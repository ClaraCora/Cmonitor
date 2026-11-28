#!/usr/bin/env python3
"""Exercise the distributed shell installers with isolated paths and stub init systems."""
import fcntl
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
        # Model Linux root ownership on the developer host; preserve actual mode
        # bits so an unsafe writable file is still rejected.
        py = shlex.quote(sys.executable)
        self.stub('stat', py + """ -c 'import os,stat,sys; print("0:%o" % stat.S_IMODE(os.lstat(sys.argv[1]).st_mode))' "$3" """)
        self.stub('flock', py + """ -c 'import fcntl,sys; fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)' "$2" """)
        self.stub('sync', ':')
        # Linux CI uses the platform implementations for checksums and flock.
        if sys.platform == 'linux':
            (self.tools / 'flock').unlink()
            (self.tools / 'flock').symlink_to(shutil.which('flock'))
        sha = shutil.which('sha256sum')
        if sha:
            (self.tools / 'sha256sum').symlink_to(sha)
        else:
            self.stub('sha256sum', 'exec ' + shlex.quote(shutil.which('shasum')) + ' -a 256 "$@"')

    def stub(self, name, script):
        p = self.tools / name
        # Fixtures may link to a platform tool, e.g. flock on the Linux runner.
        p.unlink(missing_ok=True)
        p.write_text('#!/bin/sh\n' + script + '\n')
        p.chmod(0o755)

    def installer(self, name, edits, args):
        s = (ROOT / name).read_text()
        if name != 'install-hub.sh':
            s = s.replace('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'PATH="$PATH"')
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
method=GET
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o|--output) shift; out=$1;;
    --data-binary) method=POST;;
    http://*|https://*) url=$1;;
  esac
  shift
done
if [ "$url" = https://hub.example/api/agent/register ] && [ "$method" = GET ]; then
  echo "check registration" >> "$CALLS"
  IFS= read -r header || exit 1
  case "$header" in "Authorization: Bearer "?*) ;; *) exit 1;; esac
  if [ -e "$FIXTURE/status-error" ]; then exit 22; fi
  if [ -e "$FIXTURE/deleted" ] && [ "$header" = "Authorization: Bearer fixture-token" ]; then
    echo unregistered
  else echo registered; fi
  exit 0
