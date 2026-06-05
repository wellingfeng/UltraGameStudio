//! Built-in local HTTP translation proxy for FreeUltraCode "free channels".
//!
//! When the user picks the `claude-code` runtime with a free channel, the
//! `claude` CLI is pointed at `http://127.0.0.1:<port>/ch/<channelId>`
//! (`ANTHROPIC_BASE_URL`). The CLI appends `/v1/messages`, so requests arrive
//! here as `POST /ch/<id>/v1/messages` with an Anthropic Messages JSON body.
//!
//! This proxy holds the real upstream config per channel and either:
//!   - reverse-proxies the request to a native Anthropic endpoint (`transport: "anthropic"`), or
//!   - translates Anthropic <-> OpenAI chat-completions SSE (`transport: "openai"`).
//!
//! Binds 127.0.0.1 ONLY. Uses tiny_http (blocking server) + ureq (upstream).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

/// Per-channel upstream config sent from the JS layer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreeChannelCfg {
    pub id: String,
    #[serde(default)]
    pub label: String,
    /// "openai" | "anthropic" | "auto"
    pub transport: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub fallback_models: Vec<String>,
}

/// Returned to JS from `free_proxy_ensure`.
#[derive(Debug, Clone, Serialize)]
pub struct FreeProxyInfo {
    pub port: u16,
    pub token: String,
}

struct ProxyState {
    port: u16,
    token: String,
}

static SERVER_STATE: OnceLock<Mutex<Option<ProxyState>>> = OnceLock::new();
static REGISTRY: OnceLock<Mutex<HashMap<String, FreeChannelCfg>>> = OnceLock::new();
static REGISTRY_ORDER: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
static MODEL_SUCCESS_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static CHANNEL_COOLDOWNS: OnceLock<Mutex<HashMap<String, ChannelCooldown>>> = OnceLock::new();
static AUTO_COUNTER: AtomicU64 = AtomicU64::new(0);
static MSG_COUNTER: AtomicU64 = AtomicU64::new(1);
const PROXY_AUTH_HEADER: &str = "X-FreeUltraCode-Proxy-Token";
const AUTO_CHANNEL_ID: &str = "auto";
const DEFAULT_RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(60);
const DEFAULT_UPSTREAM_COOLDOWN: Duration = Duration::from_secs(30);
const DEFAULT_AUTH_COOLDOWN: Duration = Duration::from_secs(600);
const DEFAULT_BILLING_COOLDOWN: Duration = Duration::from_secs(300);
const FREE_CHANNEL_MAX_TOKENS: u64 = 8192;
const TOOL_OPEN: &str = "<<FUC_TOOL>>";
const TOOL_CLOSE: &str = "<<FUC_TOOL_END>>";
const FREE_PROXY_TOOL_NAME: &str = "free_proxy";
// Keep the port directly below this range reserved for Lark OAuth callback.
const FREE_PROXY_PORT_START: u16 = 8766;
const FREE_PROXY_PORT_END: u16 = 8799;

#[derive(Debug, Clone)]
struct ChannelCooldown {
    until: Instant,
    reason: String,
}

impl FreeChannelCfg {
    fn display_name(&self) -> String {
        let label = self.label.trim();
        if label.is_empty() {
            self.id.clone()
        } else {
            label.to_string()
        }
    }
}

#[derive(Debug, Clone)]
struct FreeProxyRouteLog {
    id: String,
    channel: String,
    model: String,
    status: &'static str,
    detail: Option<String>,
}

fn free_proxy_route_log(
    id: String,
    channel: String,
    model: String,
    status: &'static str,
    detail: Option<String>,
) -> FreeProxyRouteLog {
    FreeProxyRouteLog {
        id,
        channel,
        model,
        status,
        detail,
    }
}

fn push_free_proxy_route_log(
    logs: &mut Vec<FreeProxyRouteLog>,
    id: Option<String>,
    cfg: &FreeChannelCfg,
    model: &str,
    status: &'static str,
    detail: Option<String>,
) -> String {
    let id = id.unwrap_or_else(|| format!("free-proxy-route-{}", logs.len()));
    logs.push(free_proxy_route_log(
        id.clone(),
        cfg.display_name(),
        model.to_string(),
        status,
        detail,
    ));
    id
}

fn free_proxy_log_subject(log: &FreeProxyRouteLog) -> String {
    let target = if log.model.trim().is_empty() {
        log.channel.clone()
    } else {
        format!("{} · {}", log.channel, log.model)
    };
    match log.status {
        "running" => format!("尝试使用 {target}"),
        "done" => format!("尝试使用 {target}（成功）"),
        "error" => format!("尝试使用 {target}（失败，切换）"),
        _ => target,
    }
}

fn encode_free_proxy_tool_patch(log: &FreeProxyRouteLog) -> String {
    let mut patch = json!({
        "id": log.id,
        "name": FREE_PROXY_TOOL_NAME,
        "status": log.status,
        "subject": free_proxy_log_subject(log),
    });
    if let Some(detail) = log.detail.as_deref() {
        if let Some(obj) = patch.as_object_mut() {
            obj.insert("result".to_string(), Value::String(brief_detail(detail)));
        }
    }
    format!("\n{TOOL_OPEN}{}{TOOL_CLOSE}\n", patch)
}

fn encode_free_proxy_logs(logs: &[FreeProxyRouteLog]) -> Option<String> {
    if logs.is_empty() {
        return None;
    }
    Some(
        logs.iter()
            .map(encode_free_proxy_tool_patch)
            .collect::<Vec<_>>()
            .join(""),
    )
}

fn state_lock() -> &'static Mutex<Option<ProxyState>> {
    SERVER_STATE.get_or_init(|| Mutex::new(None))
}

fn registry() -> &'static Mutex<HashMap<String, FreeChannelCfg>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn registry_order() -> &'static Mutex<Vec<String>> {
    REGISTRY_ORDER.get_or_init(|| Mutex::new(Vec::new()))
}

fn model_success_cache() -> &'static Mutex<HashMap<String, String>> {
    MODEL_SUCCESS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn channel_cooldowns() -> &'static Mutex<HashMap<String, ChannelCooldown>> {
    CHANNEL_COOLDOWNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_message_id() -> String {
    let n = MSG_COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    format!("msg_{:x}{:x}", pid, n)
}

/// Tauri command: start the proxy if needed, swap the channel registry, return the port.
#[tauri::command]
pub async fn free_proxy_ensure(channels: Vec<FreeChannelCfg>) -> Result<FreeProxyInfo, String> {
    // Swap the registry first (cheap, takes effect immediately).
    {
        let mut reg = registry().lock().map_err(|_| "registry poisoned")?;
        let mut order = registry_order()
            .lock()
            .map_err(|_| "registry order poisoned")?;
        reg.clear();
        order.clear();
        for c in channels {
            order.push(c.id.clone());
            reg.insert(c.id.clone(), c);
        }
    }

    // If already running, just return the existing port. Verify the listener is
    // still reachable first; a stale state record would otherwise make the CLI
    // fail later with an opaque ConnectionRefused against the cached port.
    let existing = {
        let guard = state_lock().lock().map_err(|_| "state poisoned")?;
        guard.as_ref().map(|st| (st.port, st.token.clone()))
    };
    if let Some((port, token)) = existing {
        if proxy_port_accepting(port) {
            return Ok(FreeProxyInfo { port, token });
        }
        let mut guard = state_lock().lock().map_err(|_| "state poisoned")?;
        if guard.as_ref().map(|st| st.port) == Some(port) {
            *guard = None;
        }
    }

    // Bind + start the accept loop (blocking bind is cheap; do it on a blocking pool).
    let info = tauri::async_runtime::spawn_blocking(start_server)
        .await
        .map_err(|e| format!("spawn_blocking join error: {e}"))??;

    Ok(info)
}

/// Tauri command: stop the proxy. (Idempotent best-effort.)
#[tauri::command]
pub fn free_proxy_stop() -> Result<(), String> {
    // tiny_http's Server has no clean shutdown handle here; we simply drop our
    // record of it. The accept thread keeps the bound socket but is harmless and
    // will be reused on the next ensure (same port returned). For a hard stop the
    // app process exit releases the socket. Clearing the registry disables routing.
    if let Ok(mut reg) = registry().lock() {
        reg.clear();
    }
    if let Ok(mut order) = registry_order().lock() {
        order.clear();
    }
    Ok(())
}

/// Bind 127.0.0.1 on the first free port in 8766..=8799 and spawn the accept loop.
/// Returns the chosen port. Idempotent guard via SERVER_STATE.
fn start_server() -> Result<FreeProxyInfo, String> {
    let mut guard = state_lock().lock().map_err(|_| "state poisoned")?;
    if let Some(st) = guard.as_ref() {
        if proxy_port_accepting(st.port) {
            return Ok(FreeProxyInfo {
                port: st.port,
                token: st.token.clone(),
            });
        }
        *guard = None;
    }

    let mut bound: Option<(Server, u16)> = None;
    for port in FREE_PROXY_PORT_START..=FREE_PROXY_PORT_END {
        match Server::http(("127.0.0.1", port)) {
            Ok(server) => {
                bound = Some((server, port));
                break;
            }
            Err(_) => continue,
        }
    }

    let (server, port) = bound.ok_or_else(|| {
        format!(
            "free proxy: no free port in {FREE_PROXY_PORT_START}..{FREE_PROXY_PORT_END} to bind on 127.0.0.1"
        )
    })?;
    let token = generate_proxy_token()?;

    std::thread::Builder::new()
        .name("fuc-free-proxy".to_string())
        .spawn(move || {
            for request in server.incoming_requests() {
                // One worker thread per request so a long-lived stream does not
                // block other channels.
                std::thread::spawn(move || {
                    handle_request(request);
                });
            }
        })
        .map_err(|e| format!("free proxy: failed to spawn accept thread: {e}"))?;

    *guard = Some(ProxyState {
        port,
        token: token.clone(),
    });
    Ok(FreeProxyInfo { port, token })
}

fn proxy_port_accepting(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn generate_proxy_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("free proxy: failed to generate auth token: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn header_value(headers: &[Header], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn proxy_auth_headers_match(headers: &[Header], expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    if header_value(headers, PROXY_AUTH_HEADER).as_deref() == Some(expected) {
        return true;
    }
    if header_value(headers, "x-api-key").as_deref() == Some(expected) {
        return true;
    }
    if let Some(auth) = header_value(headers, "authorization") {
        let trimmed = auth.trim();
        if trimmed == expected {
            return true;
        }
        if let Some((scheme, token)) = trimmed.split_once(' ') {
            if scheme.eq_ignore_ascii_case("bearer") {
                return token.trim() == expected;
            }
        }
    }
    false
}

fn request_has_proxy_auth(request: &Request) -> bool {
    let expected = state_lock()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|st| st.token.clone()));
    match expected {
        Some(token) => proxy_auth_headers_match(request.headers(), &token),
        None => false,
    }
}

fn anthropic_error_json(message: &str) -> Value {
    json!({
        "type": "error",
        "error": { "type": "api_error", "message": message }
    })
}

/// Respond with a plain JSON anthropic-style error (used before any streaming).
fn respond_json_error(request: Request, status: u16, message: &str) {
    let body = anthropic_error_json(message).to_string();
    let mut response = Response::from_string(body).with_status_code(status);
    if let Ok(ct) = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        response.add_header(ct);
    }
    let _ = request.respond(response);
}

