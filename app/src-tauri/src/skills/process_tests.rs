use super::test_support::{skill, Fixture};
use super::*;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const HELPER: &str = "skills::process_tests::process_fixture_helper";
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn child(f: &Fixture, mode: &str) -> ChildGuard {
    ChildGuard(
        Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", HELPER, "--nocapture"])
            .env("UGS_SKILL_PROCESS_FIXTURE", &f.0)
            .env("UGS_SKILL_PROCESS_MODE", mode)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    )
}
fn wait_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(12);
    while !path.is_file() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        path.is_file(),
        "expected real process checkpoint: {}",
        path.display()
    );
}
fn wait_child(child: &mut ChildGuard) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            assert!(status.success(), "child failed: {status}");
            return;
        }
        assert!(Instant::now() < deadline, "child did not finish");
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn origin(project: &Path, run: &str) -> SkillOrigin {
    SkillOrigin {
        host_id: "local".into(),
        workspace_id: "workspace-process".into(),
        session_id: "session-process".into(),
        turn_id: "turn-process".into(),
        run_id: run.into(),
        cwd: Some(project.to_string_lossy().into_owned()),
    }
}

#[test]
#[ignore = "invoked only in an isolated child by real process tests"]
fn process_fixture_helper() {
    let base = PathBuf::from(std::env::var_os("UGS_SKILL_PROCESS_FIXTURE").unwrap());
    assert!(base.starts_with(
        "C:/Users/fengwei/AppData/Local/hermes/cache/scratch/ugs-autoskill-build-20261009"
    ));
    let mode = std::env::var("UGS_SKILL_PROCESS_MODE").unwrap();
    let s = SkillService::new(base.join("global"));
    let o = origin(&base.join("project"), &format!("run-{mode}"));
    s.bind_run(o.clone(), LearningMode::AutoSafe, SkillActor::Background)
        .unwrap();
    match mode.as_str() {
        "hold" => {
            let root = s.create_root(&o, &s.authority(&o).unwrap()).unwrap();
            let guard = super::state::RootGuard::open(&root).unwrap();
            std::fs::write(base.join("held"), "SQLite IMMEDIATE acquired").unwrap();
            wait_file(&base.join("release"));
            guard.commit().unwrap();
        }
        "reader" => {
            std::fs::write(base.join("reader-started"), "reader entering real service").unwrap();
            let catalog = s.list(&o).unwrap();
            std::fs::write(
                base.join("reader-result.json"),
                serde_json::to_vec(&catalog).unwrap(),
            )
            .unwrap();
        }
        "concurrent-a" | "concurrent-b" => {
            s.record_evidence(&o, &[SkillEvidence {
                evidence_id:"correction-concurrent".into(),origin:o.clone(),occurred_at:1,
                kind:"correction".into(),provenance:"user-input".into(),status:"success".into(),
                summary:"Preserve every original rule; concurrent writers must use fresh full reads.".into(),
                tool_call_id:None,tool_name:None,parent_id:None,exit_code:None,result:None,path:None,skill_id:None,revision:None,
            }]).unwrap();
            let entry = s.list(&o).unwrap().entries.remove(0);
            let read = s.view(&o, &entry.skill_id, None).unwrap();
            std::fs::write(
                base.join(format!("ready-{mode}")),
                "complete read obtained in this process",
            )
            .unwrap();
            wait_file(&base.join("release-writers"));
            let result = s
                .manage(
                    &o,
                    &SkillProposal {
                        version: 1,
                        kind: "propose".into(),
                        lesson: "CAS prevents the second stale concurrent update.".into(),
                        evidence_ids: vec!["correction-concurrent".into()],
                        operations: vec![SkillOperation::Patch {
                            skill_id: entry.skill_id,
                            file_path: None,
                            old_string: "Preserve every original rule.".into(),
                            new_string:
                                "Preserve every original rule. Apply only one concurrent writer."
                                    .into(),
                            expected_hash: read.hash,
                            read_receipt_id: read.read_receipt_id,
                        }],
                    },
                )
                .unwrap();
            std::fs::write(
                base.join(format!("result-{mode}.json")),
                serde_json::to_vec(&result).unwrap(),
            )
            .unwrap();
        }
        "crash-writer" | "revoke-after-commit" => {
            let evidence = SkillEvidence {
                evidence_id: "correction-process".into(),
                origin: o.clone(),
                occurred_at: 1,
                kind: "correction".into(),
                provenance: "user-input".into(),
                status: "success".into(),
                summary: "Always validate both packages before publishing either.".into(),
                tool_call_id: None,
                tool_name: None,
                parent_id: None,
                exit_code: None,
                result: None,
                path: None,
                skill_id: None,
                revision: None,
            };
            s.record_evidence(&o, &[evidence]).unwrap();
            let existing = s
                .list(&o)
                .unwrap()
                .entries
                .into_iter()
                .find(|entry| entry.name == "first-package")
                .unwrap();
            let owner = SkillService::new(base.join("global"));
            owner
                .bind_run(o.clone(), LearningMode::AutoSafe, SkillActor::User)
                .unwrap();
            owner
                .set_policy(
                    &o,
                    &existing.skill_id,
                    &SkillPolicy {
                        auto_editable: Some(true),
                        ..SkillPolicy::default()
                    },
                )
                .unwrap();
            let read = s.view(&o, &existing.skill_id, None).unwrap();
            let p = SkillProposal {
                version: 1,
                kind: "propose".into(),
                lesson: "Validate the complete batch before publication.".into(),
                evidence_ids: vec!["correction-process".into()],
                // Keep two genuine package publishes without violating the
                // host's one-new-class budget: one existing additive patch.
                operations: vec![
                    SkillOperation::Patch {
                        skill_id: existing.skill_id,
                        file_path: None,
                        old_string: "Read all files before changing them.".into(),
                        new_string: "Read all files before changing them. Validate both packages before publication.".into(),
                        expected_hash: read.hash,
                        read_receipt_id: read.read_receipt_id,
                    },
                    SkillOperation::Create {
                        name: "second-package".into(),
                        content: skill(
                            "second-package",
                            "Read all files before changing them. Validate both packages before publication.",
                        ),
                    },
                ],
            };
            if mode == "revoke-after-commit" {
                let s = std::sync::Arc::new(s);
                let writer = std::thread::spawn({
                    let s = s.clone();
                    let o = o.clone();
                    move || s.manage(&o, &p).unwrap()
                });
                wait_file(&base.join("published-first"));
                let (tx, rx) = std::sync::mpsc::channel();
                let revoker = std::thread::spawn({
                    let s = s.clone();
                    let o = o.clone();
                    move || tx.send(s.revoke_run(&o)).unwrap()
                });
                assert!(
                    matches!(
                        rx.recv_timeout(Duration::from_millis(250)),
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                    ),
                    "revocation cannot cross an acquired commit guard"
                );
                std::fs::write(
                    base.join("revoke-blocked"),
                    "revocation waits for real commit critical section",
                )
                .unwrap();
                let result = writer.join().unwrap();
                rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
                revoker.join().unwrap();
                let late = s
                    .manage(
                        &o,
                        &SkillProposal {
                            version: 1,
                            kind: "propose".into(),
                            lesson: "late proposal".into(),
                            evidence_ids: vec![],
                            operations: vec![SkillOperation::Create {
                                name: "late-result".into(),
                                content: skill("late-result", "Do not persist a revoked proposal."),
                            }],
                        },
                    )
                    .unwrap();
                std::fs::write(
                    base.join("writer-result.json"),
                    serde_json::to_vec(&serde_json::json!({"applied":result,"late":late})).unwrap(),
                )
                .unwrap();
            } else {
                let result = s.manage(&o, &p).unwrap();
                std::fs::write(
                    base.join("writer-result.json"),
                    serde_json::to_vec(&result).unwrap(),
                )
                .unwrap();
            }
        }
        _ => panic!("unknown fixture mode"),
    }
}

