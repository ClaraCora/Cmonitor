use super::*;
use std::time::Instant;

/// Run with cargo test --release --locked benchmark_live_snapshot -- --ignored --nocapture.
/// Each rebuild explicitly invalidates the snapshot. Hits exercise the full
/// public HTTP handler and consume its body, without a socket or compression.
#[tokio::test]
#[ignore = "manual synthetic performance benchmark"]
async fn benchmark_live_snapshot() {
    for count in [23, 230] {
        let app = std::sync::Arc::new(app());
        let ids: Vec<_> = (0..count).map(|n| node(&app, &format!("node-{n}"), true)).collect();
        let probes: Vec<_> = (0..4).map(|_| task(&app, ids.clone())).collect();
        for id in &ids {
            let _rx = connect(
                &app,
                *id,
                json!({"cpu": 4.5, "load": [0.2,0.3,0.1], "mem_used": 123000, "mem_total": 200000,
                       "net_tx": 10, "net_rx": 20, "boot_id": "local", "net_rx_total": 55555}),
            );
            let mut agents = app.agents.write().unwrap();
            let live = agents.get_mut(id).unwrap();
            for probe in &probes {
                let mut reading = crate::agent_ws::PingReading::new(20, Utc::now().timestamp());
                reading.samples = (10..30).collect();
                live.pings.insert(*probe, reading);
            }
        }
        for full in [false, true] {
            let size = live_snapshot(&app, full).len();
            let rounds = if count == 23 { 30 } else { 12 };
            let mut micros = Vec::with_capacity(rounds);
            for _ in 0..rounds {
                invalidate_snapshot(&app);
                let start = Instant::now();
                std::hint::black_box(live_snapshot(&app, full));
                micros.push(start.elapsed().as_micros());
            }
            micros.sort_unstable();
            println!(
                "nodes={count} admin={full} frame_bytes={size} rebuild_median_us={}",
                micros[rounds / 2]
            );
        }
        // Start each group with a fresh frame to avoid measuring a TTL expiry.
        let mut hits = Vec::new();
        for _ in 0..9 {
            invalidate_snapshot(&app);
            let size = live_snapshot(&app, false).len();
            let start = Instant::now();
            for _ in 0..200 {
                let r = nodes(State(app.clone()), HeaderMap::new()).await;
                assert_eq!(r.status(), StatusCode::OK);
                let bytes = axum::body::to_bytes(r.into_body(), usize::MAX).await.unwrap();
                assert_eq!(std::hint::black_box(bytes).len(), size);
            }
            hits.push(start.elapsed().as_nanos() / 200);
        }
        hits.sort_unstable();
        println!("nodes={count} public_http_hit_median_ns={}", hits[4]);
    }
}
