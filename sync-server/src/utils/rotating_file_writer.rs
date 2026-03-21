use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::NaiveDateTime;
use tracing_subscriber::fmt::MakeWriter;

#[derive(Clone)]
pub struct RotatingFileWriter {
    inner: Arc<Mutex<RotatingFileWriterInner>>,
}

struct RotatingFileWriterInner {
    directory: PathBuf,
    file_prefix: String,
    rotation_duration: Duration,
    current_file: Option<std::fs::File>,
    next_rotation_time: SystemTime,
}

impl RotatingFileWriter {
    pub fn new(
        directory: impl AsRef<Path>,
        file_prefix: &str,
        rotation_duration: Duration,
    ) -> io::Result<Self> {
        let directory = directory.as_ref().to_path_buf();

        fs::create_dir_all(&directory)?;

        let next_rotation_time =
            Self::calculate_next_rotation_time(&directory, file_prefix, rotation_duration);

        let inner = RotatingFileWriterInner {
            directory,
            file_prefix: file_prefix.to_owned(),
            rotation_duration,
            current_file: None,
            next_rotation_time,
        };

        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
        })
    }

    /// Parse timestamp from log filename and return as `SystemTime`
    fn parse_log_timestamp(filename: &str, file_prefix: &str) -> Option<SystemTime> {
        // Expected format: {prefix}.{timestamp}.log where timestamp is %Y-%m-%d_%H-%M-%S
        let prefix_len = file_prefix.len() + 1; // +1 for the dot
        let timestamp_str = filename.get(prefix_len..filename.len().checked_sub(4)?)?;

        let dt = NaiveDateTime::parse_from_str(timestamp_str, "%Y-%m-%d_%H-%M-%S").ok()?;
        let timestamp = dt.and_utc();
        let secs: u64 = timestamp.timestamp().try_into().ok()?;

        Some(UNIX_EPOCH + Duration::from_secs(secs))
    }

    fn find_latest_log_file(directory: &Path, file_prefix: &str) -> Option<String> {
        fs::read_dir(directory)
            .ok()?
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let filename = entry.file_name().into_string().ok()?;
                let has_correct_prefix = filename.starts_with(file_prefix);
                let has_log_extension = Path::new(&filename)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("log"));

                (has_correct_prefix && has_log_extension).then_some(filename)
            })
            .max()
    }

    fn calculate_next_rotation_time(
        directory: &Path,
        file_prefix: &str,
        rotation_duration: Duration,
    ) -> SystemTime {
        Self::find_latest_log_file(directory, file_prefix)
            .and_then(|filename| Self::parse_log_timestamp(&filename, file_prefix))
            .map_or_else(SystemTime::now, |last_rotation| {
                last_rotation + rotation_duration
            })
    }

    fn should_rotate(inner: &RotatingFileWriterInner) -> bool {
        SystemTime::now() >= inner.next_rotation_time
    }

    fn open_or_create_log_file(inner: &mut RotatingFileWriterInner) -> io::Result<()> {
        // If we haven't reached rotation time and there's an existing log file, reuse it
        if !Self::should_rotate(inner)
            && let Some(latest_file) =
                Self::find_latest_log_file(&inner.directory, &inner.file_prefix)
        {
            let filepath = inner.directory.join(&latest_file);
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&filepath)?;

            inner.current_file = Some(file);
            return Ok(());
        }

        // Otherwise, create a new log file with current timestamp
        Self::rotate(inner)
    }

    fn rotate(inner: &mut RotatingFileWriterInner) -> io::Result<()> {
        let timestamp = chrono::Utc::now().format("%Y-%m-%d_%H-%M-%S");
        let filename = format!("{}.{}.log", inner.file_prefix, timestamp);
        let filepath = inner.directory.join(filename);

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&filepath)?;

        inner.current_file = Some(file);
        inner.next_rotation_time = SystemTime::now() + inner.rotation_duration;

        Ok(())
    }
}

