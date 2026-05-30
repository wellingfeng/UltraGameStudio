// History persistence backend.
//
// Implements the storage layer specified in `.omc/plans/history-store-spec.md`:
// all conversation / workflow history lives under `%USERPROFILE%\.worktree\`,
// laid out as `workspaces/<wsId>/sessions/<sid>.json` with `index.json` summary
// files at each level. The frontend talks to this module via the five
// `history_*` Tauri commands; the Rust side is responsible for path-traversal
// safety, atomic writes (tmp → rename), and soft deletes (move into `trash/`).
//
// Every command is `async` and wraps its blocking I/O in `spawn_blocking` so it
// never stalls the webview's main thread — see project memory
// `tauri-blocking-commands.md` for the precedent.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Locate the user's home directory in a platform-neutral way.
///
/// On Windows the `USERPROFILE` env var is authoritative; `HOME` is the
/// fallback used by everything else (and works on macOS/Linux too).
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

/// Resolve the `.worktree` root, creating it (and the canonical `workspaces/`
/// + `trash/` subdirectories) on first call. Resolution order:
///   1. `OWF_HOME` env var (escape hatch for tests / portable installs)
///   2. `<home>/.worktree`
fn worktree_root() -> Result<PathBuf, String> {
    let root = if let Ok(env) = std::env::var("OWF_HOME") {
        if !env.trim().is_empty() {
            PathBuf::from(env)
        } else {
            home_dir().ok_or("无法定位用户目录")?.join(".worktree")
        }
    } else {
        home_dir().ok_or("无法定位用户目录")?.join(".worktree")
    };
    fs::create_dir_all(&root).map_err(|e| format!("创建 .worktree 根目录失败: {e}"))?;
    let _ = fs::create_dir_all(root.join("workspaces"));
    let _ = fs::create_dir_all(root.join("trash"));
    Ok(root)
}

/// Validate `rel_path` and join it onto `root`. Rejects empty input, absolute
/// paths, parent traversal (`..`), and drive-letter prefixes — anything that
/// could escape `.worktree`.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("relPath 为空".into());
    }
    if rel.starts_with('/') || rel.starts_with('\\') {
        return Err("relPath 不能以分隔符开头".into());
    }
    if rel.contains(':') {
        return Err("relPath 不能含驱动器分隔符".into());
    }
    for seg in rel.split(['/', '\\']) {
        if seg == ".." {
            return Err("relPath 不能包含 ..".into());
        }
    }
    Ok(root.join(rel))
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
/// Corrupt JSON is renamed to `<file>.corrupt-<unix-secs>` so a parse failure
/// never re-crashes the UI on every load — the caller gets `None` and treats
/// the slot as empty.
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
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let mut corrupt = path.clone();
                    let mut name = path
                        .file_name()
                        .map(|n| n.to_os_string())
                        .unwrap_or_default();
                    name.push(format!(".corrupt-{ts}"));
                    corrupt.set_file_name(name);
                    let _ = fs::rename(&path, &corrupt);
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
/// `<path>.tmp` first and then `rename`d over the target — POSIX guarantees the
/// rename is atomic, and NTFS does too for same-volume targets, so readers
/// never observe a half-written file.
#[tauri::command]
pub async fn history_write_json(rel_path: String, json: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if !rel_path.ends_with(".json") {
            return Err("history_write_json 只允许写 .json".into());
        }
        let root = worktree_root()?;
        let path = safe_join(&root, &rel_path)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
        }
        let tmp = {
            let mut t = path.clone();
            let mut name = t
                .file_name()
                .map(|n| n.to_os_string())
                .unwrap_or_default();
            name.push(".tmp");
            t.set_file_name(name);
            t
        };
        {
            let mut f = fs::File::create(&tmp)
                .map_err(|e| format!("创建临时文件失败 {}: {e}", tmp.display()))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("写入失败 {}: {e}", tmp.display()))?;
            let _ = f.sync_all();
        }
        fs::rename(&tmp, &path).map_err(|e| format!("rename 覆盖失败: {e}"))?;
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
            fs::create_dir_all(&trash).ok();
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let safe_name = rel_path.replace(['/', '\\'], "_");
            let dest = trash.join(format!("{ts}-{safe_name}"));
            fs::rename(&path, &dest).map_err(|e| format!("移入 trash 失败: {e}"))?;
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

/// List the files (not subdirectories) directly inside `rel_path` under
/// `.worktree`. Empty `rel_path` lists the root itself. `.tmp` staging files
/// and `.corrupt-*` quarantines are filtered out so the caller sees only
/// well-formed entries.
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
                if ft.is_file() {
                    names.push(name);
                }
            }
        }
        Ok(names)
    })
    .await
    .map_err(|e| format!("history_list_dir 调度失败: {e}"))?
}
