//! Times the history walk (gix rev-walk + lane allocation) on a repository.
//!
//!     cargo run --release -p perseus --example walk_timing -- <repo>
//!
//! Reports time to the first chunk (what the user waits for before rows appear), total time,
//! rows per second and peak memory of the process (Windows only).

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use perseus_lib::git::graph::{DEFAULT_CHUNK_SIZE, walk_commits};

fn peak_memory_mb() -> Option<f64> {
    #[cfg(windows)]
    {
        // `tasklist` is slow but dependency-free; this runs once, after the walk.
        let pid = std::process::id().to_string();
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("(Get-Process -Id {pid}).PeakWorkingSet64"),
            ])
            .output()
            .ok()?;
        let bytes: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        Some(bytes / 1024.0 / 1024.0)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn main() {
    let path: PathBuf = std::env::args()
        .nth(1)
        .expect("usage: walk_timing <repository>")
        .into();
    let repo = gix::open(&path).expect("open repository");
    let cancel = AtomicBool::new(false);

    let started = Instant::now();
    let mut first_chunk = None;
    let mut rows = 0usize;
    let mut max_lanes = 0usize;
    let summary = walk_commits(&repo, DEFAULT_CHUNK_SIZE, &cancel, |chunk| {
        first_chunk.get_or_insert_with(|| started.elapsed());
        rows += chunk.len();
        for r in &chunk {
            max_lanes = max_lanes.max(r.graph.lane as usize + 1);
        }
        true
    })
    .expect("walk");

    let total = started.elapsed();
    println!("repository      : {}", path.display());
    println!("commits         : {}", summary.total);
    println!(
        "first chunk     : {:.1} ms",
        first_chunk.unwrap().as_secs_f64() * 1000.0
    );
    println!("total           : {:.2} s", total.as_secs_f64());
    println!("rows per second : {:.0}", rows as f64 / total.as_secs_f64());
    println!("widest lane     : {max_lanes}");
    if let Some(mb) = peak_memory_mb() {
        println!("peak memory     : {mb:.0} MB");
    }
}
