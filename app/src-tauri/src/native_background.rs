//! Native work must never make the Tao message thread wait for I/O.
#[path = "native_pipe.rs"]
mod pipe;
#[path = "native_lifecycle.rs"]
pub(crate) mod lifecycle;
pub(crate) use pipe::PipeWriter;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Default)]
pub(crate) struct ProbeCache {
    entries: Mutex<HashMap<String, Arc<OnceLock<bool>>>>,
}
impl ProbeCache {
    pub(crate) fn get_or_probe(&self, key: String, probe: impl FnOnce() -> bool) -> bool {
        let entry = {
            let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
            // Bound retained capability keys; an in-flight cell remains alive in its caller.
            if entries.len() >= 256 && !entries.contains_key(&key) {
                entries.retain(|_, cell| cell.get().is_none());
            }
            entries.entry(key).or_default().clone()
        };
        *entry.get_or_init(probe)
    }
}

pub(crate) async fn run_bounded<T: Send + 'static>(
    limit: Arc<tokio::sync::Semaphore>,
    timeout: std::time::Duration,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = limit
        .try_acquire_owned()
        .map_err(|_| "后台任务繁忙，请稍后重试。".to_string())?;
    run_with_permit(permit, timeout, work).await
}

/// Queue update work asynchronously without tying up a blocking worker while waiting.
pub(crate) async fn run_queued<T: Send + 'static>(
    limit: Arc<tokio::sync::Semaphore>,
    timeout: std::time::Duration,
    on_started: impl FnOnce(),
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let permit = limit
        .acquire_owned()
        .await
        .map_err(|_| "后台更新通道已关闭。".to_string())?;
    on_started();
    run_with_permit(permit, timeout, work).await
}

async fn run_with_permit<T: Send + 'static>(
    permit: tokio::sync::OwnedSemaphorePermit,
    timeout: std::time::Duration,
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // A timed-out blocking task keeps its permit until it REALLY exits.
    tokio::time::timeout(
        timeout,
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            work()
        }),
    )
    .await
    .map_err(|_| "后台任务超时。".to_string())?
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// Gateway-only receipt path. The caller owns a mailbox, never the task handle.
pub(crate) async fn run_bounded_tracked<T: Send + 'static, C: lifecycle::Cleanup>(
    root: Arc<lifecycle::CleanupRoot<C>>,
    limit: Arc<tokio::sync::Semaphore>,
    timeout: std::time::Duration,
    work: impl FnOnce(lifecycle::TrackedAdmission<C>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    use lifecycle::{ReceiptSignals, TaskReceipt};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::atomic::Ordering;
    use std::task::{Context, Poll};
    type Handle<T> = tauri::async_runtime::JoinHandle<Result<T, String>>;
    struct Receipt<T> {
        handle: Arc<Mutex<Option<Handle<T>>>>,
        result: Option<tokio::sync::oneshot::Sender<Result<T, String>>>,
        signals: Arc<ReceiptSignals>,
    }
    impl<T: Send + 'static> TaskReceipt for Receipt<T> {
        fn poll(&mut self, cx: &mut Context<'_>) -> Poll<bool> {
            let mut handle = {
                let mut cell = self
                    .handle
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let Some(handle) = cell.take() else {
                    return Poll::Ready(false);
                };
                handle
            };
            let output = match Pin::new(&mut handle).poll(cx) {
                Poll::Pending => {
                    *self
                        .handle
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = Some(handle);
                    return Poll::Pending;
                }
                Poll::Ready(output) => output,
            };
            // Real Future output was extracted once; handle Drop is outside locks.
            drop(handle);
            self.signals.join_consumed.store(true, Ordering::Release);
            if let Err(tauri::Error::JoinError(error)) = &output {
                self.signals
                    .join_panic
                    .store(error.is_panic(), Ordering::Release);
                self.signals
                    .join_cancelled
                    .store(error.is_cancelled(), Ordering::Release);
            }
            let normal = output.is_ok();
            self.signals.join_failed.store(!normal, Ordering::Release);
            let output = output.unwrap_or_else(|error| Err(format!("后台任务失败: {error}")));
            if let Some(sender) = self.result.take() {
                // A dropped waiter returns the exact orphan for lock-free disposal.
                if let Err(orphan) = sender.send(output) {
                    drop(orphan);
                }
            } else {
                drop(output);
            }
            Poll::Ready(normal)
        }
    }
    struct PermitReturn {
        permit: Option<tokio::sync::OwnedSemaphorePermit>,
        signals: Arc<ReceiptSignals>,
    }
    impl Drop for PermitReturn {
        fn drop(&mut self) {
            drop(self.permit.take());
            self.signals.permit_returned.store(true, Ordering::Release);
        }
    }
    // All allocations and the rooted bounded slot precede spawn and first await.
    let signals = Arc::new(ReceiptSignals::default());
    let handle = Arc::new(Mutex::new(None));
    let (sender, waiter) = tokio::sync::oneshot::channel();
    let admission = root.reserve_receipt(
        Box::new(Receipt {
            handle: handle.clone(),
            result: Some(sender),
            signals: signals.clone(),
        }),
        signals.clone(),
    )?;
    let permit = match limit.try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            root.cancel_unlaunched(&admission);
            return Err("后台任务繁忙，请稍后重试。".into());
        }
    };
    // Only an installation capability remains here, not a caller-owned handle.
    let worker_admission = lifecycle::TrackedAdmission::copy_capability(&admission);
    let task = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        tauri::async_runtime::spawn_blocking(move || {
            let _return_permit = PermitReturn {
                permit: Some(permit),
                signals,
            };
            work(worker_admission)
        })
    })) {
        Ok(task) => task,
        Err(error) => {
            root.fail_receipt(&admission);
            drop(error);
            return Err("后台任务失败: receipt 启动未知。".into());
        }
    };
    *handle.lock().unwrap_or_else(|error| error.into_inner()) = Some(task);
    root.install_receipt(&admission);
    drop(handle);
    drop(admission);
    tokio::time::timeout(timeout, waiter)
        .await
        .map_err(|_| "后台任务超时。".to_string())?
        .map_err(|_| "后台任务失败: receipt 结果不可用。".to_string())?
}

