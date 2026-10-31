//! Project discovery owns a temporary connection. It never touches Agent-owned clients.
mod legacy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, io::{BufRead, BufReader, Read, Write}, path::Path,
    process::{Child, ChildStdin, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex, OnceLock}, time::Duration};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub id: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub url: Option<String>,
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub server_id: String,
    pub ok: bool,
    pub status: String,
    pub message: String,
    pub tools_count: Option<usize>,
    pub checked_at_ms: u64,
    pub tools: Vec<Value>,
    pub catalog_coverage: String,
    pub protocol_version: Option<String>,
    pub server_info: Option<Value>,
    pub capabilities: Option<Value>,
}

type Error = (String, String);
fn err(code: &str, message: impl Into<String>) -> Error { (code.into(), message.into()) }
fn cancelled(flag: &AtomicBool) -> Result<(), Error> {
    if flag.load(Ordering::Relaxed) { Err(err("cancelled", "目录发现已取消")) } else { Ok(()) }
}

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub fn tool_catalog_cancel(request_id: String) {
    if let Ok(mut map) = jobs().lock() { map.entry(request_id).or_insert_with(||Arc::new(AtomicBool::new(false))).store(true, Ordering::Relaxed); }
}

pub fn probe(root: &Path, server: &ServerConfig, request_id: Option<String>) -> ProbeResult {
    let flag = request_id.as_ref().and_then(|id|jobs().lock().ok().map(|mut map|map.entry(id.clone()).or_insert_with(||Arc::new(AtomicBool::new(false))).clone()))
        .unwrap_or_else(||Arc::new(AtomicBool::new(false)));
    let mut result = ProbeResult {server_id:server.id.clone(),ok:false,status:"discovering".into(),
        message:String::new(),tools_count:None,checked_at_ms:crate::now_ms(),tools:vec![],catalog_coverage:"unknown".into(),
        protocol_version:None,server_info:None,capabilities:None};
    let outcome = discover(root,server,&flag,&mut result);
    if let Some(id) = &request_id { if let Ok(mut map) = jobs().lock() { map.remove(id); } }
    result.checked_at_ms = crate::now_ms();
    match outcome {
        Ok(()) => { result.ok=true;result.status="connected".into();result.catalog_coverage="full".into();
            result.tools_count=Some(result.tools.len());result.message=format!("MCP 握手与分页读取完成，发现 {} 个工具；探测连接已释放。",result.tools.len()); },
        Err((code,message)) => { result.status=code;result.message=message; },
    }
    result
}

enum Transport {
    Stdio { child: Child, stdin: ChildStdin, rx: mpsc::Receiver<String> },
    Http { agent: ureq::Agent, url: String, headers: HashMap<String,String>, session: Option<String>, version: Option<String> },
    Legacy { agent: ureq::Agent, url: String, headers: HashMap<String,String>, rx: mpsc::Receiver<String>, _stream: legacy::LegacyStream },
}

impl Drop for Transport {
    fn drop(&mut self) {
        if let Self::Stdio {child,..} = self { crate::terminate_child_tree(child);let _=child.wait(); }
        if let Self::Http {agent,url,headers,session:Some(session),version,..} = self {
            let mut req=agent.delete(url).set("Mcp-Session-Id",session).timeout(Duration::from_secs(2));
            for (k,v) in headers.iter() { req=req.set(k,v); }
            if let Some(v)=version {req=req.set("MCP-Protocol-Version",v);}
            let _=req.call();
        }
    }
}

fn rpc_response(value: Value, id: &Value) -> Result<Option<Value>, Error> {
    if value.get("id") != Some(id) {return Ok(None);}
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {return Err(err("protocol-error","MCP 响应缺少 jsonrpc 2.0"));}
    if let Some(error)=value.get("error") {
        return Err(err("rpc-error",format!("MCP 返回错误: {}",error["message"].as_str().unwrap_or("未提供原因"))));
    }
    value.get("result").cloned().map(Some).ok_or_else(||err("protocol-error","MCP 响应缺少 result"))
}

fn recv_response(rx: &mpsc::Receiver<String>, id: &Value, flag: &AtomicBool) -> Result<Value,Error> {
    let deadline=std::time::Instant::now()+Duration::from_secs(60);
    loop {
        cancelled(flag)?;
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line)=> {if let Ok(value)=serde_json::from_str(&line) {if let Some(result)=rpc_response(value,id)? {return Ok(result);}}},
            Err(mpsc::RecvTimeoutError::Disconnected)=>return Err(err("disconnected","MCP 连接在完成目录发现前关闭")),
            Err(mpsc::RecvTimeoutError::Timeout)=>{},
        }
        if std::time::Instant::now()>deadline {return Err(err("discovery-timeout","目录查询 60 秒未收到对应响应；仅回收 UGS 探测连接"));}
    }
}

