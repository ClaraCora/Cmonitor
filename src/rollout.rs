//! Verify the first node before releasing the rest of the selection together.
//! Success requires both a maintenance receipt and a new authenticated reporting session.
use crate::{agent_ws::bearer, api::Admin, App, Shared};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use rusqlite::{OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicI64, Ordering},
        LazyLock,
    },
    time::Duration,
};

static EPOCH: LazyLock<String> = LazyLock::new(crate::auth::random_token);
// Active batches never survive a Hub restart. This process-local order lets a
// receipt and an Agent report within the same second be compared exactly.
static OBSERVATION_ORDER: AtomicI64 = AtomicI64::new(1);
fn next_observation() -> i64 {
    OBSERVATION_ORDER.fetch_add(1, Ordering::Relaxed)
}
const TIMEOUT: i64 = 600; // Each phase gets a fresh budget.
const ROLLBACK_OFFER: i64 = 120;
const ROLLBACK_WINDOW: i64 = 180;
const REPORT_FRESH: i64 = 90;
#[derive(Debug, Default, Clone)]
pub struct Live {
    pub tls: bool,
    pub version: String,
    pub reported: bool,
    complete_order: i64,
    seen: i64,
    incomplete_since: i64,
    incomplete_latest: i64,
}
fn triple(v: &str) -> Option<[u32; 3]> {
    let n = v.split('.').map(str::parse::<u32>).collect::<Result<Vec<_>, _>>().ok()?;
    n.try_into().ok()
}
impl Live {
    pub fn reset_report(&mut self) {
        self.reported = false;
        self.complete_order = 0;
        self.incomplete_since = 0;
        self.incomplete_latest = 0;
    }
    pub fn record_report(&mut self, complete: bool, now: i64) {
        self.reported = complete;
        if complete {
            self.complete_order = next_observation();
            self.incomplete_since = 0;
            self.incomplete_latest = 0;
        } else {
            if self.incomplete_latest == 0 || now - self.incomplete_latest > REPORT_FRESH {
                self.incomplete_since = now;
            }
            self.incomplete_latest = now;
        }
    }
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
fn set_item(
    tx: &Transaction,
    batch: i64,
    node: i64,
    status: &str,
    reason: &str,
    deadline: i64,
    now: i64,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE upgrade_item SET status=?, reason=?, deadline=?, updated_at=? WHERE batch=? AND node=?",
        (status, reason, deadline, now, batch, node),
    )?;
    Ok(())
}

/// Stop issuing permissions, but let already-authorised peers settle.
fn stop_pending(tx: &Transaction, batch: i64, node: i64, reason: &str, now: i64) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE upgrade_batch SET reason=? WHERE id=? AND reason=''",
        (format!("节点 #{node} · {reason}"), batch),
    )?;
    tx.execute(
        "UPDATE upgrade_item SET status='skipped', reason='批次已停止，未安装', deadline=0, updated_at=?
        WHERE batch=? AND status IN ('queued','ready','waiting')",
        (now, batch),
    )?;
    Ok(())
}

