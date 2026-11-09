//! Journal-only NT object-relative operations. No full-path opens below root.
use super::*;
use std::ffi::{c_void, OsStr};
use std::os::windows::{
    ffi::OsStrExt,
    io::{AsRawHandle, FromRawHandle},
};
use windows_sys::Win32::Storage::FileSystem::*;
type Handle = *mut c_void;
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}
#[repr(C)]
struct ObjectAttributes {
    length: u32,
    root: Handle,
    name: *mut UnicodeString,
    attributes: u32,
    security: *mut c_void,
    qos: *mut c_void,
}
#[repr(C)]
struct IoStatus {
    status: usize,
    information: usize,
}
#[link(name = "ntdll")]
extern "system" {
    fn NtCreateFile(
        handle: *mut Handle,
        access: u32,
        object: *mut ObjectAttributes,
        status: *mut IoStatus,
        allocation: *mut i64,
        attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: *mut c_void,
        ea_length: u32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
    fn NtSetInformationFile(
        handle: Handle,
        status: *mut IoStatus,
        information: *mut c_void,
        length: u32,
        class: u32,
    ) -> i32;
}
fn nt_result(status: i32) -> io::Result<()> {
    if status < 0 {
        Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ))
    } else {
        Ok(())
    }
}
/// A single name, resolved by the kernel relative to the owned directory object.
/// OBJ_DONT_REPARSE rejects parsing redirections; OPEN_REPARSE_POINT allows
/// object validation. Even a root converted after validation cannot redirect
/// this operation through a subsequently substituted full pathname.
pub(super) fn relative(parent: &File, name: &OsStr, directory: bool) -> io::Result<File> {
    relative_with(parent, name, directory, false)
}
fn relative_with(parent: &File, name: &OsStr, directory: bool, create: bool) -> io::Result<File> {
    let mut wide: Vec<u16> = name.encode_wide().collect();
    if wide.is_empty()
        || wide.len() > 32767
        || wide.iter().any(|c| matches!(*c, 0 | 47 | 92 | 58))
        || name == "."
        || name == ".."
    {
        return Err(denied());
    }
    let mut string = UnicodeString {
        length: (wide.len() * 2) as u16,
        maximum_length: (wide.len() * 2) as u16,
        buffer: wide.as_mut_ptr(),
    };
    let mut object = ObjectAttributes {
        length: std::mem::size_of::<ObjectAttributes>() as u32,
        root: parent.as_raw_handle(),
        name: &mut string,
        attributes: 0x40 | 0x1000,
        security: std::ptr::null_mut(),
        qos: std::ptr::null_mut(),
    };
    let mut status = IoStatus {
        status: 0,
        information: 0,
    };
    let mut handle = std::ptr::null_mut();
    let access = if directory {
        FILE_READ_ATTRIBUTES | SYNCHRONIZE
    } else {
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | if create { DELETE } else { 0 }
    };
    // SAFETY: all C-layout structures and UTF-16 storage remain live through
    // the synchronous call; the root handle is borrowed from its File owner.
    nt_result(unsafe {
        NtCreateFile(
            &mut handle,
            access,
            &mut object,
            &mut status,
            std::ptr::null_mut(),
            0,
            FILE_SHARE_READ,
            if create { 2 } else { 1 },
            0x20 | 0x200000 | if directory { 1 } else { 0x40 },
            std::ptr::null_mut(),
            0,
        )
    })?;
    // SAFETY: successful NtCreateFile returned a new owned handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

#[repr(C)]
struct RenameInformation {
    replace: u8,
    root: Handle,
    length: u32,
    name: [u16; 1],
}
/// Create, sync and rename relative to the retained parent; keep the same handle.
pub(super) fn replace(parent: &File, name: &OsStr, bytes: &[u8]) -> io::Result<File> {
    use std::io::Write;
    validate_directory(parent)?;
    let stage = format!(
        ".ugs-journal-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos()
    );
    let mut file = relative_with(parent, OsStr::new(&stage), false, true)?;
    let mut renamed = false;
    let result = (|| {
        validate(&file)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        validate_directory(parent)?;
        let wide: Vec<u16> = name.encode_wide().collect();
        let offset = std::mem::offset_of!(RenameInformation, name);
        let length = offset + wide.len() * 2;
        let mut storage = vec![
            0usize;
            (length + std::mem::size_of::<usize>() - 1)
                / std::mem::size_of::<usize>()
        ];
        let info = storage.as_mut_ptr().cast::<RenameInformation>();
        let mut status = IoStatus {
            status: 0,
            information: 0,
        };
        // SAFETY: pointer-aligned zeroed C header + exact UTF-16 byte count.
        // Both borrowed handles and storage remain live through the call.
        unsafe {
            std::ptr::addr_of_mut!((*info).replace).write(1);
            std::ptr::addr_of_mut!((*info).root).write(parent.as_raw_handle());
            std::ptr::addr_of_mut!((*info).length).write((wide.len() * 2) as u32);
            std::ptr::copy_nonoverlapping(
                wide.as_ptr(),
                storage.as_mut_ptr().cast::<u8>().add(offset).cast::<u16>(),
                wide.len(),
            );
            nt_result(NtSetInformationFile(
                file.as_raw_handle(),
                &mut status,
                info.cast(),
                length as u32,
                10,
            ))?;
        }
        renamed = true;
        validate(&file)?;
        Ok(())
    })();
    if let Err(error) = result {
        // A successful atomic rename committed the new header. Never delete
        // that durable journal merely because a subsequent validation failed.
        if renamed {
            return Err(error);
        }
        let mut status = IoStatus {
            status: 0,
            information: 0,
        };
        let mut delete = 1u8;
        // SAFETY: deletion applies only to the owned staged handle.
        let cleanup = nt_result(unsafe {
            NtSetInformationFile(
                file.as_raw_handle(),
                &mut status,
                (&mut delete as *mut u8).cast(),
                1,
                13,
            )
        });
        return Err(match cleanup {
            Ok(()) => error,
            Err(cleanup) => io::Error::new(
                error.kind(),
                format!("{error}; journal stage cleanup failed: {cleanup}"),
            ),
        });
    }
    Ok(file)
}
