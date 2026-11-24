//! Browser terminals backed by the shell running on a monitor agent.
//!
//! The hub only authenticates the operator and relays JSON-RPC frames. It never
//! receives an SSH credential and never starts a command on the hub host.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tracing::{info, warn};

use crate::auth::{authed, current_session, random_token};
use crate::db::Db;
use crate::{App, Shared};

const TERMINAL_IDLE_CHECK: Duration = Duration::from_secs(5);
const TERMINAL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TERMINAL_ID: usize = 128;
// JSON escaping can expand one byte to six; stay inside the agent's 64 KiB
// WebSocket frame limit even for a chunk made entirely of control bytes.
const MAX_INPUT: usize = 8 * 1024;
const MAX_COLS: u32 = 500;
const MAX_ROWS: u32 = 200;

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Entry>>);

struct Entry {
    node_id: i64,
    agent_session: u64,
    admin_session: String,
    cancel: watch::Sender<bool>,
    browser: mpsc::Sender<String>,
}

impl Registry {
    fn insert(
        &self,
        id: String,
        node_id: i64,
        agent_session: u64,
        admin_session: String,
        browser: mpsc::Sender<String>,
    ) -> Option<watch::Receiver<bool>> {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= 32 || entries.values().filter(|e| e.node_id == node_id).count() >= 4 {
            return None;
        }
        let (cancel, rx) = watch::channel(false);
        entries.insert(id, Entry { node_id, agent_session, admin_session, cancel, browser });
        Some(rx)
    }

    pub fn revoke_invalid(&self, db: &Db) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, entry| db.session_valid(&entry.admin_session));
    }

    pub fn disconnect_all(&self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    fn remove(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    fn route(&self, id: &str, node_id: i64, agent_session: u64, message: &str) -> bool {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = entries.get(id) else { return false };
        if entry.node_id != node_id
            || entry.agent_session != agent_session
            || entry.browser.try_send(message.to_owned()).is_ok()
        {
            return false;
        }
        // A terminal that stops reading must not retain an agent process or a
        // growing output buffer indefinitely.
        entries.remove(id);
        true
    }

    pub fn disconnect_node(&self, node_id: i64) {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        entries.retain(|id, entry| {
            if entry.node_id != node_id {
                return true;
            }
            let message = rpc("terminal.error", json!({"terminal_id": id, "message": "节点连接已断开"}));
            let _ = entry.browser.try_send(message);
            false
        });
    }
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
    }
}

