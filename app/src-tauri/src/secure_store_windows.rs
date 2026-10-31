//! Windows authority: user-bound DPAPI files, never a second keyring writer.
//! A local file (including a tombstone) always wins over legacy credentials.
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::marker::PhantomData;
use std::os::windows::ffi::OsStrExt;
#[cfg(not(test))]
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

const FORMAT: &[u8] = b"UGS-DPAPI-SECRET\x01";
// Bound corrupt-file allocation; provider maps are normally much smaller.
const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
const LOCK_TIMEOUT_MS: u32 = 30_000;

fn error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn wide(path: &std::ffi::OsStr) -> Result<Vec<u16>, String> {
    let mut value: Vec<u16> = path.encode_wide().collect();
    if value.contains(&0) {
        return Err("安全存储路径包含非法字符。".into());
    }
    value.push(0);
    Ok(value)
}

#[cfg(not(test))]
fn storage_root() -> Result<PathBuf, String> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath};
    let mut ptr = null_mut();
    // Known Folder API, not UGS_HOME, CWD, or a caller-controlled project path.
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, null_mut(), &mut ptr) };
    if result < 0 {
        return Err(format!("无法定位用户安全存储目录: HRESULT {result:#x}"));
    }
    if ptr.is_null() {
        return Err("用户安全存储目录为空。".into());
    }
    let path = unsafe {
        let mut length = 0;
        while *ptr.add(length) != 0 {
            length += 1;
        }
        let path = std::ffi::OsString::from_wide(std::slice::from_raw_parts(ptr, length));
        CoTaskMemFree(ptr.cast());
        PathBuf::from(path)
    };
    Ok(path.join("UltraGameStudio").join("secure-store-v1"))
}

#[cfg(test)]
fn storage_root() -> Result<PathBuf, String> {
    // Tests cannot accidentally open the user's real secure-store directory.
    super::tests::root_override().ok_or_else(|| "安全存储测试必须使用独立目录。".into())
}

struct MutexGuard {
    handle: HANDLE,
    // Windows mutex ownership is thread-bound, including ReleaseMutex.
    _thread_bound: PhantomData<std::rc::Rc<()>>,
}

impl MutexGuard {
    fn acquire(root: &Path, key_hash: &str) -> Result<Self, String> {
        let root_bytes: Vec<u8> = root
            .as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect();
        let name = format!(
            "Global\\UltraGameStudio.SecureStore.v1.{}.{key_hash}",
            hash(&root_bytes)
        );
        let name = wide(std::ffi::OsStr::new(&name))?;
        let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(error("打开安全存储锁失败"));
        }
        match unsafe { WaitForSingleObject(handle, LOCK_TIMEOUT_MS) } {
            // Abandonment grants ownership. Always reread the atomic file: no cache.
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self {
                handle,
                _thread_bound: PhantomData,
            }),
            status => {
                let message = if status == WAIT_TIMEOUT {
                    "等待安全存储锁超时。".into()
                } else {
                    error("等待安全存储锁失败")
                };
                unsafe {
                    CloseHandle(handle);
                }
                Err(message)
            }
        }
    }
}

impl Drop for MutexGuard {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

struct DpapiBuffer(CRYPT_INTEGER_BLOB);
impl Drop for DpapiBuffer {
    fn drop(&mut self) {
        if !self.0.pbData.is_null() {
            // Also erase decrypted bytes before returning their allocation to Windows.
            unsafe {
                for index in 0..self.0.cbData as usize {
                    std::ptr::write_volatile(self.0.pbData.add(index), 0);
                }
                LocalFree(self.0.pbData.cast());
            }
        }
    }
}

fn crypt(input: &[u8], key_hash: &str, protect: bool) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| "安全存储内容过大。")?,
        pbData: input.as_ptr().cast_mut(),
    };
    // Authenticated key binding prevents swapping ciphertext between logical keys.
    let entropy = format!("UltraGameStudio/secure-store/v1/{key_hash}");
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output = DpapiBuffer(CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    });
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                null(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                &entropy,
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output.0,
            )
        }
    };
    if ok == 0 {
        return Err(error(if protect {
            "加密安全存储失败"
        } else {
            "解密安全存储失败"
        }));
    }
    if output.0.pbData.is_null() || output.0.cbData == 0 {
        return Err("安全存储加密数据为空。".into());
    }
    Ok(unsafe { std::slice::from_raw_parts(output.0.pbData, output.0.cbData as usize).to_vec() })
}

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(super) struct Store {
    root: PathBuf,
    key_hash: String,
    _lock: MutexGuard,
}

