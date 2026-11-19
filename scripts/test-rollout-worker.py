#!/usr/bin/env python3
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1] / 'deploy/agent-updater.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class Worker(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        attrs = dict(ROOT=root, BIN=root/'monitor-agent', ENV=root/'agent.env', PREVIOUS=root/'previous', PENDING=root/'pending')
        for key, value in attrs.items():
            p = patch.object(w, key, value); p.start(); self.addCleanup(p.stop)
        self.old = b'#!/bin/sh\necho monitor-agent 1.2.0\n'; self.new = self.old.replace(b'1.2.0', b'1.2.1')
        w.BIN.write_bytes(self.old); w.BIN.chmod(0o755)
        w.ENV.write_text('MONITOR_SERVER=https://monitor.example.org\nMONITOR_TOKEN=fixture\n')
        self.actions = []; self.valid = True; self.allow = True
        def fetch(url, limit, data=None, token=None):
            if data:
                self.assertEqual(token, 'fixture'); self.assertEqual(url,'https://monitor.example.org/api/agent/upgrade')
                action=json.loads(data)['action']; self.actions.append(action)
                if action in ('poll','apply') and (action=='poll' or self.allow): return b'{"batch":3,"target":"1.2.1"}'
                return b'null'
            self.assertIsNone(token)
            if url.endswith('sha256sums.txt'):
                self.assertTrue(url.startswith(w.OFFICIAL+'v1.2.1/')); return (hashlib.sha256(self.new if self.valid else b'bad').hexdigest()+'  monitor-agent-x86_64-unknown-linux-musl\n').encode()
            self.assertEqual(url,'https://monitor.example.org/agent/x86_64'); return self.new
        for p in [patch.object(w,'fetch',fetch),patch.object(w,'trusted'),patch.object(w.platform,'machine',return_value='x86_64')]:
            p.start(); self.addCleanup(p.stop)

    def test_valid_release_keeps_identity_and_previous_image(self):
        env=w.ENV.read_bytes()
        with patch.object(w,'restart_healthy'): w.once()
        self.assertEqual(self.actions,['poll','apply','installed']); self.assertEqual(w.BIN.read_bytes(),self.new)
        self.assertEqual(w.PREVIOUS.read_bytes(),self.old); self.assertEqual(w.ENV.read_bytes(),env)

    def test_restart_failure_restores_previous_image(self):
        with patch.object(w,'restart_healthy',side_effect=[OSError(),None]),self.assertRaises(OSError): w.once()
        self.assertEqual(self.actions[-1],'failed'); self.assertEqual(w.BIN.read_bytes(),self.old); self.assertFalse(w.PENDING.exists())

    def test_checksum_and_expired_authorization_precede_replacement(self):
        self.valid=False
        with self.assertRaises(ValueError): w.once()
        self.assertNotIn('apply',self.actions); self.assertEqual(w.BIN.read_bytes(),self.old)
        self.valid=True;self.allow=False;w.once();self.assertEqual(w.BIN.read_bytes(),self.old)

    def test_http_and_downgrade_refused(self):
        w.ENV.write_text('MONITOR_SERVER=http://monitor.example.org\nMONITOR_TOKEN=fixture\n')
        with self.assertRaises(ValueError): w.once()
        self.assertEqual(self.actions,[])
        for value in ['1.2.0','1.1.9','https://other','1.2.1/../other']:
            with self.assertRaises(ValueError): w.validate_target('1.2.0',value)

if __name__=='__main__': unittest.main()
