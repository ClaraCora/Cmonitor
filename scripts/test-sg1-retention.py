"""Exercise SG1's opt-in backup policy using the shipped scripts and service drop-in."""
import configparser
from contextlib import closing
import os
from pathlib import Path
import runpy
import shlex
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SG1 = ROOT / "deploy" / "sg1"
backup = runpy.run_path(str(ROOT / "scripts" / "backup.py"))["backup"]
retention = runpy.run_path(str(SG1 / "retention.py"))


def create_db(path):
    with closing(sqlite3.connect(path)) as conn:
        conn.executescript("""
            CREATE TABLE node(id);
            CREATE TABLE traffic(id);
            CREATE TABLE session(id);
            CREATE TABLE setting(key TEXT PRIMARY KEY,value TEXT);
        """)


class SG1RetentionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_daily_service_defers_pruning_until_verified_post_step(self):
        unit = configparser.ConfigParser(interpolation=None)
        unit.read(SG1 / "monitor-backup-retention.conf")
        env = dict(word.split("=", 1) for word in shlex.split(unit["Service"]["Environment"]))
        post = shlex.split(unit["Service"]["ExecStartPost"])
        self.assertEqual(post[-2:], ["/usr/local/lib/cmonitor/retention.py", "daily"])
        src, dest = self.root / "source.db", self.root / "copies"
        create_db(src)
        with patch.dict(os.environ, env):
            for _ in range(8):
                backup(src, dest)
        copies = sorted(dest.glob("monitor-*.db"))
        self.assertEqual(len(copies), 8, "old backups must survive until the post-step")
        latest = copies[-1]
        original = latest.read_bytes()
        latest.write_bytes(b"corrupt backup")
        with self.assertRaises(ValueError):
            retention["prune_daily"](dest)
        self.assertEqual(sorted(dest.glob("monitor-*.db")), copies)
        latest.write_bytes(original)
        manual = dest / "before-restore.db"
        manual.write_bytes(b"manual copy")
        retention["prune_daily"](dest)
        self.assertEqual(sorted(dest.glob("monitor-*.db")), copies[1:])
        self.assertEqual(sorted(dest.glob("monitor-*.json")), [p.with_suffix(".json") for p in copies[1:]])
        self.assertEqual(manual.read_bytes(), b"manual copy")

    def test_snapshots_preserve_fallback_and_ignore_manual_archive(self):
        # The newest point sorts first by directory timestamp, not by Git hash.
        points = []
        for i in range(5):
            point = self.root / f"hub-pre-{9 - i:07x}-aaaaaaaa"
            point.mkdir()
            binary = point / "running-hub"
            binary.write_bytes(b"\x7fELFfixture")
            binary.chmod(0o700)
            create_db(point / "monitor.db")
            os.utime(point, (100 + i, 100 + i))
            points.append(point)
        archive = self.root / "archived-manual-20261126.tar.zst"
        archive.write_bytes(b"manual archive")

        latest = points[-1] / "monitor.db"
        original = latest.read_bytes()
        latest.write_bytes(b"corrupt SQLite file")
        with self.assertRaises((ValueError, sqlite3.DatabaseError)):
            retention["prune_snapshots"](self.root)
        self.assertTrue(all(p.is_dir() for p in points))
        latest.write_bytes(original)
        retention["prune_snapshots"](self.root)
        self.assertEqual(set(self.root.iterdir()), {archive, *points[-3:]})
        self.assertEqual(archive.read_bytes(), b"manual archive")


if __name__ == "__main__":
    unittest.main()
