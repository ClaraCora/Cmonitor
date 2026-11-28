//! Single-use pairing for an existing node. The administrator's ticket and the
//! Agent's original reporting token authorise only a locally generated worker key.
use crate::{agent_ws::bearer, api, auth, App, Shared};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::json;

const LIFETIME: i64 = 600;

pub(crate) fn redeem_path(path: &str) -> bool {
    path.strip_prefix("/api/nodes/")
        .and_then(|p| p.strip_suffix("/maintenance/redeem"))
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
}

fn key(node: i64) -> String {
    format!("maintenance-pair:{node}")
}

pub(crate) fn clear_ticket(conn: &Connection, node: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM setting WHERE key=?", [key(node)])?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct StoredTicket {
    digest: String,
    expires_at: i64,
    server: String,
}

fn origin(value: &str) -> Option<String> {
    let url = api::https_domain(value)?;
    let domain = url.domain()?;
    // This canonical DNS name (plus a possible numeric port) is also a literal
    // argument in the administrator's shell command.
    domain
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-'))
        .then(|| url.origin().ascii_serialization())
}

fn request_origin(app: &App, headers: &HeaderMap) -> Option<String> {
    if crate::forwarded_proto(headers) != Some("https") || !api::provisioning_allowed(app, headers) {
        return None;
    }
    let received = origin(&format!("https://{}", headers.get(header::HOST)?.to_str().ok()?))?;
    if !app.site.is_empty() && origin(&app.site).as_ref() != Some(&received) {
        return None;
    }
    Some(received)
}

fn busy(conn: &Connection, node: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM upgrade_item i JOIN upgrade_batch b ON b.id=i.batch
        WHERE i.node=? AND b.status='running')",
        [node],
        |r| r.get(0),
    )
}

fn db_error(e: rusqlite::Error) -> Response {
    tracing::error!("maintenance pairing database operation failed: {e}");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

fn shell_command(server: &str, node: i64, ticket: &str) -> String {
    let helper_sha = auth::sha256(crate::AGENT_PAIR);
    let installer_sha = auth::sha256(include_str!("../install.sh"));
    format!(
        r#"sh <<'CMONITOR_PAIR_SETUP'
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
[ "$(id -u)" = 0 ] || {{ echo "run as root on the selected node" >&2; exit 1; }}
umask 077
work=$(mktemp -d /tmp/cmonitor-pair.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
curl -q --fail --silent --show-error --proto '=https' --connect-timeout 15 --max-time 90 --output agent-pair.py '{server}/agent-pair.py'
printf '%s  agent-pair.py\n' '{helper_sha}' | sha256sum -c -
if ! python3 -I -c 'import fcntl, ssl, sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
    if [ -f /etc/alpine-release ]; then
        apk add --no-cache python3 || {{ echo "could not install Python 3 from the Alpine repositories; check apk connectivity and retry" >&2; exit 1; }}
    else
        echo "pairing requires Python 3.8 or newer with SSL support" >&2; exit 1
    fi
fi
python3 -I ./agent-pair.py --server '{server}' --node {node} --installer-sha256 '{installer_sha}' <<'CMONITOR_PAIR_TICKET'
{ticket}
CMONITOR_PAIR_TICKET
CMONITOR_PAIR_SETUP"#
    )
}

pub async fn issue(
    _: api::Admin,
    Path(node): Path<i64>,
    State(app): State<Shared>,
    headers: HeaderMap,
) -> Response {
    let Some(server) = request_origin(&app, &headers) else {
        return (StatusCode::FORBIDDEN, "请从原 HTTPS Hub 域名生成配对命令").into_response();
    };
    if !auth::current_session(&headers).is_some_and(|s| crate::terminal::recent_session(&app, &s)) {
        return (StatusCode::FORBIDDEN, "请重新登录后生成配对命令").into_response();
    }
    let result = (|| -> rusqlite::Result<Response> {
        let mut conn = app.db.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let policy = tx
            .query_row(
                "SELECT coalesce(m.offline_only,0), m.key_hash IS NOT NULL FROM node n
             LEFT JOIN node_maintenance m ON m.node=n.id WHERE n.id=?",
                [node],
                |r| Ok((r.get::<_, bool>(0)?, r.get::<_, bool>(1)?)),
            )
            .optional()?;
        match policy {
            None => return Ok((StatusCode::NOT_FOUND, "节点不存在").into_response()),
            Some((true, _)) => return Ok((StatusCode::CONFLICT, "该节点固定为离线维护").into_response()),
            Some((_, true)) => return Ok((StatusCode::CONFLICT, "节点已配对").into_response()),
            _ => {}
        }
        if busy(&tx, node)? {
            return Ok((StatusCode::CONFLICT, "请先结束该节点的升级批次").into_response());
        }
        let ticket = format!("cmp_{}", auth::random_token());
        let expires_at = Utc::now().timestamp() + LIFETIME;
        let stored = StoredTicket { digest: auth::sha256(&ticket), expires_at, server: server.clone() };
        tx.execute(
            "INSERT INTO setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key(node), serde_json::to_string(&stored).expect("serializable ticket")),
        )?;
        tx.commit()?;
        Ok((
            [(header::CACHE_CONTROL, "private, no-store")],
            Json(json!({"command":shell_command(&server,node,&ticket),"expires_at":expires_at})),
        )
            .into_response())
    })();
    result.unwrap_or_else(db_error)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Redeem {
    ticket: String,
    server: String,
    credential_sha256: String,
}

pub(crate) fn hex_digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn consume(
    app: &App,
    node: i64,
    server: &str,
    report: &str,
    body: &Redeem,
    now: i64,
) -> rusqlite::Result<bool> {
    let mut conn = app.db.conn();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let value = tx
        .query_row("SELECT value FROM setting WHERE key=?", [key(node)], |r| r.get::<_, String>(0))
        .optional()?;
    let Some(stored) = value.as_deref().and_then(|s| serde_json::from_str::<StoredTicket>(s).ok()) else {
        return Ok(false);
    };
    if stored.expires_at <= now {
        clear_ticket(&tx, node)?;
        tx.commit()?;
        return Ok(false);
    }
    if stored.expires_at > now + LIFETIME
        || stored.server != server
        || stored.digest != auth::sha256(&body.ticket)
    {
        return Ok(false);
    }
    let original_node = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM node n LEFT JOIN node_maintenance m ON n.id=m.node
        WHERE n.id=? AND n.token=? AND coalesce(m.offline_only,0)=0 AND m.key_hash IS NULL)",
        (node, report),
        |r| r.get::<_, bool>(0),
    )?;
    if !original_node || busy(&tx, node)? {
        return Ok(false);
    }
    // An accidental key reuse across distinct nodes must never authenticate the second node.
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM node_maintenance WHERE key_hash=?)",
        [&body.credential_sha256],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO node_maintenance(node,key_hash) VALUES(?,?)
        ON CONFLICT(node) DO UPDATE SET key_hash=excluded.key_hash",
        (node, &body.credential_sha256),
    )?;
    clear_ticket(&tx, node)?;
    tx.commit()?;
    Ok(true)
}