#[test]
fn two_real_process_writers_allow_only_one_fresh_cas_update() {
    let f = Fixture::new("concurrent-writers");
    let s = SkillService::new(f.global());
    let o = origin(&f.project(), "run-create-concurrent");
    s.bind_run(o.clone(), LearningMode::AutoSafe, SkillActor::Background)
        .unwrap();
    s.record_evidence(
        &o,
        &[SkillEvidence {
            evidence_id: "correction-create".into(),
            origin: o.clone(),
            occurred_at: 1,
            kind: "correction".into(),
            provenance: "user-input".into(),
            status: "success".into(),
            summary: "Preserve every original rule before learning.".into(),
            tool_call_id: None,
            tool_name: None,
            parent_id: None,
            exit_code: None,
            result: None,
            path: None,
            skill_id: None,
            revision: None,
        }],
    )
    .unwrap();
    let created = s
        .manage(
            &o,
            &SkillProposal {
                version: 1,
                kind: "propose".into(),
                lesson: "Preserve all rules.".into(),
                evidence_ids: vec!["correction-create".into()],
                operations: vec![SkillOperation::Create {
                    name: "concurrent-rule".into(),
                    content: skill("concurrent-rule", "Preserve every original rule."),
                }],
            },
        )
        .unwrap();
    assert_eq!(created.status, "applied");
    let mut a = child(&f, "concurrent-a");
    let mut b = child(&f, "concurrent-b");
    wait_file(&f.0.join("ready-concurrent-a"));
    wait_file(&f.0.join("ready-concurrent-b"));
    f.write("release-writers", "release both genuine service requests");
    wait_child(&mut a);
    wait_child(&mut b);
    let mut statuses = ["concurrent-a", "concurrent-b"]
        .iter()
        .map(|mode| {
            let result: SkillMutationResult = serde_json::from_slice(
                &std::fs::read(f.0.join(format!("result-{mode}.json"))).unwrap(),
            )
            .unwrap();
            if result.status == "conflicted" {
                assert_eq!(result.operations_applied, 0);
                assert!(result.error.as_deref().unwrap().contains("CAS conflict"));
            }
            result.status
        })
        .collect::<Vec<_>>();
    statuses.sort();
    assert_eq!(statuses, vec!["applied", "conflicted"]);
    let content = std::fs::read_to_string(
        f.project()
            .join(".ultragamestudio/skills/concurrent-rule/SKILL.md"),
    )
    .unwrap();
    assert_eq!(
        content.matches("Apply only one concurrent writer.").count(),
        1
    );
}