/// Called before a restored DB becomes live, as well as on process restart.
pub(crate) fn invalidate_running(tx: &Transaction, reason: &str, now: i64) -> rusqlite::Result<()> {
    tx.execute("UPDATE upgrade_item SET status=CASE WHEN status IN ('queued','ready','waiting') THEN 'skipped' ELSE 'unconfirmed' END,
        reason=?,deadline=0,updated_at=? WHERE batch IN (SELECT id FROM upgrade_batch WHERE status='running')
        AND status IN ('queued','ready','waiting','installing','observing','rollback_pending','rolling_back')", (reason,now))?;
    tx.execute("UPDATE upgrade_batch SET status='stopped',reason=? WHERE status='running'", [reason])?;
    Ok(())
}

pub(crate) fn revoke_node(tx: &Transaction, node: i64) -> rusqlite::Result<()> {
    let batch = tx.query_row("SELECT b.id FROM upgrade_batch b JOIN upgrade_item i ON i.batch=b.id WHERE b.status='running' AND i.node=?", [node], |r|r.get::<_,i64>(0)).optional()?;
    if let Some(batch) = batch {
        let now = Utc::now().timestamp();
        let why = "节点维护授权已撤销";
        tx.execute("UPDATE upgrade_item SET status='unconfirmed', reason=?, deadline=0, updated_at=?
            WHERE node=? AND batch=? AND status IN ('installing','observing','rollback_pending','rolling_back')", (why,now,node,batch))?;
        stop_pending(tx, batch, node, why, now)?;
        finish_if_settled(tx, batch)?;
    }
    Ok(())
}

fn target_session<'a>(fleet: &'a Fleet, node: i64, previous: &str, target: &str) -> Option<&'a Live> {
    fleet
        .get(&node)
        .filter(|(session, live)| live.tls && session.to_string() != previous && live.version == target)
        .map(|(_, live)| live)
}

// Only positive, repeated observations of the new binary producing incomplete
// data qualify. Loss of network, worker receipts, or the Hub cannot prove this.
fn stalled(live: Option<&Live>, now: i64) -> bool {
    live.is_some_and(|l| {
        !l.reported
            && l.incomplete_since > 0
            && l.incomplete_latest - l.incomplete_since >= REPORT_FRESH
            && (0..=REPORT_FRESH).contains(&(now - l.incomplete_latest))
    })
}