fn handle_request(mut request: Request) {
    let method = request.method().clone();
    let url = request.url().to_string();

    if method == Method::Options {
        respond_json_error(request, 403, "free proxy: browser preflight is not allowed");
        return;
    }

    if !request_has_proxy_auth(&request) {
        respond_json_error(
            request,
            403,
            "free proxy: missing or invalid local auth token",
        );
        return;
    }

    // Route: /ch/<id>/v1/messages or /ch/<id>/v1/messages/count_tokens
    // (tolerate query strings like ?beta=true).
    let path = url.split('?').next().unwrap_or(&url);
    let (channel_id, endpoint) = match parse_channel_route(path) {
        Some(parsed) => parsed,
        None => {
            respond_json_error(
                request,
                404,
                "free proxy: unknown route (expected /ch/<id>/v1/messages)",
            );
            return;
        }
    };

    let cfg = {
        let reg = match registry().lock() {
            Ok(r) => r,
            Err(_) => {
                respond_json_error(request, 500, "free proxy: registry poisoned");
                return;
            }
        };
        match reg.get(&channel_id) {
            Some(c) => c.clone(),
            None => {
                respond_json_error(
                    request,
                    404,
                    &format!("free proxy: channel '{channel_id}' not registered"),
                );
                return;
            }
        }
    };

    // Detect anthropic-beta passthrough header before consuming the body.
    let anthropic_beta = request
        .headers()
        .iter()
        .find(|h| {
            h.field
                .as_str()
                .as_str()
                .eq_ignore_ascii_case("anthropic-beta")
        })
        .map(|h| h.value.as_str().to_string());

    // Read the full request body (Anthropic Messages JSON).
    let mut body_bytes = Vec::new();
    if request.as_reader().read_to_end(&mut body_bytes).is_err() {
        respond_json_error(request, 400, "free proxy: failed to read request body");
        return;
    }

    let anthropic_body: Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(e) => {
            respond_json_error(request, 400, &format!("free proxy: invalid JSON body: {e}"));
            return;
        }
    };

    // The claude CLI pre-flights token usage via POST /v1/messages/count_tokens.
    // Handle it explicitly so a missing route doesn't 404 (which degrades the
    // CLI's /context and /compact accounting).
    if endpoint == ProxyEndpoint::CountTokens {
        handle_count_tokens(request, &cfg, anthropic_body, anthropic_beta);
        return;
    }

    match cfg.transport.as_str() {
        "anthropic" => handle_anthropic_passthrough(request, &cfg, anthropic_body, anthropic_beta),
        "openai" => handle_openai_translate(request, &cfg, anthropic_body),
        "auto" => handle_auto_route(request, &cfg, anthropic_body, anthropic_beta),
        other => {
            respond_json_error(
                request,
                400,
                &format!("free proxy: unknown transport '{other}'"),
            );
        }
    }
}

/// Which Anthropic endpoint a request targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyEndpoint {
    Messages,
    CountTokens,
}

/// Extract `<id>` and the endpoint kind from `/ch/<id>/v1/messages[/count_tokens]`.
fn parse_channel_route(path: &str) -> Option<(String, ProxyEndpoint)> {
    let rest = path.strip_prefix("/ch/")?;
    let id_end = rest.find('/')?;
    let id = &rest[..id_end];
    let tail = &rest[id_end..];
    if id.is_empty() {
        return None;
    }
    match tail {
        "/v1/messages" | "/v1/messages/" => Some((id.to_string(), ProxyEndpoint::Messages)),
        "/v1/messages/count_tokens" | "/v1/messages/count_tokens/" => {
            Some((id.to_string(), ProxyEndpoint::CountTokens))
        }
        _ => None,
    }
}

/// Respond with a plain JSON body (used for count_tokens and similar
/// non-streamed JSON replies).
fn respond_json(request: Request, status: u16, value: &Value) {
    let body = value.to_string();
    let mut response = Response::from_string(body).with_status_code(status);
    if let Ok(ct) = Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        response.add_header(ct);
    }
    let _ = request.respond(response);
}

/// Rough Anthropic-style token estimate from a Messages body: ~4 chars/token
/// over the joined system + message text. Used for OpenAI-transport channels
/// (which have no count_tokens endpoint) and as a fallback.
fn estimate_input_tokens(anthropic_body: &Value) -> u64 {
    let mut chars = 0usize;
    if let Some(system) = anthropic_body.get("system") {
        chars += join_system_text(system).chars().count();
    }
    if let Some(msgs) = anthropic_body.get("messages").and_then(|m| m.as_array()) {
        for msg in msgs {
            match msg.get("content") {
                Some(Value::String(s)) => chars += s.chars().count(),
                Some(Value::Array(blocks)) => {
                    chars += collect_text_blocks(blocks).chars().count();
                }
                _ => {}
            }
        }
    }
    ((chars / 4) as u64).max(1)
}

/// Answer a count_tokens request. For native Anthropic upstreams, forward it;
/// for OpenAI-translated channels (no such endpoint), synthesize an estimate.
fn handle_count_tokens(
    request: Request,
    cfg: &FreeChannelCfg,
    mut anthropic_body: Value,
    anthropic_beta: Option<String>,
) {
    if cfg.transport == "anthropic" {
        if !cfg.model.is_empty() {
            if let Some(obj) = anthropic_body.as_object_mut() {
                obj.insert("model".to_string(), Value::String(cfg.model.clone()));
            }
        }
        let upstream_url = format!("{}/v1/messages/count_tokens", trim_base(&cfg.base_url));
        let mut req = ureq::post(&upstream_url)
            .set("x-api-key", &cfg.api_key)
            .set("authorization", &format!("Bearer {}", cfg.api_key))
            .set("anthropic-version", "2023-06-01")
            .set("content-type", "application/json");
        if let Some(beta) = anthropic_beta.as_deref() {
            req = req.set("anthropic-beta", beta);
        }
        match req.send_string(&anthropic_body.to_string()) {
            Ok(response) => {
                let body = response
                    .into_string()
                    .unwrap_or_else(|_| json!({ "input_tokens": 0 }).to_string());
                let value: Value = serde_json::from_str(&body).unwrap_or_else(
                    |_| json!({ "input_tokens": estimate_input_tokens(&anthropic_body) }),
                );
                respond_json(request, 200, &value);
            }
            // On any upstream failure, fall back to a local estimate so the CLI
            // keeps working instead of erroring on a 404/5xx.
            Err(_) => {
                respond_json(
                    request,
                    200,
                    &json!({ "input_tokens": estimate_input_tokens(&anthropic_body) }),
                );
            }
        }
        return;
    }

    // OpenAI-compatible upstreams have no count_tokens endpoint: estimate.
    respond_json(
        request,
        200,
        &json!({ "input_tokens": estimate_input_tokens(&anthropic_body) }),
    );
}

fn trim_base(base: &str) -> &str {
    base.trim_end_matches('/')
}

fn push_unique_model(out: &mut Vec<String>, model: String) {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return;
    }
    if out.iter().any(|existing| existing == trimmed) {
        return;
    }
    out.push(trimmed.to_string());
}

fn model_variants_for_channel(channel_id: &str, model: &str) -> Vec<String> {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let lower = trimmed.to_ascii_lowercase();
    match channel_id {
        // OpenRouter requires provider-qualified ids for GLM models.
        "open_router" => {
            if lower.starts_with("glm-") {
                return vec![format!("z-ai/{lower}")];
            }
            if lower.starts_with("z-ai/glm-") {
                return vec![lower];
            }
        }
        // These providers use namespaced ids for the models in our catalog.
        "nvidia_nim" => {
            if !trimmed.contains('/') && lower.contains("nemotron") {
                return vec![format!("nvidia/{lower}")];
            }
        }
        "fireworks" => {
            if !trimmed.contains('/') && lower.starts_with("llama-") {
                return vec![format!("accounts/fireworks/models/{lower}")];
            }
        }
        // GLM-like providers are inconsistent about casing in examples; the
        // public APIs accept lowercase ids, while Wafer is handled by fallback
        // candidates so both GLM-5.1 and glm-5.1 may be tried.
        "opencode" | "opencode_go" | "zai" => {
            if lower.starts_with("glm-") {
                return vec![lower];
            }
        }
        _ => {}
    }

    vec![trimmed.to_string()]
}

