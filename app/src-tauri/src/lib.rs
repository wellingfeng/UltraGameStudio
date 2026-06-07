use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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

/// Windows CreateProcess flag: don't allocate a console window for the child.
/// Without this, spawning the `claude` console binary pops up a black terminal
/// window every time the app runs a node. No-op on other platforms.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_MENU_SHOW_ID: &str = "tray-show-main";
const TRAY_MENU_GITHUB_ID: &str = "tray-open-github";
const TRAY_MENU_QUIT_ID: &str = "tray-quit";
const GITHUB_REPOSITORY_URL: &str = "https://github.com/wellingfeng/FreeUltraCode";
const SINGLE_INSTANCE_WARNING_EVENT: &str = "single-instance-warning";
const SINGLE_INSTANCE_WARNING_MESSAGE: &str = "只能同时运行一个进程";
const SLASH_CATALOG_UPDATED_EVENT: &str = "slash-catalog-updated";
const MAX_SLASH_ENTRIES: usize = 800;
const MAX_COMMAND_SCAN_DEPTH: usize = 4;
const MAX_SKILL_SCAN_DEPTH: usize = 8;

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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
const LOCAL_MODEL_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
const REMOTE_MODEL_LIST_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);
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
struct UltracodeRunResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    run_id: String,
    run_dir: Option<String>,
    result_json: Option<serde_json::Value>,
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

fn app_slash_command_entry(
    name: &str,
    zh_label: &str,
    en_label: &str,
    zh_detail: &str,
    en_detail: &str,
    zh_insert: &str,
    en_insert: &str,
) -> SlashCatalogEntry {
    SlashCatalogEntry {
        id: format!("command:app:{name}"),
        kind: "command".to_string(),
        name: name.to_string(),
        label: localized_text(zh_label, en_label),
        detail: localized_text(zh_detail, en_detail),
        insert_text: localized_text(zh_insert, en_insert),
        source: Some("app".to_string()),
        source_adapter: Some("app".to_string()),
    }
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
    let mut entries = vec![
        app_slash_command_entry(
            "/deep-research",
            "深度调研",
            "Deep Research",
            "用 /ultracode 跑多源核验研究",
            "Run source-grounded research through /ultracode",
            "执行 deep-research：使用随 FreeUltraCode 一起发布的内置 workflow 协议 workflows/deep-research/WORKFLOW.md 和 protocol/model-agnostic-deep-research.md。必须先界定研究问题、来源边界、时间范围和风险等级；优先官方/一手来源；维护 source ledger 和 claim audit；区分已核验事实、供应商声明、社区观点、设计推断、未核验假设和 gaps。默认输出中文决策简报：优先级、Top opportunities/options、MVP/原型路径、暂不做事项、风险和验证信号；证据表作为附录。高风险或用户明确要求时再输出完整 dossier。不要声称访问任何供应商私有实现。",
            "Run deep research using the built-in FreeUltraCode workflow protocol workflows/deep-research/WORKFLOW.md and protocol/model-agnostic-deep-research.md. Define the question, source boundary, time window, and risk level; prioritize official/primary sources; maintain a source ledger and claim audit; separate verified facts, vendor-stated claims, community reports, design inferences, unverified hypotheses, and gaps. Default to a decision brief with priority, top opportunities/options, MVP/prototype path, what not to do yet, risks, and validation signals; keep evidence tables as an appendix. Expand to a full dossier only for high-risk work or when explicitly requested. Do not claim access to private vendor internals.",
        ),
        app_slash_command_entry(
            "/help",
            "帮助",
            "Help",
            "列出当前可用 command / skill",
            "List available commands and skills",
            "列出当前可用的 slash command 和 Skill，按用途分组，并给出每个条目的触发词和适用场景。",
            "List the available slash commands and skills, grouped by use case, with each trigger and when to use it.",
        ),
        app_slash_command_entry(
            "/plan",
            "计划",
            "Plan",
            "先拆步骤，再执行",
            "Break down steps before acting",
            "先给出简短执行计划，再按计划完成任务；只保留必要步骤和风险点。",
            "Start with a short execution plan, then complete the task; keep only necessary steps and risks.",
        ),
        app_slash_command_entry(
            "/diagnose",
            "诊断",
            "Diagnose",
            "复现 -> 根因 -> 修复 -> 验证",
            "Reproduce -> root cause -> fix -> verify",
            "诊断这个问题：先复现或定位触发条件，再找根因，最后给出修复和验证结果。",
            "Diagnose this: reproduce or identify the trigger, find the root cause, then provide the fix and verification.",
        ),
        app_slash_command_entry(
            "/review",
            "审查",
            "Review",
            "按代码审查视角找风险",
            "Review for bugs and risks",
            "按代码审查视角检查：优先列出 bug、回归风险和缺失测试，给出文件/位置和修复建议。",
            "Review this as code: list bugs, regression risks, and missing tests first, with file/location references and fixes.",
        ),
        app_slash_command_entry(
            "/explain",
            "解释",
            "Explain",
            "解释执行路径和关键依赖",
            "Explain flow and dependencies",
            "解释这段内容的执行路径、关键依赖和容易误解的点，结论先行。",
            "Explain the execution flow, key dependencies, and easy-to-misread parts. Start with the conclusion.",
        ),
        app_slash_command_entry(
            "/test",
            "测试",
            "Test",
            "补充或运行相关测试",
            "Add or run relevant tests",
            "为当前任务补充或运行最相关的测试；若失败，说明失败点、可能根因和下一步。",
            "Add or run the most relevant tests for this task; if they fail, report the failure, likely cause, and next step.",
        ),
    ];

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

fn bundled_deep_research_workflow_root(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("workflows").join("deep-research"))
        .filter(|dir| dir.is_dir())
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
    matches!(name.trim().to_ascii_lowercase().as_str(), "/deep-research")
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
    if let Ok(path) = std::env::var("FREEULTRACODE_FREE_CHANNELS_CONFIG") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            out.push(PathBuf::from(trimmed));
        }
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

