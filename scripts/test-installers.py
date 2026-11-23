#!/usr/bin/env python3
"""Exercise the distributed shell installers with isolated paths and stub init systems."""
import hashlib
import os
import shlex
import shutil
import sys
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
        self.stub('sha256sum', shlex.quote(sys.executable) + ''' -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest()," ",sys.argv[1])' "$1"''')

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

    def offline(self, openrc=False, fail=False, downgrade=False, allow=False):
        self.stub('curl', f'touch {self.base}/network; exit 1')
        self.stub('rc-update', ':')
        self.stub('systemctl', f'''case "$1" in restart) ! grep -q bad '{self.root}/monitor-agent';; *) exit 0;; esac''')
        self.stub('rc-service', f'''case "$2" in restart) ! grep -q bad '{self.root}/monitor-agent';; *) exit 0;; esac''')
        config = 'MONITOR_SERVER=http://198.51.100.1:1234\nMONITOR_TOKEN=fixture\nMONITOR_DISABLE_TERMINAL=true\nMONITOR_NET_INCLUDE=eth0\n'
        env = self.root / 'agent.env'; env.write_text(config); env.chmod(0o600)
        old = '#!/bin/sh\necho monitor-agent 1.2.0\n'
        binary = self.root / 'monitor-agent'; binary.write_text(old); binary.chmod(0o755)
        unit = self.openrc if openrc else self.unit
        unit.write_text('command_args="--interval 11 --insecure"\n' if openrc else 'ExecStart=/opt/monitor/monitor-agent --interval 11 --insecure\n')
        before = unit.read_bytes()
        new = '#!/bin/sh\necho monitor-agent {}\n# {}\n'.format('1.1.9' if downgrade else '1.2.1', 'bad' if fail else 'good')
        candidate = self.base / 'monitor-agent-x86_64-unknown-linux-musl'; candidate.write_text(new)
        (self.base/'sha256sums.txt').write_text(f'{hashlib.sha256(candidate.read_bytes()).hexdigest()}  {candidate.name}\n')
        edits = [('/opt/monitor', self.root), ('/etc/systemd/system/monitor-agent.service',self.unit),('/etc/init.d/monitor-agent', self.openrc)]
        if openrc:
            edits += [('if command -v systemctl >/dev/null; then','if false; then')]
        args = ['--offline-dir', str(self.base)] + (['--allow-downgrade'] if allow else [])
        result = self.installer('install.sh', edits, args)
        rejected = fail or (downgrade and not allow)
        self.assertEqual(result.returncode, int(rejected), result.stderr)
        self.assertEqual(env.read_text(), config); self.assertEqual(unit.read_bytes(), before)
        self.assertEqual(binary.read_text(), old if rejected else new)
        if not rejected:
            previous = self.root / '.agent-offline.previous'
            self.assertEqual(previous.read_text(), old)
            self.assertEqual(self.installer('install.sh', edits, args).returncode, 0)
            self.assertEqual(previous.read_text(), old, 'identical reinstall preserves rollback point')
        self.assertFalse((self.base/'network').exists())

    def online_fixture(self, *, openrc=False, package_manager=None, python=True):
        # Simulate command discovery too: a missing guest interpreter or
        # package manager must never fall through to one installed on the host.
        self.env['PATH'] = str(self.tools)
        for name in ('awk', 'cat', 'chmod', 'cmp', 'cp', 'cut', 'date', 'dirname', 'grep',
                     'head', 'hostname', 'install', 'mkdir', 'mktemp', 'mv', 'rm', 'sed',
                     'sh', 'touch', 'tr'):
            (self.tools / name).symlink_to(shutil.which(name))
        self.calls = self.base / 'commands'
        self.calls.touch()
        self.env.update(FIXTURE=str(self.base), CALLS=str(self.calls))
        self.edits = [
            ('/opt/monitor', self.root),
            ('/etc/systemd/system/monitor-agent.service', self.unit),
            ('/etc/init.d/monitor-agent', self.openrc),
            ('PATH="$PATH:/usr/sbin:/sbin"', 'PATH="$PATH"'),
        ]
        service = 'echo "service $*" >> "$CALLS"'
        if openrc:
            self.stub('rc-service', service)
            self.stub('rc-update', service)
        else:
            self.stub('systemctl', service)
        self.image = self.base / 'monitor-agent-x86_64-unknown-linux-musl'
        self.image.write_text('#!/bin/sh\necho monitor-agent 1.2.1\n')
        (self.base / 'sha256sums.txt').write_text(
            f'{hashlib.sha256(self.image.read_bytes()).hexdigest()}  {self.image.name}\n')
        self.env['FIXTURE_WORKER'] = str(ROOT / 'deploy/agent-updater.py')
        self.stub('curl', '''
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in -o|--output) shift; out=$1;; http://*|https://*) url=$1;; esac
  shift
done
echo "fetch $url" >> "$CALLS"
case "$url" in
  */agent/x86_64) cp "$FIXTURE/monitor-agent-x86_64-unknown-linux-musl" "$out";;
  */agent/x86_64/sha256) cut -d " " -f 1 "$FIXTURE/sha256sums.txt";;
  https://hub.example/agent-updater.py/sha256)
    if [ -n "$out" ]; then sha256sum "$FIXTURE_WORKER" | cut -d " " -f 1 > "$out"
    else sha256sum "$FIXTURE_WORKER" | cut -d " " -f 1; fi;;
  https://hub.example/agent-updater.py)
    [ ! -e "$FIXTURE/no-download" ] || exit 22
    if [ -e "$FIXTURE/corrupt" ]; then echo damaged > "$out"; else cp "$FIXTURE_WORKER" "$out"; fi;;
  */api/agent/register) echo fixture-issued-token;;
  *) echo "unexpected URL: $url" >&2; exit 1;;
esac''')
        self.stub('python3', '''
case " $* " in
  *" enable ")
    echo "enable" >> "$CALLS"
    test "$1" = "-I" || exit 2
    test -s "$FIXTURE/monitor/agent.env" || exit 2
    for arg do case "$arg" in /*) cmp -s "$arg" "$FIXTURE_WORKER" || exit 2;; esac; done
    test ! -e "$FIXTURE/enable-fails";;
  *) test -f "$FIXTURE/has-python";;
esac''')
        if python:
            (self.base / 'has-python').touch()
        else:
            # Installing the package puts python3 on PATH for the next probe.
            (self.tools / 'python3').rename(self.base / 'python-pending')
        if package_manager:
            self.stub(package_manager, '''
echo "package $*" >> "$CALLS"
[ ! -f "$FIXTURE/package-fails" ] || exit 1
case " $* " in *" python3 "*)
    cp "$FIXTURE/python-pending" "$FIXTURE/bin/python3" && touch "$FIXTURE/has-python";;
esac''')

    def install_online(self, args=None, server='https://hub.example', register=False, success=True):
        identity = ['--register', 'fixture-enroll'] if register else ['--token', 'fixture-token']
        command = ['--server', server, *identity, *(args or [])]
        proc = self.installer('install.sh', self.edits, command)
        self.assertEqual(proc.returncode == 0, success, proc.stderr + proc.stdout)
        self.assertEqual((self.root / 'monitor-agent').read_bytes(), self.image.read_bytes())
        self.assertIn('MONITOR_TOKEN=' + ('fixture-issued-token' if register else 'fixture-token'),
                      (self.root / 'agent.env').read_text())
        return self.calls.read_text().splitlines(), proc.stdout + proc.stderr

    def test_first_https_registration_enables_worker_after_agent_starts(self):
        self.online_fixture(package_manager='apt-get')
        calls, _ = self.install_online(register=True)
        self.assertIn('fetch https://hub.example/api/agent/register', calls)
        self.assertIn('fetch https://hub.example/agent-updater.py/sha256', calls)
        self.assertEqual(calls.count('enable'), 1)
        self.assertLess(calls.index('service restart monitor-agent'), calls.index('enable'))
        self.assertFalse(any(c.startswith('package ') for c in calls))

    def test_openrc_installs_missing_python_before_enabling(self):
        self.online_fixture(python=False, openrc=True, package_manager='apk')
        calls, _ = self.install_online()
        self.assertTrue(any(c.startswith('package ') and 'python3' in c for c in calls))
        self.assertLess(calls.index('service monitor-agent restart'), calls.index('enable'))

    def test_enterprise_linux_uses_parallel_python_if_default_is_too_old(self):
        self.online_fixture(python=False)
        self.stub('python3', 'exit 1')
        self.stub('dnf', '''
echo "package $*" >> "$CALLS"
case " $* " in *" python3.11 "*)
  cp "$FIXTURE/python-pending" "$FIXTURE/bin/python3.11" && touch "$FIXTURE/has-python";;
esac''')
        calls, _ = self.install_online()
        self.assertEqual([c for c in calls if c.startswith('package ')],
                         ['package -y install python3', 'package -y install python3.11'])
        self.assertEqual(calls.count('enable'), 1)

    def test_python_package_failure_leaves_agent_and_can_be_retried(self):
        self.online_fixture(python=False, package_manager='apt-get')
        flag = self.base / 'package-fails'
        flag.touch()
        calls, msg = self.install_online(success=False)
        self.assertNotIn('enable', calls)
        self.assertIn('--updater-only', msg)
        config = (self.root / 'agent.env').read_bytes()
        unit = self.unit.read_bytes()
        self.calls.write_text('')
        flag.unlink()
        repaired = self.installer('install.sh', self.edits, ['--updater-only'])
        self.assertEqual(repaired.returncode, 0, repaired.stderr + repaired.stdout)
        self.assertIn('enable', self.calls.read_text().splitlines())
        self.assertNotIn('fetch https://hub.example/agent/x86_64', self.calls.read_text())
        self.assertNotIn('restart monitor-agent', self.calls.read_text())
        self.assertEqual((self.root / 'agent.env').read_bytes(), config)
        self.assertEqual(self.unit.read_bytes(), unit)

    def test_bad_updater_checksum_preserves_working_agent(self):
        self.online_fixture()
        (self.base / 'corrupt').touch()
        calls, _ = self.install_online(success=False)
        self.assertNotIn('enable', calls)
        self.assertTrue(self.unit.exists())

    def test_enable_failure_preserves_working_agent(self):
        self.online_fixture()
        (self.base / 'enable-fails').touch()
        calls, msg = self.install_online(success=False)
        self.assertEqual(calls.count('enable'), 1)
        self.assertTrue(self.unit.exists())
        self.assertIn('--updater-only', msg)

    def test_http_node_never_enrolls_or_installs_python(self):
        self.online_fixture(python=False, package_manager='apt-get')
        calls, _ = self.install_online(args=['--insecure'], server='http://hub.example')
        self.assertIn('--insecure', self.unit.read_text())
        self.assertFalse(any(c.startswith('package ') or 'agent-updater' in c for c in calls))
        self.calls.write_text('')
        fail = self.installer('install.sh', self.edits, ['--updater-only'])
        self.assertNotEqual(fail.returncode, 0)
        self.assertFalse(self.calls.read_text(), 'updater-only must reject HTTP without side effects')

    def test_https_opt_out_survives_ordinary_reinstallation(self):
        self.online_fixture(python=False, package_manager='apt-get')
        self.install_online(args=['--no-updater'])
        self.install_online()
        calls = self.calls.read_text().splitlines()
        self.assertFalse(any(c.startswith('package ') or 'agent-updater' in c or c == 'enable' for c in calls))

    def test_reinstall_retains_previously_enabled_updater(self):
        self.online_fixture()
        self.install_online()
        worker = self.root / 'agent-updater.py'
        worker.write_text('locally enrolled worker')
        self.calls.write_text('')
        calls, _ = self.install_online(args=['--no-updater'])
        self.assertEqual(worker.read_text(), 'locally enrolled worker')
        self.assertFalse(any(c.startswith('package ') or 'agent-updater' in c or c == 'enable' for c in calls))

    def test_insecure_flag_skips_enrollment_even_with_https_address(self):
        self.online_fixture(python=False, package_manager='apt-get')
        calls, _ = self.install_online(args=['--insecure'])
        self.assertFalse(any(c.startswith('package ') or 'agent-updater' in c for c in calls))

    def test_offline_https_install_skips_updater_and_dependency(self):
        self.online_fixture(python=False, package_manager='apt-get')
        calls, _ = self.install_online(args=['--offline-dir', str(self.base)])
        self.assertFalse(any(c.startswith(('fetch ', 'package ')) or c == 'enable' for c in calls))

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
    def test_offline_downgrade_requires_explicit_choice(self): self.offline(downgrade=True)
    def test_offline_downgrade_opt_in(self): self.offline(downgrade=True, allow=True)


if __name__ == '__main__':
    unittest.main()
