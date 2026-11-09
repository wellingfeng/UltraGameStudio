use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
pub(crate) trait PipeSink: Write + Send + std::os::windows::io::AsHandle {}
#[cfg(windows)]
impl<T: Write + Send + std::os::windows::io::AsHandle> PipeSink for T {}
#[cfg(not(windows))]
pub(crate) trait PipeSink: Write + Send {}
#[cfg(not(windows))]
impl<T: Write + Send> PipeSink for T {}

struct WriteRequest {
    bytes: Vec<u8>,
    deadline: Instant,
    reply: mpsc::Sender<Result<(), String>>,
    _bytes: BytePermit,
}
static WRITERS: AtomicUsize = AtomicUsize::new(0);

struct ByteBudget {
    used: AtomicUsize,
    limit: usize,
}
struct BytePermit {
    budget: Arc<ByteBudget>,
    bytes: usize,
}
impl Drop for BytePermit {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
impl ByteBudget {
    fn reserve(self: &Arc<Self>, bytes: usize) -> Result<BytePermit, String> {
        self.used
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|next| *next <= self.limit)
            })
            .map_err(|_| "管道排队字节达到上限。".to_string())?;
        Ok(BytePermit {
            budget: self.clone(),
            bytes,
        })
    }
}
struct WriterSlot;
impl Drop for WriterSlot {
    fn drop(&mut self) {
        WRITERS.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) struct PipeWriter {
    queue: mpsc::SyncSender<WriteRequest>,
    closed: Arc<AtomicBool>,
    writer_joined: Arc<AtomicBool>,
    cleanup: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl PipeWriter {
    pub(crate) fn new(writer: impl PipeSink + 'static) -> Result<Arc<Self>, String> {
        Self::new_with_spawner(writer, |name, work| {
            std::thread::Builder::new().name(name.into()).spawn(work)
        })
    }
    fn new_with_spawner(
        mut writer: impl PipeSink + 'static,
        mut spawn: impl FnMut(
            &str,
            Box<dyn FnOnce() + Send>,
        ) -> std::io::Result<std::thread::JoinHandle<()>>,
    ) -> Result<Arc<Self>, String> {
        // ChildStdin can perform overlapped I/O even though Write blocks its
        // caller. Keep an owned duplicate so cleanup cannot use a recycled handle.
        #[cfg(windows)]
        let cancellation_handle = writer
            .as_handle()
            .try_clone_to_owned()
            .map_err(|e| format!("复制管道取消句柄失败: {e}"))?;
        WRITERS
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < 64).then_some(n + 1)
            })
            .map_err(|_| "管道后台任务繁忙。".to_string())?;
        let slot = Arc::new(WriterSlot);
        let worker_slot = slot.clone();
        let (queue, receiver) = mpsc::sync_channel::<WriteRequest>(32);
        let closed = Arc::new(AtomicBool::new(false));
        let stop = closed.clone();
        let cleanup_stop = closed.clone();
        let writer_joined = Arc::new(AtomicBool::new(false));
        let joined = writer_joined.clone();
        let (attach, attached) = mpsc::sync_channel::<std::thread::JoinHandle<()>>(1);
        // Establish cleanup ownership before the writer can execute. A failure
        // to create this supervisor must never leave an uncancellable writer.
        let cleanup = spawn(
            "ugs-pipe-cleanup",
            Box::new(move || {
                // Share admission with the actual worker: neither a close nor a
                // cancelled reply releases it before the writer has really exited.
                let _slot = slot;
                let Ok(worker) = attached.recv() else {
                    return;
                };
                while !worker.is_finished() {
                    let closing = cleanup_stop.load(Ordering::SeqCst);
                    if closing {
                        // A single cancellation can run BEFORE WriteFile, or
                        // between write_all's writes. Retry until confirmed exit.
                        #[cfg(windows)]
                        {
                            use std::os::windows::io::AsRawHandle;
                            unsafe {
                                windows_sys::Win32::System::IO::CancelSynchronousIo(
                                    worker.as_raw_handle() as _,
                                );
                                windows_sys::Win32::System::IO::CancelIoEx(
                                    cancellation_handle.as_raw_handle() as _,
                                    std::ptr::null(),
                                );
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_millis(if closing { 5 } else { 20 }));
                }
                joined.store(worker.join().is_ok(), Ordering::Release);
            }),
        )
        .map_err(|e| format!("启动管道清理任务失败: {e}"))?;
        let worker = spawn(
            "ugs-pipe-writer",
            Box::new(move || {
                let _slot = worker_slot;
                while !stop.load(Ordering::SeqCst) {
                    let request = match receiver.recv_timeout(Duration::from_millis(20)) {
                        Ok(request) => request,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };
                    if stop.load(Ordering::SeqCst) || Instant::now() >= request.deadline {
                        let _ = request.reply.send(Err("管道请求已超时，未写入。".into()));
                        continue;
                    }
                    let result = writer
                        .write_all(&request.bytes)
                        .and_then(|_| writer.flush())
                        .map_err(|e| format!("管道写入失败: {e}"));
                    let failed = result.is_err();
                    let _ = request.reply.send(result);
                    if failed {
                        break;
                    }
                }
                stop.store(true, Ordering::SeqCst);
                for request in receiver.try_iter() {
                    let _ = request.reply.send(Err("管道已关闭。".into()));
                }
            }),
        );
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => {
                // No writer exists and disconnecting the attach channel lets
                // the already-owned supervisor exit without waiting on I/O.
                drop(attach);
                let _ = cleanup.join();
                return Err(format!("启动管道任务失败: {error}"));
            }
        };
        if let Err(error) = attach.send(worker) {
            // The queue has not been published: this writer cannot be inside
            // a user write, so closing/disconnecting it permits a real join.
            closed.store(true, Ordering::SeqCst);
            drop(queue);
            let _ = error.0.join();
            let _ = cleanup.join();
            return Err("管道清理任务在初始化期间退出。".into());
        }
        Ok(Arc::new(Self {
            queue,
            closed,
            writer_joined,
            cleanup: Mutex::new(Some(cleanup)),
        }))
    }
    pub(crate) fn write_bytes(&self, bytes: Vec<u8>, deadline: Instant) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("管道已关闭。".into());
        }
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("管道请求超过 16MiB 上限。".into());
        }
        static BUDGET: std::sync::OnceLock<Arc<ByteBudget>> = std::sync::OnceLock::new();
        let permit = BUDGET
            .get_or_init(|| {
                Arc::new(ByteBudget {
                    used: AtomicUsize::new(0),
                    limit: 64 * 1024 * 1024,
                })
            })
            .reserve(bytes.len())?;
        let (reply, result) = mpsc::channel();
        self.queue
            .try_send(WriteRequest {
                bytes,
                deadline,
                reply,
                _bytes: permit,
            })
            .map_err(|_| "管道队列繁忙或已关闭。".to_string())?;
        match result.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(result) => result,
            Err(_) => {
                // In-flight writes may be partial. Close the transport rather than
                // silently delivering timed-out text later or pretending success.
                self.close();
                Err("管道写入超时，传输已关闭（请求可能部分写入）。".into())
            }
        }
    }
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }
    pub(crate) fn cleanup_complete(&self) -> bool {
        // close() is only intent. The writer must be joined, its admission
        // released, and the cleanup thread itself joined before acknowledging.
        if !self.writer_joined.load(Ordering::Acquire) {
            return false;
        }
        let Ok(mut cleanup) = self.cleanup.try_lock() else {
            return false;
        };
        // A concurrent poll may already have consumed a failed join.
        if !self.writer_joined.load(Ordering::Acquire) {
            return false;
        }
        if let Some(worker) = cleanup.as_ref() {
            if !worker.is_finished() {
                return false;
            }
        }
        if let Some(worker) = cleanup.take() {
            if worker.join().is_err() {
                self.writer_joined.store(false, Ordering::Release);
                return false;
            }
        }
        true
    }
}
impl Drop for PipeWriter {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn failed_actual_writer_join_never_acknowledges_repeated_cleanup_polls() {
        use std::os::windows::io::{AsHandle, BorrowedHandle};
        use std::os::windows::process::CommandExt;
        struct PanickingSink(std::process::ChildStdin);
        impl AsHandle for PanickingSink {
            fn as_handle(&self) -> BorrowedHandle<'_> {
                self.0.as_handle()
            }
        }
        impl Write for PanickingSink {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                panic!("fixture actual writer panic");
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let slots_before = WRITERS.load(Ordering::SeqCst);
        let mut child = BlockedPipeFixture(
            Command::new("C:/Program Files/nodejs/node.exe")
                .creation_flags(0x08000000)
                .args(["-e", "setTimeout(()=>{},5000)"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let writer = PipeWriter::new(PanickingSink(child.0.stdin.take().unwrap())).unwrap();
        let write_result =
            writer.write_bytes(vec![b'x'; 16], Instant::now() + Duration::from_millis(400));
        let deadline = Instant::now() + Duration::from_millis(400);
        let cleanup_finished = loop {
            if writer
                .cleanup
                .lock()
                .unwrap()
                .as_ref()
                .map_or(true, |h| h.is_finished())
            {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let receipts = [writer.cleanup_complete(), writer.cleanup_complete()];
        // Reap the owned supervisor even when a failed writer join refuses ACK.
        let cleanup_joined = writer
            .cleanup
            .lock()
            .unwrap()
            .take()
            .map_or(true, |h| h.join().is_ok());
        let slots_after = WRITERS.load(Ordering::SeqCst);
        let peer_alive = child.0.try_wait().map(|status| status.is_none());
        let peer_pid = child.0.id();
        drop(writer);
        drop(child);
        eprintln!("receipt actual_writer_panic write_result={write_result:?} cleanup_finished={cleanup_finished} cleanup_joined={cleanup_joined} receipts={receipts:?} slots={slots_before}->{slots_after} peer_alive={peer_alive:?} owned_peer_pid={peer_pid}");
        assert!(write_result.is_err() && cleanup_finished && cleanup_joined);
        assert!(matches!(peer_alive, Ok(true)));
        assert_eq!(slots_before, slots_after);
        assert_eq!(
            receipts,
            [false, false],
            "an actual writer join panic must never acknowledge cleanup"
        );
    }

    #[test]
    fn failed_cleanup_join_is_not_acknowledged_on_a_later_poll() {
        let worker = std::thread::spawn(|| panic!("fixture cleanup failure"));
        let deadline = Instant::now() + Duration::from_millis(400);
        while !worker.is_finished() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let (queue, _receiver) = mpsc::sync_channel(1);
        let writer = PipeWriter {
            queue,
            closed: Arc::new(AtomicBool::new(true)),
            writer_joined: Arc::new(AtomicBool::new(true)),
            cleanup: Mutex::new(Some(worker)),
        };
        let first = writer.cleanup_complete();
        let second = writer.cleanup_complete();
        assert!(
            !first && !second,
            "a failed join must remain unconfirmed on repeated polls"
        );
    }

    #[test]
    fn pipe_byte_budget_rejects_until_inflight_request_really_finishes() {
        let budget = Arc::new(ByteBudget {
            used: AtomicUsize::new(0),
            limit: 8,
        });
        let first = budget.reserve(6).unwrap();
        assert!(
            budget.reserve(3).is_err(),
            "bounded request count must also bound queued bytes"
        );
        drop(first);
        assert!(budget.reserve(3).is_ok());
    }
    use std::process::{Command, Stdio};

    #[cfg(windows)]
    struct BlockedPipeFixture(std::process::Child);
    #[cfg(windows)]
    impl Drop for BlockedPipeFixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(windows)]
    struct PausedPipeWrite<W> {
        stdin: W,
        entered: mpsc::Sender<()>,
        resume: Option<mpsc::Receiver<()>>,
        short_first_write: bool,
    }
    #[cfg(windows)]
    impl<W: std::os::windows::io::AsHandle> std::os::windows::io::AsHandle for PausedPipeWrite<W> {
        fn as_handle(&self) -> std::os::windows::io::BorrowedHandle<'_> {
            self.stdin.as_handle()
        }
    }
    #[cfg(windows)]
    impl<W: Write> Write for PausedPipeWrite<W> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.short_first_write {
                self.short_first_write = false;
                return self.stdin.write(&bytes[..1]);
            }
            if let Some(resume) = self.resume.take() {
                self.entered.send(()).unwrap();
                resume.recv().unwrap();
            }
            // This is real synchronous pipe I/O, AFTER PipeWriter's closed check.
            self.stdin.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.stdin.flush()
        }
    }

