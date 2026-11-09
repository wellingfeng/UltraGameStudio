//! Versioned session-only journal. The normal JSON remains the portable base.
use super::*;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom};

#[path = "history_journal_safety.rs"]
pub(super) mod history_journal_safety;

pub(super) fn path_for(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".journal");
    PathBuf::from(name)
}
pub(super) fn visible(json: &str) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if let Some(record) = value.as_object_mut() {
        record.remove("__ugsHistoryRevision");
    }
    serde_json::to_string(&value).map_err(|e| e.to_string())
}
fn read_header(raw: &[u8]) -> Result<Option<Value>, String> {
    let Some(first) = raw.split_inclusive(|byte| *byte == b'\n').next() else {
        return Ok(None);
    };
    if !first.ends_with(b"\n") {
        return Ok(None);
    }
    let header: Value =
        serde_json::from_slice(first).map_err(|e| format!("journal header 损坏: {e}"))?;
    if header["__ugsJournalHeader"] != 1 {
        return Err("不支持的 history journal header 版本".into());
    }
    let hash = header["baseHash"].as_str().ok_or("journal baseHash 无效")?;
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("journal baseHash 无效".into());
    }
    Ok(Some(header))
}
fn fingerprint(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

type Stamp = (u64, Option<std::time::SystemTime>);
static VALIDATED: std::sync::OnceLock<
    std::sync::Mutex<std::collections::VecDeque<(PathBuf, Stamp)>>,
> = std::sync::OnceLock::new();
fn cache() -> &'static std::sync::Mutex<std::collections::VecDeque<(PathBuf, Stamp)>> {
    VALIDATED.get_or_init(|| std::sync::Mutex::new(std::collections::VecDeque::new()))
}
fn file_stamp(file: &fs::File) -> Result<Stamp, String> {
    let meta = file.metadata().map_err(|e| e.to_string())?;
    Ok((meta.len(), meta.modified().ok()))
}
pub(super) fn forget(path: &Path) {
    if let Ok(mut cache) = cache().lock() {
        cache.retain(|(key, _)| !key.starts_with(path));
    }
}
fn remember(path: &Path, stamp: Stamp) {
    if let Ok(mut cache) = cache().lock() {
        cache.retain(|(key, _)| key != path);
        cache.push_back((path.to_path_buf(), stamp));
        while cache.len() > 64 {
            cache.pop_front();
        }
    }
}

pub(super) fn append(path: &Path, json: &str) -> Result<(), String> {
    append_with_limits(path, json, 16 * 1024 * 1024, 64 * 1024 * 1024)
}

