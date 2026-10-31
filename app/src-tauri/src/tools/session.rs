//! Passive session catalogue: consumes native evidence, never starts an Agent/MCP.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex, OnceLock}};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    pub workspace_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub provider_id: String,
    #[serde(default)]
    pub channel_id: String,
    pub model: String,
}

impl Scope {
    fn key(&self) -> String {
        hex::encode(Sha256::digest(serde_json::to_vec(&[
            &self.workspace_id, &self.session_id, &self.agent_id, &self.provider_id, &self.channel_id, &self.model,
        ]).unwrap()))
    }
}

fn memory() -> &'static Mutex<HashMap<String, Value>> {
    static MEMORY: OnceLock<Mutex<HashMap<String, Value>>> = OnceLock::new();
    MEMORY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn path(scope: &Scope) -> Result<std::path::PathBuf, String> {
    Ok(crate::storage_paths::global_root()?.join("tools/catalogs").join(format!("{}.json", scope.key())))
}

fn persist(scope: &Scope, snapshot: &Value) -> Result<(), String> {
    let path = path(scope)?;
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(snapshot).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let from: Vec<u16> = tmp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn read(scope: &Scope) -> Result<Option<Value>, String> {
    if let Some(value) = memory().lock().map_err(|e| e.to_string())?.get(&scope.key()).cloned() {
        return Ok(Some(value));
    }
    let raw = match std::fs::read(path(scope)?) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut value: Value = serde_json::from_slice(&raw).map_err(|e| format!("目录缓存损坏: {e}"))?;
    if value["schemaVersion"] != 1 || value["scope"] != json!(scope) {
        return Err("目录缓存作用域不一致".into());
    }
    // A persisted active flag is not proof the original process still exists.
    value["active"] = false.into();
    Ok(Some(value))
}

#[derive(Clone)]
pub struct Capture {
    scope: Scope,
    run_id: String,
    seen_cursors: Arc<Mutex<HashSet<String>>>,
    codex_generation: Arc<AtomicU64>,
    codex_incomplete: Arc<AtomicBool>,
}

impl Capture {
    pub fn start(env: Option<&HashMap<String, String>>, adapter: &str, model: Option<&str>, run_id: &str) -> Option<Self> {
        let env = env?;
        let scope: Scope = env.get("UGS_TOOL_CATALOG_SCOPE")
            .and_then(|raw| serde_json::from_str(raw).ok()).or_else(|| Some(Scope {
                workspace_id: env.get("UGS_WORKSPACE_ID")?.clone(), session_id: env.get("UGS_SESSION_ID")?.clone(),
                agent_id: adapter.into(), provider_id: String::new(), channel_id: String::new(), model: model.unwrap_or("").into(),
            }))?;
        if scope.workspace_id.is_empty() || scope.session_id.is_empty() { return None; }
        let now = crate::now_ms();
        let snapshot = json!({"schemaVersion":1,"scope":scope,"runId":run_id,"startedAtMs":now,
            "updatedAtMs":now,"revision":0,"active":true,"tools":[],"coverage":[
                {"source":"builtin","level":"unknown","reason":"当前通道未提供完整内置工具枚举"},
                {"source":"mcp","level":"unknown","reason":"等待当前 Agent 的真实目录证据"}
            ]});
        if let Ok(mut map) = memory().lock() {
            map.insert(scope.key(), snapshot.clone());
            if let Err(e) = persist(&scope, &snapshot) { log::warn!("工具目录缓存写入失败: {e}"); }
        }
        Some(Self { scope, run_id: run_id.into(), seen_cursors: Arc::new(Mutex::new(HashSet::new())),
            codex_generation: Arc::new(AtomicU64::new(0)), codex_incomplete: Arc::new(AtomicBool::new(false)) })
    }

    fn update(&self, f: impl FnOnce(&mut Value)) {
        if let Ok(mut map) = memory().lock() {
            if let Some(value) = map.get_mut(&self.scope.key()).filter(|v| v["runId"] == self.run_id) {
                f(value);
                value["updatedAtMs"] = crate::now_ms().into();
                value["revision"] = (value["revision"].as_u64().unwrap_or(0) + 1).into();
                if let Err(e) = persist(&self.scope, value) { log::warn!("工具目录缓存写入失败: {e}"); }
            }
        }
    }

    fn descriptor(&self, name: &str, server: Option<&str>, evidence: &str) -> Value {
        json!({"toolId":serde_json::to_string(&[&self.scope.agent_id,server.unwrap_or(""),name]).unwrap(),
            "originalName":name,"providerId":self.scope.agent_id,"serverId":server,
            "origin":if server.is_some(){"mcp"}else{"unknown"},"owner":"agent","discovery":"live",
            "selected":"unknown","exposure":"unknown","connection":"unknown","permission":"agent-managed",
            "evidence":evidence,"lastSeenAtMs":crate::now_ms()})
    }

    pub fn claude_init(&self, event: &Value) {
        let Some(names) = event["tools"].as_array() else { return; };
        let tools: Vec<Value> = names.iter().filter_map(Value::as_str)
            .map(|name| self.descriptor(name, None, "Claude system/init.tools（仅名称）")).collect();
        self.update(|v| {
            v["tools"] = tools.into();
            v["coverage"] = json!([{"source":"session","level":"names","reason":"会话启动工具名称；Schema、逐工具权限与延迟加载方式未提供"}]);
        });
    }

    pub fn begin_codex(&self) -> String {
        let generation = self.codex_generation.fetch_add(1, Ordering::Relaxed) + 1;
        if let Ok(mut cursors) = self.seen_cursors.lock() { cursors.clear(); }
        self.codex_incomplete.store(false, Ordering::Relaxed);
        self.update(|v| {
            for tool in v["tools"].as_array_mut().unwrap() {
                if tool["origin"] == "mcp" { tool["discovery"] = "cached".into(); tool["connection"] = "unknown".into(); }
            }
        });
        format!("ugs-catalog-{generation}-0")
    }

    pub fn codex_page(&self, request_id: &str, result: &Value) -> Result<Option<(String,String)>, String> {
        let parts: Vec<&str> = request_id.split('-').collect();
        let generation = parts.get(2).and_then(|v| v.parse::<u64>().ok()).ok_or("目录响应 ID 无效")?;
        let page = parts.get(3).and_then(|v| v.parse::<u64>().ok()).ok_or("目录分页 ID 无效")?;
        if generation != self.codex_generation.load(Ordering::Relaxed) { return Ok(None); }
        let data = result["data"].as_array().ok_or("Codex MCP 状态缺少 data 数组")?;
        let mut additions = Vec::new();
        let mut coverage = Vec::new();
        let mut incomplete = false;
        for server in data {
            let name = server["name"].as_str().ok_or("Codex MCP 服务缺少名称")?;
            let entries = server["tools"].as_object().ok_or("Codex MCP tools 不是映射")?;
            let runtime = server["runtimeStatus"].as_str();
            let error = server["toolsError"].as_str();
            if error.is_some() || runtime.is_some_and(|s| s != "connected") { incomplete = true; }
            for (wire, raw) in entries {
                let original = raw["name"].as_str().unwrap_or(wire);
                let mut tool = self.descriptor(original, Some(name), "当前 Codex thread mcpServerStatus/list");
                tool["wireName"] = wire.clone().into();
                for field in ["description", "inputSchema", "outputSchema"] {
                    if let Some(value) = raw.get(field) { tool[field] = value.clone(); }
                }
                tool["metadata"] = raw.clone();
                if runtime == Some("connected") { tool["connection"] = "connected".into(); }
                if runtime.is_some_and(|s| s != "connected") { tool["discovery"] = "cached".into(); }
                additions.push(tool);
            }
            let reason=error.unwrap_or(match runtime {
                Some("connected")=>"当前线程已连接；执行许可由 Agent 管理",
                Some("starting")=>"当前线程正在连接；工具仅为上次发现",
                Some("notStarted")=>"当前线程尚未启动连接",
                Some("authenticationRequired")=>"当前线程需要认证",
                Some("failed")=>"当前线程连接失败",
                Some("cancelled")=>"当前线程连接已取消",
                Some("disabled")=>"当前线程已禁用服务器",
                _=>"连接状态未提供；仅工具元数据",
            });
            coverage.push(json!({"source":format!("mcp:{name}"),"level":if error.is_some(){"unknown"}else{"full"},"reason":reason}));
        }
        let cursor = result["nextCursor"].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
        if let Some(cursor) = &cursor {
            if !self.seen_cursors.lock().map_err(|e| e.to_string())?.insert(cursor.clone()) {
                return Err("Codex MCP 分页游标循环".into());
            }
        }
        if incomplete { self.codex_incomplete.store(true, Ordering::Relaxed); }
        let incomplete = self.codex_incomplete.load(Ordering::Relaxed);
        self.update(|v| {
            let tools = v["tools"].as_array_mut().unwrap();
            if page == 0 { tools.retain(|t| t["origin"] != "mcp"); }
            for tool in additions {
                if let Some(old) = tools.iter_mut().find(|old| old["toolId"] == tool["toolId"]) { *old = tool; }
                else { tools.push(tool); }
            }
            let rows = v["coverage"].as_array_mut().unwrap();
            if page == 0 { rows.retain(|c| !c["source"].as_str().unwrap_or("").starts_with("mcp:")); }
            rows.retain(|c| c["source"] != "mcp");
            rows.extend(coverage);
            rows.push(json!({"source":"mcp","level":if cursor.is_none() && !incomplete {"full"}else{"unknown"},
                "reason":if incomplete {"存在未连接或工具发现失败的服务"}else if cursor.is_none(){"当前线程 MCP 分页读取完成"}else{"MCP 分页读取中"}}));
        });
        Ok(cursor.map(|cursor| (format!("ugs-catalog-{generation}-{}",page+1),cursor)))
    }

    pub fn failure(&self, reason: &str) {
        self.update(|v| {
            let rows = v["coverage"].as_array_mut().unwrap();
            rows.retain(|c| c["source"] != "mcp");
            rows.push(json!({"source":"mcp","level":"unknown","reason":reason}));
        });
    }

    pub fn observe(&self, payload: &Value) {
        let name = payload["name"].as_str().or_else(|| payload["toolName"].as_str());
        let Some(name) = name else { return; };
        let mut observed = self.descriptor(name, None, "本会话原生工具调用事件（不是完整目录）");
        observed["discovery"] = "observed".into();
        observed["lastCall"] = json!({"atMs":crate::now_ms(),"status":payload["phase"].as_str().unwrap_or("observed")});
        self.update(|v| {
            let tools = v["tools"].as_array_mut().unwrap();
            let wires: Vec<usize> = tools.iter().enumerate().filter(|(_,t)| t["wireName"].as_str() == Some(name)).map(|(i,_)|i).collect();
            let exact = if wires.len() == 1 {Some(wires[0])}else{None};
            let names: Vec<usize> = tools.iter().enumerate().filter(|(_,t)| t["originalName"].as_str() == Some(name)).map(|(i,_)|i).collect();
            let index = exact.or_else(|| if names.len() == 1 {Some(names[0])}else{None});
            if let Some(index) = index {
                let existing = &mut tools[index];
                existing["lastCall"] = observed["lastCall"].clone();
            } else { tools.push(observed); }
        });
    }

    pub fn finish(&self) { self.update(|v| v["active"] = false.into()); }
}

/// A separate guard makes closure clones passive; only the launch owner finishes.
pub struct Owner(pub Option<Capture>);
impl Drop for Owner { fn drop(&mut self) { if let Some(c) = &self.0 { c.finish(); } } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scope_identity_includes_account_model_and_session() {
        let mut a = Scope {workspace_id:"a".into(),session_id:"b".into(),agent_id:"codex".into(),provider_id:"one".into(),channel_id:"".into(),model:"m".into()};
        let key = a.key(); a.provider_id = "two".into(); assert_ne!(key,a.key());
        assert_eq!(key,hex::encode(Sha256::digest(br#"["a","b","codex","one","","m"]"#)));
    }

    #[test]
    fn native_pages_drop_old_generations_and_remove_withdrawn_tools() {
        let mut env=HashMap::new();
        env.insert("UGS_WORKSPACE_ID".into(),"tool-catalog-fixture".into());
        env.insert("UGS_SESSION_ID".into(),format!("test-{}",crate::now_ms()));
        let c=Capture::start(Some(&env),"codex",Some("m"),"run-one").unwrap();
        let first=c.begin_codex();
        let raw=json!({"data":[{"name":"s","runtimeStatus":"connected","tools":{"mcp__s__lookup":{"name":"lookup","inputSchema":{"type":"object"}}}}]});
        c.codex_page(&first,&raw).unwrap();
        assert_eq!(read(&c.scope).unwrap().unwrap()["tools"].as_array().unwrap().len(),1);
        let second=c.begin_codex();
        c.codex_page(&first,&raw).unwrap();
        c.codex_page(&second,&json!({"data":[{"name":"s","runtimeStatus":"connected","tools":{}}]})).unwrap();
        assert!(read(&c.scope).unwrap().unwrap()["tools"].as_array().unwrap().is_empty());
        let second_run=Capture::start(Some(&env),"codex",Some("m"),"run-two").unwrap();
        c.finish();
        assert_eq!(read(&c.scope).unwrap().unwrap()["runId"],"run-two");
        assert_eq!(read(&c.scope).unwrap().unwrap()["active"],true);
        second_run.finish();
        std::fs::remove_file(path(&c.scope).unwrap()).unwrap();
        memory().lock().unwrap().remove(&c.scope.key());
    }

    #[test]
    fn optional_live_agent_fixture_uses_native_adapter() {
        let Ok(dir)=std::env::var("UGS_TOOL_CATALOG_LIVE_FIXTURE") else {return;};
        let live:Value=serde_json::from_slice(&std::fs::read(std::path::Path::new(&dir).join("codex-live.json")).unwrap()).unwrap();
        let mut env=HashMap::new();env.insert("UGS_WORKSPACE_ID".into(),"tool-catalog-live".into());env.insert("UGS_SESSION_ID".into(),"codex".into());
        let capture=Capture::start(Some(&env),"codex",Some("default"),"codex-live-verification").unwrap();
        let id=capture.begin_codex();capture.codex_page(&id,&json!({"data":live["servers"]})).unwrap();capture.finish();
        let value=read(&capture.scope).unwrap().unwrap();
        assert_eq!(value["tools"].as_array().unwrap().len(),live["toolCount"].as_u64().unwrap() as usize);
        std::fs::write(std::path::Path::new(&dir).join("codex-catalog.json"),serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let claude:Value=serde_json::from_slice(&std::fs::read(std::path::Path::new(&dir).join("claude-live.json")).unwrap()).unwrap();
        env.insert("UGS_SESSION_ID".into(),"claude".into());
        let capture=Capture::start(Some(&env),"claude-code",Some("default"),"claude-live-verification").unwrap();
        capture.claude_init(&json!({"tools":claude["tools"]}));capture.finish();
        let value=read(&capture.scope).unwrap().unwrap();assert_eq!(value["coverage"][0]["level"],"names");
        std::fs::write(std::path::Path::new(&dir).join("claude-catalog.json"),serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
}
