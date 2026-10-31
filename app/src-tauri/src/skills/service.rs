use super::types::{LearningMode, SkillActor};
use super::types::{SkillOrigin, SkillReadResult};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone)]
pub(super) struct RunGrant {
    pub origin: SkillOrigin,
    pub cwd: Option<PathBuf>,
    pub mode: LearningMode,
    pub actor: SkillActor,
    pub revoked: bool,
    pub bound: bool,
    pub evidence: std::collections::BTreeMap<String, super::types::SkillEvidence>,
}

pub struct SkillService {
    pub(super) global_root: PathBuf,
    pub(super) grants: Mutex<std::collections::BTreeMap<String, RunGrant>>,
    #[cfg(test)]
    pub(super) before_commit_gate:
        Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}

impl SkillService {
    pub fn new(global_root: PathBuf) -> Self {
        Self {
            global_root,
            grants: Mutex::new(std::collections::BTreeMap::new()),
            #[cfg(test)]
            before_commit_gate: Mutex::new(None),
        }
    }
    /// Test helper; production host binding installs authority and evidence together.
    #[cfg(test)]
    pub fn bind_run(
        &self,
        origin: SkillOrigin,
        mode: LearningMode,
        actor: SkillActor,
    ) -> Result<(), String> {
        self.bind_run_with_evidence(origin, mode, actor, &[])
    }

    pub(super) fn bind_run_with_evidence(
        &self,
        origin: SkillOrigin,
        mode: LearningMode,
        actor: SkillActor,
        evidence: &[super::types::SkillEvidence],
    ) -> Result<(), String> {
        if origin.host_id != "local" {
            return Err("local hostId required".into());
        }
        if [
            &origin.workspace_id,
            &origin.session_id,
            &origin.turn_id,
            &origin.run_id,
        ]
        .iter()
        .any(|s| s.is_empty() || s.len() > 256 || s.contains('\0'))
        {
            return Err("invalid origin identifier".into());
        }
        super::validation::safe_chain(&self.global_root)?;
        let cwd = match origin.cwd.as_deref() {
            Some(value) => {
                let path = Path::new(value);
                super::validation::safe_chain(path)?;
                if !path.is_dir() {
                    return Err("origin workspace cwd is unavailable".into());
                }
                Some(std::fs::canonicalize(path).map_err(|e| e.to_string())?)
            }
            None if origin.workspace_id == "__default__" => None,
            None => return Err("workspace requires a frozen cwd".into()),
        };
        let mut grants = self.grants.lock().map_err(|_| "grant lock poisoned")?;
        let mut candidate = if let Some(prior) = grants.get(&origin.run_id) {
            if prior.revoked {
                return Err("run authority revoked".into());
            }
            if prior.origin != origin || prior.mode != mode || prior.actor != actor {
                return Err("run already bound to another authority".into());
            }
            prior.clone()
        } else {
            RunGrant {
                origin,
                cwd,
                mode,
                actor,
                revoked: false,
                bound: true,
                evidence: std::collections::BTreeMap::new(),
            }
        };
        // Install neither authority nor evidence unless the whole ingress succeeds.
        super::management::register_evidence(&mut candidate, evidence)?;
        grants.insert(candidate.origin.run_id.clone(), candidate);
        Ok(())
    }

    pub fn revoke_run(&self, origin: &SkillOrigin) -> Result<(), String> {
        if origin.host_id != "local"
            || [
                &origin.workspace_id,
                &origin.session_id,
                &origin.turn_id,
                &origin.run_id,
            ]
            .iter()
            .any(|id| id.is_empty() || id.len() > 256 || id.contains('\0'))
        {
            return Err("invalid origin identifier".into());
        }
        // This is the same lock held through a dispatched commit. A revoke
        // acknowledgement cannot overtake that commit or a concurrent bind.
        let mut grants = self.grants.lock().map_err(|_| "grant lock poisoned")?;
        if let Some(grant) = grants.get_mut(&origin.run_id) {
            if &grant.origin != origin {
                return Err("origin does not match frozen host binding".into());
            }
            grant.revoked = true;
        } else {
            // Trusted app cancellation may arrive while source validation is
            // still reading. Retain its exact identity so a late bind is denied.
            grants.insert(
                origin.run_id.clone(),
                RunGrant {
                    origin: origin.clone(),
                    cwd: None,
                    mode: LearningMode::Off,
                    actor: SkillActor::Background,
                    revoked: true,
                    bound: false,
                    evidence: std::collections::BTreeMap::new(),
                },
            );
        }
        Ok(())
    }

