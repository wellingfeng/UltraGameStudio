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
use std::sync::atomic::{AtomicU64, Ordering};

use crate::storage_paths;

#[path = "history_retention.rs"]
mod history_retention;
#[path = "history_journal.rs"]
mod history_journal;
use history_retention::delete_session_backups;

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
const MAX_BACKUPS_PER_FILE: usize = 24;
const MAX_BACKUP_FILES_TOTAL: usize = 5000;
const MAX_BACKUP_BYTES_TOTAL: u64 = 512 * 1024 * 1024;
const BACKUP_PRUNE_INTERVAL_SECS: u64 = 300;

#[cfg(test)]
#[path = "history_persistence_tests.rs"]
mod history_persistence_tests;

static LAST_BACKUP_PRUNE_SECS: AtomicU64 = AtomicU64::new(0);
static HISTORY_NAMESPACE: std::sync::RwLock<()> = std::sync::RwLock::new(());
static HISTORY_LANES: std::sync::OnceLock<[std::sync::Mutex<()>; 64]> = std::sync::OnceLock::new();
static HISTORY_REVISION_SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn history_revision(clock: &str) -> String {
    format!("{clock}-{}-{}", std::process::id(), HISTORY_REVISION_SEQUENCE.fetch_add(1, Ordering::SeqCst))
}
fn history_lane(path: &Path) -> Result<std::sync::MutexGuard<'static, ()>, String> {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let identity = path.to_string_lossy();
    #[cfg(windows)] let identity = identity.to_lowercase();
    identity.hash(&mut hash);
    HISTORY_LANES.get_or_init(|| std::array::from_fn(|_| std::sync::Mutex::new(())))
        [(hash.finish() % 64) as usize].lock().map_err(|_| "history lane poisoned".into())
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

fn global_history_root() -> Result<PathBuf, String> {
    storage_paths::ensure_global_root_with_dirs(ROOT_DIRS)
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent, &format!("父目录 {}", parent.display()))?;
    }
    Ok(())
}

fn staged_path_for(path: &Path) -> PathBuf {
    let mut tmp = path.to_path_buf();
    let mut name = tmp
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(format!(".{}.tmp", timestamp_token()));
    tmp.set_file_name(name);
    tmp
}

