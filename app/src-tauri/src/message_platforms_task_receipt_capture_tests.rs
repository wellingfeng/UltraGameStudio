use super::*;
use native_background::lifecycle::CleanupState;
use std::time::Instant;

struct Release(Option<mpsc::Sender<()>>);
impl Release {
    fn release(&mut self) -> bool {
        self.0.take().is_some_and(|sender| sender.send(()).is_ok())
    }
}
impl Drop for Release {
    fn drop(&mut self) {
        self.release();
    }
}

struct CapturedTail {
    entered: mpsc::Sender<()>,
    release: mpsc::Receiver<()>,
    finished: mpsc::Sender<bool>,
}
impl Drop for CapturedTail {
    fn drop(&mut self) {
        let _ = self.entered.send(());
        let released = self.release.recv_timeout(Duration::from_secs(3)).is_ok();
        let _ = self.finished.send(released);
    }
}

fn until(mut check: impl FnMut() -> bool, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    while !check() {
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    true
}

#[test]
fn closure_capture_drop_keeps_root_pending_until_real_wrapper_permit_returns() {
    let root = GatewayRoot::new();
    let key = root.reserve().unwrap();
    let sink = std::fs::OpenOptions::new().write(true).open("NUL").unwrap();
    let writer = PipeWriter::new(sink).unwrap();
    let state = Arc::new(Mutex::new(GatewayState {
        root: root.clone(),
        root_key: Some(key),
        unknown_obligations: false,
        deny_kill: false,
        child: None,
        job: None,
        stdin: Some(writer.clone()),
        pending: Default::default(),
        reader: None,
        statuses: Default::default(),
        sequence: 0,
        generation: Default::default(),
        ready_generation: 0,
    }));
    let lane = Arc::new(tokio::sync::Semaphore::new(1));
    let (written_tx, written_rx) = mpsc::channel();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let mut release = Release(Some(release_tx));
    let captured_tail = CapturedTail {
        entered: entered_tx,
        release: release_rx,
        finished: finished_tx,
    };
    let worker_state = state.clone();
    let worker_lane = lane.clone();
    let worker_root = root.clone();
    let outer = tauri::async_runtime::spawn(async move {
        native_background::run_bounded_tracked(worker_root, worker_lane, Duration::from_millis(50), move |admission| {
            // This is a real captured-value destructor, not a work-local tail.
            std::hint::black_box(&captured_tail);
            let queued;
            let (sender, receiver) = mpsc::channel();
            queued = {
                let mut state = worker_state.lock().map_err(|_| "fixture state lock")?;
                queue_gateway_request_tracked(&mut state, sender, &admission)?
            };
            let request_id = &queued.request_id;
            let line = format!("{}\n", json!({"requestId": request_id, "method": "owned-capture-drop"}));
            queued.stdin.write_bytes(line.into_bytes(), Instant::now() + Duration::from_secs(3))?;
            written_tx.send(request_id.clone()).map_err(|_| "written checkpoint")?;
            let reply = receiver.recv_timeout(Duration::from_secs(3));
            queued.pending.lock().map_err(|_| "fixture map lock")?.remove(request_id);
            let closed = matches!(reply, Ok(Err(_)));
            if !closed {
                return Err("expected real close response".into());
            }
            Ok(())
        })
        .await
    });
    let request_id = written_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let outer_result = tauri::async_runtime::block_on(outer).unwrap();
    let outer_timed_out = outer_result == Err("后台任务超时。".into());
    root.draining();
    state.lock().unwrap().handoff_cleanup();
    // Close the actual map response through the public owner cleanup path.
    state.lock().unwrap().clear_transport();
    // Handoff already took root_key/stdin but response clearing is still real.
    let capture_drop_entered = entered_rx.recv_timeout(Duration::from_secs(3)).is_ok();
    let actual_pipe_receipt = until(|| writer.cleanup_complete(), Duration::from_millis(500));
    let map_empty = state.lock().unwrap().pending.lock().unwrap().is_empty();
    let live_until = Instant::now() + Duration::from_millis(500);
    let mut continuously_pending = true;
    while Instant::now() < live_until {
        continuously_pending &= root.state() == CleanupState::Pending(key);
        std::thread::sleep(Duration::from_millis(2));
    }
    let live_state = root.state();
    let lane_live = lane.available_permits();
    let replacement_denied = root.reserve().is_err();
    let tail_released = release.release();
    let actual_capture_drop_finished = finished_rx.recv_timeout(Duration::from_secs(3)).unwrap_or(false);
    let actual_lane_returned = until(|| lane.available_permits() == 1, Duration::from_secs(3));
    let stopped_after_release = until(|| root.state() == CleanupState::Stopped(key), Duration::from_secs(3));
    let evidence = root.receipt_evidence();
    println!("ACTUAL_RECEIPT count={} own_permit_ack={} actual_join_consumed={} unknown={}", evidence.0, evidence.1, evidence.2, evidence.3);
    drop(state);
    drop(writer);
    println!("CAPTURE_DROP request={request_id} outer_timeout={outer_timed_out} capture_drop_entered={capture_drop_entered} map_empty={map_empty} pipe_receipt={actual_pipe_receipt} live_state={live_state:?} continuously_pending={continuously_pending} lane_live={lane_live} replacement_denied={replacement_denied} tail_released={tail_released} actual_capture_drop_finished={actual_capture_drop_finished} actual_lane_returned={actual_lane_returned} stopped_after_release={stopped_after_release} actual_runtime_join=not_accessible");
    assert!(outer_timed_out && capture_drop_entered && map_empty && actual_pipe_receipt);
    assert!(tail_released && actual_capture_drop_finished && actual_lane_returned && stopped_after_release);
    assert_eq!(lane_live, 0, "real capture destructor still runs before wrapper permit Drop");
    assert_eq!(live_state, CleanupState::Pending(key), "work-local lease cannot establish closure captures and wrapper task retirement");
    assert!(continuously_pending && replacement_denied);
    assert_eq!(evidence, (0, 1, 1, false), "actual root join consumption and own permit receipt");
}
