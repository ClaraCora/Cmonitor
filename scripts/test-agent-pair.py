#!/usr/bin/env python3
"""Local pairing transaction and installer tests. No root, services or network required."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
MODULE = Path(__file__).resolve().parents[1] / 'deploy/agent-pair.py'
spec = importlib.util.spec_from_file_location('agent_pair', MODULE)
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
SERVER = 'https://hub.test:8443'
TICKET = 'cmp_' + '1' * 64
INSTALLER = b'test installer body\n'
SHA = hashlib.sha256(INSTALLER).hexdigest()

def denied(code=401):
    return urllib.error.HTTPError(SERVER, code, 'rejected', {}, None)

class Pairing(unittest.TestCase):

    def setUp(self):
        stack = self.enter_context
        root = Path(stack(tempfile.TemporaryDirectory())).resolve()
        self.root = root
        stack(patch.object(p, 'ROOT', root))
        stack(patch.object(p, 'check_root'))
        # Preserve the real permission checks and locks in unprivileged CI.
        original = p.check_file

        def mapped(info, private, allow_hardlink=False):
            adjusted = list(info)
            adjusted[stat.ST_UID] = 0 if info.st_uid == os.getuid() else info.st_uid
            return original(os.stat_result(adjusted), private, allow_hardlink)
        stack(patch.object(p, 'check_file', side_effect=mapped))
        self.binary = root / 'monitor-agent'
        self.binary.write_bytes(b'original')
        self.binary.chmod(493)
        self.config = root / 'agent.env'
        self.report = 'report-token-fixture'
        self.configure()
        self.key = root / 'agent-maintenance.json'
        self.remote_hash = None
        self.authorized_node = 17
        self.drop = False
        self.redeems = 0
        self.requests = []
        self.enable = stack(patch.object(p.subprocess, 'run', side_effect=self.installer))
        self.fetch = stack(patch.object(p, 'fetch', side_effect=self.api))
        self.stdout = stack(contextlib.redirect_stdout(io.StringIO()))

    def enter_context(self, cm):
        result = cm.__enter__()
        self.addCleanup(cm.__exit__, None, None, None)
        return result

    def configure(self, server=SERVER):
        self.config.write_text('MONITOR_SERVER=' + server + '\nMONITOR_TOKEN=' + self.report + '\n')
        self.config.chmod(384)

    def installer(self, argv, **options):
        self.assertEqual(argv[0], '/bin/sh')
        self.assertEqual(argv[2:], ['--updater-only'])
        self.assertEqual(Path(argv[1]).read_bytes(), INSTALLER)
        self.assertNotIn(TICKET, str(argv) + str(options['env']))
        # The --updater-only subprocess must be free to take its own worker lock.
        with p.locked('.agent-updater.lock'):
            return type('Process', (), {'returncode': 0})()

    def api(self, url, limit, token=None, payload=None):
        self.requests.append(url)
        if url == SERVER + '/install.sh':
            self.assertIsNone(token)
            self.assertIsNone(payload)
            return INSTALLER
        if url == SERVER + '/api/agent/upgrade':
            self.assertEqual(payload, {'action': 'identity', 'protocol': 2})
            if p.digest(token.encode()) != self.remote_hash:
                raise denied()
            return json.dumps({'node': self.authorized_node}).encode()
        self.redeems += 1
        self.assertEqual(token, self.report)
        self.assertEqual(set(payload), {'ticket', 'server', 'credential_sha256'})
        self.assertEqual(payload['server'], SERVER)
        if payload['ticket'] != TICKET or url != SERVER + '/api/nodes/{}/maintenance/redeem'.format(self.authorized_node):
            raise denied()
        self.remote_hash = payload['credential_sha256']
        if self.drop:
            raise OSError('simulated lost response')
        return json.dumps({'node': self.authorized_node}).encode()

    def run_pair(self, node=17, sha=SHA, server=SERVER):
        p.run(server, node, sha, TICKET)

    def test_fresh_pair_and_idempotent_retry_without_rotating(self):
        self.run_pair()
        grant = json.loads(self.key.read_bytes())
        self.assertEqual(grant['report_identity'], p.digest(self.report.encode()))
        self.assertEqual(self.remote_hash, p.digest(grant['credential'].encode()))
        self.assertEqual(stat.S_IMODE(self.key.stat().st_mode), 384)
        self.run_pair()
        self.assertEqual(self.redeems, 1)
        self.assertEqual(self.enable.call_count, 2)
        self.assertEqual(self.binary.read_bytes(), b'original')
        self.assertEqual(self.stdout.getvalue().count(TICKET), 0)
        self.assertFalse(list(self.root.glob('.agent-pair-*.pending')))

    def test_lost_response_reconciled_immediately(self):
        self.drop = True
        self.run_pair()
        self.assertTrue(self.key.is_file())
        self.assertEqual(self.redeems, 1)
        self.assertIn(SERVER + '/api/agent/upgrade', self.requests)

    def test_recovery_after_hub_or_disk_interruption(self):
        self.drop = True
        with patch.object(p, 'confirm', side_effect=TimeoutError('temporarily unreachable')):
            with self.assertRaises(TimeoutError):
                self.run_pair()
        saved = list(self.root.glob('.agent-pair-*.pending'))
        self.assertEqual(len(saved), 1)
        self.assertFalse(self.key.exists())
        self.enable.assert_not_called()
        self.assertNotIn(TICKET, saved[0].read_text())
        self.run_pair()
        self.assertEqual(self.redeems, 1)
        self.assertEqual(self.key.stat().st_mode & 511, 384)

    def test_wrong_node_then_correct_ticket(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.run_pair(node=18)
        self.assertFalse(self.key.exists())
        self.run_pair()
        self.assertEqual(json.loads(self.key.read_bytes())['node'], 17)

    def test_rotated_report_token_permits_new_ticket_on_same_node(self):
        self.run_pair()
        old = json.loads(self.key.read_bytes())
        self.report = 'replacement-report'
        self.configure()
        self.remote_hash = None
        self.run_pair()
        new = json.loads(self.key.read_bytes())
        self.assertNotEqual(new['credential'], old['credential'])
        self.assertEqual(new['report_identity'], p.digest(self.report.encode()))

    def test_revoked_existing_grant_is_replaced_only_after_confirmation(self):
        self.run_pair()
        old = self.key.read_bytes()
        self.remote_hash = None
        self.authorized_node = 19
        with self.assertRaises(urllib.error.HTTPError):
            self.run_pair()
        self.assertEqual(self.key.read_bytes(), old)
        self.authorized_node = 17
        self.run_pair()
        self.assertNotEqual(self.key.read_bytes(), old)

    def test_unused_ticket_and_no_private_writes_on_wrong_hub_or_bad_digest(self):
        with self.assertRaisesRegex(p.PairError, 'different Hub'):
            self.run_pair(server='https://another.example')
        self.fetch.assert_not_called()
        with self.assertRaisesRegex(p.PairError, 'SHA-256 mismatch'):
            self.run_pair(sha='0' * 64)
        self.assertFalse(self.key.exists())
        self.assertEqual(self.redeems, 0)
        self.assertFalse(list(self.root.glob('*.pending')))

    def test_busy_lock_or_interrupted_manual_install(self):
        with p.locked('.agent-updater.lock'):
            with self.assertRaisesRegex(p.PairError, 'busy'):
                self.run_pair()
        (self.root / '.agent-install.recovery').mkdir()
        with self.assertRaisesRegex(p.PairError, 'interrupted'):
            self.run_pair()
        self.fetch.assert_not_called()

    def test_private_env_and_https_only(self):
        self.config.chmod(420)
        with self.assertRaises(p.PairError):
            self.run_pair()
        self.configure('http://old-http.example')
        with self.assertRaises(p.PairError):
            self.run_pair()
        self.fetch.assert_not_called()

    def test_identity_or_grant_for_wrong_node_fails_closed(self):
        self.run_pair()
        old = self.key.read_bytes()
        self.authorized_node = 18
        with self.assertRaisesRegex(p.PairError, 'different maintenance identity'):
            self.run_pair()
        with self.assertRaisesRegex(p.PairError, 'another identity'):
            self.run_pair(node=18)
        self.assertEqual(self.key.read_bytes(), old)

    def test_failed_scheduler_retries_with_already_saved_grant(self):
        self.enable.side_effect = lambda *a, **k: type('Process', (), {'returncode': 1})()
        with self.assertRaisesRegex(p.PairError, 'credential saved'):
            self.run_pair()
        self.assertTrue(self.key.is_file())
        self.enable.side_effect = self.installer
        self.run_pair()
        self.assertEqual(self.redeems, 1)

    def test_agent_binary_can_have_a_rollback_hardlink(self):
        os.link(self.binary, self.root / '.agent-updater.previous')
        self.run_pair()
        self.assertTrue(self.key.is_file())

    def test_redirect_denied(self):
        with self.assertRaisesRegex(p.PairError, 'redirects'):
            p.NoRedirect().redirect_request(None, None, 302, 'Moved', {}, 'https://other.example')
if __name__ == '__main__':
    unittest.main()
