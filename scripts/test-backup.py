import importlib.util
import json
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
    def test_reporter_reads_schedule_and_inventory_without_creating_a_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            live, copies = root / "live.db", root / "copies"
            with closing(sqlite3.connect(live)) as conn, conn:
                conn.executescript("CREATE TABLE node(id); CREATE TABLE traffic(id); CREATE TABLE setting(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE session(id);")
            module.backup(live, copies)
            before = set(copies.iterdir())
            timer = "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nTimersCalendar={ OnCalendar=*-*-* 03:20:00 ; next_elapse=tomorrow }\nNextElapseUSecRealtime=tomorrow\nRandomizedDelayUSec=10min\n"
            with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=timer)):
                status = module.report_status(live)
            self.assertEqual(status["scheduler"]["state"], "active")
            self.assertEqual(status["scheduler"]["calendar"], "*-*-* 03:20:00")
            self.assertEqual(status["copies"], 1)
            self.assertEqual(status["policy"]["keep"], 7)
            self.assertEqual(set(copies.iterdir()), before)
            with patch.object(module.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=timer.replace("ActiveState=active", "ActiveState=inactive"))):
                self.assertIsNone(module.report_status(live)["scheduler"]["next_run"])

    def test_a_failed_timer_query_reports_unknown_instead_of_enabled(self):
        with tempfile.TemporaryDirectory() as temporary:
            live = Path(temporary) / "live.db"
            with closing(sqlite3.connect(live)) as conn, conn:
                conn.execute("CREATE TABLE setting(key TEXT PRIMARY KEY,value TEXT)")
            with patch.object(module.subprocess, "run", side_effect=subprocess.TimeoutExpired(["systemctl"], 2)):
                self.assertEqual(module.report_status(live)["scheduler"]["state"], "unavailable")
        self.assertEqual(module.parse_timer("LoadState=not-found\n")["state"], "not_installed")
        self.assertEqual(module.parse_timer("LoadState=masked\nActiveState=inactive\n")["state"], "inactive")

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
                policy = json.loads(conn.execute("SELECT value FROM setting WHERE key='backup_policy'").fetchone()[0])
                self.assertEqual(policy, {"directory": str(copies.resolve()), "keep": 2, "offsite": False})

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
            with closing(sqlite3.connect(live)) as conn:
                policy = json.loads(conn.execute("SELECT value FROM setting WHERE key='backup_policy'").fetchone()[0])
                self.assertEqual(policy["keep"], 1)
                self.assertTrue(policy["offsite"])
                self.assertNotIn("unused-fixture", json.dumps(policy))


if __name__ == "__main__":
    unittest.main()