struct Lease {
    app: Shared,
    id: String,
    agent: mpsc::Sender<String>,
    cancel_agent: watch::Sender<bool>,
    actor: String,
    node_id: i64,
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.app.terminals.remove(&self.id);
        if let Err(e) = self.app.db.terminal_audit(&self.actor, self.node_id, "closed", &self.id[..16]) {
            warn!("terminal close audit failed: {e}");
        }
        if self.agent.try_send(rpc("terminal.close", json!({"terminal_id": self.id}))).is_err() {
            // A full queue cannot prevent root-shell cleanup. Reconnect the node.
            self.cancel_agent.send_replace(true);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Connect {
        node_id: i64,
        #[serde(default = "default_cols")]
        cols: u32,
        #[serde(default = "default_rows")]
        rows: u32,
    },
    Input {
        data: String,
    },
    Resize {
        cols: u32,
        rows: u32,
    },
}

fn default_cols() -> u32 {
    120
}
fn default_rows() -> u32 {
    32
}

pub(crate) fn recent_session(app: &App, hash: &str) -> bool {
    app.db
        .session_identity(hash)
        .is_some_and(|s| matches!(s.kind.as_str(), "github" | "password") && recently_issued(s.issued_at))
}

fn recently_issued(issued_at: i64) -> bool {
    (0..=600).contains(&(Utc::now().timestamp() - issued_at))
}

fn may_open_terminal(app: &App, hash: &str) -> bool {
    app.db.session_identity(hash).is_some_and(|s| match s.kind.as_str() {
        "github" => true,
        "password" => recently_issued(s.issued_at),
        _ => false,
    })
}
pub async fn access(_: crate::api::Admin, State(app): State<Shared>, headers: HeaderMap) -> Json<Value> {
    let allowed = current_session(&headers).is_some_and(|h| may_open_terminal(&app, &h));
    let config = app.db.auth_config(&app.site).ok();
    Json(
        json!({"allowed": allowed, "github": config.as_ref().is_some_and(|c| c.github_ready()), "password_login": config.as_ref().is_some_and(|c| c.password_enabled)}),
    )
}
#[derive(Deserialize)]
pub struct TerminalPolicy {
    enabled: bool,
}
pub async fn policy(
    _: crate::api::Admin,
    State(app): State<Shared>,
    Path(node): Path<i64>,
    headers: HeaderMap,
    Json(policy): Json<TerminalPolicy>,
) -> Response {
    if !app.db.node(node).ok().flatten().is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    if policy.enabled && crate::maintenance::offline(&app.db.conn(), node).unwrap_or(true) {
        return (StatusCode::CONFLICT, "该节点固定为离线维护").into_response();
    }
    let actor = current_session(&headers)
        .and_then(|h| app.db.session_identity(&h))
        .map(|s| s.actor())
        .unwrap_or_default();
    if let Err(e) = app.db.set(&format!("terminal_node_{node}"), if policy.enabled { "on" } else { "off" }) {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }
    if !policy.enabled {
        app.terminals.disconnect_node(node);
    }
    if let Err(e) = app.db.terminal_audit(
        &actor,
        node,
        if policy.enabled { "enabled" } else { "disabled" },
        &random_token()[..16],
    ) {
        warn!("terminal policy audit failed: {e}");
    }
    Json(json!({"ok":true})).into_response()
}
pub async fn history(_: crate::api::Admin, State(app): State<Shared>) -> Response {
    match app.db.terminal_history() {
        Ok(items) => Json(json!({"items":items})).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub async fn handler(State(app): State<Shared>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    if !crate::auth::same_origin(&app, &headers, true) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !authed(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(session) = current_session(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !may_open_terminal(&app, &session) {
        return (StatusCode::FORBIDDEN, "请重新登录后打开终端").into_response();
    }
    info!("browser terminal websocket accepted");
    upgrade
        .read_buffer_size(crate::api::SOCKET_BUFFER)
        .max_message_size(crate::api::MAX_FRAME)
        .max_frame_size(crate::api::MAX_FRAME)
        .on_upgrade(move |socket| run(app, socket, session))
}

async fn run(app: Shared, mut socket: WebSocket, session: String) {
    let Ok(Some(Ok(Message::Text(first)))) = tokio::time::timeout(TERMINAL_OPEN_TIMEOUT, socket.recv()).await
    else {
        return;
    };
    if !authed_hash(&app, &session) {
        return;
    }
    let Ok(ClientMessage::Connect { node_id, cols, rows }) = serde_json::from_str(first.as_str()) else {
        send_error(&mut socket, "终端必须先选择一个节点").await;
        return;
    };
    if !valid_size(cols, rows) {
        send_error(&mut socket, "终端窗口大小无效").await;
        return;
    }
    if !may_open_terminal(&app, &session) {
        send_error(&mut socket, "请重新登录后打开终端").await;
        return;
    }
    if crate::maintenance::offline(&app.db.conn(), node_id).unwrap_or(true) {
        send_error(&mut socket, "该节点固定为离线维护").await;
        return;
    }
    if app.db.get(&format!("terminal_node_{node_id}")).as_deref() == Some("off") {
        send_error(&mut socket, "管理员已禁用该节点终端").await;
        return;
    }
    let agent_disabled = app
        .agents
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&node_id)
        .is_some_and(|a| !a.terminal_enabled);
    if agent_disabled {
        send_error(&mut socket, "Agent 已在本机禁用终端").await;
        return;
    }
    info!("opening terminal on node {node_id}");

    let connection = app
        .agents
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(&node_id)
        .map(|a| (a.tx.clone(), a.session, a.cancel.clone(), a.cancel.subscribe()));
    let Some((agent, agent_session, cancel_agent, mut agent_cancelled)) = connection else {
        send_error(&mut socket, "节点当前不在线").await;
        return;
    };
    let terminal_id = random_token();
    let actor = app.db.session_identity(&session).map(|s| s.actor()).unwrap_or_default();
    if app.db.terminal_audit(&actor, node_id, "open_requested", &terminal_id[..16]).is_err() {
        send_error(&mut socket, "无法写入终端审计，请检查数据库").await;
        return;
    }
    let (browser_tx, mut browser_rx) = mpsc::channel(128);
    let Some(mut cancelled) =
        app.terminals.insert(terminal_id.clone(), node_id, agent_session, session.clone(), browser_tx)
    else {
        send_error(&mut socket, "终端数量已达上限：每节点 4 个，Hub 共 32 个").await;
        return;
    };
    let lease = Lease { app: app.clone(), id: terminal_id.clone(), agent, cancel_agent, actor, node_id };
    if *agent_cancelled.borrow() || !terminal_session_allowed(&app, &session, node_id) {
        return;
    }
    let open = rpc("terminal.open", json!({"terminal_id": terminal_id, "cols": cols, "rows": rows}));
    if lease.agent.try_send(open).is_err() {
        send_error(&mut socket, "节点连接繁忙，请稍后重试").await;
        return;
    }

    let mut check = tokio::time::interval(TERMINAL_IDLE_CHECK);
    let open_timeout = tokio::time::sleep(TERMINAL_OPEN_TIMEOUT);
    tokio::pin!(open_timeout);
    let mut ready = false;
    loop {
        tokio::select! {
            biased;
            _ = agent_cancelled.changed() => break,
            _ = cancelled.changed() => break,
            _ = check.tick() => {
                if !terminal_session_allowed(&app, &session, node_id) { break }
            }
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if !terminal_session_allowed(&app, &session, node_id) { break }
                    if let Some(message) = to_agent(&terminal_id, &text) {
                        if lease.agent.try_send(message).is_err() { break }
                    }
                }
                Some(Ok(Message::Binary(data))) if data.len() <= MAX_INPUT => {
                    if !terminal_session_allowed(&app, &session, node_id) { break }
                    if lease.agent.try_send(rpc("terminal.input", json!({"terminal_id": terminal_id, "data": String::from_utf8_lossy(&data)}))).is_err() { break }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(Message::Ping(data))) => { if !send(&mut socket, Message::Pong(data)).await { break } }
                Some(Ok(Message::Pong(_))) => {}
                Some(Err(_)) => break,
                _ => {}
            },
            message = browser_rx.recv() => match message {
                Some(message) => {
                    if !terminal_session_allowed(&app, &session, node_id) { break }
                    let terminal_event = event_type(&message);
                    if terminal_event.as_deref() == Some("terminal.ready") {
                        ready = true;
                        let _ = app.db.terminal_audit(&lease.actor,node_id,"ready",&terminal_id[..16]);
                        info!("terminal on node {node_id} is ready");
                    }
                    if !send(&mut socket, Message::Text(message.into())).await { break }
                    if terminal_event.as_deref() == Some("terminal.error") { let _ = app.db.terminal_audit(&lease.actor,node_id,"agent_error",&terminal_id[..16]); }
                    if matches!(terminal_event.as_deref(), Some("terminal.exit" | "terminal.error")) {
                        break;
                    }
                }
                None => break,
            },
            _ = &mut open_timeout, if !ready => {
                warn!("terminal on node {node_id} did not answer within {}s", TERMINAL_OPEN_TIMEOUT.as_secs());
                send_error(&mut socket, "Cagent 未响应终端请求，请检查 Agent 与 Hub 的 WebSocket 连接").await;
                break;
            }
        }
    }

    drop(lease);
}

fn authed_hash(app: &App, session: &str) -> bool {
    app.db.session_valid(session)
}

fn terminal_session_allowed(app: &App, session: &str, node: i64) -> bool {
    authed_hash(app, session) && !crate::maintenance::offline(&app.db.conn(), node).unwrap_or(true)
}

fn valid_size(cols: u32, rows: u32) -> bool {
    (1..=MAX_COLS).contains(&cols) && (1..=MAX_ROWS).contains(&rows)
}

fn to_agent(terminal_id: &str, text: &str) -> Option<String> {
    let message: ClientMessage = serde_json::from_str(text).ok()?;
    match message {
        ClientMessage::Input { data } if data.len() <= MAX_INPUT => {
            Some(rpc("terminal.input", json!({"terminal_id": terminal_id, "data": data})))
        }
        ClientMessage::Resize { cols, rows } if valid_size(cols, rows) => {
            Some(rpc("terminal.resize", json!({"terminal_id": terminal_id, "cols": cols, "rows": rows})))
        }
        ClientMessage::Connect { .. } | ClientMessage::Input { .. } | ClientMessage::Resize { .. } => None,
    }
}

fn rpc(method: &str, params: Value) -> String {
    json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string()
}

fn event_type(message: &str) -> Option<String> {
    serde_json::from_str::<Value>(message).ok()?.get("method").and_then(Value::as_str).map(str::to_owned)
}

async fn send_error(socket: &mut WebSocket, message: &str) {
    let _ =
        send(socket, Message::Text(json!({"type": "error", "message": message}).to_string().into())).await;
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(tokio::time::timeout(Duration::from_secs(5), socket.send(message)).await, Ok(Ok(())))
}

/// Routes an agent's terminal notification to the browser that opened it.
pub fn from_agent(app: &App, node_id: i64, agent_session: u64, params: &Value, text: &str) {
    let Some(id) = params.get("terminal_id").and_then(Value::as_str) else {
        return;
    };
    if id.len() > MAX_TERMINAL_ID {
        return;
    }
    if app.terminals.route(id, node_id, agent_session, text) {
        if let Some(agent) = app.agents.read().unwrap_or_else(|e| e.into_inner()).get(&node_id) {
            let _ = agent.tx.try_send(rpc("terminal.close", json!({"terminal_id": id})));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn revoked_logins_and_replaced_agents_cannot_keep_a_terminal() {
        let db = Db::open(":memory:").unwrap();
        db.create_session("session", i64::MAX).unwrap();
        let registry = Registry::default();
        let (tx, mut rx) = mpsc::channel(1);
        let mut cancelled = registry.insert("terminal".into(), 1, 7, "session".into(), tx).unwrap();
        registry.route("terminal", 1, 6, "old agent");
        registry.route("terminal", 2, 7, "other node");
        assert!(rx.try_recv().is_err());
        registry.route("terminal", 1, 7, "current agent");
        assert_eq!(rx.recv().await.as_deref(), Some("current agent"));
        db.drop_session("session").unwrap();
        registry.revoke_invalid(&db);
        cancelled.changed().await.unwrap();
        assert!(*cancelled.borrow());
        let agent = crate::agent_ws::Agent::new(7, mpsc::channel(1).0);
        let cloned_sender = agent.tx.clone();
        let mut revoked = agent.cancel.subscribe();
        drop(agent);
        revoked.changed().await.unwrap();
        assert!(*revoked.borrow(), "a terminal's cloned sender must not prevent revocation");
        drop(cloned_sender);
    }

    #[test]
    fn an_open_terminal_checks_the_persistent_node_policy() {
        let app = App::for_test(Db::open(":memory:").unwrap());
        app.db.create_session("live", i64::MAX).unwrap();
        let node = app.db.create_node(&Default::default(), "report").unwrap();
        assert!(terminal_session_allowed(&app, "live", node));
        crate::maintenance::observe_http(&app.db, node).unwrap();
        assert!(!terminal_session_allowed(&app, "live", node));
    }
    #[test]
    fn browser_terminal_messages_are_bounded_and_bound_to_the_server_id() {
        assert!(to_agent("server-id", r#"{"type":"input","data":"echo ok\r"}"#)
            .is_some_and(|frame| frame.contains(r#""terminal_id":"server-id""#)));
        assert!(to_agent("server-id", r#"{"type":"resize","cols":120,"rows":32}"#).is_some());
        assert!(to_agent("server-id", r#"{"type":"resize","cols":0,"rows":32}"#).is_none());
        assert!(to_agent("server-id", r#"{"type":"connect","node_id":1}"#).is_none());
    }
    #[test]
    fn terminal_and_maintenance_use_distinct_login_windows() {
        let app = App::for_test(Db::open(":memory:").unwrap());
        app.db.set("admin_password_hash", "hash").unwrap();
        let now = Utc::now().timestamp();
        app.db.create_session("legacy", crate::auth::session_expiry()).unwrap();
        assert!(!recent_session(&app, "legacy"));
        assert!(!may_open_terminal(&app, "legacy"));
        app.db.password_session("fresh", crate::auth::session_expiry(), "hash").unwrap();
        assert!(recent_session(&app, "fresh"));
        assert!(may_open_terminal(&app, "fresh"));
        app.db.password_session("old", crate::auth::session_expiry() - 601, "hash").unwrap();
        assert!(!recent_session(&app, "old"));
        assert!(!may_open_terminal(&app, "old"));
        app.db
            .conn()
            .execute("UPDATE session SET kind='github', identity='operator' WHERE token_hash='old'", [])
            .unwrap();
        assert!(may_open_terminal(&app, "old"));
        assert!(
            !recent_session(&app, "old"),
            "issuing maintenance credentials still requires recent authentication"
        );
        app.db.conn().execute("UPDATE session SET expires_at=? WHERE token_hash='old'", [now - 1]).unwrap();
        assert!(!may_open_terminal(&app, "old"));
        app.db.terminal_audit("password:local", 7, "ready", "public-correlation").unwrap();
        assert_eq!(app.db.terminal_history().unwrap()[0]["node_id"], 7);
    }
}
