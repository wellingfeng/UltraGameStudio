//! The probe owns the SSE future, including during endpoint discovery.
//! Aborting and joining it drops the response socket before the probe returns.
use super::{cancelled, err, Error};
use std::{collections::HashMap, sync::{atomic::AtomicBool, mpsc}, time::{Duration, Instant}};

pub(super) struct LegacyStream {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for LegacyStream {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            // Discovery runs on spawn_blocking; joining confirms socket release.
            let _ = tauri::async_runtime::block_on(task);
        }
    }
}

impl LegacyStream {
    pub(super) fn open(url: &str, headers: &HashMap<String, String>, flag: &AtomicBool)
        -> Result<(Self, String, mpsc::Receiver<String>), Error>
    {
        let url = url.to_owned();
        let headers = headers.clone();
        let (endpoint_tx, endpoint_rx) = mpsc::channel();
        let (tx, rx) = mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            let result = read_stream(&url, &headers, &endpoint_tx, &tx).await;
            if let Err(error) = result { let _ = endpoint_tx.send(Err(error)); }
        });
        let stream = Self { task: Some(task) };
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            cancelled(flag)?;
            if Instant::now() > deadline {
                return Err(err("discovery-timeout", "旧 SSE 60 秒未提供 endpoint"));
            }
            let endpoint = endpoint_rx.recv_timeout(Duration::from_millis(100));
            // Cancellation may race the stream closing or producing an error.
            cancelled(flag)?;
            match endpoint {
                Ok(endpoint) => return Ok((stream, endpoint?, rx)),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(err("protocol-error", "旧 SSE 未提供 endpoint")),
                Err(mpsc::RecvTimeoutError::Timeout) => {},
            }
        }
    }
}

async fn read_stream(url: &str, headers: &HashMap<String, String>,
    endpoint_tx: &mpsc::Sender<Result<String, Error>>, tx: &mpsc::Sender<String>) -> Result<(), Error>
{
    let client = reqwest::Client::builder().no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build().map_err(|e| err("http-unreachable", format!("MCP SSE 客户端初始化失败: {e}")))?;
    let mut request = client.get(url).header("Accept", "text/event-stream");
    for (key, value) in headers { request = request.header(key, value); }
    let mut response = request.send().await
        .map_err(|e| err("http-unreachable", format!("MCP SSE 连接失败: {e}")))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(err(if status == 401 || status == 403 { "auth-required" } else { "http-error" },
            format!("MCP HTTP 返回 {status}")));
    }
    if !response.headers().get("Content-Type").and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        return Err(err("protocol-error", "旧 SSE 响应不是 text/event-stream"));
    }
    let mut parser = Parser::default();
    while let Some(chunk) = response.chunk().await
        .map_err(|e| err("stream-error", format!("MCP SSE 读取失败: {e}")))?
    {
        if !parser.feed(&chunk, |event, data| {
            if event == "endpoint" { endpoint_tx.send(Ok(data.to_owned())).is_ok() }
            else { tx.send(data.to_owned()).is_ok() }
        })? { break; }
    }
    Ok(())
}

// Preserve partial lines and UTF-8 sequences across arbitrary HTTP chunk sizes.
#[derive(Default)]
struct Parser {
    pending: Vec<u8>,
    event: String,
    data: String,
    total: usize,
}

impl Parser {
    fn feed(&mut self, chunk: &[u8], mut on_event: impl FnMut(&str, &str) -> bool) -> Result<bool, Error> {
        self.total += chunk.len();
        if self.total > 16 * 1024 * 1024 { return Err(err("response-too-large", "MCP 响应超过 16 MiB")); }
        for byte in chunk {
            if *byte != b'\n' { self.pending.push(*byte); continue; }
            let line = std::str::from_utf8(&self.pending)
                .map_err(|e| err("stream-error", format!("MCP SSE UTF-8 无效: {e}")))?.trim_end_matches('\r');
            if line.is_empty() {
                if !self.data.is_empty() && !on_event(&self.event, self.data.trim_end_matches('\n')) { return Ok(false); }
                self.event.clear(); self.data.clear();
            } else if let Some(value) = line.strip_prefix("event:") { self.event = value.trim().into(); }
            else if let Some(value) = line.strip_prefix("data:") {
                self.data.push_str(value.strip_prefix(' ').unwrap_or(value)); self.data.push('\n');
            }
            self.pending.clear();
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_chunks_preserve_utf8_crlf_and_multiline_events() {
        let mut parser = Parser::default(); let mut events = Vec::new();
        for byte in "event: message\r\ndata: 工具\r\ndata: 参数\r\n\r\n".as_bytes() {
            parser.feed(&[*byte], |event, data| { events.push((event.to_owned(), data.to_owned())); true }).unwrap();
        }
        assert_eq!(events, [("message".into(), "工具\n参数".into())]);
    }
}
