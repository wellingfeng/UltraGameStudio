//! Single-library memory transactions. SQLite BEGIN IMMEDIATE gates processes;
//! publish is a synced atomic rename (never a truncating fallback). Intents
//! survive process death and readers reconcile only known before/after bytes.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    rel: String,
    before: Option<String>,
    after: String,
}

fn safe_chain(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("memory symlink/reparse path rejected".into())
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}
fn target(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let segments: Vec<_> = rel.split('/').collect();
    if segments.first() != Some(&"memories")
        || !rel.ends_with(".json")
        || segments.iter().any(|s| {
            s.is_empty()
                || s.starts_with('.')
                || s.ends_with('.')
                || s.ends_with(' ')
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
    {
        return Err("memory transaction path rejected".into());
    }
    let path = root.join(rel);
    safe_chain(&path)?;
    Ok(path)
}
struct Gate {
    _connection: rusqlite::Connection,
    state: PathBuf,
}
fn gate(root: &Path) -> Result<Gate, String> {
    let state = root.join("memories/.transactions");
    safe_chain(&state)?;
    fs::create_dir_all(&state).map_err(|e| e.to_string())?;
    let database = state.join("gate.sqlite");
    safe_chain(&database)?;
    let connection = rusqlite::Connection::open(database).map_err(|e| e.to_string())?;
    connection
        .busy_timeout(std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("memory process gate failed: {e}"))?;
    Ok(Gate {
        _connection: connection,
        state,
    })
}
fn read_raw(path: &Path) -> Result<Option<String>, String> {
    safe_chain(path)?;
    match fs::read_to_string(path) {
        Ok(raw) => {
            serde_json::from_str::<serde_json::Value>(&raw)
                .map_err(|e| format!("unknown/corrupt memory JSON: {e}"))?;
            Ok(Some(raw))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
#[cfg(windows)]
fn replace(stage: &Path, dest: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    // canonicalize adds the Windows extended-length prefix for deep fixtures.
    let stage = fs::canonicalize(stage).map_err(|e| e.to_string())?;
    let dest = fs::canonicalize(dest.parent().ok_or("missing destination parent")?)
        .map_err(|e| e.to_string())?
        .join(dest.file_name().ok_or("missing destination filename")?);
    let stage: Vec<u16> = stage.as_os_str().encode_wide().chain(Some(0)).collect();
    let dest: Vec<u16> = dest.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            stage.as_ptr(),
            dest.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(format!(
            "memory atomic replace failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}
#[cfg(not(windows))]
fn replace(stage: &Path, dest: &Path) -> Result<(), String> {
    fs::rename(stage, dest).map_err(|e| e.to_string())
}
fn publish(path: &Path, bytes: &[u8]) -> Result<(), String> {
    safe_chain(path)?;
    fs::create_dir_all(path.parent().ok_or("missing memory parent")?).map_err(|e| e.to_string())?;
    let stage = path.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    ));
    safe_chain(&stage)?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&stage)
        .map_err(|e| e.to_string())?;
    let staged = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = staged {
        let _ = fs::remove_file(&stage);
        return Err(error.to_string());
    }
    if let Err(error) = replace(&stage, path) {
        let _ = fs::remove_file(&stage);
        return Err(error);
    }
    #[cfg(unix)]
    fs::File::open(path.parent().unwrap())
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn intent_path(state: &Path, rel: &str) -> PathBuf {
    state.join(format!(
        "{}.intent.json",
        hex::encode(Sha256::digest(rel.as_bytes()))
    ))
}
fn recover(root: &Path, state: &Path, rel: &str) -> Result<(), String> {
    let intent_path = intent_path(state, rel);
    let Some(raw) = read_raw(&intent_path)? else {
        return Ok(());
    };
    let intent: Intent = serde_json::from_str(&raw)
        .map_err(|e| format!("memory needs_recovery: invalid intent: {e}"))?;
    if intent.version != 1 || intent.rel != rel {
        return Err("memory needs_recovery: intent identity mismatch".into());
    }
    let current = read_raw(&target(root, rel)?)?;
    if current.as_deref() != Some(&intent.after) && current != intent.before {
        return Err("memory needs_recovery: external edit; before/after retained".into());
    }
    fs::remove_file(intent_path).map_err(|e| format!("memory needs_recovery: {e}"))?;
    Ok(())
}

pub(crate) fn read_at(root: &Path, rel: &str) -> Result<Option<String>, String> {
    let path = target(root, rel)?;
    let lock = gate(root)?;
    recover(root, &lock.state, rel)?;
    let raw = read_raw(&path)?;
    if let Some(json) = &raw {
        validate_memory_json(rel, json)?;
    }
    Ok(raw)
}

fn allowed_keys(value: &serde_json::Map<String, serde_json::Value>, allowed: &[&str]) -> bool {
    value.keys().all(|key| allowed.contains(&key.as_str()))
}
fn valid_entries(value: &serde_json::Value) -> bool {
    value.as_array().is_some_and(|entries| {
        entries.iter().all(|entry| {
            if let Some(text) = entry.as_str() {
                return !text.trim().is_empty();
            }
            entry.as_object().is_some_and(|entry| {
                allowed_keys(entry, &["id", "text", "updatedAt", "importance"])
                    && entry
                        .get("text")
                        .and_then(|v| v.as_str())
                        .is_some_and(|s| !s.trim().is_empty())
                    && entry
                        .get("id")
                        .is_none_or(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                    && entry.get("updatedAt").is_none_or(|v| v.is_number())
                    && entry.get("importance").is_none_or(|v| {
                        v.as_str().is_some_and(|s| {
                            [
                                "must",
                                "important",
                                "minor",
                                "critical",
                                "必须",
                                "重要",
                                "low",
                                "trivial",
                                "不重要",
                            ]
                            .contains(&s.trim().to_lowercase().as_str())
                        })
                    })
            })
        })
    })
}
fn valid_count(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|count| count <= 9_007_199_254_740_991)
}

fn nonempty_text(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

fn known_fields(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|object| allowed_keys(object, keys))
}

fn valid_review_source(value: &Value) -> bool {
    known_fields(
        value,
        &[
            "hostId",
            "namespaceId",
            "workspaceId",
            "sessionId",
            "turnId",
            "sourceMessageId",
            "runId",
            "cwd",
        ],
    ) && [
        "hostId",
        "namespaceId",
        "sessionId",
        "turnId",
        "sourceMessageId",
        "runId",
    ]
    .iter()
    .all(|key| nonempty_text(&value[*key]))
        && value["workspaceId"].is_string()
        && value.get("cwd").is_none_or(nonempty_text)
}

fn valid_confirmation(value: &Value) -> bool {
    known_fields(
        value,
        &[
            "provenance",
            "legacyId",
            "confirmedAt",
            "workspaceId",
            "sessionId",
            "sourceMessageId",
            "message",
        ],
    ) && value["provenance"] == "user_confirmed_rebinding"
        && ["legacyId", "sessionId", "sourceMessageId"]
            .iter()
            .all(|key| nonempty_text(&value[*key]))
        && value["workspaceId"].is_string()
        && valid_count(&value["confirmedAt"])
        && value["message"].is_object()
        && value["message"]["role"] == "user"
        && value["message"]["id"] == value["sourceMessageId"]
        && value["message"]["text"].is_string()
}

fn valid_string_list(value: &Value, max: usize) -> bool {
    value.as_array().is_some_and(|items| {
        let mut seen = std::collections::HashSet::new();
        items.len() <= max
            && items
                .iter()
                .all(|item| nonempty_text(item) && seen.insert(item.as_str()))
    })
}

fn valid_pairs(value: &Value, valid_value: impl Fn(&Value) -> bool) -> bool {
    value.as_array().is_some_and(|items| {
        let mut seen = std::collections::HashSet::new();
        items.len() <= 128
            && items.iter().all(|item| {
                item.as_array().is_some_and(|pair| {
                    pair.len() == 2
                        && nonempty_text(&pair[0])
                        && seen.insert(pair[0].as_str())
                        && valid_value(&pair[1])
                })
            })
    })
}

fn valid_review_journal(value: &Value) -> bool {
    let scheduler = &value["scheduler"];
    if !known_fields(value, &["version", "scheduler", "jobs"])
        || value["version"] != 1
        || !known_fields(
            scheduler,
            &[
                "consumed",
                "attempted",
                "lastCompleted",
                "consumedFence",
                "attemptedFence",
            ],
        )
        || !valid_pairs(&scheduler["consumed"], |ids| valid_string_list(ids, 256))
        || !valid_string_list(&scheduler["attempted"], 256)
        || !valid_pairs(&scheduler["lastCompleted"], valid_count)
        || ["consumedFence", "attemptedFence"].iter().any(|key| {
            scheduler.get(*key).is_some_and(|fence| {
                !fence.as_array().is_some_and(|words| {
                    words.len() == 2048
                        && words
                            .iter()
                            .all(|word| word.as_u64().is_some_and(|n| n <= u32::MAX as u64))
                })
            })
        })
    {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    value["jobs"].as_array().is_some_and(|jobs| {
        jobs.len() <= 100
            && jobs.iter().all(|job| {
                known_fields(
                    job,
                    &[
                        "id",
                        "source",
                        "phase",
                        "appliedOps",
                        "queuedOps",
                        "updatedAt",
                        "assistantMessageId",
                        "error",
                        "usage",
                        "recordingError",
                    ],
                ) && nonempty_text(&job["id"])
                    && seen.insert(job["id"].as_str())
                    && valid_review_source(&job["source"])
                    && matches!(
                        job["phase"].as_str(),
                        Some(
                            "reading"
                                | "applied"
                                | "awaiting_approval"
                                | "noop"
                                | "failed"
                                | "cancelled"
                        )
                    )
                    && ["appliedOps", "queuedOps", "updatedAt"]
                        .iter()
                        .all(|key| valid_count(&job[*key]))
                    && job.get("assistantMessageId").is_none_or(nonempty_text)
                    && ["error", "recordingError"]
                        .iter()
                        .all(|key| job.get(*key).is_none_or(Value::is_string))
                    && job.get("usage").is_none_or(|usage| {
                        known_fields(
                            usage,
                            &["calls", "inputTokens", "outputTokens", "estimated"],
                        ) && valid_count(&usage["calls"])
                            && valid_count(&usage["inputTokens"])
                            && usage.get("outputTokens").is_none_or(valid_count)
                            && usage["estimated"].is_boolean()
                    })
            })
    })
}

fn valid_commit_receipt(receipt: &Value) -> bool {
    known_fields(
        receipt,
        &[
            "id",
            "signature",
            "appliedCount",
            "skippedCount",
            "target",
            "workspaceId",
            "reviewSource",
            "sourceConfirmation",
            "before",
            "after",
            "afterRevision",
            "undoes",
        ],
    ) && nonempty_text(&receipt["id"])
        && receipt["signature"].is_string()
        && valid_count(&receipt["appliedCount"])
        && valid_count(&receipt["skippedCount"])
        && receipt
            .get("target")
            .is_none_or(|target| matches!(target.as_str(), Some("memory" | "user")))
        && receipt.get("workspaceId").is_none_or(Value::is_string)
        && ["afterRevision", "undoes"]
            .iter()
            .all(|key| receipt.get(*key).is_none_or(nonempty_text))
        && receipt.get("reviewSource").is_none_or(valid_review_source)
        && receipt
            .get("sourceConfirmation")
            .is_none_or(valid_confirmation)
        && ["before", "after"].iter().all(|key| {
            receipt.get(*key).is_none_or(|entries| {
                valid_entries(entries)
                    && entries
                        .as_array()
                        .is_some_and(|items| items.iter().all(Value::is_object))
            })
        })
}

fn validate_memory_json(rel: &str, json: &str) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid memory JSON: {e}"))?;
    let object = value
        .as_object()
        .ok_or("Unknown memory JSON schema; refusing overwrite")?;
    let version = object
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or("Unknown memory JSON version")?;
    if ![1, 2].contains(&version) {
        return Err("Unknown memory JSON version; refusing overwrite".into());
    }
    if rel == "memories/review-jobs.v1.json" {
        return if valid_review_journal(&value) {
            Ok(())
        } else {
            Err("Invalid memory review journal; refusing overwrite".into())
        };
    }
    if rel.starts_with("memories/snapshots/") {
        if version != 1
            || !allowed_keys(
                object,
                &["version", "workspaceId", "freezeKey", "full", "compact"],
            )
            || !object
                .get("workspaceId")
                .is_some_and(|v| v.is_null() || v.is_string())
            || !["freezeKey", "full", "compact"]
                .iter()
                .all(|key| object.get(*key).is_some_and(|v| v.is_string()))
        {
            return Err("Unknown session snapshot JSON; refusing live replacement".into());
        }
        return Ok(());
    }
    if rel == "memories/pending.json" {
        if !allowed_keys(object, &["version", "writes"])
            || !object.get("writes").is_some_and(|v| v.is_array())
        {
            return Err("Unknown pending JSON schema; refusing overwrite".into());
        }
    } else if !allowed_keys(object, &["version", "entries", "revision", "receipts"])
        || !object.get("entries").is_some_and(valid_entries)
        || object.get("revision").is_some_and(|v| !v.is_string())
        || object.get("receipts").is_some_and(|v| {
            !v.as_array()
                .is_some_and(|receipts| receipts.iter().all(valid_commit_receipt))
        })
    {
        return Err("Unknown/invalid memory JSON entries; refusing overwrite".into());
    }
    Ok(())
}

pub(crate) fn compare_exchange_at(
    root: &Path,
    rel: &str,
    expected: Option<&str>,
    json: &str,
) -> Result<String, String> {
    if json.len() > 4 * 1024 * 1024 {
        return Err("memory JSON exceeds hard size limit".into());
    }
    validate_memory_json(rel, json)?;
    let path = target(root, rel)?;
    let lock = gate(root)?;
    recover(root, &lock.state, rel)?;
    let before = read_raw(&path)?;
    if let Some(raw) = &before {
        validate_memory_json(rel, raw)?;
    }
    if before.as_deref() != expected {
        return Err("memory CAS conflict: exact bytes changed".into());
    }
    if before.as_deref() == Some(json) {
        return Ok(json.into());
    }
    let intent = Intent {
        version: 1,
        rel: rel.into(),
        before,
        after: json.into(),
    };
    let encoded = serde_json::to_vec(&intent).map_err(|e| e.to_string())?;
    // Last transaction's complete before/after is a durable recovery/backup record.
    publish(
        &lock.state.join(format!(
            "{}.backup.json",
            hex::encode(Sha256::digest(rel.as_bytes()))
        )),
        &encoded,
    )?;
    publish(&intent_path(&lock.state, rel), &encoded)?;
    #[cfg(test)]
    if std::env::var("UGS_MEMORY_TEST_FAILPOINT").as_deref() == Ok("before_publish") {
        std::process::exit(77);
    }
    if let Err(error) = publish(&path, json.as_bytes()) {
        recover(root, &lock.state, rel)?;
        return Err(error);
    }
    #[cfg(test)]
    if std::env::var("UGS_MEMORY_TEST_FAILPOINT").as_deref() == Ok("after_publish") {
        std::process::exit(77);
    }
    if read_raw(&path)?.as_deref() != Some(json) {
        return Err("memory needs_recovery: committed readback mismatch".into());
    }
    recover(root, &lock.state, rel)?;
    Ok(json.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    fn fixture() -> PathBuf {
        let base = PathBuf::from(
            std::env::var("UGS_MEMORY_TEST_ROOT").expect("explicit scratch fixture root"),
        );
        let root = base.join(format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn exact_cas_reads_real_file_and_preserves_later_edit() {
        let root = fixture();
        let rel = "memories/user.json";
        let a = r#"{"version":2,"entries":[{"text":"alpha"}]}"#;
        let b = r#"{"version":2,"entries":[{"text":"beta"}]}"#;
        assert_eq!(compare_exchange_at(&root, rel, None, a).unwrap(), a);
        assert_eq!(read_at(&root, rel).unwrap().as_deref(), Some(a));
        assert!(compare_exchange_at(&root, rel, None, b)
            .unwrap_err()
            .contains("conflict"));
        assert_eq!(std::fs::read_to_string(root.join(rel)).unwrap(), a);
        assert_eq!(compare_exchange_at(&root, rel, Some(a), b).unwrap(), b);
    }

    #[test]
    fn session_snapshot_is_durable_and_cannot_be_replaced_from_absent_base() {
        let root = fixture();
        let rel = "memories/snapshots/6161.json";
        let json = r#"{"version":1,"workspaceId":"A","freezeKey":"s","full":"original","compact":"original"}"#;
        assert_eq!(compare_exchange_at(&root, rel, None, json).unwrap(), json);
        assert_eq!(read_at(&root, rel).unwrap().as_deref(), Some(json));
        assert!(compare_exchange_at(&root, rel, None, json)
            .unwrap_err()
            .contains("conflict"));
    }

    #[test]
    fn review_journal_uses_its_own_schema_and_survives_fresh_process_read() {
        let root = fixture();
        let rel = "memories/review-jobs.v1.json";
        let source = serde_json::json!({"hostId":"local","namespaceId":"local","workspaceId":"A",
            "sessionId":"s","turnId":"u","sourceMessageId":"u","runId":"r"});
        let json = serde_json::json!({"version":1,"scheduler":{"consumed":[],"attempted":["job"],"lastCompleted":[]},
            "jobs":[{"id":"job","source":source,"phase":"reading","appliedOps":0,"queuedOps":0,"updatedAt":1000}]}).to_string();
        assert_eq!(compare_exchange_at(&root, rel, None, &json).unwrap(), json);
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "memory_transactions::tests::fresh_read_child",
                "--ignored",
            ])
            .env("UGS_MEMORY_CHILD_ROOT", &root)
            .env("UGS_MEMORY_CHILD_REL", rel)
            .env("UGS_MEMORY_CHILD_JSON", &json)
            .status()
            .unwrap();
        assert!(
            child.success(),
            "fresh process must restore exact journal bytes"
        );
    }

    #[test]
    fn review_journal_optional_assistant_binding_survives_fresh_process_without_normalizing_bytes()
    {
        for assistant_id in ["a1", "  exact assistant ID  "] {
            let root = fixture();
            let rel = "memories/review-jobs.v1.json";
            let value = serde_json::json!({"version":1,"scheduler":{"consumed":[],"attempted":["job"],"lastCompleted":[]},
                "jobs":[{"id":"job","source":{"hostId":"local","namespaceId":"local","workspaceId":"A",
                    "sessionId":"s","turnId":"u","sourceMessageId":"u","runId":"r"},
                    "assistantMessageId":assistant_id,"phase":"applied","appliedOps":1,"queuedOps":0,"updatedAt":1000}]});
            let raw = format!("  {value}\n");
            assert_eq!(compare_exchange_at(&root, rel, None, &raw).unwrap(), raw);
            assert_eq!(read_at(&root, rel).unwrap().as_deref(), Some(raw.as_str()));
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "memory_transactions::tests::fresh_read_child",
                    "--ignored",
                ])
                .env("UGS_MEMORY_CHILD_ROOT", &root)
                .env("UGS_MEMORY_CHILD_REL", rel)
                .env("UGS_MEMORY_CHILD_JSON", &raw)
                .status()
                .unwrap();
            assert!(
                child.success(),
                "fresh process must preserve the exact assistant binding bytes"
            );
        }
    }

    #[test]
    fn malformed_assistant_bindings_and_unknown_journal_fields_never_replace_bytes() {
        let valid = serde_json::json!({"version":1,"scheduler":{"consumed":[],"attempted":[],"lastCompleted":[]},
            "jobs":[{"id":"job","source":{"hostId":"local","namespaceId":"local","workspaceId":"A",
                "sessionId":"s","turnId":"u","sourceMessageId":"u","runId":"r"},
                "phase":"applied","appliedOps":1,"queuedOps":0,"updatedAt":1000,
                "usage":{"calls":1,"inputTokens":2,"estimated":true}}]});
        let mut cases = Vec::new();
        for bad in [
            serde_json::json!(""),
            serde_json::json!(null),
            serde_json::json!(12),
            serde_json::json!(false),
            serde_json::json!(["a1"]),
            serde_json::json!({"id":"a1"}),
        ] {
            let mut value = valid.clone();
            value["jobs"][0]["assistantMessageId"] = bad;
            cases.push(value);
        }
        for pointer in [
            "",
            "/scheduler",
            "/jobs/0",
            "/jobs/0/source",
            "/jobs/0/usage",
        ] {
            let mut value = valid.clone();
            value.pointer_mut(pointer).unwrap()["futureField"] = serde_json::json!(true);
            cases.push(value);
        }
        for value in cases {
            let root = fixture();
            let rel = "memories/review-jobs.v1.json";
            let valid_raw = valid.to_string();
            compare_exchange_at(&root, rel, None, &valid_raw).unwrap();
            let raw = format!("  {value}\n");
            assert!(compare_exchange_at(&root, rel, Some(&valid_raw), &raw).is_err());
            assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), valid_raw);
            fs::write(root.join(rel), &raw).unwrap();
            assert!(read_at(&root, rel).is_err());
            assert!(compare_exchange_at(&root, rel, Some(&raw), &valid_raw).is_err());
            assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), raw);
        }
    }

    #[test]
    #[ignore = "fresh-process read entry, called with an isolated scratch root"]
    fn fresh_read_child() {
        let root = PathBuf::from(std::env::var_os("UGS_MEMORY_CHILD_ROOT").unwrap());
        let rel = std::env::var("UGS_MEMORY_CHILD_REL").unwrap();
        let expected = std::env::var("UGS_MEMORY_CHILD_JSON").unwrap();
        assert_eq!(
            read_at(&root, &rel).unwrap().as_deref(),
            Some(expected.as_str())
        );
    }

    #[test]
    fn extended_commit_receipt_roundtrips_and_undo_retains_original_audit() {
        let root = fixture();
        let rel = "memories/workspaces/A/memory.json";
        let receipt = serde_json::json!({"id":"batch","signature":"exact-batch","appliedCount":1,"skippedCount":0,
            "target":"memory","workspaceId":"A","before":[{"id":"entry","text":"before"}],
            "after":[{"id":"entry","text":"after"}],"afterRevision":"r1",
            "sourceConfirmation":{"provenance":"user_confirmed_rebinding","legacyId":"legacy","confirmedAt":1000,
                "workspaceId":"A","sessionId":"s","sourceMessageId":"u","message":{"id":"u","role":"user","text":"saved source"}}});
        let first = serde_json::json!({"version":2,"entries":receipt["after"],"revision":"r1","receipts":[receipt.clone()]}).to_string();
        assert_eq!(
            compare_exchange_at(&root, rel, None, &first).unwrap(),
            first
        );
        let mut undo = receipt.clone();
        undo["id"] = serde_json::json!("undo:batch");
        undo["undoes"] = serde_json::json!("batch");
        undo["before"] = receipt["after"].clone();
        undo["after"] = receipt["before"].clone();
        undo["afterRevision"] = serde_json::json!("r2");
        let second = serde_json::json!({"version":2,"entries":receipt["before"],"revision":"r2","receipts":[receipt,undo]}).to_string();
        assert_eq!(
            compare_exchange_at(&root, rel, Some(&first), &second).unwrap(),
            second
        );
        assert_eq!(
            read_at(&root, rel).unwrap().as_deref(),
            Some(second.as_str())
        );
        assert!(compare_exchange_at(&root, rel, Some(&first), &first)
            .unwrap_err()
            .contains("conflict"));
        assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), second);
    }

    #[test]
    fn unknown_schema_is_not_overwritten_even_with_exact_bytes() {
        let root = fixture();
        let rel = "memories/user.json";
        fs::create_dir_all(root.join("memories")).unwrap();
        let unknown = r#"{"version":999,"entries":[]}"#;
        fs::write(root.join(rel), unknown).unwrap();
        assert!(read_at(&root, rel).is_err());
        assert!(
            compare_exchange_at(&root, rel, Some(unknown), r#"{"version":2,"entries":[]}"#)
                .is_err()
        );
        assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), unknown);
    }

    #[test]
    fn malformed_review_journal_is_preserved_instead_of_being_repaired_or_overwritten() {
        let valid = serde_json::json!({"version":1,"scheduler":{"consumed":[],"attempted":[],"lastCompleted":[]},"jobs":[]});
        let mut cases = Vec::new();
        for (field, bad) in [
            ("consumed", serde_json::json!([["session", ["u", "u"]]])),
            ("attempted", serde_json::json!(["job", "job"])),
            ("lastCompleted", serde_json::json!([["scope", -1]])),
            ("consumedFence", serde_json::json!([0])),
        ] {
            let mut value = valid.clone();
            value["scheduler"][field] = bad;
            cases.push(value);
        }
        let mut unknown = valid.clone();
        unknown["futureVersionField"] = serde_json::json!(true);
        cases.push(unknown);
        let mut invalid_source = valid.clone();
        invalid_source["jobs"] = serde_json::json!([{"id":"job","source":{"workspaceId":"A"},"phase":"reading","appliedOps":0,"queuedOps":0,"updatedAt":1000}]);
        cases.push(invalid_source);
        for value in cases {
            let root = fixture();
            let rel = "memories/review-jobs.v1.json";
            fs::create_dir_all(root.join("memories")).unwrap();
            let raw = value.to_string();
            fs::write(root.join(rel), &raw).unwrap();
            assert!(read_at(&root, rel).is_err());
            assert!(compare_exchange_at(&root, rel, Some(&raw), &valid.to_string()).is_err());
            assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), raw);
        }
    }

    #[test]
    fn malformed_receipt_extensions_never_replace_existing_bytes() {
        let valid = serde_json::json!({"version":2,"entries":[],"receipts":[{"id":"old","signature":"s","appliedCount":1,"skippedCount":0}]});
        for (field, bad) in [
            (
                "sourceConfirmation",
                serde_json::json!({"provenance":"fabricated"}),
            ),
            ("reviewSource", serde_json::json!({"workspaceId":"A"})),
            (
                "before",
                serde_json::json!([{"text":"bad","injected":true}]),
            ),
            ("after", serde_json::json!([42])),
            ("afterRevision", serde_json::json!(12)),
            ("mystery", serde_json::json!(true)),
        ] {
            let root = fixture();
            let rel = "memories/user.json";
            fs::create_dir_all(root.join("memories")).unwrap();
            let mut value = valid.clone();
            value["receipts"][0][field] = bad;
            let raw = value.to_string();
            fs::write(root.join(rel), &raw).unwrap();
            assert!(read_at(&root, rel).is_err());
            assert!(compare_exchange_at(&root, rel, Some(&raw), &valid.to_string()).is_err());
            assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), raw);
        }
    }

    #[cfg(windows)]
    #[test]
    fn memory_junction_cannot_redirect_transaction_reads_or_writes() {
        let root = fixture();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let original = r#"{"version":2,"entries":[{"text":"outside"}]}"#;
        fs::write(outside.join("user.json"), original).unwrap();
        let link = root.join("memories");
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(outside.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture could not be created: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(read_at(&root, "memories/user.json").is_err());
        assert!(compare_exchange_at(
            &root,
            "memories/user.json",
            Some(original),
            r#"{"version":2,"entries":[]}"#
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(outside.join("user.json")).unwrap(),
            original
        );
        fs::remove_dir(link).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_publish_reconciles_before_and_after_without_inventing_success() {
        for phase in ["before_publish", "after_publish"] {
            let root = fixture();
            let rel = "memories/user.json";
            let before = r#"{"version":2,"entries":[{"text":"before"}]}"#;
            let after = r#"{"version":2,"entries":[{"text":"after"}]}"#;
            compare_exchange_at(&root, rel, None, before).unwrap();
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "memory_transactions::tests::transaction_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("UGS_MEMORY_CHILD_ROOT", &root)
                .env("UGS_MEMORY_TEST_FAILPOINT", phase)
                .status()
                .unwrap();
            assert_eq!(child.code(), Some(77));
            let expected = if phase == "before_publish" {
                before
            } else {
                after
            };
            assert_eq!(read_at(&root, rel).unwrap().as_deref(), Some(expected));
            assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), expected);
            assert!(!intent_path(&root.join("memories/.transactions"), rel).exists());
        }
    }

    #[test]
    #[ignore = "child process entry, invoked with an isolated scratch root"]
    fn transaction_child() {
        let Some(root) = std::env::var_os("UGS_MEMORY_CHILD_ROOT") else {
            return;
        };
        let before = r#"{"version":2,"entries":[{"text":"before"}]}"#;
        let after = r#"{"version":2,"entries":[{"text":"after"}]}"#;
        compare_exchange_at(
            &PathBuf::from(root),
            "memories/user.json",
            Some(before),
            after,
        )
        .unwrap();
    }

    #[test]
    fn concurrent_process_cas_has_one_winner_and_one_explicit_conflict() {
        let root = fixture();
        let rel = "memories/user.json";
        let before = r#"{"version":2,"entries":[{"text":"before"}]}"#;
        compare_exchange_at(&root, rel, None, before).unwrap();
        let spawn = || {
            std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "memory_transactions::tests::race_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("UGS_MEMORY_CHILD_ROOT", &root)
                .spawn()
                .unwrap()
        };
        let mut first = spawn();
        let mut second = spawn();
        let mut codes = vec![first.wait().unwrap().code(), second.wait().unwrap().code()];
        codes.sort();
        assert_eq!(codes, vec![Some(0), Some(3)]);
        assert_eq!(
            read_at(&root, rel).unwrap().unwrap(),
            r#"{"version":2,"entries":[{"text":"after"}]}"#
        );
    }

    #[test]
    #[ignore = "child process race entry"]
    fn race_child() {
        let root = PathBuf::from(std::env::var_os("UGS_MEMORY_CHILD_ROOT").unwrap());
        let result = compare_exchange_at(
            &root,
            "memories/user.json",
            Some(r#"{"version":2,"entries":[{"text":"before"}]}"#),
            r#"{"version":2,"entries":[{"text":"after"}]}"#,
        );
        match result {
            Ok(_) => std::process::exit(0),
            Err(error) if error.contains("conflict") => std::process::exit(3),
            Err(error) => panic!("{error}"),
        }
    }

    #[test]
    fn corrupt_file_and_ambiguous_recovery_are_preserved() {
        let root = fixture();
        let rel = "memories/user.json";
        fs::create_dir_all(root.join("memories")).unwrap();
        fs::write(root.join(rel), "{broken").unwrap();
        assert!(read_at(&root, rel).is_err());
        assert!(compare_exchange_at(&root, rel, None, r#"{"version":2,"entries":[]}"#).is_err());
        assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), "{broken");
        let external = r#"{"version":2,"entries":[{"text":"external"}]}"#;
        fs::write(root.join(rel), external).unwrap();
        let state = root.join("memories/.transactions");
        let intent = Intent {
            version: 1,
            rel: rel.into(),
            before: None,
            after: r#"{"version":2,"entries":[]}"#.into(),
        };
        publish(
            &intent_path(&state, rel),
            &serde_json::to_vec(&intent).unwrap(),
        )
        .unwrap();
        assert!(read_at(&root, rel).unwrap_err().contains("needs_recovery"));
        assert_eq!(fs::read_to_string(root.join(rel)).unwrap(), external);
        assert!(intent_path(&state, rel).exists());
    }

    #[cfg(windows)]
    #[test]
    fn occupied_file_preserves_before_and_never_truncates() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = fixture();
        let rel = "memories/user.json";
        let before = r#"{"version":2,"entries":[{"text":"before"}]}"#;
        compare_exchange_at(&root, rel, None, before).unwrap();
        let occupied = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(root.join(rel))
            .unwrap();
        assert!(
            compare_exchange_at(&root, rel, Some(before), r#"{"version":2,"entries":[]}"#).is_err()
        );
        drop(occupied);
        assert_eq!(read_at(&root, rel).unwrap().as_deref(), Some(before));
    }
}
