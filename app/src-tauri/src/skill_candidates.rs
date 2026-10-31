use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Caller must first verify persisted source and resolve workspace from host metadata.
/// Shares the exact Node path + mkdir lock protocol; no model call while locked.
pub fn candidate_request(workspace: &Path, request: &Value) -> Result<Value, String> {
    let path = workspace.join(".ultragamestudio/skill-learning/pre-review.v1.json");
    match request.get("action").and_then(Value::as_str) {
        Some("load") => load(&path),
        Some("compare_and_swap") => cas(
            &path,
            request
                .get("expectedRevision")
                .and_then(Value::as_u64)
                .ok_or("SKILL_CANDIDATE_INVALID_REVISION")?,
            request
                .get("list")
                .ok_or("SKILL_PRE_REVIEW_INVALID_STORAGE")?,
        ),
        _ => Err("SKILL_CANDIDATE_INVALID_ACTION".into()),
    }
}
fn safe(path: &Path) -> Result<(), String> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(info) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if info.file_attributes() & 0x400 != 0 {
                        return Err("SKILL_CANDIDATE_UNSAFE_PATH".into());
                    }
                }
                if info.file_type().is_symlink() {
                    return Err("SKILL_CANDIDATE_UNSAFE_PATH".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}
fn sources(list: &Value) -> Result<Vec<String>, String> {
    let mut all = Vec::new();
    if let Some(values) = list.get("seenSources") {
        let values = values
            .as_array()
            .ok_or("SKILL_PRE_REVIEW_INVALID_STORAGE")?;
        if values.len() > 4096 {
            return Err("SKILL_PRE_REVIEW_INVALID_STORAGE".into());
        }
        for value in values {
            let source = value
                .as_str()
                .filter(|s| s.chars().count() <= 2048)
                .ok_or("SKILL_PRE_REVIEW_INVALID_STORAGE")?;
            all.push(source.to_owned());
        }
    } else {
        for item in list["candidates"]
            .as_array()
            .ok_or("SKILL_PRE_REVIEW_INVALID_STORAGE")?
        {
            for value in item["sources"]
                .as_array()
                .ok_or("SKILL_PRE_REVIEW_INVALID_STORAGE")?
            {
                all.push(
                    value
                        .as_str()
                        .ok_or("SKILL_PRE_REVIEW_INVALID_STORAGE")?
                        .to_owned(),
                );
            }
        }
    }
    Ok(all)
}
fn validate(list: &Value) -> Result<(), String> {
    if list["version"].as_u64() != Some(1)
        || list.get("revision").map_or(false, |r| {
            r.as_u64().map_or(true, |r| r > 9_007_199_254_740_991)
        })
    {
        return Err("SKILL_PRE_REVIEW_INVALID_STORAGE".into());
    }
    let items = list["candidates"]
        .as_array()
        .ok_or("SKILL_PRE_REVIEW_INVALID_STORAGE")?;
    if items.len() > 64 {
        return Err("SKILL_PRE_REVIEW_INVALID_STORAGE".into());
    }
    for item in items {
        if item["id"].as_str().map_or(true, str::is_empty)
            || item["lesson"]
                .as_str()
                .map_or(true, |s| s.chars().count() > 1024)
            || item["context"]
                .as_str()
                .map_or(true, |s| s.chars().count() > 8192)
            || item["consecutive"].as_u64().is_none()
            || item["submitted"].as_bool().is_none()
            || item["sources"].as_array().map_or(true, |a| {
                a.len() > 4096
                    || a.iter()
                        .any(|s| s.as_str().map_or(true, |s| s.chars().count() > 2048))
            })
        {
            return Err("SKILL_PRE_REVIEW_INVALID_STORAGE".into());
        }
    }
    sources(list)?;
    Ok(())
}
fn load(path: &Path) -> Result<Value, String> {
    safe(path)?;
    match fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > 16 * 1024 * 1024 {
                return Err("SKILL_PRE_REVIEW_INVALID_STORAGE".into());
            }
            let mut list: Value =
                serde_json::from_slice(&bytes).map_err(|_| "SKILL_PRE_REVIEW_INVALID_STORAGE")?;
            validate(&list)?;
            if list.get("revision").is_none() {
                list["revision"] = json!(0);
            }
            Ok(list)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(json!({"version":1,"revision":0,"candidates":[]}))
        }
        Err(e) => Err(e.to_string()),
    }
}
struct Guard(PathBuf);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
fn cas(path: &Path, expected: u64, list: &Value) -> Result<Value, String> {
    validate(list)?;
    if expected >= 9_007_199_254_740_991 {
        return Err("SKILL_CANDIDATE_INVALID_REVISION".into());
    }
    safe(path)?;
    fs::create_dir_all(path.parent().ok_or("SKILL_CANDIDATE_INVALID_ROOT")?)
        .map_err(|e| e.to_string())?;
    let lock = PathBuf::from(format!("{}.lock", path.display()));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match fs::create_dir(&lock) {
            Ok(_) => break,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if Instant::now() >= deadline {
                    return Err("SKILL_CANDIDATE_LOCKED_NEEDS_RECOVERY".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    let _guard = Guard(lock);
    let current = load(path)?;
    if current["revision"].as_u64() != Some(expected) {
        return Err("SKILL_CANDIDATE_CONFLICT".into());
    }
    let next_sources = sources(list)?;
    if sources(&current)?.iter().any(|s| !next_sources.contains(s)) {
        return Err("SKILL_CANDIDATE_REPLAY_ERASURE".into());
    }
    let mut next = list.clone();
    next["revision"] = json!(expected + 1);
    let bytes = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
    let temp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        replace(&temp, path)?;
        if fs::read(path).map_err(|e| e.to_string())? != bytes {
            return Err("SKILL_CANDIDATE_READBACK_FAILED".into());
        }
        Ok(next)
    })();
    let _ = fs::remove_file(temp);
    result
}
#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| e.to_string())
}
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::path::PathBuf;
    #[test]
    fn stale_host_revision_cannot_overwrite_the_winner() {
        let workspace = PathBuf::from("C:/Users/fengwei/AppData/Local/hermes/cache/scratch/ugs-self-review-development/candidate-stream")
            .join(format!("rust-cas-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&workspace).unwrap();
        let first = json!({"version":1,"revision":0,"candidates":[],"seenSources":["source-a"]});
        let applied = super::candidate_request(
            &workspace,
            &json!({"action":"compare_and_swap","expectedRevision":0,"list":first}),
        )
        .unwrap();
        assert_eq!(applied["revision"], 1);
        assert_eq!(
            super::candidate_request(
                &workspace,
                &json!({"action":"compare_and_swap","expectedRevision":0,"list":first})
            )
            .unwrap_err(),
            "SKILL_CANDIDATE_CONFLICT"
        );
        let loaded = super::candidate_request(&workspace, &json!({"action":"load"})).unwrap();
        assert_eq!(loaded["seenSources"], json!(["source-a"]));
        std::fs::remove_dir_all(workspace).unwrap();
    }
}
