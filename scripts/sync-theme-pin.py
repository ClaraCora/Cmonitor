#!/usr/bin/env python3
"""Prepare a reviewed theme pin update using the release's published digest."""
import json
import os
import re
import urllib.request
from pathlib import Path

REPO = "ClaraCora/Cmonitor-theme-default"
TOKEN = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")


def read(url, *, github_api=False, accept=None):
    headers = {
        "User-Agent": "Cmonitor-pin-sync",
        "Accept": accept or "application/vnd.github+json",
    }
    if github_api and TOKEN:
        headers["Authorization"] = "Bearer " + TOKEN
        headers["X-GitHub-Api-Version"] = "2022-11-28"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read(1024 * 1024)

release = json.loads(read(f"https://api.github.com/repos/{REPO}/releases/latest", github_api=True))
tag = release["tag_name"]
if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
    raise SystemExit("unsupported theme tag")
assets = {asset["name"]: asset for asset in release["assets"]}
if "theme.tar.gz" not in assets or "theme.tar.gz.sha256" not in assets:
    raise SystemExit("release is missing the installable archive or checksum")
checksum = assets["theme.tar.gz.sha256"]
if not TOKEN:
    raise SystemExit("GITHUB_TOKEN is required to read the checksum asset")
sha = read(
    f"https://api.github.com/repos/{REPO}/releases/assets/{checksum['id']}",
    github_api=True,
    accept="application/octet-stream",
).decode().strip()
if not re.fullmatch(r"[0-9a-f]{64}", sha):
    raise SystemExit("release digest must contain exactly one SHA256")
pin = Path(__file__).resolve().parent.parent / "web-theme.pin"
value = f"{tag} {sha}\n"
if pin.read_text() == value:
    print("theme pin already current")
else:
    pin.write_text(value)
    print(f"prepared {tag}; run theme.sh and integration CI before merging")
