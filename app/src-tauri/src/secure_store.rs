use std::collections::HashMap;
#[cfg(not(windows))]
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(windows)]
#[path = "secure_store_windows.rs"]
mod windows_store;

const SERVICE_NAME: &str = "UltraGameStudio";
const MAX_SECRET_KEY_LEN: usize = 160;
// Legacy sharding remains the non-Windows write path and Windows migration input.
#[cfg(not(windows))]
const MAX_SECRET_CHUNK_UTF16_UNITS: usize = 1000;
const CHUNK_MANIFEST_PREFIX: &str = "UGS_CHUNKED_SECRET_V1:";
#[cfg(not(windows))]
static CHUNK_GENERATION: AtomicU64 = AtomicU64::new(1);

fn normalize_secret_key(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("安全存储 key 不能为空。".to_string());
    }
    if trimmed.len() > MAX_SECRET_KEY_LEN {
        return Err("安全存储 key 过长。".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
    {
        return Err("安全存储 key 包含非法字符。".to_string());
    }
    Ok(trimmed.to_string())
}

fn entry_for_key(key: &str) -> Result<keyring::Entry, String> {
    let key = normalize_secret_key(key)?;
    keyring::Entry::new(SERVICE_NAME, &key).map_err(|e| format!("打开系统安全存储失败: {e}"))
}

fn raw_secret_get(key: &str) -> Result<Option<String>, String> {
    let entry = entry_for_key(key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("读取系统安全存储失败: {err}")),
    }
}

#[cfg(any(not(windows), test))]
fn raw_secret_set(key: &str, value: &str) -> Result<(), String> {
    entry_for_key(key)?
        .set_password(value)
        .map_err(|e| format!("写入系统安全存储失败: {e}"))
}

#[cfg(any(not(windows), test))]
fn raw_secret_delete(key: &str) -> Result<(), String> {
    match entry_for_key(key)?.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("删除系统安全存储失败: {err}")),
    }
}

fn stable_key_hash(value: &str) -> u64 {
    // FNV-1a: deterministic across processes, compact, and sufficient for
    // deriving private keychain entry names from an already-validated key.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn chunk_key(key: &str, generation: &str, index: usize) -> String {
    format!(
        "ugs.secret.chunk.{:016x}.{generation}.{index}",
        stable_key_hash(key)
    )
}

#[cfg(any(not(windows), test))]
fn chunk_manifest(generation: &str, count: usize) -> String {
    format!("{CHUNK_MANIFEST_PREFIX}{generation}:{count}")
}

fn parse_chunk_manifest(value: &str) -> Option<(&str, usize)> {
    let rest = value.strip_prefix(CHUNK_MANIFEST_PREFIX)?;
    let (generation, count) = rest.rsplit_once(':')?;
    if generation.is_empty() {
        return None;
    }
    let count = count.parse::<usize>().ok()?;
    (count > 0).then_some((generation, count))
}

