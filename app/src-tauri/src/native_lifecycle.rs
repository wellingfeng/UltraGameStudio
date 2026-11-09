//! A preallocated, process-lifetime cleanup cell. Retirement is evidence, not Drop.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, TryLockError};
use std::time::Duration;

pub(crate) trait Cleanup: Default + Send + 'static {
    /// Poll in place. False includes every unknown obligation.
    fn poll(&mut self) -> bool;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CleanupState {
    Vacant,
    Pending(u64),
    Stopped(u64),
}

struct Gate<T: Cleanup> {
    draining: bool,
    reserved: bool,
    handed_off: bool,
    sequence: u64,
    request_workers: usize,
    state: CleanupState,
    // One reserved handoff slot, allocated before admission, not a new queue.
    receipts: [ReceiptSlot<T>; 8],
    staging: Box<T>,
    staged: bool,
}

pub(crate) struct CleanupRoot<T: Cleanup> {
    gate: Mutex<Gate<T>>,
    // Allocated before any execution admission; never taken while unknown.
    payload: Mutex<Box<T>>,
    receipt_waker: std::task::Waker,
    ready: AtomicBool,
    supervisor: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// A run-bound obligation owned by the actual blocking request work.
pub(crate) struct RequestWorkerLease<T: Cleanup> {
    root: Arc<CleanupRoot<T>>,
    key: u64,
}

impl<T: Cleanup> Drop for RequestWorkerLease<T> {
    fn drop(&mut self) {
        let mut gate = match self.root.gate.lock() {
            Ok(gate) => gate,
            Err(_) => {
                self.root.ready.store(false, Ordering::Release);
                return;
            }
        };
        if gate.sequence != self.key || !gate.reserved {
            self.root.ready.store(false, Ordering::Release);
            return;
        }
        match gate.request_workers.checked_sub(1) {
            Some(remaining) => gate.request_workers = remaining,
            None => self.root.ready.store(false, Ordering::Release),
        }
        // Only the cleanup supervisor/empty-owner commit can publish Stopped.
    }
}

impl<T: Cleanup> CleanupRoot<T> {
    pub(crate) fn new() -> Arc<Self> {
        Self::new_with_spawner(|work| {
            std::thread::Builder::new()
                .name("gateway-root-cleanup".into())
                .spawn(work)
        })
    }

    fn new_with_spawner(
        spawn: impl FnOnce(Box<dyn FnOnce() + Send>) -> std::io::Result<std::thread::JoinHandle<()>>,
    ) -> Arc<Self> {
        let root = Arc::new(Self {
            gate: Mutex::new(Gate {
                draining: false,
                reserved: false,
                handed_off: false,
                sequence: 0,
                request_workers: 0,
                state: CleanupState::Vacant,
                receipts: std::array::from_fn(|_| ReceiptSlot::default()),
                staging: Box::default(),
                staged: false,
            }),
            payload: Mutex::new(Box::default()),
            receipt_waker: std::task::Waker::from(Arc::new(ReceiptWake)),
            ready: AtomicBool::new(false),
            supervisor: Mutex::new(None),
        });
        let weak = Arc::downgrade(&root);
        let (ready, received) = mpsc::sync_channel(1);
        let worker = spawn(Box::new(move || {
            let _ = ready.send(());
            loop {
                let Some(root) = weak.upgrade() else { return };
                root.poll_receipts();
                if !root.ready.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                root.poll_handoff();
                drop(root);
                std::thread::sleep(Duration::from_millis(5));
            }
        }));
        if let Ok(worker) = worker {
            *root.supervisor.lock().unwrap_or_else(|e| e.into_inner()) = Some(worker);
            if received.recv_timeout(Duration::from_millis(100)).is_ok() {
                root.ready.store(true, Ordering::Release);
            }
        }
        root
    }

    pub(crate) fn check_open(&self) -> Result<(), String> {
        let gate = self.gate.lock().map_err(|_| "消息网关生命周期锁失败。")?;
        if gate.draining {
            return Err("消息网关正在清理，未重新开放。".into());
        }
        if matches!(gate.state, CleanupState::Pending(_)) {
            return Err("消息网关清理 Pending，原 owner 仍被保留。".into());
        }
        Ok(())
    }

