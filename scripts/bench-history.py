#!/usr/bin/env python3
"""Compare two Hub release binaries on the same loopback HTTP history workload."""
import argparse
import contextlib
import http.client
import json
import math
import shutil
import socket
import sqlite3
import statistics
import subprocess
import tempfile
import time
from pathlib import Path


def seed(binary, path):
    path.touch()
    subprocess.run([binary, "--db", path, "--check-db"], check=True, stdout=subprocess.DEVNULL)
    start = (int(time.time()) - 7 * 86400 + 300) // 60 * 60
    with contextlib.closing(sqlite3.connect(path)) as db, db:
        db.execute("INSERT INTO setting VALUES('password_login','off')")
        db.execute("INSERT INTO node(id,name,token,created_at) VALUES(1,'benchmark','fixture',?)", (start,))
        for probe in range(1, 5):
            db.execute("INSERT INTO ping_task VALUES(?,?,'127.0.0.1',20)", (probe, f"probe {probe}"))
            db.execute("INSERT INTO ping_node VALUES(?,1)", (probe,))
        def rows():
            for i in range(30210):
                for probe in range(1, 5):
                    case = (i * 17 + probe * 13) % 173
                    value = -2 if case == 0 else -1 if case < 5 else 5 + (case * probe) % 120
                    yield probe, start + 20 * i, value
        db.executemany("INSERT INTO ping_record(node_id,task_id,ts,latency) VALUES(1,?,?,?)", rows())


def request(conn, path):
    conn.request("GET", path)
    res = conn.getresponse()
    body = res.read()
    if res.status != 200:
        raise RuntimeError(f"{path}: {res.status}")
    return body


def measure(binary, fixture, work, runs):
    work.mkdir()
    db = work / "hub.db"
    shutil.copyfile(fixture, db)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proc = subprocess.Popen([binary, "--listen", f"127.0.0.1:{port}", "--db", db, "--themes", work / "themes"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    path = "/api/nodes/1/metrics?hours=168&series=ping&points=1440"
    try:
        for _ in range(100):
            if proc.poll() is not None:
                raise RuntimeError("Hub exited during startup")
            try:
                request(conn, "/healthz")
                break
            except OSError:
                conn.close()
                time.sleep(0.05)
        else:
            raise RuntimeError("Hub did not become ready")
        body = json.loads(request(conn, path))
        total = sum(s["success_count"] + s["loss_count"] + s["error_count"] for s in body["stats"].values())
        if total != 120840 or len(body["probes"]) != 4:
            raise RuntimeError(f"fixture returned {total} samples and {len(body['probes'])} probes")
        request(conn, path)
        times = []
        for _ in range(runs):
            begin = time.perf_counter_ns()
            response = request(conn, path)
            times.append((time.perf_counter_ns() - begin) / 1e6)
            if json.loads(response) != body:
                raise RuntimeError("history changed during measurements")
        return body, times
    finally:
        conn.close()
        proc.terminate()
        proc.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--runs", type=int, default=20)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        fixture = root / "fixture.db"
        baseline, candidate = args.baseline.resolve(), args.candidate.resolve()
        seed(baseline, fixture)
        expected = None
        for name, binary in [("baseline", baseline), ("candidate", candidate)]:
            body, times = measure(binary, fixture, root / name, args.runs)
            if expected is not None and expected != body:
                raise RuntimeError("baseline and candidate returned different JSON")
            expected = body
            print(f"{name}: n={len(times)} p50={statistics.median(times):.2f} ms "
                  f"p95={sorted(times)[math.ceil(len(times) * 0.95) - 1]:.2f} ms")
        print(f"Matched complete JSON for 120840 samples, 4 probes, {len(expected['ping'])} chart rows.")


if __name__ == "__main__":
    main()
