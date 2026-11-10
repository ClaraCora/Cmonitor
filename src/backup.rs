//! Read the privileged backup reporter's snapshot without leaving the Hub sandbox.
use serde_json::{json, Value};

use crate::db::Db;

pub fn status(db: &Db) -> Value {
    snapshot(db.get("backup_status").as_deref(), chrono::Utc::now().timestamp())
}

fn snapshot(raw: Option<&str>, now: i64) -> Value {
    let mut status = raw.and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(|value| value.is_object() && value["scheduler"].is_object())
        .unwrap_or_else(|| json!({"scheduler":{"state":"unavailable"},"policy":null,"copies":null,"checked_at":null,"timezone":null}));
    let fresh =
        status["checked_at"].as_i64().is_some_and(|checked| (now - 180..=now + 30).contains(&checked));
    status["stale"] = json!(!fresh);
    if !fresh {
        status["scheduler"] = json!({"state":"unavailable"});
        status["copies"] = Value::Null;
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recent_report_exposes_the_actual_timer_and_policy() {
        let status = snapshot(
            Some(
                r#"{"scheduler":{"state":"active","next_run":"tomorrow"},"policy":{"keep":7},"checked_at":1000,"copies":2}"#,
            ),
            1100,
        );
        assert_eq!(status["scheduler"]["state"], "active");
        assert_eq!(status["policy"]["keep"], 7);
        assert_eq!(status["copies"], 2);
        assert_eq!(status["stale"], false);
    }

    #[test]
    fn an_old_or_future_report_cannot_claim_the_timer_is_still_enabled() {
        let raw = r#"{"scheduler":{"state":"active","next_run":"tomorrow"},"checked_at":1000,"copies":2}"#;
        for now in [1200, 900] {
            let status = snapshot(Some(raw), now);
            assert_eq!(status["scheduler"]["state"], "unavailable");
            assert!(status["scheduler"]["next_run"].is_null());
            assert!(status["copies"].is_null());
            assert_eq!(status["stale"], true);
        }
    }

    #[test]
    fn missing_or_malformed_reports_are_explicitly_unknown() {
        for raw in [None, Some("not json"), Some("null"), Some("[]"), Some("{}")] {
            assert_eq!(snapshot(raw, 1000)["scheduler"]["state"], "unavailable");
        }
    }
}