pub(crate) fn probe_lane() -> Arc<tokio::sync::Semaphore> {
    static LANE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    LANE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
}
pub(crate) fn control_lane() -> Arc<tokio::sync::Semaphore> {
    static LANE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    LANE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
        .clone()
}
pub(crate) fn gateway_lane() -> Arc<tokio::sync::Semaphore> {
    static LANE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    LANE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(8)))
        .clone()
}
pub(crate) fn file_lane() -> Arc<tokio::sync::Semaphore> {
    static LANE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    LANE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
}

pub(crate) fn update_lane() -> Arc<tokio::sync::Semaphore> {
    static LANE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    LANE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone()
}

pub(crate) fn with_detached_state<S: Default, T>(
    state: &Mutex<S>,
    work: impl FnOnce(&mut S) -> T,
) -> T {
    struct Checkout<'a, S: Default> {
        target: &'a Mutex<S>,
        owned: Option<S>,
    }
    impl<S: Default> Drop for Checkout<'_, S> {
        fn drop(&mut self) {
            let old = {
                let mut state = self.target.lock().unwrap_or_else(|e| e.into_inner());
                std::mem::replace(&mut *state, self.owned.take().unwrap())
            };
            drop(old); // Destructors may do I/O: never run them under the state lock.
        }
    }
    let owned = std::mem::take(&mut *state.lock().unwrap_or_else(|e| e.into_inner()));
    let mut checkout = Checkout {
        target: state,
        owned: Some(owned),
    };
    work(checkout.owned.as_mut().unwrap())
}

