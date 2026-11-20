//! Preserve the Gemini CLI when Kuro's gateway only exposes OpenAI-compatible APIs.
//! Each CLI invocation receives an authenticated loopback proxy with its own lifetime.
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

pub(crate) struct KuroGeminiProxy {
    pub base_url: String,
    pub token: String,
    stopped: Arc<AtomicBool>,
}

impl Drop for KuroGeminiProxy {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
    }
}

pub(crate) fn is_kuro_gateway(base: &str) -> bool {
    let Ok(url) = url::Url::parse(base) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("ai-gateway.kurogames.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "" | "/" | "/v1" | "/v1/")
}

impl KuroGeminiProxy {
    pub(crate) fn start(api_key: String) -> Result<Self, String> {
        let server =
            Server::http("127.0.0.1:0").map_err(|e| format!("启动 Gemini 协议适配失败：{e}"))?;
        let addr = server
            .server_addr()
            .to_ip()
            .ok_or("无法读取 Gemini 协议适配端口")?;
        let mut secret = [0u8; 32];
        getrandom::getrandom(&mut secret).map_err(|e| format!("生成本地鉴权令牌失败：{e}"))?;
        let token = URL_SAFE_NO_PAD.encode(secret);
        let stopped = Arc::new(AtomicBool::new(false));
        let thread_stopped = Arc::clone(&stopped);
        let thread_token = token.clone();
        std::thread::Builder::new()
            .name("ugs-gemini-kuro-proxy".into())
            .spawn(move || {
                while !thread_stopped.load(Ordering::Acquire) {
                    match server.recv_timeout(Duration::from_millis(200)) {
                        Ok(Some(request)) => {
                            let token = thread_token.clone();
                            let api_key = api_key.clone();
                            std::thread::spawn(move || {
                                handle_request(request, &token, &api_key, addr.port())
                            });
                        }
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("启动 Gemini 协议适配线程失败：{e}"))?;
        Ok(Self {
            base_url: format!("http://127.0.0.1:{}", addr.port()),
            token,
            stopped,
        })
    }
}

fn respond_error(request: Request, status: u16, message: &str) {
    let body =
        json!({"error":{"code":status,"message":message,"status":"UPSTREAM_ERROR"}}).to_string();
    let mut response = Response::from_string(body).with_status_code(status);
    if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        response.add_header(header);
    }
    let _ = request.respond(response);
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn handle_request(mut request: Request, token: &str, api_key: &str, port: u16) {
    let host = format!("127.0.0.1:{port}");
    let authorized = header(&request, "x-goog-api-key") == Some(token)
        || header(&request, "authorization").and_then(|h| h.strip_prefix("Bearer ")) == Some(token);
    if !authorized
        || header(&request, "host") != Some(host.as_str())
        || !request.remote_addr().is_some_and(|a| a.ip().is_loopback())
    {
        respond_error(request, 403, "本地 Gemini 协议适配鉴权失败");
        return;
    }
    let path = request.url().split('?').next().unwrap_or("");
    let model = path
        .strip_prefix("/v1beta/models/")
        .or_else(|| path.strip_prefix("/v1/models/"))
        .and_then(|p| p.strip_suffix(":streamGenerateContent"))
        .filter(|m| {
            !m.is_empty()
                && m.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
        .map(str::to_owned);
    let Some(model) = model else {
        respond_error(request, 404, "本地 Gemini 协议适配不支持此接口");
        return;
    };
    if request.method() != &Method::Post {
        respond_error(request, 405, "请求方法不受支持");
        return;
    }
    let mut bytes = Vec::new();
    if request
        .as_reader()
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() > 64 * 1024 * 1024
    {
        respond_error(request, 413, "Gemini 请求过大或无法读取");
        return;
    }
    let body: Value = match serde_json::from_slice(&bytes) {
        Ok(body) => body,
        Err(_) => {
            respond_error(request, 400, "Gemini 请求不是有效 JSON");
            return;
        }
    };
    let translated = match gemini_to_openai(&body, &model) {
        Ok(value) => value,
        Err(error) => {
            respond_error(request, 400, &error);
            return;
        }
    };
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let response = agent
        .post("https://ai-gateway.kurogames.com/v1/chat/completions")
        .set("content-type", "application/json")
        .set("accept", "text/event-stream")
        .set("authorization", &format!("Bearer {api_key}"))
        .send_string(&translated.to_string());
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(status, response)) => {
            let detail = response
                .into_string()
                .unwrap_or_default()
                .replace(api_key, "[隐藏]");
            respond_error(request, status, &format!("Kuro 网关：{detail}"));
            return;
        }
        Err(error) => {
            respond_error(request, 502, &format!("连接 Kuro 网关失败：{error}"));
            return;
        }
    };
    if !response
        .header("content-type")
        .unwrap_or("")
        .to_ascii_lowercase()
        .contains("text/event-stream")
    {
        respond_error(request, 502, "Kuro 网关未返回流式响应");
        return;
    }
    let mut writer = request.into_writer();
    if writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n").is_err() { return; }
    let reader = BufReader::new(response.into_reader());
    let mut translator = StreamTranslator::default();
    let result = translate_stream(reader, &mut translator, |event| {
        let data = format!("data: {event}\n\n");
        writer.write_all(format!("{:x}\r\n", data.len()).as_bytes())?;
        writer.write_all(data.as_bytes())?;
        writer.write_all(b"\r\n")?;
        writer.flush()
    });
    if result.is_ok() {
        let _ = writer.write_all(b"0\r\n\r\n");
        let _ = writer.flush();
    }
}

fn gemini_to_openai(body: &Value, model: &str) -> Result<Value, String> {
    let mut messages = Vec::new();
    if let Some(parts) = body
        .pointer("/systemInstruction/parts")
        .and_then(Value::as_array)
    {
        let text = parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            messages.push(json!({"role":"system","content":text}));
        }
    }
    let mut pending: HashMap<String, Vec<String>> = HashMap::new();
    let mut next_id = 0usize;
    for content in body
        .get("contents")
        .and_then(Value::as_array)
        .ok_or("Gemini 请求缺少 contents")?
    {
        let role = content
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let parts = content
            .get("parts")
            .and_then(Value::as_array)
            .ok_or("Gemini 消息缺少 parts")?;
        let mut blocks = Vec::new();
        let mut tool_calls = Vec::new();
        let mut tool_results = Vec::new();
        for part in parts {
            if part.get("thought").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                blocks.push(json!({"type":"text","text":text}));
            } else if let Some(inline) = part.get("inlineData") {
                let mime = inline.get("mimeType").and_then(Value::as_str).unwrap_or("");
                let data = inline.get("data").and_then(Value::as_str).unwrap_or("");
                if !mime.starts_with("image/") || data.is_empty() {
                    return Err("暂不支持此 Gemini 多模态内容".into());
                }
                blocks.push(json!({"type":"image_url","image_url":{"url":format!("data:{mime};base64,{data}")}}));
            } else if let Some(call) = part.get("functionCall") {
                let name = call
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or("工具调用缺少名称")?;
                next_id += 1;
                let id = call
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("call_ugs_{next_id}"));
                pending.entry(name.into()).or_default().push(id.clone());
                tool_calls.push(json!({"id":id,"type":"function","function":{"name":name,"arguments":call.get("args").cloned().unwrap_or_else(|| json!({})).to_string()}}));
            } else if let Some(response) = part.get("functionResponse") {
                let name = response.get("name").and_then(Value::as_str).unwrap_or("");
                let id = response
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| {
                        pending.get_mut(name).and_then(|ids| {
                            if ids.is_empty() {
                                None
                            } else {
                                Some(ids.remove(0))
                            }
                        })
                    })
                    .ok_or("工具结果缺少对应的调用 ID")?;
                if let Some(ids) = pending.get_mut(name) {
                    ids.retain(|pending_id| pending_id != &id);
                }
                let value = response.get("response").cloned().unwrap_or(Value::Null);
                let output = value
                    .get("output")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                tool_results.push(json!({"role":"tool","tool_call_id":id,"content":output}));
            } else if part.get("thoughtSignature").is_none() {
                return Err("暂不支持此 Gemini 消息内容".into());
            }
        }
        if role == "model" {
            let text = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("");
            let mut message = json!({"role":"assistant","content":if text.is_empty() { Value::Null } else { Value::String(text) }});
            if !tool_calls.is_empty() {
                message["tool_calls"] = Value::Array(tool_calls);
            }
            messages.push(message);
        } else {
            messages.extend(tool_results);
            if !blocks.is_empty() {
                let text_only = blocks
                    .iter()
                    .all(|b| b.get("type").and_then(Value::as_str) == Some("text"));
                let value = if text_only {
                    Value::String(
                        blocks
                            .iter()
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n"),
                    )
                } else {
                    Value::Array(blocks)
                };
                messages.push(json!({"role":"user","content":value}));
            }
        }
    }
    let mut result = json!({"model":model,"messages":messages,"stream":true,"stream_options":{"include_usage":true}});
    let mut tools = Vec::new();
    for group in body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(declarations) = group.get("functionDeclarations").and_then(Value::as_array) {
            for declaration in declarations {
                let name = declaration
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or("工具定义缺少名称")?;
                let parameters = declaration
                    .get("parametersJsonSchema")
                    .or_else(|| declaration.get("parameters"))
                    .cloned()
                    .unwrap_or_else(|| json!({"type":"object","properties":{}}));
                let mut function = json!({"name":name,"parameters":parameters});
                if let Some(description) = declaration.get("description") {
                    function["description"] = description.clone();
                }
                tools.push(json!({"type":"function","function":function}));
            }
        } else {
            return Err("Kuro 网关不支持此 Gemini 工具类型".into());
        }
    }
    if !tools.is_empty() {
        result["tools"] = Value::Array(tools);
    }
    for (from, to) in [
        ("temperature", "temperature"),
        ("topP", "top_p"),
        ("maxOutputTokens", "max_tokens"),
        ("stopSequences", "stop"),
    ] {
        if let Some(value) = body.pointer(&format!("/generationConfig/{from}")) {
            result[to] = value.clone();
        }
    }
    if let Some(level) = body
        .pointer("/generationConfig/thinkingConfig/thinkingLevel")
        .and_then(Value::as_str)
    {
        result["reasoning_effort"] = Value::String(level.to_ascii_lowercase());
    }
    if let Some(mode) = body
        .pointer("/toolConfig/functionCallingConfig/mode")
        .and_then(Value::as_str)
    {
        match mode {
            "NONE" => result["tool_choice"] = json!("none"),
            "ANY" => result["tool_choice"] = json!("required"),
            _ => {}
        }
    }
    Ok(result)
}

