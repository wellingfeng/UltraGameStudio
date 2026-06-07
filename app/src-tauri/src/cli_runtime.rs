use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliPlatform {
    Windows,
    Macos,
    Linux,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliScanCandidate {
    pub adapter: String,
    pub command: String,
    pub path: Option<String>,
    pub source: String,
    pub available: bool,
    pub status: String,
    pub hint: Option<String>,
    pub error: Option<String>,
    pub platform: CliPlatform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliScanResult {
    pub scanned_at_ms: u64,
    pub platform: CliPlatform,
    pub candidates: Vec<CliScanCandidate>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliPathValidation {
    pub path: String,
    pub normalized_path: String,
    pub platform: CliPlatform,
    pub file_name: String,
}

#[derive(Clone, Copy)]
struct CliSpec {
    adapter: &'static str,
    label: &'static str,
    commands: &'static [&'static str],
}

const CLI_SPECS: &[CliSpec] = &[
    CliSpec {
        adapter: "claude-code",
        label: "Claude Code",
        commands: &["claude", "claude-code"],
    },
    CliSpec {
        adapter: "codex",
        label: "Codex",
        commands: &["codex"],
    },
    CliSpec {
        adapter: "gemini",
        label: "Gemini",
        commands: &["gemini"],
    },
];

pub fn adapter_binary(adapter: &str) -> &str {
    match adapter {
        "claude-code" | "claude" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        other => other,
    }
}

pub fn adapter_protocol(adapter: &str) -> &str {
    match adapter {
        "claude-code" | "claude" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        other => other,
    }
}

pub fn should_pass_model(adapter: &str, model: &str) -> bool {
    let m = model.trim();
    if m.is_empty() {
        return false;
    }
    let lower = m.to_ascii_lowercase();
    if matches!(adapter_protocol(adapter), "codex" | "gemini") {
        return !matches!(lower.as_str(), "haiku" | "sonnet" | "opus")
            && !lower.starts_with("claude-");
    }
    // claude-code: only forward genuine Claude model ids or the bare tier
    // aliases the CLI maps. A relay route label (e.g. a cc-switch id like
    // "kimi-for-coding") may still be present in ANTHROPIC_MODEL, but must not
    // be passed as a `--model` flag to the claude CLI.
    matches!(lower.as_str(), "haiku" | "sonnet" | "opus") || lower.starts_with("claude")
}

pub fn platform() -> CliPlatform {
    if cfg!(windows) {
        CliPlatform::Windows
    } else if cfg!(target_os = "macos") {
        CliPlatform::Macos
    } else {
        CliPlatform::Linux
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn push_path_dir(out: &mut Vec<PathBuf>, seen: &mut Vec<String>, path: PathBuf) {
    let key = path.to_string_lossy().to_string();
    if key.trim().is_empty() || seen.iter().any(|existing| existing == &key) {
        return;
    }
    seen.push(key);
    out.push(path);
}

fn common_path_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = Vec::new();

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            push_path_dir(&mut out, &mut seen, dir);
        }
    }

    if let Some(home) = home_dir() {
        #[cfg(windows)]
        {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                push_path_dir(&mut out, &mut seen, PathBuf::from(appdata).join("npm"));
            }
            push_path_dir(&mut out, &mut seen, home.join(".cargo").join("bin"));
            push_path_dir(&mut out, &mut seen, home.join(".bun").join("bin"));
        }

        #[cfg(not(windows))]
        {
            push_path_dir(&mut out, &mut seen, home.join(".cargo").join("bin"));
            push_path_dir(&mut out, &mut seen, home.join(".bun").join("bin"));
            push_path_dir(&mut out, &mut seen, home.join(".deno").join("bin"));
            push_path_dir(&mut out, &mut seen, home.join(".local").join("bin"));
            push_path_dir(&mut out, &mut seen, home.join(".npm-global").join("bin"));
            push_path_dir(&mut out, &mut seen, home.join(".volta").join("bin"));
            push_path_dir(&mut out, &mut seen, home.join("Library").join("pnpm"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        for dir in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            push_path_dir(&mut out, &mut seen, PathBuf::from(dir));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for dir in [
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
            "/snap/bin",
        ] {
            push_path_dir(&mut out, &mut seen, PathBuf::from(dir));
        }
    }

    out
}

pub fn augmented_path_var() -> Option<OsString> {
    std::env::join_paths(common_path_dirs()).ok()
}

pub fn scan_model_clis() -> CliScanResult {
    let platform = platform();
    let scanned_at_ms = now_ms();
    let mut candidates = Vec::new();

    for spec in CLI_SPECS {
        match resolve_spec_candidate(spec, platform) {
            Ok(candidate) => candidates.push(candidate),
            Err(err) => candidates.push(CliScanCandidate {
                adapter: spec.adapter.to_string(),
                command: spec.commands[0].to_string(),
                path: None,
                source: "scan".to_string(),
                available: false,
                status: "missing".to_string(),
                hint: Some(spec.label.to_string()),
                error: Some(err),
                platform,
            }),
        }
    }

    CliScanResult {
        scanned_at_ms,
        platform,
        candidates,
        error: None,
    }
}

pub fn validate_cli_path(raw: &str) -> Result<CliPathValidation, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("INVALID_CLI_PATH: 请选择可执行文件。".to_string());
    }
    validate_candidate_path(Path::new(trimmed))
}

pub fn normalize_cli_command_override(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("INVALID_CLI_PATH: 请选择可执行文件。".to_string());
    }

    if looks_like_path(trimmed) {
        return validate_cli_path(trimmed).map(|v| v.normalized_path);
    }

    if is_disallowed_launcher(trimmed) {
        return Err("UNSUPPORTED_CLI_TYPE: 请选择模型 CLI，不要使用 shell 程序。".to_string());
    }

    Ok(trimmed.to_string())
}