#[cfg(test)]
fn model_candidates(primary: &str, fallbacks: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for model in std::iter::once(primary).chain(fallbacks.iter().map(String::as_str)) {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            continue;
        }
        if out
            .iter()
            .any(|existing: &String| existing.eq_ignore_ascii_case(trimmed))
        {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

fn model_cache_key(channel_id: &str, candidates: &[String]) -> String {
    let mut parts = vec![channel_id.trim().to_ascii_lowercase()];
    parts.extend(candidates.iter().map(|m| m.trim().to_string()));
    parts.join("\u{1f}")
}

fn builtin_models_for_channel(channel_id: &str) -> &'static [&'static str] {
    match channel_id {
        "nvidia_nim" => &[
            "nvidia/nemotron-3-super-120b-a12b",
            "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        ],
        "open_router" => &[
            "z-ai/glm-4.6",
            "z-ai/glm-5.1",
            "z-ai/glm-4.7",
            "z-ai/glm-4.5-air:free",
        ],
        "github_models" => &[
            "openai/gpt-4.1-mini",
            "openai/gpt-4.1",
            "xai/grok-code-fast-1",
        ],
        "huggingface_router" => &[
            "deepseek-ai/DeepSeek-V4-Pro",
            "Qwen/Qwen3-Coder-480B-A35B-Instruct",
            "zai-org/GLM-4.6",
        ],
        "sambanova" => &[
            "DeepSeek-V3.1",
            "DeepSeek-V3.2",
            "Meta-Llama-3.3-70B-Instruct",
        ],
        "together" => &[
            "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8",
            "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        ],
        "gemini" => &[
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
            "gemini-2.0-flash",
        ],
        "deepseek" => &["deepseek-chat", "deepseek-reasoner"],
        "mistral" => &["mistral-large-latest", "mistral-small-latest"],
        "mistral_codestral" => &["codestral-latest", "codestral-2405"],
        "opencode" => &["glm-5.1", "glm-4.6"],
        "opencode_go" => &["glm-5.1", "glm-4.6"],
        "wafer" => &["GLM-5.1", "glm-5.1", "glm-4.6"],
        "kimi" => &["kimi-k2.5", "kimi-k2-0905-preview", "moonshot-v1-32k"],
        "cerebras" => &["llama-3.3-70b", "llama3.1-8b"],
        "groq" => &[
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "openai/gpt-oss-120b",
        ],
        "fireworks" => &[
            "accounts/fireworks/models/llama-v3p3-70b-instruct",
            "accounts/fireworks/models/llama-v3p1-8b-instruct",
        ],
        "zai" => &["glm-5.1", "glm-4.6"],
        _ => &[],
    }
}

fn model_candidates_for_channel(
    channel_id: &str,
    primary: &str,
    fallbacks: &[String],
) -> (String, Vec<String>) {
    let mut candidates = Vec::new();
    for model in std::iter::once(primary)
        .chain(fallbacks.iter().map(String::as_str))
        .chain(builtin_models_for_channel(channel_id).iter().copied())
    {
        for variant in model_variants_for_channel(channel_id, model) {
            push_unique_model(&mut candidates, variant);
        }
    }
    let cache_key = model_cache_key(channel_id, &candidates);
    let cached = model_success_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned());
    if let Some(cached_model) = cached {
        if let Some(pos) = candidates.iter().position(|model| model == &cached_model) {
            let model = candidates.remove(pos);
            candidates.insert(0, model);
        }
    }
    (cache_key, candidates)
}

fn remember_model_success(cache_key: &str, model: &str) {
    if let Ok(mut cache) = model_success_cache().lock() {
        cache.insert(cache_key.to_string(), model.to_string());
    }
}

fn looks_like_model_error(status: u16, detail: &str) -> bool {
    if !matches!(status, 400 | 404 | 422 | 403) {
        return false;
    }
    let text = detail.to_ascii_lowercase();
    let mentions_model = text.contains("model")
        || text.contains("模型")
        || text.contains("deployment")
        || text.contains("engine");
    mentions_model
        && (text.contains("not found")
            || text.contains("not defined")
            || text.contains("does not exist")
            || text.contains("unsupported")
            || text.contains("invalid")
            || text.contains("unavailable")
            || text.contains("不存在")
            || text.contains("不支持")
            || text.contains("不可用"))
}

fn model_candidates_failed_message(
    channel_id: &str,
    status: u16,
    detail: &str,
    tried_models: &[String],
) -> String {
    let tried = if tried_models.is_empty() {
        "<none>".to_string()
    } else {
        tried_models.join(", ")
    };
    format!(
        "free proxy: channel {channel_id} model unavailable (tried: {tried}): upstream {status}: {detail}"
    )
}

fn with_json_model(body: &Value, model: &str) -> Value {
    let mut next = body.clone();
    if !model.is_empty() {
        if let Some(obj) = next.as_object_mut() {
            obj.insert("model".to_string(), Value::String(model.to_string()));
        }
    }
    if let Some(requested) = next.get("max_tokens").and_then(|v| v.as_u64()) {
        let capped = requested.min(FREE_CHANNEL_MAX_TOKENS);
        if let Some(obj) = next.as_object_mut() {
            obj.insert("max_tokens".to_string(), json!(capped));
        }
    }
    next
}

#[derive(Debug)]
struct ProxyAttemptError {
    status: u16,
    content_type: String,
    detail: String,
    raw_body: bool,
    retry_after: Option<String>,
}

type UpstreamReader = Box<dyn Read + Send + Sync + 'static>;

struct PrefetchedSseStream {
    status: u16,
    content_type: String,
    prefix: Vec<u8>,
    reader: BufReader<UpstreamReader>,
}

#[derive(Debug)]
struct AutoFailure {
    channel_id: String,
    status: u16,
    detail: String,
}

fn json_attempt_error(status: u16, detail: String) -> ProxyAttemptError {
    ProxyAttemptError {
        status,
        content_type: "application/json".to_string(),
        detail,
        raw_body: false,
        retry_after: None,
    }
}

fn respond_attempt_error(request: Request, err: ProxyAttemptError) {
    if err.raw_body {
        respond_upstream_status(request, err.status, &err.content_type, err.detail);
    } else {
        respond_json_error(request, err.status, &err.detail);
    }
}

fn retry_after_duration(value: Option<&str>) -> Option<Duration> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let seconds = raw.parse::<u64>().ok()?;
    Some(Duration::from_secs(seconds.clamp(1, 3600)))
}

fn looks_like_billing_error(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("payment method")
        || lower.contains("no payment method")
        || lower.contains("payment required")
        || lower.contains("insufficient credit")
        || lower.contains("insufficient credits")
        || lower.contains("credit balance")
        || lower.contains("insufficient balance")
        || lower.contains("out of credit")
        || lower.contains("recharge")
        || lower.contains("resource package")
}

fn cooldown_for_attempt_error(err: &ProxyAttemptError) -> Option<Duration> {
    if err.status == 429 {
        return retry_after_duration(err.retry_after.as_deref())
            .or(Some(DEFAULT_RATE_LIMIT_COOLDOWN));
    }
    if err.status == 402 {
        return Some(DEFAULT_BILLING_COOLDOWN);
    }
    if looks_like_billing_error(&err.detail) {
        return Some(DEFAULT_BILLING_COOLDOWN);
    }
    if matches!(err.status, 401 | 403) {
        return Some(DEFAULT_AUTH_COOLDOWN);
    }
    if matches!(err.status, 408 | 425 | 500 | 502 | 503 | 504) {
        return retry_after_duration(err.retry_after.as_deref())
            .or(Some(DEFAULT_UPSTREAM_COOLDOWN));
    }
    let lower = err.detail.to_ascii_lowercase();
    if lower.contains("rate limit")
        || lower.contains("ratelimit")
        || lower.contains("quota")
        || lower.contains("too many requests")
        || lower.contains("tokens per")
        || lower.contains("requests per")
        || lower.contains("限速")
        || lower.contains("额度")
    {
        return Some(DEFAULT_RATE_LIMIT_COOLDOWN);
    }
    None
}

fn brief_detail(detail: &str) -> String {
    let one_line = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 220;
    if one_line.chars().count() <= MAX {
        return one_line;
    }
    one_line.chars().take(MAX).collect::<String>() + "..."
}

fn remember_channel_cooldown(channel_id: &str, err: &ProxyAttemptError) {
    let Some(duration) = cooldown_for_attempt_error(err) else {
        return;
    };
    if let Ok(mut cooldowns) = channel_cooldowns().lock() {
        cooldowns.insert(
            channel_id.to_string(),
            ChannelCooldown {
                until: Instant::now() + duration,
                reason: format!("HTTP {}: {}", err.status, brief_detail(&err.detail)),
            },
        );
    }
}

fn clear_channel_cooldown(channel_id: &str) {
    if let Ok(mut cooldowns) = channel_cooldowns().lock() {
        cooldowns.remove(channel_id);
    }
}

fn channel_cooldown_remaining(channel_id: &str) -> Option<(u64, String)> {
    let mut cooldowns = channel_cooldowns().lock().ok()?;
    let now = Instant::now();
    let expired = cooldowns
        .get(channel_id)
        .map(|cooldown| cooldown.until <= now)
        .unwrap_or(false);
    if expired {
        cooldowns.remove(channel_id);
        return None;
    }
    cooldowns.get(channel_id).map(|cooldown| {
        (
            cooldown
                .until
                .saturating_duration_since(now)
                .as_secs()
                .max(1),
            cooldown.reason.clone(),
        )
    })
}

fn auto_channel_candidates() -> Vec<FreeChannelCfg> {
    let mut out = Vec::new();
    if let (Ok(reg), Ok(order)) = (registry().lock(), registry_order().lock()) {
        for id in order.iter() {
            if id == AUTO_CHANNEL_ID {
                continue;
            }
            let Some(cfg) = reg.get(id) else {
                continue;
            };
            if cfg.transport == "anthropic" || cfg.transport == "openai" {
                out.push(cfg.clone());
            }
        }
    }

    if out.is_empty() {
        if let Ok(reg) = registry().lock() {
            out.extend(
                reg.values()
                    .filter(|cfg| {
                        cfg.id != AUTO_CHANNEL_ID
                            && (cfg.transport == "anthropic" || cfg.transport == "openai")
                    })
                    .cloned(),
            );
        }
    }

    if out.len() > 1 {
        let start = AUTO_COUNTER.fetch_add(1, Ordering::Relaxed) as usize % out.len();
        out.rotate_left(start);
    }
    out
}

fn auto_failure_message(auto_id: &str, failures: &[AutoFailure]) -> String {
    if failures.is_empty() {
        return format!("free proxy auto channel '{auto_id}' has no configured ready channels");
    }
    let details = failures
        .iter()
        .map(|failure| {
            format!(
                "{} -> HTTP {}: {}",
                failure.channel_id,
                failure.status,
                brief_detail(&failure.detail)
            )
        })
        .collect::<Vec<_>>()
        .join(" | ");
    format!("free proxy auto channel '{auto_id}' could not find an available upstream: {details}")
}

// ---------------------------------------------------------------------------
// Native Anthropic reverse proxy
// ---------------------------------------------------------------------------

fn handle_anthropic_passthrough(
    request: Request,
    cfg: &FreeChannelCfg,
    anthropic_body: Value,
    anthropic_beta: Option<String>,
) {
    let mut logs = Vec::new();
    match try_anthropic_passthrough(cfg, &anthropic_body, anthropic_beta.as_deref(), &mut logs) {
        Ok(response) => stream_passthrough(request, response, encode_free_proxy_logs(&logs)),
        Err(err) => respond_attempt_error(request, err),
    }
}

fn try_anthropic_passthrough(
    cfg: &FreeChannelCfg,
    anthropic_body: &Value,
    anthropic_beta: Option<&str>,
    logs: &mut Vec<FreeProxyRouteLog>,
) -> Result<PrefetchedSseStream, ProxyAttemptError> {
    let upstream_url = format!("{}/v1/messages", trim_base(&cfg.base_url));
    let requested_model = anthropic_body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let primary_model = if cfg.model.is_empty() {
        requested_model
    } else {
        cfg.model.as_str()
    };
    let (cache_key, candidates) =
        model_candidates_for_channel(&cfg.id, primary_model, &cfg.fallback_models);
    let mut last_error: Option<(u16, String, String)> = None;
    let mut tried_models: Vec<String> = Vec::new();

    for model in candidates.iter() {
        let log_id = push_free_proxy_route_log(logs, None, cfg, model, "running", None);
        tried_models.push(model.clone());
        let body = with_json_model(&anthropic_body, model);
        let body_string = body.to_string();
        let mut req = ureq::post(&upstream_url)
            .set("anthropic-version", "2023-06-01")
            .set("content-type", "application/json")
            .set("accept", "text/event-stream");
        // Only attach credentials when we actually have a key. Local channels send
        // an empty key; a literal `Authorization: Bearer ` (no token) makes some
        // auth-enabled local backends 401.
        if !cfg.api_key.is_empty() {
            req = req
                .set("x-api-key", &cfg.api_key)
                .set("authorization", &format!("Bearer {}", cfg.api_key));
        }
        if let Some(beta) = anthropic_beta {
            req = req.set("anthropic-beta", beta);
        }

        match req.send_string(&body_string) {
            Ok(response) => {
                let stream = match prefetch_anthropic_stream(response) {
                    Ok(stream) => stream,
                    Err(err) => {
                        push_free_proxy_route_log(
                            logs,
                            Some(log_id),
                            cfg,
                            model,
                            "error",
                            Some(format!("HTTP {}: {}", err.status, err.detail)),
                        );
                        return Err(err);
                    }
                };
                remember_model_success(&cache_key, model);
                clear_channel_cooldown(&cfg.id);
                push_free_proxy_route_log(logs, Some(log_id), cfg, model, "done", None);
                return Ok(stream);
            }
            Err(ureq::Error::Status(code, response)) => {
                let retry_after = response.header("retry-after").map(|v| v.to_string());
                let raw_ct = response
                    .header("content-type")
                    .unwrap_or("application/json")
                    .to_string();
                let ct = if raw_ct.starts_with("text/event-stream") {
                    "application/json".to_string()
                } else {
                    raw_ct
                };
                let detail = response
                    .into_string()
                    .unwrap_or_else(|_| "<no body>".to_string());
                push_free_proxy_route_log(
                    logs,
                    Some(log_id),
                    cfg,
                    model,
                    "error",
                    Some(format!("HTTP {code}: {detail}")),
                );
                if looks_like_model_error(code, &detail) {
                    last_error = Some((code, ct.clone(), detail.clone()));
                    let is_last_candidate =
                        candidates.last().map(|last| model == last).unwrap_or(true);
                    if !is_last_candidate {
                        continue;
                    }
                    if let Some((last_code, _, last_detail)) = last_error.as_ref() {
                        return Err(json_attempt_error(
                            422,
                            model_candidates_failed_message(
                                &cfg.id,
                                *last_code,
                                last_detail,
                                &tried_models,
                            ),
                        ));
                    }
                }
                return Err(ProxyAttemptError {
                    status: code,
                    content_type: ct,
                    detail,
                    raw_body: true,
                    retry_after,
                });
            }
            Err(e) => {
                push_free_proxy_route_log(
                    logs,
                    Some(log_id),
                    cfg,
                    model,
                    "error",
                    Some(format!("request failed: {e}")),
                );
                return Err(json_attempt_error(
                    502,
                    format!("free proxy: upstream request failed: {e}"),
                ));
            }
        }
    }

    if let Some((code, ct, detail)) = last_error {
        if looks_like_model_error(code, &detail) {
            Err(json_attempt_error(
                422,
                model_candidates_failed_message(&cfg.id, code, &detail, &tried_models),
            ))
        } else {
            Err(ProxyAttemptError {
                status: code,
                content_type: ct,
                detail,
                raw_body: true,
                retry_after: None,
            })
        }
    } else {
        Err(json_attempt_error(
            400,
            "free proxy: no model configured".to_string(),
        ))
    }
}

fn respond_upstream_status(request: Request, code: u16, content_type: &str, body: String) {
    let mut out = Response::from_string(body).with_status_code(code);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()) {
        out.add_header(h);
    }
    let _ = request.respond(out);
}

/// Stream an upstream SSE response back to the client unchanged.
///
/// We write the HTTP response head + body manually onto the raw socket
/// (`Request::into_writer`) so SSE streams flush live, byte-for-byte.
fn stream_passthrough(request: Request, stream: PrefetchedSseStream, log_text: Option<String>) {
    let status = stream.status;
    let content_type = stream.content_type;
    let mut raw_reader = Cursor::new(stream.prefix).chain(stream.reader);
    let mut writer = request.into_writer();

    if write_stream_head(&mut writer, status, &content_type).is_err() {
        return;
    }

    if let Some(log_text) = log_text.filter(|text| !text.trim().is_empty()) {
        let reader = BufReader::new(raw_reader);
        let mut sink = |event: &str, data: &Value| -> bool {
            let s = sse_event(event, data);
            if write_chunk(&mut writer, s.as_bytes()).is_err() {
                return false;
            }
            let _ = writer.flush();
            true
        };
        run_anthropic_passthrough_with_log_text(reader, &log_text, &mut sink);
        let _ = writer.write_all(b"0\r\n\r\n");
        let _ = writer.flush();
        return;
    }

    let mut buf = [0u8; 8192];
    loop {
        match raw_reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if write_chunk(&mut writer, &buf[..n]).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
            Err(_) => break,
        }
    }
    // Terminate the chunked body.
    let _ = writer.write_all(b"0\r\n\r\n");
    let _ = writer.flush();
}

/// Write an HTTP/1.1 response head using chunked transfer-encoding.
fn write_stream_head<W: Write>(
    writer: &mut W,
    status: u16,
    content_type: &str,
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} OK\r\n\
         Content-Type: {content_type}\r\n\
         Transfer-Encoding: chunked\r\n\
         Cache-Control: no-cache\r\n\
         Connection: keep-alive\r\n\
         X-Accel-Buffering: no\r\n\
         \r\n"
    );
    writer.write_all(head.as_bytes())
}

