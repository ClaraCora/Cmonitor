#!/usr/bin/env python3
"""Opt-in maintenance for the packaged Linux monitor-agent. Python >= 3.8."""
import fcntl
import hashlib
import http.client
import json
import os
import platform
import random
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
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
    headers = {'User-Agent': 'Cmonitor-updater/2'}
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


NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError, http.client.IncompleteRead)


def release_bytes(url, limit):
    # Many nodes become eligible together. Only retry transport errors and
    # transient HTTP statuses; never retry away a checksum mismatch.
    for attempt in range(4):
        try:
            return fetch(url, limit)
        except urllib.error.HTTPError as exc:
            if exc.code not in (408, 425, 429, 500, 502, 503, 504) or attempt == 3:
                raise
            retry_after = (exc.headers.get('Retry-After') or '') if exc.headers else ''
            delay = min(int(retry_after), 20) if retry_after.isdecimal() else 0
        except NETWORK_ERRORS:
            if attempt == 3:
                raise
            delay = 0
        time.sleep(max(delay, random.uniform(0.5, 1.5) * 2 ** attempt))


def checked_binary(server, target, current):
    validate_target(current, target)
    arch = platform.machine()
    if arch not in ('x86_64', 'aarch64'):
        raise ValueError('unsupported architecture')
    asset = 'monitor-agent-' + arch + '-unknown-linux-musl'
    sums = release_bytes(OFFICIAL + 'v' + target + '/sha256sums.txt', 8192).decode('ascii')
    hashes = re.findall(r'^([0-9a-f]{64}) [ *]' + re.escape(asset) + r'$', sums, re.M)
    image = release_bytes(server + '/agent/' + arch, 32 * 1024 * 1024)
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


def sync_dir():
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_file(path, data, mode):
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        staging = Path(tmp) / 'new'
        with staging.open('wb') as out:
            out.write(data)
            out.flush()
            os.fchmod(out.fileno(), mode)
            os.fsync(out.fileno())
        os.replace(staging, path)
        sync_dir()


def link_replace(source, dest):
    with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
        link = Path(tmp) / 'link'
        os.link(source, link)
        os.replace(link, dest)
        sync_dir()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checkpoint(state, **changes):
    state.update(changes)
    write_file(ROOT / '.agent-updater.state', json.dumps(state).encode(), 0o600)


def complete(state, status):
    print('monitor-agent batch {}: {}'.format(state['job']['batch'], status), flush=True)
    (ROOT / '.agent-updater.candidate').unlink(missing_ok=True)
    (ROOT / '.agent-updater.state').unlink()
    sync_dir()


def valid_job(job):
    return (isinstance(job, dict) and job.get('protocol') == 2 and
            type(job.get('batch')) is int and job['batch'] > 0 and
            isinstance(job.get('attempt'), str) and re.fullmatch(r'[a-f0-9]{32}', job['attempt']) and
            isinstance(job.get('target'), str) and re.fullmatch(VERSION, job['target']))


TERMINAL = {'verified', 'failed', 'skipped', 'rolled_back', 'unconfirmed', 'unknown', 'rollback_failed'}


def decision(reply):
    if not isinstance(reply, dict) or not isinstance(reply.get('status'), str):
        raise ValueError('missing Hub upgrade decision')
    return reply['status']


def restore_image(state, deadline=None):
    # An operator may already have replaced either file. Never undo that change.
    if digest(PREVIOUS) != state['old'] or digest(BIN) not in (state['new'], state['old']):
        raise ValueError('installed or previous image no longer matches this attempt')
    if deadline is not None and time.time() >= deadline:
        return False
    link_replace(PREVIOUS, BIN)
    restart_healthy()
    return True


def record_restore(state, success, deadline=None):
    try:
        if not restore_image(state, deadline):
            return
    except (OSError, ValueError, subprocess.SubprocessError):
        success = 'rollback_failed'
    checkpoint(state, phase='failed', error=success)


def prepare(state, server):
    # Keep files from the same filesystem, in order, before asking for permission
    # to replace the live executable. A lost apply response is safe to replay.
    candidate = ROOT / '.agent-updater.candidate'
    try:
        image = checked_binary(server, state['job']['target'], version(BIN))
        write_file(candidate, image, 0o755)
        if version(candidate) != state['job']['target']:
            raise ValueError('unexpected release version')
        link_replace(BIN, PREVIOUS)
        checkpoint(state, phase='prepared', old=digest(PREVIOUS), new=digest(candidate))
    except NETWORK_ERRORS as exc:
        print('Agent release download failed: ' + type(exc).__name__, file=sys.stderr, flush=True)
        checkpoint(state, phase='failed', error='download')
    except (ValueError, OSError, IndexError, subprocess.SubprocessError) as exc:
        print('Agent release verification failed: ' + type(exc).__name__, file=sys.stderr, flush=True)
        checkpoint(state, phase='failed', error='verify')