#[cfg(test)]
thread_local! {
    static INTERLEAVE: std::cell::RefCell<Option<Box<dyn FnMut(&str)>>> = std::cell::RefCell::new(None);
}
#[cfg(test)]
pub(super) fn append_interleaved(
    path: &Path,
    json: &str,
    hook: impl FnMut(&str) + 'static,
) -> Result<(), String> {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            INTERLEAVE.with(|slot| *slot.borrow_mut() = None);
        }
    }
    INTERLEAVE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    let _reset = Reset;
    append(path, json)
}
#[cfg(test)]
fn interleave(stage: &str) {
    INTERLEAVE.with(|slot| {
        if let Some(hook) = slot.borrow_mut().as_mut() {
            hook(stage);
        }
    });
}
pub(super) fn append_with_limits(
    path: &Path,
    json: &str,
    entry_limit: usize,
    journal_limit: u64,
) -> Result<(), String> {
    if json.len() > entry_limit {
        return Err("HISTORY_JOURNAL_ENTRY_FULL".into());
    }
    let payload: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    validate_delta(&payload)?;
    if let Some(order) = payload["messages"].get("order") {
        // Ordering changes happen on structural edits, not on every token.
        // Validate against the recovered durable prefix before repairing or
        // replacing any journal bytes; syntactic ID checks alone cannot do this.
        let base =
            fs::read_to_string(path).map_err(|e| format!("读取 journal 基础文件失败: {e}"))?;
        let recovered: Value =
            serde_json::from_str(&replay(path, &base)?).map_err(|e| e.to_string())?;
        let messages = recovered["messages"]
            .as_array()
            .ok_or("journal messages 无效")?;
        let mut available = std::collections::HashSet::new();
        for message in messages.iter().chain(
            payload["messages"]["upserts"]
                .as_array()
                .ok_or("journal upserts 无效")?,
        ) {
            available.insert(message["id"].as_str().ok_or("journal message id 无效")?);
        }
        for id in order.as_array().ok_or("journal order 无效")? {
            if !available.contains(id.as_str().ok_or("journal order id 无效")?) {
                return Err("journal order message 缺失".into());
            }
        }
    }
    let line = payload.to_string() + "\n";
    let journal = path_for(path);
    let _parents = history_journal_safety::lock_parents(&journal).map_err(|e| e.to_string())?;
    #[cfg(test)]
    interleave("parents_locked");
    // Always validate the object actually opened, including the cache fast path.
    #[cfg(test)]
    let opening = history_journal_safety::open_bound_interleaved(&journal, &_parents, || {
        interleave("parent_validated")
    });
    #[cfg(not(test))]
    let opening = history_journal_safety::open_bound(&journal, &_parents);
    let mut opened = match opening {
        Ok(file) => Some(file),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("打开 journal 失败: {error}")),
    };
    let current_stamp = opened.as_ref().map(file_stamp).transpose()?;
    if current_stamp
        .is_some_and(|(length, _)| length.saturating_add(line.len() as u64) > journal_limit)
    {
        return Err("HISTORY_JOURNAL_FULL".into());
    }
    let known = current_stamp.is_some()
        && cache()
            .lock()
            .map_err(|_| "journal cache poisoned")?
            .iter()
            .any(|(key, saved)| key == path && Some(*saved) == current_stamp);
    if !known {
        let base = fs::read(path).map_err(|e| format!("读取 journal 基础文件失败: {e}"))?;
        let hash = fingerprint(&base);
        let header = serde_json::json!({"__ugsJournalHeader":1,"baseHash":hash});
        let mut replace_header = opened.is_none();
        if let Some(file) = opened.as_mut() {
            let mut raw = Vec::new();
            file.read_to_end(&mut raw).map_err(|e| e.to_string())?;
            let existing = read_header(&raw)?;
            if existing
                .as_ref()
                .and_then(|header| header["baseHash"].as_str())
                != Some(hash.as_str())
            {
                replace_header = true;
            } else {
                let (_, valid) = scan(&raw, validate_delta)?;
                if valid < raw.len() {
                    history_journal_safety::validate(file).map_err(|e| e.to_string())?;
                    file.set_len(valid as u64)
                        .and_then(|_| file.sync_all())
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        if replace_header {
            if (header.to_string().len() + 1 + line.len()) as u64 > journal_limit {
                return Err("HISTORY_JOURNAL_FULL".into());
            }
            // The base replacement committed; discard a stale log atomically.
            // Close the old handle for rename, then validate the replacement
            // handle before any in-place write (never trust the pathname).
            drop(opened.take());
            #[cfg(test)]
            interleave("stale_leaf_closed");
            #[cfg(windows)]
            {
                opened = Some(
                    history_journal_safety::replace_bound(
                        &journal,
                        &_parents,
                        (header.to_string() + "\n").as_bytes(),
                    )
                    .map_err(|e| e.to_string())?,
                );
            }
            #[cfg(not(windows))]
            {
                persist_json_file(&journal, &(header.to_string() + "\n"))?;
                opened = Some(history_journal_safety::open(&journal).map_err(|e| e.to_string())?);
            }
        }
    }
    let mut file = opened.ok_or("journal handle 缺失")?;
    append_line_with(&mut file, line.as_bytes(), |file, bytes| {
        file.write_all(bytes)
    })?;
    remember(path, file_stamp(&file)?);
    Ok(())
}

pub(super) fn append_line_with(
    file: &mut fs::File,
    bytes: &[u8],
    writer: impl FnOnce(&mut fs::File, &[u8]) -> std::io::Result<()>,
) -> Result<(), String> {
    history_journal_safety::validate(file).map_err(|e| e.to_string())?;
    let previous_length = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    if let Err(error) = writer(file, bytes).and_then(|_| file.sync_all()) {
        let rollback = file.set_len(previous_length).and_then(|_| file.sync_all());
        return Err(match rollback {
            Ok(()) => format!("写入 journal 失败，已回滚: {error}"),
            Err(rollback) => format!("写入 journal 失败: {error}; rollback failed: {rollback}"),
        });
    }
    Ok(())
}

fn protected_field(key: &str) -> bool {
    matches!(
        key,
        "messages" | "id" | "workspaceId" | "__ugsHistoryRevision" | "__ugsJournal"
    )
}
fn validate_delta(delta: &Value) -> Result<(), String> {
    if delta["__ugsJournal"] != 1 {
        return Err("不支持的 history journal 版本".into());
    }
    let fields = delta["fields"].as_object().ok_or("journal fields 无效")?;
    if fields.keys().any(|key| protected_field(key)) {
        return Err("journal 禁止修改保留字段".into());
    }
    let deleted = delta["deleted"].as_array().ok_or("journal deleted 无效")?;
    for key in deleted {
        if protected_field(key.as_str().ok_or("journal deleted key 无效")?) {
            return Err("journal 禁止删除保留字段".into());
        }
    }
    let updates = delta["messages"]["upserts"]
        .as_array()
        .ok_or("journal upserts 无效")?;
    let mut ids = std::collections::HashSet::new();
    for message in updates {
        let id = message["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("journal message id 无效")?;
        if !ids.insert(id) {
            return Err("journal message id 重复".into());
        }
    }
    if let Some(order) = delta["messages"].get("order") {
        let mut ids = std::collections::HashSet::new();
        for id in order.as_array().ok_or("journal order 无效")? {
            if !ids.insert(id.as_str().ok_or("journal order id 无效")?) {
                return Err("journal order id 重复".into());
            }
        }
    }
    Ok(())
}
fn apply(record: &mut Value, delta: &Value) -> Result<(), String> {
    validate_delta(delta)?;
    let fields = delta["fields"].as_object().ok_or("journal fields 无效")?;
    let target = record.as_object_mut().ok_or("journal 基础记录无效")?;
    for (key, value) in fields {
        target.insert(key.clone(), value.clone());
    }
    for key in delta["deleted"].as_array().ok_or("journal deleted 无效")? {
        target.remove(key.as_str().ok_or("journal deleted key 无效")?);
    }
    let messages = target
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or("journal messages 无效")?;
    let upserts = delta["messages"]["upserts"]
        .as_array()
        .ok_or("journal upserts 无效")?;
    for message in upserts {
        let id = message["id"].as_str().ok_or("journal message id 无效")?;
        if let Some(old) = messages
            .iter_mut()
            .find(|old| old["id"].as_str() == Some(id))
        {
            *old = message.clone();
        } else {
            messages.push(message.clone());
        }
    }
    if let Some(order) = delta["messages"].get("order") {
        let ordered = order
            .as_array()
            .ok_or("journal order 无效")?
            .iter()
            .map(|id| {
                messages
                    .iter()
                    .find(|message| message["id"] == *id)
                    .cloned()
                    .ok_or_else(|| "journal order message 缺失".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        *messages = ordered;
    }
    Ok(())
}

fn scan(
    raw: &[u8],
    mut visit: impl FnMut(&Value) -> Result<(), String>,
) -> Result<(Value, usize), String> {
    let mut lines = raw.split_inclusive(|byte| *byte == b'\n');
    let first = lines.next().ok_or("journal header 缺失")?;
    if !first.ends_with(b"\n") {
        return Err("journal header 截断".into());
    }
    let header: Value =
        serde_json::from_slice(first).map_err(|e| format!("journal header 损坏: {e}"))?;
    if header["__ugsJournalHeader"] != 1 {
        return Err("不支持的 history journal header 版本".into());
    }
    let mut valid = first.len();
    for line in lines {
        if !line.ends_with(b"\n") {
            break;
        }
        let delta: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(_) if valid + line.len() == raw.len() => break,
            Err(e) => return Err(format!("journal 中部损坏: {e}")),
        };
        visit(&delta)?;
        valid += line.len();
    }
    Ok((header, valid))
}

pub(super) fn replay(path: &Path, base: &str) -> Result<String, String> {
    let journal = path_for(path);
    match fs::metadata(&journal) {
        Ok(metadata) if metadata.len() > 64 * 1024 * 1024 => {
            return Err("HISTORY_JOURNAL_FULL".into())
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(base.to_string()),
        Err(error) => return Err(format!("读取 journal 失败: {error}")),
    }
    let raw = match fs::read(journal) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(base.to_string()),
        Err(e) => return Err(format!("读取 journal 失败: {e}")),
    };
    let Some(header) = read_header(&raw)? else {
        return Ok(base.to_string());
    };
    if header["baseHash"].as_str() != Some(&fingerprint(base.as_bytes())) {
        return Ok(base.to_string());
    }
    let mut record: Value = serde_json::from_str(base).map_err(|e| e.to_string())?;
    scan(&raw, |delta| apply(&mut record, delta))?;
    serde_json::to_string(&record).map_err(|e| e.to_string())
}
