use super::*;
use serde_json::{json, Value};

#[cfg(windows)]
#[path = "history_journal_interleave_tests.rs"]
mod journal_interleave_tests;

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
fn fixture() -> PathBuf {
    let scratch = std::env::var("UGS_PERSIST_FIXTURE_ROOT")
        .or_else(|_| std::env::var("TMPDIR"))
        .unwrap_or_else(|_| format!("{}/hermes/cache/scratch", std::env::var("LOCALAPPDATA").expect("isolated scratch root")));
    let root = PathBuf::from(scratch).join(format!("persist-fixture-{}-{}-{}", std::process::id(), timestamp_token(), FIXTURE_SEQUENCE.fetch_add(1, Ordering::SeqCst)));
    fs::create_dir_all(&root).unwrap(); root
}
const SESSION: &str = "workspaces/fixture/sessions/a.json";
fn record() -> Value { json!({"id":"a","workspaceId":"fixture","title":"old","messages":[{"id":"m","text":"old"}],"unknown":{"keep":true}}) }

#[test]
fn batched_chunk_reads_preserve_order_and_enforce_the_same_boundaries() {
    use sha2::{Digest, Sha256};
    let root = fixture();
    let chunks: Vec<_> = ["one", "two"].iter().map(|text| {
        let hash = hex::encode(Sha256::digest(text.as_bytes()));
        let path = format!("{SESSION}.chunks/{hash}.json");
        let payload = json!({"text":text}).to_string();
        history_write_at(&root, &path, &payload, false).unwrap();
        (path, payload)
    }).collect();
    let missing = format!("{SESSION}.chunks/{}.json", "0".repeat(64));
    let paths = vec![chunks[1].0.clone(), missing, chunks[0].0.clone()];
    assert_eq!(history_read_chunks_at(&root, &paths).unwrap(), vec![Some(chunks[1].1.clone()), None, Some(chunks[0].1.clone())]);
    assert!(history_read_chunks_at(&root, &vec![chunks[0].0.clone(); 17]).is_err());
    assert!(history_read_chunks_at(&root, &[SESSION.into()]).is_err());
    fs::write(root.join(&chunks[0].0), "{\"text\":\"corrupt\"}").unwrap();
    assert!(history_read_chunks_at(&root, &[chunks[0].0.clone()]).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn chunk_storage_checks_hash_and_rejects_hardlink_aliases() {
    use sha2::{Digest, Sha256};
    let root = fixture();
    let text = "完整分块🌍";
    let hash = hex::encode(Sha256::digest(text.as_bytes()));
    let rel = format!("{SESSION}.chunks/{hash}.json");
    let chunk = json!({"text":text}).to_string();
    assert!(history_read_at(&root, &rel).unwrap().is_none());
    history_write_at(&root, &rel, &chunk, false).unwrap();
    history_write_at(&root, &rel, &chunk, false).unwrap();
    assert_eq!(history_read_at(&root, &rel).unwrap().unwrap(), chunk);
    assert!(history_write_at(&root, &rel, &json!({"text":"other"}).to_string(), false).is_err());
    let outside = root.with_extension("chunk-hardlink");
    fs::hard_link(root.join(&rel), &outside).unwrap();
    assert!(history_read_at(&root, &rel).is_err());
    assert!(history_write_at(&root, &rel, &chunk, false).is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), chunk);
    fs::remove_file(outside).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[cfg(windows)]
#[test]
fn chunk_storage_rejects_a_redirected_parent_directory() {
    use sha2::{Digest, Sha256};
    let root = fixture();
    let text = "块";
    let hash = hex::encode(Sha256::digest(text.as_bytes()));
    let rel = format!("{SESSION}.chunks/{hash}.json");
    let chunk = json!({"text":text}).to_string();
    history_write_at(&root, &rel, &chunk, false).unwrap();
    let parent = root.join(format!("{SESSION}.chunks"));
    let external = root.with_extension("chunk-outside");
    fs::rename(&parent, &external).unwrap();
    let command = format!("mklink /J \"{}\" \"{}\"", parent.display(), external.display());
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("cmd.exe").args(["/d", "/c"]).raw_arg(command).output().unwrap();
    assert!(output.status.success());
    assert!(history_read_at(&root, &rel).is_err());
    assert!(history_write_at(&root, &rel, &chunk, false).is_err());
    assert_eq!(fs::read_to_string(external.join(format!("{hash}.json"))).unwrap(), chunk);
    fs::remove_dir(&parent).unwrap();
    fs::remove_dir_all(external).unwrap();
    fs::remove_dir_all(root).unwrap();
}
fn fresh_read(root: &Path, expected: &Value) { fresh_read_at(root, SESSION, expected); }
fn fresh_read_at(root: &Path, rel_path: &str, expected: &Value) {
    let name = module_path!().split("::").skip(1).collect::<Vec<_>>().join("::") + "::fresh_reader";
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &name, "--nocapture"])
        .env("UGS_HISTORY_READ_FIXTURE", root)
        .env("UGS_HISTORY_READ_REL_PATH", rel_path)
        .env("UGS_HISTORY_READ_EXPECTED", serde_json::to_string(expected).unwrap())
        .output().unwrap();
    assert!(output.status.success(), "child fresh-read failed: {} {}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(String::from_utf8_lossy(&output.stdout).contains("fresh-read verified"));
}
#[test]
fn fresh_reader() {
    let Ok(root) = std::env::var("UGS_HISTORY_READ_FIXTURE") else { return; };
    let rel_path = std::env::var("UGS_HISTORY_READ_REL_PATH").unwrap_or_else(|_| SESSION.into());
    let actual: Value = serde_json::from_str(&history_read_at(Path::new(&root), &rel_path).unwrap().unwrap()).unwrap();
    let expected: Value = serde_json::from_str(&std::env::var("UGS_HISTORY_READ_EXPECTED").unwrap()).unwrap();
    assert_eq!(actual, expected); println!("fresh-read verified");
}
#[test]
fn legacy_json_is_read_by_a_fresh_process() {
    let root = fixture(); let expected = record();
    history_write_at(&root, SESSION, &expected.to_string(), false).unwrap();
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}

#[test]
fn final_save_compacts_journal_then_reads_portable_json_in_fresh_process() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("streaming").to_string(), true).unwrap();
    let mut final_record = original; final_record["messages"][0]["text"] = json!("final");
    history_write_at(&root, SESSION, &final_record.to_string(), false).unwrap();
    assert!(!journal_path(&root).exists());
    fresh_read(&root, &final_record); fs::remove_dir_all(root).unwrap();
}

