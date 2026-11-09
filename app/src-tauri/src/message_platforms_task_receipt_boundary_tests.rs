use super::*;
use native_background::lifecycle::{Cleanup, CleanupRoot, CleanupState};
use std::time::Instant;
#[derive(Default)]
struct Ready;
impl Cleanup for Ready { fn poll(&mut self) -> bool { true } }
struct Tail { entered: mpsc::Sender<()>, release: mpsc::Receiver<()>, left: mpsc::Sender<bool> }
impl Drop for Tail {
    fn drop(&mut self) {
        let _ = self.entered.send(());
        let released = self.release.recv_timeout(Duration::from_secs(3)).is_ok();
        let _ = self.left.send(released);
    }
}
struct Release(Option<mpsc::Sender<()>>);
impl Release { fn release(&mut self) -> bool { self.0.take().is_some_and(|s| s.send(()).is_ok()) } }
impl Drop for Release { fn drop(&mut self) { self.release(); } }
fn tail() -> (Tail, mpsc::Receiver<()>, Release, mpsc::Receiver<bool>) {
    let (entered, entered_rx) = mpsc::channel(); let (release_tx, release) = mpsc::channel(); let (left, left_rx) = mpsc::channel();
    (Tail { entered, release, left }, entered_rx, Release(Some(release_tx)), left_rx)
}
fn until(mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !check() { if Instant::now() >= deadline { return false } std::thread::sleep(Duration::from_millis(2)); }
    true
}
#[test]
fn outer_abort_retains_actual_task_until_capture_join_and_own_permit() {
    let root = CleanupRoot::<Ready>::new(); let key = root.reserve().unwrap();
    let lane = Arc::new(tokio::sync::Semaphore::new(1));
    let (capture, entered, mut release, left) = tail();
    let r = root.clone(); let l = lane.clone();
    let outer = tauri::async_runtime::spawn(async move {
        let worker_root = r.clone();
        native_background::run_bounded_tracked(r, l, Duration::from_secs(3), move |admission| {
            worker_root.admit_request_tracked(key, &admission)?;
            std::hint::black_box(&capture);
            Ok(17usize)
        }).await
    });
    let entered = entered.recv_timeout(Duration::from_secs(3)).is_ok();
    outer.abort();
    let outer_cancelled = matches!(tauri::async_runtime::block_on(outer), Err(tauri::Error::JoinError(e)) if e.is_cancelled());
    root.draining(); root.handoff(key, |_| {});
    let before = root.receipt_evidence();
    let deadline = Instant::now() + Duration::from_millis(120); let mut pending = true;
    while Instant::now() < deadline { pending &= root.state()==CleanupState::Pending(key); std::thread::sleep(Duration::from_millis(2)); }
    let live_lane = lane.available_permits(); let denied = root.reserve().is_err();
    let released = release.release(); let left = left.recv_timeout(Duration::from_secs(3)).unwrap_or(false);
    let consumed = until(|| root.receipt_evidence()==(0,1,1,false));
    let stopped = until(|| root.state()==CleanupState::Stopped(key));
    println!("OUTER_ABORT entered={entered} outer_join_cancelled={outer_cancelled} before={before:?} pending={pending} lane={live_lane} released={released} tail_left={left} actual_receipts={consumed} stopped={stopped} supervisor_join=not_accessible");
    assert!(released && left && consumed && stopped);
    assert!(entered && outer_cancelled && pending && denied);
    assert_eq!(before,(1,0,0,false)); assert_eq!(live_lane,0);
}
#[test]
fn same_run_result_count_and_actual_panic_join_keep_truthful_retirement() {
    // Two actual tasks, same run. First live result is non-Clone; second business Err is exact.
    struct ValueOnce(usize);
    let root = CleanupRoot::<Ready>::new(); let key = root.reserve().unwrap();
    let lane = Arc::new(tokio::sync::Semaphore::new(2));
    let (a, ea, mut ra, la)=tail(); let (b, eb, mut rb, lb)=tail();
    let r=root.clone(); let l=lane.clone();
    let first=tauri::async_runtime::spawn(async move { let worker=r.clone();
        native_background::run_bounded_tracked(r,l,Duration::from_secs(3),move |admission| {
            worker.admit_request_tracked(key,&admission)?; std::hint::black_box(&a); Ok(ValueOnce(29))
        }).await
    });
    let r=root.clone(); let l=lane.clone();
    let second=tauri::async_runtime::spawn(async move { let worker=r.clone();
        native_background::run_bounded_tracked(r,l,Duration::from_secs(3),move |admission| {
            worker.admit_request_tracked(key,&admission)?; std::hint::black_box(&b); Err::<usize,_>("sentinel business error".into())
        }).await
    });
    let ea=ea.recv_timeout(Duration::from_secs(3)).is_ok(); let eb=eb.recv_timeout(Duration::from_secs(3)).is_ok();
    root.draining();root.handoff(key, |_| {});
    let two=root.receipt_evidence(); let released_a=ra.release();let left_a=la.recv_timeout(Duration::from_secs(3)).unwrap_or(false);
    let first_result=tauri::async_runtime::block_on(first);
    let first_exact=matches!(first_result,Ok(Ok(ValueOnce(29))));
    let first_consumed=until(|| root.receipt_evidence().0==1);let one=root.receipt_evidence();
    let still_pending=root.state()==CleanupState::Pending(key);let denied=root.reserve().is_err();
    let released_b=rb.release();let left_b=lb.recv_timeout(Duration::from_secs(3)).unwrap_or(false);
    let second_result=tauri::async_runtime::block_on(second);let business_exact=matches!(second_result,Ok(Err(ref e)) if e=="sentinel business error");
    let consumed=until(|| root.receipt_evidence()==(0,2,2,false));let stopped=until(|| root.state()==CleanupState::Stopped(key));
    // A separate private root is deliberately retained Unknown after the real panic JoinError.
    let panic_root=CleanupRoot::<Ready>::new();let panic_key=panic_root.reserve().unwrap();
    let (capture,entered,mut release,left)=tail();let r=panic_root.clone();let worker=r.clone();
    let panic_outer=tauri::async_runtime::spawn(async move {
        native_background::run_bounded_tracked(r,Arc::new(tokio::sync::Semaphore::new(1)),Duration::from_secs(3),move |admission| {
            worker.admit_request_tracked(panic_key,&admission)?;std::hint::black_box(&capture);
            panic!("owned blocking work panic sentinel");
            #[allow(unreachable_code)] Ok::<usize,String>(0)
        }).await
    });
    let entered=entered.recv_timeout(Duration::from_secs(3)).is_ok();panic_root.draining();panic_root.handoff(panic_key, |_| {});
    let panic_live=panic_root.receipt_evidence();let released=release.release();let left=left.recv_timeout(Duration::from_secs(3)).unwrap_or(false);
    let panic_result=tauri::async_runtime::block_on(panic_outer);
    let caller_failure=matches!(panic_result,Ok(Err(ref e)) if e.starts_with("后台任务失败: "));
    let panic_consumed=until(|| panic_root.receipt_evidence()==(1,1,1,true));
    let real_join_error=panic_root.receipt_join_errors();let panic_pending=panic_root.state()==CleanupState::Pending(panic_key);let panic_denied=panic_root.reserve().is_err();
    println!("RESULT_COUNT two={two:?} one={one:?} actual_first_join={first_consumed} first_exact={first_exact} business_exact={business_exact} own_receipts={consumed} stopped={stopped}; PANIC entered={entered} live={panic_live:?} released={released} tail_left={left} caller_failure={caller_failure} actual_join_consumed={panic_consumed} real_join_error={real_join_error:?} unknown_pending={panic_pending} replacement_denied={panic_denied} root_supervisor_join=not_accessible bounded_unknown_root_retained=true");
    assert!(released_a && left_a && released_b && left_b && released && left && consumed && panic_consumed);
    assert!(ea && eb && first_exact && business_exact && first_consumed && still_pending && denied && stopped);
    assert_eq!(two,(2,0,0,false));assert_eq!(one,(1,1,1,false));
    assert!(entered && caller_failure && panic_pending && panic_denied);assert_eq!(panic_live,(1,0,0,false));assert_eq!(real_join_error,(1,0));
}
