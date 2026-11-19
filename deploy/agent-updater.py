#!/usr/bin/env python3
"""Opt-in maintenance for the packaged Linux monitor-agent. Python >= 3.8."""
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path('/opt/monitor')
BIN = ROOT / 'monitor-agent'
ENV = ROOT / 'agent.env'
WORKER = ROOT / 'agent-updater.py'
PREVIOUS = ROOT / '.agent-updater.previous'
PENDING = ROOT / '.agent-updater.pending'
VERSION = r'(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})'
OFFICIAL = 'https://github.com/ClaraCora/Cagent/releases/download/'


def trusted(path):
    for p in [path, *path.parents]:
        st = p.lstat()
        if st.st_uid != 0 or stat.S_ISLNK(st.st_mode) or st.st_mode & 0o022:
            raise ValueError('unsafe ownership or permissions: ' + str(p))


def connection():
    trusted(ENV)
    trusted(BIN)
    values = dict(line.split('=', 1) for line in ENV.read_text().splitlines() if '=' in line)
    server = values['MONITOR_SERVER'].rstrip('/')
    url = urllib.parse.urlsplit(server)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('this Agent requires offline maintenance')
    return server, values['MONITOR_TOKEN']


class Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # No redirects on Hub requests (they may carry a node token). Only
        # GitHub's HTTPS release asset hosts may serve its public checksums.
        u = urllib.parse.urlsplit(newurl)
        if (not req.full_url.startswith(OFFICIAL) or u.scheme != 'https' or u.username or u.password
                or u.hostname not in ('release-assets.githubusercontent.com', 'objects.githubusercontent.com')):
            raise ValueError('unexpected redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, limit, data=None, token=None):
    headers = {'User-Agent': 'Cmonitor-updater/1'}
    if token:
        headers.update({'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.build_opener(Redirect()).open(req, timeout=45) as response:
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError('response too large')
        return body


def version(binary):
    p = subprocess.run([str(binary), '--help'], capture_output=True, timeout=10)
    match = re.fullmatch(r'monitor-agent (' + VERSION + ')', (p.stdout + p.stderr).decode().splitlines()[0])
    if not match:
        raise ValueError('unrecognised installed Agent')
    return match[1]


def validate_target(current, target):
    if not isinstance(target, str) or not re.fullmatch(VERSION, target):
        raise ValueError('invalid version')
    if tuple(map(int, current.split('.'))) >= tuple(map(int, target.split('.'))):
        raise ValueError('target must be newer')


def checked_binary(server, target, current):
    validate_target(current, target)
    arch = platform.machine()
    if arch not in ('x86_64', 'aarch64'):
        raise ValueError('unsupported architecture')
    asset = 'monitor-agent-' + arch + '-unknown-linux-musl'
    sums = fetch(OFFICIAL + 'v' + target + '/sha256sums.txt', 8192).decode('ascii')
    hashes = re.findall(r'^([0-9a-f]{64}) [ *]' + re.escape(asset) + r'$', sums, re.M)
    image = fetch(server + '/agent/' + arch, 32 * 1024 * 1024)
    if hashes != [hashlib.sha256(image).hexdigest()]:
        raise ValueError('release checksum mismatch')
    return image


def service(action):
    if Path('/run/systemd/system').is_dir():
        args = ['systemctl', 'restart' if action == 'restart' else 'is-active', 'monitor-agent']
    else:
        args = ['rc-service', 'monitor-agent', 'restart' if action == 'restart' else 'status']
    subprocess.run(args, check=True, timeout=60, stdout=subprocess.DEVNULL)


def restart_healthy():
    service('restart')
    time.sleep(2)
    service('status')


def restore():
    # Keep the prior executable until its service is healthy, even if power is
    # lost between rename and restart.
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        old = Path(tmp) / 'old'
        os.link(PREVIOUS, old)
        os.replace(old, BIN)
    restart_healthy()
    PENDING.unlink()


def once():
    server, token = connection()
    if PENDING.exists():
        restore()

    def request(action, **fields):
        return json.loads(fetch(server + '/api/agent/upgrade', 2048,
                                json.dumps(dict(action=action, **fields)).encode(), token))

    job = request('poll')
    if job is None:
        return
    batch, target = job['batch'], job['target']
    phase = 'verify'
    try:
        image = checked_binary(server, target, version(BIN))
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            new = Path(tmp) / 'new'
            new.write_bytes(image)
            new.chmod(0o755)
            if version(new) != target:
                raise ValueError('unexpected release version')
            if request('apply', batch=batch) != job:
                return
            old = Path(tmp) / 'old'
            os.link(BIN, old)
            os.replace(old, PREVIOUS)
            phase = 'restart'
            PENDING.touch(mode=0o600, exist_ok=False)
            os.replace(new, BIN)
            restart_healthy()
            PENDING.unlink()
        request('installed', batch=batch)
        print('installed monitor-agent ' + target, flush=True)
    except Exception:
        try:
            if PENDING.exists():
                restore()
        finally:
            request('failed', batch=batch, error=phase)
        raise


def enable():
    connection()  # Refuse plaintext before installing any service or schedule.
    python = shutil.which('python3', path='/usr/bin:/usr/local/bin:/bin')
    if not python:
        raise RuntimeError('python3 not installed')
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        dest = Path(tmp) / 'worker'
        shutil.copyfile(__file__, dest)
        dest.chmod(0o700)
        os.replace(dest, WORKER)
    if Path('/run/systemd/system').is_dir():
        units = Path('/etc/systemd/system')
        (units / 'monitor-agent-updater.service').write_text(
            '[Unit]\nDescription=Check for an approved Cmonitor Agent upgrade\n[Service]\nType=oneshot\n'
            'UMask=0077\nExecStart=' + python + ' -I ' + str(WORKER) + ' once\n')
        (units / 'monitor-agent-updater.timer').write_text(
            '[Unit]\nDescription=Poll Cmonitor for Agent releases\n[Timer]\nOnBootSec=10s\n'
            'OnUnitInactiveSec=30s\nAccuracySec=3s\n[Install]\nWantedBy=timers.target\n')
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'enable', '--now', 'monitor-agent-updater.timer'], check=True)
    elif Path('/sbin/openrc-run').exists():
        service_file = Path('/etc/init.d/monitor-agent-updater')
        service_file.write_text('#!/sbin/openrc-run\ncommand="' + python + '"\ncommand_args="-I ' + str(WORKER) + ' watch"\ncommand_background=true\npidfile=/run/monitor-agent-updater.pid\ndepend() { need net; }\n')
        service_file.chmod(0o755)
        subprocess.run(['rc-update', 'add', 'monitor-agent-updater', 'default'], check=True)
        subprocess.run(['rc-service', 'monitor-agent-updater', 'restart'], check=True)
    else:
        raise RuntimeError('requires systemd or OpenRC')


def main():
    os.umask(0o077)
    if os.geteuid() or platform.system() != 'Linux' or sys.argv[1:] not in (['enable'], ['once'], ['watch']):
        sys.exit('usage (Linux root): python3 -I agent-updater.py enable|once|watch')
    trusted(ROOT)
    if sys.argv[1] == 'enable':
        enable()
        return
    while True:
        try:
            with (ROOT / '.agent-updater.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                once()
        except Exception as exc:
            if sys.argv[1] == 'once':
                raise
            print('Agent upgrade check failed: ' + type(exc).__name__, file=sys.stderr, flush=True)
        if sys.argv[1] == 'once':
            return
        time.sleep(30)


if __name__ == '__main__':
    main()