#[test]
fn crash_after_atomic_compaction_does_not_replay_old_journal_even_if_content_returns_to_base() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("intermediate").to_string(), true).unwrap();
    let stale = fs::read(journal_path(&root)).unwrap();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    // Simulate death between the atomic JSON replacement and journal unlink.
    fs::write(journal_path(&root), stale).unwrap();
    fresh_read(&root, &original); fs::remove_dir_all(root).unwrap();
}

#[test]
fn truncated_tail_recovers_only_complete_entries_in_fresh_process() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    fs::OpenOptions::new().append(true).open(journal_path(&root)).unwrap()
        .write_all(b"{\"__ugsJournal\":1,\"fields\":").unwrap();
    let mut expected = original; expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("durable");
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}

#[test]
fn checkpoint_after_torn_tail_repairs_tail_without_losing_previous_fields() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    fs::OpenOptions::new().append(true).open(journal_path(&root)).unwrap().write_all(b"{torn").unwrap();
    let next = json!({"__ugsJournal":1,"fields":{"extra":true},"deleted":[],"messages":{"upserts":[{"id":"m","text":"next"}]}});
    history_write_at(&root, SESSION, &next.to_string(), true).unwrap();
    let mut expected = original; expected["title"] = json!("checkpoint"); expected["extra"] = json!(true); expected["messages"][0]["text"] = json!("next");
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}

