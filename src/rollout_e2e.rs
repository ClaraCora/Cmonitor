//! Real authenticated Hub routes plus reloaded Python workers on an ephemeral fleet.
//! The mock release server and the two simulated transport faults are local to this test.
use super::*;
use axum::extract::Request;
use axum::middleware::{from_fn, Next};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit Python worker + 20 WebSocket rollout regression"]
async fn canary_then_nineteen_workers() {
    let version = agent_pin().tag.trim_start_matches('v').to_string();
    let image = format!("#!/bin/sh\necho 'monitor-agent {version}'\n");
    let digest = hex::encode(Sha256::digest(image.as_bytes()));
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let source = upstream.local_addr().unwrap();
    let mut app = App::for_test(Db::open(":memory:").unwrap());
    app.agent_fixture_sha256 = Some(digest.clone());
    app.site = "https://hub.example.test".into();
    app.db.set("github_proxy", &format!("http://{source}")).unwrap();
    // In particular, optional geographic lookups cannot leave this fixture.
    app.http = reqwest::Client::builder()
        .proxy(reqwest::Proxy::custom(|url| {
            (url.host_str() != Some("127.0.0.1")).then_some("http://127.0.0.1:9")
        }))
        .build()
        .unwrap();
    let cookie = auth::issue_session(&app, &HeaderMap::new()).unwrap();
    app.db.conn().execute("UPDATE session SET kind='password'", []).unwrap();
    let slots = app.relay_slots.clone();
    let source_reads = Arc::new(AtomicUsize::new(0));
    let reads = source_reads.clone();
    let releases = Router::new().fallback(move |request: Request| {
        let image = image.clone();
        let digest = digest.clone();
        let slots = slots.clone();
        let reads = reads.clone();
        async move {
            let path = request.uri().path();
            if path.ends_with("/sha256sums.txt") {
                return format!("{digest}  monitor-agent-x86_64-unknown-linux-musl\n{digest}  monitor-agent-aarch64-unknown-linux-musl\n").into_response();
            }
            if path.ends_with("/monitor-agent-aarch64-unknown-linux-musl") {
                // The followers use a different architecture from the canary. Hold the
                // cold upstream response until all 19 real download handlers have permits.
                let all_joined = tokio::time::timeout(Duration::from_secs(12), async {
                    while RELAY_SLOTS - slots.available_permits() < 19 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }).await;
                if all_joined.is_err() {
                    return (StatusCode::REQUEST_TIMEOUT, "19 concurrent downloads did not join").into_response();
                }
            } else if !path.ends_with("/monitor-agent-x86_64-unknown-linux-musl") {
                return StatusCode::NOT_FOUND.into_response();
            }
            reads.fetch_add(1, Ordering::SeqCst);
            image.into_response()
        }
    });
    let remote = tokio::spawn(async move { axum::serve(upstream, releases).await.unwrap() });
    let downloads = Arc::new(AtomicUsize::new(0));
    let count = downloads.clone();
    let router = Router::new()
        .route("/api/agent/ws", get(agent_ws::handler))
        .route("/api/agent/upgrade", post(rollout::poll))
        .route("/api/agent-upgrades", get(rollout::status).post(rollout::start))
        .route("/api/nodes", get(api::nodes).post(api::create_node))
        .route("/api/nodes/{id}/maintenance", post(maintenance::policy))
        .route("/api/nodes/{id}/maintenance/pair-command", post(pairing::issue))
        .route("/api/nodes/{id}/maintenance/redeem", post(pairing::redeem))
        .route("/agent/{arch}", get(agent_binary))
        .layer(from_fn(move |mut req: Request, next: Next| {
            let count = count.clone();
            async move {
                // Simulate the production TLS terminator on a loopback-only listener.
                req.headers_mut().insert("host", "hub.example.test".parse().unwrap());
                req.headers_mut().insert("x-forwarded-proto", "https".parse().unwrap());
                if req.uri().path().starts_with("/agent/") && count.fetch_add(1, Ordering::SeqCst) == 0 {
                    return (StatusCode::SERVICE_UNAVAILABLE, "fixture: transient busy").into_response();
                }
                next.run(req).await
            }
        }))
        .with_state(Arc::new(app));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("python3")
            .args(["-B", "scripts/rollout-e2e.py", &port.to_string(), &source.port().to_string(), &version])
            .env("ROLLOUT_TEST_COOKIE", cookie.split(';').next().unwrap())
            .env("no_proxy", "127.0.0.1")
            .env("NO_PROXY", "127.0.0.1")
            .status()
            .unwrap()
    })
    .await
    .unwrap();
    server.abort();
    remote.abort();
    assert!(result.success());
    assert_eq!(source_reads.load(Ordering::SeqCst), 2, "one upstream download per architecture");
    assert_eq!(downloads.load(Ordering::SeqCst), 21, "one 503 and twenty verified downloads");
}
