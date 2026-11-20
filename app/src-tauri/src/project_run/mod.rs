mod config;
mod dap;
mod unity;
mod unreal;

use config::Project;
use dap::{DebugView, Debugger};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};
use unreal::{canonical, hidden, Unreal};

type Sessions = Mutex<HashMap<PathBuf, Arc<Mutex<Session>>>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    engine: String,
    project: Option<String>,
    name: Option<String>,
    target: Option<String>,
    editor: Option<PathBuf>,
    installed: bool,
    build: bool,
    debugger: bool,
    attach: bool,
    pie: bool,
    profile: Option<Action>,
    issue: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    build: bool,
    cancel_build: bool,
    run: Option<&'static str>,
    pie: Option<&'static str>,
    debugger: Option<DebugView>,
    unity_debug_editor: Option<PathBuf>,
    notice: String,
    error: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Build,
    CancelBuild,
    Editor,
    Game,
    Pie,
    StopPie,
    StopRun,
    DebugEditor,
    DebugGame,
    Attach,
    Disconnect,
    Pause,
    Continue,
    Next,
    StepIn,
    StepOut,
    Restart,
    Frame,
}

struct Process {
    child: Child,
    kind: &'static str,
    job: Option<isize>,
    cancelled: bool,
}

impl Process {
    fn spawn(
        mut command: Command,
        kind: &'static str,
        kill_on_close: bool,
    ) -> Result<Self, String> {
        let child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("启动{kind}失败：{error}"))?;
        let job = kill_on_close
            .then(|| crate::assign_child_to_kill_on_close_job(&child))
            .flatten();
        Ok(Self {
            child,
            kind,
            job,
            cancelled: false,
        })
    }

    fn kill(&mut self) -> Result<(), String> {
        if let Some(job) = self.job {
            crate::kill_job_processes(job);
        } else if self
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_none()
        {
            self.child.kill().map_err(|error| error.to_string())?;
        }
        self.cancelled = true;
        Ok(())
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        if let Some(job) = self.job {
            crate::close_job_handle(job);
        }
    }
}

#[derive(Deserialize)]
struct RemoteStatus {
    #[serde(default)]
    connected: bool,
    #[serde(default)]
    playing: bool,
    #[serde(default)]
    pid: u32,
    error: Option<String>,
}

struct RemoteTask {
    child: Child,
    completion: std::sync::mpsc::Receiver<Result<Vec<u8>, std::io::Error>>,
    deadline: Instant,
}

impl RemoteTask {
    fn start(unreal: &Unreal, command: &str, expected_pid: Option<u32>) -> Result<Self, String> {
        let mut child = unreal
            .remote_command(command, expected_pid)?
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("启动 UE 编辑器连接失败：{error}"))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (sender, completion) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let result = stdout
                .take(128 * 1024)
                .read_to_end(&mut buffer)
                .map(|_| buffer);
            let _ = sender.send(result);
        });
        let timeout = if command == "wait-start" { 190 } else { 38 };
        Ok(Self {
            child,
            completion,
            deadline: Instant::now() + Duration::from_secs(timeout),
        })
    }

    fn poll(&mut self) -> Option<Result<RemoteStatus, String>> {
        use std::sync::mpsc::TryRecvError;
        match self.completion.try_recv() {
            Ok(result) => Some(result.map_err(|e| e.to_string()).and_then(|data| {
                let response: RemoteStatus =
                    serde_json::from_slice(&data).map_err(|_| "UE 编辑器连接未返回有效状态。")?;
                match response.error {
                    Some(error) => Err(error),
                    None => Ok(response),
                }
            })),
            Err(TryRecvError::Empty) if Instant::now() < self.deadline => None,
            Err(_) => Some(Err("UE 编辑器连接超时或已断开。".into())),
        }
    }
}