fn write_staged_json(path: &Path, json: &str) -> Result<PathBuf, String> {
    ensure_parent_dir(path)?;
    let tmp = staged_path_for(path);
    {
        let mut f = fs::File::create(&tmp)
            .map_err(|e| format!("创建临时文件失败 {}: {e}", tmp.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("写入失败 {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("同步临时文件失败 {}: {e}", tmp.display()))?;
    }
    Ok(tmp)
}

fn persist_json_file(path: &Path, json: &str) -> Result<(), String> {
    persist_json_file_with(path, json, replace_file)
}

fn persist_json_file_with(path: &Path, json: &str, replace: impl Fn(&Path, &Path) -> Result<(), String>) -> Result<(), String> {
    let mut last_err: Option<String> = None;
    for _ in 0..2 {
        let tmp = write_staged_json(path, json)?;
        match replace(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                let _ = fs::remove_file(&tmp);
            }
        }
    }

    // Never truncate the durable base after a failed atomic replacement.
    // A session's previous journal must remain recoverable on every failure.
    Err(last_err.unwrap_or_else(|| "替换文件失败".to_string()))
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
    let _ = prune_backup_siblings(root, rel_path);
    maybe_prune_backup_root(root);
    Ok(())
}

fn modified_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn prune_backup_siblings(root: &Path, rel_path: &str) -> Result<(), String> {
    let (parent_segments, file_name) = rel_parent_and_name(rel_path)?;
    let mut dir = root.join("backups");
    for segment in parent_segments {
        dir.push(segment);
    }
    let prefix = format!("{file_name}.backup-");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) {
            files.push((path, entry.metadata().and_then(|m| m.modified()).ok()));
        }
    }
    if files.len() <= MAX_BACKUPS_PER_FILE {
        return Ok(());
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    for (idx, (path, _)) in files.into_iter().enumerate() {
        if idx >= MAX_BACKUPS_PER_FILE {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn history_delete_session_backups(rel_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_session_backups(&global_history_root()?, &rel_path))
        .await
        .map_err(|error| format!("清理会话备份调度失败: {error}"))?
}

fn maybe_prune_backup_root(root: &Path) {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let last_secs = LAST_BACKUP_PRUNE_SECS.load(Ordering::Relaxed);
    if now_secs.saturating_sub(last_secs) < BACKUP_PRUNE_INTERVAL_SECS {
        return;
    }
    if LAST_BACKUP_PRUNE_SECS
        .compare_exchange(last_secs, now_secs, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    let _ = prune_backup_root(root);
}

fn collect_backup_files(dir: &Path, out: &mut Vec<(PathBuf, u64, u64)>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_backup_files(&path, out);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        out.push((path.clone(), modified_secs(&path), size));
    }
}

fn prune_backup_root(root: &Path) -> Result<(), String> {
    let backup_root = root.join("backups");
    if !backup_root.exists() {
        return Ok(());
    }
    let mut files = Vec::new();
    collect_backup_files(&backup_root, &mut files);
    let total_bytes = files
        .iter()
        .fold(0_u64, |acc, (_, _, size)| acc.saturating_add(*size));
    if files.len() <= MAX_BACKUP_FILES_TOTAL && total_bytes <= MAX_BACKUP_BYTES_TOTAL {
        return Ok(());
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let mut kept = 0_usize;
    let mut kept_bytes = 0_u64;
    for (path, _, size) in files {
        let within_count = kept < MAX_BACKUP_FILES_TOTAL;
        let within_bytes = kept_bytes.saturating_add(size) <= MAX_BACKUP_BYTES_TOTAL;
        if kept == 0 || (within_count && within_bytes) {
            kept += 1;
            kept_bytes = kept_bytes.saturating_add(size);
            continue;
        }
        let _ = fs::remove_file(path);
    }
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

fn is_session_path(rel: &str) -> bool {
    normalized_rel_segments(rel).ok().is_some_and(|parts| {
        let name = parts.last().map(String::as_str).unwrap_or("");
        name.ends_with(".json") && name != "index.json" &&
          ((parts.len() == 4 && parts[0] == "workspaces" && parts[2] == "sessions") ||
           (parts.len() == 3 && parts[0] == "scheduled-tasks" && parts[1] == "sessions"))
    })
}

fn chunk_hash(rel: &str) -> Option<String> {
    let parts = normalized_rel_segments(rel).ok()?;
    let valid_parent = (parts.len() == 5 && parts[0] == "workspaces" && parts[2] == "sessions")
        || (parts.len() == 4 && parts[0] == "scheduled-tasks" && parts[1] == "sessions");
    if !valid_parent || !parts[parts.len() - 2].ends_with(".json.chunks") { return None; }
    let hash = parts.last()?.strip_suffix(".json")?;
    (hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).then(|| hash.to_owned())
}

fn validate_chunk(json: &str, hash: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if json.len() > 2 * 1024 * 1024 { return Err("HISTORY_CHUNK_CORRUPT".into()); }
    let payload: serde_json::Value = serde_json::from_str(json).map_err(|_| "HISTORY_CHUNK_CORRUPT")?;
    let text = payload.get("text").and_then(serde_json::Value::as_str).ok_or("HISTORY_CHUNK_CORRUPT")?;
    if text.encode_utf16().count() > 128 * 1024 || hex::encode(Sha256::digest(text.as_bytes())) != hash {
        return Err("HISTORY_CHUNK_CORRUPT".into());
    }
    Ok(())
}

fn reject_chunk_redirects(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                let mut redirected = metadata.file_type().is_symlink();
                #[cfg(windows)]
                { use std::os::windows::fs::MetadataExt; redirected |= metadata.file_attributes() & 0x400 != 0; }
                if redirected { return Err("HISTORY_CHUNK_UNSAFE_PATH".into()); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!("检查分块路径失败: {error}")),
        }
    }
    Ok(())
}

pub(crate) fn read_chunk_file(path: &Path, hash: &str) -> Result<Option<String>, String> {
    use std::io::Read;
    reject_chunk_redirects(path)?;
    let parents = match history_journal::history_journal_safety::lock_parents(path) {
        Ok(parents) => parents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取分块目录失败: {error}")),
    };
    let mut file = match history_journal::history_journal_safety::open_bound(path, &parents) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("打开分块失败: {error}")),
    };
    if file.metadata().map_err(|error| error.to_string())?.len() > 2 * 1024 * 1024 { return Err("HISTORY_CHUNK_CORRUPT".into()); }
    let mut json = String::new();
    file.read_to_string(&mut json).map_err(|error| format!("读取分块失败: {error}"))?;
    validate_chunk(&json, hash)?;
    Ok(Some(json))
}

fn write_chunk_file(path: &Path, hash: &str, json: &str) -> Result<(), String> {
    validate_chunk(json, hash)?;
    reject_chunk_redirects(path)?;
    ensure_parent_dir(path)?;
    let parents = history_journal::history_journal_safety::lock_parents(path).map_err(|error| format!("打开分块目录失败: {error}"))?;
    match history_journal::history_journal_safety::open_bound(path, &parents) {
        Ok(mut file) => {
            use std::io::Read;
            if file.metadata().map_err(|error| error.to_string())?.len() > 2 * 1024 * 1024 { return Err("HISTORY_CHUNK_CORRUPT".into()); }
            let mut old = String::new();
            file.read_to_string(&mut old).map_err(|error| error.to_string())?;
            validate_chunk(&old, hash)?;
            return Ok(());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(format!("打开分块失败: {error}")),
    }
    #[cfg(windows)]
    {
        history_journal::history_journal_safety::replace_bound(path, &parents, json.as_bytes())
            .map_err(|error| format!("写入分块失败: {error}"))?;
    }
    #[cfg(not(windows))]
    { persist_json_file(path, json)?; }
    Ok(())
}

fn is_memory_path(rel: &str) -> bool {
    normalized_rel_segments(rel)
        .ok()
        .and_then(|parts| parts.first().cloned())
        .is_some_and(|part| part.eq_ignore_ascii_case("memories"))
}

#[tauri::command]
pub async fn memory_read_json(window: tauri::Webview, rel_path: String) -> Result<Option<String>, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::memory_transactions::read_at(&global_history_root()?, &rel_path)
    })
    .await
    .map_err(|e| format!("memory_read_json dispatch failed: {e}"))?
}

