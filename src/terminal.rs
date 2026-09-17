//! Browser terminals backed by the shell running on a monitor agent.
//!
//! The hub only authenticates the operator and relays JSON-RPC frames. It never
//! receives an SSH credential and never starts a command on the hub host.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tracing::debug;

use crate::auth::{authed, current_session, random_token};
use crate::{App, Shared};

const TERMINAL_IDLE_CHECK: Duration = Duration::from_secs(5);
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
    browser: mpsc::Sender<String>,
}

impl Registry {
    fn insert(&self, id: String, node_id: i64, browser: mpsc::Sender<String>) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Entry { node_id, browser });
    }

    fn remove(&self, id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    }

    fn route(&self, id: &str, node_id: i64, message: &str) -> bool {
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = entries.get(id) else { return false };
        if entry.node_id != node_id || entry.browser.try_send(message.to_owned()).is_ok() {
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

pub async fn handler(State(app): State<Shared>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    if !authed(&app, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(session) = current_session(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    upgrade
        .read_buffer_size(crate::api::SOCKET_BUFFER)
        .max_message_size(crate::api::MAX_FRAME)
        .on_upgrade(move |socket| run(app, socket, session))
}

async fn run(app: Shared, mut socket: WebSocket, session: String) {
    let Some(Ok(Message::Text(first))) = socket.next().await else { return };
    let Ok(ClientMessage::Connect { node_id, cols, rows }) = serde_json::from_str(first.as_str()) else {
        send_error(&mut socket, "终端必须先选择一个节点").await;
        return;
    };
    if !valid_size(cols, rows) {
        send_error(&mut socket, "终端窗口大小无效").await;
        return;
    }

    let agent = app.agents.read().unwrap_or_else(|e| e.into_inner()).get(&node_id).map(|a| a.tx.clone());
    let Some(agent) = agent else {
        send_error(&mut socket, "节点当前不在线").await;
        return;
    };

    let terminal_id = random_token();
    let (browser_tx, mut browser_rx) = mpsc::channel(128);
    app.terminals.insert(terminal_id.clone(), node_id, browser_tx);
    let open = rpc("terminal.open", json!({"terminal_id": terminal_id, "cols": cols, "rows": rows}));
    if agent.send(open).await.is_err() {
        app.terminals.remove(&terminal_id);
        send_error(&mut socket, "节点连接已断开").await;
        return;
    }

    let mut check = tokio::time::interval(TERMINAL_IDLE_CHECK);
    let result = loop {
        tokio::select! {
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if !authed_hash(&app, &session) { break Ok(()) }
                    if let Some(message) = to_agent(&terminal_id, &text) {
                        if agent.send(message).await.is_err() { break Ok(()) }
                    }
                }
                Some(Ok(Message::Binary(data))) if data.len() <= MAX_INPUT => {
                    if agent.send(rpc("terminal.input", json!({"terminal_id": terminal_id, "data": String::from_utf8_lossy(&data)}))).await.is_err() { break Ok(()) }
                }
                Some(Ok(Message::Close(_))) | None => break Ok(()),
                Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break Ok(()) } }
                Some(Ok(Message::Pong(_))) => {}
                Some(Err(_)) => break Ok(()),
                _ => {}
            },
            message = browser_rx.recv() => match message {
                Some(message) => {
                    let terminal_event = event_type(&message);
                    if socket.send(Message::Text(message.into())).await.is_err() { break Ok(()) }
                    if matches!(terminal_event, Some("terminal.exit" | "terminal.error")) { break Ok(()) }
                }
                None => break Ok(()),
            }
            _ = check.tick() => {
                if !authed_hash(&app, &session) { break Ok(()) }
            }
        }
    };

    app.terminals.remove(&terminal_id);
    let _ = agent.send(rpc("terminal.close", json!({"terminal_id": terminal_id}))).await;
    if let Err(error) = result {
        debug!("terminal session ended: {error}");
    }
}

fn authed_hash(app: &App, session: &str) -> bool {
    app.db.session_valid(session)
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

fn event_type(message: &str) -> Option<&str> {
    serde_json::from_str::<Value>(message).ok()?.get("method").and_then(Value::as_str)
}

async fn send_error(socket: &mut WebSocket, message: &str) {
    let _ = socket.send(Message::Text(json!({"type": "error", "message": message}).to_string().into())).await;
}

/// Routes an agent's terminal notification to the browser that opened it.
pub fn from_agent(app: &App, node_id: i64, text: &str) {
    let Ok(frame) = serde_json::from_str::<Value>(text) else { return };
    let Some(id) = frame.get("params").and_then(|p| p.get("terminal_id")).and_then(Value::as_str) else {
        return;
    };
    if id.len() > MAX_TERMINAL_ID {
        return;
    }
    if app.terminals.route(id, node_id, text) {
        if let Some(agent) = app.agents.read().unwrap_or_else(|e| e.into_inner()).get(&node_id) {
            let _ = agent.tx.try_send(rpc("terminal.close", json!({"terminal_id": id})));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_terminal_messages_are_bounded_and_bound_to_the_server_id() {
        assert!(to_agent("server-id", r#"{"type":"input","data":"echo ok\r"}"#)
            .is_some_and(|frame| frame.contains(r#""terminal_id":"server-id""#)));
        assert!(to_agent("server-id", r#"{"type":"resize","cols":120,"rows":32}"#).is_some());
        assert!(to_agent("server-id", r#"{"type":"resize","cols":0,"rows":32}"#).is_none());
        assert!(to_agent("server-id", r#"{"type":"connect","node_id":1}"#).is_none());
    }
}
