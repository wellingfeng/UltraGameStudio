use super::unreal::{hidden, Unreal};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread,
    time::{Duration, Instant},
};

pub(super) struct Adapter {
    pub path: PathBuf,
    pub attach: bool,
}

pub(super) const ATTACH_HINT: &str =
    "附加到运行中的编辑器需要 LLVM 20 或更新版本。可通过 UGS_LLDB_DAP 指定适配器路径。";

pub(super) fn availability(unreal: &Unreal) -> Result<Adapter, String> {
    if let Some(path) = env::var_os("UGS_LLDB_DAP").map(PathBuf::from) {
        if !path.is_absolute() || !path.is_file() {
            return Err("UGS_LLDB_DAP 未指向可用的本地调试适配器。".into());
        }
        return probe(path);
    }
    let dirs = env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .chain(env::var_os("ProgramFiles").map(|path| PathBuf::from(path).join("LLVM/bin")))
        .chain(
            unreal
                .engine
                .as_ref()
                .map(|path| path.join("Binaries/ThirdParty/LLVM/Win64/bin")),
        );
    let mut fallback = None;
    let mut error =
        "找不到 lldb-dap.exe。请安装 LLVM，或通过 UGS_LLDB_DAP 指定适配器路径。".to_owned();
    for path in dirs
        .map(|path| path.join("lldb-dap.exe"))
        .filter(|path| path.is_file())
    {
        match probe(path) {
            Ok(adapter) if adapter.attach => return Ok(adapter),
            Ok(adapter) => {
                if fallback.is_none() {
                    fallback = Some(adapter);
                }
            }
            Err(reason) => error = reason,
        }
    }
    fallback.ok_or(error)
}

fn probe(path: PathBuf) -> Result<Adapter, String> {
    let output = hidden(&path)
        .arg("--help")
        .output()
        .map_err(|error| format!("无法启动 lldb-dap：{error}"))?;
    if !output.status.success() {
        let code = output.status.code().unwrap_or_default() as u32;
        if code == 0xc000_0135 {
            return Err("lldb-dap 缺少运行时 DLL。请检查 LLVM 所需的 Python 或随附运行库。".into());
        }
        return Err(format!("lldb-dap 无法启动，退出码 {code:#010x}。"));
    }
    // Older LLDB calls DebugActiveProcessStop before continuing the synthetic
    // breakpoint event, which can terminate an attached Windows process.
    let attach = hidden(path.with_file_name("lldb.exe"))
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .find_map(|line| {
                    line.trim()
                        .strip_prefix("lldb version ")?
                        .split('.')
                        .next()?
                        .parse::<u32>()
                        .ok()
                })
        })
        .is_some_and(|major| major >= 20);
    Ok(Adapter { path, attach })
}

#[derive(Default, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(super) struct DebugView {
    pub phase: &'static str,
    pub attached: bool,
    pub reason: String,
    pub frames: Vec<Value>,
    pub variables: Vec<Value>,
    pub frame_id: Option<i64>,
}

pub(super) struct Debugger {
    child: Child,
    writer: Option<Box<dyn Write + Send>>,
    godot: Option<GodotSession>,
    deadline: Instant,
    messages: Receiver<Result<Value, String>>,
    seq: i64,
    pending: HashMap<i64, String>,
    inspection_request: Option<i64>,
    start: Option<(&'static str, Value)>,
    thread: Option<i64>,
    pause_thread: Option<i64>,
    pub view: DebugView,
    pub attached: bool,
    pub ended: bool,
}

struct GodotSession {
    editor_job: Option<isize>,
    game_command: Option<Command>,
    game: Option<super::Process>,
    retry_attach: Option<Instant>,
}

impl Debugger {
    pub fn start(unreal: &Unreal, game: bool, pid: Option<u32>) -> Result<Self, String> {
        let adapter = availability(unreal)?;
        if pid.is_some() && !adapter.attach {
            return Err(ATTACH_HINT.into());
        }
        let editor = unreal.editor().ok_or("找不到关联的 Unreal Editor。")?;
        let binary_dir = editor.parent().ok_or("Unreal Editor 路径无效。")?;
        let (request, args) = if let Some(pid) = pid {
            (
                "attach",
                json!({"program":editor, "pid":pid, "stopOnEntry":false}),
            )
        } else {
            (
                "launch",
                json!({"program":editor, "cwd":binary_dir, "args":unreal.arguments(game), "stopOnEntry":false}),
            )
        };
        let mut child = hidden(adapter.path)
            .current_dir(unreal.root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("启动 LLVM 调试适配器失败：{error}"))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        Self::connect(
            child,
            stdin,
            stdout,
            None,
            Some((request, args)),
            pid.is_some(),
        )
    }

