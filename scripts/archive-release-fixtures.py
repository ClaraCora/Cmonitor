#!/usr/bin/env python3
"""Losslessly compress temporary QA databases in verified releases. Print a plan by default."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def digest(stream):
    result = hashlib.sha256()
    for part in iter(lambda: stream.read(1024 * 1024), b''):
        result.update(part)
    return result.hexdigest()


def archive(source):
    info = source.stat()
    if source.with_suffix('.db.gz').exists():
        return 0
    with tempfile.NamedTemporaryFile(dir=source.parent, prefix='.archive-', delete=False) as file:
        tmp = Path(file.name)
    try:
        with source.open('rb') as live, gzip.open(tmp, 'wb', compresslevel=3) as zipped:
            shutil.copyfileobj(live, zipped)
        with source.open('rb') as live, gzip.open(tmp, 'rb') as zipped:
            if digest(live) != digest(zipped) or info.st_mtime_ns != source.stat().st_mtime_ns:
                raise ValueError('archive did not match its source')
        size = tmp.stat().st_size
        os.replace(tmp, source.with_suffix('.db.gz'))
        source.unlink()
        return info.st_size - size
    finally:
        tmp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('releases', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    saved = 0
    for entry in sorted(args.releases.iterdir()):
        if entry.is_symlink() or not entry.is_dir(): continue
        if not all((entry / name).is_file() for name in ['verified.json','DEPLOYED.json','rollback/monitor.db']): continue
        for name in ['preflight.db','smoke.db']:
            source = entry / name
            if source.is_symlink() or not source.is_file(): continue
            if any(Path(str(source)+s).exists() for s in ['-wal','-shm','-journal']): continue
            if args.apply: saved += archive(source)
            print(entry.name, name)
    print(json.dumps({'applied':args.apply,'bytes_saved':saved}))

if __name__ == '__main__':main()