fn sse_reader(reader: impl Read, mut on_event: impl FnMut(&str,&str) -> bool) -> Result<(),Error> {
    let mut event=String::new();let mut data=String::new();let mut total=0usize;
    for line in BufReader::new(reader).lines() {
        let line=line.map_err(|e|err("stream-error",format!("MCP SSE 读取失败: {e}")))?;
        total+=line.len();if total>16*1024*1024 {return Err(err("response-too-large","MCP 响应超过 16 MiB"));}
        if line.is_empty() {
            if !data.is_empty() && !on_event(&event,data.trim_end_matches('\n')) {return Ok(());}
            event.clear();data.clear();
        } else if let Some(value)=line.strip_prefix("event:") {event=value.trim().into();}
        else if let Some(value)=line.strip_prefix("data:") {data.push_str(value.strip_prefix(' ').unwrap_or(value));data.push('\n');}
    }
    if !data.is_empty() {on_event(&event,data.trim_end_matches('\n'));}
    Ok(())
}

fn http_status(e: ureq::Error) -> Error {
    match e {
        ureq::Error::Status(code,_)=>err(if code==401||code==403 {"auth-required"}else{"http-error"},format!("MCP HTTP 返回 {code}")),
        e=>err("http-unreachable",format!("MCP HTTP 连接失败: {e}")),
    }
}

impl Transport {
    fn open(root:&Path,server:&ServerConfig,flag:&AtomicBool)->Result<Self,Error> {
        cancelled(flag)?;
        if server.transport=="stdio" {
            let command=server.command.as_deref().filter(|v|!v.trim().is_empty()).ok_or_else(||err("missing-command","MCP 命令为空"))?;
            let command=crate::project_expand_path_text(command);
            let root_text=crate::project_path_display(root);
            let mut cmd=crate::new_spawn_command(&command);
            cmd.current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            for arg in server.args.as_deref().unwrap_or(&[]) {cmd.arg(crate::project_expand_path_text(&arg.replace("{workspace}",&root_text)));}
            for (key,value) in server.env.as_ref().into_iter().flatten() {cmd.env(key,value.replace("{workspace}",&root_text));}
            cmd.env("MCP_CLIENT_NAME","UltraGameStudio");
            let mut child=cmd.spawn().map_err(|e|err("spawn-failed",format!("启动 MCP 失败: {e}")))?;
            let stdin=child.stdin.take().unwrap();let stdout=child.stdout.take().unwrap();
            let (tx,rx)=mpsc::channel();
            std::thread::spawn(move||{for line in BufReader::new(stdout).lines().map_while(Result::ok) {if tx.send(line).is_err(){break;}}});
            // Drain diagnostics independently: stderr JSON is never protocol evidence.
            if let Some(stderr)=child.stderr.take() {std::thread::spawn(move||{let _=std::io::copy(&mut BufReader::new(stderr),&mut std::io::sink());});}
            return Ok(Self::Stdio {child,stdin,rx});
        }
        if !["streamable-http","http","sse"].contains(&server.transport.as_str()) {
            return Err(err("unsupported-transport",format!("不支持 {} 传输",server.transport)));
        }
        let url=server.url.as_deref().filter(|v|!v.trim().is_empty()).ok_or_else(||err("missing-url","MCP URL 为空"))?;
        let headers=server.headers.clone().unwrap_or_default();
        // No ambient proxy for local hosts; retain the configured endpoint exactly.
        let agent=ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout_read(Duration::from_secs(30)).build();
        if server.transport!="sse" {return Ok(Self::Http{agent,url:url.into(),headers,session:None,version:None});}
        let (stream,endpoint,rx)=legacy::LegacyStream::open(url, &headers, flag)?;
        // Prevent an SSE endpoint from sending configured credentials to another host.
        let base=ureq_url(url)?;
        let endpoint=base.join(&endpoint).map_err(|e|err("protocol-error",e.to_string()))?;
        if endpoint.origin()!=base.origin() {return Err(err("protocol-error","旧 SSE endpoint 与配置地址不同源"));}
        Ok(Self::Legacy {agent,url:endpoint.to_string(),headers,rx,_stream:stream})
    }

