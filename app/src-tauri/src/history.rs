// History persistence backend.
//
// This module owns the filesystem primitives behind the history store:
// root initialization, JSON reads/writes, atomic replacement, backup copies,
// and quarantine of corrupt payloads. The frontend still talks to these
// helpers through the existing `history_*` Tauri commands.

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_READONLY,
    INVALID_FILE_ATTRIBUTES, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

const ROOT_DIRS: &[&str] = &[
    "workspaces",
    "trash",
    "backups",
    "quarantine",
    "tmp",
    "deleted",
    "migrations",
];

const INTERNAL_TOP_LEVEL_DIRS: &[&str] = &["backups", "quarantine", "tmp", "deleted", "migrations"];

/// Locate the user's home directory in a platform-neutral way.
fn home_dir() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    None
}

fn ensure_dir(path: &Path, label: &str) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("创建 {label} 失败: {e}"))
}

fn timestamp_token() -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{stamp}-{}", std::process::id())
}

fn normalized_rel_segments(rel: &str) -> Result<Vec<String>, String> {
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Err("relPath 为空".into());
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err("relPath 不能以分隔符开头".into());
    }

    let mut segments = Vec::new();
    for raw in trimmed.split(['/', '\\']) {
        let seg = raw.trim();
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("relPath 不能包含 ..".into());
        }
        if seg.contains(':') {
            return Err("relPath 不能含驱动器分隔符".into());
        }
        segments.push(seg.to_string());
    }

    if segments.is_empty() {
        return Err("relPath 为空".into());
    }

    Ok(segments)
}

/// Validate `rel_path` and join it onto `root`. Rejects empty input, absolute
/// paths, parent traversal (`..`), and drive-letter prefixes.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut path = root.to_path_buf();
    for segment in normalized_rel_segments(rel)? {
        path.push(segment);
    }
    Ok(path)
}

fn rel_parent_and_name(rel: &str) -> Result<(Vec<String>, String), String> {
    let segments = normalized_rel_segments(rel)?;
    let file_name = segments
        .last()
        .ok_or_else(|| "relPath 为空".to_string())?
        .clone();
    let parent = segments[..segments.len().saturating_sub(1)].to_vec();
    Ok((parent, file_name))
}

fn is_internal_path(rel_path: &str) -> bool {
    normalized_rel_segments(rel_path)
        .ok()
        .and_then(|segments| segments.first().cloned())
        .is_some_and(|first| INTERNAL_TOP_LEVEL_DIRS.contains(&first.as_str()))
}

fn artifact_relative_path(
    rel_path: &str,
    bucket: &str,
    kind: &str,
    stamp: &str,
) -> Result<PathBuf, String> {
    let (parent_segments, file_name) = rel_parent_and_name(rel_path)?;
    let mut rel = PathBuf::from(bucket);
    for segment in parent_segments {
        rel.push(segment);
    }
    let mut name = OsString::from(file_name);
    name.push(format!(".{kind}-{stamp}"));
    rel.push(name);
    Ok(rel)
}

fn unique_artifact_paths(
    root: &Path,
    rel_path: &str,
    bucket: &str,
    kind: &str,
) -> Result<(PathBuf, String), String> {
    let base = timestamp_token();
    for attempt in 0..1000 {
        let stamp = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}-{attempt}")
        };
        let rel = artifact_relative_path(rel_path, bucket, kind, &stamp)?;
        let abs = root.join(&rel);
        if !abs.exists() {
            return Ok((abs, rel.to_string_lossy().into_owned()));
        }
    }
    Err(format!("无法为 {rel_path} 生成唯一 {kind} 路径"))
}

#[cfg(windows)]
fn to_wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// Windows sets the read-only attribute on some files (and antivirus/backup
/// tools can flip it transiently). `MoveFileExW` over a read-only destination
/// fails with ACCESS_DENIED, so clear the bit before attempting the rename.
#[cfg(windows)]
fn clear_readonly(dest_wide: &[u16]) {
    unsafe {
        let attrs = GetFileAttributesW(dest_wide.as_ptr());
        if attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_READONLY) != 0 {
            SetFileAttributesW(dest_wide.as_ptr(), attrs & !FILE_ATTRIBUTE_READONLY);
        }
    }
}