/// Write one chunk in HTTP chunked-transfer framing.
fn write_chunk<W: Write>(writer: &mut W, data: &[u8]) -> std::io::Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    writer.write_all(format!("{:x}\r\n", data.len()).as_bytes())?;
    writer.write_all(data)?;
    writer.write_all(b"\r\n")
}

// ---------------------------------------------------------------------------
// Auto channel router
// ---------------------------------------------------------------------------

fn handle_auto_route(
    request: Request,
    cfg: &FreeChannelCfg,
    anthropic_body: Value,
    anthropic_beta: Option<String>,
) {
    let candidates = auto_channel_candidates();
    if candidates.is_empty() {
        respond_json_error(
            request,
            503,
            &format!("free proxy auto channel '{}' has no ready channels", cfg.id),
        );
        return;
    }

    let model_override = auto_route_model_override(&cfg.model);
    let mut failures: Vec<AutoFailure> = Vec::new();
    let mut logs: Vec<FreeProxyRouteLog> = Vec::new();
    for mut candidate in candidates {
        if let Some(model) = model_override.as_deref() {
            candidate.model = model.to_string();
        }
        if let Some((seconds, reason)) = channel_cooldown_remaining(&candidate.id) {
            push_free_proxy_route_log(
                &mut logs,
                None,
                &candidate,
                &candidate.model,
                "error",
                Some(format!("cooling down for {seconds}s after {reason}")),
            );
            failures.push(AutoFailure {
                channel_id: candidate.id.clone(),
                status: 429,
                detail: format!("cooling down for {seconds}s after {reason}"),
            });
            continue;
        }

        match candidate.transport.as_str() {
            "anthropic" => match try_anthropic_passthrough(
                &candidate,
                &anthropic_body,
                anthropic_beta.as_deref(),
                &mut logs,
            ) {
                Ok(response) => {
                    stream_passthrough(request, response, encode_free_proxy_logs(&logs));
                    return;
                }
                Err(err) => {
                    remember_channel_cooldown(&candidate.id, &err);
                    failures.push(AutoFailure {
                        channel_id: candidate.id.clone(),
                        status: err.status,
                        detail: err.detail,
                    });
                }
            },
            "openai" => match try_openai_translate(&candidate, &anthropic_body, &mut logs) {
                Ok(response) => {
                    translate_openai_response(request, response, encode_free_proxy_logs(&logs));
                    return;
                }
                Err(err) => {
                    remember_channel_cooldown(&candidate.id, &err);
                    failures.push(AutoFailure {
                        channel_id: candidate.id.clone(),
                        status: err.status,
                        detail: err.detail,
                    });
                }
            },
            other => failures.push(AutoFailure {
                channel_id: candidate.id.clone(),
                status: 400,
                detail: format!("unsupported transport '{other}'"),
            }),
        }
    }

    let status = if failures.iter().all(|failure| failure.status == 429) {
        429
    } else {
        503
    };
    respond_json_error(request, status, &auto_failure_message(&cfg.id, &failures));
}

fn auto_route_model_override(model: &str) -> Option<String> {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        return None;
    }
    Some(trimmed.to_string())
}

// ---------------------------------------------------------------------------
// OpenAI translation
// ---------------------------------------------------------------------------

fn handle_openai_translate(request: Request, cfg: &FreeChannelCfg, anthropic_body: Value) {
    let mut logs = Vec::new();
    match try_openai_translate(cfg, &anthropic_body, &mut logs) {
        Ok(response) => translate_openai_response(request, response, encode_free_proxy_logs(&logs)),
        Err(err) => respond_attempt_error(request, err),
    }
}

enum OpenAiUpstreamResponse {
    Stream {
        stream: PrefetchedSseStream,
        echo_model: String,
    },
    Json {
        body: Value,
        echo_model: String,
    },
}

fn try_openai_translate(
    cfg: &FreeChannelCfg,
    anthropic_body: &Value,
    logs: &mut Vec<FreeProxyRouteLog>,
) -> Result<OpenAiUpstreamResponse, ProxyAttemptError> {
    // The model the CLI requested. We echo this back in message_start so the
    // response model matches the request (Anthropic contract).
    let requested_model = anthropic_body
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    // The model actually sent upstream: the channel override, or — when no
    // override is configured — the requested model, so we never POST model:"".
    let upstream_model = if cfg.model.is_empty() {
        requested_model.clone()
    } else {
        cfg.model.clone()
    };
    let requested_echo_model = if requested_model.is_empty() {
        upstream_model.clone()
    } else {
        requested_model.clone()
    };
    let upstream_url = format!("{}/chat/completions", trim_base(&cfg.base_url));
    let (cache_key, candidates) =
        model_candidates_for_channel(&cfg.id, &upstream_model, &cfg.fallback_models);
    let mut last_error: Option<(u16, String)> = None;
    let mut tried_models: Vec<String> = Vec::new();

    for model in candidates.iter() {
        let log_id = push_free_proxy_route_log(logs, None, cfg, model, "running", None);
        tried_models.push(model.clone());
        let openai_body = anthropic_to_openai_body(anthropic_body, model);
        let mut req = ureq::post(&upstream_url)
            .set("content-type", "application/json")
            .set("accept", "text/event-stream");
        if !cfg.api_key.is_empty() {
            req = req.set("authorization", &format!("Bearer {}", cfg.api_key));
        }
        if cfg.id == "open_router" {
            req = req
                .set("HTTP-Referer", "https://freeultracode.local")
                .set("X-Title", "FreeUltraCode");
        }
        let resp = req.send_string(&openai_body.to_string());

        match resp {
            Ok(response) => {
                let echo_model = if model == &upstream_model {
                    requested_echo_model.clone()
                } else {
                    model.clone()
                };
                let content_type = response.header("content-type").unwrap_or("").to_string();
                if is_event_stream_content_type(&content_type) || content_type.trim().is_empty() {
                    let stream = match prefetch_openai_stream(response) {
                        Ok(stream) => stream,
                        Err(err) => {
                            push_free_proxy_route_log(
                                logs,
                                Some(log_id),
                                cfg,
                                model,
                                "error",
                                Some(format!("HTTP {}: {}", err.status, err.detail)),
                            );
                            return Err(err);
                        }
                    };
                    remember_model_success(&cache_key, model);
                    clear_channel_cooldown(&cfg.id);
                    push_free_proxy_route_log(logs, Some(log_id), cfg, model, "done", None);
                    return Ok(OpenAiUpstreamResponse::Stream { stream, echo_model });
                }
                if is_json_content_type(&content_type) {
                    let detail = response
                        .into_string()
                        .unwrap_or_else(|_| "<no body>".to_string());
                    let body: Value = match serde_json::from_str(&detail) {
                        Ok(body) => body,
                        Err(e) => {
                            let err = json_attempt_error(
                                502,
                                format!(
                                    "free proxy: upstream 200 returned invalid JSON ({content_type}): {e}"
                                ),
                            );
                            push_free_proxy_route_log(
                                logs,
                                Some(log_id),
                                cfg,
                                model,
                                "error",
                                Some(format!("HTTP {}: {}", err.status, err.detail)),
                            );
                            return Err(err);
                        }
                    };
                    if let Err(message) = validate_openai_json_body(&body) {
                        let err = json_attempt_error(
                            502,
                            format!(
                                "free proxy: upstream 200 returned unusable JSON ({content_type}): {message}"
                            ),
                        );
                        push_free_proxy_route_log(
                            logs,
                            Some(log_id),
                            cfg,
                            model,
                            "error",
                            Some(format!("HTTP {}: {}", err.status, err.detail)),
                        );
                        return Err(err);
                    }
                    remember_model_success(&cache_key, model);
                    clear_channel_cooldown(&cfg.id);
                    push_free_proxy_route_log(logs, Some(log_id), cfg, model, "done", None);
                    return Ok(OpenAiUpstreamResponse::Json { body, echo_model });
                }
                let detail = response
                    .into_string()
                    .unwrap_or_else(|_| "<no body>".to_string());
                push_free_proxy_route_log(
                    logs,
                    Some(log_id),
                    cfg,
                    model,
                    "error",
                    Some(format!("HTTP 502: {detail}")),
                );
                return Err(json_attempt_error(
                    502,
                    format!(
                        "free proxy: upstream 200 returned non-SSE content-type '{}': {}",
                        content_type,
                        brief_detail(&detail)
                    ),
                ));
            }
            Err(ureq::Error::Status(code, response)) => {
                let retry_after = response.header("retry-after").map(|v| v.to_string());
                let detail = response
                    .into_string()
                    .unwrap_or_else(|_| "<no body>".to_string());
                push_free_proxy_route_log(
                    logs,
                    Some(log_id),
                    cfg,
                    model,
                    "error",
                    Some(format!("HTTP {code}: {detail}")),
                );
                if looks_like_model_error(code, &detail) {
                    last_error = Some((code, detail.clone()));
                    let is_last_candidate =
                        candidates.last().map(|last| model == last).unwrap_or(true);
                    if !is_last_candidate {
                        continue;
                    }
                    if let Some((last_code, last_detail)) = last_error.as_ref() {
                        return Err(json_attempt_error(
                            422,
                            model_candidates_failed_message(
                                &cfg.id,
                                *last_code,
                                last_detail,
                                &tried_models,
                            ),
                        ));
                    }
                }
                return Err(ProxyAttemptError {
                    status: code,
                    content_type: "application/json".to_string(),
                    detail: format!("free proxy: upstream {code}: {detail}"),
                    raw_body: false,
                    retry_after,
                });
            }
            Err(e) => {
                push_free_proxy_route_log(
                    logs,
                    Some(log_id),
                    cfg,
                    model,
                    "error",
                    Some(format!("request failed: {e}")),
                );
                return Err(json_attempt_error(
                    502,
                    format!("free proxy: upstream request failed: {e}"),
                ));
            }
        }
    }

    if let Some((code, detail)) = last_error {
        if looks_like_model_error(code, &detail) {
            Err(json_attempt_error(
                422,
                model_candidates_failed_message(&cfg.id, code, &detail, &tried_models),
            ))
        } else {
            Err(json_attempt_error(
                code,
                format!("free proxy: upstream {code}: {detail}"),
            ))
        }
    } else {
        Err(json_attempt_error(
            400,
            "free proxy: no model configured".to_string(),
        ))
    }
}

fn is_event_stream_content_type(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("text/event-stream")
}

fn is_json_content_type(content_type: &str) -> bool {
    let media_type = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    media_type == "application/json" || media_type.ends_with("+json")
}

fn prefetch_openai_stream(
    response: ureq::Response,
) -> Result<PrefetchedSseStream, ProxyAttemptError> {
    let status = response.status();
    let raw_content_type = response.header("content-type").unwrap_or("").to_string();
    let content_type = if raw_content_type.trim().is_empty() {
        "text/event-stream".to_string()
    } else {
        raw_content_type
    };
    let mut reader = BufReader::new(response.into_reader());
    let mut prefix = Vec::new();
    preflight_openai_stream_reader(&mut reader, &mut prefix)?;
    Ok(PrefetchedSseStream {
        status,
        content_type,
        prefix,
        reader,
    })
}

fn prefetch_anthropic_stream(
    response: ureq::Response,
) -> Result<PrefetchedSseStream, ProxyAttemptError> {
    let status = response.status();
    let raw_content_type = response.header("content-type").unwrap_or("").to_string();
    if !raw_content_type.trim().is_empty() && !is_event_stream_content_type(&raw_content_type) {
        let detail = response
            .into_string()
            .unwrap_or_else(|_| "<no body>".to_string());
        return Err(json_attempt_error(
            502,
            format!(
                "free proxy: upstream 200 returned non-SSE content-type '{}': {}",
                raw_content_type,
                brief_detail(&detail)
            ),
        ));
    }
    let content_type = if raw_content_type.trim().is_empty() {
        "text/event-stream".to_string()
    } else {
        raw_content_type
    };
    let mut reader = BufReader::new(response.into_reader());
    let mut prefix = Vec::new();
    preflight_anthropic_stream_reader(&mut reader, &mut prefix)?;
    Ok(PrefetchedSseStream {
        status,
        content_type,
        prefix,
        reader,
    })
}

