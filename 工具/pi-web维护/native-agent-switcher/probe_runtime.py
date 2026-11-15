"""Probe a production candidate with the real CLI/dependencies, without opening a session."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import tempfile
import plistlib
import shlex

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('core', HERE/'deploy_when_idle.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


def probe(package, launchd=False, history_verification=False):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    core.BASE = f'http://127.0.0.1:{port}'
    log_path = package.parent/'runtime-probe.log'
    sdk_root = str((package/'node_modules/@earendil-works/pi-coding-agent').resolve())
    with tempfile.TemporaryDirectory(prefix='pi-web-probe-', dir=Path.home()/'.pi') as directory, log_path.open('w') as log:
        label = f'cn.pi.web.upgrade-probe-{os.getpid()}'
        service = f'gui/{os.getuid()}/{label}'
        process = None
        if launchd:
            launcher = Path(directory)/'serve.sh'
            original = (Path.home()/'.local/bin/pi-web-serve').read_text()
            expected = 'exec /opt/homebrew/bin/pi-web '
            if original.count(expected) != 1:
                raise RuntimeError('Unknown service launcher; refusing to invent its environment')
            launcher.write_text(original.replace(expected, 'export PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT='+shlex.quote(sdk_root)+'\nexec /opt/homebrew/bin/node '+shlex.quote(str(package/'bin/pi-web.js'))+' '))
            launcher.chmod(0o700)
            plist = Path(directory)/'probe.plist'
            plist.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': [str(launcher)], 'RunAtLoad': True,
                'WorkingDirectory': str(Path.home()), 'StandardOutPath': str(log_path), 'StandardErrorPath': str(log_path),
                'EnvironmentVariables': {'PI_WEB_PORT': str(port), 'PI_ROUTE_ENV': str(Path.home()/'.pi/agent/pi-web-proxy.env'), 'PI_WEB_BROWSER_PROFILE': str(Path(directory)/'browser-profile')}}))
            core.command('/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist))
        else:
            process = subprocess.Popen(['/opt/homebrew/bin/node', str(package/'bin/pi-web.js'), '--no-open', '--port', str(port)],
                cwd=Path.home(), env={**os.environ, 'NODE_ENV': 'production', 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT': sdk_root, 'PI_WEB_BROWSER_PROFILE': str(Path(directory)/'browser-profile')}, stdout=log, stderr=log, start_new_session=True)
        started = time.monotonic()
        try:
            try:
                core.healthy()
            except Exception:
                if launchd:
                    details = core.command('/bin/launchctl', 'print', service, check=False).stdout
                    print('\n'.join(line for line in details.splitlines() if any(key in line for key in ['state =', 'pid =', 'exit code', 'reason =', 'runs ='])), flush=True)
                raise
            snapshot = core.api('/api/agent/running')
            if snapshot['runningSessionIds']:
                raise RuntimeError('Probe unexpectedly started a session')
            result = {'passed': True, 'packageRoot': str(package), 'version': json.loads((package/'package.json').read_text())['version'],
                      'buildId': (package/'.next/BUILD_ID').read_text().strip(), 'elapsedSeconds': round(time.monotonic()-started, 2),
                      'realHome': True, 'productionCli': True, 'launchd': launchd,
                      'subagentSdkRoot': sdk_root, 'sdkVersion': json.loads((Path(sdk_root)/'package.json').read_text())['version'],
                      'historyVerification': history_verification, 'sessionStarts': None if history_verification else 0, 'modelRequests': 0}
            core.save(HERE/'runtime-probe-result.json', result)
            print(json.dumps(result), flush=True)
        finally:
            if launchd:
                core.command('/bin/launchctl', 'bootout', service)
                (HERE/'runtime-probe.log').write_text(log_path.read_text())
            elif process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                    raise RuntimeError('Isolated probe failed graceful shutdown')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('--launchd', action='store_true')
    args = parser.parse_args()
    probe(args.package.resolve(), args.launchd)
