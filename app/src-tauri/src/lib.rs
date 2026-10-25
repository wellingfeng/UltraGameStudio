use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::Emitter;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

mod autosave;
mod cache_cleanup;
mod cc_switch_import;
mod cli_runtime;
mod dsh_log;
mod free_proxy;
mod history;
mod kimi_log;
mod message_platforms;
mod proxy_http;
mod secure_store;
mod skills;
mod storage_paths;
mod system_file_preview;

/// Windows CreateProcess flag: don't allocate a console window for the child.
/// Without this, spawning the `claude` console binary pops up a black terminal
/// window every time the app runs a node. No-op on other platforms.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_MENU_SHOW_ID: &str = "tray-show-main";
const TRAY_MENU_GITHUB_ID: &str = "tray-open-github";
const TRAY_MENU_QUIT_ID: &str = "tray-quit";
/// 退出前冲刷事件：宿主（托盘右键菜单「退出」）先通知前端把内存中的密钥
/// 兜底落盘，等前端确认（ugs_quit_flush_done）后再真正退出，避免
/// 就地编辑的 API Key 因 keychain 异步写未完成而丢失。
const BEFORE_QUIT_EVENT: &str = "ugs:before-quit";
const GITHUB_REPOSITORY_URL: &str = "https://github.com/wellingfeng/UltraGameStudio";
const SINGLE_INSTANCE_WARNING_EVENT: &str = "single-instance-warning";
const SINGLE_INSTANCE_WARNING_MESSAGE: &str = "只能同时运行一个进程";
const SESSION_NOTIFICATION_CLICKED_EVENT: &str = "session-notification-clicked";
const WAITING_INPUT_NOTIFICATION_GROUP: &str = "ugs-wait-input";
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

fn waiting_input_notification_tag(workspace_id: Option<&str>, session_id: Option<&str>) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(workspace_id.unwrap_or("").as_bytes());
    hasher.update([0]);
    hasher.update(session_id.unwrap_or("").as_bytes());
    hex::encode(&hasher.finalize()[..8])
}

#[tauri::command]
fn focus_main_window(app: AppHandle) {
    show_main_window(&app);
}

/// 前端完成退出前冲刷（密钥兜底落盘 + keychain flush）后调用，放行退出。
#[tauri::command]
fn ugs_quit_flush_done(app: AppHandle) {
    app.exit(0);
}

/// 前端决定本次不退出（例如仍有会话在运行，用户点了「取消」）。
/// 把主窗拉回前台，等待用户处理未保存的数据。
#[tauri::command]
fn ugs_quit_cancel(app: AppHandle) {
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
fn dismiss_session_waiting_input_notification(
    app: AppHandle,
    workspace_id: Option<String>,
    session_id: Option<String>,
) -> Result<bool, String> {
    dismiss_waiting_input_notification(app, workspace_id, session_id)
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

    if kind == SessionNotificationKind::WaitingInput {
        return show_windows_waiting_input_notification(app, title, body, payload);
    }

    let app_id = windows_notification_app_id(&app);
    let toast = Toast::new(&app_id)
        .title(&title)
        .text2(&body)
        .duration(Duration::Short);
    toast
        .on_activated(move |_| {
            emit_session_notification_click(&app, payload.clone());
            Ok(())
        })
        .show()
        .map_err(|err| format!("发送 Windows 通知失败: {err}"))?;
    Ok(true)
}

#[cfg(target_os = "windows")]
fn escape_xml_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(target_os = "windows")]
fn show_windows_waiting_input_notification(
    app: AppHandle,
    title: String,
    body: String,
    payload: SessionNotificationClickPayload,
) -> Result<bool, String> {
    use std::time::Duration as StdDuration;
    use windows::{
        core::{IInspectable, HSTRING},
        Data::Xml::Dom::XmlDocument,
        Foundation::TypedEventHandler,
        UI::Notifications::{ToastNotification, ToastNotificationManager},
    };

    let app_id = windows_notification_app_id(&app);
    let tag = waiting_input_notification_tag(
        payload.workspace_id.as_deref(),
        payload.session_id.as_deref(),
    );
    let xml = XmlDocument::new().map_err(|err| format!("创建 Windows 通知 XML 失败: {err}"))?;
    xml.LoadXml(&HSTRING::from(format!(
        r#"<toast duration="long">
            <visual>
                <binding template="ToastGeneric">
                    <text id="1">{}</text>
                    <text id="3">{}</text>
                </binding>
            </visual>
        </toast>"#,
        escape_xml_text(&title),
        escape_xml_text(&body),
    )))
    .map_err(|err| format!("解析 Windows 通知 XML 失败: {err}"))?;
    let toast = ToastNotification::CreateToastNotification(&xml)
        .map_err(|err| format!("创建 Windows 通知失败: {err}"))?;
    toast
        .SetTag(&HSTRING::from(tag))
        .map_err(|err| format!("设置 Windows 通知标签失败: {err}"))?;
    toast
        .SetGroup(&HSTRING::from(WAITING_INPUT_NOTIFICATION_GROUP))
        .map_err(|err| format!("设置 Windows 通知分组失败: {err}"))?;
    toast
        .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, _| {
                emit_session_notification_click(&app, payload.clone());
                Ok(())
            },
        ))
        .map_err(|err| format!("绑定 Windows 通知点击事件失败: {err}"))?;

    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        .and_then(|notifier| notifier.Show(&toast))
        .map_err(|err| format!("发送 Windows 通知失败: {err}"))?;
    std::thread::sleep(StdDuration::from_millis(10));
    Ok(true)
}

#[cfg(target_os = "windows")]
fn dismiss_waiting_input_notification(
    app: AppHandle,
    workspace_id: Option<String>,
    session_id: Option<String>,
) -> Result<bool, String> {
    use windows::{core::HSTRING, UI::Notifications::ToastNotificationManager};

    let app_id = windows_notification_app_id(&app);
    let tag = waiting_input_notification_tag(workspace_id.as_deref(), session_id.as_deref());
    ToastNotificationManager::History()
        .and_then(|history| {
            history.RemoveGroupedTagWithId(
                &HSTRING::from(tag),
                &HSTRING::from(WAITING_INPUT_NOTIFICATION_GROUP),
                &HSTRING::from(app_id),
            )
        })
        .map_err(|err| format!("关闭 Windows 等待输入通知失败: {err}"))?;
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

#[cfg(target_os = "macos")]
fn dismiss_waiting_input_notification(
    _app: AppHandle,
    _workspace_id: Option<String>,
    _session_id: Option<String>,
) -> Result<bool, String> {
    Ok(false)
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

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn dismiss_waiting_input_notification(
    _app: AppHandle,
    _workspace_id: Option<String>,
    _session_id: Option<String>,
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

// ---------------------------------------------------------------------------
// Windows Job Object + orphan-killing machinery
//
// PROBLEM: On Windows, when an AI CLI (claude/codex) exits, its tool-spawned
// descendants (bash → grep/find/rg scanning UE source trees) are NOT
// auto-reaped. `taskkill /T /PID <cli_pid>` only kills processes still in
// the parent-child chain; if an intermediate process (bash) already exited,
// its children are "orphaned" (re-parented to the system) and invisible to
// `taskkill /T`. They keep burning CPU indefinitely.
//
// SOLUTION (3 layers):
//   1. KILL_ON_JOB_CLOSE Job Object: assigned at spawn, guarantees kernel-level
//      cleanup when UGS itself exits/crashes. (existing)
//   2. Per-run_id job handle storage: instead of leaking the handle, store it
//      keyed by run_id so we can explicitly query+kill+close it when the CLI
//      exits, while UGS is still running. (new)
//   3. QueryInformationJobObject(JobObjectBasicProcessIdList): on CLI exit,
//      enumerate ALL PIDs still in the job (including orphaned grandchildren
//      that `taskkill /T` cannot see) and kill each one. Then close the job
//      handle as a final safety net. (new)
//
// The job tracks all processes that inherited it, regardless of whether
// their parent is still alive — this is exactly the semantic needed to
// catch orphans that `taskkill /T` misses.
// ---------------------------------------------------------------------------

/// Registry: run_id → Job Object handle (as isize for Send-safety).
fn active_ai_cli_jobs() -> &'static Mutex<HashMap<String, isize>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, isize>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_ai_cli_job(run_id: &str, job: isize) {
    if let Ok(mut active) = active_ai_cli_jobs().lock() {
        active.insert(run_id.to_string(), job);
    }
}

fn take_ai_cli_job(run_id: &str) -> Option<isize> {
    active_ai_cli_jobs()
        .lock()
        .ok()
        .and_then(|mut active| active.remove(run_id))
}

/// Windows Job Object configured with KILL_ON_JOB_CLOSE. Returns the job
/// handle (as isize) so the caller can store it per-run_id and later
/// query/kill/close it when the CLI exits.
///
/// While the returned handle is alive, every process assigned to the job
/// (and every process those processes spawn, recursively) is guaranteed to
/// be reaped by the kernel the moment the last job handle closes — whether
/// that is an explicit close, a panic unwind, or UGS itself crashing.
#[cfg(windows)]
fn assign_child_to_kill_on_close_job(child: &Child) -> Option<isize> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return None;
        }
        let proc_handle = child.as_raw_handle();
        if AssignProcessToJobObject(job, proc_handle as _) == 0 {
            CloseHandle(job);
            return None;
        }
        // Return the handle — caller stores it per-run_id and explicitly
        // closes it when the CLI exits. If UGS crashes before that, the OS
        // closes all open handles, triggering KILL_ON_JOB_CLOSE.
        Some(job as isize)
    }
}

#[cfg(not(windows))]
fn assign_child_to_kill_on_close_job(_child: &Child) -> Option<isize> {
    None
}

/// Query the Job Object for ALL process PIDs currently assigned to it
/// (including orphaned grandchildren whose intermediate parent already
/// died — they are still in the job because they inherited it at spawn).
/// Kill each one with `taskkill /F /PID`.
///
/// This is the critical function that catches orphans that `taskkill /T`
/// misses: the job tracks membership by inheritance, not by parent-child
/// linkage, so even processes whose parent has exited remain visible.
#[cfg(windows)]
fn kill_job_processes(job: isize) {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject,
    };

    if job == 0 {
        return;
    }

    // JOBOBJECT_BASIC_PROCESS_ID_LIST layout:
    //   NumberOfAssignedProcesses: u32  (4 bytes)
    //   NumberOfProcessIdsInList:  u32 (4 bytes)
    //   ProcessIdList: [usize; N]      (8 bytes each on 64-bit)
    //
    // We allocate stack space for up to 512 PIDs — far more than any AI CLI
    // turn would ever spawn. If the job has more (extremely unlikely), the
    // query fails gracefully and we fall back to `taskkill /T` in
    // `terminate_child_tree`.
    const MAX_PIDS: usize = 512;
    #[repr(C)]
    struct JobPidList {
        assigned: u32,
        in_list: u32,
        pids: [usize; MAX_PIDS],
    }
    let mut buf = JobPidList {
        assigned: 0,
        in_list: 0,
        pids: [0; MAX_PIDS],
    };

    unsafe {
        let ok = QueryInformationJobObject(
            job as *mut _,
            JobObjectBasicProcessIdList,
            &mut buf as *mut _ as *mut _,
            std::mem::size_of::<JobPidList>() as u32,
            std::ptr::null_mut(),
        );
        if ok == 0 {
            return; // query failed — fallback to taskkill /T
        }
        let count = buf.in_list as usize;
        for i in 0..count.min(MAX_PIDS) {
            let pid = buf.pids[i];
            if pid == 0 {
                continue;
            }
            // Kill each process directly. This catches orphans whose parent
            // already exited — they are still in the job's PID list.
            let mut cmd = Command::new("taskkill");
            hide_console(&mut cmd);
            let _ = cmd
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/F")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[cfg(not(windows))]
fn kill_job_processes(_job: isize) {}

/// Close a Job Object handle. If the job has KILL_ON_JOB_CLOSE set, this
/// triggers kernel-level termination of all remaining processes in the job
/// as a final safety net.
#[cfg(windows)]
fn close_job_handle(job: isize) {
    use windows_sys::Win32::Foundation::CloseHandle;
    if job != 0 {
        unsafe {
            let _ = CloseHandle(job as *mut _);
        }
    }
}

#[cfg(not(windows))]
fn close_job_handle(_job: isize) {}

/// Terminate an AI CLI and ALL processes in its Job Object — including
/// orphaned grandchildren (grep/find/rg) whose intermediate parent (bash)
/// already exited and are therefore invisible to `taskkill /T`.
///
/// This is the robust replacement for `terminate_child_tree` in AI CLI
/// contexts. Call this instead of `terminate_child_tree` whenever a
/// `run_id` is available.
///
/// Order of operations:
///   1. Query job for all PIDs (catches orphans) → kill each
///   2. Close job handle (triggers KILL_ON_JOB_CLOSE for stragglers)
///   3. `terminate_child_tree` (taskkill /T + child.kill + child.wait)
fn terminate_ai_cli_tree(child: &mut Child, run_id: &str) {
    if let Some(job) = take_ai_cli_job(run_id) {
        kill_job_processes(job);
        close_job_handle(job);
    }
    terminate_child_tree(child);
}

fn active_ai_cli_pids() -> &'static Mutex<HashMap<String, u32>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone)]
struct ActiveCodexSteer {
    stdin: Arc<Mutex<ChildStdin>>,
    thread_id: Arc<Mutex<Option<String>>>,
    turn_id: Arc<Mutex<Option<String>>>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<(), String>>>>>,
}

#[derive(Clone)]
struct ActiveClaudeSteer {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

/// Live handle for steering an in-flight zcode app-server turn. The steer
/// path writes an extra `session/send` on the SAME session that the writer
/// thread opened, using the shared stdin handle (the Mutex serializes writes
/// with the writer/reader threads). `session_id` is populated by the reader
/// once `session/create`/`session/resume` answers; `pending` collects the
/// per-steer oneshot senders keyed by request id so the reader can route the
/// `session/send` ack/error back to the waiting `steer_ai_cli` call.
#[derive(Clone)]
struct ActiveZcodeSteer {
    stdin: Arc<Mutex<ChildStdin>>,
    session_id: Arc<Mutex<Option<String>>>,
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<Result<(), String>>>>>,
}

#[derive(Clone)]
enum ActiveAiCliSteer {
    Codex(ActiveCodexSteer),
    Claude(ActiveClaudeSteer),
    Zcode(ActiveZcodeSteer),
}

fn active_ai_cli_steers() -> &'static Mutex<HashMap<String, ActiveAiCliSteer>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, ActiveAiCliSteer>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_ai_cli_steer(run_id: &str, state: ActiveAiCliSteer) {
    if let Ok(mut active) = active_ai_cli_steers().lock() {
        active.insert(run_id.to_string(), state);
    }
}

fn unregister_ai_cli_steer(run_id: &str) {
    let state = active_ai_cli_steers()
        .lock()
        .ok()
        .and_then(|mut active| active.remove(run_id));
    match state {
        Some(ActiveAiCliSteer::Codex(state)) => {
            if let Ok(mut pending) = state.pending.lock() {
                for (_, sender) in pending.drain() {
                    let _ = sender.send(Err("Codex turn 已结束。".to_string()));
                }
            }
        }
        Some(ActiveAiCliSteer::Claude(state)) => close_claude_stream_input(&state.stdin),
        Some(ActiveAiCliSteer::Zcode(state)) => {
            if let Ok(mut pending) = state.pending.lock() {
                for (_, sender) in pending.drain() {
                    let _ = sender.send(Err("ZCode turn 已结束。".to_string()));
                }
            }
        }
        None => {}
    }
}

fn cancelled_ai_cli_ids() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn register_ai_cli(run_id: &str, pid: u32) {
    if let Ok(mut active) = active_ai_cli_pids().lock() {
        active.insert(run_id.to_string(), pid);
    }
    if let Ok(mut visible) = active_ai_cli_visible_progress().lock() {
        visible.insert(run_id.to_string(), std::time::Instant::now());
    }
}

fn active_ai_cli_visible_progress() -> &'static Mutex<HashMap<String, std::time::Instant>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, std::time::Instant>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn touch_visible_progress(run_id: &str) {
    if let Ok(mut visible) = active_ai_cli_visible_progress().lock() {
        visible.insert(run_id.to_string(), std::time::Instant::now());
    }
}

fn visible_progress_elapsed(run_id: &str) -> std::time::Duration {
    active_ai_cli_visible_progress()
        .lock()
        .ok()
        .and_then(|visible| visible.get(run_id).map(std::time::Instant::elapsed))
        .unwrap_or_default()
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
    // Safety net: if the job handle wasn't already closed by
    // `terminate_ai_cli_tree`, close it now. This triggers KILL_ON_JOB_CLOSE
    // for any stray orphan processes still in the job.
    if let Some(job) = take_ai_cli_job(run_id) {
        close_job_handle(job);
    }
    if let Ok(mut active) = active_ai_cli_pids().lock() {
        active.remove(run_id);
    }
    if let Ok(mut visible) = active_ai_cli_visible_progress().lock() {
        visible.remove(run_id);
    }
    unregister_ai_cli_steer(run_id);
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
    /// Absolute path the frontend can hand to `convertFileSrc` so the webview
    /// streams the file itself (asset protocol, Range requests) instead of
    /// receiving one giant base64 string through the IPC bridge. Set for every
    /// media/document preview that no longer inlines its bytes.
    stream_path: Option<String>,
    /// Page (PDF/PPTX) or sheet (XLSX) count when the format exposes one. Drives
    /// the paged preview UI.
    page_count: Option<u32>,
}

/// One rendered page/sheet of an Office document, pre-paged in Rust so the
/// webview never receives the whole archive.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficePreviewPage {
    index: u32,
    html: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OfficePreview {
    kind: String,
    page_count: u32,
    pages: Vec<OfficePreviewPage>,
    truncated: bool,
}

/// Downscaled raster returned by `read_image_thumbnail`. Chat chips render many
/// screenshots at once, so they take a few-KB JPEG instead of a full-resolution
/// base64 payload each.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageThumbnail {
    base64: String,
    mime: String,
    width: u32,
    height: u32,
}

const OFFICE_PREVIEW_DEFAULT_PAGES: usize = 5;
const OFFICE_PREVIEW_MAX_PAGES: usize = 50;
const OFFICE_PREVIEW_MAX_ROWS: usize = 200;
const PREVIEW_THUMBNAIL_MAX_EDGE: u32 = 512;
const PREVIEW_THUMBNAIL_QUALITY: u8 = 78;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileUploadPayload {
    bytes_base64: String,
    file_name: String,
    mime: Option<String>,
    size_bytes: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeBaseScanSource {
    path: String,
    kind: Option<String>,
    enabled: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeBaseScannedFile {
    path: String,
    size_bytes: u64,
    modified_at_ms: Option<u64>,
    text: String,
    truncated: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeBaseScanResult {
    files: Vec<KnowledgeBaseScannedFile>,
    skipped_files: usize,
    skipped_dirs: usize,
    total_bytes: u64,
    truncated: bool,
    errors: Vec<String>,
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct P4PendingListCollectResult {
    root_path: String,
    requested_count: usize,
    opened_count: usize,
    stdout: String,
    stderr: String,
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

/// One background job's raw manifest text plus the filesystem observations the
/// pure TS state-machine (`resolveJobStatus` in `lib/backgroundJobs.ts`) needs.
/// The Rust side stays "dumb": it reads, probes existence/liveness, tails the
/// progress file, and hands the facts to TS — it never decides success/failure.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundJobProbe {
    /// The manifest's `.json` filename stem (used to delete it when terminal).
    file_stem: String,
    /// Workspace whose `.ultragamestudio/jobs/` this came from (echoed back so
    /// the frontend can target the right dir when removing a finished job).
    workspace_cwd: Option<String>,
    /// Raw manifest JSON, parsed on the TS side into `BackgroundJobManifest`.
    manifest_json: String,
    artifact_exists: bool,
    done_marker_exists: bool,
    fail_marker_exists: bool,
    /// None when the manifest had no pid; otherwise whether it is a live process.
    pid_alive: Option<bool>,
    /// Last few KB of the progress file, if configured and readable.
    progress_tail: Option<String>,
    /// Unix ms when this probe was taken.
    probed_at_ms: u64,
}

/// Whether `pid` names a live process. Best-effort and cross-platform: any
/// uncertainty resolves to `true` (assume alive) so a probe failure never
/// spuriously flips a running job to "failed" — the TS side only fails a job on
/// a *known-dead* pid.
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                // Access-denied still implies the pid exists; only a clean
                // "no such process" means dead, which we can't distinguish here
                // without the error code — assume alive to stay conservative.
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE as u32
        }
    }
    #[cfg(not(windows))]
    {
        // signal 0 probes existence without delivering a signal.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
}

/// Read up to `max_bytes` from the END of a text file, lossily decoded. Used to
/// scan a long-lived progress log's tail for the latest percentage without
/// slurping a multi-MB file every poll tick.
fn read_file_tail(path: &Path, max_bytes: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
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
            &format!(
                "Use the `{name}` slash-command semantics from {source_en} CLI for this request. {en_detail}"
            ),
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
            [".grok", "skills"],
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
        "kimi" => ("Kimi Code", "Kimi Code"),
        "deepseek-harness" => ("DeepSeek Harness", "DeepSeek Harness"),
        "zcode" => ("ZCode / GLM", "ZCode / GLM"),
        "grok" => ("Grok", "Grok"),
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
            ".grok" => return Some("grok"),
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

fn append_owned_slash_entries(
    global: &Path, cwd: Option<&Path>, entries: &mut Vec<SlashCatalogEntry>, seen: &mut HashSet<String>,
) -> Result<(),String> {
    for (dir, skill) in skills::legacy_owned_entries(global, cwd)? {
        if entries.len() >= MAX_SLASH_ENTRIES { break; }
        let token=slash_token(&skill.name,&skill.relative_path); let name=format!("/{token}");
        if is_app_reserved_slash_name(&name) { continue; }
        let entry=SlashCatalogEntry {
            id:format!("skill:ugs-owned:{}",skill.skill_id), kind:"skill".into(), name:name.clone(),
            label:same_localized_text(&skill.name), detail:same_localized_text(&skill.description),
            insert_text:localized_text(&format!("请按 {name} skill 的工作流处理当前请求。Skill 摘要：{}",skill.description),&format!("Use the {name} skill workflow for this request. Skill summary: {}",skill.description)),
            source:Some(dir.to_string_lossy().into_owned()), source_adapter:None,
        };
        if seen.insert(slash_entry_key(&entry)) { entries.push(entry); }
    }
    Ok(())
}

fn scan_slash_catalog_blocking() -> SlashCatalogSnapshot {
    let mut entries = slash_command_entries();
    let mut seen_keys: HashSet<String> = entries.iter().map(slash_entry_key).collect();

    for (source, root) in command_root_candidates() {
        scan_command_dir(&source, &root, &root, 0, &mut entries, &mut seen_keys);
    }

    // Owned roots use the transaction/recovery gate, never recursive legacy
    // scanning of .state backups. Project-owned entries win same-name conflicts.
    let owned_error = storage_paths::global_root().and_then(|global| {
        let cwd=std::env::current_dir().ok();
        append_owned_slash_entries(&global,cwd.as_deref(),&mut entries,&mut seen_keys)
    }).err();
    for root in skill_root_candidates() {
        scan_skill_dir("local", &root, 0, &mut entries, &mut seen_keys);
    }

    SlashCatalogSnapshot {
        scanned_at_ms: now_ms(),
        ready: true,
        entries,
        error: owned_error,
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

static SKILL_DESKTOP_HOST: OnceLock<Result<Arc<skills::SkillDesktopHost>, String>> = OnceLock::new();

fn skill_desktop_host() -> Result<&'static Arc<skills::SkillDesktopHost>, String> {
    SKILL_DESKTOP_HOST
        .get_or_init(|| storage_paths::global_root().map(|root| Arc::new(skills::SkillDesktopHost::new(root))))
        .as_ref()
        .map_err(Clone::clone)
}

fn require_skill_app(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "cannot verify skills IPC caller")?;
    let origin = match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), url.host_str().unwrap_or_default()),
        None => format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default()),
    };
    skills::SkillDesktopHost::validate_app_caller(window.label(), &origin, cfg!(debug_assertions))
}

/// App orchestration supplies the frozen config/evidence before invoking the
/// model-facing request. Never expose this binding command as a model tool.
#[tauri::command]
async fn skills_bind_run(window: tauri::WebviewWindow, request: skills::SkillHostBindingRequest) -> Result<serde_json::Value, String> {
    require_skill_app(&window)?;
    let host = Arc::clone(skill_desktop_host()?);
    tauri::async_runtime::spawn_blocking(move || {
        let origin = request.origin.clone(); let mode = request.mode;
        let actor = match request.actor {
            skills::SkillHostActor::Background => "background",
            skills::SkillHostActor::User => "user",
        };
        host.bind(request)?;
        Ok(serde_json::json!({"origin":origin,"mode":mode,"actor":actor}))
    }).await.map_err(|e|format!("skills binding worker failed: {e}"))?
}

#[tauri::command]
async fn skills_revoke_run(window: tauri::WebviewWindow, origin: skills::SkillOrigin) -> Result<(), String> {
    require_skill_app(&window)?;
    let host = Arc::clone(skill_desktop_host()?);
    tauri::async_runtime::spawn_blocking(move || host.revoke(&origin))
        .await.map_err(|e|format!("skills revoke worker failed: {e}"))?
}

#[tauri::command]
async fn skills_request(app: AppHandle, window: tauri::WebviewWindow, request: skills::SkillServiceRequest) -> Result<serde_json::Value, String> {
    require_skill_app(&window)?;
    let host = Arc::clone(skill_desktop_host()?);
    tauri::async_runtime::spawn_blocking(move || host.request_with_update(request, |origin,catalog| {
        let _ = app.emit("skills-catalog-updated", serde_json::json!({"origin":origin,"catalog":catalog}));
        start_slash_catalog_scan(app.clone());
    })).await.map_err(|e|format!("skills request worker failed: {e}"))?
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
            "grok" => ("Grok 项目 Skill (.grok/skills)", [".grok", "skills"]),
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
            codex_user_home_dir()
                .unwrap_or_else(|| home.join(".codex"))
                .join("skills"),
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
        "global-grok" => (
            "global-grok".to_string(),
            "全局 Grok Skills (~/.grok/skills)".to_string(),
            home.join(".grok").join("skills"),
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

// ============================================================================
// 能力统一翻译：把 UGS 的 skill / MCP / LSP 能力翻译成各 agent 的原生格式并写入其
// 原生配置位置（离线生成，不介入 agent 运行时）。核心原则：
//   - skill  → 复用现有 SKILL.md 安装器，按 agent 写入 global + project 根目录；
//   - MCP    → Claude 写项目 .mcp.json、Codex 写 ~/.codex/config.toml、Gemini 写
//              ~/.gemini/settings.json（各自原生格式）；
//   - LSP    → 运行时能力，无法文本翻译；生成统一目录清单，各 agent 复用同一 LSP。
// 不支持原生配置格式的 agent（kimi / deepseek / zcode）会在结果中明确标记为「待接入」。
// ============================================================================

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityTranslateRequest {
    kind: String,
    project_root: Option<String>,
    targets: Vec<String>,
    #[serde(default)]
    overwrite: bool,
    name: Option<String>,
    slug: Option<String>,
    text: Option<String>,
    source_path: Option<String>,
    #[serde(default)]
    servers: Option<Vec<serde_json::Value>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityTranslateTargetResult {
    agent: String,
    label: String,
    ok: bool,
    path: Option<String>,
    message: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityTranslateResult {
    kind: String,
    results: Vec<CapabilityTranslateTargetResult>,
}

fn translate_agent_label(agent: &str) -> String {
    match agent {
        "claude-code" => "Claude Code".to_string(),
        "codex" => "Codex".to_string(),
        "gemini" => "Gemini".to_string(),
        "agents" => "Agents (跨 agent 标准)".to_string(),
        "kimi" => "Kimi Code".to_string(),
        "deepseek-harness" => "DeepSeek Harness".to_string(),
        "zcode" => "ZCode / GLM".to_string(),
        "grok" => "Grok".to_string(),
        other => other.to_string(),
    }
}

/// 每个 agent 对应的 skill 安装目标 id（global + 项目内）。Gemini 目前只有 global 根。
fn skill_target_ids_for_agent(agent: &str) -> Vec<&'static str> {
    match agent {
        "claude-code" => vec!["global-claude", "project-claude"],
        "codex" => vec!["global-codex", "project-codex"],
        "gemini" => vec!["global-gemini"],
        "grok" => vec!["global-grok", "project-grok"],
        "agents" => vec!["global-agents", "project-agents"],
        _ => vec![],
    }
}

fn translate_skill_to_agents_blocking(
    req: &CapabilityTranslateRequest,
) -> Result<CapabilityTranslateResult, String> {
    let text = match req.text.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => {
            let src = req
                .source_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "缺少 skill 文本或来源路径。".to_string())?;
            let src_path = PathBuf::from(src);
            let skill_file = if src_path.is_file() {
                src_path
            } else {
                src_path.join("SKILL.md")
            };
            std::fs::read_to_string(&skill_file)
                .map_err(|e| format!("读取 skill 来源失败（{}）：{e}", skill_file.display()))?
        }
    };
    if text.trim().is_empty() {
        return Err("Skill 内容为空，无法翻译。".to_string());
    }
    let name = req.name.clone().unwrap_or_default();
    let slug = req.slug.clone().unwrap_or_default();
    let project_root = req.project_root.clone();
    let mut results = Vec::new();

    for agent in &req.targets {
        let target_ids = skill_target_ids_for_agent(agent);
        if target_ids.is_empty() {
            results.push(CapabilityTranslateTargetResult {
                agent: agent.clone(),
                label: translate_agent_label(agent),
                ok: false,
                path: None,
                message: "该 agent 尚无标准 skill 安装目录，待接入。".to_string(),
            });
            continue;
        }
        let mut written = 0usize;
        let mut skipped = 0usize;
        let mut errors: Vec<String> = Vec::new();
        let mut first_path: Option<String> = None;
        for target_id in &target_ids {
            if target_id.starts_with("project-")
                && project_root
                    .as_deref()
                    .map(str::trim)
                    .unwrap_or("")
                    .is_empty()
            {
                continue;
            }
            match install_skill_from_text_blocking(
                text.clone(),
                name.clone(),
                slug.clone(),
                (*target_id).to_string(),
                req.overwrite,
                None,
                project_root.clone(),
                None,
            ) {
                Ok(installed) => {
                    written += 1;
                    if first_path.is_none() {
                        first_path = Some(installed.skill_file);
                    }
                }
                Err(e) if e.contains("已存在") => skipped += 1,
                Err(e) => errors.push(e),
            }
        }
        let ok = errors.is_empty() && written > 0;
        let message = if ok {
            let mut parts = vec![format!("已写入 {written} 处")];
            if skipped > 0 {
                parts.push(format!("{skipped} 处已存在（未覆盖）"));
            }
            parts.join("，")
        } else if written == 0 && skipped > 0 && errors.is_empty() {
            format!("{skipped} 处已存在，未覆盖（可勾选「覆盖」重写）")
        } else if errors.is_empty() {
            "无可用写入位置".to_string()
        } else {
            errors.join("；")
        };
        results.push(CapabilityTranslateTargetResult {
            agent: agent.clone(),
            label: translate_agent_label(agent),
            ok,
            path: first_path,
            message,
        });
    }

    Ok(CapabilityTranslateResult {
        kind: "skill".to_string(),
        results,
    })
}

/// 把 MCP server 表合并进一个 JSON 文件（Claude `.mcp.json` 与 Gemini `settings.json`
/// 都使用 `mcpServers` 这一键；Gemini 额外写 `trust: true`）。
fn merge_mcp_servers_into_json(
    path: &Path,
    servers: &serde_json::Map<String, serde_json::Value>,
    trust: bool,
) -> Result<(), String> {
    let mut doc: serde_json::Value = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() {
        doc = serde_json::json!({});
    }
    let root_obj = doc.as_object_mut().unwrap();
    let mcp = root_obj
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !mcp.is_object() {
        *mcp = serde_json::json!({});
    }
    let mcp_obj = mcp.as_object_mut().unwrap();
    for (id, entry) in servers {
        let mut e = entry.clone();
        if trust {
            if let Some(o) = e.as_object_mut() {
                o.insert("trust".to_string(), serde_json::Value::Bool(true));
            }
        }
        mcp_obj.insert(id.clone(), e);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let serialized =
        serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化 JSON 失败：{e}"))?;
    atomic_write(path, serialized.as_bytes())
        .map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    Ok(())
}

/// Root of the user's Codex home: `CODEX_HOME` when set (codex itself honours
/// it, as does `cli_runtime::preferred_codex_path`), else `~/.codex`. Keeping
/// UGS's config/MCP writes on the same root codex actually reads avoids the
/// "UGS edited a file codex never opens" class of bug.
fn codex_user_home_dir() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("CODEX_HOME") {
        let trimmed = configured.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    user_home_dir().map(|home| home.join(".codex"))
}

fn codex_mcp_config_path() -> Option<PathBuf> {
    codex_user_home_dir().map(|home| home.join("config.toml"))
}

/// Whether `~/.codex/config.toml` explicitly selects a non-default
/// `model_provider` (e.g. a relay defined via `[model_providers.<id>]`, like the
/// common `model_provider = "sss"` + `[model_providers.sss]` layout). A top-level
/// `model_provider = "openai"` (or absent) means no custom routing and UGS may
/// still override the endpoint via `OPENAI_BASE_URL`.
///
/// When a named provider is selected, UGS must NOT inject `OPENAI_BASE_URL` /
/// `OPENAI_API_KEY` env: codex resolves the provider, `wire_api` and credential
/// from its own (already working) config + `auth.json`, and overriding them
/// redirects the request off the configured relay — whose `wire_api`/auth no
/// longer match, so the relay rejects the turn (surfaced by UGS as
/// `CLI "..." turn status failed` after an HTTP 40x).
fn codex_config_selects_named_provider(config_toml: &str) -> bool {
    config_toml
        .parse::<toml::Value>()
        .ok()
        .and_then(|doc| {
            doc.get("model_provider")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .map(|selected| selected.trim().to_owned())
        .map(|selected| !selected.is_empty() && selected != "openai")
        .unwrap_or(false)
}

/// Read `~/.codex/config.toml` (if present) and decide whether codex already
/// routes through a named model provider that UGS should respect.
fn codex_uses_named_model_provider() -> bool {
    let Some(path) = codex_mcp_config_path() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    codex_config_selects_named_provider(&text)
}

/// Env var UGS exports the selected channel's key under for Codex spawns.
/// Overriding `model_providers.<provider>.env_key` to this name is what makes
/// 设置 → 模型 the credential codex actually sends.
const CODEX_CHANNEL_KEY_ENV: &str = "UGS_CODEX_CHANNEL_KEY";

/// The non-default `model_provider` selected by a `config.toml`, or None.
fn codex_selected_provider(config_toml: &str) -> Option<String> {
    config_toml
        .parse::<toml::Value>()
        .ok()?
        .get("model_provider")?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "openai")
        .map(str::to_owned)
}

/// The named provider whose credential slot UGS may override, if the user's
/// `config.toml` selects a provider that is actually declared. `-c
/// model_providers.<provider>.env_key=…` needs the table to exist, otherwise
/// codex would resolve a provider with no `base_url`/`name`.
fn codex_provider_for_credential_override(config_toml: &str) -> Option<String> {
    let provider = codex_selected_provider(config_toml)?;
    config_toml
        .parse::<toml::Value>()
        .ok()?
        .get("model_providers")?
        .get(&provider)?;
    Some(provider)
}

/// Report the provider whose credential slot this spawn should override, having
/// re-read the user's `config.toml` (same file `codex_config_selects_named_provider`
/// resolves through `CODEX_HOME`).
fn codex_provider_credential_override() -> Option<String> {
    let text = std::fs::read_to_string(codex_mcp_config_path()?).ok()?;
    codex_provider_for_credential_override(&text)
}

/// Codex 原生 MCP 配置写入 `~/.codex/config.toml` 的 `[mcp_servers.<name>]`。
fn merge_codex_mcp_servers(
    servers: &serde_json::Map<String, serde_json::Value>,
) -> Result<PathBuf, String> {
    let path = codex_mcp_config_path().ok_or_else(|| "未找到用户主目录。".to_string())?;
    let mut doc: toml::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| text.parse::<toml::Value>().ok())
        .unwrap_or_else(|| toml::Value::Table(toml::map::Map::new()));
    let table = doc
        .as_table_mut()
        .ok_or_else(|| "~/.codex/config.toml 不是有效的 TOML 表。".to_string())?;
    let mcp = table
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    let mcp_table = mcp
        .as_table_mut()
        .ok_or_else(|| "mcp_servers 不是 TOML 表。".to_string())?;

    let mut count = 0usize;
    for (id, entry) in servers {
        let Some(entry_obj) = entry.as_object() else {
            continue;
        };
        let mut server = toml::map::Map::new();
        if let Some(cmd) = entry_obj.get("command").and_then(|v| v.as_str()) {
            server.insert("command".to_string(), toml::Value::String(cmd.to_string()));
        }
        if let Some(args) = entry_obj.get("args").and_then(|v| v.as_array()) {
            let arr = args
                .iter()
                .filter_map(|a| a.as_str())
                .map(|s| toml::Value::String(s.to_string()))
                .collect::<Vec<_>>();
            server.insert("args".to_string(), toml::Value::Array(arr));
        }
        if let Some(env) = entry_obj.get("env").and_then(|v| v.as_object()) {
            let mut env_map = toml::map::Map::new();
            for (k, v) in env {
                if let Some(vs) = v.as_str() {
                    env_map.insert(k.clone(), toml::Value::String(vs.to_string()));
                }
            }
            server.insert("env".to_string(), toml::Value::Table(env_map));
        }
        mcp_table.insert(id.clone(), toml::Value::Table(server));
        count += 1;
    }
    if count == 0 {
        return Err("没有可翻译的 MCP server。".to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let serialized = toml::to_string_pretty(&doc).map_err(|e| format!("序列化 TOML 失败：{e}"))?;
    atomic_write(&path, serialized.as_bytes())
        .map_err(|e| format!("写入 config.toml 失败：{e}"))?;
    Ok(path)
}

fn translate_mcp_to_agents_blocking(
    req: &CapabilityTranslateRequest,
) -> Result<CapabilityTranslateResult, String> {
    let servers = req.servers.clone().unwrap_or_default();
    let settings_json = serde_json::json!({
        "mcp": { "enabled": true, "servers": servers }
    });
    let cwd = req.project_root.clone().unwrap_or_default();
    let mcp_json = project_mcp_settings_json_from_settings(&settings_json, Some(cwd.as_str()))
        .ok_or_else(|| "没有可翻译的 MCP server（请先启用至少一个 MCP）。".to_string())?;
    let servers_map = mcp_json
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .cloned()
        .ok_or_else(|| "MCP server 转换为空。".to_string())?;

    let mut results = Vec::new();
    for agent in &req.targets {
        let outcome: Result<Option<PathBuf>, String> = match agent.as_str() {
            "claude-code" => {
                let root = project_scan_root(cwd.trim())?;
                let path = root.join(".mcp.json");
                merge_mcp_servers_into_json(&path, &servers_map, false)?;
                Ok(Some(path))
            }
            "codex" => merge_codex_mcp_servers(&servers_map).map(Some),
            "gemini" => {
                let home = user_home_dir().ok_or_else(|| "未找到用户主目录。".to_string())?;
                let path = home.join(".gemini").join("settings.json");
                merge_mcp_servers_into_json(&path, &servers_map, true)?;
                Ok(Some(path))
            }
            other => Err(format!(
                "该 agent（{other}）尚无标准 MCP 配置文件，待接入。"
            )),
        };
        match outcome {
            Ok(path) => results.push(CapabilityTranslateTargetResult {
                agent: agent.clone(),
                label: translate_agent_label(agent),
                ok: true,
                path: path.map(|p| display_preview_path(&p)),
                message: "已写入原生 MCP 配置".to_string(),
            }),
            Err(e) => results.push(CapabilityTranslateTargetResult {
                agent: agent.clone(),
                label: translate_agent_label(agent),
                ok: false,
                path: None,
                message: e,
            }),
        }
    }

    Ok(CapabilityTranslateResult {
        kind: "mcp".to_string(),
        results,
    })
}

fn translate_lsp_to_agents_blocking(
    req: &CapabilityTranslateRequest,
) -> Result<CapabilityTranslateResult, String> {
    let servers = req.servers.clone().unwrap_or_default();
    let enabled = servers
        .iter()
        .filter(|s| s.get("enabled").and_then(|v| v.as_bool()) == Some(true))
        .collect::<Vec<_>>();
    if enabled.is_empty() {
        return Err("没有已启用的 LSP server（请先启用至少一个 LSP）。".to_string());
    }

    let root = project_scan_root(
        req.project_root
            .as_deref()
            .map(str::trim)
            .unwrap_or_default(),
    )?;
    let manifest_dir = root.join(".ugs");
    std::fs::create_dir_all(&manifest_dir).map_err(|e| format!("创建 .ugs 目录失败：{e}"))?;

    let mut manifest_servers = Vec::new();
    for server in &enabled {
        let id = server.get("id").and_then(|v| v.as_str()).unwrap_or("lsp");
        let command = server
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let args = server
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut entry = serde_json::Map::new();
        entry.insert("id".to_string(), serde_json::Value::String(id.to_string()));
        if let Some(cmd) = command {
            entry.insert(
                "command".to_string(),
                serde_json::Value::String(cmd.to_string()),
            );
        }
        entry.insert(
            "args".to_string(),
            serde_json::Value::Array(args.into_iter().map(serde_json::Value::String).collect()),
        );
        manifest_servers.push(serde_json::Value::Object(entry));
    }

    let manifest = serde_json::json!({
        "version": 1,
        "kind": "lsp",
        "servers": manifest_servers
    });
    let path = manifest_dir.join("lsp-manifest.json");
    let serialized =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("序列化清单失败：{e}"))?;
    atomic_write(&path, serialized.as_bytes()).map_err(|e| format!("写入 LSP 清单失败：{e}"))?;

    let mut results = Vec::new();
    for agent in &req.targets {
        results.push(CapabilityTranslateTargetResult {
            agent: agent.clone(),
            label: translate_agent_label(agent),
            ok: true,
            path: Some(display_preview_path(&path)),
            message: "LSP 是运行时能力，无法文本翻译；已生成统一目录清单，各 agent 复用同一 LSP 进程/配置。"
                .to_string(),
        });
    }
    Ok(CapabilityTranslateResult {
        kind: "lsp".to_string(),
        results,
    })
}

fn capability_translate_blocking(
    req: CapabilityTranslateRequest,
) -> Result<CapabilityTranslateResult, String> {
    match req.kind.as_str() {
        "skill" => translate_skill_to_agents_blocking(&req),
        "mcp" => translate_mcp_to_agents_blocking(&req),
        "lsp" => translate_lsp_to_agents_blocking(&req),
        other => Err(format!("未知能力类型：{other}")),
    }
}

#[tauri::command]
async fn translate_capability(
    app: AppHandle,
    request: CapabilityTranslateRequest,
) -> Result<CapabilityTranslateResult, String> {
    let result =
        tauri::async_runtime::spawn_blocking(move || capability_translate_blocking(request))
            .await
            .map_err(|e| format!("翻译任务失败：{e}"))??;
    if result.kind == "skill" {
        let _ = refresh_slash_catalog_async(app).await;
    }
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
/// 仅内联 SVG 保留这个上限：位图/文档改走 asset protocol 后不再随体积线性拖慢读取，
/// 上限失去意义（历史遗留的 64MB 文档拒绝逻辑也已随之删除）。
const PREVIEW_IMAGE_LIMIT: u64 = 12 * 1024 * 1024;
const PREVIEW_BASENAME_SEARCH_LIMIT: usize = 20_000;
const CLIPBOARD_IMAGE_LIMIT: usize = 32 * 1024 * 1024;
const CLIPBOARD_VIDEO_LIMIT: usize = 512 * 1024 * 1024;
const SESSION_CAPTURE_LIMIT: usize = 128 * 1024 * 1024;
const LOCAL_FILE_UPLOAD_LIMIT: u64 = 128 * 1024 * 1024;
const KNOWLEDGE_BASE_MAX_FILES: usize = 1200;
const KNOWLEDGE_BASE_MAX_TOTAL_BYTES: u64 = 16 * 1024 * 1024;
const KNOWLEDGE_BASE_MAX_FILE_BYTES: u64 = 768 * 1024;
const KNOWLEDGE_BASE_MAX_DOCX_BYTES: u64 = 8 * 1024 * 1024;
const KNOWLEDGE_BASE_MAX_DEPTH: usize = 16;
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

/// `.ultragamestudio` 下对用户有意义的"素材产物"目录。文件树与会话变更扫描
/// 只在 `.ultragamestudio` 这一层暴露这些目录（粘贴图片、生成的模型/截图、
/// 以及 `docs/` 下的调研报告等 AI 交付物），继续隐藏
/// jobs/session-changes/sidecar 等内部状态。
const WORKSPACE_TREE_PRODUCT_DIRS: &[&str] = &[
    "assets",
    "clipboard-images",
    "docs",
    "model-assets",
    "session-captures",
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

/// 文件树列表专用：根层放行 `.ultragamestudio`（作为隐藏的产物根），
/// 进入 `.ultragamestudio` 后只保留素材产物目录，其余仍走通用排除规则。
fn workspace_tree_list_excluded_dir(parent: &str, name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == ".ultragamestudio" {
        return false;
    }
    if parent == ".ultragamestudio" {
        return !WORKSPACE_TREE_PRODUCT_DIRS
            .iter()
            .any(|product| lower == *product);
    }
    workspace_tree_excluded_dir(name)
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
        if is_dir && workspace_tree_list_excluded_dir(&relative_path, &name) {
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
        Ok(_) => {
            EngineRevealResult::new("unreal", true, "jumped", "已在 Unreal 编辑器中定位资产。")
        }
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
        ("grok", "Grok 项目 Skill", ".grok/skills"),
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
            };
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
            };
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

fn bun_command_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "bun.exe"
    } else {
        "bun"
    }
}

fn is_bun_global_shim_path(exe: &str) -> bool {
    let normalized = exe.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/.bun/bin/")
}

fn bun_command_for_shim(exe: &str) -> String {
    let path = std::path::Path::new(exe);
    if path.is_absolute() {
        if let Some(parent) = path.parent() {
            return parent
                .join(bun_command_name())
                .to_string_lossy()
                .to_string();
        }
    }
    bun_command_name().to_string()
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
                // 会话变更要用文件树那套"部分放行"规则，而不是通用排除规则：
                // 通用规则会把整个 `.ultragamestudio` 挡在外面，于是 AI 按工作区
                // 约定写进 `.ultragamestudio/docs/` 的交付物永远进不了变更快照，
                // 「会话文件」面板就一直是 0 个文件。
                if !workspace_tree_list_excluded_dir(&relative_dir, &name) {
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
const P4_PENDING_COLLECT_TIMEOUT_MS: u64 = 30_000;
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
    workspace_file_diff_root_and_relative_path_inner(root, path, false)
        .map(|(_, relative_path)| relative_path)
}

fn workspace_file_diff_absolute_path_fallback(path: &Path) -> Option<(PathBuf, String)> {
    let file_name = path.file_name()?.to_string_lossy().trim().to_string();
    if file_name.is_empty() {
        return None;
    }
    let parent = path.parent()?.to_path_buf();
    if !parent.is_dir() {
        return None;
    }
    let root = std::fs::canonicalize(&parent).unwrap_or(parent);
    Some((root, normalize_vcs_status_path(&file_name)))
}

fn workspace_file_diff_root_and_relative_path(
    root: &Path,
    path: &str,
) -> Result<(PathBuf, String), String> {
    workspace_file_diff_root_and_relative_path_inner(root, path, true)
}

fn workspace_file_diff_root_and_relative_path_inner(
    root: &Path,
    path: &str,
    allow_external_absolute_path: bool,
) -> Result<(PathBuf, String), String> {
    let normalized = normalize_preview_separators(path.trim());
    if normalized.trim().is_empty() {
        return Err("缺少文件路径。".to_string());
    }

    if normalized.starts_with("//") {
        return Ok((root.to_path_buf(), normalize_p4_mapping_path(&normalized)));
    }

    let candidate = PathBuf::from(&normalized);
    if candidate.is_absolute() {
        if let Some(relative) = local_status_path_from_root(root, &normalized) {
            return Ok((root.to_path_buf(), relative));
        }
        if let Ok(canonical) = std::fs::canonicalize(&candidate) {
            if let Some(relative) = local_status_path_from_root(root, &canonical.to_string_lossy())
            {
                return Ok((root.to_path_buf(), relative));
            }
        }
        if allow_external_absolute_path {
            if let Some(fallback) = workspace_file_diff_absolute_path_fallback(&candidate) {
                return Ok(fallback);
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
    Ok((root.to_path_buf(), relative))
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
    let (diff_root, relative_path) = workspace_file_diff_root_and_relative_path(&root, &path)?;
    vcs_workspace_file_change(&diff_root, &relative_path)
}

fn p4_collect_opened_count(stdout: &str) -> usize {
    stdout
        .lines()
        .filter(|line| line.to_ascii_lowercase().contains("opened for"))
        .count()
}

fn p4_collect_error_is_noop(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    p4_error_is_empty_result("reconcile", stderr) || lower.contains("already opened")
}

fn p4_collect_to_pending_list_blocking(
    root_path: String,
    paths: Vec<String>,
) -> Result<P4PendingListCollectResult, String> {
    let (root, _) = workspace_tree_resolve_dir(&root_path, "")?;
    let mut specs = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let relative = workspace_file_diff_relative_path(&root, &path)?;
        if seen.insert(relative.clone()) {
            specs.push(relative);
        }
    }

    if specs.is_empty() {
        return Err("缺少要收集到 P4 pending list 的文件。".to_string());
    }

    let probe = run_workspace_status_command(&root, "p4", &["info"])
        .map_err(|err| format!("P4 检测失败: {err}"))?;
    if probe.timed_out {
        return Err("P4 检测超时。".to_string());
    }
    if !probe.success {
        return Err(format!(
            "当前工作区不是可用的 P4 工作区: {}",
            workspace_status_error(&probe)
        ));
    }

    let args = p4_status_args(&["reconcile", "-ead"], &specs);
    let output = run_workspace_status_command_owned_with_timeout(
        &root,
        "p4",
        &args,
        std::time::Duration::from_millis(P4_PENDING_COLLECT_TIMEOUT_MS),
    )
    .map_err(|err| format!("P4 收集失败: {err}"))?;

    let opened_count = p4_collect_opened_count(&format!("{}\n{}", output.stdout, output.stderr));
    let noop_result = p4_collect_error_is_noop(&output.stderr);
    if output.timed_out {
        return Err("P4 收集到 pending list 超时。".to_string());
    }
    if !output.success && !noop_result {
        return Err(format!(
            "P4 收集到 pending list 失败: {}",
            workspace_status_error(&output)
        ));
    }

    Ok(P4PendingListCollectResult {
        root_path: display_preview_path(&root),
        requested_count: specs.len(),
        opened_count,
        stdout: output.stdout.trim().to_string(),
        stderr: output.stderr.trim().to_string(),
    })
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
                } else if !cache_key.starts_with("turn:")
                    && snapshot_modified_since(&new, baseline.generated_at_ms)
                {
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
    if cache_key.starts_with("turn:") {
        // Per-turn fallback data is attached to the message. Discard large
        // baseline contents instead of retaining one full workspace per turn.
        let baseline_file = workspace_change_cache_file(&root, &cache_key, "baseline");
        let _ = std::fs::remove_file(baseline_file);
    } else {
        let cache_file = workspace_change_cache_file(&root, &cache_key, "changes");
        write_json_cache(&cache_file, &changes)?;
    }
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

#[tauri::command]
async fn p4_collect_to_pending_list(
    root_path: String,
    paths: Vec<String>,
) -> Result<P4PendingListCollectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        p4_collect_to_pending_list_blocking(root_path, paths)
    })
    .await
    .map_err(|e| format!("P4 收集任务失败: {e}"))?
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

fn video_mime_for_path(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" | "qt" => Some("video/quicktime"),
        "ogv" => Some("video/ogg"),
        "avi" => Some("video/x-msvideo"),
        "mkv" => Some("video/x-matroska"),
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
        "obj" | "bvh" | "asf" | "amc" => Some("text/plain"),
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

fn knowledge_base_allowed_text_ext(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "" | "txt"
            | "md"
            | "mdx"
            | "markdown"
            | "rst"
            | "adoc"
            | "csv"
            | "tsv"
            | "json"
            | "jsonc"
            | "json5"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "scss"
            | "less"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "cjs"
            | "mjs"
            | "py"
            | "lua"
            | "cs"
            | "cpp"
            | "c"
            | "h"
            | "hpp"
            | "java"
            | "kt"
            | "rs"
            | "go"
            | "rb"
            | "php"
            | "sh"
            | "bat"
            | "cmd"
            | "ps1"
            | "uproject"
            | "uplugin"
    )
}

fn knowledge_base_is_docx(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("docx"))
        .unwrap_or(false)
}

fn knowledge_base_skip_dir(path: &Path) -> bool {
    if skip_preview_search_dir(path) {
        return true;
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    matches!(
        name,
        ".ultragamestudio"
            | ".worktree"
            | ".omc"
            | "Binaries"
            | "DerivedDataCache"
            | "Intermediate"
            | "Library"
            | "Saved"
            | "Temp"
    )
}

fn knowledge_base_modified_at_ms(metadata: &std::fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn decode_xml_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }
        let mut entity = String::new();
        while let Some(next) = chars.peek().copied() {
            chars.next();
            if next == ';' {
                break;
            }
            entity.push(next);
            if entity.len() > 16 {
                break;
            }
        }
        match entity.as_str() {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            _ if entity.starts_with("#x") => {
                if let Ok(code) = u32::from_str_radix(&entity[2..], 16) {
                    if let Some(decoded) = char::from_u32(code) {
                        out.push(decoded);
                    }
                }
            }
            _ if entity.starts_with('#') => {
                if let Ok(code) = entity[1..].parse::<u32>() {
                    if let Some(decoded) = char::from_u32(code) {
                        out.push(decoded);
                    }
                }
            }
            _ => {
                out.push('&');
                out.push_str(&entity);
                out.push(';');
            }
        }
    }
    out
}

fn word_xml_text(xml: &str) -> String {
    let mut out = String::new();
    let mut tag = String::new();
    let mut in_tag = false;
    for ch in xml.chars() {
        if in_tag {
            if ch == '>' {
                let tag_name = tag.trim();
                if tag_name.starts_with("/w:p")
                    || tag_name.starts_with("w:br")
                    || tag_name.starts_with("/w:tr")
                {
                    out.push('\n');
                } else if tag_name.starts_with("/w:tc") || tag_name.starts_with("w:tab") {
                    out.push('\t');
                }
                tag.clear();
                in_tag = false;
            } else {
                tag.push(ch);
            }
            continue;
        }
        if ch == '<' {
            in_tag = true;
            tag.clear();
        } else {
            out.push(ch);
        }
    }
    decode_xml_entities(&out)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_docx_text(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("打开 docx 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解析 docx 失败：{e}"))?;
    let mut sections = Vec::new();
    for name in [
        "word/document.xml",
        "word/footnotes.xml",
        "word/endnotes.xml",
        "word/comments.xml",
    ] {
        let Ok(mut entry) = archive.by_name(name) else {
            continue;
        };
        let mut xml = String::new();
        if entry.read_to_string(&mut xml).is_ok() {
            let text = word_xml_text(&xml);
            if !text.trim().is_empty() {
                sections.push(text);
            }
        }
    }
    Ok(sections.join("\n\n"))
}

fn read_knowledge_base_file(path: &Path) -> Result<Option<KnowledgeBaseScannedFile>, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !metadata.is_file() {
        return Ok(None);
    }
    let size_bytes = metadata.len();
    if knowledge_base_is_docx(path) {
        if size_bytes > KNOWLEDGE_BASE_MAX_DOCX_BYTES {
            return Ok(None);
        }
        let text = extract_docx_text(path)?;
        if text.trim().is_empty() {
            return Ok(None);
        }
        return Ok(Some(KnowledgeBaseScannedFile {
            path: display_preview_path(path),
            size_bytes,
            modified_at_ms: knowledge_base_modified_at_ms(&metadata),
            text,
            truncated: false,
        }));
    }
    if !knowledge_base_allowed_text_ext(path) {
        return Ok(None);
    }
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(KNOWLEDGE_BASE_MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("读取文件失败：{e}"))?;
    let truncated = bytes.len() as u64 > KNOWLEDGE_BASE_MAX_FILE_BYTES
        || size_bytes > KNOWLEDGE_BASE_MAX_FILE_BYTES;
    if bytes.len() as u64 > KNOWLEDGE_BASE_MAX_FILE_BYTES {
        bytes.truncate(KNOWLEDGE_BASE_MAX_FILE_BYTES as usize);
    }
    if !has_utf16_bom(&bytes) && probably_binary(&bytes) {
        return Ok(None);
    }
    let Some(text) = decode_preview_text(bytes) else {
        return Ok(None);
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(KnowledgeBaseScannedFile {
        path: display_preview_path(path),
        size_bytes,
        modified_at_ms: knowledge_base_modified_at_ms(&metadata),
        text,
        truncated,
    }))
}

fn push_knowledge_base_file(result: &mut KnowledgeBaseScanResult, path: &Path) {
    if result.files.len() >= KNOWLEDGE_BASE_MAX_FILES {
        result.truncated = true;
        result.skipped_files += 1;
        return;
    }
    match read_knowledge_base_file(path) {
        Ok(Some(file)) => {
            let counted = file.size_bytes.min(KNOWLEDGE_BASE_MAX_FILE_BYTES);
            if result.total_bytes.saturating_add(counted) > KNOWLEDGE_BASE_MAX_TOTAL_BYTES {
                result.truncated = true;
                result.skipped_files += 1;
                return;
            }
            result.total_bytes = result.total_bytes.saturating_add(counted);
            result.truncated = result.truncated || file.truncated;
            result.files.push(file);
        }
        Ok(None) => {
            result.skipped_files += 1;
        }
        Err(err) => {
            result.skipped_files += 1;
            if result.errors.len() < 20 {
                result
                    .errors
                    .push(format!("{}: {err}", display_preview_path(path)));
            }
        }
    }
}

fn knowledge_base_scan_files_blocking(
    sources: Vec<KnowledgeBaseScanSource>,
) -> Result<KnowledgeBaseScanResult, String> {
    let mut result = KnowledgeBaseScanResult {
        files: Vec::new(),
        skipped_files: 0,
        skipped_dirs: 0,
        total_bytes: 0,
        truncated: false,
        errors: Vec::new(),
    };
    let mut queue: VecDeque<(PathBuf, usize)> = VecDeque::new();
    let mut seen_dirs = HashSet::new();

    for source in sources {
        if source.enabled == Some(false) {
            continue;
        }
        let path = normalize_preview_separators(&source.path);
        let raw = preview_path(&path, None)?;
        let resolved = std::fs::canonicalize(&raw).unwrap_or(raw);
        let metadata = match std::fs::metadata(&resolved) {
            Ok(metadata) => metadata,
            Err(err) => {
                result
                    .errors
                    .push(format!("{}: 路径不可读：{err}", source.path));
                continue;
            }
        };
        let requested_file = source.kind.as_deref() == Some("file");
        if requested_file && !metadata.is_file() {
            result
                .errors
                .push(format!("{}: 配置为文件，但目标不是文件。", source.path));
            continue;
        }
        if metadata.is_file() {
            push_knowledge_base_file(&mut result, &resolved);
        } else if metadata.is_dir() {
            queue.push_back((resolved, 0));
        } else {
            result.skipped_files += 1;
        }
    }

    while let Some((dir, depth)) = queue.pop_front() {
        if result.files.len() >= KNOWLEDGE_BASE_MAX_FILES
            || result.total_bytes >= KNOWLEDGE_BASE_MAX_TOTAL_BYTES
        {
            result.truncated = true;
            break;
        }
        if depth > KNOWLEDGE_BASE_MAX_DEPTH || knowledge_base_skip_dir(&dir) {
            result.skipped_dirs += 1;
            continue;
        }
        let canonical = std::fs::canonicalize(&dir).unwrap_or(dir.clone());
        if !seen_dirs.insert(canonical.clone()) {
            continue;
        }
        let mut entries = match std::fs::read_dir(&canonical) {
            Ok(entries) => entries.filter_map(Result::ok).collect::<Vec<_>>(),
            Err(err) => {
                result.skipped_dirs += 1;
                if result.errors.len() < 20 {
                    result.errors.push(format!(
                        "{}: 读取目录失败：{err}",
                        display_preview_path(&canonical)
                    ));
                }
                continue;
            }
        };
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                result.skipped_files += 1;
                continue;
            };
            let path = entry.path();
            if file_type.is_symlink() {
                result.skipped_files += 1;
            } else if file_type.is_dir() {
                queue.push_back((path, depth + 1));
            } else if file_type.is_file() {
                push_knowledge_base_file(&mut result, &path);
            }
            if result.files.len() >= KNOWLEDGE_BASE_MAX_FILES
                || result.total_bytes >= KNOWLEDGE_BASE_MAX_TOTAL_BYTES
            {
                result.truncated = true;
                break;
            }
        }
    }

    result.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}

#[tauri::command]
async fn knowledge_base_scan_files(
    sources: Vec<KnowledgeBaseScanSource>,
) -> Result<KnowledgeBaseScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || knowledge_base_scan_files_blocking(sources))
        .await
        .map_err(|e| format!("知识库扫描任务失败: {e}"))?
}

/// Path handed to the frontend for `convertFileSrc`. Reuses the display
/// normaliser so Windows' canonical `\\?\` prefix — which the asset protocol
/// scope would never match — is stripped before the path reaches the webview.
fn preview_stream_path(path: &std::path::Path) -> String {
    display_preview_path(path)
}

fn preview_extension(path: &std::path::Path) -> String {
    path.extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Number of slides (PPTX) or worksheets (XLSX) inside an OOXML container.
/// DOCX has no fixed pagination, so it reports `None` and the frontend renders
/// the flowed document instead of paging it.
fn office_page_count(path: &std::path::Path, ext: &str) -> Option<u32> {
    let prefix = match ext {
        "pptx" => "ppt/slides/slide",
        "xlsx" => "xl/worksheets/sheet",
        _ => return None,
    };
    let file = std::fs::File::open(path).ok()?;
    let archive = zip::ZipArchive::new(file).ok()?;
    let count = archive
        .file_names()
        .filter(|name| {
            name.starts_with(prefix) && name.ends_with(".xml") && !name.contains("/_rels/")
        })
        .count();
    (count > 0).then_some(count as u32)
}

/// Decode the XML entities that actually occur in OOXML text runs.
fn unescape_ooxml_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let (replacement, consumed) = if tail.starts_with("&amp;") {
            ("&", 5)
        } else if tail.starts_with("&lt;") {
            ("<", 4)
        } else if tail.starts_with("&gt;") {
            (">", 4)
        } else if tail.starts_with("&quot;") {
            ("\"", 6)
        } else if tail.starts_with("&apos;") {
            ("'", 6)
        } else {
            ("&", 1)
        };
        out.push_str(replacement);
        rest = &tail[consumed..];
    }
    out.push_str(rest);
    out
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Inner XML of every `<tag>` / `<tag attr="…">` element, in document order.
/// Returns raw (still-escaped) slices so callers can recurse into nested
/// elements before decoding text. A search for `t` will not match `table`.
fn collect_element_inner<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open_head = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut inners = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = xml[cursor..].find(&open_head) {
        let start = cursor + rel;
        let after_head = start + open_head.len();
        let Some(attr_len) = xml[after_head..].find('>') else {
            break;
        };
        let opener_end = after_head + attr_len + 1;
        let rest = &xml[after_head..opener_end];
        let well_formed = rest.starts_with('>')
            || rest.starts_with('/')
            || rest.starts_with(char::is_whitespace);
        if !well_formed {
            cursor = after_head;
            continue;
        }
        if rest.starts_with('/') {
            cursor = opener_end;
            continue;
        }
        let Some(end_rel) = xml[opener_end..].find(&close) else {
            break;
        };
        inners.push(&xml[opener_end..opener_end + end_rel]);
        cursor = opener_end + end_rel + close.len();
    }
    inners
}

/// Opener + inner XML of every `<tag …>` element, so callers can still inspect
/// attributes (XLSX uses `t="s"` to mark shared-string cells).
fn collect_elements<'a>(xml: &'a str, tag: &str) -> Vec<(&'a str, &'a str)> {
    let open_head = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut elements = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = xml[cursor..].find(&open_head) {
        let start = cursor + rel;
        let after_head = start + open_head.len();
        let Some(attr_len) = xml[after_head..].find('>') else {
            break;
        };
        let opener_end = after_head + attr_len + 1;
        let rest = &xml[after_head..opener_end];
        let well_formed = rest.starts_with('>')
            || rest.starts_with('/')
            || rest.starts_with(char::is_whitespace);
        if !well_formed {
            cursor = after_head;
            continue;
        }
        if rest.starts_with('/') {
            cursor = opener_end;
            continue;
        }
        let Some(end_rel) = xml[opener_end..].find(&close) else {
            break;
        };
        elements.push((&xml[start..opener_end], &xml[opener_end..opener_end + end_rel]));
        cursor = opener_end + end_rel + close.len();
    }
    elements
}

fn read_zip_entry(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
) -> Option<String> {
    let mut entry = archive.by_name(name).ok()?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut entry, &mut text).ok()?;
    Some(text)
}

/// `(index, name)` for the numbered parts under `prefix`, ordered by index so
/// slide 2 always follows slide 1.
fn office_sorted_entries(
    archive: &mut zip::ZipArchive<std::fs::File>,
    prefix: &str,
) -> Vec<(u32, String)> {
    let mut entries: Vec<(u32, String)> = archive
        .file_names()
        .filter(|name| {
            name.starts_with(prefix) && name.ends_with(".xml") && !name.contains("/_rels/")
        })
        .map(|name| {
            let index = name[prefix.len()..name.len() - 4]
                .parse::<u32>()
                .unwrap_or(u32::MAX);
            (index, name.to_string())
        })
        .collect();
    entries.sort_by_key(|(index, _)| *index);
    entries
}

/// Text runs of a slide, one paragraph per `<a:t>` run group. PowerPoint keeps
/// no paragraph boundary we can trust, so runs become lines.
fn pptx_page_html(slide_xml: &str, index: u32) -> String {
    let mut html = format!("<h2>第 {index} 页</h2>");
    let mut wrote = false;
    for run in collect_element_inner(slide_xml, "a:t") {
        let text = unescape_ooxml_text(run);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        html.push_str("<p>");
        html.push_str(&escape_html_text(trimmed));
        html.push_str("</p>");
        wrote = true;
    }
    if !wrote {
        html.push_str("<p class=\"preview-empty\">本页没有可提取的文本（可能是图片或图表）。</p>");
    }
    html
}

fn xlsx_cell_text(inner: &str, opener: &str, shared: &[String]) -> String {
    // Inline strings keep their text in `<is><t>`.
    if let Some(text) = collect_element_inner(inner, "t").into_iter().next() {
        return unescape_ooxml_text(text);
    }
    let Some(value) = collect_element_inner(inner, "v").into_iter().next() else {
        return String::new();
    };
    if opener.contains("t=\"s\"") || opener.contains("t='s'") {
        let index = value.trim().parse::<usize>().unwrap_or(usize::MAX);
        return shared.get(index).cloned().unwrap_or_default();
    }
    value.to_string()
}

fn xlsx_page_html(sheet_xml: &str, shared: &[String], index: u32, max_rows: usize) -> String {
    let rows = collect_elements(sheet_xml, "row");
    let total_rows = rows.len();
    let mut html = format!("<h2>工作表 {index}</h2><table><tbody>");
    for (row_index, (_, row_inner)) in rows.iter().take(max_rows).enumerate() {
        html.push_str("<tr><th class=\"preview-row-number\">");
        html.push_str(&(row_index + 1).to_string());
        html.push_str("</th>");
        for (opener, cell_inner) in collect_elements(row_inner, "c") {
            let text = xlsx_cell_text(cell_inner, opener, shared);
            html.push_str("<td>");
            html.push_str(&escape_html_text(&text));
            html.push_str("</td>");
        }
        html.push_str("</tr>");
    }
    html.push_str("</tbody></table>");
    if total_rows > max_rows {
        html.push_str(&format!(
            "<p class=\"preview-empty\">仅显示前 {max_rows} 行，共 {total_rows} 行。</p>"
        ));
    }
    html
}

fn preview_office_document_blocking(
    path: String,
    cwd: Option<String>,
    max_pages: Option<usize>,
) -> Result<OfficePreview, String> {
    let path = normalize_preview_separators(&path);
    let resolved = preview_path(&path, cwd.as_deref())?;
    let resolved = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    let ext = preview_extension(&resolved);
    let max_pages = max_pages
        .unwrap_or(OFFICE_PREVIEW_DEFAULT_PAGES)
        .clamp(1, OFFICE_PREVIEW_MAX_PAGES);

    let file = std::fs::File::open(&resolved).map_err(|e| format!("打开文档失败：{e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("解析文档结构失败：{e}"))?;

    match ext.as_str() {
        "pptx" => {
            let slides = office_sorted_entries(&mut archive, "ppt/slides/slide");
            let page_count = slides.len() as u32;
            let mut pages = Vec::new();
            for (index, name) in slides.into_iter().take(max_pages) {
                let Some(xml) = read_zip_entry(&mut archive, &name) else {
                    continue;
                };
                pages.push(OfficePreviewPage {
                    index,
                    html: pptx_page_html(&xml, index),
                });
            }
            Ok(OfficePreview {
                kind: "pptx".to_string(),
                page_count,
                truncated: page_count as usize > pages.len(),
                pages,
            })
        }
        "xlsx" => {
            let shared = read_zip_entry(&mut archive, "xl/sharedStrings.xml")
                .map(|xml| {
                    collect_element_inner(&xml, "si")
                        .into_iter()
                        .map(|entry| {
                            collect_element_inner(entry, "t")
                                .into_iter()
                                .map(unescape_ooxml_text)
                                .collect::<String>()
                        })
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            let sheets = office_sorted_entries(&mut archive, "xl/worksheets/sheet");
            let page_count = sheets.len() as u32;
            let mut pages = Vec::new();
            for (index, name) in sheets.into_iter().take(max_pages) {
                let Some(xml) = read_zip_entry(&mut archive, &name) else {
                    continue;
                };
                pages.push(OfficePreviewPage {
                    index,
                    html: xlsx_page_html(&xml, &shared, index, OFFICE_PREVIEW_MAX_ROWS),
                });
            }
            Ok(OfficePreview {
                kind: "xlsx".to_string(),
                page_count,
                truncated: page_count as usize > pages.len(),
                pages,
            })
        }
        other => Err(format!("预览器暂不支持分页读取 .{other} 文档。")),
    }
}

fn binary_file_preview(resolved: &Path, path: String, file_name: String, size_bytes: u64) -> LocalFilePreview {
    use base64::Engine;
    let thumbnail = system_file_preview::thumbnail(resolved);
    let has_thumbnail = thumbnail.is_some();
    LocalFilePreview {
        path, file_name, size_bytes,
        kind: if has_thumbnail { "image" } else { "binary" }.to_string(),
        mime: has_thumbnail.then(|| "image/png".to_string()),
        truncated: false, text: None,
        base64: thumbnail.map(|png| base64::engine::general_purpose::STANDARD.encode(png)),
        stream_path: None, page_count: None,
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
        // SVG is markup and stays cheap inline; every raster format streams. A
        // 12 MB screenshot base64-encodes to ~16 MB and had to be serialised
        // through IPC before the webview could even start decoding, so the
        // asset protocol (Range requests, native decoding) wins for bitmaps.
        if mime == "image/svg+xml" && size_bytes <= PREVIEW_IMAGE_LIMIT {
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
                stream_path: None,
                page_count: None,
            });
        }
        return Ok(LocalFilePreview {
            path,
            file_name,
            kind: "image".to_string(),
            mime: Some(mime.to_string()),
            size_bytes,
            truncated: false,
            text: None,
            base64: None,
            stream_path: Some(preview_stream_path(&resolved)),
            page_count: None,
        });
    }

    if let Some(mime) = document_mime_for_path(&resolved) {
        let ext = preview_extension(&resolved);
        // PDF renders through the paged pdf.js viewer; the OOXML family is a zip
        // container and renders through `preview_office_document`, which pulls
        // only the leading slides/sheets instead of the whole archive.
        let kind = if ext == "pdf" { "document" } else { "office" };
        return Ok(LocalFilePreview {
            path,
            file_name,
            kind: kind.to_string(),
            mime: Some(mime.to_string()),
            size_bytes,
            truncated: false,
            text: None,
            base64: None,
            stream_path: Some(preview_stream_path(&resolved)),
            page_count: office_page_count(&resolved, &ext),
        });
    }

    // Videos are streamed by the frontend through the asset protocol (Range
    // requests), so we only report metadata instead of base64-encoding a
    // potentially very large file into the IPC payload.
    if let Some(mime) = video_mime_for_path(&resolved) {
        return Ok(LocalFilePreview {
            path,
            file_name,
            kind: "video".to_string(),
            mime: Some(mime.to_string()),
            size_bytes,
            truncated: false,
            text: None,
            base64: None,
            stream_path: Some(preview_stream_path(&resolved)),
            page_count: None,
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
        return Ok(binary_file_preview(&resolved, path, file_name, size_bytes));
    }

    let Some(text) = decode_preview_text(bytes) else {
        return Ok(binary_file_preview(&resolved, path, file_name, size_bytes));
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
        // HTML previews load through the asset protocol so relative
        // stylesheets/images resolve and the 1.5 MB text cap stops applying.
        stream_path: (text_mime_for_path(&resolved) == "text/html")
            .then(|| preview_stream_path(&resolved)),
        page_count: None,
    })
}

/// Open the file's directory in the asset protocol scope so `convertFileSrc`
/// URLs resolve. Without this the protocol returns 403 for anything outside the
/// app's own resources. Covers video, image, PDF, Office and HTML previews.
fn allow_preview_stream(app: &AppHandle, preview: &LocalFilePreview) {
    let Some(stream) = preview.stream_path.as_deref() else {
        return;
    };
    let stream = std::path::Path::new(stream);
    let absolute = std::fs::canonicalize(stream).unwrap_or_else(|_| stream.to_path_buf());
    if let Some(parent) = absolute.parent() {
        // HTML commonly keeps styles, scripts and images in child directories.
        // Scope those resources to this document's directory; other previews
        // still authorize only their immediate directory.
        let recursive = preview.mime.as_deref() == Some("text/html");
        let _ = app.asset_protocol_scope().allow_directory(parent, recursive);
    }
}

#[tauri::command]
async fn preview_local_file(
    app: AppHandle,
    path: String,
    cwd: Option<String>,
) -> Result<LocalFilePreview, String> {
    let preview =
        tauri::async_runtime::spawn_blocking(move || preview_local_file_blocking(path, cwd))
            .await
            .map_err(|e| format!("文件预览任务失败: {e}"))??;

    allow_preview_stream(&app, &preview);
    Ok(preview)
}

/// 把本地文件所在目录加入 asset protocol scope，使 `convertFileSrc(path)`
/// 生成的 URL 能加载。聊天 / md 预览里内嵌的本地图片先调它，否则 403。
#[tauri::command]
fn ensure_local_asset_scope(app: AppHandle, path: String) -> Result<(), String> {
    let target = std::path::Path::new(&path);
    let absolute = std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
    let Some(parent) = absolute.parent() else {
        return Err("路径没有父目录".to_string());
    };
    let _ = app.asset_protocol_scope().allow_directory(parent, false);
    Ok(())
}

/// Paged read of a PPTX/XLSX: only the leading slides/sheets are parsed, so a
/// 200-slide deck costs the same as a 5-slide one.
#[tauri::command]
async fn preview_office_document(
    path: String,
    cwd: Option<String>,
    max_pages: Option<usize>,
) -> Result<OfficePreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        preview_office_document_blocking(path, cwd, max_pages)
    })
    .await
    .map_err(|e| format!("文档分页读取任务失败: {e}"))?
}

/// Small JPEG for chat thumbnails; always decodes at most `max_edge` pixels on
/// the long side, so a 12 MB screenshot yields a few KB.
#[tauri::command]
async fn read_image_thumbnail(
    path: String,
    cwd: Option<String>,
    max_edge: Option<u32>,
) -> Result<ImageThumbnail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_image_thumbnail_blocking(path, cwd, max_edge)
    })
    .await
    .map_err(|e| format!("缩略图任务失败: {e}"))?
}

fn read_image_thumbnail_blocking(
    path: String,
    cwd: Option<String>,
    max_edge: Option<u32>,
) -> Result<ImageThumbnail, String> {
    let path = normalize_preview_separators(&path);
    let resolved = preview_path(&path, cwd.as_deref())?;
    let resolved = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    let max_edge = max_edge
        .unwrap_or(PREVIEW_THUMBNAIL_MAX_EDGE)
        .clamp(32, 2048);

    let image = image::ImageReader::open(&resolved)
        .map_err(|e| format!("打开图片失败：{e}"))?
        .with_guessed_format()
        .map_err(|e| format!("识别图片格式失败：{e}"))?
        .decode()
        .map_err(|e| format!("解码图片失败：{e}"))?;

    // `thumbnail` keeps the aspect ratio and never upscales, so a small icon
    // passes through unchanged while a 4K screenshot collapses to a few KB.
    let thumb = image.thumbnail(max_edge, max_edge).to_rgb8();
    let (width, height) = thumb.dimensions();
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, PREVIEW_THUMBNAIL_QUALITY)
        .encode(thumb.as_raw(), width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("编码缩略图失败：{e}"))?;

    use base64::Engine;
    Ok(ImageThumbnail {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime: "image/jpeg".to_string(),
        width,
        height,
    })
}

#[tauri::command]
async fn file_exists(path: String, cwd: Option<String>) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let path = normalize_preview_separators(&path);
        let Ok(resolved) = preview_path(&path, cwd.as_deref()) else {
            return false;
        };
        if resolved.exists() {
            return true;
        }
        preview_depot_path_fallback(&path, cwd.as_deref())
            .or_else(|| preview_workspace_app_fallback(&path, cwd.as_deref()))
            .or_else(|| preview_bare_name_fallback(&path, cwd.as_deref()))
            .map(|p| p.exists())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
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
        "video/mp4" => return Ok("mp4"),
        "video/webm" => return Ok("webm"),
        "video/quicktime" => return Ok("mov"),
        "video/ogg" => return Ok("ogv"),
        "video/x-msvideo" => return Ok("avi"),
        "video/x-matroska" => return Ok("mkv"),
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
        "mp4" | "m4v" => Ok("mp4"),
        "mov" | "qt" => Ok("mov"),
        "ogv" => Ok("ogv"),
        "avi" => Ok("avi"),
        "mkv" => Ok("mkv"),
        _ => Err(
            "仅支持 PNG/JPEG/WebP/GIF/BMP/AVIF 图片或 MP4/WebM/MOV/AVI/MKV 视频粘贴。".to_string(),
        ),
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
            "bvh" => return "bvh",
            "asf" => return "asf",
            "amc" => return "amc",
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
        .map_err(|e| format!("解析粘贴内容失败：{e}"))?;

    if bytes.is_empty() {
        return Err("粘贴内容为空。".to_string());
    }
    let is_video = matches!(ext, "mp4" | "webm" | "mov" | "ogv" | "avi" | "mkv");
    let limit = if is_video {
        CLIPBOARD_VIDEO_LIMIT
    } else {
        CLIPBOARD_IMAGE_LIMIT
    };
    if bytes.len() > limit {
        return Err(if is_video {
            "粘贴视频过大，最大支持 512MB。".to_string()
        } else {
            "粘贴图片过大，最大支持 32MB。".to_string()
        });
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

/// Pull the string field `key` out of a manifest JSON value, trimmed & non-empty.
fn manifest_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Probe a single `.ultragamestudio/jobs/*.json` manifest into the fact bundle
/// the TS state-machine consumes. Returns None for unreadable/foreign files so a
/// stray non-job file in the dir is silently skipped.
fn probe_background_job(
    path: &Path,
    workspace_cwd: Option<&str>,
    now_ms: u64,
) -> Option<BackgroundJobProbe> {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return None;
    }
    let manifest_json = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&manifest_json).ok()?;
    // Only accept our own manifests; anything else in the dir is ignored.
    if value.get("schema").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let done = value
        .get("done")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let artifact_path = manifest_str(&done, "artifactPath");
    let done_marker = manifest_str(&done, "doneMarkerPath");
    let fail_marker = manifest_str(&done, "failMarkerPath");

    let pid_alive = value
        .get("pid")
        .and_then(|v| v.as_u64())
        .map(|pid| pid_is_alive(pid as u32));

    let progress_tail =
        manifest_str(&value, "progressFile").and_then(|p| read_file_tail(Path::new(p), 16 * 1024));

    let file_stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    Some(BackgroundJobProbe {
        file_stem,
        workspace_cwd: workspace_cwd.map(|s| s.to_string()),
        manifest_json,
        artifact_exists: artifact_path.is_some_and(|p| Path::new(p).exists()),
        done_marker_exists: done_marker.is_some_and(|p| Path::new(p).exists()),
        fail_marker_exists: fail_marker.is_some_and(|p| Path::new(p).exists()),
        pid_alive,
        progress_tail,
        probed_at_ms: now_ms,
    })
}

/// Scan the `jobs/` dir under one workspace's `.ultragamestudio` and probe each
/// manifest. `cwd` selects the workspace; None uses the global tmp fallback that
/// `managed_artifact_dir` resolves to.
fn list_background_jobs_blocking(cwd: Option<String>) -> Result<Vec<BackgroundJobProbe>, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let jobs_dir = storage_paths::managed_artifact_dir(cwd.as_deref(), "jobs");
    let mut out = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&jobs_dir) {
        for entry in read_dir.flatten() {
            if let Some(probe) = probe_background_job(&entry.path(), cwd.as_deref(), now_ms) {
                out.push(probe);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
async fn list_background_jobs(cwd: Option<String>) -> Result<Vec<BackgroundJobProbe>, String> {
    tauri::async_runtime::spawn_blocking(move || list_background_jobs_blocking(cwd))
        .await
        .map_err(|e| format!("读取后台任务清单失败: {e}"))?
}

/// Delete a terminal job's manifest (and optional done/fail markers) from a
/// workspace's `jobs/` dir so a finished job stops being re-probed. Missing
/// files are treated as success (idempotent).
#[tauri::command]
async fn remove_background_job(cwd: Option<String>, file_stem: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if file_stem.is_empty() || file_stem.contains(['/', '\\', '.']) {
            return Err("非法的任务标识".into());
        }
        let jobs_dir = storage_paths::managed_artifact_dir(cwd.as_deref(), "jobs");
        let manifest = jobs_dir.join(format!("{file_stem}.json"));
        if manifest.exists() {
            std::fs::remove_file(&manifest).map_err(|e| format!("删除任务清单失败: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("删除后台任务失败: {e}"))?
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

// ---------------------------------------------------------------------------
// Model CLI version check + one-click update (claude / codex / gemini).
//
// Each vendor has a different update story:
//   - claude: native `claude update` subcommand. The ai_cli spawn path
//     already sets DISABLE_AUTOUPDATER/DISABLE_UPDATES so a live chat/run
//     never races a mid-session self-update (see `disable_autoupdater`
//     below); this command is the only place that intentionally triggers one.
//   - codex: native `codex update` subcommand.
//   - gemini: no self-update path; refreshed through the package manager that
//     owns the detected shim (`bun install -g ...` for ~/.bun/bin, else npm).
// "Latest version" is read from the npm registry for all three — Anthropic's
// native-installer channel tracks the npm package version closely enough to
// use it as a freshness signal even when `claude` itself isn't npm-installed.
// ---------------------------------------------------------------------------

const CLI_VERSION_CACHE_REL_PATH: &str = "settings/cliVersionCache.v1.json";
const CLI_VERSION_CACHE_TTL_MS: u64 = 12 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy)]
struct CliUpdateSpec {
    adapter: &'static str,
    label: &'static str,
    npm_package: &'static str,
    /// True when a missing CLI can be provisioned through the package manager
    /// (`npm install -g <npm_package>@latest`) rather than requiring the
    /// vendor's native installer. The same command doubles as the updater.
    installable: bool,
}

const CLI_UPDATE_SPECS: &[CliUpdateSpec] = &[
    CliUpdateSpec {
        adapter: "claude-code",
        label: "Claude Code",
        npm_package: "@anthropic-ai/claude-code",
        installable: false,
    },
    CliUpdateSpec {
        adapter: "codex",
        label: "Codex",
        npm_package: "@openai/codex",
        installable: false,
    },
    CliUpdateSpec {
        adapter: "gemini",
        label: "Gemini CLI",
        npm_package: "@google/gemini-cli",
        installable: true,
    },
    CliUpdateSpec {
        adapter: "kimi",
        label: "Kimi Code",
        npm_package: "@moonshot-ai/kimi-code",
        installable: true,
    },
    CliUpdateSpec {
        adapter: "deepseek-harness",
        label: "DeepSeek Harness",
        npm_package: "@deepseek-ai/dsh",
        installable: true,
    },
    CliUpdateSpec {
        adapter: "zcode",
        label: "ZCode / GLM",
        npm_package: "zcode-app-cli",
        installable: true,
    },
    CliUpdateSpec {
        adapter: "grok",
        label: "Grok",
        npm_package: "@xai-official/grok",
        installable: true,
    },
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliVersionStatus {
    adapter: String,
    label: String,
    executable_path: Option<String>,
    installed_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    checked_at_ms: u64,
    error: Option<String>,
    /// True when the CLI is missing but can be one-click installed via npm.
    installable: bool,
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
struct CliVersionCacheEntry {
    latest_version: String,
    fetched_at_ms: u64,
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct CliVersionCache {
    #[serde(default)]
    entries: HashMap<String, CliVersionCacheEntry>,
}

fn cli_version_cache_path() -> Option<PathBuf> {
    let root = storage_paths::global_root().ok()?;
    Some(root.join(CLI_VERSION_CACHE_REL_PATH.replace('/', std::path::MAIN_SEPARATOR_STR)))
}

fn load_cli_version_cache() -> CliVersionCache {
    cli_version_cache_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_cli_version_cache(cache: &CliVersionCache) {
    let Some(path) = cli_version_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, text);
    }
}

/// Extract the first `\d+(\.\d+)+` run from CLI `--version` output. Each
/// vendor formats it differently (`2.1.197 (Claude Code)`, `codex-cli
/// 0.142.5`, bare `0.38.2`), so scanning for the numeric pattern is more
/// robust than three bespoke parsers.
fn extract_semver(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            let mut j = i;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                j += 1;
            }
            let mut end = j;
            while end > start && bytes[end - 1] == b'.' {
                end -= 1;
            }
            let candidate = &text[start..end];
            let dots = candidate.matches('.').count();
            let looks_like_version = dots >= 1
                && candidate
                    .split('.')
                    .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
            if looks_like_version {
                // Capture optional prerelease / build suffix so installed versions
                // like `0.1.0-rc.6` or `3.7.7-13` are read exactly instead of being
                // truncated to the release core.
                let mut end = j;
                if end < bytes.len() && (bytes[end] == b'-' || bytes[end] == b'+') {
                    let sep_end = end + 1;
                    end += 1;
                    while end < bytes.len()
                        && (bytes[end].is_ascii_alphanumeric()
                            || bytes[end] == b'.'
                            || bytes[end] == b'-')
                    {
                        end += 1;
                    }
                    if end == sep_end {
                        end -= 1;
                    }
                }
                let version =
                    text[start..end].trim_end_matches(|c: char| c == '.' || c == '-' || c == '+');
                return Some(version.to_string());
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

fn normalize_version(version: &str) -> String {
    version
        .trim()
        .trim_start_matches(|c: char| c == 'v' || c == 'V')
        .to_string()
}

/// True when `current` differs from `latest` after normalization. We treat the
/// manifest/npm registry as the source of truth: any difference means an update
/// is available, which avoids parsing the wide variety of vendor version formats.
fn version_needs_update(current: &str, latest: &str) -> bool {
    normalize_version(current) != normalize_version(latest)
}

fn cli_version_probe_command(executable_path: &str) -> Command {
    // npm-shim loss fallback: when `%APPDATA%\npm\dsh.cmd` is gone (an npm
    // update that died between "remove old shim" and "rename the temp shim"),
    // the CLI scan resolves the *package JS entry* instead — see
    // `cli_runtime::dsh_npm_entry_fallback`, which hands back
    // `…/node_modules/@deepseek-ai/dsh/lib/bin.js`. That file has no executable
    // association, so a direct spawn fails and the panel reports
    // "无法读取当前版本" while the chat path (which node-wraps the same entry)
    // keeps working. Wrap it with `node` exactly like the launcher does.
    if executable_path.to_ascii_lowercase().ends_with(".js") {
        let mut cmd = new_spawn_command("node");
        cmd.arg(executable_path);
        cmd.arg("--version");
        return cmd;
    }

    let mut cmd = spawn_cli_command(executable_path);
    cmd.arg("--version");
    cmd
}

fn read_cli_installed_version(executable_path: &str) -> Option<String> {
    let cmd = cli_version_probe_command(executable_path);
    let text = command_text_output_with_timeout(cmd, std::time::Duration::from_secs(10)).ok()?;
    extract_semver(&text)
}

fn fetch_npm_latest_version(package: &str) -> Result<String, String> {
    let url = format!("https://registry.npmjs.org/{package}/latest");
    let response = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(6))
        .set("User-Agent", "UltraGameStudio")
        .call()
        .map_err(|err| match err {
            ureq::Error::Status(code, _) => format!("HTTP {code}"),
            other => other.to_string(),
        })?;
    let json: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("解析 npm registry 响应失败：{e}"))?;
    json.get("version")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .ok_or_else(|| "npm registry 响应缺少 version 字段".to_string())
}

fn cli_latest_version_cached(
    spec: &CliUpdateSpec,
    cache: &mut CliVersionCache,
    now: u64,
    dirty: &mut bool,
) -> Option<String> {
    if let Some(entry) = cache.entries.get(spec.npm_package) {
        if now.saturating_sub(entry.fetched_at_ms) < CLI_VERSION_CACHE_TTL_MS {
            return Some(entry.latest_version.clone());
        }
    }
    match fetch_npm_latest_version(spec.npm_package) {
        Ok(version) => {
            cache.entries.insert(
                spec.npm_package.to_string(),
                CliVersionCacheEntry {
                    latest_version: version.clone(),
                    fetched_at_ms: now,
                },
            );
            *dirty = true;
            Some(version)
        }
        // Network hiccup: fall back to whatever we last cached (even if
        // stale) rather than reporting "unknown" every time Wi-Fi blips.
        Err(_) => cache
            .entries
            .get(spec.npm_package)
            .map(|e| e.latest_version.clone()),
    }
}

fn check_cli_updates_blocking() -> Vec<CliVersionStatus> {
    let scan = cli_runtime::scan_model_clis();
    let mut cache = load_cli_version_cache();
    let mut dirty = false;
    let now = now_ms();

    let results = CLI_UPDATE_SPECS
        .iter()
        .map(|spec| {
            let candidate = scan
                .candidates
                .iter()
                .find(|c| c.adapter == spec.adapter && c.available);
            let executable_path = candidate.and_then(|c| c.path.clone());
            let installed_version = executable_path
                .as_deref()
                .and_then(read_cli_installed_version);
            let latest_version = cli_latest_version_cached(spec, &mut cache, now, &mut dirty);
            let update_available = match (&installed_version, &latest_version) {
                (Some(cur), Some(latest)) => version_needs_update(cur, latest),
                _ => false,
            };
            // A missing npm-provisionable CLI (gemini/dsh) is not an error:
            // the panel offers a one-click "install" instead of a red hint.
            let installable = spec.installable && executable_path.is_none();
            let error = if executable_path.is_none() {
                if installable {
                    None
                } else {
                    Some(format!(
                        "未检测到 {} 可执行文件，请先在设置中配置 CLI 路径。",
                        spec.label
                    ))
                }
            } else if installed_version.is_none() {
                Some("无法读取当前版本（--version 无输出或超时）。".to_string())
            } else if latest_version.is_none() {
                Some("无法获取最新版本，请检查网络后重试。".to_string())
            } else {
                None
            };
            CliVersionStatus {
                adapter: spec.adapter.to_string(),
                label: spec.label.to_string(),
                executable_path,
                installed_version,
                latest_version,
                update_available,
                checked_at_ms: now,
                error,
                installable,
            }
        })
        .collect();

    if dirty {
        save_cli_version_cache(&cache);
    }
    results
}

fn run_cli_update_blocking(adapter: &str) -> Result<String, String> {
    let spec = CLI_UPDATE_SPECS
        .iter()
        .find(|s| s.adapter == adapter)
        .ok_or_else(|| format!("未知的 CLI: {adapter}"))?;

    let scan = cli_runtime::scan_model_clis();
    let candidate = scan
        .candidates
        .iter()
        .find(|c| c.adapter == spec.adapter && c.available);
    let exe = candidate.and_then(|c| c.path.clone().or_else(|| Some(c.command.clone())));

    // npm-provisionable CLIs (gemini/dsh) can be installed on first click when
    // missing; native-installer CLIs still require the user to configure them.
    if exe.is_none() && !spec.installable {
        return Err(format!(
            "未检测到已安装的 {}，请先在设置中配置 CLI 路径。",
            spec.label
        ));
    }

    // Deliberately NOT setting DISABLE_UPDATES/DISABLE_AUTOUPDATER here: those
    // env vars only guard the ai_cli chat/run subprocess so a live session
    // never races a background self-update. This is the one path meant to
    // actually trigger an update (or, for gemini/dsh, a fresh install).
    let cmd = cli_update_command(spec, exe.as_deref())?;

    let outcome = command_outcome_with_timeout(cmd, std::time::Duration::from_secs(180))
        .map_err(|e| format!("更新 {} 失败：{e}", spec.label))?;

    // The exit code used to be ignored entirely, so a failed
    // `bun install -g` / `npm install -g` still reported "更新完成" and the real
    // stderr was discarded. Fail loudly instead, and leave the cached "latest"
    // value alone so the row keeps showing the pending update.
    if !outcome.success {
        return Err(format!(
            "{} 更新失败：{}",
            spec.label,
            summarize_command_failure(&outcome)
        ));
    }

    // Invalidate the cached "latest" lookup so the very next check reflects
    // reality instead of waiting out the TTL.
    let mut cache = load_cli_version_cache();
    cache.entries.remove(spec.npm_package);
    save_cli_version_cache(&cache);

    Ok(outcome.text)
}

/// True when `exe` lives in the Codex **desktop app**'s private runtime dir
/// (`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`). That copy is owned by
/// the app; `codex update`, `bun install -g` and `npm install -g` all rewrite a
/// *different* install tree, which is why the settings panel kept reporting an
/// available update no matter how many times the user clicked it.
fn is_codex_desktop_app_path(exe: &str) -> bool {
    let normalized = exe.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("/openai/codex/bin/")
}

/// True when `exe` is an npm global shim (`%APPDATA%\npm\codex.cmd` on Windows,
/// `.../npm/codex` elsewhere) — that tree is owned by npm, so npm must update it.
fn is_npm_global_shim_path(exe: &str) -> bool {
    let normalized = exe.replace('\\', "/").to_ascii_lowercase();
    let Some((parent, _file)) = normalized.rsplit_once('/') else {
        return false;
    };
    parent.rsplit('/').next() == Some("npm")
}

fn codex_update_command(spec: &CliUpdateSpec, exe: &str) -> Result<Command, String> {
    if is_codex_desktop_app_path(exe) {
        return Err(format!(
            "{} 当前使用的是 Codex 桌面应用自带的 CLI（{exe}），它由桌面应用自己管理，命令行更新改不动它。请在 Codex 桌面应用内检查更新，或把设置中的 Codex CLI 路径改指到 npm/bun 全局安装的 codex。",
            spec.label
        ));
    }

    // Update the detected install tree with the package manager that owns it,
    // instead of letting `codex update` guess (it always shells out to bun).
    let installer = if is_bun_global_shim_path(exe) {
        Some(bun_command_for_shim(exe))
    } else if is_npm_global_shim_path(exe) {
        Some(npm_command_name().to_string())
    } else {
        None
    };
    if let Some(installer) = installer {
        let mut c = spawn_cli_command(&installer);
        c.arg("install")
            .arg("-g")
            .arg(format!("{}@latest", spec.npm_package));
        return Ok(c);
    }

    // Unknown install source (custom path, vendor installer): fall back to the
    // CLI's own updater.
    let mut c = spawn_cli_command(exe);
    c.arg("update");
    Ok(c)
}

fn cli_update_command(spec: &CliUpdateSpec, exe: Option<&str>) -> Result<Command, String> {
    match spec.adapter {
        "claude-code" => {
            let exe = exe.ok_or_else(|| {
                format!(
                    "未检测到已安装的 {}，请先在设置中配置 CLI 路径。",
                    spec.label
                )
            })?;
            let mut c = spawn_cli_command(exe);
            c.arg("update");
            Ok(c)
        }
        "codex" => {
            let exe = exe.ok_or_else(|| {
                format!(
                    "未检测到已安装的 {}，请先在设置中配置 CLI 路径。",
                    spec.label
                )
            })?;
            codex_update_command(spec, exe)
        }
        "gemini" | "kimi" | "deepseek-harness" | "zcode" | "grok" => {
            // `npm install -g <pkg>@latest` installs when missing and updates
            // when present, so one command covers both. Prefer the owning
            // package manager of the detected shim (bun for ~/.bun/bin), else
            // fall back to npm (also used when nothing is installed yet).
            let installer = match exe {
                Some(path) if is_bun_global_shim_path(path) => bun_command_for_shim(path),
                _ => npm_command_name().to_string(),
            };
            let mut c = spawn_cli_command(&installer);
            c.arg("install")
                .arg("-g")
                .arg(format!("{}@latest", spec.npm_package));
            Ok(c)
        }
        other => Err(format!("未知的 CLI: {other}")),
    }
}

#[tauri::command]
async fn check_cli_updates() -> Vec<CliVersionStatus> {
    tauri::async_runtime::spawn_blocking(check_cli_updates_blocking)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn update_cli(adapter: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run_cli_update_blocking(&adapter))
        .await
        .map_err(|e| format!("更新任务启动失败: {e}"))?
}

/// Manual "clean up now" sweep triggered from the Settings UI (设置 > 通用).
/// Always runs (even when the startup toggle is off); `retention_days` is the
/// stepper value the user sees. Runs on a blocking thread so a large backlog
/// never stalls the webview.
#[tauri::command]
async fn run_cache_cleanup_now(
    retention_days: Option<u64>,
) -> Result<cache_cleanup::CacheCleanupReport, String> {
    tauri::async_runtime::spawn_blocking(move || cache_cleanup::run_cleanup_now(retention_days))
        .await
        .map_err(|err| format!("缓存清理任务失败: {err}"))
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
        // Same self-heal as `ai_cli`: resolve a bare command name against the
        // live filesystem so a CLI installed after app start is still found
        // despite the frozen process PATH.
        let binary = cli_runtime::resolve_launch_binary(&binary).unwrap_or(binary);
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

/// Absolute path to the bundled `ugs-job.mjs` background-job wrapper, if it can
/// be found. Checked in resource dir first (packaged app), then dev-tree
/// fallbacks. Returned to the frontend so the chat system prompt can tell the
/// model exactly which script to wrap long-running commands in.
fn locate_ugs_job_wrapper(app: &AppHandle) -> Option<PathBuf> {
    // Packaged: sits next to the bundled ugs.mjs under the resource dir.
    if let Some(dir) = app.path().resource_dir().ok() {
        let bundled = dir.join("cli").join("ugs-job.mjs");
        if bundled.is_file() {
            return normalize_node_entry_path(&bundled).ok();
        }
    }
    // Dev tree fallbacks relative to the running exe.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join("ugs-job.mjs"),
                dir.join("cli").join("ugs-job.mjs"),
                dir.join("..")
                    .join("..")
                    .join("app")
                    .join("cli")
                    .join("ugs-job.mjs"),
            ] {
                if candidate.is_file() {
                    return normalize_node_entry_path(&candidate).ok();
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        for candidate in [
            cwd.join("cli").join("ugs-job.mjs"),
            cwd.join("app").join("cli").join("ugs-job.mjs"),
        ] {
            if candidate.is_file() {
                return normalize_node_entry_path(&candidate).ok();
            }
        }
    }
    None
}

/// Frontend-facing resolver for the background-job wrapper path. Returns None
/// (serialized as null) when the wrapper can't be found, so the prompt simply
/// omits the guidance rather than pointing at a missing file.
#[tauri::command]
async fn ugs_job_wrapper_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(locate_ugs_job_wrapper(&app).map(|p| p.to_string_lossy().into_owned()))
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
        // Windows: same Job Object protection as the main AI CLI path.
        if let Some(job) = assign_child_to_kill_on_close_job(&child) {
            register_ai_cli_job(&run_id, job);
        }
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
                        terminate_ai_cli_tree(&mut child, &run_id);
                        unregister_ai_cli(&run_id);
                        return Err("CLI \"studio\" 已由用户中断。".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    terminate_ai_cli_tree(&mut child, &run_id);
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

/// Default hard timeout for a single CLI invocation. 0 disables the total
/// runtime limit; progress-aware idle detection is safer for long agent runs.
const DEFAULT_AI_CLI_TIMEOUT_SECS: u64 = 0;
/// Default "no observable progress" timeout for a single CLI invocation.
/// This is not a total runtime limit: healthy long-running tools may continue
/// indefinitely while they emit output. Set the env override to 0 to disable.
/// 2h: video processing, speech transcription/translation and similar
/// long-running tool calls routinely stay silent far past 30 minutes.
const DEFAULT_AI_CLI_IDLE_TIMEOUT_SECS: u64 = 7200;
const CLI_ERROR_CONTEXT_LIMIT: usize = 1200;
/// dsh headless 一次任务走 argv 位置参数；Windows CreateProcess 把整条命令行
/// 限制在 ~32767 个 UTF-16 字符（os error 206「文件名或扩展名太长」）。超过该
/// 安全阈值就改走 `--patch` 覆盖层里的 `headless-runner.task`，把任务文本放下
/// 文件、避开命令行长度问题（见 is_dsh 分支）。
const DSH_MAX_CMDLINE_LEN: usize = 28_000;
/// dsh 退回 `.cmd` shim（cmd /C）时的命令行上限：cmd.exe 只容忍 ~8191 字符，
/// 留出 dsh 路径与参数余量后用更保守的安全阈值。
const DSH_CMDSHIM_MAX_CMDLINE_LEN: usize = 6_000;
/// Idle gap (no stdout activity) after which a "still running" heartbeat line is
/// emitted to the run log, so a long node never looks completely frozen even
/// during a long tool execution or a slow first token.
const AI_CLI_HEARTBEAT_SECS: u64 = 12;
const DEFAULT_CODEX_THREAD_START_TIMEOUT_SECS: u64 = 7200;
const DEFAULT_CODEX_TURN_START_TIMEOUT_SECS: u64 = 7200;
const DEFAULT_CODEX_FIRST_EVENT_TIMEOUT_SECS: u64 = 7200;

fn configured_stage_timeout_secs(name: &str, default_secs: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|seconds| *seconds >= 5)
        .unwrap_or(default_secs)
}

fn codex_thread_start_timeout_secs() -> u64 {
    configured_stage_timeout_secs(
        "ULTRAGAMESTUDIO_CODEX_THREAD_START_TIMEOUT_SECS",
        DEFAULT_CODEX_THREAD_START_TIMEOUT_SECS,
    )
}

fn codex_turn_start_timeout_secs() -> u64 {
    configured_stage_timeout_secs(
        "ULTRAGAMESTUDIO_CODEX_TURN_START_TIMEOUT_SECS",
        DEFAULT_CODEX_TURN_START_TIMEOUT_SECS,
    )
}

fn codex_first_event_timeout_secs() -> u64 {
    configured_stage_timeout_secs(
        "ULTRAGAMESTUDIO_CODEX_FIRST_EVENT_TIMEOUT_SECS",
        DEFAULT_CODEX_FIRST_EVENT_TIMEOUT_SECS,
    )
}

fn ai_cli_running_stage(
    is_codex: bool,
    thread_started: bool,
    turn_started: bool,
    first_event_seen: bool,
) -> &'static str {
    if !is_codex {
        "模型/工具执行中"
    } else if !thread_started {
        "正在创建 Codex 线程"
    } else if !turn_started {
        "正在启动 Codex Turn"
    } else if !first_event_seen {
        "正在等待模型首个事件"
    } else {
        "模型/工具执行中"
    }
}

/// Read the total-runtime timeout override. 0 disables the hard deadline.
fn configured_ai_cli_timeout_secs() -> u64 {
    std::env::var("ULTRAGAMESTUDIO_AI_CLI_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|secs| *secs == 0 || *secs >= 60)
        .unwrap_or(DEFAULT_AI_CLI_TIMEOUT_SECS)
}

fn ai_cli_timeout_secs(override_secs: Option<u64>) -> u64 {
    let configured = configured_ai_cli_timeout_secs();
    let dynamic = override_secs
        .filter(|secs| *secs == 0 || *secs >= 60)
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

    let gemini_key = env_value(&out, "GEMINI_API_KEY")
        .map(ToString::to_string)
        .or_else(|| {
            std::env::var("GEMINI_API_KEY")
                .ok()
                .map(|value| value.trim().to_string())
        })
        .filter(|value| !value.is_empty());
    if let Some(api_key) = gemini_key {
        if env_value(&out, "GEMINI_API_KEY") != Some(api_key.as_str()) {
            out.insert("GEMINI_API_KEY".to_string(), api_key.clone());
            changed = true;
        }
        if env_value(&out, "GOOGLE_API_KEY") != Some(api_key.as_str()) {
            // Gemini CLI gives GOOGLE_API_KEY precedence when both are present.
            // Align it with GEMINI_API_KEY so a stale shell-level Google key
            // cannot silently override the key selected in UltraGameStudio.
            out.insert("GOOGLE_API_KEY".to_string(), api_key);
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
    env_value(env_vars, "UGS_CLAUDE_BARE")
        .map(|value| {
            let value = value.to_ascii_lowercase();
            value == "1" || value == "true" || value == "yes" || value == "on"
        })
        .unwrap_or(false)
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
static CLAUDE_STREAM_INPUT_SUPPORT_CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
static CLAUDE_EFFORT_SUPPORT_CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
static CODEX_APP_SERVER_SUPPORT_CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn claude_help_supports_bare(help_text: &str) -> bool {
    help_text.contains("--bare")
}

fn claude_help_supports_stream_input(help_text: &str) -> bool {
    help_text.contains("--input-format") && help_text.contains("stream-json")
}

/// `--effort` 出现在较新的 claude CLI 上（低/中/高/极高/最高 五档）。
fn claude_help_supports_effort(help_text: &str) -> bool {
    help_text.contains("--effort")
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

/// Result of a probe/update subprocess: the captured streams plus the *real*
/// exit status. `text` is kept as the historical `"{stdout}\n{stderr}"` blob for
/// callers that only want text; update flows read `success`/`stderr` so a failed
/// install can no longer masquerade as a successful one.
struct CommandOutcome {
    success: bool,
    exit_code: Option<i32>,
    text: String,
    stderr: String,
}

fn command_outcome_with_timeout(
    mut cmd: Command,
    timeout: std::time::Duration,
) -> Result<CommandOutcome, String> {
    prepare_command_for_spawn(&mut cmd);
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
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
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
    };

    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    Ok(CommandOutcome {
        success: status.success(),
        exit_code: status.code(),
        text: format!("{stdout}\n{stderr}"),
        stderr,
    })
}

/// Human-readable one-liner for a failed subprocess: up to the last three
/// non-empty stderr lines (npm/bun put the actionable error at the tail), else
/// stdout, else just the exit code.
fn summarize_command_failure(outcome: &CommandOutcome) -> String {
    fn tail(text: &str) -> Vec<String> {
        let lines: Vec<String> = text
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string())
            .collect();
        let start = lines.len().saturating_sub(3);
        lines[start..].to_vec()
    }

    let mut lines = tail(&outcome.stderr);
    if lines.is_empty() {
        lines = tail(&outcome.text);
    }
    if lines.is_empty() {
        return match outcome.exit_code {
            Some(code) => format!("进程退出码 {code}，且无错误输出"),
            None => "进程异常退出，且无错误输出".to_string(),
        };
    }
    let mut detail = lines.join(" | ");
    if detail.chars().count() > 600 {
        detail = detail.chars().take(600).collect::<String>();
        detail.push('…');
    }
    match outcome.exit_code {
        Some(code) => format!("{detail}（退出码 {code}）"),
        None => detail,
    }
}

fn command_text_output_with_timeout(
    cmd: Command,
    timeout: std::time::Duration,
) -> Result<String, String> {
    command_outcome_with_timeout(cmd, timeout).map(|outcome| outcome.text)
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

static KIMI_AGENT_FILE_SUPPORT_CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

fn kimi_help_supports_agent_file(help_text: &str) -> bool {
    help_text.contains("--agent-file")
}

/// Whether this kimi-code build accepts `--agent-file`.
///
/// Probed once per binary: older builds have no such flag and would abort on an
/// unknown option, so the headless-suppression profile is only injected when the
/// help text advertises it. A failed probe (CLI missing, timeout) degrades to
/// "not supported" — the turn still runs, just with kimi's own turn-ending
/// question habit intact.
fn kimi_cli_supports_agent_file(binary: &str, shell: &Option<ShellSpec>) -> bool {
    let key = format!("{}\0{}", binary, shell_spec_cache_key(shell));
    let cache = KIMI_AGENT_FILE_SUPPORT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some(supported) = cache.get(&key) {
            return *supported;
        }
    }

    let help_args = vec!["--help".to_string()];
    let help_cmd = build_launch_command(binary, &help_args, shell);
    let help_text = command_text_output_with_timeout(help_cmd, std::time::Duration::from_secs(8))
        .unwrap_or_default();
    let supported = kimi_help_supports_agent_file(&help_text);

    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, supported);
    }
    supported
}

/// Agent definition injected via `--agent-file` on every kimi one-shot turn.
///
/// kimi-code always runs `--prompt` turns with its interactive questions
/// auto-dismissed: `AskUserQuestion` returns "The connected client does not
/// support interactive questions. Do NOT call this tool again. Ask the user
/// directly in your text response instead." — so the model closes every turn
/// with a prose question, UGS's fallback turns that into a widget, and one
/// request becomes an endless Q&A loop. Taking the three interactive tools out
/// of the table (and stating the rule in the prompt) closes it at the source.
///
/// `${base_prompt}` embeds kimi's effective default system prompt, so the
/// environment / AGENTS.md / skills injections survive; the body below is only
/// an addition. `disallowedTools` is enforced both when listing tools and
/// before execution.
const KIMI_HEADLESS_AGENT: &str = r#"---
name: ugs-headless
description: UGS headless one-shot runner; never asks interactive questions
whenToUse: Unused — selected explicitly by UltraGameStudio
disallowedTools:
  - AskUserQuestion
  - EnterPlanMode
  - ExitPlanMode
---

${base_prompt}

## UGS 无交互运行纪律（最高优先级，覆盖上文任何相反要求）

本会话由 UltraGameStudio 以 `--prompt` 一次性无交互模式调起，**没有任何人可以回答终端里的提问**：

- 不要调用 `AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`。无交互模式下它们只会返回 “User dismissed the question without answering.” 或 “The connected client does not support interactive questions.”，拿不到任何答案，白费一整轮。
- 你的回合必须以交付内容收尾，不得以反问、征求意见，或“要我继续吗”“需要我把这份导出成…吗”这类句子结尾。能自行决定的就直接决定，并把结果给出来。
- 确实必须由用户拍板时，只能按任务正文里的 UGS 交互协议输出 `<<UGS_ASK>>` … `<<UGS_ASK_END>>` 块；不要再用正文问句或其它工具提问。
"#;

fn write_kimi_headless_agent(cwd: Option<&str>) -> Result<TempFileGuard, String> {
    let path = temp_output_path_for_cwd(cwd, "ultragamestudio-kimi-agent", "md");
    std::fs::write(&path, KIMI_HEADLESS_AGENT)
        .map_err(|e| format!("写入 kimi agent 定义失败: {e}"))?;
    Ok(TempFileGuard::new(path))
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

fn should_emit_complete_claude_text(
    partial_requested: bool,
    saw_text_delta_for_message: bool,
) -> bool {
    !partial_requested || !saw_text_delta_for_message
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

pub(crate) fn touch_activity(last_activity: &Arc<Mutex<std::time::Instant>>) {
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

fn should_emit_ai_cli_heartbeat(
    visible_progress_elapsed: std::time::Duration,
    since_last_heartbeat: std::time::Duration,
    interval: std::time::Duration,
) -> bool {
    visible_progress_elapsed >= interval && since_last_heartbeat >= interval
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
pub(crate) fn emit_progress(app: &tauri::AppHandle, run_id: &str, text: &str) {
    let _ = app.emit(
        "ai-cli-progress",
        serde_json::json!({ "runId": run_id, "text": text }),
    );
    touch_visible_progress(run_id);
}

pub(crate) const AI_CLI_PROGRESS_BATCH_INTERVAL_MS: u64 = 75;
pub(crate) const AI_CLI_PROGRESS_BATCH_MAX_BYTES: usize = 16 * 1024;

pub(crate) struct AiCliProgressBatcher<'a> {
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

fn spawn_ai_cli_stdout_reader<F>(
    failure: Arc<Mutex<Option<String>>>,
    read: F,
) -> std::thread::JoinHandle<String>
where
    F: FnOnce() -> String + Send + 'static,
{
    std::thread::spawn(move || {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(read)) {
            Ok(output) => output,
            Err(_) => {
                // Panic payloads may include raw native output. Report only
                // the failed transport, never that potentially sensitive text.
                if let Ok(mut slot) = failure.lock() {
                    *slot = Some("stdout 读取线程 panic".into());
                }
                String::new()
            }
        }
    })
}

fn ai_cli_result(text: String, usage: &Arc<Mutex<Option<serde_json::Value>>>) -> AiCliResult {
    AiCliResult {
        text,
        usage: usage.lock().ok().and_then(|current| (*current).clone()),
    }
}

/// Inspect a claude/gemini stream-json terminal `result` event and, when it
/// declares a FAILED turn (is_error:true or a "error*" subtype), return a
/// human-readable failure detail. Returns `None` for a normal successful turn.
/// A failed turn usually carries no usable `result` text, so callers use this
/// to surface the real cause instead of a blank "（模型没有返回内容）" bubble.
fn claude_result_failure(event: &serde_json::Value) -> Option<String> {
    let is_error = event
        .get("is_error")
        .and_then(|t| t.as_bool())
        .unwrap_or(false);
    let subtype = event.get("subtype").and_then(|t| t.as_str()).unwrap_or("");
    if !is_error && !subtype.starts_with("error") {
        return None;
    }
    let detail = event
        .get("result")
        .and_then(|t| t.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| {
            event.get("error").and_then(|e| {
                e.as_str().map(|s| s.to_string()).or_else(|| {
                    e.pointer("/message")
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string())
                })
            })
        })
        .unwrap_or_else(|| {
            if subtype.is_empty() {
                "模型报告本轮执行出错".to_string()
            } else {
                subtype.to_string()
            }
        });
    Some(detail)
}

/// Extract the assistant text from a kimi stream-json assistant message.
/// The legacy Python kimi-cli serialized `content` as a plain string; current
/// npm kimi-code (>=0.38) does the same, but older builds followed the Claude
/// wire protocol where `content` was a block array
/// (`[{"type":"text","text":…}]`). Accept both shapes. Returns the
/// concatenated text, or `None` when the message carries no text.
fn extract_kimi_assistant_text(content: Option<&serde_json::Value>) -> Option<String> {
    let value = content?;
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let blocks = value.as_array()?;
    let mut out = String::new();
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                out.push_str(text);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

/// ZCode (zcode-app-cli) reads its provider + model + API key EXCLUSIVELY from
/// `~/.zcode/cli/config.json` — never from env vars — so a headless turn
/// (`zcode --prompt … --json`) fails with the opaque `Turn execution failed
/// (traceId: …)` when that file is missing or carries no key. Before spawning,
/// ensure the config is usable:
///   - If it already has a non-empty apiKey (any provider), leave it alone.
///   - Otherwise merge the channel's `ZCODE_API_KEY` / `ZCODE_BASE_URL` /
///     `ZCODE_MODEL` env values into `provider.zai` + `model.main` (preserving
///     existing fields), creating file/dirs as needed.
///   - If neither source has a key, return an actionable Chinese error instead
///     of the opaque CLI failure.
fn ensure_zcode_user_config(env_vars: Option<&HashMap<String, String>>) -> Result<(), String> {
    let Some(home) = user_home_dir() else {
        return Err("无法定位用户主目录（USERPROFILE/HOME），不能检查 ZCode 配置。".to_string());
    };
    let config_path = home.join(".zcode").join("cli").join("config.json");
    ensure_zcode_config_at(&config_path, env_vars)
}

fn ensure_zcode_config_at(
    config_path: &Path,
    env_vars: Option<&HashMap<String, String>>,
) -> Result<(), String> {
    // Treat a missing/unparseable file as an empty config; the CLI will surface
    // its own error for a genuinely corrupt file we cannot repair.
    let existing = std::fs::read_to_string(config_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));

    let has_key = existing
        .get("provider")
        .and_then(|providers| providers.as_object())
        .map(|providers| {
            providers.values().any(|provider| {
                provider
                    .get("options")
                    .and_then(|options| options.get("apiKey"))
                    .and_then(|key| key.as_str())
                    .is_some_and(|key| !key.trim().is_empty())
            })
        })
        .unwrap_or(false);
    if has_key {
        return Ok(());
    }

    let empty_env: HashMap<String, String> = HashMap::new();
    let env = env_vars.unwrap_or(&empty_env);
    let Some(api_key) = env_value(env, "ZCODE_API_KEY") else {
        return Err(
            "ZCode CLI 尚未配置模型访问：未找到 ~/.zcode/cli/config.json 中的 API Key，且当前 ZCode 通道也未提供 Key。请在「设置 → 模型」的 ZCode/GLM 通道中填写 API Key（将自动写入 ~/.zcode/cli/config.json），或先手动运行 `zcode` 完成登录/配置。".to_string(),
        );
    };

    let mut config = existing;
    // `provider.zai` is ZCode's canonical provider slot; reuse it if present,
    // else create it with the upstream defaults.
    let zai = config
        .get_mut("provider")
        .and_then(|providers| providers.get_mut("zai"))
        .filter(|provider| provider.is_object())
        .cloned()
        .unwrap_or_else(|| {
            serde_json::json!({
                "kind": "anthropic",
                "name": "Z.AI Coding Plan",
                "options": {
                    "apiKeyRequired": true,
                    "baseURL": "https://api.z.ai/api/anthropic"
                },
                "headers": {},
                "models": {}
            })
        });
    let mut zai = zai;
    let options = zai
        .get_mut("options")
        .and_then(|options| options.as_object_mut())
        .ok_or_else(|| "ZCode 配置中的 provider.zai.options 不是有效对象。".to_string())?;
    options.insert(
        "apiKey".to_string(),
        serde_json::Value::String(api_key.to_string()),
    );
    if let Some(base_url) = env_value(env, "ZCODE_BASE_URL") {
        options.insert(
            "baseURL".to_string(),
            serde_json::Value::String(base_url.to_string()),
        );
    }

    // Ensure the selected model is registered under provider.zai.models and
    // `model.main` points at it, so zcode can resolve the turn's model.
    let model = env_value(env, "ZCODE_MODEL");
    if let Some(model) = model {
        let models = zai
            .get_mut("models")
            .and_then(|models| models.as_object_mut())
            .ok_or_else(|| "ZCode 配置中的 provider.zai.models 不是有效对象。".to_string())?;
        if !models.contains_key(model) {
            models.insert(model.to_string(), serde_json::json!({ "name": model }));
        }
        let main_model = if model.contains('/') {
            model.to_string()
        } else {
            format!("zai/{model}")
        };
        let model_root = config
            .as_object_mut()
            .expect("config is an object")
            .entry("model".to_string())
            .or_insert_with(|| serde_json::json!({}));
        model_root
            .as_object_mut()
            .expect("model entry is an object")
            .insert("main".to_string(), serde_json::Value::String(main_model));
    }

    let providers = config
        .as_object_mut()
        .expect("config is an object")
        .entry("provider".to_string())
        .or_insert_with(|| serde_json::json!({}));
    providers
        .as_object_mut()
        .expect("provider entry is an object")
        .insert("zai".to_string(), zai);

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "无法创建 ZCode 配置目录 {}：{error}",
                parent.to_string_lossy()
            )
        })?;
    }
    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("无法序列化 ZCode 配置：{error}"))?;
    std::fs::write(config_path, format!("{serialized}\n")).map_err(|error| {
        format!(
            "无法写入 ZCode 配置 {}：{error}",
            config_path.to_string_lossy()
        )
    })?;
    Ok(())
}

/// Parse the structured envelope `zcode --json` prints for a headless turn
/// (`{sessionId, turnId, response, usage, projection}`). The envelope may be
/// pretty-printed across multiple lines and could be preceded by stray
/// diagnostics, so locate the outermost JSON object in the accumulated stdout
/// rather than requiring line-oriented JSONL. Returns `None` when no object
/// parses, letting the caller fall back to the raw accumulated text.
fn zcode_envelope_from_output(output: &str) -> Option<serde_json::Value> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Fast path: the whole output is one JSON object.
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if value.is_object() {
            return Some(value);
        }
    }
    // Fallback: walk to the first `{` and try to parse a balanced object from
    // there, retrying at successive `{` positions so a leading log line cannot
    // hide the envelope.
    let bytes = trimmed.as_bytes();
    let mut search_from = 0;
    while let Some(offset) = trimmed[search_from..].find('{') {
        let start = search_from + offset;
        let mut depth = 0_i64;
        let mut in_string = false;
        let mut escaped = false;
        let mut end = None;
        for (i, byte) in bytes.iter().enumerate().skip(start) {
            let ch = *byte;
            if in_string {
                if escaped {
                    escaped = false;
                } else if ch == b'\\' {
                    escaped = true;
                } else if ch == b'"' {
                    in_string = false;
                }
                continue;
            }
            match ch {
                b'"' => in_string = true,
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        if let Some(end) = end {
            let candidate = &trimmed[start..=end];
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate) {
                if value.is_object() {
                    return Some(value);
                }
            }
        }
        search_from = start + 1;
    }
    None
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
fn context_compression_patch(event: &serde_json::Value) -> Option<serde_json::Value> {
    let kind = event.get("method").or_else(|| event.get("type")).and_then(|v| v.as_str())?;
    let completed = match kind {
        "system" => event.get("subtype").and_then(|v| v.as_str()) == Some("compact_boundary"),
        "thread/compacted" | "thread.compacted" => true,
        "item.completed" | "item/completed" => {
            let item = event.get("item").or_else(|| event.pointer("/params/item"));
            matches!(item.and_then(|v| v.get("type")).and_then(|v| v.as_str()),
                Some("contextCompaction") | Some("context_compaction"))
        }
        _ => false,
    };
    completed.then(|| serde_json::json!({
        "id": "native-context-compression", "name": "ugs_context_compaction",
        "status": "done", "ephemeral": true
    }))
}

pub(crate) fn encode_tool_patch(patch: &serde_json::Value) -> String {
    let payload = patch
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e");
    format!("\n<<UGS_TOOL>>{}<<UGS_TOOL_END>>\n", payload)
}

fn encode_running_status_patch(run_id: &str, elapsed_secs: u64, stage: &str) -> String {
    let patch = serde_json::json!({
        "id": format!("runtime-status-{run_id}"),
        "name": "运行状态",
        "subject": format!("{stage} · 仍在运行…（已 {elapsed_secs}s）"),
        "status": "running",
        "provenance": "ui-synthetic",
        "ephemeral": true,
    });
    encode_tool_patch(&patch)
}

/// Cap a tool result body so a huge file read doesn't bloat the message text.
pub(crate) const TOOL_RESULT_CLAMP: usize = 4000;

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

#[derive(Debug)]
struct NativeToolStart {
    started_at: std::time::Instant,
    name: String,
    parent_id: Option<String>,
    // Store only the already-minimized arguments, never raw credential fields.
    args: Option<serde_json::Value>,
}

const NATIVE_CLI_TOOL_EVENT: &str = "ugs-cli-tool";

const NATIVE_TOOL_RESULT_MAX_BYTES: usize = 8192;
const NATIVE_TOOL_ARGS_MAX_BYTES: usize = 4096;

fn native_tool_prefix(text: &str, limit: usize) -> &str {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) { end -= 1; }
    &text[..end]
}

fn native_tool_sensitive_key(key: &str) -> bool {
    let key: String = key.chars().filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase).collect();
    matches!(key.as_str(), "env" | "envvars" | "environment" | "headers" | "cookie" | "cookies")
        || ["authorization", "apikey", "password", "passwd", "secret", "credential", "accesstoken", "refreshtoken", "authtoken", "privatekey", "clientkey"]
            .iter().any(|part| key.contains(part))
        || (key.contains("token") && !matches!(key.as_str(), "tokens" | "tokenusage" | "tokencount" | "inputtokens" | "outputtokens" | "totaltokens"))
}

// No credential/config/file reads: redact only the already-received native
// record. Bound scans as well as serialized output, on UTF-8 boundaries.
fn native_tool_redact_text(raw: &str, limit: usize) -> String {
    let scan = native_tool_prefix(raw, 64 * 1024);
    if scan.to_ascii_lowercase().contains("private key") { return "[REDACTED]".into(); }
    let mut output = String::new();
    for line in scan.split_inclusive('\n') {
        if output.len() >= limit { break; }
        let credential_assignment = line.char_indices().any(|(index, ch)| {
            if ch != '=' && ch != ':' { return false; }
            let before = line[..index].trim_end_matches(|ch: char| ch.is_whitespace() || ch == '\"' || ch == '\'');
            let key = before.rsplit(|ch: char| !ch.is_ascii_alphanumeric() && !matches!(ch, '_' | '-' | '.'))
                .next().unwrap_or("");
            native_tool_sensitive_key(key)
        });
        if credential_assignment {
            output.push_str("[REDACTED]");
            if line.ends_with('\n') { output.push('\n'); }
            continue;
        }
        let mut bearer = false;
        for word in line.split_inclusive(char::is_whitespace) {
            if output.len() >= limit { break; }
            let token = word.trim_end();
            let lower = token.to_ascii_lowercase();
            let known_secret = ["sk-", "sk_", "ghp_", "github_pat_", "xoxb-", "xoxp-", "aiza", "eyj"]
                .iter().any(|prefix| lower.trim_start_matches(|ch: char| !ch.is_ascii_alphanumeric()).starts_with(prefix));
            let opaque = (36..=512).contains(&token.len())
                && token.chars().any(|ch| ch.is_ascii_alphabetic())
                && token.chars().any(|ch| ch.is_ascii_digit())
                && token.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '+' | '/' | '=' | '.'));
            let url_credentials = token.contains("://") && token.contains('@');
            let next = if bearer || known_secret || opaque || url_credentials { "[REDACTED]" } else { token };
            output.push_str(native_tool_prefix(next, limit.saturating_sub(output.len())));
            output.push_str(native_tool_prefix(&word[token.len()..], limit.saturating_sub(output.len())));
            bearer = lower == "bearer";
        }
    }
    native_tool_prefix(&output, limit).to_string()
}

fn native_tool_redact_value(value: &serde_json::Value, budget: &mut usize, depth: usize) -> serde_json::Value {
    if *budget < 16 || depth > 6 { return "[TRUNCATED]".into(); }
    match value {
        serde_json::Value::Object(map) => {
            let mut safe = serde_json::Map::new();
            for (key, value) in map.iter().take(32) {
                if *budget < 32 { break; }
                let key = native_tool_prefix(key, 128).to_string();
                *budget = budget.saturating_sub(key.len() + 8);
                let value = if native_tool_sensitive_key(&key) { "[REDACTED]".into() }
                    else { native_tool_redact_value(value, budget, depth + 1) };
                safe.insert(key, value);
            }
            serde_json::Value::Object(safe)
        }
        serde_json::Value::Array(array) => {
            let mut safe = Vec::new();
            for value in array.iter().take(32) {
                if *budget < 32 { break; }
                *budget = budget.saturating_sub(2);
                safe.push(native_tool_redact_value(value, budget, depth + 1));
            }
            serde_json::Value::Array(safe)
        }
        serde_json::Value::String(text) => {
            let safe = native_tool_redact_text(text, *budget);
            *budget = budget.saturating_sub(safe.len() + 2);
            safe.into()
        }
        _ => {
            *budget = budget.saturating_sub(value.to_string().len() + 2);
            value.clone()
        }
    }
}

fn native_tool_safe_args(args: &serde_json::Value) -> serde_json::Value {
    let mut budget = NATIVE_TOOL_ARGS_MAX_BYTES;
    let safe = native_tool_redact_value(args, &mut budget, 0);
    if safe.to_string().len() > NATIVE_TOOL_ARGS_MAX_BYTES { "[TRUNCATED]".into() } else { safe }
}

// This sink is fed only by native protocol records, never by progress text or
// model-authored sentinels. Production binds it directly to AppHandle::emit.
fn emit_native_tool_event<S: FnMut(&str, serde_json::Value)>(
    sink: &mut S,
    mut event: serde_json::Value,
) {
    event["provenance"] = "native-tool".into();
    event["occurredAt"] = now_ms().into();
    if let Some(args) = event.get_mut("args") {
        *args = native_tool_safe_args(args);
    }
    if let Some(result) = event.get("result").and_then(|result| result.as_str()) {
        event["result"] = native_tool_redact_text(result, NATIVE_TOOL_RESULT_MAX_BYTES).into();
    }
    sink(NATIVE_CLI_TOOL_EVENT, event);
}

fn native_tool_parent(event: &serde_json::Value) -> Option<String> {
    ["parent_tool_use_id", "parent_id", "parentId", "parentToolCallId"]
        .iter()
        .find_map(|key| event.get(*key).and_then(|value| value.as_str()))
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn native_tool_exit_code(event: &serde_json::Value) -> Option<serde_json::Value> {
    event.get("exit_code").or_else(|| event.get("exitCode"))
        .filter(|value| value.is_i64() || value.is_null()).cloned()
}

fn native_tool_status(flag: Option<bool>, status: Option<&str>, exit: Option<&serde_json::Value>) -> &'static str {
    let code = exit.and_then(|value| value.as_i64());
    let status = status.unwrap_or("").to_ascii_lowercase();
    if flag == Some(true) || code.is_some_and(|code| code != 0)
        || matches!(status.as_str(), "error" | "failed" | "failure" | "errored" | "cancelled" | "canceled") {
        "error"
    } else if flag == Some(false) || code == Some(0) || codex_status_success(&status) {
        "success"
    } else {
        "unknown"
    }
}

fn claude_tool_start_patch<S: FnMut(&str, serde_json::Value)>(
    run_id: &str,
    event: &serde_json::Value,
    block: &serde_json::Value,
    tool_starts: &mut HashMap<String, NativeToolStart>,
    sink: &mut S,
) -> serde_json::Value {
    let native_id = block.get("id").and_then(|value| value.as_str()).filter(|id| !id.is_empty());
    let native_name = block.get("name").and_then(|value| value.as_str()).filter(|name| !name.is_empty());
    let id = native_id.map(str::to_string).unwrap_or_else(|| format!("t{}", tool_starts.len()));
    let name = native_name.unwrap_or("tool");
    let parent = native_tool_parent(block).or_else(|| native_tool_parent(event));
    let input = block.get("input").cloned().unwrap_or(serde_json::Value::Null);
    if native_id.is_some() && native_name.is_some() {
        tool_starts.insert(id.clone(), NativeToolStart {
            started_at: std::time::Instant::now(), name: name.to_string(), parent_id: parent.clone(),
            args: (!input.is_null()).then(|| native_tool_safe_args(&input)),
        });
        let mut evidence = serde_json::json!({
            "runId": run_id, "toolCallId": id, "toolName": name, "phase": "start", "status": "unknown",
        });
        if let Some(parent) = parent.as_deref() { evidence["parentId"] = parent.into(); }
        if !input.is_null() { evidence["args"] = input.clone(); }
        emit_native_tool_event(sink, evidence);
    }
    let mut patch = serde_json::json!({
        "id": id, "name": name, "subject": tool_subject(&input), "status": "running",
        "provenance": if native_id.is_some() && native_name.is_some() { "native-tool" } else { "ui-synthetic" },
    });
    if let Some(parent) = parent.as_deref() { patch["parentId"] = parent.into(); }
    if !input.is_null() { patch["args"] = input; }
    patch
}

fn claude_tool_result_patch<S: FnMut(&str, serde_json::Value)>(
    run_id: &str,
    event: &serde_json::Value,
    block: &serde_json::Value,
    tool_starts: &mut HashMap<String, NativeToolStart>,
    sink: &mut S,
) -> Option<serde_json::Value> {
    let id = block.get("tool_use_id").and_then(|value| value.as_str()).filter(|id| !id.is_empty())?;
    let start = tool_starts.remove(id);
    let name = start.as_ref().map(|start| start.name.as_str())
        .or_else(|| block.get("name").and_then(|value| value.as_str()).filter(|name| !name.is_empty()));
    let parent = native_tool_parent(block).or_else(|| native_tool_parent(event))
        .or_else(|| start.as_ref().and_then(|start| start.parent_id.clone()));
    let exit = native_tool_exit_code(block).or_else(|| {
        let metadata = event.get("tool_use_result")?;
        let metadata_id = metadata.get("tool_use_id").or_else(|| metadata.get("toolUseId"))
            .and_then(|value| value.as_str());
        let content = event.pointer("/message/content").and_then(|value| value.as_array());
        // Envelope metadata without an id is attributable only when this is
        // the sole tool_result. Never transfer another tool's process exit.
        let correlated = metadata_id.map(|metadata_id| metadata_id == id).unwrap_or_else(|| {
            content.is_some_and(|content| {
                let mut results = content.iter().filter(|value| value.get("type").and_then(|value| value.as_str()) == Some("tool_result"));
                results.next().is_some_and(|value| value.get("tool_use_id").and_then(|value| value.as_str()) == Some(id))
                    && results.next().is_none()
            })
        });
        correlated.then(|| native_tool_exit_code(metadata)).flatten()
    });
    let status = native_tool_status(block.get("is_error").and_then(|value| value.as_bool()),
        block.get("status").and_then(|value| value.as_str()), exit.as_ref());
    let raw = tool_result_raw(block);
    if let Some(name) = name {
        let mut evidence = serde_json::json!({
            "runId": run_id, "toolCallId": id, "toolName": name, "phase": "end", "status": status, "result": raw,
        });
        if let Some(parent) = parent.as_deref() { evidence["parentId"] = parent.into(); }
        if let Some(exit) = exit.as_ref() { evidence["exitCode"] = exit.clone(); }
        if let Some(args) = start.as_ref().and_then(|start| start.args.as_ref()) { evidence["args"] = args.clone(); }
        // Emit from the raw native result BEFORE clipping the UI projection.
        emit_native_tool_event(sink, evidence);
    }
    let mut patch = serde_json::json!({
        "id": id, "name": name.unwrap_or("tool"), "status": if status == "error" { "error" } else { "done" },
        "evidenceStatus": status, "provenance": if name.is_some() { "native-tool" } else { "ui-synthetic" },
        "durationMs": start.as_ref().map(|start| start.started_at.elapsed().as_millis() as u64),
        "result": raw.chars().take(TOOL_RESULT_CLAMP).collect::<String>(),
        "truncated": raw.chars().count() > TOOL_RESULT_CLAMP,
    });
    if let Some(parent) = parent.as_deref() { patch["parentId"] = parent.into(); }
    if let Some(exit) = exit { patch["exitCode"] = exit; }
    Some(patch)
}

fn gemini_tool_patch<S: FnMut(&str, serde_json::Value)>(
    run_id: &str,
    event: &serde_json::Value,
    tool_starts: &mut HashMap<String, NativeToolStart>,
    sink: &mut S,
) -> Option<serde_json::Value> {
    match event.get("type").and_then(|value| value.as_str())? {
        "tool_use" => {
            let block = serde_json::json!({
                "id": event.get("tool_id"), "name": event.get("tool_name"), "input": event.get("parameters"),
            });
            Some(claude_tool_start_patch(run_id, event, &block, tool_starts, sink))
        }
        "tool_result" => {
            let output = event.get("output").and_then(|value| value.as_str())
                .or_else(|| event.pointer("/error/message").and_then(|value| value.as_str())).unwrap_or("");
            let mut block = serde_json::json!({
                "tool_use_id": event.get("tool_id"), "name": event.get("tool_name"),
                "content": output, "status": event.get("status"),
            });
            if let Some(code) = native_tool_exit_code(event) { block["exitCode"] = code; }
            if event.get("error").is_some_and(|error| !error.is_null()) { block["is_error"] = true.into(); }
            claude_tool_result_patch(run_id, event, &block, tool_starts, sink)
        }
        _ => None,
    }
}

#[derive(serde::Deserialize)]
struct CodexLiteEvent {
    id: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
    // `codex exec --json` fatal errors print `{"type":"error","message":…}`
    // with no `error` object; keep the message so it can surface to the user.
    message: Option<String>,
    #[serde(alias = "parentId", alias = "parentToolCallId", alias = "parent_tool_use_id")]
    parent_id: Option<String>,
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
    #[serde(alias = "parentId", alias = "parentToolCallId", alias = "parent_tool_use_id")]
    parent_id: Option<String>,
    delta: Option<String>,
    item: Option<CodexLiteItem>,
    turn: Option<CodexLiteTurn>,
    #[serde(rename = "tokenUsage")]
    token_usage: Option<serde_json::Value>,
    usage: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
    plan: Option<serde_json::Value>,
    explanation: Option<String>,
    #[serde(rename = "turnId")]
    turn_id: Option<String>,
}

fn codex_cli_supports_app_server(binary: &str, shell: &Option<ShellSpec>) -> bool {
    let key = format!("{}\0{}", binary, shell_spec_cache_key(shell));
    let cache = CODEX_APP_SERVER_SUPPORT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(cache) = cache.lock() {
        if let Some(supported) = cache.get(&key) {
            return *supported;
        }
    }

    let help_args = vec!["app-server".to_string(), "--help".to_string()];
    let help_cmd = build_launch_command(binary, &help_args, shell);
    let help_text = command_text_output_with_timeout(help_cmd, std::time::Duration::from_secs(5))
        .unwrap_or_default();
    let supported = help_text.contains("app server") && help_text.contains("--stdio");
    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, supported);
    }
    supported
}

fn claude_cli_supports_stream_input(binary: &str, shell: &Option<ShellSpec>) -> bool {
    let key = format!("{}\0{}", binary, shell_spec_cache_key(shell));
    let cache = CLAUDE_STREAM_INPUT_SUPPORT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
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
    let supported = claude_help_supports_stream_input(&help_text);

    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, supported);
    }
    supported
}

/// Kill-switch for the Codex App Server transport — the only channel that can
/// steer a live GPT/Codex turn (`turn/steer`). Default ON: with it off the run
/// is a one-shot `codex exec` process with no stdin the ⚡ 插话 action could
/// write to, which is exactly the "GPT 插话点击无效" symptom.
///
/// `UGS_CODEX_APP_SERVER=0|false|off|no` forces the legacy `codex exec` path.
/// The UI probe reads the same switch, so that mode hides the ⚡ action instead
/// of offering a dead one.
fn codex_app_server_env_enabled(raw: Option<&str>) -> bool {
    match raw.map(|value| value.trim().to_ascii_lowercase()) {
        Some(value) => !matches!(value.as_str(), "0" | "false" | "off" | "no"),
        None => true,
    }
}

/// Pure core of `codex_app_server_steerable`: the gate matrix (env switch ×
/// approval mode × CLI capability). The capability arrives as a closure so the
/// cheap gates really do short-circuit `codex app-server --help` — a probe that
/// hangs would otherwise cost its full timeout on every first turn of an
/// install that opted out — and so the matrix is unit-testable without spawning
/// a probe or mutating the process environment.
///
/// `ask` stays on the one-shot path: App Server approval callbacks need a live
/// UI reviewer, and that callback surface is not wired yet.
fn codex_steer_supported<P>(
    permission: Option<&str>,
    env_enabled: bool,
    app_server_capable: P,
) -> bool
where
    P: FnOnce() -> bool,
{
    env_enabled && permission != Some("ask") && app_server_capable()
}

/// THE Codex steer decision, in one place: `ai_cli` derives this run's transport
/// from it and `ai_cli_steer_supported` answers the UI with it.
///
/// Never re-derive this by hand. The two sides disagreed once — the probe
/// omitted the App Server switch the launch path required — so the ⚡ action was
/// offered for a run whose process had no steer channel at all, and the click
/// died silently (issue "GPT 插话点击无效").
fn codex_app_server_steerable(
    binary: &str,
    permission: Option<&str>,
    shell: &Option<ShellSpec>,
) -> bool {
    let env_enabled =
        codex_app_server_env_enabled(std::env::var("UGS_CODEX_APP_SERVER").ok().as_deref());
    codex_steer_supported(permission, env_enabled, || {
        codex_cli_supports_app_server(binary, shell)
    })
}

/// Where a run's in-turn steer channel comes from — and therefore which
/// transport the launch path has to pick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiCliSteerChannel {
    None,
    CodexAppServer,
    ClaudeStreamInput,
    ZcodeAppServer,
}

/// The one decision for "does this run have a live in-turn steer channel?".
///
/// Both `ai_cli` (transport selection) and `ai_cli_steer_supported` (UI
/// capability) MUST go through here; a hand-rolled second copy is how the two
/// drifted apart and the ⚡ action became a no-op for Codex/GPT.
fn ai_cli_steer_channel(
    protocol: &str,
    binary: &str,
    permission: Option<&str>,
    shell: &Option<ShellSpec>,
) -> AiCliSteerChannel {
    match protocol {
        "codex" if codex_app_server_steerable(binary, permission, shell) => {
            AiCliSteerChannel::CodexAppServer
        }
        "claude" if claude_cli_supports_stream_input(binary, shell) => {
            AiCliSteerChannel::ClaudeStreamInput
        }
        // zcode steers by writing an extra `session/send` on the live app-server
        // session — only possible when the bundled runtime entry resolves (the
        // same gate `ai_cli` uses to pick the app-server transport over
        // `--prompt --json`). No probing of the CLI itself: the capability is a
        // property of the vendored runtime layout, which UGS ships.
        "zcode" if cli_runtime::resolve_zcode_runtime_entry(binary).is_some() => {
            AiCliSteerChannel::ZcodeAppServer
        }
        _ => AiCliSteerChannel::None,
    }
}

/// Whether this claude build accepts `--effort`.
///
/// Probed once per binary (same shape as the `--bare` / `--input-format`
/// probes): an older CLI aborts on an unknown option, which would kill the
/// whole turn, so the flag is only appended when the help text advertises it.
/// A failed probe degrades to "not supported" — the turn still runs, just on
/// the CLI's own thinking default.
fn claude_cli_supports_effort(binary: &str, shell: &Option<ShellSpec>) -> bool {
    let key = format!("{}\0{}", binary, shell_spec_cache_key(shell));
    let cache = CLAUDE_EFFORT_SUPPORT_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
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
    let supported = claude_help_supports_effort(&help_text);

    if let Ok(mut cache) = cache.lock() {
        cache.insert(key, supported);
    }
    supported
}

#[derive(serde::Deserialize)]
struct CodexLiteTurn {
    id: Option<String>,
    status: Option<String>,
    usage: Option<serde_json::Value>,
}

fn deserialize_native_exit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<i64>>, D::Error> {
    let value = <Option<i64> as serde::Deserialize>::deserialize(deserializer)?;
    Ok(Some(value))
}

#[derive(serde::Deserialize)]
struct CodexLiteItem {
    id: Option<String>,
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
    #[serde(alias = "aggregated_output", alias = "aggregatedOutput")]
    output: Option<String>,
    #[serde(default, alias = "exitCode", deserialize_with = "deserialize_native_exit")]
    exit_code: Option<Option<i64>>,
    #[serde(alias = "parentId", alias = "parentToolCallId", alias = "parent_tool_call_id")]
    parent_id: Option<String>,
    command: Option<String>,
    name: Option<String>,
    tool: Option<String>,
    server: Option<String>,
    arguments: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    path: Option<String>,
    #[serde(alias = "filePath")]
    file_path: Option<String>,
    #[serde(alias = "oldPath")]
    old_path: Option<String>,
    #[serde(alias = "newPath")]
    new_path: Option<String>,
    diff: Option<String>,
    query: Option<String>,
    status: Option<String>,
    changes: Option<serde_json::Value>,
    files: Option<serde_json::Value>,
    paths: Option<serde_json::Value>,
    edits: Option<serde_json::Value>,
    items: Option<serde_json::Value>,
    plan: Option<serde_json::Value>,
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

    fn plan_patch(&self) -> Option<serde_json::Value> {
        if matches!(self.kind(), Some("turn/plan/updated") | Some("turn.plan.updated")) {
            let params = self.params.as_ref()?;
            let plan = params.plan.as_ref().filter(|plan| plan.is_array())?;
            return Some(serde_json::json!({
                "id": format!("plan:{}", params.turn_id.as_deref().unwrap_or("current")),
                "name": "update_plan", "status": "done", "provenance": "model-output",
                "args": { "plan": plan, "explanation": params.explanation },
            }));
        }
        if !matches!(self.kind(), Some("item.started") | Some("item.updated") | Some("item.completed")
            | Some("item/started") | Some("item/updated") | Some("item/completed")) {
            return None;
        }
        let item = self.item.as_ref().or_else(|| self.params.as_ref()?.item.as_ref())?;
        if !matches!(item.item_type.as_deref(), Some("todo_list") | Some("todoList") | Some("plan")) {
            return None;
        }
        let plan = item.plan.as_ref().or(item.items.as_ref()).filter(|plan| plan.is_array())?;
        Some(serde_json::json!({
            "id": format!("plan:{}", item.id.as_deref().unwrap_or("current")),
            "name": "update_plan", "status": "done", "provenance": "model-output", "args": { "plan": plan },
        }))
    }

    fn is_turn_progress(&self) -> bool {
        self.kind()
            .is_some_and(|kind| kind.starts_with("item/") || kind.starts_with("item."))
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
    if matches!(item_type, "agent_message" | "agentMessage") {
        return item
            .text
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            // Codex emits completed assistant messages, not token deltas. Keep
            // adjacent updates as separate markdown paragraphs instead of
            // gluing them into one unreadable line.
            .map(|t| format!("\n{t}\n"));
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
    insert_codex_arg_string(&mut map, "tool", &item.tool);
    insert_codex_arg_string(&mut map, "server", &item.server);
    insert_codex_arg_value(&mut map, "arguments", &item.arguments);
    insert_codex_arg_string(&mut map, "path", &item.path);
    insert_codex_arg_string(&mut map, "file_path", &item.file_path);
    insert_codex_arg_string(&mut map, "old_path", &item.old_path);
    insert_codex_arg_string(&mut map, "new_path", &item.new_path);
    insert_codex_arg_string(&mut map, "query", &item.query);
    insert_codex_arg_string(&mut map, "status", &item.status);
    insert_codex_arg_string(&mut map, "diff", &item.diff);
    insert_codex_arg_value(&mut map, "changes", &item.changes);
    insert_codex_arg_value(&mut map, "files", &item.files);
    insert_codex_arg_value(&mut map, "paths", &item.paths);
    insert_codex_arg_value(&mut map, "edits", &item.edits);
    (!map.is_empty()).then_some(serde_json::Value::Object(map))
}

fn codex_tool_patch(item: &CodexLiteItem, fallback_id: String) -> Option<serde_json::Value> {
    let item_type = item.item_type.as_deref().unwrap_or("");
    if item_type.is_empty() || matches!(item_type, "agent_message" | "agentMessage") {
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
        .unwrap_or(false)
        || item.exit_code.flatten().is_some_and(|code| code != 0);
    let mut patch = serde_json::json!({
        "id": item.id.clone().unwrap_or(fallback_id),
        "name": item.name.as_deref().unwrap_or(item_type),
        "subject": codex_tool_subject(item),
        // `done` is a UI terminal state, not a successful native verdict.
        "status": if is_error { "error" } else { "done" },
        "evidenceStatus": if is_error { "error" }
            else if item.exit_code.flatten() == Some(0) || item.status.as_deref().is_some_and(codex_status_success) { "success" }
            else { "unknown" },
        "result": result,
        "truncated": truncated,
    });
    if let Some(args) = codex_tool_args(item) {
        patch["args"] = args;
    }
    if let Some(parent) = item.parent_id.as_deref() {
        patch["parentId"] = parent.into();
    }
    if let Some(code) = item.exit_code {
        patch["exitCode"] = serde_json::json!(code);
    }
    Some(patch)
}

fn codex_native_tool_patch<S: FnMut(&str, serde_json::Value)>(
    run_id: &str,
    event: &CodexLiteEvent,
    tool_starts: &mut HashMap<String, NativeToolStart>,
    sink: &mut S,
) -> Option<serde_json::Value> {
    let phase = match event.kind()? {
        "item.started" | "item/started" => "start",
        "item.completed" | "item/completed" => "end",
        _ => return None,
    };
    let item = event.item.as_ref().or_else(|| event.params.as_ref()?.item.as_ref())?;
    let kind = item.item_type.as_deref()?;
    // A completed assistant/todo/plan is not a native tool result.
    if !matches!(kind, "command_execution" | "commandExecution" | "file_change" | "fileChange"
        | "mcp_tool_call" | "mcpToolCall" | "web_search" | "webSearch" | "dynamic_tool_call" | "dynamicToolCall") {
        return None;
    }
    let id = item.id.as_deref().filter(|id| !id.is_empty())?;
    let start = if phase == "end" { tool_starts.remove(id) } else { None };
    let name = item.name.as_deref().filter(|name| !name.is_empty())
        .or_else(|| item.tool.as_deref().filter(|name| !name.is_empty()))
        .or_else(|| start.as_ref().map(|start| start.name.as_str())).unwrap_or(kind);
    let parent = item.parent_id.as_deref()
        .or_else(|| event.params.as_ref().and_then(|params| params.parent_id.as_deref()))
        .or(event.parent_id.as_deref())
        .or_else(|| start.as_ref().and_then(|start| start.parent_id.as_deref()));
    let raw = item.output.clone().or_else(|| item.text.clone()).or_else(|| {
        item.result.as_ref().map(|result| {
            // Structured MCP results must not bypass the native minimizer or
            // require serializing an unbounded result before clipping.
            let mut budget = NATIVE_TOOL_RESULT_MAX_BYTES;
            native_tool_redact_value(result, &mut budget, 0).to_string()
        })
    }).unwrap_or_default();
    let exit = item.exit_code.map(serde_json::Value::from);
    let reported_status = native_tool_status(None, item.status.as_deref(), exit.as_ref());
    let status = if phase == "start"
        || (matches!(kind, "command_execution" | "commandExecution") && item.exit_code.flatten().is_none() && reported_status == "success") {
        // Command lifecycle completion is not a process success verdict.
        "unknown"
    } else { reported_status };
    let mut evidence = serde_json::json!({
        "runId": run_id, "toolCallId": id, "toolName": name, "phase": phase, "status": status,
    });
    if let Some(parent) = parent { evidence["parentId"] = parent.into(); }
    if let Some(args) = start.as_ref().and_then(|start| start.args.clone()).or_else(|| codex_tool_args(item)) {
        evidence["args"] = args;
    }
    if phase == "end" { evidence["result"] = raw.into(); }
    if let Some(exit) = exit { evidence["exitCode"] = exit; }
    // Independent evidence emission precedes codex_tool_patch's UI clamp.
    emit_native_tool_event(sink, evidence);
    let mut patch = codex_tool_patch(item, id.to_string())?;
    patch["name"] = name.into();
    patch["status"] = if phase == "start" { "running" } else if status == "error" { "error" } else { "done" }.into();
    patch["evidenceStatus"] = status.into();
    patch["provenance"] = "native-tool".into();
    if let Some(parent) = parent { patch["parentId"] = parent.into(); }
    if let Some(start) = start.as_ref() {
        patch["durationMs"] = (start.started_at.elapsed().as_millis() as u64).into();
    }
    if phase == "start" {
        tool_starts.insert(id.to_string(), NativeToolStart {
            started_at: std::time::Instant::now(), name: name.to_string(), parent_id: parent.map(str::to_string),
            args: codex_tool_args(item).map(|args| native_tool_safe_args(&args)),
        });
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
    skills::native_launch::cancel_native_cli(&run_id);
    // Kill all processes in the job (including orphaned grandchildren)
    // BEFORE the taskkill /T fallback, so orphans that `taskkill /T`
    // can't see are still reaped.
    if let Some(job) = take_ai_cli_job(&run_id) {
        kill_job_processes(job);
        close_job_handle(job);
    }
    if let Some(pid) = mark_ai_cli_cancelled(&run_id) {
        let _ = terminate_process_tree(pid);
    }
    Ok(())
}

#[tauri::command]
fn ai_cli_steer_supported(
    adapter: String,
    cli_command: Option<String>,
    permission: Option<String>,
    shell: Option<ShellSpec>,
) -> Result<bool, String> {
    let binary = match cli_command
        .as_deref()
        .map(cli_runtime::normalize_cli_command_override)
        .transpose()?
    {
        Some(binary) => binary,
        None => cli_runtime::adapter_binary(&adapter).to_string(),
    };
    // Same self-heal as `ai_cli`: resolve a bare command name against the live
    // filesystem so capability probes see a freshly installed CLI.
    let binary = cli_runtime::resolve_launch_binary(&binary).unwrap_or(binary);
    let protocol = cli_runtime::adapter_protocol(&adapter);
    // Same self-heal the launch path performs, and it must run BEFORE the probe:
    // `ai_cli` repairs the binary and then decides the transport from it, so
    // answering the UI from a file the launch path is about to replace is a
    // second way to advertise a steer channel that will not exist.
    if protocol == "claude" {
        repair_claude_binary();
    }
    // One shared decision with `ai_cli` — see `ai_cli_steer_channel`. Codex App
    // Server, Claude stream-json stdin and the zcode app-server session are the
    // only transports with a real in-turn channel; everything else is `None`.
    let channel = ai_cli_steer_channel(&protocol, &binary, permission.as_deref(), &shell);
    Ok(channel != AiCliSteerChannel::None)
}

fn write_codex_app_server_message(
    stdin: &Arc<Mutex<ChildStdin>>,
    message: &serde_json::Value,
) -> Result<(), String> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| "Codex App Server stdin 锁已损坏。".to_string())?;
    serde_json::to_writer(&mut *stdin, message)
        .map_err(|e| format!("编码 Codex App Server 请求失败: {e}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("写入 Codex App Server 失败: {e}"))
}

fn set_codex_startup_error(error: &Arc<Mutex<Option<String>>>, message: String) {
    if let Ok(mut current) = error.lock() {
        if current.is_none() {
            *current = Some(message);
        }
    }
}

/// Write one newline-delimited JSON-RPC 2.0 message to the zcode app-server
/// (the bundled `vendor/zcode.cjs` runtime's `app-server` stdio protocol).
fn write_zcode_protocol_message(
    stdin: &Arc<Mutex<ChildStdin>>,
    message: &serde_json::Value,
) -> Result<(), String> {
    let mut stdin = stdin
        .lock()
        .map_err(|_| "ZCode app-server stdin 锁已损坏。".to_string())?;
    serde_json::to_writer(&mut *stdin, message)
        .map_err(|e| format!("编码 ZCode app-server 请求失败: {e}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("写入 ZCode app-server 失败: {e}"))
}

/// Poll the reader-thread-populated session id / startup error until one is
/// set (mirrors `wait_for_codex_start_id`, with zcode-specific diagnostics).
fn wait_for_zcode_start_id(
    value: &Arc<Mutex<Option<String>>>,
    startup_error: &Arc<Mutex<Option<String>>>,
    timeout: std::time::Duration,
    stage: &str,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(error) = startup_error
            .lock()
            .ok()
            .and_then(|current| current.clone())
        {
            return Err(error);
        }
        if let Some(id) = value.lock().ok().and_then(|current| current.clone()) {
            return Ok(id);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "ZCode {stage} 响应超时（{}s）。",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn wait_for_codex_start_id(
    value: &Arc<Mutex<Option<String>>>,
    startup_error: &Arc<Mutex<Option<String>>>,
    timeout: std::time::Duration,
    stage: &str,
) -> Result<String, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(error) = startup_error
            .lock()
            .ok()
            .and_then(|current| current.clone())
        {
            return Err(error);
        }
        if let Some(id) = value.lock().ok().and_then(|current| current.clone()) {
            return Ok(id);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "Codex {stage} 响应超时（{}s）。",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn write_claude_stream_message(
    stdin: &Arc<Mutex<Option<ChildStdin>>>,
    text: &str,
) -> Result<(), String> {
    let mut guard = stdin
        .lock()
        .map_err(|_| "Claude streaming stdin 锁已损坏。".to_string())?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| "Claude turn 已结束。".to_string())?;
    let message = claude_stream_input_message(text);
    serde_json::to_writer(&mut *stdin, &message)
        .map_err(|e| format!("编码 Claude streaming input 失败: {e}"))?;
    stdin
        .write_all(b"\n")
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("写入 Claude streaming input 失败: {e}"))
}

fn claude_stream_input_message(text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": serde_json::Value::Null,
        "session_id": "default"
    })
}

fn close_claude_stream_input(stdin: &Arc<Mutex<Option<ChildStdin>>>) {
    if let Ok(mut guard) = stdin.lock() {
        guard.take();
    }
}

#[tauri::command]
fn steer_ai_cli(run_id: String, text: String) -> Result<bool, String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(false);
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let state = loop {
        let state = active_ai_cli_steers()
            .lock()
            .ok()
            .and_then(|active| active.get(&run_id).cloned());
        if let Some(state) = state {
            break state;
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };

    let state = match state {
        ActiveAiCliSteer::Claude(state) => {
            write_claude_stream_message(&state.stdin, text)?;
            return Ok(true);
        }
        ActiveAiCliSteer::Zcode(state) => {
            return steer_zcode_session(&state, text, deadline);
        }
        ActiveAiCliSteer::Codex(state) => state,
    };

    let (thread_id, turn_id) = loop {
        let thread_id = state.thread_id.lock().ok().and_then(|id| id.clone());
        let turn_id = state.turn_id.lock().ok().and_then(|id| id.clone());
        if let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) {
            break (thread_id, turn_id);
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };

    static STEER_REQUEST_SEQ: AtomicUsize = AtomicUsize::new(1);
    let request_id = format!(
        "ugs-steer-{}",
        STEER_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = mpsc::channel();
    state
        .pending
        .lock()
        .map_err(|_| "Codex steer 等待表锁已损坏。".to_string())?
        .insert(request_id.clone(), sender);
    let request = serde_json::json!({
        "method": "turn/steer",
        "id": request_id,
        "params": {
            "threadId": thread_id,
            "expectedTurnId": turn_id,
            "input": [{ "type": "text", "text": text }]
        }
    });
    if let Err(error) = write_codex_app_server_message(&state.stdin, &request) {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(request["id"].as_str().unwrap_or_default());
        }
        return Err(error);
    }

    match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(true),
        Ok(Err(error)) => Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("Codex steer 响应超时。".to_string()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("Codex steer 通道已断开。".to_string()),
    }
}

/// Steer a live zcode app-server turn by sending an extra `session/send` on
/// the SAME session the writer thread opened. The vendored runtime consumes
/// queued `session/send` messages in-order per session, so the steered text
/// is delivered as soon as the current model turn drains — a true in-session
/// steer, not a new process. We wait (bounded by `deadline`, itself already
/// capped at ~2s by `steer_ai_cli`) for the reader to have populated the
/// session id, then await the send ack via the shared pending map; an error
/// ack (or disconnect) is surfaced so the frontend can fall back to FIFO.
fn steer_zcode_session(
    state: &ActiveZcodeSteer,
    text: &str,
    deadline: std::time::Instant,
) -> Result<bool, String> {
    let session_id = loop {
        let session_id = state.session_id.lock().ok().and_then(|id| id.clone());
        if let Some(session_id) = session_id {
            break session_id;
        }
        if std::time::Instant::now() >= deadline {
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };

    static ZCODE_STEER_SEQ: AtomicUsize = AtomicUsize::new(1);
    let request_id = format!(
        "ugs-zcode-steer-{}",
        ZCODE_STEER_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let (sender, receiver) = mpsc::channel();
    state
        .pending
        .lock()
        .map_err(|_| "ZCode steer 等待表锁已损坏。".to_string())?
        .insert(request_id.clone(), sender);
    let request = serde_json::json!({
        "method": "session/send",
        "id": request_id,
        "params": {
            "sessionId": session_id,
            "content": text,
        }
    });
    if let Err(error) = write_zcode_protocol_message(&state.stdin, &request) {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&request_id);
        }
        return Err(error);
    }

    match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(true),
        Ok(Err(error)) => Err(error),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("ZCode steer 响应超时。".to_string()),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("ZCode steer 通道已断开。".to_string()),
    }
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

/// Guarded, case-normalized key derived from [`workspace_dir_key`]: appends a
/// trailing separator so a prefix match can only hit a whole-component
/// boundary (`/a/bc` is never mistaken for `/a/b`).
fn workspace_dir_key_guarded(path: &Path) -> String {
    let mut key = workspace_dir_key(path);
    if !key.ends_with('/') {
        key.push('/');
    }
    key
}

/// Lowest common ancestor directory shared by every path in `paths`.
///
/// dsh's sandbox admits exactly ONE workspace root — the session's
/// `process.cwd()` — and offers no `--add-dir` equivalent (unlike claude/codex/
/// kimi's `--add-dir` or gemini's `--include-directories`). To give every
/// configured folder the SAME write permission as the primary cwd, the only
/// lever is to root the session at their common ancestor. Returns `None` when
/// the folders share no directory (e.g. different drives) or the list is empty.
fn common_ancestor_dir(paths: &[String]) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = paths
        .iter()
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect();
    if dirs.is_empty() {
        return None;
    }
    if dirs.len() == 1 {
        return Some(dirs[0].clone());
    }
    let keys: Vec<String> = dirs
        .iter()
        .map(|dir| workspace_dir_key_guarded(dir))
        .collect();
    let mut current = dirs[0].clone();
    loop {
        let key = workspace_dir_key_guarded(&current);
        if keys.iter().all(|k| k.starts_with(&key)) {
            return Some(current);
        }
        if !current.pop() {
            // Reached the volume root without finding a shared ancestor.
            return None;
        }
    }
}

/// Pre-flight gate for the kimi adapter. Kimi Code CLI (>= 0.38) can run from
/// EITHER a `/login`-populated config.toml OR an in-memory model synthesised
/// from env vars (`KIMI_MODEL_NAME` + `KIMI_MODEL_API_KEY`, injected by the
/// gateway resolver when the channel has a key + model). When neither exists
/// the CLI would exit with a raw "No model configured" (or, before 0.38, hang
/// for minutes), so fail fast here with an actionable reason + solution.
fn ensure_kimi_ready(env_vars: Option<&HashMap<String, String>>) -> Result<(), String> {
    let has_env_key = env_vars
        .and_then(|vars| env_value(vars, "KIMI_MODEL_API_KEY"))
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_env_model = env_vars
        .and_then(|vars| env_value(vars, "KIMI_MODEL_NAME"))
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if has_env_key && has_env_model {
        return Ok(());
    }
    if kimi_log::kimi_has_configured_model() {
        return Ok(());
    }
    Err(
        "Kimi Code 尚未配置：既没有可用的 API Key，也没有登录态（~/.kimi-code/config.toml 里没有 default_model）。\n\
         \n请二选一：\n\
         \n1. 在「设置 → 模型」里给 Kimi Code 渠道填上 API Key 与模型（UGS 会自动通过环境变量 KIMI_MODEL_API_KEY / KIMI_MODEL_NAME 注入，无需网页登录）；\n\
         \n2. 或在本机终端运行 `kimi`，输入 `/login` 完成登录后重试。"
            .to_string(),
    )
}

/// Map kimi-code's raw English stderr failures to an actionable Chinese hint.
/// The pre-flight (`ensure_kimi_ready`) already catches the "not configured"
/// case before spawn; this is the fallback for failures that only surface once
/// the CLI actually runs (invalid key, 401, 429, etc).
fn kimi_failure_hint(detail: &str) -> Option<&'static str> {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("no model configured") {
        Some("Kimi 尚未登录或未配置默认模型：在「设置 → 模型」给 Kimi Code 渠道填 API Key 与模型，或在本机终端运行 `kimi` 并输入 /login。")
    } else if lower.contains("no credential configured") {
        Some("Kimi 渠道缺少 API Key（KIMI_MODEL_API_KEY）：请在「设置 → 模型」里为该渠道填写 API Key。")
    } else if lower.contains("invalid authentication")
        || lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("auth_error")
    {
        Some("Kimi API Key 无效、已过期或与所选模型/端点不匹配：请核对「设置 → 模型」里的 Key（中国区账号用 api.moonshot.cn 时还需在 Base URL 里填对应端点）。")
    } else if lower.contains("rate limit") || lower.contains("429") {
        Some("Kimi 额度受限或触发限流（429）：请稍后重试或检查账户余额/配额。")
    } else {
        None
    }
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
    skill_tools: Option<skills::native_cli::NativeCliSkillToolsRequest>,
    session_id: Option<String>,
    resume: Option<bool>,
    language_directive: Option<String>,
    shell: Option<ShellSpec>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<AiCliResult, String> {
    let native_skill = match skill_tools {
        Some(request) if request.enabled && request.mode != skills::LearningMode::Off => {
            require_skill_app(&window)?;
            Some((Arc::clone(skill_desktop_host()?), request))
        }
        _ => None,
    };
    ai_cli_runtime(
        prompt, adapter, cli_command, model, cwd, extra_workspace_paths, permission,
        env_vars, timeout_seconds, idle_timeout_seconds, run_id, native_skill,
        session_id, resume, language_directive, shell, app,
    ).await
}

async fn ai_cli_runtime(
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
    native_skill: Option<(Arc<skills::SkillDesktopHost>, skills::native_cli::NativeCliSkillToolsRequest)>,
    // Optional Claude session continuity (claude only): when `session_id` is set
    // and `resume` is false the run *creates* that session (`--session-id`); when
    // `resume` is true it *continues* it (`--resume`), inheriting the prior
    // call's full context so a downstream step needn't re-explore the project.
    session_id: Option<String>,
    resume: Option<bool>,
    // Short language-enforcement directive (from the UI locale). For claude
    // this is injected via `--append-system-prompt` (genuine system-role
    // authority, resent every turn — cheap and counters mid-session drift);
    // codex/gemini have no such flag, so it is prepended to the stdin prompt
    // alongside the workspace note.
    language_directive: Option<String>,
    // Optional launch shell wrapping (from the General settings "启动 Shell").
    shell: Option<ShellSpec>,
    app: tauri::AppHandle,
) -> Result<AiCliResult, String> {
    // Keep the request owner alive through worker teardown, including no-PID launch errors.
    let native_owner = native_skill.as_ref()
        .filter(|(_, request)| request.enabled && request.mode != skills::LearningMode::Off
            && cli_runtime::adapter_protocol(&adapter) == "claude")
        .map(|_| skills::native_launch::NativeSkillCliOwner::register(&run_id))
        .transpose()?;
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
                "附加工作区目录（与主工作目录同属本次会话上下文，权限一致，均可读写）：\n{}\n需要读写、搜索或分析这些目录时，请直接按绝对路径操作，不要仅因主工作目录未命中就判定“找不到”。",
                extra_workspace_paths
                    .iter()
                    .map(|path| format!("- {path}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let inject_extra_workspace_note =
            !extra_workspace_note.is_empty() && !resume.unwrap_or(false);
        // Unlike the workspace note, the language directive is resent on
        // EVERY turn (including resumed sessions) — it is small, and a
        // resumed session's warm context is exactly where language drift
        // creeps back in over a long agentic run.
        let language_directive = language_directive
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or_default()
            .to_string();
        // dsh self-heal: npm updates to @deepseek-ai/dsh sometimes delete the
        // `%APPDATA%\npm\dsh.cmd` shim while leaving the package body intact.
        // If the stored cli_command is a stale shim path that no longer exists,
        // fall back to the package's `lib/bin.js` (spawned via node below).
        let binary = if cli_command
            .as_deref()
            .map(|s| {
                let lower = s.to_ascii_lowercase();
                lower.contains("dsh") && (lower.ends_with(".cmd") || lower.ends_with(".bat"))
            })
            .unwrap_or(false)
            && !std::path::Path::new(cli_command.as_deref().unwrap()).exists()
        {
            if let Some(entry) = cli_runtime::resolve_dsh_node_entry("dsh") {
                entry.to_string_lossy().to_string()
            } else {
                // Package body also missing: surface the original error.
                cli_command
                    .as_deref()
                    .map(cli_runtime::normalize_cli_command_override)
                    .transpose()?
                    .unwrap_or_else(|| cli_runtime::adapter_binary(&adapter).to_string())
            }
        } else {
            match cli_command
                .as_deref()
                .map(cli_runtime::normalize_cli_command_override)
                .transpose()?
            {
                Some(binary) => binary,
                None => cli_runtime::adapter_binary(&adapter).to_string(),
            }
        };
        // Self-heal for a CLI installed after app start: the process PATH is
        // frozen at startup, so a bare command name is re-resolved against the
        // LIVE filesystem (which also scans well-known dirs like
        // `%APPDATA%\npm`) before any capability probe or spawn. This keeps a
        // freshly installed CLI usable without restarting the app, and the
        // resolved absolute path also makes the dsh/zcode node-entry lookups
        // below deterministic.
        let binary = cli_runtime::resolve_launch_binary(&binary).unwrap_or(binary);
        let protocol = cli_runtime::adapter_protocol(&adapter);
        let is_claude = protocol == "claude";
        let is_codex = protocol == "codex";
        let is_gemini = protocol == "gemini";
        let is_kimi = protocol == "kimi";
        let is_dsh = protocol == "deepseek-harness";
        let is_zcode = protocol == "zcode";
        let is_grok = protocol == "grok";
        // Self-heal a claude binary that an interrupted auto-update corrupted,
        // BEFORE the steer-channel probe below: `ai_cli_steer_supported` repairs
        // first as well, so both sides must read the same file.
        if is_claude {
            repair_claude_binary();
        }
        // Single source of truth for this run's in-turn steer channel — the same
        // call `ai_cli_steer_supported` makes when the UI asks whether it may
        // offer ⚡ 插话. Deriving both transports from one answer, instead of
        // re-testing each capability here, is what keeps the ⚡ action and the
        // running process in agreement.
        let steer_channel =
            ai_cli_steer_channel(&protocol, &binary, permission.as_deref(), &shell);
        let claude_stream_input = steer_channel == AiCliSteerChannel::ClaudeStreamInput;
        let codex_app_server = steer_channel == AiCliSteerChannel::CodexAppServer;
        let codex_last_message_path = if is_codex && !codex_app_server {
            Some(temp_output_path_for_cwd(
                cwd.as_deref(),
                "ultragamestudio-codex-last",
                "txt",
            ))
        } else {
            None
        };

        // Collect the program arguments first so the whole invocation can be
        // optionally wrapped in a launch shell (see build_launch_command). Env
        // vars and the working directory are applied to the final (outer)
        // command below and inherited by any wrapped child.
        let mut args: Vec<String> = Vec::new();
        let mut workdir: Option<std::path::PathBuf> = None;
        let mut disable_autoupdater = false;
        let mut temp_files: Vec<TempFileGuard> = Vec::new();
        let mut native_scope: Option<Arc<skills::native_launch::NativeSkillCliScope>> = None;
        let mut gemini_system_settings_path: Option<String> = None;
        // When set, dsh is launched as `node <bin.js> <args>` (bypassing the
        // `.cmd` shim's cmd.exe command-line length cap). See the is_dsh branch.
        let mut dsh_node_entry: Option<String> = None;
        // When set, the is_dsh branch redirected dsh's session log to this
        // UGS-owned root (plain JSONL, see dsh_log::ugs_patch_yaml); it is
        // injected as UGS_DSH_SESSIONS before spawn and tailed for live
        // progress by dsh_log::run_tracer.
        let mut dsh_sessions_root: Option<std::path::PathBuf> = None;
        // kimi-code live-progress tracer: tails the wire.jsonl session log
        // (real text/think deltas + tool calls) into ai-cli-progress events.
        // Unlike dsh, kimi's session log is read-only — no --patch needed,
        // we just discover the new session dir after spawn and tail wire.jsonl.
        let mut kimi_tracer_plan: Option<(Vec<std::path::PathBuf>, HashSet<std::path::PathBuf>, std::time::SystemTime)> = None;
        // Same trick for zcode: its npm shim runs `node <pkg>/bin/zcode.js`,
        // whose headless prompt is a `--prompt` argv value, so cmd.exe's
        // ~8191-char cap would truncate a long chat turn. Launching the launcher
        // directly with node raises the ceiling ~4x. See the is_zcode branch.
        let mut zcode_node_entry: Option<String> = None;
        // When true, zcode is launched as the bundled runtime's `app-server`
        // stdio JSON-RPC server (real `session/event` token streaming) instead
        // of the one-shot `--prompt --json` path. Set in the is_zcode branch
        // only when the vendor bundle is resolvable.
        let mut zcode_app_server = false;
        // The full turn prompt (workspace note + prompt + language directive)
        // for the app-server writer thread; the one-shot path keeps it in argv.
        let mut zcode_task: Option<String> = None;
        // And for kimi-code: its npm shim runs `node <pkg>/dist/main.mjs`, and
        // the headless prompt is likewise a `-p/--prompt` argv value (>=0.38),
        // so the same cmd.exe ~8191-char cap applies. See the is_kimi branch.
        let mut kimi_node_entry: Option<String> = None;

        // 会话级思考深度。前端（`gatewayRouteEnv`）只在「该渠道+模型确实支持」
        // 时才下发 `UGS_THINKING_LEVEL`，值是渠道原生的等级拼写；这里按 adapter
        // 翻译成各自真正接受的传参方式。缺省 = 不注入，保持 CLI 自身默认档。
        let thinking_level = env_vars
            .as_ref()
            .and_then(|vars| env_value(vars, "UGS_THINKING_LEVEL"))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        // 完整思考计划（前端 `thinkingLevels` 解析好的族判定结果）。dsh 侧用它
        // 在第三方 pi-ai 路由上声明 `reasoningEfforts`/`compat`，让「非官方端点」
        // 也有真实可用的档位，而不是像以前那样整体隐藏或静默丢弃。
        let thinking_plan = env_vars
            .as_ref()
            .and_then(|vars| env_value(vars, "UGS_THINKING_PLAN"))
            .and_then(|raw| dsh_log::parse_thinking_plan(Some(&raw)));

        if is_codex {
            if codex_app_server {
                // Keep a Codex App Server connection alive for this turn.
                // Unlike `codex exec -`, it exposes `turn/steer`, so a
                // follow-up can join the turn without killing the process.
                append_codex_project_mcp_config_args(&mut args, cwd.as_deref());
                if !extra_workspace_paths.is_empty() {
                    args.push("-c".into());
                    args.push(format!(
                        "sandbox_workspace_write.writable_roots={}",
                        toml_literal_string_array(&extra_workspace_paths)
                    ));
                }
                // 思考深度走 codex 的全局配置覆盖 `-c`，必须排在子命令
                // `app-server` 之前，否则会被当成子命令参数。
                if let Some(level) = thinking_level.as_deref() {
                    args.push("-c".into());
                    args.push(format!(
                        "model_reasoning_effort={}",
                        toml_literal_string(level)
                    ));
                }
                args.push("app-server".into());
                args.push("--stdio".into());

                if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                    let p = std::path::Path::new(dir);
                    if p.is_dir() {
                        workdir = Some(p.to_path_buf());
                    }
                }
            } else {
                match permission.as_deref().unwrap_or("full") {
                    "readonly" => args.extend(["-a".into(), "never".into()]),
                    "ask" => args.extend(["-a".into(), "on-request".into()]),
                    _ => {}
                }
                args.push("exec".into());
                append_codex_project_mcp_config_args(&mut args, cwd.as_deref());
                args.extend(["--json".into(), "--skip-git-repo-check".into()]);
                match permission.as_deref().unwrap_or("full") {
                    "readonly" => args.extend(["--sandbox".into(), "read-only".into()]),
                    "ask" => args.extend(["--sandbox".into(), "workspace-write".into()]),
                    _ => args.push("--dangerously-bypass-approvals-and-sandbox".into()),
                }
                if let Some(model) = model
                    .as_deref()
                    .filter(|model| cli_runtime::should_pass_model(&adapter, model))
                {
                    args.extend(["--model".into(), model.to_string()]);
                }
                // 思考深度：codex 的配置键是 `model_reasoning_effort`
                // （none/minimal/low/medium/high/xhigh），CLI 只提供 `-c` 覆盖。
                if let Some(level) = thinking_level.as_deref() {
                    args.push("-c".into());
                    args.push(format!(
                        "model_reasoning_effort={}",
                        toml_literal_string(level)
                    ));
                }
                if let Some(dir) = cwd.as_deref().map(str::trim).filter(|dir| !dir.is_empty()) {
                    if Path::new(dir).is_dir() {
                        workdir = Some(Path::new(dir).to_path_buf());
                        args.extend(["-C".into(), dir.to_string()]);
                    }
                }
                for dir in &extra_workspace_paths {
                    args.extend(["--add-dir".into(), dir.clone()]);
                }
                if let Some(path) = codex_last_message_path.as_ref() {
                    args.extend(["-o".into(), path.to_string_lossy().to_string()]);
                }
                args.push("-".into());
            }
        } else if is_gemini {
            // Gemini CLI has its own headless/MCP flags. The prompt still goes
            // through stdin; an empty --prompt enables non-interactive mode
            // without hitting command-line length limits.
            args.push("--prompt".into());
            args.push(String::new());
            args.push("--output-format".into());
            args.push("stream-json".into());
            // Headless runs land in a folder Gemini CLI has not marked trusted,
            // which silently overrides `--approval-mode` back to "default" and
            // exits with code 55. `--skip-trust` mirrors how codex/claude skip
            // their own approval gates in headless mode (`--dangerously-bypass-
            // approvals-and-sandbox` / `--dangerously-skip-permissions`), so the
            // turn always runs without an interactive trust prompt.
            args.push("--skip-trust".into());

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
        } else if is_kimi {
            // Fail fast when kimi has no credential and no login: the CLI
            // would otherwise hang (old versions) or exit with a raw
            // "No model configured" error (>= 0.38) that lacks the UGS fix.
            ensure_kimi_ready(env_vars.as_ref())?;
            // Kimi Code CLI headless one-shot. The prompt is an argv value via
            // `-p/--prompt` (never stdin). kimi-code >= 0.38 removed `--print`,
            // `--input-format` and `--final-message-only`, and `--yolo`/`--auto`/
            // `--plan` all conflict with `--prompt` — headless turns ALWAYS run
            // fully autonomous (auto-approved tools, auto-dismissed questions).
            // `--output-format stream-json` emits one `{"role":...}` line each:
            //   {"role":"meta","type":"system.version",...}
            //   {"role":"assistant","content":"<string>","tool_calls":[...]}
            //   {"role":"tool","tool_call_id":...,"content":"..."}
            // The terminal assistant line's `content` string is the answer.
            //
            // Live progress: kimi-code writes every step event in real time
            // to `~/.kimi-code/sessions/<workspace-hash>/<session-uuid>/
            // wire.jsonl` (ContentPart text/think deltas, ToolCall, ToolResult,
            // etc). kimi_log::run_tracer tails that file into
            // ai-cli-progress events so the run doesn't look frozen for
            // minutes. The session log is read-only — no --patch needed.
            let mut task = String::new();
            if inject_extra_workspace_note {
                task.push_str(&extra_workspace_note);
                if !task.is_empty() {
                    task.push_str("\n\n");
                }
            }
            task.push_str(&prompt);
            if !language_directive.is_empty() {
                task.push_str("\n\n");
                task.push_str(&language_directive);
            }
            // Prefer spawning the package's `dist/main.mjs` directly with node
            // (bypasses the `.cmd` shim's cmd.exe ~8191-char command-line cap;
            // node gets the ~32767-char CreateProcess ceiling). Fall back to
            // the historical `cmd /C` shim path when the package layout isn't
            // the expected npm shim.
            if let Some(entry) = cli_runtime::resolve_kimi_node_entry(&binary) {
                kimi_node_entry = Some(entry.to_string_lossy().to_string());
            }
            args.push("--prompt".into());
            args.push(task);
            args.push("--output-format".into());
            args.push("stream-json".into());

            // Suppress kimi's own interactive-question habit. A headless
            // `--prompt` turn auto-dismisses `AskUserQuestion`, and the CLI then
            // tells the model to "ask the user directly in your text response
            // instead" — which UGS's plain-text fallback converts into another
            // widget, so one request becomes a question-every-round loop. The
            // profile drops the three interactive tools and states the rule in
            // the prompt. Injected only when this build's help advertises
            // `--agent-file`; an unknown flag would abort the whole turn.
            if kimi_cli_supports_agent_file(&binary, &shell) {
                let agent = write_kimi_headless_agent(cwd.as_deref())?;
                args.push("--agent-file".into());
                args.push(agent.path().to_string_lossy().to_string());
                temp_files.push(agent);
            }

            // Model selection never rides a real id via `--model`: the CLI
            // resolves unknown aliases against config.toml's [models.*] table
            // and dies with `Model "<id>" is not configured in config.toml`
            // (should_pass_model("kimi", ..) is false for every id). When the
            // env overlay is active (KIMI_MODEL_NAME + KIMI_MODEL_API_KEY,
            // injected per-channel by resolver.ts) the CLI registers the
            // synthesized model under the reserved alias `__kimi_env_model__`
            // — pin it explicitly so a stale `default_model` in the user's
            // config.toml cannot shadow the channel's selected model. Without
            // the overlay, omit `-m` and let the CLI use its own login state.
            let kimi_env_overlay_active = env_vars
                .as_ref()
                .and_then(|vars| env_value(vars, "KIMI_MODEL_NAME"))
                .map(str::trim)
                .is_some_and(|value| !value.is_empty())
                && env_vars
                    .as_ref()
                    .and_then(|vars| env_value(vars, "KIMI_MODEL_API_KEY"))
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty());
            if kimi_env_overlay_active {
                args.push("--model".into());
                args.push("__kimi_env_model__".into());
            }

            if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    workdir = Some(p.to_path_buf());
                }
            }
            for dir in &extra_workspace_paths {
                args.push("--add-dir".into());
                args.push(dir.clone());
            }
            // Snapshot kimi session dirs BEFORE spawn so the live-progress
            // tracer can tell this run's brand-new session directory apart
            // from everything that existed before (see kimi_log::run_tracer).
            let kimi_roots = kimi_log::kimi_sessions_roots();
            let kimi_known = kimi_log::snapshot_session_dirs(&kimi_roots);
            let kimi_spawned_at = std::time::SystemTime::now();
            kimi_tracer_plan = Some((kimi_roots, kimi_known, kimi_spawned_at));
        } else if is_dsh {
            // dsh (`@deepseek-ai/dsh`) runs one headless task via the
            // `--profile headless "<task>"` positional argument and prints the
            // final answer to stdout before exiting. There is no JSONL stream,
            // no `--model` flag (the model lives in `$DSH_HOME/settings.yaml`),
            // and the prompt is not read from stdin — so assemble the full task
            // (extra-workspace note + language directive + prompt) inline here.
            let mut task = String::new();
            if inject_extra_workspace_note {
                task.push_str(&extra_workspace_note);
                if !task.is_empty() {
                    task.push_str("\n\n");
                }
            }
            task.push_str(&prompt);
            if !language_directive.is_empty() {
                task.push_str("\n\n");
                task.push_str(&language_directive);
            }
            // Prefer spawning dsh's underlying `node bin.js` directly instead of
            // the `.cmd` shim. cmd.exe caps the whole command line at ~8191
            // chars, and a chat prompt (system prefix + history + the task,
            // which sits LAST) easily overflows it — truncating the task so dsh
            // only sees the lead-in and answers with a generic greeting. Node
            // spawned directly gets the ~32767-char CreateProcess ceiling (~4x),
            // which fits a real turn. Fall back to the shim if the package
            // layout isn't the expected npm shim.
            if let Some(entry) = cli_runtime::resolve_dsh_node_entry(&binary) {
                dsh_node_entry = Some(entry.to_string_lossy().to_string());
            }
            // Live progress: dsh headless stdout stays silent until the final
            // answer, so the run would look frozen for minutes. dsh does stream
            // every step into its persistent session log in real time (that's
            // what `dsh web` renders); a `--patch` overlay redirects that log
            // to a UGS-owned plain-JSONL root (see dsh_log::ugs_patch_yaml),
            // which dsh_log::run_tracer tails into `ai-cli-progress` events.
            // The patched root is injected via UGS_DSH_SESSIONS so the web/tui
            // profiles sharing `$DSH_HOME/sessions` are never touched.
            //
            // Channel model/baseURL are baked into the same patch file: dsh's
            // `agent-default-model` composition entry defaults to
            // `deepseek-v4-flash`, which breaks any third-party DeepSeek-
            // compatible relay the channel points at (the relay receives the
            // official model id and 400s). The channel's model is forwarded
            // via UGS_DSH_MODEL (a UGS-only env var dsh itself never reads);
            // baseURL is read from DEEPSEEK_BASE_URL, which the resolver
            // already injects for dsh. Both are optional — when absent, the
            // patch row is omitted and dsh's own defaults/settings.yaml win.
            let dsh_root = dsh_log::ugs_dsh_sessions_root();
            let _ = std::fs::create_dir_all(&dsh_root);
            let dsh_patch_path =
                temp_output_path_for_cwd(cwd.as_deref(), "ultragamestudio-dsh", "yml");
            let dsh_model = env_vars
                .as_ref()
                .and_then(|vars| vars.get("UGS_DSH_MODEL").map(String::as_str));
            let dsh_base_url = env_vars
                .as_ref()
                .and_then(|vars| vars.get("DEEPSEEK_BASE_URL").map(String::as_str));
            // Windows CreateProcess 把整条命令行限制在 ~32767 个 UTF-16 字符
            // （os error 206「文件名或扩展名太长」）。直接 `node bin.js` 已把上限
            // 从 cmd.exe 的 ~8191 提到 ~32767，但长对话回合（系统前缀 + 历史 +
            // 位于最后的任务）仍会把它撑爆。一旦估计会溢出，就把任务写进
            // `--patch` 覆盖层里 `headless-runner` 的 `task` 配置（dsh-headless
            // 正是读这个字段驱动本轮任务），让命令行上只留短小的 patch 路径与
            // 占位位置参数，从而彻底规避命令行长问题。
            let dsh_argv_estimate = dsh_node_entry.as_deref().map(str::len).unwrap_or(0)
                + 96 // node.exe 路径 + 引号/分隔符余量
                + dsh_patch_path.to_string_lossy().len()
                + task.len()
                + 64; // --patch / --profile headless + 分隔符
            // 命中 `node <bin.js>` 直启（布局完整）时上限 ~32767；退回 `.cmd`
            // shim（cmd /C，布局缺 bin.js）时上限骤降到 ~8191，阈值也相应收紧。
            let dsh_cmdline_cap = if dsh_node_entry.is_some() {
                DSH_MAX_CMDLINE_LEN
            } else {
                DSH_CMDSHIM_MAX_CMDLINE_LEN
            };
            let mut task_via_patch = dsh_argv_estimate > dsh_cmdline_cap;
            let mut dsh_patch = dsh_log::ugs_patch_yaml_with_plan(
                dsh_model,
                dsh_base_url,
                task_via_patch.then_some(task.as_str()),
                thinking_level.as_deref(),
                thinking_plan.as_ref(),
            );
            // 不变量：决定用占位符 `"."` 顶替任务之前，patch 里必须真的带上了
            // 任务文本。任何让 `headless-runner.task` 缺失的路径都不能静默用
            // `"."` 冒充任务（dsh 会把 `.` 当用户消息，模型只看到一个句点，
            // 表现成"大模型失智"）。宁可退回 argv 传任务——那种情况超长会明确
            // 报 os error 206——也不静默丢任务。
            if task_via_patch && !dsh_patch.contains("id: headless-runner") {
                task_via_patch = false;
                dsh_patch = dsh_log::ugs_patch_yaml_with_plan(
                    dsh_model,
                    dsh_base_url,
                    None,
                    thinking_level.as_deref(),
                    thinking_plan.as_ref(),
                );
            }
            let _ = std::fs::write(&dsh_patch_path, dsh_patch);
            temp_files.push(TempFileGuard::new(dsh_patch_path.clone()));
            args.push("--patch".into());
            args.push(dsh_patch_path.to_string_lossy().to_string());
            dsh_sessions_root = Some(dsh_root);
            args.push("--profile".into());
            args.push("headless".into());
            if task_via_patch {
                // 占位位置参数：满足 headless-startup 的“非空任务”校验，
                // 真正的任务文本由 --patch 覆盖层里的 headless-runner.task 提供。
                args.push(".".into());
            } else {
                args.push(task);
            }
            // dsh's sandbox admits a single workspace root (the session's
            // `process.cwd()`) and has no `--add-dir` flag. So when extra
            // workspace folders are configured, root the session at their
            // common ancestor to give each folder the SAME write permission as
            // the primary cwd. Falls back to the plain cwd when there are no
            // extras or when they share no directory (different drives).
            if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    let mut scope = vec![p.to_string_lossy().to_string()];
                    scope.extend(extra_workspace_paths.iter().cloned());
                    workdir = Some(common_ancestor_dir(&scope).unwrap_or_else(|| p.to_path_buf()));
                }
            }
        } else if is_grok {
            // grok (`@xai-official/grok`) is claude-family headless, but its
            // npm shim routes through cmd.exe on Windows (~8 KB argv cap), so
            // the full turn prompt is handed over via `--prompt-file` instead
            // of argv/stdin. `--output-format streaming-messages-json` emits
            // NDJSON in the Anthropic Messages wire format — the same
            // `assistant`/`user`/`result` shape the claude parser reads below.
            let mut task = String::new();
            if inject_extra_workspace_note {
                task.push_str(&extra_workspace_note);
                if !task.is_empty() {
                    task.push_str("\n\n");
                }
            }
            task.push_str(&prompt);
            if !language_directive.is_empty() {
                task.push_str("\n\n");
                task.push_str(&language_directive);
            }
            let prompt_path =
                managed_temp_path(cwd.as_deref(), "sidecar", "ultragamestudio-grok", "txt");
            std::fs::write(&prompt_path, task.as_bytes())
                .map_err(|e| format!("写入 grok 提示文件失败: {e}"))?;
            temp_files.push(TempFileGuard::new(prompt_path.clone()));

            args.push("-p".into());
            args.push("--output-format".into());
            args.push("streaming-messages-json".into());

            // Session continuity: continue a prior session (warm context) when
            // the caller asks to resume, else pin a fresh session id.
            if let Some(sid) = session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                if resume.unwrap_or(false) {
                    args.push("--resume".into());
                    args.push(sid.to_string());
                } else {
                    args.push("--session-id".into());
                    args.push(sid.to_string());
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
                    args.push("--permission-mode".into());
                    args.push("plan".into());
                }
                "ask" => {}
                _ => {
                    args.push("--permission-mode".into());
                    args.push("bypassPermissions".into());
                }
            }

            if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    workdir = Some(p.to_path_buf());
                    args.push("--cwd".into());
                    args.push(dir.to_string());
                }
            }

            args.push("--prompt-file".into());
            args.push(prompt_path.to_string_lossy().to_string());
        } else if is_zcode {
            // ZCode (zcode-app-cli) credentials live ONLY in
            // `~/.zcode/cli/config.json` (`provider.zai` + `model.main`) — never
            // env vars — so when the channel carried a key/base url/model (via
            // ZCODE_* env) merge them in BEFORE spawning, otherwise a keyless
            // config fails the whole turn with the opaque `Turn execution failed`.
            ensure_zcode_user_config(env_vars.as_ref())?;
            let mut task = String::new();
            if inject_extra_workspace_note {
                task.push_str(&extra_workspace_note);
                if !task.is_empty() {
                    task.push_str("\n\n");
                }
            }
            task.push_str(&prompt);
            if !language_directive.is_empty() {
                task.push_str("\n\n");
                task.push_str(&language_directive);
            }
            // Prefer the bundled runtime's `app-server` stdio JSON-RPC server
            // (`node <pkg>/vendor/zcode.cjs app-server`), which streams REAL
            // token deltas via `session/event` — the only zcode surface that
            // emits machine-readable live output. Fall back to the historical
            // `--prompt --json` one-shot (single envelope at EOF, no streaming)
            // when the vendor bundle isn't in the expected npm layout.
            if let Some(entry) = cli_runtime::resolve_zcode_runtime_entry(&binary) {
                zcode_node_entry = Some(entry.to_string_lossy().to_string());
                // Keep this in sync with `ai_cli_steer_channel`, which answers
                // the UI probe from the very same `resolve_zcode_runtime_entry`
                // lookup — that is what lets the zcode ⚡ action and this
                // transport agree by construction.
                zcode_app_server = true;
                zcode_task = Some(task.clone());
                args.push("app-server".into());
            } else if let Some(entry) = cli_runtime::resolve_zcode_node_entry(&binary) {
                // Direct-launcher one-shot: `node <pkg>/bin/zcode.js --prompt
                // <task> --json --mode <mode>`. Spawning node directly bypasses
                // the `.cmd` shim's cmd.exe ~8191-char command-line cap (node
                // gets the ~32767-char CreateProcess ceiling).
                zcode_node_entry = Some(entry.to_string_lossy().to_string());
            }
            if !zcode_app_server {
                args.push("--prompt".into());
                args.push(task);
                args.push("--json".into());
                match permission.as_deref().unwrap_or("full") {
                    "readonly" => {
                        args.push("--mode".into());
                        args.push("plan".into());
                    }
                    "ask" => {
                        args.push("--mode".into());
                        args.push("build".into());
                    }
                    _ => {
                        args.push("--mode".into());
                        args.push("yolo".into());
                    }
                }
                // Session continuity (one-shot only; the app-server path maps
                // this onto `session/resume` in the writer thread): continue a
                // prior session (warm context) when the caller asks to resume.
                if let Some(sid) = session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    if resume.unwrap_or(false) {
                        args.push("--resume".into());
                        args.push(sid.to_string());
                    }
                }
            }
            if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
                let p = std::path::Path::new(dir);
                if p.is_dir() {
                    workdir = Some(p.to_path_buf());
                }
            }
        } else {
            // The prompt is fed via stdin (not a positional arg) so large
            // aggregation prompts can't hit the OS command-line length limit
            // (~32KB on Windows), which would stall the final "summary" node.
            args.push("-p".into());
            args.push("--output-format".into());
            args.push("stream-json".into());
            args.push("--verbose".into());
            if claude_stream_input {
                args.push("--input-format".into());
                args.push("stream-json".into());
            }
            // Only UGS-owned routes may opt into minimal print mode through the
            // private UGS_CLAUDE_BARE capability flag. User-provided base URLs
            // are data only and must never change launcher behavior.
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
            if let Some(owner) = native_owner.as_ref() {
                owner.check_active()?;
                let (host, request) = native_skill.as_ref().ok_or("SKILL_NATIVE_HOST_REQUIRED")?;
                let settings = mcp_enabled().then(||
                    skills::native_launch::NativeSkillCliScope::project_settings(host, cwd.as_deref())
                ).flatten();
                let strict = !mcp_enabled() || settings.as_ref()
                    .is_some_and(project_mcp_settings_prefers_unreal_mcp);
                // Independent authority budget: ordinary CLI timeout=0 must never grant an unbounded bridge.
                let scope = Arc::new(skills::native_launch::NativeSkillCliScope::start(
                    Arc::clone(host), request.clone(), &run_id, cwd.as_deref(),
                    &skills::native_launch::NativeSkillCliScope::private_scratch(host),
                    settings, 256, std::time::Duration::from_secs(600),
                )?);
                scope.append_claude_args(&mut args);
                if strict { args.push("--strict-mcp-config".into()); }
                owner.attach(Arc::clone(&scope))?;
                native_scope = Some(scope);
            } else if mcp_enabled() {
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
            // 思考深度：claude CLI 用 `--effort <level>`
            // （low/medium/high/xhigh/max）。旧版本没有这个选项，传了会直接
            // 报 unknown option 把整轮打死，所以先探一次 `--help` 再决定。
            if let Some(level) = thinking_level.as_deref() {
                if claude_cli_supports_effort(&binary, &shell) {
                    args.push("--effort".into());
                    args.push(level.to_string());
                }
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
            if inject_extra_workspace_note || !language_directive.is_empty() {
                let combined: Vec<&str> = [
                    inject_extra_workspace_note.then_some(extra_workspace_note.as_str()),
                    (!language_directive.is_empty()).then_some(language_directive.as_str()),
                ]
                .into_iter()
                .flatten()
                .collect();
                args.push("--append-system-prompt".into());
                args.push(combined.join("\n\n"));
            }
        }

        // If codex's own `config.toml` already selects a named `model_provider`
        // (the user's working relay + endpoint/wire layout), UGS must NOT
        // override `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`: injecting
        // them makes codex resolve a different provider/wire than the configured
        // one, so the relay rejects the turn (HTTP 40x surfaced as "turn status
        // failed"). The selected model still rides `--model`.
        //
        // The credential, however, must still come from 设置 → 模型 instead of the
        // user's global `~/.codex/auth.json`: leaving codex on that stale file is
        // exactly why editing the channel key had no effect (the Kuro gateway kept
        // answering `403 该用途已停止接受新请求` with the old key). So this spawn
        // overrides *only* the selected provider's credential slot via
        // `-c model_providers.<provider>.env_key=…` and exports the channel key
        // under that variable — endpoint and `wire_api` stay as configured.
        let codex_respects_own_config = is_codex && codex_uses_named_model_provider();
        let codex_channel_key = if codex_respects_own_config {
            env_vars
                .as_ref()
                .and_then(|env| env_value(env, "OPENAI_API_KEY"))
                .map(str::to_owned)
        } else {
            None
        };
        if codex_channel_key.is_some() {
            if let Some(provider) = codex_provider_credential_override() {
                args.push("-c".into());
                args.push(format!(
                    "model_providers.{provider}.env_key=\"{CODEX_CHANNEL_KEY_ENV}\""
                ));
            }
        }

        let mut cmd = if let Some(entry) = dsh_node_entry.as_deref() {
            // dsh direct-node launch: `node <bin.js> --profile headless <task>`.
            // Skip the launch-shell wrapper entirely so the long task argv goes
            // straight to CreateProcess (no cmd.exe 8191-char truncation).
            let mut node_args = Vec::with_capacity(args.len() + 1);
            node_args.push(entry.to_string());
            node_args.extend(args.iter().cloned());
            build_launch_command("node", &node_args, &None)
        } else if let Some(entry) = zcode_node_entry.as_deref() {
            // zcode direct-node launch: either `node <pkg>/vendor/zcode.cjs
            // app-server` (streaming protocol) or `node <pkg>/bin/zcode.js
            // --prompt <task> --json --mode <mode>` (one-shot fallback). Same
            // cmd.exe-length bypass as dsh.
            let mut node_args = Vec::with_capacity(args.len() + 1);
            node_args.push(entry.to_string());
            node_args.extend(args.iter().cloned());
            build_launch_command("node", &node_args, &None)
        } else if let Some(entry) = kimi_node_entry.as_deref() {
            // kimi-code direct entry launch: `node <pkg>/dist/main.mjs --prompt
            // <task> --output-format stream-json …`. Same cmd.exe-length bypass.
            let mut node_args = Vec::with_capacity(args.len() + 1);
            node_args.push(entry.to_string());
            node_args.extend(args.iter().cloned());
            build_launch_command("node", &node_args, &None)
        } else {
            build_launch_command(&binary, &args, &shell)
        };
        if let Some(env_vars) = env_vars.as_ref() {
            for (key, value) in env_vars {
                if !key.trim().is_empty() && key != "UGS_CLAUDE_BARE" {
                    if codex_respects_own_config
                        && (key == "OPENAI_BASE_URL"
                            || key == "OPENAI_API_KEY"
                            || key == "OPENAI_MODEL")
                    {
                        continue;
                    }
                    cmd.env(key, value);
                }
            }
        }
        if let Some(key) = codex_channel_key.as_deref() {
            // The channel credential, exported under the variable the selected
            // provider's overridden `env_key` points at. codex prefers it over the
            // stale `auth.json`, so 设置 → 模型 finally drives the real request.
            cmd.env(CODEX_CHANNEL_KEY_ENV, key);
        }
        if disable_autoupdater {
            cmd.env("DISABLE_AUTOUPDATER", "1");
            // `DISABLE_AUTOUPDATER` alone doesn't fully suppress the npm
            // registry check / symlink rewrite on npm-based Claude installs
            // (see Claude Code changelog). `DISABLE_UPDATES` is the stricter
            // switch that blocks every update path, including background
            // daemon self-update — exactly what a mid-run chat/tool-use
            // subprocess needs. It also blocks manual `claude update`, which
            // is fine here because the update button spawns its own process
            // without this env var (see `run_cli_update_blocking`).
            cmd.env("DISABLE_UPDATES", "1");
        }
        if let Some(path) = gemini_system_settings_path.as_deref() {
            cmd.env("GEMINI_CLI_SYSTEM_SETTINGS_PATH", path);
        }
        // Workspace cwd for background-job self-registration: a long-running
        // process the agent detaches (yt-dlp/whisper/ffmpeg) reads this to locate
        // `.ultragamestudio/jobs/` and write its manifest, so its real progress
        // surfaces on the session's Sidebar dot instead of the dot going green
        // when this CLI turn ends. The store session id is injected via the
        // `env_vars` overlay above (UGS_SESSION_ID); we don't derive it from the
        // native continuity `session_id`, which is a different identifier. See
        // lib/backgroundJobs.ts + BackgroundJobRunner.
        if let Some(dir) = workdir.as_ref() {
            cmd.env("UGS_WORKSPACE_CWD", dir);
            cmd.current_dir(dir);
        }
        if let Some(root) = dsh_sessions_root.as_deref() {
            cmd.env("UGS_DSH_SESSIONS", root);
        }
        if is_dsh {
            // dsh 的部署级权限开关：base profile 的 sandbox-policy.mode 与
            // approval.policy 都读 DSH_PERMISSION_MODE（见 dsh-base 的
            // cordis.patch.yml）。不设时 dsh 永远默认 workspace-write + ask，
            // 这正是 composer 选了「完全访问」仍弹申请的根因。映射与 codex
            // 分支一致：full → 完全放行，readonly → 只读，ask → 工作区写入+询问。
            cmd.env("DSH_PERMISSION_MODE", dsh_log::dsh_permission_mode(permission.as_deref()));
        }

        // Snapshot the dsh session root BEFORE spawn so the live-progress
        // tracer can tell this run's brand-new session directory apart from
        // everything that existed before (see dsh_log::run_tracer).
        let dsh_tracer_plan = if let Some(root) = dsh_sessions_root.as_deref() {
            let known = dsh_log::snapshot_session_dirs(root);
            let spawned_at = std::time::SystemTime::now();
            Some((root.to_path_buf(), known, spawned_at))
        } else {
            None
        };

        #[cfg(test)]
        skills::native_launch::test_checkpoint(&run_id, "before-spawn");
        if let Some(owner) = native_owner.as_ref() { owner.check_active()?; }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!("无法启动 CLI \"{binary}\"：请确认它已安装并在 PATH 中。({e})")
            })?;
        // Publish PID immediately; an external cancel cannot miss capability-probe/startup work.
        register_ai_cli(&run_id, child.id());
        // Windows: pin the CLI into a KILL_ON_JOB_CLOSE job so any bash/grep/
        // find/rg it spawns are reaped by the kernel even if UGS crashes or the
        // normal `terminate_child_tree` path is skipped. No-op elsewhere.
        if let Some(job) = assign_child_to_kill_on_close_job(&child) {
            register_ai_cli_job(&run_id, job);
        }
        #[cfg(test)]
        skills::native_launch::test_checkpoint(&run_id, "after-spawn");
        if let Some(owner) = native_owner.as_ref() {
            if let Err(error) = owner.check_active() {
                // Dispatcher revocation precedes process-tree termination, including the spawn race.
                skills::native_launch::cancel_native_cli(&run_id);
                terminate_ai_cli_tree(&mut child, &run_id);
                take_ai_cli_cancelled(&run_id);
                unregister_ai_cli(&run_id);
                return Err(error);
            }
        }
        let last_activity = Arc::new(Mutex::new(std::time::Instant::now()));
        // Codex app-server may print repetitive diagnostics on stderr while a
        // turn makes no real progress. Keep protocol progress separate so log
        // spam cannot defeat the idle watchdog.
        let last_meaningful_activity =
            Arc::new(Mutex::new(std::time::Instant::now()));

        let mut stdin_pipe = child.stdin.take();
        // Codex/Gemini have no `--append-system-prompt`, so the extra-workspace
        // note (claude gets it as a system-prompt arg above) is prepended to the
        // prompt fed over stdin instead. The language directive is appended at
        // the very END instead (right after the user's actual question) — models
        // weight the tail of a long agentic prompt more than the head, so this
        // is the strongest lever available without a real system-role channel.
        let prompt = if inject_extra_workspace_note && (is_codex || is_gemini) {
            format!("{extra_workspace_note}\n\n{prompt}")
        } else {
            prompt
        };
        let prompt = if !language_directive.is_empty() && (is_codex || is_gemini) {
            format!("{prompt}\n\n{language_directive}")
        } else {
            prompt
        };
        let codex_thread_id = Arc::new(Mutex::new(None::<String>));
        let codex_turn_id = Arc::new(Mutex::new(None::<String>));
        let codex_startup_error = Arc::new(Mutex::new(None::<String>));
        let codex_first_event_seen = Arc::new(AtomicBool::new(false));
        let codex_turn_started_at = Arc::new(Mutex::new(None::<std::time::Instant>));
        let codex_pending = Arc::new(Mutex::new(HashMap::new()));
        let codex_stdin = if codex_app_server {
            stdin_pipe.take().map(|stdin| Arc::new(Mutex::new(stdin)))
        } else {
            None
        };
        let claude_stdin = if claude_stream_input {
            stdin_pipe
                .take()
                .map(|stdin| Arc::new(Mutex::new(Some(stdin))))
        } else {
            None
        };
        // zcode app-server protocol state: the session id (populated by the
        // reader from the `session/create`/`session/resume` response) and the
        // startup error slot the writer fills when the handshake fails.
        let zcode_session_id = Arc::new(Mutex::new(None::<String>));
        let zcode_startup_error = Arc::new(Mutex::new(None::<String>));
        let zcode_pending = Arc::new(Mutex::new(HashMap::new()));
        let zcode_stdin = if zcode_app_server {
            stdin_pipe.take().map(|stdin| Arc::new(Mutex::new(stdin)))
        } else {
            None
        };
        if let Some(stdin) = codex_stdin.as_ref() {
            register_ai_cli_steer(
                &run_id,
                ActiveAiCliSteer::Codex(ActiveCodexSteer {
                    stdin: Arc::clone(stdin),
                    thread_id: Arc::clone(&codex_thread_id),
                    turn_id: Arc::clone(&codex_turn_id),
                    pending: Arc::clone(&codex_pending),
                }),
            );
        } else if let Some(stdin) = claude_stdin.as_ref() {
            register_ai_cli_steer(
                &run_id,
                ActiveAiCliSteer::Claude(ActiveClaudeSteer {
                    stdin: Arc::clone(stdin),
                }),
            );
        } else if let Some(stdin) = zcode_stdin.as_ref() {
            register_ai_cli_steer(
                &run_id,
                ActiveAiCliSteer::Zcode(ActiveZcodeSteer {
                    stdin: Arc::clone(stdin),
                    session_id: Arc::clone(&zcode_session_id),
                    pending: Arc::clone(&zcode_pending),
                }),
            );
        }

        let writer_stdin = codex_stdin.clone();
        let writer_claude_stdin = claude_stdin.clone();
        let writer_thread_id = Arc::clone(&codex_thread_id);
        let writer_turn_id = Arc::clone(&codex_turn_id);
        let writer_startup_error = Arc::clone(&codex_startup_error);
        let writer_turn_started_at = Arc::clone(&codex_turn_started_at);
        let writer_prompt = prompt.clone();
        let writer_model = model.clone();
        let writer_cwd = cwd.clone();
        let writer_permission = permission.clone();
        let writer_zcode_stdin = zcode_stdin.clone();
        let writer_zcode_session_id = Arc::clone(&zcode_session_id);
        let writer_zcode_startup_error = Arc::clone(&zcode_startup_error);
        let writer_zcode_task = zcode_task.clone();
        let writer_resume = resume;
        let writer_resume_session_id = session_id.clone();
        let stdin_handle = if codex_app_server {
            std::thread::spawn(move || {
                let Some(stdin) = writer_stdin else {
                    return;
                };
                if let Err(error) = write_codex_app_server_message(
                    &stdin,
                    &serde_json::json!({
                        "method": "initialize",
                        "id": "ugs-init",
                        "params": {
                            "clientInfo": {
                                "name": "UltraGameStudio",
                                "title": "UltraGameStudio",
                                "version": env!("CARGO_PKG_VERSION")
                            }
                        }
                    }),
                ) {
                    set_codex_startup_error(
                        &writer_startup_error,
                        format!("Codex initialize 写入失败：{error}"),
                    );
                    return;
                }
                if let Err(error) = write_codex_app_server_message(
                    &stdin,
                    &serde_json::json!({ "method": "initialized", "params": {} }),
                ) {
                    set_codex_startup_error(
                        &writer_startup_error,
                        format!("Codex initialized 写入失败：{error}"),
                    );
                    return;
                }

                let permission = writer_permission.as_deref().unwrap_or("full");
                let approval_policy = if permission == "ask" {
                    "on-request"
                } else {
                    "never"
                };
                let sandbox = match permission {
                    "readonly" => "read-only",
                    "ask" => "workspace-write",
                    _ => "danger-full-access",
                };
                let mut thread_params = serde_json::json!({
                    "approvalPolicy": approval_policy,
                    "sandbox": sandbox,
                    "ephemeral": true
                });
                if let Some(model) = writer_model
                    .as_deref()
                    .filter(|model| cli_runtime::should_pass_model("codex", model))
                {
                    thread_params["model"] = serde_json::Value::String(model.to_string());
                }
                if let Some(cwd) = writer_cwd
                    .as_deref()
                    .map(str::trim)
                    .filter(|cwd| Path::new(cwd).is_dir())
                {
                    thread_params["cwd"] = serde_json::Value::String(cwd.to_string());
                }
                if let Err(error) = write_codex_app_server_message(
                    &stdin,
                    &serde_json::json!({
                        "method": "thread/start",
                        "id": "ugs-thread-start",
                        "params": thread_params
                    }),
                ) {
                    set_codex_startup_error(
                        &writer_startup_error,
                        format!("Codex thread/start 写入失败：{error}"),
                    );
                    return;
                }

                let thread_id = match wait_for_codex_start_id(
                    &writer_thread_id,
                    &writer_startup_error,
                    std::time::Duration::from_secs(codex_thread_start_timeout_secs()),
                    "thread/start",
                ) {
                    Ok(thread_id) => thread_id,
                    Err(error) => {
                        set_codex_startup_error(&writer_startup_error, error);
                        return;
                    }
                };
                if let Err(error) = write_codex_app_server_message(
                    &stdin,
                    &serde_json::json!({
                        "method": "turn/start",
                        "id": "ugs-turn-start",
                        "params": {
                            "threadId": thread_id,
                            "input": [{ "type": "text", "text": writer_prompt }]
                        }
                    }),
                ) {
                    set_codex_startup_error(
                        &writer_startup_error,
                        format!("Codex turn/start 写入失败：{error}"),
                    );
                    return;
                }
                match wait_for_codex_start_id(
                    &writer_turn_id,
                    &writer_startup_error,
                    std::time::Duration::from_secs(codex_turn_start_timeout_secs()),
                    "turn/start",
                ) {
                    Ok(_) => {
                        if let Ok(mut started_at) = writer_turn_started_at.lock() {
                            *started_at = Some(std::time::Instant::now());
                        }
                    }
                    Err(error) => set_codex_startup_error(&writer_startup_error, error),
                }
            })
        } else if claude_stream_input {
            std::thread::spawn(move || {
                if let Some(stdin) = writer_claude_stdin {
                    let _ = write_claude_stream_message(&stdin, &prompt);
                }
            })
        } else if zcode_app_server {
            // zcode app-server writer: `session/create` (or `session/resume`)
            // → `session/subscribe` (activates `session/event` streaming)
            // → `session/send` (starts the turn). The reader thread parses the
            // NDJSON responses/notifications and populates `zcode_session_id`.
            std::thread::spawn(move || {
                let Some(stdin) = writer_zcode_stdin else {
                    return;
                };
                let cwd_path = writer_cwd
                    .as_deref()
                    .map(str::trim)
                    .filter(|cwd| !cwd.is_empty())
                    .unwrap_or(".");
                let workspace = serde_json::json!({
                    "workspacePath": cwd_path,
                    "workspaceKey": cwd_path,
                });
                let mode = match writer_permission.as_deref().unwrap_or("full") {
                    "readonly" => "plan",
                    "ask" => "build",
                    _ => "yolo",
                };
                let resume_sid = writer_resume_session_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|sid| !sid.is_empty());
                let do_resume = writer_resume.unwrap_or(false) && resume_sid.is_some();
                let session_msg = if do_resume {
                    serde_json::json!({
                        "method": "session/resume",
                        "id": "ugs-zcode-session",
                        "params": { "sessionId": resume_sid.unwrap() }
                    })
                } else {
                    serde_json::json!({
                        "method": "session/create",
                        "id": "ugs-zcode-session",
                        "params": { "workspace": workspace, "mode": mode }
                    })
                };
                if let Err(error) = write_zcode_protocol_message(&stdin, &session_msg) {
                    set_codex_startup_error(
                        &writer_zcode_startup_error,
                        format!("ZCode session 创建写入失败：{error}"),
                    );
                    return;
                }
                let session_id = match wait_for_zcode_start_id(
                    &writer_zcode_session_id,
                    &writer_zcode_startup_error,
                    std::time::Duration::from_secs(codex_thread_start_timeout_secs()),
                    "session/create",
                ) {
                    Ok(id) => id,
                    Err(error) => {
                        set_codex_startup_error(&writer_zcode_startup_error, error);
                        return;
                    }
                };
                // Subscribe BEFORE send: the runtime's session-event gate only
                // starts pushing `session/event` deltas once `deliveryKind` is
                // set, so skipping this yields no live stream at all.
                if let Err(error) = write_zcode_protocol_message(
                    &stdin,
                    &serde_json::json!({
                        "method": "session/subscribe",
                        "id": "ugs-zcode-subscribe",
                        "params": {
                            "sessionId": session_id,
                            "deliveryKind": "desktop-continuous"
                        }
                    }),
                ) {
                    set_codex_startup_error(
                        &writer_zcode_startup_error,
                        format!("ZCode session/subscribe 写入失败：{error}"),
                    );
                    return;
                }
                if let Err(error) = write_zcode_protocol_message(
                    &stdin,
                    &serde_json::json!({
                        "method": "session/send",
                        "id": "ugs-zcode-send",
                        "params": {
                            "sessionId": session_id,
                            "content": writer_zcode_task.unwrap_or_default()
                        }
                    }),
                ) {
                    set_codex_startup_error(
                        &writer_zcode_startup_error,
                        format!("ZCode session/send 写入失败：{error}"),
                    );
                }
            })
        } else if is_dsh || is_zcode || is_kimi || is_grok {
            // dsh reads the task from argv (see the args branch above), not
            // stdin; zcode and kimi likewise take their prompt as a `--prompt`
            // argv value, and grok via `--prompt-file`. Close stdin immediately
            // so none can block on a half-open pipe; the task itself never uses
            // this fd.
            std::thread::spawn(move || {
                drop(stdin_pipe);
            })
        } else {
            std::thread::spawn(move || {
                if let Some(mut stdin) = stdin_pipe {
                    let _ = stdin.write_all(prompt.as_bytes());
                }
            })
        };

        // Reader thread: parse the JSONL stream, emit progress, capture the result.
        let stdout = child.stdout.take();
        let app2 = app.clone();
        let run2 = run_id.clone();
        let native_scope_reader = native_scope.clone();
        let native_run2 = native_scope.as_ref()
            .map(|scope| scope.invocation().execution_run_id().to_owned())
            .unwrap_or_else(|| run_id.clone());
        let parse_codex = is_codex;
        let parse_gemini = is_gemini;
        let parse_kimi = is_kimi;
        let parse_dsh = is_dsh;
        // zcode has two stdout shapes: the historical `--json` one-shot (raw
        // envelope parsed at EOF) and the new `app-server` NDJSON protocol
        // (streamed `session/event` deltas). `parse_zcode` covers only the
        // one-shot; `parse_zcode_app_server` handles the live protocol.
        let parse_zcode = is_zcode && !zcode_app_server;
        let parse_zcode_app_server = is_zcode && zcode_app_server;
        let claude_stdin_reader = claude_stdin.clone();
        let zcode_session_id_reader = Arc::clone(&zcode_session_id);
        let zcode_startup_error_reader = Arc::clone(&zcode_startup_error);
        let zcode_pending_reader = Arc::clone(&zcode_pending);
        // The zcode app-server is BIDIRECTIONAL: it sends its own requests to
        // the client (e.g. `session/requestRuntimePreferences`) that must be
        // answered. The reader replies through this shared stdin handle (the
        // `Mutex` inside serializes writes with the writer thread).
        let zcode_stdin_reader = zcode_stdin.clone();
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
        // Claude/gemini stream-json can end on a terminal `result` event that
        // reports a FAILED turn (is_error / subtype "error_*") with no usable
        // text. Capture that error so an otherwise-empty turn surfaces the real
        // cause instead of a blank "（模型没有返回内容）" bubble.
        let claude_stream_error = Arc::new(Mutex::new(None::<String>));
        let claude_stream_error_reader = Arc::clone(&claude_stream_error);
        let codex_streamed_output = Arc::new(Mutex::new(String::new()));
        let codex_streamed_output_reader = Arc::clone(&codex_streamed_output);
        let codex_thread_id_reader = Arc::clone(&codex_thread_id);
        let codex_turn_id_reader = Arc::clone(&codex_turn_id);
        let codex_startup_error_reader = Arc::clone(&codex_startup_error);
        let codex_first_event_seen_reader = Arc::clone(&codex_first_event_seen);
        let codex_pending_reader = Arc::clone(&codex_pending);
        let stdout_activity = Arc::clone(&last_activity);
        let meaningful_activity_reader = Arc::clone(&last_meaningful_activity);
        // Claude/Gemini stream-json emit a terminal `result` event once the turn
        // is logically done. The process itself can linger afterward (lingering
        // MCP servers / child processes), so polling `try_wait` alone can spin
        // until the global timeout even though the answer is fully streamed.
        // The reader sets this flag on the terminal event so the wait loop can
        // break early and gracefully terminate the (already finished) process.
        let stream_result_seen = Arc::new(AtomicBool::new(false));
        let stream_result_seen_reader = Arc::clone(&stream_result_seen);
        // Tracks whether the CLI ever produced real model output (assistant
        // text/thinking, a tool call, or a non-empty terminal result) as
        // opposed to only the "session started / requesting model" progress
        // placeholders. A process that exits with code 0 without ever
        // flipping this is a silent failure (dropped connection, auth hiccup,
        // killed mid-turn) and must NOT be reported as a successful turn.
        let received_content = Arc::new(AtomicBool::new(false));
        let received_content_reader = Arc::clone(&received_content);
        // Tracks whether the stream ever emitted a real tool_use. A turn whose
        // only output is tool calls (no closing prose) is still a successful
        // turn, so we must not treat its empty text as a silent failure.
        let emitted_tool_use = Arc::new(AtomicBool::new(false));
        let emitted_tool_use_reader = Arc::clone(&emitted_tool_use);
        // dsh live-progress tracer: tails the redirected session log (plain
        // JSONL, see dsh_log) into `ai-cli-progress` events while the process
        // runs. `active` flips once the tracer has forwarded any content — the
        // stdout reader then stops re-forwarding the final answer (the log
        // already streamed it) to avoid duplicating text in the live bubble;
        // if the tracer never engages, stdout falls back to the old behavior.
        let dsh_tracer_cancel = Arc::new(AtomicBool::new(false));
        let dsh_tracer_active = Arc::new(AtomicBool::new(false));
        let dsh_tracer_active_reader = Arc::clone(&dsh_tracer_active);
        let dsh_tracer_handle = if let Some((root, known, spawned_at)) = dsh_tracer_plan {
            let app_tracer = app.clone();
            let run_tracer_id = run_id.clone();
            let activity_tracer = Arc::clone(&last_activity);
            let received_tracer = Arc::clone(&received_content);
            let active_tracer = Arc::clone(&dsh_tracer_active);
            let cancel_tracer = Arc::clone(&dsh_tracer_cancel);
            Some(std::thread::spawn(move || {
                dsh_log::run_tracer(dsh_log::DshTracerConfig {
                    app: app_tracer,
                    run_id: run_tracer_id,
                    sessions_root: root,
                    known,
                    spawned_at,
                    activity: activity_tracer,
                    received: received_tracer,
                    active: active_tracer,
                    cancel: cancel_tracer,
                });
            }))
        } else {
            None
        };
        // kimi live-progress tracer: tails wire.jsonl (real text/think deltas
        // + tool calls) into ai-cli-progress events while the process runs.
        // `active` flips once the tracer has forwarded any content — the
        // stdout reader then stops re-forwarding the final answer (the log
        // already streamed it) to avoid duplicating text in the live bubble;
        // if the tracer never engages, stdout falls back to the old behavior.
        let kimi_tracer_cancel = Arc::new(AtomicBool::new(false));
        let kimi_tracer_active = Arc::new(AtomicBool::new(false));
        let kimi_tracer_active_reader = Arc::clone(&kimi_tracer_active);
        let kimi_tracer_handle = if let Some((roots, known, spawned_at)) = kimi_tracer_plan {
            let app_tracer = app.clone();
            let run_tracer_id = run_id.clone();
            let activity_tracer = Arc::clone(&last_activity);
            let received_tracer = Arc::clone(&received_content);
            let active_tracer = Arc::clone(&kimi_tracer_active);
            let cancel_tracer = Arc::clone(&kimi_tracer_cancel);
            Some(std::thread::spawn(move || {
                kimi_log::run_tracer(kimi_log::KimiTracerConfig {
                    app: app_tracer,
                    run_id: run_tracer_id,
                    sessions_roots: roots,
                    known,
                    spawned_at,
                    activity: activity_tracer,
                    received: received_tracer,
                    active: active_tracer,
                    cancel: cancel_tracer,
                });
            }))
        } else {
            None
        };
        let partial_streaming = partial_enabled();
        let stdout_read_error = Arc::new(Mutex::new(None::<String>));
        let stdout_read_error_reader = Arc::clone(&stdout_read_error);
        let out_handle = spawn_ai_cli_stdout_reader(Arc::clone(&stdout_read_error), move || -> String {
            let mut result = String::new();
            let mut acc = String::new();
            // Token-level partial deltas (`stream_event` content_block_delta) are
            // shown live only and deliberately NOT pushed into `acc` — the
            // authoritative text comes from complete `assistant` / terminal
            // `result` events. But when the CLI exits 0 without ever emitting
            // those terminal events (dropped connection, relay abort, process
            // killed mid-turn), the streamed text is the only content the user
            // actually saw. Accumulate it here so it can be returned as a
            // fallback instead of reporting a misleading "no reply" failure.
            let mut partial_text = String::new();
            let mut saw_text_delta_for_message = false;
            // `prev_kind` tracks the last delta kind ("text" / "thinking") so we
            // can insert a separator when the model switches between them.
            let mut prev_kind: &str = "";
            // zcode app-server: whether a `reasoning_delta` is currently open,
            // so we can wrap the model's chain-of-thought in `<think>` markers
            // and close it when text resumes (mirrors the claude convention).
            let mut zcode_in_think = false;
            // codex: last error message seen on stdout (`error` / `turn.failed`
            // events). Both events carry the same message, so dedupe here —
            // only the first copy is pushed into the streamed output.
            let mut codex_last_error: Option<String> = None;
            // Native id → timing + identity; completion records omit names/parents.
            let mut tool_starts: HashMap<String, NativeToolStart> = HashMap::new();
            let mut native_tool_sink = |event: &str, mut payload: serde_json::Value| {
                #[cfg(test)]
                if payload.get("phase").and_then(serde_json::Value::as_str) == Some("end") {
                    skills::native_launch::test_checkpoint(&run2, "before-native-end");
                }
                if let Some(scope) = native_scope_reader.as_ref() {
                    // Authentic parser events enter host authority before any UI consumer.
                    if scope.invocation().observe_native_event(&mut payload).is_err() { return; }
                    payload["requestRunId"] = run2.clone().into();
                }
                let _ = app2.emit(event, payload);
            };
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
                        Err(error) => {
                            if let Ok(mut slot) = stdout_read_error_reader.lock() {
                                *slot = Some(format!("stdout 读取失败: {error}"));
                            }
                            break;
                        }
                    }
                    let line = line.trim_end_matches(['\r', '\n']);
                    touch_activity(&stdout_activity);
                    if line.trim().is_empty() {
                        continue;
                    }
                    if parse_dsh {
                        // dsh headless prints plain text (the final answer), not
                        // JSONL. Accumulate it verbatim; the process exit code
                        // decides success (0=completed, else 1). While the
                        // session-log tracer is live it already streamed the
                        // text incrementally, so skip re-forwarding the final
                        // answer to avoid duplicating the bubble; when the
                        // tracer never engaged (log missing/unreadable), keep
                        // streaming stdout so the run still fills in at the end.
                        acc.push_str(line);
                        acc.push('\n');
                        if !dsh_tracer_active_reader.load(Ordering::Relaxed) {
                            progress.push(line);
                            progress.push("\n");
                        }
                        received_content_reader.store(true, Ordering::Relaxed);
                        continue;
                    }
                    if parse_zcode {
                        // zcode `--json` emits a single structured envelope
                        // (sessionId/turnId/response/usage/projection), possibly
                        // pretty-printed across multiple lines, with its final
                        // answer in `response`. Stream the raw text live while
                        // accumulating; the envelope is parsed once at EOF.
                        acc.push_str(line);
                        acc.push('\n');
                        progress.push(line);
                        progress.push("\n");
                        received_content_reader.store(true, Ordering::Relaxed);
                        continue;
                    }
                    if parse_zcode_app_server {
                        // zcode app-server NDJSON (newline-delimited JSON-RPC):
                        // responses carry an `id`, notifications carry a
                        // `method`. Real text arrives as `session/event`
                        // notifications whose `payload.kind` is `text_delta`
                        // (answer) or `reasoning_delta` (chain-of-thought);
                        // `state.updated` marks turn start/completion.
                        let v: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        // --- Server-initiated REQUEST: carries BOTH `id` and
                        // `method` (e.g. `session/requestRuntimePreferences`).
                        // The server awaits our reply, so answer immediately.
                        // A `-32601` (method not found) tells the server there
                        // is no interactive client and it falls back to its
                        // built-in defaults for preferences/permissions. ---
                        if v.get("id").is_some() && v.get("method").is_some() {
                            if let Some(stdin) = zcode_stdin_reader.as_ref() {
                                let req_id = v
                                    .get("id")
                                    .cloned()
                                    .unwrap_or(serde_json::Value::Null);
                                let reply = serde_json::json!({
                                    "id": req_id,
                                    "error": {
                                        "code": -32601,
                                        "message": "Method not found"
                                    }
                                });
                                let _ = write_zcode_protocol_message(stdin, &reply);
                            }
                            continue;
                        }
                        // --- Responses (have an `id`, no `method`) ---
                        if v.get("id").is_some() {
                            if v.get("id").and_then(|id| id.as_str())
                                == Some("ugs-zcode-session")
                            {
                                if let Some(error) = v.get("error") {
                                    if let Ok(mut slot) = zcode_startup_error_reader.lock() {
                                        if slot.is_none() {
                                            let msg = error
                                                .get("message")
                                                .and_then(|m| m.as_str())
                                                .unwrap_or("session 创建/恢复失败");
                                            *slot = Some(format!("ZCode session 失败：{msg}"));
                                        }
                                    }
                                } else if let Some(sid) = v
                                    .pointer("/result/session/sessionId")
                                    .or_else(|| v.pointer("/result/sessionId"))
                                    .or_else(|| v.pointer("/result/record/sessionId"))
                                    .and_then(|s| s.as_str())
                                {
                                    if let Ok(mut slot) = zcode_session_id_reader.lock() {
                                        if slot.is_none() {
                                            *slot = Some(sid.to_string());
                                        }
                                    }
                                }
                            } else if v.get("id").and_then(|id| id.as_str())
                                == Some("ugs-zcode-send")
                            {
                                if let Some(error) = v.get("error") {
                                    if let Ok(mut slot) = claude_stream_error_reader.lock() {
                                        if slot.is_none() {
                                            let msg = error
                                                .get("message")
                                                .and_then(|m| m.as_str())
                                                .unwrap_or("session/send 失败");
                                            *slot = Some(format!("ZCode 本轮执行出错：{msg}"));
                                        }
                                    }
                                }
                            } else if let Some(req_id) = v
                                .get("id")
                                .and_then(|id| id.as_str())
                                .filter(|id| id.starts_with("ugs-zcode-steer-"))
                            {
                                // Steer ack: route the `session/send` response
                                // back to the waiting `steer_ai_cli` call. An
                                // error ack means the runtime rejected the
                                // steer — surface it so the frontend can fall
                                // back to the FIFO queue instead of losing the
                                // message silently.
                                let result = if let Some(error) = v.get("error") {
                                    let msg = error
                                        .get("message")
                                        .and_then(|m| m.as_str())
                                        .unwrap_or("session/send 被拒绝");
                                    Err(format!("ZCode steer 失败:{msg}"))
                                } else {
                                    Ok(())
                                };
                                let sender = zcode_pending_reader
                                    .lock()
                                    .ok()
                                    .and_then(|mut pending| pending.remove(req_id));
                                if let Some(sender) = sender {
                                    let _ = sender.send(result);
                                }
                            }
                            continue;
                        }
                        // --- Notifications (have a `method`, no `id`) ---
                        let Some(method) = v.get("method").and_then(|m| m.as_str()) else {
                            continue;
                        };
                        match method {
                            "session/event" => {
                                let payload = v.get("params").and_then(|p| p.get("payload"));
                                let kind = payload
                                    .and_then(|p| p.get("kind"))
                                    .and_then(|k| k.as_str());
                                match kind {
                                    Some("text_delta") => {
                                        let delta = payload
                                            .and_then(|p| p.get("delta"))
                                            .and_then(|d| d.as_str())
                                            .unwrap_or("");
                                        if !delta.is_empty() {
                                            if zcode_in_think {
                                                progress.push("</think>");
                                                zcode_in_think = false;
                                            }
                                            acc.push_str(delta);
                                            progress.push(delta);
                                            received_content_reader
                                                .store(true, Ordering::Relaxed);
                                            touch_activity(&meaningful_activity_reader);
                                        }
                                    }
                                    Some("reasoning_delta") => {
                                        let delta = payload
                                            .and_then(|p| p.get("delta"))
                                            .and_then(|d| d.as_str())
                                            .unwrap_or("");
                                        if !delta.is_empty() {
                                            if !zcode_in_think {
                                                progress.push("<think>");
                                                zcode_in_think = true;
                                            }
                                            progress.push(delta);
                                            received_content_reader
                                                .store(true, Ordering::Relaxed);
                                            touch_activity(&meaningful_activity_reader);
                                        }
                                    }
                                    Some("tool_call")
                                    | Some("tool_input_start")
                                    | Some("tool_input_delta")
                                    | Some("tool_input_end") => {
                                        emitted_tool_use_reader.store(true, Ordering::Relaxed);
                                        touch_activity(&meaningful_activity_reader);
                                    }
                                    _ => {}
                                }
                            }
                            "state.updated" => {
                                let reason = v
                                    .pointer("/params/reason")
                                    .and_then(|r| r.as_str());
                                match reason {
                                    Some("prompt_started") => {
                                        if !requesting_done {
                                            requesting_done = true;
                                            progress.emit_now("⏳ 正在请求模型…\n");
                                        }
                                    }
                                    Some("prompt_completed") => {
                                        if zcode_in_think {
                                            progress.push("</think>");
                                            zcode_in_think = false;
                                        }
                                        received_content_reader.store(true, Ordering::Relaxed);
                                        progress.flush();
                                        // Signal the wait loop: the turn is
                                        // logically done (the app-server itself
                                        // stays alive as a server).
                                        stream_result_seen_reader.store(true, Ordering::Relaxed);
                                    }
                                    Some("prompt_failed") => {
                                        if zcode_in_think {
                                            progress.push("</think>");
                                            zcode_in_think = false;
                                        }
                                        let detail = v
                                            .pointer("/params/error")
                                            .and_then(|e| e.as_str())
                                            .or_else(|| {
                                                v.pointer("/params/message").and_then(|m| m.as_str())
                                            })
                                            .unwrap_or("ZCode 本轮执行失败");
                                        if let Ok(mut slot) = claude_stream_error_reader.lock() {
                                            if slot.is_none() {
                                                *slot = Some(detail.to_string());
                                            }
                                        }
                                        progress.flush();
                                        stream_result_seen_reader.store(true, Ordering::Relaxed);
                                    }
                                    _ => {}
                                }
                            }
                            _ => {}
                        }
                        continue;
                    }
                    if parse_kimi {
                        // kimi `-p --output-format stream-json` emits one JSON
                        // object per line; the assistant line carries the final
                        // answer in `content` (a plain string on current
                        // kimi-code; historically a block array too — accept
                        // both shapes). `meta`/`tool` lines are ignored here.
                        //
                        // While the wire.jsonl tracer is live it already
                        // streamed the text incrementally, so skip
                        // re-forwarding the final answer to avoid duplicating
                        // the bubble; when the tracer never engaged (log
                        // missing/unreadable), keep streaming stdout so the
                        // run still fills in at the end.
                        let v: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if v.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                            let text = extract_kimi_assistant_text(v.get("content"));
                            if let Some(tx) = text {
                                if !tx.trim().is_empty() {
                                    acc.push_str(&tx);
                                    if !kimi_tracer_active_reader
                                        .load(Ordering::Relaxed)
                                    {
                                        progress.push(&tx);
                                    }
                                    received_content_reader.store(true, Ordering::Relaxed);
                                }
                            }
                        }
                        continue;
                    }
                    if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&line) {
                        if let Some(patch) = context_compression_patch(&raw) {
                            touch_activity(&meaningful_activity_reader);
                            progress.emit_now(&encode_tool_patch(&patch));
                            continue;
                        }
                    }
                    if parse_codex {
                        let event: CodexLiteEvent = match serde_json::from_str(&line) {
                            Ok(event) => event,
                            Err(_) => continue,
                        };
                        if let Some(id) = event.id.as_ref().and_then(|id| {
                            id.as_str()
                                .map(ToString::to_string)
                                .or_else(|| id.as_u64().map(|id| id.to_string()))
                        }) {
                            if matches!(id.as_str(), "ugs-init" | "ugs-thread-start" | "ugs-turn-start")
                                && event.error.is_some()
                            {
                                let message = event
                                    .error
                                    .as_ref()
                                    .and_then(|error| error.get("message"))
                                    .and_then(|message| message.as_str())
                                    .unwrap_or("Codex App Server 请求失败");
                                if let Ok(mut current) = codex_streamed_output_reader.lock() {
                                    current.push_str(message);
                                }
                                progress.emit_now(&format!("⚠ {message}\n"));
                                if let Ok(mut current) = codex_turn_status_reader.lock() {
                                    *current = Some("failed".to_string());
                                }
                                set_codex_startup_error(
                                    &codex_startup_error_reader,
                                    format!("Codex {id} 失败：{message}"),
                                );
                            }
                            if id == "ugs-thread-start" {
                                if let Some(thread_id) = event
                                    .result
                                    .as_ref()
                                    .and_then(|result| result.pointer("/thread/id"))
                                    .and_then(|id| id.as_str())
                                {
                                    if let Ok(mut current) = codex_thread_id_reader.lock() {
                                        *current = Some(thread_id.to_string());
                                    }
                                }
                            } else if id == "ugs-turn-start" {
                                if let Some(turn_id) = event
                                    .result
                                    .as_ref()
                                    .and_then(|result| result.pointer("/turn/id"))
                                    .and_then(|id| id.as_str())
                                {
                                    if let Ok(mut current) = codex_turn_id_reader.lock() {
                                        *current = Some(turn_id.to_string());
                                    }
                                }
                            } else if id.starts_with("ugs-steer-") {
                                let sender = codex_pending_reader
                                    .lock()
                                    .ok()
                                    .and_then(|mut pending| pending.remove(&id));
                                if let Some(sender) = sender {
                                    let response = if let Some(error) = event.error.as_ref() {
                                        Err(error
                                            .get("message")
                                            .and_then(|message| message.as_str())
                                            .unwrap_or("Codex 拒绝了 steer 请求。")
                                            .to_string())
                                    } else {
                                        Ok(())
                                    };
                                    let _ = sender.send(response);
                                }
                            }
                        }
                        if let Some(patch) = event.plan_patch() {
                            codex_first_event_seen_reader.store(true, Ordering::Relaxed);
                            received_content_reader.store(true, Ordering::Relaxed);
                            touch_activity(&meaningful_activity_reader);
                            progress.emit_now(&encode_tool_patch(&patch));
                            continue;
                        }
                        if event.is_turn_progress() {
                            codex_first_event_seen_reader.store(true, Ordering::Relaxed);
                            touch_activity(&meaningful_activity_reader);
                        }
                        if let Some(patch) = codex_native_tool_patch(
                            &run2, &event, &mut tool_starts, &mut native_tool_sink,
                        ) {
                            received_content_reader.store(true, Ordering::Relaxed);
                            emitted_tool_use_reader.store(true, Ordering::Relaxed);
                            progress.emit_now(&encode_tool_patch(&patch));
                            continue;
                        }
                        match event.kind() {
                            Some("thread/started") => {
                                if let Some(thread_id) = event
                                    .params
                                    .as_ref()
                                    .and_then(|params| params.item.as_ref())
                                    .and_then(|item| item.id.as_deref())
                                {
                                    if let Ok(mut current) = codex_thread_id_reader.lock() {
                                        *current = Some(thread_id.to_string());
                                    }
                                }
                            }
                            Some("turn/started") => {
                                if let Some(turn_id) = event
                                    .params
                                    .as_ref()
                                    .and_then(|params| params.turn.as_ref())
                                    .and_then(|turn| turn.id.as_deref())
                                {
                                    if let Ok(mut current) = codex_turn_id_reader.lock() {
                                        *current = Some(turn_id.to_string());
                                    }
                                }
                            }
                            Some("item/agentMessage/delta") => {
                                if let Some(delta) = event
                                    .params
                                    .as_ref()
                                    .and_then(|params| params.delta.as_deref())
                                    .filter(|delta| !delta.is_empty())
                                {
                                    acc.push_str(delta);
                                    if let Ok(mut current) = codex_streamed_output_reader.lock() {
                                        current.push_str(delta);
                                    }
                                    progress.push(delta);
                                    received_content_reader.store(true, Ordering::Relaxed);
                                    codex_first_event_seen_reader.store(true, Ordering::Relaxed);
                                }
                                continue;
                            }
                            Some("thread/tokenUsage/updated") => {
                                if let Some(usage) = event
                                    .params
                                    .as_ref()
                                    .and_then(|params| params.token_usage.as_ref())
                                    .and_then(|usage| usage.get("last"))
                                {
                                    if let Ok(mut current) = codex_usage_reader.lock() {
                                        *current = Some(usage.clone());
                                    }
                                    emit_usage(&app2, &run2, usage);
                                }
                                continue;
                            }
                            Some("error") | Some("turn.failed") | Some("turn/failed") => {
                                // `codex exec --json` reports transport failures
                                // (429 quota/auth, network) as an `error` event
                                // followed by `turn.failed`; neither carries text
                                // deltas, so without this the process exits 1 with
                                // both stderr and the reply empty and UGS prints an
                                // opaque `退出码 1:` with no detail. Record the
                                // message once (both events carry the same text) so
                                // the failure detail surfaces to the user.
                                let message = event
                                    .error
                                    .as_ref()
                                    .and_then(|error| error.get("message"))
                                    .and_then(|message| message.as_str())
                                    .map(ToString::to_string)
                                    .or_else(|| {
                                        event
                                            .params
                                            .as_ref()
                                            .and_then(|params| params.error.as_ref())
                                            .and_then(|error| error.get("message"))
                                            .and_then(|message| message.as_str())
                                            .map(ToString::to_string)
                                    })
                                    .or_else(|| event.message.clone())
                                    .filter(|message| !message.trim().is_empty());
                                if let Some(message) = message {
                                    if codex_last_error.as_deref() != Some(message.as_str()) {
                                        codex_last_error = Some(message.clone());
                                        acc.push_str(&message);
                                        if let Ok(mut current) = codex_streamed_output_reader.lock()
                                        {
                                            current.push_str(&message);
                                        }
                                        progress.emit_now(&format!("⚠ {message}\n"));
                                    }
                                }
                                if event.kind() != Some("error") {
                                    if let Ok(mut current) = codex_turn_status_reader.lock() {
                                        *current = Some("failed".to_string());
                                    }
                                }
                                continue;
                            }
                            _ => {}
                        }
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
                            codex_first_event_seen_reader.store(true, Ordering::Relaxed);
                            received_content_reader.store(true, Ordering::Relaxed);
                            if matches!(
                                item.item_type.as_deref(),
                                Some("agent_message") | Some("agentMessage")
                            ) {
                                // `item/agentMessage/delta` streams the same text
                                // token by token, so its completed twin must be
                                // skipped — but the exec path emits NO deltas and
                                // delivers each message whole, several per turn
                                // (progress preambles, then the final answer).
                                // Testing "the buffer is non-empty" made the
                                // first message poison every later one, so a long
                                // turn surfaced only its opening line.
                                let message = item.text.as_deref().map(str::trim).unwrap_or("");
                                let already_streamed = message.is_empty()
                                    || codex_streamed_output_reader
                                        .lock()
                                        .ok()
                                        .is_some_and(|current| {
                                            current.trim_end().ends_with(message)
                                        });
                                if already_streamed {
                                    continue;
                                }
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
                                emitted_tool_use_reader.store(true, Ordering::Relaxed);
                                tool_starts.insert(
                                    patch
                                        .get("id")
                                        .and_then(|value| value.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    NativeToolStart {
                                        started_at: std::time::Instant::now(),
                                        name: patch["name"].as_str().unwrap_or("tool").to_string(),
                                        parent_id: item.parent_id.clone(),
                                        args: None,
                                    },
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
                                        received_content_reader.store(true, Ordering::Relaxed);
                                    }
                                }
                            }
                            Some("tool_use") | Some("tool_result") => {
                                if let Some(patch) = gemini_tool_patch(
                                    &run2, &v, &mut tool_starts, &mut native_tool_sink,
                                ) {
                                    received_content_reader.store(true, Ordering::Relaxed);
                                    emitted_tool_use_reader.store(true, Ordering::Relaxed);
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
                                if ev_type == "message_start" {
                                    saw_text_delta_for_message = false;
                                } else if ev_type == "content_block_delta" {
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
                                                    saw_text_delta_for_message = true;
                                                    progress.push(tx);
                                                    partial_text.push_str(tx);
                                                    received_content_reader
                                                        .store(true, Ordering::Relaxed);
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
                                                    received_content_reader
                                                        .store(true, Ordering::Relaxed);
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
                                                received_content_reader
                                                    .store(true, Ordering::Relaxed);
                                                if should_emit_complete_claude_text(
                                                    partial_streaming,
                                                    saw_text_delta_for_message,
                                                ) {
                                                    if prev_kind == "thinking" {
                                                        progress.emit_now("</think>");
                                                    }
                                                    progress.push(tx);
                                                }
                                            }
                                        }
                                        Some("tool_use") => {
                                            received_content_reader.store(true, Ordering::Relaxed);
                                            emitted_tool_use_reader.store(true, Ordering::Relaxed);
                                            let patch = claude_tool_start_patch(
                                                &native_run2, &v, block, &mut tool_starts, &mut native_tool_sink,
                                            );
                                            if prev_kind == "thinking" {
                                                progress.emit_now("</think>");
                                            }
                                            prev_kind = "";
                                            progress.emit_now(&encode_tool_patch(&patch));
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            // Delta presence is scoped to one assistant message.
                            // A later tool-loop response may contain only a complete
                            // assistant event even if an earlier message had deltas.
                            saw_text_delta_for_message = false;
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
                                    if let Some(patch) = claude_tool_result_patch(
                                        &native_run2, &v, block, &mut tool_starts, &mut native_tool_sink,
                                    ) {
                                        if prev_kind == "thinking" {
                                            progress.emit_now("</think>");
                                        }
                                        prev_kind = "";
                                        progress.emit_now(&encode_tool_patch(&patch));
                                    }
                                }
                            }
                        }
                        Some("result") => {
                            if let Some(stdin) = claude_stdin_reader.as_ref() {
                                // Stop accepting lightning messages as soon as
                                // Claude declares this agent loop complete. A
                                // write that won the stdin lock before this
                                // point remains buffered and can finish before
                                // EOF; later writes fail and stay in UI FIFO.
                                close_claude_stream_input(stdin);
                            }
                            if let Some(r) = v.get("result").and_then(|t| t.as_str()) {
                                result = r.to_string();
                            }
                            // A terminal `result` can also declare the turn FAILED
                            // (e.g. upstream overload / rate-limit surfaces as
                            // subtype "error_during_execution" or "error_max_turns",
                            // or is_error:true). The `result` text is then usually
                            // empty, so record the failure and let the wait loop
                            // turn it into a real error instead of a blank bubble.
                            if let Some(detail) = claude_result_failure(&v) {
                                if let Ok(mut slot) = claude_stream_error_reader.lock() {
                                    *slot = Some(detail);
                                }
                            }
                            // Reaching the terminal `result` event at all means the
                            // turn genuinely completed (even a tool-only turn with
                            // no closing text is a real, finished turn).
                            received_content_reader.store(true, Ordering::Relaxed);
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
            if parse_zcode {
                // zcode `--json` prints one structured envelope whose `response`
                // field is the final answer. Parse it once at EOF (the envelope
                // may be pretty-printed across lines) and prefer it over the
                // raw accumulated text; also surface its usage when present.
                if let Some(envelope) = zcode_envelope_from_output(&acc) {
                    if let Some(response) = envelope
                        .get("response")
                        .and_then(|value| value.as_str())
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        result = response.to_string();
                    }
                    if let Some(usage) = envelope.get("usage") {
                        if !usage.is_null() {
                            if let Ok(mut current) = claude_usage_reader.lock() {
                                *current = Some(usage.clone());
                            }
                            emit_usage(&app2, &run2, usage);
                        }
                    }
                }
            }
            if result.trim().is_empty() {
                if acc.trim().is_empty() {
                    // The terminal `result` / complete `assistant` events never
                    // arrived, but token-level deltas were streamed: fall back to
                    // the text the user already saw rendered, so a clean exit 0
                    // after a dropped terminal event isn't reported as failure.
                    partial_text
                } else {
                    acc
                }
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
        let deadline = (timeout_secs > 0)
            .then(|| std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs));
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
        // EOF can slightly precede a one-shot CLI's process exit. Allow that
        // short race, but never leave a persistent server alive without its
        // only completion-event consumer until the (possibly disabled) idle
        // deadline. Check terminal events above this guard on every poll.
        let stdout_exit_grace = std::time::Duration::from_millis(500);
        let mut stdout_exited_at: Option<std::time::Instant> = None;
        let wait_result = loop {
            let watchdog_activity = if is_codex {
                &last_meaningful_activity
            } else {
                &last_activity
            };
            if is_codex {
                if let Some(error) = codex_startup_error
                    .lock()
                    .ok()
                    .and_then(|current| current.clone())
                {
                    skills::native_launch::cancel_native_cli(&run_id);
                    terminate_ai_cli_tree(&mut child, &run_id);
                    break Err(error);
                }
                if !codex_first_event_seen.load(Ordering::Relaxed) {
                    let first_event_timed_out = codex_turn_started_at
                        .lock()
                        .ok()
                        .and_then(|started_at| *started_at)
                        .is_some_and(|started_at| {
                            started_at.elapsed()
                                >= std::time::Duration::from_secs(
                                    codex_first_event_timeout_secs(),
                                )
                        });
                    if first_event_timed_out {
                        skills::native_launch::cancel_native_cli(&run_id);
                        terminate_ai_cli_tree(&mut child, &run_id);
                        break Err(format!(
                            "Codex turn 已启动，但 {}s 内未收到模型或工具事件，已终止。",
                            codex_first_event_timeout_secs()
                        ));
                    }
                }
                let status = codex_turn_status
                    .lock()
                    .ok()
                    .and_then(|current| current.clone());
                if let Some(status) = status {
                    terminate_ai_cli_tree(&mut child, &run_id);
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
                    terminate_ai_cli_tree(&mut child, &run_id);
                    break Ok(WaitOutcome::CodexLastMessageReady);
                }
            }
            if zcode_app_server {
                // The writer thread records a `session/create`/`session/resume`/
                // subscribe/send handshake failure here; surface it instead of
                // letting the (never-exiting) server linger until the timeout.
                if let Some(error) = zcode_startup_error
                    .lock()
                    .ok()
                    .and_then(|current| current.clone())
                {
                    skills::native_launch::cancel_native_cli(&run_id);
                    terminate_ai_cli_tree(&mut child, &run_id);
                    break Err(error);
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    // The CLI's main process exited on its own. On Windows its
                    // tool-spawned descendants (bash → grep/find/rg scanning UE
                    // trees) are NOT auto-reaped when the parent dies — they
                    // become orphans and keep burning CPU. Kill the whole tree
                    // so a finished turn never leaves stray search processes
                    // behind. This is a no-op if the tree is already gone.
                    if !status.success()
                        || claude_stream_error.lock().ok().is_some_and(|slot| slot.is_some())
                        || stdout_read_error.lock().ok().is_some_and(|slot| slot.is_some())
                    {
                        skills::native_launch::cancel_native_cli(&run_id);
                    }
                    #[cfg(test)]
                    skills::native_launch::test_checkpoint(&run_id, "before-exit-kill");
                    terminate_ai_cli_tree(&mut child, &run_id);
                    break Ok(WaitOutcome::Exited(status));
                }
                Ok(None) => {
                    if out_handle.is_finished()
                        && !stream_result_seen.load(Ordering::Relaxed)
                    {
                        let since = stdout_exited_at
                            .get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() >= stdout_exit_grace {
                            let error = format!(
                                "CLI \"{binary}\" stdout 读取线程已退出，未收到完成事件，已终止。"
                            );
                            // Handshake writers poll these slots; wake them as
                            // well so their join cannot add a startup timeout.
                            set_codex_startup_error(&codex_startup_error, error.clone());
                            set_codex_startup_error(&zcode_startup_error, error.clone());
                            skills::native_launch::cancel_native_cli(&run_id);
                            #[cfg(test)]
                            skills::native_launch::test_checkpoint(&run_id, "before-error-kill");
                            terminate_ai_cli_tree(&mut child, &run_id);
                            break Err(error);
                        }
                    }
                    // Stream-json (claude/gemini) signalled its terminal result.
                    // Allow a short grace for a clean self-exit, then break early
                    // so a lingering child process can't stall the finished turn.
                    if !is_codex && stream_result_seen.load(Ordering::Relaxed) {
                        let since = stream_complete_at
                            .get_or_insert_with(std::time::Instant::now);
                        if since.elapsed() >= stream_complete_grace {
                            if claude_stream_error.lock().ok().is_some_and(|slot| slot.is_some())
                                || stdout_read_error.lock().ok().is_some_and(|slot| slot.is_some())
                            {
                                skills::native_launch::cancel_native_cli(&run_id);
                            }
                            #[cfg(test)]
                            skills::native_launch::test_checkpoint(&run_id, "before-stream-kill");
                            terminate_ai_cli_tree(&mut child, &run_id);
                            break Ok(WaitOutcome::StreamCompleted);
                        }
                    }
                    if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                        skills::native_launch::cancel_native_cli(&run_id);
                        terminate_ai_cli_tree(&mut child, &run_id);
                        break Err(format!("CLI \"{binary}\" 超时（{timeout_secs}s）已终止。"));
                    }
                    if let Some(idle) = idle_timeout {
                        if activity_elapsed(watchdog_activity) >= idle {
                            skills::native_launch::cancel_native_cli(&run_id);
                            terminate_ai_cli_tree(&mut child, &run_id);
                            break Err(format!(
                                "CLI \"{binary}\" 空转超过 {idle_timeout_secs}s 未产生输出，已终止。"
                            ));
                        }
                    }
                    // Heartbeat is based on visible progress, not raw stdout/stderr.
                    // Compatible CLIs may emit frequent protocol events UGS does not
                    // render; those events must not keep the UI blank indefinitely.
                    let beat = std::time::Duration::from_secs(AI_CLI_HEARTBEAT_SECS);
                    let now = std::time::Instant::now();
                    if should_emit_ai_cli_heartbeat(
                        visible_progress_elapsed(&run_id),
                        now.duration_since(last_heartbeat),
                        beat,
                    ) {
                        let total = run_started_at.elapsed().as_secs();
                        let thread_started = codex_thread_id
                            .lock()
                            .ok()
                            .is_some_and(|thread_id| thread_id.is_some());
                        let turn_started = codex_turn_id
                            .lock()
                            .ok()
                            .is_some_and(|turn_id| turn_id.is_some());
                        let stage = ai_cli_running_stage(
                            is_codex,
                            thread_started,
                            turn_started,
                            codex_first_event_seen.load(Ordering::Relaxed),
                        );
                        emit_progress(
                            &app,
                            &run_id,
                            &encode_running_status_patch(&run_id, total, stage),
                        );
                        last_heartbeat = now;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    skills::native_launch::cancel_native_cli(&run_id);
                    terminate_ai_cli_tree(&mut child, &run_id);
                    break Err(format!("等待 CLI \"{binary}\" 失败: {e}"));
                }
            }
        };

        let _ = stdin_handle.join();
        #[cfg(test)]
        skills::native_launch::test_checkpoint(&run_id, "before-worker-drain");
        // Every transport drains its authentic parser and stderr before returning.
        // Codex terminal status/sidecar readiness are outcomes, not a reader teardown shortcut.
        let streamed_output = out_handle.join().unwrap_or_default();
        // A pipe read error may race a clean process exit. Received tool/text
        // content is not terminal evidence; do not turn the read failure into
        // a successful turn just because the launcher exited with code zero.
        let wait_result = if wait_result.is_ok() && !stream_result_seen.load(Ordering::Relaxed) {
            match stdout_read_error.lock().ok().and_then(|slot| slot.clone()) {
                Some(error) => Err(format!("CLI \"{binary}\" {error}，未收到完成事件。")),
                None => wait_result,
            }
        } else {
            wait_result
        };
        // Stop the dsh session-log tracer and drain its last batch so the final
        // progress (closing tool cards, trailing answer text) reaches the UI.
        if let Some(tracer) = dsh_tracer_handle {
            dsh_tracer_cancel.store(true, Ordering::Relaxed);
            let _ = tracer.join();
        }
        // Stop the kimi wire.jsonl tracer and drain its last batch.
        if let Some(tracer) = kimi_tracer_handle {
            kimi_tracer_cancel.store(true, Ordering::Relaxed);
            let _ = tracer.join();
        }
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

        // A failed terminal event stays failed even when it contains useful
        // partial text or the process later exits zero. Text is not a success
        // signal and must not mask the provider's authoritative result.
        if wait_result.is_ok() {
            if let Some(detail) = claude_stream_error.lock().ok().and_then(|slot| slot.clone()) {
                return Err(append_cli_error_context(
                    format!("CLI \"{binary}\" 本轮执行出错：{detail}"),
                    &output,
                    &stderr,
                ));
            }
        }

        match wait_result {
            Err(err) => Err(append_cli_error_context(err, &output, &stderr)),
            Ok(WaitOutcome::Exited(status))
                if status.success() && received_content.load(Ordering::Relaxed) =>
            {
                // The stream declared a failed turn (overload / rate-limit /
                // max-turns) and left no usable text — surface the real cause
                // instead of returning empty and rendering a blank bubble.
                if output.trim().is_empty() {
                    if let Some(detail) =
                        claude_stream_error.lock().ok().and_then(|slot| slot.clone())
                    {
                        return Err(append_cli_error_context(
                            format!("CLI \"{binary}\" 本轮执行出错：{detail}"),
                            &output,
                            &stderr,
                        ));
                    }
                    // Placeholders ("session started" / "requesting") never set
                    // received_content — only real model events (text/thinking
                    // deltas, assistant messages, tool_use, the terminal result)
                    // do. Streamed text is already captured by the partial_text
                    // fallback above, so reaching here with received_content=true
                    // and empty output means the terminal `result` arrived with no
                    // text and nothing else real streamed (no deltas, no tool
                    // calls) — a genuine silent failure, not a successful empty
                    // turn.
                    if !emitted_tool_use.load(Ordering::Relaxed) {
                        let detail = if stderr.trim().is_empty() {
                            "CLI 退出但未返回任何内容".to_string()
                        } else {
                            stderr.trim().to_string()
                        };
                        return Err(append_cli_error_context(
                            format!("CLI \"{binary}\" 未产生任何回复就退出（退出码 0）：{detail}"),
                            &output,
                            &stderr,
                        ));
                    }
                }
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
            Ok(WaitOutcome::Exited(status)) if status.success() => {
                // Exit code 0 but the CLI never produced any real model output
                // (no assistant text/thinking, no tool call, no terminal
                // `result` event) — e.g. a dropped connection, an auth hiccup,
                // or the process being killed mid-turn while still reporting a
                // clean exit. Reporting this as success would silently strand
                // the chat bubble on the "会话已启动…/正在请求模型…" placeholder
                // while the UI marks the turn complete, so surface it as a
                // real error instead.
                let detail = if stderr.trim().is_empty() {
                    if output.trim().is_empty() {
                        "CLI 退出但未返回任何内容".to_string()
                    } else {
                        output.trim().to_string()
                    }
                } else {
                    stderr.trim().to_string()
                };
                Err(format!(
                    "CLI \"{binary}\" 未产生任何回复就退出（退出码 0）：{detail}"
                ))
            }
            Ok(WaitOutcome::Exited(status)) => {
                let code = status.code().unwrap_or(-1);
                let detail = if stderr.trim().is_empty() {
                    output.trim()
                } else {
                    stderr.trim()
                };
                if is_kimi {
                    if let Some(hint) = kimi_failure_hint(detail) {
                        return Err(format!("CLI \"{binary}\" 退出码 {code}: {detail}\n\n{hint}"));
                    }
                }
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
                // was force-terminated. If that terminal event declared a failed
                // turn with no usable text, surface the real cause.
                if output.trim().is_empty() {
                    if let Some(detail) =
                        claude_stream_error.lock().ok().and_then(|slot| slot.clone())
                    {
                        return Err(append_cli_error_context(
                            format!("CLI \"{binary}\" 本轮执行出错：{detail}"),
                            &output,
                            &stderr,
                        ));
                    }
                    // A terminal result event with no text and no tool calls is not
                    // a successful turn; it usually means the upstream returned an
                    // empty or blocked response. Surface it as a real error.
                    if !emitted_tool_use.load(Ordering::Relaxed) {
                        let detail = if stderr.trim().is_empty() {
                            "CLI 退出但未返回任何内容".to_string()
                        } else {
                            stderr.trim().to_string()
                        };
                        return Err(append_cli_error_context(
                            format!("CLI \"{binary}\" 未产生任何回复就退出（退出码 0）：{detail}"),
                            &output,
                            &stderr,
                        ));
                    }
                }
                // Prefer the claude usage snapshot.
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
    #[test]
    fn context_compression_only_marks_native_completion() {
        for event in [
            serde_json::json!({"type": "system", "subtype": "compact_boundary"}),
            serde_json::json!({"method": "thread/compacted", "params": {"threadId": "t"}}),
            serde_json::json!({"type": "item.completed", "item": {"type": "context_compaction"}}),
            serde_json::json!({"method": "item/completed", "params": {"item": {"type": "contextCompaction"}}}),
        ] {
            let patch = super::context_compression_patch(&event).unwrap();
            assert_eq!(patch["name"], "ugs_context_compaction");
            assert_eq!(patch["ephemeral"], true);
        }
        for event in [
            serde_json::json!({"type": "system", "subtype": "status", "status": "compacting"}),
            serde_json::json!({"type": "item.started", "item": {"type": "context_compaction"}}),
            serde_json::json!({"type": "assistant", "text": "compact_boundary"}),
        ] {
            assert!(super::context_compression_patch(&event).is_none());
        }
    }
    use super::*;

    #[test]
    fn skills_owned_slash_scans_both_roots_and_refreshes_same_id_details() {
        let f = skills::test_support::Fixture::new("owned-slash");
        f.write("global/skills/global-rule/SKILL.md", &skills::test_support::skill("global-rule", "Keep global rules."));
        f.write("project/.ultragamestudio/skills/project-rule/SKILL.md", &skills::test_support::skill("project-rule", "Keep project rules."));
        f.write("global/skills/.state/transactions/hidden/SKILL.md", &skills::test_support::skill("hidden", "Ignore state."));
        let mut entries=vec![]; let mut seen=HashSet::new();
        append_owned_slash_entries(&f.global(),Some(&f.project()),&mut entries,&mut seen).unwrap();
        assert_eq!(entries.len(),2);
        assert_eq!(entries[0].name,"/project-rule"); assert_eq!(entries[1].name,"/global-rule");
        let id=entries[0].id.clone();
        f.write("project/.ultragamestudio/skills/project-rule/SKILL.md","---\nname: project-rule\ndescription: Use when updating project rules.\n---\n\nKeep original requirements.\n");
        entries.clear();seen.clear();
        append_owned_slash_entries(&f.global(),Some(&f.project()),&mut entries,&mut seen).unwrap();
        assert_eq!(entries[0].id,id); assert_eq!(entries[0].detail["en-US"],"Use when updating project rules.");
    }

    /// 1x1 透明 PNG。位图预览测试只需要一个真能被 `image` 解码的样本。
    const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
        0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
        0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
        0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn preview_fixture_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ugs-preview-{label}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_test_zip(path: &std::path::Path, entries: &[(&str, &str)]) {
        use std::io::Write;
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    /// 位图必须走 asset protocol：整张 12 MB 截图 base64 之后要在 IPC 上传约
    /// 16 MB 字符串，前端还得先 base64 解码才能开始解码图片。
    #[test]
    fn bitmap_preview_streams_instead_of_inlining_base64() {
        let dir = preview_fixture_dir("bitmap-stream");
        let file = dir.join("shot.png");
        std::fs::write(&file, TINY_PNG).unwrap();

        let preview =
            preview_local_file_blocking(file.to_string_lossy().to_string(), None).unwrap();

        assert_eq!(preview.kind, "image");
        assert!(preview.base64.is_none(), "位图不应再走 base64 IPC");
        let stream = preview.stream_path.expect("位图必须给出流式路径");
        assert!(
            !stream.starts_with(r"\\?\"),
            "asset protocol 匹配不到 canonical 前缀：{stream}"
        );
        assert!(stream.ends_with("shot.png"), "实际: {stream}");
    }

    #[test]
    fn video_preview_exposes_stream_for_asset_scope() {
        let dir = preview_fixture_dir("video-stream");
        for ext in ["mp4", "webm", "mov", "avi", "mkv"] {
            let file = dir.join(format!("视频 预览.{ext}"));
            let fixture = std::fs::File::create(&file).unwrap();
            fixture.set_len(617_659_737).unwrap();
            drop(fixture);
            let preview = preview_local_file_blocking(file.to_string_lossy().to_string(), None).unwrap();
            assert_eq!(preview.kind, "video");
            assert_eq!(preview.size_bytes, 617_659_737);
            assert!(preview.base64.is_none());
            assert!(!preview.truncated);
            let stream = preview.stream_path.expect("视频必须提供流式路径，否则会跳过 asset scope 授权");
            assert_eq!(stream, preview.path);
            assert!(!stream.starts_with(r"\\?\"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// SVG 是标记文本、体积可控，保留内联路径即可，不必多开一次 asset 请求。
    #[test]
    fn svg_preview_stays_inline() {
        let dir = preview_fixture_dir("svg-inline");
        let file = dir.join("icon.svg");
        std::fs::write(&file, "<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap();

        let preview =
            preview_local_file_blocking(file.to_string_lossy().to_string(), None).unwrap();

        assert_eq!(preview.kind, "image");
        assert!(preview.base64.is_some(), "矢量图应保持内联");
        assert!(preview.stream_path.is_none());
    }

    /// PPTX/XLSX 走 office 分支并报出页数，避免前端把整包 base64 进内存。
    #[test]
    fn office_preview_reports_slide_and_sheet_counts() {
        let dir = preview_fixture_dir("office-count");
        let pptx = dir.join("deck.pptx");
        write_test_zip(
            &pptx,
            &[
                ("ppt/slides/slide1.xml", "<a:t>一</a:t>"),
                ("ppt/slides/slide2.xml", "<a:t>二</a:t>"),
            ],
        );
        let xlsx = dir.join("book.xlsx");
        write_test_zip(&xlsx, &[("xl/worksheets/sheet1.xml", "<worksheet/>")]);

        let slides =
            preview_local_file_blocking(pptx.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(slides.kind, "office");
        assert_eq!(slides.page_count, Some(2));
        assert!(slides.base64.is_none(), "Office 文档不应走 base64 IPC");
        assert!(slides.stream_path.is_some());

        let sheets =
            preview_local_file_blocking(xlsx.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(sheets.kind, "office");
        assert_eq!(sheets.page_count, Some(1));
    }

    /// 「先读前面几页」：请求 2 页时第 3 页的内容根本不该被解析。
    #[test]
    fn office_paging_reads_only_the_requested_slides() {
        let dir = preview_fixture_dir("office-paging");
        let pptx = dir.join("deck.pptx");
        write_test_zip(
            &pptx,
            &[
                ("ppt/slides/slide1.xml", "<a:t>第一页</a:t>"),
                ("ppt/slides/slide2.xml", "<a:t>第二页</a:t>"),
                ("ppt/slides/slide3.xml", "<a:t>第三页</a:t>"),
            ],
        );

        let preview =
            preview_office_document_blocking(pptx.to_string_lossy().to_string(), None, Some(2))
                .unwrap();

        assert_eq!(preview.kind, "pptx");
        assert_eq!(preview.page_count, 3);
        assert_eq!(preview.pages.len(), 2, "只应解析请求的前两页");
        assert!(preview.truncated, "被截断时要能提示用户");
        assert!(preview.pages[0].html.contains("第一页"));
        assert!(preview.pages[1].html.contains("第二页"));
        assert!(!preview.pages.iter().any(|page| page.html.contains("第三页")));
    }

    /// XLSX 的文本多数存在 sharedStrings 里，单元格只放索引；直接读 `<v>` 会
    /// 把表格渲染成一列数字。
    #[test]
    fn xlsx_preview_resolves_shared_strings() {
        let dir = preview_fixture_dir("xlsx-shared");
        let xlsx = dir.join("book.xlsx");
        write_test_zip(
            &xlsx,
            &[
                (
                    "xl/sharedStrings.xml",
                    "<sst><si><t>名称</t></si><si><t>数量</t></si></sst>",
                ),
                (
                    "xl/worksheets/sheet1.xml",
                    "<worksheet><sheetData>\
                     <row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>\
                     <row r=\"2\"><c r=\"A2\"><v>42</v></c></row>\
                     </sheetData></worksheet>",
                ),
            ],
        );

        let preview =
            preview_office_document_blocking(xlsx.to_string_lossy().to_string(), None, None)
                .unwrap();

        assert_eq!(preview.kind, "xlsx");
        let html = &preview.pages[0].html;
        assert!(html.contains("名称"), "共享字符串应解析出文本: {html}");
        assert!(html.contains("数量"), "共享字符串应解析出文本: {html}");
        assert!(html.contains("42"), "数值单元格应保留: {html}");
    }

    /// 找 `<t>` 不能把 `<table>` 这类同前缀标签算进去，否则表格结构会被当成
    /// 文本重复输出。
    #[test]
    fn ooxml_tag_scan_ignores_longer_tag_names() {
        let xml = "<body><table><tr><t>正文</t></tr></table><t>结尾</t></body>";
        let runs = collect_element_inner(xml, "t");
        assert_eq!(runs, vec!["正文", "结尾"]);
    }

    #[test]
    fn ooxml_text_entities_are_decoded() {
        assert_eq!(
            unescape_ooxml_text("A&amp;B &lt;C&gt; &quot;D&quot;"),
            "A&B <C> \"D\""
        );
        assert_eq!(escape_html_text("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
    }

    /// 缩略图必须真的缩小：聊天气泡里几十张 4K 截图不能各自全尺寸解码。
    #[test]
    fn thumbnail_decodes_at_most_max_edge() {
        let dir = preview_fixture_dir("thumb");
        let file = dir.join("shot.png");
        std::fs::write(&file, TINY_PNG).unwrap();

        let thumb = read_image_thumbnail_blocking(
            file.to_string_lossy().to_string(),
            None,
            Some(64),
        )
        .unwrap();

        assert!(thumb.width <= 64 && thumb.height <= 64);
        assert_eq!(thumb.mime, "image/jpeg");
        assert!(!thumb.base64.is_empty());
    }

    /// 「会话文件」面板必须能看到 AI 按工作区约定写进 `.ultragamestudio/docs/`
    /// 的交付物，否则用户拿不到本轮生成的报告；jobs 这类内部状态仍要排除。
    #[test]
    fn workspace_change_scan_includes_ultragamestudio_deliverables() {
        let root = std::env::temp_dir().join(format!(
            "ugs-change-scan-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let reading = root.join(".ultragamestudio").join("docs").join("reading");
        let jobs = root.join(".ultragamestudio").join("jobs");
        std::fs::create_dir_all(&reading).unwrap();
        std::fs::create_dir_all(&jobs).unwrap();
        std::fs::write(reading.join("调研.html"), "<html></html>").unwrap();
        std::fs::write(jobs.join("state.json"), "{}").unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {}").unwrap();

        let (files, _) = scan_workspace_snapshot(&root);
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();

        assert!(
            paths.contains(&".ultragamestudio/docs/reading/调研.html"),
            "交付物必须进入会话变更快照，实际: {paths:?}"
        );
        assert!(
            !paths
                .iter()
                .any(|path| path.starts_with(".ultragamestudio/jobs/")),
            "内部状态目录不应出现在会话变更里，实际: {paths:?}"
        );
        assert!(paths.contains(&"main.rs"), "普通工作区文件仍要扫描");

        let _ = std::fs::remove_dir_all(&root);
    }

    fn command_arg_strings(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn extract_semver_handles_each_vendor_format() {
        // claude
        assert_eq!(
            extract_semver("2.1.197 (Claude Code)"),
            Some("2.1.197".to_string())
        );
        // codex
        assert_eq!(
            extract_semver("codex-cli 0.142.5"),
            Some("0.142.5".to_string())
        );
        // gemini (bare)
        assert_eq!(extract_semver("0.38.2\n"), Some("0.38.2".to_string()));
        assert_eq!(extract_semver("no version here"), None);
        // prerelease / build suffixes must stay attached
        assert_eq!(
            extract_semver("0.1.0-rc.6 (Claude Code)"),
            Some("0.1.0-rc.6".to_string())
        );
        assert_eq!(extract_semver("3.7.7-13\n"), Some("3.7.7-13".to_string()));
    }

    #[test]
    fn version_needs_update_detects_any_difference() {
        assert!(version_needs_update("0.1.0", "0.1.0-rc.6"));
        assert!(version_needs_update("3.7.7", "3.7.7-13"));
        assert!(version_needs_update("2.1.197", "2.1.202"));
        assert!(version_needs_update("0.38.2", "0.49.0"));
        assert!(!version_needs_update("0.142.5", "0.142.5"));
        assert!(!version_needs_update("v1.2.0", "1.2.0"));
        assert!(!version_needs_update("  1.2.0  ", "1.2.0"));
        assert!(!version_needs_update("0.1.0-rc.6", "0.1.0-rc.6"));
    }

    #[test]
    fn cli_version_probe_command_passes_version_arg() {
        let cmd = cli_version_probe_command("claude");
        assert!(command_arg_strings(&cmd)
            .iter()
            .any(|arg| arg == "--version"));
    }

    #[test]
    fn cli_version_probe_command_wraps_raw_js_entry_with_node() {
        // Stale-shim fallback: the scan can hand us the package JS entry
        // directly (`@deepseek-ai/dsh/lib/bin.js`) when npm lost the `.cmd`
        // shim. It must be launched through `node`, never spawned as-is.
        let entry =
            r"C:\Users\me\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js";
        let cmd = cli_version_probe_command(entry);
        assert_eq!(cmd.get_program().to_string_lossy(), "node");
        assert_eq!(command_arg_strings(&cmd), vec![entry, "--version"]);
    }

    #[cfg(windows)]
    #[test]
    fn cli_version_probe_command_wraps_windows_cmd_shims() {
        let shim = r"C:\Users\me\AppData\Roaming\npm\claude.cmd";
        let cmd = cli_version_probe_command(shim);
        let program = cmd.get_program().to_string_lossy().to_ascii_lowercase();
        assert!(program == "cmd" || program.ends_with("cmd.exe"));
        assert_eq!(command_arg_strings(&cmd), vec!["/C", shim, "--version"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn cli_version_probe_command_uses_direct_program_on_unix_like_platforms() {
        let path = "/opt/ugs/bin/claude";
        let cmd = cli_version_probe_command(path);
        assert_eq!(cmd.get_program().to_string_lossy(), path);
        assert_eq!(command_arg_strings(&cmd), vec!["--version"]);
    }

    #[test]
    fn cli_update_command_builds_expected_args() {
        let codex = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "codex")
            .unwrap();
        let codex_cmd = cli_update_command(codex, Some("codex")).unwrap();
        assert!(command_arg_strings(&codex_cmd).ends_with(&["update".to_string()]));

        let gemini = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "gemini")
            .unwrap();
        let gemini_cmd = cli_update_command(gemini, Some("gemini")).unwrap();
        assert!(command_arg_strings(&gemini_cmd).ends_with(&[
            "install".to_string(),
            "-g".to_string(),
            "@google/gemini-cli@latest".to_string(),
        ]));
    }

    #[test]
    fn cli_update_command_installs_dsh_when_missing() {
        // A missing npm-provisionable CLI (dsh) must install via the package
        // manager instead of erroring -- this is the "one-click install" path.
        let dsh = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "deepseek-harness")
            .unwrap();
        let dsh_cmd = cli_update_command(dsh, None).unwrap();
        assert!(command_arg_strings(&dsh_cmd).ends_with(&[
            "install".to_string(),
            "-g".to_string(),
            "@deepseek-ai/dsh@latest".to_string(),
        ]));
    }

    #[test]
    fn cli_update_command_installs_kimi_when_missing() {
        // kimi is npm-provisionable too; it must route to `npm install -g
        // @moonshot-ai/kimi-code@latest` rather than the "unknown CLI" fallback.
        let kimi = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "kimi")
            .unwrap();
        let kimi_cmd = cli_update_command(kimi, None).unwrap();
        assert!(command_arg_strings(&kimi_cmd).ends_with(&[
            "install".to_string(),
            "-g".to_string(),
            "@moonshot-ai/kimi-code@latest".to_string(),
        ]));
    }

    #[test]
    fn cli_update_command_installs_grok_when_missing() {
        // grok is npm-provisionable via `@xai-official/grok`; a missing CLI must
        // route to `npm install -g @xai-official/grok@latest`.
        let grok = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "grok")
            .unwrap();
        let grok_cmd = cli_update_command(grok, None).unwrap();
        assert!(command_arg_strings(&grok_cmd).ends_with(&[
            "install".to_string(),
            "-g".to_string(),
            "@xai-official/grok@latest".to_string(),
        ]));
    }

    #[test]
    fn cli_update_command_rejects_missing_native_installer_cli() {
        // claude/codex have no npm one-click provision path; a missing CLI must
        // still be reported as an error rather than silently installing.
        let codex = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "codex")
            .unwrap();
        assert!(cli_update_command(codex, None).is_err());
    }

    #[test]
    fn codex_update_rejects_desktop_app_managed_binary() {
        // The desktop app's private runtime can never be updated from the
        // command line; say so instead of returning a command that silently
        // rewrites a different install tree.
        let codex = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "codex")
            .unwrap();
        let exe = r"C:\Users\me\AppData\Local\OpenAI\Codex\bin\f1c7ee7a13db5fed\codex.exe";
        assert!(is_codex_desktop_app_path(exe));
        let err = cli_update_command(codex, Some(exe)).unwrap_err();
        assert!(err.contains("桌面应用"), "错误信息应引导用户去桌面应用：{err}");
    }

    #[cfg(windows)]
    #[test]
    fn codex_update_uses_bun_for_bun_global_shim() {
        let codex = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "codex")
            .unwrap();
        let shim = r"C:\Users\me\.bun\bin\codex.exe";
        let cmd = cli_update_command(codex, Some(shim)).unwrap();
        assert_eq!(
            cmd.get_program().to_string_lossy(),
            r"C:\Users\me\.bun\bin\bun.exe"
        );
        assert_eq!(
            command_arg_strings(&cmd),
            vec!["install", "-g", "@openai/codex@latest"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn codex_update_uses_npm_for_npm_global_shim() {
        let codex = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "codex")
            .unwrap();
        let shim = r"C:\Users\me\AppData\Roaming\npm\codex.cmd";
        assert!(is_npm_global_shim_path(shim));
        let cmd = cli_update_command(codex, Some(shim)).unwrap();
        assert_eq!(
            command_arg_strings(&cmd),
            vec![
                "/C",
                "npm.cmd",
                "install",
                "-g",
                "@openai/codex@latest"
            ]
        );
    }

    #[test]
    fn codex_update_falls_back_to_self_update_for_unknown_source() {
        // A bare command name (vendor installer / custom path) keeps the
        // historical `codex update` delegation.
        let codex = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "codex")
            .unwrap();
        assert!(!is_codex_desktop_app_path("codex"));
        assert!(!is_npm_global_shim_path("codex"));
        let cmd = cli_update_command(codex, Some("codex")).unwrap();
        assert!(command_arg_strings(&cmd).ends_with(&["update".to_string()]));
    }

    #[test]
    fn summarize_command_failure_prefers_stderr_tail_and_exit_code() {
        let outcome = CommandOutcome {
            success: false,
            exit_code: Some(1),
            text: "out\n".to_string(),
            stderr: "line1\nline2\nline3\nline4\n\n".to_string(),
        };
        let summary = summarize_command_failure(&outcome);
        assert!(summary.contains("line2 | line3 | line4"), "{summary}");
        assert!(!summary.contains("line1"), "只保留末尾几行：{summary}");
        assert!(summary.contains("退出码 1"), "{summary}");
    }

    #[test]
    fn summarize_command_failure_falls_back_to_stdout_then_exit_code() {
        let stdout_only = CommandOutcome {
            success: false,
            exit_code: Some(2),
            text: "EACCES: permission denied\n".to_string(),
            stderr: String::new(),
        };
        assert!(summarize_command_failure(&stdout_only).contains("EACCES"));

        let silent = CommandOutcome {
            success: false,
            exit_code: None,
            text: "\n".to_string(),
            stderr: String::new(),
        };
        assert_eq!(
            summarize_command_failure(&silent),
            "进程异常退出，且无错误输出"
        );
    }

    #[cfg(windows)]
    #[test]
    fn command_outcome_reports_nonzero_exit_code() {
        // The regression that made "更新一直失败" look like success: the old
        // helper only checked that the process exited in time. Skipped when the
        // managed temp dir is not writable (e.g. a sandboxed runner), since the
        // helper needs it for the stdout/stderr side channels.
        let probe = temp_output_path("ultragamestudio-test-probe", "txt");
        if std::fs::File::create(&probe).is_err() {
            eprintln!("跳过：托管临时目录不可写 {}", probe.display());
            return;
        }
        let _ = std::fs::remove_file(&probe);

        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("exit 3");
        let outcome =
            command_outcome_with_timeout(cmd, std::time::Duration::from_secs(30)).unwrap();
        assert!(!outcome.success);
        assert_eq!(outcome.exit_code, Some(3));
    }

    #[cfg(windows)]
    #[test]
    fn cli_update_command_wraps_windows_npm_cmd() {
        let gemini = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "gemini")
            .unwrap();
        let cmd = cli_update_command(gemini, Some("gemini")).unwrap();
        let program = cmd.get_program().to_string_lossy().to_ascii_lowercase();
        assert!(program == "cmd" || program.ends_with("cmd.exe"));
        assert_eq!(
            command_arg_strings(&cmd),
            vec![
                "/C",
                "npm.cmd",
                "install",
                "-g",
                "@google/gemini-cli@latest"
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn cli_update_command_uses_bun_for_windows_bun_gemini_shim() {
        let gemini = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "gemini")
            .unwrap();
        let shim = r"C:\Users\me\.bun\bin\gemini.exe";
        let cmd = cli_update_command(gemini, Some(shim)).unwrap();
        assert_eq!(
            cmd.get_program().to_string_lossy(),
            r"C:\Users\me\.bun\bin\bun.exe"
        );
        assert_eq!(
            command_arg_strings(&cmd),
            vec!["install", "-g", "@google/gemini-cli@latest"]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn cli_update_command_uses_direct_npm_on_unix_like_platforms() {
        let gemini = CLI_UPDATE_SPECS
            .iter()
            .find(|spec| spec.adapter == "gemini")
            .unwrap();
        let cmd = cli_update_command(gemini, Some("gemini")).unwrap();
        let args = command_arg_strings(&cmd);
        assert!(!args.iter().any(|arg| arg == "/C"));
        assert_eq!(args, vec!["install", "-g", "@google/gemini-cli@latest"]);
    }

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
    fn preview_video_mime_supports_common_formats() {
        assert_eq!(
            video_mime_for_path(std::path::Path::new("clip.mp4")),
            Some("video/mp4")
        );
        assert_eq!(
            video_mime_for_path(std::path::Path::new("clip.webm")),
            Some("video/webm")
        );
        assert_eq!(
            video_mime_for_path(std::path::Path::new("clip.mov")),
            Some("video/quicktime")
        );
        assert_eq!(
            video_mime_for_path(std::path::Path::new("clip.avi")),
            Some("video/x-msvideo")
        );
        assert_eq!(
            video_mime_for_path(std::path::Path::new("clip.mkv")),
            Some("video/x-matroska")
        );
        assert_eq!(
            video_mime_for_path(std::path::Path::new("readme.txt")),
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
    fn parses_zcode_envelope_from_output() {
        // Single-line envelope.
        let single = r#"{"sessionId":"sess_abc","turnId":"turn_1","response":"你好，我是 GLM。","usage":{"input_tokens":10,"output_tokens":5}}"#;
        let envelope = zcode_envelope_from_output(single).unwrap();
        assert_eq!(envelope["response"].as_str(), Some("你好，我是 GLM。"));

        // Pretty-printed envelope across multiple lines.
        let pretty = "{\n  \"sessionId\": \"sess_abc\",\n  \"response\": \"done\"\n}\n";
        let envelope = zcode_envelope_from_output(pretty).unwrap();
        assert_eq!(envelope["response"].as_str(), Some("done"));

        // Stray diagnostic line before the envelope must not hide it.
        let with_log =
            "15:32:01 [info] session started\n{\"sessionId\":\"s\",\"response\":\"ok\"}\n";
        let envelope = zcode_envelope_from_output(with_log).unwrap();
        assert_eq!(envelope["response"].as_str(), Some("ok"));

        // No JSON at all -> None (caller falls back to raw text).
        assert!(zcode_envelope_from_output("just some text").is_none());
        assert!(zcode_envelope_from_output("").is_none());
        assert!(zcode_envelope_from_output("   ").is_none());
    }

    #[test]
    fn zcode_config_created_from_env_when_missing() {
        let dir =
            std::env::temp_dir().join(format!("ugs-zcode-config-created-{}", std::process::id()));
        let config_path = dir.join(".zcode").join("cli").join("config.json");
        let _ = std::fs::remove_dir_all(&dir);

        let env = HashMap::from([
            ("ZCODE_API_KEY".to_string(), "sk-test-123".to_string()),
            ("ZCODE_MODEL".to_string(), "glm-5.3".to_string()),
        ]);
        ensure_zcode_config_at(&config_path, Some(&env)).unwrap();

        let raw = std::fs::read_to_string(&config_path).unwrap();
        let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            config["provider"]["zai"]["options"]["apiKey"],
            "sk-test-123"
        );
        assert_eq!(config["model"]["main"], "zai/glm-5.3");
        // The chosen model is registered so zcode can resolve it.
        assert!(config["provider"]["zai"]["models"]["glm-5.3"].is_object());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zcode_config_keeps_existing_api_key() {
        let dir =
            std::env::temp_dir().join(format!("ugs-zcode-config-keeps-{}", std::process::id()));
        let config_path = dir.join(".zcode").join("cli").join("config.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::write(
            &config_path,
            r#"{
              "provider": {
                "zai": {
                  "kind": "anthropic",
                  "options": { "apiKey": "existing-key", "baseURL": "https://custom.example" },
                  "models": { "glm-5.1": { "name": "GLM-5.1" } }
                }
              },
              "model": { "main": "zai/glm-5.1" }
            }"#,
        )
        .unwrap();

        // No env at all: a config that already carries a key must pass through.
        ensure_zcode_config_at(&config_path, None).unwrap();
        let raw = std::fs::read_to_string(&config_path).unwrap();
        let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            config["provider"]["zai"]["options"]["apiKey"],
            "existing-key"
        );
        assert_eq!(
            config["provider"]["zai"]["options"]["baseURL"],
            "https://custom.example"
        );
        assert_eq!(config["model"]["main"], "zai/glm-5.1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zcode_config_merges_env_into_existing_provider() {
        let dir =
            std::env::temp_dir().join(format!("ugs-zcode-config-merges-{}", std::process::id()));
        let config_path = dir.join(".zcode").join("cli").join("config.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        // Existing config WITHOUT an apiKey (fresh `zcode` first-run default).
        std::fs::write(
            &config_path,
            r#"{
              "provider": {
                "zai": {
                  "kind": "anthropic",
                  "name": "Z.AI Coding Plan",
                  "options": { "apiKeyRequired": true, "baseURL": "https://api.z.ai/api/anthropic" },
                  "models": { "glm-5.2": { "name": "GLM-5.2" } }
                }
              },
              "model": { "main": "zai/glm-5.2", "lite": "zai/glm-5-turbo" }
            }"#,
        )
        .unwrap();

        let env = HashMap::from([
            ("ZCODE_API_KEY".to_string(), "sk-merged".to_string()),
            ("ZCODE_MODEL".to_string(), "glm-5.3".to_string()),
        ]);
        ensure_zcode_config_at(&config_path, Some(&env)).unwrap();
        let raw = std::fs::read_to_string(&config_path).unwrap();
        let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(config["provider"]["zai"]["options"]["apiKey"], "sk-merged");
        // Existing baseURL is preserved (no ZCODE_BASE_URL in env).
        assert_eq!(
            config["provider"]["zai"]["options"]["baseURL"],
            "https://api.z.ai/api/anthropic"
        );
        assert_eq!(config["model"]["main"], "zai/glm-5.3");
        assert!(config["provider"]["zai"]["models"]["glm-5.3"].is_object());
        // Pre-existing model registry is kept.
        assert!(config["provider"]["zai"]["models"]["glm-5.2"].is_object());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zcode_config_rejects_without_any_key() {
        let dir =
            std::env::temp_dir().join(format!("ugs-zcode-config-no-key-{}", std::process::id()));
        let config_path = dir.join(".zcode").join("cli").join("config.json");
        let _ = std::fs::remove_dir_all(&dir);

        let err = ensure_zcode_config_at(&config_path, None).unwrap_err();
        assert!(err.contains("尚未配置模型访问"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_native_plan_snapshots_reach_task_progress() {
        let event: CodexLiteEvent = serde_json::from_str(r#"{
          "method":"turn/plan/updated","params":{"turnId":"turn-1",
            "plan":[{"step":"build","status":"inProgress"}],"explanation":"verify"}
        }"#).unwrap();
        let patch = event.plan_patch().unwrap();
        assert_eq!(patch["id"], "plan:turn-1");
        assert_eq!(patch["args"]["plan"][0]["status"], "inProgress");
        for kind in ["item.started", "item.updated", "item.completed"] {
            let event: CodexLiteEvent = serde_json::from_value(serde_json::json!({
                "type": kind, "item": {"id":"todo", "type":"todo_list",
                    "items":[{"text":"build","completed":false}]}
            })).unwrap();
            assert_eq!(event.plan_patch().unwrap()["args"]["plan"][0]["completed"], false);
        }
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
    fn codex_agent_messages_are_paragraph_delimited() {
        let first: CodexLiteEvent = serde_json::from_str(
            r#"{
              "method": "item/completed",
              "params": {
                "item": {
                  "type": "agent_message",
                  "text": "🔎 目标：分析原因。"
                }
              }
            }"#,
        )
        .unwrap();
        let second: CodexLiteEvent = serde_json::from_str(
            r#"{
              "method": "item/completed",
              "params": {
                "item": {
                  "type": "agent_message",
                  "text": "🛠 下一步：修复。"
                }
              }
            }"#,
        )
        .unwrap();

        let first = first
            .completed_item()
            .and_then(codex_progress_line)
            .unwrap();
        let second = second
            .completed_item()
            .and_then(codex_progress_line)
            .unwrap();
        assert_eq!(
            format!("{first}{second}"),
            "\n🔎 目标：分析原因。\n\n🛠 下一步：修复。\n"
        );
    }

    // The UI probe (`ai_cli_steer_supported`) and the transport selection
    // (`ai_cli`) both read `ai_cli_steer_channel`, so they cannot disagree.
    // They used to: the probe omitted the App Server switch the launch path
    // required, so ⚡ 插话 was offered for a `codex exec` run that had no steer
    // channel at all and the click died silently ("GPT 插话点击无效").
    #[test]
    fn ai_cli_steer_channel_matches_the_launch_transport() {
        let no_shell: Option<ShellSpec> = None;
        // A binary that cannot be spawned advertises no in-turn channel, for
        // every adapter — the probe must fail closed.
        for protocol in [
            "codex",
            "claude",
            "zcode",
            "gemini",
            "kimi",
            "grok",
            "deepseek-harness",
        ] {
            assert_eq!(
                ai_cli_steer_channel(protocol, "ugs-no-such-binary", Some("full"), &no_shell),
                AiCliSteerChannel::None,
                "{protocol}"
            );
        }
        assert_eq!(
            ai_cli_steer_channel("mystery", "codex", Some("full"), &no_shell),
            AiCliSteerChannel::None
        );
    }

    #[test]
    fn codex_app_server_switch_defaults_on_with_an_opt_out() {
        assert!(codex_app_server_env_enabled(None));
        for value in ["1", "true", "TRUE", "yes", " on "] {
            assert!(codex_app_server_env_enabled(Some(value)), "{value}");
        }
        for value in ["0", "false", "FALSE", "off", "no", " 0 ", " Off "] {
            assert!(!codex_app_server_env_enabled(Some(value)), "{value}");
        }
    }

    #[test]
    fn codex_steer_gate_covers_env_approval_and_capability() {
        // This predicate is what picks `app-server --stdio` over `exec`, and
        // the UI probe reads the same value — so it is the one place the two
        // sides could still drift.
        let capable = || true;
        assert!(codex_steer_supported(Some("full"), true, &capable));
        assert!(codex_steer_supported(Some("readonly"), true, &capable));
        assert!(codex_steer_supported(None, true, &capable));
        // App Server approval callbacks have no UI reviewer yet -> one-shot.
        assert!(!codex_steer_supported(Some("ask"), true, &capable));
        // Opted out -> `codex exec`, and the UI hides the action.
        assert!(!codex_steer_supported(Some("full"), false, &capable));
        // CLI build without an `app-server --stdio` subcommand.
        assert!(!codex_steer_supported(Some("full"), true, || false));
    }

    // `codex app-server --help` is a real spawn with a 5s timeout. It must stay
    // behind the cheap gates, or opting out of App Server would still pay for
    // the probe on every first turn.
    #[test]
    fn codex_steer_skips_the_probe_when_a_cheap_gate_already_decided() {
        let calls = std::cell::Cell::new(0);
        let counted = || {
            calls.set(calls.get() + 1);
            true
        };
        assert!(!codex_steer_supported(Some("full"), false, &counted));
        assert_eq!(calls.get(), 0, "switch off must not probe app-server");
        assert!(!codex_steer_supported(Some("ask"), true, &counted));
        assert_eq!(calls.get(), 0, "ask mode must not probe app-server");
        assert!(codex_steer_supported(Some("full"), true, &counted));
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn parses_codex_app_server_delta_and_turn_ids() {
        let started: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "method": "turn/started",
            "params": {
                "turn": { "id": "turn-1", "status": "inProgress" }
            }
        }))
        .unwrap();
        assert_eq!(started.kind(), Some("turn/started"));
        assert_eq!(
            started
                .params
                .as_ref()
                .and_then(|params| params.turn.as_ref())
                .and_then(|turn| turn.id.as_deref()),
            Some("turn-1")
        );

        let delta: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "method": "item/agentMessage/delta",
            "params": { "delta": "STEER_OK" }
        }))
        .unwrap();
        assert_eq!(
            delta
                .params
                .as_ref()
                .and_then(|params| params.delta.as_deref()),
            Some("STEER_OK")
        );
        assert!(delta.is_turn_progress());

        let tool_started: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "method": "item/started",
            "params": { "item": { "id": "tool-1", "type": "command_execution" } }
        }))
        .unwrap();
        assert!(tool_started.is_turn_progress());
        assert!(!started.is_turn_progress());
    }

    #[test]
    fn parses_codex_app_server_steer_response() {
        let event: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "id": "ugs-steer-7",
            "result": { "turnId": "turn-1" }
        }))
        .unwrap();
        assert_eq!(
            event.id.as_ref().and_then(|id| id.as_str()),
            Some("ugs-steer-7")
        );
        assert_eq!(
            event
                .result
                .as_ref()
                .and_then(|result| result.get("turnId"))
                .and_then(|turn_id| turn_id.as_str()),
            Some("turn-1")
        );
        assert!(event.error.is_none());
    }

    #[test]
    fn running_heartbeat_reports_codex_stage() {
        let stage = ai_cli_running_stage(true, true, true, false);
        assert_eq!(stage, "正在等待模型首个事件");
        let patch = encode_running_status_patch("run-1", 12, stage);
        assert!(patch.contains("正在等待模型首个事件"));
        assert!(patch.contains("已 12s"));
    }

    #[test]
    fn codex_startup_deadlines_are_stage_specific() {
        assert_eq!(DEFAULT_AI_CLI_TIMEOUT_SECS, 0);
        assert_eq!(DEFAULT_AI_CLI_IDLE_TIMEOUT_SECS, 7200);
        assert_eq!(DEFAULT_CODEX_THREAD_START_TIMEOUT_SECS, 7200);
        assert_eq!(DEFAULT_CODEX_TURN_START_TIMEOUT_SECS, 7200);
        assert_eq!(DEFAULT_CODEX_FIRST_EVENT_TIMEOUT_SECS, 7200);
    }

    #[test]
    fn codex_start_id_wait_surfaces_timeout_instead_of_silent_return() {
        let value = Arc::new(Mutex::new(None));
        let startup_error = Arc::new(Mutex::new(None));
        let error = wait_for_codex_start_id(
            &value,
            &startup_error,
            std::time::Duration::from_millis(1),
            "thread/start",
        )
        .unwrap_err();
        assert!(error.contains("thread/start 响应超时"));
    }

    #[test]
    fn codex_config_selects_named_provider_detects_relay_layouts() {
        // A named relay provider (the common packyapi layout) must be respected
        // so UGS doesn't override OPENAI_BASE_URL/OPENAI_API_KEY.
        assert!(codex_config_selects_named_provider(
            r#"
model_provider = "sss"
model = "gpt-5.6-sol"
[model_providers.sss]
name = "packycode"
base_url = "https://www.packyapi.com/v1"
wire_api = "responses"
requires_openai_auth = true
"#
        ));
        // Default / no custom routing -> UGS may still override the endpoint.
        assert!(!codex_config_selects_named_provider(
            "model = \"gpt-5.6-sol\"\n"
        ));
        assert!(!codex_config_selects_named_provider(
            "model_provider = \"openai\"\n"
        ));
        assert!(!codex_config_selects_named_provider(
            "model_provider = \"\"\n"
        ));
        assert!(!codex_config_selects_named_provider("not valid toml ["));
    }

    #[test]
    fn codex_credential_override_targets_only_a_declared_named_provider() {
        // The relay layout this bug came from: a named provider with its own
        // credential slot — UGS overrides exactly that slot.
        let relay = "model_provider = \"sss\"\n\
model = \"gpt-5.6-sol\"\n\
[model_providers.sss]\n\
name = \"packycode\"\n\
base_url = \"https://api.packycode.com/v1\"\n\
wire_api = \"responses\"\n\
requires_openai_auth = true\n";
        assert_eq!(
            codex_provider_for_credential_override(relay).as_deref(),
            Some("sss")
        );

        // The provider table must exist: writing `env_key` into a provider codex
        // cannot otherwise resolve would break the turn outright.
        assert_eq!(
            codex_provider_for_credential_override("model_provider = \"ghost\"\n"),
            None
        );
        // Default/openai providers take the plain OPENAI_API_KEY env instead.
        assert_eq!(
            codex_provider_for_credential_override("model_provider = \"openai\"\n"),
            None
        );
        assert_eq!(
            codex_provider_for_credential_override("model = \"gpt-5.1\"\n"),
            None
        );
        assert_eq!(
            codex_provider_for_credential_override("not valid toml ["),
            None
        );
    }

    #[test]
    fn codex_credential_override_names_a_stable_env_var() {
        // The `-c` override and the exported variable must agree, and the name
        // must be UGS-owned so it can never collide with a user's own key var.
        assert_eq!(CODEX_CHANNEL_KEY_ENV, "UGS_CODEX_CHANNEL_KEY");
        let arg = format!(
            "model_providers.{}.env_key=\"{CODEX_CHANNEL_KEY_ENV}\"",
            "sss"
        );
        assert_eq!(arg, "model_providers.sss.env_key=\"UGS_CODEX_CHANNEL_KEY\"");
    }

    #[test]
    fn native_tool_codex_preserves_command_identity_and_explicit_exit() {
        let event: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "cmd-original", "type": "command_execution", "name": "run_shell_command",
                "parentId": "task-original", "status": "completed", "exit_code": 9,
                "aggregated_output": "fixture command failed"
            }
        })).unwrap();
        let patch = codex_tool_patch(event.completed_item().unwrap(), "fallback".into()).unwrap();
        assert_eq!(patch["id"], "cmd-original");
        assert_eq!(patch["name"], "run_shell_command");
        assert_eq!(patch["parentId"], "task-original");
        assert_eq!(patch["status"], "error");
        assert_eq!(patch["exitCode"], 9);
        assert_eq!(patch["result"], "fixture command failed");
    }

    #[test]
    fn native_tool_completion_retains_sanitized_start_arguments() {
        let mut tool_starts = HashMap::new();
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        let start = serde_json::json!({"id":"call-original", "name":"Bash", "input":{
            "command":"npm test", "env":{"API_KEY":"fixture-private-value"}
        }});
        claude_tool_start_patch("run-original", &serde_json::json!({}), &start, &mut tool_starts, &mut sink);
        let end = serde_json::json!({"tool_use_id":"call-original", "is_error":false, "content":"fixture output"});
        claude_tool_result_patch("run-original", &serde_json::json!({}), &end, &mut tool_starts, &mut sink).unwrap();
        assert_eq!(observed[1]["args"]["command"], "npm test");
        assert_eq!(observed[1]["args"]["env"], "[REDACTED]");
        assert!(!serde_json::to_string(&observed).unwrap().contains("fixture-private-value"));
    }

    #[cfg(windows)]
    fn stdio_fixture_binary() -> &'static std::path::PathBuf {
        static BINARY: OnceLock<std::path::PathBuf> = OnceLock::new();
        BINARY.get_or_init(|| {
            let dir = preview_fixture_dir("cli-transport-binary");
            let source = dir.join("fixture.rs");
            let binary = dir.join("fixture-codex.exe");
            std::fs::write(&source, include_str!("../tests/fixtures/stdio_cli.rs")).unwrap();
            let compiled = new_spawn_command("rustc").arg("--edition=2021")
                .arg(&source).arg("-o").arg(&binary).output().unwrap();
            assert!(compiled.status.success(), "fixture must compile: {}",
                String::from_utf8_lossy(&compiled.stderr));
            binary
        })
    }

    #[cfg(windows)]
    fn assert_stdio_run_released(run_id: &str) {
        assert!(!active_ai_cli_pids().lock().unwrap().contains_key(run_id));
        assert!(!active_ai_cli_steers().lock().unwrap().contains_key(run_id));
        assert!(!active_ai_cli_jobs().lock().unwrap().contains_key(run_id));
        assert!(!active_ai_cli_visible_progress().lock().unwrap().contains_key(run_id));
        assert!(!cancelled_ai_cli_ids().lock().unwrap().contains(run_id));
    }

    #[cfg(windows)]
    fn run_stdio_fixture(mode: &str, adapter: &str, timeout: u64, idle: u64)
        -> (Result<AiCliResult, String>, std::time::Duration, std::path::PathBuf)
    {
        let binary = stdio_fixture_binary();
        let dir = preview_fixture_dir(mode);
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows.clear();
        let app = tauri::Builder::default().any_thread().build(context).unwrap();
        let run_id = format!("fixture-disconnect-{mode}-{}", now_ms());
        let env = HashMap::from([("UGS_TEST_STDOUT_MODE".into(), mode.into())]);
        let started = std::time::Instant::now();
        let result = tauri::async_runtime::block_on(ai_cli_runtime(
            "fixture input".into(), adapter.into(), Some(binary.to_string_lossy().into_owned()),
            None, Some(dir.to_string_lossy().into_owned()), None, Some("readonly".into()),
            Some(env), Some(timeout), Some(idle), run_id.clone(), None, None, None, None, None,
            app.handle().clone(),
        ));
        assert!(dir.join("transport-started").is_file(), "must launch the native fixture");
        if adapter == "codex" && mode != "initial-eof" {
            assert!(dir.join("turn-started").is_file(), "must reach the real turn handshake");
        }
        assert_stdio_run_released(&run_id);
        (result, started.elapsed(), dir)
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_closed_stdout_fails_without_waiting_for_idle_timeout() {
        let (result, elapsed, dir) = run_stdio_fixture("eof", "codex", 60, 30);
        let error = result.err().expect("missing terminal event must not be reported as success");
        assert!(elapsed < std::time::Duration::from_secs(5),
            "a dead stdout reader must fail promptly, not at the idle deadline: {error}");
        assert!(error.contains("stdout 读取"), "surface the failed transport: {error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_read_error_does_not_become_success_on_exit_zero() {
        let (result, _, dir) = run_stdio_fixture("invalid-exit", "codex", 60, 30);
        let error = result.err().expect("read errors before terminal must survive a clean process exit");
        assert!(error.contains("stdout 读取失败"), "preserve the actual read failure: {error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_eof_remains_bounded_when_both_timeouts_are_disabled() {
        let (result, elapsed, dir) = run_stdio_fixture("eof", "codex", 0, 0);
        assert!(elapsed < std::time::Duration::from_secs(5));
        assert!(result.err().unwrap().contains("stdout 读取"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_handshake_eof_wakes_the_writer_before_join() {
        let (result, elapsed, dir) = run_stdio_fixture("initial-eof", "codex", 0, 0);
        assert!(elapsed < std::time::Duration::from_secs(5), "writer must not wait for its startup deadline");
        assert!(result.err().unwrap().contains("stdout 读取"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_error_while_server_lingers_fails_promptly() {
        let (result, elapsed, dir) = run_stdio_fixture("invalid-linger", "codex", 0, 0);
        assert!(elapsed < std::time::Duration::from_secs(5));
        assert!(result.err().unwrap().contains("stdout 读取"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_eof_after_codex_terminal_preserves_unicode_completion() {
        let (result, elapsed, dir) = run_stdio_fixture("complete", "codex", 0, 0);
        assert!(elapsed < std::time::Duration::from_secs(5));
        assert_eq!(result.unwrap().text, "fixture complete");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_eof_after_stream_terminal_preserves_completion() {
        let (result, elapsed, dir) = run_stdio_fixture("stream-complete", "fixture-json", 0, 0);
        assert!(elapsed < std::time::Duration::from_secs(6));
        assert_eq!(result.unwrap().text, "fixture complete");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_eof_after_failed_terminal_stays_failed() {
        let (result, _, dir) = run_stdio_fixture("stream-failed", "fixture-json", 0, 0);
        assert!(result.err().unwrap().contains("fixture upstream failed"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_eof_immediately_before_clean_one_shot_exit_is_not_a_failure() {
        let (result, _, dir) = run_stdio_fixture("clean-exit", "fixture-json", 0, 0);
        assert_eq!(result.unwrap().text, "fixture complete");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ai_cli_stdout_reader_panic_is_reported_without_exposing_its_payload() {
        let failure = Arc::new(Mutex::new(None::<String>));
        let reader = spawn_ai_cli_stdout_reader(Arc::clone(&failure), || -> String {
            panic!("fixture private payload must not enter the transport error");
        });
        assert!(reader.join().unwrap().is_empty());
        assert_eq!(failure.lock().unwrap().as_deref(), Some("stdout 读取线程 panic"));
    }

    #[cfg(windows)]
    #[test]
    fn ai_cli_stdout_cancelled_run_stays_cancelled_and_releases_only_its_registration() {
        let binary = stdio_fixture_binary();
        let dir = preview_fixture_dir("cli-cancel");
        let run_id = format!("fixture-disconnect-cancel-{}", now_ms());
        let other_run = format!("fixture-independent-{}", now_ms());
        // A registration-only sentinel has no process attached and is never
        // cancelled or passed to any kill API. It must remain untouched.
        active_ai_cli_visible_progress().lock().unwrap()
            .insert(other_run.clone(), std::time::Instant::now());
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows.clear();
        let app = tauri::Builder::default().any_thread().build(context).unwrap();
        let cancel_id = run_id.clone();
        let marker = dir.join("turn-started");
        let canceller = std::thread::spawn(move || {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while !marker.is_file() && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(marker.is_file(), "must cancel an actual running fixture turn");
            cancel_ai_cli(cancel_id).unwrap();
        });
        let env = HashMap::from([("UGS_TEST_STDOUT_MODE".into(), "cancel".into())]);
        let result = tauri::async_runtime::block_on(ai_cli_runtime(
            "fixture input".into(), "codex".into(), Some(binary.to_string_lossy().into_owned()),
            None, Some(dir.to_string_lossy().into_owned()), None, Some("readonly".into()),
            Some(env), Some(0), Some(0), run_id.clone(), None, None, None, None, None,
            app.handle().clone(),
        ));
        canceller.join().unwrap();
        assert_stdio_run_released(&run_id);
        assert!(active_ai_cli_visible_progress().lock().unwrap().remove(&other_run).is_some());
        assert!(result.err().unwrap().contains("已由用户中断"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn native_tool_codex_unicode_result_keeps_turn_completion_readable() {
        // The stdio reader processes native tool evidence before turn/completed.
        // A UTF-8 slicing panic here drops the pipe and loses the terminal event.
        let records = [
            serde_json::json!({
                "method": "item/completed",
                "params": {"item": {
                    "id": "unicode-command", "type": "commandExecution",
                    "command": "printf fixture", "status": "completed", "exitCode": 0,
                    "aggregatedOutput": "退出代码: 0\n结果=完成\n检查✅: 通过\n中文API_KEY=fixture-private-value\n"
                }}
            }),
            serde_json::json!({
                "method": "turn/completed",
                "params": {"turn": {"id": "unicode-turn", "status": "completed"}}
            }),
        ];
        let reader = std::thread::spawn(move || {
            let mut observed = Vec::new();
            let mut tool_starts = HashMap::new();
            let mut completed = false;
            for record in records {
                let event: CodexLiteEvent = serde_json::from_value(record).unwrap();
                let mut sink = |_: &str, payload| observed.push(payload);
                let _ = codex_native_tool_patch("unicode-run", &event, &mut tool_starts, &mut sink);
                completed |= event.turn_completion_status().as_deref() == Some("completed");
            }
            (observed, completed)
        });
        let (observed, completed) = reader.join().expect("native evidence must not kill the stdout reader");
        assert!(completed, "the reader must reach turn/completed after Unicode tool output");
        assert_eq!(observed.len(), 1);
        let result = observed[0]["result"].as_str().unwrap();
        assert!(result.contains("退出代码: 0"));
        assert!(result.contains("检查✅: 通过"));
        assert!(!result.contains("fixture-private-value"));
        assert!(result.contains("[REDACTED]"));
    }

    #[test]
    fn native_tool_evidence_redacts_named_token_assignments() {
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        let start = serde_json::json!({"id":"token-original", "name":"Bash", "input":{
            "command":"npm test", "github_token":"fixture-private-value"
        }});
        let mut tool_starts = HashMap::new();
        claude_tool_start_patch("run-original", &serde_json::json!({}), &start, &mut tool_starts, &mut sink);
        let end = serde_json::json!({"tool_use_id":"token-original", "content":"GITHUB_TOKEN=fixture-output-value\nordinary output"});
        claude_tool_result_patch("run-original", &serde_json::json!({}), &end, &mut tool_starts, &mut sink).unwrap();
        assert_eq!(observed[0]["args"]["github_token"], "[REDACTED]");
        let result = observed[1]["result"].as_str().unwrap();
        assert!(result.contains("ordinary output"));
        assert!(!serde_json::to_string(&observed).unwrap().contains("fixture-private-value"));
        assert!(!result.contains("fixture-output-value"));
    }

    #[test]
    fn native_tool_serialized_arguments_have_a_hard_byte_limit() {
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        // JSON escaping must count toward the bound, not only source text bytes.
        let start = serde_json::json!({"id":"args-original", "name":"Bash", "input":{
            "command": "\"".repeat(2500), "path":"docs/guide.md"
        }});
        claude_tool_start_patch("run-original", &serde_json::json!({}), &start, &mut HashMap::new(), &mut sink);
        assert!(observed[0]["args"].to_string().len() <= NATIVE_TOOL_ARGS_MAX_BYTES);
    }

    #[test]
    fn native_tool_evidence_is_redacted_and_bounded_before_ui_clipping() {
        let mut tool_starts = HashMap::new();
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        let start = serde_json::json!({"id":"read-original", "name":"Read", "input":{
            "file_path":"docs/guide.md", "env":{"API_KEY":"fixture-private-value"},
            "headers":{"Authorization":"Bearer fixture-bearer-value"}, "password":"fixture-password-value"
        }});
        claude_tool_start_patch("run-original", &serde_json::json!({}), &start, &mut tool_starts, &mut sink);
        let raw = format!("Authorization: Bearer fixture-output-value\n{}", "x".repeat(12000));
        let end = serde_json::json!({"tool_use_id":"read-original", "is_error":false, "content":raw});
        let patch = claude_tool_result_patch("run-original", &serde_json::json!({}), &end, &mut tool_starts, &mut sink).unwrap();
        let serialized = serde_json::to_string(&observed).unwrap();
        for secret in ["fixture-private-value", "fixture-bearer-value", "fixture-password-value", "fixture-output-value"] {
            assert!(!serialized.contains(secret), "fixture credentials must never reach the evidence sink");
        }
        assert_eq!(observed[0]["args"]["file_path"], "docs/guide.md");
        assert_eq!(observed[0]["args"]["env"], "[REDACTED]");
        let result = observed[1]["result"].as_str().unwrap();
        assert!(result.contains("[REDACTED]"));
        assert!(result.len() <= 8192);
        assert!(result.len() > TOOL_RESULT_CLAMP, "native projection must not inherit the UI clip");
        assert_eq!(patch["result"].as_str().unwrap().chars().count(), TOOL_RESULT_CLAMP);
        assert_eq!(observed[1]["status"], "success");
        assert!(observed[1].get("exitCode").is_none());
    }

    #[test]
    fn native_tool_claude_does_not_borrow_another_call_metadata_exit() {
        for metadata in [serde_json::json!({"tool_use_id":"other-call", "exitCode":0}), serde_json::json!({"exitCode":0})] {
            let mut observed = Vec::new();
            let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
            let start = serde_json::json!({"id":"call-original", "name":"Bash", "input":{"command":"npm test"}});
            let mut tool_starts = HashMap::new();
            claude_tool_start_patch("run-original", &serde_json::json!({}), &start, &mut tool_starts, &mut sink);
            let end = serde_json::json!({"type":"tool_result", "tool_use_id":"call-original", "content":"fixture output"});
            let event = serde_json::json!({"type":"user", "message":{"content":[end.clone(),
                {"type":"tool_result", "tool_use_id":"other-call", "content":"unrelated output"}]}, "tool_use_result":metadata});
            claude_tool_result_patch("run-original", &event, &end, &mut tool_starts, &mut sink).unwrap();
            assert_eq!(observed[1]["status"], "unknown");
            assert!(observed[1].get("exitCode").is_none());
        }
    }

    #[test]
    fn native_tool_claude_preserves_correlated_result_metadata_exit() {
        for explicit_metadata_id in [true, false] {
            let mut tool_starts = HashMap::new();
            let mut observed = Vec::new();
            let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
            let start = serde_json::json!({"id":"call-original", "name":"Bash", "input":{"command":"npm test"}});
            claude_tool_start_patch("run-original", &serde_json::json!({}), &start, &mut tool_starts, &mut sink);
            let end = serde_json::json!({"type":"tool_result", "tool_use_id":"call-original", "content":"fixture output"});
            let mut metadata = serde_json::json!({"exitCode":7});
            if explicit_metadata_id { metadata["tool_use_id"] = "call-original".into(); }
            let event = serde_json::json!({"type":"user", "message":{"content":[end.clone()]}, "tool_use_result":metadata});
            claude_tool_result_patch("run-original", &event, &end, &mut tool_starts, &mut sink).unwrap();
            assert_eq!(observed[1]["toolName"], "Bash");
            assert_eq!(observed[1]["exitCode"], 7);
            assert_eq!(observed[1]["status"], "error");
        }
    }

    #[test]
    fn native_tool_claude_emits_correlated_completion_on_independent_channel() {
        let mut tool_starts = HashMap::new();
        let mut observed = Vec::new();
        let mut sink = |name: &str, payload: serde_json::Value| observed.push((name.to_string(), payload));
        let start_event = serde_json::json!({"type":"assistant", "parent_tool_use_id":"task-original"});
        let start = serde_json::json!({"type":"tool_use", "id":"call-original", "name":"Bash", "input":{"command":"npm test"}});
        let start_patch = claude_tool_start_patch("run-original", &start_event, &start, &mut tool_starts, &mut sink);
        let end = serde_json::json!({"type":"tool_result", "tool_use_id":"call-original", "content":"fixture command failed", "is_error":true, "exit_code":7});
        let end_patch = claude_tool_result_patch("run-original", &serde_json::json!({"type":"user"}), &end, &mut tool_starts, &mut sink).unwrap();
        assert_eq!(start_patch["id"], "call-original");
        assert_eq!(end_patch["name"], "Bash");
        assert_eq!(end_patch["parentId"], "task-original");
        assert_eq!(observed.len(), 2);
        assert_eq!(observed[0].0, "ugs-cli-tool");
        assert_eq!(observed[0].1["phase"], "start");
        assert_eq!(observed[0].1["status"], "unknown");
        assert_eq!(observed[1].0, "ugs-cli-tool");
        assert_eq!(observed[1].1["runId"], "run-original");
        assert_eq!(observed[1].1["toolCallId"], "call-original");
        assert_eq!(observed[1].1["toolName"], "Bash");
        assert_eq!(observed[1].1["parentId"], "task-original");
        assert_eq!(observed[1].1["provenance"], "native-tool");
        assert_eq!(observed[1].1["phase"], "end");
        assert_eq!(observed[1].1["status"], "error");
        assert_eq!(observed[1].1["exitCode"], 7);
        assert_eq!(observed[1].1["result"], "fixture command failed");
    }

    #[test]
    fn native_tool_codex_exec_and_app_server_emit_start_and_end() {
        for (kind_key, start_kind, end_kind) in [
            ("type", "item.started", "item.completed"),
            ("method", "item/started", "item/completed"),
        ] {
            let mut tool_starts = HashMap::new();
            let mut observed = Vec::new();
            let mut sink = |name: &str, payload: serde_json::Value| observed.push((name.to_string(), payload));
            for (kind, item) in [
                (start_kind, serde_json::json!({"id":"cmd-original", "type":"commandExecution", "name":"run_shell_command", "parentId":"parent-original", "command":"npm test"})),
                (end_kind, serde_json::json!({"id":"cmd-original", "type":"commandExecution", "status":"completed", "exitCode":0, "aggregatedOutput":"fixture passed"})),
            ] {
                let mut raw = serde_json::json!({kind_key: kind});
                if kind_key == "method" { raw["params"] = serde_json::json!({"item":item}); }
                else { raw["item"] = item; }
                let event: CodexLiteEvent = serde_json::from_value(raw).unwrap();
                let patch = codex_native_tool_patch("run-original", &event, &mut tool_starts, &mut sink).unwrap();
                assert_eq!(patch["name"], "run_shell_command");
            }
            assert_eq!(observed.len(), 2);
            assert_eq!(observed[0].0, "ugs-cli-tool");
            assert_eq!(observed[0].1["phase"], "start");
            assert_eq!(observed[0].1["status"], "unknown");
            assert_eq!(observed[1].0, "ugs-cli-tool");
            assert_eq!(observed[1].1["phase"], "end");
            assert_eq!(observed[1].1["toolCallId"], "cmd-original");
            assert_eq!(observed[1].1["toolName"], "run_shell_command");
            assert_eq!(observed[1].1["parentId"], "parent-original");
            assert_eq!(observed[1].1["exitCode"], 0);
            assert_eq!(observed[1].1["status"], "success");
            assert_eq!(observed[1].1["result"], "fixture passed");
        }
    }

    #[test]
    fn native_tool_ui_status_and_model_plan_are_not_native_evidence() {
        let heartbeat = encode_running_status_patch("run-original", 12, "waiting");
        let payload = heartbeat.split("<<UGS_TOOL>>").nth(1).unwrap().split("<<UGS_TOOL_END>>").next().unwrap();
        let heartbeat: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(heartbeat["provenance"], "ui-synthetic");
        let mut tool_starts = HashMap::new();
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        let plan: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "method":"turn/plan/updated", "params":{"turnId":"turn-original", "plan":[{"step":"model plan","status":"completed"}]}
        })).unwrap();
        assert_eq!(plan.plan_patch().unwrap()["provenance"], "model-output");
        assert!(codex_native_tool_patch("run-original", &plan, &mut tool_starts, &mut sink).is_none());
        let todo: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "type":"item.completed", "item":{"id":"todo-original", "type":"todo_list", "items":[]}
        })).unwrap();
        assert!(codex_native_tool_patch("run-original", &todo, &mut tool_starts, &mut sink).is_none());
        assert!(observed.is_empty());
    }

    #[test]
    fn native_tool_gemini_preserves_identity_and_unknown_verdict() {
        let mut tool_starts = HashMap::new();
        let mut observed = Vec::new();
        let mut sink = |name: &str, payload: serde_json::Value| observed.push((name.to_string(), payload));
        let start = serde_json::json!({"type":"tool_use", "tool_id":"gem-original", "tool_name":"run_shell_command", "parent_id":"parent-original", "parameters":{"command":"npm test"}});
        gemini_tool_patch("run-original", &start, &mut tool_starts, &mut sink).unwrap();
        let end = serde_json::json!({"type":"tool_result", "tool_id":"gem-original", "output":"fixture output", "exitCode":null});
        let patch = gemini_tool_patch("run-original", &end, &mut tool_starts, &mut sink).unwrap();
        assert_eq!(patch["name"], "run_shell_command");
        assert_eq!(patch["parentId"], "parent-original");
        assert_eq!(observed.len(), 2);
        assert_eq!(observed[0].0, "ugs-cli-tool");
        assert_eq!(observed[0].1["phase"], "start");
        assert_eq!(observed[1].1["toolCallId"], "gem-original");
        assert_eq!(observed[1].1["toolName"], "run_shell_command");
        assert_eq!(observed[1].1["parentId"], "parent-original");
        assert_eq!(observed[1].1["phase"], "end");
        assert_eq!(observed[1].1["status"], "unknown");
        assert_eq!(observed[1].1["exitCode"], serde_json::Value::Null);
        assert_eq!(observed[1].1["result"], "fixture output");
    }

    #[test]
    fn native_tool_codex_preserves_mcp_name_arguments_and_structured_result() {
        let event: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "method":"item/completed", "params":{"item":{
                "id":"mcp-original", "type":"mcpToolCall", "server":"workspace", "tool":"read_file",
                "status":"completed", "arguments":{"path":"docs/guide.md", "api_key":"fixture-private-value"},
                "result":{"content":[{"type":"text", "text":"fixture output"}]}
            }}
        })).unwrap();
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        codex_native_tool_patch("run-original", &event, &mut HashMap::new(), &mut sink).unwrap();
        assert_eq!(observed[0]["toolName"], "read_file");
        assert_eq!(observed[0]["args"]["arguments"]["path"], "docs/guide.md");
        assert_eq!(observed[0]["args"]["arguments"]["api_key"], "[REDACTED]");
        assert!(observed[0]["result"].as_str().unwrap().contains("fixture output"));
        assert!(!serde_json::to_string(&observed).unwrap().contains("fixture-private-value"));
    }

    #[test]
    fn native_tool_codex_keeps_explicit_null_exit_and_params_parent() {
        let event: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "method":"item/completed", "params":{"parentId":"parent-original",
                "item":{"id":"cmd-original", "type":"commandExecution", "exitCode":null}}
        })).unwrap();
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        codex_native_tool_patch("run-original", &event, &mut HashMap::new(), &mut sink).unwrap();
        assert_eq!(observed[0]["parentId"], "parent-original");
        assert_eq!(observed[0].get("exitCode"), Some(&serde_json::Value::Null));
        assert_eq!(observed[0]["status"], "unknown");
    }

    #[test]
    fn native_tool_codex_completed_command_without_exit_stays_unknown() {
        let event: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "type":"item.completed", "item":{"id":"cmd-original", "type":"command_execution", "status":"completed"}
        })).unwrap();
        let mut observed = Vec::new();
        let mut sink = |_: &str, payload: serde_json::Value| observed.push(payload);
        codex_native_tool_patch("run-original", &event, &mut HashMap::new(), &mut sink).unwrap();
        assert_eq!(observed[0]["status"], "unknown");
        assert!(observed[0].get("exitCode").is_none());
    }

    #[test]
    fn native_tool_codex_unknown_completion_is_not_success() {
        let event: CodexLiteEvent = serde_json::from_value(serde_json::json!({
            "type": "item.completed",
            "item": { "id": "cmd-unknown", "type": "command_execution", "output": "fixture output" }
        })).unwrap();
        let patch = codex_tool_patch(event.completed_item().unwrap(), "fallback".into()).unwrap();
        assert_eq!(patch["evidenceStatus"], "unknown");
        assert!(patch.get("exitCode").is_none());
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
    fn claude_result_failure_detects_errors_and_ignores_success() {
        // Successful turn with text — no failure.
        let ok = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "result": "done",
        });
        assert_eq!(claude_result_failure(&ok), None);

        // is_error with empty result — falls back to a generic message.
        let flagged = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": "",
        });
        assert_eq!(
            claude_result_failure(&flagged).as_deref(),
            Some("模型报告本轮执行出错"),
        );

        // Error subtype with no text — reports the subtype.
        let max_turns = serde_json::json!({
            "type": "result",
            "subtype": "error_max_turns",
        });
        assert_eq!(
            claude_result_failure(&max_turns).as_deref(),
            Some("error_max_turns"),
        );

        // During-execution error carrying a nested error message.
        let during = serde_json::json!({
            "type": "result",
            "subtype": "error_during_execution",
            "error": { "message": "Overloaded" },
        });
        assert_eq!(
            claude_result_failure(&during).as_deref(),
            Some("Overloaded")
        );

        // Prefer the human-readable result text when present.
        let with_text = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": "rate limited, retry later",
        });
        assert_eq!(
            claude_result_failure(&with_text).as_deref(),
            Some("rate limited, retry later"),
        );
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
    fn claude_bare_mode_requires_explicit_internal_capability() {
        let mut env = HashMap::new();
        assert!(!should_run_claude_bare_with_disable(Some(&env), false));

        env.insert("ANTHROPIC_API_KEY".to_string(), "token".to_string());
        env.insert(
            "ANTHROPIC_BASE_URL".to_string(),
            "https://relay.example/anthropic".to_string(),
        );
        assert!(!should_run_claude_bare_with_disable(Some(&env), false));

        env.insert("UGS_CLAUDE_BARE".to_string(), "1".to_string());
        assert!(should_run_claude_bare_with_disable(Some(&env), false));
    }

    #[test]
    fn claude_bare_mode_can_be_disabled() {
        let mut env = HashMap::new();
        env.insert("UGS_CLAUDE_BARE".to_string(), "true".to_string());

        assert!(!should_run_claude_bare_with_disable(Some(&env), true));
    }

    #[test]
    fn claude_bare_mode_never_depends_on_gateway_url() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_AUTH_TOKEN".to_string(), "tok".to_string());
        for url in [
            "https://relay-a.example/anthropic",
            "https://relay-b.example/v1",
            "http://127.0.0.1:8766/ch/custom",
        ] {
            env.insert("ANTHROPIC_BASE_URL".to_string(), url.to_string());
            assert!(!should_run_claude_bare_with_disable(Some(&env), false));
        }

        env.insert("UGS_CLAUDE_BARE".to_string(), "yes".to_string());
        assert!(should_run_claude_bare_with_disable(Some(&env), false));
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
    fn claude_stream_input_support_comes_from_help_text() {
        assert!(claude_help_supports_stream_input(
            "--input-format <format> text or stream-json (realtime streaming input)"
        ));
        assert!(!claude_help_supports_stream_input(
            "--output-format <format> text or stream-json"
        ));
    }

    #[test]
    fn claude_effort_support_comes_from_help_text() {
        // 本机 claude 的 `--effort <level>`（low/medium/high/xhigh/max）。
        assert!(claude_help_supports_effort(
            "  --effort <level>  Effort level for the current session (low, medium, high, xhigh, max)"
        ));
        assert!(!claude_help_supports_effort(
            "Options:\n  --model <model>\n  --verbose"
        ));
    }

    #[test]
    fn kimi_agent_file_support_comes_from_help_text() {
        assert!(kimi_help_supports_agent_file(
            "  --agent-file <path>   Load an agent definition from a Markdown file"
        ));
        assert!(!kimi_help_supports_agent_file(
            "  --prompt <prompt>     Run one prompt non-interactively"
        ));
    }

    #[test]
    fn kimi_headless_agent_keeps_base_prompt_and_drops_ask_tools() {
        // `${base_prompt}` must survive: without it the agent file REPLACES
        // kimi's effective system prompt (environment, AGENTS.md, skills)
        // instead of adding to it.
        assert!(KIMI_HEADLESS_AGENT.contains("${base_prompt}"));
        assert!(KIMI_HEADLESS_AGENT.contains("disallowedTools:"));
        for tool in ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"] {
            assert!(KIMI_HEADLESS_AGENT.contains(tool), "missing {tool}");
        }
        assert!(KIMI_HEADLESS_AGENT.contains("<<UGS_ASK>>"));
    }

    #[test]
    fn claude_stream_input_message_matches_cli_protocol() {
        assert_eq!(
            claude_stream_input_message("补充约束"),
            serde_json::json!({
                "type": "user",
                "message": { "role": "user", "content": "补充约束" },
                "parent_tool_use_id": serde_json::Value::Null,
                "session_id": "default"
            })
        );
    }

    #[test]
    fn claude_complete_assistant_text_falls_back_when_no_delta_arrived() {
        assert!(should_emit_complete_claude_text(true, false));
        assert!(!should_emit_complete_claude_text(true, true));
        assert!(should_emit_complete_claude_text(false, false));
    }

    #[test]
    fn heartbeat_depends_on_visible_progress_gap() {
        let beat = std::time::Duration::from_secs(AI_CLI_HEARTBEAT_SECS);
        assert!(should_emit_ai_cli_heartbeat(beat, beat, beat));
        assert!(!should_emit_ai_cli_heartbeat(
            std::time::Duration::from_secs(1),
            beat,
            beat,
        ));
        assert!(!should_emit_ai_cli_heartbeat(
            beat,
            std::time::Duration::from_secs(1),
            beat,
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
    fn parse_unified_workspace_diff_lines_accepts_p4_headers() {
        let (lines, binary) = parse_unified_workspace_diff_lines(
            "--- //MoonEngine/dev/Engine/Shaders/Private/MoonShader.usf\t2026-05-27\n\
             +++ E:\\project_moon_ue5\\MoonEngine\\Engine\\Shaders\\Private\\MoonShader.usf\t2026-05-27\n\
             @@ -139,0 +139,1 @@\n\
             +\tValue.a = 1.0f; // Moon Modified\n\
             @@ -169,1 +170,1 @@\n\
             -void DecodeMoonScreenShadow(float4 LightAttenuation)\n\
             +void DecodeMoonScreenShadow(float4 ShadowMaskFactors)\n",
        );

        assert!(!binary);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].kind, "added");
        assert_eq!(lines[0].new_line, Some(139));
        assert_eq!(lines[1].kind, "replacedDeleted");
        assert_eq!(lines[1].old_line, Some(169));
        assert_eq!(lines[2].kind, "replacedAdded");
        assert_eq!(lines[2].new_line, Some(170));
    }

    #[test]
    fn workspace_file_diff_root_and_relative_path_uses_absolute_file_parent_outside_root() {
        let base = std::env::temp_dir().join(format!(
            "ugs-file-diff-root-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let primary = base.join("primary");
        let external_dir = base.join("external").join("Engine").join("Shaders");
        let file = external_dir.join("MoonShader.usf");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::create_dir_all(&external_dir).unwrap();
        std::fs::write(&file, "float4 Main() { return 1; }\n").unwrap();
        let expected_root = std::fs::canonicalize(&external_dir).unwrap_or(external_dir.clone());

        assert!(workspace_file_diff_relative_path(&primary, &display_preview_path(&file)).is_err());
        let (diff_root, relative_path) =
            workspace_file_diff_root_and_relative_path(&primary, &display_preview_path(&file))
                .unwrap();
        let _ = std::fs::remove_dir_all(&base);

        assert_eq!(diff_root, expected_root);
        assert_eq!(relative_path, "MoonShader.usf");
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
    fn p4_collect_opened_count_counts_opened_lines() {
        assert_eq!(
            p4_collect_opened_count(
                "//depot/A.cpp#3 - opened for edit\n\
                 //depot/B.cpp#1 - opened for add\n\
                 //depot/C.cpp - file(s) up-to-date\n"
            ),
            2
        );
    }

    #[test]
    fn p4_collect_error_treats_already_opened_as_noop() {
        assert!(p4_collect_error_is_noop(
            "//depot/A.cpp#3 - can't edit exclusive file already opened\n"
        ));
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
    fn turn_file_changes_exclude_unchanged_dirty_files() {
        let root = std::env::current_dir().unwrap().join("../../.ultragamestudio/tests")
            .join(format!("turn-changes-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("existing.txt"), "user's dirty content\n").unwrap();
        std::fs::write(root.join("changed.txt"), "old\n").unwrap();
        let key = format!("turn:test:{}", now_ms());
        workspace_changes_baseline_blocking(display_preview_path(&root), key.clone(), None).unwrap();
        let unchanged = workspace_changes_blocking(display_preview_path(&root), key.clone(), None).unwrap();
        assert!(unchanged.files.is_empty());
        assert!(!workspace_change_cache_file(&root, &key, "baseline").exists());
        workspace_changes_baseline_blocking(display_preview_path(&root), key.clone(), None).unwrap();
        std::fs::write(root.join("changed.txt"), "new\n").unwrap();
        std::fs::write(root.join("created.txt"), "created\n").unwrap();
        let changes = workspace_changes_blocking(display_preview_path(&root), key, None).unwrap();
        assert_eq!(changes.files.len(), 2);
        assert_eq!(changes.files[0].path, "changed.txt");
        assert_eq!(changes.files[1].path, "created.txt");
        std::fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn normalizes_spawn_env_prefers_gemini_key_over_stale_google_key() {
        let mut env = HashMap::new();
        env.insert("GEMINI_API_KEY".to_string(), "gemini-key".to_string());
        env.insert("GOOGLE_API_KEY".to_string(), "stale-google-key".to_string());

        let normalized = normalize_spawn_env(Some(env)).unwrap();

        assert_eq!(
            normalized.get("GOOGLE_API_KEY").map(String::as_str),
            Some("gemini-key")
        );
    }

    #[test]
    fn translate_agent_label_maps_known_and_unknown_agents() {
        assert_eq!(translate_agent_label("claude-code"), "Claude Code");
        assert_eq!(translate_agent_label("codex"), "Codex");
        assert_eq!(translate_agent_label("gemini"), "Gemini");
        assert_eq!(translate_agent_label("agents"), "Agents (跨 agent 标准)");
        assert_eq!(translate_agent_label("kimi"), "Kimi Code");
        assert_eq!(translate_agent_label("mystery"), "mystery");
    }

    #[test]
    fn skill_target_ids_for_agent_returns_expected_roots() {
        assert_eq!(
            skill_target_ids_for_agent("claude-code"),
            vec!["global-claude", "project-claude"]
        );
        assert_eq!(
            skill_target_ids_for_agent("codex"),
            vec!["global-codex", "project-codex"]
        );
        assert_eq!(skill_target_ids_for_agent("gemini"), vec!["global-gemini"]);
        assert_eq!(
            skill_target_ids_for_agent("grok"),
            vec!["global-grok", "project-grok"]
        );
        assert_eq!(
            skill_target_ids_for_agent("agents"),
            vec!["global-agents", "project-agents"]
        );
        assert!(skill_target_ids_for_agent("zcode").is_empty());
    }

    #[test]
    fn merge_mcp_servers_into_json_merges_and_sets_trust() {
        let dir = std::env::temp_dir().join(format!("ugs-capability-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            serde_json::json!({
                "mcpServers": { "existing": { "command": "old" } },
                "keepMe": true
            })
            .to_string(),
        )
        .unwrap();

        let servers: serde_json::Map<String, serde_json::Value> =
            serde_json::json!({ "my-server": { "command": "npx", "args": ["-y", "x"] } })
                .as_object()
                .unwrap()
                .clone();

        merge_mcp_servers_into_json(&path, &servers, true).unwrap();

        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["keepMe"], serde_json::json!(true));
        assert_eq!(
            doc["mcpServers"]["existing"]["command"],
            serde_json::json!("old")
        );
        assert_eq!(
            doc["mcpServers"]["my-server"]["command"],
            serde_json::json!("npx")
        );
        assert_eq!(
            doc["mcpServers"]["my-server"]["trust"],
            serde_json::json!(true)
        );

        let _ = std::fs::remove_dir_all(&dir);
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
        const DISABLE_OCCLUSION: &str =
            "--disable-features=msWebOOUI,msPdfOOUI,CalculateNativeWinOcclusion";
        match std::env::var(WEBVIEW2_ARGS_VAR) {
            Ok(existing) if !existing.is_empty() => {
                if !existing.contains("CalculateNativeWinOcclusion") {
                    std::env::set_var(WEBVIEW2_ARGS_VAR, format!("{existing} {DISABLE_OCCLUSION}"));
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
            cache_cleanup::spawn_startup_cache_cleanup();
            autosave::spawn_autosave_service();

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
                    TRAY_MENU_QUIT_ID => {
                        // 先给前端一次同步落盘兜底的机会（见 BEFORE_QUIT_EVENT），
                        // 只在前端确认落盘后退出；固定超时会截断 keychain 写入。
                        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                            if let Err(error) = window.emit(BEFORE_QUIT_EVENT, ()) {
                                eprintln!("[quitFlush] 退出前保存事件发送失败: {error}");
                                show_main_window(app);
                            }
                        } else {
                            app.exit(0);
                        }
                    }
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
            message_platforms::message_platform_load,
            message_platforms::message_platform_save,
            message_platforms::message_platform_request,
            message_platforms::message_platform_status,
            focus_main_window,
            ugs_quit_flush_done,
            ugs_quit_cancel,
            notify_session_complete,
            dismiss_session_waiting_input_notification,
            migrate_legacy_brand_storage,
            ai_edit_graph,
            // [workflow 编排已废弃] run_workflow 命令停用：前端 tauri.ts 绑定本就无调用方。
            // 恢复功能取消下一行注释即可（命令实现保留）。
            // run_workflow,
            run_studio,
            ai_cli,
            cancel_ai_cli,
            ai_cli_steer_supported,
            steer_ai_cli,
            slash_catalog,
            refresh_slash_catalog,
            skills_bind_run,
            skills_revoke_run,
            skills_request,
            skill_install_targets,
            install_skill_from_url,
            install_skill_from_zip_url,
            install_skill_from_text,
            uninstall_skill,
            translate_capability,
            scan_model_clis,
            validate_cli_path,
            check_cli_updates,
            update_cli,
            run_cache_cleanup_now,
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
            p4_collect_to_pending_list,
            workspace_vcs_status_cached,
            workspace_vcs_status_scan,
            workspace_vcs_status_cancel,
            workspace_changes_cached,
            prepare_isolated_workspace,
            preview_local_file,
            ensure_local_asset_scope,
            preview_office_document,
            read_image_thumbnail,
            file_exists,
            read_local_file_for_upload,
            knowledge_base_scan_files,
            save_clipboard_image,
            save_session_capture,
            fetch_capture_image_data_url,
            fetch_model_asset_data_url,
            read_model_asset_data_url,
            download_model_asset,
            save_generated_asset,
            list_cached_assets,
            list_background_jobs,
            remove_background_job,
            ugs_job_wrapper_path,
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
            free_proxy::free_proxy_stop,
            proxy_http::proxy_http,
            cache_cleanup::manual_cache_cleanup,
            autosave::autosave_now,
            autosave::autosave_config,
            autosave::autosave_list_snapshots
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) { message_platforms::shutdown(); }
        });
}
