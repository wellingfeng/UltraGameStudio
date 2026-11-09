use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use crate::native_background::{self, PipeWriter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const IDS: [&str; 4] = ["feishu", "wechat", "wecom", "dingtalk"];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct PlatformConfig {
    pub id: String,
    pub enabled: bool,
    pub app_id: String,
    pub account_id: String,
    pub base_url: String,
    pub allowed_users: Vec<String>,
    pub allow_all_users: bool,
    pub group_mention_only: bool,
    pub workspace_id: String,
    pub notify_on_completion: bool,
    pub has_secret: bool,
}
impl Default for PlatformConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: false,
            app_id: String::new(),
            account_id: String::new(),
            base_url: "https://ilinkai.weixin.qq.com".into(),
            allowed_users: vec![],
            allow_all_users: false,
            group_mention_only: true,
            workspace_id: String::new(),
            notify_on_completion: false,
            has_secret: false,
        }
    }
}
fn validate_id(id: &str) -> Result<(), String> {
    if IDS.contains(&id) {
        Ok(())
    } else {
        Err("未知消息平台。".into())
    }
}
fn config_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}
fn read_configs() -> Result<Vec<PlatformConfig>, String> {
    let path = crate::storage_paths::global_root()?.join("settings/messagePlatforms.v1.json");
    if !path.exists() {
        return Ok(IDS
            .iter()
            .map(|id| PlatformConfig {
                id: id.to_string(),
                ..Default::default()
            })
            .collect());
    }
    let saved: Vec<PlatformConfig> =
        serde_json::from_slice(&std::fs::read(path).map_err(|_| "读取消息平台配置失败。")?)
            .map_err(|_| "消息平台配置格式错误。")?;
    Ok(IDS
        .iter()
        .map(|id| {
            saved
                .iter()
                .find(|c| c.id == *id)
                .cloned()
                .unwrap_or_else(|| PlatformConfig {
                    id: id.to_string(),
                    ..Default::default()
                })
        })
        .collect())
}
fn write_config(config: PlatformConfig) -> Result<(), String> {
    let _lock = config_lock().lock().map_err(|_| "消息平台配置锁失败。")?;
    let mut configs = read_configs()?;
    let index = configs
        .iter()
        .position(|c| c.id == config.id)
        .ok_or("未知消息平台。")?;
    configs[index] = config;
    let path = crate::storage_paths::global_root()?.join("settings/messagePlatforms.v1.json");
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "创建消息平台配置目录失败。")?;
    let staged = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&configs).map_err(|_| "编码消息平台配置失败。")?;
    std::fs::write(&staged, bytes).map_err(|_| "暂存消息平台配置失败。")?;
    std::fs::rename(&staged, &path).map_err(|_| "保存消息平台配置失败。".to_string())
}
fn secret_key(id: &str) -> String {
    format!("ugs.message-platform.{id}")
}
async fn read_secret(id: &str) -> Result<String, String> {
    let key = secret_key(id);
    Ok(
        crate::secure_store::secure_secret_get_many(vec![key.clone()])
            .await?
            .remove(&key)
            .unwrap_or_default(),
    )
}