/// Write the generated script to a uniquely-named temp file and return its path.
fn write_temp_script(script: &str) -> Result<std::path::PathBuf, String> {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    path.push(format!("freeultracode-{stamp}.sh"));
    let mut file = std::fs::File::create(&path).map_err(|e| format!("无法创建临时脚本: {e}"))?;
    file.write_all(script.as_bytes())
        .map_err(|e| format!("写入临时脚本失败: {e}"))?;
    Ok(path)
}

/// Return a unique temp path for CLI side-channel output.
fn temp_output_path(prefix: &str, ext: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    path.push(format!("{prefix}-{stamp}.{ext}"));
    path
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
                            .arg("fuc-shell")
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

const PREVIEW_TEXT_LIMIT: u64 = 1_500_000;
const PREVIEW_IMAGE_LIMIT: u64 = 12 * 1024 * 1024;
const PREVIEW_BASENAME_SEARCH_LIMIT: usize = 20_000;
const CLIPBOARD_IMAGE_LIMIT: usize = 32 * 1024 * 1024;
const SESSION_CAPTURE_LIMIT: usize = 128 * 1024 * 1024;
const CAPTURE_IMAGE_FETCH_LIMIT: usize = 32 * 1024 * 1024;
const CAPTURE_IMAGE_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

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
        preview_bare_name_fallback(&path, cwd.as_deref()).unwrap_or(resolved)
    };
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
    let path = resolved.to_string_lossy().to_string();

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
    let cwd = cwd.unwrap_or_default().trim();
    if !cwd.is_empty() {
        let root = PathBuf::from(cwd);
        if root.is_dir() {
            return root.join(".omc").join("clipboard-images");
        }
    }
    std::env::temp_dir()
        .join("freeultracode")
        .join("clipboard-images")
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
    let cwd = cwd.unwrap_or_default().trim();
    if !cwd.is_empty() {
        let root = PathBuf::from(cwd);
        if root.is_dir() {
            return root.join(".omc").join("session-captures");
        }
    }
    std::env::temp_dir()
        .join("freeultracode")
        .join("session-captures")
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
        .set("User-Agent", "FreeUltraCode")
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
        let script_path = std::env::temp_dir().join("freeultracode-setup-local-model.ps1");
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