#[tauri::command]
pub async fn memory_compare_exchange_json(
    window: tauri::Webview,
    rel_path: String,
    expected_json: Option<String>,
    json: String,
) -> Result<String, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::memory_transactions::compare_exchange_at(
            &global_history_root()?,
            &rel_path,
            expected_json.as_deref(),
            &json,
        )
    })
    .await
    .map_err(|e| format!("memory_compare_exchange_json dispatch failed: {e}"))?
}

/// Return the absolute path of the `.ultragamestudio` root, creating it on first
/// access. The frontend uses this for diagnostics; it must not hardcode the
/// path.
#[tauri::command]
pub async fn history_root() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let root = global_history_root()?;
        Ok(root.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("history_root 调度失败: {e}"))?
}

/// Read a JSON file under `.ultragamestudio`, returning `None` if it does not exist.
/// Corrupt JSON is moved into `quarantine/` so a parse failure never keeps
/// re-crashing the UI on every load.
#[tauri::command]
pub async fn history_read_json(rel_path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
        history_read_at(&global_history_root()?, &rel_path)
    })
    .await
    .map_err(|e| format!("history_read_json 调度失败: {e}"))?
}

/// Read a small bounded batch of content-addressed chunks in one IPC request.
#[tauri::command]
pub async fn history_read_chunks(rel_paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history_read_chunks_at(&global_history_root()?, &rel_paths)
    }).await.map_err(|e| format!("history_read_chunks 调度失败: {e}"))?
}