impl Drop for RemoteTask {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
fn editor_pid(unreal: &Unreal) -> Result<Option<u32>, String> {
    // Query only editor processes. Compare full project paths, including paths with spaces.
    let script = r#"
        $ErrorActionPreference = 'Stop'
        $project = [IO.Path]::GetFullPath($env:UGS_UNREAL_PROJECT)
        Get-CimInstance Win32_Process -Filter "Name LIKE 'UnrealEditor%.exe' OR Name LIKE 'UE4Editor%.exe'" | ForEach-Object {
            if (-not $_.CommandLine -or $_.CommandLine -match '(?i)(?:^|\s)-(?:game|server|run=\S+)(?:\s|$)') { return }
            $argument = [regex]::Matches($_.CommandLine, '"([^"]+)"|(\S+)') | Select-Object -Skip 1 -First 1
            $arg = if ($argument.Groups[1].Success) { $argument.Groups[1].Value } else { $argument.Groups[2].Value }
            if ($arg -notlike '*.uproject') { return }
            if (-not [IO.Path]::IsPathRooted($arg)) { $arg = Join-Path (Split-Path $_.ExecutablePath) $arg }
            if ([IO.Path]::GetFullPath($arg) -eq $project) { $_.ProcessId }
        }
    "#;
    let powershell =
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("找不到 Windows 系统目录。")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = hidden(powershell)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("UGS_UNREAL_PROJECT", &unreal.project)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("无法检查当前项目的 Unreal Editor 进程。".into());
    }
    let mut pids = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect::<Vec<u32>>();
    pids.dedup();
    match pids.as_slice() {
        [] => Ok(None),
        [pid] => Ok(Some(*pid)),
        _ => Err("当前项目有多个 Unreal Editor，无法唯一定位。".into()),
    }
}

#[cfg(not(windows))]
fn editor_pid(_: &Unreal) -> Result<Option<u32>, String> {
    Err("UE 运行与调试目前支持 Windows。".into())
}

struct LiveBuild {
    pid: u32,
    log: PathBuf,
    offset: u64,
    next_check: Instant,
    start_deadline: Option<Instant>,
}

impl LiveBuild {
    fn new(unreal: &Unreal, pid: u32) -> Self {
        let mut name = unreal
            .project
            .file_stem()
            .unwrap_or_default()
            .to_os_string();
        name.push(".log");
        let log = unreal.root().join("Saved/Logs").join(name);
        let offset = std::fs::metadata(&log).map_or(0, |metadata| metadata.len());
        Self {
            pid,
            log,
            offset,
            next_check: Instant::now(),
            start_deadline: Some(Instant::now() + Duration::from_secs(20)),
        }
    }

    fn poll(&mut self) -> Option<Result<&'static str, &'static str>> {
        let now = Instant::now();
        if now < self.next_check {
            return None;
        }
        self.next_check = now + Duration::from_millis(750);
        if !crate::process_is_alive(self.pid) {
            return Some(Err("编辑器已退出，Live Coding 结束。"));
        }
        if let Ok(metadata) = std::fs::metadata(&self.log) {
            let length = metadata.len();
            let added = length.saturating_sub(self.offset);
            if added > 0 {
                if let Some(tail) = crate::read_file_tail(&self.log, added.min(64 * 1024)) {
                    self.offset = length;
                    for line in tail.lines().filter_map(|line| {
                        line.split_once("LogLiveCoding:")
                            .map(|(_, message)| message.to_ascii_lowercase())
                    }) {
                        if line.contains("starting live coding compile") {
                            self.start_deadline = None;
                        }
                        if line.contains("live coding succeeded") {
                            return Some(Ok(if line.contains("no code changes") {
                                "Live Coding 完成，未检测到代码变更。"
                            } else {
                                "Live Coding 编译成功。"
                            }));
                        }
                        if line.contains("live coding canceled") {
                            return Some(Err("UE 已取消 Live Coding，请查看 Live Coding 控制台。"));
                        }
                        if line.contains("live coding failed")
                            || line.contains("unable to start live coding")
                        {
                            return Some(Err("Live Coding 编译失败，请查看 Live Coding 控制台。"));
                        }
                    }
                }
            }
        }
        self.start_deadline
            .filter(|deadline| now >= *deadline)
            .map(|_| Ok("已请求 Live Coding。请在 UE 日志中确认编译状态。"))
    }
}

#[derive(Default)]
struct Session {
    build: Option<Process>,
    live_build: Option<LiveBuild>,
    run: Option<Process>,
    remote: Option<(RemoteTask, &'static str)>,
    pie_pid: Option<u32>,
    pie_phase: Option<&'static str>,
    pie_check: Option<Instant>,
    pie_transition_deadline: Option<Instant>,
    pie_probe_failures: u8,
    debugger: Option<Debugger>,
    unity_debugger: Option<unity::Debugger>,
    unity_debug_editor: Option<PathBuf>,
    debug_game: bool,
    restart: bool,
    notice: String,
    error: String,
    monitoring: bool,
}

impl Session {
    fn building(&self) -> bool {
        self.build.is_some() || self.live_build.is_some()
    }

