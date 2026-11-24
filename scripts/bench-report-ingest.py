#!/usr/bin/env python3
"""Time reports from 23 loopback agent sockets through to their SQLite commits.

python3 scripts/bench-report-ingest.py path/to/monitor-hub
Run the same command against both release binaries. The first batch is warmup.
"""
import argparse
from contextlib import closing, ExitStack
import json
from pathlib import Path
import runpy
import socket
import sqlite3
import statistics
import subprocess
import tempfile
import time

WebSocket = runpy.run_path(str(Path(__file__).with_name("security-smoke.py")))["WebSocket"]
NODES = 23
METRICS = dict(boot_id="fixture", uptime=3600, cpu=4.5, load=[0.5, 0.4, 0.3],
               mem_total=2**30, mem_used=2**29, swap_total=2**30, swap_used=0,
               disk_total=2**34, disk_used=2**31, tcp=19, udp=3, procs=82, net_rx=1000, net_tx=400)


def report(seq):
    return WebSocket.encode({"jsonrpc": "2.0", "method": "report",
                             "params": dict(METRICS, net_rx_total=seq*1000, net_tx_total=seq*400)})


def bench(binary, per_node, rounds):
    with tempfile.TemporaryDirectory(prefix="cmonitor-ingest-") as folder, ExitStack() as cleanup:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        db = Path(folder) / "fixture.db"
        process = cleanup.enter_context(subprocess.Popen(
            [str(binary.resolve()), "--listen", f"127.0.0.1:{port}", "--db", str(db)],
            cwd=folder, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        cleanup.callback(process.terminate)
        deadline = time.monotonic() + 15
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    break
            except OSError:
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError("temporary Hub did not start")
                time.sleep(0.025)
        conn = cleanup.enter_context(closing(sqlite3.connect(db, isolation_level=None)))
        tokens = [f"fixture-{n}" for n in range(1, NODES + 1)]
        for node, token in enumerate(tokens, 1):
            conn.execute("INSERT INTO node(id,name,token,created_at) VALUES(?,?,?,0)", (node, token, token))
            conn.execute("INSERT INTO traffic(node_id,history_since) VALUES(?,date('now','localtime'))", (node,))
        sockets = []
        for token in tokens:
            ws = cleanup.enter_context(closing(WebSocket(port, "/api/agent/ws", token=token)))
            assert ws.receive()["method"] == "ping.tasks"
            ws.sock.sendall(report(0))
            sockets.append(ws.sock)

        samples = []
        for run in range(rounds + 1):
            first = run * per_node + 1
            last = first + per_node - 1
            # Encode outside the timed section. Feed all sockets in small batches
            # so multiple nodes compete for the same writer, as they do on the Hub.
            chunks = [b"".join(report(i) for i in range(n, min(n+32, last+1)))
                      for n in range(first, last+1, 32)]
            start = time.monotonic()
            for chunk in chunks:
                for sock in sockets:
                    sock.sendall(chunk)
            while conn.execute("SELECT min(last_rx) FROM traffic").fetchone()[0] != last*1000:
                if time.monotonic() - start > 30:
                    raise RuntimeError("timed out waiting for the last report to be booked")
                time.sleep(.002)
            elapsed = time.monotonic() - start
            if run:
                samples.append(round(elapsed * 1000, 2))
            counted = conn.execute("""
                SELECT count(*) FROM traffic t JOIN node n ON n.id=t.node_id
                WHERE t.total_rx=? AND t.total_tx=? AND t.month_rx=? AND t.month_tx=?
                  AND n.last_seen>0 AND t.day_rx=? AND t.day_tx=?
            """, (last*1000, last*400)*3).fetchone()[0]
            assert counted == NODES, "traffic totals or offline timestamps differ"
            assert conn.execute("SELECT sum(rx),sum(tx) FROM traffic_daily").fetchone() == (
                NODES*last*1000, NODES*last*400)
        median = statistics.median(samples)
        print(json.dumps(dict(nodes=NODES, reports_per_batch=NODES*per_node, elapsed_ms=samples,
                              median_ms=median, reports_per_second=round(NODES*per_node*1000/median))))


if __name__ == "__main__":
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("binary", type=Path)
    args.add_argument("--per-node", type=int, default=256)
    args.add_argument("--rounds", type=int, default=7)
    opts = args.parse_args()
    if min(opts.per_node, opts.rounds) < 1:
        args.error("rounds and per-node report counts must be positive")
    bench(opts.binary, opts.per_node, opts.rounds)