#[derive(Default)]
struct ToolDelta {
    id: String,
    name: String,
    arguments: String,
}

#[derive(Default)]
struct StreamTranslator {
    tools: BTreeMap<u64, ToolDelta>,
    finish: Option<String>,
    emitted: bool,
}

impl StreamTranslator {
    fn accept(&mut self, chunk: &Value) -> Result<Vec<Value>, String> {
        if let Some(error) = chunk.get("error") {
            return Err(format!("Kuro 网关流式错误：{error}"));
        }
        let mut events = Vec::new();
        if let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|v| v.first())
        {
            let delta = &choice["delta"];
            for (field, thought) in [("reasoning_content", true), ("content", false)] {
                if let Some(text) = delta
                    .get(field)
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    let mut part = json!({"text":text});
                    if thought {
                        part["thought"] = json!(true);
                    }
                    events.push(json!({"candidates":[{"index":0,"content":{"role":"model","parts":[part]}}]}));
                    self.emitted = true;
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                    let entry = self.tools.entry(index).or_default();
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        entry.id.push_str(id);
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        entry.name.push_str(name);
                    }
                    if let Some(args) = call.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        entry.arguments.push_str(args);
                    }
                }
            }
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.finish = Some(reason.into());
            }
        }
        if let Some(usage) = chunk.get("usage").filter(|v| v.is_object()) {
            let input = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let total = usage
                .get("total_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(input + output);
            events.push(json!({"usageMetadata":{"promptTokenCount":input,"candidatesTokenCount":output,"totalTokenCount":total}}));
        }
        Ok(events)
    }

    fn finish(&mut self) -> Result<Value, String> {
        let mut parts = Vec::new();
        for (index, call) in &self.tools {
            if call.name.is_empty() {
                return Err("Kuro 网关返回了没有名称的工具调用".into());
            }
            let args: Value = serde_json::from_str(if call.arguments.is_empty() {
                "{}"
            } else {
                &call.arguments
            })
            .map_err(|_| "Kuro 网关返回了无效的工具参数".to_string())?;
            let id = if call.id.is_empty() {
                format!("call_ugs_{index}")
            } else {
                call.id.clone()
            };
            parts.push(json!({"functionCall":{"id":id,"name":call.name,"args":args}}));
        }
        if !parts.is_empty() {
            self.emitted = true;
        }
        let finish = match self.finish.as_deref() {
            Some("length") => "MAX_TOKENS",
            Some("content_filter") => "SAFETY",
            _ => "STOP",
        };
        if !self.emitted && self.finish.is_none() {
            return Err("Kuro 网关流未返回有效内容".into());
        }
        Ok(
            json!({"candidates":[{"index":0,"content":{"role":"model","parts":parts},"finishReason":finish}]}),
        )
    }
}