    pub(super) fn commit_authority(
        &self,
        origin: &SkillOrigin,
    ) -> Result<std::sync::MutexGuard<'_, std::collections::BTreeMap<String, RunGrant>>, String>
    {
        let grants = self.grants.lock().map_err(|_| "grant lock poisoned")?;
        let grant = grants.get(&origin.run_id).ok_or("unbound origin")?;
        if &grant.origin != origin || grant.revoked || grant.mode == LearningMode::Off {
            return Err("run authority revoked before commit".into());
        }
        Ok(grants)
    }

    pub(super) fn authority(&self, origin: &SkillOrigin) -> Result<RunGrant, String> {
        let grants = self.grants.lock().map_err(|_| "grant lock poisoned")?;
        let grant = grants.get(&origin.run_id).ok_or("unbound origin")?;
        if !grant.bound {
            return Err("run authority revoked before binding".into());
        }
        if &grant.origin != origin {
            return Err("origin does not match frozen host binding".into());
        }
        if let Some(cwd) = &grant.cwd {
            super::validation::safe_chain(cwd)?;
            if !cwd.is_dir() {
                return Err("origin workspace unavailable".into());
            }
        }
        Ok(grant.clone())
    }

    pub(super) fn discover_bound(
        &self,
        origin: &SkillOrigin,
        authority: &RunGrant,
    ) -> Result<Vec<super::catalog::FoundSkill>, String> {
        let mut found = vec![];
        for root in
            super::catalog::roots_for(&origin.host_id, authority.cwd.as_deref(), &self.global_root)?
        {
            if !root.path.is_dir() {
                continue;
            }
            if root.scope == "external" {
                found.extend(super::catalog::discover_root(
                    &origin.host_id,
                    &origin.workspace_id,
                    &root,
                )?);
            } else {
                let guard = super::state::RootGuard::open(&root)?;
                found.extend(super::catalog::discover_root(
                    &origin.host_id,
                    &origin.workspace_id,
                    &root,
                )?);
                guard.commit()?;
            }
        }
        Ok(found)
    }

    #[cfg(test)]
    pub fn validate_receipt(
        &self,
        origin: &SkillOrigin,
        skill_id: &str,
        relative_path: &str,
        expected_hash: &str,
        receipt_id: &str,
    ) -> Result<(), String> {
        super::validation::relative_file(relative_path)?;
        let authority = self.authority(origin)?;
        let target = self
            .discover_bound(origin, &authority)?
            .into_iter()
            .find(|s| s.skill_id == skill_id)
            .ok_or("unknown skillId in origin")?;
        let guard = self.target_guard(&target)?;
        let snapshot = super::state::target_snapshot(&target)?;
        guard.check_receipt(
            origin,
            skill_id,
            relative_path,
            expected_hash,
            receipt_id,
            &snapshot,
        )
    }

    pub(super) fn target_guard(
        &self,
        target: &super::catalog::FoundSkill,
    ) -> Result<super::state::RootGuard, String> {
        let ledger_root = if target.root.scope == "external" {
            super::catalog::owned_root(
                "local",
                &self.global_root.join("skills"),
                "global",
                "ugs-global",
            )?
        } else {
            target.root.clone()
        };
        super::state::RootGuard::open(&ledger_root)
    }

