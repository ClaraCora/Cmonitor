//! Verify the first node before releasing the rest of the selection together.
//! Success comes from the authenticated monitoring socket, never the updater.
use crate::{agent_ws::bearer, api::Admin, App, Shared};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
    time::Duration,
};

static EPOCH: LazyLock<String> = LazyLock::new(crate::auth::random_token);
const TIMEOUT: i64 = 600;
#[derive(Debug, Default, Clone)]
pub struct Live {
    pub tls: bool,
    pub version: String,
    pub reported: bool,
    seen: i64,
}
fn triple(v: &str) -> Option<[u32; 3]> {
    let n = v.split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>().ok()?;
    n.try_into().ok()
}
impl Live {
    fn eligibility(&self, target: &str, now: i64) -> &'static str {
        if !self.tls {
            return "plaintext";
        }
        let (Some(v), Some(t)) = (triple(&self.version), triple(target)) else { return "unknown" };
        if v >= t {
            return "current";
        }
        if !self.reported {
            return "no_report";
        }
        if self.seen == 0 || now - self.seen > 120 {
            return "unenrolled";
        }
        "ready"
    }
}
type Fleet = HashMap<i64, (u64, Live)>;
fn fleet(app: &App) -> Fleet {
    app.agents
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(id, a)| (*id, (a.session, a.rollout.clone())))
        .collect()
}
fn target() -> String {
    crate::agent_pin().tag.trim_start_matches('v').to_owned()
}
/// Revoke work up to the worker's apply gate. Nodes already authorised to
/// replace the binary must still be able to report their individual outcomes.
fn fail_item(tx: &Transaction, batch: i64, node: i64, reason: &str) -> rusqlite::Result<()> {
    tx.execute("UPDATE upgrade_item SET status='failed' WHERE batch=? AND node=?", (batch, node))?;
    tx.execute(
        "UPDATE upgrade_batch SET reason=? WHERE id=? AND reason=''",
        (format!("节点 #{node} · {reason}"), batch),
    )?;
    tx.execute(
        "UPDATE upgrade_item SET status='skipped' WHERE batch=? AND status IN ('queued','ready','waiting')",
        [batch],
    )?;
    Ok(())
}
/// Called inside the same transaction as every claim. A restored DB or a new
/// Hub process never silently resumes a previously authorised fleet operation.
fn advance(tx: &Transaction, f: &Fleet, now: i64) -> rusqlite::Result<()> {
    let active = tx
        .query_row("SELECT id,epoch,target FROM upgrade_batch WHERE status='running'", [], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .optional()?;
    let Some((id, epoch, target)) = active else { return Ok(()) };
    if epoch != *EPOCH {
        tx.execute("UPDATE upgrade_item SET status=CASE WHEN status IN ('installing','observing') THEN 'unconfirmed' ELSE 'skipped' END WHERE batch=? AND status IN ('queued','ready','waiting','installing','observing')", [id])?;
        tx.execute(
            "UPDATE upgrade_batch SET status='stopped',reason='Hub 已重启，请核对节点版本后重试' WHERE id=?",
            [id],
        )?;
        return Ok(());
    }
    let mut stmt = tx.prepare("SELECT node,status,previous_session,deadline FROM upgrade_item WHERE batch=? AND status IN ('ready','waiting','installing','observing') ORDER BY pos")?;
    let mut rows = stmt.query([id])?;
    let mut expired = Vec::new();
    let mut verified = Vec::new();
    while let Some(row) = rows.next()? {
        let node: i64 = row.get(0)?;
        let state: String = row.get(1)?;
        let old: String = row.get(2)?;
        if now >= row.get::<_, i64>(3)? {
            expired.push(node);
        } else if state == "observing"
            && f.get(&node).is_some_and(|(session, live)| {
                live.tls && session.to_string() != old && live.reported && live.version == target
            })
        {
            verified.push(node);
        }
    }
    for node in verified {
        tx.execute("UPDATE upgrade_item SET status='verified' WHERE batch=? AND node=?", (id, node))?;
    }
    for node in expired {
        fail_item(tx, id, node, "等待领取或新版上报超时")?;
    }
    // All followers become claimable in the same transaction. Poll and apply
    // re-check each node's current identity, transport, and eligibility.
    tx.execute(
        "UPDATE upgrade_item SET status='ready',deadline=? WHERE batch=? AND status='queued'
        AND EXISTS (SELECT 1 FROM upgrade_item WHERE batch=? AND pos=0 AND status='verified')",
        (now + TIMEOUT, id, id),
    )?;
    finish_if_settled(tx, id)?;
    Ok(())
}
fn finish_if_settled(tx: &Transaction, id: i64) -> rusqlite::Result<()> {
    tx.execute("UPDATE upgrade_batch SET status=CASE WHEN reason='' THEN 'done' ELSE 'stopped' END WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM upgrade_item WHERE batch=? AND status IN ('queued','ready','waiting','installing','observing'))", (id, id))?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    nodes: Vec<i64>,
}
fn db_error(e: rusqlite::Error) -> Response {
    tracing::error!("upgrade batch: {e}");
    (StatusCode::INTERNAL_SERVER_ERROR, "升级记录读写失败").into_response()
}
fn create(app: &App, ids: &[i64], f: &Fleet, now: i64) -> rusqlite::Result<Response> {
    let target = target();
    let mut conn = app.db.conn();
    let tx = conn.transaction()?;
    advance(&tx, f, now)?;
    if tx.query_row("SELECT EXISTS(SELECT 1 FROM upgrade_batch WHERE status='running')", [], |r| {
        r.get::<_, bool>(0)
    })? {
        tx.commit()?;
        return Ok((StatusCode::CONFLICT, "已有升级批次正在进行").into_response());
    }
    if ids.is_empty()
        || ids.len() > 100
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
        || !ids.iter().all(|id| f.get(id).is_some_and(|(_, l)| l.eligibility(&target, now) == "ready"))
    {
        tx.commit()?;
        return Ok(
            (StatusCode::BAD_REQUEST, "请选择 1 至 100 台已就绪、版本低于目标的 HTTPS 节点").into_response()
        );
    }
    tx.execute("INSERT INTO upgrade_batch(epoch,target,created) VALUES(?,?,?)", (&*EPOCH, &target, now))?;
    let id = tx.last_insert_rowid();
    for (pos, node) in ids.iter().enumerate() {
        tx.execute("INSERT INTO upgrade_item(batch,pos,node) VALUES(?,?,?)", (id, pos as i64, node))?;
    }
    tx.execute(
        "UPDATE upgrade_item SET status='ready',deadline=? WHERE batch=? AND pos=0",
        (now + TIMEOUT, id),
    )?;
    tx.commit()?;
    Ok(Json(json!({"id":id})).into_response())
}
pub async fn start(_: Admin, State(app): State<Shared>, Json(input): Json<Selection>) -> Response {
    create(&app, &input.nodes, &fleet(&app), Utc::now().timestamp()).unwrap_or_else(db_error)
}
fn overview(app: &App) -> rusqlite::Result<Value> {
    let now = Utc::now().timestamp();
    let f = fleet(app);
    let target = target();
    let mut conn = app.db.conn();
    let tx = conn.transaction()?;
    advance(&tx, &f, now)?;
    let latest = tx
        .query_row("SELECT id,target,status,reason FROM upgrade_batch ORDER BY id DESC LIMIT 1", [], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })
        .optional()?;
    let batch = if let Some((id, version, status, reason)) = latest {
        let mut q = tx.prepare("SELECT node,status FROM upgrade_item WHERE batch=? ORDER BY pos")?;
        let items = q
            .query_map([id], |r| Ok(json!({"node":r.get::<_,i64>(0)?,"status":r.get::<_,String>(1)?})))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        json!({"id":id,"target":version,"status":status,"reason":reason,"items":items})
    } else {
        Value::Null
    };
    tx.commit()?;
    let nodes = f
        .into_iter()
        .map(|(id, (_, l))| (id.to_string(), json!(l.eligibility(&target, now))))
        .collect::<serde_json::Map<_, _>>();
    Ok(json!({"target":target,"nodes":nodes,"batch":batch}))
}
pub async fn status(_: Admin, State(app): State<Shared>) -> Response {
    overview(&app).map(|v| Json(v).into_response()).unwrap_or_else(db_error)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Poll {
    action: String,
    batch: Option<i64>,
    error: Option<String>,
}
fn process(app: &App, node: i64, input: Poll, now: i64) -> rusqlite::Result<Value> {
    {
        let mut agents = app.agents.write().unwrap_or_else(|e| e.into_inner());
        if let Some(a) = agents.get_mut(&node).filter(|a| a.rollout.tls) {
            a.rollout.seen = now;
        }
    }
    let f = fleet(app);
    let mut conn = app.db.conn();
    let tx = conn.transaction()?;
    advance(&tx, &f, now)?;
    let row=tx.query_row("SELECT b.id,b.target,i.status,i.previous_session FROM upgrade_batch b JOIN upgrade_item i ON i.batch=b.id WHERE b.status='running' AND i.node=? AND i.status IN ('ready','waiting','installing','observing')",[node],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional()?;
    let mut reply = Value::Null;
    if let Some((id, target, state, old)) = row {
        match input.action.as_str() {
            "poll" if state == "ready" => {
                if let Some((session, _)) =
                    f.get(&node).filter(|(_, l)| l.eligibility(&target, now) == "ready")
                {
                    tx.execute("UPDATE upgrade_item SET status='waiting',previous_session=?,deadline=? WHERE batch=? AND node=?",params![session.to_string(),now+TIMEOUT,id,node])?;
                    reply = json!({"batch":id,"target":target});
                }
            }
            "apply"
                if input.batch == Some(id)
                    && state == "waiting"
                    && f.get(&node).is_some_and(|(s, l)| {
                        l.eligibility(&target, now) == "ready" && s.to_string() == old
                    }) =>
            {
                tx.execute(
                    "UPDATE upgrade_item SET status='installing' WHERE batch=? AND node=?",
                    (id, node),
                )?;
                reply = json!({"batch":id,"target":target});
            }
            "installed" if input.batch == Some(id) && state == "installing" => {
                tx.execute(
                    "UPDATE upgrade_item SET status='observing' WHERE batch=? AND node=?",
                    (id, node),
                )?;
            }
            "failed" if matches!(state.as_str(), "waiting" | "installing") && input.batch == Some(id) => {
                let reason = match input.error.as_deref() {
                    Some("verify") => "官方版本或摘要校验失败",
                    Some("restart") => "新服务启动失败，已尝试恢复旧程序",
                    _ => "节点升级器报告失败，请检查节点日志",
                };
                fail_item(&tx, id, node, reason)?;
                finish_if_settled(&tx, id)?;
            }
            _ => {}
        }
    }
    tx.commit()?;
    Ok(reply)
}
pub async fn poll(State(app): State<Shared>, headers: HeaderMap, Json(input): Json<Poll>) -> Response {
    if crate::forwarded_proto(&headers) != Some("https") || !crate::api::provisioning_allowed(&app, &headers)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(token) = bearer(&headers) else { return StatusCode::UNAUTHORIZED.into_response() };
    let Ok(Some(node)) = app.db.node_by_token(token) else { return StatusCode::UNAUTHORIZED.into_response() };
    if !matches!(input.action.as_str(), "poll" | "apply" | "installed" | "failed") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    process(&app, node, input, Utc::now().timestamp())
        .map(|v| Json(v).into_response())
        .unwrap_or_else(db_error)
}
pub async fn watch(app: Shared) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let f = fleet(&app);
        let result = (|| {
            let mut conn = app.db.conn();
            let tx = conn.transaction()?;
            advance(&tx, &f, Utc::now().timestamp())?;
            tx.commit()
        })();
        if let Err(e) = result {
            tracing::error!("advancing upgrade batch: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agent_ws::Agent, db::Db};
    const NOW: i64 = 1800000000;
    fn node(app: &App, id: i64, session: u64, version: &str, tls: bool, reported: bool) {
        let mut a = Agent::new(session, tokio::sync::mpsc::channel(1).0);
        a.rollout = Live { tls, version: version.into(), reported, seen: NOW };
        app.agents.write().unwrap().insert(id, a);
    }
    fn fixture() -> App {
        let app = App::for_test(Db::open(":memory:").unwrap());
        for id in 1..=2 {
            node(&app, id, id as u64, "1.0.0", true, true);
        }
        app
    }
    fn poll(app: &App, node: i64, action: &str, batch: Option<i64>, now: i64) -> Value {
        process(app, node, Poll { action: action.into(), batch, error: None }, now).unwrap()
    }
    #[test]
    fn canary_needs_same_identity_new_session_target_hello_and_report() {
        let app = fixture();
        assert_eq!(create(&app, &[1, 2], &fleet(&app), NOW).unwrap().status(), 200);
        let job = poll(&app, 1, "poll", None, NOW);
        assert_eq!(job["target"], target());
        assert!(poll(&app, 2, "poll", None, NOW).is_null());
        assert!(poll(&app, 2, "apply", Some(1), NOW).is_null());
        assert_eq!(poll(&app, 1, "apply", Some(1), NOW), job);
        poll(&app, 1, "installed", Some(1), NOW);
        node(&app, 9, 22, &target(), true, true); // Another node cannot release the queue.
        node(&app, 1, 1, &target(), true, true);
        assert!(poll(&app, 2, "poll", None, NOW).is_null());
        node(&app, 1, 3, "1.0.0", true, true);
        assert!(poll(&app, 2, "poll", None, NOW).is_null());
        node(&app, 1, 4, &target(), true, false);
        assert!(poll(&app, 2, "poll", None, NOW).is_null());
        node(&app, 1, 4, &target(), true, true);
        assert_eq!(poll(&app, 2, "poll", None, NOW), job);
        assert_eq!(poll(&app, 2, "apply", Some(1), NOW), job);
        poll(&app, 2, "installed", Some(1), NOW);
        node(&app, 2, 5, &target(), true, true);
        poll(&app, 2, "poll", None, NOW);
        assert_eq!(
            app.db
                .conn()
                .query_row("SELECT status FROM upgrade_batch", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "done"
        );
    }
    #[test]
    fn failure_timeout_and_hub_restart_never_dispatch_the_next_node() {
        for mode in ["failed", "timeout", "restart"] {
            let app = fixture();
            create(&app, &[1, 2], &fleet(&app), NOW).unwrap();
            poll(&app, 1, "poll", None, NOW);
            assert_eq!(create(&app, &[2], &fleet(&app), NOW).unwrap().status(), 409);
            if mode == "restart" {
                app.db.conn().execute("UPDATE upgrade_batch SET epoch='before-restart'", []).unwrap();
            }
            if mode == "failed" {
                poll(&app, 1, "failed", Some(1), NOW);
            }
            assert!(poll(&app, 2, "poll", None, NOW + if mode == "timeout" { TIMEOUT } else { 1 }).is_null());
            assert_eq!(
                app.db
                    .conn()
                    .query_row("SELECT status FROM upgrade_item WHERE pos=1", [], |r| r.get::<_, String>(0))
                    .unwrap(),
                "skipped"
            );
        }
    }
    fn start_with_verified_canary(count: i64) -> App {
        let app = fixture();
        let ids: Vec<_> = (1..=count).collect();
        for &id in &ids {
            node(&app, id, id as u64, "1.0.0", true, true);
        }
        assert_eq!(create(&app, &ids, &fleet(&app), NOW).unwrap().status(), 200);
        poll(&app, 1, "poll", None, NOW);
        poll(&app, 1, "apply", Some(1), NOW);
        poll(&app, 1, "installed", Some(1), NOW);
        node(&app, 1, 1001, &target(), true, true);
        app
    }
    fn snapshot(app: &App) -> (String, Vec<String>) {
        let db = app.db.conn();
        let status = db.query_row("SELECT status FROM upgrade_batch", [], |r| r.get(0)).unwrap();
        let mut query = db.prepare("SELECT status FROM upgrade_item ORDER BY pos").unwrap();
        let items = query.query_map([], |r| r.get(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        (status, items)
    }
    #[test]
    fn nineteen_followers_can_apply_before_any_one_finishes() {
        let app = start_with_verified_canary(20);
        for id in 2..=20 {
            assert_eq!(poll(&app, id, "poll", None, NOW)["batch"], 1);
            assert_eq!(poll(&app, id, "apply", Some(1), NOW)["batch"], 1);
        }
        assert!(snapshot(&app).1[1..].iter().all(|status| status == "installing"));
        for id in (2..=20).rev() {
            poll(&app, id, "installed", Some(1), NOW);
            node(&app, id, 1000 + id as u64, &target(), true, true);
            poll(&app, id, "poll", None, NOW);
            assert_eq!(snapshot(&app).0, if id == 2 { "done" } else { "running" });
        }
        assert!(snapshot(&app).1.iter().all(|status| status == "verified"));
    }
    #[test]
    fn failure_revokes_unapproved_work_but_drains_already_approved_siblings() {
        let app = start_with_verified_canary(6);
        for id in 2..=5 {
            poll(&app, id, "poll", None, NOW);
        }
        for id in [2, 3, 4] {
            poll(&app, id, "apply", Some(1), NOW);
        }
        poll(&app, 4, "installed", Some(1), NOW);
        poll(&app, 2, "failed", Some(1), NOW);
        assert_eq!(snapshot(&app).1, ["verified", "failed", "installing", "observing", "skipped", "skipped"]);
        assert!(poll(&app, 5, "apply", Some(1), NOW).is_null());
        assert!(poll(&app, 6, "poll", None, NOW).is_null());
        assert_eq!(create(&app, &[6], &fleet(&app), NOW).unwrap().status(), 409);
        node(&app, 4, 1004, &target(), true, true);
        poll(&app, 4, "poll", None, NOW + 1);
        poll(&app, 3, "poll", None, NOW + TIMEOUT);
        let (status, items) = snapshot(&app);
        assert_eq!(status, "stopped");
        assert_eq!(items, ["verified", "failed", "failed", "verified", "skipped", "skipped"]);
    }
    #[test]
    fn selecting_http_offline_current_unenrolled_or_duplicates_rejects_the_entire_batch() {
        let app = fixture();
        node(&app, 3, 3, "1.0.0", false, true);
        node(&app, 4, 4, &target(), true, true);
        node(&app, 5, 5, "1.0.0", true, true);
        app.agents.write().unwrap().get_mut(&5).unwrap().rollout.seen = 0;
        for ids in [vec![2, 3], vec![2, 4], vec![2, 5], vec![2, 99], vec![2, 2], vec![]] {
            assert_eq!(create(&app, &ids, &fleet(&app), NOW).unwrap().status(), 400);
        }
        assert_eq!(
            app.db
                .conn()
                .query_row("SELECT count(*) FROM upgrade_batch", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