    fn process_completion(&mut self) {
        for slot in [&mut self.build, &mut self.run] {
            let Some(process) = slot else {
                continue;
            };
            match process.child.try_wait() {
                Ok(None) => continue,
                Ok(Some(status)) => {
                    self.notice = format!(
                        "{}退出，退出码 {}",
                        process.kind,
                        status
                            .code()
                            .map_or_else(|| "未知".into(), |code| code.to_string())
                    );
                    if process.cancelled {
                        self.notice = format!("已停止{}", process.kind);
                    } else if !status.success() {
                        self.error = self.notice.clone();
                    }
                }
                Err(error) => self.error = format!("读取{}状态失败：{error}", process.kind),
            }
            if self.pie_pid == Some(process.child.id()) {
                self.pie_pid = None;
                self.pie_phase = None;
            }
            *slot = None;
        }
    }

    fn tick(&mut self, project: &Project) {
        self.process_completion();
        if let Some(debugger) = &mut self.unity_debugger {
            if let Err(error) = debugger.poll() {
                self.error = error;
                self.unity_debugger = None;
                self.unity_debug_editor = None;
                self.restart = false;
            } else if debugger.ended {
                self.unity_debugger = None;
                if std::mem::take(&mut self.restart) {
                    if let Err(error) = self.start_other_debugger(project) {
                        self.error = error;
                    }
                }
            } else if debugger.view.phase == "running" {
                self.unity_debug_editor = Some(debugger.editor.clone());
            }
        }
        if let Some(debugger) = &mut self.debugger {
            if let Err(error) = debugger.poll() {
                self.error = error;
                debugger.ended = true;
            }
            if debugger.ended {
                self.debugger = None;
                if std::mem::take(&mut self.restart) {
                    let result = match &project.unreal {
                        Some(unreal) => self.start_debugger(unreal, self.debug_game, None),
                        None => self.start_other_debugger(project),
                    };
                    if let Err(error) = result {
                        self.error = error;
                    }
                }
            }
        }
        let Some(unreal) = &project.unreal else {
            return;
        };
        if let Some((remote, action)) = &mut self.remote {
            if let Some(result) = remote.poll() {
                let action = *action;
                self.remote = None;
                if action == "status" {
                    if result
                        .as_ref()
                        .is_ok_and(|status| status.connected && Some(status.pid) == self.pie_pid)
                    {
                        self.pie_probe_failures = 0;
                    } else {
                        self.pie_probe_failures += 1;
                        if self.pie_probe_failures < 3 {
                            self.pie_check = Some(Instant::now() + Duration::from_secs(3));
                            return;
                        }
                    }
                }
                match result {
                    Ok(status) if status.connected => match action {
                        "start" => {
                            self.pie_pid = Some(status.pid);
                            self.pie_probe_failures = 0;
                            self.pie_phase = Some(if status.playing {
                                "running"
                            } else {
                                "starting"
                            });
                            self.notice = "已请求开始 PIE".into();
                            self.pie_transition_deadline =
                                Some(Instant::now() + Duration::from_secs(45));
                        }
                        "stop" => {
                            self.pie_phase = Some("stopping");
                            self.notice = "已请求结束 PIE".into();
                            self.pie_transition_deadline =
                                Some(Instant::now() + Duration::from_secs(45));
                        }
                        "status" if Some(status.pid) == self.pie_pid => {
                            let transitioning = self
                                .pie_transition_deadline
                                .is_some_and(|deadline| Instant::now() < deadline);
                            if status.playing
                                && (self.pie_phase != Some("stopping") || !transitioning)
                            {
                                self.pie_phase = Some("running");
                                self.pie_transition_deadline = None;
                            } else if !status.playing
                                && (self.pie_phase != Some("starting") || !transitioning)
                            {
                                if self.pie_phase == Some("starting") {
                                    self.error = "编辑器未进入 PIE，请查看 UE 日志。".into();
                                }
                                self.pie_phase = None;
                                self.pie_pid = None;
                                self.pie_transition_deadline = None;
                            }
                        }
                        "status" => {
                            self.error = "原来的 PIE 编辑器连接已结束。".into();
                            self.pie_phase = None;
                            self.pie_pid = None;
                        }
                        "live" => self.notice = "已触发 Live Coding，正在等待编译结果。".into(),
                        _ => {}
                    },
                    Err(error) => {
                        self.error = error;
                        if action == "live" {
                            self.live_build = None;
                        } else {
                            self.pie_phase = None;
                            self.pie_pid = None;
                        }
                    }
                    _ => {
                        self.error =
                            "找不到当前项目的 UE Python Remote Execution。请检查编辑器和项目设置。"
                                .into();
                        if action == "live" {
                            self.live_build = None;
                        } else {
                            self.pie_phase = None;
                            self.pie_pid = None;
                        }
                    }
                }
                let interval = if self.pie_phase == Some("running") {
                    5
                } else {
                    1
                };
                self.pie_check = Some(Instant::now() + Duration::from_secs(interval));
            }
        }
        if self
            .remote
            .as_ref()
            .map_or(true, |(_, action)| *action != "live")
        {
            if let Some(result) = self.live_build.as_mut().and_then(LiveBuild::poll) {
                self.live_build = None;
                match result {
                    Ok(message) => self.notice = message.into(),
                    Err(message) => self.error = message.into(),
                }
            }
        }
        if self.pie_pid.is_some()
            && self.remote.is_none()
            && !self
                .debugger
                .as_ref()
                .is_some_and(|debugger| debugger.view.phase == "paused")
            && self.pie_check.is_some_and(|due| Instant::now() >= due)
        {
            match RemoteTask::start(unreal, "status", self.pie_pid) {
                Ok(remote) => self.remote = Some((remote, "status")),
                Err(error) => {
                    self.error = error;
                    self.pie_check = None;
                }
            }
        }
    }