    #[cfg(windows)]
    #[test]
    fn cleanup_spawn_failure_prevents_any_writer_thread_from_starting() {
        use std::os::windows::process::CommandExt;
        let mut child = BlockedPipeFixture(
            Command::new("C:/Program Files/nodejs/node.exe")
                .creation_flags(0x08000000)
                .args(["-e", "setTimeout(()=>{},5000)"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let slots_before = WRITERS.load(Ordering::SeqCst);
        let mut writer_spawns = 0;
        let result = PipeWriter::new_with_spawner(child.0.stdin.take().unwrap(), |name, work| {
            if name == "ugs-pipe-cleanup" {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "fixture cleanup creation refused",
                ));
            }
            let thread = std::thread::Builder::new().name(name.into()).spawn(work)?;
            writer_spawns += 1;
            Ok(thread)
        });
        let error = result.err().unwrap();
        let deadline = Instant::now() + Duration::from_millis(400);
        while WRITERS.load(Ordering::SeqCst) != slots_before && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let slots_after = WRITERS.load(Ordering::SeqCst);
        drop(child);
        assert!(error.contains("fixture cleanup creation refused"));
        assert_eq!(
            writer_spawns, 0,
            "cleanup capacity must exist before a real writer thread starts"
        );
        assert_eq!(
            slots_after, slots_before,
            "failed initialization must release its unused admission"
        );
    }

    #[cfg(windows)]
    #[test]
    fn close_receipt_stays_pending_until_the_actual_writer_is_joined() {
        use std::os::windows::process::CommandExt;
        let mut child = BlockedPipeFixture(
            Command::new("C:/Program Files/nodejs/node.exe")
                .creation_flags(0x08000000)
                .args(["-e", "setTimeout(()=>{},5000)"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let (entered, entered_rx) = mpsc::channel();
        let (resume, resume_rx) = mpsc::channel();
        struct ResumeOnDrop(Option<mpsc::Sender<()>>);
        impl Drop for ResumeOnDrop {
            fn drop(&mut self) {
                if let Some(resume) = self.0.take() {
                    let _ = resume.send(());
                }
            }
        }
        let mut resume = ResumeOnDrop(Some(resume));
        let slots_before = WRITERS.load(Ordering::SeqCst);
        let writer = PipeWriter::new(PausedPipeWrite {
            stdin: child.0.stdin.take().unwrap(),
            entered,
            resume: Some(resume_rx),
            short_first_write: false,
        })
        .unwrap();
        let budget = Arc::new(ByteBudget {
            used: AtomicUsize::new(0),
            limit: 1024 * 1024,
        });
        let (reply, result) = mpsc::channel();
        writer
            .queue
            .try_send(WriteRequest {
                bytes: vec![b'x'; 1024 * 1024],
                deadline: Instant::now() + Duration::from_secs(5),
                reply,
                _bytes: budget.reserve(1024 * 1024).unwrap(),
            })
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        writer.close();
        let premature_receipt = writer.cleanup_complete();
        let slots_while_paused = WRITERS.load(Ordering::SeqCst);
        let bytes_while_paused = budget.used.load(Ordering::Acquire);
        resume.0.take().unwrap().send(()).unwrap();
        let deadline = Instant::now() + Duration::from_millis(400);
        while !writer.cleanup_complete() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let complete = writer.cleanup_complete();
        let peer_alive = child.0.try_wait().unwrap().is_none();
        let slots_after = WRITERS.load(Ordering::SeqCst);
        let bytes_after = budget.used.load(Ordering::Acquire);
        let write_result = result.try_recv();
        drop(child);
        // Keep a failing receipt assertion from contaminating the next test's
        // process-wide admission baseline. Evidence above predates peer cleanup.
        drop(writer);
        let cleanup_deadline = Instant::now() + Duration::from_millis(400);
        while WRITERS.load(Ordering::SeqCst) != slots_before && Instant::now() < cleanup_deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            !premature_receipt,
            "close intent must not acknowledge an unjoined writer"
        );
        assert_eq!(slots_while_paused, slots_before + 1);
        assert_eq!(bytes_while_paused, 1024 * 1024);
        assert!(
            complete && peer_alive,
            "join receipt must complete without terminating the peer"
        );
        assert_eq!(
            slots_after, slots_before,
            "receipt cannot precede writer admission release"
        );
        assert_eq!(
            bytes_after, 0,
            "receipt cannot precede in-flight byte release"
        );
        assert!(matches!(write_result, Ok(Err(_))));
    }

    #[cfg(windows)]
    #[test]
    fn close_before_actual_write_reclaims_worker_and_bytes_without_peer_exit() {
        close_at_real_pipe_write_barrier(false);
    }

    #[cfg(windows)]
    #[test]
    fn close_between_write_all_chunks_reclaims_worker_without_peer_exit() {
        close_at_real_pipe_write_barrier(true);
    }

    #[cfg(windows)]
    fn close_at_real_pipe_write_barrier(short_first_write: bool) {
        use std::os::windows::process::CommandExt;
        let mut child = BlockedPipeFixture(
            Command::new("C:/Program Files/nodejs/node.exe")
                .creation_flags(0x08000000)
                .args(["-e", "setTimeout(()=>{},10000)"])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let (entered, entered_rx) = mpsc::channel();
        let (resume, resume_rx) = mpsc::channel();
        let slots_before = WRITERS.load(Ordering::SeqCst);
        let writer = PipeWriter::new(PausedPipeWrite {
            stdin: child.0.stdin.take().unwrap(),
            entered,
            resume: Some(resume_rx),
            short_first_write,
        })
        .unwrap();
        let budget = Arc::new(ByteBudget {
            used: AtomicUsize::new(0),
            limit: 2 * 1024 * 1024,
        });
        let (reply, result) = mpsc::channel();
        writer
            .queue
            .try_send(WriteRequest {
                bytes: vec![b'x'; 1024 * 1024],
                deadline: Instant::now() + Duration::from_secs(5),
                reply,
                _bytes: budget.reserve(1024 * 1024).unwrap(),
            })
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        writer.close();
        // The close-time cancellation sees no pending WriteFile at this barrier.
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(WRITERS.load(Ordering::SeqCst), slots_before + 1);
        assert_eq!(budget.used.load(Ordering::Acquire), 1024 * 1024);
        resume.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_millis(400);
        while WRITERS.load(Ordering::SeqCst) != slots_before && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        // Capture all evidence BEFORE fixture cleanup can unblock the pipe.
        let peer_alive = child.0.try_wait().unwrap().is_none();
        let slots_after = WRITERS.load(Ordering::SeqCst);
        let bytes_after = budget.used.load(Ordering::Acquire);
        let reply = result.try_recv();
        drop(child);
        assert!(peer_alive, "fixture must still impose real backpressure");
        assert_eq!(
            slots_after, slots_before,
            "close missed the pending real pipe write"
        );
        assert_eq!(
            bytes_after, 0,
            "in-flight bytes must be reclaimed only on worker exit"
        );
        assert!(
            matches!(reply, Ok(Err(_))),
            "cancelled write cannot report success"
        );
    }

    #[cfg(windows)]
    #[test]
    fn drop_before_synchronous_write_reclaims_worker_with_read_end_open() {
        use std::ffi::c_void;
        use std::os::windows::io::FromRawHandle;
        #[link(name = "kernel32")]
        extern "system" {
            fn CreatePipe(
                read: *mut *mut c_void,
                write: *mut *mut c_void,
                attributes: *const c_void,
                size: u32,
            ) -> i32;
        }
        let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
        assert_ne!(
            unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 4096) },
            0
        );
        let read = unsafe { std::fs::File::from_raw_handle(read) };
        let write = unsafe { std::fs::File::from_raw_handle(write) };
        let (entered, entered_rx) = mpsc::channel();
        let (resume, resume_rx) = mpsc::channel();
        let slots_before = WRITERS.load(Ordering::SeqCst);
        let writer = PipeWriter::new(PausedPipeWrite {
            stdin: write,
            entered,
            resume: Some(resume_rx),
            short_first_write: false,
        })
        .unwrap();
        let budget = Arc::new(ByteBudget {
            used: AtomicUsize::new(0),
            limit: 1024 * 1024,
        });
        let (reply, result) = mpsc::channel();
        writer
            .queue
            .try_send(WriteRequest {
                bytes: vec![b'x'; 1024 * 1024],
                deadline: Instant::now() + Duration::from_secs(5),
                reply,
                _bytes: budget.reserve(1024 * 1024).unwrap(),
            })
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(writer); // Drop must retain a cleanup owner after PipeWriter is gone.
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(WRITERS.load(Ordering::SeqCst), slots_before + 1);
        assert_eq!(budget.used.load(Ordering::Acquire), 1024 * 1024);
        resume.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_millis(400);
        while WRITERS.load(Ordering::SeqCst) != slots_before && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        let slots_after = WRITERS.load(Ordering::SeqCst);
        let bytes_after = budget.used.load(Ordering::Acquire);
        let reply = result.try_recv();
        // The read end stayed open and never consumed any bytes until NOW.
        drop(read);
        assert_eq!(
            slots_after, slots_before,
            "synchronous WriteFile was not cancelled"
        );
        assert_eq!(bytes_after, 0);
        assert!(matches!(reply, Ok(Err(_))));
    }

    #[test]
    fn backpressured_real_pipe_returns_by_deadline() {
        let mut command = Command::new("C:/Program Files/nodejs/node.exe");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .args(["-e", "setTimeout(()=>{},5000)"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let writer = PipeWriter::new(child.stdin.take().unwrap()).unwrap();
        let killer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            child.kill().unwrap();
            child.wait().unwrap();
        });
        let started = Instant::now();
        let result =
            writer.write_bytes(vec![b'x'; 1024 * 1024], started + Duration::from_millis(50));
        let elapsed = started.elapsed();
        killer.join().unwrap();
        assert!(result.is_err());
        assert!(
            elapsed < Duration::from_millis(200),
            "pipe backpressure blocked caller for {elapsed:?}"
        );
    }
}
