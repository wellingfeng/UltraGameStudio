//! Foreground native CLI tools. This is not a tool-free reviewer capsule.
use super::*;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeCliSkillToolsRequest {
    pub source: SkillOrigin,
    pub enabled: bool,
    pub mode: LearningMode,
}

pub(crate) struct NativeSkillInvocation {
    host: Arc<SkillDesktopHost>,
    source: SkillOrigin,
    origin: SkillOrigin,
    mode: LearningMode,
}
impl NativeSkillInvocation {
    pub(crate) fn bind(
        host: Arc<SkillDesktopHost>,
        request: NativeCliSkillToolsRequest,
        execution_run_id: &str,
        cwd: Option<&str>,
    ) -> Result<Arc<Self>, String> {
        if !request.enabled || request.mode == LearningMode::Off {
            return Err("SKILL_NATIVE_TOOLS_DISABLED".into());
        }
        if !same_cwd(request.source.cwd.as_deref(), cwd) {
            return Err("SKILL_NATIVE_CWD_MISMATCH".into());
        }
        super::host::persisted_native_source(&host.background.global_root, &request.source)?;
        if execution_run_id == request.source.run_id {
            return Err("SKILL_NATIVE_EXECUTION_MUST_BE_DISTINCT".into());
        }
        let source = request.source;
        let mut origin = source.clone();
        origin.run_id = execution_run_id.to_string();
        host.bind(SkillHostBindingRequest {
            origin: origin.clone(),
            mode: request.mode,
            actor: SkillHostActor::Background,
            evidence: vec![],
        })?;
        Ok(Arc::new(Self {
            host,
            source,
            origin,
            mode: request.mode,
        }))
    }
    /// Fed only by the Rust native protocol parser, never by MCP arguments.
    pub(crate) fn observe_native_event(&self, event: &mut Value) -> Result<(), String> {
        if event.get("runId").and_then(Value::as_str) != Some(self.origin.run_id.as_str())
            || event.get("provenance").and_then(Value::as_str) != Some("native-tool")
        {
            return Err("SKILL_NATIVE_EVENT_SCOPE_MISMATCH".into());
        }
        event["sourceOrigin"] = json!(self.source);
        if event.get("phase").and_then(Value::as_str) != Some("end") {
            return Ok(());
        }
        let id = event
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty() && v.len() <= 256 && !v.contains('\0'))
            .ok_or("SKILL_NATIVE_EVENT_ID_REQUIRED")?;
        let name = event
            .get("toolName")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty() && v.len() <= 256 && !v.contains('\0'))
            .ok_or("SKILL_NATIVE_EVENT_NAME_REQUIRED")?;
        let exit_code = event
            .get("exitCode")
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok());
        let command = event
            .pointer("/args/command")
            .and_then(Value::as_str)
            .unwrap_or("");
        let status = event
            .get("status")
            .and_then(Value::as_str)
            .filter(|v| ["success", "error", "unknown"].contains(v))
            .unwrap_or("unknown");
        let evidence = SkillEvidence {
            evidence_id: format!(
                "native_{}",
                super::service::hash(json!([self.origin.run_id, id]).to_string().as_bytes())
            ),
            origin: self.origin.clone(),
            occurred_at: event
                .get("occurredAt")
                .and_then(Value::as_u64)
                .unwrap_or_else(crate::now_ms),
            kind: if status == "success"
                && exit_code == Some(0)
                && direct_verification(name, command)
            {
                "verification"
            } else {
                "tool"
            }
            .into(),
            provenance: "native-tool".into(),
            status: status.into(),
            summary: crate::native_tool_redact_text(
                if command.is_empty() { name } else { command },
                4096,
            ),
            tool_call_id: Some(id.into()),
            tool_name: Some(name.into()),
            parent_id: event
                .get("parentId")
                .and_then(Value::as_str)
                .map(str::to_string),
            exit_code,
            result: event
                .get("result")
                .and_then(Value::as_str)
                .map(|v| crate::native_tool_redact_text(v, 8192)),
            path: None,
            skill_id: None,
            revision: None,
        };
        let grant = self.host.background.authority(&self.origin)?;
        if grant.evidence.len() >= 256 && !grant.evidence.contains_key(&evidence.evidence_id) {
            return Err("SKILL_NATIVE_EVIDENCE_LIMIT".into());
        }
        self.host.bind(SkillHostBindingRequest {
            origin: self.origin.clone(),
            mode: self.mode,
            actor: SkillHostActor::Background,
            evidence: vec![evidence],
        })
    }
    pub(crate) fn execution_run_id(&self) -> &str {
        &self.origin.run_id
    }

    /// Close/abort/expiry revoke the dispatcher even if a request already arrived.
    pub(crate) fn revoke(&self) -> Result<(), String> {
        self.host.revoke(&self.origin)
    }

    pub(crate) fn invoke(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let grant = self.host.background.authority(&self.origin)?;
        if grant.revoked || grant.mode == LearningMode::Off {
            return Err("SKILL_TOOL_CANCELLED".into());
        }
        super::host::persisted_native_source(&self.host.background.global_root, &self.source)?;
        let args = arguments
            .as_object()
            .ok_or("SKILL_TOOL_INVALID_ARGUMENTS")?;
        if arguments.to_string().len() > 131072 {
            return Err("SKILL_TOOL_REQUEST_LIMIT".into());
        }
        if name == "skill_manage" {
            let proposal: SkillProposal =
                serde_json::from_value(arguments).map_err(|_| "SKILL_TOOL_INVALID_PROPOSAL")?;
            if proposal.version != 1
                || proposal.kind != "propose"
                || proposal.evidence_ids.is_empty()
                || proposal.evidence_ids.len() > 64
                || proposal.operations.is_empty()
                || proposal.operations.len() > 16
            {
                return Err("SKILL_TOOL_INVALID_PROPOSAL".into());
            }
            let grant = self.host.background.authority(&self.origin)?;
            if proposal
                .evidence_ids
                .iter()
                .any(|id| !grant.evidence.contains_key(id))
            {
                return Err("SKILL_TOOL_UNKNOWN_EVIDENCE".into());
            }
            return self.host.request(
                serde_json::from_value(json!({"action":"manage","origin":self.origin,
                "mode":self.mode,"proposal":proposal}))
                .map_err(|_| "SKILL_TOOL_INVALID_PROPOSAL")?,
            );
        }
        let action = match name {
            "skills_list" if args.is_empty() => "list",
            "skill_view"
                if args
                    .keys()
                    .all(|key| ["skillId", "filePath"].contains(&key.as_str())) =>
            {
                "view"
            }
            "skills_list" | "skill_view" => return Err("SKILL_TOOL_UNKNOWN_FIELD".into()),
            _ => return Err("SKILL_TOOL_UNAVAILABLE".into()),
        };
        let mut request = json!({"action":action,"origin":self.origin,"mode":self.mode});
        for (key, value) in args {
            request[key] = value.clone();
        }
        let mut result = self.host.request(
            serde_json::from_value(request).map_err(|_| "SKILL_TOOL_INVALID_ARGUMENTS")?,
        )?;
        if action == "list" {
            let grant = self.host.background.authority(&self.origin)?;
            result["learningEvidence"] = json!(grant.evidence.values().map(|e| json!({
                "evidenceId":e.evidence_id,"kind":e.kind,"provenance":e.provenance,"status":e.status,"exitCode":e.exit_code
            })).collect::<Vec<_>>());
        }
        Ok(result)
    }
}

