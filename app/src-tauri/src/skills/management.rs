use super::catalog::{identity, Root};
use super::service::{hash, RunGrant, SkillService, Snapshot};
use super::state::RootGuard;
use super::transactions::{self, Batch, PackageChange};
use super::types::*;

impl SkillService {
    /// Test helper; production evidence uses the atomic trusted host binding.
    #[cfg(test)]
    pub fn record_evidence(
        &self,
        origin: &SkillOrigin,
        evidence: &[SkillEvidence],
    ) -> Result<(), String> {
        self.authority(origin)?;
        let mut grants = self.grants.lock().map_err(|_| "grant lock poisoned")?;
        let grant = grants.get_mut(&origin.run_id).ok_or("unbound origin")?;
        register_evidence(grant, evidence)
    }

    pub(super) fn create_root(
        &self,
        origin: &SkillOrigin,
        authority: &RunGrant,
    ) -> Result<Root, String> {
        let (path, scope, source) = match authority.cwd.as_deref() {
            Some(cwd) => (
                cwd.join(".ultragamestudio/skills"),
                "project",
                "ugs-project",
            ),
            None => (self.global_root.join("skills"), "global", "ugs-global"),
        };
        super::catalog::owned_root(&origin.host_id, &path, scope, source)
    }

    fn batch_root(
        &self,
        origin: &SkillOrigin,
        grant: &RunGrant,
        batch_id: &str,
    ) -> Result<Root, String> {
        let mut selected = None;
        for root in
            super::catalog::roots_for(&origin.host_id, grant.cwd.as_deref(), &self.global_root)?
                .into_iter()
                .filter(|r| r.scope != "external")
        {
            let intent = transactions::directory(&root, batch_id)?.join("intent.json");
            super::validation::safe_chain(&intent)?;
            if intent.is_file() {
                if selected.is_some() {
                    return Err("ambiguous batch identity across roots".into());
                }
                selected = Some(root);
            }
        }
        selected.ok_or_else(|| "unknown batch in origin roots".into())
    }

    fn management_root(
        &self,
        origin: &SkillOrigin,
        grant: &RunGrant,
        proposal: &SkillProposal,
    ) -> Result<Root, String> {
        let mut selected = if proposal
            .operations
            .iter()
            .any(|op| matches!(op, SkillOperation::Create { .. }))
        {
            Some(self.create_root(origin, grant)?)
        } else {
            None
        };
        let found = self.discover_bound(origin, grant)?;
        for op in &proposal.operations {
            let id = match op {
                SkillOperation::Create { .. } => continue,
                SkillOperation::Patch { skill_id, .. }
                | SkillOperation::WriteFile { skill_id, .. }
                | SkillOperation::RemoveFile { skill_id, .. } => skill_id,
            };
            let target = found
                .iter()
                .find(|s| &s.skill_id == id)
                .ok_or("unknown skillId in origin")?;
            if target.root.scope == "external" {
                return Err("external skills are read-only; explicitly import first".into());
            }
            if selected
                .as_ref()
                .map_or(false, |r| r.root_id != target.root.root_id)
            {
                return Err("cross-root batch rejected".into());
            }
            selected = Some(target.root.clone());
        }
        selected
            .map(Ok)
            .unwrap_or_else(|| self.create_root(origin, grant))
    }