fn fuc_cli_candidates(cwd: Option<&str>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = cwd.map(str::trim).filter(|dir| !dir.is_empty()) {
        let root = PathBuf::from(dir);
        out.push(root.join("app").join("cli").join("dist").join("fuc.mjs"));
        out.push(root.join("cli").join("dist").join("fuc.mjs"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("app").join("cli").join("dist").join("fuc.mjs"));
        out.push(cwd.join("cli").join("dist").join("fuc.mjs"));
        if let Some(parent) = cwd.parent() {
            out.push(parent.join("app").join("cli").join("dist").join("fuc.mjs"));
            out.push(parent.join("cli").join("dist").join("fuc.mjs"));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            out.push(dir.join("fuc.mjs"));
            out.push(dir.join("cli").join("dist").join("fuc.mjs"));
            out.push(
                dir.join("..")
                    .join("..")
                    .join("app")
                    .join("cli")
                    .join("dist")
                    .join("fuc.mjs"),
            );
        }
    }
    out
}

fn bundled_fuc_cli_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("cli").join("fuc.mjs"))
        .filter(|path| path.is_file())
}

fn locate_fuc_cli(cwd: Option<&str>, app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = bundled_fuc_cli_path(app) {
        return normalize_node_entry_path(&path)
            .map_err(|e| format!("无法解析内置 fuc CLI 路径 {}: {e}", path.display()));
    }

    let candidates = fuc_cli_candidates(cwd);
    for path in &candidates {
        if path.is_file() {
            return normalize_node_entry_path(path)
                .map_err(|e| format!("无法解析 fuc CLI 路径 {}: {e}", path.display()));
        }
    }
    let searched = candidates
        .iter()
        .map(|path| format!("  - {}", path.display()))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "未找到 app/cli/dist/fuc.mjs 或内置 cli/fuc.mjs。请先在 app/ 下运行 npm run cli:build。\n已搜索:\n{searched}"
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

fn default_ultracode_workdir(cli_path: &Path) -> PathBuf {
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

fn emit_ultracode_progress(app: &tauri::AppHandle, run_id: &str, stream: &str, text: &str) {
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

#[tauri::command]
async fn run_ultracode(
    task: String,
    cwd: Option<String>,
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
) -> Result<UltracodeRunResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<UltracodeRunResult, String> {
        let task = task.trim().to_string();
        if task.is_empty() {
            return Err("请提供任务：/ultracode <任务>".to_string());
        }

        let cwd_trimmed = cwd.as_deref().map(str::trim).filter(|dir| !dir.is_empty());
        let cli_path = locate_fuc_cli(cwd_trimmed, &app)?;
        let workdir = cwd_trimmed
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| default_ultracode_workdir(&cli_path));
        let deep_research_workflow = bundled_deep_research_workflow_root(&app);
        let task = if task.contains("执行 deep-research")
            || task.contains("Run deep research")
            || task.contains("/deep-research")
        {
            match &deep_research_workflow {
                Some(root) => format!(
                    "{task}\n\n内置 deep-research workflow 路径：{root}\n请优先读取并遵循该目录下 WORKFLOW.md 和 protocol/model-agnostic-deep-research.md；这是随 FreeUltraCode 发布的内置 workflow，不是用户电脑上的普通 skill，不要依赖用户工作区里是否存在 skills/ 目录。",
                    root = root.to_string_lossy()
                ),
                None => format!(
                    "{task}\n\n内置 deep-research workflow 路径：未找到 Tauri bundled workflow resource；请按内置 deep-research 协议摘要执行，并在最终报告中记录该资源缺口。"
                ),
            }
        } else {
            task
        };

        let mut args = vec![
            cli_path.to_string_lossy().to_string(),
            "ultracode".to_string(),
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
            .env(
                "FUC_BUILTIN_DEEP_RESEARCH_WORKFLOW_DIR",
                deep_research_workflow
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default(),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动 node 执行 /ultracode：请确认 Node.js 已安装并在 PATH 中。({e})"))?;
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
                emit_ultracode_progress(&app_stdout, &run_stdout, "stdout", &line);
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
                emit_ultracode_progress(&app_stderr, &run_stderr, "stderr", &line);
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
                        return Err("CLI \"ultracode\" 已由用户中断。".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    terminate_child_tree(&mut child);
                    unregister_ai_cli(&run_id);
                    return Err(format!("等待 /ultracode 进程失败: {e}"));
                }
            }
        };

        let stdout = stdout_handle.join().unwrap_or_default();
        let stderr = stderr_handle.join().unwrap_or_default();
        let cancelled = take_ai_cli_cancelled(&run_id);
        unregister_ai_cli(&run_id);
        if cancelled {
            return Err("CLI \"ultracode\" 已由用户中断。".to_string());
        }

        let result_json = serde_json::from_str::<serde_json::Value>(stdout.trim()).ok();
        let run_dir = result_json
            .as_ref()
            .and_then(|value| value.get("runDir"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        let exit_code = status.code().unwrap_or(-1);
        let result = UltracodeRunResult {
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
                "/ultracode 退出码 {exit_code}\n--- stdout ---\n{}\n--- stderr ---\n{}",
                result.stdout.trim_end(),
                result.stderr.trim_end()
            ))
        }
    })
    .await
    .map_err(|e| format!("/ultracode 任务调度失败: {e}"))?
}

