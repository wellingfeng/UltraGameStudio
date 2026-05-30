use std::io::{BufRead, Read, Write};
use std::process::{Command, Stdio};
use tauri::Emitter;

/// Windows CreateProcess flag: don't allocate a console window for the child.
/// Without this, spawning the `claude` console binary pops up a black terminal
/// window every time the app runs a node. No-op on other platforms.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Apply the no-console-window flag to a Command on Windows (no-op elsewhere).
fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Map a frontend adapter id to the local CLI binary that runs it.
///
///   claude-code -> claude
///   codex       -> codex
///   gemini      -> gemini
///
/// Unknown adapters fall back to the literal id so a custom CLI on PATH can
/// still be targeted.
fn adapter_binary(adapter: &str) -> &str {
    match adapter {
        "claude-code" | "claude" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        other => other,
    }
}

/// Best-effort self-heal for a bun-installed `claude` whose binary an
/// interrupted auto-update renamed to `claude.exe.old.<timestamp>` (leaving the
/// CLI broken: "bin executable does not exist on disk / corrupted node_modules").
///
/// If the expected binary is missing but a renamed `.old` copy exists, the newest
/// one is restored. No-op on non-bun / non-Windows installs (paths won't match),
/// so it is safe to call unconditionally before spawning claude. Combined with
/// `DISABLE_AUTOUPDATER=1` on the spawn (which stops the CLI from re-corrupting
/// itself), this keeps the run working across the auto-update breakage loop.
fn repair_claude_binary() {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return;
    }
    let bin_dir = std::path::Path::new(&home)
        .join(".bun")
        .join("install")
        .join("global")
        .join("node_modules")
        .join("@anthropic-ai")
        .join("claude-code")
        .join("bin");
    // The binary is `claude.exe` on Windows, `claude` elsewhere.
    for target_name in ["claude.exe", "claude"] {
        let target = bin_dir.join(target_name);
        if target.exists() {
            return; // healthy
        }
        let prefix = format!("{target_name}.old.");
        let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
        if let Ok(entries) = std::fs::read_dir(&bin_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().starts_with(&prefix) {
                    if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                        if newest.as_ref().map_or(true, |(t, _)| modified > *t) {
                            newest = Some((modified, entry.path()));
                        }
                    }
                }
            }
        }
        if let Some((_, src)) = newest {
            let _ = std::fs::copy(&src, &target);
            return;
        }
    }
}

/// Write the generated script to a uniquely-named temp file and return its path.
fn write_temp_script(script: &str) -> Result<std::path::PathBuf, String> {
    let mut path = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    path.push(format!("openworkflow-{stamp}.sh"));
    let mut file = std::fs::File::create(&path)
        .map_err(|e| format!("无法创建临时脚本: {e}"))?;
    file.write_all(script.as_bytes())
        .map_err(|e| format!("写入临时脚本失败: {e}"))?;
    Ok(path)
}

/// Run an emitted workflow script through the mapped local CLI.
///
/// Async: the blocking process spawn/wait runs on a blocking thread via
/// `spawn_blocking` so it never stalls the webview's main thread (a synchronous
/// command would freeze the UI for the CLI's whole runtime). Spawns the real
/// binary (`claude` / `codex` / `gemini`), waits for it, and returns a combined
/// stdout/stderr summary. The script is materialised to a temp file.
#[tauri::command]
async fn run_workflow(script: String, adapter: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let binary = adapter_binary(&adapter);
        let script_path = write_temp_script(&script)?;

        let mut cmd = Command::new(binary);
        hide_console(&mut cmd); // no popup terminal window on Windows
        let output = cmd
            .arg(&script_path)
            .output()
            .map_err(|e| {
                format!("启动 CLI \"{binary}\" 失败: {e}（请确认它已安装并在 PATH 中）")
            })?;

        // Best-effort cleanup; ignore failures.
        let _ = std::fs::remove_file(&script_path);

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);

        let mut summary = String::new();
        summary.push_str(&format!("[{binary}] exit={code}\n"));
        if !stdout.trim().is_empty() {
            summary.push_str("--- stdout ---\n");
            summary.push_str(stdout.trim_end());
            summary.push('\n');
        }
        if !stderr.trim().is_empty() {
            summary.push_str("--- stderr ---\n");
            summary.push_str(stderr.trim_end());
            summary.push('\n');
        }

        if output.status.success() {
            Ok(summary)
        } else {
            Err(summary)
        }
    })
    .await
    .map_err(|e| format!("运行任务调度失败: {e}"))?
}

