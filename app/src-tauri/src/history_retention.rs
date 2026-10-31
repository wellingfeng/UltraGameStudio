use std::fs;
use std::path::Path;

pub(crate) fn delete_session_backups(root: &Path, rel_path: &str) -> Result<(), String> {
    let normalized = rel_path.replace('\\', "/");
    let segments: Vec<_> = normalized.split('/').collect();
    if segments
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == ".." || part.contains(':'))
    {
        return Err("会话备份路径无效".into());
    }
    let valid = matches!(segments.as_slice(), ["scheduled-tasks", "sessions", name]
        if name.ends_with(".json") && *name != "index.json")
        || matches!(segments.as_slice(), ["workspaces", _, "sessions", name]
            if name.ends_with(".json") && *name != "index.json");
    if !valid {
        return Err("仅允许清理指定会话的历史备份".into());
    }
    let file_name = segments[segments.len() - 1];
    let mut dir = root.join("backups");
    for segment in &segments[..segments.len() - 1] {
        dir.push(segment);
    }
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取会话备份失败: {error}")),
    };
    let prefix = format!("{file_name}.backup-");
    for entry in entries {
        let entry = entry.map_err(|error| format!("读取会话备份失败: {error}"))?;
        if entry.file_name().to_string_lossy().starts_with(&prefix)
            && entry
                .file_type()
                .map_err(|error| format!("读取备份类型失败: {error}"))?
                .is_file()
        {
            fs::remove_file(entry.path()).map_err(|error| format!("删除会话备份失败: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn delete_only_target_session_backups() {
        let tests_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(".ultragamestudio")
            .join("tests");
        let root = tests_dir.join(format!("scheduled-retention-{}", std::process::id()));
        let backups = root
            .join("backups")
            .join("scheduled-tasks")
            .join("sessions");
        fs::create_dir_all(&backups).unwrap();
        fs::write(backups.join("weekly.json.backup-1"), b"old").unwrap();
        fs::write(backups.join("weekly.json.backup-2"), b"old").unwrap();
        fs::write(backups.join("weekly-other.json.backup-1"), b"keep").unwrap();
        fs::write(backups.join("index.json.backup-1"), b"keep").unwrap();
        delete_session_backups(&root, "scheduled-tasks/sessions/weekly.json").unwrap();
        assert!(!backups.join("weekly.json.backup-1").exists());
        assert!(!backups.join("weekly.json.backup-2").exists());
        assert!(backups.join("weekly-other.json.backup-1").exists());
        assert!(backups.join("index.json.backup-1").exists());
        assert!(delete_session_backups(&root, "scheduled-tasks/sessions/index.json").is_err());
        assert!(delete_session_backups(&root, "workspaces/../sessions/weekly.json").is_err());
        assert!(root.starts_with(tests_dir));
        fs::remove_dir_all(root).unwrap();
    }
}
