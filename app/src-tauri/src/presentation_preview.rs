use std::path::{Path, PathBuf};

#[cfg(windows)]
pub(crate) fn render(source: &Path) -> Result<PathBuf, String> {
    use crate::{storage_paths, temp_stamp, TempFileGuard};
    use std::collections::hash_map::DefaultHasher;
    use std::fs;
    use std::hash::{Hash, Hasher};

    let metadata = fs::metadata(source).map_err(|e| format!("读取演示文稿失败：{e}"))?;
    if !metadata.is_file() {
        return Err("目标不是演示文稿文件。".into());
    }
    let revision = metadata
        .modified()
        .map_err(|e| format!("读取文件修改时间失败：{e}"))?;
    let cache = storage_paths::global_tmp_artifact_dir("presentation-preview")?;
    let mut key = DefaultHasher::new();
    (source, metadata.len(), revision).hash(&mut key);
    let rendered = cache.join(format!("{:016x}.pdf", key.finish()));
    if is_pdf(&rendered) {
        return Ok(rendered);
    }

    let stage = cache.join(format!("slide-{}-{}", std::process::id(), temp_stamp()));
    let snapshot = TempFileGuard::new(stage.with_extension(crate::preview_extension(source)));
    let output = TempFileGuard::new(stage.with_extension("pdf"));
    let errors = TempFileGuard::new(stage.with_extension("log"));

    // PowerPoint can return an already-open presentation from Open. Render a
    // private snapshot so closing the export never closes the user's document.
    fs::copy(source, snapshot.path()).map_err(|e| format!("创建演示文稿快照失败：{e}"))?;
    let latest = fs::metadata(source).map_err(|e| format!("读取演示文稿失败：{e}"))?;
    if latest.len() != metadata.len() || latest.modified().ok() != Some(revision) {
        return Err("演示文稿正在修改，请刷新预览。".into());
    }
    export_with_powerpoint(snapshot.path(), output.path(), errors.path())?;
    if !is_pdf(output.path()) {
        return Err("PowerPoint 未生成可用的预览文件。".into());
    }
    fs::rename(output.path(), &rendered).map_err(|e| format!("保存演示文稿预览失败：{e}"))?;
    Ok(rendered)
}

#[cfg(not(windows))]
pub(crate) fn render(_source: &Path) -> Result<PathBuf, String> {
    Err("版式预览需要 Windows 版 Microsoft PowerPoint。".into())
}

#[cfg(windows)]
fn is_pdf(path: &Path) -> bool {
    use std::io::Read;

    let mut header = [0; 5];
    std::fs::File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .is_ok()
        && &header == b"%PDF-"
}

#[cfg(windows)]
fn export_with_powerpoint(source: &Path, output: &Path, errors: &Path) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let system_root = std::env::var_os("SystemRoot").ok_or("无法定位 Windows 系统目录。")?;
    let shell = PathBuf::from(system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let script: Vec<u8> = include_str!("presentation_preview.ps1")
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let stderr = std::fs::File::create(errors).map_err(|e| format!("无法记录预览错误：{e}"))?;
    let mut command = Command::new(shell);
    crate::hide_console(&mut command);
    let mut child = command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Sta",
            "-EncodedCommand",
        ])
        .arg(STANDARD.encode(script))
        .env(
            "UGS_PPT_PREVIEW_SOURCE",
            crate::display_preview_path(source),
        )
        .env(
            "UGS_PPT_PREVIEW_OUTPUT",
            crate::display_preview_path(output),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .spawn()
        .map_err(|e| format!("启动 PowerPoint 预览失败：{e}"))?;

    let deadline = Instant::now() + Duration::from_secs(180);
    let status = match crate::native_background::wait_child_until(&mut child, deadline) {
        Ok(status) => status,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("PowerPoint 预览失败：{error}"));
        }
    };
    if status.success() {
        return Ok(());
    }
    let mut details = String::new();
    if let Ok(file) = std::fs::File::open(errors) {
        let _ = file.take(2048).read_to_string(&mut details);
    }
    Err(if details.trim().is_empty() {
        format!("PowerPoint 导出失败（{status}）。")
    } else {
        format!("PowerPoint 导出失败：{}", details.trim())
    })
}
