"""Restart the known Pi Web/MCP launchd services after all Web work is idle.
Does not deploy a candidate, kill terminal clients, change settings, or wake a model.
"""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
HERE=Path(__file__).resolve().parent
WEB=HERE.parent/'pi-web维护/native-agent-switcher'
spec=importlib.util.spec_from_file_location('restart_core',WEB/'deploy_when_idle.py')
core=importlib.util.module_from_spec(spec);spec.loader.exec_module(core)
OUT=HERE/'验收-20261013';OUT.mkdir(exist_ok=True)
STATE=OUT/'重启状态.json'
SERVICES=['cn.pi.web'] if '--web-only' in sys.argv else ['cn.pi.github-mcp','cn.pi.playwright-mcp','cn.pi.web']

def save(status,**extra):
    payload={'status':status,'at':time.strftime('%Y-%m-%d %H:%M:%S'),'scope':SERVICES,**extra}
    core.save(STATE,payload);print(json.dumps(payload,ensure_ascii=False),flush=True)

def service_pid(label):
    r=core.command('/bin/launchctl','list',label)
    import re
    m=re.search(r'"PID"\s*=\s*(\d+)',r.stdout)
    if not m:raise RuntimeError('No running launchd PID for '+label)
    return int(m.group(1))

def idle():
    data=core.api('/api/agent/running')
    ids=data.get('runningSessionIds');waiting=data.get('awaitingInputSessionIds')
    if not isinstance(ids,list) or not isinstance(waiting,list):raise RuntimeError('Unknown idle response')
    return not ids and not waiting

try:
    save('waiting_for_idle')
    deadline=time.monotonic()+3600;count=0
    while time.monotonic()<deadline:
        count=count+1 if idle() else 0
        if count>=5:break
        time.sleep(2)
    else:raise RuntimeError('Still busy after one hour; no process stopped')
    # Share the existing deploy lock, never race a package swap.
    with (WEB.parent/'.deployment.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        ds=json.loads((WEB/'upgrade-0.12-state.json').read_text())
        if ds.get('status') in {'prepared','waiting_for_idle','switching','verifying_live','rollback_waiting_for_idle','recovery_blocked'}:
            raise RuntimeError('An unfinished deployment must be resolved before restart')
        core.preflight_launchd()
        before={label:service_pid(label) for label in SERVICES}
        if 'node /opt/homebrew/bin/pi-web --no-open --port 30141' not in core.identity(before['cn.pi.web']):
            raise RuntimeError('Web service identity changed')
        save('restarting',before=before)
        for label in SERVICES:
            if not idle():raise RuntimeError('New activity; remaining services not restarted')
            core.command('/bin/launchctl','kickstart','-k',f'gui/{os.getuid()}/{label}')
        core.healthy(timeout=90)
        after={label:service_pid(label) for label in SERVICES}
        if any(after[s]==before[s] for s in SERVICES):raise RuntimeError('One service PID did not change')
        checks=core.command('/opt/homebrew/bin/node',str(HERE/'check-child-tools.mjs'),timeout=120)
        (OUT/'重启后工具加载.log').write_text(checks.stdout+checks.stderr)
        save('restarted_health_verified',before=before,after=after,
             toolsLoaded=True,liveChildModelVerified=False,
             note='独立终端已发送/reload；此脚本只验证Web/MCP服务与工具加载，真实子代理模型调用待重启后会话验收。')
except Exception as error:
    save('blocked_or_failed',error=str(error))
    raise