    fn send(&mut self,message:&Value,flag:&AtomicBool)->Result<Option<Value>,Error> {
        cancelled(flag)?;
        let id=message.get("id");
        match self {
            Self::Stdio {stdin,rx,..}=> {
                writeln!(stdin,"{message}").and_then(|_|stdin.flush()).map_err(|e|err("write-failed",format!("写入 MCP 失败: {e}")))?;
                id.map(|id|recv_response(rx,id,flag)).transpose()
            },
            Self::Http {agent,url,headers,session,version}=> {
                let mut req=agent.post(url).set("Accept","application/json, text/event-stream");
                for (k,v) in headers.iter(){req=req.set(k,v);}
                if let Some(s)=session.as_deref(){req=req.set("Mcp-Session-Id",s);}
                if let Some(v)=version.as_deref(){req=req.set("MCP-Protocol-Version",v);}
                let response=req.send_json(message.clone()).map_err(http_status)?;
                if let Some(value)=response.header("Mcp-Session-Id") {*session=Some(value.into());}
                let Some(id)=id else {return Ok(None);};
                let content_type=response.header("Content-Type").unwrap_or("").to_owned();
                let mut found=None;
                if content_type.starts_with("text/event-stream") {
                    sse_reader(response.into_reader(),|_,data| {
                        if let Ok(v)=serde_json::from_str(data) {match rpc_response(v,id) {Ok(Some(v))=>{found=Some(Ok(v));return false;},Err(e)=>{found=Some(Err(e));return false;},_=>{}}} true
                    })?;
                } else if content_type.starts_with("application/json") {
                    let mut text=String::new(); response.into_reader().take(16*1024*1024+1).read_to_string(&mut text).map_err(|e|err("stream-error",e.to_string()))?;
                    if text.len()>16*1024*1024 {return Err(err("response-too-large","MCP 响应超过 16 MiB"));}
                    let value=serde_json::from_str(&text).map_err(|e|err("protocol-error",format!("MCP JSON 无效: {e}")))?;
                    found=rpc_response(value,id)?.map(Ok);
                } else {return Err(err("protocol-error",format!("MCP 响应类型不支持: {content_type}")));}
                cancelled(flag)?;
                found.ok_or_else(||err("protocol-error","MCP 未返回对应请求响应"))?.map(Some)
            },
            Self::Legacy {agent,url,headers,rx,..}=> {
                let mut req=agent.post(url);
                for (k,v) in headers.iter(){req=req.set(k,v);}
                req.send_json(message.clone()).map_err(http_status)?;
                id.map(|id|recv_response(rx,id,flag)).transpose()
            },
        }
    }
}

// `url` is already a transitive ureq dependency; use the crate directly (Cargo declares it).
fn ureq_url(url:&str)->Result<url::Url,Error> {url::Url::parse(url).map_err(|e|err("invalid-url",e.to_string()))}

fn discover(root:&Path,server:&ServerConfig,flag:&AtomicBool,result:&mut ProbeResult)->Result<(),Error> {
    let mut transport=Transport::open(root,server,flag)?;
    let init=transport.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"UltraGameStudio","version":env!("CARGO_PKG_VERSION")}}}),flag)?.unwrap();
    let version=init["protocolVersion"].as_str().ok_or_else(||err("protocol-error","initialize 未返回 protocolVersion"))?;
    if init["serverInfo"]["name"].as_str().is_none() || init["serverInfo"]["version"].as_str().is_none() || init["capabilities"].as_object().is_none() {
        return Err(err("protocol-error","initialize 缺少合法 serverInfo 或 capabilities"));
    }
    if !["2025-11-25","2025-06-18","2025-03-26","2024-11-05"].contains(&version) {
        return Err(err("unsupported-version",format!("MCP 协商版本不支持: {version}")));
    }
    result.protocol_version=Some(version.into());result.server_info=init.get("serverInfo").cloned();result.capabilities=init.get("capabilities").cloned();
    if let Transport::Http {version:current,..}=&mut transport {*current=Some(version.into());}
    transport.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}),flag)?;
    if init.pointer("/capabilities/tools").and_then(Value::as_object).is_none() {
        return Err(err("tools-unsupported","服务器未声明 tools 能力；不能将未知目录当成 0 个工具"));
    }
    let mut cursor:Option<String>=None;let mut cursors=HashSet::new();let mut names=HashSet::new();let mut id=2;
    loop {
        let params=cursor.as_ref().map(|c|json!({"cursor":c})).unwrap_or(json!({}));
        let page=transport.send(&json!({"jsonrpc":"2.0","id":id,"method":"tools/list","params":params}),flag)?.unwrap();
        let tools=page["tools"].as_array().ok_or_else(||err("invalid-tools","tools/list 缺少合法 tools 数组"))?;
        for tool in tools {
            let name=tool["name"].as_str().filter(|n|!n.is_empty()).ok_or_else(||err("invalid-tool","工具缺少名称"))?;
            if tool["inputSchema"].as_object().is_none() {return Err(err("invalid-schema",format!("工具 {name} 缺少 inputSchema 对象")));}
            if !names.insert(name.to_owned()) {return Err(err("duplicate-tool",format!("同一服务重复工具名称: {name}")));}
            result.tools.push(tool.clone());
        }
        cursor=match page.get("nextCursor") {
            None|Some(Value::Null)=>None,
            Some(Value::String(c)) if c.is_empty()=>None,
            Some(Value::String(c))=>Some(c.clone()),
            _=>return Err(err("invalid-cursor","nextCursor 不是字符串")),
        };
        let Some(next)=&cursor else {break;};
        if !cursors.insert(next.clone()) {return Err(err("cursor-loop","MCP 分页游标循环；保留已发现条目，不声明完整"));}
        id+=1;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