/// System prompt steering the model to emit a pure IRGraph JSON object that maps
/// onto a *runnable* Claude Code workflow (the injected-globals DSL).
const AI_EDIT_SYSTEM: &str = "You are a workflow graph editor for OpenWorkflow. You receive the current workflow as an IRGraph JSON object plus a natural-language instruction (in Chinese or English). Return ONLY a single valid IRGraph JSON object (no markdown, no prose).

The IRGraph compiles to a real Claude Code workflow script, so use these exact node shapes:
- Envelope: {version, meta, nodes, edges, layout?}.
- meta: {name, description?, adapter?, schemaDefs?}. schemaDefs maps a schema identifier name to its JS object source, e.g. {\"REVIEW\":\"{ findings: [] }\"}.
- Each node: {id, type, parent?, label?, binding?, params}. type is one of start|end|agent|parallel|pipeline|phase|branch|loop|workflow|log|variable|codeblock. `parent` is the id of a containing branch/loop node (omit for the top level). `binding` is the JS variable name (optional).
- agent.params: {prompt, label?, agentType?, model?, schema?, isolation?, phase?}. Use `agentType` (NOT `agent`) for a sub-agent type like 'explore'/'verifier'. `schema` is a bare identifier NAME (a key of meta.schemaDefs), e.g. \"REVIEW\". model is haiku|sonnet|opus.
- parallel.params: {branches: [{prompt, agentType?, model?, schema?, label?}]} — each branch becomes a () => agent(...) thunk.
- pipeline.params: {items, stages: [{prompt, agentType?, schema?}]} — items is a JS expression naming the input array (e.g. \"files\"); each stage becomes a (prev, item, i) => agent(...) callback.
- branch.params: {condition} and loop.params: {condition} (a JS boolean expression). Their child nodes are separate nodes carrying parent = the branch/loop id.
- variable.params: {name, value, raw?}. log.params: {message}. workflow.params: {name}. codeblock.params: {code}.

Edges: {id, from:{node,port}, to:{node,port}, kind} where kind is 'exec' or 'data'. Wire an exec spine start -> ... -> end among top-level siblings; a branch/loop connects to its first child via an exec edge (kind 'exec') and children chain child->child. Express data flow as 'data'-kind edges from a producer node to a consumer node — do NOT inline ${...} yourself; the emitter does that. Keep node ids stable when editing existing nodes.";

/// Ask the Anthropic Messages API to rewrite the graph from an instruction.
///
/// Requires `api_key`. Returns the new IRGraph as a JSON string. When no key is
/// supplied the command errors so the frontend can fall back to its local
/// intent engine.
#[tauri::command]
fn ai_edit_graph(
    current_ir_json: String,
    instruction: String,
    api_key: Option<String>,
) -> Result<String, String> {
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => return Err("NO_API_KEY".to_string()),
    };

    let user_content = format!(
        "Current IRGraph:\n{current_ir_json}\n\nInstruction:\n{instruction}\n\nReturn the edited IRGraph JSON."
    );

    let body = serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 8192,
        "system": AI_EDIT_SYSTEM,
        "messages": [
            { "role": "user", "content": user_content }
        ]
    });

    let response = ureq::post("https://api.anthropic.com/v1/messages")
        .set("x-api-key", &key)
        .set("anthropic-version", "2023-06-01")
        .set("content-type", "application/json")
        .send_json(body);

    let response = match response {
        Ok(r) => r,
        Err(ureq::Error::Status(code, resp)) => {
            let detail = resp
                .into_string()
                .unwrap_or_else(|_| "<no body>".to_string());
            return Err(format!("Anthropic API 错误 {code}: {detail}"));
        }
        Err(e) => return Err(format!("请求 Anthropic API 失败: {e}")),
    };

    let parsed: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("解析 Anthropic 响应失败: {e}"))?;

    // Concatenate all text blocks from the content array.
    let text = parsed
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    let trimmed = extract_json(&text);
    // Validate it parses as JSON before returning to the frontend.
    serde_json::from_str::<serde_json::Value>(&trimmed)
        .map_err(|e| format!("模型未返回有效 JSON: {e}\n原始输出:\n{text}"))?;

    Ok(trimmed)
}