#[cfg(windows)]
fn replace_file(src: &Path, dest: &Path) -> Result<(), String> {
    let src_wide = to_wide(src);
    let dest_wide = to_wide(dest);

    // ACCESS_DENIED (5) and SHARING_VIOLATION (32) are usually transient on
    // Windows: the destination is briefly locked by antivirus, the Search
    // indexer, or another reader. Clear any read-only attribute and retry a
    // few times with a short backoff before giving up.
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const MAX_ATTEMPTS: u32 = 8;

    let mut last_err = std::io::Error::last_os_error();
    for attempt in 0..MAX_ATTEMPTS {
        clear_readonly(&dest_wide);
        let ok = unsafe {
            MoveFileExW(
                src_wide.as_ptr(),
                dest_wide.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok != 0 {
            return Ok(());
        }
        last_err = std::io::Error::last_os_error();
        let transient = matches!(
            last_err.raw_os_error(),
            Some(ERROR_ACCESS_DENIED) | Some(ERROR_SHARING_VIOLATION)
        );
        if !transient || attempt + 1 == MAX_ATTEMPTS {
            break;
        }
        // 20ms, 40ms, 60ms ... — total worst-case ~0.5s, imperceptible on load.
        std::thread::sleep(std::time::Duration::from_millis(20 * (attempt as u64 + 1)));
    }

    Err(format!(
        "替换文件失败 {} -> {}: {}",
        src.display(),
        dest.display(),
        last_err
    ))
}

#[cfg(not(windows))]
fn replace_file(src: &Path, dest: &Path) -> Result<(), String> {
    fs::rename(src, dest)
        .map_err(|e| format!("替换文件失败 {} -> {}: {e}", src.display(), dest.display()))
}

fn worktree_root() -> Result<PathBuf, String> {
    let root = if let Ok(env) = std::env::var("FUC_HOME") {
        if !env.trim().is_empty() {
            PathBuf::from(env)
        } else {
            home_dir().ok_or("无法定位用户目录")?.join(".worktree")
        }
    } else {
        home_dir().ok_or("无法定位用户目录")?.join(".worktree")
    };

    ensure_dir(&root, ".worktree 根目录")?;
    for dir in ROOT_DIRS {
        ensure_dir(&root.join(dir), &format!(".worktree/{dir}"))?;
    }
    Ok(root)
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent, &format!("父目录 {}", parent.display()))?;
    }
    Ok(())
}

fn backup_existing_file(root: &Path, rel_path: &str, source: &Path) -> Result<(), String> {
    let (dest, _) = unique_artifact_paths(root, rel_path, "backups", "backup")?;
    ensure_parent_dir(&dest)?;
    fs::copy(source, &dest).map_err(|e| {
        format!(
            "备份文件失败 {} -> {}: {e}",
            source.display(),
            dest.display()
        )
    })?;
    Ok(())
}

fn quarantine_corrupt_file(root: &Path, rel_path: &str, source: &Path) -> Result<(), String> {
    let (dest, _) = unique_artifact_paths(root, rel_path, "quarantine", "corrupt")?;
    ensure_parent_dir(&dest)?;

    match replace_file(source, &dest) {
        Ok(()) => Ok(()),
        Err(primary_err) => {
            fs::copy(source, &dest).map_err(|copy_err| {
                format!(
                    "隔离损坏文件失败 {} -> {}: {copy_err} (原始错误: {primary_err})",
                    source.display(),
                    dest.display()
                )
            })?;
            let _ = fs::remove_file(source);
            Ok(())
        }
    }
}

fn validate_json(json: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(json)
        .map(|_| ())
        .map_err(|e| format!("JSON 无效: {e}"))
}

/// Return the absolute path of the `.worktree` root, creating it on first
/// access. The frontend uses this for diagnostics; it must not hardcode the
/// path.
#[tauri::command]
pub async fn history_root() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let root = worktree_root()?;
        Ok(root.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("history_root 调度失败: {e}"))?
}

