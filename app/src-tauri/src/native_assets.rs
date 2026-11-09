//! Asset grants are canonicalized off-thread and cached by directory + recursion.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
#[derive(Default)]
pub(crate) struct AssetScopes {
    granted: Mutex<HashMap<PathBuf, bool>>,
}
impl AssetScopes {
    pub(crate) fn ensure(
        &self,
        file: &Path,
        recursive: bool,
        grant: impl FnOnce(&Path, bool) -> Result<(), String>,
    ) -> Result<(), String> {
        let absolute =
            std::fs::canonicalize(file).map_err(|e| format!("解析本地资源路径失败: {e}"))?;
        let parent = absolute.parent().ok_or("路径没有父目录")?;
        let mut granted = self.granted.lock().map_err(|_| "本地资源授权锁失败。")?;
        if granted
            .get(parent)
            .is_some_and(|existing| *existing || !recursive)
        {
            return Ok(());
        }
        // Fail explicitly rather than grow scopes forever or broaden permission.
        if granted.len() >= 4096 && !granted.contains_key(parent) {
            return Err("本地资源目录授权达到上限。".into());
        }
        grant(parent, recursive)?;
        granted.insert(parent.to_path_buf(), recursive);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn files_in_same_directory_share_one_asset_grant() {
        let root = PathBuf::from(std::env::var_os("TMPDIR").unwrap())
            .join(format!("ugs-asset-scope-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let cache = AssetScopes::default();
        let mut grants = 0;
        for name in ["one.png", "two.png"] {
            let file = root.join(name);
            std::fs::write(&file, b"fixture").unwrap();
            cache
                .ensure(&file, false, |directory, recursive| {
                    assert_eq!(directory, std::fs::canonicalize(&root).unwrap());
                    assert!(!recursive);
                    grants += 1;
                    Ok(())
                })
                .unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(
            grants, 1,
            "directory scope must not recompile duplicate grants per image"
        );
    }
}