fn translate_stream<R: BufRead>(
    mut reader: R,
    translator: &mut StreamTranslator,
    mut emit: impl FnMut(&Value) -> std::io::Result<()>,
) -> Result<(), String> {
    let mut line = String::new();
    let mut data = String::new();
    let mut done = false;
    loop {
        line.clear();
        let count = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取 Kuro 流失败：{e}"))?;
        if count == 0 || line.trim_end_matches(['\r', '\n']).is_empty() {
            if !data.is_empty() {
                if data == "[DONE]" {
                    done = true;
                    break;
                }
                let value: Value = serde_json::from_str(&data)
                    .map_err(|_| "Kuro 网关返回了无效的流式 JSON".to_string())?;
                for event in translator.accept(&value)? {
                    emit(&event).map_err(|e| e.to_string())?;
                }
                data.clear();
            }
            if count == 0 {
                break;
            }
        } else if let Some(value) = line.trim_end_matches(['\r', '\n']).strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    if !done {
        return Err("Kuro 网关流提前中断".into());
    }
    emit(&translator.finish()?).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn forwards_tool_calls_and_results_with_the_same_ids() {
        let input = json!({
            "systemInstruction":{"parts":[{"text":"system"}]},
            "contents":[
                {"role":"user","parts":[{"text":"read it"}]},
                {"role":"model","parts":[{"functionCall":{"id":"call_1","name":"read_file","args":{"file_path":"a.txt"}}}]},
                {"role":"user","parts":[{"functionResponse":{"id":"call_1","name":"read_file","response":{"output":"hello"}}}]}
            ],
            "tools":[{"functionDeclarations":[{"name":"read_file","parametersJsonSchema":{"type":"object"}}]}]
        });
        let output = gemini_to_openai(&input, "gemini-4-hydrogen").unwrap();
        assert_eq!(output["model"], "gemini-4-hydrogen");
        assert_eq!(output["messages"][2]["tool_calls"][0]["id"], "call_1");
        assert_eq!(output["messages"][3]["tool_call_id"], "call_1");
        assert_eq!(
            output["tools"][0]["function"]["parameters"]["type"],
            "object"
        );
    }

    #[test]
    fn matches_only_the_known_kuro_gateway() {
        assert!(is_kuro_gateway("https://ai-gateway.kurogames.com"));
        assert!(is_kuro_gateway("https://ai-gateway.kurogames.com/v1/"));
        for base in [
            "https://ai-gateway.kurogames.com.evil.test",
            "http://ai-gateway.kurogames.com",
            "https://ai-gateway.kurogames.com/another",
            "https://generativelanguage.googleapis.com",
        ] {
            assert!(!is_kuro_gateway(base));
        }
    }

    #[test]
    fn streams_text_and_reassembles_fragmented_tool_calls() {
        let data = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"file_\"}}]},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"path\\\":\\\"a.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,\"total_tokens\":13}}\n\n",
            "data: [DONE]\n\n"
        );
        let mut events = Vec::new();
        translate_stream(data.as_bytes(), &mut StreamTranslator::default(), |v| {
            events.push(v.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            events[0]["candidates"][0]["content"]["parts"][0]["text"],
            "hello"
        );
        assert_eq!(events[1]["usageMetadata"]["totalTokenCount"], 13);
        assert_eq!(
            events[2]["candidates"][0]["content"]["parts"][0]["functionCall"],
            json!({"id":"call_1","name":"read_file","args":{"file_path":"a.txt"}})
        );
    }

    #[test]
    fn rejects_truncated_stream_and_unsupported_parts() {
        assert!(translate_stream(
            b"data: {\"choices\":[]}\n\n".as_slice(),
            &mut StreamTranslator::default(),
            |_| Ok(())
        )
        .is_err());
        assert!(gemini_to_openai(
            &json!({"contents":[{"role":"user","parts":[{"fileData":{"fileUri":"x"}}]}]}),
            "model"
        )
        .is_err());
    }

    #[test]
    #[ignore = "需要本机 Gemini CLI 和 Kuro 渠道密钥，手动验证真实网关"]
    fn live_gemini_cli_text_and_tool_round_trip() {
        use std::process::Command;
        let key = std::env::var("UGS_GEMINI_KURO_LIVE_KEY").expect("需要渠道密钥");
        let proxy = KuroGeminiProxy::start(key).unwrap();
        let home = std::env::var("USERPROFILE").unwrap();
        let binary = std::path::Path::new(&home).join(".bun/bin/gemini.exe");
        let output = Command::new(binary)
            .args([
                "--model",
                "gemini-4-hydrogen",
                "--prompt",
                "必须使用 read_file 工具读取 .editorconfig，然后只报告其中的 end_of_line 值。",
                "--output-format",
                "stream-json",
                "--skip-trust",
                "--approval-mode",
                "yolo",
            ])
            .current_dir(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .parent()
                    .unwrap(),
            )
            .env("GOOGLE_GEMINI_BASE_URL", &proxy.base_url)
            .env("GOOGLE_API_KEY", &proxy.token)
            .env("GEMINI_API_KEY", &proxy.token)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "CLI 失败：{stderr}\n{stdout}");
        assert!(
            stdout.contains("\"tool_name\":\"read_file\""),
            "未观察到读取工具：{stdout}"
        );
        assert!(
            stdout.contains("\"status\":\"success\""),
            "未观察到成功结果：{stdout}"
        );
        assert!(
            stdout.to_ascii_lowercase().contains("lf"),
            "未观察到文件内容：{stdout}"
        );
    }

    #[test]
    #[ignore = "需要本机 Gemini CLI 和 Kuro 渠道密钥，手动验证真实网关"]
    fn live_gemini_cli_reads_image() {
        use std::process::Command;
        let key = std::env::var("UGS_GEMINI_KURO_LIVE_KEY").expect("需要渠道密钥");
        let proxy = KuroGeminiProxy::start(key).unwrap();
        let home = std::env::var("USERPROFILE").unwrap();
        let output = Command::new(std::path::Path::new(&home).join(".bun/bin/gemini.exe"))
            .args(["--model", "gemini-4-hydrogen", "--prompt", "必须使用 read_file 读取 app/public/vcs/tortoisegit/ReplacedIcon.png 图片，简短描述看到的图案。", "--output-format", "stream-json", "--skip-trust", "--approval-mode", "yolo"])
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap())
            .env("GOOGLE_GEMINI_BASE_URL", &proxy.base_url)
            .env("GOOGLE_API_KEY", &proxy.token)
            .env("GEMINI_API_KEY", &proxy.token)
            .output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "CLI 失败：{stderr}\n{stdout}");
        assert!(
            stdout.contains("\"tool_name\":\"read_file\""),
            "未观察到读取工具：{stdout}"
        );
        assert!(
            stdout.contains("Read image file:"),
            "图片未成功读取：{stdout}"
        );
        assert!(
            stdout.contains("\"status\":\"success\""),
            "未观察到成功结果：{stdout}"
        );
    }
}