    fn view(&self) -> Status {
        Status {
            build: self.building(),
            cancel_build: self.build.is_some(),
            run: self.run.as_ref().map(|process| process.kind),
            pie: self.pie_phase,
            debugger: self
                .debugger
                .as_ref()
                .map(|debugger| debugger.view.clone())
                .or_else(|| {
                    self.unity_debugger
                        .as_ref()
                        .map(|debugger| debugger.view.clone())
                }),
            notice: self.notice.clone(),
            error: self.error.clone(),
            unity_debug_editor: self.unity_debug_editor.clone(),
        }
    }

    fn start_editor(&mut self, unreal: &Unreal, game: bool) -> Result<(), String> {
        if self.run.is_some() || self.debugger.is_some() || self.building() {
            return Err("请先结束当前运行、调试或编译任务。".into());
        }
        let editor = unreal.editor().ok_or("找不到关联的 Unreal Editor。")?;
        let kind = if game { "独立游戏" } else { "编辑器" };
        let mut command = Command::new(&editor);
        command
            .current_dir(editor.parent().ok_or("Unreal Editor 路径无效。")?)
            .args(unreal.arguments(game));
        self.run = Some(Process::spawn(command, kind, game)?);
        self.notice = format!("已启动{kind}");
        Ok(())
    }

    fn start_debugger(
        &mut self,
        unreal: &Unreal,
        game: bool,
        pid: Option<u32>,
    ) -> Result<(), String> {
        if self.debugger.is_some() || self.building() || (pid.is_none() && self.run.is_some()) {
            return Err("请先结束当前运行、调试或编译任务。".into());
        }
        self.debugger = Some(Debugger::start(unreal, game, pid)?);
        self.debug_game = game;
        self.notice = if pid.is_some() {
            "正在附加 C++ 调试器"
        } else {
            "正在启动 C++ 调试"
        }
        .into();
        Ok(())
    }

