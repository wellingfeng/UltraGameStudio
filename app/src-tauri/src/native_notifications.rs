//! One bounded notification thread; COM objects never leave its apartment.
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};

type Job = Box<dyn FnOnce() + Send>;
pub(crate) struct NotificationExecutor {
    queue: mpsc::SyncSender<Job>,
}
impl NotificationExecutor {
    fn new() -> Result<Self, String> {
        let (queue, jobs) = mpsc::sync_channel::<Job>(16);
        std::thread::Builder::new()
            .name("ugs-notifications".into())
            .spawn(move || {
                #[cfg(windows)]
                let _apartment = match NotificationApartment::initialize() {
                    Ok(apartment) => apartment,
                    Err(error) => {
                        log::error!("{error}");
                        return;
                    }
                };
                for job in jobs {
                    job();
                }
            })
            .map_err(|e| format!("通知线程启动失败: {e}"))?;
        Ok(Self { queue })
    }
    pub(crate) async fn submit(
        &self,
        timeout: Duration,
        work: impl FnOnce() -> Result<bool, String> + Send + 'static,
    ) -> Result<bool, String> {
        let deadline = Instant::now() + timeout;
        let (reply, result) = tokio::sync::oneshot::channel();
        self.queue
            .try_send(Box::new(move || {
                let value = if Instant::now() >= deadline {
                    Err("通知排队超时，未执行。".into())
                } else {
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
                        .unwrap_or_else(|_| Err("通知任务 panic。".into()))
                };
                let _ = reply.send(value);
            }))
            .map_err(|_| "通知队列繁忙或线程已关闭。".to_string())?;
        tokio::time::timeout(timeout, result)
            .await
            .map_err(|_| "通知响应超时（正在执行的系统调用可能已生效）。".to_string())?
            .map_err(|_| "通知线程已关闭。".to_string())?
    }
}
#[cfg(windows)]
struct NotificationApartment;
#[cfg(windows)]
impl NotificationApartment {
    fn initialize() -> Result<Self, String> {
        // RoInitialize also initializes COM; balance S_OK and S_FALSE on THIS thread.
        unsafe {
            windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            )
        }
        .map_err(|e| format!("通知 WinRT 初始化失败: {e}"))?;
        Ok(Self)
    }
}
#[cfg(windows)]
impl Drop for NotificationApartment {
    fn drop(&mut self) {
        unsafe {
            windows::Win32::System::WinRT::RoUninitialize();
        }
    }
}

pub(crate) fn executor() -> Result<&'static NotificationExecutor, String> {
    static WORKER: OnceLock<Result<NotificationExecutor, String>> = OnceLock::new();
    WORKER
        .get_or_init(NotificationExecutor::new)
        .as_ref()
        .map_err(Clone::clone)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn panicking_notification_does_not_close_the_only_worker() {
        let worker = NotificationExecutor::new().unwrap();
        let failed = tauri::async_runtime::block_on(
            worker.submit(Duration::from_secs(1), || panic!("fixture private content")),
        );
        assert!(failed.unwrap_err().contains("panic"));
        assert!(
            tauri::async_runtime::block_on(worker.submit(Duration::from_secs(1), || Ok(true)))
                .unwrap()
        );
    }
    #[test]
    #[cfg(windows)]
    fn notification_work_runs_in_initialized_mta() {
        let worker = NotificationExecutor::new().unwrap();
        let initialized =
            tauri::async_runtime::block_on(worker.submit(Duration::from_secs(1), || {
                use windows_sys::Win32::System::Com::{CoGetApartmentType, APTTYPE_MTA};
                let (mut apartment, mut qualifier) = (-1, 0);
                let hr = unsafe { CoGetApartmentType(&mut apartment, &mut qualifier) };
                Ok(hr >= 0 && apartment == APTTYPE_MTA)
            }))
            .unwrap();
        assert!(
            initialized,
            "notification work must run in an initialized COM MTA, not the Tao thread"
        );
    }
}
