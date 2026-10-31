use super::*;
use std::path::{Path, PathBuf};

/// App-owned IPC binding, separate from the model-facing skills_request.
/// A User binding belongs to the explicit control path, never the reviewer.
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillHostActor {
    Background,
    User,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillHostBindingRequest {
    pub origin: SkillOrigin,
    pub mode: LearningMode,
    pub actor: SkillHostActor,
    #[serde(default)]
    pub evidence: Vec<SkillEvidence>,
}

pub struct SkillDesktopHost {
    pub background: SkillService,
    pub controls: SkillService,
}
impl SkillDesktopHost {
    pub fn validate_app_caller(label: &str, origin: &str, development: bool) -> Result<(), String> {
        if label == "main"
            && ([
                "tauri://localhost",
                "http://tauri.localhost",
                "https://tauri.localhost",
            ]
            .contains(&origin)
                || (development && origin == "http://localhost:5173"))
        {
            Ok(())
        } else {
            Err("skills host binding requires the trusted local app webview".into())
        }
    }
    pub fn new(global_root: PathBuf) -> Self {
        Self {
            background: SkillService::new(global_root.clone()),
            controls: SkillService::new(global_root),
        }
    }
    pub fn bind(&self, request: SkillHostBindingRequest) -> Result<(), String> {
        persisted_origin(&self.background.global_root, &request.origin)?;
        if matches!(request.actor, SkillHostActor::Background) {
            persisted_review_source(&self.background.global_root, &request.origin)?;
        }
        let (service, actor) = match request.actor {
            SkillHostActor::Background => (&self.background, SkillActor::Background),
            SkillHostActor::User => (&self.controls, SkillActor::User),
        };
        service.bind_run_with_evidence(request.origin, request.mode, actor, &request.evidence)
    }
    pub fn request(&self, request: SkillServiceRequest) -> Result<serde_json::Value, String> {
        // A valid run cannot keep using a removed/reassigned history identity.
        // Once its transaction starts, commit/recovery owns the outcome.
        persisted_origin(&self.background.global_root, &request.origin)?;
        let service = if [
            "approve",
            "reject",
            "rollback",
            "set_policy",
            "archive",
            "restore",
            "import",
        ]
        .contains(&request.action.as_str())
        {
            &self.controls
        } else if ["list", "view", "history", "usage"].contains(&request.action.as_str())
            && self
                .background
                .authority(&request.origin)
                .map_or(true, |grant| {
                    request.mode.map_or(false, |mode| mode != grant.mode)
                        && self
                            .controls
                            .authority(&request.origin)
                            .map_or(false, |control| request.mode == Some(control.mode))
                })
        {
            &self.controls
        } else {
            &self.background
        };
        service.handle(request)
    }
    pub fn request_with_update(
        &self,
        request: SkillServiceRequest,
        mut notify: impl FnMut(&SkillOrigin, &SkillCatalog),
    ) -> Result<serde_json::Value, String> {
        let action = request.action.clone();
        let origin = request.origin.clone();
        let result = self.request(request)?;
        let changed = result.get("status").and_then(|v| v.as_str()) == Some("applied")
            || ["set_policy", "archive", "restore", "import"].contains(&action.as_str());
        if changed {
            let catalog = self
                .background
                .list(&origin)
                .or_else(|_| self.controls.list(&origin));
            // Publication truth must survive a notification/readback failure.
            if let Ok(catalog) = catalog {
                notify(&origin, &catalog);
            }
        }
        Ok(result)
    }

    pub fn revoke(&self, origin: &SkillOrigin) -> Result<(), String> {
        self.background.revoke_run(origin)
    }

    /// Candidate persistence grants no skill mutation authority. Re-read the
    /// trusted workspace and unique user message before every candidate CAS.
    pub fn candidate_request(
        &self,
        request: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let body = request
            .as_object()
            .ok_or("SKILL_CANDIDATE_INVALID_REQUEST")?;
        if body
            .keys()
            .any(|key| !["action", "origin", "expectedRevision", "list"].contains(&key.as_str()))
        {
            return Err("SKILL_CANDIDATE_INVALID_REQUEST".into());
        }
        let origin: SkillOrigin = serde_json::from_value(
            body.get("origin")
                .cloned()
                .ok_or("SKILL_CANDIDATE_ORIGIN_REQUIRED")?,
        )
        .map_err(|_| "SKILL_CANDIDATE_INVALID_ORIGIN")?;
        persisted_review_source(&self.background.global_root, &origin)?;
        // Project scopes share the exact Node host path and lock protocol.
        // The unbound workspace uses only the app-owned history directory.
        let workspace = origin.cwd.as_ref().map(PathBuf::from).unwrap_or_else(|| {
            self.background
                .global_root
                .join("workspaces")
                .join(&origin.workspace_id)
        });
        crate::skill_candidates::candidate_request(&workspace, &request)
    }
}

fn history_json(path: &Path) -> Result<serde_json::Value, String> {
    super::validation::safe_chain(path)?;
    let bytes =
        std::fs::read(path).map_err(|_| "origin has no persisted workspace/session".to_string())?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("history identity record exceeds limit".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "invalid persisted workspace/session identity".into())
}
/// Native foreground grants require the exact persisted source message, not
/// merely a session-shaped optimistic id. The loopback client never calls this.
pub(super) fn persisted_native_source(global: &Path, source: &SkillOrigin) -> Result<(), String> {
    persisted_origin(global, source)?;
    if [&source.turn_id, &source.run_id]
        .iter()
        .any(|id| id.is_empty() || id.len() > 256 || id.contains('\0'))
    {
        return Err("invalid native source identity".into());
    }
    let session = history_json(
        &global
            .join("workspaces")
            .join(&source.workspace_id)
            .join("sessions")
            .join(format!("{}.json", source.session_id)),
    )?;
    let message = session
        .get("messages")
        .and_then(|v| v.as_array())
        .and_then(|messages| {
            messages.iter().find(|message| {
                message.get("id").and_then(|v| v.as_str()) == Some(source.turn_id.as_str())
                    && message.get("role").and_then(|v| v.as_str()) == Some("user")
            })
        })
        .ok_or("native source message is not persisted")?;
    if let Some(saved) = message.pointer("/skillContext/origin") {
        let saved: SkillOrigin = serde_json::from_value(saved.clone())
            .map_err(|_| "invalid persisted native source metadata")?;
        if &saved != source {
            return Err("native source metadata mismatch".into());
        }
    } else if source.run_id != source.turn_id {
        return Err("native source run must be the persisted main message".into());
    }
    Ok(())
}

/// A review may have its own run ID but never its own invented source turn.
fn persisted_review_source(global: &Path, source: &SkillOrigin) -> Result<String, String> {
    persisted_origin(global, source)?;
    if [&source.turn_id, &source.run_id]
        .iter()
        .any(|id| id.is_empty() || id.len() > 256 || id.contains('\0'))
    {
        return Err("invalid review source identity".into());
    }
    let session = history_json(
        &global
            .join("workspaces")
            .join(&source.workspace_id)
            .join("sessions")
            .join(format!("{}.json", source.session_id)),
    )?;
    let matches = session
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|messages| {
            messages
                .iter()
                .filter(|message| {
                    message.get("id").and_then(|v| v.as_str()) == Some(source.turn_id.as_str())
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if matches.len() != 1 || matches[0].get("role").and_then(|v| v.as_str()) != Some("user") {
        return Err("review source message is not persisted".into());
    }
    matches[0]
        .get("text")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "review source content is not persisted".into())
}

fn persisted_origin(global: &Path, origin: &SkillOrigin) -> Result<(), String> {
    if origin.host_id != "local" {
        return Err("local hostId required".into());
    }
    for (id, maximum) in [(&origin.workspace_id, 80), (&origin.session_id, 120)] {
        super::validation::component(id)?;
        if id.len() > maximum
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err("invalid persisted workspace/session id".into());
        }
    }
    let workspace = global.join("workspaces").join(&origin.workspace_id);
    let meta_path = if workspace.join("meta.json").is_file() {
        workspace.join("meta.json")
    } else {
        workspace.join("workspace.json")
    };
    if origin.workspace_id == "__default__" && origin.cwd.is_none() {
        // The unbound workspace deliberately has no filesystem project root.
    } else {
        let meta = history_json(&meta_path)?;
        if meta
            .get("workspaceId")
            .or_else(|| meta.get("id"))
            .and_then(|v| v.as_str())
            != Some(origin.workspace_id.as_str())
        {
            return Err("persisted workspace id mismatch".into());
        }
        if meta
            .get("status")
            .and_then(|v| v.as_str())
            .map_or(false, |v| v != "active")
        {
            return Err("workspace is deleted or unavailable".into());
        }
        let actual = meta
            .get("canonicalPath")
            .filter(|v| v.as_str().map_or(false, |s| !s.is_empty()))
            .or_else(|| meta.get("path"))
            .and_then(|v| v.as_str())
            .ok_or("persisted workspace has no cwd")?;
        let supplied = origin
            .cwd
            .as_deref()
            .ok_or("project origin requires frozen cwd")?;
        for path in [Path::new(actual), Path::new(supplied)] {
            super::validation::safe_chain(path)?;
        }
        if std::fs::canonicalize(actual).map_err(|_| "persisted workspace cwd unavailable")?
            != std::fs::canonicalize(supplied).map_err(|_| "supplied cwd unavailable")?
        {
            return Err("origin cwd does not belong to persisted workspace".into());
        }
    }
    let session = history_json(
        &workspace
            .join("sessions")
            .join(format!("{}.json", origin.session_id)),
    )?;
    if session
        .get("sessionId")
        .or_else(|| session.get("id"))
        .and_then(|v| v.as_str())
        != Some(origin.session_id.as_str())
        || session.get("workspaceId").and_then(|v| v.as_str()) != Some(origin.workspace_id.as_str())
        || session.get("deletedAt").map_or(false, |v| !v.is_null())
    {
        return Err("persisted session does not belong to workspace".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::test_support::{skill, Fixture};
    fn origin(f: &Fixture) -> SkillOrigin {
        SkillOrigin {
            host_id: "local".into(),
            workspace_id: "workspace-a".into(),
            session_id: "session-a".into(),
            turn_id: "turn-a".into(),
            run_id: "run-a".into(),
            cwd: Some(f.project().to_string_lossy().into_owned()),
        }
    }
    fn histories(f: &Fixture, o: &SkillOrigin) {
        f.write(
            "global/workspaces/workspace-a/meta.json",
            &serde_json::json!({"id":"workspace-a","path":o.cwd,"name":"Fixture workspace"})
                .to_string(),
        );
        f.write(
            "global/workspaces/workspace-a/sessions/session-a.json",
            &serde_json::json!({"id":"session-a","workspaceId":"workspace-a","messages":[
                {"id":o.turn_id,"role":"user","text":"Perform the captured task."}
            ]})
            .to_string(),
        );
    }
    #[test]
    fn background_binding_rejects_empty_source_session_before_authority() {
        let f = Fixture::new("host-source-missing");
        let o = origin(&f);
        histories(&f, &o);
        f.write(
            "global/workspaces/workspace-a/sessions/session-a.json",
            &serde_json::json!({
                "id":"session-a","workspaceId":"workspace-a","messages":[]
            })
            .to_string(),
        );
        let host = SkillDesktopHost::new(f.global());
        assert!(host
            .bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::AutoSafe,
                actor: SkillHostActor::Background,
                evidence: vec![]
            })
            .is_err());
        assert!(host.background.authority(&o).is_err());
    }

    #[test]
    fn native_revoke_before_binding_confirms_tombstone_and_denies_late_binding() {
        let f = Fixture::new("host-prebind-revoke");
        let o = origin(&f);
        let host = SkillDesktopHost::new(f.global());
        // Cancellation must not depend on persistence/binding finishing first.
        host.revoke(&o).expect("unbound revoke must install a native tombstone");
        host.revoke(&o).unwrap();
        assert!(host.background.authority(&o).is_err());
        histories(&f, &o);
        for mode in [LearningMode::AutoSafe, LearningMode::ApproveAll, LearningMode::Off] {
            let error = host.bind(SkillHostBindingRequest {
                origin: o.clone(), mode, actor: SkillHostActor::Background, evidence: vec![],
            }).unwrap_err();
            assert!(error.contains("revoked"), "late native bind must fail closed: {error}");
        }
        // Denial is exact-origin and cannot revoke or resurrect user controls.
        let mut wrong = o.clone(); wrong.session_id = "foreign-session".into();
        assert!(host.revoke(&wrong).is_err());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(), mode: LearningMode::Off, actor: SkillHostActor::User, evidence: vec![],
        }).unwrap();
        assert!(!host.controls.authority(&o).unwrap().revoked);
        let history = host.request(serde_json::from_value(serde_json::json!({
            "action":"history", "origin":o, "mode":"off"
        })).unwrap()).unwrap();
        assert_eq!(history["results"], serde_json::json!([]));
        assert!(!f.project().join(".ultragamestudio/skills").exists());
    }

    #[test]
    fn candidate_store_rechecks_saved_source_before_storage_and_never_accepts_a_client_namespace() {
        let f = Fixture::new("host-candidate-source");
        let o = origin(&f);
        let host = SkillDesktopHost::new(f.global());
        let load = serde_json::json!({"action":"load", "origin":o});
        assert!(host.candidate_request(load.clone()).is_err());
        assert!(!f.global().join(".ugs-skill-candidates").exists());
        histories(&f, &o);
        assert_eq!(host.candidate_request(load.clone()).unwrap()["revision"], 0);
        let mut forged = load;
        forged["namespace"] = serde_json::json!("another-account");
        assert!(host.candidate_request(forged).is_err());
    }

    #[test]
    fn candidate_store_is_durable_across_host_recreation_and_rejects_stale_cas() {
        let f = Fixture::new("host-candidate-cas");
        let o = origin(&f);
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        let write = serde_json::json!({"action":"compare_and_swap", "origin":o,
            "expectedRevision":0,"list":{"version":1,"revision":0,"candidates":[],"seenSources":["task-a"]}});
        assert_eq!(
            host.candidate_request(write.clone()).unwrap()["revision"],
            1
        );
        let restarted = SkillDesktopHost::new(f.global());
        let saved = restarted
            .candidate_request(serde_json::json!({"action":"load", "origin":o}))
            .unwrap();
        assert_eq!(saved["seenSources"], serde_json::json!(["task-a"]));
        assert_eq!(saved["revision"], 1);
        assert!(restarted.candidate_request(write).is_err());
        f.write(
            "global/workspaces/workspace-a/sessions/session-a.json",
            "{}",
        );
        assert!(restarted
            .candidate_request(serde_json::json!({"action":"load", "origin":o}))
            .is_err());
    }

    #[test]
    fn privileged_binding_is_only_available_to_the_local_app_origin() {
        for app in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            SkillDesktopHost::validate_app_caller("main", app, false).unwrap();
        }
        SkillDesktopHost::validate_app_caller("main", "http://localhost:5173", true).unwrap();
        for (label, url, development) in [
            ("preview", "tauri://localhost", false),
            ("main", "https://example.invalid", true),
            ("main", "http://localhost:5174", true),
            ("main", "http://localhost:5173", false),
            ("main", "file://", false),
        ] {
            assert!(SkillDesktopHost::validate_app_caller(label, url, development).is_err());
        }
    }
    #[test]
    fn desktop_binding_requires_persisted_workspace_session_and_exact_cwd() {
        let f = Fixture::new("host-binding");
        let o = origin(&f);
        let host = SkillDesktopHost::new(f.global());
        let binding = SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::AutoSafe,
            actor: SkillHostActor::Background,
            evidence: vec![],
        };
        assert!(host.bind(binding.clone()).is_err());
        histories(&f, &o);
        host.bind(binding.clone()).unwrap();
        let request = serde_json::from_value(
            serde_json::json!({"action":"list","origin":o,"mode":"auto-safe"}),
        )
        .unwrap();
        assert_eq!(
            host.request(request).unwrap()["entries"],
            serde_json::json!([])
        );
        let mut wrong = binding.clone();
        wrong.origin.cwd = Some(f.global().to_string_lossy().into_owned());
        wrong.origin.run_id = "wrong-cwd".into();
        assert!(host.bind(wrong).is_err());
        let mut wrong = binding.clone();
        wrong.origin.workspace_id = "../workspace-a".into();
        wrong.origin.run_id = "wrong-workspace".into();
        assert!(host.bind(wrong).is_err());
        let mut wrong = binding.clone();
        wrong.origin.session_id = "missing-session".into();
        wrong.origin.run_id = "wrong-session".into();
        assert!(host.bind(wrong).is_err());
        let mut wrong = binding;
        wrong.origin.host_id = "remote".into();
        wrong.origin.run_id = "wrong-host".into();
        assert!(host.bind(wrong).is_err());
    }
    #[test]
    fn failed_host_evidence_binding_never_leaves_a_new_run_authority() {
        let f = Fixture::new("host-bind-evidence-atomic");
        let o = origin(&f);
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        let foreign = SkillEvidence {
            evidence_id: "foreign-correction".into(),
            origin: SkillOrigin {
                session_id: "another-session".into(),
                run_id: "another-run".into(),
                ..o.clone()
            },
            occurred_at: 1,
            kind: "correction".into(),
            provenance: "user-input".into(),
            status: "success".into(),
            summary: "Never borrow another run's trusted evidence.".into(),
            tool_call_id: None,
            tool_name: None,
            parent_id: None,
            exit_code: None,
            result: None,
            path: None,
            skill_id: None,
            revision: None,
        };
        assert!(host
            .bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::AutoSafe,
                actor: SkillHostActor::Background,
                evidence: vec![foreign],
            })
            .is_err());
        assert!(
            host.background.authority(&o).is_err(),
            "failed binding must not create authority"
        );
        assert!(host.controls.authority(&o).is_err());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::Off,
            actor: SkillHostActor::Background,
            evidence: vec![],
        })
        .unwrap();
        assert_eq!(
            host.background.authority(&o).unwrap().mode,
            LearningMode::Off
        );
    }

    #[test]
    fn review_binding_keeps_original_child_run_evidence_while_writes_use_review_origin() {
        let f = Fixture::new("host-review-child-evidence");
        let mut review = origin(&f);
        review.run_id = "review-auxiliary".into();
        review.turn_id = "review-turn".into();
        histories(&f, &review);
        let host = SkillDesktopHost::new(f.global());
        let evidence = ["native-child-a", "native-child-b"]
            .into_iter()
            .enumerate()
            .map(|(index, run)| SkillEvidence {
                evidence_id: serde_json::json!([run, "native-check"]).to_string(),
                origin: SkillOrigin {
                    turn_id: format!("source-turn-{index}"),
                    run_id: run.into(),
                    ..review.clone()
                },
                occurred_at: 1 + index as u64,
                kind: "verification".into(),
                provenance: "native-tool".into(),
                status: "success".into(),
                summary: "cargo test skills passed in the original native child.".into(),
                tool_call_id: Some("native-check".into()),
                tool_name: Some("terminal".into()),
                parent_id: Some("foreground-owner".into()),
                exit_code: Some(0),
                result: Some("Actual host fixture verification.".into()),
                path: None,
                skill_id: None,
                revision: None,
            })
            .collect::<Vec<_>>();
        host.bind(SkillHostBindingRequest {
            origin: review.clone(),
            mode: LearningMode::AutoSafe,
            actor: SkillHostActor::Background,
            evidence: evidence.clone(),
        })
        .expect("trusted review ingress accepts original child run identities in this session");
        let registered = host.background.authority(&review).unwrap().evidence;
        for item in &evidence {
            assert_eq!(
                serde_json::to_value(&registered[&item.evidence_id]).unwrap(),
                serde_json::to_value(item).unwrap()
            );
            assert!(
                host.background.authority(&item.origin).is_err(),
                "source evidence does not mint source-run authority"
            );
        }
        let content = skill(
            "source-preserving",
            "Retain actual native execution identities when reviewing evidence.",
        );
        let request = serde_json::from_value(serde_json::json!({
            "action":"manage", "origin":review, "mode":"auto-safe", "evidence":evidence,
            "proposal":{"version":1, "kind":"propose", "lesson":"Retain source provenance without rewriting native IDs.",
                "evidenceIds":evidence.iter().map(|item| &item.evidence_id).collect::<Vec<_>>(),
                "operations":[{"action":"create", "name":"source-preserving", "content":content}]}
        })).unwrap();
        let applied = host.request(request).unwrap();
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["origin"], serde_json::to_value(&review).unwrap());
        assert_eq!(
            std::fs::read_to_string(
                f.project()
                    .join(".ultragamestudio/skills/source-preserving/SKILL.md")
            )
            .unwrap(),
            content
        );
        let root = host
            .background
            .create_root(&review, &host.background.authority(&review).unwrap())
            .unwrap();
        let dir =
            super::super::transactions::directory(&root, applied["batchId"].as_str().unwrap())
                .unwrap();
        let intent: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("intent.json")).unwrap()).unwrap();
        assert_eq!(
            intent["evidence"],
            serde_json::to_value(&evidence).unwrap(),
            "durable batch preserves each original source origin"
        );
        let id = applied["changes"][0]["skillId"].as_str().unwrap();
        let read = host.background.view(&review, id, None).unwrap();
        host.background
            .validate_receipt(&review, id, "SKILL.md", &read.hash, &read.read_receipt_id)
            .unwrap();
        assert!(host
            .background
            .validate_receipt(
                &evidence[0].origin,
                id,
                "SKILL.md",
                &read.hash,
                &read.read_receipt_id
            )
            .is_err());
    }

    #[test]
    fn review_evidence_registration_rejects_cross_session_and_cwd_without_partial_ingress() {
        let f = Fixture::new("host-review-evidence-scope");
        let mut o = origin(&f);
        o.run_id = "review-scope".into();
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::AutoSafe,
            actor: SkillHostActor::Background,
            evidence: vec![],
        })
        .unwrap();
        let good = SkillEvidence {
            evidence_id: "child-valid".into(),
            origin: SkillOrigin {
                turn_id: "source-turn".into(),
                run_id: "native-child".into(),
                ..o.clone()
            },
            occurred_at: 1,
            kind: "verification".into(),
            provenance: "native-tool".into(),
            status: "success".into(),
            summary: "Actual child-native evidence fixture.".into(),
            tool_call_id: Some("native-check".into()),
            tool_name: Some("terminal".into()),
            parent_id: None,
            exit_code: Some(0),
            result: None,
            path: None,
            skill_id: None,
            revision: None,
        };
        let mut invalid_origins = vec![];
        let mut invalid = good.origin.clone();
        invalid.host_id = "remote".into();
        invalid_origins.push(invalid);
        let mut invalid = good.origin.clone();
        invalid.workspace_id = "workspace-foreign".into();
        invalid_origins.push(invalid);
        let mut invalid = good.origin.clone();
        invalid.session_id = "session-foreign".into();
        invalid_origins.push(invalid);
        let mut invalid = good.origin.clone();
        invalid.cwd = Some(f.global().to_string_lossy().into_owned());
        invalid_origins.push(invalid);
        let mut invalid = good.origin.clone();
        invalid.cwd = None;
        invalid_origins.push(invalid);
        let mut invalid = good.origin.clone();
        invalid.turn_id.clear();
        invalid_origins.push(invalid);
        let mut invalid = good.origin.clone();
        invalid.run_id = "bad\0run".into();
        invalid_origins.push(invalid);
        for invalid_origin in invalid_origins {
            let invalid = SkillEvidence {
                evidence_id: "child-invalid".into(),
                origin: invalid_origin,
                ..good.clone()
            };
            assert!(host
                .bind(SkillHostBindingRequest {
                    origin: o.clone(),
                    mode: LearningMode::AutoSafe,
                    actor: SkillHostActor::Background,
                    evidence: vec![good.clone(), invalid],
                })
                .is_err());
            assert!(
                host.background.authority(&o).unwrap().evidence.is_empty(),
                "failed scope validation cannot install the valid prefix"
            );
        }
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::AutoSafe,
            actor: SkillHostActor::Background,
            evidence: vec![good.clone()],
        })
        .unwrap();
        assert_eq!(host.background.authority(&o).unwrap().evidence.len(), 1);
        assert_eq!(
            host.background.authority(&o).unwrap().evidence[&good.evidence_id].origin,
            good.origin
        );
    }

    #[test]
    fn deleting_persisted_session_blocks_existing_binding_before_any_new_transaction() {
        let f = Fixture::new("host-session-deleted");
        let o = origin(&f);
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::ApproveAll,
            actor: SkillHostActor::Background,
            evidence: vec![],
        })
        .unwrap();
        std::fs::remove_file(
            f.global()
                .join("workspaces/workspace-a/sessions/session-a.json"),
        )
        .unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "action":"manage", "origin":o, "mode":"approve-all",
            "proposal": {
                "version":1, "kind":"propose", "lesson":"Preserve original session authority.",
                "evidenceIds":[], "operations":[{"action":"create", "name":"deleted-origin",
                    "content":skill("deleted-origin", "Deleted sessions cannot publish new lessons.")}]
            }
        })).unwrap();
        assert!(
            host.request(request).is_err(),
            "a once-valid binding cannot outlive its persisted session"
        );
        assert!(!f.project().join(".ultragamestudio/skills").exists());
    }

    #[test]
    fn successful_write_emits_same_identity_with_new_description_and_revision() {
        let f = Fixture::new("host-update");
        let o = origin(&f);
        histories(&f, &o);
        let original = "---\nname: manual\ndescription: Read the complete original file.\n---\n\nKeep all rules intact.\n";
        f.write("project/.ultragamestudio/skills/manual/SKILL.md", original);
        let host = SkillDesktopHost::new(f.global());
        for actor in [SkillHostActor::Background, SkillHostActor::User] {
            host.bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::ApproveAll,
                actor,
                evidence: vec![],
            })
            .unwrap();
        }
        let read = host
            .background
            .view(
                &o,
                &host.background.list(&o).unwrap().entries[0].skill_id,
                None,
            )
            .unwrap();
        let p = SkillProposal {
            version: 1,
            kind: "propose".into(),
            lesson: "Make the trigger easier to recognize.".into(),
            evidence_ids: vec![],
            operations: vec![SkillOperation::Patch {
                skill_id: read.entry.skill_id.clone(),
                file_path: None,
                old_string: "Read the complete original file.".into(),
                new_string: "Use when editing files. Read the complete original file.".into(),
                expected_hash: read.hash,
                read_receipt_id: read.read_receipt_id,
            }],
        };
        let pending = host.background.manage(&o, &p).unwrap();
        let request=serde_json::from_value(serde_json::json!({"action":"approve","origin":o,"mode":"approve-all","batchId":pending.batch_id})).unwrap();
        let mut observed = vec![];
        let applied = host
            .request_with_update(request, |origin, catalog| {
                observed.push((origin.clone(), catalog.clone()))
            })
            .unwrap();
        assert_eq!(applied["status"], "applied");
        assert_eq!(
            observed.len(),
            1,
            "only verified applied writes notify observers"
        );
        assert_eq!(observed[0].0, o);
        let entry = &observed[0].1.entries[0];
        assert_eq!(entry.skill_id, read.entry.skill_id);
        assert_ne!(entry.revision, read.entry.revision);
        assert_eq!(
            entry.description,
            "Use when editing files. Read the complete original file."
        );
    }
    #[test]
    fn explicit_user_controls_can_read_catalog_and_history_without_background_authority() {
        let f = Fixture::new("host-user-read");
        let o = origin(&f);
        histories(&f, &o);
        f.write(
            "project/.ultragamestudio/skills/manual/SKILL.md",
            &skill("manual", "Read explicit user configuration safely."),
        );
        let host = SkillDesktopHost::new(f.global());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::Off,
            actor: SkillHostActor::User,
            evidence: vec![],
        })
        .unwrap();
        let request = |action: &str| {
            serde_json::from_value(serde_json::json!({"action":action,"origin":o,"mode":"off"}))
                .unwrap()
        };
        let catalog = host.request(request("list")).unwrap();
        assert_eq!(catalog["entries"].as_array().unwrap().len(), 1);
        assert_eq!(
            host.request(request("history")).unwrap()["results"],
            serde_json::json!([])
        );
        assert!(host.background.authority(&o).is_err());
        assert!(host.request(request("manage")).is_err());
    }
    #[test]
    fn user_reads_use_the_matching_control_policy_when_background_binding_exists() {
        let f = Fixture::new("host-controls-read-mode");
        let o = origin(&f);
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::AutoSafe,
            actor: SkillHostActor::Background,
            evidence: vec![],
        })
        .unwrap();
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::Off,
            actor: SkillHostActor::User,
            evidence: vec![],
        })
        .unwrap();
        let request = serde_json::from_value(serde_json::json!({
            "action":"history", "origin":o, "mode":"off"
        }))
        .unwrap();
        let history = host
            .request(request)
            .expect("off-mode user history must not reuse background policy");
        assert_eq!(history["results"], serde_json::json!([]));
        assert_eq!(
            host.background.authority(&o).unwrap().mode,
            LearningMode::AutoSafe
        );
    }

    #[test]
    fn history_reload_controls_use_exact_saved_batch_origin_after_background_revocation() {
        let f = Fixture::new("host-reload-controls");
        let o = origin(&f);
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::ApproveAll,
            actor: SkillHostActor::Background,
            evidence: vec![],
        })
        .unwrap();
        let proposal = SkillProposal {
            version: 1,
            kind: "propose".into(),
            lesson: "Retain exact saved batch provenance across reloads.".into(),
            evidence_ids: vec![],
            operations: vec![SkillOperation::Create {
                name: "reload-source".into(),
                content: skill(
                    "reload-source",
                    "Controls must operate on the frozen source batch.",
                ),
            }],
        };
        let pending = host.background.manage(&o, &proposal).unwrap();
        assert_eq!(pending.status, "awaiting_approval");
        host.revoke(&o).unwrap();
        drop(host);
        let restarted = SkillDesktopHost::new(f.global());
        let mut control = o.clone();
        control.run_id = "new-control-run".into();
        restarted
            .bind(SkillHostBindingRequest {
                origin: control.clone(),
                mode: LearningMode::ApproveAll,
                actor: SkillHostActor::User,
                evidence: vec![],
            })
            .unwrap();
        let request = |action: &str, origin: &SkillOrigin, mode: &str, field: &str, id: &str| {
            serde_json::from_value(
                serde_json::json!({"action":action,"origin":origin,"mode":mode,field:id}),
            )
            .unwrap()
        };
        assert!(
            restarted
                .request(request(
                    "approve",
                    &control,
                    "approve-all",
                    "batchId",
                    &pending.batch_id
                ))
                .is_err(),
            "new control runId cannot impersonate saved batch origin"
        );
        restarted
            .bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::ApproveAll,
                actor: SkillHostActor::User,
                evidence: vec![],
            })
            .unwrap();
        let history = restarted
            .request(
                serde_json::from_value(
                    serde_json::json!({"action":"history","origin":o,"mode":"approve-all"}),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            history["results"][0]["origin"],
            serde_json::to_value(&o).unwrap()
        );
        let applied = restarted
            .request(request(
                "approve",
                &o,
                "approve-all",
                "batchId",
                &pending.batch_id,
            ))
            .unwrap();
        assert_eq!(applied["status"], "applied");
        assert!(
            restarted.background.authority(&o).is_err(),
            "user control never resurrects background authority"
        );
        let rollback_id = applied["rollbackId"].as_str().unwrap().to_owned();
        drop(restarted);
        let after_reload = SkillDesktopHost::new(f.global());
        after_reload
            .bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::Off,
                actor: SkillHostActor::User,
                evidence: vec![],
            })
            .unwrap();
        let rollback = after_reload
            .request(request("rollback", &o, "off", "rollbackId", &rollback_id))
            .unwrap();
        assert_eq!(
            rollback["status"], "applied",
            "learning-off still permits explicit exact-source rollback"
        );
        assert!(!f
            .project()
            .join(".ultragamestudio/skills/reload-source")
            .exists());
        let history = after_reload
            .request(
                serde_json::from_value(
                    serde_json::json!({"action":"history","origin":o,"mode":"off"}),
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(history["results"].as_array().unwrap().len(), 2);
        assert!(history["results"]
            .as_array()
            .unwrap()
            .iter()
            .all(|result| result["status"] == "applied"));
    }

    #[test]
    fn same_source_user_grant_survives_live_background_revocation_without_policy_escalation() {
        let f = Fixture::new("host-live-revoke-control");
        let o = origin(&f);
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        for actor in [SkillHostActor::Background, SkillHostActor::User] {
            host.bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::ApproveAll,
                actor,
                evidence: vec![],
            })
            .unwrap();
        }
        let proposal = SkillProposal {
            version: 1,
            kind: "propose".into(),
            lesson: "User approval remains explicit after background cancellation.".into(),
            evidence_ids: vec![],
            operations: vec![SkillOperation::Create {
                name: "live-user-control".into(),
                content: skill(
                    "live-user-control",
                    "Keep background and user authority separate.",
                ),
            }],
        };
        let pending = host.background.manage(&o, &proposal).unwrap();
        assert_eq!(pending.status, "awaiting_approval");
        host.revoke(&o).unwrap();
        assert!(host.background.authority(&o).unwrap().revoked);
        let control = host.controls.authority(&o).unwrap();
        assert_eq!(control.actor, SkillActor::User);
        assert_eq!(control.mode, LearningMode::ApproveAll);
        assert!(!control.revoked);
        assert!(
            host.bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::ApproveAll,
                actor: SkillHostActor::Background,
                evidence: vec![],
            })
            .is_err(),
            "rebind cannot resurrect revoked background authority"
        );
        assert!(
            host.bind(SkillHostBindingRequest {
                origin: o.clone(),
                mode: LearningMode::AutoSafe,
                actor: SkillHostActor::User,
                evidence: vec![],
            })
            .is_err(),
            "user mode is immutable for this same actor/run binding"
        );
        let late = host
            .request(
                serde_json::from_value(serde_json::json!({
                    "action":"manage", "origin":o, "mode":"approve-all", "proposal":proposal,
                }))
                .unwrap(),
            )
            .unwrap();
        assert_eq!(late["status"], "cancelled");
        let applied = host.request(serde_json::from_value(serde_json::json!({
            "action":"approve", "origin":o, "mode":"approve-all", "batchId":pending.batch_id,
        })).unwrap()).unwrap();
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["origin"], serde_json::to_value(&o).unwrap());
        assert!(f
            .project()
            .join(".ultragamestudio/skills/live-user-control/SKILL.md")
            .is_file());
        assert!(host.background.authority(&o).unwrap().revoked);
        assert!(!host.controls.authority(&o).unwrap().revoked);
    }

    #[test]
    fn explicit_control_binding_never_upgrades_background_actor() {
        let f = Fixture::new("host-control");
        let o = origin(&f);
        histories(&f, &o);
        let host = SkillDesktopHost::new(f.global());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::ApproveAll,
            actor: SkillHostActor::Background,
            evidence: vec![],
        })
        .unwrap();
        let proposal = SkillProposal {
            version: 1,
            kind: "propose".into(),
            lesson: "Keep the complete batch scoped to its original project.".into(),
            evidence_ids: vec![],
            operations: vec![SkillOperation::Create {
                name: "verified-rule".into(),
                content: skill(
                    "verified-rule",
                    "Read all original requirements before changing files.",
                ),
            }],
        };
        let pending = host.background.manage(&o, &proposal).unwrap();
        assert_eq!(pending.status, "awaiting_approval");
        let approve = || {
            serde_json::from_value(serde_json::json!({"action":"approve","origin":o,"mode":"approve-all","batchId":pending.batch_id})).unwrap()
        };
        assert!(host.request(approve()).is_err());
        host.bind(SkillHostBindingRequest {
            origin: o.clone(),
            mode: LearningMode::ApproveAll,
            actor: SkillHostActor::User,
            evidence: vec![],
        })
        .unwrap();
        let applied = host.request(approve()).unwrap();
        assert_eq!(applied["status"], "applied");
        assert_eq!(
            host.background.authority(&o).unwrap().actor,
            SkillActor::Background
        );
        assert_eq!(host.controls.authority(&o).unwrap().actor, SkillActor::User);
        assert_eq!(
            host.background
                .view(&o, applied["changes"][0]["skillId"].as_str().unwrap(), None)
                .unwrap()
                .content,
            skill(
                "verified-rule",
                "Read all original requirements before changing files."
            )
        );
    }
}