#[test]
fn revoke_after_commit_start_waits_and_preserves_applied_publication_truth() {
    let f = Fixture::new("revoke-committing");
    f.write(
        "project/.ultragamestudio/skills/first-package/SKILL.md",
        &skill("first-package", "Read all files before changing them."),
    );
    let mut writer = child(&f, "revoke-after-commit");
    wait_file(&f.0.join("revoke-blocked"));
    f.write("release-writer", "finish the acquired commit boundary");
    wait_child(&mut writer);
    let result: serde_json::Value =
        serde_json::from_slice(&std::fs::read(f.0.join("writer-result.json")).unwrap()).unwrap();
    assert_eq!(result["applied"]["status"], "applied");
    assert_eq!(result["applied"]["operationsApplied"], 2);
    assert_eq!(result["late"]["status"], "cancelled");
    for name in ["first-package", "second-package"] {
        assert_eq!(
            std::fs::read_to_string(
                f.project()
                    .join(".ultragamestudio/skills")
                    .join(name)
                    .join("SKILL.md")
            )
            .unwrap(),
            skill(
                name,
                "Read all files before changing them. Validate both packages before publication."
            )
        );
    }
    assert!(!f
        .project()
        .join(".ultragamestudio/skills/late-result")
        .exists());
}

#[test]
fn root_gate_serializes_real_reader_in_another_process() {
    let f = Fixture::new("process-lock");
    f.write(
        "project/.ultragamestudio/skills/existing/SKILL.md",
        &skill("existing", "Keep all original bytes."),
    );
    let mut holder = child(&f, "hold");
    wait_file(&f.0.join("held"));
    let mut reader = child(&f, "reader");
    wait_file(&f.0.join("reader-started"));
    std::thread::sleep(Duration::from_millis(250));
    assert!(
        !f.0.join("reader-result.json").exists(),
        "reader must block on the root transaction"
    );
    f.write("release", "release actual gate");
    wait_child(&mut holder);
    wait_child(&mut reader);
    let catalog: SkillCatalog =
        serde_json::from_slice(&std::fs::read(f.0.join("reader-result.json")).unwrap()).unwrap();
    assert_eq!(catalog.entries.len(), 1);
    assert_eq!(catalog.entries[0].name, "existing");
}

