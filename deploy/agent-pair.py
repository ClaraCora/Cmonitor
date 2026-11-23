#!/usr/bin/env python3
"""Pair the local HTTPS Agent to its Hub, using a one-time ticket on stdin."""
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path('/opt/monitor')
DIGEST = r'[a-f0-9]{64}'


class PairError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise PairError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def https_origin(value):
    require(re.fullmatch(r'https://[A-Za-z0-9.\-:\[\]]+/?', value), 'expected a literal HTTPS Hub origin')
    try:
        url = urllib.parse.urlsplit(value)
        require(url.hostname and url.port != 0, 'expected a valid HTTPS Hub origin')
    except ValueError:
        raise PairError('invalid Hub address or port') from None
    return value.rstrip('/')


def check_root():
    for path in (ROOT, *ROOT.parents):
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                'unsafe Agent installation directory')


def check_file(info, private, allow_hardlink=False):
    mask = 0o077 if private else 0o022
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and (allow_hardlink or info.st_nlink == 1) and not info.st_mode & mask,
            'unsafe local file ownership or permissions')


def read_private(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as file:
        check_file(os.fstat(file.fileno()), True)
        data = file.read(limit + 1)
    require(len(data) <= limit, 'local configuration is too large')
    return data


def local_identity(expected_server):
    values = {}
    for line in read_private(ROOT / 'agent.env', 65536).decode().splitlines():
        name, sep, value = line.partition('=')
        if sep and name in ('MONITOR_SERVER', 'MONITOR_TOKEN'):
            require(name not in values, 'duplicate local Agent identity setting')
            values[name] = value
    server = https_origin(values.get('MONITOR_SERVER', ''))
    require(server == expected_server, 'command belongs to a different Hub')
    token = values.get('MONITOR_TOKEN', '')
    require(re.fullmatch('[!-~]{1,1024}', token), 'invalid local Agent reporting credential')
    # Rollback snapshots can legitimately share the installed executable's inode.
    check_file((ROOT / 'monitor-agent').lstat(), False, allow_hardlink=True)
    return token


@contextlib.contextmanager
def locked(name):
    fd = os.open(ROOT / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        check_file(os.fstat(fd), False)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise PairError('maintenance is busy; retry the same command') from None
        yield
    finally:
        os.close(fd)


def sync_dir():
    fd = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def save_candidate(path, grant):
    with tempfile.NamedTemporaryFile(dir=ROOT, prefix='.pair-tmp-', delete=False) as output:
        stage = Path(output.name)
        try:
            output.write(json.dumps(grant).encode() + b'\n')
            output.flush()
            os.fsync(output.fileno())
            os.replace(stage, path)
            sync_dir()
        finally:
            stage.unlink(missing_ok=True)


def load_grant(path, binding, allow_previous_report=False):
    try:
        grant = json.loads(read_private(path, 4096))
    except FileNotFoundError:
        return None
    fields = {k: v for k, v in binding.items() if not allow_previous_report or k != 'report_identity'}
    require(isinstance(grant, dict) and all(type(grant.get(k)) is type(v) and grant[k] == v for k, v in fields.items())
            and isinstance(grant.get('report_identity'), str) and re.fullmatch(DIGEST, grant['report_identity'])
            and isinstance(grant.get('credential'), str) and re.fullmatch('cmu_' + DIGEST, grant['credential']),
            'local maintenance file belongs to another identity or is invalid')
    return grant


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise PairError('Hub redirects are not allowed')


def fetch(url, limit, token=None, payload=None):
    headers = {'User-Agent': 'Cmonitor-pair/1'}
    data = None
    if payload is not None:
        headers.update({'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        data = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers=headers)
    # Credentials are sent only to the configured Hub over verified TLS.
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
        require(response.status == 200, 'unexpected response from Hub')
        body = response.read(limit + 1)
    require(len(body) <= limit, 'Hub response is too large')
    return body


def confirm(server, grant):
    try:
        body = fetch(server + '/api/agent/upgrade', 1024, grant['credential'], {'action': 'identity', 'protocol': 2})
    except urllib.error.HTTPError as error:
        if error.code == 401:
            return False
        raise
    response = json.loads(body)
    require(isinstance(response, dict) and type(response.get('node')) is int and response['node'] == grant['node'],
            'Hub returned a different maintenance identity')
    return True


def pair(server, node, report, ticket):
    binding = {'format': 1, 'node': node, 'server': server, 'report_identity': digest(report.encode())}
    active = ROOT / 'agent-maintenance.json'
    # A command for the wrong node or an earlier reporting token must never block
    # the correct command, including when the Hub's response was lost.
    scope = digest((server + '\0' + str(node) + '\0' + binding['report_identity']).encode())
    pending = ROOT / ('.agent-pair-' + scope + '.pending')
    previous = load_grant(active, binding, allow_previous_report=True)
    if previous and previous['report_identity'] == binding['report_identity'] and confirm(server, previous):
        return
    candidate = load_grant(pending, binding)
    # Persist before redeeming: a dropped response or interrupted disk write can
    # then be reconciled using the same locally generated secret. Never save a ticket.
    if candidate is None:
        candidate = dict(binding, credential='cmu_' + secrets.token_hex(32))
        save_candidate(pending, candidate)
        recovered = False
    else:
        recovered = confirm(server, candidate)
    if not recovered:
        try:
            body = fetch(server + '/api/nodes/{}/maintenance/redeem'.format(node), 1024, report,
                         {'ticket': ticket, 'server': server, 'credential_sha256': digest(candidate['credential'].encode())})
            reply = json.loads(body)
            require(isinstance(reply, dict) and type(reply.get('node')) is int and reply['node'] == node,
                    'Hub did not confirm the expected node')
        except Exception:
            # An error, including an already-consumed ticket, is not a grant.
            # Only the authenticated identity endpoint can resolve an ambiguous result.
            if not confirm(server, candidate):
                raise
    os.replace(pending, active)
    sync_dir()


def run(server, node, installer_hash, ticket):
    server = https_origin(server)
    require(0 < node <= (1 << 63) - 1 and re.fullmatch(DIGEST, installer_hash), 'invalid node or installer digest')
    require(re.fullmatch('cmp_' + DIGEST, ticket), 'invalid pairing ticket')
    check_root()
    with locked('.agent-pair.lock'):
        # Use the existing installer to configure both systemd and OpenRC workers.
        # --updater-only obtains the same worker lock, so release it before exec.
        with locked('.agent-updater.lock'):
            require(not os.path.lexists(ROOT / '.agent-install.recovery'), 'finish the interrupted Agent installation first')
            report = local_identity(server)
            installer = fetch(server + '/install.sh', 262144)
            require(digest(installer) == installer_hash, 'installer SHA-256 mismatch; copy a fresh command from the Hub')
            pair(server, node, report, ticket)
        with tempfile.TemporaryDirectory(dir=ROOT, prefix='.pair-install-') as stage:
            path = Path(stage) / 'install.sh'
            path.write_bytes(installer)
            command = subprocess.run(['/bin/sh', str(path), '--updater-only'], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True,
                                     env={'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root'})
            require(command.returncode == 0, 'credential saved; retry this command to finish enabling the upgrade service')
    print('This node is paired and its upgrade service is enabled.')


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--server', required=True)
    cli.add_argument('--node', type=int, required=True)
    cli.add_argument('--installer-sha256', required=True)
    args = cli.parse_args()
    try:
        require(os.geteuid() == 0, 'run as root on the selected node')
        os.umask(0o077)
        line = sys.stdin.buffer.readline(80).decode('ascii').rstrip('\r\n')
        run(args.server, args.node, args.installer_sha256, line)
    except urllib.error.HTTPError as error:
        sys.exit('Hub rejected pairing (HTTP {}); check the node, ticket and Hub address.'.format(error.code))
    except PairError as error:
        sys.exit(str(error))
    except (OSError, ValueError, KeyError, EOFError, http.client.HTTPException):
        # Never print server text, headers, local configuration, tickets or secrets.
        sys.exit('Could not finish pairing. Check HTTPS connectivity and local files, then retry the same command.')


if __name__ == '__main__':
    main()
