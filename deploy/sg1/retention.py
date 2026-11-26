"""SG1 retention for verified Cmonitor daily backups and Hub rollback snapshots."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat


DAILY = re.compile(r"monitor-\d{8}-\d{6}(?:-\d{9})?\.db")
SNAPSHOT = re.compile(
    r"hub-(?:pre-(?:[a-f0-9]{7,40}|v\d+\.\d+\.\d+)|(?:\d+-)?\d{8}T\d{6}Z)-[a-z0-9_]{8}"
)
SNAPSHOT_FILES = {"running-hub", "monitor.db", "monitor-hub.service",
                  "monitor-stopped.db", "offline-agent-release.json"}


def regular(path):
    return not path.is_symlink() and path.is_file() and not os.path.ismount(path)


def verify_db(path):
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"node", "setting", "traffic", "session"} <= tables or db.execute(
            "PRAGMA quick_check"
        ).fetchall() != [("ok",)]:
            raise ValueError(f"invalid Hub database: {path.name}")


def prune_daily(directory, dry_run=False):
    # A named retirement marker makes removing a DB/manifest pair retryable.
    for marker in directory.glob(".retiring-monitor-*.db"):
        original = directory / marker.name[len(".retiring-"):]
        if DAILY.fullmatch(original.name) and regular(marker) and not original.exists() and not dry_run:
            original.with_suffix(".json").unlink(missing_ok=True)
            marker.unlink()
    copies = sorted((p for p in directory.iterdir() if DAILY.fullmatch(p.name)), reverse=True)
    expired = copies[7:]
    if expired:
        for path in copies:
            manifest = path.with_suffix(".json")
            if not (regular(path) and regular(manifest)):
                raise ValueError(f"incomplete daily backup: {path.name}")
        for path in copies[:7]:
            meta = json.loads(path.with_suffix(".json").read_text())
            with path.open("rb") as stream:
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            if meta.get("file") != path.name or meta.get("sha256") != digest.hexdigest():
                raise ValueError(f"manifest mismatch: {path.name}")
        for path in expired:
            print(f"expire daily {path.name}", flush=True)
            if not dry_run:
                marker = path.with_name(".retiring-" + path.name)
                path.rename(marker)
                path.with_suffix(".json").unlink()
                marker.unlink()
    print(f"daily: found={len(copies)} expire={len(expired)} limit=7 dry_run={dry_run}")


def prune_snapshots(directory, dry_run=False):
    # Finish previously approved deletions if the machine stopped midway.
    for marker in directory.glob(".retiring-hub-*"):
        if not SNAPSHOT.fullmatch(marker.name[len(".retiring-"):]):
            continue
        if marker.is_symlink() or not marker.is_dir() or os.path.ismount(marker):
            raise ValueError(f"unexpected retirement marker: {marker.name}")
        files = tuple(marker.iterdir())
        if any(p.name not in SNAPSHOT_FILES or not regular(p) for p in files):
            raise ValueError(f"unexpected contents: {marker.name}")
        if not dry_run:
            for child in files:
                child.unlink()
            marker.rmdir()
    points = [p for p in directory.iterdir() if SNAPSHOT.fullmatch(p.name)]
    for path in points:
        if path.is_symlink() or not path.is_dir() or os.path.ismount(path):
            raise ValueError(f"unexpected snapshot path: {path.name}")
    points.sort(key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    expired = points[3:]
    if expired:
        children = {}
        for path in points:
            files = tuple(path.iterdir())
            names = {p.name for p in files}
            if not {"running-hub", "monitor.db"} <= names or not names <= SNAPSHOT_FILES or not all(
                regular(p) for p in files
            ):
                raise ValueError(f"unexpected snapshot contents: {path.name}")
            children[path] = files
        for path in points[:3]:
            binary = path / "running-hub"
            with binary.open("rb") as stream:
                magic = stream.read(4)
            if not binary.stat().st_mode & stat.S_IXUSR or magic != b"\x7fELF":
                raise ValueError(f"invalid Hub executable: {path.name}")
            verify_db(path / "monitor.db")
        for path in expired:
            print(f"expire snapshot {path.name}", flush=True)
            if not dry_run:
                marker = path.with_name(".retiring-" + path.name)
                path.rename(marker)
                for child in children[path]:
                    (marker / child.name).unlink()
                marker.rmdir()
    print(f"snapshots: found={len(points)} expire={len(expired)} limit=3 dry_run={dry_run}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=["daily", "snapshots"])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if args.kind == "daily":
        prune_daily(Path("/opt/monitor/backups"), args.dry_run)
    else:
        prune_snapshots(Path("/var/backups/cmonitor"), args.dry_run)
