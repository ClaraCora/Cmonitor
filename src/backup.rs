//! Read-only deployment backup status for the authenticated data page.
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::db::Db;

pub fn status(db: &Db) -> Value {
    let policy = db.get("backup_policy").and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let copies = policy.as_ref().and_then(|policy| policy["directory"].as_str()).and_then(|directory| {
        let entries = std::fs::read_dir(directory).ok()?;
        let mut count = 0;
        for entry in entries {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("monitor-")
                && name.ends_with(".db")
                && entry.file_type().ok()?.is_file()
                && entry.path().with_extension("json").is_file()
            {
                count += 1;
            }
        }
        Some(count)
    });
    json!({
        "scheduler": timer_output().map(|output| parse_timer(&output)).unwrap_or_else(|| json!({"state":"unavailable"})),
        "policy": policy,
        "copies": copies,
        "checked_at": chrono::Utc::now().timestamp(),
        "timezone": chrono::Local::now().format("UTC%:z").to_string(),
    })
}

// No shell or user-controlled command. A stalled service manager must not hold
// an admin request indefinitely; platforms without systemd report unknown.
fn timer_output() -> Option<String> {
    let mut child = Command::new("systemctl")
        .args([
            "show",
            "monitor-backup.timer",
            "--no-pager",
            "--no-ask-password",
            "-p",
            "LoadState",
            "-p",
            "ActiveState",
            "-p",
            "UnitFileState",
            "-p",
            "TimersCalendar",
            "-p",
            "NextElapseUSecRealtime",
            "-p",
            "RandomizedDelayUSec",
        ])
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(2) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    // A missing unit may return a failing exit status with useful LoadState.
    (text.contains("LoadState=")).then_some(text)
}

fn parse_timer(output: &str) -> Value {
    let field = |name: &str| output.lines().find_map(|line| line.strip_prefix(name));
    let load = field("LoadState=");
    let state = if load == Some("not-found") {
        "not_installed"
    } else if !matches!(load, Some("loaded" | "masked")) {
        "unavailable"
    } else if field("ActiveState=") == Some("active") {
        "active"
    } else {
        "inactive"
    };
    let calendar = field("TimersCalendar=")
        .and_then(|value| value.split_once("OnCalendar="))
        .and_then(|(_, value)| value.split_once(" ;"))
        .map(|(calendar, _)| calendar.trim());
    let next = field("NextElapseUSecRealtime=").filter(|value| !value.is_empty() && *value != "n/a");
    json!({
        "state": state,
        "boot_enabled": field("UnitFileState=") == Some("enabled"),
        "calendar": calendar,
        "random_delay": field("RandomizedDelayUSec="),
        "next_run": if state == "active" { next } else { None },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_timer_exposes_real_schedule_and_next_run() {
        let status = parse_timer("LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nTimersCalendar={ OnCalendar=*-*-* 03:20:00 ; next_elapse=Wed 2026-11-11 03:20:00 CST }\nNextElapseUSecRealtime=Wed 2026-11-11 03:21:27 CST\nRandomizedDelayUSec=10min\n");
        assert_eq!(status["state"], "active");
        assert_eq!(status["boot_enabled"], true);
        assert_eq!(status["calendar"], "*-*-* 03:20:00");
        assert_eq!(status["next_run"], "Wed 2026-11-11 03:21:27 CST");
    }

    #[test]
    fn stopped_timer_does_not_expose_a_stale_next_run() {
        let status = parse_timer("LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\nNextElapseUSecRealtime=Wed 2026-11-11 03:21:27 CST\n");
        assert_eq!(status["state"], "inactive");
        assert_eq!(status["boot_enabled"], false);
        assert!(status["next_run"].is_null());
    }

    #[test]
    fn missing_timer_is_distinct_from_an_enabled_backup() {
        let status = parse_timer("LoadState=not-found\nActiveState=inactive\n");
        assert_eq!(status["state"], "not_installed");
        assert!(status["calendar"].is_null());
        assert_eq!(parse_timer("LoadState=error\nActiveState=inactive\n")["state"], "unavailable");
        assert_eq!(parse_timer("LoadState=masked\nActiveState=inactive\n")["state"], "inactive");
    }
}