#[cfg(not(windows))]
fn split_secret_chunks(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut utf16_units = 0;
    for ch in value.chars() {
        let char_units = ch.len_utf16();
        if !current.is_empty() && utf16_units + char_units > MAX_SECRET_CHUNK_UTF16_UNITS {
            chunks.push(std::mem::take(&mut current));
            utf16_units = 0;
        }
        current.push(ch);
        utf16_units += char_units;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[cfg(not(windows))]
fn delete_manifest_chunks(key: &str, manifest: &str) {
    let Some((generation, count)) = parse_chunk_manifest(manifest) else {
        return;
    };
    for index in 0..count {
        let _ = raw_secret_delete(&chunk_key(key, generation, index));
    }
}

fn legacy_secret_get_blocking(key: String) -> Result<Option<String>, String> {
    let Some(value) = raw_secret_get(&key)? else {
        return Ok(None);
    };
    let Some((generation, count)) = parse_chunk_manifest(&value) else {
        #[cfg(windows)]
        if value.starts_with(CHUNK_MANIFEST_PREFIX) {
            return Err("系统安全存储分片索引损坏。".into());
        }
        return Ok(Some(value));
    };
    let mut combined = String::new();
    for index in 0..count {
        let part_key = chunk_key(&key, generation, index);
        let part = raw_secret_get(&part_key)?
            .ok_or_else(|| format!("系统安全存储分片缺失: {part_key}"))?;
        combined.push_str(&part);
    }
    Ok(Some(combined))
}

#[cfg(all(windows, test))]
fn secure_secret_get_blocking(key: String) -> Result<Option<String>, String> {
    let key = normalize_secret_key(&key)?;
    windows_store::Store::open(&key)?.get(|| legacy_secret_get_blocking(key))
}

#[cfg(not(windows))]
fn secure_secret_get_blocking(key: String) -> Result<Option<String>, String> {
    legacy_secret_get_blocking(key)
}

#[cfg(windows)]
fn secure_secret_set_blocking(key: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return secure_secret_delete_blocking(key);
    }
    windows_store::Store::open(&key)?.write(Some(&value))
}

#[cfg(not(windows))]
fn secure_secret_set_blocking(key: String, value: String) -> Result<(), String> {
    if value.is_empty() {
        return secure_secret_delete_blocking(key);
    }
    let previous = raw_secret_get(&key)?;
    if value.encode_utf16().count() <= MAX_SECRET_CHUNK_UTF16_UNITS {
        raw_secret_set(&key, &value)?;
        if let Some(manifest) = previous.as_deref() {
            delete_manifest_chunks(&key, manifest);
        }
        return Ok(());
    }

    let generation = format!(
        "{:x}-{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        CHUNK_GENERATION.fetch_add(1, Ordering::Relaxed),
    );
    let chunks = split_secret_chunks(&value);
    let mut written: Vec<String> = Vec::with_capacity(chunks.len());
    for (index, chunk) in chunks.iter().enumerate() {
        let part_key = chunk_key(&key, &generation, index);
        if let Err(err) = raw_secret_set(&part_key, chunk) {
            for written_key in written {
                let _ = raw_secret_delete(&written_key);
            }
            return Err(err);
        }
        written.push(part_key);
    }
    let manifest = chunk_manifest(&generation, chunks.len());
    if let Err(err) = raw_secret_set(&key, &manifest) {
        for written_key in written {
            let _ = raw_secret_delete(&written_key);
        }
        return Err(err);
    }
    if let Some(old_manifest) = previous.as_deref() {
        delete_manifest_chunks(&key, old_manifest);
    }
    Ok(())
}

#[cfg(windows)]
fn secure_secret_delete_blocking(key: String) -> Result<(), String> {
    // Keep an encrypted tombstone; removing the file would resurrect legacy keys.
    windows_store::Store::open(&key)?.write(None)
}

#[cfg(not(windows))]
fn secure_secret_delete_blocking(key: String) -> Result<(), String> {
    let previous = raw_secret_get(&key)?;
    raw_secret_delete(&key)?;
    if let Some(manifest) = previous.as_deref() {
        delete_manifest_chunks(&key, manifest);
    }
    Ok(())
}

fn secure_secret_get_many_blocking(keys: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for key in keys {
        let normalized = normalize_secret_key(&key)?;
        #[cfg(windows)]
        let value = windows_store::Store::open(&normalized)?
            .get_for_ipc(|| legacy_secret_get_blocking(normalized.clone()))?;
        #[cfg(not(windows))]
        let value = secure_secret_get_blocking(normalized.clone())?;
        if let Some(value) = value {
            out.insert(normalized, value);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn secure_secret_get_many(keys: Vec<String>) -> Result<HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || secure_secret_get_many_blocking(keys))
        .await
        .map_err(|e| format!("安全存储读取任务失败: {e}"))?
}

#[tauri::command]
pub async fn secure_secret_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secure_secret_set_blocking(key, value))
        .await
        .map_err(|e| format!("安全存储写入任务失败: {e}"))?
}

