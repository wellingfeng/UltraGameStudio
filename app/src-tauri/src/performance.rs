//! Release-safe numeric diagnostics. Neither the IPC handler nor the UI probe
//! performs file I/O or waits for the message thread. The writer queue is bounded.

#[path = "performance_core.rs"]
mod core;

use core::{validate_ui_sample, LogRecord, ProbeDecision, ProbeState, RotatingLog};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UiPerformanceKind {
    LongTask,
    TimerDrift,
    Heartbeat,
}

impl UiPerformanceKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::LongTask => "longTask",
            Self::TimerDrift => "timerDrift",
            Self::Heartbeat => "heartbeat",
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiPerformanceSample {
    kind: UiPerformanceKind,
    duration_ms: f64,
    hidden: bool,
}

struct Diagnostics {
    sender: SyncSender<(u64, LogRecord)>,
    origin: Instant,
    last_ui_at: Arc<AtomicU64>,
}

static DIAGNOSTICS: OnceLock<Diagnostics> = OnceLock::new();

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn elapsed_ms(origin: Instant) -> u64 {
    origin.elapsed().as_millis().min(u64::MAX as u128) as u64
}

/// Called once from setup. Path resolution only; all filesystem access is on
/// the writer thread. A writer failure never prevents application startup.
pub fn start(app: tauri::AppHandle) {
    DIAGNOSTICS.get_or_init(|| {
        let origin = Instant::now();
        let last_ui_at = Arc::new(AtomicU64::new(0));
        let (sender, receiver) = mpsc::sync_channel::<(u64, LogRecord)>(64);
        let path = app.path().app_log_dir().ok().map(|root| {
            // PID keeps an independently launched diagnostic build from racing
            // another process's log rotation. No session data appears in names.
            root.join(format!("ugs-performance-{}.jsonl", std::process::id()))
        });
        let _ = std::thread::Builder::new()
            .name("ugs-performance-log".into())
            .spawn(move || {
                let Some(path) = path else { return };
                let mut log = RotatingLog::new(path, 1_048_576);
                let mut last_error_at: Option<Instant> = None;
                for (at, record) in receiver {
                    if last_error_at.is_some_and(|at| at.elapsed() < Duration::from_secs(30)) {
                        continue;
                    }
                    if log.write(at, &record).is_err() {
                        last_error_at = Some(Instant::now());
                        eprintln!("UGS numeric diagnostic log unavailable; retry delayed");
                    } else {
                        last_error_at = None;
                    }
                }
            });

        let probe_sender = sender.clone();
        let ui_seen = last_ui_at.clone();
        let _ = std::thread::Builder::new()
            .name("ugs-native-heartbeat".into())
            .spawn(move || {
                let acknowledged = Arc::new(AtomicBool::new(true));
                let mut probe = ProbeState::default();
                let mut last_watchdog_at = 0_u64;
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let now = elapsed_ms(origin);
                    match probe.tick(now, acknowledged.load(Ordering::Acquire)) {
                        ProbeDecision::Schedule => {
                            acknowledged.store(false, Ordering::Release);
                            let ack = acknowledged.clone();
                            if app
                                .run_on_main_thread(move || ack.store(true, Ordering::Release))
                                .is_err()
                            {
                                // Runtime teardown: don't spin or join the UI thread.
                                break;
                            }
                        }
                        ProbeDecision::Stalled(duration) => {
                            let _ = probe_sender
                                .try_send((epoch_ms(), LogRecord::NativeStalled(duration)));
                        }
                        ProbeDecision::Recovered(duration) => {
                            let _ = probe_sender
                                .try_send((epoch_ms(), LogRecord::NativeRecovered(duration)));
                        }
                        ProbeDecision::Waiting => {}
                    }
                    if now.saturating_sub(last_watchdog_at) >= 30_000 {
                        last_watchdog_at = now;
                        let silence = now.saturating_sub(ui_seen.load(Ordering::Acquire));
                        let _ = probe_sender
                            .try_send((epoch_ms(), LogRecord::WatchdogHeartbeat(silence)));
                    }
                }
            });
        Diagnostics {
            sender,
            origin,
            last_ui_at,
        }
    });
}

/// Enqueue only validated numeric samples. A stalled disk/writer cannot block
/// IPC; optional diagnostic overflow is explicitly reported, never retried here.
#[tauri::command]
pub async fn report_ui_performance(samples: Vec<UiPerformanceSample>) -> Result<(), String> {
    if samples.len() > 32 {
        return Err("diagnostic batch exceeds budget".into());
    }
    let records: Vec<_> = samples
        .iter()
        .map(|sample| {
            validate_ui_sample(sample.kind.as_str(), sample.duration_ms, sample.hidden)
                .ok_or_else(|| "invalid numeric diagnostic sample".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let Some(diagnostics) = DIAGNOSTICS.get() else {
        return Ok(());
    };
    diagnostics
        .last_ui_at
        .store(elapsed_ms(diagnostics.origin), Ordering::Release);
    for record in records {
        diagnostics
            .sender
            .try_send((epoch_ms(), LogRecord::Ui(record)))
            .map_err(|_| "diagnostic writer busy or unavailable".to_owned())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_shape_rejects_body_fields_and_unknown_kinds() {
        assert!(serde_json::from_str::<UiPerformanceSample>(
            r#"{"kind":"longTask","durationMs":100,"hidden":false,"body":"private"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<UiPerformanceSample>(
            r#"{"kind":"private URL","durationMs":100,"hidden":false}"#
        )
        .is_err());
        let sample = serde_json::from_str::<UiPerformanceSample>(
            r#"{"kind":"longTask","durationMs":100,"hidden":false}"#,
        )
        .unwrap();
        assert_eq!(sample.kind.as_str(), "longTask");
    }
}
