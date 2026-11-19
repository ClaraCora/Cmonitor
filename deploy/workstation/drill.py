"""Start a restored Hub on loopback and verify an independent test Agent reports."""
from contextlib import ExitStack
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import time
import urllib.request


def recover(point, scratch, config, count):
    root=Path(scratch); work=root/'restore.db'; shutil.copy2(point/'monitor.db',work)
    subprocess.run([config['check_hub'],'--db',str(work),'--check-db'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=120)
    with tarfile.open(point/'runtime.tar.gz','r:gz') as archive:
        for member in archive:
            path=Path(member.name)
            if path.parts[:2]!=('data','themes') or not member.isfile(): continue
            if '..' in path.parts: raise ValueError('invalid theme bundle')
            dest=root/path; dest.parent.mkdir(parents=True,exist_ok=True)
            with dest.open('wb') as out: shutil.copyfileobj(archive.extractfile(member),out)
    token=secrets.token_hex(32)
    with sqlite3.connect(work) as conn:
        assert conn.execute('select count(*) from node').fetchone()[0]==count
        history=conn.execute('select count(*) from metric').fetchone()[0]
        conn.execute("delete from setting where key like 'notify_%'")
        conn.execute('delete from notification_delivery'); conn.execute('delete from session')
        conn.execute('update node set token=hex(randomblob(32))')
        conn.execute("insert or replace into setting(key,value) values ('public_page','on')")
        node=conn.execute("insert into node(name,token,created_at) values('restore-fixture',?,0)",(token,)).lastrowid
        conn.execute('insert into traffic(node_id) values(?)',(node,))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
    addr=f'127.0.0.1:{port}'; base='http://'+addr
    def stop(proc):
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill();proc.wait()
    with ExitStack() as stack:
        def start(args,env):
            proc=subprocess.Popen(args,env=env,cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);stack.callback(stop,proc)
        start([config['check_hub'],'--listen',addr,'--db',str(work),'--themes',str(root/'data/themes')],os.environ)
        start([config['check_agent'],'--interval','1'],{**os.environ,'MONITOR_SERVER':base,'MONITOR_TOKEN':token})
        for _ in range(60):
            try:
                with urllib.request.urlopen(base+'/api/nodes',timeout=2) as response: rows=json.load(response)['nodes']
                if any(row['id']==node and row['online'] and row['metrics'] for row in rows): break
            except OSError: pass
            time.sleep(.5)
        else:raise ValueError('restored Hub did not receive fixture telemetry')
        with urllib.request.urlopen(base+'/',timeout=5) as response: assert response.read()==(root/'data/themes/default/dist/index.html').read_bytes()
    print(f'restored Hub served the disk theme and received test telemetry: {count} original nodes, {history} history samples')