#[tauri::command]
pub async fn secure_secret_delete(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || secure_secret_delete_blocking(key))
        .await
        .map_err(|e| format!("安全存储删除任务失败: {e}"))?
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    thread_local! {
        static TEST_ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    }

    pub(super) fn root_override() -> Option<PathBuf> {
        TEST_ROOT.with(|root| root.borrow().clone())
    }

    struct Fixture {
        key: String,
        root: PathBuf,
        legacy_keys: Vec<String>,
    }

    impl Fixture {
        fn new() -> Self {
            let id = format!(
                "{}.{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let root = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap())
                .join("hermes/cache/scratch")
                .join(format!("ugs-secure-store-test-{id}"));
            std::fs::create_dir_all(&root).unwrap();
            TEST_ROOT.with(|slot| *slot.borrow_mut() = Some(root.clone()));
            let key = format!("test.ugs-dpapi.{id}");
            Self {
                legacy_keys: vec![key.clone()],
                key,
                root,
            }
        }

        fn replay_old_manifest(&mut self) {
            let part = chunk_key(&self.key, "dummy-old-generation", 0);
            if !self.legacy_keys.contains(&part) {
                self.legacy_keys.push(part.clone());
            }
            raw_secret_set(&part, "dummy-old-value").unwrap();
            raw_secret_set(&self.key, &chunk_manifest("dummy-old-generation", 1)).unwrap();
            assert_eq!(
                raw_secret_get(&self.key).unwrap().as_deref(),
                Some(chunk_manifest("dummy-old-generation", 1).as_str())
            );
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            for key in &self.legacy_keys {
                raw_secret_delete(key).expect("dummy legacy cleanup");
                assert!(
                    raw_secret_get(key).unwrap().is_none(),
                    "dummy legacy cleanup readback"
                );
            }
            TEST_ROOT.with(|slot| *slot.borrow_mut() = None);
            std::fs::remove_dir_all(&self.root).expect("isolated encrypted test files cleanup");
            assert!(!self.root.exists());
        }
    }

    #[test]
    fn saved_value_ignores_replayed_old_legacy_manifest() {
        let mut fixture = Fixture::new();
        fixture.replay_old_manifest();
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        fixture.replay_old_manifest();
        assert_eq!(
            secure_secret_get_blocking(fixture.key.clone())
                .unwrap()
                .as_deref(),
            Some("dummy-current-value"),
            "old legacy manifest must not override a saved local value"
        );
    }

    fn child(fixture: &Fixture, mode: &str) {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "secure_store::tests::fresh_process_probe",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("UGS_TEST_ROOT", &fixture.root)
            .env("UGS_TEST_KEY", &fixture.key)
            .env("UGS_TEST_MODE", mode)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "independent test process failed: {}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }

    fn large_unicode_value() -> String {
        "dummy-密钥-🔐-e\u{301}-\0-\u{d}\u{a}".repeat(20_000)
    }

    fn encrypted_path(fixture: &Fixture, key: &str) -> PathBuf {
        use sha2::Digest;
        fixture.root.join(format!(
            "{:x}.dpapi",
            sha2::Sha256::digest(normalize_secret_key(key).unwrap().as_bytes())
        ))
    }

    #[test]
    #[ignore = "executed only as an isolated independent-process probe"]
    fn fresh_process_probe() {
        let root = PathBuf::from(std::env::var_os("UGS_TEST_ROOT").unwrap());
        let key = std::env::var("UGS_TEST_KEY").unwrap();
        assert!(key.starts_with("test.ugs-dpapi."));
        TEST_ROOT.with(|slot| *slot.borrow_mut() = Some(root));
        match std::env::var("UGS_TEST_MODE").unwrap().as_str() {
            "read-tombstone" => assert!(
                secure_secret_get_blocking(key).unwrap().is_none(),
                "deleted value must not resurrect in a fresh process"
            ),
            "write-large" => {
                secure_secret_set_blocking(key.clone(), large_unicode_value()).unwrap();
                secure_secret_set_blocking(
                    format!("{key}.other"),
                    "dummy-independent-value".into(),
                )
                .unwrap();
            }
            "read-large" => {
                assert!(
                    secure_secret_get_blocking(key.clone()).unwrap().as_deref()
                        == Some(large_unicode_value().as_str())
                );
                assert_eq!(
                    secure_secret_get_blocking(format!("{key}.other"))
                        .unwrap()
                        .as_deref(),
                    Some("dummy-independent-value")
                );
            }
            "read-old" => assert_eq!(
                secure_secret_get_blocking(key).unwrap().as_deref(),
                Some("dummy-old-value")
            ),
            "read-current" => assert_eq!(
                secure_secret_get_blocking(key).unwrap().as_deref(),
                Some("dummy-current-value")
            ),
            "blocked-read" | "blocked-write" | "blocked-delete" => {
                let root = root_override().unwrap();
                std::fs::write(root.join("started"), b"ready").unwrap();
                match std::env::var("UGS_TEST_MODE").unwrap().as_str() {
                    "blocked-read" => {
                        secure_secret_get_blocking(key).unwrap();
                    }
                    "blocked-write" => {
                        secure_secret_set_blocking(key, "dummy-current-value".into()).unwrap();
                    }
                    "blocked-delete" => {
                        secure_secret_delete_blocking(key).unwrap();
                    }
                    _ => unreachable!(),
                }
                std::fs::write(root.join("finished"), b"done").unwrap();
            }
            "expect-timeout" => {
                let result = secure_secret_get_blocking(key);
                assert!(
                    matches!(result, Err(message) if message.contains("超时")),
                    "mutex contention must time out explicitly"
                );
            }
            _ => panic!("unknown isolated test mode"),
        }
    }

    #[test]
    fn deletion_tombstone_survives_fresh_process_and_legacy_replay() {
        let mut fixture = Fixture::new();
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        secure_secret_delete_blocking(fixture.key.clone()).unwrap();
        fixture.replay_old_manifest();
        child(&fixture, "read-tombstone");
        assert!(secure_secret_get_blocking(fixture.key.clone())
            .unwrap()
            .is_none());
    }

    #[test]
    fn malformed_legacy_primary_is_an_error_not_a_migrated_value() {
        let fixture = Fixture::new();
        raw_secret_set(
            &fixture.key,
            &format!("{CHUNK_MANIFEST_PREFIX}dummy-invalid"),
        )
        .unwrap();
        assert!(
            secure_secret_get_blocking(fixture.key.clone()).is_err(),
            "corrupt manifest must fail rather than becoming an authoritative secret"
        );
        assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
    }

    #[test]
    fn large_unicode_values_round_trip_between_independent_processes() {
        let fixture = Fixture::new();
        child(&fixture, "write-large");
        child(&fixture, "read-large");
        assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 2);
        let disk = std::fs::read(encrypted_path(&fixture, &fixture.key)).unwrap();
        assert!(
            !disk
                .windows(b"dummy-".len())
                .any(|bytes| bytes == b"dummy-"),
            "no plaintext secret copy on disk"
        );
        assert!(
            raw_secret_get(&fixture.key).unwrap().is_none(),
            "new writes do not touch legacy"
        );
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        child(&fixture, "read-current");
    }

    #[test]
    fn migration_preserves_legacy_and_local_value_wins_afterwards() {
        let mut fixture = Fixture::new();
        fixture.replay_old_manifest();
        child(&fixture, "read-old");
        let part = chunk_key(&fixture.key, "dummy-old-generation", 0);
        assert_eq!(
            raw_secret_get(&part).unwrap().as_deref(),
            Some("dummy-old-value")
        );
        assert_eq!(
            raw_secret_get(&fixture.key).unwrap(),
            Some(chunk_manifest("dummy-old-generation", 1))
        );
        raw_secret_set(&fixture.key, "dummy-replayed-different-value").unwrap();
        child(&fixture, "read-old");
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        secure_secret_delete_blocking(fixture.key.clone()).unwrap();
        assert_eq!(
            raw_secret_get(&fixture.key).unwrap().as_deref(),
            Some("dummy-replayed-different-value")
        );
        assert_eq!(
            raw_secret_get(&part).unwrap().as_deref(),
            Some("dummy-old-value")
        );
    }

    #[test]
    fn replacement_failure_preserves_previous_ciphertext_and_cleans_temp() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        let path = encrypted_path(&fixture, &fixture.key);
        let before = std::fs::read(&path).unwrap();
        // Real Windows sharing violation at MoveFileExW, not a mocked writer.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1 | 2)
            .open(&path)
            .unwrap();
        assert!(
            secure_secret_set_blocking(fixture.key.clone(), "dummy-next-value".into()).is_err()
        );
        assert!(secure_secret_delete_blocking(fixture.key.clone()).is_err());
        assert!(
            std::fs::read(&path).unwrap() == before,
            "failed replacement must preserve exact ciphertext"
        );
        assert_eq!(
            std::fs::read_dir(&fixture.root).unwrap().count(),
            1,
            "failed temporary files cleaned"
        );
        drop(lock);
        child(&fixture, "read-current");
    }

    #[test]
    fn corrupt_existing_file_returns_error_without_legacy_fallback() {
        let mut fixture = Fixture::new();
        fixture.replay_old_manifest();
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        let path = encrypted_path(&fixture, &fixture.key);
        let valid = std::fs::read(&path).unwrap();
        let mut bad_ciphertext = valid.clone();
        *bad_ciphertext.last_mut().unwrap() ^= 0x80;
        for broken in [Vec::new(), b"dummy-corrupt-file".to_vec(), bad_ciphertext] {
            std::fs::write(&path, &broken).unwrap();
            assert!(
                secure_secret_get_blocking(fixture.key.clone()).is_err(),
                "existing corruption must not fall back to old legacy"
            );
            assert!(
                std::fs::read(&path).unwrap() == broken,
                "failed read must not overwrite evidence"
            );
        }
        std::fs::write(&path, valid).unwrap();
        child(&fixture, "read-current");
    }

    #[test]
    fn missing_legacy_chunk_errors_without_creating_local_file() {
        let fixture = Fixture::new();
        raw_secret_set(&fixture.key, &chunk_manifest("dummy-missing-generation", 1)).unwrap();
        assert!(secure_secret_get_blocking(fixture.key.clone()).is_err());
        assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 0);
    }

    #[test]
    fn logical_keys_keep_validation_and_bind_ciphertext_to_key() {
        let fixture = Fixture::new();
        for key in [
            "",
            " ",
            "密钥",
            "dummy\\path",
            "dummy\0key",
            &"x".repeat(161),
        ] {
            assert!(secure_secret_get_blocking(key.into()).is_err());
            assert!(secure_secret_set_blocking(key.into(), "dummy".into()).is_err());
            assert!(secure_secret_delete_blocking(key.into()).is_err());
        }
        secure_secret_set_blocking(format!(" {} ", fixture.key), "dummy-current-value".into())
            .unwrap();
        child(&fixture, "read-current");
        let other = format!("{}/other:_.-", fixture.key);
        std::fs::copy(
            encrypted_path(&fixture, &fixture.key),
            encrypted_path(&fixture, &other),
        )
        .unwrap();
        assert!(
            secure_secret_get_blocking(other).is_err(),
            "ciphertext swap between keys must fail authentication"
        );
    }

    #[test]
    fn empty_value_is_tombstone_even_when_only_legacy_exists() {
        let mut fixture = Fixture::new();
        fixture.replay_old_manifest();
        secure_secret_set_blocking(fixture.key.clone(), String::new()).unwrap();
        child(&fixture, "read-tombstone");
        fixture.replay_old_manifest();
        child(&fixture, "read-tombstone");
        assert_eq!(std::fs::read_dir(&fixture.root).unwrap().count(), 1);
    }

    #[test]
    fn named_mutex_serializes_cross_process_migration_set_and_delete() {
        let mut fixture = Fixture::new();
        fixture.replay_old_manifest();
        for mode in ["blocked-read", "blocked-write", "blocked-delete"] {
            let guard = windows_store::Store::open(&fixture.key).unwrap();
            let mut process = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "secure_store::tests::fresh_process_probe",
                    "--exact",
                    "--ignored",
                ])
                .env("UGS_TEST_ROOT", &fixture.root)
                .env("UGS_TEST_KEY", &fixture.key)
                .env("UGS_TEST_MODE", mode)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !fixture.root.join("started").exists() && std::time::Instant::now() < deadline {
                assert!(
                    process.try_wait().unwrap().is_none(),
                    "child should wait for named lock"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(fixture.root.join("started").exists());
            std::thread::sleep(std::time::Duration::from_millis(150));
            assert!(
                !fixture.root.join("finished").exists(),
                "operation bypassed cross-process lock"
            );
            assert!(process.try_wait().unwrap().is_none());
            drop(guard);
            let output = process.wait_with_output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(fixture.root.join("finished").exists());
            std::fs::remove_file(fixture.root.join("started")).unwrap();
            std::fs::remove_file(fixture.root.join("finished")).unwrap();
        }
        child(&fixture, "read-tombstone");
    }

    #[test]
    fn named_mutex_timeout_is_explicit_and_releases_failed_handle() {
        let fixture = Fixture::new();
        let guard = windows_store::Store::open(&fixture.key).unwrap();
        child(&fixture, "expect-timeout");
        drop(guard);
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        child(&fixture, "read-current");
    }

    #[test]
    fn abandoned_mutex_rereads_complete_ciphertext() {
        let fixture = Fixture::new();
        secure_secret_set_blocking(fixture.key.clone(), "dummy-current-value".into()).unwrap();
        let key = fixture.key.clone();
        let root = fixture.root.clone();
        let leaked_handle = std::thread::spawn(move || {
            TEST_ROOT.with(|slot| *slot.borrow_mut() = Some(root));
            windows_store::Store::open(&key).unwrap().abandon_for_test() as usize
        })
        .join()
        .unwrap();
        // The owning thread exited without ReleaseMutex; WAIT_ABANDONED grants ownership.
        assert_eq!(
            secure_secret_get_blocking(fixture.key.clone())
                .unwrap()
                .as_deref(),
            Some("dummy-current-value")
        );
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(leaked_handle as _);
        }
        child(&fixture, "read-current");
    }

    #[test]
    fn ipc_batch_distinguishes_tombstone_from_never_stored_key() {
        let mut fixture = Fixture::new();
        fixture.replay_old_manifest();
        secure_secret_delete_blocking(fixture.key.clone()).unwrap();
        let missing = format!("{}.never-stored", fixture.key);
        let live = format!("{}.live", fixture.key);
        secure_secret_set_blocking(live.clone(), "dummy-current-value".into()).unwrap();
        let result = secure_secret_get_many_blocking(vec![
            fixture.key.clone(),
            missing.clone(),
            live.clone(),
        ])
        .unwrap();
        assert_eq!(result.get(&fixture.key).map(String::as_str), Some(""),
            "IPC must explicitly represent authoritative deletion so inline migration cannot resurrect it");
        assert!(!result.contains_key(&missing));
        assert_eq!(
            result.get(&live).map(String::as_str),
            Some("dummy-current-value")
        );
        assert!(
            secure_secret_get_blocking(fixture.key.clone())
                .unwrap()
                .is_none(),
            "single-key deletion still means None"
        );
    }
}