pub async fn redeem(
    Path(node): Path<i64>,
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Redeem>,
) -> Response {
    let Some(server) = request_origin(&app, &headers) else { return StatusCode::FORBIDDEN.into_response() };
    if origin(&body.server).as_ref() != Some(&server) {
        return (StatusCode::FORBIDDEN, "本机 Agent 的原 Hub 地址不匹配").into_response();
    }
    if !body.ticket.strip_prefix("cmp_").is_some_and(hex_digest) || !hex_digest(&body.credential_sha256) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(report) = bearer(&headers) else { return StatusCode::UNAUTHORIZED.into_response() };
    if body.credential_sha256 == auth::sha256(report) || body.credential_sha256 == auth::sha256(&body.ticket)
    {
        return (StatusCode::BAD_REQUEST, "请使用独立生成的维护凭据").into_response();
    }
    match consume(&app, node, &server, report, &body, Utc::now().timestamp()) {
        Ok(true) => Json(json!({"node":node})).into_response(),
        Ok(false) => (StatusCode::UNAUTHORIZED, "配对未获授权，请确认节点和命令有效期").into_response(),
        Err(e) => db_error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::Db, maintenance, rollout};
    use axum::{middleware, routing::post, Router};
    use serde_json::Value;
    use std::sync::Arc;

    const ORIGIN: &str = "https://hub.example:8443";
    fn admin_headers(app: &App) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "hub.example:8443".parse().unwrap());
        headers.insert(header::ORIGIN, ORIGIN.parse().unwrap());
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        let cookie = auth::issue_session(app, &headers).unwrap();
        let token = cookie.split(';').next().unwrap();
        headers.insert(header::COOKIE, token.parse().unwrap());
        app.db.conn().execute("UPDATE session SET kind='password'", []).unwrap();
        headers
    }
    async fn value(reply: Response) -> Value {
        let bytes = axum::body::to_bytes(reply.into_body(), 16384).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    fn ticket(reply: &Value) -> &str {
        let cmd = reply["command"].as_str().unwrap();
        cmd.lines().find(|line| line.strip_prefix("cmp_").is_some_and(hex_digest)).unwrap()
    }
    async fn issue_test(app: &Shared, node: i64, h: &HeaderMap) -> String {
        let reply = issue(api::Admin, Path(node), State(app.clone()), h.clone()).await;
        assert_eq!(reply.status(), StatusCode::OK);
        ticket(&value(reply).await).into()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn ticket_and_local_identity_are_required_and_racing_claims_have_one_winner() {
        let mut base = App::for_test(Db::open(":memory:").unwrap());
        base.site = ORIGIN.into();
        let app = Arc::new(base);
        let node = app.db.create_node(&Default::default(), "report-one").unwrap();
        let other = app.db.create_node(&Default::default(), "report-two").unwrap();
        let h = admin_headers(&app);
        let router = Router::new()
            .route("/api/nodes/{id}/maintenance/pair-command", post(issue))
            .route("/api/nodes/{id}/maintenance/redeem", post(redeem))
            .route("/api/agent/upgrade", post(rollout::poll))
            .layer(middleware::from_fn_with_state(app.clone(), auth::browser_guard))
            .with_state(app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let issue_url = format!("{base}/api/nodes/{node}/maintenance/pair-command");
        let request = |id| {
            client
                .post(format!("{base}/api/nodes/{id}/maintenance/redeem"))
                .header(header::HOST, "hub.example:8443")
                .header("x-forwarded-proto", "https")
        };
        let mut anonymous = h.clone();
        anonymous.remove(header::COOKIE);
        assert_eq!(
            client.post(&issue_url).headers(anonymous).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let mut cross_origin = h.clone();
        cross_origin.insert(header::ORIGIN, "https://another.example".parse().unwrap());
        assert_eq!(
            client.post(&issue_url).headers(cross_origin).send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let first = issue_test(&app, node, &h).await;
        let reply = client.post(&issue_url).headers(h.clone()).send().await.unwrap();
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "private, no-store");
        let reply: Value = reply.json().await.unwrap();
        assert!((Utc::now().timestamp() + 598..=Utc::now().timestamp() + 600)
            .contains(&reply["expires_at"].as_i64().unwrap()));
        let fresh = ticket(&reply);
        let cmd = reply["command"].as_str().unwrap();
        assert!(!cmd.contains("report-one"));
        assert!(
            cmd.contains(&auth::sha256(crate::AGENT_PAIR))
                && cmd.contains(&auth::sha256(include_str!("../install.sh")))
        );
        assert!(!app.db.get(&key(node)).unwrap().contains(fresh));
        let secret = format!("cmu_{}", "a1".repeat(32));
        let alternate = format!("cmu_{}", "b2".repeat(32));
        let claim = |ticket: &str, secret: &str| json!({"server":ORIGIN,"ticket":ticket,"credential_sha256":auth::sha256(secret)});
        let post = |node, report: &str, body: Value| request(node).bearer_auth(report).json(&body).send();
        for reused in ["report-one", fresh] {
            assert_eq!(
                post(node, "report-one", claim(fresh, reused)).await.unwrap().status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            post(node, "report-one", claim(&first, &secret)).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            post(node, "report-two", claim(fresh, &secret)).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            post(other, "report-two", claim(fresh, &secret)).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let mut mismatch = claim(fresh, &secret);
        mismatch["server"] = json!("https://another.example");
        assert_eq!(post(node, "report-one", mismatch).await.unwrap().status(), StatusCode::FORBIDDEN);
        let mut plain = h.clone();
        plain.insert("x-forwarded-proto", "http".parse().unwrap());
        assert_eq!(
            client.post(&issue_url).headers(plain.clone()).send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .post(format!("{base}/api/nodes/{node}/maintenance/redeem"))
                .headers(plain)
                .bearer_auth("report-one")
                .json(&claim(fresh, &secret))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let (one, two) = tokio::join!(
            post(node, "report-one", claim(fresh, &secret)),
            post(node, "report-one", claim(fresh, &alternate))
        );
        let (one, two) = (one.unwrap(), two.unwrap());
        let (winner, wkey, loser) =
            if one.status() == StatusCode::OK { (one, &secret, two) } else { (two, &alternate, one) };
        assert_eq!(winner.json::<Value>().await.unwrap(), json!({"node":node}));
        assert_eq!(loser.status(), StatusCode::UNAUTHORIZED);
        assert!(app.db.get(&key(node)).is_none());
        assert_eq!(
            post(node, "report-one", claim(fresh, wkey)).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let identity = client
            .post(format!("{base}/api/agent/upgrade"))
            .header(header::HOST, "hub.example:8443")
            .header("x-forwarded-proto", "https")
            .bearer_auth(wkey)
            .json(&json!({"action":"identity","protocol":2}))
            .send()
            .await
            .unwrap();
        assert_eq!(identity.json::<Value>().await.unwrap(), json!({"node":node}));
        assert_eq!(
            app.db
                .conn()
                .query_row("SELECT count(*) FROM upgrade_worker", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(client.post(issue_url).headers(h).send().await.unwrap().status(), StatusCode::CONFLICT);
        task.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn expired_and_invalidated_tickets_cannot_be_redeemed_after_state_changes() {
        let dir = std::env::temp_dir().join(format!("cmonitor-pairing-{}", auth::random_token()));
        std::fs::create_dir(&dir).unwrap();
        let app = Arc::new(App::for_test(Db::open(dir.join("hub.db").to_str().unwrap()).unwrap()));
        let node = app.db.create_node(&Default::default(), "original-report").unwrap();
        let h = admin_headers(&app);
        let admin_issue = || issue(api::Admin, Path(node), State(app.clone()), h.clone());
        let old = issue_test(&app, node, &h).await;
        let input = Redeem { ticket: old, server: ORIGIN.into(), credential_sha256: "ab".repeat(32) };
        assert!(!consume(&app, node, ORIGIN, "original-report", &input, Utc::now().timestamp() + LIFETIME)
            .unwrap());
        assert!(app.db.get(&key(node)).is_none());
        issue_test(&app, node, &h).await;
        app.db.reset_token(node, "new-report").unwrap();
        assert!(app.db.get(&key(node)).is_none());
        for action in ["grant", "revoke"] {
            issue_test(&app, node, &h).await;
            let change = serde_json::from_value(json!({"action":action})).unwrap();
            assert_eq!(
                maintenance::policy(api::Admin, Path(node), State(app.clone()), h.clone(), Json(change))
                    .await
                    .status(),
                StatusCode::OK
            );
            assert!(app.db.get(&key(node)).is_none());
            if action == "grant" {
                let change = serde_json::from_value(json!({"action":"revoke"})).unwrap();
                maintenance::policy(api::Admin, Path(node), State(app.clone()), h.clone(), Json(change))
                    .await;
            }
        }
        let pending = issue_test(&app, node, &h).await;
        app.db
            .conn()
            .execute("INSERT INTO upgrade_batch(epoch,target,created) VALUES('test','1',0)", [])
            .unwrap();
        app.db.conn().execute("INSERT INTO upgrade_item(batch,pos,node) VALUES(1,0,?)", [node]).unwrap();
        assert_eq!(admin_issue().await.status(), StatusCode::CONFLICT);
        let input = Redeem { ticket: pending, server: ORIGIN.into(), credential_sha256: "ab".repeat(32) };
        assert!(!consume(&app, node, ORIGIN, "new-report", &input, Utc::now().timestamp()).unwrap());
        app.db.conn().execute("UPDATE upgrade_batch SET status='failed'", []).unwrap();
        let backup = dir.join("backup.db");
        app.db.backup_into(backup.to_str().unwrap()).unwrap();
        app.db.restore_from(backup.to_str().unwrap()).unwrap();
        assert!(app.db.get(&key(node)).is_none());
        let h = admin_headers(&app);
        issue_test(&app, node, &h).await;
        maintenance::observe_http(&app.db, node).unwrap();
        assert!(app.db.get(&key(node)).is_none());
        assert_eq!(
            issue(api::Admin, Path(node), State(app.clone()), h.clone()).await.status(),
            StatusCode::CONFLICT
        );
        let another = app.db.create_node(&Default::default(), "another-report").unwrap();
        issue_test(&app, another, &h).await;
        app.db.delete_node(another).unwrap();
        assert!(app.db.get(&key(another)).is_none());
        app.db.conn().execute("UPDATE session SET expires_at=expires_at-601", []).unwrap();
        assert_eq!(
            issue(api::Admin, Path(node), State(app.clone()), h).await.status(),
            StatusCode::FORBIDDEN
        );
        drop(app);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