#[test]
fn damaged_final_line_recovers_valid_prefix_even_when_tail_is_not_utf8() {
    for tail in [b"{broken}\n".as_slice(), &[0xff, 0xfe, b'\n']] {
        let root = fixture(); let original = record();
        history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
        history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
        fs::OpenOptions::new().append(true).open(journal_path(&root)).unwrap().write_all(tail).unwrap();
        let mut expected = original; expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("durable");
        fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn failed_atomic_replacement_does_not_truncate_base_or_clear_previous_journal() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let base_before = fs::read(root.join(SESSION)).unwrap(); let log_before = fs::read(journal_path(&root)).unwrap();
    let result = persist_json_file_with(&root.join(SESSION), &json!({"messages":[]}).to_string(), |_, _| Err("injected replacement failure".into()));
    assert!(result.is_err());
    assert_eq!(fs::read(root.join(SESSION)).unwrap(), base_before);
    assert_eq!(fs::read(journal_path(&root)).unwrap(), log_before);
    let mut expected = original; expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("durable");
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}

#[test]
fn unsupported_or_invalid_delta_is_rejected_before_modifying_previous_journal() {
    let root = fixture(); history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let before = fs::read(journal_path(&root)).unwrap();
    for bad in [json!({"__ugsJournal":2}), json!({"__ugsJournal":1,"fields":{"messages":[]},"deleted":[],"messages":{"upserts":[]}})] {
        assert!(history_write_at(&root, SESSION, &bad.to_string(), true).is_err());
        assert_eq!(fs::read(journal_path(&root)).unwrap(), before);
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn next_checkpoint_after_crash_compaction_starts_a_new_base_generation() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("intermediate").to_string(), true).unwrap();
    let stale = fs::read(journal_path(&root)).unwrap();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    fs::write(journal_path(&root), stale).unwrap();
    history_write_at(&root, SESSION, &delta("new generation").to_string(), true).unwrap();
    let mut expected = original; expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("new generation");
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}

#[test]
fn journal_budgets_reject_before_append_and_leave_previous_bytes_unchanged() {
    let root = fixture(); history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let before = fs::read(journal_path(&root)).unwrap();
    assert!(history_journal::append_with_limits(&root.join(SESSION), &delta("too large").to_string(), 10, u64::MAX).is_err());
    assert_eq!(fs::read(journal_path(&root)).unwrap(), before);
    assert!(history_journal::append_with_limits(&root.join(SESSION), &delta("log full").to_string(), usize::MAX, before.len() as u64).is_err());
    assert_eq!(fs::read(journal_path(&root)).unwrap(), before);
    history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    assert!(!journal_path(&root).exists()); fs::remove_dir_all(root).unwrap();
}

#[test]
fn concurrent_native_checkpoints_preserve_every_entry() {
    let root = fixture(); history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("initial").to_string(), true).unwrap();
    let start = std::sync::Arc::new(std::sync::Barrier::new(16));
    let handles = (0..16).map(|index| {
        let root = root.clone(); let start = start.clone();
        std::thread::spawn(move || {
            start.wait();
            let update = json!({"__ugsJournal":1,"fields":{format!("field_{index}"):index},"deleted":[],"messages":{"upserts":[]}});
            history_write_at(&root, SESSION, &update.to_string(), true)
        })
    }).collect::<Vec<_>>();
    for handle in handles { handle.join().unwrap().unwrap(); }
    let recovered: Value = serde_json::from_str(&history_read_at(&root, SESSION).unwrap().unwrap()).unwrap();
    for index in 0..16 { assert_eq!(recovered[format!("field_{index}")], index); }
    fresh_read(&root, &recovered); fs::remove_dir_all(root).unwrap();
}