def resume(state, server, request):
    job = state['job']
    def call(action, **extra):
        return request(action, batch=job['batch'], attempt=job['attempt'], **extra)

    if state['phase'] == 'download':
        prepare(state, server)
    if state['phase'] in ('prepared', 'swapping'):
        current = digest(BIN)
        if current == state['old']:
            candidate = ROOT / '.agent-updater.candidate'
            if digest(candidate) != state['new'] or digest(PREVIOUS) != state['old']:
                checkpoint(state, phase='failed', error='verify')
            elif call('apply') != job:
                status = decision(call('status'))
                if status in TERMINAL:
                    complete(state, status)
                return
            else:
                checkpoint(state, phase='swapping')
                os.replace(candidate, BIN)
                sync_dir()
        elif current != state['new'] or state['phase'] != 'swapping':
            checkpoint(state, phase='failed', error='verify')
        if state['phase'] == 'swapping':
            try:
                restart_healthy()
            except (OSError, subprocess.SubprocessError):
                checkpoint(state, phase='restore_local')
            else:
                checkpoint(state, phase='receipt')
    if state['phase'] == 'restore_local':
        record_restore(state, 'restart')
    if state['phase'] == 'receipt':
        status = decision(call('installed'))
        if status in TERMINAL:
            complete(state, status)
            return
        if status == 'observing':
            checkpoint(state, phase='observe')
            return
        if status not in ('rolling_back', 'rollback_pending'):
            return
        checkpoint(state, phase='observe')
    if state['phase'] == 'restore_authorized' and digest(BIN) == state['old']:
        # An interruption after the authorized rename but before recording the
        # restart. Only finish starting the already-restored image, even if the
        # Hub is now unreachable. No replacement with an expired grant.
        try:
            restart_healthy()
        except (OSError, subprocess.SubprocessError):
            checkpoint(state, phase='failed', error='rollback_failed')
        else:
            checkpoint(state, phase='failed', error='rolled_back')
    if state['phase'] in ('observe', 'restore_authorized'):
        status = decision(call('status'))
        if status in TERMINAL:
            complete(state, status)
            return
        if status in ('rolling_back', 'rollback_pending'):
            grant = call('rollback')
            # A Hub restart or interrupted response cannot authorize a local
            # rollback. Repeat the grant request on recovery, also checking its
            # expiry and both on-disk image digests before touching the service.
            if (decision(grant) != 'rollback' or type(grant.get('deadline')) is not int
                    or time.time() >= grant['deadline']):
                return
            checkpoint(state, phase='restore_authorized')
            record_restore(state, 'rolled_back', grant['deadline'])
    if state['phase'] == 'failed':
        status = decision(call('failed', error=state['error']))
        if status in TERMINAL:
            complete(state, status)


def once():
    server, token = connection()
    # An empty marker was written by the old worker only while replacing the
    # binary; an interrupted v1 transaction keeps its original recovery rule.
    if PENDING.exists():
        link_replace(PREVIOUS, BIN)
        restart_healthy()
        PENDING.unlink()
        sync_dir()

    def request(action, **fields):
        return json.loads(fetch(server + '/api/agent/upgrade', 2048,
                                json.dumps(dict(action=action, protocol=2, **fields)).encode(), token))

    journal = ROOT / '.agent-updater.state'
    identity = hashlib.sha256((server + '\0' + token).encode()).hexdigest()
    if journal.exists():
        state = json.loads(journal.read_text())
        if state.get('identity') != identity or not valid_job(state.get('job')):
            raise ValueError('upgrade journal belongs to a different identity or is damaged')
    else:
        job = request('poll')
        if job is None:
            return
        if not valid_job(job):
            raise ValueError('Hub must support the recoverable upgrade protocol')
        state = dict(identity=identity, job=job)
        checkpoint(state, phase='download')
    resume(state, server, request)


def enable():
    connection()  # Refuse plaintext before installing any service or schedule.
    # The installer can select a parallel distro interpreter on a host whose
    # default python3 is too old. Persist the interpreter that actually ran enable.
    python = str(Path(sys.executable).resolve(strict=True))
    trusted(Path(python))
    if not re.fullmatch(r'/[A-Za-z0-9_./+-]+', python):
        raise ValueError('unsupported Python path for the service')
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
