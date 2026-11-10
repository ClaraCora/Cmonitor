import importlib.util
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("monitor_backup", Path(__file__).with_name("backup.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BackupTests(unittest.TestCase):
    def test_real_hub_can_migrate_and_read_the_isolated_snapshot(self):
        executable = Path(os.environ.get("MONITOR_HUB", Path(__file__).resolve().parents[1] / "target" / "debug" / ("monitor-hub.exe" if os.name == "nt" else "monitor-hub"))).resolve()
        self.assertTrue(executable.is_file(), "build the Hub before running backup integration tests")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            live = root / "live.db"
            live.touch()
            subprocess.run([str(executable), "--db", str(live), "--check-db"], check=True, capture_output=True, timeout=30)
            with closing(sqlite3.connect(live)) as conn, conn:
                conn.execute("INSERT INTO node(name,token,created_at) VALUES('isolated','fixture-token',0)")
            result = module.backup(live, root / "copies", hub=executable)
            self.assertEqual(result["nodes"], 1)
            with closing(sqlite3.connect(result["file"])) as conn:
                self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(conn.execute("SELECT name FROM node").fetchone()[0], "isolated")

    def test_wal_snapshot_is_verified_and_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            live, copies = root / "live.db", root / "copies"
            moments = [1_700_000_000_000_900_000, 1_700_000_000_001_100_000, 1_700_000_000_001_500_000, 1_700_000_000_001_600_000]
            with closing(sqlite3.connect(live)) as conn, conn, patch.object(module.time, "time_ns", side_effect=moments):
                conn.executescript("PRAGMA journal_mode=WAL; CREATE TABLE node(id INTEGER PRIMARY KEY); CREATE TABLE traffic(node_id INTEGER); CREATE TABLE setting(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE session(token TEXT);")
                for value in range(4):
                    conn.execute("INSERT INTO node VALUES(?)", (value,))
                    conn.commit()
                    result = module.backup(live, copies, keep=2)
                    with closing(sqlite3.connect(result["file"])) as snapshot:
                        self.assertEqual(snapshot.execute("SELECT COUNT(*) FROM node").fetchone()[0], value + 1)
                    self.assertEqual(len(list(copies.glob("monitor-*.db"))), min(value + 1, 2))
            self.assertEqual(len(list(copies.glob("monitor-*.json"))), 2)
            retained = []
            for snapshot_file in sorted(copies.glob("monitor-*.db")):
                with closing(sqlite3.connect(snapshot_file)) as snapshot:
                    retained.append(snapshot.execute("SELECT COUNT(*) FROM node").fetchone()[0])
            self.assertEqual(retained, [3, 4], "retention keeps the newest verified generations")
            self.assertFalse(list(copies.glob("*.partial")))
            with closing(sqlite3.connect(live)) as conn:
                self.assertTrue(conn.execute("SELECT value FROM setting WHERE key='backup_last_success'").fetchone())

    def test_failed_offsite_copy_preserves_every_previous_generation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            live, copies = root / "live.db", root / "copies"
            with closing(sqlite3.connect(live)) as conn, conn:
                conn.executescript("CREATE TABLE node(id); CREATE TABLE traffic(id); CREATE TABLE setting(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE session(id);")
            module.backup(live, copies, keep=7)
            before = set(copies.glob("monitor-*.db"))
            with patch.object(module.subprocess, "run", side_effect=RuntimeError("local fake failure")):
                with self.assertRaises(RuntimeError):
                    module.backup(live, copies, keep=1, offsite="unused-fixture")
            self.assertTrue(before <= set(copies.glob("monitor-*.db")))


if __name__ == "__main__":
    unittest.main()
