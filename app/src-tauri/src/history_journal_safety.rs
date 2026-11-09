//! Object checks for in-place journal writes (not a general history path policy).
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

#[cfg(windows)]
#[path = "history_journal_nt.rs"]
mod nt;

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "HISTORY_JOURNAL_UNSAFE_OBJECT",
    )
}

/// Retain Windows ancestors, opened object-relative from the disk root.
/// Sharing blocks renames, NOT metadata conversion. Relative kernel operations
/// and opened-directory validation establish the journal mutation boundary.
/// Deliberately deny redirected roots too; this is journal-only, not safe_join.
pub(in super::super) fn lock_parents(path: &Path) -> io::Result<Vec<File>> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        };
        if !path.is_absolute() {
            return Err(denied());
        }
        let mut dirs = Vec::new();
        let mut current = std::path::PathBuf::new();
        for component in path.parent().ok_or_else(denied)?.components() {
            current.push(component.as_os_str());
            // VerbatimDisk reports has_root before the RootDir component.
            // Never open the bare drive prefix as though it were a directory.
            if matches!(component, std::path::Component::Prefix(_)) || !current.has_root() {
                continue;
            }
            let file = if let Some(parent) = dirs.last() {
                validate_directory(parent)?;
                let std::path::Component::Normal(name) = component else {
                    return Err(denied());
                };
                nt::relative(parent, name, true)?
            } else {
                OpenOptions::new()
                    .access_mode(FILE_READ_ATTRIBUTES)
                    .share_mode(FILE_SHARE_READ)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                    .open(&current)?
            };
            let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
            // SAFETY: the live handle and writable output belong to this scope.
            if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let info = unsafe { info.assume_init() };
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            {
                return Err(denied());
            }
            dirs.push(file);
        }
        Ok(dirs)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Ok(Vec::new())
    }
}

pub(in super::super) fn open(path: &Path) -> io::Result<File> {
    #[cfg(windows)]
    {
        let parents = lock_parents(path)?;
        return open_bound(path, &parents);
    }
    #[cfg(not(windows))]
    open_unbound(path)
}

pub(in super::super) fn open_bound(path: &Path, parents: &[File]) -> io::Result<File> {
    open_bound_with(path, parents, || {})
}

#[cfg(test)]
pub(in super::super) fn open_bound_interleaved(
    path: &Path,
    parents: &[File],
    hook: impl FnOnce(),
) -> io::Result<File> {
    open_bound_with(path, parents, hook)
}

fn open_bound_with(path: &Path, parents: &[File], hook: impl FnOnce()) -> io::Result<File> {
    #[cfg(windows)]
    {
        let parent = parents.last().ok_or_else(denied)?;
        validate_directory(parent)?;
        hook();
        let file = nt::relative(parent, path.file_name().ok_or_else(denied)?, false)?;
        validate(&file)?;
        Ok(file)
    }
    #[cfg(not(windows))]
    {
        let _ = parents;
        hook();
        open_unbound(path)
    }
}

#[cfg(windows)]
fn validate_directory(file: &File) -> io::Result<()> {
    validate_directory_inner(file)
}

#[cfg(windows)]
pub(in super::super) fn replace_bound(
    path: &Path,
    parents: &[File],
    bytes: &[u8],
) -> io::Result<File> {
    nt::replace(
        parents.last().ok_or_else(denied)?,
        path.file_name().ok_or_else(denied)?,
        bytes,
    )
}

#[cfg(windows)]
fn validate_directory_inner(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
    // SAFETY: live borrowed handle and writable output with matching ABI.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
    {
        return Err(denied());
    }
    Ok(())
}

#[cfg(not(windows))]
fn open_unbound(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .share_mode(FILE_SHARE_READ);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    validate(&file)?;
    Ok(file)
}

/// Inspect the opened object, never a check-before-open pathname or cached stamp.
/// This does not promise exclusion of hardlinks created after the last check.
pub(in super::super) fn validate(file: &File) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
            FILE_ATTRIBUTE_REPARSE_POINT,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::uninit();
        // SAFETY: file owns a live handle; the API initializes info on success.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        if info.nNumberOfLinks != 1
            || info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)
                != 0
        {
            return Err(denied());
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let info = file.metadata()?;
        if !info.is_file() || info.nlink() != 1 {
            return Err(denied());
        }
    }
    #[cfg(not(any(windows, unix)))]
    return Err(denied());
    Ok(())
}
