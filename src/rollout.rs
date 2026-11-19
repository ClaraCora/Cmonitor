//! Each batch has one outstanding node. A worker may only obtain the Hub's pin.
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
fn stop(tx: &Transaction, id: i64, reason: &str) -> rusqlite::Result<()> {
    tx.execute("UPDATE upgrade_item SET status=CASE WHEN status='queued' THEN 'skipped' ELSE 'failed' END WHERE batch=? AND status IN ('ready','waiting','installing','observing','queued')",[id])?;
    tx.execute("UPDATE upgrade_batch SET status='stopped',reason=? WHERE id=?", (reason, id))?;
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
        return stop(tx, id, "Hub 已重启，请重新选择尚未升级的节点");
    }
    let item=tx.query_row("SELECT node,status,previous_session,deadline FROM upgrade_item WHERE batch=? AND status IN ('ready','waiting','installing','observing')",[id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,i64>(3)?))).optional()?;
    if let Some((node, state, old, end)) = item {
        if now >= end {
            return stop(tx, id, "等待领取或新版上报超时");
        }
        if state != "observing"
            || !f
                .get(&node)
                .is_some_and(|(s, l)| l.tls && s.to_string() != old && l.reported && l.version == target)
        {
            return Ok(());
        }
        tx.execute("UPDATE upgrade_item SET status='verified' WHERE batch=? AND node=?", (id, node))?;
    }
    let next = tx
        .query_row(
            "SELECT node FROM upgrade_item WHERE batch=? AND status='queued' ORDER BY pos LIMIT 1",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    if let Some(node) = next {
        if !f.get(&node).is_some_and(|(_, l)| l.eligibility(&target, now) == "ready") {
            return stop(tx, id, "下一台节点已离线、版本变化或升级器未就绪");
        }
        tx.execute(
            "UPDATE upgrade_item SET status='ready',deadline=? WHERE batch=? AND node=?",
            (now + TIMEOUT, id, node),
        )?;
    } else {
        tx.execute("UPDATE upgrade_batch SET status='done' WHERE id=?", [id])?;
    }
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
    advance(&tx, f, now)?;
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
                stop(&tx, id, reason)?;
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
