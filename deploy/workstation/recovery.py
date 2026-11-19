#!/usr/bin/env python3
"""Pull verified snapshots into an encrypted macOS volume; never write a plaintext DB outside it."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess as sp
import sys
import tempfile
import time
from keychain import password
from drill import recover

HERE = Path(__file__).resolve().parent
IMAGE = HERE / 'recovery.sparsebundle'
REMOTE_SNAPSHOT = "cd /opt/monitor/backups && ls -1 monitor-*.json | sort | tail -1"


def command(*args, **kwargs):
    return sp.run(args, check=True, **kwargs)


def verify(directory):
    meta = json.loads((directory/'manifest.json').read_text())
    db = directory/'monitor.db'
    if hashlib.sha256(db.read_bytes()).hexdigest() != meta['sha256']:
        raise ValueError('remote digest mismatch')
    with sqlite3.connect(db.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as conn:
        if conn.execute('pragma integrity_check').fetchone()[0] != 'ok' or conn.execute('pragma foreign_key_check').fetchone():
            raise ValueError('invalid backup')
        count = conn.execute('select count(*) from node').fetchone()[0]
    if count != meta['nodes']:
        raise ValueError('node inventory mismatch')
    return count


def perform(mount, config, drill):
    import re
    ssh = ['/usr/bin/ssh','-F',config['ssh_config'],'-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',config['host']]
    filename = command(*ssh,REMOTE_SNAPSHOT,capture_output=True,text=True,timeout=30).stdout.strip()
    if not re.fullmatch(r'monitor-\d{8}-\d{6}-\d{9}\.json', filename):
        raise RuntimeError('no verified remote manifest')
    points=mount/'points'; points.mkdir(exist_ok=True)
    target = points/filename[:-5]
    start=time.monotonic()
    if not target.exists():
        with tempfile.TemporaryDirectory(dir=mount) as scratch:
            temp=Path(scratch)/'snapshot'; temp.mkdir()
            for local,remote in [('manifest.json',filename),('monitor.db',filename[:-5]+'.db')]:
                with (temp/local).open('wb') as dest:
                    command(*ssh, 'cat /opt/monitor/backups/'+remote, stdout=dest,timeout=240)
            verify(temp);temp.rename(target)
    runtime=target/'runtime.tar.gz'
    if not runtime.is_file():
        # Copy only the monitor service's runtime, theme and service definitions.
        # TLS private keys and unrelated virtual hosts stay on the production host.
        args=['monitor-hub','monitor-agent','backup.py','data/themes']
        units=['monitor-hub.service','monitor-agent.service','monitor-backup.service','monitor-backup.timer',
               'monitor-backup-status.service','monitor-backup-status.timer']
        archive=tempfile.NamedTemporaryFile(dir=target,delete=False)
        try:
            with archive:
                command(*ssh,'tar czf - -C /opt/monitor '+ ' '.join(args) + ' -C /etc/systemd/system '+ ' '.join(units),stdout=archive,timeout=240)
            Path(archive.name).replace(runtime)
        finally:Path(archive.name).unlink(missing_ok=True)
    count=verify(target)
    days=set()
    for point in sorted(points.glob('monitor-*'),reverse=True):
        day=point.name[8:16]
        if day not in days and len(days)<14:
            days.add(day)
        elif point!=target:
            shutil.rmtree(point)
    if drill:
        with tempfile.TemporaryDirectory(dir=mount) as scratch:
            recover(target,scratch,config,count)
    manifest=json.loads((target/'manifest.json').read_text())
    receipt={'verified_at':int(time.time()),'backup_at':manifest['verified_at'],'nodes':count,'days':len(days),'elapsed_seconds':round(time.monotonic()-start,1)}
    if time.time()-receipt['backup_at']>86400:raise RuntimeError('newest remote point exceeds 24h')
    if drill: receipt['drill']=True
    (HERE/('drill.json' if drill else 'last-backup.json')).write_text(json.dumps(receipt))
    print('encrypted remote backup verified')


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('--init',action='store_true');parser.add_argument('--drill',action='store_true');args=parser.parse_args()
    config=json.loads((HERE/'settings.json').read_text());lock=(HERE/'backup.lock').open('a');fcntl.flock(lock,fcntl.LOCK_EX)
    key=password(create=args.init)+b'\n'
    if not IMAGE.exists():
        if not args.init:raise RuntimeError('no encrypted volume')
        command('/usr/bin/hdiutil','create','-size','2g','-fs','APFS','-type','SPARSEBUNDLE','-volname','CmonitorRecovery','-encryption','AES-256','-stdinpass',str(IMAGE),input=key,stdout=sp.DEVNULL)
    with tempfile.TemporaryDirectory(prefix='mount-',dir=HERE) as directory:
        mount=Path(directory)
        command('/usr/bin/hdiutil','attach','-nobrowse','-owners','on','-mountpoint',directory,'-stdinpass',str(IMAGE),input=key,stdout=sp.DEVNULL)
        try:perform(mount,config,args.drill)
        finally:command('/usr/bin/hdiutil','detach',directory,stdout=sp.DEVNULL)

if __name__=='__main__':main()
