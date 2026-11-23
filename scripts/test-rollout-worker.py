#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1] / 'deploy/agent-updater.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class Worker(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.journal = root / '.agent-updater.state'
        attrs = dict(ROOT=root, BIN=root/'monitor-agent', ENV=root/'agent.env', PREVIOUS=root/'previous', PENDING=root/'pending')
        for key, value in attrs.items():
            self.enter_patch(w, key, value)
        self.old = b'#!/bin/sh\necho monitor-agent 1.2.0\n'
        self.new = self.old.replace(b'1.2.0', b'1.2.1')
        w.BIN.write_bytes(self.old)
        w.BIN.chmod(0o755)
        w.ENV.write_text('MONITOR_SERVER=https://monitor.example.org\nMONITOR_TOKEN=fixture\n')
        self.job = dict(batch=3, target='1.2.1', protocol=2, attempt='a' * 32)
        self.actions = []
        self.status = 'ready'
        self.error = None
        self.checksum = hashlib.sha256(self.new).hexdigest()
        self.fail_asset = []
        self.asset_calls = 0
        self.drop = []
        self.grant_deadline = 1060
        self.enter_patch(w, 'trusted', lambda path: None)
        self.enter_patch(w.platform, 'machine', lambda: 'x86_64')
        self.enter_patch(w.time, 'time', lambda: 1000)
        self.enter_patch(w.time, 'sleep', lambda _: None)
        self.enter_patch(w, 'fetch', self.fetch)

    def enter_patch(self, module, key, value):
        p = patch.object(module, key, value)
        p.start()
        self.addCleanup(p.stop)

    def fetch(self, url, limit, data=None, token=None):
        if not data:
            self.assertIsNone(token)
            if url.endswith('sha256sums.txt'):
                self.assertTrue(url.startswith(w.OFFICIAL + 'v1.2.1/'))
                return (self.checksum + '  monitor-agent-x86_64-unknown-linux-musl\n').encode()
            self.assertEqual(url, 'https://monitor.example.org/agent/x86_64')
            self.asset_calls += 1
            if self.fail_asset:
                raise self.fail_asset.pop(0)
            return self.new
        self.assertEqual(token, 'fixture')
        self.assertEqual(url, 'https://monitor.example.org/api/agent/upgrade')
        body = json.loads(data)
        self.assertEqual(body['protocol'], 2)
        action = body['action']
        self.actions.append(action)
        if action == 'poll':
            return json.dumps(self.job).encode()
        self.assertEqual((body['batch'], body['attempt']), (3, 'a' * 32))
        if self.drop and self.drop[0] == action:
            self.drop.pop(0)
            raise TimeoutError('connection lost')
        if action == 'apply':
            return json.dumps(None if self.status in w.TERMINAL else self.job).encode()
        if action == 'installed' and self.status == 'ready':
            self.status = 'observing'
        if action == 'failed':
            self.error = body['error']
            self.status = 'rolled_back' if self.error == 'rolled_back' else 'failed'
        if action == 'rollback' and self.status in ('rollback_pending', 'rolling_back'):
            self.status = 'rolling_back'
            return json.dumps(dict(status='rollback', deadline=self.grant_deadline)).encode()
        return json.dumps(dict(status=self.status)).encode()

    def install(self):
        with patch.object(w, 'restart_healthy') as restart:
            w.once()
            restart.assert_called_once()

    def test_install_preserves_identity_until_hub_verifies(self):
        env = w.ENV.read_bytes()
        self.install()
        self.assertEqual(self.actions, ['poll', 'apply', 'installed'])
        self.assertEqual(w.BIN.read_bytes(), self.new)
        self.assertEqual(w.PREVIOUS.read_bytes(), self.old)
        self.assertEqual(w.ENV.read_bytes(), env)
        self.assertTrue(self.journal.exists())
        self.status = 'verified'
        w.once()
        self.assertFalse(self.journal.exists())

    def test_lost_install_receipt_is_replayed_without_reinstall(self):
        self.drop = ['installed']
        with patch.object(w, 'restart_healthy') as restart:
            with self.assertRaises(TimeoutError):
                w.once()
            self.assertEqual(w.BIN.read_bytes(), self.new)
            w.once()
            restart.assert_called_once()
        self.assertEqual(self.actions, ['poll', 'apply', 'installed', 'installed'])
        self.assertEqual(self.asset_calls, 1)

    def test_lost_apply_reply_needs_fresh_grant_before_replacement(self):
        self.drop = ['apply']
        with self.assertRaises(TimeoutError):
            w.once()
        self.assertEqual(w.BIN.read_bytes(), self.old)
        self.status = 'skipped'
        w.once()
        self.assertEqual(w.BIN.read_bytes(), self.old)
        self.assertFalse(self.journal.exists())

    def test_restart_failure_restores_previous_and_retries_failure_receipt(self):
        self.drop = ['failed']
        with patch.object(w, 'restart_healthy', side_effect=[OSError(), None]):
            with self.assertRaises(TimeoutError):
                w.once()
        self.assertEqual(w.BIN.read_bytes(), self.old)
        w.once()
        self.assertEqual(self.error, 'restart')
        self.assertFalse(self.journal.exists())

    def test_contact_loss_does_not_roll_back_a_healthy_node(self):
        self.install()
        self.drop = ['status']
        with self.assertRaises(TimeoutError):
            w.once()
        self.status = 'unconfirmed'
        w.once()
        self.assertEqual(w.BIN.read_bytes(), self.new)
        self.assertFalse(self.journal.exists())
        self.assertNotIn('rollback', self.actions)

    def test_rollback_only_with_valid_grant_and_known_images(self):
        self.install()
        self.status = 'rollback_pending'
        self.drop = ['rollback']
        with self.assertRaises(TimeoutError):
            w.once()
        self.grant_deadline = 999
        w.once()
        self.assertEqual(w.BIN.read_bytes(), self.new)
        self.grant_deadline = 1060
        with patch.object(w, 'restart_healthy') as restart:
            w.once()
            restart.assert_called_once()
        self.assertEqual(w.BIN.read_bytes(), self.old)
        self.assertEqual(self.error, 'rolled_back')

    def test_operator_binary_is_not_replaced_by_rollback(self):
        self.install()
        self.status = 'rollback_pending'
        w.BIN.write_bytes(b'manually installed')
        with patch.object(w, 'restart_healthy') as restart:
            w.once()
            restart.assert_not_called()
        self.assertEqual(self.error, 'rollback_failed')
        self.assertEqual(w.BIN.read_bytes(), b'manually installed')

    def test_interrupted_restart_recovers_the_same_install_attempt(self):
        with patch.object(w, 'restart_healthy', side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            w.once()
        self.assertEqual(w.BIN.read_bytes(), self.new)
        self.assertEqual(json.loads(self.journal.read_text())['phase'], 'swapping')
        with patch.object(w, 'restart_healthy') as restart:
            w.once()
            restart.assert_called_once()
        self.assertEqual(self.actions, ['poll', 'apply', 'installed'])
        self.assertEqual(self.asset_calls, 1)

    def test_interruption_after_authorized_rollback_rename_finishes_old_restart(self):
        self.install()
        self.status = 'rollback_pending'
        with patch.object(w, 'restart_healthy', side_effect=KeyboardInterrupt()), self.assertRaises(KeyboardInterrupt):
            w.once()
        self.assertEqual(w.BIN.read_bytes(), self.old)
        self.grant_deadline = 999
        with patch.object(w, 'restart_healthy') as restart:
            w.once()
            restart.assert_called_once()
        self.assertEqual(self.actions.count('rollback'), 1)
        self.assertEqual(self.error, 'rolled_back')

    def test_temporary_release_failures_retry_but_checksum_mismatch_does_not(self):
        self.fail_asset = [urllib.error.HTTPError('https://example', 429, '', {'Retry-After': '2'}, None), TimeoutError()]
        self.checksum = '0' * 64
        w.once()
        self.assertEqual(self.error, 'verify')
        self.assertEqual(self.asset_calls, 3)
        self.assertNotIn('apply', self.actions)

    def test_failed_download_is_distinct_from_checksum_error(self):
        self.fail_asset = [TimeoutError()] * 4
        w.once()
        self.assertEqual(self.error, 'download')
        self.assertNotIn('apply', self.actions)
        self.assertEqual(w.BIN.read_bytes(), self.old)

    def test_http_and_downgrade_refused(self):
        w.ENV.write_text('MONITOR_SERVER=http://monitor.example.org\nMONITOR_TOKEN=fixture\n')
        with self.assertRaises(ValueError):
            w.once()
        self.assertEqual(self.actions, [])
        for value in ['1.2.0', '1.1.9', 'https://other', '1.2.1/../other']:
            with self.assertRaises(ValueError):
                w.validate_target('1.2.0', value)


if __name__ == '__main__':
    unittest.main()
