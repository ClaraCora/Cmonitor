#!/usr/bin/env python3
"""Invoked by the ignored Rust rollout E2E test. Network and files stay local."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import runpy
import sys
import tempfile
import threading
import time
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parent
WebSocket = runpy.run_path(str(SCRIPTS / 'security-smoke.py'))['WebSocket']
PORT, SOURCE = map(int, sys.argv[1:3])
TARGET = sys.argv[3]
OLD = '0.0.1'
PUBLIC = 'https://hub.example.test'
LOCAL = f'http://127.0.0.1:{PORT}'
METRICS = dict(boot_id='fixture', uptime=10, cpu=0, load=[0, 0, 0], mem_total=1024, mem_used=0,
               swap_total=0, swap_used=0, disk_total=1024, disk_used=0, net_rx=0, net_tx=0,
               tcp=0, udp=0, procs=1, net_rx_total=0, net_tx_total=0)


def admin(path, data=None):
    connection = http.client.HTTPConnection('127.0.0.1', PORT, timeout=10)
    try:
        connection.request('GET' if data is None else 'POST', path, None if data is None else json.dumps(data),
                           {'cookie': os.environ['ROLLOUT_TEST_COOKIE'], 'content-type': 'application/json'})
        response = connection.getresponse()
        payload = response.read()
        assert response.status == 200, (path, response.status)
        return json.loads(payload)
    finally:
        connection.close()


def wait(check, label):
    end = time.monotonic() + 15
    while time.monotonic() < end:
        if check():
            return
        time.sleep(0.05)
    raise AssertionError(f'timed out waiting for {label}')


class FixtureNode:
    def __init__(self, item, root, canary):
        self.id = item['id']
        self.token = item['token']
        self.root = root / str(self.id)
        self.root.mkdir()
        self.binary = self.root / 'monitor-agent'
        self.binary.write_text(f"#!/bin/sh\necho 'monitor-agent {OLD}'\n")
        self.binary.chmod(0o755)
        self.env = self.root / 'agent.env'
        self.env.write_text(f'MONITOR_SERVER={PUBLIC}\nMONITOR_TOKEN={self.token}\n')
        self.env.chmod(0o600)
        if not canary:
            grant = self.root / 'agent-maintenance.json'
            grant.write_text(json.dumps(admin(f'/api/nodes/{self.id}/maintenance', {'action': 'grant'})))
            grant.chmod(0o600)
        self.arch = 'x86_64' if canary else 'aarch64'
        self.channel = None
        self.restarts = 0
        self.attempts = []
        self.drop_receipt = False
        self.restart_barrier = None
        self.worker = self.load_worker()
        self.report()

    def pair_from_command(self):
        helper = SCRIPTS.parent / 'deploy/agent-pair.py'
        issued = admin(f'/api/nodes/{self.id}/maintenance/pair-command', {})
        command = issued['command']
        tickets = re.findall(r'^cmp_[a-f0-9]{64}$', command, re.MULTILINE)
        assert len(tickets) == 1 and issued['expires_at'] > time.time()
        assert hashlib.sha256(helper.read_bytes()).hexdigest() in command
        assert f"--server '{PUBLIC}' --node {self.id} " in command
        spec = importlib.util.spec_from_file_location('fixture_pair', helper)
        pair = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(pair)
        pair.ROOT = self.root
        network_fetch, check_file = pair.fetch, pair.check_file

        def loopback_fetch(url, *args):
            assert url.startswith(PUBLIC + '/'), 'unexpected pairing origin'
            return network_fetch(LOCAL + url[len(PUBLIC):], *args)

        def fixture_owner(info, private):
            assert info.st_uid == os.geteuid(), 'unexpected fixture file owner'
            check_file(SimpleNamespace(st_uid=0, st_mode=info.st_mode, st_nlink=info.st_nlink), private)

        pair.fetch, pair.check_file = loopback_fetch, fixture_owner
        report = pair.local_identity(PUBLIC)
        pair.pair(PUBLIC, self.id, report, tickets[0])
        grant = json.loads((self.root / 'agent-maintenance.json').read_text())
        assert grant['node'] == self.id and grant['credential'] != report
        assert grant['report_identity'] == hashlib.sha256(report.encode()).hexdigest()

    def load_worker(self):
        spec = importlib.util.spec_from_file_location('fixture_worker', SCRIPTS.parent / 'deploy/agent-updater.py')
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        worker.ROOT = self.root
        worker.BIN, worker.ENV = self.binary, self.env
        worker.PREVIOUS, worker.PENDING = self.root / 'previous', self.root / 'pending'
        # The temporary directories belong to the test user. Packaged service and
        # ownership checks are exercised separately by the installer regressions.
        worker.trusted = lambda path: None
        worker.platform = SimpleNamespace(machine=lambda: self.arch)
        worker.OFFICIAL = f'http://127.0.0.1:{SOURCE}/'
        worker.restart_healthy = self.restart
        network_fetch = worker.fetch

        def fetch(url, limit, data=None, token=None):
            if url.startswith(PUBLIC + '/'):
                url = LOCAL + url[len(PUBLIC):]
            assert url.startswith((LOCAL + '/', worker.OFFICIAL)), 'unexpected non-local URL'
            body = json.loads(data) if data else {}
            reply = network_fetch(url, limit, data, token)
            if body.get('action') == 'installed':
                self.attempts.append(body['attempt'])
                if self.drop_receipt:
                    self.drop_receipt = False
                    raise ConnectionResetError('fixture: installed response lost after Hub accepted it')
            return reply
        worker.fetch = fetch
        return worker

    def report(self):
        self.close()
        self.channel = WebSocket(PORT, '/api/agent/ws', token=self.token)
        self.channel.send({'method': 'hello', 'params': {'agent_version': self.worker.version(self.binary)}})
        self.channel.send({'method': 'report', 'params': METRICS})

    def restart(self):
        if self.restart_barrier:
            # Every follower must have passed the Hub's apply gate before any
            # is allowed to finish reconnecting its service.
            self.restart_barrier.wait(timeout=18)
        self.restarts += 1
        self.report()

    def close(self):
        if self.channel:
            self.channel.close()
            self.channel = None


def run():
    ids = [admin('/api/nodes', {'name': f'fixture-{n}'})['id'] for n in range(20)]
    overview = lambda: admin('/api/agent-upgrades')
    with tempfile.TemporaryDirectory() as root, ExitStack() as cleanup, ThreadPoolExecutor(19) as group:
        fleet = []
        for item in sorted(admin('/api/nodes')['nodes'], key=lambda row: ids.index(row['id'])):
            node = FixtureNode(item, Path(root), item['id'] == ids[0])
            cleanup.callback(node.close)
            fleet.append(node)
        first, *followers = fleet
        wait(lambda: all(n['metrics'] for n in admin('/api/nodes')['nodes']), 'all original WebSocket reports')
        original = str(first.id)
        before = overview()
        assert before['maintenance'][original] == 'unpaired' and original not in before['workers']
        first.pair_from_command()
        list(group.map(lambda n: n.worker.once(), fleet))
        paired = overview()
        assert paired['maintenance'][original] == 'paired'
        assert paired['workers'][original]['protocol'] == 2 and paired['workers'][original]['last_seen'] > 0
        assert all(paired['nodes'][str(n)] == 'ready' for n in ids)
        admin('/api/agent-upgrades', {'nodes': ids})
        list(group.map(lambda n: n.worker.once(), followers))
        assert [i['status'] for i in overview()['batch']['items']] == ['ready'] + ['queued'] * 19
        assert all(n.restarts == 0 for n in fleet)

        first.worker.once()
        first.channel.send({'method': 'report', 'params': METRICS})
        wait(lambda: [i['status'] for i in overview()['batch']['items']] == ['verified'] + ['ready'] * 19,
             'the original canary to report the pinned version and release every follower')
        barrier = threading.Barrier(19)
        for n in followers:
            n.restart_barrier = barrier
        faulty = followers[0]
        faulty.drop_receipt = True

        def upgrade(n):
            try:
                n.worker.once()
            except ConnectionResetError:
                if n is not faulty or not n.attempts:
                    raise
                assert json.loads((n.root / '.agent-updater.state').read_text())['phase'] == 'receipt'
                # A different module instance simulates the next timer invocation
                # recovering the persisted receipt without installing twice.
                n.worker = n.load_worker()
                n.worker.once()

        list(group.map(upgrade, followers))
        for node in followers:
            node.channel.send({'method': 'report', 'params': METRICS})
        wait(lambda: overview()['batch']['status'] == 'done', '20 verified versions on the original node IDs')
        items = overview()['batch']['items']
        assert [i['node'] for i in items] == ids and all(i['status'] == 'verified' for i in items)
        def latest_reports():
            reports = admin('/api/nodes')['nodes']
            return ({n['id'] for n in reports} == set(ids)
                    and all(n['online'] and n['metrics'] and n['agent_version'] == TARGET for n in reports))
        wait(latest_reports, 'the panel snapshot to show all 20 live target versions')
        list(group.map(lambda n: n.worker.once(), fleet))
        assert len(faulty.attempts) == 2 and faulty.attempts[0] == faulty.attempts[1]
        assert all(n.restarts == 1 and not (n.root / '.agent-updater.state').exists() for n in fleet)
        print('Verified one-time pairing on the original canary, its authenticated v2 heartbeat, 19 parallel followers, one HTTP 503 and a replayed receipt.')


if __name__ == '__main__':
    run()