    pub fn start_godot(editor: &Path, root: &Path) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| format!("无法分配 Godot 调试端口：{error}"))?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let remote = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| format!("无法分配 Godot 游戏调试端口：{error}"))?;
        let remote_address = remote.local_addr().map_err(|error| error.to_string())?;
        drop((listener, remote));
        let mut child = Command::new(editor)
            .current_dir(root)
            .arg("--editor")
            .arg("--path")
            .arg(root)
            .args(["--dap-port", &address.port().to_string()])
            .args(["--debug-server", &format!("tcp://{remote_address}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("启动 Godot 编辑器失败：{error}"))?;
        let job = crate::assign_child_to_kill_on_close_job(&child);
        let deadline = Instant::now() + Duration::from_secs(90);
        let connection = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Err(format!("Godot 编辑器提前退出：{status}")),
                Err(error) => break Err(format!("读取 Godot 编辑器状态失败：{error}")),
                Ok(None) => {}
            }
            if let Ok(stream) = TcpStream::connect_timeout(&address, Duration::from_millis(160)) {
                if super::owns_listener(address.port(), child.id())
                    && super::owns_listener(remote_address.port(), child.id())
                {
                    break stream
                        .try_clone()
                        .map(|reader| (stream, reader))
                        .map_err(|error| error.to_string());
                }
            }
            if Instant::now() >= deadline {
                break Err("Godot 编辑器未在分配端口启动调试服务。".into());
            }
            thread::sleep(Duration::from_millis(200));
        };
        let (writer, reader) = match connection {
            Ok(connection) => connection,
            Err(error) => {
                stop_editor(&mut child, job);
                return Err(error);
            }
        };
        let mut game_command = Command::new(editor);
        game_command
            .current_dir(root)
            .arg("--path")
            .arg(root)
            .args(["--remote-debug", &format!("tcp://{remote_address}")]);
        Self::connect(
            child,
            writer,
            reader,
            Some(GodotSession {
                editor_job: job,
                game_command: Some(game_command),
                game: None,
                retry_attach: None,
            }),
            None,
            false,
        )
    }

    fn connect(
        child: Child,
        writer: impl Write + Send + 'static,
        reader: impl Read + Send + 'static,
        godot: Option<GodotSession>,
        start: Option<(&'static str, Value)>,
        attached: bool,
    ) -> Result<Self, String> {
        let (sender, messages) = mpsc::sync_channel(256);
        thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            loop {
                match read_message(&mut reader) {
                    Ok(Some(message)) => {
                        if sender.send(Ok(message)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        break;
                    }
                }
            }
        });
        let adapter_id = if godot.is_some() { "godot" } else { "lldb" };
        let mut debugger = Self {
            child,
            writer: Some(Box::new(writer)),
            godot,
            deadline: Instant::now() + Duration::from_secs(90),
            messages,
            seq: 0,
            pending: HashMap::new(),
            inspection_request: None,
            start,
            thread: None,
            pause_thread: None,
            attached,
            ended: false,
            view: DebugView {
                phase: "starting",
                attached,
                ..Default::default()
            },
        };
        debugger.request("initialize", json!({"adapterID":adapter_id, "clientID":"ugs", "pathFormat":"path", "linesStartAt1":true, "columnsStartAt1":true}))?;
        Ok(debugger)
    }

    fn request(&mut self, command: &str, arguments: Value) -> Result<(), String> {
        self.seq += 1;
        let body =
            json!({"type":"request", "seq":self.seq, "command":command,"arguments":arguments})
                .to_string();
        let writer = self.writer.as_mut().ok_or("调试连接已结束。")?;
        write!(writer, "Content-Length: {}\r\n\r\n{}", body.len(), body)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("调试连接已断开：{error}"))?;
        self.pending.insert(self.seq, command.to_owned());
        Ok(())
    }

    pub fn poll(&mut self) -> Result<(), String> {
        if let Some(godot) = &mut self.godot {
            if let Some(game) = &mut godot.game {
                if let Some(status) = game.child.try_wait().map_err(|error| error.to_string())? {
                    self.ended = true;
                    if !status.success() || self.view.phase == "starting" {
                        return Err(format!("Godot 游戏进程退出，状态 {status}。"));
                    }
                    return Ok(());
                }
            }
            if self.view.phase == "starting" {
                if Instant::now() >= self.deadline {
                    return Err("Godot 游戏未连接 GDScript 调试，需检查项目导入和主场景。".into());
                }
                if godot
                    .retry_attach
                    .is_some_and(|retry| Instant::now() >= retry)
                {
                    godot.retry_attach = None;
                    self.request("attach", json!({}))?;
                }
            }
        }
        for _ in 0..256 {
            match self.messages.try_recv() {
                Ok(message) => self.message(message?)?,
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if !self.ended && self.view.phase == "starting" {
                        let code = self
                            .child
                            .try_wait()
                            .ok()
                            .flatten()
                            .and_then(|status| status.code());
                        return Err(match code {
                            Some(code) => {
                                format!("调试适配器提前退出，退出码 {:#010x}。", code as u32)
                            }
                            None => "调试适配器在初始化期间断开。".into(),
                        });
                    }
                    self.ended = true;
                    break;
                }
            }
        }
        Ok(())
    }

    fn message(&mut self, message: Value) -> Result<(), String> {
        let body = &message["body"];
        if message["type"] == "response" {
            let Some(sequence) = message["request_seq"].as_i64() else {
                return Ok(());
            };
            let Some(command) = self.pending.remove(&sequence) else {
                return Ok(());
            };
            if matches!(command.as_str(), "scopes" | "variables")
                && self.inspection_request != Some(sequence)
            {
                return Ok(());
            }
            if message["success"] != true {
                if command == "attach"
                    && message["message"] == "not_running"
                    && self.view.phase == "starting"
                {
                    if let Some(godot) = &mut self.godot {
                        godot.retry_attach = Some(Instant::now() + Duration::from_millis(240));
                        return Ok(());
                    }
                }
                if command == "pause" {
                    self.pause_thread = None;
                }
                let error = format!(
                    "{command}：{}",
                    message["message"].as_str().unwrap_or("调试请求失败")
                );
                if matches!(
                    command.as_str(),
                    "initialize" | "launch" | "attach" | "configurationDone"
                ) {
                    return Err(error);
                }
                self.view.reason = error;
                return Ok(());
            }
            match command.as_str() {
                "initialize" => {
                    if let Some((request, args)) = self.start.take() {
                        self.request(request, args)?;
                    }
                    if let Some(godot) = &mut self.godot {
                        let command = godot.game_command.take().ok_or("Godot 启动命令已使用。")?;
                        godot.game = Some(super::Process::spawn(command, "Godot 游戏", true)?);
                        self.request("attach", json!({}))?;
                    }
                }
                "attach" if self.godot.is_some() && self.view.phase == "starting" => {
                    self.view.phase = "running"
                }
                "configurationDone" if self.godot.is_none() && self.view.phase == "starting" => {
                    self.view.phase = "running"
                }
                "threads" if self.view.phase != "paused" => {
                    let thread = body["threads"]
                        .as_array()
                        .and_then(|threads| {
                            threads
                                .iter()
                                .find(|thread| {
                                    thread["name"]
                                        .as_str()
                                        .is_some_and(|name| name.contains("GameThread"))
                                })
                                .or(threads.first())
                        })
                        .and_then(|thread| thread["id"].as_i64());
                    self.request("pause", json!({"threadId":thread.unwrap_or(0)}))?;
                    self.pause_thread = thread;
                }
                "stackTrace" if self.view.phase == "paused" => {
                    self.view.frames = body["stackFrames"].as_array().cloned().unwrap_or_default();
                    if let Some(frame) = self
                        .view
                        .frames
                        .first()
                        .and_then(|frame| frame["id"].as_i64())
                    {
                        self.inspect(frame)?;
                    }
                }
                "scopes" if self.view.phase == "paused" => {
                    let scopes = body["scopes"].as_array();
                    let scope = scopes.and_then(|scopes| {
                        scopes
                            .iter()
                            .find(|scope| {
                                scope["presentationHint"] == "locals" || scope["name"] == "Locals"
                            })
                            .or(scopes.first())
                    });
                    if let Some(reference) = scope
                        .and_then(|scope| scope["variablesReference"].as_i64())
                        .filter(|reference| *reference > 0)
                    {
                        self.request(
                            "variables",
                            json!({"variablesReference":reference, "count":100}),
                        )?;
                        self.inspection_request = Some(self.seq);
                    }
                }
                "variables" if self.view.phase == "paused" => {
                    self.view.variables = body["variables"].as_array().cloned().unwrap_or_default()
                }
                "disconnect" => self.ended = true,
                _ => {}
            }
            return Ok(());
        }
        match message["event"].as_str().unwrap_or_default() {
            "initialized" if self.godot.is_none() => {
                self.request("configurationDone", json!({}))?;
            }
            "stopped" => {
                self.view.phase = "paused";
                self.view.reason = body["description"]
                    .as_str()
                    .or(body["reason"].as_str())
                    .unwrap_or_default()
                    .into();
                let manual_pause = self.pause_thread.take().filter(|_| {
                    matches!(body["reason"].as_str(), Some("pause" | "trace"))
                        || (body["reason"] == "exception"
                            && self.view.reason.contains("0x80000003"))
                });
                if manual_pause.is_some() {
                    self.view.reason = "手动暂停".into();
                }
                self.view.frame_id = None;
                self.view.frames.clear();
                self.view.variables.clear();
                self.thread = manual_pause.or_else(|| body["threadId"].as_i64());
                if let Some(thread) = self.thread {
                    self.request("stackTrace", json!({"threadId":thread, "levels":32}))?;
                }
            }
            "continued" => self.mark_running(),
            "terminated" if self.view.phase != "stopping" => self.ended = true,
            _ => {}
        }
        Ok(())
    }

    fn mark_running(&mut self) {
        self.view.phase = "running";
        self.view.frames.clear();
        self.view.variables.clear();
        self.view.frame_id = None;
        self.inspection_request = None;
        self.view.reason.clear();
    }

    pub fn inspect(&mut self, frame: i64) -> Result<(), String> {
        if self.view.phase != "paused"
            || !self
                .view
                .frames
                .iter()
                .any(|candidate| candidate["id"] == frame)
        {
            return Err("调用栈帧已失效。".into());
        }
        self.view.frame_id = Some(frame);
        self.view.variables.clear();
        self.request("scopes", json!({"frameId":frame}))?;
        self.inspection_request = Some(self.seq);
        Ok(())
    }

    pub fn control(&mut self, command: &str) -> Result<(), String> {
        match command {
            "disconnect" => {
                self.request(command, json!({"terminateDebuggee":!self.attached}))?;
                self.view.phase = "stopping";
            }
            "pause" if self.view.phase == "running" => self.request("threads", json!({}))?,
            "continue" | "next" | "stepIn" | "stepOut" if self.view.phase == "paused" => {
                let thread = self.thread.ok_or("调试器没有可继续的线程。")?;
                self.request(command, json!({"threadId":thread}))?;
            }
            _ => return Err("当前调试状态无法执行该操作。".into()),
        }
        Ok(())
    }
}

