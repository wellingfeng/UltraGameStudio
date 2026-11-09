//! Own a foreground native child and its ephemeral skill transport/config.
use super::native_cli::{NativeCliSkillToolsRequest, NativeSkillInvocation};
use super::native_mcp::NativeSkillMcpBridge;
use super::SkillDesktopHost;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

struct ActiveNativeCli {
    cancelled: AtomicBool,
    scope: Mutex<Option<Arc<NativeSkillCliScope>>>,
}
impl ActiveNativeCli {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let scope = self.scope.lock().ok().and_then(|mut scope| scope.take());
        if let Some(scope) = scope {
            scope.close();
        }
    }
}
fn active_native_cli() -> &'static Mutex<HashMap<String, Arc<ActiveNativeCli>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<ActiveNativeCli>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
/// Registered before blocking launch work, so cancellation also covers no-PID startup.
pub(crate) struct NativeSkillCliOwner {
    request_id: String,
    active: Arc<ActiveNativeCli>,
}
impl NativeSkillCliOwner {
    pub(crate) fn register(id: &str) -> Result<Self, String> {
        if id.is_empty() || id.len() > 256 || id.contains('\0') {
            return Err("SKILL_NATIVE_REQUEST_ID_INVALID".into());
        }
        // Acceptance and registry binding share the intent publication lock.
        // A cancellation before registration is inherited, never consumed here.
        let _accepted = crate::accepted_ai_cli_ids().lock()
            .map_err(|_| "SKILL_NATIVE_OWNER_UNAVAILABLE")?;
        let cancelled = crate::cancelled_ai_cli_ids().lock()
            .map_err(|_| "SKILL_NATIVE_OWNER_UNAVAILABLE")?.contains(id);
        let mut registry = active_native_cli()
            .lock()
            .map_err(|_| "SKILL_NATIVE_OWNER_UNAVAILABLE")?;
        if registry.contains_key(id) || registry.len() >= 256 {
            return Err("SKILL_NATIVE_REQUEST_ALREADY_ACTIVE_OR_LIMIT".into());
        }
        let active = Arc::new(ActiveNativeCli {
            cancelled: AtomicBool::new(cancelled),
            scope: Mutex::new(None),
        });
        registry.insert(id.to_owned(), Arc::clone(&active));
        Ok(Self {
            request_id: id.to_owned(),
            active,
        })
    }
    pub(crate) fn attach(&self, scope: Arc<NativeSkillCliScope>) -> Result<(), String> {
        let mut slot = self
            .active
            .scope
            .lock()
            .map_err(|_| "SKILL_NATIVE_OWNER_UNAVAILABLE")?;
        if self.active.cancelled.load(Ordering::SeqCst) || slot.is_some() {
            drop(slot);
            scope.close();
            return Err("SKILL_NATIVE_REQUEST_CANCELLED".into());
        }
        *slot = Some(scope);
        Ok(())
    }
    pub(crate) fn check_active(&self) -> Result<(), String> {
        if self.active.cancelled.load(Ordering::SeqCst) {
            Err("SKILL_NATIVE_REQUEST_CANCELLED".into())
        } else {
            Ok(())
        }
    }
}
impl Drop for NativeSkillCliOwner {
    fn drop(&mut self) {
        self.active.cancel();
        if let Ok(mut registry) = active_native_cli().lock() {
            if registry
                .get(&self.request_id)
                .map_or(false, |active| Arc::ptr_eq(active, &self.active))
            {
                registry.remove(&self.request_id);
            }
        }
    }
}
/// Revoke the dispatcher and delete temporary config before the parent kills any child.
pub(crate) fn cancel_native_cli(request_id: &str) {
    if let Some(cancellation) = capture_native_cli_cancellation(request_id) {
        cancellation.cancel();
    }
}

pub(crate) struct NativeCliCancellation(Arc<ActiveNativeCli>);
impl NativeCliCancellation {
    pub(crate) fn cancel(self) {
        self.0.cancel();
    }
}

pub(crate) fn capture_native_cli_cancellation(request_id: &str) -> Option<NativeCliCancellation> {
    active_native_cli()
        .lock()
        .ok()
        .and_then(|registry| registry.get(request_id).cloned())
        .map(NativeCliCancellation)
}

