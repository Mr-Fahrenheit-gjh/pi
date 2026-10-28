"""Explicit, scoped user-runtime installation. Does not touch Pi settings or restart Pi Web."""
from pathlib import Path
import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys

SOURCE=Path(__file__).resolve().parent
BASE=Path.home()/'.pi/agent/hy-memory'
LABELS={'models':'cn.pi.hy-memory-models','engine':'cn.pi.hy-memory','candidate':'cn.pi.hy-memory-candidate'}
FILES=['bridge.mjs','sdk_engine.py','sdk_service.py','models.sh','engine.sh']


def record():
    path=BASE/'install-state.json'
    return json.loads(path.read_text()) if path.exists() else {'schema':1,'source':str(SOURCE),'phases':{}}


def save(state):
    p=BASE/'install-state.json';p.write_text(json.dumps(state,ensure_ascii=False,indent=2));p.chmod(0o600)


def plist(role):
    label=LABELS[role]
    environment={'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'}
    if role=='candidate':
        environment['HY_MEMORY_HOME']=str(BASE/'candidate-data')
    return {'Label':label,'ProgramArguments':['/bin/bash',str(BASE/'runtime'/('models.sh' if role=='models' else 'engine.sh'))],
        'WorkingDirectory':str(BASE),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,
        'StandardOutPath':str(BASE/'logs'/(role+'.out.log')),'StandardErrorPath':str(BASE/'logs'/(role+'.error.log')),
        'EnvironmentVariables':environment}


def prepare():
    os.umask(0o077)
    if any(registered('gui/'+str(os.getuid())+'/'+LABELS[role]) for role in ['engine','candidate']):
        raise RuntimeError('stop_managed_engine_before_prepare')
    if BASE.exists() and not (BASE/'install-state.json').exists():
        raise RuntimeError('existing_unmanaged_runtime_refused')
    BASE.mkdir(mode=0o700,parents=True,exist_ok=True)
    state=record();state['phases']['prepared']=False;save(state)
    (BASE/'runtime').mkdir(mode=0o700,exist_ok=True);(BASE/'logs').mkdir(mode=0o700,exist_ok=True)
    for name in FILES:
        shutil.copy2(SOURCE/name,BASE/'runtime'/name)
    (BASE/'runtime/plugin').mkdir(mode=0o700,exist_ok=True)
    for name in ['index.ts','package.json']:
        shutil.copy2(SOURCE/name,BASE/'runtime/plugin'/name)
    token=BASE/'bridge-token'
    if not token.exists():
        shutil.copy2(SOURCE/'data/bridge-token',token)
    elif token.read_bytes()!=(SOURCE/'data/bridge-token').read_bytes():
        raise RuntimeError('runtime_token_conflict')
    token.chmod(0o600)
    config=BASE/'config.json';config.write_text(json.dumps({'baseUrl':'http://127.0.0.1:30148','tokenFile':str(token)},indent=2));config.chmod(0o600)
    if not (BASE/'venv').exists():
        shutil.move(str(SOURCE/'data/sdk-venv'),BASE/'venv')
    # Launch the relocated interpreter directly; do not rely on old venv console-script shebangs.
    check=subprocess.run([str(BASE/'venv/bin/python'),'-c',"import importlib.metadata; assert importlib.metadata.version('hy-memory')=='2.0.2'"],capture_output=True,text=True)
    check.check_returncode()
    state['source_sha256']={name:hashlib.sha256((SOURCE/name).read_bytes()).hexdigest() for name in FILES}
    state['plugin_sha256']={name:hashlib.sha256((SOURCE/name).read_bytes()).hexdigest() for name in ['index.ts','package.json']}
    state['phases']['prepared']=True;save(state)
    print(json.dumps({'state':'prepared','base':str(BASE),'sdk':'2.0.2'}))