/// System prompt steering the model to emit a pure IRGraph JSON object that maps
/// onto a *runnable* Claude Code workflow (the injected-globals DSL).
const AI_EDIT_SYSTEM: &str = "You are a workflow graph editor for FreeUltraCode. You receive the current workflow as an IRGraph JSON object plus a natural-language instruction (in Chinese or English). Return ONLY a single valid IRGraph JSON object (no markdown, no prose).

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
const DEFAULT_AI_CLI_IDLE_TIMEOUT_SECS: u64 = 300;
const CLI_ERROR_CONTEXT_LIMIT: usize = 1200;
/// Idle gap (no stdout activity) after which a "still running" heartbeat line is
/// emitted to the run log, so a long node never looks completely frozen even
/// during a long tool execution or a slow first token.
const AI_CLI_HEARTBEAT_SECS: u64 = 12;

/// Read the CLI timeout override from the environment, falling back to a
/// longer default so legitimate long-running workflows are less likely to be
/// killed too early.
fn configured_ai_cli_timeout_secs() -> u64 {
    std::env::var("FREEULTRACODE_AI_CLI_TIMEOUT_SECS")
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
/// Off by default (each cold `claude -p` spawn skips MCP init, saving ~2-4s of
/// startup per node); set FREEULTRACODE_ENABLE_MCP=1 to opt back in for
/// workflows whose nodes actually call an MCP tool.
fn mcp_enabled() -> bool {
    std::env::var("FREEULTRACODE_ENABLE_MCP")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false)
}