    fn action(
        &mut self,
        unreal: &Unreal,
        action: Action,
        frame: Option<i64>,
    ) -> Result<(), String> {
        match action {
            Action::Build => {
                if self.building()
                    || self
                        .remote
                        .as_ref()
                        .is_some_and(|(_, action)| *action != "status")
                    || self.run.as_ref().is_some_and(|run| run.kind == "独立游戏")
                    || self
                        .debugger
                        .as_ref()
                        .is_some_and(|debugger| debugger.view.phase != "running" || self.debug_game)
                {
                    return Err("运行状态暂无法编译，请先结束当前操作。".into());
                }
                if let Some(pid) = editor_pid(unreal)? {
                    let live_build = LiveBuild::new(unreal, pid);
                    self.remote = Some((RemoteTask::start(unreal, "live", Some(pid))?, "live"));
                    self.live_build = Some(live_build);
                    self.notice = "正在连接当前项目的 Live Coding".into();
                } else {
                    self.build = Some(Process::spawn(unreal.build_command()?, "编译", true)?);
                    self.notice = format!(
                        "正在编译 {} · Win64 Development",
                        unreal.target.as_deref().unwrap_or_default()
                    );
                }
            }
            Action::CancelBuild => {
                self.build
                    .as_mut()
                    .ok_or("当前没有可取消的离线编译。")?
                    .kill()?;
            }
            Action::Editor | Action::DebugEditor => {
                if editor_pid(unreal)?.is_some() {
                    return Err("当前项目的编辑器已运行，使用 PIE 或附加调试。".into());
                }
                if matches!(action, Action::Editor) {
                    self.start_editor(unreal, false)?;
                } else {
                    self.start_debugger(unreal, false, None)?;
                }
            }
            Action::Game => self.start_editor(unreal, true)?,
            Action::DebugGame => self.start_debugger(unreal, true, None)?,
            Action::Pie => {
                if self.remote.is_some()
                    || self.building()
                    || self
                        .debugger
                        .as_ref()
                        .is_some_and(|debugger| debugger.view.phase != "running" || self.debug_game)
                {
                    return Err("当前状态无法启动 PIE。".into());
                }
                let pid = editor_pid(unreal)?;
                if pid.is_none() {
                    self.start_editor(unreal, false)?;
                }
                self.remote = Some((
                    RemoteTask::start(
                        unreal,
                        if pid.is_some() { "start" } else { "wait-start" },
                        pid.or_else(|| self.run.as_ref().map(|run| run.child.id())),
                    )?,
                    "start",
                ));
                self.pie_phase = Some("starting");
                self.notice = "等待编辑器启动 PIE".into();
            }
            Action::StopPie => {
                if self.pie_phase == Some("starting") && self.pie_pid.is_none() {
                    self.remote = None;
                    self.pie_phase = None;
                } else if self.pie_pid.is_some() {
                    self.remote = Some((RemoteTask::start(unreal, "stop", self.pie_pid)?, "stop"));
                    self.pie_phase = Some("stopping");
                } else {
                    return Err("没有由工具栏运行的 PIE 会话。".into());
                }
            }
            Action::StopRun => {
                let process = self.run.as_mut().ok_or("当前没有 UGS 启动的运行进程。")?;
                if process.kind == "编辑器" {
                    let output = hidden("taskkill.exe")
                        .args(["/PID", &process.child.id().to_string()])
                        .output()
                        .map_err(|e| e.to_string())?;
                    if !output.status.success() {
                        return Err("无法请求编辑器关闭，请检查编辑器窗口。".into());
                    }
                    self.notice = "已请求关闭编辑器，请处理编辑器中的保存提示。".into();
                } else {
                    process.kill()?;
                }
            }
            Action::Attach => {
                let pid = editor_pid(unreal)?.ok_or("请先启动当前项目的 Unreal Editor。")?;
                self.start_debugger(unreal, false, Some(pid))?;
            }
            Action::Frame => self
                .debugger
                .as_mut()
                .ok_or("调试会话已结束。")?
                .inspect(frame.ok_or("缺少调用栈帧。")?)?,
            Action::Restart => {
                let debugger = self.debugger.as_mut().ok_or("调试会话已结束。")?;
                if debugger.attached {
                    return Err("附加的编辑器可以断开调试连接。".into());
                }
                debugger.control("disconnect")?;
                self.restart = true;
            }
            Action::Disconnect
            | Action::Pause
            | Action::Continue
            | Action::Next
            | Action::StepIn
            | Action::StepOut => {
                self.debugger
                    .as_mut()
                    .ok_or("调试会话已结束。")?
                    .control(control_command(action))?;
            }
        }
        Ok(())
    }