def start(role):
    state=record()
    if not state['phases'].get('prepared'):
        raise RuntimeError('runtime_not_prepared')
    if role in ('engine','candidate'):
        other='candidate' if role=='engine' else 'engine'
        if registered('gui/'+str(os.getuid())+'/'+LABELS[other]):
            raise RuntimeError('other_memory_engine_registered_refused')
    for name,digest in state['source_sha256'].items():
        if hashlib.sha256((BASE/'runtime'/name).read_bytes()).hexdigest()!=digest:
            raise RuntimeError('runtime_changed_since_prepare')
    for name,digest in state.get('plugin_sha256',{}).items():
        if hashlib.sha256((BASE/'runtime/plugin'/name).read_bytes()).hexdigest()!=digest:
            raise RuntimeError('plugin_changed_since_prepare')
    if role=='engine' and not (BASE/'data/engine').is_dir():
        raise RuntimeError('verified_memory_store_required')
    if role=='candidate' and not (BASE/'candidate-data/archive/MEMORY.md').is_file():
        raise RuntimeError('candidate_archive_required')
    data=plistlib.dumps(plist(role),sort_keys=True)
    target=Path.home()/'Library/LaunchAgents'/(LABELS[role]+'.plist')
    if target.exists() and target.read_bytes()!=data:
        raise RuntimeError('unmanaged_launchagent_refused')
    domain='gui/'+str(os.getuid());label=domain+'/'+LABELS[role]
    active=registered(label)
    if not active:
        import socket
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            probe.bind(('127.0.0.1',30147 if role=='models' else 30148))
    target.write_bytes(data);target.chmod(0o600)
    if not active:
        subprocess.run(['launchctl','bootstrap',domain,str(target)],check=True)
    else:
        subprocess.run(['launchctl','kickstart',label],check=True)
    state['phases'][role+'_registered']=True;state.setdefault('plist_sha256',{})[role]=hashlib.sha256(data).hexdigest();save(state)
    print(json.dumps({'state':'registered','label':LABELS[role]}))


def registered(label):
    result=subprocess.run(['launchctl','print',label],capture_output=True,text=True)
    if result.returncode==0:
        return True
    if result.returncode==113 and 'Could not find service' in result.stderr:
        return False
    raise RuntimeError('launchagent_status_uncertain')


def stop(role):
    state=record();target=Path.home()/'Library/LaunchAgents'/(LABELS[role]+'.plist')
    label='gui/'+str(os.getuid())+'/'+LABELS[role]
    if target.exists():
        digest=hashlib.sha256(target.read_bytes()).hexdigest()
        if digest!=state.get('plist_sha256',{}).get(role):
            raise RuntimeError('changed_launchagent_refused')
    active=registered(label)
    if active:
        if not target.exists():
            raise RuntimeError('active_launchagent_missing_managed_plist')
        result=subprocess.run(['launchctl','bootout',label],capture_output=True,text=True)
        if result.returncode!=0:
            raise RuntimeError('launchagent_stop_failed_configuration_preserved')
    # bootout may return while launchd is still reaping the child. Bound this
    # OS readiness wait; do not claim success or erase the plist on timeout.
    import time
    import threading
    deadline=time.monotonic()+15
    while registered(label):
        if time.monotonic()>=deadline:
            raise RuntimeError('launchagent_still_registered_configuration_preserved')
        threading.Event().wait(0.1)
    # Never erase recovery information until absence was positively established.
    if target.exists():
        target.unlink()
    state['phases'][role+'_registered']=False;save(state)
    print(json.dumps({'state':'stopped','label':LABELS[role],'data_preserved':True}))


if __name__=='__main__':
    action=sys.argv[1]
    if action=='prepare':prepare()
    elif action in ('start','stop') and len(sys.argv)==3 and sys.argv[2] in LABELS:
        (start if action=='start' else stop)(sys.argv[2])
    else:raise ValueError('usage: prepare | start/stop models/engine/candidate')
