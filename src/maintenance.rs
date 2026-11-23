//! A reporting token cannot enrol, impersonate or authorise an upgrade worker.
use crate::{api::Admin, auth, db::Db, Shared};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::json;

pub fn offline(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM node_maintenance WHERE node=? AND offline_only=1)",
        [id],
        |r| r.get(0),
    )
}

pub fn revoke(tx: &Transaction, node: i64, offline_only: bool) -> rusqlite::Result<()> {
    crate::pairing::clear_ticket(tx, node)?;
    if offline_only {
        tx.execute(
            "INSERT INTO node_maintenance(node,offline_only) SELECT id,1 FROM node WHERE id=?
            ON CONFLICT(node) DO UPDATE SET offline_only=1,key_hash=NULL",
            [node],
        )?;
    } else {
        tx.execute("UPDATE node_maintenance SET key_hash=NULL WHERE node=?", [node])?;
    }
    tx.execute("DELETE FROM upgrade_worker WHERE node=?", [node])?;
    // A previously issued apply permission cannot be recalled. Its result must
    // be reviewed, and should never release the remaining nodes in the batch.
    crate::rollout::revoke_node(tx, node)
}

pub fn observe_http(db: &Db, node: i64) -> rusqlite::Result<()> {
    let mut conn = db.conn();
    let tx = conn.transaction()?;
    if !offline(&tx, node)? {
        revoke(&tx, node, true)?;
    }
    tx.commit()
}

#[derive(Copy, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Action {
    Grant,
    Revoke,
    Offline,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    action: Action,
}

pub fn server(app: &crate::App, headers: &HeaderMap) -> String {
    if app.site.is_empty() {
        format!("https://{}", headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default())
    } else {
        app.site.clone()
    }
}

pub fn grant_file(server: &str, node: i64, report: &str, credential: &str) -> serde_json::Value {
    json!({"format":1,"node":node,"server":server.trim_end_matches('/'),"report_identity":auth::sha256(report),"credential":credential})
}

enum Decision {
    Issued(serde_json::Value),
    Updated,
    Refused(StatusCode, &'static str),
}

/// Both local root and recent web administrators use the same transaction and checks.
fn change_node(tx: &Transaction, node: i64, action: Action, server: &str) -> rusqlite::Result<Decision> {
    let Some(report) =
        tx.query_row("SELECT token FROM node WHERE id=?", [node], |r| r.get::<_, String>(0)).optional()?
    else {
        return Ok(Decision::Refused(StatusCode::NOT_FOUND, "节点不存在"));
    };
    if action != Action::Grant {
        revoke(tx, node, action == Action::Offline)?;
        return Ok(Decision::Updated);
    }
    if offline(tx, node)? {
        return Ok(Decision::Refused(StatusCode::CONFLICT, "该节点固定为离线维护"));
    }
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM upgrade_item i JOIN upgrade_batch b ON b.id=i.batch
         WHERE i.node=? AND b.status='running')",
        [node],
        |r| r.get::<_, bool>(0),
    )? {
        return Ok(Decision::Refused(StatusCode::CONFLICT, "请先结束该节点的升级批次"));
    }
    let credential = format!("cmu_{}", auth::random_token());
    crate::pairing::clear_ticket(tx, node)?;
    tx.execute("INSERT INTO node_maintenance(node,key_hash) VALUES(?,?) ON CONFLICT(node) DO UPDATE SET key_hash=excluded.key_hash", (node,auth::sha256(&credential)))?;
    tx.execute("DELETE FROM upgrade_worker WHERE node=?", [node])?;
    Ok(Decision::Issued(grant_file(server, node, &report, &credential)))
}