impl Store {
    #[cfg(test)]
    pub(super) fn abandon_for_test(self) -> HANDLE {
        let handle = self._lock.handle;
        std::mem::forget(self);
        handle
    }

    pub(super) fn open(key: &str) -> Result<Self, String> {
        let key = super::normalize_secret_key(key)?;
        let root = storage_root()?;
        let key_hash = hash(key.as_bytes());
        let lock = MutexGuard::acquire(&root, &key_hash)?;
        Ok(Self {
            root,
            key_hash,
            _lock: lock,
        })
    }

    fn path(&self) -> PathBuf {
        self.root.join(format!("{}.dpapi", self.key_hash))
    }

    // Outer None = absent file; inner None = an authoritative deletion tombstone.
    fn read(&self) -> Result<Option<Option<String>>, String> {
        let file = match File::open(self.path()) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("读取本地安全存储失败: {err}")),
        };
        let mut bytes = Vec::new();
        file.take((MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|err| format!("读取本地安全存储失败: {err}"))?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err("本地安全存储文件过大。".into());
        }
        let Some(ciphertext) = bytes.strip_prefix(FORMAT) else {
            return Err("本地安全存储文件格式损坏。".into());
        };
        let plaintext = crypt(ciphertext, &self.key_hash, false)?;
        match plaintext.split_first() {
            Some((0, rest)) if rest.is_empty() => Ok(Some(None)),
            Some((1, rest)) => String::from_utf8(rest.to_vec())
                .map(|value| Some(Some(value)))
                .map_err(|_| "本地安全存储内容格式损坏。".into()),
            _ => Err("本地安全存储内容格式损坏。".into()),
        }
    }

    pub(super) fn get(
        &self,
        legacy: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<Option<String>, String> {
        if let Some(value) = self.read()? {
            return Ok(value);
        }
        let value = legacy()?;
        if let Some(value) = value.as_deref() {
            self.write(Some(value))?;
        }
        // A missing legacy entry is not migrated; it may legitimately appear later.
        Ok(value)
    }

    pub(super) fn get_for_ipc(
        &self,
        legacy: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<Option<String>, String> {
        if let Some(value) = self.read()? {
            // Preserve an explicit own-property for deletion in the IPC map.
            // Missing files/legacy entries stay None and are omitted by the caller.
            return Ok(Some(value.unwrap_or_default()));
        }
        self.get(legacy)
    }

    pub(super) fn write(&self, value: Option<&str>) -> Result<(), String> {
        let mut plaintext = vec![u8::from(value.is_some())];
        if let Some(value) = value {
            plaintext.extend_from_slice(value.as_bytes());
        }
        let ciphertext = crypt(&plaintext, &self.key_hash, true)?;
        if ciphertext.len() + FORMAT.len() > MAX_FILE_BYTES {
            return Err("安全存储内容过大。".into());
        }
        std::fs::create_dir_all(&self.root)
            .map_err(|err| format!("创建安全存储目录失败: {err}"))?;
        let (temp, mut file) = self.create_temp()?;
        file.write_all(FORMAT)
            .and_then(|_| file.write_all(&ciphertext))
            .and_then(|_| file.sync_all())
            .map_err(|err| format!("写入加密安全存储失败: {err}"))?;
        drop(file);
        let from = wide(temp.0.as_os_str())?;
        let to = wide(self.path().as_os_str())?;
        // Same-directory replace only. Never truncate or fall back to copy/remove.
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(error("原子替换安全存储失败"));
        }
        let actual = self.read()?;
        if actual.as_ref().map(|item| item.as_deref()) != Some(value) {
            return Err("安全存储写入回读验证失败。".into());
        }
        Ok(())
    }

    fn create_temp(&self) -> Result<(TempFile, File), String> {
        for _ in 0..16 {
            let mut random = [0_u8; 16];
            getrandom::getrandom(&mut random).map_err(|_| "生成安全存储临时文件名失败。")?;
            let name = format!("{}.{}.tmp", self.key_hash, hash(&random));
            let path = self.root.join(name);
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => return Ok((TempFile(path), file)),
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(err) => return Err(format!("创建安全存储临时文件失败: {err}")),
            }
        }
        Err("无法创建唯一的安全存储临时文件。".into())
    }
}