fn preflight_openai_stream_reader<R: Read>(
    reader: &mut BufReader<R>,
    prefix: &mut Vec<u8>,
) -> Result<(), ProxyAttemptError> {
    let mut saw_data = false;
    let mut saw_choices = false;

    loop {
        let mut line_bytes = Vec::new();
        let n = reader.read_until(b'\n', &mut line_bytes).map_err(|e| {
            json_attempt_error(502, format!("free proxy: upstream SSE read failed: {e}"))
        })?;
        if n == 0 {
            break;
        }
        prefix.extend_from_slice(&line_bytes);
        let line = String::from_utf8_lossy(&line_bytes);
        let line = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if line.is_empty() {
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        saw_data = true;
        if data == "[DONE]" {
            return Err(json_attempt_error(
                502,
                "free proxy: upstream 200 SSE ended before first assistant content/tool"
                    .to_string(),
            ));
        }
        let chunk: Value = serde_json::from_str(data).map_err(|e| {
            json_attempt_error(
                502,
                format!("free proxy: upstream 200 SSE returned invalid JSON chunk: {e}"),
            )
        })?;
        if let Some(error) = chunk.get("error") {
            return Err(json_attempt_error(
                502,
                format!(
                    "free proxy: upstream 200 SSE returned error: {}",
                    brief_detail(&error.to_string())
                ),
            ));
        }
        if openai_stream_chunk_has_choices(&chunk) {
            saw_choices = true;
        }
        if openai_stream_chunk_has_assistant_output(&chunk) {
            return Ok(());
        }
    }

    let detail = if !saw_data {
        "empty stream (no data events)"
    } else if !saw_choices {
        "missing choices[]"
    } else {
        "no assistant content/tool"
    };
    Err(json_attempt_error(
        502,
        format!("free proxy: upstream 200 SSE returned unusable stream: {detail}"),
    ))
}

fn preflight_anthropic_stream_reader<R: Read>(
    reader: &mut BufReader<R>,
    prefix: &mut Vec<u8>,
) -> Result<(), ProxyAttemptError> {
    let mut saw_data = false;

    loop {
        let mut line_bytes = Vec::new();
        let n = reader.read_until(b'\n', &mut line_bytes).map_err(|e| {
            json_attempt_error(502, format!("free proxy: upstream SSE read failed: {e}"))
        })?;
        if n == 0 {
            break;
        }
        prefix.extend_from_slice(&line_bytes);
        let line = String::from_utf8_lossy(&line_bytes);
        let line = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if line.is_empty() {
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        saw_data = true;
        let event: Value = serde_json::from_str(data).map_err(|e| {
            json_attempt_error(
                502,
                format!("free proxy: upstream 200 SSE returned invalid JSON chunk: {e}"),
            )
        })?;
        if event.get("type").and_then(|v| v.as_str()) == Some("error") {
            return Err(json_attempt_error(
                502,
                format!(
                    "free proxy: upstream 200 SSE returned error: {}",
                    brief_detail(&event.to_string())
                ),
            ));
        }
        if anthropic_stream_event_has_assistant_output(&event) {
            return Ok(());
        }
        if event.get("type").and_then(|v| v.as_str()) == Some("message_stop") {
            return Err(json_attempt_error(
                502,
                "free proxy: upstream 200 SSE ended before first assistant content/tool"
                    .to_string(),
            ));
        }
    }

    let detail = if saw_data {
        "no assistant content/tool"
    } else {
        "empty stream (no data events)"
    };
    Err(json_attempt_error(
        502,
        format!("free proxy: upstream 200 SSE returned unusable stream: {detail}"),
    ))
}

fn openai_stream_chunk_has_choices(chunk: &Value) -> bool {
    chunk
        .get("choices")
        .and_then(|c| c.as_array())
        .map(|choices| !choices.is_empty())
        .unwrap_or(false)
}

fn openai_stream_chunk_has_assistant_output(chunk: &Value) -> bool {
    let Some(choice) = chunk
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|choices| choices.first())
    else {
        return false;
    };
    let Some(delta) = choice.get("delta") else {
        return false;
    };
    if delta
        .get("content")
        .and_then(|content| content.as_str())
        .map(|text| !text.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    delta
        .get("tool_calls")
        .and_then(|calls| calls.as_array())
        .map(|calls| calls.iter().any(openai_tool_call_has_name))
        .unwrap_or(false)
}

fn openai_tool_call_has_name(tool_call: &Value) -> bool {
    tool_call
        .get("function")
        .and_then(|func| func.get("name"))
        .and_then(|name| name.as_str())
        .map(|name| !name.is_empty())
        .unwrap_or(false)
}

fn openai_message_has_assistant_output(message: &Value) -> bool {
    if message
        .get("content")
        .and_then(openai_message_content_text)
        .map(|text| !text.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    message
        .get("tool_calls")
        .and_then(|calls| calls.as_array())
        .map(|calls| calls.iter().any(openai_tool_call_has_name))
        .unwrap_or(false)
}

fn anthropic_stream_event_has_assistant_output(event: &Value) -> bool {
    match event.get("type").and_then(|value| value.as_str()) {
        Some("content_block_start") => event
            .get("content_block")
            .and_then(|block| block.get("type"))
            .and_then(|kind| kind.as_str())
            .map(|kind| kind == "tool_use" || kind == "server_tool_use")
            .unwrap_or(false),
        Some("content_block_delta") => {
            let Some(delta) = event.get("delta") else {
                return false;
            };
            let kind = delta.get("type").and_then(|value| value.as_str());
            match kind {
                Some("text_delta") => delta
                    .get("text")
                    .and_then(|text| text.as_str())
                    .map(|text| !text.is_empty())
                    .unwrap_or(false),
                Some("input_json_delta") => delta
                    .get("partial_json")
                    .and_then(|text| text.as_str())
                    .map(|text| !text.is_empty())
                    .unwrap_or(false),
                Some("thinking_delta") => delta
                    .get("thinking")
                    .and_then(|text| text.as_str())
                    .map(|text| !text.is_empty())
                    .unwrap_or(false),
                _ => false,
            }
        }
        _ => false,
    }
}

fn validate_openai_json_body(body: &Value) -> Result<(), String> {
    if let Some(error) = body.get("error") {
        return Err(brief_detail(&error.to_string()));
    }
    let choice = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|choices| choices.first());
    if choice.is_none() {
        return Err("missing choices[]".to_string());
    }
    let message = choice.and_then(|choice| choice.get("message"));
    let Some(message) = message else {
        return Err("missing choices[0].message".to_string());
    };
    if !openai_message_has_assistant_output(message) {
        return Err("missing assistant content/tool".to_string());
    }
    Ok(())
}

/// Convert an Anthropic Messages body to an OpenAI chat/completions body.
fn anthropic_to_openai_body(anthropic: &Value, model: &str) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    // system (string or array of {type:text,text}).
    if let Some(system) = anthropic.get("system") {
        let sys_text = join_system_text(system);
        if !sys_text.is_empty() {
            messages.push(json!({ "role": "system", "content": sys_text }));
        }
    }

    if let Some(msgs) = anthropic.get("messages").and_then(|m| m.as_array()) {
        for msg in msgs {
            convert_message(msg, &mut messages);
        }
    }

    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    let Some(obj) = body.as_object_mut() else {
        return body;
    };

    let max_tokens = anthropic
        .get("max_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(4096);
    obj.insert(
        "max_tokens".to_string(),
        json!(max_tokens.min(FREE_CHANNEL_MAX_TOKENS)),
    );

    if let Some(t) = anthropic.get("temperature") {
        if !t.is_null() {
            obj.insert("temperature".to_string(), t.clone());
        }
    }
    if let Some(p) = anthropic.get("top_p") {
        if !p.is_null() {
            obj.insert("top_p".to_string(), p.clone());
        }
    }
    if let Some(stop) = anthropic
        .get("stop_sequences")
        .and_then(|stop| stop.as_array())
        .filter(|stop| !stop.is_empty())
    {
        obj.insert("stop".to_string(), Value::Array(stop.clone()));
    }

    // tools.
    if let Some(tools) = anthropic.get("tools").and_then(|t| t.as_array()) {
        if !tools.is_empty() {
            let converted: Vec<Value> = tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.get("name").cloned().unwrap_or(Value::String(String::new())),
                            "description": tool.get("description").cloned().unwrap_or(Value::String(String::new())),
                            "parameters": tool.get("input_schema").cloned().unwrap_or(json!({"type":"object","properties":{}})),
                        }
                    })
                })
                .collect();
            obj.insert("tools".to_string(), json!(converted));
        }
    }

    // tool_choice.
    if let Some(tc) = anthropic.get("tool_choice") {
        if let Some(converted) = convert_tool_choice(tc) {
            obj.insert("tool_choice".to_string(), converted);
        }
    }

    body
}

fn join_system_text(system: &Value) -> String {
    match system {
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

fn convert_tool_choice(tc: &Value) -> Option<Value> {
    let obj = tc.as_object()?;
    match obj.get("type").and_then(|t| t.as_str()) {
        Some("auto") => Some(json!("auto")),
        Some("none") => Some(json!("none")),
        Some("any") => Some(json!("required")),
        Some("required") => Some(json!("required")),
        Some("tool") => {
            let name = obj.get("name").and_then(|n| n.as_str())?;
            Some(json!({ "type": "function", "function": { "name": name } }))
        }
        Some("function") if obj.contains_key("function") => Some(tc.clone()),
        _ => Some(tc.clone()),
    }
}

/// Extract the joined text from an array of content blocks.
fn collect_text_blocks(blocks: &[Value]) -> String {
    blocks
        .iter()
        .filter_map(|b| {
            if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                b.get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Serialize a tool_result block's `content` field to a plain string.
fn serialize_tool_result_content(content: &Value) -> String {
    match content {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .map(|item| {
                if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                    item.get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string()
                } else {
                    item.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn convert_message(msg: &Value, out: &mut Vec<Value>) {
    let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("user");
    let content = match msg.get("content") {
        Some(c) => c,
        None => return,
    };

    // String content -> straightforward.
    if let Some(s) = content.as_str() {
        out.push(json!({ "role": role, "content": s }));
        return;
    }

    let blocks = match content.as_array() {
        Some(b) => b,
        None => {
            out.push(json!({ "role": role, "content": content.to_string() }));
            return;
        }
    };

    if role == "assistant" {
        convert_assistant_blocks(blocks, out);
    } else {
        convert_user_blocks(blocks, out);
    }
}

fn convert_assistant_blocks(blocks: &[Value], out: &mut Vec<Value>) {
    let text = collect_text_blocks(blocks);
    let mut tool_calls: Vec<Value> = Vec::new();
    for b in blocks {
        if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
            let id = b.get("id").and_then(|i| i.as_str()).unwrap_or("");
            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let input = b.get("input").cloned().unwrap_or(json!({}));
            tool_calls.push(json!({
                "id": id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": input.to_string(),
                }
            }));
        }
    }

    if !tool_calls.is_empty() {
        // OpenAI: assistant with tool_calls; content may be null.
        let content_val: Value = if text.is_empty() {
            Value::Null
        } else {
            Value::String(text)
        };
        out.push(json!({
            "role": "assistant",
            "content": content_val,
            "tool_calls": tool_calls,
        }));
    } else {
        out.push(json!({ "role": "assistant", "content": text }));
    }
}

fn convert_user_blocks(blocks: &[Value], out: &mut Vec<Value>) {
    // Collect plain text + best-effort image parts, then emit one user message
    // (if any non-tool content) followed by tool result messages.
    let mut text_parts: Vec<String> = Vec::new();
    let mut image_parts: Vec<Value> = Vec::new();
    let mut tool_msgs: Vec<Value> = Vec::new();

    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(t.to_string());
                }
            }
            Some("image") => {
                if let Some(source) = b.get("source") {
                    let media_type = source
                        .get("media_type")
                        .and_then(|m| m.as_str())
                        .unwrap_or("image/png");
                    let data = source.get("data").and_then(|d| d.as_str()).unwrap_or("");
                    let url = format!("data:{media_type};base64,{data}");
                    image_parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": url }
                    }));
                }
            }
            Some("tool_result") => {
                let tool_use_id = b.get("tool_use_id").and_then(|i| i.as_str()).unwrap_or("");
                let serialized = b
                    .get("content")
                    .map(serialize_tool_result_content)
                    .unwrap_or_default();
                tool_msgs.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": serialized,
                }));
            }
            _ => {}
        }
    }

    // Emit user text/image message first if present.
    let joined_text = text_parts.join("\n");
    if !image_parts.is_empty() {
        let mut parts: Vec<Value> = Vec::new();
        if !joined_text.is_empty() {
            parts.push(json!({ "type": "text", "text": joined_text }));
        }
        parts.extend(image_parts);
        out.push(json!({ "role": "user", "content": parts }));
    } else if !joined_text.is_empty() {
        out.push(json!({ "role": "user", "content": joined_text }));
    }

    out.extend(tool_msgs);
}

// ---------------------------------------------------------------------------
// OpenAI SSE -> Anthropic SSE translation
// ---------------------------------------------------------------------------

fn sse_event(event_type: &str, data: &Value) -> String {
    format!("event: {}\ndata: {}\n\n", event_type, data)
}

