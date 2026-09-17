#!/usr/bin/env python3
"""Linux CI only: real Hub + root Agent, with disposable data and credentials.

Uses the standard library so the security regression runner needs no packages.
Never writes login credentials or terminal content to the CI log.
"""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time


class WebSocket:
    def __init__(self, port, path, cookie="", origin=None, token=None, expected=101):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=8)
        self.sock.settimeout(8)
        self.file = self.sock.makefile("rb")
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        headers = [f"GET {path} HTTP/1.1", f"Host: 127.0.0.1:{port}",
                   "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13",
                   f"Sec-WebSocket-Key: {key}"]
        if origin is not None:
            headers.append(f"Origin: {origin}")
        if cookie:
            headers.append(f"Cookie: {cookie}")
        if token:
            headers.append(f"Authorization: Bearer {token}")
        self.sock.sendall(("\r\n".join(headers) + "\r\n\r\n").encode())
        status = int(self.file.readline().split()[1])
        response = {}
        while (line := self.file.readline()) not in (b"\r\n", b""):
            name, value = line.decode().split(":", 1)
            response[name.lower()] = value.strip()
        assert status == expected, f"WebSocket {path}: expected {expected}, received {status}"
        if status == 101:
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            assert response["sec-websocket-accept"] == accept
        else:
            self.close()

    def send(self, value, opcode=1):
        payload = json.dumps(value).encode() if not isinstance(value, bytes) else value
        size = len(payload)
        header = bytes([0x80 | opcode])
        header += bytes([0x80 | size]) if size < 126 else bytes([0x80 | 126]) + struct.pack("!H", size)
        mask = secrets.token_bytes(4)
        self.sock.sendall(header + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(payload)))

    def receive(self):
        while True:
            header = self.file.read(2)
            if len(header) != 2:
                return None
            opcode, length = header[0] & 15, header[1] & 127
            if length == 126:
                length = struct.unpack("!H", self.file.read(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self.file.read(8))[0]
            assert length <= 65536
            payload = self.file.read(length)
            if opcode == 8:
                return None
            if opcode == 9:
                self.send(payload, 10)
            elif opcode == 1:
                return json.loads(payload)

    def closed(self):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                frame = self.receive()
            except (ConnectionResetError, BrokenPipeError):
                return
            if frame is None:
                return
        raise AssertionError("revoked terminal remained connected")

    def close(self):
        self.file.close()
        self.sock.close()


def main():
    assert sys.platform.startswith("linux") and os.geteuid() == 0, "run only on the Linux CI runner as root"
    hub_binary, agent_binary = [str(Path(p).resolve()) for p in sys.argv[1:3]]
    with tempfile.TemporaryDirectory(prefix="cmonitor-security-") as directory:
        directory = Path(directory)
        database = directory / "monitor.db"
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        processes, sockets = [], []

        def start(binary, args, env=None):
            output = tempfile.TemporaryFile()
            child = subprocess.Popen([binary, *args], env=env, stdout=output, stderr=output,
                                     cwd=directory, start_new_session=True)
            processes.append((child, output))
            return child, output

        def stop(child):
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=3)

        def api(path, body=None, cookie="", request_origin=origin, method=None):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            headers = {"Content-Type": "application/json"}
            if request_origin is not None:
                headers["Origin"] = request_origin
            if cookie:
                headers["Cookie"] = cookie
            connection.request(method or ("POST" if body is not None else "GET"), path,
                               json.dumps(body) if body is not None else None, headers)
            response = connection.getresponse()
            data, status, response_headers = response.read(), response.status, dict(response.getheaders())
            connection.close()
            try:
                data = json.loads(data)
            except (ValueError, UnicodeDecodeError):
                data = None
            return status, data, response_headers

        def ready():
            for _ in range(100):
                try:
                    if api("/api/me")[0] == 200:
                        return
                except OSError:
                    pass
                time.sleep(0.1)
            raise AssertionError("Hub did not start")

        def login(password):
            status, _, headers = api("/api/auth/login", {"password": password})
            assert status == 200, f"password login returned {status}"
            return headers["set-cookie"].split(";", 1)[0]

        def ws(cookie, path="/api/terminal/ws", request_origin=origin, expected=101, token=None):
            result = WebSocket(port, path, cookie, request_origin, token, expected)
            if expected == 101:
                sockets.append(result)
            return result

        def agent_online(cookie):
            for _ in range(100):
                status, nodes, _ = api("/api/nodes", cookie=cookie)
                if status == 200 and any(n["online"] for n in nodes["nodes"]):
                    return
                time.sleep(0.1)
            raise AssertionError("Agent did not connect")

        def terminal(cookie, node):
            channel = ws(cookie)
            channel.send({"type": "connect", "node_id": node, "cols": 80, "rows": 24})
            while True:
                frame = channel.receive()
                assert frame is not None, "terminal disconnected before ready"
                assert frame.get("method") != "terminal.error", "terminal failed to open"
                if frame.get("method") == "terminal.ready":
                    break
            channel.send({"type": "input", "data": "printf '__UID=%s PID=%s__\\n' \"$(id -u)\" \"$$\"\r"})
            output = ""
            while True:
                frame = channel.receive()
                assert frame is not None
                output += frame.get("params", {}).get("data", "")
                found = re.search(r"__UID=0 PID=(\d+)__", output)
                if found:
                    return channel, int(found[1])

        def shell_gone(pid):
            for _ in range(80):
                if not Path(f"/proc/{pid}").exists():
                    return
                time.sleep(0.1)
            raise AssertionError("revoked root shell was not reaped")

        try:
            hub, log = start(hub_binary, ["--listen", f"127.0.0.1:{port}", "--db", str(database)])
            ready()
            log.seek(0)
            password = re.search(rb"Emergency password: ([a-f0-9]+)", log.read())[1].decode()
            cookie = login(password)
            assert api("/api/me", cookie=cookie)[1]["hub_version"]
            assert api("/api/me")[1]["hub_version"] is None
            assert api("/api/settings", {"password_login": "off"}, cookie, method="PUT")[0] == 400
            assert api("/api/settings", {"site_name": "blocked"}, cookie, "http://evil.example.com", "PUT")[0] == 403
            assert api("/api/auth/logout", {}, cookie, None)[0] == 403
            ws("", expected=401)
            ws(cookie, request_origin="http://evil.example.com", expected=403)
            ws(cookie, request_origin=None, expected=403)
            ws(cookie, path="/api/ws", request_origin="http://evil.example.com", expected=403)
            print("PASS: version visibility, password prerequisite and cross-origin protection", flush=True)

            token = secrets.token_hex(32)
            with sqlite3.connect(database) as db:
                node = db.execute("INSERT INTO node(name,token,created_at) VALUES(?,?,?)", ("CI", token, int(time.time()))).lastrowid
                db.execute("INSERT INTO traffic(node_id) VALUES(?)", (node,))
            agent, _ = start(agent_binary, [], dict(os.environ, MONITOR_SERVER=origin, MONITOR_TOKEN=token))
            agent_online(cookie)
            channel, pid = terminal(cookie, node)
            assert api(f"/api/nodes/{node}/token", {}, cookie)[0] == 200
            channel.closed()
            shell_gone(pid)
            stop(agent)
            ws("", "/api/agent/ws", token=token, expected=401)
            print("PASS: root PTY, token rotation closes cloned channels and reaps shell", flush=True)

            with sqlite3.connect(database) as db:
                token = db.execute("SELECT token FROM node WHERE id=?", (node,)).fetchone()[0]
            agent, _ = start(agent_binary, [], dict(os.environ, MONITOR_SERVER=origin, MONITOR_TOKEN=token))
            agent_online(cookie)
            channel, pid = terminal(cookie, node)
            assert api("/api/auth/logout", {}, cookie)[0] == 200
            channel.closed()
            shell_gone(pid)
            ws(cookie, expected=401)
            cookie = login(password)
            channel, pid = terminal(cookie, node)
            assert api(f"/api/nodes/{node}", cookie=cookie, method="DELETE")[0] == 200
            channel.closed()
            shell_gone(pid)
            stop(agent)
            print("PASS: logout and node deletion close root terminals", flush=True)

            # Exercise the local recovery path, including a disabled state with
            # missing OAuth config (e.g. an operator's damaged backup).
            stop(hub)
            with sqlite3.connect(database) as db:
                db.execute("INSERT INTO setting(key,value) VALUES('password_login','off') ON CONFLICT(key) DO UPDATE SET value='off'")
            hub, _ = start(hub_binary, ["--listen", f"127.0.0.1:{port}", "--db", str(database)])
            ready()
            assert api("/api/me")[1]["password_login"] is False
            assert api("/api/auth/login", {"password": password})[0] == 403
            stop(hub)
            recovery = subprocess.run([hub_binary, "--db", str(database), "--reset-password"], capture_output=True, check=True)
            replacement = re.search(rb"([a-f0-9]{24})\s*$", recovery.stdout)[1].decode()
            hub, _ = start(hub_binary, ["--listen", f"127.0.0.1:{port}", "--db", str(database)])
            ready()
            assert api("/api/me")[1]["password_login"] is True
            login(replacement)
            assert api("/api/me", cookie=cookie)[1]["authed"] is False
            print("PASS: disabled password survives restart; local recovery revokes old logins", flush=True)
        finally:
            for channel in sockets:
                channel.close()
            for child, output in reversed(processes):
                stop(child)
                output.close()


if __name__ == "__main__":
    main()
