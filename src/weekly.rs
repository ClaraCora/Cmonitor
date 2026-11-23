//! Daily accounting totals for the seven completed Hub-local calendar days.
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use anyhow::Result;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Days, Local, NaiveDate};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::{App, Shared};

#[derive(PartialEq)]
struct Member {
    id: i64,
    region: String,
    created_at: i64,
}

pub(crate) struct Cache {
    today: NaiveDate,
    members: Vec<Member>,
    built: Instant,
    bytes: Bytes,
}

#[derive(Default, Clone, Copy, Serialize)]
struct Bucket {
    rx: Option<u64>,
    tx: Option<u64>,
    observed_nodes: usize,
    expected_nodes: usize,
}

impl Bucket {
    fn record(&mut self, rx: u64, tx: u64) {
        self.observed_nodes += 1;
        self.rx = Some(self.rx.unwrap_or_default().saturating_add(rx));
        self.tx = Some(self.tx.unwrap_or_default().saturating_add(tx));
    }
}

#[derive(Serialize)]
struct Week {
    days: [NaiveDate; 7],
    all: [Bucket; 7],
    regions: BTreeMap<String, [Bucket; 7]>,
}

fn snapshot(app: &App, today: NaiveDate, admin: bool) -> Result<Option<Bytes>> {
    let mut cache = app.weekly.lock().unwrap_or_else(|e| e.into_inner());
    let conn = app.db.conn();
    if !admin {
        let public: Option<String> = conn
            .query_row("SELECT value FROM setting WHERE key='public_page'", [], |r| r.get(0))
            .optional()?;
        if public.as_deref() == Some("off") {
            return Ok(None);
        }
    }
    // A cache hit checks only current public membership. This also catches an
    // IP/region change and never serves a recently hidden node's old figures.
    let members = conn
        .prepare_cached("SELECT id,country,created_at FROM node WHERE public=1 ORDER BY id")?
        .query_map([], |row| {
            Ok(Member {
                id: row.get(0)?,
                region: row.get::<_, String>(1)?.trim().to_ascii_uppercase(),
                created_at: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if let Some(hit) = cache
        .as_ref()
        .filter(|v| v.today == today && v.members == members && v.built.elapsed() < Duration::from_secs(300))
    {
        return Ok(Some(hit.bytes.clone()));
    }

    let days = std::array::from_fn(|i| today - Days::new(7 - i as u64));
    let mut week = Week { days, all: Default::default(), regions: BTreeMap::new() };
    let first = days[0].to_string();
    let until = today.to_string();
    let mut rows =
        conn.prepare_cached("SELECT day,rx,tx FROM traffic_daily WHERE node_id=?1 AND day>=?2 AND day<?3")?;
    for member in &members {
        let region = week.regions.entry(member.region.clone()).or_default();
        let created =
            DateTime::from_timestamp(member.created_at, 0).map(|d| d.with_timezone(&Local).date_naive());
        for (i, day) in days.iter().enumerate() {
            if created.is_some_and(|first| first <= *day) {
                region[i].expected_nodes += 1;
                week.all[i].expected_nodes += 1;
            }
        }
        // The composite primary key bounds each lookup to at most seven rows.
        let mut daily = rows.query(params![member.id, first, until])?;
        while let Some(row) = daily.next()? {
            let day: NaiveDate = row.get::<_, String>(0)?.parse()?;
            let i = (day - days[0]).num_days() as usize;
            if i >= days.len() || created.is_none_or(|first| first > day) {
                continue;
            }
            let rx = u64::try_from(row.get::<_, i64>(1)?)?;
            let tx = u64::try_from(row.get::<_, i64>(2)?)?;
            region[i].record(rx, tx);
            week.all[i].record(rx, tx);
        }
    }
    let bytes = Bytes::from(serde_json::to_vec(&week)?);
    *cache = Some(Cache { today, members, built: Instant::now(), bytes: bytes.clone() });
    Ok(Some(bytes))
}

pub async fn get(State(app): State<Shared>, headers: HeaderMap) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let admin = crate::auth::authed(&app, &headers);
        snapshot(&app, Local::now().date_naive(), admin)
    })
    .await
    .map_err(anyhow::Error::from)
    .and_then(|v| v);
    let response = match result {
        Ok(Some(bytes)) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
        Ok(None) => (StatusCode::UNAUTHORIZED, "sign-in required").into_response(),
        Err(e) => {
            tracing::warn!("weekly traffic unavailable: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "weekly traffic unavailable").into_response()
        }
    };
    ([(header::CACHE_CONTROL, "private, no-store")], response).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, Node};
    use chrono::TimeZone;
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn app() -> App {
        App::for_test(Db::open(":memory:").unwrap())
    }

    fn node(app: &App, name: &str, region: &str, public: bool, created: &str) -> i64 {
        let id =
            app.db.create_node(&Node { name: name.to_owned(), public, ..Default::default() }, name).unwrap();
        let day: NaiveDate = created.parse().unwrap();
        let ts =
            Local.from_local_datetime(&day.and_hms_opt(12, 30, 0).unwrap()).earliest().unwrap().timestamp();
        app.db
            .conn()
            .execute("UPDATE node SET country=?1,created_at=?2 WHERE id=?3", params![region, ts, id])
            .unwrap();
        id
    }

    fn record(app: &App, id: i64, day: &str, rx: i64, tx: i64) {
        app.db
            .conn()
            .execute("INSERT INTO traffic_daily VALUES (?1,?2,?3,?4)", params![id, day, rx, tx])
            .unwrap();
    }

    fn read(app: &App, today: &str) -> Value {
        serde_json::from_slice(&snapshot(app, today.parse().unwrap(), false).unwrap().unwrap()).unwrap()
    }

    #[test]
    fn completed_local_days_include_recorded_zeros_missing_periods_and_public_nodes_only() {
        let app = app();
        let a = node(&app, "Secret name A", " sg ", true, "2026-01-01");
        let b = node(&app, "New node", "SG", true, "2026-11-21");
        let unknown = node(&app, "Unknown address", "", true, "2026-01-01");
        let hidden = node(&app, "Private node", "JP", false, "2026-01-01");
        record(&app, a, "2026-11-15", 777, 777);
        record(&app, a, "2026-11-16", 0, 0);
        record(&app, a, "2026-11-22", 11, 25);
        record(&app, b, "2026-11-22", 88, 20);
        record(&app, unknown, "2026-11-22", 100, 5);
        record(&app, hidden, "2026-11-22", 5555, 7777);
        record(&app, a, "2026-11-23", 12345, 54321);
        let result = read(&app, "2026-11-23");
        assert_eq!(
            result["days"],
            json!([
                "2026-11-16",
                "2026-11-17",
                "2026-11-18",
                "2026-11-19",
                "2026-11-20",
                "2026-11-21",
                "2026-11-22"
            ])
        );
        assert_eq!(result["regions"]["SG"][0], json!({"rx":0,"tx":0,"expected_nodes":1,"observed_nodes":1}));
        assert_eq!(result["all"][0], json!({"rx":0,"tx":0,"expected_nodes":2,"observed_nodes":1}));
        assert_eq!(result["all"][1], json!({"rx":null,"tx":null,"expected_nodes":2,"observed_nodes":0}));
        assert_eq!(result["all"][5]["expected_nodes"], 3);
        assert_eq!(
            result["regions"]["SG"][6],
            json!({"rx":99,"tx":45,"expected_nodes":2,"observed_nodes":2})
        );
        assert_eq!(result["regions"][""][6]["rx"], 100);
        assert_eq!(result["all"][6], json!({"rx":199,"tx":50,"expected_nodes":3,"observed_nodes":3}));
        assert!(result["regions"].get("JP").is_none());
        assert_eq!(read(&app, "2026-11-24")["all"][6]["rx"], 12345);
    }

    #[test]
    fn warmed_data_tracks_public_membership_and_latest_country_immediately() {
        let app = app();
        let a = node(&app, "first", "JP", true, "2026-01-01");
        record(&app, a, "2026-11-22", 80, 40);
        let date = "2026-11-23".parse().unwrap();
        let bytes = snapshot(&app, date, false).unwrap().unwrap();
        let hit = snapshot(&app, date, false).unwrap().unwrap();
        assert_eq!(bytes.as_ptr(), hit.as_ptr(), "cache reuses serialized public data");
        app.db.conn().execute("UPDATE node SET country='CN' WHERE id=?1", [a]).unwrap();
        let changed = read(&app, "2026-11-23");
        assert!(changed["regions"].get("JP").is_none());
        assert_eq!(changed["regions"]["CN"][6]["tx"], 40);
        app.db.conn().execute("UPDATE node SET public=0 WHERE id=?1", [a]).unwrap();
        let hidden = read(&app, "2026-11-23");
        assert_eq!(hidden["regions"], json!({}));
        assert_eq!(hidden["all"][6], json!({"rx":null,"tx":null,"expected_nodes":0,"observed_nodes":0}));
    }

    #[test]
    fn unreadable_counters_do_not_create_an_observed_zero_day() {
        let app = app();
        let a = node(&app, "unmeasured", "", true, "2026-01-01");
        app.db.accumulate(a, "boot", None).unwrap();
        let n = || {
            app.db
                .conn()
                .query_row("SELECT COUNT(*) FROM traffic_daily WHERE node_id=?1", [a], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(n(), 0);
        app.db.accumulate(a, "boot", Some((100, 150))).unwrap();
        assert_eq!(n(), 1, "a readable baseline creates the first measured day");
        app.db.accumulate(a, "boot", None).unwrap();
        app.db.accumulate(a, "boot", Some((125, 160))).unwrap();
        assert_eq!(
            app.db
                .conn()
                .query_row("SELECT rx,tx FROM traffic_daily WHERE node_id=?1", [a], |r| Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?
                )))
                .unwrap(),
            (25, 10)
        );
    }

    #[tokio::test]
    async fn private_page_gates_cached_data_even_for_old_sessions() {
        let app = Arc::new(app());
        let public = get(State(app.clone()), HeaderMap::new()).await;
        assert_eq!(public.status(), StatusCode::OK);
        assert_eq!(public.headers()[header::CACHE_CONTROL], "private, no-store");
        app.db.set("public_page", "off").unwrap();
        let denied = get(State(app.clone()), HeaderMap::new()).await;
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(denied.headers()[header::CACHE_CONTROL], "private, no-store");
        let cookie = crate::auth::issue_session(&app, &HeaderMap::new()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, cookie.split(';').next().unwrap().parse().unwrap());
        let hidden = node(&app, "private", "HK", false, "2026-01-01");
        record(&app, hidden, &(Local::now().date_naive() - Days::new(1)).to_string(), 9876, 1234);
        let allowed = get(State(app.clone()), headers.clone()).await;
        assert_eq!(allowed.status(), StatusCode::OK);
        assert_eq!(allowed.headers()[header::CACHE_CONTROL], "private, no-store");
        let body: Value =
            serde_json::from_slice(&axum::body::to_bytes(allowed.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["regions"], json!({}), "even the authenticated response remains public-node-only");
        app.db.drop_all_sessions().unwrap();
        assert_eq!(get(State(app), headers).await.status(), StatusCode::UNAUTHORIZED);
    }
}