fn history_read_chunks_at(root: &Path, rel_paths: &[String]) -> Result<Vec<Option<String>>, String> {
    if rel_paths.len() > 16 || rel_paths.iter().any(|path| chunk_hash(path).is_none()) {
        return Err("HISTORY_CHUNK_REFERENCE_INVALID".into());
    }
    rel_paths.iter().map(|path| history_read_at(root, path)).collect()
}

pub(crate) fn history_read_at(root: &Path, rel_path: &str) -> Result<Option<String>, String> {
    let _namespace = HISTORY_NAMESPACE.read().map_err(|_| "history namespace poisoned")?;
    let validated_path = safe_join(root, rel_path)?;
    let _lane = history_lane(&validated_path)?;
        if !rel_path.ends_with(".json") {
            return Err("history_read_json 只接受 .json 路径".into());
        }
        if is_memory_path(&rel_path) {
            return crate::memory_transactions::read_at(&root, &rel_path);
        }
        let path = safe_join(&root, &rel_path)?;
        if let Some(hash) = chunk_hash(rel_path) { return read_chunk_file(&path, &hash); }
        match fs::read_to_string(&path) {
            Ok(s) => {
                if serde_json::from_str::<serde_json::Value>(&s).is_err() {
                    if !is_internal_path(&rel_path) {
                        let _ = quarantine_corrupt_file(&root, &rel_path, &path);
                    }
                    return Ok(None);
                }
                if is_session_path(rel_path) { return history_journal::replay(&path, &s).and_then(|json| history_journal::visible(&json)).map(Some); }
                Ok(Some(s))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("读取失败 {rel_path}: {e}")),
        }
}

/// Atomically write JSON to a path under `.ultragamestudio`. The data is staged into
/// a temp file in the same directory and then renamed over the target. If the
/// target already exists, a copy is saved under `backups/` first.
#[tauri::command]
pub async fn history_write_json(rel_path: String, json: String, stream_checkpoint: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        history_write_at(&global_history_root()?, &rel_path, &json, stream_checkpoint.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("history_write_json 调度失败: {e}"))?
}

