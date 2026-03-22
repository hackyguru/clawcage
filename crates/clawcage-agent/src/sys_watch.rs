#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

// clawcage-sys-watch: In-VM system metrics daemon.
//
// Polls /proc/stat, /proc/meminfo, and statvfs(/root) every 2 seconds and
// streams SystemMetrics snapshots to the host over vsock port 5008.
//
// This binary runs inside the guest VM, launched by clawcage-init.

#[path = "vsock_io.rs"]
mod vsock_io;

/// vsock port for system metrics on the host.
#[cfg(target_os = "linux")]
const VSOCK_PORT_SYS_WATCH: u32 = 5008;

/// Polling interval for system metrics.
const POLL_INTERVAL_MS: u64 = 2000;

// ── Pure helpers (testable on macOS) ─────────────────────────────────

/// Parsed CPU times from a single `/proc/stat` "cpu" line.
#[derive(Debug, Clone, Copy, Default)]
pub struct CpuTimes {
    pub user: u64,
    pub nice: u64,
    pub system: u64,
    pub idle: u64,
    pub iowait: u64,
    pub irq: u64,
    pub softirq: u64,
    pub steal: u64,
}

impl CpuTimes {
    /// Total CPU time across all fields.
    pub fn total(&self) -> u64 {
        self.user + self.nice + self.system + self.idle
            + self.iowait + self.irq + self.softirq + self.steal
    }

    /// Idle time (idle + iowait).
    pub fn idle_time(&self) -> u64 {
        self.idle + self.iowait
    }
}

/// Parse the aggregate "cpu" line from `/proc/stat`.
///
/// Example line: `cpu  1234 56 789 12345 67 89 12 34 0 0`
pub fn parse_proc_stat_cpu(content: &str) -> Option<CpuTimes> {
    for line in content.lines() {
        // Match "cpu " (with trailing space) to get aggregate, not per-core.
        if let Some(rest) = line.strip_prefix("cpu ") {
            let fields: Vec<u64> = rest
                .split_whitespace()
                .filter_map(|f| f.parse().ok())
                .collect();
            if fields.len() < 4 {
                return None;
            }
            return Some(CpuTimes {
                user: fields[0],
                nice: fields[1],
                system: fields[2],
                idle: fields[3],
                iowait: fields.get(4).copied().unwrap_or(0),
                irq: fields.get(5).copied().unwrap_or(0),
                softirq: fields.get(6).copied().unwrap_or(0),
                steal: fields.get(7).copied().unwrap_or(0),
            });
        }
    }
    None
}

/// Compute CPU usage percentage from two samples.
pub fn cpu_percent(prev: &CpuTimes, curr: &CpuTimes) -> f32 {
    let total_delta = curr.total().saturating_sub(prev.total());
    if total_delta == 0 {
        return 0.0;
    }
    let idle_delta = curr.idle_time().saturating_sub(prev.idle_time());
    let busy = total_delta - idle_delta;
    (busy as f32 / total_delta as f32) * 100.0
}

/// Parsed memory info from `/proc/meminfo`.
#[derive(Debug, Clone, Copy, Default)]
pub struct MemInfo {
    pub total_kb: u64,
    pub available_kb: u64,
}

/// Parse MemTotal and MemAvailable from `/proc/meminfo`.
pub fn parse_proc_meminfo(content: &str) -> MemInfo {
    let mut info = MemInfo::default();
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            info.total_kb = parse_kb_value(rest);
        } else if let Some(rest) = line.strip_prefix("MemAvailable:") {
            info.available_kb = parse_kb_value(rest);
        }
    }
    info
}