fi
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
  */api/agent/register) if [ -f "$FIXTURE/registration" ]; then cat "$FIXTURE/registration"; else printf "%064d\\n" 1; fi;;
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
        self.assertIn('MONITOR_TOKEN=' + (f'{1:064d}' if register else 'fixture-token'),
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
        refused = self.installer('install.sh', self.edits, ['--server', 'http://hub.example', '--token', 'existing', '--insecure'])
        self.assertNotEqual(refused.returncode, 0)
        self.assertFalse(self.calls.read_text())
        self.assertFalse((self.root / 'monitor-agent').exists())
        calls, _ = self.install_online(args=['--offline-dir', str(self.base), '--insecure'], server='http://hub.example')
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

    def test_https_registration_pairs_without_exposing_maintenance_to_agent(self):
        self.online_fixture()
        credential = '{"format":1,"credential":"private-maintenance-fixture"}'
        (self.base / 'registration').write_text(f'{1:064d}\n{credential}\n')
        calls, msg = self.install_online(register=True)
        maintenance = self.root / 'agent-maintenance.json'
        self.assertEqual(maintenance.read_text(), credential + '\n')
        self.assertEqual(maintenance.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private-maintenance', (self.root / 'agent.env').read_text() + msg)
        self.assertIn('enable', calls)

    def test_registration_failure_does_not_start_agent_or_install_unexpected_lines(self):
        self.online_fixture()
        for value in ('short', 'A' * 64, f'{1:064d}\nnot-json', f'{1:064d}\n{{}}\nextra'):
            (self.base / 'registration').write_text(value)
            proc = self.installer('install.sh', self.edits, ['--server', 'https://hub.example', '--register', 'enroll'])
            self.assertNotEqual(proc.returncode, 0)
            self.assertFalse((self.root / 'agent.env').exists())
        self.assertNotIn('service ', self.calls.read_text())

    def test_retry_reuses_the_registered_identity_after_init_failure(self):
        self.online_fixture()
        self.stub('systemctl', 'test "$1" != restart')
        args = ['--server', 'https://hub.example', '--register', 'fixture-enroll']
        self.assertNotEqual(self.installer('install.sh', self.edits, args).returncode, 0)
        self.assertTrue((self.root / '.agent-registration.pending').is_dir())
        self.stub('systemctl', ':')
        args[-1] = 'reopened-window'
        proc = self.installer('install.sh', self.edits, args)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.calls.read_text().count('/api/agent/register'), 1)
        self.assertFalse((self.root / '.agent-registration.pending').exists())

    def test_deleted_openrc_node_reenrolls_then_reuses_new_report_and_grant(self):
        self.online_fixture(openrc=True)
        self.install_online()
        key = self.root / 'agent-maintenance.json'
        key.write_text('old node credential')
        (self.base / 'deleted').touch()
        new_grant = '{"credential":"new-node-key"}'
        (self.base / 'registration').write_text(f'{1:064d}\n{new_grant}\n')
        self.calls.write_text('')
        calls, _ = self.install_online(register=True)
        self.assertEqual(key.read_text(), new_grant + '\n')
        self.assertEqual(calls.count('enable'), 1)
        calls, _ = self.install_online(register=True)
        self.assertEqual(calls.count('fetch https://hub.example/api/agent/register'), 1)
        self.assertEqual(calls.count('check registration'), 2)
        self.assertEqual(calls.count('enable'), 1)

    def test_registration_check_failure_preserves_current_install(self):
        self.online_fixture(openrc=True)
        self.install_online()
        config = self.root / 'agent.env'
        before = config.read_bytes()
        self.calls.write_text('')
        (self.base / 'status-error').touch()
        proc = self.installer('install.sh', self.edits, ['--server', 'https://hub.example', '--register', 'enroll'])
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('could not verify', proc.stderr)
        self.assertEqual(config.read_bytes(), before)
        self.assertNotIn('service ', self.calls.read_text())
        self.assertNotIn('fetch https://hub.example/api/agent/register', self.calls.read_text())

    def test_manual_rebind_retires_old_grant_only_after_recoverable_service_change(self):
        self.online_fixture(openrc=True)
        self.install_online()
        config = self.root / 'agent.env'
        old_env = config.read_bytes()
        key = self.root / 'agent-maintenance.json'
        key.write_text('old grant')
        args = ['--server', 'https://hub.example', '--token', 'replacement']
        self.stub('rc-service', f'if [ "$2" = restart ]; then grep -q fixture-token "{config}"; fi')
        self.assertNotEqual(self.installer('install.sh', self.edits, args).returncode, 0)
        self.assertEqual(config.read_bytes(), old_env)
        self.assertEqual(key.read_text(), 'old grant')
        self.stub('rc-service', ':')
        proc = self.installer('install.sh', self.edits, args)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('MONITOR_TOKEN=replacement\n', config.read_text())
        self.assertFalse(key.exists())

    def test_shared_worker_lock_and_journal_block_replacement(self):
        self.online_fixture()
        args = ['--server', 'https://hub.example', '--token', 'fixture']
        with (self.root / '.agent-updater.lock').open('a') as locked:
            fcntl.flock(locked, fcntl.LOCK_EX)
            proc = self.installer('install.sh', self.edits, args)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn('maintenance', proc.stderr)
        for marker in ('.agent-updater.state', '.agent-updater.pending'):
            p = self.root / marker
            p.touch()
            proc = self.installer('install.sh', self.edits, args)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn('rollout', proc.stderr)
            p.unlink()
        self.assertFalse(self.calls.read_text())

    def test_worker_repair_preserves_unfinished_rollout_and_agent(self):
        self.online_fixture()
        self.install_online(args=['--no-updater'])
        journal = self.root / '.agent-updater.state'
        journal.write_text('old worker state')
        self.calls.write_text('')
        proc = self.installer('install.sh', self.edits, ['--updater-only'])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(journal.read_text(), 'old worker state')
        self.assertIn('enable', self.calls.read_text())
        self.assertNotIn('restart monitor-agent', self.calls.read_text())
        self.assertNotIn('fetch https://hub.example/agent/x86_64', self.calls.read_text())
        (self.root / '.agent-install.recovery').mkdir(mode=0o700)
        self.calls.write_text('')
        proc = self.installer('install.sh', self.edits, ['--updater-only'])
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue((self.root / '.agent-install.recovery').is_dir())
        self.assertFalse(self.calls.read_text())

    def test_recovers_interrupted_manual_replacement_on_next_run(self):
        self.online_fixture()
        backup = self.root / '.agent-install.recovery'
        backup.mkdir(mode=0o700)
        (backup / 'monitor-agent').write_text('original executable')
        (backup / 'agent.env').write_text('MONITOR_SERVER=https://previous.example\nMONITOR_TOKEN=kept\n')
        (backup / 'agent-maintenance.json').write_text('existing maintenance identity')
        (backup / 'saved-unit').write_text('original unit')
        (backup / 'was-active').touch()
        (self.root / 'monitor-agent').write_text('partially applied new release')
        # Stop after the previous transaction is resolved, without starting a new installation.
        proc = self.installer('install.sh', self.edits, ['--server', 'ftp://other', '--token', 'invalid'])
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual((self.root / 'monitor-agent').read_text(), 'original executable')
        self.assertEqual(self.unit.read_text(), 'original unit')
        self.assertEqual((self.root / 'agent-maintenance.json').read_text(), 'existing maintenance identity')
        self.assertFalse(backup.exists())
        self.assertIn('restart monitor-agent', self.calls.read_text())

    def test_migrates_legacy_openrc_reader_and_preserves_literal_network_settings(self):
        self.online_fixture(openrc=True)
        self.install_online(args=['--no-updater'])
        config = self.root / 'agent.env'
        config.write_text(config.read_text() + 'MONITOR_NET_INCLUDE=eth0; literal text\nMONITOR_HTTP_PROBE_ALLOWLIST="probe.example:443=192.0.2.1|192.0.2.2"\nUNRELATED_SETTING=ignored\n')
        legacy = f'command_args="--interval 19"\nstart_pre() {{\n  set -a\n  . "{config}"\n  set +a\n}}\n'
        self.openrc.write_text(legacy)
        proc = self.installer('install.sh', self.edits, ['--offline-dir', str(self.base)])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('command_args="--interval 19"', self.openrc.read_text())
        got = subprocess.run(['sh', '-c', '. "$1"; start_pre; printf "%s/%s/%s" "$MONITOR_NET_INCLUDE" "${UNRELATED_SETTING:-unset}" "$MONITOR_HTTP_PROBE_ALLOWLIST"',
                              'sh', str(self.openrc)], capture_output=True, text=True, check=True)
        self.assertEqual(got.stdout, 'eth0; literal text/unset/probe.example:443=192.0.2.1|192.0.2.2')

    def test_unsafe_url_credential_or_writable_binary_is_rejected(self):
        self.online_fixture()
        for url, token in [('https://hub.example/\nfoo', 'abcd'), ('ftp://invalid', 'abcd'),
                           ('https://user@other', 'abcd'), ('https://hub.example', 'line1\nline2')]:
            proc = self.installer('install.sh', self.edits, ['--server', url, '--token', token])
            self.assertNotEqual(proc.returncode, 0)
        binary = self.root / 'monitor-agent'
        binary.touch()
        binary.chmod(0o777)
        proc = self.installer('install.sh', self.edits, ['--server', 'https://hub.example', '--token', 'abcd'])
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('unsafe ownership', proc.stderr)
        self.assertFalse(self.calls.read_text())

    def test_verifier_accepts_trusted_local_file_and_stops_before_extracting_on_mismatch(self):
        import tarfile
        folder = self.base / 'cmonitor-agent-offline'
        folder.mkdir()
        (folder / 'install.sh').write_text('test "$1:$2" = "--offline-dir:." && touch "$MARKER"\n')
        (folder / 'sha256sums.txt').write_text(hashlib.sha256((folder / 'install.sh').read_bytes()).hexdigest() + '  install.sh\n')
        package = self.base / 'archive.tar.gz'
        with tarfile.open(package, 'w:gz') as tar:
            tar.add(folder, arcname=folder.name)
        self.env['MARKER'] = str(self.base / 'ran')
        cache = self.base / 'cache'
        edits = [('/var/lib/cmonitor-offline', cache)]
        trusted = hashlib.sha256(package.read_bytes()).hexdigest()
        p = self.installer('deploy/agent-offline-install.sh', edits, ['0' * 64, str(package)])
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse(Path(self.env['MARKER']).exists())
        self.assertFalse(any(cache.glob('unpack.*')))
        p = self.installer('deploy/agent-offline-install.sh', edits, [trusted, str(package)])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertTrue(Path(self.env['MARKER']).is_file())

    def test_verifier_resumes_partial_http_transfer_then_verifies_exact_body(self):
        import http.server
        import tarfile
        import threading
        folder = self.base / 'cmonitor-agent-offline'
        folder.mkdir()
        (folder / 'install.sh').write_text('touch "$MARKER"\n')
        (folder / 'sha256sums.txt').write_text(hashlib.sha256((folder / 'install.sh').read_bytes()).hexdigest() + '  install.sh\n')
        package = self.base / 'archive.tar.gz'
        with tarfile.open(package, 'w:gz') as tar:
            tar.add(folder, arcname=folder.name)
        body = package.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        cache = self.base / 'cache'
        cache.mkdir(mode=0o700)
        (cache / (digest + '.part')).write_bytes(body[:32])
        observed = []
        class Serve(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                observed.append(self.headers.get('Range'))
                if observed[-1] != 'bytes=32-':
                    self.send_error(400)
                    return
                self.send_response(206)
                self.send_header('Content-Length', str(len(body) - 32))
                self.send_header('Content-Range', f'bytes 32-{len(body)-1}/{len(body)}')
                self.end_headers()
                self.wfile.write(body[32:])
            def log_message(self, *args):
                pass
        with http.server.HTTPServer(('127.0.0.1', 0), Serve) as httpd:
            t = threading.Thread(target=httpd.serve_forever, daemon=True)
            t.start()
            try:
                self.env.update(MARKER=str(self.base / 'ran'), NO_PROXY='127.0.0.1', no_proxy='127.0.0.1')
                url = f'http://127.0.0.1:{httpd.server_port}/archive'
                proc = self.installer('deploy/agent-offline-install.sh', [('/var/lib/cmonitor-offline', cache)], [digest, url])
            finally:
                httpd.shutdown(); t.join()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(observed, ['bytes=32-'])
        self.assertTrue(Path(self.env['MARKER']).exists())

    def hub_upgrade(self, old_healthy=True, new_healthy=False):
        import sqlite3
        data = self.root/'data'; data.mkdir()
        with sqlite3.connect(data/'monitor.db') as db:
            db.execute('CREATE TABLE setting(key TEXT)')
        previous = self.root/'monitor-hub'; previous.write_text('old'); previous.chmod(0o755)
        units = self.base / 'etc/systemd/system'
        lib = self.base / 'usr/local/lib'
        self.unit = units / 'monitor-hub.service'
        sg1 = ROOT / 'deploy/sg1'
        policy = {
            self.root / 'backup.py': ROOT / 'scripts/backup.py',
            lib / 'cmonitor/retention.py': sg1 / 'retention.py',
            units / 'monitor-backup.service.d/80-retention.conf': sg1 / 'monitor-backup-retention.conf',
            units / 'monitor-hub-snapshot-retention.service': sg1 / 'monitor-hub-snapshot-retention.service',
            units / 'monitor-hub-snapshot-retention.timer': sg1 / 'monitor-hub-snapshot-retention.timer',
        }
        for target, source in policy.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        active = self.base / 'active'
        enabled = units / 'timers.target.wants'
        active.mkdir()
        enabled.mkdir()
        timers = ('monitor-backup.timer', 'monitor-backup-status.timer', 'monitor-hub-snapshot-retention.timer')
        for timer in timers:
            if timer not in {path.name for path in policy}:
                shutil.copyfile(ROOT / 'deploy' / timer, units / timer)
            (active / timer).touch()
            (enabled / timer).symlink_to(units / timer)
        old_unit = 'ExecStart=/unused --listen 127.0.0.1:5000 --db unused\n'
        self.unit.write_text(old_unit)
        self.stub('flock', ':'); self.stub('ss', ':')
        self.stub('install', '''if [ "$1" = -d ]; then for value in "$@"; do path=$value; done; mkdir -p "$path"; else /usr/bin/install "$@"; fi''')
        self.stub('systemctl', f'''action=$1; shift
for unit in "$@"; do
  case "$unit" in
    *.timer) case "$action" in
      is-active) test -f '{active}'/"$unit" || exit 3;;
      start) touch '{active}'/"$unit";; stop) rm -f '{active}'/"$unit";;
      disable) rm -f '{enabled}'/"$unit";;
    esac;;
    *backup*.service) [ "$action" != is-active ] || exit 3;;
    monitor-hub) if [ "$action" = start ] && ! grep -qx old '{previous}'; then touch '{data}/new-schema'; fi;;
  esac
done
exit 0''')
        candidate = self.base/'candidate'; candidate.write_text('#!/bin/sh\nexit 0\n')
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        old_healthy_code = 'true' if old_healthy else 'false'
        self.stub('curl', f'''case "$*" in
 *redirect_url*) echo 'https://example.invalid/download/v1/mock';;
 *sha256sums*) for arg in "$@"; do out=$arg; done; echo '{digest}  monitor-hub-x86_64-unknown-linux-musl' > "$out";;
 *download/*/monitor*) for arg in "$@"; do out=$arg; done; cp '{candidate}' "$out";;
 *127.0.0.1:5001*) {'true' if new_healthy else 'false'} || exit 22; echo '{{"authed":false}}';;
 *127.0.0.1:5000*) grep -qx old '{previous}' && {old_healthy_code} || exit 22; echo '{{"authed":false}}';;
 *) exit 22;; esac''')
        edits = [('/opt/monitor', self.root), ('/etc/systemd/system', units)]
        # The current installer has no /usr/local/lib payload. Redirect it too
        # if a later installer starts managing files alongside the local policy.
        if '/usr/local/lib' in (ROOT / 'install-hub.sh').read_text():
            edits.append(('/usr/local/lib', lib))
        result = self.installer('install-hub.sh', edits, ['--port','5001'])
        for target, source in policy.items():
            self.assertEqual(target.read_bytes(), source.read_bytes(), str(target))
        for timer in timers:
            self.assertTrue((active / timer).is_file(), timer)
            self.assertEqual((enabled / timer).readlink(), units / timer)
            self.assertTrue((enabled / timer).is_file(), timer)
        if new_healthy:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(previous.read_bytes(), candidate.read_bytes())
            return
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('已验证原运行状态' if old_healthy else '原服务未通过恢复检查', result.stderr)
        self.assertEqual(previous.read_text(),'old'); self.assertEqual(self.unit.read_text(),old_unit)
        self.assertFalse((data/'new-schema').exists()); self.assertTrue((data/'monitor.db').exists())

    def test_hub_upgrade_preserves_sg1_retention_and_timers(self): self.hub_upgrade(new_healthy=True)
    def test_unhealthy_hub_restores_unit_data_and_original_port(self): self.hub_upgrade()
    def test_unhealthy_rollback_is_reported(self): self.hub_upgrade(old_healthy=False)

    def test_systemd_offline(self): self.offline()
    def test_openrc_offline(self): self.offline(openrc=True)
    def test_systemd_rollback(self): self.offline(fail=True)
    def test_openrc_rollback(self): self.offline(openrc=True, fail=True)
    def test_offline_downgrade_requires_explicit_choice(self): self.offline(downgrade=True)
    def test_offline_downgrade_opt_in(self): self.offline(downgrade=True, allow=True)


if __name__ == '__main__':
    unittest.main()