impl Drop for Debugger {
    fn drop(&mut self) {
        if let Some(mut godot) = self.godot.take() {
            if !self.ended && self.view.phase != "stopping" {
                let _ = self.control("disconnect");
            }
            self.writer.take();
            if let Some(game) = &mut godot.game {
                let _ = game.kill();
                let _ = game.child.wait();
            }
            stop_editor(&mut self.child, godot.editor_job);
            return;
        }
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        if !self.ended && self.view.phase != "stopping" {
            let _ = self.control("disconnect");
        }
        self.writer.take();
        if self.attached {
            // Adapter owns the detach handshake. Killing it can kill the editor.
            return;
        }
        for _ in 0..25 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn stop_editor(child: &mut Child, job: Option<isize>) {
    if let Some(job) = job {
        crate::kill_job_processes(job);
        crate::close_job_handle(job);
    } else {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut length = None;
    let mut header = String::new();
    loop {
        header.clear();
        if reader
            .read_line(&mut header)
            .map_err(|error| error.to_string())?
            == 0
        {
            return Ok(None);
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some(value) = header.strip_prefix("Content-Length:") {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let mut body = vec![
        0;
        length
            .filter(|length| *length <= 16 * 1024 * 1024)
            .ok_or("调试消息长度无效。")?
    ];
    reader
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| error.to_string())
}