pub(crate) struct NativeSkillCliScope {
    invocation: Arc<NativeSkillInvocation>,
    bridge: Arc<NativeSkillMcpBridge>,
    config: TransientConfig,
}
impl NativeSkillCliScope {
    pub(crate) fn private_scratch(host: &SkillDesktopHost) -> PathBuf {
        host.background.global_root.join("tmp/native-cli-skills")
    }
    pub(crate) fn project_settings(host: &SkillDesktopHost, cwd: Option<&str>) -> Option<Value> {
        let key = crate::project_history_path_key(cwd?)?;
        let path = host.background.global_root.join("workspaces/index.json");
        super::validation::safe_chain(&path).ok()?;
        let bytes = std::fs::read(path).ok()?;
        if bytes.len() > 32 * 1024 * 1024 {
            return None;
        }
        let index: Value = serde_json::from_slice(&bytes).ok()?;
        let project = index.as_array()?.iter().find(|workspace| {
            workspace
                .get("path")
                .and_then(Value::as_str)
                .and_then(crate::project_history_path_key)
                .as_ref()
                == Some(&key)
        })?;
        crate::project_mcp_settings_json_from_settings(
            project.pointer("/metadata/projectSettings")?,
            cwd,
        )
    }
    pub(crate) fn start(
        host: Arc<SkillDesktopHost>,
        request: NativeCliSkillToolsRequest,
        request_run_id: &str,
        cwd: Option<&str>,
        temp_root: &Path,
        settings: Option<Value>,
        max_requests: usize,
        lifetime: Duration,
    ) -> Result<Self, String> {
        if request_run_id.is_empty() || request_run_id.len() > 256 || request_run_id.contains('\0')
        {
            return Err("SKILL_NATIVE_REQUEST_ID_INVALID".into());
        }
        let mut nonce = [0_u8; 16];
        getrandom::getrandom(&mut nonce).map_err(|_| "SKILL_NATIVE_CHILD_ID_FAILED")?;
        let child = format!("native_cli_{}", hex::encode(nonce));
        let invocation = NativeSkillInvocation::bind(host, request, &child, cwd)?;
        let bridge =
            match NativeSkillMcpBridge::start(Arc::clone(&invocation), max_requests, lifetime) {
                Ok(bridge) => Arc::new(bridge),
                Err(error) => {
                    let _ = invocation.revoke();
                    return Err(error);
                }
            };
        let config = match TransientConfig::write(temp_root, &child, settings, &bridge) {
            Ok(config) => config,
            Err(error) => {
                bridge.close();
                return Err(error);
            }
        };
        Ok(Self {
            invocation,
            bridge,
            config,
        })
    }
    pub(crate) fn invocation(&self) -> &Arc<NativeSkillInvocation> {
        &self.invocation
    }
    pub(crate) fn bridge(&self) -> &Arc<NativeSkillMcpBridge> {
        &self.bridge
    }
    pub(crate) fn config_path(&self) -> &Path {
        &self.config.path
    }
    pub(crate) fn append_claude_args(&self, args: &mut Vec<String>) {
        let mut index = 0;
        while index < args.len() {
            if args[index] == "--mcp-config" {
                args.remove(index);
                if index < args.len() {
                    args.remove(index);
                }
            } else {
                index += 1;
            }
        }
        args.extend([
            "--mcp-config".into(),
            self.config.path.to_string_lossy().into_owned(),
            "--allowed-tools".into(),
            "mcp__ugs_skills__*".into(),
        ]);
    }
    pub(crate) fn close(&self) {
        self.bridge.close();
        self.config.close();
    }
}
impl Drop for NativeSkillCliScope {
    fn drop(&mut self) {
        self.close();
    }
}

// The host never writes this credential into a workspace .mcp.json or settings.
// No Debug implementation; write errors intentionally omit contents and paths.
struct TransientConfig {
    path: PathBuf,
}
impl TransientConfig {
    fn write(
        root: &Path,
        child: &str,
        settings: Option<Value>,
        bridge: &NativeSkillMcpBridge,
    ) -> Result<Self, String> {
        use std::io::Write;
        if !root.is_absolute() {
            return Err("SKILL_NATIVE_TEMP_ROOT_INVALID".into());
        }
        super::validation::safe_chain(root)?;
        std::fs::create_dir_all(root).map_err(|_| "SKILL_NATIVE_CONFIG_FAILED")?;
        let directory = root.join(child);
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| "SKILL_NATIVE_CONFIG_FAILED")?;
        let guard = Self {
            path: directory.join("mcp.json"),
        };
        let mut value = settings.unwrap_or_else(|| serde_json::json!({"mcpServers":{}}));
        let servers = value
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
            .ok_or("SKILL_NATIVE_MCP_SETTINGS_INVALID")?;
        servers.insert("ugs_skills".into(), serde_json::json!({
            "type":"http", "url":bridge.url(), "headers":{"Authorization":bridge.authorization()}
        }));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&guard.path)
            .map_err(|_| "SKILL_NATIVE_CONFIG_FAILED")?;
        file.write_all(value.to_string().as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "SKILL_NATIVE_CONFIG_FAILED")?;
        Ok(guard)
    }
    fn close(&self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(directory) = self.path.parent() {
            let _ = std::fs::remove_dir(directory);
        }
    }
}
impl Drop for TransientConfig {
    fn drop(&mut self) {
        self.close();
    }
}