fn resolve_spec_candidate(
    spec: &CliSpec,
    platform: CliPlatform,
) -> Result<CliScanCandidate, String> {
    for command in spec.commands {
        if let Some(path) = resolve_command_path(command)
            .and_then(|candidate| validate_candidate_path(&candidate).ok())
        {
            let resolved_path = path.normalized_path.clone();
            return Ok(CliScanCandidate {
                adapter: spec.adapter.to_string(),
                command: (*command).to_string(),
                path: Some(resolved_path.clone()),
                source: "scan".to_string(),
                available: true,
                status: "available".to_string(),
                hint: Some(resolved_path),
                error: None,
                platform,
            });
        }
    }

    Err(format!("未找到 {} CLI", spec.label))
}

pub fn resolve_command_path(command: &str) -> Option<PathBuf> {
    let raw = Path::new(command);
    if looks_like_path(command) {
        return raw.exists().then(|| raw.to_path_buf());
    }

    #[cfg(windows)]
    {
        let mut variants = vec![command.to_string()];
        if raw.extension().is_none() {
            variants.extend(pathext_variants(command));
        }
        if let Some(found) = search_path(&variants) {
            return Some(found);
        }
        None
    }

    #[cfg(not(windows))]
    {
        search_path(&[command.to_string()])
    }
}

#[cfg(windows)]
fn pathext_variants(command: &str) -> Vec<String> {
    let pathext = std::env::var_os("PATHEXT")
        .and_then(|value| value.into_string().ok())
        .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
    pathext
        .split(';')
        .filter_map(|ext| {
            let ext = ext.trim();
            if ext.is_empty() {
                None
            } else {
                Some(format!("{command}{ext}"))
            }
        })
        .collect()
}