/// Parse a value like "  1234 kB" into the numeric part.
fn parse_kb_value(s: &str) -> u64 {
    s.split_whitespace()
        .next()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Disk usage from statvfs.
#[derive(Debug, Clone, Copy, Default)]
pub struct DiskUsage {
    pub total_kb: u64,
    pub used_kb: u64,
}

/// Get disk usage for a path using statvfs.
#[cfg(target_os = "linux")]
pub fn disk_usage(path: &str) -> DiskUsage {
    use std::ffi::CString;
    use std::mem::MaybeUninit;

    let c_path = match CString::new(path) {
        Ok(p) => p,
        Err(_) => return DiskUsage::default(),
    };

    let mut buf = MaybeUninit::<nix::libc::statvfs>::uninit();
    let ret = unsafe { nix::libc::statvfs(c_path.as_ptr(), buf.as_mut_ptr()) };
    if ret != 0 {
        return DiskUsage::default();
    }

    let stat = unsafe { buf.assume_init() };
    let block_size = stat.f_frsize as u64;
    let total = stat.f_blocks * block_size / 1024;
    let free = stat.f_bfree * block_size / 1024;

    DiskUsage {
        total_kb: total,
        used_kb: total.saturating_sub(free),
    }
}

// ── Watcher (Linux only) ─────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn run_watcher() {
    use clawcage_proto::{GuestToHost, encode_guest_msg};
    use vsock_io::{VSOCK_HOST_CID, vsock_connect_retry, write_all_fd};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    eprintln!("[clawcage-sys-watch] starting (pid {})", std::process::id());

    let vsock_fd = vsock_connect_retry(VSOCK_HOST_CID, VSOCK_PORT_SYS_WATCH, "sys-watch");

    let term_now = Arc::new(AtomicBool::new(false));
    for sig in &[
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGQUIT,
    ] {
        signal_hook::flag::register(*sig, Arc::clone(&term_now)).expect("register signal");
    }

    // Initial CPU sample.
    let stat_content = std::fs::read_to_string("/proc/stat").unwrap_or_default();
    let mut prev_cpu = parse_proc_stat_cpu(&stat_content).unwrap_or_default();

    loop {
        if term_now.load(Ordering::Relaxed) {
            eprintln!("[clawcage-sys-watch] received termination signal, exiting");
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));

        // CPU
        let stat_content = std::fs::read_to_string("/proc/stat").unwrap_or_default();
        let curr_cpu = parse_proc_stat_cpu(&stat_content).unwrap_or_default();
        let cpu_pct = cpu_percent(&prev_cpu, &curr_cpu);
        prev_cpu = curr_cpu;

        // Memory
        let meminfo_content = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let mem = parse_proc_meminfo(&meminfo_content);

        // Disk
        let disk = disk_usage("/root");

        let msg = GuestToHost::SystemMetrics {
            cpu_percent: cpu_pct,
            mem_total_kb: mem.total_kb,
            mem_used_kb: mem.total_kb.saturating_sub(mem.available_kb),
            disk_total_kb: disk.total_kb,
            disk_used_kb: disk.used_kb,
        };

        match encode_guest_msg(&msg) {
            Ok(frame) => {
                if let Err(e) = write_all_fd(vsock_fd, &frame) {
                    eprintln!("[clawcage-sys-watch] write failed: {e}");
                    break;
                }
            }
            Err(e) => {
                eprintln!("[clawcage-sys-watch] encode failed: {e}");
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn run_watcher() {
    eprintln!("[clawcage-sys-watch] /proc not available on this platform");
    std::process::exit(1);
}

fn main() {
    run_watcher();
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_PROC_STAT: &str = "\
cpu  10132153 290696 3084719 46828483 16683 0 25195 0 0 0
cpu0 1393280 32966 572056 13343292 6130 0 17875 0 0 0
intr 30646631 0 9 0 0 0 0 0 0 1 79 0 0 156 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
";

    #[test]
    fn parse_cpu_line() {
        let cpu = parse_proc_stat_cpu(SAMPLE_PROC_STAT).unwrap();
        assert_eq!(cpu.user, 10132153);
        assert_eq!(cpu.nice, 290696);
        assert_eq!(cpu.system, 3084719);
        assert_eq!(cpu.idle, 46828483);
        assert_eq!(cpu.iowait, 16683);
        assert_eq!(cpu.irq, 0);
        assert_eq!(cpu.softirq, 25195);
        assert_eq!(cpu.steal, 0);
    }

    #[test]
    fn parse_cpu_line_missing() {
        assert!(parse_proc_stat_cpu("").is_none());
        assert!(parse_proc_stat_cpu("intr 123 456").is_none());
    }

    #[test]
    fn parse_cpu_line_minimal_fields() {
        let content = "cpu  100 0 50 200\n";
        let cpu = parse_proc_stat_cpu(content).unwrap();
        assert_eq!(cpu.user, 100);
        assert_eq!(cpu.idle, 200);
        assert_eq!(cpu.iowait, 0);
    }

    #[test]
    fn cpu_percent_idle() {
        let prev = CpuTimes { user: 0, nice: 0, system: 0, idle: 100, iowait: 0, irq: 0, softirq: 0, steal: 0 };
        let curr = CpuTimes { user: 0, nice: 0, system: 0, idle: 200, iowait: 0, irq: 0, softirq: 0, steal: 0 };
        let pct = cpu_percent(&prev, &curr);
        assert!((pct - 0.0).abs() < 0.01);
    }

    #[test]
    fn cpu_percent_full_load() {
        let prev = CpuTimes { user: 0, nice: 0, system: 0, idle: 100, iowait: 0, irq: 0, softirq: 0, steal: 0 };
        let curr = CpuTimes { user: 100, nice: 0, system: 0, idle: 100, iowait: 0, irq: 0, softirq: 0, steal: 0 };
        let pct = cpu_percent(&prev, &curr);
        assert!((pct - 100.0).abs() < 0.01);
    }

    #[test]
    fn cpu_percent_half_load() {
        let prev = CpuTimes { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0 };
        let curr = CpuTimes { user: 50, nice: 0, system: 0, idle: 50, iowait: 0, irq: 0, softirq: 0, steal: 0 };
        let pct = cpu_percent(&prev, &curr);
        assert!((pct - 50.0).abs() < 0.01);
    }

    #[test]
    fn cpu_percent_zero_delta() {
        let t = CpuTimes::default();
        assert_eq!(cpu_percent(&t, &t), 0.0);
    }

    const SAMPLE_MEMINFO: &str = "\
MemTotal:        4028848 kB
MemFree:          123456 kB
MemAvailable:    2514080 kB
Buffers:          100000 kB
Cached:           500000 kB
SwapTotal:       1048576 kB
SwapFree:        1048576 kB
";

    #[test]
    fn parse_meminfo() {
        let mem = parse_proc_meminfo(SAMPLE_MEMINFO);
        assert_eq!(mem.total_kb, 4028848);
        assert_eq!(mem.available_kb, 2514080);
    }

    #[test]
    fn parse_meminfo_empty() {
        let mem = parse_proc_meminfo("");
        assert_eq!(mem.total_kb, 0);
        assert_eq!(mem.available_kb, 0);
    }

    #[test]
    fn parse_meminfo_partial() {
        let mem = parse_proc_meminfo("MemTotal:   8000000 kB\n");
        assert_eq!(mem.total_kb, 8000000);
        assert_eq!(mem.available_kb, 0);
    }

    #[test]
    fn parse_kb_value_variants() {
        assert_eq!(parse_kb_value("  1234 kB"), 1234);
        assert_eq!(parse_kb_value("0 kB"), 0);
        assert_eq!(parse_kb_value(""), 0);
        assert_eq!(parse_kb_value("notanumber kB"), 0);
    }

    #[test]
    fn cpu_times_total() {
        let t = CpuTimes { user: 10, nice: 5, system: 3, idle: 80, iowait: 2, irq: 0, softirq: 0, steal: 0 };
        assert_eq!(t.total(), 100);
        assert_eq!(t.idle_time(), 82);
    }
}
