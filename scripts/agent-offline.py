#!/usr/bin/env python3
"""Build a self-contained Linux installer from this Hub revision's Agent pin."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def build(output):
    pin = json.loads((ROOT / 'agent.pin').read_text())
    tag = pin['tag']
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('invalid agent pin')
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary) / 'cmonitor-agent-offline'
        folder.mkdir()
        sums = []
        for arch in ('x86_64', 'aarch64'):
            name = f'monitor-agent-{arch}-unknown-linux-musl'
            with urlopen(f'https://github.com/ClaraCora/Cagent/releases/download/{tag}/{name}', timeout=120) as response:
                data = response.read(16 * 1024 * 1024 + 1)
            digest = hashlib.sha256(data).hexdigest()
            if len(data) > 16 * 1024 * 1024 or digest != pin['sha256'][arch]:
                raise ValueError(f'{name}: pinned checksum mismatch')
            (folder / name).write_bytes(data)
            sums.append(f'{digest}  {name}\n')
        (folder / 'sha256sums.txt').write_text(''.join(sums))
        (folder / 'versions.txt').write_text(f'Agent={tag}\n')
        shutil.copy2(ROOT / 'install.sh', folder / 'install.sh')
        with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as staging:
            staged = Path(staging.name)
        try:
            with tarfile.open(staged, 'w:gz') as archive:
                archive.add(folder, arcname=folder.name)
            staged.replace(output)
        finally:
            staged.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    build(parser.parse_args().output)