pub(crate) fn history_write_at(root: &Path, rel_path: &str, json: &str, stream_checkpoint: bool) -> Result<(), String> {
    let _namespace = HISTORY_NAMESPACE.read().map_err(|_| "history namespace poisoned")?;
    let validated_path = safe_join(root, rel_path)?;
    let _lane = history_lane(&validated_path)?;
        if !rel_path.ends_with(".json") {
            return Err("history_write_json 只允许写 .json".into());
        }
        validate_json(&json)?;

        if is_memory_path(&rel_path) {
            return Err(
                "Memory writes require exact memory_compare_exchange_json; legacy overwrite denied"
                    .into(),
            );
        }
        let path = safe_join(&root, &rel_path)?;
        if let Some(hash) = chunk_hash(rel_path) { return write_chunk_file(&path, &hash, json); }
        if path.exists() && path.is_dir() {
            return Err(format!("目标是目录，不能写入 JSON: {}", path.display()));
        }
        let payload: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if payload.get("__ugsJournal").is_some() {
            if !stream_checkpoint || !is_session_path(rel_path) { return Err("journal 只允许用于会话 checkpoint".into()); }
            return history_journal::append(&path, json);
        }

        // Checkpoints replace only a session record atomically. Keep the normal
        // backups intact instead of rotating them every few seconds of a stream.
        let checkpoint = stream_checkpoint && is_session_path(rel_path);
        if path.exists() && !is_internal_path(&rel_path) && !checkpoint {
            backup_existing_file(&root, &rel_path, &path)?;
        }
        // A checkpoint can compact a full journal into a chunked record. Keep
        // the portable legacy base before that first format migration too.
        if checkpoint && path.exists() && payload.get("__ugsHistoryChunkVersion") == Some(&serde_json::json!(1)) {
            let old = fs::read_to_string(&path).map_err(|e| format!("读取旧会话失败: {e}"))?;
            let old: serde_json::Value = serde_json::from_str(&old).map_err(|e| format!("旧会话无效: {e}"))?;
            if old.get("__ugsHistoryChunkVersion") != Some(&serde_json::json!(1)) {
                backup_existing_file(root, rel_path, &path)?;
            }
        }

        let mut persisted = payload;
        let compacting = is_session_path(rel_path) && history_journal::path_for(&path).exists();
        if compacting {
            persisted.as_object_mut().ok_or("会话记录必须是 object")?
                .insert("__ugsHistoryRevision".into(), serde_json::Value::String(history_revision(&timestamp_token())));
        }
        let compacted_json;
        let output = if compacting { compacted_json = persisted.to_string(); &compacted_json } else { json };
        persist_json_file(&path, output)?;
        if is_session_path(rel_path) {
            history_journal::forget(&path);
            let journal = history_journal::path_for(&path);
            match fs::remove_file(&journal) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(format!("压实后清理 journal 失败: {e}")),
            }
        }
        Ok(())
}

/// Remove a file or directory under `.ultragamestudio`. `soft=true` (the default
/// from the UI) moves the target into `trash/<unix-ms>-<flattened-relpath>`;
/// `soft=false` deletes it outright. A missing target is treated as success
/// so callers can be idempotent.
#[tauri::command]
pub async fn history_remove(rel_path: String, soft: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || history_remove_at(&global_history_root()?, &rel_path, soft))
        .await.map_err(|e| format!("history_remove 调度失败: {e}"))?
}
fn history_remove_at(root: &Path, rel_path: &str, soft: bool) -> Result<(), String> {
    let _namespace = HISTORY_NAMESPACE.write().map_err(|_| "history namespace poisoned")?;
    if is_memory_path(rel_path) { return Err("Memory removal requires a scoped CAS transaction".into()); }
    let path = safe_join(root, rel_path)?;
    let journal = is_session_path(rel_path).then(|| history_journal::path_for(&path));
    history_journal::forget(&path);
    if soft {
        let trash = root.join("trash"); ensure_dir(&trash, "trash 目录")?;
        let safe_name = rel_path.replace(['/', '\\'], "_");
        let dest = trash.join(format!("{}-{safe_name}", timestamp_token()));
        let moved_base = path.exists();
        if moved_base { replace_file(&path, &dest)?; }
        if let Some(journal) = journal.filter(|journal| journal.exists()) {
            if let Err(error) = replace_file(&journal, &history_journal::path_for(&dest)) {
                if moved_base {
                    if let Err(rollback) = replace_file(&dest, &path) { return Err(format!("{error}; trash rollback failed: {rollback}")); }
                }
                return Err(error);
            }
        }
    } else {
        if path.is_dir() { fs::remove_dir_all(&path).map_err(|e| format!("删除目录失败: {e}"))?; }
        else if path.exists() { fs::remove_file(&path).map_err(|e| format!("删除文件失败: {e}"))?; }
        if let Some(journal) = journal.filter(|journal| journal.exists()) {
            fs::remove_file(&journal).map_err(|e| format!("删除 journal 失败: {e}"))?;
        }
    }
    Ok(())
}

/// List the direct children inside `rel_path` under `.ultragamestudio`. Empty
/// `rel_path` lists the root itself. Temp and corrupt files are filtered out so
/// the caller sees only well-formed entries.
#[tauri::command]
pub async fn history_list_dir(rel_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let root = global_history_root()?;
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