fn search_path(variants: &[String]) -> Option<PathBuf> {
    for dir in common_path_dirs() {
        for variant in variants {
            let candidate = dir.join(variant);
            if candidate.exists() && validate_candidate_path(&candidate).is_ok() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Strip the Windows extended-length (`\\?\`) prefix that `fs::canonicalize`
/// always emits. We never store or spawn that verbatim form: `cmd.exe /C`
/// (used to launch `.cmd`/`.bat` shims like `claude.cmd`) cannot resolve a
/// `\\?\C:\...` path and fails with "系统找不到指定的路径" (exit code 1).
/// Drive-letter paths drop the prefix outright; UNC shares (`\\?\UNC\srv\share`)
/// fold back to `\\srv\share`. Non-Windows paths pass through unchanged.
fn simplify_canonical_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn validate_candidate_path(path: &Path) -> Result<CliPathValidation, String> {
    let canonical = fs::canonicalize(path)
        .map(|c| simplify_canonical_path(&c))
        .map_err(|err| classify_path_error(path, err))?;
    let metadata = fs::metadata(&canonical).map_err(|err| classify_path_error(&canonical, err))?;
    if !metadata.is_file() {
        return Err("NOT_FILE: 请选择普通文件，而不是文件夹或特殊路径。".to_string());
    }

    let platform = platform();
    ensure_supported_cli_path(&canonical, platform)?;

    let file_name = canonical
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_string();

    Ok(CliPathValidation {
        path: path.to_string_lossy().to_string(),
        normalized_path: canonical.to_string_lossy().to_string(),
        platform,
        file_name,
    })
}

fn ensure_supported_cli_path(path: &Path, platform: CliPlatform) -> Result<(), String> {
    if is_disallowed_launcher(path.to_string_lossy().as_ref()) {
        return Err("UNSUPPORTED_CLI_TYPE: 请选择模型 CLI，不要使用 shell 程序。".to_string());
    }

    match platform {
        CliPlatform::Windows => ensure_supported_windows_path(path),
        CliPlatform::Macos | CliPlatform::Linux => ensure_supported_unix_path(path),
    }
}

fn ensure_supported_windows_path(path: &Path) -> Result<(), String> {
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        stem.as_str(),
        "powershell" | "pwsh" | "cmd" | "command" | "wscript" | "cscript"
    ) {
        return Err("UNSUPPORTED_CLI_TYPE: 请选择模型 CLI，不要使用 shell 程序。".to_string());
    }

    match path
        .extension()
        .and_then(OsStr::to_str)
        .map(|ext| ext.to_ascii_lowercase())
    {
        Some(ext) if matches!(ext.as_str(), "exe" | "cmd" | "bat") => Ok(()),
        Some(_) => Err(
            "UNSUPPORTED_CLI_TYPE: Windows 仅支持 .exe、.cmd、.bat 或无扩展的可执行文件。"
                .to_string(),
        ),
        None => {
            let mut file = File::open(path).map_err(|err| classify_path_error(path, err))?;
            let mut magic = [0_u8; 2];
            file.read_exact(&mut magic)
                .map_err(|_| "UNSUPPORTED_CLI_TYPE: 请选择 Windows 可执行文件。".to_string())?;
            if magic == [0x4D, 0x5A] {
                Ok(())
            } else {
                Err("UNSUPPORTED_CLI_TYPE: 请选择 Windows 可执行文件。".to_string())
            }
        }
    }
}

fn ensure_supported_unix_path(path: &Path) -> Result<(), String> {
    let stem = path
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        stem.as_str(),
        "sh" | "bash" | "zsh" | "fish" | "dash" | "ksh" | "csh" | "tcsh"
    ) {
        return Err("UNSUPPORTED_CLI_TYPE: 请选择模型 CLI，不要使用 shell 程序。".to_string());
    }

    #[cfg(unix)]
    {
        let mode = fs::metadata(path)
            .map_err(|err| classify_path_error(path, err))?
            .permissions()
            .mode();
        if mode & 0o111 == 0 {
            return Err("NOT_EXECUTABLE: 请先为该文件添加执行权限（chmod +x）。".to_string());
        }
    }

    Ok(())
}

fn is_disallowed_launcher(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    let stem = Path::new(&lower)
        .file_stem()
        .and_then(OsStr::to_str)
        .unwrap_or(&lower)
        .to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "powershell"
            | "pwsh"
            | "cmd"
            | "command"
            | "wscript"
            | "cscript"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "dash"
            | "ksh"
            | "csh"
            | "tcsh"
    )
}

fn looks_like_path(raw: &str) -> bool {
    raw.contains('/') || raw.contains('\\') || Path::new(raw).is_absolute()
}

fn classify_path_error(path: &Path, err: std::io::Error) -> String {
    let prefix = if err.kind() == std::io::ErrorKind::PermissionDenied {
        "PERMISSION_DENIED"
    } else if err.kind() == std::io::ErrorKind::NotFound {
        "INVALID_CLI_PATH"
    } else {
        "INVALID_CLI_PATH"
    };
    format!("{prefix}: 无法访问 {} ({err})", path.to_string_lossy())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disallows_shell_launchers() {
        assert!(is_disallowed_launcher("powershell.exe"));
        assert!(is_disallowed_launcher("/bin/sh"));
        assert!(!is_disallowed_launcher("claude"));
    }

    #[test]
    fn claude_code_drops_non_model_labels() {
        // cc-switch route labels are not safe CLI --model values.
        assert!(!should_pass_model("claude-code", "kimi-for-coding"));
        assert!(!should_pass_model("claude", "glm-4.6"));
        assert!(!should_pass_model("claude-code", "   "));
    }

    #[test]
    fn claude_code_passes_real_models_and_tiers() {
        assert!(should_pass_model("claude-code", "claude-opus-4-8"));
        assert!(should_pass_model("claude-code", "claude-sonnet-4-6"));
        assert!(should_pass_model("claude-code", "sonnet"));
        assert!(should_pass_model("claude-code", "opus"));
        assert!(should_pass_model("claude-code", "haiku"));
    }

    #[test]
    fn codex_gemini_behaviour_unchanged() {
        // Real upstream ids pass.
        assert!(should_pass_model("codex", "gpt-5.5"));
        assert!(should_pass_model("gemini", "gemini-2.5-pro"));
        // Claude tiers / ids are filtered out for codex/gemini.
        assert!(!should_pass_model("codex", "sonnet"));
        assert!(!should_pass_model("gemini", "claude-opus-4-8"));
    }

    #[cfg(windows)]
    #[test]
    fn simplify_strips_verbatim_prefix() {
        use std::path::Path;
        // Drive-letter verbatim path drops the prefix entirely so `cmd /C` can
        // resolve a `.cmd` shim instead of failing with "系统找不到指定的路径".
        assert_eq!(
            simplify_canonical_path(Path::new(r"\\?\C:\Users\me\claude.cmd")).to_string_lossy(),
            r"C:\Users\me\claude.cmd"
        );
        // UNC verbatim paths fold back to a plain UNC share.
        assert_eq!(
            simplify_canonical_path(Path::new(r"\\?\UNC\srv\share\claude.cmd")).to_string_lossy(),
            r"\\srv\share\claude.cmd"
        );
        // A path without the prefix is untouched.
        assert_eq!(
            simplify_canonical_path(Path::new(r"C:\bin\claude.cmd")).to_string_lossy(),
            r"C:\bin\claude.cmd"
        );
    }
}