/// Strip a possible ```json fence and return the inner JSON payload.
fn extract_json(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```json") {
        return rest.trim_end_matches("```").trim().to_string();
    }
    if let Some(rest) = t.strip_prefix("```") {
        return rest.trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// How long a single CLI invocation may run before it is killed.
const AI_CLI_TIMEOUT_SECS: u64 = 600;

/// Emit a live progress chunk for a given run to the frontend.
fn emit_progress(app: &tauri::AppHandle, run_id: &str, text: &str) {
    let _ = app.emit(
        "ai-cli-progress",
        serde_json::json!({ "runId": run_id, "text": text }),
    );
}

/// Summarize a `tool_use` event into one readable progress line, e.g.
/// `🔧 Bash: ls app/src` / `🔧 Glob: **/*.tsx` / `🔧 Read: app/src/core/ir.ts`,
/// so the run log shows *what* the agent is doing, not just the tool name.
fn summarize_tool_use(name: &str, input: &serde_json::Value) -> String {
    // Prefer the most informative known field; fall back to compact JSON.
    let detail = [
        "command",
        "pattern",
        "file_path",
        "path",
        "query",
        "url",
        "description",
        "prompt",
        "old_string",
        "title",
    ]
    .iter()
    .find_map(|k| {
        input
            .get(*k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    })
    .unwrap_or_else(|| {
        let s = input.to_string();
        if s == "null" { String::new() } else { s }
    });

    let detail: String = detail.replace(['\n', '\r'], " ");
    let detail: String = detail.chars().take(200).collect();
    if detail.is_empty() {
        format!("🔧 {name}")
    } else {
        format!("🔧 {name}: {detail}")
    }
}

/// Run a prompt through the locally-installed agent CLI (e.g. `claude`) using the
/// machine's own environment/credentials — no API key is passed from the app.
///
/// Uses `claude -p "<prompt>" --output-format stream-json --verbose` so that:
///   - per-step events (assistant text, tool uses) stream to the frontend via the
///     `ai-cli-progress` event (tagged with `run_id`) — the run no longer looks
///     frozen while a node's agent is exploring the project; and
///   - the clean final answer is taken from the terminal `result` event.
/// The optional `model` maps the node's model tier (haiku/sonnet/opus) onto
/// `--model`. stdin is closed; the call is bounded by a timeout that kills the
/// child so a stuck CLI surfaces an error instead of hanging "运行中" forever.
#[tauri::command]
async fn ai_cli(
    prompt: String,
    adapter: String,
    model: Option<String>,
    cwd: Option<String>,
    permission: Option<String>,
    run_id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let binary = adapter_binary(&adapter);

        // Self-heal a claude binary that an interrupted auto-update corrupted.
        if binary == "claude" {
            repair_claude_binary();
        }

        let mut cmd = Command::new(binary);
        hide_console(&mut cmd); // no popup terminal window on Windows
        // The prompt is fed via stdin (not a positional arg) so large aggregation
        // prompts can't hit the OS command-line length limit (~32KB on Windows),
        // which would stall the final "summary" node.
        cmd.arg("-p")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            // Don't let the CLI auto-update mid-run: an interrupted update can
            // leave the binary corrupted ("bin executable does not exist").
            .env("DISABLE_AUTOUPDATER", "1");
        if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
            cmd.arg("--model").arg(m);
        }

        // Permission mode (from the AIDock dropdown) so a headless run can act
        // without stalling on permission prompts:
        //   full (默认) → skip all prompts (read/write/bash autonomously)
        //   readonly    → plan mode (explore + report, no mutations)
        //   ask         → default (may print a permission question; rarely useful headless)
        match permission.as_deref().unwrap_or("full") {
            "readonly" => {
                cmd.arg("--permission-mode").arg("plan");
            }
            "ask" => {}
            _ => {
                cmd.arg("--dangerously-skip-permissions");
            }
        }

        // Working directory: run in the user's chosen workspace so the agent
        // explores the right project (and add it as an allowed dir).
        if let Some(dir) = cwd.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            let p = std::path::Path::new(dir);
            if p.is_dir() {
                cmd.current_dir(p);
                cmd.arg("--add-dir").arg(dir);
            }
        }
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!("启动 CLI \"{binary}\" 失败: {e}（请确认它已安装并在 PATH 中）")
            })?;

        // Write the prompt to stdin on its own thread (so a large prompt can't
        // deadlock against a full pipe), then close stdin to signal EOF.
        let mut stdin_pipe = child.stdin.take();
        let prompt_bytes = prompt.into_bytes();
        let stdin_handle = std::thread::spawn(move || {
            if let Some(mut s) = stdin_pipe.take() {
                let _ = s.write_all(&prompt_bytes);
            }
        });

        // Reader thread: parse the JSONL stream, emit progress, capture the result.
        let stdout = child.stdout.take();
        let app2 = app.clone();
        let run2 = run_id.clone();
        let out_handle = std::thread::spawn(move || -> String {
            let mut result = String::new();
            let mut acc = String::new();
            if let Some(o) = stdout {
                let reader = std::io::BufReader::new(o);
                for line in reader.lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(_) => break,
                    };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let v: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("assistant") => {
                            if let Some(content) =
                                v.pointer("/message/content").and_then(|c| c.as_array())
                            {
                                for block in content {
                                    match block.get("type").and_then(|t| t.as_str()) {
                                        Some("text") => {
                                            if let Some(tx) =
                                                block.get("text").and_then(|t| t.as_str())
                                            {
                                                acc.push_str(tx);
                                                emit_progress(&app2, &run2, tx);
                                            }
                                        }
                                        Some("tool_use") => {
                                            let name = block
                                                .get("name")
                                                .and_then(|t| t.as_str())
                                                .unwrap_or("tool");
                                            let input = block
                                                .get("input")
                                                .cloned()
                                                .unwrap_or(serde_json::Value::Null);
                                            emit_progress(
                                                &app2,
                                                &run2,
                                                &format!("\n{}\n", summarize_tool_use(name, &input)),
                                            );
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                        Some("result") => {
                            if let Some(r) = v.get("result").and_then(|t| t.as_str()) {
                                result = r.to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
            if result.trim().is_empty() {
                acc
            } else {
                result
            }
        });

        let mut err_pipe = child.stderr.take();
        let err_handle = std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(p) = err_pipe.as_mut() {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        });

        // Poll for exit until the deadline; kill on timeout.
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(AI_CLI_TIMEOUT_SECS);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!(
                            "CLI \"{binary}\" 超时（{AI_CLI_TIMEOUT_SECS}s）已终止。"
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(format!("等待 CLI \"{binary}\" 失败: {e}")),
            }
        };

        let _ = stdin_handle.join();
        let output = out_handle.join().unwrap_or_default();
        let stderr_bytes = err_handle.join().unwrap_or_default();
        let stderr = String::from_utf8_lossy(&stderr_bytes);

        if status.success() {
            Ok(output)
        } else {
            let code = status.code().unwrap_or(-1);
            let detail = if stderr.trim().is_empty() {
                output.trim()
            } else {
                stderr.trim()
            };
            Err(format!("CLI \"{binary}\" 退出码 {code}: {detail}"))
        }
    })
    .await
    .map_err(|e| format!("CLI 任务调度失败: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ai_edit_graph, run_workflow, ai_cli])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
