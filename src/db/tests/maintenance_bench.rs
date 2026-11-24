use super::*;
use std::time::Instant;

/// Exercises the production stats and hourly cleanup on the same file-backed
/// SQLite fixture. Setup and insertion of the expired tail are outside timing.
#[test]
#[ignore = "manual synthetic performance benchmark"]
fn benchmark_history_maintenance() {
    let scratch = Scratch::new();
    let db = Db::open(&scratch.0).unwrap();
    for _ in 0..23 {
        node(&db, 1);
    }
    let now = Utc::now().timestamp();
    db.conn()
        .execute(
            "WITH RECURSIVE samples(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM samples WHERE i<10079)
         INSERT INTO metric SELECT id, ?1-i*60, 1,2,3,4,5,6,7,8,9 FROM node CROSS JOIN samples",
            [now],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO ping_record SELECT node_id,task,ts,21 FROM metric CROSS JOIN
         (SELECT 1 AS task UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)",
            [],
        )
        .unwrap();

    let mut stats = Vec::new();
    let mut prune = Vec::new();
    for round in 0..12 {
        db.conn().execute("INSERT INTO ping_record SELECT id,1,?1,33 FROM node", [now - 10 * 86400]).unwrap();
        let start = Instant::now();
        let result = db.stats().unwrap();
        let stats_us = start.elapsed().as_micros();
        assert_eq!(result["oldest"], now - 10 * 86400);
        assert_eq!(result["rows"]["metric"], 23 * 10080);
        assert_eq!(result["rows"]["ping_record"], 23 * 10080 * 4 + 23);

        let start = Instant::now();
        assert_eq!(db.prune(8).unwrap(), 23);
        if round > 0 {
            prune.push(start.elapsed().as_micros());
            stats.push(stats_us);
        }
    }
    stats.sort_unstable();
    prune.sort_unstable();
    println!("maintenance_rows={} stats_median_us={} prune_median_us={}", 23 * 10080 * 5, stats[5], prune[5]);
}

/// Cache revalidation on a real embedded admin asset, through the handler.
#[tokio::test]
#[ignore = "manual synthetic performance benchmark"]
async fn benchmark_static_revalidation() {
    use axum::extract::{ConnectInfo, State};
    use axum::http::{header, HeaderMap, StatusCode, Uri};
    let app = std::sync::Arc::new(crate::App::for_test(Db::open(":memory:").unwrap()));
    let peer = ConnectInfo("127.0.0.1:12345".parse().unwrap());
    let uri: Uri = "/clara/wallpaper-night.svg".parse().unwrap();
    let first = crate::frontend::serve(State(app.clone()), peer, HeaderMap::new(), uri.clone()).await;
    assert_eq!(first.headers()[header::CONTENT_TYPE], "image/svg+xml");
    let mut headers = HeaderMap::new();
    headers.insert(header::IF_NONE_MATCH, first.headers()[header::ETAG].clone());
    let mut times = Vec::new();
    for round in 0..12 {
        let start = Instant::now();
        for _ in 0..1000 {
            let r = crate::frontend::serve(State(app.clone()), peer, headers.clone(), uri.clone()).await;
            assert_eq!(r.status(), StatusCode::NOT_MODIFIED);
        }
        if round > 0 {
            times.push(start.elapsed().as_nanos() / 1000);
        }
    }
    times.sort_unstable();
    println!("embedded_revalidation_median_ns={}", times[5]);
}