// Test-only checkpoints pause the real worker, never a replacement launcher.
#[cfg(test)]
type TestCheckpoint = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
#[cfg(test)]
fn test_checkpoints() -> &'static Mutex<HashMap<(String, String), TestCheckpoint>> {
    static CHECKPOINTS: OnceLock<Mutex<HashMap<(String, String), TestCheckpoint>>> =
        OnceLock::new();
    CHECKPOINTS.get_or_init(|| Mutex::new(HashMap::new()))
}
#[cfg(test)]
pub(crate) fn test_checkpoint(request_id: &str, stage: &str) {
    let gate = test_checkpoints()
        .lock()
        .unwrap()
        .remove(&(request_id.into(), stage.into()));
    if let Some((ready, release)) = gate {
        ready.send(()).unwrap();
        release
            .recv_timeout(Duration::from_secs(5))
            .expect("native test checkpoint release");
    }
}

#[cfg(test)]
pub(crate) fn checkpoint(
    request_id: &str,
    stage: &str,
) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    test_checkpoints()
        .lock()
        .unwrap()
        .insert((request_id.into(), stage.into()), (ready_tx, release_rx));
    (ready_rx, release_tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::native_cli::tests::{persisted, request, source};
    use crate::skills::test_support::{skill, Fixture};
    use serde_json::json;

    #[cfg(windows)]
    fn native_stdio_binary() -> &'static PathBuf {
        static BINARY: OnceLock<PathBuf> = OnceLock::new();
        BINARY.get_or_init(|| {
            let directory =
                std::env::temp_dir().join(format!("native-skill-stdio-{}", std::process::id()));
            std::fs::create_dir_all(&directory).unwrap();
            let source = directory.join("fixture.rs");
            let binary = directory.join("offline-claude.exe");
            std::fs::write(
                &source,
                include_str!("../../tests/fixtures/native_skill_stdio.rs"),
            )
            .unwrap();
            let compiled = std::process::Command::new("rustc")
                .arg("--edition=2021")
                .arg(&source)
                .arg("-o")
                .arg(&binary)
                .output()
                .unwrap();
            assert!(
                compiled.status.success(),
                "offline native fixture must compile: {}",
                String::from_utf8_lossy(&compiled.stderr)
            );
            binary
        })
    }

    #[cfg(windows)]
    fn headless_app() -> tauri::App {
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows.clear();
        tauri::Builder::default()
            .any_thread()
            .build(context)
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn production_claude_runtime_attaches_real_mcp_and_removes_private_config_after_exit() {
        let f = Fixture::new("production-claude-attach");
        let source = source(&f);
        persisted(&f, &source);
        f.write(
            "project/.ultragamestudio/skills/stdio-read/SKILL.md",
            &skill("stdio-read", "Use the actual host read receipt."),
        );
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("stdio-attach-{}", crate::now_ms());
        let result = tauri::async_runtime::block_on(crate::ai_cli_runtime(
            "offline fixture task".into(),
            "claude-code".into(),
            Some(native_stdio_binary().to_string_lossy().into_owned()),
            None,
            source.cwd.clone(),
            None,
            Some("readonly".into()),
            None,
            Some(0),
            Some(30),
            request_id.clone(),
            Some((Arc::clone(&host), request(&source))),
            None,
            None,
            None,
            None,
            app.handle().clone(),
        ));
        assert!(
            result.is_ok(),
            "supported foreground runtime must attach the real scoped MCP: {}",
            result.err().unwrap_or_default()
        );
        let wire: Value = serde_json::from_slice(
            &std::fs::read(f.project().join("native-mcp-list-response.json")).unwrap(),
        )
        .unwrap();
        let catalog: Value =
            serde_json::from_str(wire["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(catalog["entries"][0]["name"], "stdio-read");
        let path = PathBuf::from(
            std::fs::read_to_string(f.project().join("native-config-path.txt")).unwrap(),
        );
        assert!(
            !path.starts_with(f.project()),
            "invocation credentials must never enter workspace artifacts"
        );
        assert!(path.starts_with(f.global().join("tmp/native-cli-skills")),
            "production configuration must use the injected host private scratch, not process/cwd temp");
        assert!(
            !path.exists(),
            "worker finally must delete the credential-bearing configuration"
        );
        assert!(!path.parent().unwrap().exists());
        assert!(!f.project().join(".mcp.json").exists());
        let replacement = NativeSkillCliOwner::register(&request_id)
            .expect("worker finally must release the request owner");
        drop(replacement);
    }

    #[cfg(windows)]
    #[test]
    fn production_off_disabled_and_unknown_adapters_never_attach_skill_authority() {
        let app = headless_app();
        for (label, adapter, enabled, mode) in [
            ("off", "claude-code", true, crate::skills::LearningMode::Off),
            (
                "disabled",
                "claude-code",
                false,
                crate::skills::LearningMode::AutoSafe,
            ),
            (
                "unknown",
                "unsupported-native-fixture",
                true,
                crate::skills::LearningMode::AutoSafe,
            ),
        ] {
            let f = Fixture::new(&format!("production-native-gate-{label}"));
            let source = source(&f);
            // Missing source persistence is intentional: an inactive transport must not bind.
            let host = Arc::new(SkillDesktopHost::new(f.global()));
            let mut req = request(&source);
            req.enabled = enabled;
            req.mode = mode;
            let request_id = format!("native-gate-{label}-{}", crate::now_ms());
            let result = tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "ordinary offline task".into(),
                adapter.into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                source.cwd.clone(),
                None,
                Some("readonly".into()),
                Some(HashMap::from([(
                    "UGS_NATIVE_FIXTURE_MODE".into(),
                    "ordinary".into(),
                )])),
                Some(0),
                Some(30),
                request_id.clone(),
                Some((Arc::clone(&host), req)),
                None,
                None,
                None,
                None,
                app.handle().clone(),
            ));
            assert_eq!(result.unwrap().text, "ordinary native complete");
            assert!(
                host.background.grants.lock().unwrap().is_empty(),
                "inactive transport cannot mint authority"
            );
            assert!(!active_native_cli()
                .lock()
                .unwrap()
                .contains_key(&request_id));
            assert!(!f.global().join("tmp/native-cli-skills").exists());
            assert!(!f.project().join("native-config-path.txt").exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn production_enabled_invalid_source_fails_closed_without_ordinary_fallback() {
        let f = Fixture::new("production-native-invalid-source");
        let source = source(&f);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("native-invalid-source-{}", crate::now_ms());
        let result = tauri::async_runtime::block_on(crate::ai_cli_runtime(
            "ordinary offline task".into(),
            "claude-code".into(),
            Some(native_stdio_binary().to_string_lossy().into_owned()),
            None,
            source.cwd.clone(),
            None,
            Some("readonly".into()),
            Some(HashMap::from([(
                "UGS_NATIVE_FIXTURE_MODE".into(),
                "ordinary".into(),
            )])),
            Some(0),
            Some(30),
            request_id.clone(),
            Some((Arc::clone(&host), request(&source))),
            None,
            None,
            None,
            None,
            app.handle().clone(),
        ));
        assert!(
            result.is_err(),
            "enabled invalid authority must not silently run unscoped"
        );
        assert!(!f.project().join("native-transport-started").exists());
        assert!(host.background.grants.lock().unwrap().is_empty());
        assert!(!active_native_cli()
            .lock()
            .unwrap()
            .contains_key(&request_id));
    }

    #[cfg(windows)]
    #[test]
    fn production_normal_exit_drains_claude_native_tail_before_owner_revocation() {
        let f = Fixture::new("production-native-normal-tail");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("native-normal-tail-{}", crate::now_ms());
        let (end_ready, end_release) = checkpoint(&request_id, "before-native-end");
        let (drain_ready, drain_release) = checkpoint(&request_id, "before-worker-drain");
        let handle = app.handle().clone();
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let worker_host = Arc::clone(&host);
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline tail task".into(),
                "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                None,
                Some(0),
                Some(30),
                worker_id,
                Some((worker_host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ));
            result_tx.send(result).unwrap();
        });
        end_ready
            .recv_timeout(Duration::from_secs(5))
            .expect("actual Claude native completion reader checkpoint");
        drain_ready
            .recv_timeout(Duration::from_secs(5))
            .expect("actual Claude worker drain checkpoint");
        let scope = active_native_cli()
            .lock()
            .unwrap()
            .get(&request_id)
            .unwrap()
            .scope
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        let child_id = scope.invocation().execution_run_id().to_owned();
        let authority_before_drain = scope.invocation().invoke("skills_list", json!({})).is_ok();
        drain_release.send(()).unwrap();
        let early = result_rx.recv_timeout(Duration::from_millis(200));
        end_release.send(()).unwrap();
        worker.join().unwrap();
        let returned_early = early.is_ok();
        let result =
            early.unwrap_or_else(|_| result_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        assert!(result.is_ok());
        assert!(
            authority_before_drain,
            "normal tail observation must remain authorized until parser drain"
        );
        assert!(
            !returned_early,
            "owner cleanup must not race authentic tail observation"
        );
        let grant = host
            .background
            .grants
            .lock()
            .unwrap()
            .get(&child_id)
            .unwrap()
            .clone();
        assert!(grant.revoked);
        assert_eq!(grant.evidence.len(), 1);
        assert_eq!(
            grant
                .evidence
                .values()
                .next()
                .unwrap()
                .tool_call_id
                .as_deref(),
            Some("fixture-native: exact/a")
        );
        assert!(!scope.config_path().exists());
    }

    #[cfg(windows)]
    #[test]
    fn production_scope_merges_original_project_mcp_servers_without_workspace_config_writes() {
        let f = Fixture::new("production-project-mcp-merge");
        let source = source(&f);
        persisted(&f, &source);
        let settings = json!({"mcp":{"enabled":true,"servers":[{
            "id":"existing-server","enabled":true,"transport":"http","url":"http://127.0.0.1:1/fixture"
        }]}});
        f.write(
            "global/workspaces/index.json",
            &json!([{
                "id":"workspace-a","path":source.cwd,"metadata":{"projectSettings":settings}
            }])
            .to_string(),
        );
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("project-merge-{}", crate::now_ms());
        let (ready, release) = checkpoint(&request_id, "before-spawn");
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let handle = app.handle().clone();
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline fixture task".into(),
                "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                None,
                Some(0),
                Some(30),
                worker_id,
                Some((host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ))
        });
        ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real combined-config seam");
        let scope = active_native_cli()
            .lock()
            .unwrap()
            .get(&request_id)
            .unwrap()
            .scope
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        let config: Value =
            serde_json::from_slice(&std::fs::read(scope.config_path()).unwrap()).unwrap();
        let retained =
            config["mcpServers"]["existing-server"]["url"] == "http://127.0.0.1:1/fixture";
        release.send(()).unwrap();
        assert!(worker.join().unwrap().is_ok());
        assert!(
            retained,
            "scope must synthesize original project MCP settings before adding its skill server"
        );
        assert!(!f.project().join(".ultragamestudio/sidecar").exists());
        assert!(!f.project().join(".mcp.json").exists());
        assert!(!scope.config_path().exists());
    }

    #[cfg(windows)]
    #[test]
    fn production_failed_terminal_revokes_before_killing_lingering_transport() {
        let f = Fixture::new("production-failed-terminal-revoke");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("native-failed-terminal-{}", crate::now_ms());
        let (ready, release) = checkpoint(&request_id, "before-stream-kill");
        let handle = app.handle().clone();
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline failing terminal".into(),
                "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                Some(HashMap::from([(
                    "UGS_NATIVE_FIXTURE_MODE".into(),
                    "failed-terminal-linger".into(),
                )])),
                Some(0),
                Some(30),
                worker_id,
                Some((worker_host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ))
        });
        ready
            .recv_timeout(Duration::from_secs(5))
            .expect("actual failed terminal before lingering transport kill");
        let still_active = host
            .background
            .grants
            .lock()
            .unwrap()
            .values()
            .any(|grant| !grant.revoked);
        release.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(
            !still_active,
            "a failed terminal event must revoke authority before lingering transport kill"
        );
        assert!(!active_native_cli()
            .lock()
            .unwrap()
            .contains_key(&request_id));
    }

    #[cfg(windows)]
    #[test]
    fn production_failed_exit_revokes_before_terminating_remaining_child_tree() {
        let f = Fixture::new("production-failed-exit-revoke");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("native-failed-exit-{}", crate::now_ms());
        let (ready, release) = checkpoint(&request_id, "before-exit-kill");
        let handle = app.handle().clone();
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline failing task".into(),
                "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                Some(HashMap::from([(
                    "UGS_NATIVE_FIXTURE_MODE".into(),
                    "nonzero".into(),
                )])),
                Some(0),
                Some(30),
                worker_id,
                Some((worker_host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ))
        });
        ready
            .recv_timeout(Duration::from_secs(5))
            .expect("actual failed process exit before descendant kill");
        let still_active = host
            .background
            .grants
            .lock()
            .unwrap()
            .values()
            .any(|grant| !grant.revoked);
        release.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(
            !still_active,
            "a failed native exit must revoke authority before killing its remaining tree"
        );
        assert!(host
            .background
            .grants
            .lock()
            .unwrap()
            .values()
            .all(|grant| grant.revoked));
        assert!(!active_native_cli()
            .lock()
            .unwrap()
            .contains_key(&request_id));
    }

    #[cfg(windows)]
    #[test]
    fn production_transport_error_revokes_skill_authority_before_process_termination() {
        let f = Fixture::new("production-error-revoke-order");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("error-revoke-{}", crate::now_ms());
        let (ready, release) = checkpoint(&request_id, "before-error-kill");
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let handle = app.handle().clone();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline fixture task".into(),
                "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                Some(HashMap::from([(
                    "UGS_NATIVE_FIXTURE_MODE".into(),
                    "invalid-linger".into(),
                )])),
                Some(0),
                Some(30),
                worker_id,
                Some((worker_host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ))
        });
        ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real transport-error termination checkpoint");
        let scope = active_native_cli()
            .lock()
            .unwrap()
            .get(&request_id)
            .unwrap()
            .scope
            .lock()
            .unwrap()
            .clone();
        let still_authorized = scope.as_ref().map_or(false, |scope| {
            scope.invocation().invoke("skills_list", json!({})).is_ok()
        });
        release.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(
            !still_authorized,
            "transport error must revoke the dispatcher before killing the native child"
        );
        assert!(host
            .background
            .grants
            .lock()
            .unwrap()
            .values()
            .all(|grant| grant.revoked));
        assert!(!crate::active_ai_cli_pids()
            .lock()
            .unwrap()
            .contains_key(&request_id));
    }

    #[cfg(windows)]
    #[test]
    fn production_cancellation_after_accept_before_register_creates_no_authority() {
        let f = Fixture::new("production-cancel-accept-register");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("cancel-accept-register-{}", crate::now_ms());
        let (ready, release) = checkpoint(&request_id, "after-accept-before-native-register");
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let handle = app.handle().clone();
        let worker_host = Arc::clone(&host);
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline fixture task".into(), "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()), None,
                worker_source.cwd.clone(), None, Some("readonly".into()), None,
                Some(0), Some(30), worker_id,
                Some((worker_host, request(&worker_source))), None, None, None, None, handle,
            ))
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        crate::cancel_ai_cli(request_id.clone()).unwrap();
        release.send(()).unwrap();
        let result = worker.join().unwrap();
        let no_scope = host.background.grants.lock().unwrap().is_empty();
        assert!(result.is_err() && no_scope && !f.project().join("native-transport-started").exists(),
            "successful accepted cancellation must prevent both scope creation and child spawn");
        assert!(!active_native_cli().lock().unwrap().contains_key(&request_id));
    }

    #[cfg(windows)]
    #[test]
    fn production_cancellation_before_spawn_never_launches_a_child() {
        let f = Fixture::new("production-cancel-before-spawn");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("cancel-no-pid-{}", crate::now_ms());
        let (ready, release) = checkpoint(&request_id, "before-spawn");
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let handle = app.handle().clone();
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline fixture task".into(),
                "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                None,
                Some(0),
                Some(30),
                worker_id,
                Some((host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ))
        });
        ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real worker must reach the spawn seam");
        assert!(!crate::active_ai_cli_pids()
            .lock()
            .unwrap()
            .contains_key(&request_id));
        crate::cancel_ai_cli(request_id.clone()).unwrap();
        release.send(()).unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(
            !f.project().join("native-transport-started").exists(),
            "a no-PID cancellation must be checked again immediately before process spawn"
        );
        assert!(!active_native_cli()
            .lock()
            .unwrap()
            .contains_key(&request_id));
    }

    #[cfg(windows)]
    #[test]
    fn production_cancellation_between_spawn_and_pid_registration_remains_cancelled() {
        let f = Fixture::new("production-cancel-pid-window");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("cancel-pid-window-{}", crate::now_ms());
        let (ready, release) = checkpoint(&request_id, "after-spawn");
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let handle = app.handle().clone();
        let worker = std::thread::spawn(move || {
            tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline fixture task".into(),
                "claude-code".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                None,
                Some(0),
                Some(30),
                worker_id,
                Some((host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ))
        });
        ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real child spawn checkpoint");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !f.project().join("native-mcp-list-response.json").is_file()
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            f.project().join("native-mcp-list-response.json").is_file(),
            "child must complete actual MCP handshake before cancel"
        );
        crate::cancel_ai_cli(request_id.clone()).unwrap();
        release.send(()).unwrap();
        assert!(
            worker.join().unwrap().is_err(),
            "cancel in the spawn/registration window must not become successful after CLI exit=0"
        );
        assert!(!crate::active_ai_cli_pids()
            .lock()
            .unwrap()
            .contains_key(&request_id));
        assert!(!crate::active_ai_cli_jobs()
            .lock()
            .unwrap()
            .contains_key(&request_id));
        assert!(!active_native_cli()
            .lock()
            .unwrap()
            .contains_key(&request_id));
    }

    #[cfg(windows)]
    #[test]
    fn production_codex_completion_waits_for_native_tail_drain_without_attaching_skills() {
        use tauri::Listener;
        let f = Fixture::new("production-codex-tail");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("codex-tail-{}", crate::now_ms());
        let (end_ready, end_release) = checkpoint(&request_id, "before-native-end");
        let (drain_ready, drain_release) = checkpoint(&request_id, "before-worker-drain");
        let (events_tx, events_rx) = std::sync::mpsc::channel();
        let sub = app.listen(crate::NATIVE_CLI_TOOL_EVENT, move |event| {
            events_tx
                .send(serde_json::from_str::<Value>(event.payload()).unwrap())
                .unwrap();
        });
        let worker_source = source.clone();
        let worker_id = request_id.clone();
        let handle = app.handle().clone();
        let worker_host = Arc::clone(&host);
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let result = tauri::async_runtime::block_on(crate::ai_cli_runtime(
                "offline codex fixture task".into(),
                "codex".into(),
                Some(native_stdio_binary().to_string_lossy().into_owned()),
                None,
                worker_source.cwd.clone(),
                None,
                Some("readonly".into()),
                None,
                Some(0),
                Some(30),
                worker_id,
                Some((worker_host, request(&worker_source))),
                None,
                None,
                None,
                None,
                handle,
            ));
            result_tx.send(result).unwrap();
        });
        end_ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real Codex parser tail checkpoint");
        drain_ready
            .recv_timeout(Duration::from_secs(5))
            .expect("real Codex worker cleanup checkpoint");
        drain_release.send(()).unwrap();
        let early = result_rx.recv_timeout(Duration::from_millis(200));
        end_release.send(()).unwrap();
        worker.join().unwrap();
        let returned_early = early.is_ok();
        let result =
            early.unwrap_or_else(|_| result_rx.recv_timeout(Duration::from_secs(5)).unwrap());
        app.unlisten(sub);
        assert!(!returned_early, "a terminal Codex result must not return while authentic native tail evidence is still undrained");
        assert_eq!(result.unwrap().text, "offline codex complete");
        let events: Vec<_> = events_rx.try_iter().collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[1]["phase"], "end");
        assert_eq!(events[1]["runId"], request_id);
        assert_eq!(events[1]["toolCallId"], "fixture-codex-tail: exact/a");
        assert!(
            events[1].get("sourceOrigin").is_none(),
            "unsupported transport must not mint a skill association"
        );
        assert!(
            host.background.grants.lock().unwrap().is_empty(),
            "Codex has no controlled Rust skill transport"
        );
        assert!(!f.global().join("tmp/native-cli-skills").exists());
    }

    #[cfg(windows)]
    #[test]
    fn production_native_parser_records_child_evidence_before_ui_with_request_correlation() {
        use tauri::Listener;
        let f = Fixture::new("production-parser-ingress");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let app = headless_app();
        let request_id = format!("stdio-parser-{}", crate::now_ms());
        let (sender, receiver) = std::sync::mpsc::channel();
        let observed_host = Arc::clone(&host);
        let subscription = app.listen(crate::NATIVE_CLI_TOOL_EVENT, move |event| {
            let payload: Value = serde_json::from_str(event.payload()).unwrap();
            let grants = observed_host.background.grants.lock().unwrap();
            let prior_evidence = payload["runId"]
                .as_str()
                .and_then(|id| grants.get(id))
                .map_or(false, |grant| {
                    grant
                        .evidence
                        .values()
                        .any(|e| e.tool_call_id.as_deref() == payload["toolCallId"].as_str())
                });
            sender.send((payload, prior_evidence)).unwrap();
        });
        let result = tauri::async_runtime::block_on(crate::ai_cli_runtime(
            "offline fixture task".into(),
            "claude-code".into(),
            Some(native_stdio_binary().to_string_lossy().into_owned()),
            None,
            source.cwd.clone(),
            None,
            Some("readonly".into()),
            None,
            Some(0),
            Some(30),
            request_id.clone(),
            Some((Arc::clone(&host), request(&source))),
            None,
            None,
            None,
            None,
            app.handle().clone(),
        ))
        .expect("fixture native transport must complete");
        app.unlisten(subscription);
        assert_eq!(result.text, "offline native complete");
        assert_eq!(result.usage.as_ref().unwrap()["input_tokens"], 7);
        let events: Vec<_> = receiver.try_iter().collect();
        assert_eq!(
            events.len(),
            2,
            "only actual protocol records produce native callbacks"
        );
        let (end, was_registered_before_ui) = &events[1];
        assert!(
            *was_registered_before_ui,
            "native host evidence ingress must precede the UI event"
        );
        assert_ne!(end["runId"], request_id);
        assert_ne!(end["runId"], source.run_id);
        assert_eq!(end["runId"], events[0].0["runId"]);
        assert_eq!(end["requestRunId"], request_id);
        assert_eq!(end["sourceOrigin"], json!(source));
        assert_eq!(end["toolCallId"], "fixture-native: exact/a");
        assert_eq!(end["parentId"], "fixture-parent: exact/b");
        assert_eq!(end["provenance"], "native-tool");
        assert!(
            end.get("exitCode").is_none(),
            "Read result never borrows CLI exit=0"
        );
        let grant = host
            .background
            .grants
            .lock()
            .unwrap()
            .get(end["runId"].as_str().unwrap())
            .unwrap()
            .clone();
        assert!(
            grant.revoked,
            "normal worker completion must revoke the child grant"
        );
        assert_eq!(grant.evidence.len(), 1);
        assert_eq!(grant.evidence.values().next().unwrap().kind, "tool");
        assert!(!grant.evidence.values().any(|e| e.kind == "verification"));
    }

    #[test]
    fn foreground_claude_arguments_load_only_transient_skill_transport_without_inline_credentials()
    {
        let f = Fixture::new("native-args");
        let source = source(&f);
        persisted(&f, &source);
        let scope = NativeSkillCliScope::start(
            Arc::new(SkillDesktopHost::new(f.global())),
            request(&source),
            "native-args-request",
            source.cwd.as_deref(),
            &f.0.join("transient"),
            None,
            32,
            Duration::from_secs(30),
        )
        .unwrap();
        let mut args = vec![
            "-p".into(),
            "--mcp-config".into(),
            "previous-project-copy.json".into(),
        ];
        scope.append_claude_args(&mut args);
        let configs: Vec<_> = args
            .windows(2)
            .filter(|pair| pair[0] == "--mcp-config")
            .collect();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0][1], scope.config_path().to_string_lossy());
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--allowed-tools" && pair[1] == "mcp__ugs_skills__*"));
        assert!(args
            .iter()
            .all(|arg| !arg.contains(scope.bridge().authorization())));
    }

    #[test]
    fn native_cli_request_cancellation_revokes_dispatcher_before_any_pid_exists() {
        let f = Fixture::new("native-launch-cancel");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let owner = NativeSkillCliOwner::register("native-cancel-before-pid").unwrap();
        let scope = Arc::new(
            NativeSkillCliScope::start(
                Arc::clone(&host),
                request(&source),
                "native-cancel-before-pid",
                source.cwd.as_deref(),
                &f.0.join("transient"),
                None,
                32,
                Duration::from_secs(30),
            )
            .unwrap(),
        );
        owner.attach(Arc::clone(&scope)).unwrap();
        crate::cancel_ai_cli("native-cancel-before-pid".into()).unwrap();
        assert!(
            owner.check_active().is_err(),
            "cancel must cover the pending native launch"
        );
        assert!(scope
            .invocation()
            .invoke("skills_list", serde_json::json!({}))
            .is_err());
        assert!(!scope.config_path().exists());
    }

    #[test]
    fn native_launch_owns_a_distinct_child_and_transient_config_until_finally() {
        let f = Fixture::new("native-launch-owner");
        let source = source(&f);
        persisted(&f, &source);
        let content = skill(
            "native-scope-read",
            "Read bytes using the same desktop host.",
        );
        f.write(
            "project/.ultragamestudio/skills/native-scope-read/SKILL.md",
            &content,
        );
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let scope = NativeSkillCliScope::start(
            Arc::clone(&host), request(&source), "frontend-request", source.cwd.as_deref(),
            &f.0.join("transient"), Some(json!({"mcpServers":{"existing":{"type":"http","url":"http://127.0.0.1:1/existing"}}})),
            32, Duration::from_secs(30),
        ).expect("native CLI production owner must start the scoped service");
        let config_path = scope.config_path().to_path_buf();
        assert!(config_path.starts_with(f.0.join("transient")));
        let config: Value = serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(
            config["mcpServers"]["ugs_skills"]["url"],
            scope.bridge().url()
        );
        // Compare in memory; never include the credential in assertion output.
        assert!(
            config["mcpServers"]["ugs_skills"]["headers"]["Authorization"].as_str()
                == Some(scope.bridge().authorization())
        );
        assert_eq!(
            config["mcpServers"]["existing"]["url"],
            "http://127.0.0.1:1/existing"
        );
        assert!(!f.project().join(".mcp.json").exists());
        let mut starts = std::collections::HashMap::new();
        let mut observed = vec![];
        let child_run_id = scope.invocation().execution_run_id().to_owned();
        assert_ne!(child_run_id, source.run_id);
        assert_ne!(child_run_id, "frontend-request");
        crate::claude_tool_start_patch(
            &child_run_id,
            &json!({}),
            &json!({"id":"native original/a","name":"Read","input":{"path":"guide.md"}}),
            &mut starts,
            &mut |_, mut payload| {
                scope
                    .invocation()
                    .observe_native_event(&mut payload)
                    .unwrap();
                observed.push(payload);
            },
        );
        assert_eq!(observed[0]["runId"], child_run_id);
        assert_eq!(observed[0]["sourceOrigin"], json!(source));
        let catalog = scope.invocation().invoke("skills_list", json!({})).unwrap();
        let read = scope
            .invocation()
            .invoke(
                "skill_view",
                json!({"skillId":catalog["entries"][0]["skillId"]}),
            )
            .unwrap();
        assert_eq!(read["content"], content);
        let invocation = Arc::clone(scope.invocation());
        drop(scope); // Exactly the production RAII/finally path, including spawn errors.
        assert!(!config_path.exists());
        assert!(!config_path.parent().unwrap().exists());
        assert!(invocation.invoke("skills_list", json!({})).is_err());
    }
}
