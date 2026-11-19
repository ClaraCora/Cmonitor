#!/usr/bin/env python3
"""Exercise the distributed shell installers with isolated paths and stub init systems."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class Installers(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.root = self.base / 'monitor'
        self.root.mkdir()
        self.tools = self.base / 'bin'
        self.tools.mkdir()
        self.unit = self.base / 'unit'
        self.openrc = self.base / 'openrc'
        self.env = {**os.environ, 'PATH': str(self.tools) + ':' + os.environ['PATH']}
        self.stub('id', 'echo 0')
        self.stub('sleep', ':')
        self.stub('uname', 'echo x86_64')
        self.stub('sha256sum', '''python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest()," ",sys.argv[1])' "$1"''')

    def stub(self, name, script):
        p = self.tools / name
        p.write_text('#!/bin/sh\n' + script + '\n')
        p.chmod(0o755)

    def installer(self, name, edits, args):
        s = (ROOT / name).read_text()
        for old, new in edits:
            self.assertIn(old, s)
            s = s.replace(old, str(new))
        return subprocess.run(['sh', '-s', '--', *args], input=s, text=True, env=self.env, capture_output=True)

    def offline(self, openrc=False, fail=False):
        self.stub('curl', f'touch {self.base}/network; exit 1')
        self.stub('rc-update', ':')
        self.stub('systemctl', f'''case "$1" in restart) ! grep -q bad '{self.root}/monitor-agent';; *) exit 0;; esac''')
        self.stub('rc-service', f'''case "$2" in restart) ! grep -q bad '{self.root}/monitor-agent';; *) exit 0;; esac''')
        config = 'MONITOR_SERVER=http://198.51.100.1:1234\nMONITOR_TOKEN=fixture\nMONITOR_DISABLE_TERMINAL=true\nMONITOR_NET_INCLUDE=eth0\n'
        env = self.root / 'agent.env'; env.write_text(config); env.chmod(0o600)
        binary = self.root / 'monitor-agent'; binary.write_text('old')
        unit = self.openrc if openrc else self.unit
        unit.write_text('command_args="--interval 11 --insecure"\n' if openrc else 'ExecStart=/opt/monitor/monitor-agent --interval 11 --insecure\n')
        before = unit.read_bytes()
        candidate = self.base / 'monitor-agent-x86_64-unknown-linux-musl'; candidate.write_text('bad' if fail else 'new')
        (self.base/'sha256sums.txt').write_text(f'{hashlib.sha256(candidate.read_bytes()).hexdigest()}  {candidate.name}\n')
        edits = [('/opt/monitor', self.root), ('/etc/systemd/system/monitor-agent.service',self.unit),('/etc/init.d/monitor-agent', self.openrc)]
        if openrc:
            edits += [('if command -v systemctl >/dev/null; then','if false; then')]
        result = self.installer('install.sh', edits, ['--offline-dir',str(self.base)])
        self.assertEqual(result.returncode, int(fail), result.stderr)
        self.assertEqual(env.read_text(), config); self.assertEqual(unit.read_bytes(), before)
        self.assertEqual(binary.read_text(), 'old' if fail else 'new')
        self.assertFalse((self.base/'network').exists())

    def hub_failure(self, old_healthy):
        import sqlite3
        data = self.root/'data'; data.mkdir()
        with sqlite3.connect(data/'monitor.db') as db:
            db.execute('CREATE TABLE setting(key TEXT)')
        previous = self.root/'monitor-hub'; previous.write_text('old'); previous.chmod(0o755)
        old_unit = 'ExecStart=/unused --listen 127.0.0.1:5000 --db unused\n'
        self.unit.write_text(old_unit)
        self.stub('flock', ':'); self.stub('ss', ':')
        self.stub('install', '''if [ "$1" = -d ]; then for value in "$@"; do path=$value; done; mkdir -p "$path"; else /usr/bin/install "$@"; fi''')
        self.stub('systemctl', f'''case "$*" in *timer*|*backup*) exit 3;; esac
if [ "$1" = start ] && ! grep -qx old '{previous}'; then touch '{data}/new-schema'; fi
exit 0''')
        candidate = self.base/'candidate'; candidate.write_text('#!/bin/sh\nexit 0\n')
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        old_healthy_code = 'true' if old_healthy else 'false'
        self.stub('curl', f'''case "$*" in
 *redirect_url*) echo 'https://example.invalid/download/v1/mock';;
 *sha256sums*) for arg in "$@"; do out=$arg; done; echo '{digest}  monitor-hub-x86_64-unknown-linux-musl' > "$out";;
 *download/*/monitor*) for arg in "$@"; do out=$arg; done; cp '{candidate}' "$out";;
 *127.0.0.1:5000*) grep -qx old '{previous}' && {old_healthy_code} || exit 22; echo '{{"authed":false}}';;
 *) exit 22;; esac''')
        result = self.installer('install-hub.sh', [('/opt/monitor',self.root),('/etc/systemd/system/monitor-hub.service',self.unit)], ['--port','5001'])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('已验证原运行状态' if old_healthy else '原服务未通过恢复检查', result.stderr)
        self.assertEqual(previous.read_text(),'old'); self.assertEqual(self.unit.read_text(),old_unit)
        self.assertFalse((data/'new-schema').exists()); self.assertTrue((data/'monitor.db').exists())

    def test_unhealthy_hub_restores_unit_data_and_original_port(self): self.hub_failure(True)
    def test_unhealthy_rollback_is_reported(self): self.hub_failure(False)

    def test_systemd_offline(self): self.offline()
    def test_openrc_offline(self): self.offline(openrc=True)
    def test_systemd_rollback(self): self.offline(fail=True)
    def test_openrc_rollback(self): self.offline(openrc=True, fail=True)


if __name__ == '__main__':
    unittest.main()
