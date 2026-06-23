use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

mod cc_switch_import;
mod cli_runtime;
mod free_proxy;
mod history;
mod secure_store;
mod storage_paths;

/// Windows CreateProcess flag: don't allocate a console window for the child.
/// Without this, spawning the `claude` console binary pops up a black terminal
/// window every time the app runs a node. No-op on other platforms.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_MENU_SHOW_ID: &str = "tray-show-main";
const TRAY_MENU_GITHUB_ID: &str = "tray-open-github";
const TRAY_MENU_QUIT_ID: &str = "tray-quit";
const GITHUB_REPOSITORY_URL: &str = "https://github.com/wellingfeng/UltraGameStudio";
const SINGLE_INSTANCE_WARNING_EVENT: &str = "single-instance-warning";
const SINGLE_INSTANCE_WARNING_MESSAGE: &str = "只能同时运行一个进程";
const SESSION_NOTIFICATION_CLICKED_EVENT: &str = "session-notification-clicked";
const SLASH_CATALOG_UPDATED_EVENT: &str = "slash-catalog-updated";
const WORKSPACE_VCS_SCAN_PROGRESS_EVENT: &str = "workspace-vcs-scan-progress";
const LEGACY_BRAND_MIGRATION_PROGRESS_EVENT: &str = "legacy-brand-migration-progress";
const MAX_SLASH_ENTRIES: usize = 800;
const MAX_COMMAND_SCAN_DEPTH: usize = 4;
const MAX_SKILL_SCAN_DEPTH: usize = 8;
const MAX_SKILL_INSTALL_BYTES: u64 = 512 * 1024;
const MAX_SKILL_ZIP_INSTALL_BYTES: u64 = 10 * 1024 * 1024;
const MAX_SKILL_ZIP_EXTRACTED_BYTES: u64 = 25 * 1024 * 1024;
const MAX_SKILL_ZIP_FILES: usize = 200;

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionNotificationClickPayload {
    workspace_id: Option<String>,
    session_id: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SessionNotificationKind {
    Success,
    Error,
    WaitingInput,
}

impl SessionNotificationKind {
    fn from_arg(value: Option<String>) -> Self {
        match value.as_deref() {
            Some("error") => Self::Error,
            Some("waitingInput") => Self::WaitingInput,
            _ => Self::Success,
        }
    }
}

fn emit_session_notification_click<R: Runtime>(
    app: &AppHandle<R>,
    payload: SessionNotificationClickPayload,
) {
    show_main_window(app);
    let _ = app.emit(SESSION_NOTIFICATION_CLICKED_EVENT, payload);
}

#[tauri::command]
fn focus_main_window(app: AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn notify_session_complete(
    app: AppHandle,
    title: String,
    body: String,
    workspace_id: Option<String>,
    session_id: Option<String>,
    kind: Option<String>,
) -> Result<bool, String> {
    let payload = SessionNotificationClickPayload {
        workspace_id,
        session_id,
    };
    show_session_completion_notification(
        app,
        title,
        body,
        payload,
        SessionNotificationKind::from_arg(kind),
    )
}

#[tauri::command]
async fn migrate_legacy_brand_storage(
    app: AppHandle,
) -> Result<storage_paths::LegacyBrandMigrationProgress, String> {
    let emit_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        storage_paths::migrate_legacy_brand_storage_on_startup_with_progress(|progress| {
            let _ = emit_app.emit(LEGACY_BRAND_MIGRATION_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|e| format!("迁移旧版配置失败: {e}"))?;

    match result {
        Ok(progress) => Ok(progress),
        Err(err) => {
            eprintln!("Legacy storage migration failed: {err}");
            let progress = storage_paths::LegacyBrandMigrationProgress {
                phase: "error".to_string(),
                message: Some(err),
                ..Default::default()
            };
            let _ = app.emit(LEGACY_BRAND_MIGRATION_PROGRESS_EVENT, progress.clone());
            Ok(progress)
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_notification_app_id(app: &AppHandle) -> String {
    let identifier = app.config().identifier.clone();
    let current_dir = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.display().to_string()));
    let Some(current_dir) = current_dir else {
        return identifier;
    };
    let sep = std::path::MAIN_SEPARATOR;
    if current_dir.ends_with(format!("{sep}target{sep}debug").as_str())
        || current_dir.ends_with(format!("{sep}target{sep}release").as_str())
    {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        identifier
    }
}

#[cfg(target_os = "windows")]
fn show_session_completion_notification(
    app: AppHandle,
    title: String,
    body: String,
    payload: SessionNotificationClickPayload,
    kind: SessionNotificationKind,
) -> Result<bool, String> {
    use tauri_winrt_notification::{Duration, Toast};

    let app_id = windows_notification_app_id(&app);
    let toast = Toast::new(&app_id).title(&title).text2(&body).duration(
        if kind == SessionNotificationKind::WaitingInput {
            Duration::Long
        } else {
            Duration::Short
        },
    );
    toast
        .on_activated(move |_| {
            emit_session_notification_click(&app, payload.clone());
            Ok(())
        })
        .show()
        .map_err(|err| format!("发送 Windows 通知失败: {err}"))?;
    Ok(true)
}

#[cfg(target_os = "macos")]
fn show_session_completion_notification(
    app: AppHandle,
    title: String,
    body: String,
    payload: SessionNotificationClickPayload,
    _kind: SessionNotificationKind,
) -> Result<bool, String> {
    std::thread::spawn(move || {
        let bundle = if tauri::is_dev() {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        };
        let _ = mac_notification_sys::set_application(&bundle);
        let mut notification = mac_notification_sys::Notification::new();
        let response = notification
            .title(&title)
            .message(&body)
            .wait_for_click(true)
            .send();
        if matches!(
            response,
            Ok(mac_notification_sys::NotificationResponse::Click)
        ) {
            emit_session_notification_click(&app, payload);
        }
    });
    Ok(true)
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn show_session_completion_notification(
    _app: AppHandle,
    _title: String,
    _body: String,
    _payload: SessionNotificationClickPayload,
    _kind: SessionNotificationKind,
) -> Result<bool, String> {
    Ok(false)
}

/// Apply the no-console-window flag to a Command on Windows (no-op elsewhere).
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn resolve_spawn_program(program: &str) -> String {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return program.to_string();
    }
    if trimmed.contains('/') || trimmed.contains('\\') || Path::new(trimmed).is_absolute() {
        return trimmed.to_string();
    }
    cli_runtime::resolve_command_path(trimmed)
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|| trimmed.to_string())
}

fn prepare_command_for_spawn(cmd: &mut Command) {
    hide_console(cmd);
    if let Some(path) = cli_runtime::augmented_path_var() {
        cmd.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

fn new_spawn_command(program: &str) -> Command {
    let mut cmd = Command::new(resolve_spawn_program(program));
    prepare_command_for_spawn(&mut cmd);
    cmd
}

fn terminate_process_tree(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        hide_console(&mut cmd);
        return cmd
            .arg("/PID")
            .arg(pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
    #[cfg(not(windows))]
    {
        let group_pid = format!("-{pid}");
        let killed_group = Command::new("kill")
            .arg("-TERM")
            .arg(&group_pid)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if killed_group {
            return true;
        }
        return Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
}

/// Terminate a spawned CLI and its wrapper descendants where the OS supports it.
fn terminate_child_tree(child: &mut Child) {
    if !terminate_process_tree(child.id()) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn active_ai_cli_pids() -> &'static Mutex<HashMap<String, u32>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled_ai_cli_ids() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn register_ai_cli(run_id: &str, pid: u32) {
    if let Ok(mut active) = active_ai_cli_pids().lock() {
        active.insert(run_id.to_string(), pid);
    }
}

fn mark_ai_cli_cancelled(run_id: &str) -> Option<u32> {
    let pid = active_ai_cli_pids()
        .lock()
        .ok()
        .and_then(|active| active.get(run_id).copied());
    if pid.is_some() {
        if let Ok(mut cancelled) = cancelled_ai_cli_ids().lock() {
            cancelled.insert(run_id.to_string());
        }
    }
    pid
}

fn take_ai_cli_cancelled(run_id: &str) -> bool {
    cancelled_ai_cli_ids()
        .lock()
        .map(|mut cancelled| cancelled.remove(run_id))
        .unwrap_or(false)
}

fn unregister_ai_cli(run_id: &str) {
    if let Ok(mut active) = active_ai_cli_pids().lock() {
        active.remove(run_id);
    }
}

const FREE_CHANNEL_ENV_MAPPINGS: &[(&str, &[&str])] = &[
    ("nvidia_nim", &["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"]),
    (
        "open_router",
        &["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"],
    ),
    ("gemini", &["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
    ("deepseek", &["DEEPSEEK_API_KEY"]),
    (
        "volcengine",
        &["ARK_API_KEY", "VOLCENGINE_API_KEY", "VOLC_API_KEY"],
    ),
    ("mistral", &["MISTRAL_API_KEY"]),
    (
        "mistral_codestral",
        &[
            "CODESTRAL_API_KEY",
            "MISTRAL_CODESTRAL_API_KEY",
            "MISTRAL_API_KEY",
        ],
    ),
    ("opencode", &["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"]),
    ("opencode_go", &["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"]),
    ("wafer", &["WAFER_API_KEY"]),
    ("kimi", &["MOONSHOT_API_KEY", "KIMI_API_KEY"]),
    ("cerebras", &["CEREBRAS_API_KEY"]),
    ("groq", &["GROQ_API_KEY"]),
    ("fireworks", &["FIREWORKS_API_KEY", "FIREWORKS_API_TOKEN"]),
    (
        "zai",
        &[
            "ZAI_API_KEY",
            "Z_AI_API_KEY",
            "GLM_API_KEY",
            "ZHIPU_API_KEY",
        ],
    ),
];

#[cfg(target_os = "windows")]
const LOCAL_MODEL_SETUP_PS1: &str = include_str!("../../scripts/setup-local-model.ps1");
const COMFYUI_SETUP_PS1: &str = include_str!("../../scripts/setup-comfyui.ps1");
const LOCAL_MODEL_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const REMOTE_MODEL_LIST_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);
const CLOUDFLARE_IMAGE_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
const AI_EDIT_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelHardware {
    ram_gb: Option<f64>,
    cpu_threads: Option<u32>,
    gpu_vram_gb: Option<f64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalModelRuntimeStatus {
    channel_id: String,
    configured_model: String,
    reachable: bool,
    ready: bool,
    state: String,
    models: Vec<String>,
    message: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteModelListResult {
    models: Vec<String>,
    url: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StudioRunResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    run_id: String,
    run_dir: Option<String>,
    result_json: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AiCliResult {
    text: String,
    usage: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFilePreview {
    path: String,
    file_name: String,
    kind: String,
    mime: Option<String>,
    size_bytes: u64,
    truncated: bool,
    text: Option<String>,
    base64: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileUploadPayload {
    bytes_base64: String,
    file_name: String,
    mime: Option<String>,
    size_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceTreeEntry {
    name: String,
    path: String,
    relative_path: String,
    kind: String,
    hidden: bool,
    size_bytes: Option<u64>,
    modified_at_ms: Option<u64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDirectoryListing {
    root_path: String,
    relative_path: String,
    entries: Vec<WorkspaceTreeEntry>,
    truncated: bool,
    total_entries: usize,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangeLine {
    kind: String,
    old_line: Option<u32>,
    new_line: Option<u32>,
    content: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangeFile {
    path: String,
    old_path: Option<String>,
    status: String,
    binary: bool,
    truncated: bool,
    lines: Vec<WorkspaceChangeLine>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChanges {
    root_path: String,
    generated_at_ms: u64,
    source: String,
    files: Vec<WorkspaceChangeFile>,
    truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scan_scope: Option<String>,
}

/// Progress event emitted while a workspace VCS scan runs in the background.
///
/// `phase` is one of `scanning` / `done` / `error`. Counts are best-effort: we
/// can't know the true total file count up front for P4/full scans, so the UI
/// shows an indeterminate thin progress bar plus a live "scanned N items" text
/// rather than a precise percentage.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceVcsScanProgress {
    root_path: String,
    phase: String,
    scanned_specs: usize,
    found_items: usize,
    truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangeSnapshotFile {
    path: String,
    size_bytes: u64,
    modified_at_ms: Option<u64>,
    binary: bool,
    truncated: bool,
    content: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangeBaseline {
    root_path: String,
    generated_at_ms: u64,
    files: Vec<WorkspaceChangeSnapshotFile>,
    truncated: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceChangeBaselineSummary {
    root_path: String,
    generated_at_ms: u64,
    file_count: usize,
    truncated: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelAssetDownload {
    path: String,
    mime: String,
    size_bytes: usize,
}

/// Result of persisting a model-generated asset (image/video/audio/sprite/mesh)
/// into the workspace asset cache. Shared by the unified Asset Hub.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedAssetSave {
    path: String,
    size_bytes: usize,
    file_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedAssetFile {
    kind: String,
    source: String,
    origin: String,
    title: String,
    local_path: String,
    size_bytes: u64,
    created_at_ms: Option<u64>,
    modified_at_ms: Option<u64>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SlashCatalogEntry {
    id: String,
    kind: String,
    name: String,
    label: HashMap<String, String>,
    detail: HashMap<String, String>,
    insert_text: HashMap<String, String>,
    source: Option<String>,
    source_adapter: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SlashCatalogSnapshot {
    scanned_at_ms: u64,
    ready: bool,
    entries: Vec<SlashCatalogEntry>,
    error: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallTarget {
    id: String,
    label: String,
    path: String,
    exists: bool,
    skill_count: usize,
    skills: Vec<String>,
    is_default: bool,
    /// "project" for the active workspace's skill dirs, "global" otherwise.
    scope: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledSkill {
    name: String,
    slug: String,
    target_id: String,
    path: String,
    skill_file: String,
    source_url: Option<String>,
    overwritten: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillUninstallResult {
    target_id: String,
    slug: String,
    path: String,
    removed: bool,
}

fn localized_text(zh_cn: &str, en_us: &str) -> HashMap<String, String> {
    HashMap::from([
        ("zh-CN".to_string(), zh_cn.to_string()),
        ("en-US".to_string(), en_us.to_string()),
    ])
}

fn same_localized_text(value: &str) -> HashMap<String, String> {
    localized_text(value, value)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn cli_slash_command_entry(
    source: &str,
    source_zh: &str,
    source_en: &str,
    name: &str,
    zh_label: &str,
    en_label: &str,
    zh_detail: &str,
    en_detail: &str,
) -> SlashCatalogEntry {
    SlashCatalogEntry {
        id: format!("command:{source}:{name}"),
        kind: "command".to_string(),
        name: name.to_string(),
        label: localized_text(
            &format!("{source_zh} {zh_label}"),
            &format!("{source_en} {en_label}"),
        ),
        detail: localized_text(zh_detail, en_detail),
        insert_text: localized_text(
            &format!("按 {source_zh} CLI 的 `{name}` slash command 语义处理当前请求。{zh_detail}"),
            &format!("Use the `{name}` slash-command semantics from {source_en} CLI for this request. {en_detail}"),
        ),
        source: Some(source.to_string()),
        source_adapter: Some(source.to_string()),
    }
}

fn extend_cli_slash_commands(
    entries: &mut Vec<SlashCatalogEntry>,
    source: &str,
    source_zh: &str,
    source_en: &str,
    commands: &[(&str, &str, &str, &str, &str)],
) {
    for (name, zh_label, en_label, zh_detail, en_detail) in commands {
        entries.push(cli_slash_command_entry(
            source, source_zh, source_en, name, zh_label, en_label, zh_detail, en_detail,
        ));
    }
}

fn slash_command_entries() -> Vec<SlashCatalogEntry> {
    let mut entries = Vec::new();

    extend_cli_slash_commands(
        &mut entries,
        "claude-code",
        "Claude Code",
        "Claude Code",
        &[
            (
                "/add-dir",
                "追加目录",
                "Add Directory",
                "把额外目录加入当前工作上下文",
                "Add extra directories to the active workspace context",
            ),
            (
                "/agents",
                "代理",
                "Agents",
                "查看或管理后台 agents",
                "View or manage background agents",
            ),
            (
                "/bug",
                "反馈问题",
                "Report Bug",
                "整理并报告 CLI 或会话问题",
                "Prepare a CLI or session bug report",
            ),
            (
                "/clear",
                "清空上下文",
                "Clear",
                "清空当前对话上下文，重新开始",
                "Clear the current conversation context and start fresh",
            ),
            (
                "/compact",
                "压缩上下文",
                "Compact",
                "压缩当前长上下文，保留关键信息",
                "Compact a long context while preserving key facts",
            ),
            (
                "/config",
                "配置",
                "Config",
                "查看或调整 CLI 配置",
                "Inspect or adjust CLI settings",
            ),
            (
                "/cost",
                "费用",
                "Cost",
                "查看当前会话 token 和费用信息",
                "Show token and cost information for the session",
            ),
            (
                "/doctor",
                "诊断安装",
                "Doctor",
                "检查 CLI 安装、认证和环境健康状态",
                "Check CLI installation, auth, and environment health",
            ),
            (
                "/export",
                "导出",
                "Export",
                "导出当前会话内容",
                "Export the current session content",
            ),
            (
                "/help",
                "帮助",
                "Help",
                "显示可用 slash command",
                "Show available slash commands",
            ),
            (
                "/ide",
                "IDE",
                "IDE",
                "连接或管理 IDE 集成",
                "Connect or manage IDE integration",
            ),
            (
                "/init",
                "初始化记忆",
                "Init Memory",
                "为当前项目生成或更新 CLAUDE.md",
                "Create or update CLAUDE.md for the current project",
            ),
            (
                "/login",
                "登录",
                "Login",
                "处理 CLI 登录认证",
                "Handle CLI login and authentication",
            ),
            (
                "/logout",
                "登出",
                "Logout",
                "移除或切换 CLI 登录态",
                "Remove or switch CLI authentication state",
            ),
            (
                "/mcp",
                "MCP",
                "MCP",
                "查看或管理 MCP server",
                "Inspect or manage MCP servers",
            ),
            (
                "/memory",
                "记忆",
                "Memory",
                "查看或编辑项目/用户记忆",
                "Inspect or edit project/user memory",
            ),
            (
                "/model",
                "模型",
                "Model",
                "查看或切换当前模型",
                "Inspect or switch the active model",
            ),
            (
                "/permissions",
                "权限",
                "Permissions",
                "查看或调整工具权限",
                "Inspect or adjust tool permissions",
            ),
            (
                "/plugin",
                "插件",
                "Plugin",
                "查看或管理 Claude Code 插件",
                "Inspect or manage Claude Code plugins",
            ),
            (
                "/pr-comments",
                "PR 评论",
                "PR Comments",
                "查看或处理 PR 评论",
                "View or handle pull-request comments",
            ),
            (
                "/release-notes",
                "发布说明",
                "Release Notes",
                "查看 CLI 发布说明",
                "Show CLI release notes",
            ),
            (
                "/resume",
                "恢复会话",
                "Resume",
                "恢复历史会话",
                "Resume a previous session",
            ),
            (
                "/status",
                "状态",
                "Status",
                "查看当前会话、模型、目录和权限状态",
                "Show current session, model, directory, and permission status",
            ),
            (
                "/terminal-setup",
                "终端配置",
                "Terminal Setup",
                "配置终端集成和快捷键",
                "Configure terminal integration and key bindings",
            ),
            (
                "/vim",
                "Vim 模式",
                "Vim Mode",
                "切换 Vim 编辑模式",
                "Toggle Vim editing mode",
            ),
        ],
    );

    extend_cli_slash_commands(
        &mut entries,
        "codex",
        "Codex",
        "Codex",
        &[
            (
                "/approvals",
                "审批",
                "Approvals",
                "查看或调整命令审批策略",
                "Inspect or adjust command approval policy",
            ),
            (
                "/clear",
                "清空上下文",
                "Clear",
                "清空当前对话上下文，重新开始",
                "Clear the current conversation context and start fresh",
            ),
            (
                "/compact",
                "压缩上下文",
                "Compact",
                "压缩当前长上下文，保留关键信息",
                "Compact a long context while preserving key facts",
            ),
            (
                "/diff",
                "差异",
                "Diff",
                "查看当前工作区改动差异",
                "Show current workspace changes",
            ),
            (
                "/help",
                "帮助",
                "Help",
                "显示可用 slash command",
                "Show available slash commands",
            ),
            (
                "/init",
                "初始化说明",
                "Init Instructions",
                "为当前项目生成或更新 AGENTS.md",
                "Create or update AGENTS.md for the current project",
            ),
            (
                "/login",
                "登录",
                "Login",
                "处理 CLI 登录认证",
                "Handle CLI login and authentication",
            ),
            (
                "/logout",
                "登出",
                "Logout",
                "移除或切换 CLI 登录态",
                "Remove or switch CLI authentication state",
            ),
            (
                "/mcp",
                "MCP",
                "MCP",
                "查看或管理 MCP server",
                "Inspect or manage MCP servers",
            ),
            (
                "/model",
                "模型",
                "Model",
                "查看或切换当前模型",
                "Inspect or switch the active model",
            ),
            (
                "/new",
                "新会话",
                "New Session",
                "开启一个新会话",
                "Start a new session",
            ),
            (
                "/prompts",
                "提示词",
                "Prompts",
                "查看或选择保存的提示词",
                "View or select saved prompts",
            ),
            (
                "/quit",
                "退出",
                "Quit",
                "结束当前交互会话",
                "End the current interactive session",
            ),
            (
                "/review",
                "审查",
                "Review",
                "按代码审查视角找风险",
                "Review for code risks",
            ),
            (
                "/status",
                "状态",
                "Status",
                "查看当前会话、模型、目录和权限状态",
                "Show current session, model, directory, and permission status",
            ),
            (
                "/undo",
                "撤销",
                "Undo",
                "撤销上一轮自动改动或回复",
                "Undo the last automated change or turn",
            ),
        ],
    );

    extend_cli_slash_commands(
        &mut entries,
        "gemini",
        "Gemini",
        "Gemini",
        &[
            (
                "/auth",
                "认证",
                "Auth",
                "查看或处理认证状态",
                "Inspect or handle authentication state",
            ),
            (
                "/bug",
                "反馈问题",
                "Report Bug",
                "整理并报告 CLI 或会话问题",
                "Prepare a CLI or session bug report",
            ),
            (
                "/chat",
                "聊天",
                "Chat",
                "管理或恢复聊天会话",
                "Manage or resume chat sessions",
            ),
            (
                "/clear",
                "清空上下文",
                "Clear",
                "清空当前对话上下文，重新开始",
                "Clear the current conversation context and start fresh",
            ),
            (
                "/compress",
                "压缩上下文",
                "Compress",
                "压缩当前长上下文，保留关键信息",
                "Compress a long context while preserving key facts",
            ),
            (
                "/docs",
                "文档",
                "Docs",
                "打开或查询 CLI 文档入口",
                "Open or query CLI documentation",
            ),
            (
                "/editor",
                "编辑器",
                "Editor",
                "配置外部编辑器集成",
                "Configure external editor integration",
            ),
            (
                "/extensions",
                "扩展",
                "Extensions",
                "查看或管理 Gemini CLI extensions",
                "Inspect or manage Gemini CLI extensions",
            ),
            (
                "/help",
                "帮助",
                "Help",
                "显示可用 slash command",
                "Show available slash commands",
            ),
            (
                "/init",
                "初始化说明",
                "Init Instructions",
                "为当前项目生成或更新 GEMINI.md",
                "Create or update GEMINI.md for the current project",
            ),
            (
                "/memory",
                "记忆",
                "Memory",
                "查看或编辑项目/用户记忆",
                "Inspect or edit project/user memory",
            ),
            (
                "/mcp",
                "MCP",
                "MCP",
                "查看或管理 MCP server",
                "Inspect or manage MCP servers",
            ),
            (
                "/model",
                "模型",
                "Model",
                "查看或切换当前模型",
                "Inspect or switch the active model",
            ),
            (
                "/quit",
                "退出",
                "Quit",
                "结束当前交互会话",
                "End the current interactive session",
            ),
            (
                "/restore",
                "恢复",
                "Restore",
                "恢复历史会话或检查点",
                "Restore a previous session or checkpoint",
            ),
            (
                "/stats",
                "统计",
                "Stats",
                "查看当前会话统计信息",
                "Show current session statistics",
            ),
            (
                "/theme",
                "主题",
                "Theme",
                "查看或切换终端主题",
                "Inspect or switch terminal theme",
            ),
            (
                "/tools",
                "工具",
                "Tools",
                "查看当前可用工具",
                "Show currently available tools",
            ),
        ],
    );

    entries
}

fn initial_slash_catalog_snapshot() -> SlashCatalogSnapshot {
    SlashCatalogSnapshot {
        scanned_at_ms: now_ms(),
        ready: false,
        entries: slash_command_entries(),
        error: None,
    }
}

fn slash_catalog_cache() -> &'static Mutex<SlashCatalogSnapshot> {
    static CACHE: OnceLock<Mutex<SlashCatalogSnapshot>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(initial_slash_catalog_snapshot()))
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn push_skill_root(out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    let canonical = match std::fs::canonicalize(&path) {
        Ok(path) => path,
        Err(_) => return,
    };
    if !canonical.is_dir() || !seen.insert(canonical.clone()) {
        return;
    }
    out.push(canonical);
}

fn skill_root_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    if let Ok(path) = std::env::var("CODEX_HOME") {
        push_skill_root(&mut out, &mut seen, PathBuf::from(path).join("skills"));
    }
    if let Ok(path) = std::env::var("AGENTS_HOME") {
        push_skill_root(&mut out, &mut seen, PathBuf::from(path).join("skills"));
    }
    if let Ok(path) = std::env::var("CLAUDE_CONFIG_DIR") {
        push_skill_root(&mut out, &mut seen, PathBuf::from(path).join("skills"));
    }

    if let Some(home) = user_home_dir() {
        for rel in [
            [".codex", "skills"],
            [".agents", "skills"],
            [".claude", "skills"],
            [".gemini", "skills"],
            [".codex", "plugins"],
            [".agents", "plugins"],
            [".claude", "plugins"],
            [".gemini", "extensions"],
        ] {
            push_skill_root(&mut out, &mut seen, home.join(rel[0]).join(rel[1]));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        let mut base = Some(cwd.as_path());
        let mut depth = 0;
        while let Some(base_path) = base {
            push_skill_root(&mut out, &mut seen, base_path.join("skills"));
            for rel in [
                [".codex", "skills"],
                [".agents", "skills"],
                [".claude", "skills"],
                [".gemini", "skills"],
                [".codex", "plugins"],
                [".agents", "plugins"],
                [".claude", "plugins"],
                [".gemini", "extensions"],
            ] {
                push_skill_root(&mut out, &mut seen, base_path.join(rel[0]).join(rel[1]));
            }
            depth += 1;
            if depth >= 4 {
                break;
            }
            base = base_path.parent();
        }
    }

    out
}

fn push_command_root(
    out: &mut Vec<(String, PathBuf)>,
    seen: &mut HashSet<PathBuf>,
    source: &str,
    path: PathBuf,
) {
    let canonical = match std::fs::canonicalize(&path) {
        Ok(path) => path,
        Err(_) => return,
    };
    if !canonical.is_dir() || !seen.insert(canonical.clone()) {
        return;
    }
    out.push((source.to_string(), canonical));
}

fn command_root_candidates() -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    if let Ok(path) = std::env::var("CLAUDE_CONFIG_DIR") {
        push_command_root(
            &mut out,
            &mut seen,
            "claude-code",
            PathBuf::from(path).join("commands"),
        );
    }
    if let Ok(path) = std::env::var("CODEX_HOME") {
        push_command_root(
            &mut out,
            &mut seen,
            "codex",
            PathBuf::from(path).join("commands"),
        );
    }
    if let Ok(path) = std::env::var("AGENTS_HOME") {
        push_command_root(
            &mut out,
            &mut seen,
            "agent",
            PathBuf::from(path).join("commands"),
        );
    }

    if let Some(home) = user_home_dir() {
        for (source, rel) in [
            ("claude-code", [".claude", "commands"]),
            ("codex", [".codex", "commands"]),
            ("gemini", [".gemini", "commands"]),
            ("agent", [".agents", "commands"]),
        ] {
            push_command_root(&mut out, &mut seen, source, home.join(rel[0]).join(rel[1]));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for base in [Some(cwd.as_path()), cwd.parent()].into_iter().flatten() {
            for (source, rel) in [
                ("claude-code", [".claude", "commands"]),
                ("codex", [".codex", "commands"]),
                ("gemini", [".gemini", "commands"]),
                ("agent", [".agents", "commands"]),
            ] {
                push_command_root(&mut out, &mut seen, source, base.join(rel[0]).join(rel[1]));
            }
        }
    }

    out
}

fn clean_frontmatter_value(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn parse_skill_frontmatter(text: &str, fallback_name: &str) -> (String, String) {
    let normalized = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut name = String::new();
    let mut description = String::new();

    let mut lines = normalized.lines();
    if matches!(lines.next().map(str::trim), Some("---")) {
        let mut yaml = Vec::new();
        for line in lines {
            if line.trim() == "---" {
                break;
            }
            yaml.push(line);
        }

        let mut i = 0;
        while i < yaml.len() {
            let line = yaml[i];
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("name:") {
                name = clean_frontmatter_value(rest);
            } else if let Some(rest) = trimmed.strip_prefix("description:") {
                let rest = clean_frontmatter_value(rest);
                if matches!(rest.as_str(), ">" | "|" | ">-" | "|-") {
                    let mut parts = Vec::new();
                    i += 1;
                    while i < yaml.len() {
                        let next = yaml[i];
                        if !next.starts_with(' ')
                            && !next.starts_with('\t')
                            && !next.trim().is_empty()
                        {
                            i -= 1;
                            break;
                        }
                        let part = next.trim();
                        if !part.is_empty() {
                            parts.push(part);
                        }
                        i += 1;
                    }
                    description = parts.join(" ");
                } else {
                    description = rest;
                }
            }
            i += 1;
        }
    }

    if name.trim().is_empty() {
        name = fallback_name.to_string();
    }

    (name.trim().to_string(), description.trim().to_string())
}

fn slash_token(input: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    let raw = input.trim().trim_start_matches('/');
    let fallback = fallback.trim().trim_start_matches('/');
    for ch in raw
        .chars()
        .chain(std::iter::once(' '))
        .chain(fallback.chars())
    {
        let next = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch.is_alphanumeric() {
            Some(ch)
        } else if matches!(ch, '_' | '-') {
            Some(ch)
        } else if ch.is_whitespace() || matches!(ch, '.' | '/') {
            Some('-')
        } else {
            None
        };
        match next {
            Some('-') if !out.is_empty() && !last_dash => {
                out.push('-');
                last_dash = true;
            }
            Some('-') => {}
            Some(c) => {
                out.push(c);
                last_dash = false;
            }
            None => {}
        }
        if !out.trim_matches('-').is_empty() && ch == ' ' {
            break;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed.to_string()
    }
}

fn slash_path_token(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.trim().trim_start_matches('/').chars() {
        let next = if ch.is_ascii_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if ch.is_alphanumeric() {
            Some(ch)
        } else if matches!(ch, '_' | '-') {
            Some(ch)
        } else if ch.is_whitespace() || matches!(ch, '.' | '/') {
            Some('-')
        } else {
            None
        };
        match next {
            Some('-') if !out.is_empty() && !last_dash => {
                out.push('-');
                last_dash = true;
            }
            Some('-') => {}
            Some(c) => {
                out.push(c);
                last_dash = false;
            }
            None => {}
        }
    }
    out.trim_matches('-').to_string()
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (index, ch) in value.chars().enumerate() {
        if index >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn markdown_summary(text: &str) -> String {
    let normalized = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut first = true;
    let mut in_frontmatter = false;

    for line in normalized.lines() {
        let trimmed = line.trim();
        if first && trimmed == "---" {
            in_frontmatter = true;
            first = false;
            continue;
        }
        first = false;
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with("<!--") {
            continue;
        }
        let summary = trimmed
            .trim_start_matches('#')
            .trim()
            .trim_start_matches('>')
            .trim()
            .trim_matches('`')
            .trim();
        if !summary.is_empty() {
            return truncate_chars(summary, 180);
        }
    }

    String::new()
}

fn command_source_label(source: &str) -> (&'static str, &'static str) {
    match source {
        "claude-code" => ("Claude Code", "Claude Code"),
        "codex" => ("Codex", "Codex"),
        "gemini" => ("Gemini", "Gemini"),
        "agent" => ("Agent", "Agent"),
        _ => ("CLI", "CLI"),
    }
}

fn source_adapter_from_path(path: &Path) -> Option<&'static str> {
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        match name.as_str() {
            ".claude" => return Some("claude-code"),
            ".codex" => return Some("codex"),
            ".gemini" => return Some("gemini"),
            ".agents" => return Some("agent"),
            _ => {}
        }
    }
    None
}

fn command_name_from_file(root: &Path, path: &Path) -> Option<String> {
    let mut rel = path.strip_prefix(root).ok()?.to_path_buf();
    rel.set_extension("");

    let mut parts = Vec::new();
    for component in rel.components() {
        let token = slash_path_token(&component.as_os_str().to_string_lossy());
        if !token.is_empty() {
            parts.push(token);
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(format!("/{}", parts.join(":")))
    }
}

fn command_entry_from_file(source: &str, root: &Path, path: &Path) -> Option<SlashCatalogEntry> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if ext != "md" && ext != "mdx" {
        return None;
    }

    let text = std::fs::read_to_string(path).ok()?;
    let fallback_name = path.file_stem()?.to_string_lossy().to_string();
    let (frontmatter_name, description) = parse_skill_frontmatter(&text, &fallback_name);
    let slash_name = command_name_from_file(root, path)?;
    let summary = if !description.trim().is_empty() {
        description
    } else {
        markdown_summary(&text)
    };
    let detail = if summary.trim().is_empty() {
        path.to_string_lossy().to_string()
    } else {
        summary
    };
    let (source_zh, source_en) = command_source_label(source);
    let label = if frontmatter_name.trim().is_empty() {
        fallback_name
    } else {
        frontmatter_name
    };
    let zh_insert = format!(
        "按 {source_zh} 自定义 slash command `{slash_name}` 的说明处理当前请求。命令说明：{detail}"
    );
    let en_insert = format!(
        "Use the custom `{slash_name}` slash-command instructions from {source_en} CLI for this request. Command summary: {detail}"
    );

    Some(SlashCatalogEntry {
        id: format!("command:{source}:{slash_name}:{}", path.to_string_lossy()),
        kind: "command".to_string(),
        name: slash_name,
        label: localized_text(
            &format!("{source_zh} {label}"),
            &format!("{source_en} {label}"),
        ),
        detail: same_localized_text(&detail),
        insert_text: localized_text(&zh_insert, &en_insert),
        source: Some(path.to_string_lossy().to_string()),
        source_adapter: Some(source.to_string()),
    })
}

fn slash_entry_key(entry: &SlashCatalogEntry) -> String {
    format!(
        "{}|{}|{}",
        entry.kind,
        entry.source.as_deref().unwrap_or_default(),
        entry.name
    )
    .to_lowercase()
}

fn is_app_reserved_slash_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "/game"
            | "/studio"
            | "/image-to-game"
            | "/deep-research"
            | "/image-mode-start"
            | "/image-mode-end"
            | "/comfyui-mode-start"
            | "/comfyui-mode-end"
            | "/sprite"
            | "/sprite-mode-start"
            | "/sprite-mode-end"
            | "/video-to-frames"
            | "/mesh-mode-start"
            | "/mesh-mode-end"
            | "/mesh-search"
            | "/music"
            | "/music-mode-start"
            | "/music-mode-end"
            | "/video"
            | "/video-mode-start"
            | "/video-mode-end"
            | "/tts"
            | "/speech-mode-start"
            | "/speech-mode-end"
            | "/worldmodel"
            | "/worldmodel-mode-start"
            | "/worldmodel-mode-end"
            | "/ui-mode-start"
            | "/ui-mode-end"
            | "/blueprint-mode-start"
            | "/blueprint-mode-end"
            | "/metahuman-mode-start"
            | "/metahuman-mode-end"
            | "/screenshot"
            | "/screenshot-gif"
    )
}

fn skill_entry_from_file(path: &Path, source: &str) -> Option<SlashCatalogEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    let dir = path.parent()?;
    let fallback = dir.file_name()?.to_string_lossy().to_string();
    let (name, description) = parse_skill_frontmatter(&text, &fallback);
    let token = slash_token(&name, &fallback);
    let slash_name = format!("/{token}");
    let detail = if description.trim().is_empty() {
        dir.to_string_lossy().to_string()
    } else {
        description.clone()
    };
    let zh_insert = if description.trim().is_empty() {
        format!("请按 {slash_name} skill 的工作流处理当前请求。")
    } else {
        format!("请按 {slash_name} skill 的工作流处理当前请求。Skill 摘要：{description}")
    };
    let en_insert = if description.trim().is_empty() {
        format!("Use the {slash_name} skill workflow for this request.")
    } else {
        format!(
            "Use the {slash_name} skill workflow for this request. Skill summary: {description}"
        )
    };

    Some(SlashCatalogEntry {
        id: format!("skill:{source}:{token}"),
        kind: "skill".to_string(),
        name: slash_name,
        label: same_localized_text(&name),
        detail: same_localized_text(&detail),
        insert_text: localized_text(&zh_insert, &en_insert),
        source: Some(dir.to_string_lossy().to_string()),
        source_adapter: source_adapter_from_path(dir).map(str::to_string),
    })
}

fn skip_skill_scan_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    matches!(
        name,
        ".git"
            | ".next"
            | "build"
            | "coverage"
            | "dist"
            | "node_modules"
            | "target"
            | "tests"
            | "tmp"
    )
}

fn scan_command_dir(
    source: &str,
    root: &Path,
    dir: &Path,
    depth: usize,
    entries: &mut Vec<SlashCatalogEntry>,
    seen_keys: &mut HashSet<String>,
) {
    if entries.len() >= MAX_SLASH_ENTRIES || depth > MAX_COMMAND_SCAN_DEPTH {
        return;
    }
    if depth > 0 && skip_skill_scan_dir(dir) {
        return;
    }

    let mut children: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir.flatten().map(|entry| entry.path()).collect(),
        Err(_) => return,
    };
    children.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for child in children {
        if entries.len() >= MAX_SLASH_ENTRIES {
            break;
        }
        if child.is_file() {
            if let Some(entry) = command_entry_from_file(source, root, &child) {
                if is_app_reserved_slash_name(&entry.name) {
                    continue;
                }
                let key = slash_entry_key(&entry);
                if seen_keys.insert(key) {
                    entries.push(entry);
                }
            }
        } else if child.is_dir() {
            scan_command_dir(source, root, &child, depth + 1, entries, seen_keys);
        }
    }
}

fn scan_skill_dir(
    source: &str,
    dir: &Path,
    depth: usize,
    entries: &mut Vec<SlashCatalogEntry>,
    seen_keys: &mut HashSet<String>,
) {
    if entries.len() >= MAX_SLASH_ENTRIES {
        return;
    }

    let skill_file = dir.join("SKILL.md");
    if skill_file.is_file() {
        if let Some(entry) = skill_entry_from_file(&skill_file, source) {
            if is_app_reserved_slash_name(&entry.name) {
                return;
            }
            let key = slash_entry_key(&entry);
            if seen_keys.insert(key) {
                entries.push(entry);
            }
        }
        return;
    }

    if depth >= MAX_SKILL_SCAN_DEPTH || skip_skill_scan_dir(dir) {
        return;
    }

    let mut children: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect(),
        Err(_) => return,
    };
    children.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    for child in children {
        scan_skill_dir(source, &child, depth + 1, entries, seen_keys);
        if entries.len() >= MAX_SLASH_ENTRIES {
            break;
        }
    }
}

fn scan_slash_catalog_blocking() -> SlashCatalogSnapshot {
    let mut entries = slash_command_entries();
    let mut seen_keys: HashSet<String> = entries.iter().map(slash_entry_key).collect();

    for (source, root) in command_root_candidates() {
        scan_command_dir(&source, &root, &root, 0, &mut entries, &mut seen_keys);
    }

    for root in skill_root_candidates() {
        scan_skill_dir("local", &root, 0, &mut entries, &mut seen_keys);
    }

    SlashCatalogSnapshot {
        scanned_at_ms: now_ms(),
        ready: true,
        entries,
        error: None,
    }
}

fn set_slash_catalog_snapshot(snapshot: SlashCatalogSnapshot) {
    if let Ok(mut cache) = slash_catalog_cache().lock() {
        *cache = snapshot;
    }
}

fn get_slash_catalog_snapshot() -> SlashCatalogSnapshot {
    slash_catalog_cache()
        .lock()
        .map(|cache| cache.clone())
        .unwrap_or_else(|_| SlashCatalogSnapshot {
            scanned_at_ms: now_ms(),
            ready: false,
            entries: slash_command_entries(),
            error: Some("slash catalog cache lock failed".to_string()),
        })
}

fn start_slash_catalog_scan(app: AppHandle) {
    let _ = slash_catalog_cache();
    let spawn_result = std::thread::Builder::new()
        .name("slash-catalog-scan".to_string())
        .spawn(move || {
            let snapshot = scan_slash_catalog_blocking();
            set_slash_catalog_snapshot(snapshot.clone());
            let _ = app.emit(SLASH_CATALOG_UPDATED_EVENT, snapshot);
        });

    if let Err(err) = spawn_result {
        let snapshot = SlashCatalogSnapshot {
            scanned_at_ms: now_ms(),
            ready: true,
            entries: slash_command_entries(),
            error: Some(format!("slash catalog scan thread failed: {err}")),
        };
        set_slash_catalog_snapshot(snapshot);
    }
}

#[tauri::command]
fn slash_catalog() -> SlashCatalogSnapshot {
    get_slash_catalog_snapshot()
}

async fn refresh_slash_catalog_async(app: AppHandle) -> Result<SlashCatalogSnapshot, String> {
    let snapshot = tauri::async_runtime::spawn_blocking(scan_slash_catalog_blocking)
        .await
        .map_err(|e| format!("刷新技能目录失败: {e}"))?;
    set_slash_catalog_snapshot(snapshot.clone());
    let _ = app.emit(SLASH_CATALOG_UPDATED_EVENT, snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
async fn refresh_slash_catalog(app: AppHandle) -> Result<SlashCatalogSnapshot, String> {
    refresh_slash_catalog_async(app).await
}

fn skill_install_root(
    target_id: &str,
    project_root: Option<&Path>,
) -> Result<(String, String, PathBuf, bool), String> {
    if let Some(rel) = target_id.strip_prefix("project-") {
        let root = project_root.ok_or_else(|| "缺少项目路径，无法安装到项目。".to_string())?;
        let (label, sub): (&str, [&str; 2]) = match rel {
            "codex" => ("Codex 项目 Skill (.codex/skills)", [".codex", "skills"]),
            "agents" => ("Agents 项目 Skill (.agents/skills)", [".agents", "skills"]),
            "claude" => ("Claude 项目 Skill (.claude/skills)", [".claude", "skills"]),
            _ => return Err("未知安装目标。".to_string()),
        };
        return Ok((
            target_id.to_string(),
            label.to_string(),
            root.join(sub[0]).join(sub[1]),
            false,
        ));
    }

    let home = user_home_dir().ok_or_else(|| "未找到用户主目录。".to_string())?;
    let target = match target_id {
        "global-agents" => (
            "global-agents".to_string(),
            "全局 Agent Skills (~/.agents/skills)".to_string(),
            home.join(".agents").join("skills"),
            true,
        ),
        "global-codex" => (
            "global-codex".to_string(),
            "全局 Codex Skills (~/.codex/skills)".to_string(),
            home.join(".codex").join("skills"),
            false,
        ),
        "global-claude" => (
            "global-claude".to_string(),
            "全局 Claude Skills (~/.claude/skills)".to_string(),
            home.join(".claude").join("skills"),
            false,
        ),
        "global-gemini" => (
            "global-gemini".to_string(),
            "全局 Gemini Skills (~/.gemini/skills)".to_string(),
            home.join(".gemini").join("skills"),
            false,
        ),
        _ => return Err("未知安装目标。".to_string()),
    };
    Ok(target)
}

fn count_installed_skills(root: &Path, depth: usize) -> usize {
    if depth > MAX_SKILL_SCAN_DEPTH || !root.is_dir() {
        return 0;
    }
    if root.join("SKILL.md").is_file() {
        return 1;
    }
    let Ok(read_dir) = std::fs::read_dir(root) else {
        return 0;
    };
    read_dir
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && !skip_skill_scan_dir(path))
        .map(|path| count_installed_skills(&path, depth + 1))
        .sum()
}

fn collect_installed_skill_names(root: &Path) -> Vec<String> {
    if !root.is_dir() {
        return Vec::new();
    }
    let Ok(read_dir) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join("SKILL.md").is_file() {
            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    names
}

fn skill_install_target_entry(
    target_id: &str,
    project_root: Option<&Path>,
    scope: &str,
) -> Result<SkillInstallTarget, String> {
    let (id, label, path, is_default) = skill_install_root(target_id, project_root)?;
    let exists = path.is_dir();
    let skills = if exists {
        collect_installed_skill_names(&path)
    } else {
        Vec::new()
    };
    Ok(SkillInstallTarget {
        id,
        label,
        path: display_preview_path(&path),
        exists,
        skill_count: if exists {
            count_installed_skills(&path, 0)
        } else {
            0
        },
        skills,
        is_default,
        scope: scope.to_string(),
    })
}

fn skill_install_targets_blocking(
    project_root: Option<String>,
) -> Result<Vec<SkillInstallTarget>, String> {
    let mut out = Vec::new();

    // Project-scoped targets come first so the workspace's own skill dirs are
    // the natural default when installing from within a project.
    if let Some(raw) = project_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if let Ok(root) = project_scan_root(raw) {
            for id in ["project-codex", "project-agents", "project-claude"] {
                out.push(skill_install_target_entry(id, Some(&root), "project")?);
            }
        }
    }

    for id in [
        "global-agents",
        "global-codex",
        "global-claude",
        "global-gemini",
    ] {
        out.push(skill_install_target_entry(id, None, "global")?);
    }
    Ok(out)
}

#[tauri::command]
async fn skill_install_targets(
    project_root: Option<String>,
) -> Result<Vec<SkillInstallTarget>, String> {
    tauri::async_runtime::spawn_blocking(move || skill_install_targets_blocking(project_root))
        .await
        .map_err(|e| format!("读取安装目标失败: {e}"))?
}

fn sanitize_skill_install_slug(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.trim().chars() {
        let next = if ch.is_ascii_alphanumeric() || ch.is_alphanumeric() {
            Some(ch.to_ascii_lowercase())
        } else if matches!(ch, '_' | '-') {
            Some(ch)
        } else if ch.is_whitespace() || matches!(ch, '.' | '/' | '\\') {
            Some('-')
        } else {
            None
        };
        match next {
            Some('-') if !out.is_empty() && !last_dash => {
                out.push('-');
                last_dash = true;
            }
            Some('-') => {}
            Some(c) => {
                if out.chars().count() < 80 {
                    out.push(c);
                    last_dash = false;
                }
            }
            None => {}
        }
    }

    let trimmed = out.trim_matches('-').to_string();
    let reserved = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if trimmed.is_empty() {
        "skill".to_string()
    } else if reserved.contains(&trimmed.as_str()) {
        format!("skill-{trimmed}")
    } else {
        trimmed
    }
}

fn validate_skill_install_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return Err("只支持 HTTPS 下载地址。".to_string());
    }
    if !(lower.ends_with("/skill.md") || lower.contains("/skill.md?")) {
        return Err("只支持直接指向 SKILL.md 的地址。".to_string());
    }
    Ok(())
}

fn validate_skill_zip_install_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return Err("只支持 HTTPS 下载地址。".to_string());
    }
    Ok(())
}

fn download_skill_text(url: &str) -> Result<String, String> {
    validate_skill_install_url(url)?;
    let response = ureq::get(url)
        .set("User-Agent", "UltraGameStudio")
        .call()
        .map_err(|e| format!("下载失败: {e}"))?;
    if let Some(length) = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > MAX_SKILL_INSTALL_BYTES {
            return Err("SKILL.md 过大，已拒绝安装。".to_string());
        }
    }

    let mut text = String::new();
    response
        .into_reader()
        .take(MAX_SKILL_INSTALL_BYTES + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("读取下载内容失败: {e}"))?;
    if text.len() as u64 > MAX_SKILL_INSTALL_BYTES {
        return Err("SKILL.md 过大，已拒绝安装。".to_string());
    }
    if text.trim().is_empty() {
        return Err("下载内容为空。".to_string());
    }
    Ok(text)
}

fn download_skill_zip(url: &str) -> Result<Vec<u8>, String> {
    validate_skill_zip_install_url(url)?;
    let response = ureq::get(url)
        .set("User-Agent", "UltraGameStudio")
        .set(
            "Accept",
            "application/zip,application/octet-stream,*/*;q=0.8",
        )
        .call()
        .map_err(|e| format!("下载失败: {e}"))?;
    if let Some(length) = response
        .header("content-length")
        .and_then(|value| value.parse::<u64>().ok())
    {
        if length > MAX_SKILL_ZIP_INSTALL_BYTES {
            return Err("Skill 压缩包过大，已拒绝安装。".to_string());
        }
    }

    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_SKILL_ZIP_INSTALL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取下载内容失败: {e}"))?;
    if bytes.len() as u64 > MAX_SKILL_ZIP_INSTALL_BYTES {
        return Err("Skill 压缩包过大，已拒绝安装。".to_string());
    }
    if bytes.is_empty() {
        return Err("下载内容为空。".to_string());
    }
    Ok(bytes)
}

fn skill_zip_root_and_frontmatter(
    bytes: &[u8],
    fallback_name: &str,
) -> Result<(PathBuf, String), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("打开 Skill 压缩包失败: {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 Skill 压缩包失败: {e}"))?;
        let Some(path) = file.enclosed_name() else {
            continue;
        };
        let is_skill_file = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("SKILL.md"))
            .unwrap_or(false);
        if !is_skill_file {
            continue;
        }
        let mut text = String::new();
        file.by_ref()
            .take(MAX_SKILL_INSTALL_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|e| format!("读取 SKILL.md 失败: {e}"))?;
        if text.len() as u64 > MAX_SKILL_INSTALL_BYTES {
            return Err("SKILL.md 过大，已拒绝安装。".to_string());
        }
        let (frontmatter_name, _description) = parse_skill_frontmatter(&text, fallback_name);
        return Ok((
            path.parent().map(Path::to_path_buf).unwrap_or_default(),
            frontmatter_name,
        ));
    }

    Err("Skill 压缩包缺少 SKILL.md。".to_string())
}

fn extract_skill_zip(bytes: &[u8], dst: &Path, package_root: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("打开 Skill 压缩包失败: {e}"))?;
    let mut copied = 0usize;
    let mut extracted_bytes = 0u64;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 Skill 压缩包失败: {e}"))?;
        let Some(path) = file.enclosed_name() else {
            continue;
        };
        let rel = if package_root.as_os_str().is_empty() {
            path.as_path()
        } else {
            match path.strip_prefix(package_root) {
                Ok(rel) => rel,
                Err(_) => continue,
            }
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        if copied >= MAX_SKILL_ZIP_FILES {
            return Err("Skill 压缩包文件数量过多，已拒绝安装。".to_string());
        }
        extracted_bytes = extracted_bytes.saturating_add(file.size());
        if extracted_bytes > MAX_SKILL_ZIP_EXTRACTED_BYTES {
            return Err("Skill 压缩包解压后过大，已拒绝安装。".to_string());
        }

        let target = dst.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("创建目录失败 {}: {e}", target.to_string_lossy()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}: {e}", parent.to_string_lossy()))?;
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("创建文件失败 {}: {e}", target.to_string_lossy()))?;
        std::io::copy(&mut file, &mut out)
            .map_err(|e| format!("写入文件失败 {}: {e}", target.to_string_lossy()))?;
        copied += 1;
    }

    if copied == 0 {
        return Err("Skill 压缩包没有可安装文件。".to_string());
    }
    if !dst.join("SKILL.md").is_file() {
        return Err("Skill 压缩包安装后缺少 SKILL.md。".to_string());
    }
    Ok(())
}

fn install_skill_from_url_blocking(
    url: String,
    name: String,
    slug: String,
    target_id: String,
    overwrite: bool,
    source_url: Option<String>,
    project_root: Option<String>,
) -> Result<InstalledSkill, String> {
    let text = download_skill_text(&url)?;
    install_skill_from_text_blocking(
        text,
        name,
        slug,
        target_id,
        overwrite,
        source_url,
        project_root,
        Some(url),
    )
}

fn install_skill_from_zip_url_blocking(
    url: String,
    name: String,
    slug: String,
    target_id: String,
    overwrite: bool,
    source_url: Option<String>,
    project_root: Option<String>,
) -> Result<InstalledSkill, String> {
    let bytes = download_skill_zip(&url)?;
    let (package_root, frontmatter_name) = skill_zip_root_and_frontmatter(&bytes, &name)?;
    let project_root = match project_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(raw) => Some(project_scan_root(raw)?),
        None => None,
    };
    let (target_id, _label, root, _is_default) =
        skill_install_root(&target_id, project_root.as_deref())?;
    let installed_name = if name.trim().is_empty() {
        frontmatter_name
    } else {
        name.trim().to_string()
    };
    let slug_source = if slug.trim().is_empty() {
        installed_name.as_str()
    } else {
        slug.as_str()
    };
    let slug = sanitize_skill_install_slug(slug_source);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建技能目录失败: {e}"))?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("读取技能目录失败: {e}"))?;
    let target_dir = root.join(&slug);
    let skill_file = target_dir.join("SKILL.md");
    let existed = skill_file.is_file();
    if existed && !overwrite {
        return Err("目标 skill 已存在。".to_string());
    }

    if target_dir.exists() && overwrite {
        let canonical_existing = std::fs::canonicalize(&target_dir)
            .map_err(|e| format!("读取旧 Skill 目录失败: {e}"))?;
        if !canonical_existing.starts_with(&root) {
            return Err("安装路径超出允许目录。".to_string());
        }
        std::fs::remove_dir_all(&target_dir).map_err(|e| format!("清理旧 Skill 目录失败: {e}"))?;
    }
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建安装目录失败: {e}"))?;
    let canonical_target =
        std::fs::canonicalize(&target_dir).map_err(|e| format!("读取安装目录失败: {e}"))?;
    if !canonical_target.starts_with(&root) {
        return Err("安装路径超出允许目录。".to_string());
    }

    extract_skill_zip(&bytes, &target_dir, &package_root)?;
    let source_meta = serde_json::json!({
        "name": installed_name.clone(),
        "slug": slug.clone(),
        "downloadUrl": url,
        "sourceUrl": source_url.clone(),
        "installedAtMs": now_ms(),
        "installedBy": "UltraGameStudio plugin store"
    });
    let _ = std::fs::write(
        target_dir.join(".ultragamestudio-source.json"),
        serde_json::to_string_pretty(&source_meta).unwrap_or_else(|_| "{}".to_string()),
    );

    Ok(InstalledSkill {
        name: installed_name,
        slug,
        target_id,
        path: display_preview_path(&target_dir),
        skill_file: display_preview_path(&skill_file),
        source_url,
        overwritten: existed,
    })
}

fn install_skill_from_text_blocking(
    text: String,
    name: String,
    slug: String,
    target_id: String,
    overwrite: bool,
    source_url: Option<String>,
    project_root: Option<String>,
    download_url: Option<String>,
) -> Result<InstalledSkill, String> {
    if text.len() as u64 > MAX_SKILL_INSTALL_BYTES {
        return Err("SKILL.md 过大，已拒绝安装。".to_string());
    }
    if text.trim().is_empty() {
        return Err("SKILL.md 内容为空。".to_string());
    }

    let project_root = match project_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(raw) => Some(project_scan_root(raw)?),
        None => None,
    };
    let (target_id, _label, root, _is_default) =
        skill_install_root(&target_id, project_root.as_deref())?;
    let (frontmatter_name, _description) = parse_skill_frontmatter(&text, &name);
    let installed_name = if name.trim().is_empty() {
        frontmatter_name
    } else {
        name.trim().to_string()
    };
    let slug_source = if slug.trim().is_empty() {
        installed_name.as_str()
    } else {
        slug.as_str()
    };
    let slug = sanitize_skill_install_slug(slug_source);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建技能目录失败: {e}"))?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("读取技能目录失败: {e}"))?;
    let target_dir = root.join(&slug);
    let skill_file = target_dir.join("SKILL.md");
    let existed = skill_file.is_file();
    if existed && !overwrite {
        return Err("目标 skill 已存在。".to_string());
    }

    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建安装目录失败: {e}"))?;
    let canonical_target =
        std::fs::canonicalize(&target_dir).map_err(|e| format!("读取安装目录失败: {e}"))?;
    if !canonical_target.starts_with(&root) {
        return Err("安装路径超出允许目录。".to_string());
    }

    std::fs::write(&skill_file, text).map_err(|e| format!("写入 SKILL.md 失败: {e}"))?;
    let source_meta = serde_json::json!({
        "name": installed_name.clone(),
        "slug": slug.clone(),
        "downloadUrl": download_url,
        "sourceUrl": source_url.clone(),
        "installedAtMs": now_ms(),
        "installedBy": "UltraGameStudio plugin store"
    });
    let _ = std::fs::write(
        target_dir.join(".ultragamestudio-source.json"),
        serde_json::to_string_pretty(&source_meta).unwrap_or_else(|_| "{}".to_string()),
    );

    Ok(InstalledSkill {
        name: installed_name,
        slug,
        target_id,
        path: display_preview_path(&target_dir),
        skill_file: display_preview_path(&skill_file),
        source_url,
        overwritten: existed,
    })
}

#[tauri::command]
async fn install_skill_from_url(
    app: AppHandle,
    url: String,
    name: String,
    slug: String,
    target_id: String,
    overwrite: Option<bool>,
    source_url: Option<String>,
    project_root: Option<String>,
) -> Result<InstalledSkill, String> {
    let installed = tauri::async_runtime::spawn_blocking(move || {
        install_skill_from_url_blocking(
            url,
            name,
            slug,
            target_id,
            overwrite.unwrap_or(false),
            source_url,
            project_root,
        )
    })
    .await
    .map_err(|e| format!("安装任务失败: {e}"))??;
    let _ = refresh_slash_catalog_async(app).await;
    Ok(installed)
}

#[tauri::command]
async fn install_skill_from_zip_url(
    app: AppHandle,
    url: String,
    name: String,
    slug: String,
    target_id: String,
    overwrite: Option<bool>,
    source_url: Option<String>,
    project_root: Option<String>,
) -> Result<InstalledSkill, String> {
    let installed = tauri::async_runtime::spawn_blocking(move || {
        install_skill_from_zip_url_blocking(
            url,
            name,
            slug,
            target_id,
            overwrite.unwrap_or(false),
            source_url,
            project_root,
        )
    })
    .await
    .map_err(|e| format!("安装任务失败: {e}"))??;
    let _ = refresh_slash_catalog_async(app).await;
    Ok(installed)
}

#[tauri::command]
async fn install_skill_from_text(
    app: AppHandle,
    text: String,
    name: String,
    slug: String,
    target_id: String,
    overwrite: Option<bool>,
    source_url: Option<String>,
    project_root: Option<String>,
) -> Result<InstalledSkill, String> {
    let installed = tauri::async_runtime::spawn_blocking(move || {
        install_skill_from_text_blocking(
            text,
            name,
            slug,
            target_id,
            overwrite.unwrap_or(false),
            source_url,
            project_root,
            None,
        )
    })
    .await
    .map_err(|e| format!("安装任务失败: {e}"))??;
    let _ = refresh_slash_catalog_async(app).await;
    Ok(installed)
}

fn uninstall_skill_blocking(
    target_id: String,
    slug: String,
    project_root: Option<String>,
) -> Result<SkillUninstallResult, String> {
    let project_root = match project_root
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(raw) => Some(project_scan_root(raw)?),
        None => None,
    };
    let (target_id, _label, root, _is_default) =
        skill_install_root(&target_id, project_root.as_deref())?;
    let slug = sanitize_skill_install_slug(&slug);
    let display_path = display_preview_path(&root.join(&slug));
    if !root.is_dir() {
        return Ok(SkillUninstallResult {
            target_id,
            slug,
            path: display_path,
            removed: false,
        });
    }

    let root = std::fs::canonicalize(&root).map_err(|e| format!("读取技能目录失败: {e}"))?;
    let target_dir = root.join(&slug);
    if !target_dir.exists() {
        return Ok(SkillUninstallResult {
            target_id,
            slug,
            path: display_preview_path(&target_dir),
            removed: false,
        });
    }
    let canonical_target =
        std::fs::canonicalize(&target_dir).map_err(|e| format!("读取安装目录失败: {e}"))?;
    if !canonical_target.starts_with(&root) {
        return Err("卸载路径超出允许目录。".to_string());
    }
    if !canonical_target.join("SKILL.md").is_file() {
        return Err("目标目录不是可卸载的 skill。".to_string());
    }

    std::fs::remove_dir_all(&canonical_target).map_err(|e| format!("卸载失败: {e}"))?;
    Ok(SkillUninstallResult {
        target_id,
        slug,
        path: display_preview_path(&canonical_target),
        removed: true,
    })
}

#[tauri::command]
async fn uninstall_skill(
    app: AppHandle,
    target_id: String,
    slug: String,
    project_root: Option<String>,
) -> Result<SkillUninstallResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        uninstall_skill_blocking(target_id, slug, project_root)
    })
    .await
    .map_err(|e| format!("卸载任务失败: {e}"))??;
    let _ = refresh_slash_catalog_async(app).await;
    Ok(result)
}

fn known_free_channel_ids() -> HashSet<&'static str> {
    FREE_CHANNEL_ENV_MAPPINGS
        .iter()
        .map(|(channel_id, _)| *channel_id)
        .collect()
}

fn read_free_channel_key_file(path: PathBuf) -> HashMap<String, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return HashMap::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return HashMap::new(),
    };
    let keys = parsed.get("keys").unwrap_or(&parsed);
    let known = known_free_channel_ids();
    let mut out = HashMap::new();
    if let Some(obj) = keys.as_object() {
        for (channel_id, value) in obj {
            if !known.contains(channel_id.as_str()) {
                continue;
            }
            if let Some(key) = value.as_str() {
                let trimmed = key.trim();
                if !trimmed.is_empty() {
                    out.insert(channel_id.clone(), trimmed.to_string());
                }
            }
        }
    }
    out
}

fn free_channel_key_file_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(path) = std::env::var("ULTRAGAMESTUDIO_FREE_CHANNELS_CONFIG") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            out.push(PathBuf::from(trimmed));
        }
    }
    if let Ok(root) = storage_paths::global_root() {
        out.push(root.join("channels").join("free-channels.private.json"));
        out.push(root.join("free-channels.private.json"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("free-channels.private.json"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("free-channels.private.json"));
        out.push(cwd.join("app").join("free-channels.private.json"));
        out.push(cwd.join("..").join("free-channels.private.json"));
    }
    out
}

fn free_channel_auto_keys_blocking() -> HashMap<String, String> {
    let mut out = HashMap::new();
    for path in free_channel_key_file_candidates() {
        for (channel_id, key) in read_free_channel_key_file(path) {
            out.entry(channel_id).or_insert(key);
        }
    }
    for (channel_id, vars) in FREE_CHANNEL_ENV_MAPPINGS {
        for var in *vars {
            if let Ok(value) = std::env::var(var) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    out.entry((*channel_id).to_string())
                        .or_insert_with(|| trimmed.to_string());
                    break;
                }
            }
        }
    }
    out
}

#[tauri::command]
async fn free_channel_auto_keys() -> HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(free_channel_auto_keys_blocking)
        .await
        .unwrap_or_default()
}

/// Map a frontend adapter id to the local CLI binary that runs it.
///
///   claude-code -> claude
///   codex       -> codex
///   gemini      -> gemini
///
/// Unknown adapters fall back to the literal id so a custom CLI on PATH can
/// still be targeted.
/// Best-effort self-heal for a bun-installed `claude` whose binary an
/// interrupted auto-update renamed to `claude.exe.old.<timestamp>` (leaving the
/// CLI broken: "bin executable does not exist on disk / corrupted node_modules").
///
/// If the expected binary is missing but a renamed `.old` copy exists, the newest
/// one is restored. No-op on non-bun / non-Windows installs (paths won't match),
/// so it is safe to call unconditionally before spawning claude. Combined with
/// `DISABLE_AUTOUPDATER=1` on the spawn (which stops the CLI from re-corrupting
/// itself), this keeps the run working across the auto-update breakage loop.
fn repair_claude_binary() {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return;
    }
    let bin_dir = std::path::Path::new(&home)
        .join(".bun")
        .join("install")
        .join("global")
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("bin");
    // The binary is `claude.exe` on Windows, `claude` elsewhere.
    for target_name in ["claude.exe", "claude"] {
        let target = bin_dir.join(target_name);
        if target.exists() {
            return; // healthy
        }
        let prefix = format!("{target_name}.old.");
        let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
        if let Ok(entries) = std::fs::read_dir(&bin_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().starts_with(&prefix) {
                    if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                        if newest.as_ref().map_or(true, |(t, _)| modified > *t) {
                            newest = Some((modified, entry.path()));
                        }
                    }
                }
            }
        }
        if let Some((_, src)) = newest {
            let _ = std::fs::copy(&src, &target);
            return;
        }
    }
}

fn temp_stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn managed_temp_path(cwd: Option<&str>, bucket: &str, prefix: &str, ext: &str) -> PathBuf {
    let mut path = storage_paths::managed_artifact_dir(cwd, bucket);
    path.push(format!("{prefix}-{}.{ext}", temp_stamp()));
    path
}

/// Write the generated script to a uniquely-named temp file and return its path.
fn write_temp_script(script: &str) -> Result<std::path::PathBuf, String> {
    let path = managed_temp_path(None, "scripts", "ultragamestudio", "sh");
    let mut file = std::fs::File::create(&path).map_err(|e| format!("无法创建临时脚本: {e}"))?;
    file.write_all(script.as_bytes())
        .map_err(|e| format!("写入临时脚本失败: {e}"))?;
    Ok(path)
}

/// Return a unique temp path for CLI side-channel output.
fn temp_output_path(prefix: &str, ext: &str) -> std::path::PathBuf {
    temp_output_path_for_cwd(None, prefix, ext)
}

fn temp_output_path_for_cwd(cwd: Option<&str>, prefix: &str, ext: &str) -> std::path::PathBuf {
    managed_temp_path(cwd, "sidecar", prefix, ext)
}

struct TempFileGuard {
    path: PathBuf,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Strip the Windows extended-length (`\\?\`) prefix from a path before it is
/// handed to `cmd.exe /C`. `cmd` cannot resolve `\\?\C:\...` verbatim paths and
/// fails with "系统找不到指定的路径" (exit code 1). Validation already simplifies
/// stored paths, but a `\\?\` form may still reach the launcher (e.g. a PATH
/// scan or an externally supplied override), so we strip defensively here too.
/// On non-Windows the path passes through unchanged.
fn cmd_arg_path(binary: &str) -> String {
    if let Some(rest) = binary.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = binary.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    binary.to_string()
}

fn spawn_cli_command(binary: &str) -> Command {
    #[cfg(windows)]
    {
        let path = std::path::Path::new(binary);
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.to_ascii_lowercase());
        if matches!(ext.as_deref(), Some("cmd" | "bat")) {
            let mut cmd = new_spawn_command("cmd");
            cmd.arg("/C").arg(cmd_arg_path(binary));
            return cmd;
        }
    }

    new_spawn_command(binary)
}

/// Optional launch shell that wraps an AI CLI invocation (see `shellConfig.ts`).
/// `kind` is one of `direct` | `cmd` | `powershell` | `custom`; `path` is the
/// shell executable for `custom` (and optionally `powershell`).
#[derive(serde::Deserialize)]
pub struct ShellSpec {
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
}

/// PowerShell single-quoted literal (double any embedded single quotes).
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Direct spawn: the historical behaviour (auto `cmd /C` for `.cmd/.bat`).
fn direct_command(binary: &str, args: &[String]) -> Command {
    let mut cmd = spawn_cli_command(binary);
    for a in args {
        cmd.arg(a);
    }
    cmd
}

/// Build the command that launches `binary` with `args`, optionally wrapped in
/// a user-selected launch shell so the AI CLI inherits that shell's
/// environment/PATH. `None`/`direct` preserves the historical direct spawn.
///
/// POSIX shells pass argv natively via `-lc 'exec "$@"'` (no re-quoting, so
/// spaces/special chars are safe). Windows cmd/PowerShell quoting is
/// best-effort. Env vars / working dir / stdio are applied by the caller to the
/// returned (outer) command and inherited by the wrapped child.
fn build_launch_command(binary: &str, args: &[String], shell: &Option<ShellSpec>) -> Command {
    let kind = shell.as_ref().map(|s| s.kind.as_str()).unwrap_or("direct");
    match kind {
        "cmd" => {
            let mut cmd = new_spawn_command("cmd");
            cmd.arg("/C").arg(cmd_arg_path(binary));
            for a in args {
                cmd.arg(a);
            }
            cmd
        }
        "powershell" => {
            let exe = shell
                .as_ref()
                .and_then(|s| s.path.as_deref())
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .unwrap_or("powershell");
            powershell_command(exe, binary, args)
        }
        "custom" => {
            let path = shell
                .as_ref()
                .and_then(|s| s.path.as_deref())
                .map(str::trim)
                .filter(|p| !p.is_empty());
            match path {
                None => direct_command(binary, args),
                Some(path) => {
                    let lower = path.to_ascii_lowercase();
                    if lower.ends_with("powershell.exe")
                        || lower.ends_with("pwsh.exe")
                        || lower.ends_with("powershell")
                        || lower.ends_with("pwsh")
                    {
                        powershell_command(path, binary, args)
                    } else if lower.ends_with("cmd.exe") || lower.ends_with("cmd") {
                        let mut cmd = new_spawn_command(path);
                        cmd.arg("/C").arg(cmd_arg_path(binary));
                        for a in args {
                            cmd.arg(a);
                        }
                        cmd
                    } else {
                        // Treat as a POSIX login shell: pass argv natively.
                        let mut cmd = new_spawn_command(path);
                        cmd.arg("-lc")
                            .arg(r#"exec "$@""#)
                            .arg("ugs-shell")
                            .arg(binary);
                        for a in args {
                            cmd.arg(a);
                        }
                        cmd
                    }
                }
            }
        }
        _ => direct_command(binary, args),
    }
}

fn powershell_command(exe: &str, binary: &str, args: &[String]) -> Command {
    let mut cmd = new_spawn_command(exe);
    let mut script = String::from("& ");
    script.push_str(&ps_quote(binary));
    for a in args {
        script.push(' ');
        script.push_str(&ps_quote(a));
    }
    cmd.arg("-NoProfile").arg("-Command").arg(script);
    cmd
}

/// Validate a user-selected *launch shell* path. Unlike `validate_cli_path`
/// this intentionally allows shells. Returns the normalized absolute path.
fn validate_shell_path_blocking(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请选择 Shell 可执行文件。".to_string());
    }
    let p = std::path::Path::new(trimmed);
    let canonical =
        std::fs::canonicalize(p).map_err(|_| "找不到该文件，请重新选择。".to_string())?;
    if !canonical.is_file() {
        return Err("请选择一个可执行文件。".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
async fn validate_shell_path(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || validate_shell_path_blocking(path))
        .await
        .map_err(|e| format!("Shell 路径校验任务失败: {e}"))?
}

fn open_external_blocking(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("invalid url".to_string());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = new_spawn_command("cmd");
        c.args(["/C", "start", "", u]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = new_spawn_command("open");
        c.arg(u);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = new_spawn_command("xdg-open");
        c.arg(u);
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_external_blocking(url))
        .await
        .map_err(|e| format!("打开外部链接任务失败: {e}"))?
}

fn open_workspace_directory_blocking(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("工作区路径为空".to_string());
    }

    let dir = PathBuf::from(trimmed);
    let metadata = std::fs::metadata(&dir).map_err(|e| format!("读取工作区目录失败：{e}"))?;
    if !metadata.is_dir() {
        return Err("工作区路径不是目录".to_string());
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = new_spawn_command("explorer.exe");
        c.arg(&dir);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = new_spawn_command("open");
        c.arg(&dir);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = new_spawn_command("xdg-open");
        c.arg(&dir);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("打开工作区目录失败：{e}"))?;
    Ok(())
}

#[tauri::command]
async fn open_workspace_directory(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_workspace_directory_blocking(path))
        .await
        .map_err(|e| format!("打开工作区目录任务失败: {e}"))?
}

const PREVIEW_TEXT_LIMIT: u64 = 1_500_000;
const PREVIEW_IMAGE_LIMIT: u64 = 12 * 1024 * 1024;
const PREVIEW_DOCUMENT_LIMIT: u64 = 64 * 1024 * 1024;
const PREVIEW_BASENAME_SEARCH_LIMIT: usize = 20_000;
const CLIPBOARD_IMAGE_LIMIT: usize = 32 * 1024 * 1024;
const SESSION_CAPTURE_LIMIT: usize = 128 * 1024 * 1024;
const LOCAL_FILE_UPLOAD_LIMIT: u64 = 128 * 1024 * 1024;
const CAPTURE_IMAGE_FETCH_LIMIT: usize = 32 * 1024 * 1024;
const CAPTURE_IMAGE_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const MODEL_ASSET_FETCH_LIMIT: usize = 128 * 1024 * 1024;
const MODEL_ASSET_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Normalize path separators per-platform.
///
/// AI prose sometimes emits Windows-style paths (e.g. `\Users\me\file.md` or
/// `src\store\x.ts`) even when the app runs on macOS/Linux, where `\` is not a
/// path separator. On non-Windows platforms we rewrite `\` -> `/` so the path
/// can resolve; on Windows both separators are already valid, so we leave the
/// string untouched (a literal `\` could legitimately appear there).
#[cfg(windows)]
fn normalize_preview_separators(path: &str) -> String {
    path.to_string()
}

#[cfg(not(windows))]
fn normalize_preview_separators(path: &str) -> String {
    path.replace('\\', "/")
}

fn preview_path(path: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径为空。".to_string());
    }
    let raw = PathBuf::from(trimmed);
    if raw.is_absolute() {
        return Ok(raw);
    }
    let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) else {
        return Ok(raw);
    };
    Ok(PathBuf::from(cwd).join(raw))
}

fn preview_workspace_app_fallback(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let cwd = cwd?.trim();
    if cwd.is_empty() {
        return None;
    }

    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return None;
    }

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let raw = PathBuf::from(trimmed);
    let candidate = if raw.is_absolute() {
        let relative = raw.strip_prefix(&root).ok()?;
        root.join("app").join(relative)
    } else {
        root.join("app").join(raw)
    };

    candidate.exists().then_some(candidate)
}

fn path_segments_for_suffix_match(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|segment| !segment.trim().is_empty())
        .collect()
}

fn path_segments_equal(a: &[&str], b: &[&str]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b.iter()).all(|(left, right)| {
            if cfg!(windows) {
                left.eq_ignore_ascii_case(right)
            } else {
                left == right
            }
        })
}

fn preview_depot_path_fallback(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let trimmed = path.trim();
    if !trimmed.starts_with("//") || trimmed.starts_with("///") {
        return None;
    }

    let cwd = cwd?.trim();
    if cwd.is_empty() {
        return None;
    }
    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return None;
    }

    let depot = normalize_p4_mapping_path(trimmed);
    let depot_segments = path_segments_for_suffix_match(depot.trim_start_matches('/'));
    if depot_segments.is_empty() {
        return None;
    }

    let cwd_normalized = normalize_p4_mapping_path(&root.to_string_lossy());
    let cwd_segments = path_segments_for_suffix_match(&cwd_normalized);
    let mut starts = Vec::new();
    let max_overlap = cwd_segments.len().min(depot_segments.len());
    for overlap in (1..=max_overlap).rev() {
        if path_segments_equal(
            &cwd_segments[cwd_segments.len() - overlap..],
            &depot_segments[..overlap],
        ) {
            starts.push(overlap);
            break;
        }
    }
    starts.extend(0..depot_segments.len());

    let mut seen = HashSet::new();
    for start in starts {
        if start >= depot_segments.len() || !seen.insert(start) {
            continue;
        }
        let mut candidate = root.clone();
        for segment in &depot_segments[start..] {
            candidate.push(segment);
        }
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

#[cfg(windows)]
fn display_preview_path(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    raw.strip_prefix(r"\\?\").unwrap_or(&raw).to_string()
}

#[cfg(not(windows))]
fn display_preview_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

const WORKSPACE_TREE_ENTRY_LIMIT: usize = 500;
const WORKSPACE_TREE_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".ultragamestudio",
    ".worktree",
    ".omc",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    "binaries",
    "deriveddatacache",
    "intermediate",
    "saved",
];

fn workspace_tree_relative_key(relative_path: Option<String>) -> String {
    relative_path
        .unwrap_or_default()
        .replace('\\', "/")
        .trim_matches('/')
        .trim()
        .trim_matches('/')
        .to_string()
}

fn workspace_tree_modified_at_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn workspace_tree_child_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn workspace_tree_excluded_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    WORKSPACE_TREE_EXCLUDED_DIRS
        .iter()
        .any(|excluded| lower == *excluded)
}

fn workspace_tree_resolve_dir(
    root_path: &str,
    relative_path: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let root = PathBuf::from(root_path.trim());
    if root.as_os_str().is_empty() {
        return Err("工作区路径为空。".to_string());
    }
    let root = std::fs::canonicalize(&root).map_err(|e| format!("读取工作区失败：{e}"))?;
    if !root.is_dir() {
        return Err("工作区不是文件夹。".to_string());
    }

    let relative = PathBuf::from(relative_path);
    if relative.is_absolute() {
        return Err("目录路径必须在工作区内。".to_string());
    }
    let target = if relative_path.is_empty() {
        root.clone()
    } else {
        root.join(relative)
    };
    let target = std::fs::canonicalize(&target).map_err(|e| format!("读取目录失败：{e}"))?;
    if !target.starts_with(&root) {
        return Err("目录路径超出工作区。".to_string());
    }
    if !target.is_dir() {
        return Err("目标不是文件夹。".to_string());
    }

    Ok((root, target))
}

fn list_workspace_dir_blocking(
    root_path: String,
    relative_path: Option<String>,
) -> Result<WorkspaceDirectoryListing, String> {
    let relative_path = workspace_tree_relative_key(relative_path);
    let (root, target) = workspace_tree_resolve_dir(&root_path, &relative_path)?;
    let mut entries = Vec::new();

    for entry in std::fs::read_dir(&target).map_err(|e| format!("读取目录失败：{e}"))? {
        let Ok(entry) = entry else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_dir = file_type.is_dir();
        if is_dir && workspace_tree_excluded_dir(&name) {
            continue;
        }

        let metadata = entry.metadata().ok();
        entries.push(WorkspaceTreeEntry {
            relative_path: workspace_tree_child_relative(&relative_path, &name),
            path: display_preview_path(&entry.path()),
            hidden: name.starts_with('.'),
            size_bytes: metadata
                .as_ref()
                .and_then(|m| m.is_file().then_some(m.len())),
            modified_at_ms: metadata.as_ref().and_then(workspace_tree_modified_at_ms),
            kind: if is_dir { "directory" } else { "file" }.to_string(),
            name,
        });
    }

    entries.sort_by(|a, b| {
        let dir_rank = if a.kind == b.kind {
            std::cmp::Ordering::Equal
        } else if a.kind == "directory" {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
        dir_rank.then_with(|| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
                .then_with(|| a.name.cmp(&b.name))
        })
    });

    let total_entries = entries.len();
    let truncated = total_entries > WORKSPACE_TREE_ENTRY_LIMIT;
    entries.truncate(WORKSPACE_TREE_ENTRY_LIMIT);

    Ok(WorkspaceDirectoryListing {
        root_path: display_preview_path(&root),
        relative_path,
        entries,
        truncated,
        total_entries,
    })
}

#[tauri::command]
async fn list_workspace_dir(
    root_path: String,
    relative_path: Option<String>,
) -> Result<WorkspaceDirectoryListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_dir_blocking(root_path, relative_path)
    })
    .await
    .map_err(|e| format!("文件树读取任务失败: {e}"))?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEngineDetection {
    engine: String,
    label: String,
    confidence: f32,
    project_file: Option<String>,
    version: Option<String>,
    markers: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSkillRootSnapshot {
    id: String,
    label: String,
    path: String,
    exists: bool,
    skill_count: usize,
    skills: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMcpServerSuggestion {
    id: String,
    label: String,
    description: String,
    transport: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    url: Option<String>,
    available: bool,
    availability_note: String,
    requires_user_approval: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEnvironmentScan {
    root_path: String,
    scanned_at_ms: u64,
    engine: ProjectEngineDetection,
    skill_roots: Vec<ProjectSkillRootSnapshot>,
    suggested_mcp_servers: Vec<ProjectMcpServerSuggestion>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMcpProbeServerConfig {
    id: String,
    transport: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMcpProbeResult {
    server_id: String,
    ok: bool,
    status: String,
    message: String,
    tools_count: Option<usize>,
    checked_at_ms: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectLspProbeServerConfig {
    id: String,
    command: Option<String>,
    args: Option<Vec<String>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectLspProbeResult {
    server_id: String,
    ok: bool,
    status: String,
    message: String,
    resolved_command: Option<String>,
    checked_at_ms: u64,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectLspInstallCommand {
    label: String,
    command: String,
    args: Vec<String>,
    platforms: Option<Vec<cli_runtime::CliPlatform>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectLspInstallRequest {
    server_id: String,
    commands: Vec<ProjectLspInstallCommand>,
    cwd: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectLspInstallResult {
    server_id: String,
    ok: bool,
    status: String,
    message: String,
    command_line: Option<String>,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    platform: cli_runtime::CliPlatform,
    checked_at_ms: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnityMcpSetupRequest {
    root_path: String,
    write_manifest: Option<bool>,
    write_mcp_config: Option<bool>,
    dry_run: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnityMcpSetupResult {
    ok: bool,
    changed: bool,
    dry_run: bool,
    package_id: String,
    package_url: String,
    configured_files: Vec<String>,
    changed_files: Vec<String>,
    notes: Vec<String>,
    warnings: Vec<String>,
    error: Option<String>,
    server_command: String,
    server_args: Vec<String>,
}

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenericProjectMcpSetupRequest {
    root_path: String,
    dry_run: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GenericProjectMcpSetupResult {
    ok: bool,
    changed: bool,
    dry_run: bool,
    server_id: String,
    label: String,
    description: String,
    transport: String,
    server_command: Option<String>,
    server_args: Vec<String>,
    server_url: Option<String>,
    configured_files: Vec<String>,
    changed_files: Vec<String>,
    notes: Vec<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

fn project_path_display(path: &Path) -> String {
    display_preview_path(path)
}

fn project_scan_root(root_path: &str) -> Result<PathBuf, String> {
    let trimmed = root_path.trim();
    if trimmed.is_empty() {
        return Err("工作区路径为空。".to_string());
    }
    let root = std::fs::canonicalize(PathBuf::from(trimmed))
        .map_err(|e| format!("读取工作区失败：{e}"))?;
    if !root.is_dir() {
        return Err("工作区不是文件夹。".to_string());
    }
    Ok(root)
}

fn project_relative_marker(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
}

fn project_first_root_file_with_ext(root: &Path, ext: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(ext))
        {
            return Some(path);
        }
    }
    None
}

fn project_read_small_text(path: &Path, max_bytes: usize) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let slice = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        &bytes
    };
    String::from_utf8(slice.to_vec()).ok()
}

fn project_json_string(path: &Path, key: &str) -> Option<String> {
    let text = project_read_small_text(path, 256 * 1024)?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        .get(key)?
        .as_str()
        .map(|value| value.to_string())
}

fn unity_editor_version(root: &Path) -> Option<String> {
    let text = project_read_small_text(&root.join("ProjectSettings/ProjectVersion.txt"), 4096)?;
    text.lines()
        .find_map(|line| line.trim().strip_prefix("m_EditorVersion:"))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn godot_project_format(root: &Path) -> Option<String> {
    let text = project_read_small_text(&root.join("project.godot"), 64 * 1024)?;
    text.lines()
        .find_map(|line| line.trim().strip_prefix("config_version="))
        .map(|value| format!("project format {}", value.trim()))
        .filter(|value| !value.ends_with(' '))
}

fn cocos_project_name(root: &Path) -> Option<String> {
    project_json_string(&root.join("project.json"), "name")
        .or_else(|| project_json_string(&root.join("settings/project.json"), "name"))
}

fn detect_project_engine(root: &Path) -> ProjectEngineDetection {
    if let Some(project_file) = project_first_root_file_with_ext(root, "uproject") {
        let mut markers = vec![project_relative_marker(root, &project_file)];
        if root.join("Config/DefaultEngine.ini").exists() {
            markers.push("Config/DefaultEngine.ini".to_string());
        }
        let version = project_json_string(&project_file, "EngineAssociation");
        return ProjectEngineDetection {
            engine: "unreal".to_string(),
            label: "Unreal Engine".to_string(),
            confidence: 0.96,
            project_file: Some(project_path_display(&project_file)),
            version,
            markers,
        };
    }

    let unity_manifest = root.join("Packages/manifest.json");
    let unity_settings = root.join("ProjectSettings");
    if unity_manifest.is_file() && unity_settings.is_dir() {
        let mut markers = vec![
            "Packages/manifest.json".to_string(),
            "ProjectSettings/".to_string(),
        ];
        if root.join("Assets").is_dir() {
            markers.push("Assets/".to_string());
        }
        return ProjectEngineDetection {
            engine: "unity".to_string(),
            label: "Unity".to_string(),
            confidence: 0.94,
            project_file: Some(project_path_display(&unity_manifest)),
            version: unity_editor_version(root),
            markers,
        };
    }

    let godot_file = root.join("project.godot");
    if godot_file.is_file() {
        return ProjectEngineDetection {
            engine: "godot".to_string(),
            label: "Godot".to_string(),
            confidence: 0.95,
            project_file: Some(project_path_display(&godot_file)),
            version: godot_project_format(root),
            markers: vec!["project.godot".to_string()],
        };
    }

    let cocos_project = root.join("project.json");
    let cocos_settings_project = root.join("settings/project.json");
    let cocos_assets = root.join("assets");
    if (cocos_project.is_file() || cocos_settings_project.is_file()) && cocos_assets.is_dir() {
        let mut markers = vec!["assets/".to_string()];
        let project_file = if cocos_project.is_file() {
            markers.push("project.json".to_string());
            cocos_project
        } else {
            markers.push("settings/project.json".to_string());
            cocos_settings_project
        };
        if root.join("settings").is_dir() && !markers.iter().any(|marker| marker == "settings/") {
            markers.push("settings/".to_string());
        }
        if root.join("extensions").is_dir() {
            markers.push("extensions/".to_string());
        }
        return ProjectEngineDetection {
            engine: "cocos".to_string(),
            label: "Cocos".to_string(),
            confidence: 0.86,
            project_file: Some(project_path_display(&project_file)),
            version: cocos_project_name(root),
            markers,
        };
    }

    ProjectEngineDetection {
        engine: "unknown".to_string(),
        label: "未识别".to_string(),
        confidence: 0.0,
        project_file: None,
        version: None,
        markers: Vec::new(),
    }
}

// ===== Jump-to-engine (reveal asset inside the running editor) =====
//
// Right-click → "在引擎中定位" tries to bring the file into focus inside the
// running editor. Only Unreal is wired to a real, stable local channel today:
// the app already configures RemoteControl (HTTP :30010) for the UE MCP bridge,
// so we reuse it to run a tiny Python snippet that syncs the Content Browser to
// the asset. Unity / Godot / Cocos have no equally-stable app-side channel yet,
// so they degrade to an informative result the UI surfaces as a hint.

const UE_REMOTE_CONTROL_HTTP_PORT: u16 = 30010;
const UE_PYTHON_LIBRARY_OBJECT: &str = "/Script/PythonScriptPlugin.Default__PythonScriptLibrary";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineRevealResult {
    ok: bool,
    /// unreal / unity / godot / cocos / unknown
    engine: String,
    /// jumped | not_asset | engine_unreachable | unsupported | error
    status: String,
    message: String,
}

impl EngineRevealResult {
    fn new(engine: &str, ok: bool, status: &str, message: impl Into<String>) -> Self {
        Self {
            ok,
            engine: engine.to_string(),
            status: status.to_string(),
            message: message.into(),
        }
    }
}

/// Map an Unreal `.uasset` / `.umap` file path to its mount-point package path
/// (e.g. `D:/Proj/Content/Maps/Main.umap` → `/Game/Maps/Main`). Returns `None`
/// for files that are not engine assets (source, config, etc.).
fn unreal_asset_package_path(root: &Path, file: &Path) -> Option<String> {
    let ext = file.extension()?.to_string_lossy().to_lowercase();
    if ext != "uasset" && ext != "umap" {
        return None;
    }
    let rel = file.strip_prefix(root).ok()?;
    let comps: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    let content_idx = comps
        .iter()
        .position(|c| c.eq_ignore_ascii_case("Content"))?;
    // Mount point: project content → /Game, plugin content → /<PluginName>.
    let mount = if content_idx >= 2 && comps[content_idx - 2].eq_ignore_ascii_case("Plugins") {
        format!("/{}", comps[content_idx - 1])
    } else {
        "/Game".to_string()
    };
    let after = &comps[content_idx + 1..];
    if after.is_empty() {
        return None;
    }
    let mut tail = after.join("/");
    if let Some(pos) = tail.rfind('.') {
        tail.truncate(pos);
    }
    if tail.is_empty() {
        return None;
    }
    Some(format!("{mount}/{tail}"))
}

/// Drive a running Unreal editor (via RemoteControl HTTP + Python) to sync the
/// Content Browser to `package_path`. Runs on a blocking thread (ureq).
fn unreal_sync_content_browser(package_path: &str) -> EngineRevealResult {
    // Package paths only contain `/`, letters, digits, `_`, `-` and similar; no
    // quotes/backslashes, so embedding it in a single-quoted Python literal is
    // safe. Guard anyway by rejecting characters that could break out.
    if package_path.contains('\'') || package_path.contains('\\') {
        return EngineRevealResult::new(
            "unreal",
            false,
            "error",
            "资产路径包含非法字符，无法在引擎中定位。",
        );
    }
    let python = format!(
        "import unreal\n\
asset_path = '{package_path}'\n\
if unreal.EditorAssetLibrary.does_asset_exist(asset_path):\n\
    unreal.EditorAssetLibrary.sync_browser_to_objects([asset_path])\n\
else:\n\
    raise Exception('asset not found: ' + asset_path)\n"
    );
    let url = format!("http://127.0.0.1:{UE_REMOTE_CONTROL_HTTP_PORT}/remote/object/call");
    let body = serde_json::json!({
        "objectPath": UE_PYTHON_LIBRARY_OBJECT,
        "functionName": "ExecutePythonCommand",
        "parameters": { "PythonCommand": python },
        "generateTransaction": false,
    });
    match ureq::request("PUT", &url)
        .timeout(std::time::Duration::from_secs(4))
        .send_json(body)
    {
        Ok(_) => EngineRevealResult::new("unreal", true, "jumped", "已在 Unreal 编辑器中定位资产。"),
        Err(ureq::Error::Status(code, _)) => EngineRevealResult::new(
            "unreal",
            false,
            "error",
            format!(
                "Unreal RemoteControl 返回 HTTP {code}。请确认编辑器已启用 RemoteControl/Python 插件（可在项目设置里一键配置 UE MCP）。"
            ),
        ),
        Err(_) => EngineRevealResult::new(
            "unreal",
            false,
            "engine_unreachable",
            format!(
                "无法连接到 Unreal 编辑器（127.0.0.1:{UE_REMOTE_CONTROL_HTTP_PORT}）。请先打开该工程的编辑器，并确保已启用 RemoteControl 自动启动。"
            ),
        ),
    }
}

fn engine_reveal_asset_blocking(root_path: String, file_path: String) -> EngineRevealResult {
    let root = PathBuf::from(project_expand_path_text(&root_path));
    let file = PathBuf::from(project_expand_path_text(&file_path));
    let detection = detect_project_engine(&root);
    match detection.engine.as_str() {
        "unreal" => match unreal_asset_package_path(&root, &file) {
            Some(package_path) => unreal_sync_content_browser(&package_path),
            None => EngineRevealResult::new(
                "unreal",
                false,
                "not_asset",
                "该文件不是 Unreal 资产（仅 Content 下的 .uasset/.umap 可在引擎中定位）。",
            ),
        },
        "unity" => EngineRevealResult::new(
            "unity",
            false,
            "unsupported",
            "暂未支持自动在 Unity 编辑器中定位，请手动切换到 Unity 窗口。",
        ),
        "godot" => EngineRevealResult::new(
            "godot",
            false,
            "unsupported",
            "暂未支持自动在 Godot 编辑器中定位，请手动切换到 Godot 窗口。",
        ),
        "cocos" => EngineRevealResult::new(
            "cocos",
            false,
            "unsupported",
            "暂未支持自动在 Cocos 编辑器中定位，请手动切换到 Cocos 窗口。",
        ),
        _ => EngineRevealResult::new(
            "unknown",
            false,
            "unsupported",
            "当前工作区未识别为受支持的引擎工程（Unreal/Unity/Godot/Cocos）。",
        ),
    }
}

#[tauri::command]
async fn engine_reveal_asset(root_path: String, file_path: String) -> EngineRevealResult {
    tauri::async_runtime::spawn_blocking(move || engine_reveal_asset_blocking(root_path, file_path))
        .await
        .unwrap_or_else(|err| {
            EngineRevealResult::new(
                "unknown",
                false,
                "error",
                format!("引擎定位任务失败：{err}"),
            )
        })
}

fn project_expand_path_text(input: &str) -> String {
    let mut value = input.trim().to_string();
    if value.starts_with("~/") || value.starts_with("~\\") {
        if let Some(home) = user_home_dir() {
            value = home
                .join(
                    value
                        .trim_start_matches('~')
                        .trim_start_matches(&['/', '\\'][..]),
                )
                .to_string_lossy()
                .to_string();
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        value = value.replace("%USERPROFILE%", &home);
    }
    if let Ok(home) = std::env::var("HOME") {
        value = value.replace("$HOME", &home);
    }
    value
}

fn project_command_available(command: &str) -> (bool, String) {
    let command = project_expand_path_text(command);
    if command.trim().is_empty() {
        return (false, "命令为空".to_string());
    }
    let path_like =
        command.contains('/') || command.contains('\\') || Path::new(&command).is_absolute();
    if path_like {
        let exists = Path::new(&command).exists();
        return (
            exists,
            if exists {
                "命令路径存在".to_string()
            } else {
                "命令路径不存在，需在项目设置里修正".to_string()
            },
        );
    }
    match cli_runtime::resolve_command_path(&command) {
        Some(path) => (true, format!("已找到 {}", project_path_display(&path))),
        None => (false, "PATH 中未找到命令".to_string()),
    }
}

fn project_suggested_mcp_servers(engine: &str) -> Vec<ProjectMcpServerSuggestion> {
    let mut suggestions = Vec::new();
    if !matches!(engine, "unity" | "unreal" | "godot" | "cocos") {
        return suggestions;
    }

    let (unity_available, unity_note) = project_command_available(UNITY_MCP_COMMAND);
    suggestions.push(ProjectMcpServerSuggestion {
        id: UNITY_MCP_SERVER_ID.to_string(),
        label: "Unity MCP".to_string(),
        description:
            "wellingfeng/unity-mcp：连接 Unity Editor，管理场景、资产、脚本、组件与控制台；首次连接需在 Unity Editor 中授权。"
                .to_string(),
        transport: "stdio".to_string(),
        command: UNITY_MCP_COMMAND.to_string(),
        args: UNITY_MCP_ARGS.iter().map(|value| (*value).to_string()).collect(),
        env: HashMap::new(),
        url: None,
        available: unity_available,
        availability_note: unity_note,
        requires_user_approval: true,
    });

    // Converge with the one-click installer: same stable id, and point at
    // the cached verified binary when it is already present so "apply
    // recommended" + probe work without extra steps. Falls back to the
    // server id label when not yet installed.
    let cached =
        ue_mcp_expected_binary_path().filter(|path| path.is_file() && ue_mcp_binary_verified(path));
    let command = cached
        .as_ref()
        .map(|path| display_preview_path(path))
        .unwrap_or_else(|| UE_MCP_SERVER_ID.to_string());
    let (available, availability_note) = if cached.is_some() {
        (true, "已安装并校验的 UE MCP 二进制。".to_string())
    } else {
        (
            false,
            "尚未安装；点击“一键安装并配置”自动下载并配置。".to_string(),
        )
    };
    suggestions.push(ProjectMcpServerSuggestion {
        id: UE_MCP_SERVER_ID.to_string(),
        label: "Unreal MCP (全版本)".to_string(),
        description:
            "版本无关的 Unreal RemoteControl MCP，支持 UE 4.25–5.8；一键安装会自动启用 RemoteControl/Python 插件并写入工程配置。"
                .to_string(),
        transport: "stdio".to_string(),
        command,
        args: Vec::new(),
        env: HashMap::new(),
        url: None,
        available,
        availability_note,
        requires_user_approval: true,
    });

    let (godot_available, godot_note) = project_command_available("npx");
    let mut godot_env = HashMap::new();
    godot_env.insert("GODOT_PATH".to_string(), "".to_string());
    suggestions.push(ProjectMcpServerSuggestion {
        id: "godot-mcp".to_string(),
        label: "Godot MCP".to_string(),
        description:
            "wellingfeng/godot-mcp：通过 npm 启动，可启动 Godot Editor、运行项目、读取调试输出并管理场景/脚本。"
                .to_string(),
        transport: "stdio".to_string(),
        command: "npx".to_string(),
        args: vec!["-y".to_string(), "@coding-solo/godot-mcp".to_string()],
        env: godot_env,
        url: None,
        available: godot_available,
        availability_note: godot_note,
        requires_user_approval: true,
    });

    let (cocos_available, cocos_note) = project_command_available("npx");
    suggestions.push(ProjectMcpServerSuggestion {
        id: "cocos-mcp-server".to_string(),
        label: "Cocos MCP".to_string(),
        description:
            "wellingfeng/cocos-mcp-server：作为 Cocos Creator 扩展运行，暴露 streamable-http MCP 服务。"
                .to_string(),
        transport: "streamable-http".to_string(),
        command: "npx".to_string(),
        args: vec![
            "-y".to_string(),
            "mcp-remote".to_string(),
            "http://localhost:3000/mcp".to_string(),
        ],
        env: HashMap::new(),
        url: Some(COCOS_MCP_URL.to_string()),
        available: cocos_available,
        availability_note: cocos_note,
        requires_user_approval: true,
    });
    suggestions
}

fn project_skill_roots(root: &Path) -> Vec<ProjectSkillRootSnapshot> {
    [
        ("codex", "Codex 项目 Skill", ".codex/skills"),
        ("agents", "Agents 项目 Skill", ".agents/skills"),
        ("claude", "Claude 项目 Skill", ".claude/skills"),
    ]
    .into_iter()
    .map(|(id, label, rel)| {
        let path = root.join(rel);
        let mut skills = Vec::new();
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                for entry in entries.flatten() {
                    let skill_dir = entry.path();
                    if skill_dir.is_dir() && skill_dir.join("SKILL.md").is_file() {
                        if let Some(name) = skill_dir.file_name().and_then(|value| value.to_str()) {
                            skills.push(name.to_string());
                        }
                    }
                }
            }
        }
        skills.sort();
        ProjectSkillRootSnapshot {
            id: id.to_string(),
            label: label.to_string(),
            path: project_path_display(&path),
            exists: path.is_dir(),
            skill_count: skills.len(),
            skills,
        }
    })
    .collect()
}

fn project_environment_scan_blocking(root_path: String) -> Result<ProjectEnvironmentScan, String> {
    let root = project_scan_root(&root_path)?;
    let engine = detect_project_engine(&root);
    let suggested_mcp_servers = project_suggested_mcp_servers(&engine.engine);
    Ok(ProjectEnvironmentScan {
        root_path: project_path_display(&root),
        scanned_at_ms: now_ms(),
        skill_roots: project_skill_roots(&root),
        engine,
        suggested_mcp_servers,
    })
}

#[tauri::command]
async fn project_environment_scan(root_path: String) -> Result<ProjectEnvironmentScan, String> {
    tauri::async_runtime::spawn_blocking(move || project_environment_scan_blocking(root_path))
        .await
        .map_err(|e| format!("项目检测任务失败: {e}"))?
}

fn project_probe_parse_line(
    line: &str,
    initialize_seen: &mut bool,
) -> Option<Result<Option<usize>, String>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
    let id = value.get("id").and_then(|item| item.as_i64());
    if let Some(error) = value.get("error") {
        return Some(Err(format!("MCP 返回错误: {error}")));
    }
    match id {
        Some(1) => {
            if value.get("result").is_some() {
                *initialize_seen = true;
            }
            Some(Ok(None))
        }
        Some(2) => {
            let tools_count = value
                .pointer("/result/tools")
                .and_then(|tools| tools.as_array())
                .map(|tools| tools.len())
                .unwrap_or(0);
            Some(Ok(Some(tools_count)))
        }
        _ => None,
    }
}

fn project_mcp_probe_stdio(
    root: &Path,
    server: &ProjectMcpProbeServerConfig,
) -> ProjectMcpProbeResult {
    let command = match server
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(command) => project_expand_path_text(command),
        None => {
            return ProjectMcpProbeResult {
                server_id: server.id.clone(),
                ok: false,
                status: "missing-command".to_string(),
                message: "MCP 命令为空。".to_string(),
                tools_count: None,
                checked_at_ms: now_ms(),
            }
        }
    };

    let root_text = project_path_display(root);
    let args: Vec<String> = server
        .args
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|arg| project_expand_path_text(&arg.replace("{workspace}", &root_text)))
        .collect();

    let mut cmd = new_spawn_command(&command);
    cmd.current_dir(root);
    cmd.args(&args);
    if let Some(env) = &server.env {
        for (key, value) in env {
            if !key.trim().is_empty() {
                cmd.env(key, value.replace("{workspace}", &root_text));
            }
        }
    }
    cmd.env("MCP_CLIENT_NAME", "UltraGameStudio");
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return ProjectMcpProbeResult {
                server_id: server.id.clone(),
                ok: false,
                status: "spawn-failed".to_string(),
                message: format!("启动 MCP 失败: {e}"),
                tools_count: None,
                checked_at_ms: now_ms(),
            }
        }
    };

    let Some(mut stdin) = child.stdin.take() else {
        terminate_child_tree(&mut child);
        return ProjectMcpProbeResult {
            server_id: server.id.clone(),
            ok: false,
            status: "stdin-unavailable".to_string(),
            message: "MCP stdin 不可用。".to_string(),
            tools_count: None,
            checked_at_ms: now_ms(),
        };
    };

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        let tx_out = tx.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stdout)
                .lines()
                .map_while(Result::ok)
            {
                let _ = tx_out.send(line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let tx_err = tx.clone();
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(stderr)
                .lines()
                .map_while(Result::ok)
            {
                let _ = tx_err.send(line);
            }
        });
    }

    let init = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {
                "name": "UltraGameStudio",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    });
    let initialized = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
        "params": {}
    });
    let tools = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let payload = format!("{init}\n{initialized}\n{tools}\n");
    if let Err(e) = stdin
        .write_all(payload.as_bytes())
        .and_then(|_| stdin.flush())
    {
        terminate_child_tree(&mut child);
        return ProjectMcpProbeResult {
            server_id: server.id.clone(),
            ok: false,
            status: "write-failed".to_string(),
            message: format!("写入 MCP 握手失败: {e}"),
            tools_count: None,
            checked_at_ms: now_ms(),
        };
    }
    drop(stdin);

    let mut initialize_seen = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        while let Ok(line) = rx.try_recv() {
            if let Some(parsed) = project_probe_parse_line(&line, &mut initialize_seen) {
                match parsed {
                    Ok(Some(tools_count)) => {
                        terminate_child_tree(&mut child);
                        let _ = child.wait();
                        return ProjectMcpProbeResult {
                            server_id: server.id.clone(),
                            ok: true,
                            status: "connected".to_string(),
                            message: format!("MCP 已连接，发现 {tools_count} 个工具。"),
                            tools_count: Some(tools_count),
                            checked_at_ms: now_ms(),
                        };
                    }
                    Ok(None) => {}
                    Err(message) => {
                        terminate_child_tree(&mut child);
                        let _ = child.wait();
                        return ProjectMcpProbeResult {
                            server_id: server.id.clone(),
                            ok: false,
                            status: "protocol-error".to_string(),
                            message,
                            tools_count: None,
                            checked_at_ms: now_ms(),
                        };
                    }
                }
            }
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                return ProjectMcpProbeResult {
                    server_id: server.id.clone(),
                    ok: false,
                    status: "exited".to_string(),
                    message: format!("MCP 进程提前退出: {status}"),
                    tools_count: None,
                    checked_at_ms: now_ms(),
                };
            }
            Ok(None) => {}
            Err(e) => {
                terminate_child_tree(&mut child);
                return ProjectMcpProbeResult {
                    server_id: server.id.clone(),
                    ok: false,
                    status: "wait-failed".to_string(),
                    message: format!("等待 MCP 失败: {e}"),
                    tools_count: None,
                    checked_at_ms: now_ms(),
                };
            }
        }

        if std::time::Instant::now() >= deadline {
            terminate_child_tree(&mut child);
            let _ = child.wait();
            let detail = if initialize_seen {
                "initialize 成功，但 tools/list 超时。"
            } else {
                "initialize 未完成。"
            };
            return ProjectMcpProbeResult {
                server_id: server.id.clone(),
                ok: false,
                status: "timeout".to_string(),
                message: format!("MCP 探测超时：{detail}"),
                tools_count: None,
                checked_at_ms: now_ms(),
            };
        }

        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

fn project_mcp_probe_blocking(
    root_path: String,
    server: ProjectMcpProbeServerConfig,
) -> Result<ProjectMcpProbeResult, String> {
    let root = project_scan_root(&root_path)?;
    if server.transport == "stdio" {
        return Ok(project_mcp_probe_stdio(&root, &server));
    }
    if server.transport == "streamable-http" || server.transport == "http" {
        let Some(url) = server
            .url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Ok(ProjectMcpProbeResult {
                server_id: server.id,
                ok: false,
                status: "missing-url".to_string(),
                message: "MCP URL 为空。".to_string(),
                tools_count: None,
                checked_at_ms: now_ms(),
            });
        };
        let result = ureq::get(url)
            .timeout(std::time::Duration::from_secs(4))
            .call();
        return Ok(match result {
            Ok(response) => ProjectMcpProbeResult {
                server_id: server.id,
                ok: true,
                status: "reachable".to_string(),
                message: format!("HTTP MCP 端点可访问：HTTP {}", response.status()),
                tools_count: None,
                checked_at_ms: now_ms(),
            },
            Err(ureq::Error::Status(code, _)) if code == 400 || code == 404 || code == 405 => {
                ProjectMcpProbeResult {
                    server_id: server.id,
                    ok: true,
                    status: "reachable".to_string(),
                    message: format!("HTTP MCP 端点有响应：HTTP {code}"),
                    tools_count: None,
                    checked_at_ms: now_ms(),
                }
            }
            Err(err) => ProjectMcpProbeResult {
                server_id: server.id,
                ok: false,
                status: "http-unreachable".to_string(),
                message: format!("HTTP MCP 端点不可访问：{err}"),
                tools_count: None,
                checked_at_ms: now_ms(),
            },
        });
    }
    Ok(ProjectMcpProbeResult {
        server_id: server.id,
        ok: false,
        status: "unsupported-transport".to_string(),
        message: format!(
            "暂不支持自动探测 {} 传输{}。",
            server.transport,
            server
                .url
                .as_deref()
                .filter(|url| !url.trim().is_empty())
                .map(|url| format!("（{url}）"))
                .unwrap_or_default()
        ),
        tools_count: None,
        checked_at_ms: now_ms(),
    })
}

#[tauri::command]
async fn project_mcp_probe(
    root_path: String,
    server: ProjectMcpProbeServerConfig,
) -> Result<ProjectMcpProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || project_mcp_probe_blocking(root_path, server))
        .await
        .map_err(|e| format!("MCP 探测任务失败: {e}"))?
}

fn project_lsp_probe_blocking(server: ProjectLspProbeServerConfig) -> ProjectLspProbeResult {
    let command = server
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("");

    if command.is_empty() {
        return ProjectLspProbeResult {
            server_id: server.id,
            ok: false,
            status: "missing-command".to_string(),
            message: "LSP 命令为空。".to_string(),
            resolved_command: None,
            checked_at_ms: now_ms(),
        };
    }

    let expanded = project_expand_path_text(command);
    let path_like =
        expanded.contains('/') || expanded.contains('\\') || Path::new(&expanded).is_absolute();
    let resolved = if path_like {
        Path::new(&expanded)
            .exists()
            .then(|| PathBuf::from(&expanded))
    } else {
        cli_runtime::resolve_command_path(&expanded)
    };
    let args = server.args.unwrap_or_default();
    let arg_note = if args.is_empty() {
        String::new()
    } else {
        format!("；参数 {}", args.join(" "))
    };

    match resolved {
        Some(path) => ProjectLspProbeResult {
            server_id: server.id,
            ok: true,
            status: "available".to_string(),
            message: format!("命令可用：{}{}", project_path_display(&path), arg_note),
            resolved_command: Some(project_path_display(&path)),
            checked_at_ms: now_ms(),
        },
        None => ProjectLspProbeResult {
            server_id: server.id,
            ok: false,
            status: "missing".to_string(),
            message: if path_like {
                "命令路径不存在，请先安装或修正路径。".to_string()
            } else {
                "PATH 中未找到命令，请先安装或加入 PATH。".to_string()
            },
            resolved_command: None,
            checked_at_ms: now_ms(),
        },
    }
}

#[tauri::command]
async fn project_lsp_probe(
    server: ProjectLspProbeServerConfig,
) -> Result<ProjectLspProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || project_lsp_probe_blocking(server))
        .await
        .map_err(|e| format!("LSP 探测任务失败: {e}"))
}

const PROJECT_LSP_INSTALL_TIMEOUT_SECS: u64 = 900;
const PROJECT_LSP_INSTALL_OUTPUT_LIMIT: usize = 12_000;
const PROJECT_LSP_ALLOWED_INSTALLERS: &[&str] = &[
    "winget",
    "brew",
    "choco",
    "scoop",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "pip",
    "pip3",
    "python",
    "python3",
    "py",
    "dotnet",
    "rustup",
    "cargo",
    "go",
    "gem",
    "composer",
    "opam",
    "nix",
    "julia",
    "r",
    "rscript",
    "pwsh",
    "powershell",
    "cs",
    "coursier",
    "ghcup",
];

fn project_lsp_install_arg_safe(value: &str) -> bool {
    !value.is_empty() && !value.contains('\0') && !value.contains('\n') && !value.contains('\r')
}

fn project_lsp_install_command_name(command: &str) -> String {
    let expanded = project_expand_path_text(command.trim());
    let file_name = Path::new(&expanded)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(expanded.as_str());
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    stem.to_ascii_lowercase()
}

fn project_lsp_installer_allowed(command: &str) -> bool {
    let name = project_lsp_install_command_name(command);
    PROJECT_LSP_ALLOWED_INSTALLERS.contains(&name.as_str())
}

fn project_lsp_quote_command_part(value: &str) -> String {
    if value.chars().all(|ch| {
        ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '_' | '-' | '.' | '/' | '\\' | ':' | '@' | '%' | '#' | '=' | '+'
            )
    }) {
        value.to_string()
    } else {
        format!("{value:?}")
    }
}

fn project_lsp_install_command_line(command: &ProjectLspInstallCommand) -> String {
    std::iter::once(command.command.as_str())
        .chain(command.args.iter().map(String::as_str))
        .map(project_lsp_quote_command_part)
        .collect::<Vec<_>>()
        .join(" ")
}

fn project_lsp_install_platform_match(
    command: &ProjectLspInstallCommand,
    platform: cli_runtime::CliPlatform,
) -> bool {
    command
        .platforms
        .as_ref()
        .map(|platforms| platforms.is_empty() || platforms.contains(&platform))
        .unwrap_or(true)
}

fn project_lsp_install_result(
    request: &ProjectLspInstallRequest,
    ok: bool,
    status: &str,
    message: String,
    command_line: Option<String>,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    timed_out: bool,
    platform: cli_runtime::CliPlatform,
) -> ProjectLspInstallResult {
    ProjectLspInstallResult {
        server_id: request.server_id.clone(),
        ok,
        status: status.to_string(),
        message,
        command_line,
        stdout: truncate_chars(&stdout, PROJECT_LSP_INSTALL_OUTPUT_LIMIT),
        stderr: truncate_chars(&stderr, PROJECT_LSP_INSTALL_OUTPUT_LIMIT),
        exit_code,
        timed_out,
        platform,
        checked_at_ms: now_ms(),
    }
}

fn project_lsp_install_blocking(
    request: ProjectLspInstallRequest,
) -> Result<ProjectLspInstallResult, String> {
    let platform = cli_runtime::platform();
    let Some(command) = request
        .commands
        .iter()
        .find(|command| project_lsp_install_platform_match(command, platform))
        .cloned()
    else {
        return Ok(project_lsp_install_result(
            &request,
            false,
            "unsupported-platform",
            "当前平台没有可自动执行的安装命令，请按安装说明手动安装。".to_string(),
            None,
            String::new(),
            String::new(),
            None,
            false,
            platform,
        ));
    };

    let command_text = project_lsp_install_command_line(&command);
    if !project_lsp_install_arg_safe(command.command.trim())
        || command
            .args
            .iter()
            .any(|arg| !project_lsp_install_arg_safe(arg))
    {
        return Ok(project_lsp_install_result(
            &request,
            false,
            "invalid-command",
            "安装命令包含不允许的控制字符。".to_string(),
            Some(command_text),
            String::new(),
            String::new(),
            None,
            false,
            platform,
        ));
    }
    if !project_lsp_installer_allowed(&command.command) {
        return Ok(project_lsp_install_result(
            &request,
            false,
            "installer-not-allowed",
            format!("不允许直接执行该安装器：{}", command.command),
            Some(command_text),
            String::new(),
            String::new(),
            None,
            false,
            platform,
        ));
    }

    let cwd = request
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(project_scan_root)
        .transpose()?;
    let stdout_path = temp_output_path("ultragamestudio-lsp-install-stdout", "txt");
    let stderr_path = temp_output_path("ultragamestudio-lsp-install-stderr", "txt");
    let _stdout_guard = TempFileGuard::new(stdout_path.clone());
    let _stderr_guard = TempFileGuard::new(stderr_path.clone());
    let stdout_file = std::fs::File::create(&stdout_path)
        .map_err(|e| format!("创建 LSP 安装输出缓存失败: {e}"))?;
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|e| format!("创建 LSP 安装错误缓存失败: {e}"))?;

    let mut cmd = new_spawn_command(command.command.trim());
    if let Some(cwd) = cwd.as_ref() {
        cmd.current_dir(cwd);
    }
    cmd.args(&command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Ok(project_lsp_install_result(
                &request,
                false,
                "spawn-failed",
                format!("启动安装命令失败: {err}"),
                Some(command_text),
                read_workspace_status_temp(&stdout_path),
                read_workspace_status_temp(&stderr_path),
                None,
                false,
                platform,
            ));
        }
    };

    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(PROJECT_LSP_INSTALL_TIMEOUT_SECS);
    let (exit_code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    terminate_child_tree(&mut child);
                    break (None, true);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => {
                terminate_child_tree(&mut child);
                break (None, false);
            }
        }
    };

    let stdout = read_workspace_status_temp(&stdout_path);
    let stderr = read_workspace_status_temp(&stderr_path);
    if timed_out {
        return Ok(project_lsp_install_result(
            &request,
            false,
            "timeout",
            format!(
                "安装超时（{}s）已终止：{}",
                PROJECT_LSP_INSTALL_TIMEOUT_SECS, command_text
            ),
            Some(command_text),
            stdout,
            stderr,
            exit_code,
            true,
            platform,
        ));
    }

    let ok = exit_code == Some(0);
    let label = command.label.trim();
    let label_note = if label.is_empty() {
        String::new()
    } else {
        format!("{label}：")
    };
    let message = if ok {
        format!("{label_note}安装完成。")
    } else {
        let detail = stderr
            .trim()
            .lines()
            .last()
            .or_else(|| stdout.trim().lines().last());
        format!(
            "{label_note}安装失败{}{}",
            exit_code
                .map(|code| format!("（退出码 {code}）"))
                .unwrap_or_default(),
            detail.map(|line| format!("：{line}")).unwrap_or_default()
        )
    };

    Ok(project_lsp_install_result(
        &request,
        ok,
        if ok { "installed" } else { "failed" },
        message,
        Some(command_text),
        stdout,
        stderr,
        exit_code,
        false,
        platform,
    ))
}

#[tauri::command]
async fn project_lsp_install(
    request: ProjectLspInstallRequest,
) -> Result<ProjectLspInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || project_lsp_install_blocking(request))
        .await
        .map_err(|e| format!("LSP 安装任务失败: {e}"))?
}

// ===== Unity MCP one-click project setup =====
//
// MCP for Unity is a Unity package plus a small Python MCP server. The package
// runs inside Unity Editor and performs the actual editor-side operations; this
// app can safely do the project-side setup: add the package Git dependency,
// register the MCP server in the project's MCP config, and probe it once Unity
// has opened the project and authorized the connection.

const UNITY_MCP_SERVER_ID: &str = "unity-mcp";
const UNITY_MCP_PACKAGE_ID: &str = "com.coplaydev.unity-mcp";
const UNITY_MCP_PACKAGE_URL: &str =
    "https://github.com/wellingfeng/unity-mcp.git?path=/MCPForUnity#beta";
const UNITY_MCP_COMMAND: &str = "uvx";
const UNITY_MCP_ARGS: &[&str] = &[
    "--from",
    "mcpforunityserver",
    "mcp-for-unity",
    "--transport",
    "stdio",
];

fn unity_mcp_server_args() -> Vec<String> {
    UNITY_MCP_ARGS
        .iter()
        .map(|arg| (*arg).to_string())
        .collect()
}

fn unity_mcp_write_manifest_dependency(root: &Path) -> Result<Option<String>, String> {
    let manifest_path = root.join("Packages/manifest.json");
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取 Packages/manifest.json 失败：{e}"))?;
    let mut doc: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析 Packages/manifest.json 失败：{e}"))?;
    if !doc.is_object() {
        return Err("Packages/manifest.json 顶层不是 JSON 对象。".to_string());
    }
    let before = doc.clone();
    let dependencies = doc
        .as_object_mut()
        .unwrap()
        .entry("dependencies")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !dependencies.is_object() {
        return Err("Packages/manifest.json 中 dependencies 字段不是对象。".to_string());
    }
    dependencies.as_object_mut().unwrap().insert(
        UNITY_MCP_PACKAGE_ID.to_string(),
        serde_json::Value::String(UNITY_MCP_PACKAGE_URL.to_string()),
    );

    if doc == before {
        return Ok(None);
    }
    let serialized = serde_json::to_string_pretty(&doc)
        .map_err(|e| format!("序列化 Packages/manifest.json 失败：{e}"))?;
    atomic_write(&manifest_path, serialized.as_bytes())
        .map_err(|e| format!("写入 Packages/manifest.json 失败：{e}"))?;
    Ok(Some(project_relative_marker(root, &manifest_path)))
}

fn unity_mcp_write_project_mcp_json(root: &Path) -> Result<Option<String>, String> {
    let mcp_path = root.join(".mcp.json");
    let mut doc: serde_json::Value = std::fs::read_to_string(&mcp_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    let before = doc.clone();
    let desired = serde_json::json!({
        "command": UNITY_MCP_COMMAND,
        "args": unity_mcp_server_args(),
    });

    let root_obj = doc.as_object_mut().unwrap();
    let servers = root_obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !servers.is_object() {
        *servers = serde_json::Value::Object(serde_json::Map::new());
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert(UNITY_MCP_SERVER_ID.to_string(), desired);

    if doc == before {
        return Ok(None);
    }
    let serialized =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化 .mcp.json 失败：{e}"))?;
    atomic_write(&mcp_path, serialized.as_bytes())
        .map_err(|e| format!("写入 .mcp.json 失败：{e}"))?;
    Ok(Some(project_relative_marker(root, &mcp_path)))
}

fn unity_mcp_setup_project_blocking(
    req: UnityMcpSetupRequest,
) -> Result<UnityMcpSetupResult, String> {
    let root = project_scan_root(&req.root_path)?;
    let engine = detect_project_engine(&root);
    if engine.engine != "unity" {
        return Ok(UnityMcpSetupResult {
            ok: false,
            changed: false,
            dry_run: req.dry_run == Some(true),
            package_id: UNITY_MCP_PACKAGE_ID.to_string(),
            package_url: UNITY_MCP_PACKAGE_URL.to_string(),
            configured_files: Vec::new(),
            changed_files: Vec::new(),
            notes: Vec::new(),
            warnings: Vec::new(),
            error: Some(
                "未检测到 Unity 工程；需要 Packages/manifest.json 和 ProjectSettings/。"
                    .to_string(),
            ),
            server_command: UNITY_MCP_COMMAND.to_string(),
            server_args: unity_mcp_server_args(),
        });
    }

    let dry_run = req.dry_run == Some(true);
    let write_manifest = req.write_manifest != Some(false);
    let write_mcp_config = req.write_mcp_config != Some(false);
    let mut configured_files = Vec::new();
    let mut changed_files = Vec::new();
    let mut notes = Vec::new();
    let mut warnings = Vec::new();

    if dry_run {
        if write_manifest {
            configured_files.push("Packages/manifest.json".to_string());
        }
        if write_mcp_config {
            configured_files.push(".mcp.json".to_string());
        }
        notes.push("演练模式：未写入任何文件。".to_string());
    } else {
        if write_manifest {
            configured_files.push("Packages/manifest.json".to_string());
            if let Some(file) = unity_mcp_write_manifest_dependency(&root)? {
                changed_files.push(file);
            }
        }
        if write_mcp_config {
            configured_files.push(".mcp.json".to_string());
            if let Some(file) = unity_mcp_write_project_mcp_json(&root)? {
                changed_files.push(file);
            }
        }
        notes.push(format!(
            "已登记 Unity 包依赖 {UNITY_MCP_PACKAGE_ID}；Unity 下次打开工程时会解析 Git 包。"
        ));
        notes.push(
            "在 Unity Editor 中打开 Window > MCP for Unity，确认服务已启用并完成授权。".to_string(),
        );
        warnings.push(
            "首次运行需要本机可用 uv/uvx；如果探测失败，请先安装 uv 或把 uvx 加入 PATH。"
                .to_string(),
        );
    }

    Ok(UnityMcpSetupResult {
        ok: true,
        changed: !changed_files.is_empty(),
        dry_run,
        package_id: UNITY_MCP_PACKAGE_ID.to_string(),
        package_url: UNITY_MCP_PACKAGE_URL.to_string(),
        configured_files,
        changed_files,
        notes,
        warnings,
        error: None,
        server_command: UNITY_MCP_COMMAND.to_string(),
        server_args: unity_mcp_server_args(),
    })
}

#[tauri::command]
async fn unity_mcp_setup_project(
    request: UnityMcpSetupRequest,
) -> Result<UnityMcpSetupResult, String> {
    tauri::async_runtime::spawn_blocking(move || unity_mcp_setup_project_blocking(request))
        .await
        .map_err(|e| format!("Unity MCP 配置任务失败: {e}"))?
}

// ===== Blueprint Mode plugin one-click install =====

const BLUEPRINT_MODE_SOURCE_URL: &str = "https://github.com/wellingfeng/ue-blueprint-mode";
const BLUEPRINT_MODE_ARCHIVE_URL: &str =
    "https://codeload.github.com/wellingfeng/ue-blueprint-mode/zip/refs/heads/main";
const BLUEPRINT_MODE_PLUGIN_DIRNAME: &str = "BlueprintMode";
const BLUEPRINT_MODE_DOWNLOAD_LIMIT: usize = 64 * 1024 * 1024;
const BLUEPRINT_MODE_DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlueprintModeInstallRequest {
    /// UE project root (the folder that contains the .uproject file).
    root_path: String,
    /// Optional explicit target directory; defaults to <project>/Plugins/<name>.
    target_dir: Option<String>,
    /// Overwrite an existing install when true.
    overwrite: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlueprintModeTargetRequest {
    /// UE project root (the folder that contains the .uproject file).
    root_path: String,
    /// Optional explicit target directory; defaults to <project>/Plugins/<name>.
    target_dir: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BlueprintModeStatusResult {
    ok: bool,
    source_url: String,
    target_dir: String,
    exists: bool,
    installed: bool,
    uplugin_path: Option<String>,
    version_name: Option<String>,
    notes: Vec<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BlueprintModeInstallResult {
    ok: bool,
    /// GitHub repository used as the plugin source.
    source_url: String,
    /// Resolved install destination.
    target_dir: String,
    /// Number of files copied.
    files_copied: usize,
    /// True when an existing install was replaced.
    replaced_existing: bool,
    notes: Vec<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BlueprintModeUninstallResult {
    ok: bool,
    target_dir: String,
    removed: bool,
    notes: Vec<String>,
    warnings: Vec<String>,
    error: Option<String>,
}

fn blueprint_mode_resolve_target(root: &Path, target_dir: Option<&str>) -> PathBuf {
    target_dir
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("Plugins").join(BLUEPRINT_MODE_PLUGIN_DIRNAME))
}

fn blueprint_mode_find_uplugin(target: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 2 {
        return None;
    }

    let entries: Vec<std::fs::DirEntry> = std::fs::read_dir(target)
        .ok()?
        .filter_map(Result::ok)
        .collect();

    for entry in &entries {
        let path = entry.path();
        if path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("uplugin"))
            .unwrap_or(false)
        {
            return Some(path);
        }
    }

    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if let Some(path) = blueprint_mode_find_uplugin(&entry.path(), depth + 1) {
                return Some(path);
            }
        }
    }

    None
}

fn blueprint_mode_read_version_name(
    uplugin_path: &Path,
    warnings: &mut Vec<String>,
) -> Option<String> {
    let text = match std::fs::read_to_string(uplugin_path) {
        Ok(text) => text,
        Err(err) => {
            warnings.push(format!(
                "读取 .uplugin 失败 {}：{err}",
                uplugin_path.to_string_lossy()
            ));
            return None;
        }
    };
    let doc: serde_json::Value = match serde_json::from_str(&text) {
        Ok(doc) => doc,
        Err(err) => {
            warnings.push(format!(
                "解析 .uplugin 失败 {}：{err}",
                uplugin_path.to_string_lossy()
            ));
            return None;
        }
    };
    if let Some(version_name) = doc.get("VersionName").and_then(|v| v.as_str()) {
        return Some(version_name.to_string());
    }
    doc.get("Version")
        .and_then(|v| v.as_i64())
        .map(|version| version.to_string())
}

fn blueprint_mode_status_blocking(
    req: BlueprintModeTargetRequest,
) -> Result<BlueprintModeStatusResult, String> {
    let mut notes = Vec::new();
    let mut warnings = Vec::new();

    let root = project_scan_root(&req.root_path)?;
    let target = blueprint_mode_resolve_target(&root, req.target_dir.as_deref());
    let engine = detect_project_engine(&root);
    if engine.engine != "unreal" {
        return Ok(BlueprintModeStatusResult {
            ok: false,
            source_url: BLUEPRINT_MODE_SOURCE_URL.to_string(),
            target_dir: target.to_string_lossy().to_string(),
            exists: false,
            installed: false,
            uplugin_path: None,
            version_name: None,
            notes,
            warnings,
            error: Some("当前工作区不是 Unreal Engine 工程（未找到 .uproject）。".to_string()),
        });
    }

    let exists = target.exists();
    let uplugin_path = if exists {
        blueprint_mode_find_uplugin(&target, 0)
    } else {
        None
    };
    let installed = uplugin_path.is_some();
    if installed {
        notes.push("已检测到 BlueprintMode 插件。".to_string());
    } else if exists {
        warnings.push("插件目录存在，但未找到 .uplugin。".to_string());
    } else {
        notes.push("尚未安装 BlueprintMode 插件。".to_string());
    }
    let version_name = uplugin_path
        .as_deref()
        .and_then(|path| blueprint_mode_read_version_name(path, &mut warnings));

    Ok(BlueprintModeStatusResult {
        ok: true,
        source_url: BLUEPRINT_MODE_SOURCE_URL.to_string(),
        target_dir: target.to_string_lossy().to_string(),
        exists,
        installed,
        uplugin_path: uplugin_path.map(|path| path.to_string_lossy().to_string()),
        version_name,
        notes,
        warnings,
        error: None,
    })
}

fn blueprint_mode_download_archive() -> Result<Vec<u8>, String> {
    let response = ureq::get(BLUEPRINT_MODE_ARCHIVE_URL)
        .timeout(BLUEPRINT_MODE_DOWNLOAD_TIMEOUT)
        .set("User-Agent", "UltraGameStudio")
        .set(
            "Accept",
            "application/zip,application/octet-stream,*/*;q=0.8",
        )
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("BlueprintMode 下载失败：HTTP {code}。"),
            other => format!("BlueprintMode 下载失败：{other}"),
        })?;
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut reader)
        .take((BLUEPRINT_MODE_DOWNLOAD_LIMIT as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取 BlueprintMode 下载内容失败：{e}"))?;
    if bytes.is_empty() {
        return Err("BlueprintMode 下载内容为空。".to_string());
    }
    if bytes.len() > BLUEPRINT_MODE_DOWNLOAD_LIMIT {
        return Err("BlueprintMode 下载内容超出大小上限。".to_string());
    }
    Ok(bytes)
}

fn blueprint_mode_archive_plugin_root<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<PathBuf, String> {
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("读取 BlueprintMode 压缩包失败：{e}"))?;
        let Some(path) = file.enclosed_name() else {
            continue;
        };
        if path
            .extension()
            .map(|ext| ext.eq_ignore_ascii_case("uplugin"))
            .unwrap_or(false)
        {
            return Ok(path.parent().map(Path::to_path_buf).unwrap_or_default());
        }
    }
    Err("BlueprintMode 压缩包不是合法 UE 插件（缺少 .uplugin）。".to_string())
}

fn blueprint_mode_extract_archive(bytes: &[u8], dst: &Path) -> Result<usize, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("打开 BlueprintMode 压缩包失败：{e}"))?;
    let plugin_root = blueprint_mode_archive_plugin_root(&mut archive)?;
    let mut copied = 0usize;

    std::fs::create_dir_all(dst)
        .map_err(|e| format!("创建目录失败 {}：{e}", dst.to_string_lossy()))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 BlueprintMode 压缩包失败：{e}"))?;
        let Some(path) = file.enclosed_name() else {
            continue;
        };
        let rel = if plugin_root.as_os_str().is_empty() {
            path.as_path()
        } else {
            match path.strip_prefix(&plugin_root) {
                Ok(rel) => rel,
                Err(_) => continue,
            }
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        let target = dst.join(rel);
        if file.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("创建目录失败 {}：{e}", target.to_string_lossy()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录失败 {}：{e}", parent.to_string_lossy()))?;
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("创建文件失败 {}：{e}", target.to_string_lossy()))?;
        std::io::copy(&mut file, &mut out)
            .map_err(|e| format!("写入文件失败 {}：{e}", target.to_string_lossy()))?;
        copied += 1;
    }
    if copied == 0 {
        return Err("BlueprintMode 压缩包没有可安装文件。".to_string());
    }
    Ok(copied)
}

fn blueprint_mode_install_blocking(
    req: BlueprintModeInstallRequest,
) -> Result<BlueprintModeInstallResult, String> {
    let mut notes = Vec::new();
    let mut warnings = Vec::new();

    let root = project_scan_root(&req.root_path)?;
    let engine = detect_project_engine(&root);
    if engine.engine != "unreal" {
        return Ok(BlueprintModeInstallResult {
            ok: false,
            source_url: BLUEPRINT_MODE_SOURCE_URL.to_string(),
            target_dir: String::new(),
            files_copied: 0,
            replaced_existing: false,
            notes,
            warnings,
            error: Some("当前工作区不是 Unreal Engine 工程（未找到 .uproject）。".to_string()),
        });
    }

    let target = blueprint_mode_resolve_target(&root, req.target_dir.as_deref());

    let overwrite = req.overwrite.unwrap_or(false);
    let mut replaced_existing = false;
    if target.exists() {
        if !overwrite {
            return Ok(BlueprintModeInstallResult {
                ok: false,
                source_url: BLUEPRINT_MODE_SOURCE_URL.to_string(),
                target_dir: target.to_string_lossy().to_string(),
                files_copied: 0,
                replaced_existing: false,
                notes,
                warnings,
                error: Some(format!(
                    "目标已存在：{}。勾选覆盖后再安装。",
                    target.to_string_lossy()
                )),
            });
        }
    }

    let parent = target
        .parent()
        .ok_or_else(|| "安装目标目录无效。".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("创建目录失败 {}：{e}", parent.to_string_lossy()))?;

    let target_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| BLUEPRINT_MODE_PLUGIN_DIRNAME.to_string());
    let staging = parent.join(format!(".{target_name}.download"));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|e| format!("清理临时安装目录失败 {}：{e}", staging.to_string_lossy()))?;
    }

    let archive = blueprint_mode_download_archive()?;
    let files_copied = match blueprint_mode_extract_archive(&archive, &staging) {
        Ok(files_copied) => files_copied,
        Err(err) => {
            std::fs::remove_dir_all(&staging).ok();
            return Err(err);
        }
    };

    if target.exists() {
        std::fs::remove_dir_all(&target)
            .map_err(|e| format!("删除旧版本失败 {}：{e}", target.to_string_lossy()))?;
        replaced_existing = true;
        notes.push("已删除旧版本插件目录。".to_string());
    }

    std::fs::rename(&staging, &target).map_err(|e| {
        std::fs::remove_dir_all(&staging).ok();
        format!("保存插件目录失败 {}：{e}", target.to_string_lossy())
    })?;
    notes.push(format!(
        "已从 GitHub 下载并安装 {files_copied} 个文件到 {}。",
        target.to_string_lossy()
    ));
    notes.push("请重启 Unreal Editor 以加载插件。".to_string());
    warnings.push("插件首次启用需在 UE 中编译（Editor 模块）。".to_string());

    Ok(BlueprintModeInstallResult {
        ok: true,
        source_url: BLUEPRINT_MODE_SOURCE_URL.to_string(),
        target_dir: target.to_string_lossy().to_string(),
        files_copied,
        replaced_existing,
        notes,
        warnings,
        error: None,
    })
}

#[tauri::command]
async fn blueprint_mode_status(
    request: BlueprintModeTargetRequest,
) -> Result<BlueprintModeStatusResult, String> {
    tauri::async_runtime::spawn_blocking(move || blueprint_mode_status_blocking(request))
        .await
        .map_err(|e| format!("蓝图插件检测任务失败：{e}"))?
}

#[tauri::command]
async fn blueprint_mode_install(
    request: BlueprintModeInstallRequest,
) -> Result<BlueprintModeInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || blueprint_mode_install_blocking(request))
        .await
        .map_err(|e| format!("蓝图插件安装任务失败：{e}"))?
}

fn blueprint_mode_uninstall_blocking(
    req: BlueprintModeTargetRequest,
) -> Result<BlueprintModeUninstallResult, String> {
    let mut notes = Vec::new();
    let mut warnings = Vec::new();

    let root = project_scan_root(&req.root_path)?;
    let target = blueprint_mode_resolve_target(&root, req.target_dir.as_deref());
    let target_dir = target.to_string_lossy().to_string();
    let engine = detect_project_engine(&root);
    if engine.engine != "unreal" {
        return Ok(BlueprintModeUninstallResult {
            ok: false,
            target_dir,
            removed: false,
            notes,
            warnings,
            error: Some("当前工作区不是 Unreal Engine 工程（未找到 .uproject）。".to_string()),
        });
    }
    if !target.exists() {
        notes.push("BlueprintMode 插件目录不存在，无需卸载。".to_string());
        return Ok(BlueprintModeUninstallResult {
            ok: true,
            target_dir,
            removed: false,
            notes,
            warnings,
            error: None,
        });
    }

    let canonical_plugins = root
        .join("Plugins")
        .canonicalize()
        .map_err(|e| format!("读取 Plugins 目录失败：{e}"))?;
    let canonical_target = target
        .canonicalize()
        .map_err(|e| format!("读取插件目录失败 {}：{e}", target.to_string_lossy()))?;
    if !canonical_target.starts_with(&canonical_plugins) {
        return Ok(BlueprintModeUninstallResult {
            ok: false,
            target_dir,
            removed: false,
            notes,
            warnings,
            error: Some("卸载路径超出项目 Plugins 目录。".to_string()),
        });
    }
    let target_name = canonical_target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    if !target_name.eq_ignore_ascii_case(BLUEPRINT_MODE_PLUGIN_DIRNAME) {
        return Ok(BlueprintModeUninstallResult {
            ok: false,
            target_dir,
            removed: false,
            notes,
            warnings,
            error: Some("目标目录不是 BlueprintMode 插件目录。".to_string()),
        });
    }
    if blueprint_mode_find_uplugin(&canonical_target, 0).is_none() {
        warnings.push("目标目录未检测到 .uplugin，仍按 BlueprintMode 目录移除。".to_string());
    }

    std::fs::remove_dir_all(&canonical_target)
        .map_err(|e| format!("卸载 BlueprintMode 失败 {}：{e}", target.to_string_lossy()))?;
    notes.push("已卸载 BlueprintMode 插件。".to_string());

    Ok(BlueprintModeUninstallResult {
        ok: true,
        target_dir,
        removed: true,
        notes,
        warnings,
        error: None,
    })
}

#[tauri::command]
async fn blueprint_mode_uninstall(
    request: BlueprintModeTargetRequest,
) -> Result<BlueprintModeUninstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || blueprint_mode_uninstall_blocking(request))
        .await
        .map_err(|e| format!("蓝图插件卸载任务失败：{e}"))?
}

// ===== Godot / Cocos MCP one-click project setup =====

const GODOT_MCP_SERVER_ID: &str = "godot-mcp";
const GODOT_MCP_SOURCE_URL: &str = "https://github.com/wellingfeng/godot-mcp";
const GODOT_MCP_COMMAND: &str = "npx";
const GODOT_MCP_ARGS: &[&str] = &["-y", "@coding-solo/godot-mcp"];
const COCOS_MCP_SERVER_ID: &str = "cocos-mcp-server";
const COCOS_MCP_SOURCE_URL: &str = "https://github.com/wellingfeng/cocos-mcp-server";
const COCOS_MCP_URL: &str = "http://localhost:3000/mcp";
const COCOS_MCP_EXTENSION_DIR: &str = "extensions/cocos-mcp-server";

fn project_mcp_write_project_mcp_json(
    root: &Path,
    server_id: &str,
    desired: serde_json::Value,
) -> Result<Option<String>, String> {
    let mcp_path = root.join(".mcp.json");
    let mut doc: serde_json::Value = std::fs::read_to_string(&mcp_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    let before = doc.clone();
    let root_obj = doc.as_object_mut().unwrap();
    let servers = root_obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !servers.is_object() {
        *servers = serde_json::Value::Object(serde_json::Map::new());
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert(server_id.to_string(), desired);

    if doc == before {
        return Ok(None);
    }
    let serialized =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化 .mcp.json 失败：{e}"))?;
    atomic_write(&mcp_path, serialized.as_bytes())
        .map_err(|e| format!("写入 .mcp.json 失败：{e}"))?;
    Ok(Some(project_relative_marker(root, &mcp_path)))
}

fn git_command_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "git.exe"
    } else {
        "git"
    }
}

fn project_run_git(args: &[&str], cwd: &Path) -> Result<String, String> {
    let output = std::process::Command::new(git_command_name())
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("启动 git 失败：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("git {} 失败：{detail}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn npm_command_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "npm.cmd"
    } else {
        "npm"
    }
}

fn project_run_npm(args: &[&str], cwd: &Path) -> Result<String, String> {
    let output = std::process::Command::new(npm_command_name())
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("启动 npm 失败：{e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("npm {} 失败：{detail}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn project_directory_nonempty(path: &Path) -> bool {
    path.is_dir()
        && std::fs::read_dir(path)
            .ok()
            .and_then(|mut entries| entries.next())
            .is_some()
}

fn godot_mcp_setup_project_blocking(
    req: GenericProjectMcpSetupRequest,
) -> Result<GenericProjectMcpSetupResult, String> {
    let root = project_scan_root(&req.root_path)?;
    let engine = detect_project_engine(&root);
    if engine.engine != "godot" {
        return Ok(GenericProjectMcpSetupResult {
            ok: false,
            changed: false,
            dry_run: req.dry_run == Some(true),
            server_id: GODOT_MCP_SERVER_ID.to_string(),
            label: "Godot MCP".to_string(),
            description: "wellingfeng/godot-mcp：通过 npm 启动 Godot Editor 并管理项目。"
                .to_string(),
            transport: "stdio".to_string(),
            server_command: Some(GODOT_MCP_COMMAND.to_string()),
            server_args: GODOT_MCP_ARGS
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            server_url: None,
            configured_files: Vec::new(),
            changed_files: Vec::new(),
            notes: Vec::new(),
            warnings: Vec::new(),
            error: Some("未检测到 Godot 工程；需要 project.godot。".to_string()),
        });
    }

    let dry_run = req.dry_run == Some(true);
    let mut changed_files = Vec::new();
    let configured_files = vec![".mcp.json".to_string()];
    let mut notes = Vec::new();
    let mut warnings = Vec::new();
    if dry_run {
        notes.push("演练模式：未写入任何文件。".to_string());
    } else {
        let desired = serde_json::json!({
            "command": GODOT_MCP_COMMAND,
            "args": GODOT_MCP_ARGS,
            "env": {
                "GODOT_PATH": ""
            }
        });
        if let Some(file) = project_mcp_write_project_mcp_json(&root, GODOT_MCP_SERVER_ID, desired)?
        {
            changed_files.push(file);
        }
        notes.push(format!(
            "已写入 {GODOT_MCP_SOURCE_URL} 的 Godot MCP 项目配置。"
        ));
        warnings.push(
            "需要本机可用 Node.js / npx；如果无法自动发现 Godot，请在 MCP 配置中填写 GODOT_PATH。"
                .to_string(),
        );
    }

    Ok(GenericProjectMcpSetupResult {
        ok: true,
        changed: !changed_files.is_empty(),
        dry_run,
        server_id: GODOT_MCP_SERVER_ID.to_string(),
        label: "Godot MCP".to_string(),
        description: "wellingfeng/godot-mcp：通过 npm 启动 Godot Editor 并管理项目。".to_string(),
        transport: "stdio".to_string(),
        server_command: Some(GODOT_MCP_COMMAND.to_string()),
        server_args: GODOT_MCP_ARGS
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        server_url: None,
        configured_files,
        changed_files,
        notes,
        warnings,
        error: None,
    })
}

fn cocos_mcp_setup_project_blocking(
    req: GenericProjectMcpSetupRequest,
) -> Result<GenericProjectMcpSetupResult, String> {
    let root = project_scan_root(&req.root_path)?;
    let engine = detect_project_engine(&root);
    if engine.engine != "cocos" {
        return Ok(GenericProjectMcpSetupResult {
            ok: false,
            changed: false,
            dry_run: req.dry_run == Some(true),
            server_id: COCOS_MCP_SERVER_ID.to_string(),
            label: "Cocos MCP".to_string(),
            description: "wellingfeng/cocos-mcp-server：Cocos Creator 扩展形式的 MCP 服务。"
                .to_string(),
            transport: "streamable-http".to_string(),
            server_command: None,
            server_args: Vec::new(),
            server_url: Some(COCOS_MCP_URL.to_string()),
            configured_files: Vec::new(),
            changed_files: Vec::new(),
            notes: Vec::new(),
            warnings: Vec::new(),
            error: Some(
                "未检测到 Cocos 工程；需要 project.json 或 settings/project.json，并包含 assets/。"
                    .to_string(),
            ),
        });
    }

    let dry_run = req.dry_run == Some(true);
    let extension_path = root.join(COCOS_MCP_EXTENSION_DIR);
    let mut configured_files = vec![".mcp.json".to_string(), COCOS_MCP_EXTENSION_DIR.to_string()];
    let mut changed_files = Vec::new();
    let mut notes = Vec::new();
    let mut warnings = Vec::new();
    if dry_run {
        notes.push("演练模式：未写入任何文件。".to_string());
    } else {
        std::fs::create_dir_all(root.join("extensions"))
            .map_err(|e| format!("创建 extensions 目录失败：{e}"))?;
        if project_directory_nonempty(&extension_path) {
            notes.push("Cocos MCP 扩展目录已存在，跳过 clone。".to_string());
        } else {
            if extension_path.exists() {
                std::fs::remove_dir_all(&extension_path)
                    .map_err(|e| format!("清理空扩展目录失败：{e}"))?;
            }
            project_run_git(
                &[
                    "clone",
                    "--depth",
                    "1",
                    COCOS_MCP_SOURCE_URL,
                    COCOS_MCP_EXTENSION_DIR,
                ],
                &root,
            )?;
            changed_files.push(COCOS_MCP_EXTENSION_DIR.to_string());
        }
        if extension_path.join("package.json").is_file() {
            project_run_npm(&["install"], &extension_path)?;
            project_run_npm(&["run", "build"], &extension_path)?;
            notes.push("已在扩展目录执行 npm install 和 npm run build。".to_string());
        } else {
            warnings.push("扩展目录中未找到 package.json，请确认插件是否完整。".to_string());
        }
        let desired = serde_json::json!({
            "url": COCOS_MCP_URL,
            "transport": "streamable-http"
        });
        if let Some(file) = project_mcp_write_project_mcp_json(&root, COCOS_MCP_SERVER_ID, desired)?
        {
            changed_files.push(file);
        }
        notes.push("已配置 Cocos Creator 扩展和项目 .mcp.json。".to_string());
        warnings.push("请在 Cocos Creator 中打开 Extension Manager 启用 cocos-mcp-server；扩展服务启动后再探测 MCP。".to_string());
        warnings
            .push("如未安装 git，请从来源仓库手动下载到 extensions/cocos-mcp-server。".to_string());
    }
    configured_files.sort();
    configured_files.dedup();

    Ok(GenericProjectMcpSetupResult {
        ok: true,
        changed: !changed_files.is_empty(),
        dry_run,
        server_id: COCOS_MCP_SERVER_ID.to_string(),
        label: "Cocos MCP".to_string(),
        description: "wellingfeng/cocos-mcp-server：Cocos Creator 扩展形式的 MCP 服务。"
            .to_string(),
        transport: "streamable-http".to_string(),
        server_command: None,
        server_args: Vec::new(),
        server_url: Some(COCOS_MCP_URL.to_string()),
        configured_files,
        changed_files,
        notes,
        warnings,
        error: None,
    })
}

#[tauri::command]
async fn godot_mcp_setup_project(
    request: GenericProjectMcpSetupRequest,
) -> Result<GenericProjectMcpSetupResult, String> {
    tauri::async_runtime::spawn_blocking(move || godot_mcp_setup_project_blocking(request))
        .await
        .map_err(|e| format!("Godot MCP 配置任务失败: {e}"))?
}

#[tauri::command]
async fn cocos_mcp_setup_project(
    request: GenericProjectMcpSetupRequest,
) -> Result<GenericProjectMcpSetupResult, String> {
    tauri::async_runtime::spawn_blocking(move || cocos_mcp_setup_project_blocking(request))
        .await
        .map_err(|e| format!("Cocos MCP 配置任务失败: {e}"))?
}

// ===== Unreal Engine MCP one-click install + setup =====
//
// Wraps `ue-mcp-for-all-versions` (https://github.com/wellingfeng/ue-mcp-for-all-versions):
// a single version-agnostic binary that drives UE 4.25–5.8 over RemoteControl.
// The binary is purely the MCP server/probe (`--host/--port/--probe`); it does
// NOT implement project configuration. So we resolve the *latest* GitHub
// release at install time, download + sha256-verify it (using the digest the
// GitHub API advertises), cache it under the global tools dir keyed by version,
// and do the project setup natively in Rust: enable the stock engine plugins in the
// `.uproject`, make the RemoteControl web server auto-start on launch (the
// `WebControl.EnableServerOnStartup` CVar, which is exactly what the binary's
// own "Start UE and run WebControl.StartServer" message asks for), and write/
// merge the project `.mcp.json`. This gives the UI true one-click "Enable
// Unreal MCP" without depending on a binary subcommand that does not exist.

/// Stable server id used in project settings so one-click + "apply recommended" converge.
const UE_MCP_SERVER_ID: &str = "ue-mcp-for-all-versions";
const UE_MCP_DISABLED_ARCHIVE_KEY: &str = "ultragamestudioDisabledMcpServers";
/// GitHub "latest release" API — resolved at install time so we always pull the
/// newest published `ue-mcp-for-all-versions` build instead of a pinned tag.
const UE_MCP_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/wellingfeng/ue-mcp-for-all-versions/releases/latest";
/// Fallback release used only when the GitHub API is unreachable, so one-click
/// install still works offline-ish. Keep this reasonably current.
const UE_MCP_FALLBACK_VERSION: &str = "v0.4.0";
const UE_MCP_FALLBACK_ASSET_NAME: &str = "ue-mcp-for-all-versions.exe";
const UE_MCP_FALLBACK_DOWNLOAD_URL: &str = "https://github.com/wellingfeng/ue-mcp-for-all-versions/releases/download/v0.4.0/ue-mcp-for-all-versions.exe";
const UE_MCP_FALLBACK_SHA256: &str =
    "7e536be5ad2d54b836a4ebb67c6418143d0b2504e0d87ce75cc126123ea1ca92";
const UE_MCP_DOWNLOAD_LIMIT: usize = 64 * 1024 * 1024;
const UE_MCP_DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);
const UE_MCP_API_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// A resolved release asset to download (version-agnostic; populated from the
/// GitHub API or the pinned fallback).
#[derive(Clone)]
struct UeMcpRelease {
    version: String,
    asset_name: String,
    download_url: String,
    /// sha256 hex from the GitHub asset `digest` when available; `None` means
    /// the API did not advertise a digest and we trust the download as-is.
    sha256: Option<String>,
}

/// Persisted pointer to the currently installed binary so status checks and
/// project setup can find it offline (no network, no version guessing).
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UeMcpInstalledMeta {
    version: String,
    asset_name: String,
    /// Absolute path to the cached binary.
    path: String,
    sha256: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UeMcpBinaryStatus {
    server_id: String,
    version: String,
    path: String,
    available: bool,
    downloaded: bool,
    sha256: String,
    source: String,
    supported_platform: bool,
    message: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct UeMcpSetupRequest {
    root_path: String,
    server_command: Option<String>,
    enable_python: Option<bool>,
    write_mcp_config: Option<bool>,
    dry_run: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UeMcpSetupResult {
    ok: bool,
    changed: bool,
    dry_run: bool,
    uproject_path: Option<String>,
    project_dir: Option<String>,
    engine_association: Option<String>,
    configured_plugins: Vec<String>,
    changed_files: Vec<String>,
    notes: Vec<String>,
    warnings: Vec<String>,
    unreal_editor_running: bool,
    restart_required: bool,
    error: Option<String>,
    binary_path: String,
    server_command: String,
    raw_report: serde_json::Value,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Directory that holds the cached binary plus the `installed.json` pointer.
fn ue_mcp_tools_dir() -> Result<PathBuf, String> {
    let root = storage_paths::ensure_global_root_with_dirs(&["tools"])?;
    let dir = root.join("tools").join("ue-mcp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 UE MCP 工具目录失败：{e}"))?;
    Ok(dir)
}

/// Read-only tools dir (no side effects) for status queries.
fn ue_mcp_tools_dir_readonly() -> Option<PathBuf> {
    storage_paths::global_root()
        .ok()
        .map(|root| root.join("tools").join("ue-mcp"))
}

fn ue_mcp_meta_path_readonly() -> Option<PathBuf> {
    ue_mcp_tools_dir_readonly().map(|dir| dir.join("installed.json"))
}

/// Pointer to whatever version we last installed; drives offline status checks
/// and project setup without re-resolving the release.
fn ue_mcp_read_installed_meta() -> Option<UeMcpInstalledMeta> {
    let path = ue_mcp_meta_path_readonly()?;
    let bytes = std::fs::read(&path).ok()?;
    serde_json::from_slice::<UeMcpInstalledMeta>(&bytes).ok()
}

fn ue_mcp_write_installed_meta(meta: &UeMcpInstalledMeta) -> Result<(), String> {
    let dir = ue_mcp_tools_dir()?;
    let path = dir.join("installed.json");
    let serialized =
        serde_json::to_vec_pretty(meta).map_err(|e| format!("序列化 UE MCP 安装信息失败：{e}"))?;
    atomic_write(&path, &serialized).map_err(|e| format!("写入 UE MCP 安装信息失败：{e}"))
}

fn ue_mcp_verify_file(path: &Path, expected_sha: &str) -> bool {
    std::fs::read(path)
        .ok()
        .map(|bytes| sha256_hex(&bytes).eq_ignore_ascii_case(expected_sha))
        .unwrap_or(false)
}

/// Path of the currently installed binary, per `installed.json`.
fn ue_mcp_expected_binary_path() -> Option<PathBuf> {
    ue_mcp_read_installed_meta().map(|meta| PathBuf::from(meta.path))
}

/// True when `path` matches the recorded install and its sha256 still checks out.
fn ue_mcp_binary_verified(path: &Path) -> bool {
    match ue_mcp_read_installed_meta() {
        Some(meta) => PathBuf::from(&meta.path) == path && ue_mcp_verify_file(path, &meta.sha256),
        None => false,
    }
}

/// Resolve the GitHub "latest" release into a concrete downloadable asset.
/// Falls back to a pinned release when the API is unreachable.
fn ue_mcp_resolve_latest_release() -> UeMcpRelease {
    match ue_mcp_query_latest_release() {
        Ok(release) => release,
        Err(_) => UeMcpRelease {
            version: UE_MCP_FALLBACK_VERSION.to_string(),
            asset_name: UE_MCP_FALLBACK_ASSET_NAME.to_string(),
            download_url: UE_MCP_FALLBACK_DOWNLOAD_URL.to_string(),
            sha256: Some(UE_MCP_FALLBACK_SHA256.to_string()),
        },
    }
}

fn ue_mcp_query_latest_release() -> Result<UeMcpRelease, String> {
    let body: serde_json::Value = ureq::get(UE_MCP_LATEST_RELEASE_API)
        .timeout(UE_MCP_API_TIMEOUT)
        .set("User-Agent", "UltraGameStudio")
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("查询 UE MCP 最新版本失败：HTTP {code}。"),
            other => format!("查询 UE MCP 最新版本失败：{other}"),
        })?
        .into_json()
        .map_err(|e| format!("解析 UE MCP 版本信息失败：{e}"))?;

    let version = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "UE MCP 版本信息缺少 tag_name。".to_string())?;

    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "UE MCP 版本信息缺少 assets。".to_string())?;

    // Prefer a Windows `.exe` asset (win64-tagged first, then any .exe).
    let pick = assets
        .iter()
        .filter(|asset| {
            asset
                .get("name")
                .and_then(|n| n.as_str())
                .map(|name| name.to_ascii_lowercase().ends_with(".exe"))
                .unwrap_or(false)
        })
        .max_by_key(|asset| {
            let name = asset
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if name.contains("win64") {
                2
            } else if name.contains("win") {
                1
            } else {
                0
            }
        })
        .ok_or_else(|| {
            "最新 UE MCP 版本未提供 Windows .exe 预编译资源，请手动编译。".to_string()
        })?;

    let asset_name = pick
        .get("name")
        .and_then(|n| n.as_str())
        .map(str::to_string)
        .ok_or_else(|| "UE MCP 资源缺少名称。".to_string())?;
    let download_url = pick
        .get("browser_download_url")
        .and_then(|u| u.as_str())
        .map(str::to_string)
        .ok_or_else(|| "UE MCP 资源缺少下载地址。".to_string())?;
    // GitHub advertises `digest` like "sha256:<hex>"; use it to verify the download.
    let sha256 = pick
        .get("digest")
        .and_then(|d| d.as_str())
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(|hex| hex.to_string());

    Ok(UeMcpRelease {
        version,
        asset_name,
        download_url,
        sha256,
    })
}

fn ue_mcp_download_binary(release: &UeMcpRelease, target: &Path) -> Result<String, String> {
    let response = ureq::get(&release.download_url)
        .timeout(UE_MCP_DOWNLOAD_TIMEOUT)
        .set("User-Agent", "UltraGameStudio")
        .set("Accept", "application/octet-stream,*/*;q=0.8")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("UE MCP 下载失败：HTTP {code}。"),
            other => format!("UE MCP 下载失败：{other}"),
        })?;
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut reader)
        .take((UE_MCP_DOWNLOAD_LIMIT as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取 UE MCP 下载内容失败：{e}"))?;
    if bytes.is_empty() {
        return Err("UE MCP 下载内容为空。".to_string());
    }
    if bytes.len() > UE_MCP_DOWNLOAD_LIMIT {
        return Err("UE MCP 二进制超出大小上限。".to_string());
    }
    let digest = sha256_hex(&bytes);
    if let Some(expected) = release.sha256.as_deref() {
        if !digest.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "UE MCP 校验失败：期望 {expected}，实际 {digest}。已放弃使用未校验的二进制。"
            ));
        }
    }
    let tmp = target.with_extension("download");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写入 UE MCP 二进制失败：{e}"))?;
    std::fs::rename(&tmp, target)
        .or_else(|_| {
            std::fs::remove_file(target).ok();
            std::fs::rename(&tmp, target)
        })
        .map_err(|e| format!("保存 UE MCP 二进制失败：{e}"))?;
    Ok(digest)
}

fn ue_mcp_ensure_binary_blocking() -> Result<UeMcpBinaryStatus, String> {
    if !cfg!(target_os = "windows") {
        return Err(
            "一键安装目前仅提供 Windows 预编译二进制；其他平台请手动编译 ue-mcp-for-all-versions。"
                .to_string(),
        );
    }

    let release = ue_mcp_resolve_latest_release();

    // Already on the resolved version and the cached binary still verifies?
    // Skip the download.
    if let Some(meta) = ue_mcp_read_installed_meta() {
        let cached = PathBuf::from(&meta.path);
        if meta.version == release.version
            && cached.is_file()
            && ue_mcp_verify_file(&cached, &meta.sha256)
        {
            return Ok(UeMcpBinaryStatus {
                server_id: UE_MCP_SERVER_ID.to_string(),
                version: meta.version.clone(),
                path: display_preview_path(&cached),
                available: true,
                downloaded: false,
                sha256: meta.sha256.clone(),
                source: "cached".to_string(),
                supported_platform: true,
                message: format!(
                    "已使用本地缓存的 UE MCP {} 二进制（校验通过）。",
                    meta.version
                ),
            });
        }
    }

    let dir = ue_mcp_tools_dir()?.join(&release.version);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 UE MCP 版本目录失败：{e}"))?;
    let target = dir.join(&release.asset_name);

    if target.is_file() {
        std::fs::remove_file(&target).ok();
    }
    let digest = ue_mcp_download_binary(&release, &target)?;

    let meta = UeMcpInstalledMeta {
        version: release.version.clone(),
        asset_name: release.asset_name.clone(),
        path: target.to_string_lossy().to_string(),
        sha256: digest.clone(),
    };
    ue_mcp_write_installed_meta(&meta)?;

    Ok(UeMcpBinaryStatus {
        server_id: UE_MCP_SERVER_ID.to_string(),
        version: release.version.clone(),
        path: display_preview_path(&target),
        available: true,
        downloaded: true,
        sha256: digest,
        source: "downloaded".to_string(),
        supported_platform: true,
        message: format!("已下载并校验 UE MCP {} 二进制。", release.version),
    })
}

#[tauri::command]
async fn ue_mcp_ensure_binary() -> Result<UeMcpBinaryStatus, String> {
    tauri::async_runtime::spawn_blocking(ue_mcp_ensure_binary_blocking)
        .await
        .map_err(|e| format!("UE MCP 下载任务失败: {e}"))?
}

/// Atomic write via tmp + rename so a crash mid-write can't corrupt project
/// config files. Falls back to remove+rename when the target already exists.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default()
    ));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).or_else(|_| {
        std::fs::remove_file(path).ok();
        std::fs::rename(&tmp, path)
    })
}

/// Parse an `EngineAssociation` like "5.3" / "4.25" into `(major, minor)`.
/// Source builds use a GUID (e.g. `{...}`) and return `None`.
fn ue_mcp_parse_engine_version(assoc: &str) -> Option<(u32, u32)> {
    let trimmed = assoc.trim();
    if trimmed.is_empty() || trimmed.starts_with('{') {
        return None;
    }
    let mut parts = trimmed.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts
        .next()
        .and_then(|m| m.trim().parse::<u32>().ok())
        .unwrap_or(0);
    Some((major, minor))
}

/// Stock engine plugins required for the MCP server to drive the editor over
/// RemoteControl, EditorScripting helpers, and Python execution tools.
const UE_MCP_REQUIRED_PLUGINS: &[&str] = &[
    "RemoteControl",
    "EditorScriptingUtilities",
    "PythonScriptPlugin",
];

fn ue_mcp_tasklist_contains_unreal_editor(tasklist_stdout: &str) -> bool {
    tasklist_stdout.lines().any(|line| {
        let process_name = line
            .trim()
            .trim_start_matches('"')
            .split("\",")
            .next()
            .unwrap_or("")
            .trim_matches('"')
            .to_ascii_lowercase();
        (process_name.starts_with("unrealeditor") || process_name.starts_with("ue4editor"))
            && !process_name.contains("-cmd")
    })
}

fn ue_mcp_unreal_editor_running() -> bool {
    if !cfg!(target_os = "windows") {
        return false;
    }
    let output = Command::new("tasklist")
        .arg("/FO")
        .arg("CSV")
        .arg("/NH")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();
    output
        .ok()
        .filter(|out| out.status.success())
        .map(|out| ue_mcp_tasklist_contains_unreal_editor(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or(false)
}

/// Ensure the named plugins are enabled in the `.uproject` JSON. Returns the
/// list of plugins that were newly enabled (empty if all were already on).
/// Preserves existing entries; only flips `Enabled` to true or appends a new
/// `{ "Name": ..., "Enabled": true }` entry.
fn ue_mcp_enable_uproject_plugins(
    uproject: &Path,
    plugins: &[&str],
) -> Result<Vec<String>, String> {
    let text =
        std::fs::read_to_string(uproject).map_err(|e| format!("读取 .uproject 失败：{e}"))?;
    let mut doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析 .uproject JSON 失败：{e}"))?;
    if !doc.is_object() {
        return Err(".uproject 顶层不是 JSON 对象。".to_string());
    }

    let plugins_array = doc
        .as_object_mut()
        .unwrap()
        .entry("Plugins")
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    if !plugins_array.is_array() {
        return Err(".uproject 中 Plugins 字段不是数组。".to_string());
    }
    let list = plugins_array.as_array_mut().unwrap();

    let mut newly_enabled = Vec::new();
    for plugin in plugins {
        let existing = list.iter_mut().find(|entry| {
            entry
                .get("Name")
                .and_then(|n| n.as_str())
                .is_some_and(|n| n.eq_ignore_ascii_case(plugin))
        });
        match existing {
            Some(entry) => {
                let was_enabled = entry
                    .get("Enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert("Enabled".to_string(), serde_json::Value::Bool(true));
                }
                if !was_enabled {
                    newly_enabled.push((*plugin).to_string());
                }
            }
            None => {
                let mut obj = serde_json::Map::new();
                obj.insert(
                    "Name".to_string(),
                    serde_json::Value::String((*plugin).to_string()),
                );
                obj.insert("Enabled".to_string(), serde_json::Value::Bool(true));
                list.push(serde_json::Value::Object(obj));
                newly_enabled.push((*plugin).to_string());
            }
        }
    }

    if !newly_enabled.is_empty() {
        let serialized = serde_json::to_string_pretty(&doc)
            .map_err(|e| format!("序列化 .uproject 失败：{e}"))?;
        atomic_write(uproject, serialized.as_bytes())
            .map_err(|e| format!("写入 .uproject 失败：{e}"))?;
    }
    Ok(newly_enabled)
}

fn ini_has_line(existing: &str, wanted: &str) -> bool {
    existing.lines().any(|line| line.trim() == wanted)
}

fn ini_missing_any_line(existing: &str, wanted: &[&str]) -> bool {
    wanted
        .iter()
        .filter(|line| !line.trim().is_empty())
        .any(|line| !ini_has_line(existing, line))
}

const UE_MCP_REMOTE_CONTROL_STARTUP_MARKER: &str =
    "; >>> UltraGameStudio: Unreal MCP RemoteControl auto-start";
const UE_MCP_REMOTE_CONTROL_PERMISSION_MARKER: &str =
    "; >>> UltraGameStudio: Unreal MCP full-access defaults";
const UE_MCP_REMOTE_CONTROL_PERMISSION_LINES: &[&str] = &[
    "[/Script/RemoteControl.RemoteControlSettings]",
    "[/Script/RemoteControlCommon.RemoteControlSettings]",
    "bAutoStartWebServer=True",
    "bAutoStartWebSocketServer=True",
    "RemoteControlHttpServerPort=30010",
    "RemoteControlWebSocketServerPort=30020",
    "bRestrictServerAccess=False",
    "bEnforcePassphraseForRemoteClients=False",
    "bShowPassphraseDisabledWarning=False",
    "bAllowConsoleCommandRemoteExecution=True",
    "bEnableRemotePythonExecution=True",
    // Compatibility aliases used by older/community UE RemoteControl builds.
    "bAllowRemotePythonExecution=True",
    "bAllowPythonExecution=True",
    "bEnableRemoteExecution=True",
    "bAllowRemoteExecutionOfConsoleCommands=True",
    "[/Script/PythonScriptPlugin.PythonScriptPluginSettings]",
    "bRemoteExecution=True",
];

fn ue_mcp_remote_control_permission_block() -> String {
    let mut block = String::new();
    block.push('\n');
    block.push_str(UE_MCP_REMOTE_CONTROL_PERMISSION_MARKER);
    block.push('\n');
    for section in [
        "[/Script/RemoteControl.RemoteControlSettings]",
        "[/Script/RemoteControlCommon.RemoteControlSettings]",
    ] {
        block.push_str(section);
        block.push('\n');
        block.push_str("bAutoStartWebServer=True\n");
        block.push_str("bAutoStartWebSocketServer=True\n");
        block.push_str("RemoteControlHttpServerPort=30010\n");
        block.push_str("RemoteControlWebSocketServerPort=30020\n");
        block.push_str("bRestrictServerAccess=False\n");
        block.push_str("bEnforcePassphraseForRemoteClients=False\n");
        block.push_str("bShowPassphraseDisabledWarning=False\n");
        block.push_str("bAllowConsoleCommandRemoteExecution=True\n");
        block.push_str("bEnableRemotePythonExecution=True\n");
        block.push_str("bAllowRemotePythonExecution=True\n");
        block.push_str("bAllowPythonExecution=True\n");
        block.push_str("bEnableRemoteExecution=True\n");
        block.push_str("bAllowRemoteExecutionOfConsoleCommands=True\n\n");
    }
    block.push_str("[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\n");
    block.push_str("bRemoteExecution=True\n");
    block.push_str("bAllowRemotePythonExecution=True\n");
    block.push_str("; <<< UltraGameStudio: Unreal MCP full-access defaults\n");
    block
}

/// Make the RemoteControl web server auto-start when the editor launches and
/// enable the permissive project settings the UE MCP bridge needs. Appends
/// idempotent managed blocks to both `Config/DefaultEngine.ini` and
/// `Config/DefaultRemoteControl.ini`. The startup CVar differs per engine line:
///   - UE 4.25:  `WebControl.EnableServerOnStartup 1` on :8080 (RemoteControlWeb)
///   - UE 4.26+: RemoteControl auto-starts on :30010, but enabling the startup
///     CVar is harmless and makes 4.26 web-control explicit.
/// Returns relative markers for files created/modified.
fn ue_mcp_write_remote_control_config_file(
    root: &Path,
    ini_path: &Path,
    engine: Option<(u32, u32)>,
    include_startup: bool,
) -> Result<Option<String>, String> {
    if let Some(parent) = ini_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 Config 目录失败：{e}"))?;
    }

    let existing = std::fs::read_to_string(&ini_path).unwrap_or_default();
    let is_legacy_425 = matches!(engine, Some((4, minor)) if minor <= 25);
    let mut blocks = Vec::new();
    if include_startup && !existing.contains(UE_MCP_REMOTE_CONTROL_STARTUP_MARKER) {
        let mut block = String::new();
        block.push('\n');
        block.push_str(UE_MCP_REMOTE_CONTROL_STARTUP_MARKER);
        block.push('\n');
        block.push_str("[/Script/Engine.Engine]\n");
        if is_legacy_425 {
            block.push_str(
                "+ConsoleCommands=WebControl.EnableServerOnStartup 1\n+ConsoleCommands=WebControl.StartServer\n",
            );
        } else {
            block.push_str(
                "+ConsoleCommands=RemoteControl.EnableWebServerOnStartup 1\n+ConsoleCommands=WebControl.EnableServerOnStartup 1\n",
            );
        }
        block.push_str("; <<< UltraGameStudio: Unreal MCP RemoteControl auto-start\n");
        blocks.push(block);
    }

    if ini_missing_any_line(&existing, UE_MCP_REMOTE_CONTROL_PERMISSION_LINES) {
        blocks.push(ue_mcp_remote_control_permission_block());
    }

    if blocks.is_empty() {
        return Ok(None);
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(&blocks.concat());
    atomic_write(&ini_path, next.as_bytes())
        .map_err(|e| format!("写入 {} 失败：{e}", project_relative_marker(root, ini_path)))?;
    Ok(Some(project_relative_marker(root, &ini_path)))
}

fn ue_mcp_write_remote_control_config(
    root: &Path,
    engine: Option<(u32, u32)>,
) -> Result<Vec<String>, String> {
    let config_dir = root.join("Config");
    let mut changed = Vec::new();
    for (file_name, include_startup) in [
        ("DefaultEngine.ini", true),
        ("DefaultRemoteControl.ini", false),
    ] {
        if let Some(marker) = ue_mcp_write_remote_control_config_file(
            root,
            &config_dir.join(file_name),
            engine,
            include_startup,
        )? {
            changed.push(marker);
        }
    }
    Ok(changed)
}

fn ue_mcp_compact_id(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(|ch| ch.to_lowercase())
        .collect()
}

fn ue_mcp_append_json_search_text(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::String(text) => {
            out.push(' ');
            out.push_str(&text.to_ascii_lowercase());
        }
        serde_json::Value::Array(items) => {
            for item in items {
                ue_mcp_append_json_search_text(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                out.push(' ');
                out.push_str(&key.to_ascii_lowercase());
                ue_mcp_append_json_search_text(item, out);
            }
        }
        _ => {}
    }
}

fn ue_mcp_conflicts_with_preferred_server(id: &str, server: &serde_json::Value) -> bool {
    if id == UE_MCP_SERVER_ID {
        return false;
    }
    if matches!(
        ue_mcp_compact_id(id).as_str(),
        "ue" | "uemcp"
            | "unreal"
            | "unrealmcp"
            | "unrealengine"
            | "unrealenginemcp"
            | "ue5mcp"
            | "ue4mcp"
    ) {
        return true;
    }

    let mut text = id.to_ascii_lowercase();
    ue_mcp_append_json_search_text(server, &mut text);
    let looks_like_unreal_mcp =
        (text.contains("unreal") && text.contains("mcp")) || text.contains("ue-mcp");
    let controls_editor = text.contains("remotecontrol")
        || text.contains("editor")
        || text.contains("python")
        || text.contains("blueprint")
        || text.contains("uproject")
        || text.contains("unrealengine");
    looks_like_unreal_mcp && controls_editor
}

/// Merge the MCP server entry into the project `.mcp.json` (Claude Code format:
/// `{ "mcpServers": { "<id>": { "command": ..., "args": [] } } }`). Preserves
/// non-UE servers, and archives conflicting UE MCP entries outside `mcpServers`
/// so they no longer compete with `ue-mcp-for-all-versions`.
fn ue_mcp_write_project_mcp_json(
    root: &Path,
    server_command: &str,
) -> Result<Option<String>, String> {
    let mcp_path = root.join(".mcp.json");
    let mut doc: serde_json::Value = std::fs::read_to_string(&mcp_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    let before = doc.clone();

    let mut archived_conflicts = serde_json::Map::new();
    let desired = serde_json::json!({
        "command": server_command,
        "args": [],
    });

    {
        let root_obj = doc.as_object_mut().unwrap();
        let servers = root_obj
            .entry("mcpServers")
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !servers.is_object() {
            *servers = serde_json::Value::Object(serde_json::Map::new());
        }
        let servers_obj = servers.as_object_mut().unwrap();
        let existing_servers = std::mem::take(servers_obj);

        servers_obj.insert(UE_MCP_SERVER_ID.to_string(), desired);
        for (id, server) in existing_servers {
            if id == UE_MCP_SERVER_ID {
                continue;
            }
            if ue_mcp_conflicts_with_preferred_server(&id, &server) {
                archived_conflicts.insert(id, server);
            } else {
                servers_obj.insert(id, server);
            }
        }
    }

    if !archived_conflicts.is_empty() {
        let archive = doc
            .as_object_mut()
            .unwrap()
            .entry(UE_MCP_DISABLED_ARCHIVE_KEY)
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if !archive.is_object() {
            *archive = serde_json::Value::Object(serde_json::Map::new());
        }
        let archive_obj = archive.as_object_mut().unwrap();
        for (id, server) in archived_conflicts {
            archive_obj.insert(id, server);
        }
    }

    if doc == before {
        return Ok(None);
    }

    let serialized =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化 .mcp.json 失败：{e}"))?;
    atomic_write(&mcp_path, serialized.as_bytes())
        .map_err(|e| format!("写入 .mcp.json 失败：{e}"))?;
    Ok(Some(project_relative_marker(root, &mcp_path)))
}

fn ue_mcp_setup_project_blocking(req: UeMcpSetupRequest) -> Result<UeMcpSetupResult, String> {
    let root = project_scan_root(&req.root_path)?;
    let binary = ue_mcp_expected_binary_path().ok_or_else(|| {
        "UE MCP 二进制不存在，请先点击“一键配置 Unreal MCP”下载安装。".to_string()
    })?;
    if !binary.is_file() {
        return Err("UE MCP 二进制不存在，请先下载安装。".to_string());
    }
    if !ue_mcp_binary_verified(&binary) {
        return Err("本地 UE MCP 二进制校验未通过，请重新下载安装。".to_string());
    }
    let binary_display = display_preview_path(&binary);
    let server_command = req
        .server_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| binary_display.clone());

    let dry_run = req.dry_run == Some(true);

    // Locate the .uproject — this is what makes the folder an Unreal project.
    let uproject = project_first_root_file_with_ext(&root, "uproject").ok_or_else(|| {
        "未在工作区根目录找到 .uproject 文件，请确认这是一个 Unreal 工程根目录。".to_string()
    })?;
    let engine_association = project_json_string(&uproject, "EngineAssociation");
    let engine_version = engine_association
        .as_deref()
        .and_then(ue_mcp_parse_engine_version);

    // PythonScriptPlugin is intentionally always enabled. Older callers may
    // still send enablePython=false; ignore it so one-click setup keeps the
    // Python-backed UE MCP tools available.
    let _legacy_enable_python = req.enable_python;
    let wanted_plugins: Vec<&str> = UE_MCP_REQUIRED_PLUGINS.to_vec();
    let unreal_editor_running = ue_mcp_unreal_editor_running();

    let configured_plugins: Vec<String> = wanted_plugins.iter().map(|p| (*p).to_string()).collect();
    let mut changed_files: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut restart_sensitive_changed = false;

    if dry_run {
        // Report what *would* change without touching disk.
        notes.push("演练模式：未写入任何文件。".to_string());
        return Ok(UeMcpSetupResult {
            ok: true,
            changed: false,
            dry_run: true,
            uproject_path: Some(project_path_display(&uproject)),
            project_dir: Some(display_preview_path(&root)),
            engine_association,
            configured_plugins,
            changed_files,
            notes,
            warnings,
            unreal_editor_running,
            restart_required: false,
            error: None,
            binary_path: binary_display,
            server_command,
            raw_report: serde_json::json!({ "dryRun": true }),
        });
    }

    // 1) Enable the stock plugins in the .uproject.
    let newly_enabled = ue_mcp_enable_uproject_plugins(&uproject, &wanted_plugins)?;
    if !newly_enabled.is_empty() {
        restart_sensitive_changed = true;
        changed_files.push(project_relative_marker(&root, &uproject));
    }
    // `configured_plugins` already holds the full set we ensured (enabled now or
    // already on) so the UI shows the complete picture rather than only deltas.

    // 2) Make RemoteControl auto-start so the editor is reachable without a
    //    manual console command, and open the RemoteControl/Python execution
    //    switches used by ue-mcp-for-all-versions.
    let config_markers = ue_mcp_write_remote_control_config(&root, engine_version)?;
    if !config_markers.is_empty() {
        restart_sensitive_changed = true;
        changed_files.extend(config_markers);
    }
    notes.push(
        "已确保 UE MCP 默认权限：RemoteControl HTTP/WebSocket 自启动、远程 Python 执行、远程控制台命令。"
            .to_string(),
    );

    // 3) Merge the project .mcp.json (only when requested; default on).
    if req.write_mcp_config != Some(false) {
        if let Some(marker) = ue_mcp_write_project_mcp_json(&root, &server_command)? {
            changed_files.push(marker);
        }
    }

    let restart_required = unreal_editor_running && restart_sensitive_changed;
    if restart_required {
        warnings.push(
            "已检测到 Unreal Editor 正在运行或启动中；本次启用了插件或改动了 RemoteControl / Python 权限配置，必须重启 Unreal Editor 后生效。"
                .to_string(),
        );
    } else if restart_sensitive_changed {
        notes.push(
            "如 Unreal Editor 已经打开，请重启编辑器；未打开则下次启动会直接加载这些配置。"
                .to_string(),
        );
    }

    // Best-effort connectivity probe. A failure here is EXPECTED when the editor
    // isn't running yet — the server connects lazily — so it's a note, not an
    // error. This is what previously surfaced as a fatal "配置失败".
    let mut probe_report = serde_json::Value::Null;
    let mut probe = new_spawn_command(&binary.to_string_lossy());
    probe
        .arg("--probe")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match probe.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            if let Some(start) = stdout.find('{') {
                if let Some(end) = stdout.rfind('}') {
                    if end >= start {
                        probe_report = serde_json::from_str(stdout[start..=end].trim())
                            .unwrap_or(serde_json::Value::Null);
                    }
                }
            }
            let reachable = probe_report
                .get("infoAvailable")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || probe_report
                    .get("routeCount")
                    .and_then(|v| v.as_u64())
                    .map(|n| n > 0)
                    .unwrap_or(false);
            if reachable {
                notes
                    .push("已检测到正在运行的 Unreal 编辑器，RemoteControl 连接正常。".to_string());
            } else if unreal_editor_running {
                warnings.push(
                    "已检测到 Unreal Editor 正在运行或启动中，但 RemoteControl 暂不可达；如刚完成一键配置，请重启 Unreal Editor。"
                        .to_string(),
                );
            } else {
                notes.push(
                    "尚未检测到运行中的 Unreal 编辑器（属正常）。配置已写入，编辑器启动后 MCP 会自动连接。"
                        .to_string(),
                );
            }
        }
        Err(e) => {
            warnings.push(format!("连接探测未能运行：{e}"));
        }
    }

    let changed = !changed_files.is_empty();
    if !changed {
        notes.push("工程已配置妥当，本次无需改动。".to_string());
    }

    Ok(UeMcpSetupResult {
        ok: true,
        changed,
        dry_run: false,
        uproject_path: Some(project_path_display(&uproject)),
        project_dir: Some(display_preview_path(&root)),
        engine_association,
        configured_plugins,
        changed_files,
        notes,
        warnings,
        unreal_editor_running,
        restart_required,
        error: None,
        binary_path: binary_display,
        server_command,
        raw_report: serde_json::json!({
            "newlyEnabledPlugins": newly_enabled,
            "unrealEditorRunning": unreal_editor_running,
            "restartRequired": restart_required,
            "probe": probe_report,
        }),
    })
}

#[tauri::command]
async fn ue_mcp_setup_project(request: UeMcpSetupRequest) -> Result<UeMcpSetupResult, String> {
    tauri::async_runtime::spawn_blocking(move || ue_mcp_setup_project_blocking(request))
        .await
        .map_err(|e| format!("UE MCP 安装任务失败: {e}"))?
}

const WORKSPACE_CHANGE_LINE_LIMIT: usize = 320;
const WORKSPACE_CHANGE_TOTAL_LINE_LIMIT: usize = 2400;
const WORKSPACE_CHANGE_SNAPSHOT_TEXT_LIMIT: usize = 160 * 1024;
const WORKSPACE_CHANGE_SNAPSHOT_TOTAL_TEXT_LIMIT: usize = 32 * 1024 * 1024;
const WORKSPACE_CHANGE_DIFF_DP_CELL_LIMIT: usize = 1_500_000;
const WORKSPACE_CHANGE_JSON_CACHE_READ_LIMIT: u64 = 96 * 1024 * 1024;

fn workspace_change_safe_cache_key(cache_key: &str) -> String {
    let mut out = String::new();
    for ch in cache_key.chars().take(180) {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "session".to_string()
    } else {
        out
    }
}

fn workspace_change_cache_file(root: &Path, cache_key: &str, suffix: &str) -> PathBuf {
    let cwd = display_preview_path(root);
    storage_paths::managed_artifact_dir(Some(&cwd), "session-changes").join(format!(
        "{}.{suffix}.json",
        workspace_change_safe_cache_key(cache_key)
    ))
}

fn read_json_cache<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    if std::fs::metadata(path)
        .ok()
        .is_some_and(|metadata| metadata.len() > WORKSPACE_CHANGE_JSON_CACHE_READ_LIMIT)
    {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json_cache<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    }
    let json = serde_json::to_vec(value).map_err(|e| format!("序列化会话改动缓存失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入会话改动缓存失败: {e}"))?;
    std::fs::rename(&tmp, path)
        .or_else(|_| {
            std::fs::remove_file(path).ok();
            std::fs::rename(&tmp, path)
        })
        .map_err(|e| format!("替换会话改动缓存失败: {e}"))
}

// --- Scan Host: background workspace VCS scans ----------------------------
//
// A single shared worker drains a queue of scan requests so large projects
// (e.g. MoonEngine) scan slowly in the background instead of blocking the UI.
// Results are cached to disk so switching back to a workspace shows the last
// snapshot instantly while a fresh scan runs. Progress is reported via a
// thread-local counter that the worker reads and emits as events.

/// Per-scan progress shared between the scanning thread and the emitter.
#[derive(Default)]
struct VcsScanProgressState {
    scanned_specs: AtomicUsize,
    found_items: AtomicUsize,
    cancelled: AtomicBool,
}

thread_local! {
    static VCS_SCAN_PROGRESS: std::cell::RefCell<Option<Arc<VcsScanProgressState>>> =
        const { std::cell::RefCell::new(None) };
}

/// Bind a progress state to the current scanning thread for the duration of `f`.
fn vcs_scan_with_progress<T>(state: Arc<VcsScanProgressState>, f: impl FnOnce() -> T) -> T {
    VCS_SCAN_PROGRESS.with(|cell| {
        *cell.borrow_mut() = Some(state);
    });
    let result = f();
    VCS_SCAN_PROGRESS.with(|cell| {
        *cell.borrow_mut() = None;
    });
    result
}

/// Advance the current thread's scan progress counters, if any are bound.
fn vcs_scan_progress_advance(specs: usize, items: usize) {
    VCS_SCAN_PROGRESS.with(|cell| {
        if let Some(state) = cell.borrow().as_ref() {
            state.scanned_specs.fetch_add(specs, Ordering::Relaxed);
            state.found_items.fetch_add(items, Ordering::Relaxed);
        }
    });
}

/// Whether the current thread's scan has been asked to cancel (superseded).
fn vcs_scan_is_cancelled() -> bool {
    VCS_SCAN_PROGRESS.with(|cell| {
        cell.borrow()
            .as_ref()
            .map(|state| state.cancelled.load(Ordering::Relaxed))
            .unwrap_or(false)
    })
}

struct VcsScanJob {
    root_path: String,
    cache_key: String,
    progress: Arc<VcsScanProgressState>,
}

#[derive(Default)]
struct VcsScanQueue {
    pending: VecDeque<VcsScanJob>,
    // Most recent progress state per root, used to cancel superseded scans.
    active_by_root: HashMap<String, Arc<VcsScanProgressState>>,
    worker_started: bool,
}

fn vcs_scan_queue() -> &'static Mutex<VcsScanQueue> {
    static QUEUE: OnceLock<Mutex<VcsScanQueue>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(VcsScanQueue::default()))
}

fn vcs_scan_app_handle() -> &'static Mutex<Option<AppHandle>> {
    static HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();
    HANDLE.get_or_init(|| Mutex::new(None))
}

/// Register the app handle so the scan worker can emit progress events.
/// Called once during setup; starts the worker the first time it's invoked.
fn init_vcs_scan_service(app: AppHandle) {
    if let Ok(mut guard) = vcs_scan_app_handle().lock() {
        *guard = Some(app);
    }
    let mut queue = match vcs_scan_queue().lock() {
        Ok(q) => q,
        Err(e) => e.into_inner(),
    };
    if !queue.worker_started {
        queue.worker_started = true;
        std::thread::spawn(vcs_scan_worker_loop);
    }
}

fn vcs_scan_emit(progress: WorkspaceVcsScanProgress) {
    if let Ok(guard) = vcs_scan_app_handle().lock() {
        if let Some(app) = guard.as_ref() {
            let _ = app.emit(WORKSPACE_VCS_SCAN_PROGRESS_EVENT, progress);
        }
    }
}

/// Enqueue a background scan for `root_path`. Any in-flight scan for the same
/// root is cancelled so we never run duplicate work when the user switches
/// back and forth between workspaces.
fn enqueue_vcs_scan(root_path: String, cache_key: String) {
    let progress = Arc::new(VcsScanProgressState::default());
    let mut queue = match vcs_scan_queue().lock() {
        Ok(q) => q,
        Err(e) => e.into_inner(),
    };
    if let Some(prev) = queue.active_by_root.get(&root_path) {
        prev.cancelled.store(true, Ordering::Relaxed);
    }
    queue.pending.retain(|job| job.root_path != root_path);
    queue
        .active_by_root
        .insert(root_path.clone(), progress.clone());
    queue.pending.push_back(VcsScanJob {
        root_path,
        cache_key,
        progress,
    });
}

fn cancel_vcs_scan(root_path: &str) {
    let mut queue = match vcs_scan_queue().lock() {
        Ok(q) => q,
        Err(e) => e.into_inner(),
    };
    if let Some(prev) = queue.active_by_root.remove(root_path) {
        prev.cancelled.store(true, Ordering::Relaxed);
    }
    queue.pending.retain(|job| job.root_path != root_path);
}

fn vcs_scan_worker_loop() {
    loop {
        let job = {
            let mut queue = match vcs_scan_queue().lock() {
                Ok(q) => q,
                Err(e) => e.into_inner(),
            };
            queue.pending.pop_front()
        };
        let Some(job) = job else {
            std::thread::sleep(std::time::Duration::from_millis(120));
            continue;
        };
        if job.progress.cancelled.load(Ordering::Relaxed) {
            continue;
        }
        run_vcs_scan_job(job);
    }
}

fn run_vcs_scan_job(job: VcsScanJob) {
    let VcsScanJob {
        root_path,
        cache_key,
        progress,
    } = job;

    vcs_scan_emit(WorkspaceVcsScanProgress {
        root_path: root_path.clone(),
        phase: "scanning".to_string(),
        scanned_specs: 0,
        found_items: 0,
        truncated: false,
        message: None,
    });

    // Emit periodic progress while the (potentially long) scan runs.
    let ticker_progress = progress.clone();
    let ticker_root = root_path.clone();
    let ticker_done = Arc::new(AtomicBool::new(false));
    let ticker_flag = ticker_done.clone();
    let ticker = std::thread::spawn(move || {
        while !ticker_flag.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(400));
            if ticker_flag.load(Ordering::Relaxed) {
                break;
            }
            vcs_scan_emit(WorkspaceVcsScanProgress {
                root_path: ticker_root.clone(),
                phase: "scanning".to_string(),
                scanned_specs: ticker_progress.scanned_specs.load(Ordering::Relaxed),
                found_items: ticker_progress.found_items.load(Ordering::Relaxed),
                truncated: false,
                message: None,
            });
        }
    });

    let scan_progress = progress.clone();
    let scan_root = root_path.clone();
    let result = vcs_scan_with_progress(scan_progress, || workspace_vcs_status_blocking(scan_root));

    ticker_done.store(true, Ordering::Relaxed);
    let _ = ticker.join();

    // Clear ourselves from the active map only if we are still the current scan.
    {
        let mut queue = match vcs_scan_queue().lock() {
            Ok(q) => q,
            Err(e) => e.into_inner(),
        };
        if let Some(active) = queue.active_by_root.get(&root_path) {
            if Arc::ptr_eq(active, &progress) {
                queue.active_by_root.remove(&root_path);
            }
        }
    }

    if progress.cancelled.load(Ordering::Relaxed) {
        return;
    }

    match result {
        Ok(changes) => {
            let cache_file = workspace_vcs_status_cache_file(&root_path, &cache_key);
            let _ = write_json_cache(&cache_file, &changes);
            vcs_scan_emit(WorkspaceVcsScanProgress {
                root_path,
                phase: "done".to_string(),
                scanned_specs: progress.scanned_specs.load(Ordering::Relaxed),
                found_items: changes.files.len(),
                truncated: changes.truncated,
                message: None,
            });
        }
        Err(err) => {
            vcs_scan_emit(WorkspaceVcsScanProgress {
                root_path,
                phase: "error".to_string(),
                scanned_specs: progress.scanned_specs.load(Ordering::Relaxed),
                found_items: progress.found_items.load(Ordering::Relaxed),
                truncated: false,
                message: Some(err),
            });
        }
    }
}

fn workspace_vcs_status_cache_file(root_path: &str, cache_key: &str) -> PathBuf {
    let key = if cache_key.is_empty() {
        "default"
    } else {
        cache_key
    };
    storage_paths::managed_artifact_dir(Some(root_path), "session-changes").join(format!(
        "{}.vcsstatus.json",
        workspace_change_safe_cache_key(key)
    ))
}

fn mark_replacement_hunk(hunk: &mut [WorkspaceChangeLine]) {
    if hunk.is_empty() {
        return;
    }
    let has_added = hunk.iter().any(|line| line.kind == "added");
    let has_deleted = hunk.iter().any(|line| line.kind == "deleted");
    if has_added && has_deleted {
        for line in hunk.iter_mut() {
            if line.kind == "added" {
                line.kind = "replacedAdded".to_string();
            } else if line.kind == "deleted" {
                line.kind = "replacedDeleted".to_string();
            }
        }
    }
}

fn flush_change_hunk(out: &mut Vec<WorkspaceChangeLine>, hunk: &mut Vec<WorkspaceChangeLine>) {
    mark_replacement_hunk(hunk);
    out.append(hunk);
}

fn workspace_change_line_no(index: usize) -> u32 {
    (index + 1).min(u32::MAX as usize) as u32
}

fn workspace_change_known_binary_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "7z" | "a"
            | "app"
            | "avi"
            | "bin"
            | "blend"
            | "bmp"
            | "dll"
            | "dylib"
            | "exe"
            | "fbx"
            | "gif"
            | "glb"
            | "ico"
            | "jar"
            | "jpeg"
            | "jpg"
            | "lib"
            | "mov"
            | "mp3"
            | "mp4"
            | "obj"
            | "ogg"
            | "pak"
            | "pdb"
            | "png"
            | "psd"
            | "so"
            | "tga"
            | "uasset"
            | "umap"
            | "wav"
            | "webm"
            | "webp"
            | "zip"
    )
}

fn scan_workspace_snapshot(root: &Path) -> (Vec<WorkspaceChangeSnapshotFile>, bool) {
    scan_workspace_snapshot_with_text_budget(root, WORKSPACE_CHANGE_SNAPSHOT_TOTAL_TEXT_LIMIT)
}

fn scan_workspace_snapshot_with_text_budget(
    root: &Path,
    text_budget: usize,
) -> (Vec<WorkspaceChangeSnapshotFile>, bool) {
    let mut files = Vec::new();
    let mut truncated = false;
    let mut remaining_text_budget = text_budget;
    let mut stack = vec![(root.to_path_buf(), String::new())];

    while let Some((dir, relative_dir)) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&dir) else {
            truncated = true;
            continue;
        };
        let mut entries: Vec<_> = read_dir.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());

        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.is_empty() {
                continue;
            }
            let Ok(file_type) = entry.file_type() else {
                truncated = true;
                continue;
            };
            let relative_path = workspace_tree_child_relative(&relative_dir, &name);
            if file_type.is_dir() {
                if !workspace_tree_excluded_dir(&name) {
                    stack.push((entry.path(), relative_path));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Ok(metadata) = entry.metadata() else {
                truncated = true;
                continue;
            };
            let snapshot = snapshot_file_from_path(
                entry.path(),
                relative_path,
                &metadata,
                &mut remaining_text_budget,
            );
            if snapshot.truncated {
                truncated = true;
            }
            files.push(snapshot);
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    (files, truncated)
}

fn snapshot_file_from_path(
    path: PathBuf,
    relative_path: String,
    metadata: &std::fs::Metadata,
    remaining_text_budget: &mut usize,
) -> WorkspaceChangeSnapshotFile {
    let mut binary = workspace_change_known_binary_file(&path);
    let mut content = None;
    let mut truncated = false;
    let mut bytes = Vec::new();

    if !binary {
        let file_size = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if file_size > WORKSPACE_CHANGE_SNAPSHOT_TEXT_LIMIT || file_size > *remaining_text_budget {
            truncated = true;
        } else {
            match std::fs::File::open(&path) {
                Ok(mut handle) => {
                    let read_cap = WORKSPACE_CHANGE_SNAPSHOT_TEXT_LIMIT.min(*remaining_text_budget);
                    let read_limit = read_cap as u64 + 1;
                    if std::io::Read::by_ref(&mut handle)
                        .take(read_limit)
                        .read_to_end(&mut bytes)
                        .is_err()
                    {
                        truncated = true;
                    } else {
                        let charged = bytes.len().min(read_cap);
                        *remaining_text_budget = (*remaining_text_budget).saturating_sub(charged);
                        if bytes.len() > WORKSPACE_CHANGE_SNAPSHOT_TEXT_LIMIT
                            || bytes.len() > read_cap
                        {
                            bytes.truncate(read_cap);
                            truncated = true;
                        }
                        if probably_binary(&bytes) {
                            binary = true;
                        } else if truncated {
                            content = None;
                        } else {
                            content = decode_preview_text(bytes).or_else(|| {
                                binary = true;
                                None
                            });
                        }
                    }
                }
                Err(_) => truncated = true,
            }
        }
    }

    WorkspaceChangeSnapshotFile {
        path: relative_path.replace('\\', "/"),
        size_bytes: metadata.len(),
        modified_at_ms: workspace_tree_modified_at_ms(metadata),
        binary,
        truncated,
        content,
    }
}

fn lines_from_snapshot(content: &str, kind: &str, use_old_line: bool) -> Vec<WorkspaceChangeLine> {
    content
        .lines()
        .enumerate()
        .map(|(idx, line)| WorkspaceChangeLine {
            kind: kind.to_string(),
            old_line: use_old_line.then_some(workspace_change_line_no(idx)),
            new_line: (!use_old_line).then_some(workspace_change_line_no(idx)),
            content: line.to_string(),
        })
        .collect()
}

fn snapshot_file_to_change(
    file: &WorkspaceChangeSnapshotFile,
    status: &str,
) -> WorkspaceChangeFile {
    let use_old_line = status == "deleted";
    let kind = if use_old_line { "deleted" } else { "added" };
    WorkspaceChangeFile {
        path: file.path.clone(),
        old_path: None,
        status: status.to_string(),
        binary: file.binary,
        truncated: file.truncated,
        lines: file
            .content
            .as_deref()
            .map(|content| lines_from_snapshot(content, kind, use_old_line))
            .unwrap_or_default(),
    }
}

fn diff_text_lines(old_text: &str, new_text: &str) -> (Vec<WorkspaceChangeLine>, bool) {
    let old_lines: Vec<&str> = old_text.lines().collect();
    let new_lines: Vec<&str> = new_text.lines().collect();
    let mut prefix = 0_usize;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }

    let mut old_end = old_lines.len();
    let mut new_end = new_lines.len();
    while old_end > prefix && new_end > prefix && old_lines[old_end - 1] == new_lines[new_end - 1] {
        old_end -= 1;
        new_end -= 1;
    }

    let old_mid = &old_lines[prefix..old_end];
    let new_mid = &new_lines[prefix..new_end];
    let cells = (old_mid.len() + 1).saturating_mul(new_mid.len() + 1);
    let mut out = Vec::new();
    let mut hunk = Vec::new();

    if cells > WORKSPACE_CHANGE_DIFF_DP_CELL_LIMIT {
        for (idx, line) in old_mid.iter().enumerate() {
            hunk.push(WorkspaceChangeLine {
                kind: "deleted".to_string(),
                old_line: Some(workspace_change_line_no(prefix + idx)),
                new_line: None,
                content: (*line).to_string(),
            });
        }
        for (idx, line) in new_mid.iter().enumerate() {
            hunk.push(WorkspaceChangeLine {
                kind: "added".to_string(),
                old_line: None,
                new_line: Some(workspace_change_line_no(prefix + idx)),
                content: (*line).to_string(),
            });
        }
        flush_change_hunk(&mut out, &mut hunk);
        return (out, true);
    }

    let cols = new_mid.len() + 1;
    let mut dp = vec![0_u32; (old_mid.len() + 1) * cols];
    for i in (0..old_mid.len()).rev() {
        for j in (0..new_mid.len()).rev() {
            let idx = i * cols + j;
            dp[idx] = if old_mid[i] == new_mid[j] {
                dp[(i + 1) * cols + j + 1].saturating_add(1)
            } else {
                dp[(i + 1) * cols + j].max(dp[i * cols + j + 1])
            };
        }
    }

    let mut i = 0_usize;
    let mut j = 0_usize;
    while i < old_mid.len() && j < new_mid.len() {
        if old_mid[i] == new_mid[j] {
            flush_change_hunk(&mut out, &mut hunk);
            i += 1;
            j += 1;
        } else if dp[(i + 1) * cols + j] >= dp[i * cols + j + 1] {
            hunk.push(WorkspaceChangeLine {
                kind: "deleted".to_string(),
                old_line: Some(workspace_change_line_no(prefix + i)),
                new_line: None,
                content: old_mid[i].to_string(),
            });
            i += 1;
        } else {
            hunk.push(WorkspaceChangeLine {
                kind: "added".to_string(),
                old_line: None,
                new_line: Some(workspace_change_line_no(prefix + j)),
                content: new_mid[j].to_string(),
            });
            j += 1;
        }
    }
    while i < old_mid.len() {
        hunk.push(WorkspaceChangeLine {
            kind: "deleted".to_string(),
            old_line: Some(workspace_change_line_no(prefix + i)),
            new_line: None,
            content: old_mid[i].to_string(),
        });
        i += 1;
    }
    while j < new_mid.len() {
        hunk.push(WorkspaceChangeLine {
            kind: "added".to_string(),
            old_line: None,
            new_line: Some(workspace_change_line_no(prefix + j)),
            content: new_mid[j].to_string(),
        });
        j += 1;
    }
    flush_change_hunk(&mut out, &mut hunk);
    (out, false)
}

fn diff_snapshot_file(
    old: &WorkspaceChangeSnapshotFile,
    new: &WorkspaceChangeSnapshotFile,
) -> Option<WorkspaceChangeFile> {
    if old.size_bytes == new.size_bytes
        && old.modified_at_ms == new.modified_at_ms
        && old.content == new.content
        && old.binary == new.binary
    {
        return None;
    }

    let content_unavailable = old.content.is_none() || new.content.is_none();
    if old.binary || new.binary || content_unavailable {
        return Some(WorkspaceChangeFile {
            path: new.path.clone(),
            old_path: None,
            status: "modified".to_string(),
            binary: old.binary || new.binary,
            truncated: old.truncated || new.truncated || content_unavailable,
            lines: Vec::new(),
        });
    }

    let old_content = old.content.as_deref().unwrap_or_default();
    let new_content = new.content.as_deref().unwrap_or_default();
    if old_content == new_content {
        return None;
    }
    let (lines, diff_truncated) = diff_text_lines(old_content, new_content);
    Some(WorkspaceChangeFile {
        path: new.path.clone(),
        old_path: None,
        status: "modified".to_string(),
        binary: false,
        truncated: old.truncated || new.truncated || diff_truncated,
        lines,
    })
}

fn snapshot_modified_since(file: &WorkspaceChangeSnapshotFile, baseline_at_ms: u64) -> bool {
    file.modified_at_ms
        .map(|modified_at_ms| modified_at_ms >= baseline_at_ms)
        .unwrap_or(false)
}

fn snapshot_file_to_modified_marker(file: &WorkspaceChangeSnapshotFile) -> WorkspaceChangeFile {
    WorkspaceChangeFile {
        path: file.path.clone(),
        old_path: None,
        status: "modified".to_string(),
        binary: file.binary,
        truncated: true,
        lines: Vec::new(),
    }
}

fn truncate_workspace_changes(files: &mut Vec<WorkspaceChangeFile>) -> bool {
    let mut truncated = false;

    let mut total_lines = 0_usize;
    for file in files.iter_mut() {
        if file.lines.len() > WORKSPACE_CHANGE_LINE_LIMIT {
            file.lines.truncate(WORKSPACE_CHANGE_LINE_LIMIT);
            file.truncated = true;
            truncated = true;
        }

        if total_lines >= WORKSPACE_CHANGE_TOTAL_LINE_LIMIT {
            if !file.lines.is_empty() {
                file.lines.clear();
                file.truncated = true;
                truncated = true;
            }
            continue;
        }

        let remaining = WORKSPACE_CHANGE_TOTAL_LINE_LIMIT - total_lines;
        if file.lines.len() > remaining {
            file.lines.truncate(remaining);
            file.truncated = true;
            truncated = true;
        }
        total_lines += file.lines.len();
    }
    truncated
}

const WORKSPACE_STATUS_COMMAND_TIMEOUT_MS: u64 = 6_000;
const P4_STATUS_SPEC_BATCH_SIZE: usize = 6;
const P4_STATUS_MAX_SPEC_VISITS: usize = 2048;
const P4_STATUS_BATCH_PAUSE_MS: u64 = 15;
const P4_OBSERVER_STATUS_COMMANDS: &[&[&str]] = &[&["opened"], &["reconcile", "-n", "-ead"]];
const P4_WHERE_MAPPING_COMMANDS: &[&[&str]] =
    &[&["where", "..."], &["where", "*"], &["where", "."]];

struct WorkspaceStatusCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn workspace_status_temp_seq() -> u64 {
    static SEQ: OnceLock<Mutex<u64>> = OnceLock::new();
    let seq = SEQ.get_or_init(|| Mutex::new(0));
    let mut guard = seq.lock().unwrap_or_else(|e| e.into_inner());
    *guard = guard.saturating_add(1);
    *guard
}

fn read_workspace_status_temp(path: &Path) -> String {
    let bytes = std::fs::read(path).unwrap_or_default();
    String::from_utf8_lossy(&bytes).to_string()
}

fn run_workspace_status_command(
    root: &Path,
    program: &str,
    args: &[&str],
) -> Result<WorkspaceStatusCommandOutput, String> {
    run_workspace_status_command_with_timeout(
        root,
        program,
        args,
        std::time::Duration::from_millis(WORKSPACE_STATUS_COMMAND_TIMEOUT_MS),
    )
}

fn run_workspace_status_command_with_timeout(
    root: &Path,
    program: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<WorkspaceStatusCommandOutput, String> {
    let temp_id = format!(
        "ugs-status-{}-{}-{}",
        std::process::id(),
        now_ms(),
        workspace_status_temp_seq()
    );
    let stdout_path = std::env::temp_dir().join(format!("{temp_id}.stdout"));
    let stderr_path = std::env::temp_dir().join(format!("{temp_id}.stderr"));
    let stdout_file =
        std::fs::File::create(&stdout_path).map_err(|e| format!("创建状态输出缓存失败: {e}"))?;
    let stderr_file =
        std::fs::File::create(&stderr_path).map_err(|e| format!("创建状态错误缓存失败: {e}"))?;

    let mut cmd = new_spawn_command(program);
    cmd.current_dir(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file));

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            let _ = std::fs::remove_file(&stdout_path);
            let _ = std::fs::remove_file(&stderr_path);
            return Err(err.to_string());
        }
    };

    let start = std::time::Instant::now();
    let mut timed_out = false;
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => {
                timed_out = true;
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };

    let stdout = read_workspace_status_temp(&stdout_path);
    let stderr = read_workspace_status_temp(&stderr_path);
    let _ = std::fs::remove_file(stdout_path);
    let _ = std::fs::remove_file(stderr_path);

    Ok(WorkspaceStatusCommandOutput {
        success,
        stdout,
        stderr,
        timed_out,
    })
}

fn run_workspace_status_command_owned_with_timeout(
    root: &Path,
    program: &str,
    args: &[String],
    timeout: std::time::Duration,
) -> Result<WorkspaceStatusCommandOutput, String> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_workspace_status_command_with_timeout(root, program, &arg_refs, timeout)
}

fn workspace_status_error(output: &WorkspaceStatusCommandOutput) -> String {
    let message = output.stderr.trim();
    if message.is_empty() {
        "命令返回失败".to_string()
    } else {
        message.to_string()
    }
}

fn normalize_vcs_status_path(path: &str) -> String {
    path.trim()
        .trim_matches('"')
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn strip_git_workspace_prefix(path: &str, prefix: &str) -> String {
    let path = normalize_vcs_status_path(path);
    let prefix = normalize_vcs_status_path(prefix)
        .trim_end_matches('/')
        .to_string();
    if prefix.is_empty() {
        return path;
    }
    path.strip_prefix(&(prefix + "/"))
        .unwrap_or(path.as_str())
        .to_string()
}

#[allow(dead_code)]
fn workspace_change_relative_path(root: &Path, relative_path: &str) -> Option<PathBuf> {
    let normalized = normalize_vcs_status_path(relative_path);
    if normalized.is_empty() {
        return None;
    }

    let relative = PathBuf::from(&normalized);
    if relative.is_absolute() {
        return None;
    }
    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return None;
    }

    let candidate = root.join(relative);
    if let Ok(resolved) = std::fs::canonicalize(&candidate) {
        if !resolved.starts_with(root) {
            return None;
        }
        return Some(resolved);
    }
    Some(candidate)
}

fn relative_status_path_from_root(root: &Path, path: &str) -> String {
    let normalized = path.trim().trim_matches('"').replace('\\', "/");
    if normalized.starts_with("//") {
        return normalized
            .split('#')
            .next()
            .unwrap_or(&normalized)
            .to_string();
    }

    let candidate = PathBuf::from(path.trim().trim_matches('"'));
    if candidate.is_absolute() {
        if let Ok(relative) = candidate.strip_prefix(root) {
            return normalize_vcs_status_path(&relative.to_string_lossy());
        }
    }

    normalize_vcs_status_path(normalized.split('#').next().unwrap_or(normalized.as_str()))
}

#[derive(Clone, Debug)]
struct P4WhereMapping {
    depot_prefix: String,
    client_prefix: String,
    local_prefix: String,
}

fn sort_p4_where_mappings(mappings: &mut [P4WhereMapping]) {
    mappings.sort_by(|a, b| {
        let a_len = a
            .depot_prefix
            .len()
            .max(a.client_prefix.len())
            .max(a.local_prefix.len());
        let b_len = b
            .depot_prefix
            .len()
            .max(b.client_prefix.len())
            .max(b.local_prefix.len());
        b_len.cmp(&a_len)
    });
}

fn dedupe_sort_p4_where_mappings(mappings: &mut Vec<P4WhereMapping>) {
    let mut seen = HashSet::new();
    mappings.retain(|mapping| {
        seen.insert(format!(
            "{}\0{}\0{}",
            mapping.depot_prefix, mapping.client_prefix, mapping.local_prefix
        ))
    });
    sort_p4_where_mappings(mappings);
}

fn split_p4_where_line(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for ch in line.chars() {
        if ch == '"' {
            in_quotes = !in_quotes;
            continue;
        }
        if ch.is_whitespace() && !in_quotes {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn strip_p4_revision(path: &str) -> &str {
    path.split('#').next().unwrap_or(path)
}

fn normalize_p4_mapping_path(path: &str) -> String {
    strip_p4_revision(path.trim().trim_matches('"'))
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn p4_mapping_prefix(path: &str) -> String {
    let normalized = normalize_p4_mapping_path(path);
    ["/...", "/.", "/*"]
        .iter()
        .find_map(|suffix| normalized.strip_suffix(suffix).map(str::to_string))
        .unwrap_or(normalized)
        .trim_end_matches('/')
        .to_string()
}

fn parse_p4_where_mappings(root: &Path, stdout: &str) -> Vec<P4WhereMapping> {
    let mut mappings = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("... ") {
            continue;
        }
        let tokens = split_p4_where_line(trimmed);
        if tokens.len() < 3 {
            continue;
        }

        let depot_prefix = p4_mapping_prefix(&tokens[0]);
        let client_prefix = p4_mapping_prefix(&tokens[1]);
        let local_prefix = p4_mapping_prefix(&tokens[2..].join(" "));
        if depot_prefix.starts_with('-')
            || client_prefix.starts_with('-')
            || local_prefix.trim().is_empty()
        {
            continue;
        }

        mappings.push(P4WhereMapping {
            depot_prefix,
            client_prefix,
            local_prefix,
        });
    }

    if mappings.is_empty() {
        mappings.push(P4WhereMapping {
            depot_prefix: String::new(),
            client_prefix: String::new(),
            local_prefix: normalize_p4_mapping_path(&root.to_string_lossy()),
        });
    }

    dedupe_sort_p4_where_mappings(&mut mappings);
    mappings
}

fn p4_info_value(stdout: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    stdout.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix(&prefix)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn parse_p4_info_mapping(stdout: &str) -> Option<P4WhereMapping> {
    let local_root = p4_info_value(stdout, "Client root")?;
    if local_root.trim().is_empty() {
        return None;
    }

    let depot_prefix = p4_info_value(stdout, "Client stream")
        .map(|value| p4_mapping_prefix(&value))
        .unwrap_or_default();
    let client_prefix = p4_info_value(stdout, "Client name")
        .map(|value| format!("//{}", value.trim().trim_matches('/')))
        .map(|value| p4_mapping_prefix(&value))
        .unwrap_or_default();

    Some(P4WhereMapping {
        depot_prefix,
        client_prefix,
        local_prefix: p4_mapping_prefix(&local_root),
    })
}

fn strip_normalized_prefix(path: &str, prefix: &str, case_insensitive: bool) -> Option<String> {
    let path = path.trim_end_matches('/');
    let prefix = prefix.trim_end_matches('/');
    if prefix.is_empty() {
        return None;
    }

    let matches_exact = if case_insensitive {
        path.eq_ignore_ascii_case(prefix)
    } else {
        path == prefix
    };
    if matches_exact {
        return Some(String::new());
    }

    let prefix_with_slash = format!("{prefix}/");
    let matches_prefix = if case_insensitive {
        path.to_ascii_lowercase()
            .starts_with(&prefix_with_slash.to_ascii_lowercase())
    } else {
        path.starts_with(&prefix_with_slash)
    };
    if matches_prefix {
        return Some(path[prefix_with_slash.len()..].to_string());
    }

    None
}

fn local_status_path_from_root(root: &Path, path: &str) -> Option<String> {
    let normalized = normalize_p4_mapping_path(path);
    let root_text = normalize_p4_mapping_path(&root.to_string_lossy());
    if let Some(relative) = strip_normalized_prefix(&normalized, &root_text, cfg!(windows)) {
        return Some(normalize_vcs_status_path(&relative));
    }

    if let Ok(canonical_root) = std::fs::canonicalize(root) {
        let canonical_root_text = normalize_p4_mapping_path(&canonical_root.to_string_lossy());
        if let Some(relative) =
            strip_normalized_prefix(&normalized, &canonical_root_text, cfg!(windows))
        {
            return Some(normalize_vcs_status_path(&relative));
        }
    }

    None
}

fn p4_mapping_suffix_to_workspace_relative(
    root: &Path,
    local_prefix: &str,
    suffix: &str,
) -> Option<String> {
    let local = if suffix.trim().is_empty() {
        local_prefix.to_string()
    } else {
        format!("{}/{}", local_prefix.trim_end_matches('/'), suffix)
    };
    local_status_path_from_root(root, &local)
}

fn relative_p4_status_path_from_root(
    root: &Path,
    path: &str,
    mappings: &[P4WhereMapping],
) -> String {
    let normalized = normalize_p4_mapping_path(path);

    if normalized.starts_with("//") {
        for mapping in mappings {
            if let Some(suffix) = strip_normalized_prefix(&normalized, &mapping.depot_prefix, false)
            {
                if let Some(relative) =
                    p4_mapping_suffix_to_workspace_relative(root, &mapping.local_prefix, &suffix)
                {
                    return relative;
                }
            }
            if let Some(suffix) =
                strip_normalized_prefix(&normalized, &mapping.client_prefix, false)
            {
                if let Some(relative) =
                    p4_mapping_suffix_to_workspace_relative(root, &mapping.local_prefix, &suffix)
                {
                    return relative;
                }
            }
        }
        return normalized;
    }

    if let Some(relative) = local_status_path_from_root(root, &normalized) {
        return relative;
    }

    relative_status_path_from_root(root, &normalized)
}

fn workspace_change_file_from_status(
    path: String,
    old_path: Option<String>,
    status: &str,
) -> Option<WorkspaceChangeFile> {
    if path.trim().is_empty() {
        return None;
    }
    Some(WorkspaceChangeFile {
        path,
        old_path: old_path.filter(|value| !value.trim().is_empty()),
        status: status.to_string(),
        binary: false,
        truncated: true,
        lines: Vec::new(),
    })
}

fn workspace_status_from_git_xy(xy: &str) -> Option<&'static str> {
    if xy == "??" || xy.contains('A') {
        return Some("added");
    }
    if xy.contains('R') {
        return Some("renamed");
    }
    if xy.contains('D') {
        return Some("deleted");
    }
    if xy.contains('M') || xy.contains('T') || xy.contains('U') {
        return Some("modified");
    }
    None
}

fn parse_git_workspace_changes(stdout: &str, prefix: &str) -> Vec<WorkspaceChangeFile> {
    let parts: Vec<&str> = stdout.split('\0').filter(|part| !part.is_empty()).collect();
    let mut files = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let record = parts[index];
        if record.len() < 4 {
            index += 1;
            continue;
        }

        let xy = &record[..2];
        let Some(status) = workspace_status_from_git_xy(xy) else {
            index += 1;
            continue;
        };
        let path = strip_git_workspace_prefix(&record[3..], prefix);
        let mut old_path = None;
        if status == "renamed" {
            if let Some(next) = parts.get(index + 1) {
                old_path = Some(strip_git_workspace_prefix(next, prefix));
                index += 1;
            }
        }
        if let Some(file) = workspace_change_file_from_status(path, old_path, status) {
            files.push(file);
        }
        index += 1;
    }
    files
}

#[allow(dead_code)]
fn git_diff_path(path: &str, prefix: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed == "/dev/null" {
        return None;
    }
    let trimmed = trimmed.trim_matches('"');
    let trimmed = trimmed
        .strip_prefix("a/")
        .or_else(|| trimmed.strip_prefix("b/"))
        .unwrap_or(trimmed);
    Some(strip_git_workspace_prefix(trimmed, prefix))
}

#[allow(dead_code)]
fn parse_git_diff_header_paths(
    line: &str,
    prefix: &str,
) -> Option<(Option<String>, Option<String>)> {
    let rest = line.strip_prefix("diff --git ")?;
    let separator = rest.rfind(" b/")?;
    let old_path = git_diff_path(&rest[..separator], prefix);
    let new_path = git_diff_path(&rest[(separator + 1)..], prefix);
    Some((old_path, new_path))
}

#[allow(dead_code)]
fn parse_git_hunk_start(token: &str) -> Option<u32> {
    let range = token.get(1..)?;
    range.split(',').next()?.parse::<u32>().ok()
}

#[allow(dead_code)]
fn parse_git_hunk_header(line: &str) -> Option<(u32, u32)> {
    if !line.starts_with("@@ ") {
        return None;
    }

    let mut old_start = None;
    let mut new_start = None;
    for token in line.split_whitespace() {
        if token.starts_with('-') {
            old_start = parse_git_hunk_start(token);
        } else if token.starts_with('+') {
            new_start = parse_git_hunk_start(token);
        }
        if old_start.is_some() && new_start.is_some() {
            break;
        }
    }
    Some((old_start?, new_start?))
}

#[allow(dead_code)]
fn flush_git_diff_file(
    files: &mut Vec<WorkspaceChangeFile>,
    current: &mut Option<WorkspaceChangeFile>,
    hunk: &mut Vec<WorkspaceChangeLine>,
) {
    let Some(mut file) = current.take() else {
        return;
    };
    flush_change_hunk(&mut file.lines, hunk);
    if !file.path.trim().is_empty() {
        files.push(file);
    }
}

#[allow(dead_code)]
fn parse_git_diff_workspace_changes(stdout: &str, prefix: &str) -> Vec<WorkspaceChangeFile> {
    let mut files = Vec::new();
    let mut current: Option<WorkspaceChangeFile> = None;
    let mut hunk: Vec<WorkspaceChangeLine> = Vec::new();
    let mut old_line = 0_u32;
    let mut new_line = 0_u32;
    let mut in_hunk = false;

    for line in stdout.lines() {
        if line.starts_with("diff --git ") {
            flush_git_diff_file(&mut files, &mut current, &mut hunk);
            let (old_path, new_path) =
                parse_git_diff_header_paths(line, prefix).unwrap_or((None, None));
            current = Some(WorkspaceChangeFile {
                path: new_path
                    .clone()
                    .or_else(|| old_path.clone())
                    .unwrap_or_default(),
                old_path: None,
                status: "modified".to_string(),
                binary: false,
                truncated: false,
                lines: Vec::new(),
            });
            in_hunk = false;
            continue;
        }

        let Some(file) = current.as_mut() else {
            continue;
        };

        if line.starts_with("new file mode ") {
            file.status = "added".to_string();
            continue;
        }
        if line.starts_with("deleted file mode ") {
            file.status = "deleted".to_string();
            continue;
        }
        if let Some(path) = line.strip_prefix("rename from ") {
            if let Some(path) = git_diff_path(path, prefix) {
                file.old_path = Some(path);
                file.status = "renamed".to_string();
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("rename to ") {
            if let Some(path) = git_diff_path(path, prefix) {
                file.path = path;
                file.status = "renamed".to_string();
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("--- ") {
            if git_diff_path(path, prefix).is_none() {
                file.status = "added".to_string();
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("+++ ") {
            match git_diff_path(path, prefix) {
                Some(path) => file.path = path,
                None => file.status = "deleted".to_string(),
            }
            continue;
        }
        if line.starts_with("Binary files ") || line.starts_with("Binary file ") {
            file.binary = true;
            file.truncated = true;
            continue;
        }
        if let Some((old_start, new_start)) = parse_git_hunk_header(line) {
            flush_change_hunk(&mut file.lines, &mut hunk);
            old_line = old_start;
            new_line = new_start;
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        if line == r"\ No newline at end of file" {
            continue;
        }
        if let Some(content) = line.strip_prefix('+') {
            hunk.push(WorkspaceChangeLine {
                kind: "added".to_string(),
                old_line: None,
                new_line: Some(new_line),
                content: content.to_string(),
            });
            new_line = new_line.saturating_add(1);
        } else if let Some(content) = line.strip_prefix('-') {
            hunk.push(WorkspaceChangeLine {
                kind: "deleted".to_string(),
                old_line: Some(old_line),
                new_line: None,
                content: content.to_string(),
            });
            old_line = old_line.saturating_add(1);
        } else if line.starts_with(' ') {
            flush_change_hunk(&mut file.lines, &mut hunk);
            old_line = old_line.saturating_add(1);
            new_line = new_line.saturating_add(1);
        }
    }

    flush_git_diff_file(&mut files, &mut current, &mut hunk);
    files
}

#[allow(dead_code)]
fn workspace_change_file_from_current_path(
    root: &Path,
    file: &WorkspaceChangeFile,
) -> Option<WorkspaceChangeFile> {
    let path = workspace_change_relative_path(root, &file.path)?;
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut remaining_text_budget = WORKSPACE_CHANGE_SNAPSHOT_TEXT_LIMIT;
    let snapshot = snapshot_file_from_path(
        path,
        file.path.clone(),
        &metadata,
        &mut remaining_text_budget,
    );
    let mut change = snapshot_file_to_change(&snapshot, "added");
    change.status = file.status.clone();
    change.old_path = file.old_path.clone();
    Some(change)
}

#[allow(dead_code)]
fn merge_workspace_status_files_with_diff(
    root: &Path,
    status_files: Vec<WorkspaceChangeFile>,
    diff_files: Vec<WorkspaceChangeFile>,
) -> Vec<WorkspaceChangeFile> {
    let mut diff_by_path: HashMap<String, WorkspaceChangeFile> = HashMap::new();
    for file in diff_files {
        diff_by_path
            .entry(file.path.clone())
            .and_modify(|existing| {
                existing.lines.extend(file.lines.clone());
                existing.binary |= file.binary;
                existing.truncated |= file.truncated;
                if existing.old_path.is_none() {
                    existing.old_path = file.old_path.clone();
                }
                if existing.status == "modified" && file.status != "modified" {
                    existing.status = file.status.clone();
                }
            })
            .or_insert(file);
    }

    let mut merged = Vec::new();
    for file in status_files {
        if let Some(mut diff_file) = diff_by_path.remove(&file.path) {
            diff_file.status = file.status.clone();
            if file.old_path.is_some() {
                diff_file.old_path = file.old_path.clone();
            }
            merged.push(diff_file);
        } else if file.status == "added" && file.old_path.is_none() {
            merged.push(workspace_change_file_from_current_path(root, &file).unwrap_or(file));
        } else {
            merged.push(file);
        }
    }

    merged.extend(diff_by_path.into_values());
    merged
}

#[allow(dead_code)]
fn git_workspace_diff_changes(
    root: &Path,
    prefix: &str,
) -> Result<Vec<WorkspaceChangeFile>, String> {
    let head_diff = run_workspace_status_command(
        root,
        "git",
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=0",
            "HEAD",
            "--",
            ".",
        ],
    )
    .map_err(|err| format!("Git diff 读取失败: {err}"))?;
    if head_diff.timed_out {
        return Err("Git diff 读取超时".to_string());
    }
    if head_diff.success {
        return Ok(parse_git_diff_workspace_changes(&head_diff.stdout, prefix));
    }

    let mut files = Vec::new();
    let mut any_success = false;
    for args in [
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=0",
            "--",
            ".",
        ][..],
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--unified=0",
            "--",
            ".",
        ][..],
    ] {
        let output = run_workspace_status_command(root, "git", args)
            .map_err(|err| format!("Git diff 读取失败: {err}"))?;
        if output.timed_out {
            return Err("Git diff 读取超时".to_string());
        }
        if output.success {
            any_success = true;
            files.extend(parse_git_diff_workspace_changes(&output.stdout, prefix));
        }
    }

    if any_success {
        Ok(files)
    } else {
        Err(format!(
            "Git diff 读取失败: {}",
            workspace_status_error(&head_diff)
        ))
    }
}

fn workspace_change_file_matches_relative_path(
    file: &WorkspaceChangeFile,
    relative_path: &str,
) -> bool {
    let needle = normalize_vcs_status_path(relative_path);
    normalize_vcs_status_path(&file.path) == needle
        || file
            .old_path
            .as_deref()
            .map(|old_path| normalize_vcs_status_path(old_path) == needle)
            .unwrap_or(false)
}

fn filter_workspace_change_files_for_path(
    files: Vec<WorkspaceChangeFile>,
    relative_path: &str,
) -> Vec<WorkspaceChangeFile> {
    files
        .into_iter()
        .filter(|file| workspace_change_file_matches_relative_path(file, relative_path))
        .collect()
}

fn workspace_file_diff_relative_path(root: &Path, path: &str) -> Result<String, String> {
    let normalized = normalize_preview_separators(path.trim());
    if normalized.trim().is_empty() {
        return Err("缺少文件路径。".to_string());
    }

    if normalized.starts_with("//") {
        return Ok(normalize_p4_mapping_path(&normalized));
    }

    let candidate = PathBuf::from(&normalized);
    if candidate.is_absolute() {
        if let Some(relative) = local_status_path_from_root(root, &normalized) {
            return Ok(relative);
        }
        if let Ok(canonical) = std::fs::canonicalize(&candidate) {
            if let Some(relative) = local_status_path_from_root(root, &canonical.to_string_lossy())
            {
                return Ok(relative);
            }
        }
        return Err("文件不在工作区内。".to_string());
    }

    let relative = normalize_vcs_status_path(&normalized);
    if relative.is_empty() {
        return Err("缺少文件路径。".to_string());
    }
    let relative_path = PathBuf::from(&relative);
    if relative_path.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err("文件不在工作区内。".to_string());
    }
    Ok(relative)
}

fn workspace_single_change_from_status_and_diff(
    root: &Path,
    status_files: Vec<WorkspaceChangeFile>,
    diff_files: Vec<WorkspaceChangeFile>,
    relative_path: &str,
) -> Option<WorkspaceChangeFile> {
    let status_files = filter_workspace_change_files_for_path(status_files, relative_path);
    let diff_files = filter_workspace_change_files_for_path(diff_files, relative_path);
    let mut files = merge_workspace_status_files_with_diff(root, status_files, diff_files);
    files.retain(|file| workspace_change_file_matches_relative_path(file, relative_path));
    if files.is_empty() {
        return None;
    }

    files.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then_with(|| a.old_path.cmp(&b.old_path))
    });
    let mut file = files.remove(0);
    if file.status == "added" && file.lines.is_empty() {
        if let Some(filled) = workspace_change_file_from_current_path(root, &file) {
            file = filled;
        }
    }
    Some(file)
}

fn parse_unified_workspace_diff_lines(stdout: &str) -> (Vec<WorkspaceChangeLine>, bool) {
    let mut out = Vec::new();
    let mut hunk = Vec::new();
    let mut old_line = 0_u32;
    let mut new_line = 0_u32;
    let mut in_hunk = false;
    let mut binary = false;

    for line in stdout.lines() {
        if line.starts_with("Binary files ")
            || line.starts_with("Binary file ")
            || line.contains("Cannot display: file marked as a binary type")
        {
            binary = true;
            continue;
        }
        if let Some((old_start, new_start)) = parse_git_hunk_header(line) {
            flush_change_hunk(&mut out, &mut hunk);
            old_line = old_start;
            new_line = new_start;
            in_hunk = true;
            continue;
        }
        if !in_hunk {
            continue;
        }
        if line == r"\ No newline at end of file" {
            continue;
        }
        if let Some(content) = line.strip_prefix('+') {
            hunk.push(WorkspaceChangeLine {
                kind: "added".to_string(),
                old_line: None,
                new_line: Some(new_line),
                content: content.to_string(),
            });
            new_line = new_line.saturating_add(1);
        } else if let Some(content) = line.strip_prefix('-') {
            hunk.push(WorkspaceChangeLine {
                kind: "deleted".to_string(),
                old_line: Some(old_line),
                new_line: None,
                content: content.to_string(),
            });
            old_line = old_line.saturating_add(1);
        } else if line.starts_with(' ') {
            flush_change_hunk(&mut out, &mut hunk);
            old_line = old_line.saturating_add(1);
            new_line = new_line.saturating_add(1);
        }
    }

    flush_change_hunk(&mut out, &mut hunk);
    (out, binary)
}

fn workspace_change_file_from_unified_diff(
    path: &str,
    status: &str,
    stdout: &str,
) -> Option<WorkspaceChangeFile> {
    if stdout.trim().is_empty() {
        return None;
    }
    let (lines, binary) = parse_unified_workspace_diff_lines(stdout);
    Some(WorkspaceChangeFile {
        path: normalize_vcs_status_path(path),
        old_path: None,
        status: status.to_string(),
        binary,
        truncated: binary,
        lines,
    })
}

fn git_workspace_file_diff_changes(
    root: &Path,
    prefix: &str,
    relative_path: &str,
) -> Result<Vec<WorkspaceChangeFile>, String> {
    let head_args = vec![
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=0",
        "HEAD",
        "--",
        relative_path,
    ];
    let head_diff = run_workspace_status_command(root, "git", &head_args)
        .map_err(|err| format!("Git diff 读取失败: {err}"))?;
    if head_diff.timed_out {
        return Err("Git diff 读取超时".to_string());
    }
    if head_diff.success {
        return Ok(parse_git_diff_workspace_changes(&head_diff.stdout, prefix));
    }

    let mut files = Vec::new();
    let mut any_success = false;
    let arg_sets = [
        vec![
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--unified=0",
            "--",
            relative_path,
        ],
        vec![
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            "--unified=0",
            "--",
            relative_path,
        ],
    ];
    for args in arg_sets {
        let output = run_workspace_status_command(root, "git", &args)
            .map_err(|err| format!("Git diff 读取失败: {err}"))?;
        if output.timed_out {
            return Err("Git diff 读取超时".to_string());
        }
        if output.success {
            any_success = true;
            files.extend(parse_git_diff_workspace_changes(&output.stdout, prefix));
        }
    }

    if any_success {
        Ok(files)
    } else {
        Err(format!(
            "Git diff 读取失败: {}",
            workspace_status_error(&head_diff)
        ))
    }
}

fn git_workspace_file_change(
    root: &Path,
    relative_path: &str,
) -> Option<Result<Option<WorkspaceChangeFile>, String>> {
    let probe =
        match run_workspace_status_command(root, "git", &["rev-parse", "--is-inside-work-tree"]) {
            Ok(output) => output,
            Err(_) => return None,
        };
    if probe.timed_out {
        return Some(Err("Git 状态收集超时".to_string()));
    }
    if !probe.success || probe.stdout.trim() != "true" {
        return None;
    }

    let prefix = match run_workspace_status_command(root, "git", &["rev-parse", "--show-prefix"]) {
        Ok(output) if output.timed_out => return Some(Err("Git 工作区前缀读取超时".to_string())),
        Ok(output) if output.success => output.stdout.trim().to_string(),
        _ => String::new(),
    };
    let status_args = vec![
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        relative_path,
    ];
    let status = match run_workspace_status_command(root, "git", &status_args) {
        Ok(output) => output,
        Err(err) => return Some(Err(format!("Git 状态读取失败: {err}"))),
    };
    if status.timed_out {
        return Some(Err("Git 状态收集超时".to_string()));
    }
    if !status.success {
        return Some(Err(format!(
            "Git 状态读取失败: {}",
            workspace_status_error(&status)
        )));
    }

    let status_files = parse_git_workspace_changes(&status.stdout, &prefix);
    let diff_files =
        git_workspace_file_diff_changes(root, &prefix, relative_path).unwrap_or_default();
    Some(Ok(workspace_single_change_from_status_and_diff(
        root,
        status_files,
        diff_files,
        relative_path,
    )))
}

fn svn_workspace_file_change(
    root: &Path,
    relative_path: &str,
) -> Option<Result<Option<WorkspaceChangeFile>, String>> {
    let probe = match run_workspace_status_command(root, "svn", &["info"]) {
        Ok(output) => output,
        Err(_) => return None,
    };
    if probe.timed_out {
        return Some(Err("SVN 状态收集超时".to_string()));
    }
    if !probe.success {
        return None;
    }

    let status_args = vec!["status", "--ignore-externals", "--", relative_path];
    let status = match run_workspace_status_command(root, "svn", &status_args) {
        Ok(output) => output,
        Err(err) => return Some(Err(format!("SVN 状态读取失败: {err}"))),
    };
    if status.timed_out {
        return Some(Err("SVN 状态收集超时".to_string()));
    }
    if !status.success {
        return Some(Err(format!(
            "SVN 状态读取失败: {}",
            workspace_status_error(&status)
        )));
    }

    let status_files = parse_svn_workspace_changes(&status.stdout);
    let status_for_diff = status_files
        .iter()
        .find(|file| workspace_change_file_matches_relative_path(file, relative_path))
        .map(|file| file.status.as_str())
        .unwrap_or("modified");
    let diff_args = vec!["diff", "--internal-diff", "-x", "-U0", "--", relative_path];
    let diff_files = match run_workspace_status_command(root, "svn", &diff_args) {
        Ok(output) if output.timed_out => return Some(Err("SVN diff 读取超时".to_string())),
        Ok(output) => {
            workspace_change_file_from_unified_diff(relative_path, status_for_diff, &output.stdout)
                .into_iter()
                .collect()
        }
        Err(_) => Vec::new(),
    };

    Some(Ok(workspace_single_change_from_status_and_diff(
        root,
        status_files,
        diff_files,
        relative_path,
    )))
}

fn p4_workspace_file_change(
    root: &Path,
    relative_path: &str,
) -> Option<Result<Option<WorkspaceChangeFile>, String>> {
    let status_changes = match p4_workspace_changes_for_specs(
        root,
        vec![p4_normalize_file_spec(relative_path)],
        "file",
    )? {
        Ok(changes) => changes,
        Err(err) => return Some(Err(err)),
    };
    let status_files = status_changes.files;
    let status_for_diff = status_files
        .iter()
        .find(|file| workspace_change_file_matches_relative_path(file, relative_path))
        .map(|file| file.status.as_str())
        .unwrap_or("modified");
    let diff_args = p4_file_diff_args(relative_path);
    let diff_files = match run_workspace_status_command_owned_with_timeout(
        root,
        "p4",
        &diff_args,
        p4_status_command_timeout(),
    ) {
        Ok(output) if output.timed_out => return Some(Err("P4 diff 读取超时".to_string())),
        Ok(output) => {
            workspace_change_file_from_unified_diff(relative_path, status_for_diff, &output.stdout)
                .into_iter()
                .collect()
        }
        Err(_) => Vec::new(),
    };

    Some(Ok(workspace_single_change_from_status_and_diff(
        root,
        status_files,
        diff_files,
        relative_path,
    )))
}

fn p4_file_diff_args(relative_path: &str) -> Vec<String> {
    vec![
        "diff".to_string(),
        "-f".to_string(),
        "-du0".to_string(),
        relative_path.to_string(),
    ]
}

fn vcs_workspace_file_change(
    root: &Path,
    relative_path: &str,
) -> Result<Option<WorkspaceChangeFile>, String> {
    if let Some(result) = git_workspace_file_change(root, relative_path) {
        return result;
    }
    if let Some(result) = svn_workspace_file_change(root, relative_path) {
        return result;
    }
    if let Some(result) = p4_workspace_file_change(root, relative_path) {
        return result;
    }
    Ok(None)
}

fn workspace_file_diff_blocking(
    root_path: String,
    path: String,
) -> Result<Option<WorkspaceChangeFile>, String> {
    let (root, _) = workspace_tree_resolve_dir(&root_path, "")?;
    let relative_path = workspace_file_diff_relative_path(&root, &path)?;
    vcs_workspace_file_change(&root, &relative_path)
}

fn parse_svn_workspace_changes(stdout: &str) -> Vec<WorkspaceChangeFile> {
    let mut files = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('>') {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let first = chars.first().copied().unwrap_or(' ');
        let second = chars.get(1).copied().unwrap_or(' ');
        let status = match first {
            '?' | 'A' => Some("added"),
            '!' | 'D' => Some("deleted"),
            'R' => Some("renamed"),
            'M' | '~' | 'C' => Some("modified"),
            ' ' if second == 'M' => Some("modified"),
            _ => None,
        };
        let Some(status) = status else {
            continue;
        };
        let path = if line.len() > 8 {
            &line[8..]
        } else {
            trimmed.split_whitespace().last().unwrap_or_default()
        };
        if let Some(file) =
            workspace_change_file_from_status(normalize_vcs_status_path(path), None, status)
        {
            files.push(file);
        }
    }
    files
}

fn parse_p4_workspace_changes(
    root: &Path,
    stdout: &str,
    mappings: &[P4WhereMapping],
) -> Vec<WorkspaceChangeFile> {
    let mut files = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("... ") {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        let status = if lower.contains("move/add") || lower.contains("move/delete") {
            Some("renamed")
        } else if lower.contains("reconcile to add")
            || lower.contains("opened for add")
            || lower.contains(" - add")
        {
            Some("added")
        } else if lower.contains("reconcile to delete")
            || lower.contains("opened for delete")
            || lower.contains(" - delete")
            || lower.contains("missing")
        {
            Some("deleted")
        } else if lower.contains("reconcile to edit")
            || lower.contains("opened for edit")
            || lower.contains(" - edit")
            || lower.contains("changed")
        {
            Some("modified")
        } else {
            None
        };
        let Some(status) = status else {
            continue;
        };

        let path_text = trimmed
            .split_once(" - ")
            .map(|(path, _)| path)
            .unwrap_or(trimmed);
        let path = relative_p4_status_path_from_root(root, path_text, mappings);
        if let Some(file) = workspace_change_file_from_status(path, None, status) {
            files.push(file);
        }
    }
    files
}

struct P4CommandScan {
    files: Vec<WorkspaceChangeFile>,
    truncated: bool,
}

fn p4_normalize_file_spec(path: &str) -> String {
    normalize_vcs_status_path(path)
        .trim_end_matches('/')
        .to_string()
}

fn p4_child_specs_for_dir(root: &Path, relative_dir: &str) -> Vec<String> {
    let normalized_dir = p4_normalize_file_spec(relative_dir);
    let dir = if normalized_dir.is_empty() {
        root.to_path_buf()
    } else {
        root.join(normalized_dir.replace('/', std::path::MAIN_SEPARATOR_STR))
    };

    let mut specs = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return specs,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.trim().is_empty() {
            continue;
        }
        let relative = if normalized_dir.is_empty() {
            p4_normalize_file_spec(&name)
        } else {
            p4_normalize_file_spec(&format!("{normalized_dir}/{name}"))
        };
        if relative.is_empty() {
            continue;
        }

        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            specs.push(format!("{relative}/..."));
        } else if file_type.is_file() {
            specs.push(relative);
        }
    }

    specs.sort();
    specs
}

fn p4_workspace_status_specs(root: &Path) -> Vec<String> {
    let mut dir_specs = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return vec!["...".to_string()],
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.trim().is_empty() {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            dir_specs.push(format!("{}/...", p4_normalize_file_spec(&name)));
        }
    }

    dir_specs.sort();
    let mut specs = vec!["*".to_string()];
    specs.extend(dir_specs);
    specs
}

fn p4_workspace_root_status_specs() -> Vec<String> {
    vec!["*".to_string()]
}

fn p4_child_specs_for_timed_out_spec(root: &Path, spec: &str) -> Vec<String> {
    let normalized = p4_normalize_file_spec(spec);
    if normalized == "..." {
        return p4_child_specs_for_dir(root, "");
    }
    let Some(dir) = normalized.strip_suffix("/...") else {
        return Vec::new();
    };
    p4_child_specs_for_dir(root, dir)
}

fn p4_status_args(base_args: &[&str], specs: &[String]) -> Vec<String> {
    base_args
        .iter()
        .map(|arg| (*arg).to_string())
        .chain(specs.iter().cloned())
        .collect()
}

fn p4_error_is_outside_client(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("not under client's root") || lower.contains("file(s) not in client view")
}

fn p4_error_is_empty_result(command: &str, stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("file(s) not opened")
        || lower.contains("not opened on this client")
        || lower.contains("no file(s) to reconcile")
        || command == "status"
}

fn p4_push_spec_batches(queue: &mut VecDeque<Vec<String>>, specs: Vec<String>) {
    for chunk in specs.chunks(P4_STATUS_SPEC_BATCH_SIZE) {
        queue.push_back(chunk.to_vec());
    }
}

/// Per-command timeout for a single P4 status invocation.
///
/// Intentionally has no total scan budget: large projects (e.g. MoonEngine) can
/// take a long time to fully scan, and truncating at a fixed wall-clock budget
/// would hide real changes behind a default icon. Instead we keep a per-command
/// timeout so a single hung `p4` call can't stall the whole pass, and any
/// timed-out spec is split into child directories and retried until the scan
/// completes naturally.
fn p4_status_command_timeout() -> std::time::Duration {
    std::time::Duration::from_millis(WORKSPACE_STATUS_COMMAND_TIMEOUT_MS)
}

fn p4_split_or_mark_truncated(
    root: &Path,
    queue: &mut VecDeque<Vec<String>>,
    specs: Vec<String>,
) -> bool {
    if specs.len() > 1 {
        for spec in specs {
            queue.push_back(vec![spec]);
        }
        return false;
    }

    let Some(spec) = specs.first() else {
        return false;
    };
    let children = p4_child_specs_for_timed_out_spec(root, spec);
    if children.is_empty() {
        true
    } else {
        p4_push_spec_batches(queue, children);
        false
    }
}

fn p4_collect_command_changes(
    root: &Path,
    base_args: &[&str],
    initial_specs: &[String],
    mappings: &[P4WhereMapping],
) -> Result<P4CommandScan, String> {
    let command = base_args.first().copied().unwrap_or_default();
    let mut files = Vec::new();
    let mut truncated = false;
    let mut spec_visits = 0_usize;
    let mut queue: VecDeque<Vec<String>> = VecDeque::new();
    p4_push_spec_batches(&mut queue, initial_specs.to_vec());

    while let Some(specs) = queue.pop_front() {
        if specs.is_empty() {
            continue;
        }
        if vcs_scan_is_cancelled() {
            truncated = true;
            break;
        }
        if spec_visits >= P4_STATUS_MAX_SPEC_VISITS {
            truncated = true;
            break;
        }
        spec_visits = spec_visits.saturating_add(specs.len());

        let args = p4_status_args(base_args, &specs);
        let command_timeout = p4_status_command_timeout();
        let output = match run_workspace_status_command_owned_with_timeout(
            root,
            "p4",
            &args,
            command_timeout,
        ) {
            Ok(output) => output,
            Err(err) => return Err(format!("P4 状态读取失败: {err}")),
        };

        if output.timed_out {
            // No total budget: keep splitting the timed-out spec into child
            // directories and retry until it scans cleanly or has no children.
            truncated |= p4_split_or_mark_truncated(root, &mut queue, specs);
            continue;
        }

        if !output.success {
            if p4_error_is_outside_client(&output.stderr) {
                if specs.len() > 1 {
                    for spec in specs {
                        queue.push_back(vec![spec]);
                    }
                }
                continue;
            }
            if p4_error_is_empty_result(command, &output.stderr) {
                continue;
            }
            if !files.is_empty() {
                truncated = true;
                continue;
            }
            return Err(format!(
                "P4 状态读取失败: {}",
                workspace_status_error(&output)
            ));
        }

        let parsed = parse_p4_workspace_changes(root, &output.stdout, mappings);
        vcs_scan_progress_advance(specs.len(), parsed.len());
        files.extend(parsed);
        if P4_STATUS_BATCH_PAUSE_MS > 0 && !queue.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(P4_STATUS_BATCH_PAUSE_MS));
        }
    }

    Ok(P4CommandScan { files, truncated })
}

fn p4_workspace_where_mappings(
    root: &Path,
    info_stdout: &str,
) -> Result<Option<Vec<P4WhereMapping>>, String> {
    let mut info_mappings = parse_p4_info_mapping(info_stdout)
        .into_iter()
        .collect::<Vec<_>>();
    let mut saw_outside_client = false;
    let mut saw_non_outside_failure = false;
    let mut last_error = None;

    for args in P4_WHERE_MAPPING_COMMANDS {
        let output = match run_workspace_status_command(root, "p4", args) {
            Ok(output) => output,
            Err(err) => {
                saw_non_outside_failure = true;
                last_error = Some(format!("P4 工作区映射检查失败: {err}"));
                continue;
            }
        };
        if output.timed_out {
            saw_non_outside_failure = true;
            last_error = Some("P4 工作区映射检查超时".to_string());
            continue;
        }
        if output.success {
            let mut mappings = parse_p4_where_mappings(root, &output.stdout);
            mappings.append(&mut info_mappings);
            dedupe_sort_p4_where_mappings(&mut mappings);
            return Ok(Some(mappings));
        }
        if p4_error_is_outside_client(&output.stderr) {
            saw_outside_client = true;
            continue;
        }
        saw_non_outside_failure = true;
        last_error = Some(format!(
            "P4 工作区映射检查失败: {}",
            workspace_status_error(&output)
        ));
    }

    if saw_outside_client && !saw_non_outside_failure {
        return Ok(None);
    }
    if !info_mappings.is_empty() {
        dedupe_sort_p4_where_mappings(&mut info_mappings);
        return Ok(Some(info_mappings));
    }
    if let Some(err) = last_error {
        return Err(err);
    }
    Ok(Some(parse_p4_where_mappings(root, "")))
}

fn dedupe_workspace_status_files(files: Vec<WorkspaceChangeFile>) -> Vec<WorkspaceChangeFile> {
    let mut by_key: HashMap<String, WorkspaceChangeFile> = HashMap::new();
    for file in files {
        let key = format!(
            "{}\0{}",
            file.old_path.as_deref().unwrap_or_default(),
            file.path
        );
        by_key.entry(key).or_insert(file);
    }
    let mut out: Vec<_> = by_key.into_values().collect();
    out.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then_with(|| a.old_path.cmp(&b.old_path))
    });
    out
}

fn workspace_changes_from_status_files(
    root: &Path,
    source: &str,
    files: Vec<WorkspaceChangeFile>,
    source_truncated: bool,
    scan_scope: &str,
) -> WorkspaceChanges {
    let mut files = dedupe_workspace_status_files(files);
    let truncated = truncate_workspace_changes(&mut files);
    WorkspaceChanges {
        root_path: display_preview_path(root),
        generated_at_ms: now_ms(),
        source: source.to_string(),
        files,
        truncated: truncated || source_truncated,
        scan_scope: Some(scan_scope.to_string()),
    }
}

fn workspace_status_path_is_root_child(path: &str) -> bool {
    let normalized = normalize_vcs_status_path(path);
    !normalized.is_empty() && !normalized.contains('/')
}

fn workspace_status_file_touches_root(file: &WorkspaceChangeFile) -> bool {
    workspace_status_path_is_root_child(&file.path)
        || file
            .old_path
            .as_deref()
            .map(workspace_status_path_is_root_child)
            .unwrap_or(false)
}

fn root_workspace_status_files(files: Vec<WorkspaceChangeFile>) -> Vec<WorkspaceChangeFile> {
    files
        .into_iter()
        .filter(workspace_status_file_touches_root)
        .collect()
}

fn git_workspace_status_files(
    root: &Path,
) -> Option<Result<(String, Vec<WorkspaceChangeFile>), String>> {
    let probe =
        match run_workspace_status_command(root, "git", &["rev-parse", "--is-inside-work-tree"]) {
            Ok(output) => output,
            Err(_) => return None,
        };
    if probe.timed_out {
        return Some(Err("Git 状态收集超时".to_string()));
    }
    if !probe.success || probe.stdout.trim() != "true" {
        return None;
    }

    let prefix = match run_workspace_status_command(root, "git", &["rev-parse", "--show-prefix"]) {
        Ok(output) if output.timed_out => return Some(Err("Git 工作区前缀读取超时".to_string())),
        Ok(output) if output.success => output.stdout.trim().to_string(),
        _ => String::new(),
    };
    let status = match run_workspace_status_command(
        root,
        "git",
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--",
            ".",
        ],
    ) {
        Ok(output) => output,
        Err(err) => return Some(Err(format!("Git 状态读取失败: {err}"))),
    };
    if status.timed_out {
        return Some(Err("Git 状态收集超时".to_string()));
    }
    if !status.success {
        return Some(Err(format!(
            "Git 状态读取失败: {}",
            workspace_status_error(&status)
        )));
    }

    Some(Ok((
        prefix.clone(),
        parse_git_workspace_changes(&status.stdout, &prefix),
    )))
}

fn git_workspace_vcs_status(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    let (_, files) = match git_workspace_status_files(root)? {
        Ok(result) => result,
        Err(err) => return Some(Err(err)),
    };
    Some(Ok(workspace_changes_from_status_files(
        root, "git", files, false, "full",
    )))
}

fn git_workspace_vcs_status_shallow(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    let (_, files) = match git_workspace_status_files(root)? {
        Ok(result) => result,
        Err(err) => return Some(Err(err)),
    };
    Some(Ok(workspace_changes_from_status_files(
        root,
        "git",
        root_workspace_status_files(files),
        false,
        "root",
    )))
}

#[allow(dead_code)]
fn git_workspace_changes(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    let (prefix, status_files) = match git_workspace_status_files(root)? {
        Ok(result) => result,
        Err(err) => return Some(Err(err)),
    };
    let (diff_files, diff_truncated) = match git_workspace_diff_changes(root, &prefix) {
        Ok(files) => (files, false),
        Err(_) => (Vec::new(), true),
    };
    let files = merge_workspace_status_files_with_diff(root, status_files, diff_files);
    Some(Ok(workspace_changes_from_status_files(
        root,
        "git",
        files,
        diff_truncated,
        "full",
    )))
}

fn svn_workspace_changes(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    let probe = match run_workspace_status_command(root, "svn", &["info"]) {
        Ok(output) => output,
        Err(_) => return None,
    };
    if probe.timed_out {
        return Some(Err("SVN 状态收集超时".to_string()));
    }
    if !probe.success {
        return None;
    }

    let status = match run_workspace_status_command(root, "svn", &["status", "--ignore-externals"])
    {
        Ok(output) => output,
        Err(err) => return Some(Err(format!("SVN 状态读取失败: {err}"))),
    };
    if status.timed_out {
        return Some(Err("SVN 状态收集超时".to_string()));
    }
    if !status.success {
        return Some(Err(format!(
            "SVN 状态读取失败: {}",
            workspace_status_error(&status)
        )));
    }

    let files = parse_svn_workspace_changes(&status.stdout);
    Some(Ok(workspace_changes_from_status_files(
        root, "svn", files, false, "full",
    )))
}

fn svn_workspace_changes_shallow(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    let mut changes = match svn_workspace_changes(root)? {
        Ok(changes) => changes,
        Err(err) => return Some(Err(err)),
    };
    changes.files = root_workspace_status_files(changes.files);
    changes.generated_at_ms = now_ms();
    changes.scan_scope = Some("root".to_string());
    Some(Ok(changes))
}

fn p4_workspace_changes_for_specs(
    root: &Path,
    specs: Vec<String>,
    scan_scope: &str,
) -> Option<Result<WorkspaceChanges, String>> {
    let probe = match run_workspace_status_command(root, "p4", &["info"]) {
        Ok(output) => output,
        Err(_) => return None,
    };
    if probe.timed_out {
        return Some(Err("P4 状态收集超时".to_string()));
    }
    if !probe.success {
        return None;
    }

    let mut files = Vec::new();
    let mut truncated = false;

    let mappings = match p4_workspace_where_mappings(root, &probe.stdout) {
        Ok(Some(mappings)) => mappings,
        Ok(None) => return None,
        Err(err) => return Some(Err(err)),
    };

    // Observer mode: read pending state and preview reconcile only. Never opens files.
    for args in P4_OBSERVER_STATUS_COMMANDS {
        match p4_collect_command_changes(root, args, &specs, &mappings) {
            Ok(scan) => {
                files.extend(scan.files);
                truncated |= scan.truncated;
            }
            Err(err) => {
                if files.is_empty() {
                    return Some(Err(err));
                }
                truncated = true;
            }
        }
    }

    Some(Ok(workspace_changes_from_status_files(
        root, "p4", files, truncated, scan_scope,
    )))
}

fn p4_workspace_changes(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    p4_workspace_changes_for_specs(root, p4_workspace_status_specs(root), "full")
}

fn p4_workspace_changes_shallow(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    p4_workspace_changes_for_specs(root, p4_workspace_root_status_specs(), "root")
}

#[allow(dead_code)]
fn vcs_workspace_changes(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    git_workspace_changes(root)
        .or_else(|| svn_workspace_changes(root))
        .or_else(|| p4_workspace_changes(root))
}

fn vcs_workspace_status(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    git_workspace_vcs_status(root)
        .or_else(|| svn_workspace_changes(root))
        .or_else(|| p4_workspace_changes(root))
}

fn vcs_workspace_status_shallow(root: &Path) -> Option<Result<WorkspaceChanges, String>> {
    git_workspace_vcs_status_shallow(root)
        .or_else(|| svn_workspace_changes_shallow(root))
        .or_else(|| p4_workspace_changes_shallow(root))
}

fn workspace_vcs_status_blocking(root_path: String) -> Result<WorkspaceChanges, String> {
    let (root, _) = workspace_tree_resolve_dir(&root_path, "")?;
    if let Some(status) = vcs_workspace_status(&root) {
        return status;
    }

    Ok(WorkspaceChanges {
        root_path: display_preview_path(&root),
        generated_at_ms: now_ms(),
        source: "none".to_string(),
        files: Vec::new(),
        truncated: false,
        scan_scope: Some("full".to_string()),
    })
}

fn workspace_vcs_status_shallow_blocking(root_path: String) -> Result<WorkspaceChanges, String> {
    let (root, _) = workspace_tree_resolve_dir(&root_path, "")?;
    if let Some(status) = vcs_workspace_status_shallow(&root) {
        return status;
    }

    Ok(WorkspaceChanges {
        root_path: display_preview_path(&root),
        generated_at_ms: now_ms(),
        source: "none".to_string(),
        files: Vec::new(),
        truncated: false,
        scan_scope: Some("root".to_string()),
    })
}

fn workspace_changes_baseline_blocking(
    root_path: String,
    cache_key: String,
    baseline_at_ms: Option<u64>,
) -> Result<WorkspaceChangeBaseline, String> {
    let (root, _) = workspace_tree_resolve_dir(&root_path, "")?;
    let cache_file = workspace_change_cache_file(&root, &cache_key, "baseline");
    let root_label = display_preview_path(&root);
    if let Some(mut cached) = read_json_cache::<WorkspaceChangeBaseline>(&cache_file) {
        if cached.root_path == root_label {
            if let Some(baseline_at_ms) = baseline_at_ms {
                if baseline_at_ms < cached.generated_at_ms {
                    cached.generated_at_ms = baseline_at_ms;
                    let _ = write_json_cache(&cache_file, &cached);
                }
            }
            return Ok(cached);
        }
    }

    let (files, truncated) = scan_workspace_snapshot(&root);
    let baseline = WorkspaceChangeBaseline {
        root_path: root_label,
        generated_at_ms: baseline_at_ms.unwrap_or_else(now_ms),
        files,
        truncated,
    };
    write_json_cache(&cache_file, &baseline)?;
    Ok(baseline)
}

fn workspace_change_baseline_summary(
    baseline: WorkspaceChangeBaseline,
) -> WorkspaceChangeBaselineSummary {
    WorkspaceChangeBaselineSummary {
        root_path: baseline.root_path,
        generated_at_ms: baseline.generated_at_ms,
        file_count: baseline.files.len(),
        truncated: baseline.truncated,
    }
}

fn workspace_changes_blocking(
    root_path: String,
    cache_key: String,
    baseline_at_ms: Option<u64>,
) -> Result<WorkspaceChanges, String> {
    let (root, _) = workspace_tree_resolve_dir(&root_path, "")?;
    let baseline =
        workspace_changes_baseline_blocking(root_path.clone(), cache_key.clone(), baseline_at_ms)?;
    let (current_files, current_truncated) = scan_workspace_snapshot(&root);
    let mut current_by_path: HashMap<String, WorkspaceChangeSnapshotFile> = current_files
        .into_iter()
        .map(|file| (file.path.clone(), file))
        .collect();
    let mut files = Vec::new();

    for old in baseline.files.iter() {
        match current_by_path.remove(&old.path) {
            Some(new) => {
                if let Some(change) = diff_snapshot_file(old, &new) {
                    files.push(change);
                } else if snapshot_modified_since(&new, baseline.generated_at_ms) {
                    files.push(snapshot_file_to_modified_marker(&new));
                }
            }
            None => files.push(snapshot_file_to_change(old, "deleted")),
        }
    }
    for new in current_by_path.into_values() {
        files.push(snapshot_file_to_change(&new, "added"));
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    let truncated = truncate_workspace_changes(&mut files);
    let changes = WorkspaceChanges {
        root_path: display_preview_path(&root),
        generated_at_ms: now_ms(),
        source: "snapshot".to_string(),
        files,
        truncated: truncated || baseline.truncated || current_truncated,
        scan_scope: Some("full".to_string()),
    };
    let cache_file = workspace_change_cache_file(&root, &cache_key, "changes");
    write_json_cache(&cache_file, &changes)?;
    Ok(changes)
}

fn workspace_changes_cached_blocking(
    root_path: String,
    cache_key: String,
) -> Result<Option<WorkspaceChanges>, String> {
    let (root, _) = workspace_tree_resolve_dir(&root_path, "")?;
    let cache_file = workspace_change_cache_file(&root, &cache_key, "changes");
    Ok(read_json_cache(&cache_file))
}

#[tauri::command]
async fn workspace_changes_baseline(
    root_path: String,
    cache_key: String,
    baseline_at_ms: Option<u64>,
) -> Result<WorkspaceChangeBaselineSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace_changes_baseline_blocking(root_path, cache_key, baseline_at_ms)
            .map(workspace_change_baseline_summary)
    })
    .await
    .map_err(|e| format!("会话改动基线任务失败: {e}"))?
}

#[tauri::command]
async fn workspace_changes(
    root_path: String,
    cache_key: String,
    baseline_at_ms: Option<u64>,
) -> Result<WorkspaceChanges, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace_changes_blocking(root_path, cache_key, baseline_at_ms)
    })
    .await
    .map_err(|e| format!("会话改动读取任务失败: {e}"))?
}

#[tauri::command]
async fn workspace_vcs_status(root_path: String) -> Result<WorkspaceChanges, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_vcs_status_blocking(root_path))
        .await
        .map_err(|e| format!("VCS 状态读取任务失败: {e}"))?
}

#[tauri::command]
async fn workspace_vcs_status_shallow(root_path: String) -> Result<WorkspaceChanges, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_vcs_status_shallow_blocking(root_path))
        .await
        .map_err(|e| format!("VCS 状态读取任务失败: {e}"))?
}

#[tauri::command]
async fn workspace_file_diff(
    root_path: String,
    path: String,
) -> Result<Option<WorkspaceChangeFile>, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_file_diff_blocking(root_path, path))
        .await
        .map_err(|e| format!("文件差异读取任务失败: {e}"))?
}

/// Return the last cached full VCS status snapshot for a workspace, if any.
/// Lets the UI render icons instantly on workspace switch before a fresh scan.
#[tauri::command]
async fn workspace_vcs_status_cached(
    root_path: String,
    cache_key: String,
) -> Result<Option<WorkspaceChanges>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cache_file = workspace_vcs_status_cache_file(&root_path, &cache_key);
        Ok(read_json_cache::<WorkspaceChanges>(&cache_file))
    })
    .await
    .map_err(|e| format!("VCS 状态缓存读取任务失败: {e}"))?
}

/// Enqueue a background full VCS scan. Results are cached and progress is
/// emitted via the `workspace-vcs-scan-progress` event. Returns immediately.
#[tauri::command]
fn workspace_vcs_status_scan(root_path: String, cache_key: String) {
    enqueue_vcs_scan(root_path, cache_key);
}

#[tauri::command]
fn workspace_vcs_status_cancel(root_path: String) {
    cancel_vcs_scan(&root_path);
}

#[tauri::command]
async fn workspace_changes_cached(
    root_path: String,
    cache_key: String,
) -> Result<Option<WorkspaceChanges>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        workspace_changes_cached_blocking(root_path, cache_key)
    })
    .await
    .map_err(|e| format!("会话改动缓存读取任务失败: {e}"))?
}

/// Result of preparing an isolated workspace for a new session (worktree mode).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IsolatedWorkspace {
    /// Absolute path of the prepared isolated working directory.
    path: String,
    /// How the isolation was created: "worktree" (git) or "copy" (non-git).
    kind: String,
    /// Branch name created for a git worktree (absent for copies).
    branch: Option<String>,
}

/// Directories that are never copied when cloning a non-git workspace. Mirrors
/// the tree-walk exclusions plus VCS metadata so copies stay lean and never
/// drag heavy build artifacts or nested isolated worktrees along.
const ISOLATED_COPY_EXCLUDED_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".ultragamestudio",
    ".worktree",
    ".omc",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
];

fn is_inside_git_work_tree(root: &Path) -> bool {
    match run_workspace_status_command(root, "git", &["rev-parse", "--is-inside-work-tree"]) {
        Ok(output) => output.success && !output.timed_out && output.stdout.trim() == "true",
        Err(_) => false,
    }
}

/// Recursively copy `src` into `dst`, skipping VCS/build directories. Symlinks
/// are copied as plain files where possible; failures on individual entries are
/// ignored so a partial copy still yields a usable workspace.
fn copy_workspace_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建隔离目录失败: {e}"))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("读取工作区失败: {e}"))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let from = entry.path();
        let to = dst.join(&name);
        if file_type.is_dir() {
            if ISOLATED_COPY_EXCLUDED_DIRS
                .iter()
                .any(|excluded| name_str.as_ref() == *excluded)
            {
                continue;
            }
            let _ = copy_workspace_tree(&from, &to);
        } else {
            let _ = std::fs::copy(&from, &to);
        }
    }
    Ok(())
}

fn prepare_isolated_workspace_blocking(
    root_path: String,
    session_id: String,
) -> Result<IsolatedWorkspace, String> {
    let root = PathBuf::from(root_path.trim());
    if root.as_os_str().is_empty() || !root.is_dir() {
        return Err("工作区路径无效".to_string());
    }
    // A stable, filesystem-safe slug derived from the session id keeps repeated
    // preparations for the same session idempotent (reuse instead of duplicate).
    let slug: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = if slug.trim_matches('-').is_empty() {
        format!("session-{}", now_ms())
    } else {
        slug
    };

    if is_inside_git_work_tree(&root) {
        // Resolve the repository top-level so the worktree is created relative to
        // the real repo root even when the session cwd is a subdirectory.
        let toplevel =
            match run_workspace_status_command(&root, "git", &["rev-parse", "--show-toplevel"]) {
                Ok(output) if output.success && !output.timed_out => {
                    PathBuf::from(output.stdout.trim())
                }
                _ => root.clone(),
            };
        let branch = format!("ow/session-{slug}");
        let worktrees_root = toplevel.join(".worktree");
        std::fs::create_dir_all(&worktrees_root).map_err(|e| format!("创建工作树目录失败: {e}"))?;
        let worktree_path = worktrees_root.join(&slug);
        // Reuse an existing worktree for the same session if present.
        if worktree_path.is_dir() {
            return Ok(IsolatedWorkspace {
                path: worktree_path.to_string_lossy().to_string(),
                kind: "worktree".to_string(),
                branch: Some(branch),
            });
        }
        let worktree_str = worktree_path.to_string_lossy().to_string();
        let add = run_workspace_status_command_owned_with_timeout(
            &toplevel,
            "git",
            &[
                "worktree".to_string(),
                "add".to_string(),
                "-b".to_string(),
                branch.clone(),
                worktree_str.clone(),
            ],
            std::time::Duration::from_secs(60),
        )
        .map_err(|e| format!("创建 git worktree 失败: {e}"))?;
        if !add.success {
            // The branch may already exist (e.g. a re-run after manual cleanup);
            // retry without -b so we attach to the existing branch instead.
            let retry = run_workspace_status_command_owned_with_timeout(
                &toplevel,
                "git",
                &[
                    "worktree".to_string(),
                    "add".to_string(),
                    worktree_str.clone(),
                    branch.clone(),
                ],
                std::time::Duration::from_secs(60),
            )
            .map_err(|e| format!("创建 git worktree 失败: {e}"))?;
            if !retry.success {
                return Err(format!(
                    "创建 git worktree 失败: {}",
                    workspace_status_error(&add)
                ));
            }
        }
        return Ok(IsolatedWorkspace {
            path: worktree_str,
            kind: "worktree".to_string(),
            branch: Some(branch),
        });
    }

    // Non-git: copy the tree into a sibling isolated directory under the global
    // tmp area so the original workspace is never touched.
    let copies_root = storage_paths::global_tmp_artifact_dir("worktrees")?;
    let copy_path = copies_root.join(&slug);
    if copy_path.is_dir() {
        return Ok(IsolatedWorkspace {
            path: copy_path.to_string_lossy().to_string(),
            kind: "copy".to_string(),
            branch: None,
        });
    }
    copy_workspace_tree(&root, &copy_path)?;
    Ok(IsolatedWorkspace {
        path: copy_path.to_string_lossy().to_string(),
        kind: "copy".to_string(),
        branch: None,
    })
}

/// Prepare an isolated working directory for a session started in "worktree"
/// mode. Git repositories get a real `git worktree` on a fresh branch; other
/// folders get a lean recursive copy. Returns the path the CLI should use as
/// its cwd. Idempotent per session id.
#[tauri::command]
async fn prepare_isolated_workspace(
    root_path: String,
    session_id: String,
) -> Result<IsolatedWorkspace, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_isolated_workspace_blocking(root_path, session_id)
    })
    .await
    .map_err(|e| format!("隔离工作区准备任务失败: {e}"))?
}

fn image_mime_for_path(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "apng" => Some("image/apng"),
        "jpg" | "jpeg" | "jpe" | "jfif" | "pjpeg" | "pjp" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" | "dib" => Some("image/bmp"),
        "ico" | "cur" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn document_mime_for_path(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => Some("application/pdf"),
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "doc" => Some("application/msword"),
        "rtf" => Some("application/rtf"),
        "odt" => Some("application/vnd.oasis.opendocument.text"),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        "ppt" => Some("application/vnd.ms-powerpoint"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "xls" => Some("application/vnd.ms-excel"),
        _ => None,
    }
}

fn image_mime_for_content_type(content_type: &str) -> Option<&'static str> {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match media_type.as_str() {
        "image/png" => Some("image/png"),
        "image/apng" => Some("image/apng"),
        "image/jpeg" | "image/jpg" | "image/pjpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/bmp" | "image/x-ms-bmp" => Some("image/bmp"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        "image/svg+xml" => Some("image/svg+xml"),
        "image/avif" => Some("image/avif"),
        _ => None,
    }
}

fn image_mime_for_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        return Some("image/avif");
    }
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_ascii_lowercase();
    if prefix.contains("<svg") {
        return Some("image/svg+xml");
    }
    None
}

fn image_mime_for_url(url: &str) -> Option<&'static str> {
    let path = url
        .split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url);
    image_mime_for_path(std::path::Path::new(path))
}

fn model_mime_for_extension(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "glb" => Some("model/gltf-binary"),
        "gltf" => Some("model/gltf+json"),
        "obj" => Some("text/plain"),
        "stl" | "fbx" | "ply" => Some("application/octet-stream"),
        "usdz" => Some("model/vnd.usdz+zip"),
        "zip" => Some("application/zip"),
        _ => None,
    }
}

fn model_mime_for_url(url: &str) -> Option<&'static str> {
    let path = url
        .split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url);
    model_mime_for_path(std::path::Path::new(path))
}

fn model_mime_for_path(path: &std::path::Path) -> Option<&'static str> {
    path.extension()
        .and_then(|ext| model_mime_for_extension(&ext.to_string_lossy()))
}

fn model_mime_for_content_type(content_type: &str) -> Option<&'static str> {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match media_type.as_str() {
        "model/gltf-binary" => Some("model/gltf-binary"),
        "model/gltf+json" => Some("model/gltf+json"),
        "model/vnd.usdz+zip" => Some("model/vnd.usdz+zip"),
        "application/zip" | "application/x-zip-compressed" => Some("application/zip"),
        "application/octet-stream" | "binary/octet-stream" => Some("application/octet-stream"),
        "text/plain" => Some("text/plain"),
        _ => None,
    }
}

fn model_mime_for_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"glTF") {
        return Some("model/gltf-binary");
    }
    if bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06") {
        return Some("application/zip");
    }
    let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(512)])
        .trim_start()
        .to_ascii_lowercase();
    if prefix.starts_with('{') && prefix.contains("\"asset\"") {
        return Some("model/gltf+json");
    }
    if prefix.starts_with("solid ") {
        return Some("application/octet-stream");
    }
    None
}

fn model_extension_for_mime(mime: &str) -> &'static str {
    match mime {
        "model/gltf+json" => "gltf",
        "model/vnd.usdz+zip" => "usdz",
        "application/zip" => "zip",
        "text/plain" => "obj",
        _ => "glb",
    }
}

fn text_mime_for_path(path: &std::path::Path) -> &'static str {
    let Some(ext) = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
    else {
        return "text/plain";
    };
    match ext.as_str() {
        "html" | "htm" | "xhtml" | "xht" | "shtml" | "hta" => "text/html",
        "md" | "mdx" | "markdown" | "mkd" | "mkdn" | "mdown" | "mdwn" | "mdtxt" | "mdtext"
        | "rmd" | "qmd" => "text/markdown",
        "css" | "scss" | "sass" | "less" => "text/css",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" | "jsonc" | "json5" | "ndjson" | "jsonl" | "geojson" | "topojson"
        | "webmanifest" | "ipynb" | "har" => "application/json",
        "xml" | "xsd" | "xsl" | "xslt" | "rss" | "atom" | "wsdl" | "drawio" | "dio" => {
            "application/xml"
        }
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" | "mts" | "cts" => "text/typescript",
        _ => "text/plain",
    }
}

fn skip_preview_search_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    matches!(
        name,
        ".git"
            | ".hg"
            | ".svn"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".vite"
            | "build"
            | "coverage"
            | "dist"
            | "node_modules"
            | "out"
            | "target"
            | "__pycache__"
    )
}

fn preview_bare_name_fallback(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return None;
    }

    let cwd = cwd?.trim();
    if cwd.is_empty() {
        return None;
    }

    let root = PathBuf::from(cwd);
    if !root.is_dir() {
        return None;
    }

    let mut stack = vec![root];
    let mut seen = 0_usize;
    let mut found: Option<PathBuf> = None;
    while let Some(dir) = stack.pop() {
        seen += 1;
        if seen > PREVIEW_BASENAME_SEARCH_LIMIT {
            break;
        }

        let read_dir = match std::fs::read_dir(&dir) {
            Ok(read_dir) => read_dir,
            Err(_) => continue,
        };

        for entry in read_dir.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                if !skip_preview_search_dir(&entry_path) {
                    stack.push(entry_path);
                }
                continue;
            }

            let Some(name) = entry_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name != trimmed {
                continue;
            }
            if found.is_some() {
                return None;
            }
            found = Some(entry_path);
        }
    }

    found
}

fn probably_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let sample = &bytes[..bytes.len().min(4096)];
    if sample.iter().any(|b| *b == 0) {
        return true;
    }
    let control = sample
        .iter()
        .filter(|b| **b < 0x08 || (**b > 0x0d && **b < 0x20))
        .count();
    control * 100 > sample.len() * 10
}

fn has_utf16_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff])
}

fn decode_preview_text(bytes: Vec<u8>) -> Option<String> {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16(&units).ok();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|chunk| u16::from_be_bytes([chunk[0], chunk[1]]))
            .collect();
        return String::from_utf16(&units).ok();
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some(text.trim_start_matches('\u{feff}').to_string()),
        Err(err) => {
            let bytes = err.into_bytes();
            if probably_binary(&bytes) {
                None
            } else {
                Some(
                    String::from_utf8_lossy(&bytes)
                        .trim_start_matches('\u{feff}')
                        .to_string(),
                )
            }
        }
    }
}

fn preview_local_file_blocking(
    path: String,
    cwd: Option<String>,
) -> Result<LocalFilePreview, String> {
    // Normalize separators up front so both the direct resolver and the
    // bare-name fallback operate on a consistent, platform-correct path.
    let path = normalize_preview_separators(&path);
    let resolved = preview_path(&path, cwd.as_deref())?;
    let resolved = if resolved.exists() {
        resolved
    } else {
        preview_depot_path_fallback(&path, cwd.as_deref())
            .or_else(|| preview_workspace_app_fallback(&path, cwd.as_deref()))
            .or_else(|| preview_bare_name_fallback(&path, cwd.as_deref()))
            .unwrap_or(resolved)
    };
    let resolved = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    let metadata = std::fs::metadata(&resolved).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !metadata.is_file() {
        return Err("目标不是文件。".to_string());
    }

    let size_bytes = metadata.len();
    let file_name = resolved
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_string();
    let path = display_preview_path(&resolved);

    if let Some(mime) = image_mime_for_path(&resolved) {
        if size_bytes > PREVIEW_IMAGE_LIMIT {
            return Ok(LocalFilePreview {
                path,
                file_name,
                kind: "binary".to_string(),
                mime: Some(mime.to_string()),
                size_bytes,
                truncated: false,
                text: None,
                base64: None,
            });
        }
        let bytes = std::fs::read(&resolved).map_err(|e| format!("读取图片失败：{e}"))?;
        use base64::Engine;
        return Ok(LocalFilePreview {
            path,
            file_name,
            kind: "image".to_string(),
            mime: Some(mime.to_string()),
            size_bytes,
            truncated: false,
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        });
    }

    if let Some(mime) = document_mime_for_path(&resolved) {
        if size_bytes > PREVIEW_DOCUMENT_LIMIT {
            return Ok(LocalFilePreview {
                path,
                file_name,
                kind: "binary".to_string(),
                mime: Some(mime.to_string()),
                size_bytes,
                truncated: false,
                text: None,
                base64: None,
            });
        }
        let bytes = std::fs::read(&resolved).map_err(|e| format!("读取文档失败：{e}"))?;
        use base64::Engine;
        return Ok(LocalFilePreview {
            path,
            file_name,
            kind: "document".to_string(),
            mime: Some(mime.to_string()),
            size_bytes,
            truncated: false,
            text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
        });
    }

    let mut file = std::fs::File::open(&resolved).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(PREVIEW_TEXT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    let truncated = bytes.len() as u64 > PREVIEW_TEXT_LIMIT || size_bytes > PREVIEW_TEXT_LIMIT;
    if bytes.len() as u64 > PREVIEW_TEXT_LIMIT {
        bytes.truncate(PREVIEW_TEXT_LIMIT as usize);
    }

    if !has_utf16_bom(&bytes) && probably_binary(&bytes) {
        return Ok(LocalFilePreview {
            path,
            file_name,
            kind: "binary".to_string(),
            mime: None,
            size_bytes,
            truncated: false,
            text: None,
            base64: None,
        });
    }

    let Some(text) = decode_preview_text(bytes) else {
        return Ok(LocalFilePreview {
            path,
            file_name,
            kind: "binary".to_string(),
            mime: None,
            size_bytes,
            truncated: false,
            text: None,
            base64: None,
        });
    };

    Ok(LocalFilePreview {
        path,
        file_name,
        kind: "text".to_string(),
        mime: Some(text_mime_for_path(&resolved).to_string()),
        size_bytes,
        truncated,
        text: Some(text),
        base64: None,
    })
}

#[tauri::command]
async fn preview_local_file(path: String, cwd: Option<String>) -> Result<LocalFilePreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_local_file_blocking(path, cwd))
        .await
        .map_err(|e| format!("文件预览任务失败: {e}"))?
}

fn upload_mime_for_path(path: &Path) -> Option<String> {
    image_mime_for_path(path)
        .or_else(|| document_mime_for_path(path))
        .map(|mime| mime.to_string())
        .or_else(|| Some(text_mime_for_path(path).to_string()))
}

fn read_local_file_for_upload_blocking(path: String) -> Result<LocalFileUploadPayload, String> {
    let path = normalize_preview_separators(&path);
    let resolved = preview_path(&path, None)?;
    let resolved = std::fs::canonicalize(&resolved).map_err(|e| format!("读取文件失败：{e}"))?;
    let metadata = std::fs::metadata(&resolved).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !metadata.is_file() {
        return Err("目标不是文件。".to_string());
    }
    if metadata.len() > LOCAL_FILE_UPLOAD_LIMIT {
        return Err("文件超过上传大小限制。".to_string());
    }
    let bytes = std::fs::read(&resolved).map_err(|e| format!("读取文件失败：{e}"))?;
    use base64::Engine;
    Ok(LocalFileUploadPayload {
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        file_name: resolved
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file")
            .to_string(),
        mime: upload_mime_for_path(&resolved),
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
async fn read_local_file_for_upload(path: String) -> Result<LocalFileUploadPayload, String> {
    tauri::async_runtime::spawn_blocking(move || read_local_file_for_upload_blocking(path))
        .await
        .map_err(|e| format!("文件读取任务失败: {e}"))?
}

fn clipboard_image_extension(mime: &str, file_name: Option<&str>) -> Result<&'static str, String> {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();

    match mime.as_str() {
        "image/png" | "image/apng" => return Ok("png"),
        "image/jpeg" | "image/jpg" | "image/pjpeg" => return Ok("jpg"),
        "image/webp" => return Ok("webp"),
        "image/gif" => return Ok("gif"),
        "image/bmp" | "image/x-ms-bmp" => return Ok("bmp"),
        "image/avif" => return Ok("avif"),
        _ => {}
    }

    let ext = file_name
        .and_then(|name| Path::new(name).extension())
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "png" | "apng" => Ok("png"),
        "jpg" | "jpeg" | "jpe" | "jfif" | "pjpeg" | "pjp" => Ok("jpg"),
        "webp" => Ok("webp"),
        "gif" => Ok("gif"),
        "bmp" | "dib" => Ok("bmp"),
        "avif" => Ok("avif"),
        _ => Err("仅支持 PNG/JPEG/WebP/GIF/BMP/AVIF 图片粘贴。".to_string()),
    }
}

fn clipboard_image_dir(cwd: Option<&str>) -> PathBuf {
    storage_paths::managed_artifact_dir(cwd, "clipboard-images")
}

fn random_hex_u64() -> String {
    let mut bytes = [0_u8; 8];
    if getrandom::getrandom(&mut bytes).is_ok() {
        return format!("{:016x}", u64::from_le_bytes(bytes));
    }
    format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn write_unique_clipboard_image(dir: &Path, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建图片目录失败：{e}"))?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    for attempt in 0..16 {
        let path = dir.join(format!(
            "pasted-{millis}-{}-{attempt}.{ext}",
            random_hex_u64()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|e| format!("写入粘贴图片失败：{e}"))?;
                return Ok(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("创建粘贴图片失败：{err}")),
        }
    }

    Err("创建粘贴图片失败：文件名冲突。".to_string())
}

fn session_capture_dir(cwd: Option<&str>) -> PathBuf {
    storage_paths::managed_artifact_dir(cwd, "session-captures")
}

fn model_asset_dir(cwd: Option<&str>) -> PathBuf {
    storage_paths::managed_artifact_dir(cwd, "model-assets")
}

fn safe_session_capture_stem(file_name: Option<&str>) -> String {
    let raw = file_name
        .and_then(|name| Path::new(name).file_stem())
        .and_then(|stem| stem.to_str())
        .unwrap_or("session-capture");
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['-', '_', '.']).to_string();
    if trimmed.is_empty() {
        "session-capture".to_string()
    } else {
        trimmed.chars().take(96).collect()
    }
}

fn source_file_name_from_url(url: &str) -> Option<&str> {
    url.split('#')
        .next()
        .unwrap_or(url)
        .split('?')
        .next()
        .unwrap_or(url)
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
}

fn safe_model_asset_stem(file_name: Option<&str>, url: Option<&str>) -> String {
    let raw = file_name
        .and_then(|name| Path::new(name).file_stem())
        .and_then(|stem| stem.to_str())
        .or_else(|| {
            url.and_then(source_file_name_from_url)
                .and_then(|name| Path::new(name).file_stem())
                .and_then(|stem| stem.to_str())
        })
        .unwrap_or("model-asset");
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(['-', '_', '.']).to_string();
    if trimmed.is_empty() {
        "model-asset".to_string()
    } else {
        trimmed.chars().take(96).collect()
    }
}

fn model_asset_extension(mime: &str, url: Option<&str>, file_name: Option<&str>) -> &'static str {
    for candidate in [file_name, url.and_then(source_file_name_from_url)]
        .into_iter()
        .flatten()
    {
        let ext = Path::new(candidate)
            .extension()
            .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "glb" => return "glb",
            "gltf" => return "gltf",
            "obj" => return "obj",
            "stl" => return "stl",
            "fbx" => return "fbx",
            "ply" => return "ply",
            "usdz" => return "usdz",
            "zip" => return "zip",
            _ => {}
        }
    }
    if mime == "application/zip" {
        return "zip";
    }
    model_extension_for_mime(mime)
}

fn write_unique_session_capture(
    dir: &Path,
    stem: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建截图目录失败：{e}"))?;

    for attempt in 0..128 {
        let name = if attempt == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{attempt}.{ext}")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|e| format!("写入截图失败：{e}"))?;
                return Ok(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("创建截图文件失败：{err}")),
        }
    }

    Err("创建截图文件失败：文件名冲突。".to_string())
}

fn write_unique_model_asset(
    dir: &Path,
    stem: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("创建模型目录失败：{e}"))?;

    for attempt in 0..128 {
        let name = if attempt == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{attempt}.{ext}")
        };
        let path = dir.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|e| format!("写入模型文件失败：{e}"))?;
                return Ok(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("创建模型文件失败：{err}")),
        }
    }

    Err("创建模型文件失败：文件名冲突。".to_string())
}

fn save_clipboard_image_blocking(
    bytes_base64: String,
    mime: String,
    file_name: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    use base64::Engine;

    let ext = clipboard_image_extension(&mime, file_name.as_deref())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|e| format!("解析粘贴图片失败：{e}"))?;

    if bytes.is_empty() {
        return Err("粘贴图片为空。".to_string());
    }
    if bytes.len() > CLIPBOARD_IMAGE_LIMIT {
        return Err("粘贴图片过大，最大支持 32MB。".to_string());
    }

    let dir = clipboard_image_dir(cwd.as_deref());
    let path = write_unique_clipboard_image(&dir, ext, &bytes)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_clipboard_image(
    bytes_base64: String,
    mime: String,
    file_name: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_clipboard_image_blocking(bytes_base64, mime, file_name, cwd)
    })
    .await
    .map_err(|e| format!("保存粘贴图片任务失败: {e}"))?
}

fn save_session_capture_blocking(
    bytes_base64: String,
    mime: String,
    file_name: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    use base64::Engine;

    let ext = clipboard_image_extension(&mime, file_name.as_deref())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|e| format!("解析截图失败：{e}"))?;

    if bytes.is_empty() {
        return Err("截图为空。".to_string());
    }
    if bytes.len() > SESSION_CAPTURE_LIMIT {
        return Err("截图文件过大，最大支持 128MB。".to_string());
    }

    let dir = session_capture_dir(cwd.as_deref());
    let stem = safe_session_capture_stem(file_name.as_deref());
    let path = write_unique_session_capture(&dir, &stem, ext, &bytes)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn save_session_capture(
    bytes_base64: String,
    mime: String,
    file_name: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_session_capture_blocking(bytes_base64, mime, file_name, cwd)
    })
    .await
    .map_err(|e| format!("保存截图任务失败: {e}"))?
}

fn fetch_capture_image_data_url_blocking(url: String) -> Result<String, String> {
    use base64::Engine;

    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("截图图片地址必须是 http(s)。".to_string());
    }

    let response = ureq::get(url)
        .timeout(CAPTURE_IMAGE_FETCH_TIMEOUT)
        .set(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .set("User-Agent", "UltraGameStudio")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("截图图片下载失败：HTTP {code}。"),
            other => format!("截图图片下载失败：{other}"),
        })?;

    if let Some(len) = response
        .header("content-length")
        .and_then(|value| value.trim().parse::<usize>().ok())
    {
        if len > CAPTURE_IMAGE_FETCH_LIMIT {
            return Err("截图图片过大，最大支持 32MB。".to_string());
        }
    }

    let content_type = response.header("content-type").unwrap_or("").to_string();
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut reader)
        .take((CAPTURE_IMAGE_FETCH_LIMIT as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取截图图片失败：{e}"))?;

    if bytes.is_empty() {
        return Err("截图图片为空。".to_string());
    }
    if bytes.len() > CAPTURE_IMAGE_FETCH_LIMIT {
        return Err("截图图片过大，最大支持 32MB。".to_string());
    }

    let mime = image_mime_for_content_type(&content_type)
        .or_else(|| image_mime_for_bytes(&bytes))
        .or_else(|| image_mime_for_url(url))
        .ok_or_else(|| "截图图片响应不是支持的图片格式。".to_string())?;
    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{base64}"))
}

#[tauri::command]
async fn fetch_capture_image_data_url(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_capture_image_data_url_blocking(url))
        .await
        .map_err(|e| format!("截图图片下载任务失败: {e}"))?
}

fn fetch_model_asset_bytes(url: &str) -> Result<(Vec<u8>, &'static str), String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("模型地址必须是 http(s)。".to_string());
    }

    let response = ureq::get(url)
        .timeout(MODEL_ASSET_FETCH_TIMEOUT)
        .set(
            "Accept",
            "model/gltf-binary,model/gltf+json,application/octet-stream,text/plain,*/*;q=0.8",
        )
        .set("User-Agent", "UltraGameStudio")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("模型下载失败：HTTP {code}。"),
            other => format!("模型下载失败：{other}"),
        })?;

    if let Some(len) = response
        .header("content-length")
        .and_then(|value| value.trim().parse::<usize>().ok())
    {
        if len > MODEL_ASSET_FETCH_LIMIT {
            return Err("模型文件过大，最大支持 128MB 内嵌预览。".to_string());
        }
    }

    let content_type = response.header("content-type").unwrap_or("").to_string();
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut reader)
        .take((MODEL_ASSET_FETCH_LIMIT as u64) + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取模型失败：{e}"))?;

    if bytes.is_empty() {
        return Err("模型文件为空。".to_string());
    }
    if bytes.len() > MODEL_ASSET_FETCH_LIMIT {
        return Err("模型文件过大，最大支持 128MB 内嵌预览。".to_string());
    }

    let mime = model_mime_for_bytes(&bytes)
        .or_else(|| model_mime_for_content_type(&content_type))
        .or_else(|| model_mime_for_url(url))
        .ok_or_else(|| "模型响应不是支持的 3D 预览格式。".to_string())?;
    Ok((bytes, mime))
}

fn model_data_url(bytes: &[u8], mime: &str) -> String {
    use base64::Engine;

    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{base64}")
}

fn fetch_model_asset_data_url_blocking(url: String) -> Result<String, String> {
    let (bytes, mime) = fetch_model_asset_bytes(&url)?;
    Ok(model_data_url(&bytes, mime))
}

#[tauri::command]
async fn fetch_model_asset_data_url(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_model_asset_data_url_blocking(url))
        .await
        .map_err(|e| format!("模型下载任务失败: {e}"))?
}

fn read_model_asset_data_url_blocking(path: String, cwd: Option<String>) -> Result<String, String> {
    let path = preview_path(&normalize_preview_separators(&path), cwd.as_deref())?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取模型文件失败：{e}"))?;
    if !meta.is_file() {
        return Err("模型路径不是文件。".to_string());
    }
    if meta.len() > MODEL_ASSET_FETCH_LIMIT as u64 {
        return Err("模型文件过大，最大支持 128MB 内嵌预览。".to_string());
    }

    let bytes = std::fs::read(&path).map_err(|e| format!("读取模型文件失败：{e}"))?;
    if bytes.is_empty() {
        return Err("模型文件为空。".to_string());
    }
    if bytes.len() > MODEL_ASSET_FETCH_LIMIT {
        return Err("模型文件过大，最大支持 128MB 内嵌预览。".to_string());
    }

    let mime = model_mime_for_bytes(&bytes)
        .or_else(|| model_mime_for_path(&path))
        .ok_or_else(|| "模型文件不是支持的 3D 预览格式。".to_string())?;
    Ok(model_data_url(&bytes, mime))
}

#[tauri::command]
async fn read_model_asset_data_url(path: String, cwd: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_model_asset_data_url_blocking(path, cwd))
        .await
        .map_err(|e| format!("模型读取任务失败: {e}"))?
}

fn download_model_asset_blocking(
    url: String,
    cwd: Option<String>,
    file_name: Option<String>,
) -> Result<ModelAssetDownload, String> {
    let (bytes, mime) = fetch_model_asset_bytes(&url)?;
    let ext = model_asset_extension(mime, Some(&url), file_name.as_deref());
    let stem = safe_model_asset_stem(file_name.as_deref(), Some(&url));
    let dir = model_asset_dir(cwd.as_deref());
    let path = write_unique_model_asset(&dir, &stem, ext, &bytes)?;
    Ok(ModelAssetDownload {
        path: path.to_string_lossy().to_string(),
        mime: mime.to_string(),
        size_bytes: bytes.len(),
    })
}

#[tauri::command]
async fn download_model_asset(
    url: String,
    cwd: Option<String>,
    file_name: Option<String>,
) -> Result<ModelAssetDownload, String> {
    tauri::async_runtime::spawn_blocking(move || download_model_asset_blocking(url, cwd, file_name))
        .await
        .map_err(|e| format!("模型下载保存任务失败: {e}"))?
}

/// Directory for model-generated media assets, grouped by kind under the
/// managed workspace cache (e.g. `assets/image`, `assets/video`).
fn generated_asset_dir(cwd: Option<&str>, kind: &str) -> PathBuf {
    let safe_kind: String = kind
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(32)
        .collect();
    let leaf = if safe_kind.is_empty() {
        "file".to_string()
    } else {
        safe_kind
    };
    storage_paths::managed_artifact_dir(cwd, "assets").join(leaf)
}

/// Pick a file extension for a generated asset from an explicit file name, then
/// the mime type, falling back to a kind-appropriate default.
fn generated_asset_extension(mime: &str, file_name: Option<&str>, kind: &str) -> String {
    if let Some(ext) = file_name
        .and_then(|name| Path::new(name).extension())
        .and_then(|ext| ext.to_str())
        .filter(|ext| !ext.is_empty())
    {
        return ext.to_ascii_lowercase();
    }
    let m = mime.trim().to_ascii_lowercase();
    let by_mime = match m.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/svg+xml" => Some("svg"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/ogg" => Some("ogg"),
        "audio/flac" => Some("flac"),
        "audio/aac" => Some("aac"),
        "application/json" => Some("json"),
        "model/gltf-binary" => Some("glb"),
        "model/gltf+json" => Some("gltf"),
        _ => None,
    };
    if let Some(ext) = by_mime {
        return ext.to_string();
    }
    match kind {
        "image" | "sprite" => "png",
        "video" => "mp4",
        "audio" | "music" | "speech" => "mp3",
        "mesh" | "model" => "glb",
        _ => "bin",
    }
    .to_string()
}

fn save_generated_asset_blocking(
    bytes_base64: String,
    mime: String,
    kind: String,
    file_name: Option<String>,
    cwd: Option<String>,
) -> Result<GeneratedAssetSave, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64.trim())
        .map_err(|e| format!("解析生成资产失败：{e}"))?;
    if bytes.is_empty() {
        return Err("生成资产为空。".to_string());
    }

    let ext = generated_asset_extension(&mime, file_name.as_deref(), &kind);
    let stem = safe_model_asset_stem(file_name.as_deref(), None);
    let dir = generated_asset_dir(cwd.as_deref(), &kind);
    let path = write_unique_model_asset(&dir, &stem, &ext, &bytes)?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| stem.clone());
    Ok(GeneratedAssetSave {
        path: path.to_string_lossy().to_string(),
        size_bytes: bytes.len(),
        file_name,
    })
}

/// Persist a model-generated asset (decoded base64 bytes) into the workspace
/// asset cache and return its local path. Used by the unified Asset Hub so
/// generated media survives a reload instead of living only as a data URL.
#[tauri::command]
async fn save_generated_asset(
    bytes_base64: String,
    mime: String,
    kind: String,
    file_name: Option<String>,
    cwd: Option<String>,
) -> Result<GeneratedAssetSave, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_generated_asset_blocking(bytes_base64, mime, kind, file_name, cwd)
    })
    .await
    .map_err(|e| format!("保存生成资产任务失败: {e}"))?
}

fn system_time_to_ms(time: std::time::SystemTime) -> Option<u64> {
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
}

fn media_kind_for_path(path: &Path, fallback: &str) -> Option<String> {
    if matches!(
        fallback,
        "sprite" | "video" | "audio" | "music" | "speech" | "mesh" | "model"
    ) {
        return Some(fallback.to_string());
    }
    if image_mime_for_path(path).is_some() {
        return Some("image".to_string());
    }
    let ext = path
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let kind = match ext.as_str() {
        "mp4" | "webm" | "mov" | "m4v" => Some("video"),
        "mp3" | "wav" | "ogg" | "flac" | "aac" | "m4a" => Some("audio"),
        _ if model_mime_for_path(path).is_some() => Some("mesh"),
        _ => match fallback {
            "image" | "sprite" | "video" | "audio" | "music" | "speech" | "mesh" | "model"
            | "file" => Some(fallback),
            _ => None,
        },
    }?;
    Some(kind.to_string())
}

fn cached_asset_file(path: &Path, kind: &str, source: &str) -> Option<CachedAssetFile> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let title = path.file_name()?.to_string_lossy().to_string();
    let kind = media_kind_for_path(path, kind)?;
    Some(CachedAssetFile {
        kind,
        source: source.to_string(),
        origin: "local".to_string(),
        title,
        local_path: display_preview_path(path),
        size_bytes: metadata.len(),
        created_at_ms: metadata.created().ok().and_then(system_time_to_ms),
        modified_at_ms: metadata.modified().ok().and_then(system_time_to_ms),
    })
}

fn collect_cached_assets_from_dir(
    dir: &Path,
    kind: &str,
    source: &str,
    depth: usize,
    out: &mut Vec<CachedAssetFile>,
) {
    if depth == 0 {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_cached_assets_from_dir(&path, kind, source, depth - 1, out);
        } else if file_type.is_file() {
            if let Some(file) = cached_asset_file(&path, kind, source) {
                out.push(file);
            }
        }
    }
}

fn list_cached_assets_blocking(cwd: Option<String>) -> Result<Vec<CachedAssetFile>, String> {
    let cwd = cwd.as_deref();
    let mut files = Vec::new();

    collect_cached_assets_from_dir(
        &clipboard_image_dir(cwd),
        "image",
        "generated",
        1,
        &mut files,
    );
    collect_cached_assets_from_dir(
        &session_capture_dir(cwd),
        "image",
        "generated",
        1,
        &mut files,
    );
    collect_cached_assets_from_dir(&model_asset_dir(cwd), "mesh", "downloaded", 1, &mut files);

    let assets_root = storage_paths::managed_artifact_dir(cwd, "assets");
    if let Ok(read_dir) = std::fs::read_dir(&assets_root) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                let kind = entry.file_name().to_string_lossy().to_string();
                collect_cached_assets_from_dir(&path, &kind, "generated", 2, &mut files);
            } else if file_type.is_file() {
                if let Some(file) = cached_asset_file(&path, "file", "generated") {
                    files.push(file);
                }
            }
        }
    }

    files.sort_by(|a, b| {
        let at = a.modified_at_ms.or(a.created_at_ms).unwrap_or(0);
        let bt = b.modified_at_ms.or(b.created_at_ms).unwrap_or(0);
        bt.cmp(&at).then_with(|| b.local_path.cmp(&a.local_path))
    });
    Ok(files)
}

#[tauri::command]
async fn list_cached_assets(cwd: Option<String>) -> Result<Vec<CachedAssetFile>, String> {
    tauri::async_runtime::spawn_blocking(move || list_cached_assets_blocking(cwd))
        .await
        .map_err(|e| format!("读取资产缓存任务失败: {e}"))?
}

fn fallback_local_model_hardware() -> LocalModelHardware {
    LocalModelHardware {
        ram_gb: None,
        cpu_threads: std::thread::available_parallelism()
            .ok()
            .map(|n| n.get() as u32),
        gpu_vram_gb: None,
    }
}

#[cfg(target_os = "macos")]
fn local_model_hardware_unix(fallback: &LocalModelHardware) -> LocalModelHardware {
    fn sysctl_number(name: &str) -> Option<u64> {
        let output = new_spawn_command("sysctl")
            .arg("-n")
            .arg(name)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .ok()
    }

    LocalModelHardware {
        ram_gb: sysctl_number("hw.memsize").map(|bytes| {
            let gb = bytes as f64 / 1024.0 / 1024.0 / 1024.0;
            (gb * 10.0).round() / 10.0
        }),
        cpu_threads: sysctl_number("hw.logicalcpu")
            .map(|value| value as u32)
            .or(fallback.cpu_threads),
        gpu_vram_gb: None,
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn local_model_hardware_unix(fallback: &LocalModelHardware) -> LocalModelHardware {
    let ram_gb = std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                let value = line.strip_prefix("MemTotal:")?.trim();
                let kb = value.split_whitespace().next()?.parse::<f64>().ok()?;
                Some(((kb / 1024.0 / 1024.0) * 10.0).round() / 10.0)
            })
        });

    LocalModelHardware {
        ram_gb,
        cpu_threads: fallback.cpu_threads,
        gpu_vram_gb: None,
    }
}

#[cfg(unix)]
fn local_model_hardware_blocking() -> LocalModelHardware {
    let fallback = fallback_local_model_hardware();
    local_model_hardware_unix(&fallback)
}

#[cfg(target_os = "windows")]
fn local_model_hardware_blocking() -> LocalModelHardware {
    let fallback = fallback_local_model_hardware();
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$ramGb = $null
$cpuThreads = [Environment]::ProcessorCount
$gpuVramGb = $null
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs.TotalPhysicalMemory) { $ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) }
$cpu = Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum
if ($cpu.Sum) { $cpuThreads = [int]$cpu.Sum }
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Measure-Object -Property AdapterRAM -Maximum
if ($gpu.Maximum) { $gpuVramGb = [math]::Round($gpu.Maximum / 1GB, 1) }
[pscustomobject]@{ ramGb = $ramGb; cpuThreads = $cpuThreads; gpuVramGb = $gpuVramGb } | ConvertTo-Json -Compress
"#;
    let mut cmd = new_spawn_command("powershell");
    let output = cmd.arg("-NoProfile").arg("-Command").arg(script).output();
    if let Ok(output) = output {
        if output.status.success() {
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                let cpu_threads = value
                    .get("cpuThreads")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32)
                    .or(fallback.cpu_threads);
                return LocalModelHardware {
                    ram_gb: value.get("ramGb").and_then(|v| v.as_f64()),
                    cpu_threads,
                    gpu_vram_gb: value.get("gpuVramGb").and_then(|v| v.as_f64()),
                };
            }
        }
    }
    fallback
}

#[tauri::command]
async fn local_model_hardware() -> LocalModelHardware {
    tauri::async_runtime::spawn_blocking(local_model_hardware_blocking)
        .await
        .unwrap_or_else(|_| fallback_local_model_hardware())
}

fn local_model_status_payload(
    channel_id: &str,
    configured_model: &str,
    reachable: bool,
    ready: bool,
    state: &str,
    models: Vec<String>,
    message: Option<String>,
) -> LocalModelRuntimeStatus {
    LocalModelRuntimeStatus {
        channel_id: channel_id.to_string(),
        configured_model: configured_model.to_string(),
        reachable,
        ready,
        state: state.to_string(),
        models,
        message,
    }
}

fn local_model_status_endpoint(channel_id: &str) -> Option<&'static str> {
    match channel_id {
        "ollama" => Some("http://127.0.0.1:11434/api/tags"),
        "lmstudio" => Some("http://127.0.0.1:1234/v1/models"),
        "llamacpp" => Some("http://127.0.0.1:8080/v1/models"),
        _ => None,
    }
}

fn push_unique_model_id(out: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = value else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if out
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(trimmed))
    {
        return;
    }
    out.push(trimmed.to_string());
}

fn extract_local_model_ids(channel_id: &str, value: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    if channel_id == "ollama" {
        if let Some(models) = value.get("models").and_then(|v| v.as_array()) {
            for model in models {
                push_unique_model_id(&mut out, model.get("name").and_then(|v| v.as_str()));
                push_unique_model_id(&mut out, model.get("model").and_then(|v| v.as_str()));
            }
        }
    }
    if let Some(data) = value.get("data").and_then(|v| v.as_array()) {
        for model in data {
            push_unique_model_id(&mut out, model.get("id").and_then(|v| v.as_str()));
        }
    }
    if let Some(models) = value.get("models").and_then(|v| v.as_array()) {
        for model in models {
            if let Some(name) = model.as_str() {
                push_unique_model_id(&mut out, Some(name));
            } else {
                push_unique_model_id(&mut out, model.get("id").and_then(|v| v.as_str()));
                push_unique_model_id(&mut out, model.get("name").and_then(|v| v.as_str()));
                push_unique_model_id(&mut out, model.get("model").and_then(|v| v.as_str()));
            }
        }
    }
    out
}

fn fetch_local_model_ids(channel_id: &str) -> Result<Vec<String>, String> {
    let Some(url) = local_model_status_endpoint(channel_id) else {
        return Err("不支持检测该本地渠道。".to_string());
    };
    let response = ureq::get(url)
        .timeout(LOCAL_MODEL_REQUEST_TIMEOUT)
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("本地服务返回 HTTP {code}。"),
            other => format!("无法连接本地服务: {other}"),
        })?;
    let body = response
        .into_string()
        .map_err(|err| format!("读取本地服务响应失败: {err}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&body).map_err(|err| format!("本地服务响应不是有效 JSON: {err}"))?;
    Ok(extract_local_model_ids(channel_id, &value))
}

fn local_model_id_matches(configured: &str, available: &str) -> bool {
    let configured = configured.trim().to_ascii_lowercase();
    let available = available.trim().to_ascii_lowercase();
    if configured.is_empty() || available.is_empty() {
        return false;
    }
    configured == available
        || format!("{configured}:latest") == available
        || configured == format!("{available}:latest")
}

fn local_model_status_blocking(
    channel_id: String,
    model: Option<String>,
) -> LocalModelRuntimeStatus {
    let channel_id = channel_id.trim().to_ascii_lowercase();
    let configured_model = model.unwrap_or_default().trim().to_string();
    if configured_model.is_empty() {
        return local_model_status_payload(
            &channel_id,
            "",
            false,
            false,
            "missing_model",
            Vec::new(),
            Some("未填写本地模型 id。".to_string()),
        );
    }
    let Some(url) = local_model_status_endpoint(&channel_id) else {
        return local_model_status_payload(
            &channel_id,
            &configured_model,
            false,
            false,
            "unsupported",
            Vec::new(),
            Some("不支持检测该本地渠道。".to_string()),
        );
    };
    let result = ureq::get(url).timeout(LOCAL_MODEL_REQUEST_TIMEOUT).call();
    match result {
        Ok(response) => {
            let body = response.into_string().unwrap_or_default();
            let value: serde_json::Value = match serde_json::from_str(&body) {
                Ok(value) => value,
                Err(err) => {
                    return local_model_status_payload(
                        &channel_id,
                        &configured_model,
                        true,
                        false,
                        "service_error",
                        Vec::new(),
                        Some(format!("本地服务响应不是有效 JSON: {err}")),
                    );
                }
            };
            let models = extract_local_model_ids(&channel_id, &value);
            let has_model = models
                .iter()
                .any(|available| local_model_id_matches(&configured_model, available));
            if has_model {
                local_model_status_payload(
                    &channel_id,
                    &configured_model,
                    true,
                    true,
                    "ready",
                    models,
                    None,
                )
            } else {
                local_model_status_payload(
                    &channel_id,
                    &configured_model,
                    true,
                    false,
                    "model_missing",
                    models,
                    Some("本地服务已启动，但未发现已配置模型。".to_string()),
                )
            }
        }
        Err(ureq::Error::Status(code, _)) => local_model_status_payload(
            &channel_id,
            &configured_model,
            true,
            false,
            "service_error",
            Vec::new(),
            Some(format!("本地服务返回 HTTP {code}。")),
        ),
        Err(err) => local_model_status_payload(
            &channel_id,
            &configured_model,
            false,
            false,
            "service_unavailable",
            Vec::new(),
            Some(format!("无法连接本地服务: {err}")),
        ),
    }
}

#[tauri::command]
async fn local_model_status(channel_id: String, model: Option<String>) -> LocalModelRuntimeStatus {
    tauri::async_runtime::spawn_blocking(move || local_model_status_blocking(channel_id, model))
        .await
        .unwrap_or_else(|err| {
            local_model_status_payload(
                "",
                "",
                false,
                false,
                "service_error",
                Vec::new(),
                Some(format!("本地模型检测任务失败: {err}")),
            )
        })
}

#[tauri::command]
async fn local_model_list(channel_id: String) -> Result<Vec<String>, String> {
    let channel_id = channel_id.trim().to_ascii_lowercase();
    tauri::async_runtime::spawn_blocking(move || fetch_local_model_ids(&channel_id))
        .await
        .map_err(|err| format!("本地模型列表任务失败: {err}"))?
}

fn push_remote_model_id(out: &mut Vec<String>, value: Option<&str>) {
    let Some(value) = value else {
        return;
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if out
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(trimmed))
    {
        return;
    }
    out.push(trimmed.to_string());
}

fn extract_remote_model_ids(value: &serde_json::Value) -> Vec<String> {
    fn visit_model(out: &mut Vec<String>, value: &serde_json::Value) {
        if let Some(model) = value.as_str() {
            push_remote_model_id(out, Some(model));
            return;
        }
        push_remote_model_id(out, value.get("id").and_then(|v| v.as_str()));
        push_remote_model_id(out, value.get("name").and_then(|v| v.as_str()));
        push_remote_model_id(out, value.get("model").and_then(|v| v.as_str()));
    }

    let mut out = Vec::new();
    if let Some(items) = value.as_array() {
        for item in items {
            visit_model(&mut out, item);
        }
        return out;
    }
    if let Some(data) = value.get("data").and_then(|v| v.as_array()) {
        for item in data {
            visit_model(&mut out, item);
        }
    }
    if let Some(models) = value.get("models").and_then(|v| v.as_array()) {
        for item in models {
            visit_model(&mut out, item);
        }
    }
    if let Some(result) = value.get("result").and_then(|v| v.as_array()) {
        for item in result {
            visit_model(&mut out, item);
        }
    }
    visit_model(&mut out, value);
    out
}

fn list_remote_models_blocking(
    urls: Vec<String>,
    api_key: Option<String>,
    transport: String,
) -> Result<RemoteModelListResult, String> {
    let key = api_key.unwrap_or_default().trim().to_string();
    let mut errors = Vec::new();
    for raw_url in urls {
        let url = raw_url.trim();
        if url.is_empty() {
            continue;
        }
        let mut request = ureq::get(url)
            .timeout(REMOTE_MODEL_LIST_REQUEST_TIMEOUT)
            .set("accept", "application/json");
        if !key.is_empty() {
            request = request.set("authorization", &format!("Bearer {key}"));
            if transport == "anthropic" {
                request = request
                    .set("x-api-key", &key)
                    .set("anthropic-version", "2023-06-01");
            }
        }

        let response = match request.call() {
            Ok(response) => response,
            Err(ureq::Error::Status(code, resp)) => {
                let detail = resp.into_string().unwrap_or_default();
                errors.push(format!("{url}: HTTP {code} {detail}"));
                continue;
            }
            Err(err) => {
                errors.push(format!("{url}: {err}"));
                continue;
            }
        };
        let body = match response.into_string() {
            Ok(body) => body,
            Err(err) => {
                errors.push(format!("{url}: 读取响应失败: {err}"));
                continue;
            }
        };
        let parsed: serde_json::Value = match serde_json::from_str(&body) {
            Ok(parsed) => parsed,
            Err(err) => {
                errors.push(format!("{url}: 响应不是有效 JSON: {err}"));
                continue;
            }
        };
        let models = extract_remote_model_ids(&parsed);
        if !models.is_empty() {
            return Ok(RemoteModelListResult {
                models,
                url: url.to_string(),
            });
        }
        errors.push(format!("{url}: 未找到模型列表"));
    }
    Err(if errors.is_empty() {
        "没有可用的模型列表端点。".to_string()
    } else {
        errors.join("; ")
    })
}

#[tauri::command]
async fn list_remote_models(
    urls: Vec<String>,
    api_key: Option<String>,
    transport: String,
) -> Result<RemoteModelListResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_remote_models_blocking(urls, api_key, transport)
    })
    .await
    .map_err(|err| format!("模型列表任务失败: {err}"))?
}

fn cloudflare_model_path(model: &str) -> Result<String, String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err("Cloudflare 模型名称不能为空。".to_string());
    }
    if trimmed.len() > 256 {
        return Err("Cloudflare 模型名称过长。".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '_' | '-' | ':' | '/'))
    {
        return Err("Cloudflare 模型名称包含不支持的字符。".to_string());
    }
    Ok(trimmed
        .split('/')
        .map(url_encode_path_segment)
        .collect::<Vec<_>>()
        .join("/"))
}

fn url_encode_path_segment(segment: &str) -> String {
    let mut encoded = String::new();
    for byte in segment.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~' | b'@') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn json_string_at_path<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn image_data_url_from_cloudflare_json(value: &serde_json::Value) -> Option<String> {
    for path in [
        &["result", "image"][..],
        &["result", "image_url"][..],
        &["result", "imageUrl"][..],
        &["result", "url"][..],
        &["result", "data"][..],
        &["result", "b64_json"][..],
        &["image"][..],
        &["image_url"][..],
        &["imageUrl"][..],
        &["url"][..],
        &["data"][..],
        &["b64_json"][..],
    ] {
        if let Some(raw) = json_string_at_path(value, path) {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("data:")
                || trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
            {
                return Some(trimmed.to_string());
            }
            return Some(format!("data:image/png;base64,{trimmed}"));
        }
    }
    None
}

fn cloudflare_response_to_image_data_url(
    content_type: Option<String>,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let mime = content_type
        .as_deref()
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream");
    if mime.starts_with("image/") {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(format!("data:{mime};base64,{encoded}"));
    }

    let text = String::from_utf8(bytes)
        .map_err(|err| format!("Cloudflare 返回的响应不是图片，也不是可读 JSON: {err}"))?;
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|err| format!("Cloudflare 返回的响应不是图片，也不是有效 JSON: {err}: {text}"))?;
    image_data_url_from_cloudflare_json(&parsed)
        .ok_or_else(|| format!("Cloudflare 返回成功，但响应里没有可识别的图片: {text}"))
}

fn generate_cloudflare_image_blocking(
    account_id: String,
    api_key: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    let account_id = account_id.trim();
    let api_key = api_key.trim();
    let prompt = prompt.trim();
    if account_id.is_empty() {
        return Err("Cloudflare Account ID 不能为空。".to_string());
    }
    if api_key.is_empty() {
        return Err("Cloudflare API Token 不能为空。".to_string());
    }
    if prompt.is_empty() {
        return Err("生图提示词不能为空。".to_string());
    }

    let model_path = cloudflare_model_path(&model)?;
    let url =
        format!("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model_path}");
    let body = serde_json::json!({ "prompt": prompt });
    let response = ureq::post(&url)
        .timeout(CLOUDFLARE_IMAGE_REQUEST_TIMEOUT)
        .set("authorization", &format!("Bearer {api_key}"))
        .set("content-type", "application/json")
        .set("accept", "image/*, application/json")
        .send_json(body);

    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(code, resp)) => {
            let detail = resp.into_string().unwrap_or_default();
            return Err(format!("Cloudflare Workers AI 返回 HTTP {code}: {detail}"));
        }
        Err(err) => return Err(format!("Cloudflare Workers AI 请求失败: {err}")),
    };

    let content_type = response.header("content-type").map(str::to_string);
    let mut reader = response.into_reader();
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|err| format!("读取 Cloudflare 响应失败: {err}"))?;
    cloudflare_response_to_image_data_url(content_type, bytes)
}

#[tauri::command]
async fn generate_cloudflare_image(
    account_id: String,
    api_key: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        generate_cloudflare_image_blocking(account_id, api_key, model, prompt)
    })
    .await
    .map_err(|err| format!("Cloudflare 生图任务失败: {err}"))?
}

fn validate_ollama_model_id(model: &str) -> Result<String, String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Err("请选择要安装的本地模型。".to_string());
    }
    if trimmed.len() > 128 {
        return Err("模型名称过长。".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
    {
        return Err("模型名称只能包含字母、数字、点、下划线、短横线、冒号或斜杠。".to_string());
    }
    Ok(trimmed.to_string())
}

fn setup_local_model_blocking(model: String) -> Result<(), String> {
    let model = validate_ollama_model_id(&model)?;

    #[cfg(not(target_os = "windows"))]
    {
        new_spawn_command("ollama")
            .arg("pull")
            .arg(&model)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!("无法启动 ollama pull，请先安装 Ollama 并确认 ollama 在 PATH 中。({e})")
            })?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let script_path =
            managed_temp_path(None, "scripts", "ultragamestudio-setup-local-model", "ps1");
        std::fs::write(&script_path, LOCAL_MODEL_SETUP_PS1.as_bytes())
            .map_err(|e| format!("写入本地模型安装脚本失败: {e}"))?;

        let mut cmd = new_spawn_command("powershell");
        cmd.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script_path)
            .arg("-Provider")
            .arg("ollama")
            .arg("-Model")
            .arg(model)
            .spawn()
            .map_err(|e| format!("启动本地模型安装脚本失败: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
async fn setup_local_model(model: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || setup_local_model_blocking(model))
        .await
        .map_err(|e| format!("本地模型安装任务启动失败: {e}"))?
}

/// Managed install root for the ComfyUI runtime + downloaded models.
fn comfyui_tools_dir() -> Result<PathBuf, String> {
    let root = storage_paths::ensure_global_root_with_dirs(&["tools"])?;
    let dir = root.join("tools").join("comfyui");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 ComfyUI 工具目录失败：{e}"))?;
    Ok(dir)
}

/// Accept only the known model-profile ids the installer script understands.
fn validate_comfyui_model_id(model: &str) -> Result<Option<String>, String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    const ALLOWED: [&str; 3] = ["sd1.5", "sdxl-turbo", "flux-schnell"];
    if !ALLOWED.contains(&trimmed) {
        return Err(format!(
            "未知的 ComfyUI 模型档位：{trimmed}。可选 sd1.5 / sdxl-turbo / flux-schnell。"
        ));
    }
    Ok(Some(trimmed.to_string()))
}

fn setup_comfyui_blocking(model: Option<String>, skip_model: bool) -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err(
            "ComfyUI 一键安装目前仅支持 Windows（官方便携版）。其他平台请参考 github.com/comfyanonymous/ComfyUI 手动安装。"
                .to_string(),
        );
    }
    let model_id = validate_comfyui_model_id(model.as_deref().unwrap_or(""))?;
    let install_root = comfyui_tools_dir()?;

    #[cfg(target_os = "windows")]
    {
        let script_path =
            managed_temp_path(None, "scripts", "ultragamestudio-setup-comfyui", "ps1");
        std::fs::write(&script_path, COMFYUI_SETUP_PS1.as_bytes())
            .map_err(|e| format!("写入 ComfyUI 安装脚本失败：{e}"))?;

        let mut cmd = new_spawn_command("powershell");
        cmd.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(&script_path)
            .arg("-InstallRoot")
            .arg(install_root.to_string_lossy().to_string());
        if let Some(id) = model_id {
            cmd.arg("-Model").arg(id);
        }
        if skip_model {
            cmd.arg("-SkipModel");
        }
        cmd.spawn()
            .map_err(|e| format!("启动 ComfyUI 安装脚本失败：{e}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (model_id, install_root);
        Err("ComfyUI 一键安装仅支持 Windows。".to_string())
    }
}

#[tauri::command]
async fn setup_comfyui(model: Option<String>, skip_model: Option<bool>) -> Result<(), String> {
    let skip = skip_model.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || setup_comfyui_blocking(model, skip))
        .await
        .map_err(|e| format!("ComfyUI 安装任务启动失败：{e}"))?
}

#[tauri::command]
async fn scan_model_clis() -> cli_runtime::CliScanResult {
    tauri::async_runtime::spawn_blocking(cli_runtime::scan_model_clis)
        .await
        .unwrap_or_else(|e| cli_runtime::CliScanResult {
            scanned_at_ms: 0,
            platform: cli_runtime::platform(),
            candidates: Vec::new(),
            error: Some(format!("CLI 扫描任务失败: {e}")),
        })
}

#[tauri::command]
async fn validate_cli_path(path: String) -> Result<cli_runtime::CliPathValidation, String> {
    tauri::async_runtime::spawn_blocking(move || cli_runtime::validate_cli_path(&path))
        .await
        .map_err(|e| format!("CLI 路径校验任务失败: {e}"))?
}

/// Run an emitted workflow script through the mapped local CLI.
///
/// Async: the blocking process spawn/wait runs on a blocking thread via
/// `spawn_blocking` so it never stalls the webview's main thread (a synchronous
/// command would freeze the UI for the CLI's whole runtime). Spawns the real
/// binary (`claude` / `codex` / `gemini`), waits for it, and returns a combined
/// stdout/stderr summary. The script is materialised to a temp file.
#[tauri::command]
async fn run_workflow(
    script: String,
    adapter: String,
    cli_command: Option<String>,
    shell: Option<ShellSpec>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let binary = match cli_command
            .as_deref()
            .map(cli_runtime::normalize_cli_command_override)
            .transpose()?
        {
            Some(binary) => binary,
            None => cli_runtime::adapter_binary(&adapter).to_string(),
        };
        let script_path = write_temp_script(&script)?;

        // no popup terminal window on Windows; optionally wrapped in a shell.
        let args = vec![script_path.to_string_lossy().to_string()];
        let mut cmd = build_launch_command(&binary, &args, &shell);
        let output = cmd
            .output()
            .map_err(|e| format!("无法启动 CLI \"{binary}\"：请确认它已安装并在 PATH 中。({e})"))?;

        // Best-effort cleanup; ignore failures.
        let _ = std::fs::remove_file(&script_path);

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);

        let mut summary = String::new();
        summary.push_str(&format!("[{binary}] exit={code}\n"));
        if !stdout.trim().is_empty() {
            summary.push_str("--- stdout ---\n");
            summary.push_str(stdout.trim_end());
            summary.push('\n');
        }
        if !stderr.trim().is_empty() {
            summary.push_str("--- stderr ---\n");
            summary.push_str(stderr.trim_end());
            summary.push('\n');
        }

        if output.status.success() {
            Ok(summary)
        } else {
            Err(summary)
        }
    })
    .await
    .map_err(|e| format!("运行任务调度失败: {e}"))?
}

fn ugs_cli_candidates(cwd: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = cwd.map(str::trim).filter(|dir| !dir.is_empty()) {
        let root = PathBuf::from(dir);
        out.push(root.join("app").join("cli").join("dist").join("ugs.mjs"));
        out.push(root.join("cli").join("dist").join("ugs.mjs"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("app").join("cli").join("dist").join("ugs.mjs"));
        out.push(cwd.join("cli").join("dist").join("ugs.mjs"));
        if let Some(parent) = cwd.parent() {
            out.push(parent.join("app").join("cli").join("dist").join("ugs.mjs"));
            out.push(parent.join("cli").join("dist").join("ugs.mjs"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("ugs.mjs"));
            out.push(dir.join("cli").join("dist").join("ugs.mjs"));
            out.push(
                dir.join("..")
                    .join("..")
                    .join("app")
                    .join("cli")
                    .join("dist")
                    .join("ugs.mjs"),
            );
        }
    }
    out
}

fn bundled_ugs_cli_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("cli").join("ugs.mjs"))
        .filter(|path| path.is_file())
}

fn locate_ugs_cli(cwd: Option<&str>, app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = bundled_ugs_cli_path(app) {
        return normalize_node_entry_path(&path)
            .map_err(|e| format!("无法解析内置 ugs CLI 路径 {}: {e}", path.display()));
    }

    let candidates = ugs_cli_candidates(cwd);
    for path in &candidates {
        if path.is_file() {
            return normalize_node_entry_path(path)
                .map_err(|e| format!("无法解析 ugs CLI 路径 {}: {e}", path.display()));
        }
    }
    let searched = candidates
        .iter()
        .map(|path| format!("  - {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "未找到 app/cli/dist/ugs.mjs 或内置 cli/ugs.mjs。请先在 app/ 下运行 npm run cli:build。\n已搜索:\n{searched}"
    ))
}

fn normalize_node_entry_path(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let raw = canonical.display().to_string();
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(canonical)
}

fn default_studio_workdir(cli_path: &Path) -> PathBuf {
    let mut current = cli_path.parent();
    while let Some(dir) = current {
        if dir.file_name().and_then(|name| name.to_str()) == Some("app") {
            if let Some(root) = dir.parent() {
                return root.to_path_buf();
            }
            return dir.to_path_buf();
        }
        current = dir.parent();
    }
    cli_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn emit_studio_progress(app: &tauri::AppHandle, run_id: &str, stream: &str, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let prefix = if stream == "stderr" {
        "stderr"
    } else {
        "stdout"
    };
    let _ = app.emit(
        "ai-cli-progress",
        serde_json::json!({
            "runId": run_id,
            "text": format!("\n[{prefix}] {text}")
        }),
    );
}

fn studio_enabled() -> bool {
    false
}

#[tauri::command]
async fn run_studio(
    task: String,
    cwd: Option<String>,
    extra_workspace_paths: Option<Vec<String>>,
    adapter: Option<String>,
    model: Option<String>,
    provider: Option<String>,
    concurrency: Option<u32>,
    max_retries: Option<u32>,
    max_agent_calls: Option<u32>,
    max_rounds: Option<u32>,
    verify_command: Option<String>,
    timeout_seconds: Option<u64>,
    run_id: String,
    resume: Option<bool>,
    planner_only: Option<bool>,
    from_harness: Option<String>,
    trace: Option<bool>,
    interactive: Option<bool>,
    app: tauri::AppHandle,
) -> Result<StudioRunResult, String> {
    if !studio_enabled() {
        return Err(
            "/studio 动态多智能体编排已默认关闭。请直接使用普通聊天/编程模型处理任务。".to_string(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<StudioRunResult, String> {
        let task = task.trim().to_string();
        if task.is_empty() {
            return Err("请提供任务：/studio <任务>".to_string());
        }

        let cwd_trimmed = cwd.as_deref().map(str::trim).filter(|dir| !dir.is_empty());
        let cli_path = locate_ugs_cli(cwd_trimmed, &app)?;
        let workdir = cwd_trimmed
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| default_studio_workdir(&cli_path));
        let extra_workspace_paths =
            normalize_extra_workspace_paths(cwd.as_deref(), extra_workspace_paths);
        let workspace_context = if extra_workspace_paths.is_empty() {
            String::new()
        } else {
            format!(
                "\n\n附加工作区目录：\n{}\n这些目录属于同一次会话上下文；需要跨项目/引擎源码分析时可按绝对路径读取。",
                extra_workspace_paths
                    .iter()
                    .map(|path| format!("- {path}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let task = format!("{task}{workspace_context}");

        let mut args = vec![
            cli_path.to_string_lossy().to_string(),
            "studio".to_string(),
            task,
            "--json".to_string(),
            "--cwd".to_string(),
            workdir.to_string_lossy().to_string(),
        ];
        if let Some(value) = adapter.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            args.push("--adapter".to_string());
            args.push(value);
        }
        if let Some(value) = model.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            args.push("--model".to_string());
            args.push(value);
        }
        if let Some(value) = provider.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            args.push("--provider".to_string());
            args.push(value);
        }
        if let Some(value) = concurrency.filter(|value| *value > 0) {
            args.push("--concurrency".to_string());
            args.push(value.to_string());
        }
        if let Some(value) = max_retries {
            args.push("--max-retries".to_string());
            args.push(value.to_string());
        }
        if let Some(value) = max_agent_calls.filter(|value| *value > 0) {
            args.push("--max-agent-calls".to_string());
            args.push(value.to_string());
        }
        if let Some(value) = max_rounds.filter(|value| *value > 0) {
            args.push("--max-rounds".to_string());
            args.push(value.to_string());
        }
        if let Some(value) = verify_command
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
        {
            args.push("--verify-command".to_string());
            args.push(value);
        }
        if let Some(value) = timeout_seconds.filter(|value| *value >= 30) {
            args.push("--timeout".to_string());
            args.push(value.to_string());
        }
        if resume.unwrap_or(false) {
            args.push("--resume".to_string());
        }
        if planner_only.unwrap_or(false) {
            args.push("--planner-only".to_string());
        }
        if trace.unwrap_or(false) {
            args.push("--trace".to_string());
        }
        if interactive.unwrap_or(false) {
            args.push("--interactive".to_string());
        }
        if let Some(value) = from_harness.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
            args.push("--from-harness".to_string());
            args.push(value);
        }
        args.push("--run-id".to_string());
        args.push(run_id.clone());

        let mut cmd = new_spawn_command("node");
        cmd.args(&args)
            .current_dir(&workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动 node 执行 /studio：请确认 Node.js 已安装并在 PATH 中。({e})"))?;
        register_ai_cli(&run_id, child.id());

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let app_stdout = app.clone();
        let run_stdout = run_id.clone();
        let stdout_handle = std::thread::spawn(move || -> String {
            let Some(stdout) = stdout else {
                return String::new();
            };
            let reader = std::io::BufReader::new(stdout);
            let mut out = String::new();
            for line in reader.lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(_) => break,
                };
                out.push_str(&line);
                out.push('\n');
                emit_studio_progress(&app_stdout, &run_stdout, "stdout", &line);
            }
            out
        });
        let app_stderr = app.clone();
        let run_stderr = run_id.clone();
        let stderr_handle = std::thread::spawn(move || -> String {
            let Some(stderr) = stderr else {
                return String::new();
            };
            let reader = std::io::BufReader::new(stderr);
            let mut out = String::new();
            for line in reader.lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(_) => break,
                };
                out.push_str(&line);
                out.push('\n');
                emit_studio_progress(&app_stderr, &run_stderr, "stderr", &line);
            }
            out
        });

        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if take_ai_cli_cancelled(&run_id) {
                        terminate_child_tree(&mut child);
                        unregister_ai_cli(&run_id);
                        return Err("CLI \"studio\" 已由用户中断。".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    terminate_child_tree(&mut child);
                    unregister_ai_cli(&run_id);
                    return Err(format!("等待 /studio 进程失败: {e}"));
                }
            }
        };

        let stdout = stdout_handle.join().unwrap_or_default();
        let stderr = stderr_handle.join().unwrap_or_default();
        let cancelled = take_ai_cli_cancelled(&run_id);
        unregister_ai_cli(&run_id);
        if cancelled {
            return Err("CLI \"studio\" 已由用户中断。".to_string());
        }

        let result_json = serde_json::from_str::<serde_json::Value>(stdout.trim()).ok();
        let run_dir = result_json
            .as_ref()
            .and_then(|value| value.get("runDir"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        let exit_code = status.code().unwrap_or(-1);
        let result = StudioRunResult {
            exit_code,
            stdout,
            stderr,
            run_id,
            run_dir,
            result_json,
        };
        if status.success() || result.result_json.is_some() {
            Ok(result)
        } else {
            Err(format!(
                "/studio 退出码 {exit_code}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                result.stdout.trim_end(),
                result.stderr.trim_end()
            ))
        }
    })
    .await
    .map_err(|e| format!("/studio 任务调度失败: {e}"))?
}

/// System prompt steering the model to emit a pure IRGraph JSON object that maps
/// onto a *runnable* Claude Code workflow (the injected-globals DSL).
const AI_EDIT_SYSTEM: &str = "You are a workflow graph editor for UltraGameStudio. You receive the current workflow as an IRGraph JSON object plus a natural-language instruction (in Chinese or English). Return ONLY a single valid IRGraph JSON object (no markdown, no prose).

The IRGraph compiles to a real Claude Code workflow script, so use these exact node shapes:
- Envelope: {version, meta, nodes, edges, layout?}.
- meta: {name, description?, adapter?, gateway?:{defaults?:{adapter, modelClass, providerId?, channelId?}}, schemaDefs?}. schemaDefs maps a schema identifier name to its JS object source, e.g. {\"REVIEW\":\"{ findings: [] }\"}.
- Each node: {id, type, parent?, label?, binding?, params}. type is one of start|end|agent|parallel|pipeline|phase|branch|loop|workflow|log|variable|codeblock. `parent` is the id of a containing branch/loop node (omit for the top level). `binding` is the JS variable name (optional).
- agent.params: {prompt, label?, agentType?, model?, gateway?, schema?, isolation?, phase?}. Use `agentType` (NOT `agent`) for a sub-agent type like 'explore'/'verifier'. `schema` is a bare identifier NAME (a key of meta.schemaDefs), e.g. \"REVIEW\". model is haiku|sonnet|opus. New nodes should inherit meta.gateway.defaults instead of writing model:'sonnet'.
- parallel.params: {branches: [{prompt, agentType?, model?, schema?, label?}]} — each branch becomes a () => agent(...) thunk.
- pipeline.params: {items, stages: [{prompt, agentType?, schema?}]} — items is a JS expression naming the input array (e.g. \"files\"); each stage becomes a (prev, item, i) => agent(...) callback.
- branch.params: {condition} and loop.params: {condition} (a JS boolean expression). Their child nodes are separate nodes carrying parent = the branch/loop id.
- variable.params: {name, value, raw?}. log.params: {message}. workflow.params: {name}. codeblock.params: {code}.

Before drafting, estimate the task's complexity from the instruction and the current graph. Match graph granularity to task complexity: use the smallest workflow that fully covers the request, keep simple edits minimal, and only expand into branches, pipelines, verification, fallback, or extra coordination when there are real dependencies, independent subproblems, or meaningful risk. Treat completeness as proportional to risk and ambiguity, not maximal by default.

Edges: {id, from:{node,port}, to:{node,port}, kind} where kind is 'exec' or 'data'. Wire an exec spine start -> ... -> end among top-level siblings; a branch/loop connects to its first child via an exec edge (kind 'exec') and children chain child->child. Express data flow as 'data'-kind edges from a producer node to a consumer node — do NOT inline ${...} yourself; the emitter does that. Keep node ids stable when editing existing nodes.";

/// Ask the Anthropic Messages API to rewrite the graph from an instruction.
///
/// Requires `api_key`. Returns the new IRGraph as a JSON string. When no key is
/// supplied the command errors so the frontend can fall back to its local
/// intent engine.
fn ai_edit_graph_blocking(
    current_ir_json: String,
    instruction: String,
    api_key: Option<String>,
) -> Result<String, String> {
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Err("NO_API_KEY".to_string()),
    };

    let user_content = format!(
        "Current IRGraph:\n{current_ir_json}\n\nInstruction:\n{instruction}\n\nReturn the edited IRGraph JSON."
    );

    let body = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 8192,
        "system": AI_EDIT_SYSTEM,
        "messages": [
            { "role": "user", "content": user_content }
        ]
    });

    let response = ureq::post("https://api.anthropic.com/v1/messages")
        .timeout(AI_EDIT_REQUEST_TIMEOUT)
        .set("x-api-key", &key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json")
        .send_json(body);

    let response = match response {
        Ok(r) => r,
        Err(ureq::Error::Status(code, resp)) => {
            let detail = resp
                .into_string()
                .unwrap_or_else(|_| "<no body>".to_string());
            return Err(format!("Anthropic API 错误 {code}: {detail}"));
        }
        Err(e) => return Err(format!("请求 Anthropic API 失败: {e}")),
    };

    let parsed: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("解析 Anthropic 响应失败: {e}"))?;

    // Concatenate all text blocks from the content array.
    let text = parsed
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    let trimmed = extract_json(&text);
    // Validate it parses as JSON before returning to the frontend.
    serde_json::from_str::<serde_json::Value>(&trimmed)
        .map_err(|e| format!("模型未返回有效 JSON: {e}\n原始输出:\n{text}"))?;

    Ok(trimmed)
}

#[tauri::command]
async fn ai_edit_graph(
    current_ir_json: String,
    instruction: String,
    api_key: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ai_edit_graph_blocking(current_ir_json, instruction, api_key)
    })
    .await
    .map_err(|e| format!("AI 编辑任务失败: {e}"))?
}

/// Strip a possible ```json fence and return the inner JSON payload.
fn extract_json(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```json") {
        return rest.trim_end_matches("```").trim().to_string();
    }
    if let Some(rest) = t.strip_prefix("```") {
        return rest.trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// Default hard timeout for a single CLI invocation before it is killed.
const DEFAULT_AI_CLI_TIMEOUT_SECS: u64 = 1800;
/// Default "no observable progress" timeout for a single CLI invocation.
/// 0 disables idle detection; long-running tools often stay quiet while waiting
/// for external work such as CI, package builds, or downloads.
const DEFAULT_AI_CLI_IDLE_TIMEOUT_SECS: u64 = 0;
const CLI_ERROR_CONTEXT_LIMIT: usize = 1200;
/// Idle gap (no stdout activity) after which a "still running" heartbeat line is
/// emitted to the run log, so a long node never looks completely frozen even
/// during a long tool execution or a slow first token.
const AI_CLI_HEARTBEAT_SECS: u64 = 12;

/// Read the CLI timeout override from the environment, falling back to a
/// longer default so legitimate long-running workflows are less likely to be
/// killed too early.
fn configured_ai_cli_timeout_secs() -> u64 {
    std::env::var("ULTRAGAMESTUDIO_AI_CLI_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|secs| *secs >= 60)
        .unwrap_or(DEFAULT_AI_CLI_TIMEOUT_SECS)
}

fn ai_cli_timeout_secs(override_secs: Option<u64>) -> u64 {
    let configured = configured_ai_cli_timeout_secs();
    let dynamic = override_secs
        .filter(|secs| *secs >= 60)
        .unwrap_or(configured);
    configured.max(dynamic)
}

/// Whether to load the machine's global MCP servers for each workflow node.
/// On by default so workflow nodes share the same MCP tools as a hand-run
/// `claude` (e.g. pencil `mcp__pencil__...`). Set ULTRAGAMESTUDIO_ENABLE_MCP=0
/// (or false/no) to opt out and skip MCP init for faster cold spawns.
fn mcp_enabled() -> bool {
    std::env::var("ULTRAGAMESTUDIO_ENABLE_MCP")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            // Default on: only an explicit disable value turns MCP off.
            !(v == "0" || v == "false" || v == "no" || v == "off")
        })
        .unwrap_or(true)
}

fn claude_bare_mode_disabled() -> bool {
    std::env::var("ULTRAGAMESTUDIO_DISABLE_CLAUDE_BARE")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false)
}

fn env_value<'a>(env_vars: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    env_vars
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
}

fn env_has_value(env_vars: &HashMap<String, String>, key: &str) -> bool {
    env_value(env_vars, key).is_some()
}

fn anthropic_auth_value(env_vars: &HashMap<String, String>) -> Option<&str> {
    env_value(env_vars, "ANTHROPIC_AUTH_TOKEN").or_else(|| env_value(env_vars, "ANTHROPIC_API_KEY"))
}

fn has_anthropic_gateway_env(env_vars: &HashMap<String, String>) -> bool {
    anthropic_auth_value(env_vars).is_some()
        && (env_has_value(env_vars, "ANTHROPIC_BASE_URL")
            || env_has_value(env_vars, "ANTHROPIC_MODEL"))
}

fn known_provider_model_variant(base_url: Option<&str>, model: Option<&str>) -> Option<String> {
    let trimmed = model?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let base = base_url.unwrap_or("").trim().to_ascii_lowercase();
    let lower = trimmed.to_ascii_lowercase();

    if base.contains("openrouter.ai") || base.contains("/ch/open_router") {
        if lower.starts_with("glm-") {
            return Some(format!("z-ai/{lower}"));
        }
        if lower.starts_with("z-ai/glm-") {
            return Some(lower);
        }
    }
    if base.contains("integrate.api.nvidia.com") || base.contains("/ch/nvidia_nim") {
        if !trimmed.contains('/') && lower.contains("nemotron") {
            return Some(format!("nvidia/{lower}"));
        }
    }
    if base.contains("fireworks.ai") || base.contains("/ch/fireworks") {
        if !trimmed.contains('/') && lower.starts_with("llama-") {
            return Some(format!("accounts/fireworks/models/{lower}"));
        }
    }
    if base.contains("opencode.ai")
        || base.contains("z.ai")
        || base.contains("bigmodel.cn")
        || base.contains("/ch/opencode")
        || base.contains("/ch/opencode_go")
        || base.contains("/ch/zai")
    {
        if lower.starts_with("glm-") {
            return Some(lower);
        }
    }

    Some(trimmed.to_string())
}

fn normalize_spawn_env(
    mut env_vars: Option<HashMap<String, String>>,
) -> Option<HashMap<String, String>> {
    let mut out = env_vars.take().unwrap_or_default();
    let had_overlay = !out.is_empty();
    let mut changed = false;

    let anthropic_base = out
        .get("ANTHROPIC_BASE_URL")
        .cloned()
        .or_else(|| std::env::var("ANTHROPIC_BASE_URL").ok());
    let anthropic_model = out
        .get("ANTHROPIC_MODEL")
        .cloned()
        .or_else(|| std::env::var("ANTHROPIC_MODEL").ok());
    if let Some(model) =
        known_provider_model_variant(anthropic_base.as_deref(), anthropic_model.as_deref())
    {
        if anthropic_model.as_deref().map(str::trim) != Some(model.as_str()) {
            out.insert("ANTHROPIC_MODEL".to_string(), model);
            changed = true;
        }
    }

    let openai_base = out
        .get("OPENAI_BASE_URL")
        .cloned()
        .or_else(|| std::env::var("OPENAI_BASE_URL").ok());
    let openai_model = out
        .get("OPENAI_MODEL")
        .cloned()
        .or_else(|| std::env::var("OPENAI_MODEL").ok());
    if let Some(model) =
        known_provider_model_variant(openai_base.as_deref(), openai_model.as_deref())
    {
        if openai_model.as_deref().map(str::trim) != Some(model.as_str()) {
            out.insert("OPENAI_MODEL".to_string(), model);
            changed = true;
        }
    }

    if had_overlay || changed {
        Some(out)
    } else {
        None
    }
}

fn should_run_claude_bare(env_vars: Option<&HashMap<String, String>>) -> bool {
    should_run_claude_bare_with_disable(env_vars, claude_bare_mode_disabled())
}

fn gateway_progress_model_hint(env_vars: Option<&HashMap<String, String>>) -> Option<String> {
    let env_vars = env_vars?;
    if !has_anthropic_gateway_env(env_vars) {
        return None;
    }
    env_vars
        .get("ANTHROPIC_MODEL")
        .map(|model| model.trim())
        .filter(|model| !model.is_empty())
        .map(ToString::to_string)
}

fn should_run_claude_bare_with_disable(
    env_vars: Option<&HashMap<String, String>>,
    disabled: bool,
) -> bool {
    if disabled {
        return false;
    }
    let Some(env_vars) = env_vars else {
        return false;
    };
    has_anthropic_gateway_env(env_vars)
}

fn claude_gateway_settings_json(env_vars: &HashMap<String, String>) -> Option<serde_json::Value> {
    if !has_anthropic_gateway_env(env_vars) {
        return None;
    }

    let api_key =
        env_value(env_vars, "ANTHROPIC_API_KEY").or_else(|| anthropic_auth_value(env_vars))?;
    let auth_token = env_value(env_vars, "ANTHROPIC_AUTH_TOKEN").unwrap_or(api_key);
    let mut settings_env = serde_json::Map::new();

    for (key, value) in env_vars {
        let trimmed = value.trim();
        if key.starts_with("ANTHROPIC_") && !trimmed.is_empty() {
            settings_env.insert(key.clone(), serde_json::Value::String(trimmed.to_string()));
        }
    }

    settings_env.insert(
        "ANTHROPIC_API_KEY".to_string(),
        serde_json::Value::String(api_key.to_string()),
    );
    settings_env.insert(
        "ANTHROPIC_AUTH_TOKEN".to_string(),
        serde_json::Value::String(auth_token.to_string()),
    );

    let mut root = serde_json::Map::new();
    if let Some(model) = env_value(env_vars, "ANTHROPIC_MODEL") {
        for key in [
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
        ] {
            settings_env
                .entry(key.to_string())
                .or_insert_with(|| serde_json::Value::String(model.to_string()));
        }
        root.insert(
            "model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
    }
    root.insert("env".to_string(), serde_json::Value::Object(settings_env));
    Some(serde_json::Value::Object(root))
}

fn write_claude_gateway_settings(
    env_vars: Option<&HashMap<String, String>>,
    cwd: Option<&str>,
) -> Result<Option<TempFileGuard>, String> {
    let Some(settings) = env_vars.and_then(claude_gateway_settings_json) else {
        return Ok(None);
    };
    let path = temp_output_path_for_cwd(cwd, "ultragamestudio-claude-settings", "json");
    let bytes =
        serde_json::to_vec(&settings).map_err(|e| format!("生成 Claude 临时配置失败: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("写入 Claude 临时配置失败: {e}"))?;
    Ok(Some(TempFileGuard::new(path)))
}

fn project_history_path_key(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let raw = PathBuf::from(trimmed);
    let resolved = std::fs::canonicalize(&raw).unwrap_or(raw);
    let text = resolved.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        Some(text.to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        Some(text)
    }
}

fn project_settings_for_cwd(cwd: Option<&str>) -> Option<serde_json::Value> {
    let cwd_key = project_history_path_key(cwd?)?;
    let index_path = storage_paths::global_root()
        .ok()?
        .join("workspaces")
        .join("index.json");
    let index_text = std::fs::read_to_string(index_path).ok()?;
    let workspaces = serde_json::from_str::<serde_json::Value>(&index_text).ok()?;
    let workspaces = workspaces.as_array()?;
    let workspace = workspaces.iter().find(|workspace| {
        workspace
            .get("path")
            .and_then(|value| value.as_str())
            .and_then(project_history_path_key)
            .is_some_and(|path| path == cwd_key)
    })?;
    workspace
        .pointer("/metadata/projectSettings")
        .cloned()
        .filter(|value| value.is_object())
}

fn project_mcp_server_key(id: &str, used: &mut HashSet<String>) -> String {
    let mut key: String = id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if key.trim_matches('_').is_empty() {
        key = "project-mcp".to_string();
    }
    let base = key.clone();
    let mut suffix = 2;
    while !used.insert(key.clone()) {
        key = format!("{base}-{suffix}");
        suffix += 1;
    }
    key
}

fn project_mcp_settings_json_from_settings(
    settings: &serde_json::Value,
    cwd: Option<&str>,
) -> Option<serde_json::Value> {
    if settings
        .pointer("/mcp/enabled")
        .and_then(|value| value.as_bool())
        == Some(false)
    {
        return None;
    }
    let workspace = cwd.unwrap_or_default().trim();
    let servers = settings.pointer("/mcp/servers")?.as_array()?;
    let mut used = HashSet::new();
    let mut mcp_servers = serde_json::Map::new();
    for server in servers {
        if server.get("enabled").and_then(|value| value.as_bool()) != Some(true) {
            continue;
        }
        let transport = server
            .get("transport")
            .and_then(|value| value.as_str())
            .unwrap_or("stdio")
            .trim();
        let id = server
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or("project-mcp");
        let mut entry = serde_json::Map::new();
        if transport == "stdio" {
            let Some(command) = server
                .get("command")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            entry.insert(
                "command".to_string(),
                serde_json::Value::String(project_expand_path_text(command)),
            );
            if let Some(args) = server.get("args").and_then(|value| value.as_array()) {
                let args = args
                    .iter()
                    .filter_map(|value| value.as_str())
                    .map(|value| serde_json::Value::String(value.replace("{workspace}", workspace)))
                    .collect::<Vec<_>>();
                entry.insert("args".to_string(), serde_json::Value::Array(args));
            }
        } else {
            let Some(url) = server
                .get("url")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            entry.insert(
                "url".to_string(),
                serde_json::Value::String(url.replace("{workspace}", workspace)),
            );
            entry.insert(
                "transport".to_string(),
                serde_json::Value::String(transport.to_string()),
            );
        }
        if let Some(env) = server.get("env").and_then(|value| value.as_object()) {
            let env = env
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| {
                        let value = value.replace("{workspace}", workspace);
                        (key.clone(), value)
                    })
                })
                .filter(|(_key, value)| !value.trim().is_empty())
                .map(|(key, value)| (key, serde_json::Value::String(value)))
                .collect::<serde_json::Map<_, _>>();
            if !env.is_empty() {
                entry.insert("env".to_string(), serde_json::Value::Object(env));
            }
        }
        mcp_servers.insert(
            project_mcp_server_key(id, &mut used),
            serde_json::Value::Object(entry),
        );
    }
    if mcp_servers.is_empty() {
        return None;
    }
    let mut root = serde_json::Map::new();
    root.insert(
        "mcpServers".to_string(),
        serde_json::Value::Object(mcp_servers),
    );
    Some(serde_json::Value::Object(root))
}

fn project_mcp_settings_json(cwd: Option<&str>) -> Option<serde_json::Value> {
    let settings = project_settings_for_cwd(cwd)?;
    project_mcp_settings_json_from_settings(&settings, cwd)
}

fn project_mcp_settings_prefers_unreal_mcp(settings: &serde_json::Value) -> bool {
    settings
        .get("mcpServers")
        .and_then(|value| value.as_object())
        .and_then(|servers| servers.get(UE_MCP_SERVER_ID))
        .and_then(|server| server.get("command"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .is_some_and(|command| !command.is_empty())
}

fn write_project_mcp_settings_value(
    cwd: Option<&str>,
    settings: &serde_json::Value,
) -> Result<TempFileGuard, String> {
    let path = temp_output_path_for_cwd(cwd, "ultragamestudio-project-mcp", "json");
    let bytes = serde_json::to_vec(settings).map_err(|e| format!("生成项目 MCP 配置失败: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("写入项目 MCP 配置失败: {e}"))?;
    Ok(TempFileGuard::new(path))
}

fn gemini_project_mcp_settings_json(cwd: Option<&str>) -> Option<serde_json::Value> {
    let mut settings = project_mcp_settings_json(cwd)?;
    trust_gemini_mcp_servers(&mut settings);
    Some(settings)
}

fn trust_gemini_mcp_servers(settings: &mut serde_json::Value) {
    if let Some(servers) = settings
        .get_mut("mcpServers")
        .and_then(|value| value.as_object_mut())
    {
        for server in servers.values_mut() {
            if let Some(obj) = server.as_object_mut() {
                obj.insert("trust".to_string(), serde_json::Value::Bool(true));
            }
        }
    }
}

fn write_gemini_project_mcp_settings(cwd: Option<&str>) -> Result<Option<TempFileGuard>, String> {
    let Some(settings) = gemini_project_mcp_settings_json(cwd) else {
        return Ok(None);
    };
    let path = temp_output_path_for_cwd(cwd, "ultragamestudio-gemini-project-mcp", "json");
    let bytes =
        serde_json::to_vec(&settings).map_err(|e| format!("生成 Gemini MCP 配置失败: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("写入 Gemini MCP 配置失败: {e}"))?;
    Ok(Some(TempFileGuard::new(path)))
}

fn toml_literal_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn toml_literal_string_array(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn codex_config_key_segment(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        value.to_string()
    } else {
        toml_literal_string(value)
    }
}

fn append_codex_project_mcp_config_args_from_settings(
    args: &mut Vec<String>,
    settings: &serde_json::Value,
) {
    let Some(servers) = settings
        .get("mcpServers")
        .and_then(|value| value.as_object())
    else {
        return;
    };

    if project_mcp_settings_prefers_unreal_mcp(settings) {
        args.push("-c".into());
        args.push("mcp_servers={}".into());
    }

    for (id, server) in servers {
        let Some(command) = server
            .get("command")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let server_key = codex_config_key_segment(id);
        args.push("-c".into());
        args.push(format!(
            "mcp_servers.{server_key}.command={}",
            toml_literal_string(command)
        ));

        let server_args = server
            .get("args")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        args.push("-c".into());
        args.push(format!(
            "mcp_servers.{server_key}.args={}",
            toml_literal_string_array(&server_args)
        ));

        if let Some(env) = server.get("env").and_then(|value| value.as_object()) {
            for (key, value) in env {
                let Some(value) = value.as_str() else {
                    continue;
                };
                args.push("-c".into());
                args.push(format!(
                    "mcp_servers.{server_key}.env.{}={}",
                    codex_config_key_segment(key),
                    toml_literal_string(value)
                ));
            }
        }
    }
}

fn append_codex_project_mcp_config_args(args: &mut Vec<String>, cwd: Option<&str>) {
    if !mcp_enabled() {
        return;
    }
    if let Some(settings) = project_mcp_settings_json(cwd) {
        append_codex_project_mcp_config_args_from_settings(args, &settings);
    }
}

static CLAUDE_BARE_SUPPORT_CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn claude_help_supports_bare(help_text: &str) -> bool {
    help_text.contains("--bare")
}

fn shell_spec_cache_key(shell: &Option<ShellSpec>) -> String {
    shell
        .as_ref()
        .map(|s| {
            format!(
                "{}:{}",
                s.kind.trim(),
                s.path.as_deref().unwrap_or("").trim()
            )
        })
        .unwrap_or_else(|| "direct".to_string())
}

fn command_text_output_with_timeout(
    mut cmd: Command,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let stdout_path = temp_output_path("ultragamestudio-cli-help-stdout", "txt");
    let stderr_path = temp_output_path("ultragamestudio-cli-help-stderr", "txt");
    let _stdout_guard = TempFileGuard::new(stdout_path.clone());
    let _stderr_guard = TempFileGuard::new(stderr_path.clone());
    let stdout_file = std::fs::File::create(&stdout_path)
        .map_err(|e| format!("创建 CLI 探测输出文件失败: {e}"))?;
    let stderr_file = std::fs::File::create(&stderr_path)
        .map_err(|e| format!("创建 CLI 探测错误文件失败: {e}"))?;

    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| format!("启动 CLI 探测失败: {e}"))?;

    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    terminate_child_tree(&mut child);
                    return Err("CLI 探测超时".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                terminate_child_tree(&mut child);
                return Err(format!("等待 CLI 探测失败: {e}"));
            }
        }
    }

    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    Ok(format!("{stdout}\n{stderr}"))
}

fn claude_cli_supports_bare(binary: &str, shell: &Option<ShellSpec>) -> bool {
    let key = format!("{}\0{}", binary, shell_spec_cache_key(shell));
    let cache = CLAUDE_BARE_SUPPORT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some(supported) = cache.get(&key) {
            return *supported;
        }
    }

    let help_args = vec!["--help".to_string()];
    let mut help_cmd = build_launch_command(binary, &help_args, shell);
    help_cmd.env("DISABLE_AUTOUPDATER", "1");
    let help_text = command_text_output_with_timeout(help_cmd, std::time::Duration::from_secs(5))
        .unwrap_or_default();
    let supported = claude_help_supports_bare(&help_text);

    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, supported);
    }
    supported
}

/// Whether to request token-level partial streaming from the claude CLI via
/// `--include-partial-messages`. On by default so assistant text + extended
/// thinking stream as they are generated (matching the interactive CLI's live
/// feel); the plain `-p` stream otherwise emits only one event per *completed*
/// message, leaving the run log blank while a single long answer is composed.
/// Set ULTRAGAMESTUDIO_DISABLE_PARTIAL=1 if a CLI build predates the flag.
fn partial_enabled() -> bool {
    !std::env::var("ULTRAGAMESTUDIO_DISABLE_PARTIAL")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false)
}

/// Read the no-progress timeout override. Set to 0 to disable idle detection.
fn configured_ai_cli_idle_timeout_secs() -> u64 {
    std::env::var("ULTRAGAMESTUDIO_AI_CLI_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|secs| *secs == 0 || *secs >= 30)
        .unwrap_or(DEFAULT_AI_CLI_IDLE_TIMEOUT_SECS)
}

fn ai_cli_idle_timeout_secs(override_secs: Option<u64>) -> u64 {
    if let Ok(raw) = std::env::var("ULTRAGAMESTUDIO_AI_CLI_IDLE_TIMEOUT_SECS") {
        if let Ok(secs) = raw.trim().parse::<u64>() {
            if secs == 0 || secs >= 30 {
                return secs;
            }
        }
    }
    match override_secs.filter(|secs| *secs == 0 || *secs >= 30) {
        Some(0) => 0,
        Some(dynamic) => dynamic,
        None => configured_ai_cli_idle_timeout_secs(),
    }
}

fn touch_activity(last_activity: &Arc<Mutex<std::time::Instant>>) {
    if let Ok(mut current) = last_activity.lock() {
        *current = std::time::Instant::now();
    }
}

fn activity_elapsed(last_activity: &Arc<Mutex<std::time::Instant>>) -> std::time::Duration {
    last_activity
        .lock()
        .map(|current| current.elapsed())
        .unwrap_or_default()
}

fn trim_cli_error_context(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= CLI_ERROR_CONTEXT_LIMIT {
        return trimmed.to_string();
    }
    let mut tail = trimmed
        .chars()
        .rev()
        .take(CLI_ERROR_CONTEXT_LIMIT)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    tail.insert_str(0, "...\n");
    tail
}

fn append_cli_error_context(err: String, output: &str, stderr: &str) -> String {
    let context = if !stderr.trim().is_empty() {
        stderr
    } else {
        output
    };
    let context = trim_cli_error_context(context);
    if context.is_empty() {
        err
    } else {
        format!("{err}\n最近输出:\n{context}")
    }
}

/// Emit a live progress chunk for a given run to the frontend.
fn emit_progress(app: &tauri::AppHandle, run_id: &str, text: &str) {
    let _ = app.emit(
        "ai-cli-progress",
        serde_json::json!({ "runId": run_id, "text": text }),
    );
}

const AI_CLI_PROGRESS_BATCH_INTERVAL_MS: u64 = 75;
const AI_CLI_PROGRESS_BATCH_MAX_BYTES: usize = 16 * 1024;

struct AiCliProgressBatcher<'a> {
    app: &'a tauri::AppHandle,
    run_id: &'a str,
    pending: String,
    last_flush: std::time::Instant,
}

impl<'a> AiCliProgressBatcher<'a> {
    fn new(app: &'a tauri::AppHandle, run_id: &'a str) -> Self {
        Self {
            app,
            run_id,
            pending: String::new(),
            last_flush: std::time::Instant::now(),
        }
    }

    fn push(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.pending.push_str(text);
        if self.pending.len() >= AI_CLI_PROGRESS_BATCH_MAX_BYTES
            || self.last_flush.elapsed()
                >= std::time::Duration::from_millis(AI_CLI_PROGRESS_BATCH_INTERVAL_MS)
        {
            self.flush();
        }
    }

    fn emit_now(&mut self, text: &str) {
        self.flush();
        emit_progress(self.app, self.run_id, text);
        self.last_flush = std::time::Instant::now();
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        emit_progress(self.app, self.run_id, &self.pending);
        self.pending.clear();
        self.last_flush = std::time::Instant::now();
    }
}

fn emit_usage(app: &tauri::AppHandle, run_id: &str, usage: &serde_json::Value) {
    let _ = app.emit(
        "ai-cli-usage",
        serde_json::json!({ "runId": run_id, "usage": usage }),
    );
}

fn ai_cli_result(text: String, usage: &Arc<Mutex<Option<serde_json::Value>>>) -> AiCliResult {
    AiCliResult {
        text,
        usage: usage.lock().ok().and_then(|current| (*current).clone()),
    }
}

/// Summarize a `tool_use` event into one readable progress line, e.g.
/// `🔧 Bash: ls app/src` / `🔧 Glob: **/*.tsx` / `🔧 Read: app/src/core/ir.ts`,
/// so the run log shows *what* the agent is doing, not just the tool name.
/// Retained as a fallback / for the codex text path; the claude path now emits
/// structured `<<UGS_TOOL>>` sentinels instead.
#[allow(dead_code)]
fn summarize_tool_use(name: &str, input: &serde_json::Value) -> String {
    // Prefer the most informative known field; fall back to compact JSON.
    let detail = [
        "command",
        "pattern",
        "file_path",
        "path",
        "query",
        "url",
        "description",
        "prompt",
        "old_string",
        "title",
    ]
    .iter()
    .find_map(|k| {
        input
            .get(*k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    })
    .unwrap_or_else(|| {
        let s = input.to_string();
        if s == "null" {
            String::new()
        } else {
            s
        }
    });

    let detail: String = detail.replace(['\n', '\r'], " ");
    let detail: String = detail.chars().take(200).collect();
    if detail.is_empty() {
        format!("🔧 {name}")
    } else {
        format!("🔧 {name}: {detail}")
    }
}

/// Extract a one-line subject (command/path/pattern) from a tool input object.
fn tool_subject(input: &serde_json::Value) -> String {
    let s = [
        "command",
        "pattern",
        "file_path",
        "path",
        "query",
        "url",
        "description",
    ]
    .iter()
    .find_map(|k| {
        input
            .get(*k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    })
    .unwrap_or_default();
    let s: String = s.replace(['\n', '\r'], " ");
    s.chars().take(200).collect()
}

/// Serialise a structured tool-event patch into an inline sentinel block that
/// the frontend render layer decodes (mirrors src/components/ai/lib/toolEvent.ts).
/// `<`/`>` in the JSON payload are escaped as `<`/`>` (JSON parsing
/// restores them) so a tool result that itself contains the literal sentinel
/// markers can't emit a stray `<<UGS_TOOL_END>>` that prematurely closes the
/// block and leaks the rest of the payload as prose.
fn encode_tool_patch(patch: &serde_json::Value) -> String {
    let payload = patch
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    format!("\n<<UGS_TOOL>>{}<<UGS_TOOL_END>>\n", payload)
}

fn encode_running_status_patch(run_id: &str, elapsed_secs: u64) -> String {
    let patch = serde_json::json!({
        "id": format!("runtime-status-{run_id}"),
        "name": "运行状态",
        "subject": format!("仍在运行…（已 {elapsed_secs}s）"),
        "status": "running",
        "ephemeral": true,
    });
    encode_tool_patch(&patch)
}

/// Cap a tool result body so a huge file read doesn't bloat the message text.
const TOOL_RESULT_CLAMP: usize = 4000;

/// Summarize a `tool_result` block (the `user`-role event that carries a tool's
/// output) into one short, single-line breadcrumb, e.g. `app/src/core/ir.ts …`.
/// `content` may be a bare string or an array of `{type:"text",text}` blocks.
/// Returns an empty string when there is nothing useful to show.
#[allow(dead_code)]
fn summarize_tool_result(block: &serde_json::Value) -> String {
    let raw = match block.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    };
    let one_line = raw.replace(['\n', '\r'], " ");
    let truncated: String = one_line.trim().chars().take(160).collect();
    if truncated.is_empty() {
        return String::new();
    }
    if block
        .get("is_error")
        .and_then(|b| b.as_bool())
        .unwrap_or(false)
    {
        format!("⚠ {truncated}")
    } else {
        truncated
    }
}

/// Flatten a Claude `tool_result.content` (string or `[{type:text,text}]`) into
/// a plain multi-line string for the structured tool event. Unlike
/// {@link summarize_tool_result} this keeps newlines and does NOT clamp or add a
/// `⚠` prefix — the renderer shows the error state from the event `status`.
fn tool_result_raw(block: &serde_json::Value) -> String {
    match block.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[derive(serde::Deserialize)]
struct CodexLiteEvent {
    method: Option<String>,
    #[serde(rename = "type")]
    event_type: Option<String>,
    item: Option<CodexLiteItem>,
    params: Option<CodexLiteParams>,
    turn: Option<CodexLiteTurn>,
    status: Option<String>,
    usage: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct CodexLiteParams {
    item: Option<CodexLiteItem>,
    turn: Option<CodexLiteTurn>,
    usage: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct CodexLiteTurn {
    status: Option<String>,
    usage: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct CodexLiteItem {
    id: Option<String>,
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
    output: Option<String>,
    command: Option<String>,
    name: Option<String>,
    path: Option<String>,
    file_path: Option<String>,
    old_path: Option<String>,
    new_path: Option<String>,
    query: Option<String>,
    status: Option<String>,
    changes: Option<serde_json::Value>,
    files: Option<serde_json::Value>,
    paths: Option<serde_json::Value>,
    edits: Option<serde_json::Value>,
}

impl CodexLiteEvent {
    fn kind(&self) -> Option<&str> {
        self.method.as_deref().or(self.event_type.as_deref())
    }

    fn completed_item(&self) -> Option<&CodexLiteItem> {
        match self.kind() {
            Some("item.completed") | Some("item/completed") => self
                .item
                .as_ref()
                .or_else(|| self.params.as_ref().and_then(|p| p.item.as_ref())),
            _ => None,
        }
    }

    fn turn_completion_status(&self) -> Option<String> {
        match self.kind() {
            Some("turn.completed") | Some("turn/completed") | Some("turn_complete") => {
                let status = self
                    .params
                    .as_ref()
                    .and_then(|p| p.turn.as_ref())
                    .and_then(|t| t.status.as_deref())
                    .or_else(|| self.turn.as_ref().and_then(|t| t.status.as_deref()))
                    .or(self.status.as_deref())
                    .unwrap_or("completed");
                Some(status.to_string())
            }
            _ => None,
        }
    }

    fn turn_usage(&self) -> Option<&serde_json::Value> {
        match self.kind() {
            Some("turn.completed") | Some("turn/completed") | Some("turn_complete") => self
                .usage
                .as_ref()
                .or_else(|| self.params.as_ref().and_then(|p| p.usage.as_ref()))
                .or_else(|| {
                    self.params
                        .as_ref()
                        .and_then(|p| p.turn.as_ref())
                        .and_then(|t| t.usage.as_ref())
                })
                .or_else(|| self.turn.as_ref().and_then(|t| t.usage.as_ref())),
            _ => None,
        }
    }
}

/// Codex CLI JSONL uses `item.completed` events rather than Claude's
/// `assistant` / `result` events. Emit readable agent text and a compact tool
/// breadcrumb when a tool-like item appears. Keep this on the lightweight item
/// shape so large tool output fields are skipped by serde instead of allocated.
fn codex_progress_line(item: &CodexLiteItem) -> Option<String> {
    let item_type = item.item_type.as_deref().unwrap_or("");
    if item_type == "agent_message" {
        return item
            .text
            .as_deref()
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string());
    }

    if item_type.is_empty() {
        return None;
    }

    let detail = item
        .command
        .as_deref()
        .or(item.name.as_deref())
        .or(item.path.as_deref())
        .or(item.file_path.as_deref())
        .or(item.query.as_deref())
        .or(item.text.as_deref())
        .or(item.status.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.replace(['\n', '\r'], " "))
        .unwrap_or_default();

    let detail: String = detail.chars().take(200).collect();
    if detail.is_empty() {
        Some(format!("\n🔧 {item_type}\n"))
    } else {
        Some(format!("\n🔧 {item_type}: {detail}\n"))
    }
}

fn insert_codex_arg_string(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &Option<String>,
) {
    if let Some(value) = value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        map.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
}

fn insert_codex_arg_value(
    map: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &Option<serde_json::Value>,
) {
    if let Some(value) = value {
        if !value.is_null() {
            map.insert(key.to_string(), value.clone());
        }
    }
}

fn codex_tool_subject(item: &CodexLiteItem) -> String {
    let detail = item
        .command
        .as_deref()
        .or(item.name.as_deref())
        .or(item.path.as_deref())
        .or(item.file_path.as_deref())
        .or(item.query.as_deref())
        .or(item.text.as_deref())
        .or(item.status.as_deref())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.replace(['\n', '\r'], " "))
        .unwrap_or_default();
    detail.chars().take(200).collect()
}

fn codex_tool_args(item: &CodexLiteItem) -> Option<serde_json::Value> {
    let mut map = serde_json::Map::new();
    insert_codex_arg_string(&mut map, "id", &item.id);
    insert_codex_arg_string(&mut map, "type", &item.item_type);
    insert_codex_arg_string(&mut map, "command", &item.command);
    insert_codex_arg_string(&mut map, "name", &item.name);
    insert_codex_arg_string(&mut map, "path", &item.path);
    insert_codex_arg_string(&mut map, "file_path", &item.file_path);
    insert_codex_arg_string(&mut map, "old_path", &item.old_path);
    insert_codex_arg_string(&mut map, "new_path", &item.new_path);
    insert_codex_arg_string(&mut map, "query", &item.query);
    insert_codex_arg_string(&mut map, "status", &item.status);
    insert_codex_arg_value(&mut map, "changes", &item.changes);
    insert_codex_arg_value(&mut map, "files", &item.files);
    insert_codex_arg_value(&mut map, "paths", &item.paths);
    insert_codex_arg_value(&mut map, "edits", &item.edits);
    (!map.is_empty()).then_some(serde_json::Value::Object(map))
}

fn codex_tool_patch(item: &CodexLiteItem, fallback_id: String) -> Option<serde_json::Value> {
    let item_type = item.item_type.as_deref().unwrap_or("");
    if item_type.is_empty() || item_type == "agent_message" {
        return None;
    }
    let result_raw = item
        .output
        .as_deref()
        .or(item.text.as_deref())
        .unwrap_or("");
    let truncated = result_raw.chars().count() > TOOL_RESULT_CLAMP;
    let result: String = result_raw.chars().take(TOOL_RESULT_CLAMP).collect();
    let is_error = item
        .status
        .as_deref()
        .map(|status| {
            let status = status.to_ascii_lowercase();
            status.contains("error") || status.contains("fail")
        })
        .unwrap_or(false);
    let mut patch = serde_json::json!({
        "id": item.id.clone().unwrap_or(fallback_id),
        "name": item_type,
        "subject": codex_tool_subject(item),
        "status": if is_error { "error" } else { "done" },
        "result": result,
        "truncated": truncated,
    });
    if let Some(args) = codex_tool_args(item) {
        patch["args"] = args;
    }
    Some(patch)
}

fn codex_status_success(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "success" | "succeeded" | "ok"
    )
}

/// Extract the cumulative token usage from a claude `stream-json` event. The
/// `result` event nests it under `/usage`, while `assistant` events carry it on
/// `/message/usage`. Either object includes `input_tokens`, `output_tokens` and
/// the `cache_read_input_tokens` / `cache_creation_input_tokens` cache counters.
fn claude_message_usage(event: &serde_json::Value) -> Option<serde_json::Value> {
    let usage = event
        .get("usage")
        .or_else(|| event.pointer("/message/usage"))?;
    if !usage.is_object() {
        return None;
    }
    // Ignore empty/zeroed usage objects so we don't clobber a real snapshot
    // with a placeholder that would render as 0%.
    let has_tokens = [
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ]
    .iter()
    .any(|key| {
        usage
            .get(*key)
            .and_then(|v| v.as_u64())
            .is_some_and(|n| n > 0)
    });
    if !has_tokens {
        return None;
    }
    Some(usage.clone())
}

fn codex_last_message_ready(path: &std::path::Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if meta.len() == 0 {
        return false;
    }
    meta.modified()
        .and_then(|modified| modified.elapsed().map_err(std::io::Error::other))
        .map(|elapsed| elapsed >= std::time::Duration::from_secs(1))
        .unwrap_or(false)
}

fn codex_sidecar_output(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn remove_codex_sidecar(path: &Option<PathBuf>) {
    if let Some(path) = path.as_ref() {
        let _ = std::fs::remove_file(path);
    }
}

/// The UI currently exposes Claude model tiers (`haiku` / `sonnet` / `opus`).
/// Passing those through to Codex would fail, so only forward explicit non-
#[tauri::command]
fn cancel_ai_cli(run_id: String) -> Result<(), String> {
    if let Some(pid) = mark_ai_cli_cancelled(&run_id) {
        let _ = terminate_process_tree(pid);
    }
    Ok(())
}

fn workspace_dir_key(path: &Path) -> String {
    let text = display_preview_path(path).replace('\\', "/");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn normalize_extra_workspace_paths(
    cwd: Option<&str>,
    extra_workspace_paths: Option<Vec<String>>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    if let Some(dir) = cwd.map(str::trim).filter(|dir| !dir.is_empty()) {
        let path = Path::new(dir);
        if path.is_dir() {
            seen.insert(workspace_dir_key(path));
        }
    }

    let mut out = Vec::new();
    for raw in extra_workspace_paths.unwrap_or_default() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let path = Path::new(trimmed);
        if !path.is_dir() {
            continue;
        }
        let key = workspace_dir_key(path);
        if seen.insert(key) {
            out.push(display_preview_path(path));
        }
    }
    out
}

/// Run a prompt through the locally-installed agent CLI (e.g. `claude`) using the
/// machine's own environment/credentials — no API key is passed from the app.
///
/// Uses `claude -p "<prompt>" --output-format stream-json --verbose
/// --include-partial-messages` so that:
///   - token-level partial deltas (assistant text + extended thinking), tool
///     uses, tool results (with durations) and the opening `init` event all
///     stream to the frontend via the `ai-cli-progress` event (tagged with
///     `run_id`) — the run no longer looks frozen while a node is working; a
///     "still running" heartbeat covers any remaining silent gap; and
///   - the clean final answer is taken from the terminal `result` event.
/// The optional `model` maps the node's model tier (haiku/sonnet/opus) onto
/// `--model`. stdin is closed; the call is bounded by a timeout that kills the
/// child so a stuck CLI surfaces an error instead of hanging "运行中" forever.
#[tauri::command]
async fn ai_cli(
    prompt: String,
    adapter: String,
    cli_command: Option<String>,
    model: Option<String>,
    cwd: Option<String>,
    extra_workspace_paths: Option<Vec<String>>,
    permission: Option<String>,
    env_vars: Option<HashMap<String, String>>,
    timeout_seconds: Option<u64>,
    idle_timeout_seconds: Option<u64>,
    run_id: String,
    // Optional Claude session continuity (claude only): when `session_id` is set
    // and `resume` is false the run *creates* that session (`--session-id`); when
    // `resume` is true it *continues* it (`--resume`), inheriting the prior
    // call's full context so a downstream step needn't re-explore the project.
    session_id: Option<String>,
    resume: Option<bool>,
    // Optional launch shell wrapping (from the General settings "启动 Shell").
    shell: Option<ShellSpec>,
    app: tauri::AppHandle,
) -> Result<AiCliResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<AiCliResult, String> {
        let env_vars = normalize_spawn_env(env_vars);
        let progress_model_hint = gateway_progress_model_hint(env_vars.as_ref());
        let extra_workspace_paths =
            normalize_extra_workspace_paths(cwd.as_deref(), extra_workspace_paths);
        // Telling the CLI about extra dirs via `--add-dir` only *authorizes*
        // access; it does not *inform* the model those folders exist. Without
        // this, a model that greps the primary cwd and finds nothing concludes
        // "not found" even though (e.g.) the engine source lives in a second
        // configured workspace folder. So when a session has extra workspace
        // folders, inject a short note describing them. Only do this on the
        // session's first turn (`resume == false`): a resumed claude session
        // already carries this note in its warm context, so re-sending it every
        // turn would just be noise.
        let extra_workspace_note = if extra_workspace_paths.is_empty() {
            String::new()
        } else {
            format!(
                "附加工作区目录（与主工作目录同属本次会话上下文，已授予访问权限）：\n{}\n跨项目/引擎源码搜索时，请同时检索这些目录的绝对路径，不要仅因主工作目录未命中就判定“找不到”。",
                extra_workspace_paths
                    .iter()
                    .map(|path| format!("- {path}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let inject_extra_workspace_note =
            !extra_workspace_note.is_empty() && !resume.unwrap_or(false);
        let binary = match cli_command
            .as_deref()
            .map(cli_runtime::normalize_cli_command_override)
            .transpose()?
        {
            Some(binary) => binary,
            None => cli_runtime::adapter_binary(&adapter).to_string(),
        };
        let protocol = cli_runtime::adapter_protocol(&adapter);
        let is_codex = protocol == "codex";
        let is_gemini = protocol == "gemini";
        let codex_last_message_path = if is_codex {
            Some(temp_output_path_for_cwd(
                cwd.as_deref(),
                "ultragamestudio-codex-last",
                "txt",
            ))
        } else {
            None
        };

        // Self-heal a claude binary that an interrupted auto-update corrupted.
        if protocol == "claude" {
            repair_claude_binary();
        }

        // Collect the program arguments first so the whole invocation can be
        // optionally wrapped in a launch shell (see build_launch_command). Env
        // vars and the working directory are applied to the final (outer)
        // command below and inherited by any wrapped child.
        let mut args: Vec<String> = Vec::new();
        let mut workdir: Option<std::path::PathBuf> = None;
        let mut disable_autoupdater = false;
        let mut temp_files: Vec<TempFileGuard> = Vec::new();
        let mut gemini_system_settings_path: Option<String> = None;

        if is_codex {
            // Codex's non-interactive surface is `codex exec`, and its JSON
            // stream is enabled with `--json`. It has no Claude-style
            // `--output-format`, which was the source of the reported failure.
            match permission.as_deref().unwrap_or("full") {
                "readonly" => {
                    args.push("-a".into());
                    args.push("never".into());
                }
                "ask" => {
                    args.push("-a".into());
                    args.push("on-request".into());
                }
                _ => {}
            }

            args.push("exec".into());
            append_codex_project_mcp_config_args(&mut args, cwd.as_deref());
            args.push("--json".into());
            args.push("--skip-git-repo-check".into());

            match permission.as_deref().unwrap_or("full") {
                "readonly" => {
                    args.push("--sandbox".into());
                    args.push("read-only".into());
                }
                "ask" => {
                    args.push("--sandbox".into());
                    args.push("workspace-write".into());
                }
                _ => {
                    args.push("--dangerously-bypass-approvals-and-sandbox".into());
                }
            }

            if let Some(m) = model.as_deref().filter(|m| cli_runtime::should_pass_model(&adapter, m)) {
                args.push("--model".into());
                args.push(m.to_string());
            }

            if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    workdir = Some(p.to_path_buf());
                    args.push("-C".into());
                    args.push(dir.to_string());
                }
            }
            for dir in &extra_workspace_paths {
                args.push("--add-dir".into());
                args.push(dir.clone());
            }

            if let Some(path) = codex_last_message_path.as_ref() {
                args.push("-o".into());
                args.push(path.to_string_lossy().to_string());
            }
            args.push("-".into());
        } else if is_gemini {
            // Gemini CLI has its own headless/MCP flags. The prompt still goes
            // through stdin; an empty --prompt enables non-interactive mode
            // without hitting command-line length limits.
            args.push("--prompt".into());
            args.push(String::new());
            args.push("--output-format".into());
            args.push("stream-json".into());

            if mcp_enabled() {
                if let Some(project_mcp_file) =
                    write_gemini_project_mcp_settings(cwd.as_deref())?
                {
                    gemini_system_settings_path =
                        Some(project_mcp_file.path().to_string_lossy().to_string());
                    temp_files.push(project_mcp_file);
                }
            }

            if let Some(m) = model
                .as_deref()
                .filter(|m| cli_runtime::should_pass_model(&adapter, m))
            {
                args.push("--model".into());
                args.push(m.to_string());
            }

            match permission.as_deref().unwrap_or("full") {
                "readonly" => {
                    args.push("--approval-mode".into());
                    args.push("plan".into());
                }
                "ask" => {}
                _ => {
                    args.push("--approval-mode".into());
                    args.push("yolo".into());
                }
            }

            if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    workdir = Some(p.to_path_buf());
                }
            }
            for dir in &extra_workspace_paths {
                args.push("--include-directories".into());
                args.push(dir.clone());
            }
        } else {
            // The prompt is fed via stdin (not a positional arg) so large
            // aggregation prompts can't hit the OS command-line length limit
            // (~32KB on Windows), which would stall the final "summary" node.
            args.push("-p".into());
            args.push("--output-format".into());
            args.push("stream-json".into());
            args.push("--verbose".into());
            // Free/relay channels inject their own Anthropic-compatible key and
            // base URL. Use Claude Code's minimal print mode when available so
            // user-level plugins/hooks (especially SessionEnd hooks) cannot
            // turn a successful model call into exit=1. Older Claude builds do
            // not know `--bare`, so probe once and fall back automatically.
            if should_run_claude_bare(env_vars.as_ref())
                && claude_cli_supports_bare(&binary, &shell)
            {
                args.push("--bare".into());
            }
            if let Some(settings_file) =
                write_claude_gateway_settings(env_vars.as_ref(), cwd.as_deref())?
            {
                args.push("--settings".into());
                args.push(settings_file.path().to_string_lossy().to_string());
                temp_files.push(settings_file);
            }
            // Token-level streaming so the run log fills in as text/thinking is
            // generated, instead of staying blank until a whole message lands.
            if partial_enabled() {
                args.push("--include-partial-messages".into());
            }
            // Don't let the CLI auto-update mid-run: an interrupted update can
            // leave the binary corrupted ("bin executable does not exist").
            disable_autoupdater = true;

            // MCP is loaded for each node by default so workflow nodes share
            // the same MCP tools as a hand-run `claude` (e.g. pencil
            // `mcp__pencil__...`). For UE projects configured with
            // `ue-mcp-for-all-versions`, use the project MCP config strictly so
            // global/engine UE MCP servers cannot compete with the preferred one.
            // With no `--mcp-config`, `--strict-mcp-config` means "none", so that
            // flag remains the explicit-disable path below.
            if mcp_enabled() {
                if let Some(project_mcp_settings) = project_mcp_settings_json(cwd.as_deref()) {
                    let prefer_unreal_mcp =
                        project_mcp_settings_prefers_unreal_mcp(&project_mcp_settings);
                    let project_mcp_file =
                        write_project_mcp_settings_value(cwd.as_deref(), &project_mcp_settings)?;
                    args.push("--mcp-config".into());
                    args.push(project_mcp_file.path().to_string_lossy().to_string());
                    if prefer_unreal_mcp {
                        args.push("--strict-mcp-config".into());
                    }
                    temp_files.push(project_mcp_file);
                }
            } else {
                args.push("--strict-mcp-config".into());
            }

            // Session continuity: continue a prior session (warm context) or
            // create a known one so a later step can continue it.
            if let Some(sid) = session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if resume.unwrap_or(false) {
                    args.push("--resume".into());
                    args.push(sid.to_string());
                } else {
                    args.push("--session-id".into());
                    args.push(sid.to_string());
                }
            }
            if let Some(m) = model.as_deref().filter(|m| cli_runtime::should_pass_model(&adapter, m)) {
                args.push("--model".into());
                args.push(m.to_string());
            }

            // Permission mode (from the AIDock dropdown) so a headless run can
            // act without stalling on permission prompts:
            //   full      -> skip all prompts (read/write/bash autonomously)
            //   readonly  -> plan mode (explore + report, no mutations)
            //   ask       -> default (may print a permission question)
            match permission.as_deref().unwrap_or("full") {
                "readonly" => {
                    args.push("--permission-mode".into());
                    args.push("plan".into());
                }
                "ask" => {}
                _ => {
                    args.push("--dangerously-skip-permissions".into());
                }
            }

            // Working directory: run in the user's chosen workspace so the
            // agent explores the right project (and add it as an allowed dir).
            if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    workdir = Some(p.to_path_buf());
                    args.push("--add-dir".into());
                    args.push(dir.to_string());
                }
            }
            for dir in &extra_workspace_paths {
                args.push("--add-dir".into());
                args.push(dir.clone());
            }
            if inject_extra_workspace_note {
                args.push("--append-system-prompt".into());
                args.push(extra_workspace_note.clone());
            }
        }

        let mut cmd = build_launch_command(&binary, &args, &shell);
        if let Some(env_vars) = env_vars.as_ref() {
            for (key, value) in env_vars {
                if !key.trim().is_empty() {
                    cmd.env(key, value);
                }
            }
        }
        if disable_autoupdater {
            cmd.env("DISABLE_AUTOUPDATER", "1");
        }
        if let Some(path) = gemini_system_settings_path.as_deref() {
            cmd.env("GEMINI_CLI_SYSTEM_SETTINGS_PATH", path);
        }
        if let Some(dir) = workdir.as_ref() {
            cmd.current_dir(dir);
        }

        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!("无法启动 CLI \"{binary}\"：请确认它已安装并在 PATH 中。({e})")
            })?;
        register_ai_cli(&run_id, child.id());
        let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));

        // Write the prompt to stdin on its own thread (so a large prompt can't
        // deadlock against a full pipe), then close stdin to signal EOF.
        let mut stdin_pipe = child.stdin.take();
        // Codex/Gemini have no `--append-system-prompt`, so the extra-workspace
        // note (claude gets it as a system-prompt arg above) is prepended to the
        // prompt fed over stdin instead.
        let prompt = if inject_extra_workspace_note && (is_codex || is_gemini) {
            format!("{extra_workspace_note}\n\n{prompt}")
        } else {
            prompt
        };
        let prompt_bytes = prompt.into_bytes();
        let stdin_handle = std::thread::spawn(move || {
            if let Some(mut s) = stdin_pipe.take() {
                let _ = s.write_all(&prompt_bytes);
            }
        });

        // Reader thread: parse the JSONL stream, emit progress, capture the result.
        let stdout = child.stdout.take();
        let app2 = app.clone();
        let run2 = run_id.clone();
        let parse_codex = is_codex;
        let parse_gemini = is_gemini;
        let progress_model_hint2 = progress_model_hint.clone();
        let codex_turn_status = Arc::new(Mutex::new(None::<String>));
        let codex_turn_status_reader = Arc::clone(&codex_turn_status);
        let codex_usage = Arc::new(Mutex::new(None::<serde_json::Value>));
        let codex_usage_reader = Arc::clone(&codex_usage);
        // Claude's stream-json reports cumulative token usage (including cache
        // read/creation hits) on assistant/result events. Capture it so the
        // status bar can show the real cache percentage instead of `--`.
        let claude_usage = Arc::new(Mutex::new(None::<serde_json::Value>));
        let claude_usage_reader = Arc::clone(&claude_usage);
        let codex_streamed_output = Arc::new(Mutex::new(String::new()));
        let codex_streamed_output_reader = Arc::clone(&codex_streamed_output);
        let stdout_activity = Arc::clone(&last_activity);
        // Claude/Gemini stream-json emit a terminal `result` event once the turn
        // is logically done. The process itself can linger afterward (lingering
        // MCP servers / child processes), so polling `try_wait` alone can spin
        // until the global timeout even though the answer is fully streamed.
        // The reader sets this flag on the terminal event so the wait loop can
        // break early and gracefully terminate the (already finished) process.
        let stream_result_seen = Arc::new(AtomicBool::new(false));
        let stream_result_seen_reader = Arc::clone(&stream_result_seen);
        let partial_streaming = partial_enabled();
        let out_handle = std::thread::spawn(move || -> String {
            let mut result = String::new();
            let mut acc = String::new();
            // `prev_kind` tracks the last delta kind ("text" / "thinking") so we
            // can insert a separator when the model switches between them.
            let mut prev_kind: &str = "";
            // tool_use id → start time, so a tool_result can report its duration.
            let mut tool_starts: HashMap<String, std::time::Instant> = HashMap::new();
            let mut init_done = false;
            // Surface the `requesting` status once so the gap between session
            // init and the first token isn't filled only by "still running"
            // heartbeats (a slow first token on a cold/large request can take
            // tens of seconds). Emitted at most once per run.
            let mut requesting_done = false;
            let mut progress = AiCliProgressBatcher::new(&app2, &run2);
            if let Some(o) = stdout {
                let mut reader = std::io::BufReader::new(o);
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line) {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(_) => break,
                    }
                    let line = line.trim_end_matches(['\r', '\n']);
                    touch_activity(&stdout_activity);
                    if line.trim().is_empty() {
                        continue;
                    }
                    if parse_codex {
                        let event: CodexLiteEvent = match serde_json::from_str(&line) {
                            Ok(event) => event,
                            Err(_) => continue,
                        };
                        if let Some(usage) = event.turn_usage() {
                            if let Ok(mut current) = codex_usage_reader.lock() {
                                *current = Some(usage.clone());
                            }
                            emit_usage(&app2, &run2, usage);
                        }
                        if let Some(status) = event.turn_completion_status() {
                            if let Ok(mut current) = codex_turn_status_reader.lock() {
                                *current = Some(status);
                            }
                            continue;
                        }
                        if let Some(item) = event.completed_item() {
                            if item.item_type.as_deref() == Some("agent_message") {
                                let Some(line) = codex_progress_line(item) else {
                                    continue;
                                };
                                acc.push_str(&line);
                                if let Ok(mut current) = codex_streamed_output_reader.lock() {
                                    current.push_str(&line);
                                }
                                progress.emit_now(&line);
                            } else if let Some(patch) =
                                codex_tool_patch(item, format!("cx{}", tool_starts.len()))
                            {
                                tool_starts.insert(
                                    patch
                                        .get("id")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    std::time::Instant::now(),
                                );
                                progress.emit_now(&encode_tool_patch(&patch));
                            }
                        }
                        continue;
                    }
                    let v: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if parse_gemini {
                        match v.get("type").and_then(|t| t.as_str()) {
                            Some("init") => {
                                if !init_done {
                                    init_done = true;
                                    let model = progress_model_hint2
                                        .as_deref()
                                        .or_else(|| v.get("model").and_then(|m| m.as_str()))
                                        .unwrap_or("");
                                    let line = if model.is_empty() {
                                        "⚙ 会话已启动，开始处理…".to_string()
                                    } else {
                                        format!("⚙ 会话已启动（{model}），开始处理…")
                                    };
                                    progress.emit_now(&format!("{line}\n"));
                                }
                            }
                            Some("message") => {
                                if v.get("role").and_then(|role| role.as_str())
                                    == Some("assistant")
                                {
                                    if let Some(tx) =
                                        v.get("content").and_then(|content| content.as_str())
                                    {
                                        acc.push_str(tx);
                                        progress.push(tx);
                                    }
                                }
                            }
                            Some("tool_use") => {
                                let name = v
                                    .get("tool_name")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("tool");
                                let id = v
                                    .get("tool_id")
                                    .and_then(|value| value.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| format!("t{}", tool_starts.len()));
                                let input = v
                                    .get("parameters")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                tool_starts
                                    .insert(id.clone(), std::time::Instant::now());
                                let mut patch = serde_json::json!({
                                    "id": id,
                                    "name": name,
                                    "subject": tool_subject(&input),
                                    "status": "running",
                                });
                                if !input.is_null() {
                                    patch["args"] = input;
                                }
                                progress.emit_now(&encode_tool_patch(&patch));
                            }
                            Some("tool_result") => {
                                let id = v
                                    .get("tool_id")
                                    .and_then(|value| value.as_str())
                                    .unwrap_or("");
                                if !id.is_empty() {
                                    let dur_ms = tool_starts
                                        .remove(id)
                                        .map(|start| start.elapsed().as_millis() as u64);
                                    let is_error = v
                                        .get("status")
                                        .and_then(|value| value.as_str())
                                        .map(|status| status != "success")
                                        .unwrap_or(false);
                                    let result_body = v
                                        .get("output")
                                        .and_then(|value| value.as_str())
                                        .map(|value| value.to_string())
                                        .or_else(|| {
                                            v.pointer("/error/message")
                                                .and_then(|value| value.as_str())
                                                .map(|value| value.to_string())
                                        })
                                        .unwrap_or_default();
                                    let truncated =
                                        result_body.chars().count() > TOOL_RESULT_CLAMP;
                                    let result_text: String = result_body
                                        .chars()
                                        .take(TOOL_RESULT_CLAMP)
                                        .collect();
                                    let patch = serde_json::json!({
                                        "id": id,
                                        "status": if is_error { "error" } else { "done" },
                                        "durationMs": dur_ms,
                                        "result": result_text,
                                        "truncated": truncated,
                                    });
                                    progress.emit_now(&encode_tool_patch(&patch));
                                }
                            }
                            Some("error") => {
                                if let Some(message) =
                                    v.get("message").and_then(|value| value.as_str())
                                {
                                    progress.emit_now(&format!("\n⚠ {message}\n"));
                                }
                            }
                            _ => {}
                        }
                        continue;
                    }
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("system") => {
                            // The opening `init` event is the first "I'm alive"
                            // signal — surface it so cold-start latency isn't blank.
                            if !init_done
                                && v.get("subtype").and_then(|s| s.as_str()) == Some("init")
                            {
                                init_done = true;
                                let model = progress_model_hint2
                                    .as_deref()
                                    .or_else(|| v.get("model").and_then(|m| m.as_str()))
                                    .unwrap_or("");
                                let line = if model.is_empty() {
                                    "⚙ 会话已启动，开始处理…".to_string()
                                } else {
                                    format!("⚙ 会话已启动（{model}），开始处理…")
                                };
                                progress.emit_now(&format!("{line}\n"));
                            } else if !requesting_done
                                && v.get("subtype").and_then(|s| s.as_str()) == Some("status")
                                && v.get("status").and_then(|s| s.as_str()) == Some("requesting")
                            {
                                // Between init and the first token the CLI is
                                // waiting on the model. Show it once so a slow
                                // first token reads as "requesting" rather than a
                                // silent gap padded by heartbeats.
                                requesting_done = true;
                                progress.emit_now("⏳ 正在请求模型…\n");
                            }
                        }
                        Some("stream_event") => {
                            // Token-level partial deltas: live display ONLY. The
                            // authoritative text is still captured from the complete
                            // `assistant` / `result` events below, so we never push
                            // a partial chunk into `acc` (that would double-count).
                            if let Some(ev) = v.get("event") {
                                let ev_type =
                                    ev.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                if ev_type == "content_block_delta" {
                                    if let Some(delta) = ev.get("delta") {
                                        match delta.get("type").and_then(|t| t.as_str()) {
                                            Some("text_delta") => {
                                                if let Some(tx) =
                                                    delta.get("text").and_then(|t| t.as_str())
                                                {
                                                    if prev_kind == "thinking" {
                                                        progress.emit_now("</think>");
                                                    }
                                                    prev_kind = "text";
                                                    progress.push(tx);
                                                }
                                            }
                                            Some("thinking_delta") => {
                                                if let Some(tx) = delta
                                                    .get("thinking")
                                                    .and_then(|t| t.as_str())
                                                {
                                                    if prev_kind != "thinking" {
                                                        progress.emit_now("<think>");
                                                    }
                                                    prev_kind = "thinking";
                                                    progress.push(tx);
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                        }
                        Some("assistant") => {
                            // Capture per-turn usage as a fallback; the terminal
                            // `result` event usually carries the authoritative
                            // cumulative figure but some CLI versions only report
                            // it on assistant messages.
                            if let Some(usage) = claude_message_usage(&v) {
                                if let Ok(mut current) = claude_usage_reader.lock() {
                                    *current = Some(usage);
                                }
                            }
                            if let Some(content) =
                                v.pointer("/message/content").and_then(|c| c.as_array())
                            {
                                for block in content {
                                    match block.get("type").and_then(|t| t.as_str()) {
                                        Some("text") => {
                                            if let Some(tx) =
                                                block.get("text").and_then(|t| t.as_str())
                                            {
                                                // Capture for the fallback return
                                                // value. When partial streaming is on
                                                // it was already shown live via deltas,
                                                // so don't re-emit (avoids duplication).
                                                acc.push_str(tx);
                                                if !partial_streaming {
                                                    if prev_kind == "thinking" {
                                                        progress.emit_now("</think>");
                                                    }
                                                    progress.push(tx);
                                                }
                                            }
                                        }
                                        Some("tool_use") => {
                                            let name = block
                                                .get("name")
                                                .and_then(|t| t.as_str())
                                                .unwrap_or("tool");
                                            let input = block
                                                .get("input")
                                                .cloned()
                                                .unwrap_or(serde_json::Value::Null);
                                            let id = block
                                                .get("id")
                                                .and_then(|t| t.as_str())
                                                .map(|s| s.to_string())
                                                .unwrap_or_else(|| {
                                                    format!("t{}", tool_starts.len())
                                                });
                                            tool_starts.insert(
                                                id.clone(),
                                                std::time::Instant::now(),
                                            );
                                            if prev_kind == "thinking" {
                                                progress.emit_now("</think>");
                                            }
                                            prev_kind = "";
                                            // Structured sentinel for the rich card.
                                            // Omit `args` when there is no input
                                            // so the card shows no empty JSON panel.
                                            let mut patch = serde_json::json!({
                                                "id": id,
                                                "name": name,
                                                "subject": tool_subject(&input),
                                                "status": "running",
                                            });
                                            if !input.is_null() {
                                                patch["args"] = input;
                                            }
                                            progress.emit_now(&encode_tool_patch(&patch));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        Some("user") => {
                            // Tool results arrive as a `user`-role message. Show a
                            // truncated breadcrumb + the tool's wall-clock duration so
                            // a long Bash/Read/test is no longer a silent gap.
                            if let Some(content) =
                                v.pointer("/message/content").and_then(|c| c.as_array())
                            {
                                for block in content {
                                    if block.get("type").and_then(|t| t.as_str())
                                        != Some("tool_result")
                                    {
                                        continue;
                                    }
                                    let id = block
                                        .get("tool_use_id")
                                        .and_then(|t| t.as_str())
                                        .unwrap_or("");
                                    let dur_ms = tool_starts
                                        .remove(id)
                                        .map(|start| start.elapsed().as_millis() as u64);
                                    let is_error = block
                                        .get("is_error")
                                        .and_then(|t| t.as_bool())
                                        .unwrap_or(false);
                                    let raw = tool_result_raw(block);
                                    let truncated = raw.chars().count() > TOOL_RESULT_CLAMP;
                                    let result_body: String =
                                        raw.chars().take(TOOL_RESULT_CLAMP).collect();
                                    if prev_kind == "thinking" {
                                        progress.emit_now("</think>");
                                    }
                                    prev_kind = "";
                                    if !id.is_empty() {
                                        let patch = serde_json::json!({
                                            "id": id,
                                            "status": if is_error { "error" } else { "done" },
                                            "durationMs": dur_ms,
                                            "result": result_body,
                                            "truncated": truncated,
                                        });
                                        progress.emit_now(&encode_tool_patch(&patch));
                                    }
                                }
                            }
                        }
                        Some("result") => {
                            if let Some(r) = v.get("result").and_then(|t| t.as_str()) {
                                result = r.to_string();
                            }
                            // The terminal `result` event carries the final
                            // cumulative usage (input/output + cache_read/creation).
                            // Prefer it over per-assistant snapshots.
                            if let Some(usage) = claude_message_usage(&v) {
                                if let Ok(mut current) = claude_usage_reader.lock() {
                                    *current = Some(usage.clone());
                                }
                                emit_usage(&app2, &run2, &usage);
                            }
                            progress.flush();
                            // Signal the wait loop that the turn is logically
                            // complete so it needn't wait on a lingering process.
                            stream_result_seen_reader.store(true, Ordering::Relaxed);
                        }
                        _ => {}
                    }
                }
            }
            progress.flush();
            if result.trim().is_empty() {
                acc
            } else {
                result
            }
        });

        let mut err_pipe = child.stderr.take();
        let stderr_activity = Arc::clone(&last_activity);
        let err_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(p) = err_pipe.as_mut() {
                let mut chunk = [0_u8; 4096];
                loop {
                    match p.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            touch_activity(&stderr_activity);
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        Err(_) => break,
                    }
                }
            }
            buf
        });

        // Poll for exit until the deadline; kill on timeout. Even timeout and
        // wait-error paths fall through to the common cleanup below so reader
        // threads finish and Codex side-channel files do not linger in temp.
        enum WaitOutcome {
            Exited(std::process::ExitStatus),
            CodexTurnCompleted(String),
            CodexLastMessageReady,
            // claude/gemini emitted their terminal `result` event but the process
            // is lingering; treat the turn as successfully completed.
            StreamCompleted,
        }

        let timeout_secs = ai_cli_timeout_secs(timeout_seconds);
        let idle_timeout_secs = ai_cli_idle_timeout_secs(idle_timeout_seconds);
        let idle_timeout = (idle_timeout_secs > 0)
            .then(|| std::time::Duration::from_secs(idle_timeout_secs));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
        let mut last_sidecar_len = 0_u64;
        let mut last_sidecar_modified: Option<std::time::SystemTime> = None;
        let run_started_at = std::time::Instant::now();
        let mut last_heartbeat = run_started_at;
        // When the stream's terminal `result` event arrives, give the process a
        // short grace period to exit on its own (preferring the normal Exited
        // path). If it lingers past the grace window, break early so a hung
        // child (e.g. an MCP server that never exits) can't stall the turn.
        let stream_complete_grace = std::time::Duration::from_secs(3);
        let mut stream_complete_at: Option<std::time::Instant> = None;
        let wait_result = loop {
            if is_codex {
                let status = codex_turn_status
                    .lock()
                    .ok()
                    .and_then(|current| current.clone());
                if let Some(status) = status {
                    terminate_child_tree(&mut child);
                    break Ok(WaitOutcome::CodexTurnCompleted(status));
                }
                if let Some(path) = codex_last_message_path.as_deref() {
                    if let Ok(meta) = std::fs::metadata(path) {
                        let modified = meta.modified().ok();
                        if meta.len() != last_sidecar_len || modified != last_sidecar_modified {
                            last_sidecar_len = meta.len();
                            last_sidecar_modified = modified;
                            touch_activity(&last_activity);
                        }
                    }
                }
                if codex_last_message_path
                    .as_deref()
                    .is_some_and(codex_last_message_ready)
                {
                    terminate_child_tree(&mut child);
                    break Ok(WaitOutcome::CodexLastMessageReady);
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(WaitOutcome::Exited(status)),
                Ok(None) => {
                    // Stream-json (claude/gemini) signalled its terminal result.
                    // Allow a short grace for a clean self-exit, then break early
                    // so a lingering child process can't stall the finished turn.
                    if !is_codex && stream_result_seen.load(Ordering::Relaxed) {
                        let since = stream_complete_at
                            .get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() >= stream_complete_grace {
                            terminate_child_tree(&mut child);
                            break Ok(WaitOutcome::StreamCompleted);
                        }
                    }
                    if std::time::Instant::now() >= deadline {
                        terminate_child_tree(&mut child);
                        break Err(format!("CLI \"{binary}\" 超时（{timeout_secs}s）已终止。"));
                    }
                    if let Some(idle) = idle_timeout {
                        if activity_elapsed(&last_activity) >= idle {
                            terminate_child_tree(&mut child);
                            break Err(format!(
                                "CLI \"{binary}\" 空转超过 {idle_timeout_secs}s 未产生输出，已终止。"
                            ));
                        }
                    }
                    // Heartbeat: during a silent gap (slow first token, long tool
                    // run, extended thinking with partial streaming off), drop a
                    // "still running" line so the node never looks frozen. Reads
                    // activity only — must NOT touch it, or idle detection breaks.
                    if !is_codex {
                        let beat = std::time::Duration::from_secs(AI_CLI_HEARTBEAT_SECS);
                        let now = std::time::Instant::now();
                        if activity_elapsed(&last_activity) >= beat
                            && now.duration_since(last_heartbeat) >= beat
                        {
                            let total = run_started_at.elapsed().as_secs();
                            emit_progress(&app, &run_id, &encode_running_status_patch(&run_id, total));
                            last_heartbeat = now;
                        }
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    terminate_child_tree(&mut child);
                    break Err(format!("等待 CLI \"{binary}\" 失败: {e}"));
                }
            }
        };

        let _ = stdin_handle.join();
        if is_codex {
            let streamed_fallback = codex_streamed_output
                .lock()
                .map(|current| current.clone())
                .unwrap_or_default();
            let terminal_output = codex_last_message_path
                .as_ref()
                .and_then(|path| codex_sidecar_output(path))
                .unwrap_or(streamed_fallback);
            match &wait_result {
                Ok(WaitOutcome::CodexTurnCompleted(status)) => {
                    remove_codex_sidecar(&codex_last_message_path);
                    let cancelled = take_ai_cli_cancelled(&run_id);
                    unregister_ai_cli(&run_id);
                    if cancelled {
                        return Err(append_cli_error_context(
                            format!("CLI \"{binary}\" 已由用户中断。"),
                            &terminal_output,
                            "",
                        ));
                    }
                    if codex_status_success(status) {
                        return Ok(ai_cli_result(terminal_output, &codex_usage));
                    }
                    return Err(format!(
                        "CLI \"{binary}\" turn status {status}: {}",
                        terminal_output.trim()
                    ));
                }
                Ok(WaitOutcome::CodexLastMessageReady) => {
                    remove_codex_sidecar(&codex_last_message_path);
                    let cancelled = take_ai_cli_cancelled(&run_id);
                    unregister_ai_cli(&run_id);
                    if cancelled {
                        return Err(append_cli_error_context(
                            format!("CLI \"{binary}\" 已由用户中断。"),
                            &terminal_output,
                            "",
                        ));
                    }
                    return Ok(ai_cli_result(terminal_output, &codex_usage));
                }
                _ => {}
            }
        }
        let streamed_output = out_handle.join().unwrap_or_default();
        let output = if let Some(path) = codex_last_message_path.as_ref() {
            let final_message = codex_sidecar_output(path).unwrap_or_default();
            remove_codex_sidecar(&codex_last_message_path);
            if final_message.trim().is_empty() {
                streamed_output
            } else {
                final_message
            }
        } else {
            streamed_output
        };
        let stderr_bytes = err_handle.join().unwrap_or_default();
        let stderr = String::from_utf8_lossy(&stderr_bytes);
        let cancelled = take_ai_cli_cancelled(&run_id);
        unregister_ai_cli(&run_id);

        if cancelled {
            return Err(append_cli_error_context(
                format!("CLI \"{binary}\" 已由用户中断。"),
                &output,
                &stderr,
            ));
        }

        match wait_result {
            Err(err) => Err(append_cli_error_context(err, &output, &stderr)),
            Ok(WaitOutcome::Exited(status)) if status.success() => {
                // Codex completions come through the dedicated outcomes above; a
                // plain process exit is the claude/gemini path, so prefer the
                // claude usage snapshot (falls back to codex for safety).
                let usage = if claude_usage.lock().ok().is_some_and(|u| u.is_some()) {
                    &claude_usage
                } else {
                    &codex_usage
                };
                Ok(ai_cli_result(output, usage))
            }
            Ok(WaitOutcome::Exited(status)) => {
                let code = status.code().unwrap_or(-1);
                let detail = if stderr.trim().is_empty() {
                    output.trim()
                } else {
                    stderr.trim()
                };
                Err(format!("CLI \"{binary}\" 退出码 {code}: {detail}"))
            }
            Ok(WaitOutcome::CodexTurnCompleted(status)) if codex_status_success(&status) => {
                Ok(ai_cli_result(output, &codex_usage))
            }
            Ok(WaitOutcome::CodexTurnCompleted(status)) => {
                let detail = if stderr.trim().is_empty() {
                    output.trim()
                } else {
                    stderr.trim()
                };
                Err(format!("CLI \"{binary}\" turn status {status}: {detail}"))
            }
            Ok(WaitOutcome::CodexLastMessageReady) => Ok(ai_cli_result(output, &codex_usage)),
            Ok(WaitOutcome::StreamCompleted) => {
                // Terminal `result` event already arrived; the lingering process
                // was force-terminated. Prefer the claude usage snapshot.
                let usage = if claude_usage.lock().ok().is_some_and(|u| u.is_some()) {
                    &claude_usage
                } else {
                    &codex_usage
                };
                Ok(ai_cli_result(output, usage))
            }
        }
    })
    .await
    .map_err(|e| format!("CLI 任务调度失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_vector() {
        // sha256("") and sha256("abc") known vectors.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn list_cached_assets_finds_workspace_cache_files() {
        let dir = std::env::temp_dir().join(format!(
            "ugs-assets-cache-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let clipboard_dir = dir.join(".ultragamestudio").join("clipboard-images");
        let model_dir = dir.join(".ultragamestudio").join("model-assets");
        std::fs::create_dir_all(&clipboard_dir).unwrap();
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(clipboard_dir.join("shot.png"), b"png").unwrap();
        std::fs::write(model_dir.join("model.glb"), b"glb").unwrap();

        let files = list_cached_assets_blocking(Some(dir.to_string_lossy().to_string())).unwrap();
        assert!(files.iter().any(|file| {
            file.title == "shot.png" && file.kind == "image" && file.source == "generated"
        }));
        assert!(files.iter().any(|file| {
            file.title == "model.glb" && file.kind == "mesh" && file.source == "downloaded"
        }));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blueprint_mode_status_detects_installed_plugin() {
        let dir = std::env::temp_dir().join(format!(
            "ugs-blueprint-status-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let plugin_dir = dir.join("Plugins").join(BLUEPRINT_MODE_PLUGIN_DIRNAME);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            dir.join("Game.uproject"),
            r#"{ "FileVersion": 3, "EngineAssociation": "5.3" }"#,
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("BlueprintMode.uplugin"),
            r#"{ "FileVersion": 3, "VersionName": "0.1.0" }"#,
        )
        .unwrap();

        let status = blueprint_mode_status_blocking(BlueprintModeTargetRequest {
            root_path: dir.to_string_lossy().to_string(),
            target_dir: None,
        })
        .unwrap();

        assert!(status.ok);
        assert!(status.exists);
        assert!(status.installed);
        assert_eq!(status.version_name.as_deref(), Some("0.1.0"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blueprint_mode_uninstall_removes_default_plugin_dir() {
        let dir = std::env::temp_dir().join(format!(
            "ugs-blueprint-uninstall-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let plugin_dir = dir.join("Plugins").join(BLUEPRINT_MODE_PLUGIN_DIRNAME);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            dir.join("Game.uproject"),
            r#"{ "FileVersion": 3, "EngineAssociation": "5.3" }"#,
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("BlueprintMode.uplugin"),
            r#"{ "FileVersion": 3, "VersionName": "0.1.0" }"#,
        )
        .unwrap();

        let result = blueprint_mode_uninstall_blocking(BlueprintModeTargetRequest {
            root_path: dir.to_string_lossy().to_string(),
            target_dir: None,
        })
        .unwrap();

        assert!(result.ok);
        assert!(result.removed);
        assert!(!plugin_dir.exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ue_mcp_parse_engine_version_handles_lines_and_guids() {
        assert_eq!(ue_mcp_parse_engine_version("5.3"), Some((5, 3)));
        assert_eq!(ue_mcp_parse_engine_version("4.25"), Some((4, 25)));
        assert_eq!(ue_mcp_parse_engine_version("4"), Some((4, 0)));
        assert_eq!(ue_mcp_parse_engine_version(" 5.4.1 "), Some((5, 4)));
        // Source builds use a GUID association and have no numeric version.
        assert_eq!(ue_mcp_parse_engine_version("{0557D9C8-4D9D...}"), None);
        assert_eq!(ue_mcp_parse_engine_version(""), None);
    }

    #[test]
    fn ue_mcp_enable_uproject_plugins_is_idempotent_and_merges() {
        assert!(UE_MCP_REQUIRED_PLUGINS.contains(&"PythonScriptPlugin"));
        let dir = std::env::temp_dir().join(format!(
            "ugs-ue-uproject-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let uproject = dir.join("Game.uproject");
        std::fs::write(
            &uproject,
            r#"{
  "FileVersion": 3,
  "EngineAssociation": "5.3",
  "Plugins": [
    { "Name": "RemoteControl", "Enabled": false },
    { "Name": "ExistingOther", "Enabled": true }
  ]
}"#,
        )
        .unwrap();

        let plugins = [
            "RemoteControl",
            "EditorScriptingUtilities",
            "PythonScriptPlugin",
        ];
        let first = ue_mcp_enable_uproject_plugins(&uproject, &plugins).unwrap();
        // RemoteControl flips false->true; the other two are appended.
        assert!(first.contains(&"RemoteControl".to_string()));
        assert!(first.contains(&"EditorScriptingUtilities".to_string()));
        assert!(first.contains(&"PythonScriptPlugin".to_string()));

        // Existing unrelated plugin is preserved.
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&uproject).unwrap()).unwrap();
        let names: Vec<String> = doc["Plugins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["Name"].as_str().unwrap().to_string())
            .collect();
        assert!(names.contains(&"ExistingOther".to_string()));
        assert!(doc["Plugins"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["Name"].as_str() != Some("RemoteControl")
                || p["Enabled"].as_bool() == Some(true)));

        // Second run is a no-op (already enabled).
        let second = ue_mcp_enable_uproject_plugins(&uproject, &plugins).unwrap();
        assert!(second.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ue_mcp_tasklist_detects_running_unreal_editor() {
        let tasklist = "\"UnrealEditor.exe\",\"1234\",\"Console\",\"1\",\"1,000 K\"\r\n\
\"Code.exe\",\"2345\",\"Console\",\"1\",\"1,000 K\"\r\n";
        assert!(ue_mcp_tasklist_contains_unreal_editor(tasklist));
        assert!(ue_mcp_tasklist_contains_unreal_editor(
            "\"UE4Editor.exe\",\"1234\",\"Console\",\"1\",\"1,000 K\"\r\n"
        ));
        assert!(ue_mcp_tasklist_contains_unreal_editor(
            "\"UnrealEditor-Win64-DebugGame.exe\",\"1234\",\"Console\",\"1\",\"1,000 K\"\r\n"
        ));
        assert!(!ue_mcp_tasklist_contains_unreal_editor(
            "\"UnrealEditor-Cmd.exe\",\"1234\",\"Console\",\"1\",\"1,000 K\"\r\n"
        ));
    }

    #[test]
    fn ue_mcp_remote_control_config_is_idempotent_and_version_aware() {
        let dir =
            std::env::temp_dir().join(format!("ugs-ue-rc-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();

        // Modern line (5.x): writes the modern startup CVars.
        let m1 = ue_mcp_write_remote_control_config(&dir, Some((5, 3))).unwrap();
        assert!(m1.contains(&"Config/DefaultEngine.ini".to_string()));
        assert!(m1.contains(&"Config/DefaultRemoteControl.ini".to_string()));
        let ini = std::fs::read_to_string(dir.join("Config/DefaultEngine.ini")).unwrap();
        assert!(ini.contains("UltraGameStudio: Unreal MCP RemoteControl auto-start"));
        assert!(ini.contains("WebControl.EnableServerOnStartup 1"));
        assert!(ini.contains("UltraGameStudio: Unreal MCP full-access defaults"));
        assert!(ini.contains("[/Script/RemoteControlCommon.RemoteControlSettings]"));
        assert!(ini.contains("bAllowConsoleCommandRemoteExecution=True"));
        assert!(ini.contains("bEnableRemotePythonExecution=True"));
        assert!(ini.contains("bAllowRemotePythonExecution=True"));
        assert!(ini.contains("bRemoteExecution=True"));
        let rc_ini = std::fs::read_to_string(dir.join("Config/DefaultRemoteControl.ini")).unwrap();
        assert!(rc_ini.contains("UltraGameStudio: Unreal MCP full-access defaults"));
        assert!(rc_ini.contains("[/Script/RemoteControlCommon.RemoteControlSettings]"));
        assert!(rc_ini.contains("bEnableRemotePythonExecution=True"));
        // Second run is a no-op (managed marker already present).
        let m2 = ue_mcp_write_remote_control_config(&dir, Some((5, 3))).unwrap();
        assert!(m2.is_empty());

        // Existing installs with only the old startup marker are upgraded with
        // the full-access defaults instead of being treated as complete.
        let upgrade_dir = dir.join("upgrade");
        let upgrade_config = upgrade_dir.join("Config");
        std::fs::create_dir_all(&upgrade_config).unwrap();
        std::fs::write(
            upgrade_config.join("DefaultEngine.ini"),
            "\n; >>> UltraGameStudio: Unreal MCP RemoteControl auto-start\n[/Script/Engine.Engine]\n+ConsoleCommands=RemoteControl.EnableWebServerOnStartup 1\n+ConsoleCommands=WebControl.EnableServerOnStartup 1\n; <<< UltraGameStudio: Unreal MCP RemoteControl auto-start\n",
        )
        .unwrap();
        let upgraded = ue_mcp_write_remote_control_config(&upgrade_dir, Some((5, 3))).unwrap();
        assert!(upgraded.contains(&"Config/DefaultEngine.ini".to_string()));
        assert!(upgraded.contains(&"Config/DefaultRemoteControl.ini".to_string()));
        let upgraded_ini =
            std::fs::read_to_string(upgrade_config.join("DefaultEngine.ini")).unwrap();
        assert!(upgraded_ini.contains("UltraGameStudio: Unreal MCP full-access defaults"));
        assert!(upgraded_ini.contains("bEnableRemotePythonExecution=True"));
        let upgraded_again =
            ue_mcp_write_remote_control_config(&upgrade_dir, Some((5, 3))).unwrap();
        assert!(upgraded_again.is_empty());

        // Legacy 4.25 in a fresh dir emits the StartServer console command too.
        let legacy_dir = dir.join("legacy");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        ue_mcp_write_remote_control_config(&legacy_dir, Some((4, 25))).unwrap();
        let legacy_ini =
            std::fs::read_to_string(legacy_dir.join("Config/DefaultEngine.ini")).unwrap();
        assert!(legacy_ini.contains("WebControl.StartServer"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ue_mcp_project_mcp_json_merges_and_preserves_other_servers() {
        let dir = std::env::temp_dir().join(format!(
            "ugs-ue-mcpjson-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{ "mcpServers": { "other": { "command": "x", "args": [] } } }"#,
        )
        .unwrap();

        let marker = ue_mcp_write_project_mcp_json(&dir, "C:/tools/ue-mcp.exe").unwrap();
        assert!(marker.is_some());
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        // Existing server preserved + ours added.
        assert!(doc["mcpServers"]["other"].is_object());
        assert_eq!(
            doc["mcpServers"][UE_MCP_SERVER_ID]["command"].as_str(),
            Some("C:/tools/ue-mcp.exe")
        );

        // Idempotent: re-running with the same command is a no-op.
        let again = ue_mcp_write_project_mcp_json(&dir, "C:/tools/ue-mcp.exe").unwrap();
        assert!(again.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ue_mcp_project_mcp_json_archives_conflicting_unreal_servers() {
        let dir = std::env::temp_dir().join(format!(
            "ugs-ue-mcpjson-conflict-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(".mcp.json"),
            r#"{ "mcpServers": { "unreal-mcp": { "command": "unreal-mcp", "args": [] }, "other": { "command": "x", "args": [] } } }"#,
        )
        .unwrap();

        let marker = ue_mcp_write_project_mcp_json(&dir, "C:/tools/ue-mcp.exe").unwrap();
        assert!(marker.is_some());
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();

        assert!(doc["mcpServers"][UE_MCP_SERVER_ID].is_object());
        assert!(doc["mcpServers"]["other"].is_object());
        assert!(doc["mcpServers"]["unreal-mcp"].is_null());
        assert_eq!(
            doc[UE_MCP_DISABLED_ARCHIVE_KEY]["unreal-mcp"]["command"].as_str(),
            Some("unreal-mcp")
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ue_mcp_suggestion_uses_stable_server_id() {
        let servers = project_suggested_mcp_servers("unreal");
        assert_eq!(servers.len(), 4);
        let ue = servers
            .iter()
            .find(|server| server.id == UE_MCP_SERVER_ID)
            .unwrap();
        assert_eq!(ue.transport, "stdio");
        assert!(ue.requires_user_approval);
        let cocos = servers
            .iter()
            .find(|server| server.id == COCOS_MCP_SERVER_ID)
            .unwrap();
        assert_eq!(cocos.transport, "streamable-http");
        assert_eq!(cocos.url.as_deref(), Some(COCOS_MCP_URL));
    }

    #[test]
    fn project_mcp_settings_prefers_unreal_mcp_when_enabled_server_present() {
        let settings = serde_json::json!({
            "mcpServers": {
                "ue-mcp-for-all-versions": {
                    "command": "C:\\Users\\fengwei\\.ultragamestudio\\tools\\ue-mcp.exe",
                    "args": []
                }
            }
        });

        assert!(project_mcp_settings_prefers_unreal_mcp(&settings));
    }

    #[test]
    fn project_mcp_settings_keeps_streamable_http_servers() {
        let raw_settings = serde_json::json!({
            "schemaVersion": 1,
            "mcp": {
                "enabled": true,
                "servers": [
                    {
                        "id": "cocos-mcp-server",
                        "label": "Cocos MCP",
                        "enabled": true,
                        "transport": "streamable-http",
                        "url": "http://localhost:3000/mcp",
                        "args": [],
                        "env": {}
                    }
                ]
            }
        });

        let settings =
            project_mcp_settings_json_from_settings(&raw_settings, Some("E:/Game")).unwrap();

        assert_eq!(
            settings["mcpServers"]["cocos-mcp-server"]["url"].as_str(),
            Some("http://localhost:3000/mcp")
        );
        assert_eq!(
            settings["mcpServers"]["cocos-mcp-server"]["transport"].as_str(),
            Some("streamable-http")
        );
    }

    #[test]
    fn codex_project_mcp_config_args_are_toml_overrides() {
        let settings = serde_json::json!({
            "mcpServers": {
                "ue-mcp-for-all-versions": {
                    "command": "C:\\Users\\fengwei\\.ultragamestudio\\tools\\ue-mcp.exe",
                    "args": ["--host", "127.0.0.1"],
                    "env": { "UE_PROJECT": "Game" }
                }
            }
        });
        let mut args = Vec::new();

        append_codex_project_mcp_config_args_from_settings(&mut args, &settings);

        assert_eq!(args[0], "-c");
        assert_eq!(args[1], "mcp_servers={}");
        assert_eq!(args[2], "-c");
        assert_eq!(
            args[3],
            "mcp_servers.ue-mcp-for-all-versions.command=\"C:\\\\Users\\\\fengwei\\\\.ultragamestudio\\\\tools\\\\ue-mcp.exe\""
        );
        assert_eq!(args[4], "-c");
        assert_eq!(
            args[5],
            "mcp_servers.ue-mcp-for-all-versions.args=[\"--host\",\"127.0.0.1\"]"
        );
        assert_eq!(args[6], "-c");
        assert_eq!(
            args[7],
            "mcp_servers.ue-mcp-for-all-versions.env.UE_PROJECT=\"Game\""
        );
    }

    #[test]
    fn gemini_project_mcp_settings_trusts_project_servers() {
        let mut settings = serde_json::json!({
            "mcpServers": {
                "ue-mcp-for-all-versions": {
                    "command": "C:\\Users\\fengwei\\.ultragamestudio\\tools\\ue-mcp.exe",
                    "args": ["--host", "127.0.0.1"]
                }
            }
        });
        trust_gemini_mcp_servers(&mut settings);

        assert_eq!(
            settings["mcpServers"]["ue-mcp-for-all-versions"]["trust"].as_bool(),
            Some(true)
        );
    }

    #[test]
    fn preview_image_mime_supports_common_web_formats() {
        assert_eq!(
            image_mime_for_path(std::path::Path::new("screen.avif")),
            Some("image/avif")
        );
        assert_eq!(
            image_mime_for_path(std::path::Path::new("favicon.ico")),
            Some("image/x-icon")
        );
        assert_eq!(
            image_mime_for_path(std::path::Path::new("photo.jfif")),
            Some("image/jpeg")
        );
    }

    #[test]
    fn model_mime_supports_preview_formats() {
        assert_eq!(
            model_mime_for_url("https://assets.example.com/model.glb?token=1"),
            Some("model/gltf-binary")
        );
        assert_eq!(
            model_mime_for_content_type("model/gltf+json; charset=utf-8"),
            Some("model/gltf+json")
        );
        assert_eq!(
            model_mime_for_bytes(b"glTF\x02\0\0\0"),
            Some("model/gltf-binary")
        );
        assert_eq!(
            model_mime_for_content_type("application/zip"),
            Some("application/zip")
        );
        assert_eq!(
            model_mime_for_bytes(b"PK\x03\x04\x0a\0\0\0"),
            Some("application/zip")
        );
        assert_eq!(
            model_asset_extension(
                "application/zip",
                Some("https://assets.example.com/model.zip"),
                None
            ),
            "zip"
        );
    }

    #[test]
    fn preview_document_mime_supports_office_formats() {
        assert_eq!(
            document_mime_for_path(std::path::Path::new("report.pdf")),
            Some("application/pdf")
        );
        assert_eq!(
            document_mime_for_path(std::path::Path::new("notes.docx")),
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        );
        assert_eq!(
            document_mime_for_path(std::path::Path::new("legacy.doc")),
            Some("application/msword")
        );
        assert_eq!(
            document_mime_for_path(std::path::Path::new("readme.txt")),
            None
        );
    }

    #[test]
    fn preview_text_mime_marks_html_and_markdown() {
        assert_eq!(
            text_mime_for_path(std::path::Path::new("Moon亮晶分析和渲染整体架构.html")),
            "text/html"
        );
        assert_eq!(
            text_mime_for_path(std::path::Path::new("README.markdown")),
            "text/markdown"
        );
    }

    #[test]
    fn preview_text_decodes_utf16_before_binary_rejection() {
        let bytes = vec![0xff, 0xfe, b'h', 0, b'i', 0];
        assert!(probably_binary(&bytes));
        assert!(has_utf16_bom(&bytes));
        assert_eq!(decode_preview_text(bytes).as_deref(), Some("hi"));
    }

    #[test]
    fn preview_fallback_finds_unique_bare_filename() {
        let root = std::env::temp_dir().join(format!(
            "ultragamestudio-preview-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let nested = root.join("app").join("src");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("shader.wgsl");
        std::fs::write(&file, "@compute @workgroup_size(1) fn main() {}\n").unwrap();

        let found = preview_bare_name_fallback("shader.wgsl", root.to_str());
        assert_eq!(found.as_deref(), Some(file.as_path()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_fallback_maps_p4_depot_path_to_workspace_tail() {
        let base = std::env::temp_dir().join(format!(
            "ultragamestudio-preview-p4-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let root = base
            .join("project_moon_ue5")
            .join("MoonGame")
            .join("development")
            .join("Client")
            .join("Game");
        let file = root.join("Config").join("DefaultEditor.ini");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "[Editor]\n").unwrap();

        let found = preview_depot_path_fallback(
            "//MoonGame/development/Client/Game/Config/DefaultEditor.ini#7",
            root.to_str(),
        );
        assert_eq!(found.as_deref(), Some(file.as_path()));

        let preview = preview_local_file_blocking(
            "//MoonGame/development/Client/Game/Config/DefaultEditor.ini#7".to_string(),
            Some(root.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(preview.kind, "text");
        assert_eq!(preview.text.as_deref(), Some("[Editor]\n"));

        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn preview_fallback_handles_omitted_app_prefix() {
        let root = std::env::temp_dir().join(format!(
            "ultragamestudio-preview-app-prefix-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let nested = root.join("app").join("cli").join("io");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("cli-spawn.ts");
        std::fs::write(&file, "export const ok = true;\n").unwrap();

        let relative = preview_local_file_blocking(
            "cli/io/cli-spawn.ts".to_string(),
            Some(root.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(relative.path, file.to_string_lossy());

        let missing_app_absolute = root.join("cli").join("io").join("cli-spawn.ts");
        let absolute = preview_local_file_blocking(
            missing_app_absolute.to_string_lossy().to_string(),
            Some(root.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(absolute.path, file.to_string_lossy());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn summarizes_tool_result_variants() {
        // String content.
        let s = serde_json::json!({ "type": "tool_result", "content": "hello\nworld" });
        assert_eq!(summarize_tool_result(&s), "hello world");

        // Array-of-text-blocks content.
        let arr = serde_json::json!({
            "type": "tool_result",
            "content": [{ "type": "text", "text": "line one" }, { "type": "text", "text": "line two" }]
        });
        assert_eq!(summarize_tool_result(&arr), "line one line two");

        // Error results are prefixed.
        let err = serde_json::json!({
            "type": "tool_result", "is_error": true, "content": "boom"
        });
        assert_eq!(summarize_tool_result(&err), "⚠ boom");

        // Empty / missing content yields an empty breadcrumb.
        let empty = serde_json::json!({ "type": "tool_result", "content": "   " });
        assert_eq!(summarize_tool_result(&empty), "");

        // Long output is truncated to 160 chars.
        let long = "x".repeat(300);
        let big = serde_json::json!({ "type": "tool_result", "content": long });
        assert_eq!(summarize_tool_result(&big).chars().count(), 160);
    }

    #[test]
    fn parses_codex_type_events() {
        let item: CodexLiteEvent = serde_json::from_str(
            r#"{
            "type": "item.completed",
            "item": { "type": "agent_message", "text": "done" }
        }"#,
        )
        .unwrap();
        assert_eq!(
            item.completed_item().and_then(|item| item.text.as_deref()),
            Some("done")
        );

        let turn: CodexLiteEvent = serde_json::from_str(
            r#"{
            "type": "turn.completed",
            "status": "completed",
            "usage": { "input_tokens": 22451, "cached_input_tokens": 11648, "output_tokens": 28 }
        }"#,
        )
        .unwrap();
        assert_eq!(turn.turn_completion_status().as_deref(), Some("completed"));
        assert_eq!(
            turn.turn_usage()
                .and_then(|v| v.get("cached_input_tokens"))
                .and_then(|v| v.as_u64()),
            Some(11648)
        );
    }

    #[test]
    fn parses_codex_method_events() {
        let item: CodexLiteEvent = serde_json::from_str(
            r#"{
            "method": "item/completed",
            "params": { "item": { "type": "command_execution", "command": "npm test" } }
        }"#,
        )
        .unwrap();
        assert_eq!(
            item.completed_item()
                .and_then(|item| item.command.as_deref()),
            Some("npm test")
        );

        let turn: CodexLiteEvent = serde_json::from_str(
            r#"{
            "method": "turn/completed",
            "params": {
                "turn": { "status": "completed" },
                "usage": { "input_tokens": 10, "cached_input_tokens": 4, "output_tokens": 2 }
            }
        }"#,
        )
        .unwrap();
        assert_eq!(turn.turn_completion_status().as_deref(), Some("completed"));
        assert_eq!(
            turn.turn_usage()
                .and_then(|v| v.get("cached_input_tokens"))
                .and_then(|v| v.as_u64()),
            Some(4)
        );
    }

    #[test]
    fn codex_lite_item_ignores_tool_output_body() {
        let event: CodexLiteEvent = serde_json::from_str(
            r#"{
              "method": "item/completed",
              "params": {
                "item": {
                  "type": "command_execution",
                  "command": "rg -n foo app/src",
                  "output": "large tool output should not be rendered"
                }
              }
            }"#,
        )
        .unwrap();
        let line = event.completed_item().and_then(codex_progress_line);
        assert_eq!(
            line.as_deref(),
            Some("\n🔧 command_execution: rg -n foo app/src\n")
        );
    }

    #[test]
    fn codex_tool_patch_keeps_file_change_paths() {
        let event: CodexLiteEvent = serde_json::from_str(
            r#"{
              "method": "item/completed",
              "params": {
                "item": {
                  "id": "fc1",
                  "type": "file_change",
                  "status": "completed",
                  "changes": [{ "path": "app/src/lib/sessionFiles.ts" }],
                  "output": "*** Update File: app/src/lib/sessionFiles.ts"
                }
              }
            }"#,
        )
        .unwrap();
        let patch = event
            .completed_item()
            .and_then(|item| codex_tool_patch(item, "fallback".to_string()))
            .unwrap();
        assert_eq!(patch["name"].as_str(), Some("file_change"));
        assert_eq!(
            patch["args"]["changes"][0]["path"].as_str(),
            Some("app/src/lib/sessionFiles.ts")
        );
    }

    #[test]
    fn claude_message_usage_reads_result_cache_fields() {
        let result = serde_json::json!({
            "type": "result",
            "usage": {
                "input_tokens": 120,
                "output_tokens": 40,
                "cache_read_input_tokens": 800,
                "cache_creation_input_tokens": 80
            }
        });
        let usage = claude_message_usage(&result).expect("result usage");
        assert_eq!(usage["cache_read_input_tokens"], 800);
        assert_eq!(usage["cache_creation_input_tokens"], 80);

        let assistant = serde_json::json!({
            "type": "assistant",
            "message": { "usage": { "input_tokens": 10, "output_tokens": 2 } }
        });
        let usage = claude_message_usage(&assistant).expect("assistant usage");
        assert_eq!(usage["input_tokens"], 10);

        // Zeroed/empty usage is ignored so it never clobbers a real snapshot.
        let empty = serde_json::json!({
            "type": "result",
            "usage": { "input_tokens": 0, "output_tokens": 0 }
        });
        assert!(claude_message_usage(&empty).is_none());
        assert!(claude_message_usage(&serde_json::json!({ "type": "result" })).is_none());
    }

    #[test]
    fn codex_sidecar_output_ignores_empty_files() {
        let path = std::env::temp_dir().join(format!(
            "ultragamestudio-codex-sidecar-test-{}-{}.txt",
            std::process::id(),
            now_ms()
        ));

        std::fs::write(&path, "  \n").unwrap();
        assert_eq!(codex_sidecar_output(&path), None);

        std::fs::write(&path, "final answer\n").unwrap();
        assert_eq!(
            codex_sidecar_output(&path).as_deref(),
            Some("final answer\n")
        );

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn trims_cli_error_context_from_tail() {
        let text = "x".repeat(CLI_ERROR_CONTEXT_LIMIT + 32);
        let trimmed = trim_cli_error_context(&text);
        assert!(trimmed.starts_with("...\n"));
        assert!(trimmed.len() < text.len());
    }

    #[test]
    fn extracts_local_model_ids_from_ollama_tags() {
        let value = serde_json::json!({
            "models": [
                { "name": "qwen2.5-coder:7b", "model": "qwen2.5-coder:7b" },
                { "name": "llama3.2:3b" }
            ]
        });
        assert_eq!(
            extract_local_model_ids("ollama", &value),
            vec!["qwen2.5-coder:7b", "llama3.2:3b"]
        );
    }

    #[test]
    fn extracts_local_model_ids_from_openai_models() {
        let value = serde_json::json!({
            "data": [
                { "id": "local-model-a" },
                { "id": "local-model-b" }
            ]
        });
        assert_eq!(
            extract_local_model_ids("lmstudio", &value),
            vec!["local-model-a", "local-model-b"]
        );
    }

    #[test]
    fn matches_ollama_latest_alias() {
        assert!(local_model_id_matches("llama3.1", "llama3.1:latest"));
        assert!(local_model_id_matches("llama3.1:latest", "llama3.1"));
        assert!(!local_model_id_matches("llama3.1", "llama3.2:latest"));
    }

    #[test]
    fn claude_bare_mode_requires_gateway_api_env() {
        let mut env = HashMap::new();
        assert!(!should_run_claude_bare_with_disable(Some(&env), false));

        env.insert("ANTHROPIC_API_KEY".to_string(), "freecc".to_string());
        assert!(!should_run_claude_bare_with_disable(Some(&env), false));

        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://127.0.0.1:8766/ch/open_router".to_string(),
        );
        assert!(should_run_claude_bare_with_disable(Some(&env), false));
    }

    #[test]
    fn claude_bare_mode_can_be_disabled() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "freecc".to_string());
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://127.0.0.1:8766/ch/open_router".to_string(),
        );

        assert!(!should_run_claude_bare_with_disable(Some(&env), true));
    }

    #[test]
    fn claude_bare_support_comes_from_help_text() {
        assert!(claude_help_supports_bare(
            "Options:\n  --bare  Minimal mode\n  --verbose"
        ));
        assert!(!claude_help_supports_bare(
            "Options:\n  --print\n  --verbose"
        ));
    }

    #[test]
    fn gateway_progress_model_uses_injected_model() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".to_string(), "freecc".to_string());
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://127.0.0.1:8766/ch/kilo".to_string(),
        );
        env.insert(
            "ANTHROPIC_MODEL".to_string(),
            "poolside/laguna-xs.2:free".to_string(),
        );

        assert_eq!(
            gateway_progress_model_hint(Some(&env)).as_deref(),
            Some("poolside/laguna-xs.2:free")
        );
    }

    #[test]
    fn gateway_progress_model_ignores_plain_cli_env() {
        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_MODEL".to_string(),
            "poolside/laguna-xs.2:free".to_string(),
        );

        assert_eq!(gateway_progress_model_hint(Some(&env)), None);
    }

    #[test]
    fn claude_gateway_settings_override_pins_env_and_model() {
        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://127.0.0.1:8766/ch/kilo".to_string(),
        );
        env.insert("ANTHROPIC_API_KEY".to_string(), "local-token".to_string());
        env.insert(
            "ANTHROPIC_MODEL".to_string(),
            "poolside/laguna-xs.2:free".to_string(),
        );

        let settings = claude_gateway_settings_json(&env).unwrap();
        assert_eq!(
            settings
                .pointer("/env/ANTHROPIC_BASE_URL")
                .and_then(|v| v.as_str()),
            Some("http://127.0.0.1:8766/ch/kilo")
        );
        assert_eq!(
            settings
                .pointer("/env/ANTHROPIC_AUTH_TOKEN")
                .and_then(|v| v.as_str()),
            Some("local-token")
        );
        assert_eq!(
            settings
                .pointer("/env/ANTHROPIC_DEFAULT_SONNET_MODEL")
                .and_then(|v| v.as_str()),
            Some("poolside/laguna-xs.2:free")
        );
        assert_eq!(
            settings.pointer("/model").and_then(|v| v.as_str()),
            Some("poolside/laguna-xs.2:free")
        );
    }

    #[test]
    fn claude_gateway_settings_override_skips_plain_model_env() {
        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_MODEL".to_string(),
            "poolside/laguna-xs.2:free".to_string(),
        );

        assert!(claude_gateway_settings_json(&env).is_none());
    }

    #[test]
    fn scan_workspace_snapshot_does_not_limit_file_count() {
        let root = std::env::temp_dir().join(format!(
            "ultragamestudio-session-changes-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp root");

        for index in 0..300 {
            let path = root.join(format!("{index:05}.txt"));
            std::fs::write(path, format!("file {index}\n")).expect("write test file");
        }

        let (files, truncated) = scan_workspace_snapshot(&root);
        let _ = std::fs::remove_dir_all(&root);

        assert!(!truncated);
        assert_eq!(files.len(), 300);
        let last = files.last().expect("last file");
        assert_eq!(last.path, "00299.txt");
        assert!(!last.binary);
        assert!(!last.truncated);
        assert_eq!(last.content.as_deref(), Some("file 299\n"));
    }

    #[test]
    fn scan_workspace_snapshot_caps_total_text_content() {
        let root = std::env::temp_dir().join(format!(
            "ultragamestudio-session-changes-budget-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp root");

        std::fs::write(root.join("a.txt"), "first\n").expect("write first");
        std::fs::write(root.join("b.txt"), "second\n").expect("write second");

        let (files, truncated) = scan_workspace_snapshot_with_text_budget(&root, "first\n".len());
        let _ = std::fs::remove_dir_all(&root);

        assert!(truncated);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "a.txt");
        assert_eq!(files[0].content.as_deref(), Some("first\n"));
        assert!(!files[0].truncated);
        assert_eq!(files[1].path, "b.txt");
        assert!(files[1].truncated);
        assert!(files[1].content.is_none());
    }

    #[test]
    fn scan_workspace_snapshot_skips_known_binary_content() {
        let root = std::env::temp_dir().join(format!(
            "ultragamestudio-session-changes-binary-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp root");

        std::fs::write(root.join("asset.uasset"), "text-like payload").expect("write asset");

        let (files, truncated) = scan_workspace_snapshot_with_text_budget(&root, 1024);
        let _ = std::fs::remove_dir_all(&root);

        assert!(!truncated);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "asset.uasset");
        assert!(files[0].binary);
        assert!(files[0].content.is_none());
    }

    #[test]
    fn truncate_workspace_changes_does_not_limit_file_count() {
        let mut files: Vec<WorkspaceChangeFile> = (0..300)
            .map(|index| WorkspaceChangeFile {
                path: format!("{index:03}.txt"),
                old_path: None,
                status: "modified".to_string(),
                binary: false,
                truncated: false,
                lines: Vec::new(),
            })
            .collect();

        let truncated = truncate_workspace_changes(&mut files);

        assert!(!truncated);
        assert_eq!(files.len(), 300);
    }

    #[test]
    fn parse_git_workspace_changes_strips_workspace_prefix() {
        let files = parse_git_workspace_changes(
            " M app/src/main.ts\0?? app/src/new.ts\0R  app/src/next.ts\0app/src/old.ts\0",
            "app/",
        );

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "src/main.ts");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].path, "src/new.ts");
        assert_eq!(files[1].status, "added");
        assert_eq!(files[2].path, "src/next.ts");
        assert_eq!(files[2].old_path.as_deref(), Some("src/old.ts"));
        assert_eq!(files[2].status, "renamed");
    }

    #[test]
    fn parse_git_diff_workspace_changes_reads_hunks() {
        let files = parse_git_diff_workspace_changes(
            "diff --git a/app/src/main.ts b/app/src/main.ts\n\
             index 1111111..2222222 100644\n\
             --- a/app/src/main.ts\n\
             +++ b/app/src/main.ts\n\
             @@ -4 +4,2 @@\n\
             -old line\n\
             +new line\n\
             +extra line\n",
            "app/",
        );

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/main.ts");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].lines.len(), 3);
        assert_eq!(files[0].lines[0].kind, "replacedDeleted");
        assert_eq!(files[0].lines[0].old_line, Some(4));
        assert_eq!(files[0].lines[1].kind, "replacedAdded");
        assert_eq!(files[0].lines[1].new_line, Some(4));
        assert_eq!(files[0].lines[2].content, "extra line");
    }

    #[test]
    fn merge_workspace_status_files_with_diff_keeps_status() {
        let status_files = parse_git_workspace_changes(" M app/src/main.ts\0", "app/");
        let diff_files = parse_git_diff_workspace_changes(
            "diff --git a/app/src/main.ts b/app/src/main.ts\n\
             --- a/app/src/main.ts\n\
             +++ b/app/src/main.ts\n\
             @@ -0,0 +1 @@\n\
             +new line\n",
            "app/",
        );

        let files = merge_workspace_status_files_with_diff(
            Path::new("E:/UltraGameStudio"),
            status_files,
            diff_files,
        );

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/main.ts");
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].lines.len(), 1);
        assert_eq!(files[0].lines[0].kind, "added");
    }

    #[test]
    fn parse_unified_workspace_diff_lines_marks_replacements() {
        let (lines, binary) = parse_unified_workspace_diff_lines(
            "Index: src/main.cpp\n\
             ===================================================================\n\
             --- src/main.cpp\t(revision 1)\n\
             +++ src/main.cpp\t(working copy)\n\
             @@ -8,2 +8,2 @@\n\
             -old one\n\
             -old two\n\
             +new one\n\
             +new two\n",
        );

        assert!(!binary);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0].kind, "replacedDeleted");
        assert_eq!(lines[0].old_line, Some(8));
        assert_eq!(lines[2].kind, "replacedAdded");
        assert_eq!(lines[2].new_line, Some(8));
    }

    #[test]
    fn workspace_change_file_from_unified_diff_detects_binary() {
        let file = workspace_change_file_from_unified_diff(
            "Content/Logo.uasset",
            "modified",
            "Cannot display: file marked as a binary type.\n",
        )
        .expect("binary diff marker should still produce a file");

        assert_eq!(file.path, "Content/Logo.uasset");
        assert!(file.binary);
        assert!(file.truncated);
        assert!(file.lines.is_empty());
    }

    #[test]
    fn parse_svn_workspace_changes_maps_statuses() {
        let files =
            parse_svn_workspace_changes("M       edited.ts\n?       new.ts\n!       missing.ts\n");

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[1].status, "added");
        assert_eq!(files[2].status, "deleted");
    }

    #[test]
    fn parse_p4_workspace_changes_uses_preview_actions() {
        let root = Path::new("E:/Depot/Client");
        let mappings =
            parse_p4_where_mappings(root, "//depot/... //client/... E:\\Depot\\Client\\...\n");
        let files = parse_p4_workspace_changes(
            root,
            "Source/New.cpp - reconcile to add //depot/Source/New.cpp\n\
             Source/Edit.cpp - reconcile to edit //depot/Source/Edit.cpp#3\n\
             //depot/Source/Gone.cpp#2 - opened for delete\n\
             //client/Source/ClientEdit.cpp#4 - opened for edit\n",
            &mappings,
        );

        assert_eq!(files.len(), 4);
        assert_eq!(files[0].path, "Source/New.cpp");
        assert_eq!(files[0].status, "added");
        assert_eq!(files[1].status, "modified");
        assert_eq!(files[2].path, "Source/Gone.cpp");
        assert_eq!(files[2].status, "deleted");
        assert_eq!(files[3].path, "Source/ClientEdit.cpp");
        assert_eq!(files[3].status, "modified");
    }

    #[test]
    fn parse_p4_where_mappings_supports_subdirectory_roots() {
        let root = Path::new("E:/Depot/Client/Project");
        let mappings =
            parse_p4_where_mappings(root, "//depot/... //client/... E:\\Depot\\Client\\...\n");

        assert_eq!(
            relative_p4_status_path_from_root(root, "//depot/Project/Source/Main.cpp#7", &mappings),
            "Source/Main.cpp"
        );
    }

    #[test]
    fn parse_p4_where_mappings_trims_current_directory_suffixes() {
        let root = Path::new("E:/Depot/Client/Project");
        let mappings = parse_p4_where_mappings(
            root,
            "//depot/Project/. //client/Project/. E:\\Depot\\Client\\Project\\.\n",
        );

        assert_eq!(
            relative_p4_status_path_from_root(root, "//depot/Project/Source/Main.cpp#7", &mappings),
            "Source/Main.cpp"
        );
    }

    #[test]
    fn parse_p4_info_mapping_maps_stream_and_client_paths() {
        let root = Path::new("E:/project_moon_ue5/MoonEngine");
        let mut mappings = parse_p4_where_mappings(root, "");
        mappings.push(
            parse_p4_info_mapping(
                "Client name: fengwei_project_moonengine\n\
                 Client root: E:\\project_moon_ue5\\MoonEngine\n\
                 Client stream: //MoonEngine/dev-5.7.4\n",
            )
            .unwrap(),
        );
        dedupe_sort_p4_where_mappings(&mut mappings);

        assert_eq!(
            relative_p4_status_path_from_root(
                root,
                "//MoonEngine/dev-5.7.4/Engine/Source/Edit.cpp#1",
                &mappings
            ),
            "Engine/Source/Edit.cpp"
        );
        assert_eq!(
            relative_p4_status_path_from_root(
                root,
                "//fengwei_project_moonengine/Engine/Source/Edit.cpp#1",
                &mappings
            ),
            "Engine/Source/Edit.cpp"
        );
    }

    #[test]
    fn parse_p4_where_mappings_supports_workspace_ellipsis() {
        let root = Path::new("E:/project_moon_ue5/MoonEngine");
        let mappings = parse_p4_where_mappings(
            root,
            "//MoonEngine/dev-5.7.4/... //fengwei_project_moonengine/... E:\\project_moon_ue5\\MoonEngine\\...\n",
        );

        assert_eq!(
            relative_p4_status_path_from_root(
                root,
                "//MoonEngine/dev-5.7.4/Engine/Source/Edit.cpp#1",
                &mappings
            ),
            "Engine/Source/Edit.cpp"
        );
    }

    #[test]
    fn p4_observer_status_commands_are_read_only() {
        let commands: Vec<Vec<&str>> = P4_OBSERVER_STATUS_COMMANDS
            .iter()
            .map(|args| args.to_vec())
            .collect();

        assert_eq!(
            commands,
            vec![vec!["opened"], vec!["reconcile", "-n", "-ead"]]
        );
        assert!(commands
            .iter()
            .all(|args| { args.first().copied() != Some("reconcile") || args.contains(&"-n") }));
        assert!(!commands
            .iter()
            .any(|args| args.first().is_some_and(|command| {
                matches!(*command, "add" | "edit" | "delete" | "revert" | "submit")
            })));
    }

    #[test]
    fn p4_file_diff_args_force_unopened_files() {
        let args = p4_file_diff_args("Source/Edit.cpp");

        assert!(args.contains(&"-f".to_string()));
        assert!(args.contains(&"-du0".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("Source/Edit.cpp"));
    }

    #[test]
    fn p4_workspace_status_specs_scan_root_files_before_directories() {
        let root =
            std::env::temp_dir().join(format!("ugs-p4-specs-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Content")).unwrap();
        std::fs::create_dir_all(root.join("Source")).unwrap();
        std::fs::write(root.join("README.md"), "readme\n").unwrap();

        let specs = p4_workspace_status_specs(&root);
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            specs,
            vec![
                "*".to_string(),
                "Content/...".to_string(),
                "Source/...".to_string(),
            ]
        );
    }

    #[test]
    fn root_workspace_status_files_keeps_only_root_children() {
        let file = |path: &str, old_path: Option<&str>| WorkspaceChangeFile {
            path: path.to_string(),
            old_path: old_path.map(str::to_string),
            status: "modified".to_string(),
            binary: false,
            truncated: true,
            lines: Vec::new(),
        };

        let files = root_workspace_status_files(vec![
            file("Root.txt", None),
            file("Source/Nested.cpp", None),
            file("Moved/New.cpp", Some("OldRoot.cpp")),
        ]);

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "Root.txt");
        assert_eq!(files[1].old_path.as_deref(), Some("OldRoot.cpp"));
    }

    #[test]
    fn p4_timed_out_directory_spec_subdivides_to_children() {
        let root =
            std::env::temp_dir().join(format!("ugs-p4-split-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Content").join("Maps")).unwrap();
        std::fs::write(root.join("Content").join("Main.umap"), "map\n").unwrap();

        let specs = p4_child_specs_for_timed_out_spec(&root, "Content/...");
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(
            specs,
            vec![
                "Content/Main.umap".to_string(),
                "Content/Maps/...".to_string()
            ]
        );
    }

    #[test]
    fn p4_status_command_timeout_is_per_command_without_total_budget() {
        // No total scan budget: every command uses the same per-command timeout
        // regardless of how long the overall scan has been running.
        assert_eq!(
            p4_status_command_timeout(),
            std::time::Duration::from_millis(WORKSPACE_STATUS_COMMAND_TIMEOUT_MS)
        );
    }

    #[test]
    fn vcs_scan_progress_advances_and_respects_cancellation() {
        let state = Arc::new(VcsScanProgressState::default());
        vcs_scan_with_progress(state.clone(), || {
            assert!(!vcs_scan_is_cancelled());
            vcs_scan_progress_advance(3, 5);
            vcs_scan_progress_advance(1, 2);
        });
        assert_eq!(state.scanned_specs.load(Ordering::Relaxed), 4);
        assert_eq!(state.found_items.load(Ordering::Relaxed), 7);

        state.cancelled.store(true, Ordering::Relaxed);
        vcs_scan_with_progress(state.clone(), || {
            assert!(vcs_scan_is_cancelled());
        });

        // Outside of a bound scan, advancing/cancellation are no-ops.
        vcs_scan_progress_advance(10, 10);
        assert!(!vcs_scan_is_cancelled());
    }

    #[test]
    fn enqueue_vcs_scan_cancels_previous_scan_for_same_root() {
        let root = format!("ultragamestudio-scan-test-{}", now_ms());
        enqueue_vcs_scan(root.clone(), "k1".to_string());
        let first = {
            let queue = vcs_scan_queue().lock().unwrap();
            queue.active_by_root.get(&root).cloned()
        };
        let first = first.expect("first scan registered");
        assert!(!first.cancelled.load(Ordering::Relaxed));

        enqueue_vcs_scan(root.clone(), "k2".to_string());
        assert!(
            first.cancelled.load(Ordering::Relaxed),
            "superseded scan must be cancelled"
        );

        // Only one pending job should remain for this root.
        let pending_for_root = {
            let queue = vcs_scan_queue().lock().unwrap();
            queue
                .pending
                .iter()
                .filter(|job| job.root_path == root)
                .count()
        };
        assert_eq!(pending_for_root, 1);
    }

    #[test]
    fn cancel_vcs_scan_cancels_active_and_pending_jobs_for_root() {
        let root = format!("ultragamestudio-scan-cancel-test-{}", now_ms());
        enqueue_vcs_scan(root.clone(), "k1".to_string());
        let active = {
            let queue = vcs_scan_queue().lock().unwrap();
            queue.active_by_root.get(&root).cloned()
        };
        let active = active.expect("scan registered");

        cancel_vcs_scan(&root);

        assert!(active.cancelled.load(Ordering::Relaxed));
        let queue = vcs_scan_queue().lock().unwrap();
        assert!(!queue.active_by_root.contains_key(&root));
        assert!(!queue.pending.iter().any(|job| job.root_path == root));
    }

    #[test]
    fn workspace_changes_uses_session_time_when_baseline_is_late() {
        let root = std::env::temp_dir().join(format!(
            "ultragamestudio-session-time-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp root");
        let baseline_at_ms = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(25));
        std::fs::write(root.join("changed.txt"), "changed\n").expect("write test file");

        let key = format!("test-{}", now_ms());
        let _ = workspace_changes_baseline_blocking(
            display_preview_path(&root),
            key.clone(),
            Some(baseline_at_ms),
        )
        .expect("baseline");
        let changes =
            workspace_changes_blocking(display_preview_path(&root), key, Some(baseline_at_ms))
                .expect("changes");
        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].path, "changed.txt");
        assert_eq!(changes.files[0].status, "modified");
        assert!(changes.files[0].truncated);
    }

    #[test]
    fn normalizes_spawn_env_known_provider_models() {
        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "https://integrate.api.nvidia.com/v1".to_string(),
        );
        env.insert(
            "ANTHROPIC_MODEL".to_string(),
            "nemotron-3-super-120b-a12b".to_string(),
        );
        let normalized = normalize_spawn_env(Some(env)).unwrap();
        assert_eq!(
            normalized.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("nvidia/nemotron-3-super-120b-a12b")
        );
    }

    #[test]
    fn normalizes_spawn_env_free_proxy_channel_models() {
        let mut env = HashMap::new();
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "http://127.0.0.1:8766/ch/open_router".to_string(),
        );
        env.insert("ANTHROPIC_MODEL".to_string(), "glm-4.6".to_string());
        let normalized = normalize_spawn_env(Some(env)).unwrap();
        assert_eq!(
            normalized.get("ANTHROPIC_MODEL").map(String::as_str),
            Some("z-ai/glm-4.6")
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows/WebView2: disable native window occlusion detection. WebView2
    // pauses page rendering/compositing when it thinks the window is fully
    // occluded — but that heuristic misfires under long-running streamed
    // updates (the chat SSE stream + frequent requestAnimationFrame repaints)
    // and when the window sits behind others, freezing the last frame while
    // React state keeps updating underneath. The window only "unfreezes" once
    // it regains focus and WebView2 receives an occlusion-state change. Turning
    // the heuristic off trades a small background power optimisation for a UI
    // that never stalls mid-stream. Must be set before WebView2 is created.
    #[cfg(windows)]
    {
        const WEBVIEW2_ARGS_VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
        const DISABLE_OCCLUSION: &str = "--disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion";
        match std::env::var(WEBVIEW2_ARGS_VAR) {
            Ok(existing) if !existing.is_empty() => {
                if !existing.contains("CalculateNativeWinOcclusion") {
                    std::env::set_var(
                        WEBVIEW2_ARGS_VAR,
                        format!("{existing} {DISABLE_OCCLUSION}"),
                    );
                }
            }
            _ => std::env::set_var(WEBVIEW2_ARGS_VAR, DISABLE_OCCLUSION),
        }
    }

    let builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
            let _ = app.emit(
                SINGLE_INSTANCE_WARNING_EVENT,
                SINGLE_INSTANCE_WARNING_MESSAGE,
            );
        }));

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            start_slash_catalog_scan(app.handle().clone());
            init_vcs_scan_service(app.handle().clone());

            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let window_to_hide = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_to_hide.hide();
                    }
                });
            }

            let tray_menu = MenuBuilder::new(app)
                .text(TRAY_MENU_SHOW_ID, "打开主界面")
                .text(TRAY_MENU_GITHUB_ID, "打开github")
                .separator()
                .text(TRAY_MENU_QUIT_ID, "退出")
                .build()?;

            let mut tray = TrayIconBuilder::with_id("main-tray");
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            let _tray = tray
                .tooltip("UltraGameStudio")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    TRAY_MENU_SHOW_ID => show_main_window(app),
                    TRAY_MENU_GITHUB_ID => {
                        let _ = open_external(GITHUB_REPOSITORY_URL.to_string());
                    }
                    TRAY_MENU_QUIT_ID => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            focus_main_window,
            notify_session_complete,
            migrate_legacy_brand_storage,
            ai_edit_graph,
            run_workflow,
            run_studio,
            ai_cli,
            cancel_ai_cli,
            slash_catalog,
            refresh_slash_catalog,
            skill_install_targets,
            install_skill_from_url,
            install_skill_from_zip_url,
            install_skill_from_text,
            uninstall_skill,
            scan_model_clis,
            validate_cli_path,
            validate_shell_path,
            free_channel_auto_keys,
            local_model_hardware,
            local_model_status,
            local_model_list,
            list_remote_models,
            generate_cloudflare_image,
            setup_local_model,
            setup_comfyui,
            open_external,
            open_workspace_directory,
            list_workspace_dir,
            engine_reveal_asset,
            project_environment_scan,
            project_mcp_probe,
            project_lsp_probe,
            project_lsp_install,
            unity_mcp_setup_project,
            blueprint_mode_status,
            blueprint_mode_install,
            blueprint_mode_uninstall,
            godot_mcp_setup_project,
            cocos_mcp_setup_project,
            ue_mcp_ensure_binary,
            ue_mcp_setup_project,
            workspace_changes_baseline,
            workspace_changes,
            workspace_vcs_status,
            workspace_vcs_status_shallow,
            workspace_file_diff,
            workspace_vcs_status_cached,
            workspace_vcs_status_scan,
            workspace_vcs_status_cancel,
            workspace_changes_cached,
            prepare_isolated_workspace,
            preview_local_file,
            read_local_file_for_upload,
            save_clipboard_image,
            save_session_capture,
            fetch_capture_image_data_url,
            fetch_model_asset_data_url,
            read_model_asset_data_url,
            download_model_asset,
            save_generated_asset,
            list_cached_assets,
            history::history_root,
            history::history_read_json,
            history::history_write_json,
            history::history_remove,
            history::history_list_dir,
            cc_switch_import::import_cc_switch_claude,
            secure_store::secure_secret_get_many,
            secure_store::secure_secret_set,
            secure_store::secure_secret_delete,
            free_proxy::free_proxy_ensure,
            free_proxy::free_proxy_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
