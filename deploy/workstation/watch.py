#!/usr/bin/env python3
"""Monitor the public Hub from a separate macOS workstation; notify on transitions."""
import json
import os
from pathlib import Path
import subprocess
import time

HERE = Path(__file__).resolve().parent


def advance(old, available, message, events):
    failures = 0 if available else old.get('failures', 0) + 1
    alarm = failures >= 3 or (not available and old.get('alarm', False))
    if alarm != old.get('alarm', False):
        events.append(message + ('异常' if alarm else '已恢复'))
    return {'failures': failures, 'alarm': alarm}


def sample(site):
    def get(path):
        return subprocess.run(['/usr/bin/curl','--silent','--show-error','--fail','--location',
                               '--proto','=https','--proto-redir','=https','--max-time','12',site+path],
                              check=True,capture_output=True).stdout
    if json.loads(get('/healthz')).get('status') != 'ok' or b'<html' not in get('/')[:4096].lower():
        raise ValueError('unexpected health response')
    return {str(node['id']):bool(node['online']) for node in json.loads(get('/api/nodes'))['nodes']}


def notify(message):
    # Message is an argument, never AppleScript source; names/identities stay local.
    program='on run argv\ndisplay notification (item 1 of argv) with title "Cmonitor"\nend run'
    subprocess.run(['/usr/bin/osascript','-e',program,message],check=True,timeout=10)


def main():
    os.umask(0o077)
    config=json.loads((HERE/'settings.json').read_text()); path=HERE/'watch-state.json'
    previous=json.loads(path.read_text()) if path.exists() else {}; events=[]
    try: nodes=sample(config['site'])
    except (ValueError, OSError, subprocess.SubprocessError, KeyError): nodes=None
    state={'site':advance(previous.get('site',{}),nodes is not None,'公网监控服务',events),
           'nodes':previous.get('nodes',{}), 'at':int(time.time())}
    if nodes is not None:
        # Enrol a node after actually observing it online. Already retired nodes are ignored.
        state['nodes']={key:advance(state['nodes'].get(key,{}), up, '节点 '+key+' ', events)
                        for key,up in nodes.items() if up or key in state['nodes']}
    last=HERE/'last-backup.json'
    if last.exists():
        fresh = time.time()-json.loads(last.read_text())['backup_at'] <= 86400
        state['backup']=advance(previous.get('backup',{}),fresh,'异机恢复点时效',events)
    for event in events:notify(event)
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(state));temp.replace(path)
    print('public probe', 'ok' if nodes is not None else 'failed', 'events',len(events))

if __name__=='__main__': main()
