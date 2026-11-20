use super::{config::Project, dap::DebugView, owns_listener, Process};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    net::{Ipv4Addr, TcpStream},
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const HANDSHAKE: &[u8; 13] = b"DWP-Handshake";
const VM_VERSION: u8 = 1;
const VM_SUSPEND: u8 = 3;
const VM_RESUME: u8 = 4;
const VM_DISPOSE: u8 = 6;

pub(super) struct Debugger {
    process: Process,
    pub editor: PathBuf,
    log: PathBuf,
    deadline: Instant,
    next_probe: Instant,
    connection: Option<TcpStream>,
    sequence: u32,
    pub view: DebugView,
    pub ended: bool,
}

impl Debugger {
    pub fn start(project: &Project) -> Result<Self, String> {
        let editor = project
            .editor()
            .ok_or("找不到当前项目的 Unity 编辑器。")?
            .to_owned();
        let mut command = project.command(false)?;
        let directory = project.local_directory("logs")?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let log = directory.join(format!("unity-debug-{stamp}.log"));
        command
            .args(["-debugCodeOptimization", "-logFile"])
            .arg(&log);
        let process = Process::spawn(command, "Unity 编辑器", true)?;
        Ok(Self {
            process,
            editor,
            log,
            deadline: Instant::now() + Duration::from_secs(180),
            next_probe: Instant::now(),
            connection: None,
            sequence: 0,
            view: DebugView {
                phase: "starting",
                ..Default::default()
            },
            ended: false,
        })
    }

    pub fn poll(&mut self) -> Result<(), String> {
        if let Some(status) = self
            .process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
        {
            self.ended = true;
            if self.view.phase == "starting" || (!status.success() && !self.process.cancelled) {
                let code = status
                    .code()
                    .map_or_else(|| "未知".into(), |code| code.to_string());
                return Err(self.failure(&format!("Unity 编辑器退出，退出码 {code}。")));
            }
        }
        if self.view.phase != "starting" || Instant::now() < self.next_probe {
            return Ok(());
        }
        if Instant::now() >= self.deadline {
            return Err(self.failure("Unity 编辑器未开放 Mono 托管调试连接。"));
        }
        self.next_probe = Instant::now() + Duration::from_millis(650);
        let pid = self.process.child.id();
        let port = 56000 + (pid % 1000) as u16;
        if !owns_listener(port, pid) {
            return Ok(());
        }
        let Ok(mut stream) = TcpStream::connect_timeout(
            &(Ipv4Addr::LOCALHOST, port).into(),
            Duration::from_millis(500),
        ) else {
            return Ok(());
        };
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| error.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|error| error.to_string())?;
        let mut received = [0; HANDSHAKE.len()];
        stream
            .read_exact(&mut received)
            .map_err(|error| format!("读取 Unity Mono 握手失败：{error}"))?;
        if &received != HANDSHAKE {
            return Err("Unity 编辑器未返回有效的 Mono 调试握手。".into());
        }
        stream
            .write_all(HANDSHAKE)
            .map_err(|error| format!("回复 Unity Mono 握手失败：{error}"))?;
        self.connection = Some(stream);
        self.request(VM_VERSION)?;
        self.view.phase = "running";
        self.view.reason = "已连接 Unity 编辑器的 C# 调试器。".into();
        Ok(())
    }

    pub fn control(&mut self, command: &str) -> Result<(), String> {
        match command {
            "disconnect" => {
                if self.view.phase == "paused" {
                    let _ = self.request(VM_RESUME);
                }
                if self.connection.is_some() {
                    let _ = self.request(VM_DISPOSE);
                }
                self.connection = None;
                self.view.phase = "stopping";
                self.process.kill()?;
            }
            "pause" if self.view.phase == "running" => {
                self.request(VM_SUSPEND)?;
                self.view.phase = "paused";
                self.view.reason = "已暂停 Unity 托管线程。".into();
            }
            "continue" if self.view.phase == "paused" => {
                self.request(VM_RESUME)?;
                self.view.phase = "running";
                self.view.reason.clear();
            }
            _ => return Err("当前 Unity 调试会话不支持该操作。".into()),
        }
        Ok(())
    }

    fn request(&mut self, command: u8) -> Result<(), String> {
        let stream = self
            .connection
            .as_mut()
            .ok_or("Unity Mono 调试连接尚未建立。")?;
        self.sequence += 1;
        let mut packet = [0; 11];
        packet[..4].copy_from_slice(&11u32.to_be_bytes());
        packet[4..8].copy_from_slice(&self.sequence.to_be_bytes());
        packet[9] = 1; // VM command set
        packet[10] = command;
        let io_error = |error| format!("Unity Mono 调试连接失败：{error}");
        stream.write_all(&packet).map_err(io_error)?;
        for _ in 0..32 {
            stream.read_exact(&mut packet).map_err(io_error)?;
            let length = u32::from_be_bytes(packet[..4].try_into().unwrap());
            if !(11..=1024 * 1024).contains(&length) {
                return Err("Unity Mono 调试消息长度无效。".into());
            }
            let mut body = vec![0; length as usize - packet.len()];
            stream.read_exact(&mut body).map_err(io_error)?;
            if packet[8] != 0x80 || packet[4..8] != self.sequence.to_be_bytes() {
                continue;
            }
            let error = u16::from_be_bytes([packet[9], packet[10]]);
            return if error == 0 {
                Ok(())
            } else {
                Err(format!("Unity Mono 调试请求失败，错误码 {error}。"))
            };
        }
        Err("Unity Mono 未回复调试请求。".into())
    }

    fn failure(&self, message: &str) -> String {
        let text = File::open(&self.log)
            .and_then(|mut file| {
                let start = file.metadata()?.len().saturating_sub(16384);
                file.seek(SeekFrom::Start(start))?;
                let mut tail = Vec::new();
                file.take(16384).read_to_end(&mut tail)?;
                Ok(String::from_utf8_lossy(&tail).into_owned())
            })
            .unwrap_or_default();
        let detail = text.lines().rev().find_map(|line| {
            let line = line.to_ascii_lowercase();
            if line.contains("no valid unity editor license") || line.contains("no valid license") {
                Some("Unity 缺少有效授权，请在 Unity Hub 登录并激活授权。")
            } else if line.contains("another unity instance") {
                Some("当前项目已在另一个 Unity 编辑器中打开。")
            } else {
                None
            }
        });
        format!(
            "{message} {} 日志：{}",
            detail.unwrap_or_default(),
            self.log.display()
        )
    }
}

impl Drop for Debugger {
    fn drop(&mut self) {
        if !self.ended && self.view.phase != "stopping" {
            let _ = self.control("disconnect");
        }
        let _ = self.process.child.try_wait();
        if fs::metadata(&self.log).is_ok_and(|metadata| metadata.len() == 0) {
            let _ = fs::remove_file(&self.log);
        }
    }
}