fn emit_anthropic_text_block(
    index: usize,
    text: &str,
    sink: &mut dyn FnMut(&str, &Value) -> bool,
) -> bool {
    sink(
        "content_block_start",
        &json!({
            "type": "content_block_start",
            "index": index,
            "content_block": { "type": "text", "text": "" }
        }),
    ) && sink(
        "content_block_delta",
        &json!({
            "type": "content_block_delta",
            "index": index,
            "delta": { "type": "text_delta", "text": text }
        }),
    ) && sink(
        "content_block_stop",
        &json!({ "type": "content_block_stop", "index": index }),
    )
}

fn shift_anthropic_content_index(mut data: Value) -> Value {
    if let Some(obj) = data.as_object_mut() {
        if let Some(index) = obj.get("index").and_then(|value| value.as_u64()) {
            obj.insert("index".to_string(), json!(index + 1));
        }
    }
    data
}

fn flush_anthropic_sse_block(
    event_type: &str,
    data_lines: &[String],
    inserted_log: &mut bool,
    log_text: &str,
    sink: &mut dyn FnMut(&str, &Value) -> bool,
) -> bool {
    if data_lines.is_empty() {
        return true;
    }
    let data_text = data_lines.join("\n");
    let data: Value = match serde_json::from_str(&data_text) {
        Ok(value) => value,
        Err(_) => return true,
    };
    let output_event = if event_type == "message" {
        data.get("type")
            .and_then(|value| value.as_str())
            .unwrap_or(event_type)
    } else {
        event_type
    }
    .to_string();
    if output_event == "message_start" && !*inserted_log {
        if !sink(&output_event, &data) {
            return false;
        }
        *inserted_log = true;
        return emit_anthropic_text_block(0, log_text, sink);
    }

    let shifted = if *inserted_log && output_event.starts_with("content_block_") {
        shift_anthropic_content_index(data)
    } else {
        data
    };
    sink(&output_event, &shifted)
}

fn run_anthropic_passthrough_with_log_text<R: BufRead>(
    reader: R,
    log_text: &str,
    sink: &mut dyn FnMut(&str, &Value) -> bool,
) {
    let mut event_type = String::from("message");
    let mut data_lines: Vec<String> = Vec::new();
    let mut inserted_log = false;

    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !flush_anthropic_sse_block(
                &event_type,
                &data_lines,
                &mut inserted_log,
                log_text,
                sink,
            ) {
                return;
            }
            event_type.clear();
            event_type.push_str("message");
            data_lines.clear();
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event_type = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim().to_string());
        }
    }

    let _ = flush_anthropic_sse_block(&event_type, &data_lines, &mut inserted_log, log_text, sink);
}

fn map_finish_reason(reason: Option<&str>) -> &'static str {
    match reason {
        Some("stop") => "end_turn",
        Some("length") => "max_tokens",
        Some("tool_calls") => "tool_use",
        Some("content_filter") => "end_turn",
        _ => "end_turn",
    }
}

/// Per-tool-call streaming block state. OpenAI-compatible providers vary in how
/// they split a streamed tool_call across deltas (id/name/arguments may each
/// arrive separately, in any order), so we accumulate fragments and defer the
/// Anthropic `content_block_start` until the tool name is known.
struct ToolAccum {
    /// Anthropic content-block index, assigned once the block is started.
    anthropic_index: Option<usize>,
    started: bool,
    name: String,
    id: Option<String>,
    /// Argument fragments seen before the block could be started.
    pending_args: String,
}

fn translate_openai_response(
    request: Request,
    response: OpenAiUpstreamResponse,
    log_text: Option<String>,
) {
    match response {
        OpenAiUpstreamResponse::Stream { stream, echo_model } => {
            translate_openai_stream(request, stream, &echo_model, log_text.as_deref())
        }
        OpenAiUpstreamResponse::Json { body, echo_model } => {
            translate_openai_json(request, &body, &echo_model, log_text.as_deref())
        }
    }
}

fn translate_openai_stream(
    request: Request,
    stream: PrefetchedSseStream,
    echo_model: &str,
    log_text: Option<&str>,
) {
    let mut writer = request.into_writer();
    if write_stream_head(&mut writer, 200, "text/event-stream").is_err() {
        return;
    }
    let message_id = next_message_id();
    let reader = BufReader::new(Cursor::new(stream.prefix).chain(stream.reader));

    // Sink: write each Anthropic SSE event as one chunked-transfer chunk.
    let mut sink = |event: &str, data: &Value| -> bool {
        let s = sse_event(event, data);
        if write_chunk(&mut writer, s.as_bytes()).is_err() {
            return false;
        }
        let _ = writer.flush();
        true
    };
    run_openai_translation(reader, echo_model, &message_id, log_text, &mut sink);

    // Terminate the chunked body.
    let _ = writer.write_all(b"0\r\n\r\n");
    let _ = writer.flush();
}

fn translate_openai_json(request: Request, body: &Value, echo_model: &str, log_text: Option<&str>) {
    let mut writer = request.into_writer();
    if write_stream_head(&mut writer, 200, "text/event-stream").is_err() {
        return;
    }
    let message_id = next_message_id();
    let mut sink = |event: &str, data: &Value| -> bool {
        let s = sse_event(event, data);
        if write_chunk(&mut writer, s.as_bytes()).is_err() {
            return false;
        }
        let _ = writer.flush();
        true
    };
    run_openai_json_translation(body, echo_model, &message_id, log_text, &mut sink);

    let _ = writer.write_all(b"0\r\n\r\n");
    let _ = writer.flush();
}

/// Drive the OpenAI-SSE -> Anthropic-SSE translation, emitting each Anthropic
/// event via `sink` (return false to abort). Kept independent of the socket
/// writer so it can be unit-tested by collecting events into a Vec.
fn run_openai_translation<R: BufRead>(
    reader: R,
    echo_model: &str,
    message_id: &str,
    log_text: Option<&str>,
    sink: &mut dyn FnMut(&str, &Value) -> bool,
) {
    macro_rules! emit {
        ($event:expr, $data:expr) => {{
            if !sink($event, &$data) {
                return;
            }
        }};
    }

    // Emit message_start.
    emit!(
        "message_start",
        json!({
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": echo_model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0
                }
            }
        })
    );

    // Block state.
    let mut next_index: usize = 0;
    if let Some(log_text) = log_text.filter(|text| !text.trim().is_empty()) {
        if !emit_anthropic_text_block(next_index, log_text, sink) {
            return;
        }
        next_index += 1;
    }
    let mut text_open = false;
    let mut text_index: usize = 0;
    let mut tool_blocks: HashMap<i64, ToolAccum> = HashMap::new();
    let mut finish_reason: Option<String> = None;
    let mut output_tokens: u64 = 0;
    let mut text_char_count: usize = 0;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let data = match line.strip_prefix("data:") {
            Some(d) => d.trim(),
            None => continue,
        };
        if data == "[DONE]" {
            break;
        }
        let chunk: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // usage (some providers send completion_tokens in a trailing chunk).
        if let Some(usage) = chunk.get("usage") {
            if let Some(ct) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                output_tokens = ct;
            }
        }

        let choice = match chunk
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
        {
            Some(c) => c,
            None => continue,
        };

        if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            finish_reason = Some(fr.to_string());
        }

        let delta = match choice.get("delta") {
            Some(d) => d,
            None => continue,
        };

        // Text content.
        if let Some(text) = delta.get("content").and_then(|c| c.as_str()) {
            if !text.is_empty() {
                if !text_open {
                    text_index = next_index;
                    next_index += 1;
                    text_open = true;
                    emit!(
                        "content_block_start",
                        json!({
                            "type": "content_block_start",
                            "index": text_index,
                            "content_block": { "type": "text", "text": "" }
                        })
                    );
                }
                text_char_count += text.chars().count();
                emit!(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": text_index,
                        "delta": { "type": "text_delta", "text": text }
                    })
                );
            }
        }

        // Tool calls. Accumulate id/name/arguments fragments per tool_call index
        // and defer content_block_start until the tool name is known, so a
        // provider that streams arguments before the name never produces an
        // un-dispatchable tool_use block with an empty name.
        if let Some(tool_calls) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tool_calls {
                let tc_index = tc.get("index").and_then(|i| i.as_i64()).unwrap_or(0);
                let func = tc.get("function");
                let name = func.and_then(|f| f.get("name")).and_then(|n| n.as_str());
                let args = func
                    .and_then(|f| f.get("arguments"))
                    .and_then(|a| a.as_str())
                    .unwrap_or("");
                let id = tc.get("id").and_then(|i| i.as_str());

                let accum = tool_blocks.entry(tc_index).or_insert_with(|| ToolAccum {
                    anthropic_index: None,
                    started: false,
                    name: String::new(),
                    id: None,
                    pending_args: String::new(),
                });
                if let Some(n) = name {
                    if !n.is_empty() {
                        accum.name = n.to_string();
                    }
                }
                if let Some(i) = id {
                    if !i.is_empty() && accum.id.is_none() {
                        accum.id = Some(i.to_string());
                    }
                }

                // Once we know the tool name we can open the Anthropic block and
                // flush any argument fragments buffered before now.
                if !accum.started && !accum.name.is_empty() {
                    if text_open {
                        emit!(
                            "content_block_stop",
                            json!({ "type": "content_block_stop", "index": text_index })
                        );
                        text_open = false;
                    }
                    let block_index = next_index;
                    next_index += 1;
                    accum.anthropic_index = Some(block_index);
                    accum.started = true;
                    let tool_id = accum
                        .id
                        .clone()
                        .unwrap_or_else(|| format!("tool_{}", tc_index));
                    let tool_name = accum.name.clone();
                    let buffered = std::mem::take(&mut accum.pending_args);
                    emit!(
                        "content_block_start",
                        json!({
                            "type": "content_block_start",
                            "index": block_index,
                            "content_block": {
                                "type": "tool_use",
                                "id": tool_id,
                                "name": tool_name,
                                "input": {}
                            }
                        })
                    );
                    if !buffered.is_empty() {
                        emit!(
                            "content_block_delta",
                            json!({
                                "type": "content_block_delta",
                                "index": block_index,
                                "delta": { "type": "input_json_delta", "partial_json": buffered }
                            })
                        );
                    }
                }

                if !args.is_empty() {
                    if accum.started {
                        let block_index = accum.anthropic_index.unwrap_or(0);
                        emit!(
                            "content_block_delta",
                            json!({
                                "type": "content_block_delta",
                                "index": block_index,
                                "delta": { "type": "input_json_delta", "partial_json": args }
                            })
                        );
                    } else {
                        // Name not seen yet — buffer until the block can start.
                        accum.pending_args.push_str(args);
                    }
                }
            }
        }
    }

    // Close any open blocks.
    if text_open {
        emit!(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": text_index })
        );
    }
    for accum in tool_blocks.values() {
        if let Some(idx) = accum.anthropic_index {
            emit!(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": idx })
            );
        }
    }

    // Best-effort output token estimate when upstream did not report usage.
    if output_tokens == 0 {
        output_tokens = (text_char_count / 4) as u64 + (tool_blocks.len() as u64 * 8);
    }

    let stop_reason = map_finish_reason(finish_reason.as_deref());
    emit!(
        "message_delta",
        json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason, "stop_sequence": null },
            "usage": {
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0
            }
        })
    );
    emit!("message_stop", json!({ "type": "message_stop" }));
}

