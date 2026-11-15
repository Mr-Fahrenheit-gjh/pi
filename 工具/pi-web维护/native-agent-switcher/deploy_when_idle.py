"""Deploy the combined UI only at idle, from an independent terminal task.

Use --prepare SESSION_ID first, then --apply. No process-name kills, no
configuration changes, and no model wake. The real page is checked after restart.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent
LIVE = Path('/opt/homebrew/lib/node_modules/@agegr/pi-web')
CANDIDATE = Path.home()/'.pi/pi-web-candidates/native-agent-switcher-20261012/app'
STATE = HERE/'deployment-state.json'
PLAN = HERE/'deployment-plan.json'
SERVICE = f'gui/{os.getuid()}/cn.pi.web'
PLIST = Path.home()/'Library/LaunchAgents/cn.pi.web.plist'
BASE = 'http://127.0.0.1:30141'


def save(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
    temporary.replace(path)


def state(status, **fields):
    save(STATE, {'status': status, 'at': time.strftime('%Y-%m-%d %H:%M:%S'), **fields})
    print(status, fields, flush=True)


def command(*args, check=True, timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'{args}: exit {result.returncode}: {result.stderr.strip()}')
    return result


def api(path, timeout=10):
    request = urllib.request.Request(BASE+path, headers={'Origin': BASE, 'Referer': BASE+'/'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
        return json.load(response)


def listener():
    result = command('/usr/sbin/lsof', '-nP', '-iTCP:30141', '-sTCP:LISTEN', '-t', check=False)
    pids = result.stdout.split()
    if len(pids) != 1:
        raise RuntimeError(f'Expected exactly one Web listener, found {pids}')
    return int(pids[0])


def identity(pid):
    result = command('/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,lstart=,command=')
    return result.stdout.strip()


def launchd_loaded():
    return command('/bin/launchctl', 'print', SERVICE, check=False).returncode == 0


def preflight_launchd():
    # Detect bootstrap permission/domain problems BEFORE stopping the Web service.
    label = f'cn.pi.web.deploy-probe-{os.getpid()}'
    with tempfile.TemporaryDirectory(prefix='pi-web-launchd-') as directory:
        plist = Path(directory)/'probe.plist'
        plist.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': ['/usr/bin/true'], 'RunAtLoad': False}))
        command('/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist))
        command('/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{label}')


def start():
    # bootout can return before launchd finishes removing the previous service.
    deadline = time.monotonic()+30
    error = ''
    while time.monotonic() < deadline:
        if launchd_loaded():
            command('/bin/launchctl', 'kickstart', SERVICE)
            return
        result = command('/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(PLIST), check=False)
        if result.returncode == 0:
            return
        error = result.stderr.strip()
        time.sleep(1)
    raise RuntimeError('launchd bootstrap failed after retries: '+error)


def healthy(timeout=90):
    deadline = time.monotonic()+timeout
    last_error = 'no probe completed'
    while time.monotonic() < deadline:
        started = time.monotonic()
        probe = {'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'url': BASE+'/api/agent/running'}
        try:
            result = api('/api/agent/running', timeout=max(0.1, min(10, deadline-started)))
            if not isinstance(result.get('runningSessionIds'), list):
                raise RuntimeError('Unexpected health response shape')
            probe['ok'] = True
        except Exception as error:
            last_error = f'{type(error).__name__}: {error}'
            probe.update(ok=False, error=last_error)
            if isinstance(error, urllib.error.HTTPError):
                probe['httpStatus'] = error.code
                probe['contentType'] = error.headers.get('Content-Type')
                probe['body'] = error.read(300).decode('utf-8', errors='replace')
        probe['elapsedMs'] = round((time.monotonic()-started)*1000)
        with (HERE/'health-probes.jsonl').open('a') as log:
            log.write(json.dumps(probe, ensure_ascii=False)+'\n')
        if probe['ok']:
            return
        print('health_probe', probe, flush=True)
        time.sleep(min(1, max(0, deadline-time.monotonic())))
    raise RuntimeError('Web did not become healthy; last probe: '+last_error)


def prepare(session_id):
    for filename in ['package.json', 'next.config.ts']:
        if (CANDIDATE/filename).read_bytes() != (LIVE/filename).read_bytes():
            raise RuntimeError('Candidate/runtime mismatch: '+filename)
    build = (CANDIDATE/'.next/BUILD_ID').read_text().strip()
    for test in [HERE/'smoke-result.json', HERE.parent/'pi-web-source-0.11/test-results/quiet-tools/result.json']:
        result = json.loads(test.read_text())
        if not result.get('passed') or result.get('buildId') != build or result.get('packageRoot') != str(CANDIDATE):
            raise RuntimeError('Missing matching browser evidence: '+str(test))
    if (HERE/'deploy.lock').exists():
        raise RuntimeError('Legacy deploy lock exists; inspect its owner first')
    preflight_launchd()
    pid = listener()
    parent = int(command('/bin/ps', '-p', str(pid), '-o', 'ppid=').stdout)
    parent_identity = identity(parent)
    if 'node /opt/homebrew/bin/pi-web --no-open --port 30141' not in parent_identity:
        raise RuntimeError('Unexpected Web parent; refusing to stop it: '+parent_identity)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    staged = LIVE/('.next-combined-staged-'+stamp)
    backup = Path.home()/('.pi/backups/pi-web-combined-'+stamp)
    shutil.copytree(CANDIDATE/'.next', staged, ignore=shutil.ignore_patterns('cache', 'dev'))
    # Keep old tabs' hashed chunks, without overwriting candidate manifests/assets.
    for old in (LIVE/'.next/static').rglob('*'):
        dest = staged/'static'/old.relative_to(LIVE/'.next/static')
        if old.is_file() and not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, dest)
    plan = {'sessionId': session_id, 'buildId': build, 'oldBuild': (LIVE/'.next/BUILD_ID').read_text().strip(),
            'staged': str(staged), 'backup': str(backup), 'listener': pid, 'listenerIdentity': identity(pid),
            'parent': parent, 'parentIdentity': parent_identity, 'managed': launchd_loaded()}
    save(PLAN, plan)
    state('prepared', **plan)


def assert_live_evidence(plan, expected_version):
    """A zero exit code is insufficient: require exact, real functional evidence."""
    result = json.loads((HERE/'live-result.json').read_text())
    if (result.get('buildId') != plan['buildId'] or result.get('sessionId') != plan['sessionId']
            or result.get('version') != expected_version):
        raise RuntimeError('Live evidence identity does not match the deployed build/version/session')
    if result.get('base') != BASE or result.get('packageRoot') != str(LIVE):
        raise RuntimeError('Live evidence must come from the formal service and installed package')
    for key in ['passed', 'realChildVerified', 'quietToolsCollapsed', 'switcherVisible', 'taskManagementHidden']:
        if result.get(key) is not True:
            raise RuntimeError('Missing real live acceptance: '+key)
    if result.get('mocked') is not False or type(result.get('retainedRuns')) is not int or result['retainedRuns'] < 1:
        raise RuntimeError('Live acceptance requires non-mocked persisted child records')
    return result


def assert_baseline(plan):
    if (LIVE/'.next/BUILD_ID').read_text().strip() != plan['oldBuild']:
        raise RuntimeError('Live build changed after preparation')
    if listener() != plan['listener'] or identity(plan['listener']) != plan['listenerIdentity'] or identity(plan['parent']) != plan['parentIdentity']:
        raise RuntimeError('Web process changed after preparation')
    if launchd_loaded() != plan['managed']:
        raise RuntimeError('Service ownership changed after preparation')


def bound_process_alive(pid, expected_identity):
    result = command('/bin/ps', '-p', str(pid), '-o', 'pid=,ppid=,lstart=,command=', check=False)
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return False
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError('Cannot determine bound process identity; refusing a package switch')
    current, expected = result.stdout.split(None, 7), expected_identity.split(None, 7)
    if len(current) != 8 or len(expected) != 8 or current[0] != str(pid) or expected[0] != str(pid):
        raise RuntimeError('Malformed bound process identity; refusing a package switch')
    # PPID and process title can change during shutdown; the start time cannot.
    # A reused PID is not the original process and must never be signalled.
    return current[2:7] == expected[2:7]


def wait_stopped(plan=None):
    deadline = time.monotonic()+30
    while time.monotonic() < deadline:
        result = command('/usr/sbin/lsof', '-nP', '-iTCP:30141', '-sTCP:LISTEN', '-t', check=False)
        # bootout returns before launchd finishes removing its job. A closed
        # socket alone is not a completed stop and must not permit a package swap.
        if not result.stdout.strip() and not launchd_loaded():
            if plan is None or not any(bound_process_alive(plan[key], plan[key+'Identity']) for key in ('listener', 'parent')):
                return
        time.sleep(0.5)
    raise RuntimeError('Web port, launchd job or bound processes did not stop; no forced kill performed')


def apply():
    plan = json.loads(PLAN.read_text())
    staged, backup = Path(plan['staged']), Path(plan['backup'])
    if backup.exists() or (staged/'BUILD_ID').read_text().strip() != plan['buildId']:
        raise RuntimeError('Backup already exists or staged build changed')
    preflight_launchd()
    state('waiting_for_idle', **plan)
    deadline, idle = time.monotonic()+3600, 0
    while time.monotonic() < deadline:
        ids = api('/api/agent/running').get('runningSessionIds')
        idle = idle+1 if isinstance(ids, list) and not ids else 0
        if idle >= 5:
            break
        time.sleep(2)
    else:
        raise RuntimeError('Web stayed busy for one hour; nothing stopped')
    assert_baseline(plan)
    if api('/api/agent/running').get('runningSessionIds'):
        raise RuntimeError('A new prompt started; nothing stopped')
    backup.mkdir(parents=True, mode=0o700)
    save(backup/'manifest.json', plan)
    state('switching', **plan)
    swapped = False
    try:
        if plan['managed']:
            command('/bin/launchctl', 'bootout', SERVICE)
        else:
            # Exact, preflighted CLI parent only; its lifecycle handler stops Next.
            os.kill(plan['parent'], signal.SIGTERM)
        wait_stopped()
        shutil.move(str(LIVE/'.next'), str(backup/'.next'))
        shutil.move(str(staged), str(LIVE/'.next'))
        swapped = True
        start()
        healthy()
        state('verifying_live', **plan)
        result = command('/opt/homebrew/bin/node', str(HERE/'verify-live.mjs'), plan['sessionId'], plan['buildId'], timeout=180)
        (HERE/'live-verification.log').write_text(result.stdout+result.stderr)
        state('deployed', **plan, assetsOnly=True, verifiedLive=True, evidence=str(HERE/'live-result.json'))
        save(HERE.parent/'简洁工具显示/deployment-state.json', {
            'status': 'deployed', 'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'buildId': plan['buildId'],
            'combinedDeployment': str(STATE), 'verifiedLive': True})
    except Exception as error:
        # Do not replace an unverified release with a false success record.
        if swapped or (backup/'.next').exists():
            if launchd_loaded():
                command('/bin/launchctl', 'bootout', SERVICE)
                wait_stopped()
            if swapped:
                shutil.move(str(LIVE/'.next'), str(backup/'withdrawn-next'))
            shutil.move(str(backup/'.next'), str(LIVE/'.next'))
        try:
            start()
            healthy()
        except Exception as recovery_error:
            state('recovery_failed', error=str(error), recoveryError=str(recovery_error), **plan)
            raise
        state('rolled_back', error=str(error), **plan)
        raise


if __name__ == '__main__':
    raise SystemExit('This 0.11 asset-only deployment entry is retired. Use native-agent-switcher/upgrade_when_idle.py for the combined package.')