pub async fn policy(
    _: Admin,
    Path(node): Path<i64>,
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(change): Json<Change>,
) -> Response {
    if crate::forwarded_proto(&headers) != Some("https") || !crate::api::provisioning_allowed(&app, &headers)
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !auth::current_session(&headers).is_some_and(|hash| crate::terminal::recent_session(&app, &hash)) {
        return (StatusCode::FORBIDDEN, "请重新登录后设置维护授权").into_response();
    }
    let outcome = (|| -> rusqlite::Result<Response> {
        let mut conn = app.db.conn();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let reply = match change_node(&tx, node, change.action, &server(&app, &headers))? {
            Decision::Refused(status, message) => return Ok((status, message).into_response()),
            Decision::Updated => Json(json!({"ok":true})).into_response(),
            Decision::Issued(file) => ([(header::CACHE_CONTROL, "no-store")], Json(file)).into_response(),
        };
        tx.commit()?;
        Ok(reply)
    })();
    if matches!(change.action, Action::Offline) && outcome.as_ref().is_ok_and(|r| r.status().is_success()) {
        app.terminals.disconnect_node(node);
    }
    outcome.unwrap_or_else(|e| {
        tracing::error!("node maintenance policy: {e}");
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    })
}

/// Read the effective UID from Linux's own process record; never trust `USER` or `SUDO_UID`.
pub fn local_root(
    database: &str,
    action: Action,
    node: i64,
    site: &str,
    output: Option<&std::path::Path>,
) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        let status = std::fs::read_to_string("/proc/self/status").ok();
        let root = status
            .as_deref()
            .and_then(|s| s.lines().find_map(|line| line.strip_prefix("Uid:")))
            .and_then(|uids| uids.split_whitespace().nth(1))
            == Some("0");
        anyhow::ensure!(root, "maintenance commands require Linux root on the Hub host");
        local_change(database, action, node, site, output, 0)
    }
    #[cfg(not(unix))]
    {
        let _ = (database, action, node, site, output);
        anyhow::bail!("maintenance commands require Linux root on the Hub host")
    }
}

/// Resolve the output directory once. A private leaf in a trusted or sticky
/// parent is safe to use by name, including a private directory created in /tmp.
#[cfg(unix)]
fn private_output(path: &std::path::Path, uid: u32) -> anyhow::Result<std::path::PathBuf> {
    use std::os::unix::fs::MetadataExt;
    anyhow::ensure!(path.is_absolute(), "maintenance output requires an absolute file path");
    let name = path.file_name().ok_or_else(|| anyhow::anyhow!("missing maintenance file name"))?;
    let parent = path.parent().ok_or_else(|| anyhow::anyhow!("missing output directory"))?.canonicalize()?;
    let leaf = parent.metadata()?;
    anyhow::ensure!(
        leaf.is_dir() && leaf.uid() == uid && leaf.mode() & 0o077 == 0,
        "maintenance output directory must be owner-only (0700)"
    );
    for dir in parent.ancestors() {
        let m = dir.metadata()?;
        anyhow::ensure!(
            (m.uid() == 0 || m.uid() == uid) && (m.mode() & 0o022 == 0 || m.mode() & 0o1000 != 0),
            "maintenance output directory has an untrusted parent"
        );
    }
    Ok(parent.join(name))
}