#[test]
fn killed_mid_batch_writer_is_recovered_before_blocked_reader_returns() {
    let f = Fixture::new("process-kill");
    f.write(
        "project/.ultragamestudio/skills/existing/SKILL.md",
        &skill("existing", "Untouched sentinel."),
    );
    f.write(
        "project/.ultragamestudio/skills/first-package/SKILL.md",
        &skill("first-package", "Read all files before changing them."),
    );
    let before_first =
        super::service::read_package(&f.project().join(".ultragamestudio/skills/first-package"))
            .unwrap();
    let before =
        super::service::read_package(&f.project().join(".ultragamestudio/skills/existing"))
            .unwrap();
    let mut writer = child(&f, "crash-writer");
    wait_file(&f.0.join("published-first"));
    let published = ["first-package", "second-package"]
        .iter()
        .filter(|name| {
            std::fs::read_to_string(
                f.project()
                    .join(".ultragamestudio/skills")
                    .join(name)
                    .join("SKILL.md"),
            )
            .map_or(false, |text| {
                text.contains("Validate both packages before publication.")
            })
        })
        .count();
    assert_eq!(
        published, 1,
        "the checkpoint must be between the two genuine publishes"
    );
    let mut reader = child(&f, "reader");
    wait_file(&f.0.join("reader-started"));
    std::thread::sleep(Duration::from_millis(250));
    assert!(!f.0.join("reader-result.json").exists());
    writer.0.kill().unwrap();
    assert!(!writer.0.wait().unwrap().success());
    wait_child(&mut reader);
    let catalog: SkillCatalog =
        serde_json::from_slice(&std::fs::read(f.0.join("reader-result.json")).unwrap()).unwrap();
    let mut names = catalog
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, ["existing", "first-package"]);
    assert_eq!(
        super::service::read_package(&f.project().join(".ultragamestudio/skills/first-package"))
            .unwrap(),
        before_first
    );
    assert!(!f
        .project()
        .join(".ultragamestudio/skills/second-package")
        .exists());
    assert_eq!(
        super::service::read_package(&f.project().join(".ultragamestudio/skills/existing"))
            .unwrap(),
        before
    );
    let s = SkillService::new(f.global());
    let o = origin(&f.project(), "run-crash-writer");
    s.bind_run(o.clone(), LearningMode::AutoSafe, SkillActor::Background)
        .unwrap();
    let history = s.history(&o).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, "failed");
    assert_eq!(history[0].operations_applied, 0);
    let root = s.create_root(&o, &s.authority(&o).unwrap()).unwrap();
    let dir = super::transactions::directory(&root, &history[0].batch_id).unwrap();
    assert!(dir.join("intent.json").is_file());
    assert!(dir.join("restored.json").is_file());
    assert!(dir.join("before").is_dir());
}
