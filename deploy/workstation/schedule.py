#!/usr/bin/env python3
"""Install the user's verified workstation checks into launchd."""
import os
import plistlib
import subprocess
from pathlib import Path

here=Path(__file__).resolve().parent
if not (here/'settings.json').exists() or not (here/'drill.json').exists():
    raise SystemExit('Complete the initial encrypted backup and restore check first.')
services={'backup':('recovery.py',1800,[]), 'public-watch':('watch.py',120,[]),
          'restore-check':('recovery.py',30*86400,['--drill'])}
for name,(script,interval,extra) in services.items():
    label='local.cmonitor.'+name; folder=Path.home()/'Library/LaunchAgents'; folder.mkdir(exist_ok=True)
    path=folder/(label+'.plist'); domain=f'gui/{os.getuid()}'
    settings={'Label':label,'ProgramArguments':['/usr/bin/python3',str(here/script),*extra],
              'StartInterval':interval,'RunAtLoad':name!='restore-check','ProcessType':'Background',
              'StandardErrorPath':str(here/(name+'.err')),'Umask':0o077}
    with path.open('wb') as stream:plistlib.dump(settings,stream)
    path.chmod(0o600)
    subprocess.run(['launchctl','bootout',domain+'/'+label],capture_output=True)
    subprocess.run(['launchctl','bootstrap',domain,str(path)],check=True)