impl Write for RotatingFileWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| {
            eprintln!("RotatingFileWriter mutex was poisoned, recovering");
            poisoned.into_inner()
        });

        // Reset file handle after poison recovery so the next branch
        // re-opens a valid file rather than writing to a potentially
        // half-closed handle.
        if inner.current_file.is_none() {
            Self::open_or_create_log_file(&mut inner)?;
        } else if Self::should_rotate(&inner) {
            Self::rotate(&mut inner)?;
        }

        if let Some(ref mut file) = inner.current_file {
            file.write(buf)
        } else {
            Err(io::Error::other("Failed to open log file"))
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut inner = self.inner.lock().unwrap_or_else(|poisoned| {
            eprintln!("RotatingFileWriter mutex was poisoned, recovering");
            poisoned.into_inner()
        });
        if let Some(ref mut file) = inner.current_file {
            file.flush()
        } else {
            Ok(())
        }
    }
}

impl<'a> MakeWriter<'a> for RotatingFileWriter {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn test_write_creates_log_file_and_directory() {
        let temp_dir = std::env::temp_dir().join("test_write_creates_log_file_and_directory");
        let _ = fs::remove_dir_all(&temp_dir);

        let mut writer =
            RotatingFileWriter::new(&temp_dir, "test", Duration::from_secs(3600)).unwrap();
        writer.write_all(b"test log message\n").unwrap();
        writer.flush().unwrap();

