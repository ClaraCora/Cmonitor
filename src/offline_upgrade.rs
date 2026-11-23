//! A copyable command for the offline verifier already installed on a node.
//! The archive digest comes only from the Hub's local deployment manifest.
use crate::{api::Admin, Shared};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use std::{fs, io::Read, path::Path as FsPath};

const MANIFEST: &str = "offline-agent-release.json";
const MAX_MANIFEST: u64 = 8192;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Release {
    agent_version: String,
    sha256: String,
    url: String,
}

#[derive(Serialize)]
struct UpgradeCommand {
    version: String,
    command: String,
}

fn archive_url(value: &str) -> bool {
    let Some(endpoint) = value.strip_prefix("http://").or_else(|| value.strip_prefix("https://")) else {
        return false;
    };
    let Some((authority, path)) = endpoint.split_once('/') else {
        return false;
    };
    // Only literal, credential-free archive URLs. In particular, curl treats braces
    // and path brackets as URL globs even when the argument is quoted in the shell.
    !authority.is_empty()
        && authority.bytes().all(|c| c.is_ascii_alphanumeric() || b".-:[]".contains(&c))
        && !path.is_empty()
        && !path.ends_with('/')
        && path.bytes().all(|c| c.is_ascii_alphanumeric() || b"-._~/".contains(&c))
        && !path.split('/').any(|s| matches!(s, "." | ".."))
        && reqwest::Url::parse(value).is_ok_and(|u| u.has_host())
}

fn read_command(database: &FsPath, target: &str) -> Result<UpgradeCommand, &'static str> {
    let dir = database.parent().ok_or("当前 Hub 数据库没有可读取部署清单的数据目录")?;
    let path = dir.join(MANIFEST);
    let metadata = fs::symlink_metadata(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => "尚未配置离线包，请在 Hub 数据目录部署 offline-agent-release.json",
        _ => "无法读取 offline-agent-release.json，请检查文件权限",
    })?;
    if !metadata.is_file() {
        return Err("offline-agent-release.json 必须是普通文件");
    }
    let file = fs::File::open(path).map_err(|_| "无法读取 offline-agent-release.json，请检查文件权限")?;
    let opened = file.metadata().map_err(|_| "无法检查离线包清单")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let db = database.metadata().map_err(|_| "无法确认 Hub 数据库的属主")?;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err("离线包清单正在更换，请重试");
        }
        if (opened.uid() != 0 && opened.uid() != db.uid()) || opened.mode() & 0o022 != 0 {
            return Err("离线包清单须由 root 或数据库属主拥有，且仅属主可写");
        }
    }
    if !opened.is_file() || opened.len() > MAX_MANIFEST {
        return Err("离线包清单不是有效的小型 JSON 文件");
    }
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST + 1).read_to_end(&mut bytes).map_err(|_| "无法读取离线包清单内容")?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("离线包清单过大");
    }
    let release: Release = serde_json::from_slice(&bytes)
        .map_err(|_| "离线包清单格式无效，须包含 agent_version、sha256 和 url")?;
    if release.agent_version != target {
        return Err("离线包清单版本与 Hub 的目标 Agent 版本不一致，请更新清单");
    }
    if release.sha256.len() != 64
        || !release.sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("离线包清单的 SHA-256 必须是 64 位小写十六进制摘要");
    }
    if !archive_url(&release.url) {
        return Err("离线包地址无效，须使用无凭据、参数或片段的 HTTP(S) 归档直链");
    }
    // Both alphabets above exclude single quotes and controls.
    Ok(UpgradeCommand {
        version: release.agent_version,
        command: format!("sh /root/agent-offline-install.sh '{}' '{}'", release.sha256, release.url),
    })
}

