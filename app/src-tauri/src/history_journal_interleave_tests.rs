//! Real NTFS interleavings at the complete production append entry.
use super::*;
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use windows_sys::Win32::Storage::FileSystem::*;
// Keep this test executable in the existing minimal offline harnesses without
// altering any repository/reviewer dependency feature set.
#[link(name = "kernel32")]
extern "system" {
    fn DeviceIoControl(
        handle: *mut std::ffi::c_void,
        code: u32,
        input: *const std::ffi::c_void,
        input_length: u32,
        output: *mut std::ffi::c_void,
        output_length: u32,
        returned: *mut u32,
        overlapped: *mut std::ffi::c_void,
    ) -> i32;
}

fn convert(parent: &Path, outside: &Path) -> fs::File {
    let file = fs::OpenOptions::new()
        .access_mode(FILE_WRITE_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(parent)
        .expect("real FILE_WRITE_ATTRIBUTES handle");
    let target = outside.display().to_string().replace('/', "\\");
    let s: Vec<u16> = format!("\\??\\{target}").encode_utf16().collect();
    let p: Vec<u16> = target.encode_utf16().collect();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0xA0000003u32.to_le_bytes());
    bytes.extend_from_slice(&((8 + (s.len() + p.len() + 2) * 2) as u16).to_le_bytes());
    bytes.extend_from_slice(&[0u8; 2]);
    for n in [
        0,
        (s.len() * 2) as u16,
        ((s.len() + 1) * 2) as u16,
        (p.len() * 2) as u16,
    ] {
        bytes.extend_from_slice(&n.to_le_bytes());
    }
    for n in s.into_iter().chain([0]).chain(p).chain([0]) {
        bytes.extend_from_slice(&n.to_le_bytes());
    }
    let mut returned = 0;
    assert_ne!(
        unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                0x900A4,
                bytes.as_ptr().cast(),
                bytes.len() as u32,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        },
        0,
        "real empty held-directory conversion: {}",
        std::io::Error::last_os_error()
    );
    file
}
fn undo(file: &fs::File) {
    let mut bytes = Vec::from(0xA0000003u32.to_le_bytes());
    bytes.extend_from_slice(&[0; 4]);
    let mut returned = 0;
    assert_ne!(
        unsafe {
            DeviceIoControl(
                file.as_raw_handle(),
                0x900AC,
                bytes.as_ptr().cast(),
                8,
                std::ptr::null_mut(),
                0,
                &mut returned,
                std::ptr::null_mut(),
            )
        },
        0
    );
}
fn attack_at(stage: &'static str) {
    let root = fixture();
    history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    history_write_at(&root, SESSION, &delta("durable").to_string(), true).unwrap();
    let path = root.join(SESSION);
    let journal = journal_path(&root);
    let parent = path.parent().unwrap().to_path_buf();
    let outside = root.with_extension("outside-interleave");
    fs::create_dir(&outside).unwrap();
    fs::copy(&path, outside.join("a.json")).unwrap();
    fs::copy(&journal, outside.join("a.json.journal")).unwrap();
    let before_base = fs::read(outside.join("a.json")).unwrap();
    let before = fs::read(outside.join("a.json.journal")).unwrap();
    if stage == "stale_leaf_closed" {
        fs::write(&path, record().to_string() + " ").unwrap();
    }
    history_journal::forget(&path);
    let attack_handle = std::rc::Rc::new(std::cell::RefCell::new(None));
    let shared = attack_handle.clone();
    let scratch = root.clone();
    let external = outside.clone();
    let moved_journal = root.join("moved.journal");
    let original = fs::read(&journal).unwrap();
    let result =
        history_journal::append_interleaved(&path, &delta("blocked").to_string(), move |actual| {
            if actual != stage {
                return;
            }
            fs::rename(parent.join("a.json"), scratch.join("moved.json")).unwrap();
            fs::rename(parent.join("a.json.journal"), scratch.join("moved.journal")).unwrap();
            *shared.borrow_mut() = Some(convert(&parent, &external));
        });
    let hit = attack_handle.borrow().is_some();
    let after = fs::read(outside.join("a.json.journal")).unwrap();
    let after_base = fs::read(outside.join("a.json")).unwrap();
    if let Some(file) = attack_handle.borrow_mut().take() {
        undo(&file);
    }
    let moved = fs::read(&moved_journal).unwrap();
    fs::remove_dir_all(&outside).unwrap();
    fs::remove_dir_all(&root).unwrap();
    println!(
        "complete append {stage}: hit={hit}, outside {} -> {}, result={result:?}",
        before.len(),
        after.len()
    );
    assert!(hit, "interleaving never reached");
    assert_eq!(
        after, before,
        "external journal changed at {stage}: {result:?}"
    );
    assert_eq!(after_base, before_base, "external base changed");
    assert_eq!(moved, original, "displaced original journal changed");
    assert!(
        result.is_err(),
        "converted trusted ancestor must fail closed"
    );
}
#[test]
fn complete_append_rejects_empty_held_parent_conversion() {
    attack_at("parents_locked");
}

#[test]
fn complete_append_rejects_conversion_after_stale_leaf_closed() {
    attack_at("stale_leaf_closed");
}

#[test]
fn complete_append_is_object_bound_even_after_final_parent_validation() {
    attack_at("parent_validated");
}

#[test]
fn complete_append_supports_real_normal_and_verbatim_disk_paths() {
    let root = fixture();
    history_write_at(&root, SESSION, &record().to_string(), false).unwrap();
    let path = root.join(SESSION);
    history_journal::append(&path, &delta("normal").to_string()).unwrap();
    let verbatim = fs::canonicalize(&path).unwrap();
    assert!(verbatim
        .as_os_str()
        .to_string_lossy()
        .starts_with("\\\\?\\"));
    history_journal::append(&verbatim, &delta("verbatim").to_string()).unwrap();
    let mut expected = record();
    expected["title"] = json!("checkpoint");
    expected["messages"][0]["text"] = json!("verbatim");
    fresh_read(&root, &expected);
    fs::remove_dir_all(root).unwrap();
}
