#!/usr/bin/env python3
"""Consistent SQLite backups, verified in isolation before retention removes anything."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time


def record(source, key, value):
    with closing(sqlite3.connect(Path(source).resolve().as_uri() + "?mode=rw", uri=True, timeout=30)) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO setting(key,value) VALUES(?,?)", (key, str(value)))


def backup(source, directory, keep=7, offsite=None, hub=None):
    source, directory = Path(source).resolve(), Path(directory).resolve()
    if not source.is_file():
        raise ValueError("database does not exist")
    if keep < 1:
        raise ValueError("keep must be positive")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    moment = time.time_ns()
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(moment // 1_000_000_000)) + f"-{moment % 1_000_000_000:09d}"
    target = directory / f"monitor-{stamp}.db"
    temporary = target.with_suffix(".partial")
    try:
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30)) as live:
            with closing(sqlite3.connect(temporary)) as copy:
                live.backup(copy, pages=256, sleep=0.05)
        os.chmod(temporary, 0o600)
        with closing(sqlite3.connect(temporary)) as copy:
            if copy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("backup integrity check failed")
            tables = {row[0] for row in copy.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {"node", "traffic", "setting", "session"} <= tables:
                raise ValueError("not a monitor database")
            nodes = copy.execute("SELECT COUNT(*) FROM node").fetchone()[0]
            if copy.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("backup foreign key check failed")
        # The Hub's read-only self-check opens and migrates only a disposable copy.
        if hub:
            import shutil
            with tempfile.TemporaryDirectory(prefix="cmonitor-verify-") as scratch:
                candidate = Path(scratch) / "verify.db"
                shutil.copy2(temporary, candidate)
                subprocess.run([str(hub), "--db", str(candidate), "--check-db"], check=True, timeout=120, capture_output=True)
        temporary.replace(target)
        with target.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest = target.with_suffix(".json")
        manifest.write_text(json.dumps({"file": target.name, "sha256": digest, "nodes": nodes, "verified_at": int(time.time())}) + "\n", encoding="utf-8")
        os.chmod(manifest, 0o600)
        if offsite:
            # Configured by the server operator, never a shell command. A failure
            # retains every existing local generation and is visible in the panel.
            subprocess.run(["rsync", "-a", "--protect-args", "--", str(target), str(manifest), offsite], check=True, timeout=300, capture_output=True)
        for expired in sorted(directory.glob("monitor-*.db"), reverse=True)[keep:]:
            expired.unlink()
            expired.with_suffix(".json").unlink(missing_ok=True)
        record(source, "backup_last_success", int(time.time()))
        record(source, "backup_last_error", "")
        return {"file": str(target), "sha256": digest, "nodes": nodes}
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--keep", type=int, default=7)
    parser.add_argument("--offsite", help="rsync destination, e.g. backup@host:/srv/monitor/")
    parser.add_argument("--hub", help="Hub executable for isolated migration/startup verification")
    args = parser.parse_args()
    try:
        print(json.dumps(backup(args.db, args.directory, args.keep, args.offsite, args.hub)))
    except Exception as error:
        # Do not expose offsite credentials/addresses or captured subprocess output.
        try:
            record(args.db, "backup_last_error", f"{type(error).__name__}: 备份或异机复制失败，请检查服务日志")
        except sqlite3.Error:
            pass
        raise SystemExit(f"backup failed ({type(error).__name__})") from error


if __name__ == "__main__":
    main()