    pub fn view(
        &self,
        origin: &SkillOrigin,
        skill_id: &str,
        file_path: Option<&str>,
    ) -> Result<SkillReadResult, String> {
        let authority = self.authority(origin)?;
        let found = self.discover_bound(origin, &authority)?;
        let target = found
            .into_iter()
            .find(|s| s.skill_id == skill_id)
            .ok_or("unknown skillId in origin")?;
        let guard = self.target_guard(&target)?;
        let relative_path = file_path.unwrap_or("SKILL.md");
        let path = super::validation::checked_join(
            &target.root.path.join(&target.relative_path),
            relative_path,
        )?;
        super::validation::safe_chain(&path)?;
        let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        if content.chars().count() > 100000 {
            return Err("complete text exceeds 100000 characters; split it into references".into());
        }
        let file_hash = hash(content.as_bytes());
        let package = target.root.path.join(&target.relative_path);
        let snapshot = read_package(&package)?;
        let files: Vec<String> = snapshot.keys().cloned().collect();
        let main_hash = hash(snapshot.get("SKILL.md").ok_or("missing SKILL.md")?);
        let revision = package_hash(&snapshot);
        let metadata = guard.usage(origin, skill_id, &revision, "viewed", &[])?;
        let entry = super::types::SkillEntry {
            skill_id: target.skill_id,
            root_id: target.root.root_id,
            name: target.name,
            description: target.description,
            scope: target.root.scope.clone(),
            source: target.root.source,
            relative_path: target.relative_path,
            revision: revision.clone(),
            hash: main_hash,
            read_only: target.root.scope == "external",
            auto_editable: metadata.auto_editable,
            content_locked: metadata.content_locked,
            pinned: metadata.pinned,
            state: "active".into(),
            files: files.clone(),
            usage: Some(metadata.usage),
        };
        let receipt_id = opaque_id()?;
        guard.save_receipt(
            &receipt_id,
            origin,
            skill_id,
            relative_path,
            &revision,
            &file_hash,
        )?;
        guard.commit()?;
        Ok(SkillReadResult {
            entry,
            relative_path: relative_path.into(),
            content,
            revision,
            hash: file_hash,
            full_read: true,
            read_receipt_id: receipt_id,
            files,
        })
    }
}

pub(super) type Snapshot = std::collections::BTreeMap<String, Vec<u8>>;

pub(super) fn read_package(package: &Path) -> Result<Snapshot, String> {
    super::validation::safe_chain(package)?;
    let mut result = Snapshot::new();
    if !package.exists() {
        return Ok(result);
    }
    fn visit(package: &Path, path: &Path, result: &mut Snapshot) -> Result<(), String> {
        super::validation::safe_chain(path)?;
        let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                visit(package, &entry.map_err(|e| e.to_string())?.path(), result)?;
            }
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(package)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            result.insert(rel, std::fs::read(path).map_err(|e| e.to_string())?);
        } else {
            return Err("non-regular package file rejected".into());
        }
        Ok(())
    }
    visit(package, package, &mut result)?;
    Ok(result)
}

pub(super) fn package_hash(snapshot: &Snapshot) -> String {
    let text = snapshot
        .iter()
        .map(|(path, bytes)| format!("{path}\0{}\n", hash(bytes)))
        .collect::<String>();
    hash(text.as_bytes())
}

pub(super) fn entry_from(
    target: &super::catalog::FoundSkill,
    snapshot: &Snapshot,
    metadata: &super::state::SkillMetadata,
) -> Result<super::types::SkillEntry, String> {
    let main = snapshot.get("SKILL.md").ok_or("missing SKILL.md")?;
    let (name, description) = super::validation::document(
        std::str::from_utf8(main).map_err(|_| "SKILL.md is not UTF-8")?,
        None,
    )?;
    Ok(super::types::SkillEntry {
        skill_id: target.skill_id.clone(),
        root_id: target.root.root_id.clone(),
        name,
        description,
        scope: target.root.scope.clone(),
        source: target.root.source.clone(),
        relative_path: target.relative_path.clone(),
        revision: package_hash(snapshot),
        hash: hash(main),
        read_only: target.root.scope == "external",
        auto_editable: metadata.auto_editable,
        content_locked: metadata.content_locked,
        pinned: metadata.pinned,
        state: if metadata.archived {
            "archived"
        } else {
            "active"
        }
        .into(),
        files: snapshot.keys().cloned().collect(),
        usage: Some(metadata.usage.clone()),
    })
}