#[test]
fn removal_cleans_journal_even_if_base_was_already_missing() {
    for missing in [false, true] {
        let root = fixture(); history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
        history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
        if missing { fs::remove_file(root.join(SESSION)).unwrap(); }
        history_remove_at(&root, SESSION, false).unwrap();
        assert!(!journal_path(&root).exists());
        assert!(history_read_at(&root, SESSION).unwrap().is_none()); fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn partial_append_failure_rolls_back_without_losing_previous_journal() {
    let root = fixture(); history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let before = fs::read(journal_path(&root)).unwrap();
    let mut file = fs::OpenOptions::new().read(true).write(true).open(journal_path(&root)).unwrap();
    let failure = history_journal::append_line_with(&mut file, delta("failed").to_string().as_bytes(), |file, bytes| {
        file.write_all(&bytes[..bytes.len() / 2])?;
        Err(std::io::Error::other("injected partial write failure"))
    });
    assert!(failure.is_err()); drop(file);
    assert_eq!(fs::read(journal_path(&root)).unwrap(), before);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_interrupted_initial_header_recovers_base_and_can_accept_the_next_checkpoint() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    fs::write(journal_path(&root), b"{\"__ugsJournalHeader\":1,").unwrap();
    fresh_read(&root, &original);
    history_write_at(&root, SESSION, &delta("after restart").to_string(), true).unwrap();
    let mut expected = original; expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("after restart");
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}

#[test]
fn oversized_journal_is_rejected_before_recovery_allocates_it() {
    let root = fixture(); history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    fs::OpenOptions::new().write(true).open(journal_path(&root)).unwrap().set_len(64 * 1024 * 1024 + 1).unwrap();
    assert!(history_read_at(&root, SESSION).unwrap_err().contains("HISTORY_JOURNAL_FULL"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn scheduled_session_checkpoints_keep_legacy_compatibility_without_rotating_backups() {
    let root = fixture(); let path = "scheduled-tasks/sessions/a.json"; let mut expected = record();
    history_write_at(&root, path, &expected.to_string(), false).unwrap();
    expected["title"] = json!("legacy checkpoint");
    history_write_at(&root, path, &expected.to_string(), true).unwrap();
    assert!(!root.join("backups").exists() || fs::read_dir(root.join("backups")).unwrap().next().is_none());
    fresh_read_at(&root, path, &expected);
    history_write_at(&root, path, &delta("scheduled delta").to_string(), true).unwrap();
    expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("scheduled delta");
    fresh_read_at(&root, path, &expected); fs::remove_dir_all(root).unwrap();
}

#[test]
fn checkpoint_migration_backs_up_the_legacy_base() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let mut migrated = original.clone();
    migrated["__ugsHistoryChunkVersion"] = json!(1);
    history_write_at(&root, SESSION, &migrated.to_string(), true).unwrap();
    let backups = root.join("backups/workspaces/fixture/sessions");
    let files = fs::read_dir(&backups).unwrap().map(|entry| entry.unwrap().path()).collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(&files[0]).unwrap()).unwrap(), original);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn compaction_generations_are_unique_even_if_the_wall_clock_does_not_advance() {
    assert_ne!(history_revision("same clock tick"), history_revision("same clock tick"));
}

#[test]
fn invalid_message_order_is_rejected_without_poisoning_the_durable_prefix() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let before = fs::read(journal_path(&root)).unwrap();
    let invalid = json!({"__ugsJournal":1,"fields":{},"deleted":[],"messages":{"upserts":[],"order":["missing"]}});
    assert!(history_write_at(&root, SESSION, &invalid.to_string(), true).is_err());
    assert_eq!(fs::read(journal_path(&root)).unwrap(), before);
    let mut expected = original; expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("durable");
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}

fn delta(text: &str) -> Value { json!({"__ugsJournal":1,"fields":{"title":"checkpoint"},"deleted":[],"messages":{"upserts":[{"id":"m","text":text}]}}) }
fn journal_path(root: &Path) -> PathBuf { root.join(format!("{SESSION}.journal")) }

#[test]
fn journal_hardlink_is_rejected_before_cached_append() {
    check_hardlink_rejection(false);
}
#[test]
fn journal_hardlink_is_rejected_before_tail_repair() {
    check_hardlink_rejection(true);
}
#[cfg(windows)]
#[test]
fn journal_parent_junction_is_rejected_before_external_append() {
    let root = fixture();
    history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let parent = journal_path(&root).parent().unwrap().to_path_buf();
    let external = root.with_extension("outside-sessions");
    fs::rename(&parent, &external).unwrap();
    let command = format!("mklink /J \"{}\" \"{}\"", parent.display().to_string().replace('/', "\\"), external.display().to_string().replace('/', "\\"));
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("cmd.exe").args(["/d", "/c"]).raw_arg(command).output().unwrap();
    assert!(output.status.success(), "real junction setup failed: {:?}", output);
    let target = external.join("a.json.journal");
    let before = fs::read(&target).unwrap();
    let result = history_write_at(&root, SESSION, &delta("blocked").to_string(), true);
    let after = fs::read(&target).unwrap();
    fs::remove_dir(&parent).unwrap();
    fs::remove_dir_all(&external).unwrap();
    fs::remove_dir_all(&root).unwrap();
    assert_eq!(after, before, "journal followed parent junction: {result:?}");
    assert!(result.is_err(), "journal parent reparse must be rejected");
}

#[cfg(windows)]
#[test]
fn journal_file_symlink_is_rejected_without_mutating_external_bytes() {
    let root = fixture();
    history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let journal = journal_path(&root);
    let external = root.with_extension("outside-symlink.journal");
    fs::rename(&journal, &external).unwrap();
    std::os::windows::fs::symlink_file(&external, &journal).expect("real file symlink required");
    let before = fs::read(&external).unwrap();
    let result = history_write_at(&root, SESSION, &delta("blocked").to_string(), true);
    let after = fs::read(&external).unwrap();
    fs::remove_file(&journal).unwrap();
    fs::remove_file(&external).unwrap();
    fs::remove_dir_all(&root).unwrap();
    assert_eq!(after, before);
    assert!(result.is_err(), "journal file reparse must be rejected");
}

#[cfg(windows)]
#[test]
fn journal_verified_handle_blocks_target_and_parent_substitution_then_writes_same_object() {
    let root = fixture();
    let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let journal = journal_path(&root);
    let parents = history_journal::history_journal_safety::lock_parents(&journal).unwrap();
    let mut file = history_journal::history_journal_safety::open(&journal).unwrap();
    assert!(fs::rename(&journal, root.with_extension("swap.journal")).is_err());
    assert!(fs::rename(journal.parent().unwrap(), root.with_extension("swap-parent")).is_err());
    let line = delta("same handle").to_string() + "\n";
    history_journal::append_line_with(&mut file, line.as_bytes(), |file, bytes| file.write_all(bytes)).unwrap();
    drop(file);
    drop(parents);
    let mut expected = original;
    expected["title"] = json!("checkpoint");
    expected["messages"][0]["text"] = json!("same handle");
    fresh_read(&root, &expected);
    fs::remove_dir_all(root).unwrap();
}

fn check_hardlink_rejection(torn: bool) {
    {
        let root = fixture();
        history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
        history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
        let journal = journal_path(&root);
        if torn {
            fs::OpenOptions::new().append(true).open(&journal).unwrap().write_all(b"{torn").unwrap();
        }
        // No journal metadata changes when adding an alias: exercise the cached
        // fast path as well as repair, using a real filesystem hardlink.
        let external = root.with_extension("outside.journal");
        fs::hard_link(&journal, &external).unwrap();
        let before = fs::read(&external).unwrap();
        let result = history_write_at(&root, SESSION, &delta("blocked").to_string(), true);
        let after = fs::read(&external).unwrap();
        fs::remove_file(&external).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(after, before, "external hardlink bytes changed; torn={torn}, result={result:?}");
        assert!(result.is_err(), "multiply linked journal must be rejected; torn={torn}");
    }
}
#[test]
fn incremental_checkpoint_preserves_legacy_base_and_recovers_in_fresh_process() {
    let root = fixture(); let original = record();
    history_write_at(&root, SESSION, &original.to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("streaming").to_string(), true).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&fs::read_to_string(root.join(SESSION)).unwrap()).unwrap(), original);
    assert!(journal_path(&root).exists());
    let mut expected = original; expected["title"] = json!("checkpoint"); expected["messages"][0]["text"] = json!("streaming");
    fresh_read(&root, &expected); fs::remove_dir_all(root).unwrap();
}
