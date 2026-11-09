//! Pure diagnostics core. Kept independent of Tauri for isolated regression tests.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TimingRecord {
    pub kind: &'static str,
    pub duration_ms: f64,
    pub hidden: bool,
}

pub fn validate_ui_sample(kind: &str, duration_ms: f64, hidden: bool) -> Option<TimingRecord> {
    if !duration_ms.is_finite() || !(0.0..=86_400_000.0).contains(&duration_ms) {
        return None;
    }
    let kind = match kind {
        "longTask" if duration_ms >= 50.0 => "longTask",
        "timerDrift" if duration_ms >= 200.0 => "timerDrift",
        "heartbeat" if duration_ms == 0.0 => "heartbeat",
        _ => return None,
    };
    Some(TimingRecord {
        kind,
        duration_ms,
        hidden,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeDecision {
    Schedule,
    Waiting,
    Stalled(u64),
    Recovered(u64),
}

#[derive(Default)]
pub struct ProbeState {
    pending_at: Option<u64>,
    warned_at: Option<u64>,
}

impl ProbeState {
    pub fn tick(&mut self, now_ms: u64, acknowledged: bool) -> ProbeDecision {
        if let Some(started_at) = self.pending_at {
            let elapsed = now_ms.saturating_sub(started_at);
            if acknowledged {
                self.pending_at = None;
                if self.warned_at.take().is_some() {
                    return ProbeDecision::Recovered(elapsed);
                }
            } else {
                if elapsed >= 2_000
                    && self
                        .warned_at
                        .map_or(true, |last| now_ms.saturating_sub(last) >= 30_000)
                {
                    self.warned_at = Some(now_ms);
                    return ProbeDecision::Stalled(elapsed);
                }
                return ProbeDecision::Waiting;
            }
        }
        self.pending_at = Some(now_ms);
        ProbeDecision::Schedule
    }
}

pub enum LogRecord {
    Ui(TimingRecord),
    NativeStalled(u64),
    NativeRecovered(u64),
    WatchdogHeartbeat(u64),
}

pub struct RotatingLog {
    path: std::path::PathBuf,
    limit: u64,
}

impl RotatingLog {
    pub fn new(path: std::path::PathBuf, limit: u64) -> Self {
        Self { path, limit }
    }

    pub fn write(&mut self, timestamp_ms: u64, record: &LogRecord) -> std::io::Result<()> {
        use std::io::{Error, ErrorKind, Write};
        let line = match record {
            LogRecord::Ui(sample) => {
                let sample = validate_ui_sample(sample.kind, sample.duration_ms, sample.hidden)
                    .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "invalid numeric sample"))?;
                format!(
                    "{{\"tsMs\":{timestamp_ms},\"kind\":\"{}\",\"durationMs\":{},\"hidden\":{}}}\n",
                    sample.kind, sample.duration_ms, sample.hidden
                )
            }
            LogRecord::NativeStalled(duration) => format!(
                "{{\"tsMs\":{timestamp_ms},\"kind\":\"nativeStalled\",\"durationMs\":{duration}}}\n"
            ),
            LogRecord::NativeRecovered(duration) => format!(
                "{{\"tsMs\":{timestamp_ms},\"kind\":\"nativeRecovered\",\"durationMs\":{duration}}}\n"
            ),
            LogRecord::WatchdogHeartbeat(silence) => format!(
                "{{\"tsMs\":{timestamp_ms},\"kind\":\"watchdogHeartbeat\",\"uiSilenceMs\":{silence}}}\n"
            ),
        };
        if line.len() as u64 > self.limit {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "diagnostic line exceeds log budget",
            ));
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let size = match std::fs::metadata(&self.path) {
            Ok(metadata) => metadata.len(),
            Err(err) if err.kind() == ErrorKind::NotFound => 0,
            Err(err) => return Err(err),
        };
        if size.saturating_add(line.len() as u64) > self.limit {
            let backup = self.path.with_extension("jsonl.1");
            match std::fs::remove_file(&backup) {
                Ok(()) => {}
                Err(err) if err.kind() == ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
            std::fs::rename(&self.path, backup)?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_numeric_samples_without_retaining_untrusted_kind_strings() {
        let sample = validate_ui_sample("longTask", 125.5, false).expect("valid numeric sample");
        assert_eq!(
            sample,
            TimingRecord {
                kind: "longTask",
                duration_ms: 125.5,
                hidden: false,
            }
        );
        assert!(validate_ui_sample("private URL or prompt", 100.0, false).is_none());
        assert!(validate_ui_sample("longTask", f64::NAN, false).is_none());
        assert!(validate_ui_sample("longTask", f64::INFINITY, false).is_none());
        assert!(validate_ui_sample("timerDrift", -1.0, false).is_none());
        assert!(validate_ui_sample("timerDrift", 86_400_001.0, false).is_none());
        assert_eq!(
            validate_ui_sample("heartbeat", 0.0, true).unwrap().kind,
            "heartbeat"
        );
    }

    #[test]
    fn a_stalled_message_loop_never_accumulates_native_probes() {
        let mut state = ProbeState::default();
        assert_eq!(state.tick(0, true), ProbeDecision::Schedule);
        assert_eq!(state.tick(1_000, false), ProbeDecision::Waiting);
        assert_eq!(state.tick(2_000, false), ProbeDecision::Stalled(2_000));
        for now in 2_001..30_000 {
            assert_eq!(state.tick(now, false), ProbeDecision::Waiting);
        }
        assert_eq!(state.tick(32_000, false), ProbeDecision::Stalled(32_000));
        assert_eq!(state.tick(33_000, true), ProbeDecision::Recovered(33_000));
        assert_eq!(state.tick(34_000, true), ProbeDecision::Schedule);
    }

    #[test]
    fn numeric_log_rotates_with_a_fresh_reader_and_keeps_only_one_backup() {
        let root =
            std::path::PathBuf::from(std::env::var_os("TMPDIR").expect("isolated scratch TMPDIR"))
                .join(format!("ugs-perf-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("performance.jsonl");
        let mut log = RotatingLog::new(path.clone(), 180);
        for n in 0..20 {
            log.write(n, &LogRecord::NativeStalled(n)).unwrap();
        }
        drop(log);
        let current = std::fs::read_to_string(&path).expect("fresh-reader log exists");
        let previous = std::fs::read_to_string(path.with_extension("jsonl.1")).unwrap();
        assert!(current.contains("\"tsMs\":19"));
        assert!(current.len() <= 180);
        assert!(previous.len() <= 180);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
        for line in current.lines().chain(previous.lines()) {
            assert!(line.starts_with('{') && line.ends_with('}'));
            assert!(line.contains("\"kind\":\"nativeStalled\""));
        }
        let before = std::fs::read(&path).unwrap();
        let bad = TimingRecord {
            kind: "private-prompt",
            duration_ms: 100.0,
            hidden: false,
        };
        assert!(RotatingLog::new(path.clone(), 180)
            .write(30, &LogRecord::Ui(bad))
            .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }
}