pub(crate) fn wait_child_until(
    child: &mut std::process::Child,
    deadline: std::time::Instant,
) -> Result<std::process::ExitStatus, String> {
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status);
        }
        if std::time::Instant::now() >= deadline {
            return Err("等待进程退出超时。".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

pub(crate) fn join_until<T>(
    worker: std::thread::JoinHandle<T>,
    deadline: std::time::Instant,
) -> Result<T, String> {
    while !worker.is_finished() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if worker.is_finished() {
        return worker.join().map_err(|_| "后台管道任务 panic。".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            windows_sys::Win32::System::IO::CancelSynchronousIo(worker.as_raw_handle() as _);
        }
    }
    let cancel_deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
    while !worker.is_finished() && std::time::Instant::now() < cancel_deadline {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    if worker.is_finished() {
        let _ = worker.join();
    }
    Err("后台管道收尾超时，未确认完整输出。".into())
}

pub(crate) fn stream_lane() -> Arc<tokio::sync::Semaphore> {
    static LANE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    LANE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(16)))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[test]
    fn blocking_operation_releases_state_lock() {
        let state = Mutex::new(7usize);
        let lock_available = with_detached_state(&state, |value| {
            *value += 1;
            state.try_lock().is_ok()
        });
        assert!(
            lock_available,
            "state snapshots cannot share a lock with I/O"
        );
        assert_eq!(*state.lock().unwrap(), 8);
    }
    #[test]
    fn worker_drain_obeys_deadline() {
        let worker = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(500));
            7
        });
        let start = std::time::Instant::now();
        let result = join_until(worker, start + std::time::Duration::from_millis(20));
        assert!(
            result.is_err(),
            "an inherited pipe must not make teardown wait forever"
        );
        assert!(start.elapsed() < std::time::Duration::from_millis(350));
    }
    #[test]
    fn real_process_wait_respects_cleanup_deadline() {
        let mut child = crate::new_spawn_command("C:/Program Files/nodejs/node.exe")
            .args(["-e", "setTimeout(()=>{},300)"])
            .spawn()
            .unwrap();
        let started = std::time::Instant::now();
        let result = wait_child_until(&mut child, started + std::time::Duration::from_millis(30));
        let elapsed = started.elapsed();
        let _ = child.kill();
        let _ = child.wait();
        assert!(result.is_err(), "cleanup must stop waiting at its deadline");
        assert!(elapsed < std::time::Duration::from_millis(150));
    }
    #[test]
    fn overloaded_background_lane_rejects_without_spawning() {
        tauri::async_runtime::block_on(async {
            let lane = Arc::new(tokio::sync::Semaphore::new(1));
            let permit = lane.clone().acquire_owned().await.unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let observed = calls.clone();
            let result = run_bounded(lane, std::time::Duration::from_secs(1), move || {
                observed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
            drop(permit);
            assert!(
                result.is_err(),
                "overload must not enqueue unbounded blocking work"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        });
    }
    #[test]
    fn queued_update_waits_for_a_permit_before_starting_its_timeout() {
        tauri::async_runtime::block_on(async {
            use std::time::Duration;
            let lane = Arc::new(tokio::sync::Semaphore::new(1));
            let permit = lane.clone().acquire_owned().await.unwrap();
            let started = Arc::new(AtomicUsize::new(0));
            let started_observed = started.clone();
            let task = tauri::async_runtime::spawn(run_queued(
                lane,
                Duration::from_millis(50),
                move || { started_observed.fetch_add(1, Ordering::SeqCst); },
                || Ok(42),
            ));
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(started.load(Ordering::SeqCst), 0);
            drop(permit);
            assert_eq!(task.await.unwrap().unwrap(), 42);
            assert_eq!(started.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn queued_update_waits_for_timed_out_worker_to_really_exit() {
        tauri::async_runtime::block_on(async {
            use std::time::Duration;
            let lane = Arc::new(tokio::sync::Semaphore::new(1));
            let (release, wait) = std::sync::mpsc::channel::<()>();
            let (worker_started, worker_ready) = tokio::sync::oneshot::channel();
            let first = tauri::async_runtime::spawn(run_queued(
                lane.clone(),
                Duration::from_millis(50),
                || {},
                move || {
                    let _ = worker_started.send(());
                    let _ = wait.recv();
                    Ok(())
                },
            ));
            worker_ready.await.unwrap();
            let started = Arc::new(AtomicUsize::new(0));
            let started_observed = started.clone();
            let second = tauri::async_runtime::spawn(run_queued(
                lane,
                Duration::from_secs(1),
                move || { started_observed.fetch_add(1, Ordering::SeqCst); },
                || Ok(42),
            ));
            assert!(first.await.unwrap().is_err());
            assert_eq!(started.load(Ordering::SeqCst), 0);
            release.send(()).unwrap();
            assert_eq!(second.await.unwrap().unwrap(), 42);
            assert_eq!(started.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn concurrent_capability_probe_runs_once_per_key() {
        let cache = Arc::new(ProbeCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let (cache, calls, barrier) = (cache.clone(), calls.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    cache.get_or_probe("fixture".into(), || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(30));
                        true
                    })
                })
            })
            .collect();
        for task in tasks {
            assert!(task.join().unwrap());
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "concurrent cache misses must share one probe"
        );
    }
}