    pub fn rollback(
        &self,
        origin: &SkillOrigin,
        rollback_id: &str,
    ) -> Result<SkillMutationResult, String> {
        let grant = self.authority(origin)?;
        if grant.actor != SkillActor::User {
            return Err("rollback requires trusted user authority".into());
        }
        let root = self.batch_root(origin, &grant, rollback_id)?;
        let guard = RootGuard::open(&root)?;
        let dir = transactions::directory(&root, rollback_id)?;
        let marker = dir.join("applied.json");
        super::validation::safe_chain(&marker)?;
        let applied: SkillMutationResult =
            serde_json::from_slice(&std::fs::read(marker).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if &applied.origin != origin
            || applied.status != "applied"
            || applied.rollback_id.as_deref() != Some(rollback_id)
        {
            return Err("rollback origin/state mismatch".into());
        }
        let intent = dir.join("intent.json");
        super::validation::safe_chain(&intent)?;
        let original: Batch =
            serde_json::from_slice(&std::fs::read(intent).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        transactions::validate_batch(&original, &root)?;
        let mut result =
            transactions::result(origin, &format!("Rollback: {}", original.result.lesson))?;
        let mut packages = vec![];
        for p in original.packages {
            let current = super::service::read_package(&transactions::package_path(
                &root,
                &p.relative_path,
            )?)?;
            if current != p.after {
                result.status = "conflicted".into();
                result.error = Some("CAS conflict: rollback target changed after apply".into());
                guard.save_result(&result)?;
                guard.commit()?;
                return Ok(result);
            }
            let before_metadata = guard.metadata(&p.skill_id)?;
            let mut after_metadata = p.before_metadata.clone();
            after_metadata.usage = before_metadata.usage.clone();
            after_metadata.pinned = before_metadata.pinned;
            after_metadata.content_locked = before_metadata.content_locked;
            let paths = p
                .before
                .keys()
                .chain(p.after.keys())
                .collect::<std::collections::BTreeSet<_>>();
            for path in paths {
                let before = p.after.get(path);
                let after = p.before.get(path);
                if before == after {
                    continue;
                }
                result.changes.push(SkillDiff {
                    skill_id: p.skill_id.clone(),
                    name: p.name.clone(),
                    file_path: path.clone(),
                    before: before.map(|b| String::from_utf8_lossy(b).into_owned()),
                    after: after.map(|b| String::from_utf8_lossy(b).into_owned()),
                    before_hash: before.map(|b| hash(b)),
                    after_hash: after.map(|b| hash(b)),
                });
            }
            packages.push(PackageChange {
                relative_path: p.relative_path,
                skill_id: p.skill_id,
                name: p.name,
                before: p.after,
                after: p.before,
                before_metadata,
                after_metadata,
            });
        }
        transactions::execute(
            &guard,
            Batch {
                version: 1,
                root_id: root.root_id.clone(),
                result,
                packages,
                evidence: vec![],
                proposal: None,
            },
        )
    }

    pub fn approve(
        &self,
        origin: &SkillOrigin,
        batch_id: &str,
    ) -> Result<SkillMutationResult, String> {
        let grant = self.authority(origin)?;
        if grant.actor != SkillActor::User || grant.revoked || grant.mode == LearningMode::Off {
            return Err("approval requires an active trusted user authority".into());
        }
        let root = self.batch_root(origin, &grant, batch_id)?;
        let guard = RootGuard::open(&root)?;
        let mut batch = load_pending(&guard, origin, batch_id)?;
        // Older persisted proposals must not bypass the current create budget.
        if batch
            .packages
            .iter()
            .filter(|package| package.before.is_empty())
            .count()
            > 1
        {
            return Err("at most one new class-level skill create is allowed per batch".into());
        }
        for p in &mut batch.packages {
            let current = guard.metadata(&p.skill_id)?;
            if current.archived {
                return Err("approval target archived".into());
            }
            p.after_metadata.content_locked = current.content_locked;
            p.after_metadata.pinned = current.pinned;
            p.after_metadata.usage = current.usage;
            if !p.before.is_empty() {
                p.after_metadata.auto_editable = current.auto_editable;
            }
        }
        match transactions::execute(&guard, batch.clone()) {
            Ok(result) => Ok(result),
            Err(error) => {
                batch.result.status = if error.contains("CAS conflict") {
                    "conflicted"
                } else {
                    "failed"
                }
                .into();
                batch.result.error = Some(error);
                guard.save_result(&batch.result)?;
                guard.commit()?;
                Ok(batch.result)
            }
        }
    }
    pub fn reject(
        &self,
        origin: &SkillOrigin,
        batch_id: &str,
    ) -> Result<SkillMutationResult, String> {
        let grant = self.authority(origin)?;
        if grant.actor != SkillActor::User {
            return Err("rejection requires trusted user authority".into());
        }
        let root = self.batch_root(origin, &grant, batch_id)?;
        let guard = RootGuard::open(&root)?;
        let mut batch = load_pending(&guard, origin, batch_id)?;
        batch.result.status = "rejected".into();
        super::state::write_synced(
            &transactions::directory(&root, batch_id)?.join("rejected.json"),
            &serde_json::to_vec(&batch.result).map_err(|e| e.to_string())?,
        )?;
        guard.save_result(&batch.result)?;
        guard.commit()?;
        Ok(batch.result)
    }

    pub fn manage(
        &self,
        origin: &SkillOrigin,
        proposal: &SkillProposal,
    ) -> Result<SkillMutationResult, String> {
        let grant = self.authority(origin)?;
        let mut result = transactions::result(origin, &proposal.lesson)?;
        if grant.revoked || grant.mode == LearningMode::Off {
            result.status = "cancelled".into();
            result.error = Some("run authority revoked or learning off".into());
            return Ok(result);
        }
        // Reject direct-host over-budget batches before root discovery can
        // open a ledger or recovery transaction, including approve-all mode.
        if proposal
            .operations
            .iter()
            .filter(|operation| matches!(operation, SkillOperation::Create { .. }))
            .count()
            > 1
        {
            result.error =
                Some("at most one new class-level skill create is allowed per batch".into());
            return Ok(result);
        }
        let root = match self.management_root(origin, &grant, proposal) {
            Ok(root) => root,
            Err(error) => {
                result.error = Some(error);
                return Ok(result);
            }
        };
        let guard = RootGuard::open(&root)?;
        let evaluated: Result<Batch, String> = (|| {
            if proposal.version != 1
                || proposal.kind != "propose"
                || proposal.operations.is_empty()
                || proposal.operations.len() > 16
                || proposal.lesson.trim().is_empty()
                || proposal.lesson.len() > 8192
            {
                return Err("invalid proposal envelope/size".into());
            }
            let found =
                super::catalog::discover_root(&origin.host_id, &origin.workspace_id, &root)?;
            let mut packages = std::collections::BTreeMap::<String, PackageChange>::new();
            let mut touched = std::collections::BTreeSet::new();
            for operation in &proposal.operations {
                match operation {
                    SkillOperation::Create { name, content } => {
                        super::validation::new_document(content, name)?;
                        let target = transactions::package_path(&root, name)?;
                        if target.exists() {
                            return Err("CAS conflict: create requires absent package".into());
                        }
                        let namespace = if root.scope == "global" {
                            "global"
                        } else {
                            &origin.workspace_id
                        };
                        let id = identity(&[&origin.host_id, namespace, &root.root_id, name]);
                        if packages.contains_key(&id) {
                            return Err("duplicate create".into());
                        }
                        let before_metadata = guard.metadata(&id)?;
                        if before_metadata.archived {
                            return Err("archived package must be explicitly restored".into());
                        }
                        let mut after_metadata = before_metadata.clone();
                        after_metadata.auto_editable = grant.actor == SkillActor::Background;
                        packages.insert(
                            id.clone(),
                            PackageChange {
                                relative_path: name.clone(),
                                skill_id: id.clone(),
                                name: name.clone(),
                                before: Snapshot::new(),
                                after: Snapshot::from([(
                                    "SKILL.md".into(),
                                    content.as_bytes().to_vec(),
                                )]),
                                before_metadata,
                                after_metadata,
                            },
                        );
                        touched.insert((id, "SKILL.md".to_owned()));
                    }
                    SkillOperation::Patch {
                        skill_id,
                        file_path,
                        old_string,
                        new_string,
                        expected_hash,
                        read_receipt_id,
                    } => {
                        let path = file_path.as_deref().unwrap_or("SKILL.md");
                        let p = load_package(&guard, &root, &found, &mut packages, skill_id)?;
                        super::validation::checked_join(&root.path.join(&p.relative_path), path)?;
                        if !touched.insert((skill_id.clone(), path.to_owned())) {
                            return Err("duplicate file operation in batch".into());
                        }
                        guard.check_receipt(
                            origin,
                            skill_id,
                            path,
                            expected_hash,
                            read_receipt_id,
                            &p.before,
                        )?;
                        let text =
                            std::str::from_utf8(p.after.get(path).ok_or("missing patch target")?)
                                .map_err(|_| "patch requires UTF-8 text")?;
                        if old_string.is_empty() || text.matches(old_string).count() != 1 {
                            return Err("patch must match exactly once".into());
                        }
                        if old_string == new_string {
                            continue;
                        }
                        if !new_string.contains(old_string.as_str()) {
                            result.risk_reasons.push(
                                "patch removes/replaces an existing rule; explicit review required"
                                    .into(),
                            );
                        }
                        if path == "SKILL.md"
                            && (old_string.contains("description:") || old_string.contains("name:"))
                        {
                            result
                                .risk_reasons
                                .push("trigger scope/frontmatter change requires approval".into());
                        }
                        let next = text.replacen(old_string, new_string, 1);
                        p.after.insert(path.into(), next.into_bytes());
                    }
                    SkillOperation::WriteFile {
                        skill_id,
                        file_path,
                        content,
                        expected_hash,
                        read_receipt_id,
                        absent,
                    } => {
                        let p = load_package(&guard, &root, &found, &mut packages, skill_id)?;
                        super::validation::checked_join(
                            &root.path.join(&p.relative_path),
                            file_path,
                        )?;
                        if !touched.insert((skill_id.clone(), file_path.clone())) {
                            return Err("duplicate file operation in batch".into());
                        }
                        if p.before.contains_key(file_path) {
                            if *absent == Some(true) {
                                return Err(
                                    "CAS conflict: file appeared despite absent precondition"
                                        .into(),
                                );
                            }
                            guard.check_receipt(
                                origin,
                                skill_id,
                                file_path,
                                expected_hash.as_deref().ok_or("expectedHash required")?,
                                read_receipt_id.as_deref().ok_or("readReceiptId required")?,
                                &p.before,
                            )?;
                            result
                                .risk_reasons
                                .push("whole-file rewrite requires approval".into());
                        } else if *absent != Some(true)
                            || expected_hash.is_some()
                            || read_receipt_id.is_some()
                        {
                            return Err("new file requires explicit absent:true".into());
                        }
                        if file_path == "SKILL.md" {
                            return Err("write_file only supports supporting files; use a unique main patch".into());
                        }
                        p.after
                            .insert(file_path.clone(), content.as_bytes().to_vec());
                    }
                    SkillOperation::RemoveFile {
                        skill_id,
                        file_path,
                        expected_hash,
                        read_receipt_id,
                    } => {
                        if file_path == "SKILL.md" {
                            return Err("main file removal is not supported".into());
                        }
                        let p = load_package(&guard, &root, &found, &mut packages, skill_id)?;
                        super::validation::checked_join(
                            &root.path.join(&p.relative_path),
                            file_path,
                        )?;
                        if !touched.insert((skill_id.clone(), file_path.clone())) {
                            return Err("duplicate file operation in batch".into());
                        }
                        guard.check_receipt(
                            origin,
                            skill_id,
                            file_path,
                            expected_hash,
                            read_receipt_id,
                            &p.before,
                        )?;
                        p.after.remove(file_path).ok_or("remove target absent")?;
                        result
                            .risk_reasons
                            .push("support file removal requires approval".into());
                    }
                }
            }
            let packages = packages.into_values().collect::<Vec<_>>();
            for p in &packages {
                super::validation::links(&p.after)?;
                if !p.before.is_empty() && !p.before_metadata.auto_editable {
                    result.risk_reasons.push(
                        "handwritten/imported skill has no automatic edit authorization".into(),
                    );
                }
                if p.before_metadata.content_locked {
                    result
                        .risk_reasons
                        .push("contentLocked requires explicit approval".into());
                }
                for (path, bytes) in &p.after {
                    if p.before.get(path) == Some(bytes) {
                        continue;
                    }
                    super::validation::relative_file(path)?;
                    let text = std::str::from_utf8(bytes)
                        .map_err(|_| "changed file must be UTF-8 text")?;
                    if text.chars().count() > 100000 || text.contains('\0') {
                        return Err("changed text exceeds size limit or contains NUL".into());
                    }
                    result.risk_reasons.extend(super::validation::risks(text));
                    if path == "SKILL.md" {
                        let doc = super::validation::new_document(text, &p.name)?;
                        if let Some(before) = p.before.get("SKILL.md") {
                            let prior = super::validation::document(
                                std::str::from_utf8(before).map_err(|_| "SKILL.md is not UTF-8")?,
                                None,
                            )?;
                            if prior.1 != doc.1 {
                                result.risk_reasons.push(
                                    "trigger scope/frontmatter change requires approval".into(),
                                );
                            }
                        }
                        let prefix = doc.1.chars().take(57).collect::<String>().to_lowercase();
                        if !["use when", "when ", "用于", "当", "适用"]
                            .iter()
                            .any(|v| prefix.contains(v))
                        {
                            result.risk_reasons.push(
                                "description first 57 characters do not declare a clear trigger"
                                    .into(),
                            );
                        }
                    }
                    if path != "SKILL.md"
                        && !(path.starts_with("references/") && path.ends_with(".md"))
                    {
                        result
                            .risk_reasons
                            .push("scripts/templates/assets require approval".into());
                    }
                }
                let keys = p
                    .before
                    .keys()
                    .chain(p.after.keys())
                    .collect::<std::collections::BTreeSet<_>>();
                for path in keys {
                    let before = p.before.get(path);
                    let after = p.after.get(path);
                    if before == after {
                        continue;
                    }
                    result.changes.push(SkillDiff {
                        skill_id: p.skill_id.clone(),
                        name: p.name.clone(),
                        file_path: path.clone(),
                        before: before.map(|b| String::from_utf8_lossy(b).into_owned()),
                        after: after.map(|b| String::from_utf8_lossy(b).into_owned()),
                        before_hash: before.map(|b| hash(b)),
                        after_hash: after.map(|b| hash(b)),
                    });
                }
            }
            let evidence = proposal
                .evidence_ids
                .iter()
                .filter_map(|id| grant.evidence.get(id).cloned())
                .collect::<Vec<_>>();
            if !evidence.iter().any(real_learning_evidence) {
                result
                    .risk_reasons
                    .push("lesson has no trusted verification or explicit user correction".into());
            }
            if root.scope != "project" {
                result
                    .risk_reasons
                    .push("global promotion requires approval".into());
            }
            if grant.mode == LearningMode::ApproveAll {
                result.risk_reasons.push("approve-all host policy".into());
            }
            Ok(Batch {
                version: 1,
                root_id: root.root_id.clone(),
                result: result.clone(),
                packages,
                evidence,
                proposal: Some(proposal.clone()),
            })
        })();
        let mut batch = match evaluated {
            Ok(batch) => batch,
            Err(error) => {
                result.status = if error.contains("CAS conflict") {
                    "conflicted"
                } else {
                    "failed"
                }
                .into();
                result.error = Some(error);
                guard.save_result(&result)?;
                guard.commit()?;
                return Ok(result);
            }
        };
        if batch.result.changes.is_empty() {
            batch.result.status = "noop".into();
            guard.save_result(&batch.result)?;
            guard.commit()?;
            return Ok(batch.result);
        }
        #[cfg(test)]
        if let Some((ready, release)) = self
            .before_commit_gate
            .lock()
            .map_err(|_| "test gate poisoned")?
            .take()
        {
            ready
                .send(())
                .map_err(|_| "test commit checkpoint unavailable")?;
            release
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "test commit release unavailable")?;
        }
        let _authority = match self.commit_authority(origin) {
            Ok(authority) => authority,
            Err(error) => {
                batch.result.status = "cancelled".into();
                batch.result.error = Some(error);
                guard.save_result(&batch.result)?;
                guard.commit()?;
                return Ok(batch.result);
            }
        };
        if !batch.result.risk_reasons.is_empty() {
            batch.result.status = "awaiting_approval".into();
            transactions::save_batch(&root, &batch)?;
            guard.save_result(&batch.result)?;
            guard.commit()?;
            return Ok(batch.result);
        }
        transactions::execute(&guard, batch)
    }
}

pub(super) fn register_evidence(
    grant: &mut RunGrant,
    evidence: &[SkillEvidence],
) -> Result<(), String> {
    let mut staged = std::collections::BTreeMap::new();
    for e in evidence {
        // Review/execution origins own authority and receipts. Evidence retains
        // each original turn/run, but cannot cross the frozen session or cwd.
        if e.origin.host_id != grant.origin.host_id
            || e.origin.workspace_id != grant.origin.workspace_id
            || e.origin.session_id != grant.origin.session_id
            || e.origin.cwd != grant.origin.cwd
            || [&e.origin.turn_id, &e.origin.run_id]
                .iter()
                .any(|id| id.is_empty() || id.len() > 256 || id.contains('\0'))
            || e.evidence_id.is_empty()
            || e.evidence_id.len() > 256
            || e.summary.len() > 16384
            || e.result.as_ref().map_or(false, |r| r.len() > 32768)
        {
            return Err("invalid evidence origin/id/size".into());
        }
        if let Some(prior) = grant
            .evidence
            .get(&e.evidence_id)
            .or_else(|| staged.get(&e.evidence_id))
        {
            if serde_json::to_value(prior).map_err(|e| e.to_string())?
                != serde_json::to_value(e).map_err(|e| e.to_string())?
            {
                return Err("evidence id cannot change its facts".into());
            }
        }
        staged.insert(e.evidence_id.clone(), e.clone());
    }
    grant.evidence.extend(staged);
    Ok(())
}

fn load_package<'a>(
    guard: &RootGuard,
    root: &Root,
    found: &[super::catalog::FoundSkill],
    packages: &'a mut std::collections::BTreeMap<String, PackageChange>,
    id: &str,
) -> Result<&'a mut PackageChange, String> {
    if !packages.contains_key(id) {
        let target = found
            .iter()
            .find(|s| s.skill_id == id)
            .ok_or("unknown skillId in origin")?;
        if target.root.scope == "external" {
            return Err("external skills are read-only; explicitly import first".into());
        }
        if target.root.root_id != root.root_id {
            return Err("cross-root batch rejected".into());
        }
        let before = super::state::target_snapshot(target)?;
        let metadata = guard.metadata(id)?;
        packages.insert(
            id.into(),
            PackageChange {
                relative_path: target.relative_path.clone(),
                skill_id: id.into(),
                name: target.name.clone(),
                after: before.clone(),
                before,
                before_metadata: metadata.clone(),
                after_metadata: metadata,
            },
        );
    }
    packages
        .get_mut(id)
        .ok_or_else(|| "missing prepared package".into())
}