fn run_openai_json_translation(
    body: &Value,
    echo_model: &str,
    message_id: &str,
    log_text: Option<&str>,
    sink: &mut dyn FnMut(&str, &Value) -> bool,
) {
    macro_rules! emit {
        ($event:expr, $data:expr) => {{
            if !sink($event, &$data) {
                return;
            }
        }};
    }

    emit!(
        "message_start",
        json!({
            "type": "message_start",
            "message": {
                "id": message_id,
                "type": "message",
                "role": "assistant",
                "model": echo_model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0
                }
            }
        })
    );

    let choice = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first());
    let finish_reason = choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|f| f.as_str());
    let message = choice.and_then(|c| c.get("message"));
    let mut next_index: usize = 0;
    if let Some(log_text) = log_text.filter(|text| !text.trim().is_empty()) {
        if !emit_anthropic_text_block(next_index, log_text, sink) {
            return;
        }
        next_index += 1;
    }
    let mut text_char_count: usize = 0;
    let mut tool_count: usize = 0;

    if let Some(text) = message
        .and_then(|m| m.get("content"))
        .and_then(openai_message_content_text)
        .filter(|text| !text.is_empty())
    {
        let index = next_index;
        next_index += 1;
        text_char_count += text.chars().count();
        emit!(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": index,
                "content_block": { "type": "text", "text": "" }
            })
        );
        emit!(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": index,
                "delta": { "type": "text_delta", "text": text }
            })
        );
        emit!(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": index })
        );
    }

    if let Some(tool_calls) = message
        .and_then(|m| m.get("tool_calls"))
        .and_then(|t| t.as_array())
    {
        for (idx, tc) in tool_calls.iter().enumerate() {
            let func = tc.get("function");
            let name = func
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                .unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let index = next_index;
            next_index += 1;
            tool_count += 1;
            let id = tc
                .get("id")
                .and_then(|i| i.as_str())
                .filter(|i| !i.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("tool_{idx}"));
            let args = func
                .and_then(|f| f.get("arguments"))
                .and_then(|a| a.as_str())
                .unwrap_or("");
            emit!(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": {
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": {}
                    }
                })
            );
            if !args.is_empty() {
                emit!(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": index,
                        "delta": { "type": "input_json_delta", "partial_json": args }
                    })
                );
            }
            emit!(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": index })
            );
        }
    }

    let output_tokens = body
        .pointer("/usage/completion_tokens")
        .and_then(|v| v.as_u64())
        .filter(|v| *v > 0)
        .unwrap_or_else(|| (text_char_count / 4) as u64 + (tool_count as u64 * 8));
    let stop_reason = if tool_count > 0 && finish_reason.is_none() {
        "tool_use"
    } else {
        map_finish_reason(finish_reason)
    };
    emit!(
        "message_delta",
        json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason, "stop_sequence": null },
            "usage": {
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": 0
            }
        })
    );
    emit!("message_stop", json!({ "type": "message_stop" }));
}