type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>;
#[derive(Default)]
struct GatewayStatusCache {
    values: HashMap<String, Value>,
    current: Option<(Arc<AtomicU64>, u64)>,
}
impl std::ops::Deref for GatewayStatusCache {
    type Target = HashMap<String, Value>;
    fn deref(&self) -> &Self::Target { &self.values }
}
impl std::ops::DerefMut for GatewayStatusCache {
    fn deref_mut(&mut self) -> &mut Self::Target { &mut self.values }
}
fn gateway_statuses() -> &'static Arc<Mutex<GatewayStatusCache>> {
    static STATUSES: OnceLock<Arc<Mutex<GatewayStatusCache>>> = OnceLock::new();
    STATUSES.get_or_init(Default::default)
}
#[derive(Default)]
struct GatewayCleanupOwner {
    child: Option<Child>,
    job: Option<isize>,
    stdin: Option<Arc<PipeWriter>>,
    reader: Option<std::thread::JoinHandle<()>>,
    unknown: bool,
    #[cfg(test)]
    deny_kill: bool,
}
impl native_background::lifecycle::Cleanup for GatewayCleanupOwner {
    fn poll(&mut self) -> bool {
        if let Some(child) = &mut self.child {
            #[cfg(test)]
            let kill = !self.deny_kill;
            #[cfg(not(test))]
            let kill = true;
            if kill {
                let _ = child.kill();
            }
            match child.try_wait() {
                Ok(Some(_)) => {
                    self.child.take();
                }
                _ => return false,
            }
        }
        if let Some(reader) = self.reader.as_ref() {
            if !reader.is_finished() {
                return false;
            }
        }
        if let Some(reader) = self.reader.take() {
            if reader.join().is_err() {
                self.unknown = true;
                return false;
            }
        }
        if let Some(stdin) = self.stdin.as_ref() {
            if !stdin.cleanup_complete() {
                return false;
            }
            self.stdin.take();
        }
        // Job/process-tree/request retirement evidence remains unestablished.
        !self.unknown && self.job.is_none() && self.stdin.is_none()
    }
}
type GatewayRoot = native_background::lifecycle::CleanupRoot<GatewayCleanupOwner>;
fn gateway_root() -> &'static Arc<GatewayRoot> {
    static ROOT: OnceLock<Arc<GatewayRoot>> = OnceLock::new();
    ROOT.get_or_init(GatewayRoot::new)
}
pub struct GatewayState {
    root: Arc<GatewayRoot>,
    root_key: Option<u64>,
    unknown_obligations: bool,
    #[cfg(test)]
    deny_kill: bool,
    child: Option<Child>,
    job: Option<isize>,
    stdin: Option<Arc<PipeWriter>>,
    pending: Pending,
    reader: Option<std::thread::JoinHandle<()>>,
    statuses: Arc<Mutex<GatewayStatusCache>>,
    sequence: u64,
    generation: Arc<AtomicU64>,
    ready_generation: u64,
}
impl Default for GatewayState {
    fn default() -> Self {
        Self {
            root: gateway_root().clone(),
            root_key: None,
            unknown_obligations: true,
            #[cfg(test)]
            deny_kill: false,
            child: None,
            job: None,
            stdin: None,
            pending: Default::default(),
            reader: None,
            statuses: gateway_statuses().clone(),
            sequence: 0,
            generation: Default::default(),
            ready_generation: 0,
        }
    }
}
impl GatewayState {
    fn invalidate_publication(&self) {
        let mut cache = self.statuses.lock().unwrap_or_else(|e| e.into_inner());
        self.generation.fetch_add(1, Ordering::SeqCst);
        if cache.current.as_ref().is_some_and(|(active, _)| Arc::ptr_eq(active, &self.generation)) {
            cache.current = None;
        }
    }
    fn clear_transport(&mut self) -> native_background::lifecycle::CleanupState {
        #[cfg(test)]
        let deny = self.deny_kill;
        #[cfg(not(test))]
        let deny = false;
        self.clear_transport_with_kill(|child| {
            if deny {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "owned fixture kill fault",
                ))
            } else {
                child.kill()
            }
        })
    }
    fn clear_transport_with_kill(
        &mut self,
        mut kill: impl FnMut(&mut Child) -> std::io::Result<()>,
    ) -> native_background::lifecycle::CleanupState {
        self.invalidate_publication();
        self.ready_generation = 0;
        if let Some(stdin) = &self.stdin {
            stdin.close();
        }
        if let Ok(mut requests) = self.pending.lock() {
            for (_, sender) in requests.drain() {
                let _ = sender.send(Err("消息网关已关闭。".into()));
            }
        }
        let Some(key) = self.root_key else {
            return self.root.state();
        };
        self.root.pending(key);
        if let Some(child) = &mut self.child {
            let _ = kill(child);
            if native_background::wait_child_until(
                child,
                std::time::Instant::now() + Duration::from_millis(500),
            )
            .is_ok()
            {
                self.child.take();
            }
        }
        if self.child.is_none()
            && !self.unknown_obligations
            && self.job.is_none()
            && self.stdin.is_none()
            && self.reader.is_none()
            && self.root.release_empty(key)
        {
            self.root_key = None;
        }
        self.root.state()
    }
}
impl GatewayState {
    fn handoff_cleanup(&mut self) {
        self.invalidate_publication();
        if let Some(stdin) = &self.stdin {
            stdin.close();
        }
        if let Some(key) = self.root_key.take() {
            self.root.handoff(key, |owner| {
                owner.child = self.child.take();
                owner.job = self.job.take();
                owner.stdin = self.stdin.take();
                owner.reader = self.reader.take();
                owner.unknown = self.unknown_obligations;
                #[cfg(test)]
                {
                    owner.deny_kill = self.deny_kill;
                }
            });
        }
    }
}
impl Drop for GatewayState {
    fn drop(&mut self) {
        self.handoff_cleanup();
    }
}
fn gateway() -> &'static Mutex<GatewayState> {
    static STATE: OnceLock<Mutex<GatewayState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(GatewayState::default()))
}
fn gateway_io_gate() -> &'static Mutex<()> {
    static GATE: Mutex<()> = Mutex::new(());
    &GATE
}
pub async fn shutdown() -> Result<(), String> {
    // async fn: published at first poll, before bounded-lane admission.
    gateway_root().draining();
    native_background::run_bounded(
        native_background::control_lane(),
        Duration::from_secs(3),
        move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let _io = loop {
                if let Ok(guard) = gateway_io_gate().try_lock() {
                    break guard;
                }
                if std::time::Instant::now() >= deadline {
                    return Err("消息网关清理繁忙，未退出。".into());
                }
                std::thread::sleep(Duration::from_millis(5));
            };
            {
                let mut state = gateway().lock().map_err(|_| "消息网关锁失败。")?;
                state.handoff_cleanup();
            }
            // No state lock during process polling. The reserved cell remains owned.
            let cleanup_deadline = std::time::Instant::now() + Duration::from_millis(500);
            loop {
                match gateway_root().state() {
                    native_background::lifecycle::CleanupState::Vacant
                    | native_background::lifecycle::CleanupState::Stopped(_) => return Ok(()),
                    native_background::lifecycle::CleanupState::Pending(key) => {
                        if std::time::Instant::now() >= cleanup_deadline {
                            return Err(format!("消息网关清理 Pending({key})，未确认全部退出。"));
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        },
    )
    .await
}
fn start_gateway_process(
    state: &mut GatewayState,
    spawn: impl FnOnce() -> Result<Child, String>,
    writer: impl FnOnce(ChildStdin) -> Result<Arc<PipeWriter>, String>,
) -> Result<Option<(ChildStdout, u64)>, String> {
    state.root.check_open()?;
    #[cfg(windows)]
    {
        let _ = (spawn, writer);
        Err("消息网关强 containment 尚未实现，拒绝创建进程。".into())
    }
    #[cfg(not(windows))]
    {
        if state.stdin.is_some()
            && state.ready_generation == state.generation.load(Ordering::SeqCst)
        {
            if let Some(child) = &mut state.child {
                if child
                    .try_wait()
                    .map_err(|_| "检查消息网关进程失败。")?
                    .is_none()
                {
                    return Ok(None);
                }
            }
        }
        if matches!(
            state.clear_transport(),
            native_background::lifecycle::CleanupState::Pending(_)
        ) {
            return Err("消息网关清理 Pending，拒绝替代进程。".into());
        }
        state.root_key = Some(state.root.reserve()?);
        let generation = {
            let mut cache = state.statuses.lock().map_err(|_| "消息网关状态锁失败。")?;
            let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
            cache.current = Some((state.generation.clone(), generation));
            generation
        };
        let result = (|| {
            let child = spawn()?;
            state.job = crate::assign_child_to_kill_on_close_job(&child);
            state.child = Some(child);
            let child = state.child.as_mut().unwrap();
            state.stdin = Some(writer(child.stdin.take().ok_or("消息网关输入不可用。")?)?);
            let stdout = child.stdout.take().ok_or("消息网关输出不可用。")?;
            state.ready_generation = generation;
            Ok(Some((stdout, generation)))
        })();
        if result.is_err() {
            state.clear_transport();
        }
        result
    }
}
fn spawn_gateway_reader(state: &mut GatewayState, read: impl FnOnce() + Send + 'static) {
    state.reader = Some(std::thread::spawn(read));
}
fn start_gateway(state: &mut GatewayState, app: &AppHandle) -> Result<(), String> {
    let Some((stdout, generation)) = start_gateway_process(state, || {
    let cli = crate::locate_ugs_cli(None, app)?;
    let path = cli
        .parent()
        .ok_or("消息网关目录缺失。")?
        .join("ugs-messaging.mjs");
    if !path.is_file() {
        return Err("消息网关未构建，请运行 npm run cli:build。".into());
    }
    let path = crate::normalize_node_entry_path(&path).map_err(|_| "无法解析消息网关路径。")?;
    crate::new_spawn_command("node")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "启动消息网关失败，请检查 Node.js。".to_string())
    }, PipeWriter::new)? else { return Ok(()); };
    let pending = state.pending.clone();
    let statuses = state.statuses.clone();
    let app = app.clone();
    let active_generation = state.generation.clone();
    spawn_gateway_reader(state, move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if active_generation.load(Ordering::SeqCst) != generation {
                break;
            }
            if let Some(id) = event.get("requestId").and_then(Value::as_str) {
                if let Ok(mut requests) = pending.lock() {
                    if let Some(sender) = requests.remove(id) {
                        let result = match event.get("error").and_then(Value::as_str) {
                            Some(error) => Err(error.to_string()),
                            None => Ok(event.get("data").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = sender.send(result);
                    }
                }
            } else if matches!(
                event.get("type").and_then(Value::as_str),
                Some("status" | "message")
            ) {
                publish_gateway_event(&statuses, &active_generation, generation, event, |event| {
                    let _ = app.emit("message-platform-event", event);
                });
            }
        }
        if !gateway_reader_eof(&active_generation, generation) {
            return;
        }
        if let Ok(mut requests) = pending.lock() {
            for (_, sender) in requests.drain() {
                let _ = sender.send(Err("消息网关已退出。".into()));
            }
        }
        publish_gateway_eof(&statuses, &active_generation, generation, |event| {
            let _ = app.emit("message-platform-event", event);
        });
    });
    Ok(())
}
async fn request(
    app: AppHandle,
    id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    gateway_root().check_open()?;
    native_background::run_bounded_tracked(
        gateway_root().clone(),
        native_background::gateway_lane(),
        Duration::from_secs(60),
        move |admission| {
            // Declared first for local cleanup; the root receipt owns retirement.
            let queued;
            let deadline = std::time::Instant::now() + Duration::from_secs(55);
            let (sender, receiver) = mpsc::channel();
            queued = {
                // This is an I/O-only admission lock; no status read ever takes it.
                let _io = gateway_io_gate()
                    .try_lock()
                    .map_err(|_| "消息网关启动繁忙，请重试。")?;
                let mut state = gateway().lock().map_err(|_| "消息网关锁失败。")?;
                start_gateway(&mut state, &app)?;
                queue_gateway_request_tracked(&mut state, sender, &admission)?
            };
            let line = format!(
                "{}\n",
                json!({"requestId":queued.request_id,"id":id,"method":method,"params":params})
            );
            if let Err(error) = queued.stdin.write_bytes(
                line.into_bytes(),
                std::time::Instant::now() + Duration::from_secs(3),
            ) {
                queued
                    .pending
                    .lock()
                    .map_err(|_| "消息网关请求锁失败。")?
                    .remove(&queued.request_id);
                return Err(error);
            }
            let result = receiver
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .map_err(|_| "消息平台请求未返回，请检查平台网络。".to_string());
            if let Ok(mut requests) = queued.pending.lock() {
                requests.remove(&queued.request_id);
            }
            result?
        },
    )
    .await
}

struct QueuedGatewayRequest<
    W = native_background::lifecycle::RequestWorkerLease<GatewayCleanupOwner>,
> {
    request_id: String,
    pending: Pending,
    stdin: Arc<PipeWriter>,
    // Legacy work-local lease, or unit for a root-owned tracked receipt.
    _worker: W,
}

fn queue_gateway_request(
    state: &mut GatewayState,
    sender: mpsc::Sender<Result<Value, String>>,
) -> Result<QueuedGatewayRequest, String> {
    queue_gateway_request_with(state, sender, |root, key| root.admit_request(key))
}
fn queue_gateway_request_tracked(
    state: &mut GatewayState,
    sender: mpsc::Sender<Result<Value, String>>,
    admission: &native_background::lifecycle::TrackedAdmission<GatewayCleanupOwner>,
) -> Result<QueuedGatewayRequest<()>, String> {
    queue_gateway_request_with(state, sender, |root, key| {
        root.admit_request_tracked(key, admission)
    })
}
fn queue_gateway_request_with<W>(
    state: &mut GatewayState,
    sender: mpsc::Sender<Result<Value, String>>,
    admit: impl FnOnce(&Arc<GatewayRoot>, u64) -> Result<W, String>,
) -> Result<QueuedGatewayRequest<W>, String> {
    let stdin = state.stdin.clone().ok_or("消息网关输入不可用。")?;
    let key = state.root_key.ok_or("消息网关 run identity 不可用。")?;
    let sequence = state
        .sequence
        .checked_add(1)
        .ok_or("消息网关请求编号已耗尽。")?;
    let worker = admit(&state.root, key)?;
    state.sequence = sequence;
    let request_id = sequence.to_string();
    state
        .pending
        .lock()
        .map_err(|_| "消息网关请求锁失败。")?
        .insert(request_id.clone(), sender);
    Ok(QueuedGatewayRequest {
        request_id,
        pending: state.pending.clone(),
        stdin,
        _worker: worker,
    })
}

fn publication_matches(cache: &GatewayStatusCache, active: &Arc<AtomicU64>, generation: u64) -> bool {
    cache.current.as_ref().is_some_and(|(owner, epoch)| Arc::ptr_eq(owner, active) && *epoch == generation)
}
fn publish_gateway_event(statuses: &Mutex<GatewayStatusCache>, active: &Arc<AtomicU64>, generation: u64, event: Value, mut emit: impl FnMut(Value)) {
    if let Ok(mut cache) = statuses.lock() {
        if !publication_matches(&cache, active, generation) || active.load(Ordering::SeqCst) != generation { return; }
        if event["type"] == "status" {
            if let Some(id) = event["data"]["id"].as_str() { cache.insert(id.into(), event["data"].clone()); }
        }
        emit(event);
    }
}
fn publish_gateway_eof(statuses: &Mutex<GatewayStatusCache>, active: &Arc<AtomicU64>, generation: u64, mut emit: impl FnMut(Value)) {
    if let Ok(mut map) = statuses.lock() {
        if !publication_matches(&map, active, generation) || active.load(Ordering::SeqCst) != generation + 1 { return; }
        for id in IDS {
            let data = json!({"id":id,"state":"error","detail":"消息网关已退出，请重新连接。"});
            map.insert(id.into(), data.clone());
            emit(json!({"type":"status","data":data}));
        }
    }
}
fn gateway_reader_eof(active_generation: &AtomicU64, generation: u64) -> bool {
    active_generation.compare_exchange(generation, generation + 1, Ordering::SeqCst, Ordering::SeqCst).is_ok()
}

#[tauri::command]
pub async fn message_platform_load() -> Result<Vec<PlatformConfig>, String> {
    let mut configs = read_configs()?;
    for config in &mut configs {
        config.has_secret = !read_secret(&config.id).await?.is_empty();
    }
    Ok(configs)
}
#[tauri::command]
pub async fn message_platform_save(
    mut config: PlatformConfig,
    secret: Option<String>,
) -> Result<PlatformConfig, String> {
    validate_id(&config.id)?;
    config.allowed_users.retain(|id| !id.trim().is_empty());
    config.allowed_users.sort();
    config.allowed_users.dedup();
    if let Some(secret) = secret.filter(|s| !s.trim().is_empty()) {
        crate::secure_store::secure_secret_set(secret_key(&config.id), secret).await?;
    }
    config.has_secret = !read_secret(&config.id).await?.is_empty();
    if config.enabled && !config.has_secret {
        return Err("请先配置平台凭据。".into());
    }
    if config.enabled
        && (config.id == "feishu" || config.id == "wechat")
        && config.workspace_id.is_empty()
    {
        return Err("请选择消息使用的项目。".into());
    }
    if config.enabled && config.notify_on_completion && config.workspace_id.is_empty() {
        return Err("请选择通知使用的项目。".into());
    }
    write_config(config.clone())?;
    Ok(config)
}
#[tauri::command]
pub fn message_platform_status() -> Result<HashMap<String, Value>, String> {
    let result = gateway_statuses()
        .lock()
        .map_err(|_| "消息网关状态锁失败。")?
        .values.clone();
    Ok(result)
}
#[tauri::command]
pub async fn message_platform_request(
    app: AppHandle,
    id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    validate_id(&id)?;
    if !["connect", "disconnect", "qr", "checkQr", "send"].contains(&method.as_str()) {
        return Err("不支持的消息操作。".into());
    }
    if (method == "qr" || method == "checkQr") && id != "wechat" {
        return Err("此平台不支持扫码。".into());
    }
    let mut config = read_configs()?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or("未知消息平台。")?;
    let input = if method == "connect" {
        if !config.enabled {
            return Err("请先启用消息平台。".into());
        }
        let secret = read_secret(&id).await?;
        let mut input = serde_json::to_value(&config).map_err(|_| "消息平台配置错误。")?;
        // DingTalk credentials may be a JSON pair for a signed custom robot.
        if id == "dingtalk" {
            if let Ok(pair) = serde_json::from_str::<Value>(&secret) {
                input["secret"] = pair["webhook"].clone();
                input["signingSecret"] = pair["signingSecret"].clone();
            } else {
                input["secret"] = json!(secret);
            }
        } else {
            input["secret"] = json!(secret);
        }
        input
    } else {
        params
    };
    let mut result = request(app, id.clone(), method.clone(), input).await?;
    if method == "checkQr" && result["status"] == "confirmed" {
        let secret = result
            .get("secret")
            .and_then(Value::as_str)
            .ok_or("微信登录凭据缺失。")?
            .to_string();
        crate::secure_store::secure_secret_set(secret_key(&id), secret).await?;
        config.account_id = result["accountId"].as_str().unwrap_or_default().into();
        config.base_url = result["baseUrl"].as_str().unwrap_or_default().into();
        if let Some(user) = result["userId"].as_str() {
            if !config.allowed_users.contains(&user.to_string()) {
                config.allowed_users.push(user.into());
            }
        }
        config.has_secret = true;
        write_config(config.clone())?;
        result
            .as_object_mut()
            .ok_or("微信登录结果错误。")?
            .remove("secret");
        result["config"] = serde_json::to_value(config).map_err(|_| "微信配置错误。")?;
    }
    Ok(result)
}

#[cfg(test)]
#[path = "message_platforms_task_receipt_capture_tests.rs"]
mod task_receipt_capture_tests;

#[cfg(test)]
#[path = "message_platforms_task_receipt_boundary_tests.rs"]
mod task_receipt_boundary_tests;

#[cfg(test)]
mod request_worker_tests {
    use super::*;
    use native_background::lifecycle::CleanupState;
    use std::time::Instant;

    fn owned_state(
        root: Arc<GatewayRoot>,
        key: u64,
        stdin: Option<Arc<PipeWriter>>,
    ) -> GatewayState {
        GatewayState {
            root,
            root_key: Some(key),
            unknown_obligations: false,
            deny_kill: false,
            child: None,
            job: None,
            stdin,
            pending: Default::default(),
            reader: None,
            statuses: Default::default(),
            sequence: 0,
            generation: Default::default(),
            ready_generation: 0,
        }
    }

    fn null_sink() -> std::fs::File {
        #[cfg(windows)]
        let path = "NUL";
        #[cfg(not(windows))]
        let path = "/dev/null";
        std::fs::OpenOptions::new().write(true).open(path).unwrap()
    }

    fn null_writer() -> Arc<PipeWriter> {
        PipeWriter::new(null_sink()).unwrap()
    }

    fn until(mut check: impl FnMut() -> bool, duration: Duration) -> bool {
        let deadline = Instant::now() + duration;
        while !check() {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        true
    }

    struct TailRelease(Option<mpsc::Sender<()>>);
    impl TailRelease {
        fn release(&mut self) -> bool {
            self.0.take().is_some_and(|sender| sender.send(()).is_ok())
        }
    }
    impl Drop for TailRelease {
        fn drop(&mut self) {
            self.release();
        }
    }

    #[test]
    fn timed_out_request_keeps_run_pending_after_real_pipe_join() {
        let root = GatewayRoot::new();
        let key = root.reserve().unwrap();
        let writer = null_writer();
        let state = Arc::new(Mutex::new(owned_state(
            root.clone(),
            key,
            Some(writer.clone()),
        )));
        let lane = Arc::new(tokio::sync::Semaphore::new(1));
        let (written_tx, written_rx) = mpsc::channel();
        let (tail_tx, tail_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let mut tail_release = TailRelease(Some(release_tx));
        let worker_state = state.clone();
        let worker_lane = lane.clone();
        let outer = tauri::async_runtime::spawn(async move {
            native_background::run_bounded(worker_lane, Duration::from_millis(50), move || {
                let queued;
                let (sender, receiver) = mpsc::channel();
                queued = {
                    let mut state = worker_state.lock().map_err(|_| "owned state lock")?;
                    queue_gateway_request(&mut state, sender)?
                };
                let request_id = &queued.request_id;
                let pending = &queued.pending;
                let stdin = &queued.stdin;
                let line = format!(
                    "{}\n",
                    json!({"requestId": request_id, "method": "owned-test"})
                );
                stdin.write_bytes(line.into_bytes(), Instant::now() + Duration::from_secs(3))?;
                written_tx
                    .send(request_id.clone())
                    .map_err(|_| "written checkpoint")?;
                let reply = receiver.recv_timeout(Duration::from_secs(55));
                pending
                    .lock()
                    .map_err(|_| "owned pending lock")?
                    .remove(request_id);
                let reply_consumed =
                    matches!(reply, Ok(Err(ref error)) if error == "owned fixture response end");
                tail_tx
                    .send(reply_consumed)
                    .map_err(|_| "tail checkpoint")?;
                let released = release_rx.recv_timeout(Duration::from_secs(3)).is_ok();
                done_tx.send(released).map_err(|_| "done checkpoint")?;
                Ok(())
            })
            .await
        });
        let request_id = written_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let outer_result = tauri::async_runtime::block_on(outer).unwrap();
        let outer_timed_out = outer_result == Err("后台任务超时。".into());
        root.draining();
        let response_sent = state
            .lock()
            .unwrap()
            .pending
            .lock()
            .unwrap()
            .remove(&request_id)
            .unwrap()
            .send(Err("owned fixture response end".into()))
            .is_ok();
        let reply_consumed = tail_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or(false);
        state.lock().unwrap().handoff_cleanup();
        writer.close();
        let actual_pipe_receipt = until(|| writer.cleanup_complete(), Duration::from_millis(500));
        let response_map_empty = state.lock().unwrap().pending.lock().unwrap().is_empty();
        let live_until = Instant::now() + Duration::from_millis(500);
        let mut continuously_pending = true;
        while Instant::now() < live_until {
            continuously_pending &= root.state() == CleanupState::Pending(key);
            std::thread::sleep(Duration::from_millis(2));
        }
        let live_checkpoint_state = root.state();
        let lane_at_live_checkpoint = lane.available_permits();
        let replacement_denied_at_live_checkpoint = root.reserve().is_err();
        let tail_released = tail_release.release();
        let owned_work_finished = done_rx
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or(false);
        let actual_lane_returned = until(|| lane.available_permits() == 1, Duration::from_secs(3));
        let final_root_stopped = until(
            || root.state() == CleanupState::Stopped(key),
            Duration::from_secs(3),
        );
        drop(state);
        drop(writer);
        println!("R2 outer_timeout={outer_timed_out} response_sent={response_sent} reply_consumed={reply_consumed} map_empty={response_map_empty} pipe_receipt={actual_pipe_receipt} live_state={live_checkpoint_state:?} continuously_pending={continuously_pending} lane_live={lane_at_live_checkpoint} replacement_denied={replacement_denied_at_live_checkpoint} tail_released={tail_released} owned_work_finished={owned_work_finished} lane_returned={actual_lane_returned} final_stopped={final_root_stopped} outer_task_joined=true root_supervisor_join=not_accessible");
        assert!(outer_timed_out && reply_consumed && response_map_empty && actual_pipe_receipt);
        assert_eq!(
            lane_at_live_checkpoint, 0,
            "real blocking work still owns its lane permit"
        );
        assert_eq!(live_checkpoint_state, CleanupState::Pending(key), "actual request work has not returned: pipe join and empty response map cannot retire its run");
        assert!(
            replacement_denied_at_live_checkpoint,
            "live request run must retain unique root reservation"
        );
        assert!(
            tail_released && actual_lane_returned && final_root_stopped,
            "fixture must really finish its blocking work and retire after release"
        );
        assert!(response_sent && owned_work_finished && continuously_pending);
    }

    struct CountedSink {
        sink: std::fs::File,
        bytes: Arc<std::sync::atomic::AtomicUsize>,
    }
    #[cfg(windows)]
    impl std::os::windows::io::AsHandle for CountedSink {
        fn as_handle(&self) -> std::os::windows::io::BorrowedHandle<'_> {
            std::os::windows::io::AsHandle::as_handle(&self.sink)
        }
    }
    impl std::io::Write for CountedSink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let written = std::io::Write::write(&mut self.sink, bytes)?;
            self.bytes.fetch_add(written, Ordering::SeqCst);
            Ok(written)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            std::io::Write::flush(&mut self.sink)
        }
    }

    #[test]
    fn draining_and_admission_share_the_run_gate() {
        let root = GatewayRoot::new();
        let key = root.reserve().unwrap();
        let bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writer = PipeWriter::new(CountedSink {
            sink: null_sink(),
            bytes: bytes.clone(),
        })
        .unwrap();
        let mut state = owned_state(root.clone(), key, Some(writer.clone()));
        root.draining();
        let (sender, _) = mpsc::channel();
        let queued = queue_gateway_request(&mut state, sender);
        let rejected = queued.is_err();
        if let Ok(queued) = queued {
            let _ = queued.stdin.write_bytes(
                b"unexpected\n".to_vec(),
                Instant::now() + Duration::from_secs(3),
            );
        }
        let map_empty = state.pending.lock().unwrap().is_empty();
        state.handoff_cleanup();
        let joined = until(|| writer.cleanup_complete(), Duration::from_millis(500));
        let stopped = until(
            || root.state() == CleanupState::Stopped(key),
            Duration::from_millis(500),
        );
        let written = bytes.load(Ordering::SeqCst);
        drop(state);
        drop(writer);
        let root = GatewayRoot::new();
        let key = root.reserve().unwrap();
        let writer = null_writer();
        let mut state = owned_state(root.clone(), key, Some(writer.clone()));
        let (sender, _) = mpsc::channel();
        let queued = queue_gateway_request(&mut state, sender).unwrap();
        root.draining();
        let pending = root.state();
        let denied = !root.release_empty(key);
        state.handoff_cleanup();
        let second_joined = until(|| writer.cleanup_complete(), Duration::from_millis(500));
        let retained = root.state();
        drop(queued);
        let final_stopped = until(
            || root.state() == CleanupState::Stopped(key),
            Duration::from_millis(500),
        );
        drop(state);
        drop(writer);
        println!("R2 gate D_first_rejected={rejected} map_empty={map_empty} written={written} pipe_joined={joined} stopped={stopped} A_first_pending={pending:?} empty_release_denied={denied} second_pipe_joined={second_joined} retained={retained:?} final_stopped={final_stopped}");
        assert!(rejected && map_empty && joined && stopped && second_joined && final_stopped);
        assert_eq!(written, 0);
        assert!(denied);
        assert_eq!(pending, CleanupState::Pending(key));
        assert_eq!(retained, CleanupState::Pending(key));
    }

    #[test]
    fn empty_transport_retains_root_key_until_actual_lease_release() {
        let root = GatewayRoot::new();
        let key = root.reserve().unwrap();
        let mut state = owned_state(root.clone(), key, None);
        let lease = root.admit_request(key).unwrap();
        let pending = state.clear_transport();
        let retained_key = state.root_key;
        let wrong_key_denied = !root.release_empty(key + 1);
        drop(lease);
        let stopped = state.clear_transport();
        let released_key = state.root_key;
        drop(state);
        println!("R2 empty pending={pending:?} retained_key={retained_key:?} wrong_key_denied={wrong_key_denied} stopped={stopped:?} released_key={released_key:?}");
        assert_eq!(pending, CleanupState::Pending(key));
        assert_eq!(retained_key, Some(key));
        assert!(wrong_key_denied);
        assert_eq!(stopped, CleanupState::Stopped(key));
        assert_eq!(released_key, None);
    }
}

#[cfg(test)]
mod pipe_receipt_tests {
    use super::*;
    use native_background::lifecycle::CleanupState;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    fn null_sink() -> std::fs::File {
        #[cfg(windows)]
        let path = "NUL";
        #[cfg(not(windows))]
        let path = "/dev/null";
        std::fs::OpenOptions::new().write(true).open(path).unwrap()
    }

    fn until(mut check: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_millis(500);
        loop {
            if check() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn joined_pipe_retires_the_retained_gateway_root() {
        let root = GatewayRoot::new();
        let key = root.reserve().unwrap();
        let writer = PipeWriter::new(null_sink()).unwrap();
        let written = writer.write_bytes(vec![b'x'], Instant::now() + Duration::from_millis(500));
        writer.close();
        let actual_receipt = until(|| writer.cleanup_complete());
        root.handoff(key, |owner| owner.stdin = Some(writer));
        let retired = until(|| root.state() == CleanupState::Stopped(key));
        let retained_pipe = root.inspect(|owner| owner.stdin.is_some());
        let replacement_denied = root.reserve().is_err();
        println!("joined_pipe actual_receipt={actual_receipt} retired={retired} retained_pipe={retained_pipe} replacement_denied={replacement_denied}");
        drop(root);
        assert!(
            written.is_ok() && actual_receipt,
            "real writer and cleanup supervisor must join first"
        );
        assert!(
            retired && !retained_pipe,
            "a truthful joined-pipe receipt must retire the retained Gateway owner"
        );
        assert!(
            !replacement_denied,
            "the completed root must release replacement admission"
        );
    }

    struct GatedSink {
        file: std::fs::File,
        entered: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
        panics: bool,
        exited: Arc<AtomicBool>,
    }

    #[cfg(windows)]
    impl std::os::windows::io::AsHandle for GatedSink {
        fn as_handle(&self) -> std::os::windows::io::BorrowedHandle<'_> {
            self.file.as_handle()
        }
    }

    impl Write for GatedSink {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(2)).unwrap();
            if self.panics {
                panic!("owned actual pipe writer panic");
            }
            self.file.write(bytes)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }

    impl Drop for GatedSink {
        fn drop(&mut self) {
            self.exited.store(true, Ordering::Release);
        }
    }

    struct ReleaseOnDrop(Option<mpsc::Sender<()>>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            if let Some(release) = self.0.take() {
                let _ = release.send(());
            }
        }
    }

    #[test]
    fn active_writer_direct_drop_waits_for_actual_pipe_join() {
        let root = GatewayRoot::new();
        let key = root.reserve().unwrap();
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let mut release = ReleaseOnDrop(Some(release));
        let exited = Arc::new(AtomicBool::new(false));
        let writer = PipeWriter::new(GatedSink {
            file: null_sink(),
            entered,
            release: release_rx,
            panics: false,
            exited: exited.clone(),
        })
        .unwrap();
        let caller_writer = writer.clone();
        let caller = std::thread::spawn(move || {
            caller_writer.write_bytes(vec![b'x'], Instant::now() + Duration::from_millis(500))
        });
        let entered = entered_rx.recv_timeout(Duration::from_millis(500)).is_ok();
        let state = GatewayState {
            root: root.clone(),
            root_key: Some(key),
            unknown_obligations: false,
            #[cfg(test)]
            deny_kill: false,
            child: None,
            job: None,
            stdin: Some(writer.clone()),
            pending: Default::default(),
            reader: None,
            statuses: Default::default(),
            sequence: 0,
            generation: Default::default(),
            ready_generation: 0,
        };
        let began = Instant::now();
        drop(state);
        let drop_elapsed = began.elapsed();
        let premature_receipt = writer.cleanup_complete();
        let pending = root.state() == CleanupState::Pending(key);
        let retained_same = root.inspect(|owner| {
            owner
                .stdin
                .as_ref()
                .is_some_and(|stdin| Arc::ptr_eq(stdin, &writer))
        });
        let replacement_denied = root.reserve().is_err();
        let released = release.0.take().unwrap().send(()).is_ok();
        let caller_joined = caller.join().is_ok();
        let actual_receipt = until(|| writer.cleanup_complete());
        let retired = until(|| root.state() == CleanupState::Stopped(key));
        println!("active_writer entered={entered} drop_elapsed={drop_elapsed:?} premature_receipt={premature_receipt} pending={pending} retained_same={retained_same} replacement_denied={replacement_denied} released={released} caller_joined={caller_joined} actual_receipt={actual_receipt} retired={retired}");
        assert!(entered && released && caller_joined && exited.load(Ordering::Acquire));
        assert!(
            drop_elapsed < Duration::from_millis(120),
            "Drop must not wait for the active writer"
        );
        assert!(!premature_receipt && pending && retained_same && replacement_denied);
        assert!(
            actual_receipt && retired,
            "actual joined pipe cleanup must permit root retirement"
        );
    }

    #[test]
    fn actual_writer_panic_keeps_original_pipe_pending_under_concurrent_observation() {
        let root = GatewayRoot::new();
        let key = root.reserve().unwrap();
        let (entered, entered_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let mut release = ReleaseOnDrop(Some(release));
        let exited = Arc::new(AtomicBool::new(false));
        let writer = PipeWriter::new(GatedSink {
            file: null_sink(),
            entered,
            release: release_rx,
            panics: true,
            exited: exited.clone(),
        })
        .unwrap();
        let caller_writer = writer.clone();
        let caller = std::thread::spawn(move || {
            caller_writer.write_bytes(vec![b'x'], Instant::now() + Duration::from_millis(500))
        });
        let entered = entered_rx.recv_timeout(Duration::from_millis(500)).is_ok();
        writer.close();
        root.handoff(key, |owner| owner.stdin = Some(writer.clone()));
        let released = release.0.take().unwrap().send(()).is_ok();
        let write_failed = matches!(caller.join(), Ok(Err(_)));
        let actual_sink_exited = until(|| exited.load(Ordering::Acquire));
        let observers: Vec<_> = (0..4)
            .map(|_| {
                let root = root.clone();
                let writer = writer.clone();
                std::thread::spawn(move || {
                    (0..32).all(|_| {
                        let safe = !writer.cleanup_complete()
                            && root.state() == CleanupState::Pending(key)
                            && root.check_open().is_err();
                        std::thread::sleep(Duration::from_millis(5));
                        safe
                    })
                })
            })
            .collect();
        let mut all_safe = true;
        for observer in observers {
            all_safe &= matches!(observer.join(), Ok(true));
        }
        let retained_same = root.inspect(|owner| {
            owner
                .stdin
                .as_ref()
                .is_some_and(|stdin| Arc::ptr_eq(stdin, &writer))
        });
        let replacement_denied = root.reserve().is_err();
        println!("actual_writer_panic entered={entered} released={released} write_failed={write_failed} actual_sink_exited={actual_sink_exited} observers=4 all_safe={all_safe} retained_same={retained_same} replacement_denied={replacement_denied}");
        assert!(entered && released && write_failed && actual_sink_exited);
        assert!(
            all_safe && retained_same && replacement_denied,
            "an actual writer panic must never release the original Gateway pipe owner"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn gateway_cleanup_pending_keeps_original_child_and_blocks_replacement() {
        use std::io::Write;
        use std::os::windows::io::{AsHandle, AsRawHandle, OwnedHandle};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        struct FixtureGuard {
            input: Option<ChildStdin>,
            handle: OwnedHandle,
        }
        impl FixtureGuard {
            fn release_wait(&mut self) -> (u32, u32) {
                if let Some(mut input) = self.input.take() {
                    input.write_all(b"RELEASE\n").unwrap();
                    input.flush().unwrap();
                }
                unsafe {
                    let waited = WaitForSingleObject(self.handle.as_raw_handle() as _, 3000);
                    let mut code = 259;
                    assert_ne!(
                        GetExitCodeProcess(self.handle.as_raw_handle() as _, &mut code),
                        0
                    );
                    (waited, code)
                }
            }
        }
        impl Drop for FixtureGuard {
            fn drop(&mut self) {
                if self.input.is_some() {
                    let _ = self.release_wait();
                }
            }
        }
        let mut state = GatewayState::default();
        state.root_key = Some(state.root.reserve().unwrap());
        state.unknown_obligations = false;
        state.deny_kill = true;
        let mut child = std::process::Command::new(std::env::var("UGS_ROOT_FIXTURE").unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let raw = child.as_raw_handle();
        let mut guard = FixtureGuard {
            input: child.stdin.take(),
            handle: child.as_handle().try_clone_to_owned().unwrap(),
        };
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        stdout.read_line(&mut ready).unwrap();
        assert_eq!(ready.trim_end(), "READY");
        state.child = Some(child);
        let began = std::time::Instant::now();
        state.clear_transport_with_kill(|_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "owned fixture kill fault",
            ))
        });
        let elapsed = began.elapsed();
        let retained_same = state
            .child
            .as_ref()
            .is_some_and(|child| child.as_raw_handle() == raw);
        let pending = state.child.is_some();
        let alive = unsafe { WaitForSingleObject(guard.handle.as_raw_handle() as _, 0) == 258 };
        let mut calls = 0;
        let replacement = start_gateway_process(
            &mut state,
            || {
                calls += 1;
                Err("replacement callback reached".into())
            },
            PipeWriter::new,
        );
        let (waited, code) = guard.release_wait();
        let reaped = state
            .child
            .as_mut()
            .map(|child| child.wait().unwrap().success());
        drop(state);
        println!("R1 checkpoint retained_same={retained_same} pending={pending} alive={alive} replacement_calls={calls} cleanup_ms={} owned_wait={waited} owned_exit={code} child_reaped={reaped:?}", elapsed.as_millis());
        assert_eq!(
            (waited, code),
            (0, 0),
            "finally RELEASE must signal the original kernel object"
        );
        assert!(
            retained_same && pending && alive,
            "500ms Pending must retain the original live Child"
        );
        assert!(replacement.is_err());
        assert_eq!(
            calls, 0,
            "Pending must reject before the actual replacement callback"
        );
    }
    fn fixture_child() -> Result<Child, String> {
        fixture_child_with_code("setInterval(()=>{},1000)")
    }
    fn fixture_child_with_code(code: &str) -> Result<Child, String> {
        let root = std::path::PathBuf::from(std::env::var("UGS_MEMORY_TEST_ROOT").unwrap()).join("gateway");
        std::fs::create_dir_all(&root).unwrap();
        crate::new_spawn_command("node").args(["-e", code])
            .current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|e| e.to_string())
    }
    #[test]
    fn gateway_writer_init_failure_restores_clean_state_and_retry_starts() {
        let state = Mutex::new(GatewayState::default());
        let mut pid = 0;
        let began = std::time::Instant::now();
        let failed = native_background::with_detached_state(&state, |owned| {
            start_gateway_process(owned, || { let child = fixture_child()?; pid = child.id(); Ok(child) }, |_| Err("fixture writer slots exhausted".into()))
        });
        let clean = { let owned = state.lock().unwrap(); owned.child.is_none() && owned.job.is_none() && owned.stdin.is_none() && owned.pending.lock().unwrap().is_empty() };
        let reaped = !crate::process_is_alive(pid);
        let retry = native_background::with_detached_state(&state, |owned| start_gateway_process(owned, fixture_child, PipeWriter::new));
        let restarted = matches!(retry, Ok(Some(_)));
        drop(state);
        assert!(failed.is_err());
        assert!(clean && reaped && began.elapsed() < Duration::from_secs(3), "failed writer must reap child/job before detached state restoration");
        assert!(restarted, "restored writer admission must start a fresh child");
    }
    #[test]
    fn gateway_missing_stdin_does_not_insert_pending() {
        let mut state = GatewayState::default();
        let (sender, _) = mpsc::channel();
        assert!(queue_gateway_request(&mut state, sender).is_err());
        assert!(state.pending.lock().unwrap().is_empty(), "invalid transport has no reader to consume pending");
    }
    #[test]
    fn gateway_eof_lingering_child_immediate_retry_starts_new_generation() {
        let mut state = GatewayState::default();
        #[cfg(windows)]
        let spawn_eof = || {
            let root = std::path::PathBuf::from(std::env::var("UGS_MEMORY_TEST_ROOT").unwrap()).join("gateway-eof");
            std::fs::create_dir_all(&root).unwrap();
            crate::new_spawn_command(&crate::tests::stdio_fixture_binary().to_string_lossy())
                .env("UGS_TEST_STDOUT_MODE", "stream-complete")
                .current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
                .spawn().map_err(|e| e.to_string())
        };
        #[cfg(not(windows))]
        let spawn_eof = || fixture_child_with_code("require('fs').closeSync(1);setInterval(()=>{},1000)");
        let (mut stdout, generation) = start_gateway_process(&mut state,
            spawn_eof, PipeWriter::new).unwrap().unwrap();
        let old_pid = state.child.as_ref().unwrap().id();
        let active_generation = state.generation.clone();
        let old_pending = state.pending.clone();
        let statuses = state.statuses.clone();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let old_emitted = emitted.clone();
        let (eof, eof_rx) = mpsc::channel();
        let (resume, resume_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut bytes = vec![];
            std::io::Read::read_to_end(&mut stdout, &mut bytes).unwrap();
            assert!(gateway_reader_eof(&active_generation, generation));
            eof.send(()).unwrap();
            resume_rx.recv_timeout(Duration::from_secs(3)).unwrap();
            old_pending.lock().unwrap().clear();
            publish_gateway_eof(&statuses, &active_generation, generation, |event| old_emitted.lock().unwrap().push(event));
        });
        eof_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(crate::process_is_alive(old_pid), "fixture remains alive after transport EOF");
        let retry = start_gateway_process(&mut state, fixture_child, PipeWriter::new).unwrap();
        let restarted = retry.is_some() && state.child.as_ref().unwrap().id() != old_pid;
        let old_reaped = !crate::process_is_alive(old_pid);
        publish_gateway_event(&state.statuses, &state.generation, state.ready_generation,
            json!({"type":"status","data":{"id":"feishu","state":"connected"}}), |_| {});
        let (sender, _receiver) = mpsc::channel();
        queue_gateway_request(&mut state, sender).unwrap();
        resume.send(()).unwrap();
        reader.join().unwrap();
        let retry_pending_survived = state.pending.lock().unwrap().len() == 1;
        let connected = state.statuses.lock().unwrap()["feishu"]["state"] == "connected";
        let no_old_emit = emitted.lock().unwrap().is_empty();
        drop(state);
        assert!(restarted && old_reaped, "EOF retry must replace and reap a still-running old child");
        assert!(retry_pending_survived, "delayed old EOF must not drain new generation requests");
        assert!(connected && no_old_emit, "production EOF publication must not overwrite or emit against replacement generation");
    }
    #[test]
    fn status_snapshot_does_not_wait_for_gateway_io_lock() {
        let guard = gateway().lock().unwrap();
        let (sent, received) = mpsc::channel();
        let worker = std::thread::spawn(move || { sent.send(message_platform_status()).unwrap(); });
        let snapshot = received.recv_timeout(Duration::from_millis(50));
        drop(guard);
        worker.join().unwrap();
        assert!(snapshot.is_ok(), "status must not wait for gateway spawn/write/cleanup");
    }
    #[test]
    fn defaults_are_closed_and_credentials_are_not_config_fields() {
        let config: PlatformConfig = serde_json::from_value(json!({"id":"wechat"})).unwrap();
        assert!(!config.enabled && !config.allow_all_users && config.group_mention_only);
        assert!(
            serde_json::from_value::<PlatformConfig>(json!({"id":"feishu","secret":"hidden"}))
                .is_err()
        );
        assert!(validate_id("unknown").is_err());
        assert!(
            serde_json::from_value::<PlatformConfig>(json!({"id":"wechat","hasSecret":true}))
                .unwrap()
                .has_secret
        );
    }
}