    pub(crate) fn reserve(&self) -> Result<u64, String> {
        let mut gate = self.gate.lock().map_err(|_| "消息网关生命周期锁失败。")?;
        let supervisor = self
            .supervisor
            .lock()
            .map_err(|_| "消息网关监督器锁失败。")?;
        if gate.draining
            || gate.reserved
            || gate.request_workers != 0
            || !self.ready.load(Ordering::Acquire)
            || supervisor
                .as_ref()
                .map_or(true, |worker| worker.is_finished())
        {
            return Err("消息网关清理容量或监督器不可用，拒绝创建进程。".into());
        }
        gate.sequence = gate
            .sequence
            .checked_add(1)
            .ok_or("消息网关 run identity 已耗尽。")?;
        gate.reserved = true;
        gate.handed_off = false;
        gate.state = CleanupState::Vacant;
        Ok(gate.sequence)
    }

    pub(crate) fn draining(&self) {
        // Recover poisoned metadata without dropping the resource payload.
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        gate.draining = true;
        if gate.reserved {
            gate.state = CleanupState::Pending(gate.sequence);
        }
    }

    pub(crate) fn admit_request(
        self: &Arc<Self>,
        key: u64,
    ) -> Result<RequestWorkerLease<T>, String> {
        let mut gate = self.gate.lock().map_err(|_| "消息网关生命周期锁失败。")?;
        let supervisor = self
            .supervisor
            .lock()
            .map_err(|_| "消息网关监督器锁失败。")?;
        if gate.draining
            || !gate.reserved
            || gate.sequence != key
            || gate.handed_off
            || matches!(gate.state, CleanupState::Pending(_))
            || !self.ready.load(Ordering::Acquire)
            || supervisor
                .as_ref()
                .map_or(true, |worker| worker.is_finished())
        {
            return Err("消息网关 request run 不可用，拒绝准入。".into());
        }
        gate.request_workers = gate
            .request_workers
            .checked_add(1)
            .ok_or("消息网关 request worker 容量已耗尽。")?;
        Ok(RequestWorkerLease {
            root: self.clone(),
            key,
        })
    }

    pub(crate) fn pending(&self, key: u64) -> CleanupState {
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        gate.state = CleanupState::Pending(key);
        gate.state
    }

    pub(crate) fn release_empty(&self, key: u64) -> bool {
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        if gate.sequence == key && gate.reserved && !gate.handed_off {
            if gate.request_workers != 0 || !self.ready.load(Ordering::Acquire) {
                gate.state = CleanupState::Pending(key);
                return false;
            }
            gate.reserved = false;
            gate.state = CleanupState::Stopped(key);
            return true;
        }
        false
    }

    pub(crate) fn handoff(&self, key: u64, transfer: impl FnOnce(&mut T)) {
        // Only the reserved execution owner installs this preallocated payload.
        // No thread creation, queue admission, allocation, kill or wait in Drop.
        let mut gate = self.gate.lock().unwrap_or_else(|e| e.into_inner());
        gate.reserved = true;
        gate.handed_off = true;
        gate.state = CleanupState::Pending(key);
        match self.payload.try_lock() {
            Ok(mut payload) => transfer(&mut payload),
            Err(TryLockError::WouldBlock) => {
                // The unique reserved owner installs into existing storage.
                // No closure/owner is discarded when cleanup owns the payload.
                gate.staged = true;
                transfer(&mut gate.staging);
            }
            Err(TryLockError::Poisoned(error)) => {
                self.ready.store(false, Ordering::Release);
                transfer(&mut error.into_inner());
            }
        }
    }

    pub(crate) fn state(&self) -> CleanupState {
        self.gate.lock().unwrap_or_else(|e| e.into_inner()).state
    }