    fn start_other_debugger(&mut self, project: &Project) -> Result<(), String> {
        if self.run.is_some() || self.debugger.is_some() || self.unity_debugger.is_some() {
            return Err("请先结束当前运行或调试。".into());
        }
        if project.is_godot() {
            project.command(true)?;
            self.debugger = Some(Debugger::start_godot(
                project.editor().ok_or("Godot 编辑器不可用。")?,
                project.root(),
            )?);
        } else if project.is_unity() {
            self.unity_debugger = Some(unity::Debugger::start(project)?);
        } else {
            return Err("当前引擎暂无调试适配。".into());
        }
        self.notice = "正在启动项目调试".into();
        Ok(())
    }

    fn action_other(
        &mut self,
        project: &Project,
        action: Action,
        frame: Option<i64>,
    ) -> Result<(), String> {
        match action {
            Action::Editor | Action::Game
                if project.is_godot() || (project.is_unity() && action == Action::Editor) =>
            {
                if self.run.is_some() || self.debugger.is_some() || self.unity_debugger.is_some() {
                    return Err("请先结束当前运行或调试。".into());
                }
                let game = action == Action::Game;
                self.run = Some(Process::spawn(
                    project.command(game)?,
                    if game { "游戏" } else { "编辑器" },
                    true,
                )?);
                self.notice = "已启动项目".into();
            }
            Action::DebugEditor if project.is_unity() => self.start_other_debugger(project)?,
            Action::DebugGame if project.is_godot() => self.start_other_debugger(project)?,
            Action::StopRun => {
                self.run
                    .as_mut()
                    .ok_or("当前没有 UGS 启动的运行进程。")?
                    .kill()?;
            }
            Action::Frame => self
                .debugger
                .as_mut()
                .ok_or("没有可查看的调用栈。")?
                .inspect(frame.ok_or("缺少调用栈帧。")?)?,
            Action::Restart => {
                self.control_other("disconnect")?;
                self.restart = true;
            }
            Action::Disconnect
            | Action::Pause
            | Action::Continue
            | Action::Next
            | Action::StepIn
            | Action::StepOut => {
                self.control_other(control_command(action))?;
            }
            _ => return Err("当前项目引擎不支持该操作。".into()),
        }
        Ok(())
    }

    fn control_other(&mut self, command: &str) -> Result<(), String> {
        if let Some(debugger) = &mut self.unity_debugger {
            return debugger.control(command);
        }
        self.debugger
            .as_mut()
            .ok_or("调试会话已结束。")?
            .control(command)
    }
}

fn control_command(action: Action) -> &'static str {
    match action {
        Action::Disconnect => "disconnect",
        Action::Pause => "pause",
        Action::Continue => "continue",
        Action::Next => "next",
        Action::StepIn => "stepIn",
        Action::StepOut => "stepOut",
        _ => unreachable!(),
    }
}

#[cfg(windows)]
fn owns_listener(port: u16, pid: u32) -> bool {
    let Ok(output) = hidden("netstat.exe").arg("-ano").output() else {
        return false;
    };
    let port = format!(":{port}");
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next() == Some("TCP")
            && fields.next().is_some_and(|local| local.ends_with(&port))
            && fields.next().is_some_and(|remote| remote.ends_with(":0"))
            && fields.nth(1).and_then(|owner| owner.parse().ok()) == Some(pid)
    })
}

#[cfg(not(windows))]
fn owns_listener(_: u16, _: u32) -> bool {
    false
}

static SESSIONS: OnceLock<Sessions> = OnceLock::new();
static PROJECTS: OnceLock<Mutex<HashMap<PathBuf, Arc<Project>>>> = OnceLock::new();

fn root(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(crate::project_expand_path_text(path));
    if !path.is_absolute() || !path.is_dir() {
        return Err("运行和调试需要本地工作区。".into());
    }
    canonical(&path).map_err(|error| format!("无法读取工作区：{error}"))
}

fn project(root: &Path, refresh: bool) -> Result<Arc<Project>, String> {
    let projects = PROJECTS.get_or_init(Default::default);
    if !refresh {
        if let Some(project) = projects.lock().map_err(|_| "项目缓存不可用。")?.get(root) {
            return Ok(project.clone());
        }
    }
    let project = Arc::new(Project::detect(root));
    projects
        .lock()
        .map_err(|_| "项目缓存不可用。")?
        .insert(root.to_owned(), project.clone());
    Ok(project)
}

fn session(root: &Path) -> Result<Arc<Mutex<Session>>, String> {
    Ok(SESSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "项目运行服务不可用。")?
        .entry(root.to_owned())
        .or_default()
        .clone())
}