fn load_pending(guard: &RootGuard, origin: &SkillOrigin, id: &str) -> Result<Batch, String> {
    let dir = transactions::directory(&guard.root, id)?;
    use rusqlite::OptionalExtension;
    let current: Option<String> = guard
        .conn
        .query_row("SELECT value FROM batches WHERE id=?1", [id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let current: SkillMutationResult =
        serde_json::from_str(&current.ok_or("unknown pending batch")?)
            .map_err(|e| e.to_string())?;
    if &current.origin != origin || current.status != "awaiting_approval" {
        return Err("pending batch origin/state does not match".into());
    }
    let path = dir.join("intent.json");
    super::validation::safe_chain(&path)?;
    let batch: Batch = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    transactions::validate_batch(&batch, &guard.root)?;
    if &batch.result.origin != origin || batch.result.batch_id != id {
        return Err("frozen batch origin/id mismatch".into());
    }
    Ok(batch)
}

fn real_learning_evidence(e: &SkillEvidence) -> bool {
    if e.status != "success" {
        return false;
    }
    (e.provenance == "user-input" && e.kind == "correction" && !e.summary.trim().is_empty())
        || (["native-tool", "host-check"].contains(&e.provenance.as_str())
            && e.kind == "verification"
            && e.exit_code == Some(0)
            && e.tool_call_id.as_ref().map_or(false, |id| !id.is_empty())
            && e.tool_name.as_ref().map_or(false, |name| !name.is_empty()))
}