#[cfg(unix)]
fn local_change(
    database: &str,
    action: Action,
    node: i64,
    site: &str,
    output: Option<&std::path::Path>,
    uid: u32,
) -> anyhow::Result<()> {
    use std::{
        fs::{self, OpenOptions, Permissions},
        io::Write,
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };
    anyhow::ensure!(node > 0, "expected a positive node ID");
    let output = match (action, output) {
        (Action::Grant, Some(path)) => {
            anyhow::ensure!(crate::api::https_domain(site).is_some(), "expected an HTTPS Hub domain");
            Some(private_output(path, uid)?)
        }
        (Action::Offline | Action::Revoke, None) => None,
        _ => anyhow::bail!("only a grant requires an output file"),
    };
    anyhow::ensure!(
        std::path::Path::new(database).is_absolute() && std::path::Path::new(database).is_file(),
        "expected an existing Hub database at an absolute path"
    );
    let mut conn = Connection::open_with_flags(database, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF")?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let version = tx.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?;
    anyhow::ensure!(version == crate::db::SCHEMA_VERSION, "run the matching Hub database migration first");
    match change_node(&tx, node, action, site)? {
        Decision::Refused(_, why) => anyhow::bail!(why),
        Decision::Updated => tx.commit()?,
        Decision::Issued(grant) => {
            let output = output.expect("grant output already checked");
            let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&output)?;
            // No existing file can be overwritten. If any later operation fails,
            // this transaction preserves the previous node key.
            let result = (|| -> anyhow::Result<()> {
                file.set_permissions(Permissions::from_mode(0o600))?;
                serde_json::to_writer(&mut file, &grant)?;
                file.write_all(b"\n")?;
                file.sync_all()?;
                fs::File::open(output.parent().expect("absolute file path"))?.sync_all()?;
                tx.commit()?;
                Ok(())
            })();
            if result.is_err() {
                fs::remove_file(&output)?;
            }
            result?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{api, rollout, App};
    use axum::extract::ConnectInfo;
    use serde_json::Value;
    use std::sync::Arc;

    fn headers() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "hub.example".parse().unwrap());
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        h
    }
    async fn body(resp: Response) -> String {
        String::from_utf8(axum::body::to_bytes(resp.into_body(), 8192).await.unwrap().to_vec()).unwrap()
    }
    fn login(app: &App, h: &mut HeaderMap) {
        let cookie = auth::issue_session(app, h).unwrap();
        let session = cookie.split(';').next().unwrap();
        app.db
            .conn()
            .execute(
                "UPDATE session SET kind='password' WHERE token_hash=?",
                [auth::sha256(session.split_once('=').unwrap().1)],
            )
            .unwrap();
        h.insert(header::COOKIE, session.parse().unwrap());
    }
    async fn worker_status(app: &Shared, key: &str) -> StatusCode {
        let mut h = headers();
        h.insert(header::AUTHORIZATION, format!("Bearer {key}").parse().unwrap());
        rollout::poll(
            State(app.clone()),
            h,
            Json(serde_json::from_value(json!({"action":"poll","protocol":2})).unwrap()),
        )
        .await
        .status()
    }
    #[cfg(unix)]
    #[test]
    fn host_grants_are_single_node_private_and_atomic() {
        use std::{
            fs,
            os::unix::fs::{symlink, DirBuilderExt, MetadataExt, PermissionsExt},
            path::PathBuf,
        };
        let dir = PathBuf::from("/tmp").join(format!("cmonitor-grant-{}", auth::random_token()));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let uid = dir.metadata().unwrap().uid();
        let file = dir.join("grant.json");
        let database = dir.join("monitor.db");
        let name = database.to_str().unwrap();
        let grant = |id, path: &std::path::Path| {
            local_change(name, Action::Grant, id, "https://hub.example", Some(path), uid)
        };
        assert!(grant(1, &file).is_err());
        assert!(!database.exists());
        let db = Db::open(name).unwrap();
        let one = db.create_node(&Default::default(), "report1").unwrap();
        let two = db.create_node(&Default::default(), "report2").unwrap();
        let hash = || {
            db.conn()
                .query_row("SELECT key_hash FROM node_maintenance WHERE node=?", [one], |r| {
                    r.get::<_, Option<String>>(0)
                })
                .unwrap()
        };
        grant(one, &file).unwrap();
        let key: Value = serde_json::from_reader(fs::File::open(&file).unwrap()).unwrap();
        assert_eq!(file.metadata().unwrap().mode() & 0o777, 0o600);
        assert_eq!(key["node"], one);
        assert_eq!(key["report_identity"], auth::sha256("report1"));
        let original = hash();
        assert_eq!(original, Some(auth::sha256(key["credential"].as_str().unwrap())));
        assert!(grant(one, &file).is_err());
        let link = dir.join("symlink");
        symlink(&file, &link).unwrap();
        assert!(grant(one, &link).is_err());
        assert_eq!(hash(), original);
        let unused = dir.join("unused");
        assert!(grant(two + 10, &unused).is_err());
        db.conn().execute_batch("INSERT INTO upgrade_batch(epoch,target,created) VALUES('test','1.0',0); INSERT INTO upgrade_item(batch,pos,node) VALUES(1,0,1)").unwrap();
        assert!(grant(one, &unused).is_err());
        assert!(!unused.exists());
        assert_eq!(hash(), original);
        local_change(name, Action::Offline, two, "", None, uid).unwrap();
        assert!(grant(two, &unused).is_err());
        assert!(offline(&db.conn(), two).unwrap());
        assert_eq!(hash(), original);
        db.conn().execute("UPDATE upgrade_batch SET status='failed' WHERE id=1", []).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(grant(one, &unused).is_err());
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(local_change(name, Action::Grant, one, "http://hub.example", Some(&unused), uid).is_err());
        assert!(!unused.exists());
        local_change(name, Action::Revoke, one, "", None, uid).unwrap();
        assert_eq!(hash(), None);
        drop(db);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn independent_keys_rotate_and_http_policy_remains_sticky() {
        let app = Arc::new(App::for_test(Db::open(":memory:").unwrap()));
        let node = app.db.create_node(&Default::default(), "reporting-token").unwrap();
        let mut h = headers();
        let grant = |headers: HeaderMap| {
            policy(Admin, Path(node), State(app.clone()), headers, Json(Change { action: Action::Grant }))
        };
        assert_eq!(grant(h.clone()).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(worker_status(&app, "reporting-token").await, StatusCode::UNAUTHORIZED);
        login(&app, &mut h);
        let response = grant(h.clone()).await;
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let initial: Value = serde_json::from_str(&body(response).await).unwrap();
        let old = initial["credential"].as_str().unwrap();
        assert_eq!(initial["report_identity"], auth::sha256("reporting-token"));
        assert_eq!(app.db.node_by_token(old).unwrap(), None);
        assert_eq!(worker_status(&app, old).await, StatusCode::OK);
        let next: Value = serde_json::from_str(&body(grant(h.clone()).await).await).unwrap();
        let next = next["credential"].as_str().unwrap();
        assert_eq!(worker_status(&app, old).await, StatusCode::UNAUTHORIZED);
        assert_eq!(worker_status(&app, next).await, StatusCode::OK);
        app.db.reset_token(node, "new-report").unwrap();
        assert_eq!(worker_status(&app, next).await, StatusCode::UNAUTHORIZED);
        let grant_before_http: Value = serde_json::from_str(&body(grant(h.clone()).await).await).unwrap();
        observe_http(&app.db, node).unwrap();
        assert_eq!(
            worker_status(&app, grant_before_http["credential"].as_str().unwrap()).await,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(grant(h.clone()).await.status(), StatusCode::CONFLICT);
        app.db.reset_token(node, "third-report").unwrap();
        assert!(offline(&app.db.conn(), node).unwrap());
        assert_eq!(app.db.node_by_token("third-report").unwrap(), Some(node));
        assert_eq!(
            app.db
                .conn()
                .query_row("SELECT count(*) FROM upgrade_worker", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn registration_window_enrols_only_a_new_tls_node() {
        let app = Arc::new(App::for_test(Db::open(":memory:").unwrap()));
        let h = headers();
        api::open_register(Admin, State(app.clone()), h.clone()).await;
        let window = app.db.get("register_key").unwrap();
        let register = |key: &str, tls: bool| {
            let mut h = h.clone();
            h.insert(header::ACCEPT, "application/vnd.cmonitor.agent-registration+text".parse().unwrap());
            h.insert(header::AUTHORIZATION, format!("Bearer {key}").parse().unwrap());
            if !tls {
                h.insert("x-forwarded-proto", "http".parse().unwrap());
            }
            api::agent_register(
                State(app.clone()),
                ConnectInfo("127.0.0.1:16000".parse().unwrap()),
                h,
                "first".into(),
            )
        };
        assert_eq!(register(&window, false).await.status(), StatusCode::FORBIDDEN);
        let resp = register(&window, true).await;
        assert_eq!(resp.headers()[header::CACHE_CONTROL], "no-store");
        let out = body(resp).await;
        let (report, file) = out.trim().split_once('\n').unwrap();
        let grant: Value = serde_json::from_str(file).unwrap();
        let maint = grant["credential"].as_str().unwrap();
        assert_eq!(grant["node"], app.db.node_by_token(report).unwrap().unwrap());
        assert_eq!(worker_status(&app, report).await, StatusCode::UNAUTHORIZED);
        assert_eq!(worker_status(&app, maint).await, StatusCode::OK);
        assert_eq!(register(report, true).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(register(maint, true).await.status(), StatusCode::FORBIDDEN);
        assert_eq!(app.db.nodes().unwrap().len(), 1);
    }
}
