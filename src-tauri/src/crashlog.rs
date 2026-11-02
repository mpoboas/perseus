//! A local crash log. When Perseus panics, what happened is appended to `perseus.log` in the app
//! data folder. Nothing is sent anywhere: a user who wants to report a problem attaches the file.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// The log is rotated to `perseus.log.old` once it grows past this.
const MAX_BYTES: u64 = 256 * 1024;

/// Appends `entry` to the log, keeping it small. Failures are ignored: a broken log must never
/// make a crash worse.
fn append(path: &Path, entry: &str) {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::rename(path, path.with_extension("log.old"));
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(entry.as_bytes());
    }
}

/// Records panics from now on in `<data_dir>/perseus.log`, then lets the previous hook (which
/// prints to stderr) run as usual.
pub fn install(data_dir: &Path) {
    let path: PathBuf = data_dir.join("perseus.log");
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let thread = std::thread::current();
        let entry = format!(
            "[{seconds}] perseus {} panicked on thread {:?}: {info}\n",
            env!("CARGO_PKG_VERSION"),
            thread.name().unwrap_or("unnamed"),
        );
        append(&path, &entry);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_accumulate_and_a_large_log_is_rotated() {
        let dir = std::env::temp_dir().join(format!("perseus-crashlog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = dir.join("perseus.log");

        append(&log, "first\n");
        append(&log, "second\n");
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "first\nsecond\n");

        append(&log, &"x".repeat(MAX_BYTES as usize + 1));
        append(&log, "after rotation\n");
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "after rotation\n");
        assert!(dir.join("perseus.log.old").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