fn claude_bare_mode_disabled() -> bool {
    std::env::var("FREEULTRACODE_DISABLE_CLAUDE_BARE")
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
) -> Result<Option<TempFileGuard>, String> {
    let Some(settings) = env_vars.and_then(claude_gateway_settings_json) else {
        return Ok(None);
    };
    let path = temp_output_path("freeultracode-claude-settings", "json");
    let bytes =
        serde_json::to_vec(&settings).map_err(|e| format!("生成 Claude 临时配置失败: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("写入 Claude 临时配置失败: {e}"))?;
    Ok(Some(TempFileGuard::new(path)))
}

/// Whether to request token-level partial streaming from the claude CLI via
/// `--include-partial-messages`. On by default so assistant text + extended
/// thinking stream as they are generated (matching the interactive CLI's live
/// feel); the plain `-p` stream otherwise emits only one event per *completed*
/// message, leaving the run log blank while a single long answer is composed.
/// Set FREEULTRACODE_DISABLE_PARTIAL=1 if a CLI build predates the flag.
fn partial_enabled() -> bool {
    !std::env::var("FREEULTRACODE_DISABLE_PARTIAL")
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes"
        })
        .unwrap_or(false)
}

/// Read the no-progress timeout override. Set to 0 to disable idle detection.
fn configured_ai_cli_idle_timeout_secs() -> u64 {
    std::env::var("FREEULTRACODE_AI_CLI_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|secs| *secs == 0 || *secs >= 30)
        .unwrap_or(DEFAULT_AI_CLI_IDLE_TIMEOUT_SECS)
}

fn ai_cli_idle_timeout_secs(override_secs: Option<u64>) -> u64 {
    let configured = configured_ai_cli_idle_timeout_secs();
    if configured == 0 {
        return 0;
    }
    match override_secs.filter(|secs| *secs == 0 || *secs >= 30) {
        Some(0) => 0,
        Some(dynamic) => configured.max(dynamic),
        None => configured,
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

/// Summarize a `tool_use` event into one readable progress line, e.g.
/// `🔧 Bash: ls app/src` / `🔧 Glob: **/*.tsx` / `🔧 Read: app/src/core/ir.ts`,
/// so the run log shows *what* the agent is doing, not just the tool name.
/// Retained as a fallback / for the codex text path; the claude path now emits
/// structured `<<FUC_TOOL>>` sentinels instead.
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
fn encode_tool_patch(patch: &serde_json::Value) -> String {
    format!("\n<<FUC_TOOL>>{}<<FUC_TOOL_END>>\n", patch)
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

/// Codex CLI JSONL uses `item.completed` events rather than Claude's
/// `assistant` / `result` events. Emit readable agent text and a compact tool
/// breadcrumb when a tool-like item appears.
fn codex_progress_line(item: &serde_json::Value) -> Option<String> {
    let item_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if item_type == "agent_message" {
        return item
            .get("text")
            .and_then(|t| t.as_str())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string());
    }

    if item_type.is_empty() {
        return None;
    }

    let detail = [
        "command",
        "name",
        "path",
        "file_path",
        "query",
        "text",
        "status",
    ]
    .iter()
    .find_map(|k| {
        item.get(*k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.replace(['\n', '\r'], " "))
    })
    .unwrap_or_default();

    let detail: String = detail.chars().take(200).collect();
    if detail.is_empty() {
        Some(format!("\n🔧 {item_type}\n"))
    } else {
        Some(format!("\n🔧 {item_type}: {detail}\n"))
    }
}

fn codex_event_kind(event: &serde_json::Value) -> Option<&str> {
    event
        .get("method")
        .and_then(|m| m.as_str())
        .or_else(|| event.get("type").and_then(|t| t.as_str()))
}

fn codex_completed_item(event: &serde_json::Value) -> Option<&serde_json::Value> {
    match codex_event_kind(event) {
        Some("item.completed") | Some("item/completed") => {
            event.get("item").or_else(|| event.pointer("/params/item"))
        }
        _ => None,
    }
}

fn codex_turn_completion_status(event: &serde_json::Value) -> Option<String> {
    match codex_event_kind(event) {
        Some("turn.completed") | Some("turn/completed") | Some("turn_complete") => {
            let status = event
                .pointer("/params/turn/status")
                .or_else(|| event.pointer("/turn/status"))
                .or_else(|| event.get("status"))
                .and_then(|s| s.as_str())
                .unwrap_or("completed");
            Some(status.to_string())
        }
        _ => None,
    }
}

fn codex_status_success(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "completed" | "success" | "succeeded" | "ok"
    )
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
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let env_vars = normalize_spawn_env(env_vars);
        let progress_model_hint = gateway_progress_model_hint(env_vars.as_ref());
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
        let codex_last_message_path = if is_codex {
            Some(temp_output_path("freeultracode-codex-last", "txt"))
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

            if let Some(path) = codex_last_message_path.as_ref() {
                args.push("-o".into());
                args.push(path.to_string_lossy().to_string());
            }
            args.push("-".into());
        } else {
            // The prompt is fed via stdin (not a positional arg) so large
            // aggregation prompts can't hit the OS command-line length limit
            // (~32KB on Windows), which would stall the final "summary" node.
            args.push("-p".into());
            args.push("--output-format".into());
            args.push("stream-json".into());
            args.push("--verbose".into());
            // Free/relay channels inject their own Anthropic-compatible key and
            // base URL. Use Claude Code's minimal print mode there so user-level
            // plugins/hooks (especially SessionEnd hooks) cannot turn a
            // successful model call into exit=1.
            if should_run_claude_bare(env_vars.as_ref()) {
                args.push("--bare".into());
            }
            if let Some(settings_file) = write_claude_gateway_settings(env_vars.as_ref())? {
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

            // Skip loading the machine's global MCP servers for each node. A
            // workflow node is a short, bounded task that almost never needs
            // pencil/lark/etc., yet initialising every configured MCP server
            // costs ~2-4s of cold-start *per node* (measured) — paid N times
            // for an N-node run, while a single interactive session pays it
            // once. `--strict-mcp-config` with no `--mcp-config` means "use
            // only servers from the (absent) config", i.e. none. Opt back in
            // with FREEULTRACODE_ENABLE_MCP=1 for workflows that genuinely call
            // an MCP tool.
            if !mcp_enabled() {
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
        let progress_model_hint2 = progress_model_hint.clone();
        let codex_turn_status = Arc::new(Mutex::new(None::<String>));
        let codex_turn_status_reader = Arc::clone(&codex_turn_status);
        let codex_streamed_output = Arc::new(Mutex::new(String::new()));
        let codex_streamed_output_reader = Arc::clone(&codex_streamed_output);
        let stdout_activity = Arc::clone(&last_activity);
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
            if let Some(o) = stdout {
                let reader = std::io::BufReader::new(o);
                for line in reader.lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => break,
                    };
                    touch_activity(&stdout_activity);
                    if line.trim().is_empty() {
                        continue;
                    }
                    let v: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if parse_codex {
                        if let Some(status) = codex_turn_completion_status(&v) {
                            if let Ok(mut current) = codex_turn_status_reader.lock() {
                                *current = Some(status);
                            }
                            continue;
                        }
                        if let Some(item) = codex_completed_item(&v) {
                            if let Some(line) = codex_progress_line(item) {
                                acc.push_str(&line);
                                if let Ok(mut current) = codex_streamed_output_reader.lock() {
                                    current.push_str(&line);
                                }
                                emit_progress(&app2, &run2, &line);
                            }
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
                                emit_progress(&app2, &run2, &format!("{line}\n"));
                            } else if !requesting_done
                                && v.get("subtype").and_then(|s| s.as_str()) == Some("status")
                                && v.get("status").and_then(|s| s.as_str()) == Some("requesting")
                            {
                                // Between init and the first token the CLI is
                                // waiting on the model. Show it once so a slow
                                // first token reads as "requesting" rather than a
                                // silent gap padded by heartbeats.
                                requesting_done = true;
                                emit_progress(&app2, &run2, "⏳ 正在请求模型…\n");
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
                                                        emit_progress(&app2, &run2, "</think>");
                                                    }
                                                    prev_kind = "text";
                                                    emit_progress(&app2, &run2, tx);
                                                }
                                            }
                                            Some("thinking_delta") => {
                                                if let Some(tx) = delta
                                                    .get("thinking")
                                                    .and_then(|t| t.as_str())
                                                {
                                                    if prev_kind != "thinking" {
                                                        emit_progress(
                                                            &app2, &run2, "<think>",
                                                        );
                                                    }
                                                    prev_kind = "thinking";
                                                    emit_progress(&app2, &run2, tx);
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }
                        }
                        Some("assistant") => {
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
                                                        emit_progress(&app2, &run2, "</think>");
                                                    }
                                                    emit_progress(&app2, &run2, tx);
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
                                                emit_progress(&app2, &run2, "</think>");
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
                                            emit_progress(
                                                &app2,
                                                &run2,
                                                &encode_tool_patch(&patch),
                                            );
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
                                        emit_progress(&app2, &run2, "</think>");
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
                                        emit_progress(
                                            &app2,
                                            &run2,
                                            &encode_tool_patch(&patch),
                                        );
                                    }
                                }
                            }
                        }
                        Some("result") => {
                            if let Some(r) = v.get("result").and_then(|t| t.as_str()) {
                                result = r.to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
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
                            emit_progress(&app, &run_id, &format!("\n⏳ 仍在运行…（已 {total}s）\n"));
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
                        return Ok(terminal_output);
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
                    return Ok(terminal_output);
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
            Ok(WaitOutcome::Exited(status)) if status.success() => Ok(output),
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
                Ok(output)
            }
            Ok(WaitOutcome::CodexTurnCompleted(status)) => {
                let detail = if stderr.trim().is_empty() {
                    output.trim()
                } else {
                    stderr.trim()
                };
                Err(format!("CLI \"{binary}\" turn status {status}: {detail}"))
            }
            Ok(WaitOutcome::CodexLastMessageReady) => Ok(output),
        }
    })
    .await
    .map_err(|e| format!("CLI 任务调度失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "freeultracode-preview-test-{}-{}",
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
        let item = serde_json::json!({
            "type": "item.completed",
            "item": { "type": "agent_message", "text": "done" }
        });
        assert_eq!(
            codex_completed_item(&item)
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str()),
            Some("done")
        );

        let turn = serde_json::json!({
            "type": "turn.completed",
            "status": "completed"
        });
        assert_eq!(
            codex_turn_completion_status(&turn).as_deref(),
            Some("completed")
        );
    }

    #[test]
    fn parses_codex_method_events() {
        let item = serde_json::json!({
            "method": "item/completed",
            "params": { "item": { "type": "command_execution", "command": "npm test" } }
        });
        assert_eq!(
            codex_completed_item(&item)
                .and_then(|v| v.get("command"))
                .and_then(|v| v.as_str()),
            Some("npm test")
        );

        let turn = serde_json::json!({
            "method": "turn/completed",
            "params": { "turn": { "status": "completed" } }
        });
        assert_eq!(
            codex_turn_completion_status(&turn).as_deref(),
            Some("completed")
        );
    }

    #[test]
    fn codex_sidecar_output_ignores_empty_files() {
        let path = std::env::temp_dir().join(format!(
            "freeultracode-codex-sidecar-test-{}-{}.txt",
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
                .tooltip("FreeUltraCode")
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
            ai_edit_graph,
            run_workflow,
            run_ultracode,
            ai_cli,
            cancel_ai_cli,
            slash_catalog,
            scan_model_clis,
            validate_cli_path,
            validate_shell_path,
            free_channel_auto_keys,
            local_model_hardware,
            local_model_status,
            local_model_list,
            list_remote_models,
            setup_local_model,
            open_external,
            preview_local_file,
            save_clipboard_image,
            save_session_capture,
            fetch_capture_image_data_url,
            history::history_root,
            history::history_read_json,
            history::history_write_json,
            history::history_remove,
            history::history_list_dir,
            cc_switch_import::import_cc_switch_claude,
            free_proxy::free_proxy_ensure,
            free_proxy::free_proxy_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