fn advance(tx: &Transaction, f: &Fleet, now: i64) -> rusqlite::Result<()> {
    let active = tx
        .query_row("SELECT id,epoch,target FROM upgrade_batch WHERE status='running'", [], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .optional()?;
    let Some((id, epoch, target)) = active else { return Ok(()) };
    if epoch != *EPOCH {
        return invalidate_running(tx, "Hub 已重启，请核对节点版本后重试", now);
    }
    let mut stmt=tx.prepare("SELECT node,status,previous_session,deadline,attempt,receipt_order FROM upgrade_item WHERE batch=? AND status IN ('ready','waiting','installing','observing','rollback_pending','rolling_back') ORDER BY pos")?;
    let items = stmt
        .query_map([id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Evaluate already-authorised peers even when another node has stopped the
    // batch. Apply expiration to the expired item itself before skipping siblings.
    let mut failures = Vec::new();
    for (node, state, old, deadline, attempt, receipt_order) in items {
        let live = target_session(f, node, &old, &target);
        // The independent worker must acknowledge installation as well as the
        // reporting channel showing the new version. Either identity alone is insufficient.
        if matches!(state.as_str(), "observing" | "rollback_pending")
            && live.is_some_and(|l| l.reported && l.complete_order > receipt_order)
        {
            set_item(tx, id, node, "verified", "原节点已使用目标版本恢复上报", 0, now)?;
            continue;
        }
        if now < deadline {
            continue;
        }
        let (phase, reason, next) = match state.as_str() {
            "ready" => ("failed", "等待升级器领取超时", 0),
            "waiting" => ("failed", "下载或校验超时", 0),
            "observing" if !attempt.is_empty() && stalled(live, now) => {
                ("rollback_pending", "已确认新版持续上报不完整指标，等待升级器领取回滚", now + ROLLBACK_OFFER)
            }
            "observing" => ("unconfirmed", "等待新版完整上报超时，请核对节点", 0),
            "installing" => ("unconfirmed", "安装许可已发出，安装结果待核实", 0),
            _ => ("unconfirmed", "回滚结果待核实", 0),
        };
        set_item(tx, id, node, phase, reason, next, now)?;
        failures.push((node, reason));
    }
    for (node, reason) in failures {
        stop_pending(tx, id, node, reason, now)?;
    }
    tx.execute(
        "UPDATE upgrade_item SET status='ready',deadline=?,updated_at=? WHERE batch=? AND status='queued'
        AND EXISTS (SELECT 1 FROM upgrade_item WHERE batch=? AND pos=0 AND status='verified')
        AND EXISTS (SELECT 1 FROM upgrade_batch WHERE id=? AND reason='')",
        (now + TIMEOUT, now, id, id, id),
    )?;
    finish_if_settled(tx, id)
}
fn finish_if_settled(tx: &Transaction, id: i64) -> rusqlite::Result<()> {
    tx.execute("UPDATE upgrade_batch SET status=CASE WHEN reason='' THEN 'done' ELSE 'stopped' END WHERE id=?
        AND NOT EXISTS (SELECT 1 FROM upgrade_item WHERE batch=? AND status IN ('queued','ready','waiting','installing','observing','rollback_pending','rolling_back'))",(id,id))?;
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
    let mut authorized=tx.prepare("SELECT EXISTS(SELECT 1 FROM upgrade_worker w JOIN node_maintenance m ON m.node=w.node WHERE w.node=? AND w.last_seen BETWEEN ? AND ? AND m.key_hash IS NOT NULL AND m.offline_only=0)")?;
    let mut paired = true;
    for &node in ids.iter().take(100) {
        paired &= authorized.query_row((node, now - 120, now), |r| r.get::<_, bool>(0))?;
    }
    drop(authorized);
    if !paired
        || ids.is_empty()
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
        tx.execute(
            "INSERT INTO upgrade_item(batch,pos,node,updated_at) VALUES(?,?,?,?)",
            (id, pos as i64, node, now),
        )?;
    }
    tx.execute(
        "UPDATE upgrade_item SET status='ready',deadline=? WHERE batch=? AND pos=0",
        (now + TIMEOUT, id),
    )?;
    tx.commit()?;
    Ok(Json(json!({"id":id})).into_response())
}
pub async fn start(_: Admin, State(app): State<Shared>, Json(input): Json<Selection>) -> Response {
    tokio::task::block_in_place(|| {
        create(&app, &input.nodes, &fleet(&app), Utc::now().timestamp()).unwrap_or_else(db_error)
    })
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
        let mut q = tx.prepare(
            "SELECT node,status,reason,deadline,updated_at FROM upgrade_item WHERE batch=? ORDER BY pos",
        )?;
        let items = q
            .query_map([id], |r| Ok(json!({"node":r.get::<_,i64>(0)?,"status":r.get::<_,String>(1)?,"reason":r.get::<_,String>(2)?,"deadline":r.get::<_,i64>(3)?,"updated_at":r.get::<_,i64>(4)?})))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        json!({"id":id,"target":version,"status":status,"reason":reason,"items":items})
    } else {
        Value::Null
    };
    let workers = {
        let mut query = tx.prepare("SELECT node,protocol,last_seen FROM upgrade_worker")?;
        let rows = query.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?.to_string(),
                json!({"protocol":r.get::<_,u8>(1)?,"last_seen":r.get::<_,i64>(2)?}),
            ))
        })?;
        rows.collect::<rusqlite::Result<serde_json::Map<_, _>>>()?
    };
    let policies = {
        let mut query=tx.prepare("SELECT n.id,CASE WHEN m.offline_only=1 THEN 'offline_only' WHEN m.key_hash IS NOT NULL THEN 'paired' ELSE 'unpaired' END FROM node n LEFT JOIN node_maintenance m ON n.id=m.node")?;
        let rows =
            query.query_map([], |r| Ok((r.get::<_, i64>(0)?.to_string(), json!(r.get::<_, String>(1)?))))?;
        rows.collect::<rusqlite::Result<serde_json::Map<_, _>>>()?
    };
    tx.commit()?;
    let nodes = f
        .into_iter()
        .map(|(id, (_, l))| {
            let key = id.to_string();
            let reason = if policies.get(&key).and_then(Value::as_str) == Some("offline_only") {
                "plaintext"
            } else if l.eligibility(&target, now) == "ready" && !workers.contains_key(&key) {
                "unenrolled"
            } else {
                l.eligibility(&target, now)
            };
            (key, json!(reason))
        })
        .collect::<serde_json::Map<_, _>>();
    Ok(json!({"target":target,"nodes":nodes,"batch":batch,"workers":workers,"maintenance":policies}))
}
pub async fn status(_: Admin, State(app): State<Shared>) -> Response {
    tokio::task::block_in_place(|| overview(&app).map(|v| Json(v).into_response()).unwrap_or_else(db_error))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Poll {
    action: String,
    batch: Option<i64>,
    error: Option<String>,
    protocol: Option<u8>,
    attempt: Option<String>,
}
#[cfg(test)]
fn process(app: &App, node: i64, input: Poll, now: i64) -> rusqlite::Result<Value> {
    process_key(app, &crate::auth::sha256(&format!("fixture-maint-{node}")), input, now)
        .map(|r| r.expect("test worker is paired"))
}
fn process_key(app: &App, key_hash: &str, input: Poll, now: i64) -> rusqlite::Result<Option<Value>> {
    // Check the credential in the same transaction that records or grants the
    // operation, so a concurrent revocation takes effect on every subsequent call.
    let mut f = fleet(app);
    let mut conn = app.db.conn();
    let tx = conn.transaction()?;
    let Some(node) = tx
        .query_row("SELECT node FROM node_maintenance WHERE key_hash=? AND offline_only=0", [key_hash], |r| {
            r.get::<_, i64>(0)
        })
        .optional()?
    else {
        return Ok(None);
    };
    if let Some((_, l)) = f.get_mut(&node).filter(|(_, l)| l.tls) {
        l.seen = now;
    }
    tx.execute(
        "INSERT INTO upgrade_worker(node,protocol,last_seen) SELECT id,?,? FROM node WHERE id=?
        ON CONFLICT(node) DO UPDATE SET protocol=excluded.protocol,last_seen=excluded.last_seen",
        (input.protocol.unwrap_or(1), now, node),
    )?;
    advance(&tx, &f, now)?;
    let v2 = input.protocol == Some(2);
    let row = tx
        .query_row(
            "SELECT b.id,b.target,i.status,i.previous_session,i.attempt,i.deadline,b.status
         FROM upgrade_item i JOIN upgrade_batch b ON b.id=i.batch WHERE i.node=?
         AND ((? IS NOT NULL AND b.id=?) OR (? IS NULL AND b.status='running'))",
            (node, input.batch, input.batch, input.batch),
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, String>(6)?,
                ))
            },
        )
        .optional()?;
    let is_receipt = v2 && matches!(input.action.as_str(), "installed" | "status" | "failed" | "rollback");
    let mut reply = if is_receipt { json!({"status":"unknown"}) } else { Value::Null };
    if let Some((id, target, state, old, attempt, deadline, batch_state)) = row {
        let same_worker = if v2 {
            !attempt.is_empty() && input.attempt.as_deref() == Some(attempt.as_str())
        } else {
            attempt.is_empty() && input.attempt.is_none()
        };
        let session = f
            .get(&node)
            .filter(|(_, live)| live.eligibility(&target, now) == "ready")
            .map(|(s, _)| s.to_string());
        let same_session = session.as_deref() == Some(old.as_str());
        let job = |attempt: &str| {
            if v2 {
                json!({"batch":id,"target":target,"protocol":2,"attempt":attempt})
            } else {
                json!({"batch":id,"target":target})
            }
        };
        if batch_state == "running" {
            match input.action.as_str() {
                "poll" if input.batch.is_none() && state == "ready" && session.is_some() => {
                    let token = if v2 { hex::encode(rand::random::<[u8; 16]>()) } else { String::new() };
                    tx.execute(
                        "UPDATE upgrade_item SET attempt=?,previous_session=? WHERE batch=? AND node=?",
                        (&token, session, id, node),
                    )?;
                    set_item(&tx, id, node, "waiting", "", now + TIMEOUT, now)?;
                    reply = job(&token);
                }
                "poll"
                    if input.batch.is_none()
                        && same_session
                        && state == "waiting"
                        && (v2 != attempt.is_empty()) =>
                {
                    reply = job(&attempt)
                }
                "apply"
                    if input.batch == Some(id)
                        && same_worker
                        && same_session
                        && matches!(state.as_str(), "waiting" | "installing") =>
                {
                    if state == "waiting" {
                        set_item(&tx, id, node, "installing", "", now + TIMEOUT, now)?;
                    }
                    reply = job(&attempt);
                }
                "installed" if input.batch == Some(id) && same_worker && state == "installing" => {
                    tx.execute(
                        "UPDATE upgrade_item SET receipt_order=? WHERE batch=? AND node=?",
                        (next_observation(), id, node),
                    )?;
                    set_item(&tx, id, node, "observing", "", now + TIMEOUT, now)?;
                }
                "rollback"
                    if v2
                        && same_worker
                        && input.batch == Some(id)
                        && matches!(state.as_str(), "rollback_pending" | "rolling_back") =>
                {
                    if state == "rolling_back" && stalled(target_session(&f, node, &old, &target), now) {
                        reply = json!({"status":"rollback","deadline":deadline});
                    } else if state == "rollback_pending"
                        && stalled(target_session(&f, node, &old, &target), now)
                    {
                        let end = now + ROLLBACK_WINDOW;
                        set_item(&tx, id, node, "rolling_back", "已授权升级器恢复旧版", end, now)?;
                        reply = json!({"status":"rollback","deadline":end});
                    }
                }
                "failed" if input.batch == Some(id) && same_worker => {
                    let failure = match (state.as_str(), input.error.as_deref()) {
                        ("rolling_back", Some("rolled_back")) => {
                            Some(("rolled_back", "升级器已确认恢复旧版服务"))
                        }
                        ("rolling_back", Some("rollback_failed")) => {
                            Some(("unconfirmed", "升级器未能确认恢复旧版，请检查节点"))
                        }
                        ("waiting" | "installing", Some("download")) => {
                            Some(("failed", "下载失败，请检查网络或稍后重试"))
                        }
                        ("waiting" | "installing", Some("verify")) => {
                            Some(("failed", "官方版本或摘要校验失败"))
                        }
                        ("waiting" | "installing", Some("restart")) => {
                            Some(("failed", "新服务启动失败，请核查旧版服务状态"))
                        }
                        ("waiting" | "installing", _) => {
                            Some(("failed", "节点升级器报告失败，请检查节点日志"))
                        }
                        _ => None,
                    };
                    if let Some((phase, reason)) = failure {
                        set_item(&tx, id, node, phase, reason, 0, now)?;
                        stop_pending(&tx, id, node, reason, now)?;
                        finish_if_settled(&tx, id)?;
                    }
                }
                _ => {}
            }
        }
        if is_receipt && same_worker && input.batch == Some(id) && reply["status"] != "rollback" {
            let phase: String =
                tx.query_row("SELECT status FROM upgrade_item WHERE batch=? AND node=?", (id, node), |r| {
                    r.get(0)
                })?;
            reply = json!({"status":phase});
        }
    }
    tx.commit()?;
    drop(conn);
    if let Some(a) =
        app.agents.write().unwrap_or_else(|e| e.into_inner()).get_mut(&node).filter(|a| a.rollout.tls)
    {
        a.rollout.seen = now;
    }
    Ok(Some(reply))
}
pub async fn poll(State(app): State<Shared>, headers: HeaderMap, Json(input): Json<Poll>) -> Response {
    tokio::task::block_in_place(|| {
        if crate::forwarded_proto(&headers) != Some("https")
            || !crate::api::provisioning_allowed(&app, &headers)
        {
            return StatusCode::FORBIDDEN.into_response();
        }
        let Some(token) = bearer(&headers) else { return StatusCode::UNAUTHORIZED.into_response() };
        if !token.strip_prefix("cmu_").is_some_and(crate::pairing::hex_digest) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        if input.protocol == Some(2) && input.action == "identity" {
            // An interrupted pairing may need to confirm its locally persisted key.
            // Looking up the identity must not announce a worker or claim a rollout.
            return app
                .db
                .conn()
                .query_row(
                    "SELECT node FROM node_maintenance WHERE key_hash=? AND offline_only=0",
                    [crate::auth::sha256(token)],
                    |r| r.get::<_, i64>(0),
                )
                .optional()
                .map(|n| match n {
                    Some(node) => Json(json!({"node":node})).into_response(),
                    None => StatusCode::UNAUTHORIZED.into_response(),
                })
                .unwrap_or_else(db_error);
        }
        if input.protocol != Some(2)
            || !matches!(
                input.action.as_str(),
                "poll" | "apply" | "installed" | "failed" | "status" | "rollback"
            )
        {
            return StatusCode::BAD_REQUEST.into_response();
        }
        process_key(&app, &crate::auth::sha256(token), input, Utc::now().timestamp())
            .map(|v| v.map_or_else(|| StatusCode::UNAUTHORIZED.into_response(), |v| Json(v).into_response()))
            .unwrap_or_else(db_error)
    })
}
pub async fn watch(app: Shared) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let f = fleet(&app);
        let result = tokio::task::block_in_place(|| {
            let mut conn = app.db.conn();
            let tx = conn.transaction()?;
            advance(&tx, &f, Utc::now().timestamp())?;
            tx.commit()
        });
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
        {
            let db = app.db.conn();
            db.execute(
                "INSERT OR IGNORE INTO node(id,name,token,created_at) VALUES(?,?,'fixture-report-' || ?,0)",
                (id, format!("fixture-{id}"), id),
            )
            .unwrap();
            db.execute(
                "INSERT OR IGNORE INTO node_maintenance(node,key_hash) VALUES(?,?)",
                (id, crate::auth::sha256(&format!("fixture-maint-{id}"))),
            )
            .unwrap();
            db.execute(
                "INSERT OR IGNORE INTO upgrade_worker(node,protocol,last_seen) VALUES(?,2,?)",
                (id, NOW),
            )
            .unwrap();
        }
        let mut a = Agent::new(session, tokio::sync::mpsc::channel(1).0);
        a.rollout = Live { tls, version: version.into(), reported, seen: NOW, ..Default::default() };
        a.rollout.record_report(reported, NOW);
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
        process(
            app,
            node,
            Poll { action: action.into(), batch, error: None, protocol: None, attempt: None },
            now,
        )
        .unwrap()
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
        assert_eq!(items, ["verified", "failed", "unconfirmed", "verified", "skipped", "skipped"]);
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

    fn v2(app: &App, action: &str, job: Option<&Value>, error: Option<&str>, now: i64) -> Value {
        process(
            app,
            1,
            Poll {
                action: action.into(),
                protocol: Some(2),
                batch: job.and_then(|j| j["batch"].as_i64()),
                attempt: job.and_then(|j| j["attempt"].as_str()).map(str::to_owned),
                error: error.map(str::to_owned),
            },
            now,
        )
        .unwrap()
    }
    fn begin_v2(app: &App) -> Value {
        assert_eq!(create(app, &[1, 2], &fleet(app), NOW).unwrap().status(), 200);
        v2(app, "poll", None, None, NOW)
    }

    #[test]
    fn replays_preserve_session_attempt_and_phase_deadlines() {
        let app = fixture();
        let job = begin_v2(&app);
        assert_eq!(job["attempt"].as_str().unwrap().len(), 32);
        assert_eq!(v2(&app, "poll", None, None, NOW + 30), job);
        let wrong = json!({"batch":1,"attempt":"other"});
        assert!(v2(&app, "apply", Some(&wrong), None, NOW + 31).is_null());
        assert!(poll(&app, 1, "apply", Some(1), NOW + 32).is_null());
        assert_eq!(v2(&app, "apply", Some(&job), None, NOW + TIMEOUT - 1), job);
        assert_eq!(v2(&app, "apply", Some(&job), None, NOW + TIMEOUT + 2), job);
        let end = |app: &App| {
            app.db
                .conn()
                .query_row("SELECT deadline FROM upgrade_item WHERE node=1", [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(end(&app), NOW + TIMEOUT * 2 - 1);
        assert_eq!(v2(&app, "installed", Some(&job), None, NOW + TIMEOUT + 30)["status"], "observing");
        assert_eq!(v2(&app, "installed", Some(&job), None, NOW + TIMEOUT + 60)["status"], "observing");
        assert_eq!(end(&app), NOW + TIMEOUT * 2 + 30);
        node(&app, 1, 12, &target(), true, true);
        assert_eq!(v2(&app, "status", Some(&job), None, NOW + TIMEOUT + 90)["status"], "verified");
        assert_eq!(v2(&app, "failed", Some(&job), Some("restart"), NOW + TIMEOUT + 91)["status"], "verified");
        assert_eq!(v2(&app, "status", Some(&wrong), None, NOW + TIMEOUT + 91)["status"], "unknown");
    }

    #[test]
    fn receipt_and_a_subsequent_complete_report_are_both_required() {
        let app = fixture();
        let job = begin_v2(&app);
        v2(&app, "apply", Some(&job), None, NOW);
        assert!(poll(&app, 2, "poll", None, NOW + 1).is_null());
        node(&app, 1, 21, &target(), true, true);
        assert!(poll(&app, 2, "poll", None, NOW + 2).is_null());
        assert_eq!(snapshot(&app).1, ["installing", "queued"]);
        v2(&app, "installed", Some(&job), None, NOW + 3);
        assert!(poll(&app, 2, "poll", None, NOW + 4).is_null());
        assert_eq!(snapshot(&app).1, ["observing", "queued"]);
        app.agents.write().unwrap().get_mut(&1).unwrap().rollout.record_report(true, NOW + 5);
        assert!(poll(&app, 2, "poll", None, NOW + 5).is_object());
        assert_eq!(snapshot(&app).1, ["verified", "waiting"]);
    }

    #[test]
    fn a_legacy_claim_can_be_retried_only_on_its_original_session() {
        let app = fixture();
        create(&app, &[1, 2], &fleet(&app), NOW).unwrap();
        let job = poll(&app, 1, "poll", None, NOW);
        assert_eq!(job, json!({"batch":1,"target":target()}));
        assert_eq!(poll(&app, 1, "poll", None, NOW + 1), job);
        node(&app, 1, 99, "1.0.0", true, true);
        assert!(poll(&app, 1, "poll", None, NOW + 2).is_null());
        assert!(poll(&app, 1, "apply", Some(1), NOW + 2).is_null());
    }

    #[test]
    fn rollback_requires_continuous_evidence_and_bounded_permission() {
        for mode in ["offline", "incomplete_once", "fresh", "recovered", "expired", "done"] {
            let app = fixture();
            let job = begin_v2(&app);
            v2(&app, "apply", Some(&job), None, NOW);
            v2(&app, "installed", Some(&job), None, NOW);
            let end = NOW + TIMEOUT;
            if mode == "offline" {
                app.agents.write().unwrap().remove(&1);
            } else {
                node(&app, 1, 11, &target(), true, false);
                let mut agents = app.agents.write().unwrap();
                let live = &mut agents.get_mut(&1).unwrap().rollout;
                live.record_report(false, end - REPORT_FRESH);
                if mode != "incomplete_once" {
                    live.record_report(false, end);
                }
            }
            let now = end;
            let status = v2(&app, "status", Some(&job), None, now);
            if matches!(mode, "offline" | "incomplete_once") {
                assert_eq!(status["status"], "unconfirmed");
                continue;
            }
            assert_eq!(status["status"], "rollback_pending");
            if mode == "recovered" {
                node(&app, 1, 11, &target(), true, true);
                assert_eq!(v2(&app, "rollback", Some(&job), None, end + 1)["status"], "verified");
                continue;
            }
            if mode == "expired" {
                assert_eq!(
                    v2(&app, "rollback", Some(&job), None, end + ROLLBACK_OFFER)["status"],
                    "unconfirmed"
                );
                continue;
            }
            let permit = v2(&app, "rollback", Some(&job), None, end + 1);
            assert_eq!(permit, json!({"status":"rollback","deadline":end+1+ROLLBACK_WINDOW}));
            assert_eq!(v2(&app, "rollback", Some(&job), None, end + 2), permit);
            if mode == "done" {
                assert_eq!(
                    v2(&app, "failed", Some(&job), Some("rolled_back"), end + 3)["status"],
                    "rolled_back"
                );
                assert_eq!(
                    v2(&app, "failed", Some(&job), Some("rolled_back"), end + 4)["status"],
                    "rolled_back"
                );
            } else {
                assert_eq!(
                    v2(&app, "rollback", Some(&job), None, end + 1 + ROLLBACK_WINDOW)["status"],
                    "unconfirmed"
                );
            }
            assert_eq!(snapshot(&app).0, "stopped");
        }
    }

    #[test]
    fn restore_stops_old_work_removes_stale_heartbeats_and_does_not_reuse_batch_ids() {
        let dir = std::env::temp_dir().join(format!("rollout-{}", crate::auth::random_token()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("live.db");
        let backup = dir.join("backup.db");
        {
            let app = App::for_test(Db::open(path.to_str().unwrap()).unwrap());
            for id in 1..=2 {
                app.db
                    .create_node(
                        &crate::db::Node { name: format!("n{id}"), ..Default::default() },
                        &format!("fixture-{id}"),
                    )
                    .unwrap();
                node(&app, id, id as u64, "1.0.0", true, true);
            }
            let job = begin_v2(&app);
            v2(&app, "apply", Some(&job), None, NOW);
            app.db.backup_into(backup.to_str().unwrap()).unwrap();
            v2(&app, "failed", Some(&job), Some("restart"), NOW + 1);
            create(&app, &[1], &fleet(&app), NOW + 2).unwrap();
            crate::maintenance::observe_http(&app.db, 2).unwrap();
            app.db.check_backup(backup.to_str().unwrap()).unwrap();
            app.db.restore_from(backup.to_str().unwrap()).unwrap();
            let restored = overview(&app).unwrap();
            assert_eq!(restored["workers"], json!({}));
            assert_eq!(restored["batch"]["status"], "stopped");
            assert_eq!(restored["batch"]["items"][0]["status"], "unconfirmed");
            assert_eq!(restored["batch"]["items"][1]["status"], "skipped");
            assert!(restored["batch"]["items"][0]["reason"].as_str().unwrap().contains("恢复"));
            assert_eq!(restored["maintenance"]["1"], "unpaired");
            assert_eq!(restored["maintenance"]["2"], "offline_only");
            app.db
                .conn()
                .execute(
                    "UPDATE node_maintenance SET key_hash=? WHERE node=1",
                    [crate::auth::sha256("fixture-maint-1")],
                )
                .unwrap();
            v2(&app, "poll", None, None, NOW + 2);
            create(&app, &[1], &fleet(&app), NOW + 3).unwrap();
            let next = v2(&app, "poll", None, None, NOW + 3);
            assert_eq!(next["batch"], 3);
            node(&app, 1, 22, &target(), true, true);
            let info = overview(&app).unwrap();
            assert_eq!(info["workers"]["1"], json!({"protocol":2,"last_seen":NOW+3}));
            assert_eq!(info["nodes"]["1"], "current");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