pub async fn command(_: Admin, Path(node): Path<i64>, State(app): State<Shared>) -> impl IntoResponse {
    let policy = app.db.conn().query_row(
        "SELECT COALESCE(m.offline_only,0) FROM node n LEFT JOIN node_maintenance m ON m.node=n.id WHERE n.id=?",
        [node], |r| r.get::<_, bool>(0),
    ).optional();
    let reply = match policy {
        Ok(Some(true)) => {
            let database = app.db.file();
            let pin = crate::agent_pin();
            match tokio::task::spawn_blocking(move || {
                read_command(FsPath::new(&database), pin.tag.trim_start_matches('v'))
            })
            .await
            {
                Ok(Ok(command)) => Json(command).into_response(),
                Ok(Err(why)) => (StatusCode::SERVICE_UNAVAILABLE, why).into_response(),
                Err(e) => {
                    tracing::error!("read offline release manifest: {e}");
                    StatusCode::INTERNAL_SERVER_ERROR.into_response()
                }
            }
        }
        Ok(Some(false)) => (StatusCode::CONFLICT, "手动升级命令仅适用于离线维护节点").into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, "节点不存在").into_response(),
        Err(e) => {
            tracing::error!("read offline maintenance policy: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    };
    ([(header::CACHE_CONTROL, "no-store")], reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{api, auth, db::Db, maintenance, App};
    use axum::{routing::get, Router};
    use serde_json::{json, Value};
    use std::{path::PathBuf, sync::Arc};

    struct DataDir(PathBuf);
    impl DataDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("cmonitor-offline-command-{}", auth::random_token()));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for DataDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn archive_is_a_single_literal_http_or_https_url() {
        for safe in ["http://192.0.2.1:8080/cache/agent.tar.gz", "https://[2001:db8::1]/agent-1.0.tgz"] {
            assert!(archive_url(safe), "{safe}");
        }
        for bad in [
            "file:///tmp/archive",
            "http:///host/archive",
            "https://user@host/archive",
            "https://host/archive?token=secret",
            "https://host/archive#secret",
            "https://host/a'b",
            "https://host/a\nb",
            "https://host/a;b",
            "https://host/a[1-5]",
            "https://host/{a,b}",
            "https://host/../archive",
            "https://host/path/",
            "https://host/%0A",
            "https://host/",
        ] {
            assert!(!archive_url(bad), "{bad}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn authorized_copy_is_read_only_for_a_disconnected_current_offline_node() {
        let dir = DataDir::new();
        let db = Db::open(dir.0.join("custom.db").to_str().unwrap()).unwrap();
        let public = crate::db::Node { public: true, ..Default::default() };
        let node = db.create_node(&public, "offline-report-token").unwrap();
        let online_policy = db.create_node(&Default::default(), "other-report-token").unwrap();
        maintenance::observe_http(&db, node).unwrap();
        let pin = crate::agent_pin();
        let target = pin.tag.trim_start_matches('v');
        db.save_facts(node, &json!({"agent_version":target}), "").unwrap();
        let app = Arc::new(App::for_test(db));
        let cookie = auth::issue_session(&app, &Default::default()).unwrap();
        let cookie = cookie.split(';').next().unwrap();
        let router = Router::new()
            .route("/api/nodes", get(api::nodes))
            .route("/api/nodes/{id}/offline-upgrade-command", get(command))
            .with_state(app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/api/nodes", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::new();
        let get = |id| client.get(format!("{base}/{id}/offline-upgrade-command"));
        assert_eq!(get(node).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
        let client_get = |id| get(id).header(header::COOKIE, cookie).send();
        assert_eq!(client_get(online_policy).await.unwrap().status(), StatusCode::CONFLICT);
        assert_eq!(client_get(node + 1000).await.unwrap().status(), StatusCode::NOT_FOUND);
        let missing = client_get(node).await.unwrap();
        assert_eq!(missing.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(missing.text().await.unwrap().contains(MANIFEST));

        let path = dir.0.join(MANIFEST);
        let url = "http://mirror.example/archives/cmonitor-agent-offline.tar.gz";
        let digest = "ad".repeat(32);
        let good = json!({"agent_version":target,"sha256":digest,"url":url});
        for (field, invalid, expected) in [
            ("agent_version", "outdated", "版本"),
            ("sha256", "bad", "SHA-256"),
            ("url", "https://user:secret@host/archive", "地址"),
        ] {
            let mut bad = good.clone();
            bad[field] = json!(invalid);
            fs::write(&path, bad.to_string()).unwrap();
            let response = client_get(node).await.unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            let reason = response.text().await.unwrap();
            assert!(reason.contains(expected));
            assert!(!reason.contains(invalid));
        }
        fs::write(&path, good.to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{symlink, PermissionsExt};
            fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
            assert_eq!(client_get(node).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            let other = dir.0.join("not-the-manifest");
            fs::rename(&path, &other).unwrap();
            symlink(&other, &path).unwrap();
            assert_eq!(client_get(node).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE);
            fs::remove_file(&path).unwrap();
            fs::rename(&other, &path).unwrap();
        }
        let reply = client_get(node).await.unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
        let data = reply.json::<Value>().await.unwrap();
        assert_eq!(
            data,
            json!({
                "version": target, "command":format!("sh /root/agent-offline-install.sh '{digest}' '{url}'")
            })
        );
        assert_eq!(
            app.db
                .conn()
                .query_row("SELECT count(*) FROM upgrade_batch", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let public: Value = client.get(&base).send().await.unwrap().json().await.unwrap();
        let admin: Value =
            client.get(&base).header(header::COOKIE, cookie).send().await.unwrap().json().await.unwrap();
        let admin_rows = admin["nodes"].as_array().unwrap();
        let public_rows = public["nodes"].as_array().unwrap();
        assert!(public_rows.iter().any(|n| n["id"] == node));
        assert!(public_rows.iter().all(|n| n.get("offline_only").is_none()));
        let row = admin_rows.iter().find(|n| n["id"] == node).unwrap();
        assert_eq!(row["offline_only"], true);
        assert_eq!(row["online"], false);
        assert_eq!(row["agent_version"], target);
        assert_eq!(admin_rows.iter().find(|n| n["id"] == online_policy).unwrap()["offline_only"], false);
        task.abort();
    }
}
