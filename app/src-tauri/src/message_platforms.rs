use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
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
pub struct GatewayState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    pending: Pending,
    statuses: Arc<Mutex<HashMap<String, Value>>>,
    sequence: u64,
    generation: Arc<AtomicU64>,
}
impl Drop for GatewayState {
    fn drop(&mut self) {
        self.stdin.take();
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn gateway() -> &'static Mutex<GatewayState> {
    static STATE: OnceLock<Mutex<GatewayState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(GatewayState::default()))
}
pub fn shutdown() {
    if let Ok(mut state) = gateway().lock() {
        state.stdin.take();
        if let Some(mut child) = state.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn start_gateway(state: &mut GatewayState, app: &AppHandle) -> Result<(), String> {
    if let Some(child) = &mut state.child {
        if child
            .try_wait()
            .map_err(|_| "检查消息网关进程失败。")?
            .is_none()
        {
            return Ok(());
        }
    }
    state.stdin.take();
    state.child.take();
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let cli = crate::locate_ugs_cli(None, app)?;
    let path = cli
        .parent()
        .ok_or("消息网关目录缺失。")?
        .join("ugs-messaging.mjs");
    if !path.is_file() {
        return Err("消息网关未构建，请运行 npm run cli:build。".into());
    }
    let path = crate::normalize_node_entry_path(&path).map_err(|_| "无法解析消息网关路径。")?;
    let mut child = crate::new_spawn_command("node")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "启动消息网关失败，请检查 Node.js。")?;
    state.stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("消息网关输出不可用。")?;
    state.child = Some(child);
    let pending = state.pending.clone();
    let statuses = state.statuses.clone();
    let app = app.clone();
    let active_generation = state.generation.clone();
    std::thread::spawn(move || {
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
                if event["type"] == "status" {
                    if let Some(id) = event["data"]["id"].as_str() {
                        if let Ok(mut map) = statuses.lock() {
                            map.insert(id.into(), event["data"].clone());
                        }
                    }
                }
                let _ = app.emit("message-platform-event", &event);
            }
        }
        if active_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Ok(mut requests) = pending.lock() {
            for (_, sender) in requests.drain() {
                let _ = sender.send(Err("消息网关已退出。".into()));
            }
        }
        if let Ok(mut map) = statuses.lock() {
            for id in IDS {
                let data = json!({"id":id,"state":"error","detail":"消息网关已退出，请重新连接。"});
                map.insert(id.into(), data.clone());
                let _ = app.emit(
                    "message-platform-event",
                    json!({"type":"status","data":data}),
                );
            }
        }
    });
    Ok(())
}
async fn request(
    app: AppHandle,
    id: String,
    method: String,
    params: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (sender, receiver) = mpsc::channel();
        let (request_id, pending) = {
            let mut state = gateway().lock().map_err(|_| "消息网关锁失败。")?;
            start_gateway(&mut state, &app)?;
            state.sequence += 1;
            let request_id = state.sequence.to_string();
            state
                .pending
                .lock()
                .map_err(|_| "消息网关请求锁失败。")?
                .insert(request_id.clone(), sender);
            let line = format!(
                "{}\n",
                json!({"requestId":request_id,"id":id,"method":method,"params":params})
            );
            let written = state
                .stdin
                .as_mut()
                .ok_or("消息网关输入不可用。")?
                .write_all(line.as_bytes());
            if written.is_err() {
                state.pending.lock().unwrap().remove(&request_id);
                return Err("消息网关写入失败。".into());
            }
            (request_id, state.pending.clone())
        };
        let result = receiver
            .recv_timeout(Duration::from_secs(55))
            .map_err(|_| "消息平台请求未返回，请检查平台网络。".to_string());
        if let Ok(mut requests) = pending.lock() {
            requests.remove(&request_id);
        }
        result?
    })
    .await
    .map_err(|_| "消息网关请求任务失败。".to_string())?
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
    let state = gateway().lock().map_err(|_| "消息网关锁失败。")?;
    let result = state
        .statuses
        .lock()
        .map_err(|_| "消息网关状态锁失败。")?
        .clone();
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
mod tests {
    use super::*;
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