fn openai_message_content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let arr = content.as_array()?;
    let text = arr
        .iter()
        .filter_map(|part| {
            if part.get("type").and_then(|t| t.as_str()) == Some("text") {
                part.get("text").and_then(|t| t.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(text)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Run the translator over a literal OpenAI SSE string and collect the
    /// emitted Anthropic events.
    fn collect(sse: &str, echo_model: &str) -> Vec<(String, Value)> {
        collect_with_log(sse, echo_model, None)
    }

    fn collect_with_log(
        sse: &str,
        echo_model: &str,
        log_text: Option<&str>,
    ) -> Vec<(String, Value)> {
        let mut events: Vec<(String, Value)> = Vec::new();
        let mut sink = |event: &str, data: &Value| -> bool {
            events.push((event.to_string(), data.clone()));
            true
        };
        run_openai_translation(sse.as_bytes(), echo_model, "msg_test", log_text, &mut sink);
        events
    }

    fn collect_json(body: &Value, echo_model: &str) -> Vec<(String, Value)> {
        collect_json_with_log(body, echo_model, None)
    }

    fn collect_json_with_log(
        body: &Value,
        echo_model: &str,
        log_text: Option<&str>,
    ) -> Vec<(String, Value)> {
        let mut events: Vec<(String, Value)> = Vec::new();
        let mut sink = |event: &str, data: &Value| -> bool {
            events.push((event.to_string(), data.clone()));
            true
        };
        run_openai_json_translation(body, echo_model, "msg_test", log_text, &mut sink);
        events
    }

    fn preflight_openai(sse: &str) -> Result<Vec<u8>, ProxyAttemptError> {
        let mut reader = BufReader::new(sse.as_bytes());
        let mut prefix = Vec::new();
        preflight_openai_stream_reader(&mut reader, &mut prefix).map(|_| prefix)
    }

    fn preflight_anthropic(sse: &str) -> Result<Vec<u8>, ProxyAttemptError> {
        let mut reader = BufReader::new(sse.as_bytes());
        let mut prefix = Vec::new();
        preflight_anthropic_stream_reader(&mut reader, &mut prefix).map(|_| prefix)
    }

    fn first<'a>(events: &'a [(String, Value)], kind: &str) -> &'a Value {
        &events
            .iter()
            .find(|(k, _)| k == kind)
            .unwrap_or_else(|| panic!("no event of kind {kind}"))
            .1
    }

    #[test]
    fn free_proxy_port_range_skips_lark_oauth_callback_port() {
        assert_eq!(FREE_PROXY_PORT_START, 8766);
        assert!(FREE_PROXY_PORT_START <= FREE_PROXY_PORT_END);
    }

    #[test]
    fn free_proxy_logs_encode_tool_sentinels() {
        let logs = vec![
            free_proxy_route_log(
                "attempt-1".to_string(),
                "OpenRouter".to_string(),
                "z-ai/glm-4.6".to_string(),
                "running",
                None,
            ),
            free_proxy_route_log(
                "attempt-1".to_string(),
                "OpenRouter".to_string(),
                "z-ai/glm-4.6".to_string(),
                "error",
                Some("HTTP 402: insufficient balance".to_string()),
            ),
        ];
        let encoded = encode_free_proxy_logs(&logs).unwrap();

        assert!(encoded.contains(TOOL_OPEN));
        assert!(encoded.contains("\"name\":\"free_proxy\""));
        assert!(encoded.contains("尝试使用 OpenRouter"));
        assert!(encoded.contains("失败，切换"));
    }

    #[test]
    fn openai_translation_injects_free_proxy_log_block() {
        let sse =
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\
                   data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\
                   data: [DONE]\n";
        let log_text = encode_free_proxy_logs(&[free_proxy_route_log(
            "attempt-1".to_string(),
            "LLM7".to_string(),
            "codestral-latest".to_string(),
            "done",
            None,
        )])
        .unwrap();
        let events = collect_with_log(sse, "claude-x", Some(&log_text));
        let deltas: Vec<&Value> = events
            .iter()
            .filter(|(kind, _)| kind == "content_block_delta")
            .map(|(_, value)| value)
            .collect();

        assert!(deltas[0]["delta"]["text"]
            .as_str()
            .unwrap()
            .contains(TOOL_OPEN));
        assert_eq!(deltas[0]["index"], 0);
        assert_eq!(deltas[1]["delta"]["text"], "Hello");
        assert_eq!(deltas[1]["index"], 1);
    }

    #[test]
    fn anthropic_passthrough_injects_log_and_shifts_content_indices() {
        let sse = "event: message_start\n\
                   data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n\
                   event: content_block_start\n\
                   data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
                   event: content_block_delta\n\
                   data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n\
                   event: content_block_stop\n\
                   data: {\"type\":\"content_block_stop\",\"index\":0}\n\n";
        let mut events: Vec<(String, Value)> = Vec::new();
        let mut sink = |event: &str, data: &Value| -> bool {
            events.push((event.to_string(), data.clone()));
            true
        };

        run_anthropic_passthrough_with_log_text(sse.as_bytes(), "LOG", &mut sink);

        let deltas: Vec<&Value> = events
            .iter()
            .filter(|(kind, _)| kind == "content_block_delta")
            .map(|(_, value)| value)
            .collect();
        assert_eq!(deltas[0]["delta"]["text"], "LOG");
        assert_eq!(deltas[0]["index"], 0);
        assert_eq!(deltas[1]["delta"]["text"], "Hello");
        assert_eq!(deltas[1]["index"], 1);
    }

    #[test]
    fn route_parsing_distinguishes_messages_and_count_tokens() {
        assert_eq!(
            parse_channel_route("/ch/groq/v1/messages"),
            Some(("groq".to_string(), ProxyEndpoint::Messages))
        );
        assert_eq!(
            parse_channel_route("/ch/groq/v1/messages/count_tokens"),
            Some(("groq".to_string(), ProxyEndpoint::CountTokens))
        );
        assert_eq!(
            parse_channel_route("/ch/groq/v1/messages/"),
            Some(("groq".to_string(), ProxyEndpoint::Messages))
        );
        assert_eq!(parse_channel_route("/ch//v1/messages"), None);
        assert_eq!(parse_channel_route("/ch/groq/v1/other"), None);
        assert_eq!(parse_channel_route("/health"), None);
    }

    #[test]
    fn finish_reason_mapping() {
        assert_eq!(map_finish_reason(Some("stop")), "end_turn");
        assert_eq!(map_finish_reason(Some("length")), "max_tokens");
        assert_eq!(map_finish_reason(Some("tool_calls")), "tool_use");
        assert_eq!(map_finish_reason(None), "end_turn");
    }

    #[test]
    fn openai_json_validation_rejects_200_error_shapes() {
        assert!(validate_openai_json_body(&json!({
            "choices": [{ "message": { "content": "ok" } }]
        }))
        .is_ok());
        assert!(
            validate_openai_json_body(&json!({ "error": { "message": "bad key" } }))
                .unwrap_err()
                .contains("bad key")
        );
        assert_eq!(
            validate_openai_json_body(&json!({ "message": "not openai" })).unwrap_err(),
            "missing choices[]"
        );
        assert_eq!(
            validate_openai_json_body(&json!({
                "choices": [{ "message": { "content": "" } }]
            }))
            .unwrap_err(),
            "missing assistant content/tool"
        );
    }

    #[test]
    fn openai_stream_preflight_rejects_200_done_without_output() {
        let err = preflight_openai("data: [DONE]\n").unwrap_err();
        assert_eq!(err.status, 502);
        assert!(err.detail.contains("before first assistant content/tool"));
    }

    #[test]
    fn openai_stream_preflight_rejects_200_role_only_stream() {
        let sse =
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\
                   data: [DONE]\n";
        let err = preflight_openai(sse).unwrap_err();
        assert_eq!(err.status, 502);
        assert!(err.detail.contains("before first assistant content/tool"));
    }

    #[test]
    fn openai_stream_preflight_accepts_delayed_text_output() {
        let sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}]}\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\
                   data: [DONE]\n";
        let prefix = preflight_openai(sse).unwrap();
        let prefix = String::from_utf8(prefix).unwrap();
        assert!(prefix.contains("\"role\":\"assistant\""));
        assert!(prefix.contains("\"content\":\"Hello\""));
    }

    #[test]
    fn anthropic_stream_preflight_rejects_200_without_output() {
        let sse = "event: message_start\n\
                   data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\
                   event: message_stop\n\
                   data: {\"type\":\"message_stop\"}\n";
        let err = preflight_anthropic(sse).unwrap_err();
        assert_eq!(err.status, 502);
        assert!(err.detail.contains("before first assistant content/tool"));
    }

    #[test]
    fn anthropic_stream_preflight_accepts_text_delta() {
        let sse = "event: message_start\n\
                   data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\
                   event: content_block_delta\n\
                   data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n";
        let prefix = preflight_anthropic(sse).unwrap();
        let prefix = String::from_utf8(prefix).unwrap();
        assert!(prefix.contains("\"text\":\"Hello\""));
    }

    #[test]
    fn estimate_input_tokens_counts_text() {
        let body = json!({ "messages": [{ "role": "user", "content": "12345678" }] });
        assert_eq!(estimate_input_tokens(&body), 2); // 8 chars / 4
        let empty = json!({ "messages": [] });
        assert_eq!(estimate_input_tokens(&empty), 1); // floored to 1
    }

    #[test]
    fn proxy_auth_accepts_local_token_headers_only() {
        let expected = "local-token-123";
        let local = Header::from_bytes(PROXY_AUTH_HEADER.as_bytes(), expected.as_bytes()).unwrap();
        let x_api_key = Header::from_bytes(&b"x-api-key"[..], expected.as_bytes()).unwrap();
        let auth = Header::from_bytes(
            &b"Authorization"[..],
            format!("Bearer {expected}").as_bytes(),
        )
        .unwrap();
        let wrong = Header::from_bytes(&b"x-api-key"[..], &b"wrong"[..]).unwrap();

        assert!(proxy_auth_headers_match(&[local], expected));
        assert!(proxy_auth_headers_match(&[x_api_key], expected));
        assert!(proxy_auth_headers_match(&[auth], expected));
        assert!(!proxy_auth_headers_match(&[wrong], expected));
        assert!(!proxy_auth_headers_match(&[], expected));
    }

    #[test]
    fn proxy_port_accepting_detects_listening_socket() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(proxy_port_accepting(port));
    }

    #[test]
    fn stream_head_does_not_allow_wildcard_cors() {
        let mut out = Vec::new();
        write_stream_head(&mut out, 200, "text/event-stream").unwrap();
        let head = String::from_utf8(out).unwrap();

        assert!(!head.contains("Access-Control-Allow-Origin"));
        assert!(!head.contains("Access-Control-Allow-Headers"));
    }

    #[test]
    fn model_candidates_dedupes_primary_and_fallbacks() {
        assert_eq!(
            model_candidates("glm-4.6", &["GLM-4.6".into(), "glm-5.1".into(), " ".into()]),
            vec!["glm-4.6".to_string(), "glm-5.1".to_string()]
        );
    }

    #[test]
    fn model_candidates_prefer_cached_success_for_same_config() {
        let fallbacks = vec!["glm-5.1".to_string(), "glm-4.5".to_string()];
        let (cache_key, candidates) =
            model_candidates_for_channel("cache_test_channel", "glm-4.6", &fallbacks);
        assert_eq!(candidates[0], "glm-4.6");

        remember_model_success(&cache_key, "glm-5.1");
        let (_, candidates) =
            model_candidates_for_channel("cache_test_channel", "glm-4.6", &fallbacks);
        assert_eq!(candidates[0], "glm-5.1");

        let (_, changed_primary) =
            model_candidates_for_channel("cache_test_channel", "custom-model", &fallbacks);
        assert_eq!(changed_primary[0], "custom-model");
    }

    #[test]
    fn openrouter_candidates_normalize_bare_glm_models() {
        let fallbacks = vec!["GLM-5.1".to_string(), "z-ai/glm-4.5-air:free".to_string()];
        let (_, candidates) = model_candidates_for_channel("open_router", "glm-4.6", &fallbacks);
        assert_eq!(
            candidates,
            vec![
                "z-ai/glm-4.6".to_string(),
                "z-ai/glm-5.1".to_string(),
                "z-ai/glm-4.5-air:free".to_string(),
                "z-ai/glm-4.7".to_string(),
            ]
        );
    }

    #[test]
    fn channel_candidates_have_backend_builtin_models() {
        let (_, gemini) = model_candidates_for_channel("gemini", "", &[]);
        assert_eq!(
            gemini,
            vec![
                "gemini-2.5-flash".to_string(),
                "gemini-2.5-flash-lite".to_string(),
                "gemini-2.0-flash".to_string(),
            ]
        );

        let (_, openrouter) = model_candidates_for_channel("open_router", "", &[]);
        assert_eq!(openrouter[0], "z-ai/glm-4.6");
        assert!(openrouter.contains(&"z-ai/glm-5.1".to_string()));

        let (_, github_models) = model_candidates_for_channel("github_models", "", &[]);
        assert_eq!(github_models[0], "openai/gpt-4.1-mini");

        let (_, huggingface_router) = model_candidates_for_channel("huggingface_router", "", &[]);
        assert!(huggingface_router.contains(&"Qwen/Qwen3-Coder-480B-A35B-Instruct".to_string()));

        let (_, sambanova) = model_candidates_for_channel("sambanova", "", &[]);
        assert_eq!(sambanova[0], "DeepSeek-V3.1");

        let (_, together) = model_candidates_for_channel("together", "", &[]);
        assert_eq!(together[0], "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8");
    }

    #[test]
    fn channel_candidates_normalize_known_bare_aliases() {
        let (_, nvidia) =
            model_candidates_for_channel("nvidia_nim", "nemotron-3-super-120b-a12b", &[]);
        assert_eq!(nvidia[0], "nvidia/nemotron-3-super-120b-a12b");

        let (_, fireworks) =
            model_candidates_for_channel("fireworks", "llama-v3p3-70b-instruct", &[]);
        assert_eq!(
            fireworks[0],
            "accounts/fireworks/models/llama-v3p3-70b-instruct"
        );
    }

    #[test]
    fn model_candidates_failed_message_lists_tried_models() {
        let message = model_candidates_failed_message(
            "open_router",
            403,
            "model not defined",
            &["z-ai/glm-4.6".to_string(), "z-ai/glm-5.1".to_string()],
        );
        assert!(message.contains("channel open_router"));
        assert!(message.contains("tried: z-ai/glm-4.6, z-ai/glm-5.1"));
        assert!(message.contains("upstream 403"));
    }

    #[test]
    fn model_error_detection_is_narrow() {
        assert!(looks_like_model_error(403, "model not defined: glm-4.6"));
        assert!(looks_like_model_error(
            404,
            "{\"error\":\"model does not exist\"}"
        ));
        assert!(!looks_like_model_error(401, "invalid api key"));
        assert!(!looks_like_model_error(429, "rate limit exceeded"));
        assert!(!looks_like_model_error(500, "model server overloaded"));
    }

    #[test]
    fn retry_after_duration_uses_seconds_and_clamps() {
        assert_eq!(
            retry_after_duration(Some("2")),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            retry_after_duration(Some("999999")),
            Some(Duration::from_secs(3600))
        );
        assert_eq!(
            retry_after_duration(Some("Wed, 21 Oct 2015 07:28:00 GMT")),
            None
        );
    }

    #[test]
    fn auto_cooldown_classifies_rate_limit_auth_and_billing_errors() {
        let limited = ProxyAttemptError {
            status: 429,
            content_type: "application/json".to_string(),
            detail: "rate limit exceeded".to_string(),
            raw_body: false,
            retry_after: Some("7".to_string()),
        };
        assert_eq!(
            cooldown_for_attempt_error(&limited),
            Some(Duration::from_secs(7))
        );

        let auth = ProxyAttemptError {
            status: 401,
            content_type: "application/json".to_string(),
            detail: "invalid api key".to_string(),
            raw_body: false,
            retry_after: None,
        };
        assert_eq!(
            cooldown_for_attempt_error(&auth),
            Some(DEFAULT_AUTH_COOLDOWN)
        );

        let billing = ProxyAttemptError {
            status: 402,
            content_type: "application/json".to_string(),
            detail: "No payment method. Add a payment method here.".to_string(),
            raw_body: false,
            retry_after: None,
        };
        assert_eq!(
            cooldown_for_attempt_error(&billing),
            Some(Duration::from_secs(300))
        );

        let balance = ProxyAttemptError {
            status: 500,
            content_type: "application/json".to_string(),
            detail: "insufficient balance, please recharge".to_string(),
            raw_body: false,
            retry_after: None,
        };
        assert_eq!(
            cooldown_for_attempt_error(&balance),
            Some(Duration::from_secs(300))
        );

        let model = ProxyAttemptError {
            status: 422,
            content_type: "application/json".to_string(),
            detail: "model unavailable".to_string(),
            raw_body: false,
            retry_after: None,
        };
        assert_eq!(cooldown_for_attempt_error(&model), None);
    }

    #[test]
    fn auto_route_model_override_only_uses_explicit_models() {
        assert_eq!(auto_route_model_override(""), None);
        assert_eq!(auto_route_model_override(" auto "), None);
        assert_eq!(
            auto_route_model_override("z-ai/glm-5.1"),
            Some("z-ai/glm-5.1".to_string())
        );
    }

    #[test]
    fn with_json_model_overrides_body_model() {
        let body = json!({ "model": "bad", "messages": [] });
        let out = with_json_model(&body, "good");
        assert_eq!(out["model"], "good");
        assert_eq!(body["model"], "bad");
    }

    #[test]
    fn with_json_model_caps_large_max_tokens() {
        let body = json!({ "model": "bad", "messages": [], "max_tokens": 32000 });
        let out = with_json_model(&body, "good");
        assert_eq!(out["max_tokens"], 8192);
    }

    #[test]
    fn anthropic_body_translates_to_openai_shape() {
        let body = json!({
            "model": "ignored-by-override",
            "system": "You are helpful",
            "messages": [{ "role": "user", "content": "Hi" }],
            "max_tokens": 100,
            "tools": [{ "name": "foo", "description": "d", "input_schema": { "type": "object" } }],
            "tool_choice": { "type": "auto" }
        });
        let out = anthropic_to_openai_body(&body, "gpt-x");
        assert_eq!(out["model"], "gpt-x");
        assert_eq!(out["stream"], true);
        assert_eq!(out["max_tokens"], 100);
        let msgs = out["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "You are helpful");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(out["tools"][0]["type"], "function");
        assert_eq!(out["tools"][0]["function"]["name"], "foo");
        assert_eq!(out["tool_choice"], "auto");
    }

    #[test]
    fn anthropic_body_caps_large_max_tokens() {
        let body = json!({
            "messages": [{ "role": "user", "content": "Hi" }],
            "max_tokens": 32000
        });
        let out = anthropic_to_openai_body(&body, "gpt-x");
        assert_eq!(out["max_tokens"], 8192);
    }

    #[test]
    fn text_stream_translates_and_echoes_requested_model() {
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"finish_reason\":null}]}\n\
                   data: {\"choices\":[{\"delta\":{\"content\":\" world\"},\"finish_reason\":null}]}\n\
                   data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\
                   data: [DONE]\n";
        let events = collect(sse, "claude-sonnet-4-5");
        let kinds: Vec<&str> = events.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        // message_start echoes the REQUESTED model, not the upstream model.
        assert_eq!(
            first(&events, "message_start")["message"]["model"],
            "claude-sonnet-4-5"
        );
        assert_eq!(
            first(&events, "message_delta")["delta"]["stop_reason"],
            "end_turn"
        );
    }

    #[test]
    fn non_streaming_json_translates_to_anthropic_events() {
        let body = json!({
            "choices": [{
                "message": { "role": "assistant", "content": "Hello JSON" },
                "finish_reason": "stop"
            }],
            "usage": { "completion_tokens": 7 }
        });
        let events = collect_json(&body, "claude-x");
        let kinds: Vec<&str> = events.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "message_start",
                "content_block_start",
                "content_block_delta",
                "content_block_stop",
                "message_delta",
                "message_stop",
            ]
        );
        assert_eq!(
            first(&events, "content_block_delta")["delta"]["text"],
            "Hello JSON"
        );
        assert_eq!(first(&events, "message_delta")["usage"]["output_tokens"], 7);
    }

    #[test]
    fn non_streaming_json_tool_calls_translate_to_anthropic_events() {
        let body = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_json",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"a.txt\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        });
        let events = collect_json(&body, "claude-x");
        let start = first(&events, "content_block_start");
        assert_eq!(start["content_block"]["type"], "tool_use");
        assert_eq!(start["content_block"]["name"], "read_file");
        assert_eq!(start["content_block"]["id"], "call_json");
        assert_eq!(
            first(&events, "content_block_delta")["delta"]["partial_json"],
            "{\"path\":\"a.txt\"}"
        );
        assert_eq!(
            first(&events, "message_delta")["delta"]["stop_reason"],
            "tool_use"
        );
    }

    #[test]
    fn tool_call_canonical_order_produces_named_block() {
        // OpenAI canonical: id + name in the first delta, arguments stream after.
        let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\
                   data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\"\"}}]}}]}\n\
                   data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":\\\"SF\\\"}\"}}]}}]}\n\
                   data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\
                   data: [DONE]\n";
        let events = collect(sse, "claude-x");
        let start = first(&events, "content_block_start");
        assert_eq!(start["content_block"]["type"], "tool_use");
        assert_eq!(start["content_block"]["name"], "get_weather");
        assert_eq!(start["content_block"]["id"], "call_1");
        // Arguments arrive as input_json_delta fragments.
        let joined: String = events
            .iter()
            .filter(|(k, _)| k == "content_block_delta")
            .filter_map(|(_, v)| v["delta"]["partial_json"].as_str())
            .collect();
        assert_eq!(joined, "{\"city\":\"SF\"}");
        assert_eq!(
            first(&events, "message_delta")["delta"]["stop_reason"],
            "tool_use"
        );
    }

    #[test]
    fn tool_call_with_arguments_before_name_never_emits_empty_name() {
        // Regression: some OpenAI-compatible providers send arguments (and id)
        // before the tool name. The block must NOT open with an empty name; it
        // must defer until the name arrives and then flush the buffered args.
        let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_2\",\"function\":{\"arguments\":\"{\\\"x\\\":1}\"}}]},\"finish_reason\":null}]}\n\
                   data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"do_thing\"}}]}}]}\n\
                   data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\
                   data: [DONE]\n";
        let events = collect(sse, "claude-x");
        let start = first(&events, "content_block_start");
        assert_eq!(start["content_block"]["type"], "tool_use");
        assert_eq!(
            start["content_block"]["name"], "do_thing",
            "tool name must be populated, not empty"
        );
        assert_eq!(start["content_block"]["id"], "call_2");
        // The buffered arguments must be flushed after the block opens.
        let joined: String = events
            .iter()
            .filter(|(k, _)| k == "content_block_delta")
            .filter_map(|(_, v)| v["delta"]["partial_json"].as_str())
            .collect();
        assert_eq!(joined, "{\"x\":1}");
    }

    #[test]
    fn message_start_usage_includes_cache_fields() {
        let events = collect("data: [DONE]\n", "claude-x");
        let usage = &first(&events, "message_start")["message"]["usage"];
        assert_eq!(usage["cache_creation_input_tokens"], 0);
        assert_eq!(usage["cache_read_input_tokens"], 0);
    }
}