        // Check that a log file was created
        let entries: Vec<_> = fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "log"))
            .collect();

        assert!(temp_dir.exists());
        assert_eq!(entries.len(), 1);

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_rotation_after_duration() {
        let temp_dir = std::env::temp_dir().join("test_rotation_after_duration");
        let _ = fs::remove_dir_all(&temp_dir);

        // Use a very short rotation duration
        // Note: We need to wait at least 1 second between rotations since
        // filename timestamps only have second precision
        let mut writer =
            RotatingFileWriter::new(&temp_dir, "test", Duration::from_millis(500)).unwrap();

        writer.write_all(b"first message\n").unwrap();
        writer.flush().unwrap();

        // Wait for rotation time to pass (at least 1 second for different timestamp)
        thread::sleep(Duration::from_millis(1100));

        writer.write_all(b"second message\n").unwrap();
        writer.flush().unwrap();

        // Check that two log files were created
        let entries: Vec<_> = fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "log"))
            .collect();

        assert_eq!(entries.len(), 2);

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_calculate_next_rotation_time_no_existing_logs() {
        let temp_dir =
            std::env::temp_dir().join("test_calculate_next_rotation_time_no_existing_logs");
        let _ = fs::remove_dir_all(&temp_dir);

        fs::create_dir_all(&temp_dir).unwrap();

        let before = SystemTime::now();
        let next_rotation = RotatingFileWriter::calculate_next_rotation_time(
            &temp_dir,
            "test",
            Duration::from_secs(3600),
        );
        let after = SystemTime::now();

        // Should return current time (within a small window)
        assert!(next_rotation >= before && next_rotation <= after + Duration::from_secs(1));

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_calculate_next_rotation_time_with_existing_log() {
        let temp_dir =
            std::env::temp_dir().join("test_calculate_next_rotation_time_with_existing_log");
        let _ = fs::remove_dir_all(&temp_dir);

        fs::create_dir_all(&temp_dir).unwrap();

        // Create a log file with a known timestamp
        let timestamp_str = "2025-10-26_14-30-00";
        let filename = format!("test.{timestamp_str}.log");
        fs::write(temp_dir.join(&filename), b"test").unwrap();

        let rotation_duration = Duration::from_secs(3600);
        let next_rotation =
            RotatingFileWriter::calculate_next_rotation_time(&temp_dir, "test", rotation_duration);

        // Parse the expected time
        let expected_dt =
            NaiveDateTime::parse_from_str(timestamp_str, "%Y-%m-%d_%H-%M-%S").unwrap();
        let expected_timestamp = expected_dt.and_utc();
        let expected_duration =
            Duration::from_secs(expected_timestamp.timestamp().try_into().unwrap());
        let expected_next = UNIX_EPOCH + expected_duration + rotation_duration;

        // Allow 1 second tolerance for timing differences
        let diff = if next_rotation > expected_next {
            next_rotation.duration_since(expected_next).unwrap()
        } else {
            expected_next.duration_since(next_rotation).unwrap()
        };

        assert!(
            diff < Duration::from_secs(2),
            "Expected {expected_next:?}, got {next_rotation:?}"
        );

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_picks_latest_log_file() {
        let temp_dir = std::env::temp_dir().join("test_picks_latest_log_file");
        let _ = fs::remove_dir_all(&temp_dir);

        fs::create_dir_all(&temp_dir).unwrap();

        // Create multiple log files
        fs::write(temp_dir.join("test.2025-10-26_10-00-00.log"), b"old").unwrap();
        fs::write(temp_dir.join("test.2025-10-26_14-00-00.log"), b"newer").unwrap();
        fs::write(temp_dir.join("test.2025-10-26_12-00-00.log"), b"middle").unwrap();

        let rotation_duration = Duration::from_secs(3600);
        let next_rotation =
            RotatingFileWriter::calculate_next_rotation_time(&temp_dir, "test", rotation_duration);

        // Should use the latest file (2025-10-26_14-00-00)
        let expected_dt =
            NaiveDateTime::parse_from_str("2025-10-26_14-00-00", "%Y-%m-%d_%H-%M-%S").unwrap();
        let expected_timestamp = expected_dt.and_utc();
        let expected_duration =
            Duration::from_secs(expected_timestamp.timestamp().try_into().unwrap());
        let expected_next = UNIX_EPOCH + expected_duration + rotation_duration;

        let diff = if next_rotation > expected_next {
            next_rotation.duration_since(expected_next).unwrap()
        } else {
            expected_next.duration_since(next_rotation).unwrap()
        };

        assert!(diff < Duration::from_secs(2));

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_ignores_malformed_filenames() {
        let temp_dir = std::env::temp_dir().join("test_ignores_malformed_filenames");
        let _ = fs::remove_dir_all(&temp_dir);

        fs::create_dir_all(&temp_dir).unwrap();

        // Create log files with various malformed names
        fs::write(temp_dir.join("test.invalid.log"), b"bad").unwrap();
        fs::write(temp_dir.join("test.log"), b"bad2").unwrap();
        fs::write(
            temp_dir.join("other.2025-10-26_14-00-00.log"),
            b"wrong prefix",
        )
        .unwrap();
        fs::write(temp_dir.join("test.2025-10-26_14-00-00.txt"), b"wrong ext").unwrap();

        let before = SystemTime::now();
        let next_rotation = RotatingFileWriter::calculate_next_rotation_time(
            &temp_dir,
            "test",
            Duration::from_secs(3600),
        );
        let after = SystemTime::now();

        // Should fall back to current time since no valid logs exist
        assert!(next_rotation >= before && next_rotation <= after + Duration::from_secs(1));

        fs::remove_dir_all(&temp_dir).unwrap();
    }

    #[test]
    fn test_restart_behavior() {
        let temp_dir = std::env::temp_dir().join("test_restart_behavior");
        let _ = fs::remove_dir_all(&temp_dir);

        // Create initial writer and write some data
        {
            let mut writer =
                RotatingFileWriter::new(&temp_dir, "test", Duration::from_secs(3600)).unwrap();
            writer.write_all(b"before restart\n").unwrap();
            writer.flush().unwrap();
        }

        // Simulate restart by creating a new writer
        thread::sleep(Duration::from_millis(100));
        {
            let mut writer =
                RotatingFileWriter::new(&temp_dir, "test", Duration::from_secs(3600)).unwrap();
            writer.write_all(b"after restart\n").unwrap();
            writer.flush().unwrap();
        }

        // Should still have only one log file (no premature rotation)
        let entries: Vec<_> = fs::read_dir(&temp_dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "log"))
            .collect();

        assert_eq!(
            entries.len(),
            1,
            "Should not create new log file on restart within rotation period"
        );

        fs::remove_dir_all(&temp_dir).unwrap();
    }
}