pub(super) fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

pub(super) fn opaque_id() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::catalog::discover;
    use crate::skills::test_support::{skill, Fixture};

    pub(super) fn origin(f: &Fixture, run: &str) -> SkillOrigin {
        SkillOrigin {
            host_id: "local".into(),
            workspace_id: "workspace-a".into(),
            session_id: "session-a".into(),
            turn_id: "turn-a".into(),
            run_id: run.into(),
            cwd: Some(f.project().to_string_lossy().into_owned()),
        }
    }

    fn bound_service(f: &Fixture) -> SkillService {
        let service = SkillService::new(f.global());
        service
            .bind_run(
                origin(f, "run-a"),
                LearningMode::AutoSafe,
                SkillActor::Background,
            )
            .unwrap();
        service
    }

    #[test]
    fn origin_binding_rejects_wrong_host_workspace_and_cwd() {
        let f = Fixture::new("service-binding");
        f.write(
            "project/.ultragamestudio/skills/bound/SKILL.md",
            &skill("bound", "Bound origin only"),
        );
        let service = SkillService::new(f.global());
        let o = origin(&f, "run-a");
        let id = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap()[0]
            .skill_id
            .clone();
        assert!(
            service.view(&o, &id, None).is_err(),
            "an unbound request must not read arbitrary cwd"
        );
        service
            .bind_run(
                o.clone(),
                super::super::types::LearningMode::AutoSafe,
                super::super::types::SkillActor::Background,
            )
            .unwrap();
        assert!(service.view(&o, &id, None).is_ok());
        let mut changed = o.clone();
        changed.cwd = Some(f.global().to_string_lossy().into_owned());
        assert!(service.view(&changed, &id, None).is_err());
        changed = o.clone();
        changed.workspace_id = "other-workspace".into();
        assert!(service.view(&changed, &id, None).is_err());
        changed = o;
        changed.host_id = "remote-claimed".into();
        assert!(service
            .bind_run(
                changed,
                super::super::types::LearningMode::AutoSafe,
                super::super::types::SkillActor::Background
            )
            .is_err());
    }

    #[test]
    fn relative_file_paths_reject_escape_ads_devices_and_case_aliases() {
        let f = Fixture::new("service-safe-path");
        f.write(
            "project/.ultragamestudio/skills/bound/SKILL.md",
            &skill("bound", "Safe path only"),
        );
        f.write(
            "project/.ultragamestudio/skills/bound/references/Case.md",
            "case-sensitive literal",
        );
        f.write(
            "project/.ultragamestudio/skills/outside.md",
            "outside sentinel",
        );
        let id = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap()[0]
            .skill_id
            .clone();
        let service = bound_service(&f);
        for bad in [
            "../outside.md",
            "references/../SKILL.md",
            "C:/outside.md",
            "//server/share/file.md",
            "references/Case.md:extra",
            "references/Case.md.",
            "references/CON.md",
            "references/LPT1.txt",
            "references/case.md",
            "references\\Case.md",
        ] {
            assert!(
                service.view(&origin(&f, "run-a"), &id, Some(bad)).is_err(),
                "unsafe path was accepted: {bad}"
            );
        }
        assert!(service
            .view(&origin(&f, "run-a"), &id, Some("references/Case.md"))
            .is_ok());
    }

    #[test]
    fn read_receipts_bind_exact_run_target_and_hash_and_survive_restart() {
        let f = Fixture::new("service-receipt");
        f.write(
            "project/.ultragamestudio/skills/bound/SKILL.md",
            &skill("bound", "Old rule"),
        );
        let service = bound_service(&f);
        let o = origin(&f, "run-a");
        let id = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap()[0]
            .skill_id
            .clone();
        let read = service.view(&o, &id, None).unwrap();
        let mut other = o.clone();
        other.run_id = "run-b".into();
        service
            .bind_run(
                other.clone(),
                LearningMode::AutoSafe,
                SkillActor::Background,
            )
            .unwrap();
        assert!(
            service
                .validate_receipt(&other, &id, "SKILL.md", &read.hash, &read.read_receipt_id)
                .is_err(),
            "another run must not reuse a receipt"
        );
        assert!(service
            .validate_receipt(
                &o,
                &id,
                "references/other.md",
                &read.hash,
                &read.read_receipt_id
            )
            .is_err());
        assert!(service
            .validate_receipt(&o, &id, "SKILL.md", &read.hash, "forged")
            .is_err());
        let restarted = bound_service(&f);
        assert!(restarted
            .validate_receipt(&o, &id, "SKILL.md", &read.hash, &read.read_receipt_id)
            .is_ok());
        f.write(
            "project/.ultragamestudio/skills/bound/SKILL.md",
            &skill("bound", "User-edited rule"),
        );
        assert!(
            restarted
                .validate_receipt(&o, &id, "SKILL.md", &read.hash, &read.read_receipt_id)
                .is_err(),
            "stale receipts must not authorize writes"
        );
    }

    #[test]
    fn oversized_main_rejected_without_full_receipt() {
        let f = Fixture::new("service-large");
        let text = skill("oversized", &"界".repeat(100000));
        f.write("project/.ultragamestudio/skills/oversized/SKILL.md", &text);
        let id = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap()[0]
            .skill_id
            .clone();
        let service = bound_service(&f);
        let error = service
            .view(&origin(&f, "run-a"), &id, None)
            .err()
            .expect("oversized text must not receive fullRead");
        assert!(error.contains("100000"));
    }

    #[test]
    fn support_file_full_read_and_manual_edits_refresh_hash() {
        let f = Fixture::new("service-support-read");
        f.write(
            "project/.ultragamestudio/skills/full-read/SKILL.md",
            &skill("full-read", "Follow references/check.md"),
        );
        f.write(
            "project/.ultragamestudio/skills/full-read/references/check.md",
            "All support text\n",
        );
        let id = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap()[0]
            .skill_id
            .clone();
        let service = bound_service(&f);
        let before = service
            .view(&origin(&f, "run-a"), &id, Some("references/check.md"))
            .unwrap();
        assert_eq!(before.content, "All support text\n");
        assert!(
            before.files.contains(&"references/check.md".into()),
            "linked support files must be listed"
        );
        assert_eq!(
            before.entry.hash,
            hash(skill("full-read", "Follow references/check.md").as_bytes())
        );
        f.write(
            "project/.ultragamestudio/skills/full-read/references/check.md",
            "Changed on disk\n",
        );
        let after = service
            .view(&origin(&f, "run-a"), &id, Some("references/check.md"))
            .unwrap();
        assert_eq!(after.content, "Changed on disk\n");
        assert_ne!(before.hash, after.hash);
        assert_ne!(before.entry.revision, after.entry.revision);
    }

    #[test]
    fn main_file_full_read_receipt() {
        let f = Fixture::new("service-main-read");
        let text = skill("full-read", &"Keep every rule.\n".repeat(5000));
        f.write("project/.ultragamestudio/skills/full-read/SKILL.md", &text);
        let found = discover("local", "workspace-a", Some(&f.project()), &f.global()).unwrap();
        let result = bound_service(&f)
            .view(&origin(&f, "run-a"), &found[0].skill_id, None)
            .expect("a real complete read must succeed");
        assert_eq!(result.content, text);
        assert!(result.full_read);
        assert_eq!(result.relative_path, "SKILL.md");
        assert!(!result.read_receipt_id.is_empty());
        assert_eq!(result.hash, result.entry.hash);
        assert_eq!(result.entry.skill_id, found[0].skill_id);
    }
}