    fn poll_handoff(&self) {
        let key = match self.gate.lock() {
            Ok(gate) if gate.handed_off => gate.sequence,
            Ok(_) => return,
            Err(_) => {
                self.ready.store(false, Ordering::Release);
                return;
            }
        };
        // Metadata never spans cleanup I/O or a wait for its payload.
        let mut payload = match self.payload.lock() {
            Ok(payload) => payload,
            Err(_) => {
                self.ready.store(false, Ordering::Release);
                return;
            }
        };
        {
            let mut gate = match self.gate.lock() {
                Ok(gate) => gate,
                Err(_) => {
                    self.ready.store(false, Ordering::Release);
                    return;
                }
            };
            if gate.sequence != key || !gate.handed_off {
                return;
            }
            if gate.staged {
                std::mem::swap(&mut *payload, &mut gate.staging);
                gate.staged = false;
            }
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| payload.poll()));
        match result {
            Ok(true) => {
                let mut gate = match self.gate.lock() {
                    Ok(gate) => gate,
                    Err(_) => {
                        self.ready.store(false, Ordering::Release);
                        return;
                    }
                };
                if gate.sequence == key
                    && gate.handed_off
                    && gate.request_workers == 0
                    && self.ready.load(Ordering::Acquire)
                {
                    gate.handed_off = false;
                    gate.reserved = false;
                    gate.state = CleanupState::Stopped(key);
                }
            }
            Ok(false) => {}
            Err(_) => {
                self.ready.store(false, Ordering::Release);
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn inspect<R>(&self, inspect: impl FnOnce(&T) -> R) -> R {
        inspect(&self.payload.lock().unwrap_or_else(|e| e.into_inner()))
    }

    #[cfg(test)]
    pub(crate) fn unavailable() -> Arc<Self> {
        Self::new_with_spawner(|_| {
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "fixture supervisor failure",
            ))
        })
    }
}

/// Std-only erased boundary: only the existing supervisor polls actual tasks.
pub(crate) trait TaskReceipt: Send {
    /// Ready(true) means a normal actual join and safe result delivery/disposal.
    fn poll(&mut self, cx: &mut std::task::Context<'_>) -> std::task::Poll<bool>;
}
#[derive(Default)]
pub(crate) struct ReceiptSignals {
    pub(crate) permit_returned: AtomicBool,
    pub(crate) join_consumed: AtomicBool,
    pub(crate) join_failed: AtomicBool,
    pub(crate) join_panic: AtomicBool,
    pub(crate) join_cancelled: AtomicBool,
}
struct ReceiptSlot<T: Cleanup> {
    generation: u64,
    launched: bool,
    polling: bool,
    unknown: bool,
    receipt: Option<Box<dyn TaskReceipt>>,
    signals: Option<Arc<ReceiptSignals>>,
    lease: Option<RequestWorkerLease<T>>,
}
impl<T: Cleanup> Default for ReceiptSlot<T> {
    fn default() -> Self {
        Self {
            generation: 0,
            launched: false,
            polling: false,
            unknown: false,
            receipt: None,
            signals: None,
            lease: None,
        }
    }
}
struct ReceiptWake;
impl std::task::Wake for ReceiptWake {
    fn wake(self: Arc<Self>) {}
}
/// Capability only; Drop never owns or retires a task or lease.
pub(crate) struct TrackedAdmission<T: Cleanup> {
    root: Arc<CleanupRoot<T>>,
    slot: usize,
    generation: u64,
}
impl<T: Cleanup> TrackedAdmission<T> {
    pub(crate) fn copy_capability(&self) -> Self {
        Self {
            root: self.root.clone(),
            slot: self.slot,
            generation: self.generation,
        }
    }
}
impl<T: Cleanup> CleanupRoot<T> {
    pub(crate) fn reserve_receipt(
        self: &Arc<Self>,
        receipt: Box<dyn TaskReceipt>,
        signals: Arc<ReceiptSignals>,
    ) -> Result<TrackedAdmission<T>, String> {
        let mut gate = self.gate.lock().map_err(|_| "消息网关生命周期锁失败。")?;
        let supervisor = self
            .supervisor
            .lock()
            .map_err(|_| "消息网关监督器锁失败。")?;
        if gate.draining
            || matches!(gate.state, CleanupState::Pending(_))
            || !self.ready.load(Ordering::Acquire)
            || supervisor
                .as_ref()
                .map_or(true, |worker| worker.is_finished())
        {
            return Err("消息网关 request run 不可用，拒绝准入。".into());
        }
        let index = gate
            .receipts
            .iter()
            .position(|slot| {
                slot.receipt.is_none() && !slot.polling && !slot.unknown && slot.lease.is_none()
            })
            .ok_or("后台任务繁忙，请稍后重试。")?;
        let slot = &mut gate.receipts[index];
        slot.generation = slot
            .generation
            .checked_add(1)
            .ok_or("消息网关 receipt identity 已耗尽。")?;
        slot.launched = false;
        slot.signals = Some(signals);
        slot.receipt = Some(receipt);
        Ok(TrackedAdmission {
            root: self.clone(),
            slot: index,
            generation: slot.generation,
        })
    }
    pub(crate) fn fail_receipt(&self, token: &TrackedAdmission<T>) {
        let mut gate = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        if std::ptr::eq(self, Arc::as_ptr(&token.root))
            && gate.receipts[token.slot].generation == token.generation
        {
            gate.receipts[token.slot].unknown = true;
        }
        self.ready.store(false, Ordering::Release);
    }
    pub(crate) fn install_receipt(&self, token: &TrackedAdmission<T>) {
        let mut gate = self.gate.lock().unwrap_or_else(|error| {
            self.ready.store(false, Ordering::Release);
            error.into_inner()
        });
        let slot = &mut gate.receipts[token.slot];
        if !std::ptr::eq(self, Arc::as_ptr(&token.root))
            || slot.generation != token.generation
            || slot.receipt.is_none()
            || slot.launched
        {
            slot.unknown = true;
            self.ready.store(false, Ordering::Release);
            return;
        }
        slot.launched = true;
    }
    pub(crate) fn cancel_unlaunched(&self, token: &TrackedAdmission<T>) {
        let receipt = {
            let mut gate = self.gate.lock().unwrap_or_else(|error| error.into_inner());
            let slot = &mut gate.receipts[token.slot];
            if std::ptr::eq(self, Arc::as_ptr(&token.root))
                && slot.generation == token.generation
                && !slot.launched
                && slot.lease.is_none()
            {
                slot.receipt.take()
            } else {
                None
            }
        };
        drop(receipt);
    }
    pub(crate) fn admit_request_tracked(
        self: &Arc<Self>,
        key: u64,
        token: &TrackedAdmission<T>,
    ) -> Result<(), String> {
        if !Arc::ptr_eq(self, &token.root) {
            token.root.fail_receipt(token);
            return Err("消息网关 request receipt root identity 不匹配。".into());
        }
        let mut gate = self.gate.lock().map_err(|_| "消息网关生命周期锁失败。")?;
        let supervisor = self
            .supervisor
            .lock()
            .map_err(|_| "消息网关监督器锁失败。")?;
        let valid = Arc::ptr_eq(self, &token.root)
            && token.slot < gate.receipts.len()
            && gate.receipts[token.slot].generation == token.generation
            && (gate.receipts[token.slot].receipt.is_some() || gate.receipts[token.slot].polling)
            && gate.receipts[token.slot].lease.is_none()
            && !gate.receipts[token.slot].unknown;
        if !valid
            || gate.draining
            || !gate.reserved
            || gate.sequence != key
            || gate.handed_off
            || matches!(gate.state, CleanupState::Pending(_))
            || !self.ready.load(Ordering::Acquire)
            || supervisor
                .as_ref()
                .map_or(true, |worker| worker.is_finished())
        {
            if Arc::ptr_eq(self, &token.root)
                && token.slot < gate.receipts.len()
                && gate.receipts[token.slot].generation == token.generation
            {
                gate.receipts[token.slot].unknown = true;
            }
            self.ready.store(false, Ordering::Release);
            return Err("消息网关 request receipt 不可用，拒绝准入。".into());
        }
        gate.request_workers = gate
            .request_workers
            .checked_add(1)
            .ok_or("消息网关 request worker 容量已耗尽。")?;
        gate.receipts[token.slot].lease = Some(RequestWorkerLease {
            root: self.clone(),
            key,
        });
        Ok(())
    }
    fn poll_receipts(&self) {
        for index in 0..8 {
            let claimed = {
                let mut gate = self.gate.lock().unwrap_or_else(|error| {
                    self.ready.store(false, Ordering::Release);
                    error.into_inner()
                });
                let slot = &mut gate.receipts[index];
                if !slot.launched || slot.polling || slot.unknown {
                    None
                } else {
                    slot.receipt.take().map(|receipt| {
                        slot.polling = true;
                        (slot.generation, receipt)
                    })
                }
            };
            let Some((generation, mut receipt)) = claimed else {
                continue;
            };
            let mut cx = std::task::Context::from_waker(&self.receipt_waker);
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| receipt.poll(&mut cx)));
            let (lease, retired) = {
                let mut gate = self.gate.lock().unwrap_or_else(|error| {
                    self.ready.store(false, Ordering::Release);
                    error.into_inner()
                });
                let slot = &mut gate.receipts[index];
                slot.polling = false;
                if slot.generation != generation {
                    slot.unknown = true;
                }
                let complete = matches!(result, Ok(std::task::Poll::Ready(true)))
                    && slot.signals.as_ref().is_some_and(|signals| {
                        signals.permit_returned.load(Ordering::Acquire)
                            && signals.join_consumed.load(Ordering::Acquire)
                    })
                    && !slot.unknown;
                if complete {
                    slot.polling = true;
                    (slot.lease.take(), true)
                } else {
                    if matches!(result, Err(_) | Ok(std::task::Poll::Ready(false))) {
                        slot.unknown = true;
                        self.ready.store(false, Ordering::Release);
                    }
                    slot.receipt = Some(receipt);
                    // Ownership returns to precisely this slot; no requeue allocation.
                    continue;
                }
            };
            if retired {
                // Erased payload and the unique lease are destroyed outside all gates.
                let dropped =
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(receipt)));
                if dropped.is_ok() {
                    drop(lease);
                    self.gate
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .receipts[index]
                        .polling = false;
                } else {
                    let mut gate = self.gate.lock().unwrap_or_else(|error| error.into_inner());
                    gate.receipts[index].unknown = true;
                    gate.receipts[index].lease = lease;
                    self.ready.store(false, Ordering::Release);
                }
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn receipt_evidence(&self) -> (usize, usize, usize, bool) {
        let gate = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        (
            gate.request_workers,
            gate.receipts
                .iter()
                .filter(|slot| {
                    slot.signals
                        .as_ref()
                        .is_some_and(|s| s.permit_returned.load(Ordering::Acquire))
                })
                .count(),
            gate.receipts
                .iter()
                .filter(|slot| {
                    slot.signals
                        .as_ref()
                        .is_some_and(|s| s.join_consumed.load(Ordering::Acquire))
                })
                .count(),
            gate.receipts.iter().any(|slot| slot.unknown),
        )
    }
    #[cfg(test)]
    pub(crate) fn receipt_join_errors(&self) -> (usize, usize) {
        let gate = self.gate.lock().unwrap_or_else(|error| error.into_inner());
        (
            gate.receipts
                .iter()
                .filter(|slot| {
                    slot.signals
                        .as_ref()
                        .is_some_and(|s| s.join_panic.load(Ordering::Acquire))
                })
                .count(),
            gate.receipts
                .iter()
                .filter(|slot| {
                    slot.signals
                        .as_ref()
                        .is_some_and(|s| s.join_cancelled.load(Ordering::Acquire))
                })
                .count(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Condvar};
    use std::time::Instant;

    #[derive(Default)]
    struct Payload {
        block: Option<Arc<Block>>,
        marker: Option<Marker>,
    }
    struct Block {
        released: Mutex<bool>,
        cv: Condvar,
        entered: Mutex<Option<mpsc::Sender<()>>>,
    }
    impl Block {
        fn new() -> (Arc<Self>, mpsc::Receiver<()>) {
            let (tx, rx) = mpsc::channel();
            (
                Arc::new(Self {
                    released: Mutex::new(false),
                    cv: Condvar::new(),
                    entered: Mutex::new(Some(tx)),
                }),
                rx,
            )
        }
        fn wait(&self) {
            if let Some(tx) = self.entered.lock().unwrap().take() {
                let _ = tx.send(());
            }
            let _guard = self
                .cv
                .wait_timeout_while(self.released.lock().unwrap(), Duration::from_secs(3), |r| {
                    !*r
                })
                .unwrap();
        }
        fn release(&self) {
            *self.released.lock().unwrap() = true;
            self.cv.notify_all();
        }
    }
    impl Cleanup for Payload {
        fn poll(&mut self) -> bool {
            if let Some(block) = &self.block {
                block.wait();
            }
            false
        }
    }

    #[test]
    fn real_cleanup_poll_does_not_block_draining_or_state() {
        let root = CleanupRoot::<Payload>::new();
        let key = root.reserve().unwrap();
        let (gate, entered) = Block::new();
        root.handoff(key, |payload| payload.block = Some(gate.clone()));
        let checkpoint = entered.recv_timeout(Duration::from_secs(1)).is_ok();
        let (tx, rx) = mpsc::channel();
        let r = root.clone();
        let worker = std::thread::spawn(move || {
            r.draining();
            tx.send((r.state(), r.check_open().is_err())).unwrap();
        });
        let observed = rx.recv_timeout(Duration::from_millis(120)).ok();
        gate.release();
        let joined = worker.join().is_ok();
        drop(root);
        println!("F01 checkpoint={checkpoint} gate_released=true own_thread_joined={joined}");
        assert!(checkpoint && joined);
        assert_eq!(observed, Some((CleanupState::Pending(key), true)));
    }

    struct Marker(Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for Marker {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    struct Owned {
        root: Arc<CleanupRoot<Payload>>,
        key: u64,
        marker: Option<Marker>,
    }
    impl Drop for Owned {
        fn drop(&mut self) {
            let marker = self.marker.take();
            self.root
                .handoff(self.key, |payload| payload.marker = marker);
        }
    }

    #[test]
    fn reserved_owner_drop_retains_resource_without_waiting_for_payload() {
        let root = CleanupRoot::<Payload>::new();
        let key = root.reserve().unwrap();
        let drops = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (gate, entered) = Block::new();
        let r = root.clone();
        let g = gate.clone();
        let holder = std::thread::spawn(move || r.inspect(|_| g.wait()));
        let checkpoint = entered.recv_timeout(Duration::from_secs(1)).is_ok();
        let owner = Owned {
            root: root.clone(),
            key,
            marker: Some(Marker(drops.clone())),
        };
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            drop(owner);
            tx.send(()).unwrap();
        });
        let returned = rx.recv_timeout(Duration::from_millis(120)).is_ok();
        let retained = drops.load(Ordering::SeqCst);
        gate.release();
        let holder_joined = holder.join().is_ok();
        let drop_joined = worker.join().is_ok();
        let state = root.state();
        let weak = Arc::downgrade(&root);
        drop(root);
        let until = Instant::now() + Duration::from_millis(300);
        while weak.upgrade().is_some() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(2));
        }
        let deallocated = weak.upgrade().is_none();
        println!("F02 checkpoint={checkpoint} gate_released=true own_threads_joined={} root_deallocated={deallocated} supervisor_join=not_accessible", usize::from(holder_joined) + usize::from(drop_joined));
        assert!(checkpoint && holder_joined && drop_joined && deallocated);
        assert_eq!(retained, 0);
        assert_eq!(state, CleanupState::Pending(key));
        assert_eq!(drops.load(Ordering::SeqCst), 1);
        assert!(
            returned,
            "legal reserved owner Drop waited for cleanup payload"
        );
    }
}