/// Same project directory, not same spelling: `E:\A`, `e:/a/` and `E:\A\`
/// must not fail closed. A genuinely different directory still mismatches.
fn same_cwd(source: Option<&str>, cwd: Option<&str>) -> bool {
    fn clean(v: Option<&str>) -> Option<&str> {
        v.map(str::trim).filter(|v| !v.is_empty())
    }
    match (clean(source), clean(cwd)) {
        (None, None) => true,
        (Some(a), Some(b)) => {
            a == b
                || match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
                    (Ok(a), Ok(b)) => a == b,
                    _ => false,
                }
        }
        _ => false,
    }
}

// A conservative direct-check classifier, not a shell sandbox or proof of semantics.
fn direct_verification(name: &str, command: &str) -> bool {
    if ![
        "bash",
        "shell",
        "terminal",
        "exec",
        "execute",
        "command_execution",
        "commandexecution",
        "run_shell_command",
    ]
    .contains(&name.to_ascii_lowercase().as_str())
        || command.is_empty()
        || command.len() > 4096
        || command.chars().any(|c| ";|&<>`$()\r\n\0".contains(c))
    {
        return false;
    }
    let words: Vec<_> = command.split_whitespace().collect();
    if words.iter().any(|w| {
        [
            "--help",
            "--version",
            "--if-present",
            "--ignore-scripts",
            "-h",
        ]
        .contains(w)
    }) {
        return false;
    }
    let check_script = |value: &str| {
        ["test", "check", "lint", "build"].iter().any(|prefix| {
            value == *prefix
                || value
                    .strip_prefix(&format!("{prefix}:"))
                    .map_or(false, |v| {
                        !v.is_empty()
                            && v.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    })
        })
    };
    match words.as_slice() {
        ["npm" | "pnpm" | "yarn", "run", script, ..] => check_script(script),
        ["npm" | "pnpm" | "yarn", script, ..] => check_script(script),
        ["npx", "tsc" | "eslint" | "vitest", ..]
        | ["pnpm", "exec", "tsc" | "eslint" | "vitest", ..]
        | ["pytest" | "tsc" | "eslint" | "vitest", ..]
        | ["python" | "python3", "-m", "pytest", ..]
        | ["cargo", "test" | "check" | "clippy", ..]
        | ["go", "test" | "vet", ..] => true,
        _ => false,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::skills::test_support::{skill, Fixture};

    pub(crate) fn source(f: &Fixture) -> SkillOrigin {
        SkillOrigin {
            host_id: "local".into(),
            workspace_id: "workspace-a".into(),
            session_id: "session-a".into(),
            turn_id: "source-main".into(),
            run_id: "source-main".into(),
            cwd: Some(f.project().to_string_lossy().into_owned()),
        }
    }
    pub(crate) fn persisted(f: &Fixture, source: &SkillOrigin) {
        f.write(
            "global/workspaces/workspace-a/meta.json",
            &json!({
                "workspaceId":"workspace-a", "canonicalPath":source.cwd, "status":"active"
            })
            .to_string(),
        );
        f.write(
            "global/workspaces/workspace-a/sessions/session-a.json",
            &json!({
                "sessionId":"session-a", "workspaceId":"workspace-a", "messages":[{
                    "id":source.turn_id, "role":"user", "text":"Perform the task.",
                    "skillContext":{"origin":source,"loadedSkills":[]}
                }]
            })
            .to_string(),
        );
    }
    pub(crate) fn request(source: &SkillOrigin) -> NativeCliSkillToolsRequest {
        NativeCliSkillToolsRequest {
            source: source.clone(),
            enabled: true,
            mode: LearningMode::AutoSafe,
        }
    }

    #[test]
    fn native_parser_evidence_authorizes_a_real_service_mutation_with_original_child_ids() {
        let f = Fixture::new("native-skill-learn");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let invocation = NativeSkillInvocation::bind(
            Arc::clone(&host),
            request(&source),
            "child: exact/a",
            source.cwd.as_deref(),
        )
        .unwrap();
        let mut starts = std::collections::HashMap::new();
        let mut emitted = vec![];
        let mut sink = |_: &str, mut payload: Value| {
            invocation
                .observe_native_event(&mut payload)
                .expect("native host evidence ingress");
            emitted.push(payload);
        };
        crate::claude_tool_start_patch(
            "child: exact/a",
            &json!({"parent_tool_use_id":"parent: exact/b"}),
            &json!({"id":"tool: exact/c","name":"Bash","input":{"command":"cargo test"}}),
            &mut starts,
            &mut sink,
        );
        crate::claude_tool_result_patch(
            "child: exact/a",
            &json!({}),
            &json!({"tool_use_id":"tool: exact/c","content":"Fixture protocol check completed.","is_error":false,"exit_code":0}),
            &mut starts,
            &mut sink,
        );
        assert_eq!(emitted[1]["runId"], "child: exact/a");
        assert_eq!(emitted[1]["sourceOrigin"], json!(source));
        assert_eq!(emitted[1]["parentId"], "parent: exact/b");
        let catalog = invocation.invoke("skills_list", json!({})).unwrap();
        let evidence_id = catalog["learningEvidence"][0]["evidenceId"].clone();
        assert_eq!(catalog["learningEvidence"][0]["kind"], "verification");
        let content = skill(
            "native-learned",
            "Check actual saved content before asserting a skill change.",
        );
        let applied = invocation.invoke("skill_manage", json!({
            "version":1,"kind":"propose","lesson":"Retain actual readback checks.",
            "evidenceIds":[evidence_id],"operations":[{"action":"create","name":"native-learned","content":content}]
        })).expect("foreground manage path must use Rust service");
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["origin"]["runId"], "child: exact/a");
        assert_eq!(
            std::fs::read_to_string(
                f.project()
                    .join(".ultragamestudio/skills/native-learned/SKILL.md")
            )
            .unwrap(),
            content
        );
        let id = applied["changes"][0]["skillId"].as_str().unwrap();
        let read = invocation
            .invoke("skill_view", json!({"skillId":id}))
            .unwrap();
        assert_eq!(read["content"], content);
        assert_eq!(
            read["hash"],
            super::super::service::hash(content.as_bytes())
        );
    }

    #[test]
    fn native_loopback_mcp_lists_the_same_host_catalog_with_inert_client_metadata() {
        let f = Fixture::new("native-mcp-list");
        let source = source(&f);
        persisted(&f, &source);
        let content = skill("native-mcp-read", "Retain complete host read receipts.");
        f.write(
            "project/.ultragamestudio/skills/native-mcp-read/SKILL.md",
            &content,
        );
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let invocation = NativeSkillInvocation::bind(
            host,
            request(&source),
            "native-mcp-child",
            source.cwd.as_deref(),
        )
        .unwrap();
        let bridge = super::super::native_mcp::NativeSkillMcpBridge::start(
            Arc::clone(&invocation),
            32,
            std::time::Duration::from_secs(30),
        )
        .expect("foreground native bridge must bind loopback");
        let call = |name: &str, arguments: Value| {
            use std::io::{Read, Write};
            let url = bridge.url().strip_prefix("http://").unwrap();
            let address = url.strip_suffix("/mcp").unwrap();
            let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
                "name":name,"arguments":arguments,"_meta":{"claudecode/toolUseId":"inert-only"}
            }})
            .to_string();
            let mut socket = std::net::TcpStream::connect(address).unwrap();
            socket
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            write!(socket, "POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: {}\r\nMcp-Protocol-Version: 2025-03-26\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                bridge.authorization(), body.len()).unwrap();
            let mut wire = String::new();
            socket.read_to_string(&mut wire).unwrap();
            assert!(wire.starts_with("HTTP/1.1 200"), "MCP request denied");
            let response: Value =
                serde_json::from_str(wire.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_ne!(response["result"]["isError"], true);
            serde_json::from_str::<Value>(
                response["result"]["content"][0]["text"].as_str().unwrap(),
            )
            .unwrap()
        };
        let catalog = call("skills_list", json!({}));
        let read = call(
            "skill_view",
            json!({"skillId":catalog["entries"][0]["skillId"]}),
        );
        assert_eq!(read["content"], content);
        assert_eq!(
            read["hash"],
            super::super::service::hash(content.as_bytes())
        );
        assert_eq!(read["fullRead"], true);
        assert!(!read["readReceiptId"].as_str().unwrap().is_empty());
        bridge.close();
        assert!(invocation.invoke("skills_list", json!({})).is_err());
    }

    #[test]
    fn revoked_native_invocation_refuses_reads_before_service_dispatch() {
        let f = Fixture::new("native-revoked-read");
        let source = source(&f);
        persisted(&f, &source);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let invocation = NativeSkillInvocation::bind(
            Arc::clone(&host),
            request(&source),
            "revoked-child",
            source.cwd.as_deref(),
        )
        .unwrap();
        host.revoke(&invocation.origin).unwrap();
        assert!(
            invocation.invoke("skills_list", json!({})).is_err(),
            "closing the transport must revoke dispatcher reads, not merely its socket"
        );
        assert!(!f.project().join(".ultragamestudio/skills/.state").exists());
    }

    #[test]
    fn native_binding_refuses_missing_or_reassigned_persisted_source_message() {
        let f = Fixture::new("native-skill-source");
        let source = source(&f);
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        persisted(&f, &source);
        f.write(
            "global/workspaces/workspace-a/sessions/session-a.json",
            &json!({
                "sessionId":"session-a","workspaceId":"workspace-a","messages":[]
            })
            .to_string(),
        );
        assert!(
            NativeSkillInvocation::bind(
                Arc::clone(&host),
                request(&source),
                "child-missing-source",
                source.cwd.as_deref()
            )
            .is_err(),
            "an existing session without the source message is not authority"
        );
        persisted(&f, &source);
        let mut wrong = request(&source);
        wrong.source.run_id = "invented-main".into();
        assert!(NativeSkillInvocation::bind(
            Arc::clone(&host),
            wrong,
            "child-wrong-source",
            source.cwd.as_deref()
        )
        .is_err());
        assert!(
            NativeSkillInvocation::bind(
                Arc::clone(&host),
                request(&source),
                &source.run_id,
                source.cwd.as_deref()
            )
            .is_err(),
            "source and execution grants must be independent"
        );
    }

    #[test]
    fn cwd_check_accepts_spelling_variants_but_rejects_other_directories() {
        let f = Fixture::new("native-cwd-variants");
        let project = f.project().to_string_lossy().into_owned();
        let trailing = format!("{project}{}", std::path::MAIN_SEPARATOR);
        assert!(same_cwd(Some(&project), Some(&trailing)));
        assert!(same_cwd(Some(&project), Some(&project.replace('\\', "/"))));
        assert!(same_cwd(None, None));
        assert!(!same_cwd(Some(&project), None));
        let other = f.global().to_string_lossy().into_owned();
        assert!(!same_cwd(Some(&project), Some(&other)));
        assert!(!same_cwd(Some(&project), Some("Z:/definitely/missing/ugs")));
    }

    #[test]
    fn controlled_native_invocation_lists_actual_catalog_and_reads_complete_receipt() {
        let f = Fixture::new("native-skill-read");
        let source = source(&f);
        persisted(&f, &source);
        let content = skill(
            "native-read",
            "Read complete saved bytes before changing a rule.",
        );
        f.write(
            "project/.ultragamestudio/skills/native-read/SKILL.md",
            &content,
        );
        let host = Arc::new(SkillDesktopHost::new(f.global()));
        let invocation = NativeSkillInvocation::bind(
            Arc::clone(&host),
            request(&source),
            "child: original/a",
            source.cwd.as_deref(),
        )
        .expect("foreground bridge must be available");
        let catalog = invocation.invoke("skills_list", json!({})).unwrap();
        assert_eq!(catalog["entries"].as_array().unwrap().len(), 1);
        let id = catalog["entries"][0]["skillId"].as_str().unwrap();
        let read = invocation
            .invoke("skill_view", json!({"skillId":id}))
            .unwrap();
        assert_eq!(read["content"], content);
        assert_eq!(
            read["hash"],
            super::super::service::hash(content.as_bytes())
        );
        assert_eq!(read["fullRead"], true);
        assert!(!read["readReceiptId"].as_str().unwrap().is_empty());
    }
}