fn monitor(session: Arc<Mutex<Session>>, project: Arc<Project>) {
    thread::spawn(move || loop {
        let Ok(mut state) = session.lock() else {
            break;
        };
        state.tick(&project);
        if !state.building()
            && state.run.is_none()
            && state.remote.is_none()
            && state.pie_phase.is_none()
            && state.debugger.is_none()
            && state.unity_debugger.is_none()
        {
            state.monitoring = false;
            break;
        }
        drop(state);
        thread::sleep(Duration::from_millis(120));
    });
}

pub fn shutdown() {
    let Some(sessions) = SESSIONS.get() else {
        return;
    };
    let Ok(sessions) = sessions.lock() else {
        return;
    };
    for session in sessions.values() {
        if let Ok(mut session) = session.lock() {
            session.restart = false;
            session.debugger = None;
            session.unity_debugger = None;
            session.remote = None;
            session.pie_phase = None;
            session.pie_pid = None;
            session.build = None;
            session.live_build = None;
            session.run = None;
        }
    }
}

#[tauri::command]
pub async fn project_run_info(
    window: tauri::Webview,
    workspace: String,
) -> Result<ProjectInfo, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&workspace)?;
        Ok(project(&root, true)?.info())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_run_status(
    window: tauri::Webview,
    workspace: String,
) -> Result<Status, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&workspace)?;
        let session = session(&root)?;
        let session = session.lock().map_err(|_| "项目运行状态不可用。")?;
        Ok(session.view())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_run_action(
    window: tauri::Webview,
    workspace: String,
    action: Action,
    frame: Option<i64>,
) -> Result<Status, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        run_action(&registered_root(&workspace)?, action, frame)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn registered_root(workspace: &str) -> Result<PathBuf, String> {
    let root = root(workspace)?;
    if crate::storage_paths::known_workspace_roots()
        .iter()
        .any(|path| canonical(path).is_ok_and(|path| path == root))
    {
        return Ok(root);
    }
    Err("项目运行与调试需要已登记的本地工作区。".into())
}

fn run_action(root: &Path, action: Action, frame: Option<i64>) -> Result<Status, String> {
    let latest = matches!(
        action,
        Action::Editor
            | Action::Game
            | Action::DebugEditor
            | Action::DebugGame
            | Action::Pie
            | Action::Attach
    );
    let project = project(root, latest)?;
    let session = session(root)?;
    let mut state = session.lock().map_err(|_| "项目运行状态不可用。")?;
    state.tick(&project);
    let result = if let Some(unreal) = &project.unreal {
        state.action(unreal, action, frame)
    } else {
        state.action_other(&project, action, frame)
    };
    match result {
        Ok(()) => state.error.clear(),
        Err(error) => {
            state.error = error.clone();
            return Err(error);
        }
    }
    if !state.monitoring {
        state.monitoring = true;
        monitor(session.clone(), project);
    }
    Ok(state.view())
}

#[tauri::command]
pub async fn project_run_setup(
    window: tauri::Webview,
    workspace: String,
) -> Result<config::Setup, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = registered_root(&workspace)?;
        let launch_error = session(&root)?
            .lock()
            .map_err(|_| "项目运行状态不可用。")?
            .error
            .clone();
        Ok(project(&root, true)?.setup(launch_error))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_run_apply_setup(
    window: tauri::Webview,
    workspace: String,
    selection: config::Selection,
) -> Result<ProjectInfo, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = registered_root(&workspace)?;
        let session = session(&root)?;
        let state = session.lock().map_err(|_| "项目运行状态不可用。")?;
        if state.monitoring {
            return Err("请先结束当前运行、调试或编译。".into());
        }
        project(&root, true)?.apply(selection)?;
        Ok(project(&root, true)?.info())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn project_run_save_profile(
    window: tauri::Webview,
    workspace: String,
    profile: Action,
) -> Result<ProjectInfo, String> {
    crate::require_skill_app(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = registered_root(&workspace)?;
        let session = session(&root)?;
        let _state = session.lock().map_err(|_| "项目运行状态不可用。")?;
        project(&root, true)?.save_profile(profile)?;
        Ok(project(&root, true)?.info())
    })
    .await
    .map_err(|error| error.to_string())?
}
