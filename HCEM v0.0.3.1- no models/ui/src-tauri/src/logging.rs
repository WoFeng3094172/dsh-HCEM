//! HCEM 统一日志（Rust 侧）
//!
//! 与 Node 侧共用同一目录：<HCEM_HOME>\logs\hcem-YYYY-MM-DD.log
//! 格式：2026-11-18 04:20:31.123 [LEVEL] [module] message
//! 保留 7 天，超过的按修改时间删除。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

fn log_dir() -> PathBuf {
    crate::exe_dir().join("logs")
}
const KEEP_DAYS: u64 = 7;

fn now_parts() -> (String, String) {
    // 用本地时间（UTC+8 由系统时区决定），格式化为 YYYY-MM-DD 与 HH:MM:SS.mmm
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let local = secs as i64 + 8 * 3600; // 本项目固定东八区（与用户机器一致）
    let days = local.div_euclid(86400);
    let tod = local.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let hh = tod / 3600;
    let mm = (tod % 3600) / 60;
    let ss = tod % 60;
    (
        format!("{:04}-{:02}-{:02}", y, m, d),
        format!("{:02}:{:02}:{:02}.{:03}", hh, mm, ss, millis),
    )
}

/// 由 Unix 天数换算公历年月日（Howard Hinnant 的算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn log_file() -> PathBuf {
    let (date, _) = now_parts();
    log_dir().join(format!("hcem-{date}.log"))
}

/// 写一条日志（失败静默，绝不影响主流程）
pub fn log(level: &str, module: &str, message: &str) {
    let (date, time) = now_parts();
    let line = format!("{date} {time} [{level}] [{module}] {message}\n");
    let _ = fs::create_dir_all(log_dir());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log_file()) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 删除超过 KEEP_DAYS 的日志
pub fn cleanup() {
    let Ok(entries) = fs::read_dir(log_dir()) else { return };
    let limit = Duration::from_secs(KEEP_DAYS * 24 * 3600);
    let now = SystemTime::now();
    let mut removed = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("hcem-") || !name.ends_with(".log") {
            continue;
        }
        if let Ok(meta) = e.metadata() {
            if let Ok(modified) = meta.modified() {
                if now.duration_since(modified).unwrap_or_default() > limit {
                    let _ = fs::remove_file(e.path());
                    removed += 1;
                }
            }
        }
    }
    if removed > 0 {
        log("INFO", "log", &format!("清理过期日志 {removed} 个（保留 {KEEP_DAYS} 天）"));
    }
}