/// Read a JSON file under `.worktree`, returning `None` if it does not exist.
/// Corrupt JSON is moved into `quarantine/` so a parse failure never keeps
/// re-crashing the UI on every load.
#[tauri::command]
pub async fn history_read_json(rel_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        if !rel_path.ends_with(".json") {
            return Err("history_read_json 只接受 .json 路径".into());
        }
        let root = worktree_root()?;
        let path = safe_join(&root, &rel_path)?;
        match fs::read_to_string(&path) {
            Ok(s) => {
                if serde_json::from_str::<serde_json::Value>(&s).is_err() {
                    if !is_internal_path(&rel_path) {
                        let _ = quarantine_corrupt_file(&root, &rel_path, &path);
                    }
                    return Ok(None);
                }
                Ok(Some(s))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("读取失败 {rel_path}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("history_read_json 调度失败: {e}"))?
}

/// Atomically write JSON to a path under `.worktree`. The data is staged into
/// a temp file in the same directory and then renamed over the target. If the
/// target already exists, a copy is saved under `backups/` first.
#[tauri::command]
pub async fn history_write_json(rel_path: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if !rel_path.ends_with(".json") {
            return Err("history_write_json 只允许写 .json".into());
        }
        validate_json(&json)?;

        let root = worktree_root()?;
        let path = safe_join(&root, &rel_path)?;
        if path.exists() && path.is_dir() {
            return Err(format!("目标是目录，不能写入 JSON: {}", path.display()));
        }

        if path.exists() && !is_internal_path(&rel_path) {
            backup_existing_file(&root, &rel_path, &path)?;
        }

        ensure_parent_dir(&path)?;

        let tmp = {
            let mut t = path.clone();
            let mut name = t.file_name().map(|n| n.to_os_string()).unwrap_or_default();
            name.push(format!(".{}.tmp", timestamp_token()));
            t.set_file_name(name);
            t
        };

        {
            let mut f = fs::File::create(&tmp)
                .map_err(|e| format!("创建临时文件失败 {}: {e}", tmp.display()))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("写入失败 {}: {e}", tmp.display()))?;
            f.sync_all()
                .map_err(|e| format!("同步临时文件失败 {}: {e}", tmp.display()))?;
        }

        replace_file(&tmp, &path)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("history_write_json 调度失败: {e}"))?
}

/// Remove a file or directory under `.worktree`. `soft=true` (the default
/// from the UI) moves the target into `trash/<unix-ms>-<flattened-relpath>`;
/// `soft=false` deletes it outright. A missing target is treated as success
/// so callers can be idempotent.
#[tauri::command]
pub async fn history_remove(rel_path: String, soft: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let root = worktree_root()?;
        let path = safe_join(&root, &rel_path)?;
        if !path.exists() {
            return Ok(());
        }
        if soft {
            let trash = root.join("trash");
            ensure_dir(&trash, "trash 目录")?;
            let safe_name = rel_path.replace(['/', '\\'], "_");
            let dest = trash.join(format!("{}-{safe_name}", timestamp_token()));
            replace_file(&path, &dest).map_err(|e| {
                format!(
                    "移入 trash 失败 {} -> {}: {e}",
                    path.display(),
                    dest.display()
                )
            })?;
        } else if path.is_dir() {
            fs::remove_dir_all(&path).map_err(|e| format!("删除目录失败: {e}"))?;
        } else {
            fs::remove_file(&path).map_err(|e| format!("删除文件失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("history_remove 调度失败: {e}"))?
}

/// List the direct children inside `rel_path` under `.worktree`. Empty
/// `rel_path` lists the root itself. Temp and corrupt files are filtered out so
/// the caller sees only well-formed entries.
#[tauri::command]
pub async fn history_list_dir(rel_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let root = worktree_root()?;
        let path = if rel_path.is_empty() {
            root.clone()
        } else {
            safe_join(&root, &rel_path)?
        };
        if !path.exists() {
            return Ok(vec![]);
        }
        let mut names: Vec<String> = vec![];
        for entry in fs::read_dir(&path).map_err(|e| format!("读取目录失败: {e}"))? {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".tmp") {
                continue;
            }
            if name.contains(".corrupt-") {
                continue;
            }
            if let Ok(ft) = entry.file_type() {
                if ft.is_file() || ft.is_dir() {
                    names.push(name);
                }
            }
        }
        names.sort();
        Ok(names)
    })
    .await
    .map_err(|e| format!("history_list_dir 调度失败: {e}"))?
}
