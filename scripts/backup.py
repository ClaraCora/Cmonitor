#!/usr/bin/env python3
"""Consistent SQLite backups, verified in isolation before retention removes anything."""
import argparse
from datetime import datetime
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


def parse_timer(output):
    fields = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
    load = fields.get("LoadState")
    state = "not_installed" if load == "not-found" else "unavailable" if load not in ("loaded", "masked") else "active" if fields.get("ActiveState") == "active" else "inactive"
    calendar = fields.get("TimersCalendar", "")
    calendar = calendar.split("OnCalendar=", 1)[1].split(" ;", 1)[0].strip() if "OnCalendar=" in calendar else None
    return {"state": state, "boot_enabled": fields.get("UnitFileState") == "enabled", "calendar": calendar,
            "random_delay": fields.get("RandomizedDelayUSec"),
            "next_run": (fields.get("NextElapseUSecRealtime") or None) if state == "active" and fields.get("NextElapseUSecRealtime") != "n/a" else None}


def report_status(source):
    """Run in the backup service, keeping systemd and root-only files outside the Hub."""
    scheduler = {"state": "unavailable"}
    try:
        output = subprocess.run(["systemctl", "show", "monitor-backup.timer", "--no-pager", "--no-ask-password",
                                 "-p", "LoadState", "-p", "ActiveState", "-p", "UnitFileState", "-p", "TimersCalendar",
                                 "-p", "NextElapseUSecRealtime", "-p", "RandomizedDelayUSec"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=2, env={**os.environ, "LC_ALL": "C"})
        scheduler = parse_timer(output.stdout)
    except (OSError, subprocess.TimeoutExpired):
        pass
    with closing(sqlite3.connect(Path(source).resolve().as_uri() + "?mode=rw", uri=True, timeout=30)) as conn:
        row = conn.execute("SELECT value FROM setting WHERE key='backup_policy'").fetchone()
    try:
        policy = json.loads(row[0]) if row else None
        if not isinstance(policy, dict) or not isinstance(policy.get("directory"), str) or type(policy.get("keep")) is not int or policy["keep"] < 1:
            policy = None
        else:
            policy = {"directory": policy["directory"], "keep": policy["keep"], "offsite": bool(policy.get("offsite"))}
    except (ValueError, TypeError):
        policy = None
    copies = None
    if policy:
        try:
            directory = Path(policy["directory"])
            if directory.is_dir():
                copies = sum(path.is_file() and not path.is_symlink() and path.with_suffix(".json").is_file() for path in directory.glob("monitor-*.db"))
        except OSError:
            pass
    status = {"scheduler": scheduler, "policy": policy, "copies": copies, "checked_at": int(time.time()),
              "timezone": datetime.now().astimezone().strftime("UTC%z")}
    record(source, "backup_status", json.dumps(status))
    return status


def backup(source, directory, keep=7, offsite=None, hub=None):
    source, directory = Path(source).resolve(), Path(directory).resolve()
    if not source.is_file():
        raise ValueError("database does not exist")
    if keep < 1:
        raise ValueError("keep must be positive")
    # Report only the destination kind; never expose an offsite address/key.
    record(source, "backup_policy", json.dumps({"directory": str(directory), "keep": keep, "offsite": bool(offsite)}))
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
    parser.add_argument("--directory")
    parser.add_argument("--report-status", action="store_true", help="report timer and local inventory without creating a backup")
    parser.add_argument("--keep", type=int, default=7)
    parser.add_argument("--offsite", help="rsync destination, e.g. backup@host:/srv/monitor/")
    parser.add_argument("--hub", help="Hub executable for isolated migration/startup verification")
    args = parser.parse_args()
    if args.report_status:
        print(json.dumps(report_status(args.db)))
        return
    if not args.directory:
        parser.error("--directory is required when creating a backup")
    try:
        print(json.dumps(backup(args.db, args.directory, args.keep, args.offsite, args.hub)))
    except Exception as error:
        # Do not expose offsite credentials/addresses or captured subprocess output.
        try:
            record(args.db, "backup_last_error", f"{type(error).__name__}: 备份或异机复制失败，请检查服务日志")
        except sqlite3.Error:
            pass
        raise SystemExit(f"backup failed ({type(error).__name__})") from error
    finally:
        try:
            report_status(args.db)
        except Exception:
            # A metadata refresh must not turn a verified backup into a failure.
            pass


if __name__ == "__main__":
    main()
