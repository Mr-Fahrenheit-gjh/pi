#!/usr/bin/env python3
"""One preparation entry: capability map, read-only preflight, resumable candidate checks/build and same-build evidence. Never deploys."""
import argparse
from concurrent.futures import CancelledError, ThreadPoolExecutor, as_completed
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
RECOVERY_ENGINE = HERE.parents[1] / 'pi-task-recovery/engine.mjs'
INTERRUPT_ADAPTER = HERE.parents[1] / 'pi-interrupt/install.mjs'


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


precheck = module('flow_preflight', 'preflight.py')
bundle = module('flow_bundle', 'dependency_bundle.py')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def identity(root, env):
    # Hash actual bytes and an opaque environment digest, never persist env values.
    types = root / '.next/types'
    value = {'inputs': precheck.runtime_files(root, include_docs=True), 'dependencies': bundle.tree_digest(root / 'node_modules'),
                   'generatedTypes': bundle.tree_digest(types) if types.is_dir() else None,
                   'node': subprocess.check_output(['node', '--version'], text=True).strip(),
                   'environmentDigest': digest(env),
                   # The SDK adapter imports this file outside node_modules.
                   'recoveryEngine': bundle.digest(RECOVERY_ENGINE) if RECOVERY_ENGINE.is_file() else None,
                   # Engine bytes live in source and are vendored into node_modules;
                   # include the external replay/check adapter in cache identity too.
                   'interruptAdapter': bundle.digest(INTERRUPT_ADAPTER) if INTERRUPT_ADAPTER.is_file() else None,
                   'runner': {name: bundle.digest(HERE / name) for name in ['flow.py', 'preflight.py', 'dependency_bundle.py']}}
    checks = digest(value)
    non_output = digest({key: item for key, item in value.items() if key != 'generatedTypes'})
    # Next publishes public/ assets without imports, regardless of their names.
    runtime = {name: hashed for name, hashed in value['inputs'].items()
               if name.startswith('public/') or not name.endswith('.md')}
    build_inputs = {name: hashed for name, hashed in runtime.items()
                    if name.startswith('public/') or (not name.startswith('e2e/') and '.test.' not in name
                    and name not in ['local-customizations.json', 'eslint.config.mjs'])}
    # Only apply the test/build split for our known Next build. If production
    # source or a custom build references tests/e2e/metadata, fail conservatively
    # to the broader inventory instead of caching an incomplete build input set.
    package_path = root / 'package.json'
    package = json.loads(package_path.read_text()) if package_path.is_file() else {}
    scripts = package.get('scripts', {})
    source_text = '\n'.join((root / name).read_text(errors='replace') for name in build_inputs
                            if Path(name).suffix in ['.ts', '.tsx', '.js', '.mjs', '.cjs'])
    custom_build = scripts.get('build', 'next build --webpack') not in ['next build', 'next build --webpack']
    hook_text = '\n'.join(scripts.get(name, '') for name in ['prebuild', 'build', 'postbuild'])
    imports = re.findall(r'''(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)[\"'`]([^\"'`\n]+)''', source_text)
    referenced = '\n'.join(imports) + hook_text
    if custom_build or any(marker in referenced for marker in ['.test', 'e2e/', 'local-customizations.json', 'eslint.config']):
        build_inputs = runtime
    value['inputs'] = build_inputs
    build = digest(value)
    return {'checks': checks, 'build': build, 'nonOutput': non_output}


def commands(profile, tests):
    if profile == 'upgrade' and tests:
        raise RuntimeError('Core/Web/dependency upgrades require the full test suite')
    if any(Path(file).is_absolute() or '..' in Path(file).parts or file.startswith('-') or not file.endswith(('.test.mjs', '.test.js')) for file in tests):
        raise RuntimeError('Targeted tests must be relative test files inside the candidate')
    test = ['node', '--experimental-strip-types', '--test', *tests] if tests else ['npm', 'test']
    return {'typecheck': ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false'],
            'test': test, 'lint': ['npm', 'run', 'lint']}


def stage_key(input_key, argv):
    return digest({'input': input_key, 'argv': argv})


def reusable(stage, key, root):
    if stage.get('status') != 'passed' or stage.get('exitCode') != 0 or stage.get('processGroupExited') is not True or stage.get('key') != key:
        return False
    if stage.get('outputDigest') is not None:
        try:
            return (stage.get('buildId') == (root / '.next/BUILD_ID').read_text().strip()
                    and stage['outputDigest'] == bundle.tree_digest(root / '.next'))
        except (OSError, RuntimeError):
            return False
    return True


def process_identity(pid):
    try:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart=', '-o', 'command='], capture_output=True, text=True, timeout=5)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def process_group_alive(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # Unreadable is not evidence of exit.


def ensure_no_live_stage(stages):
    for stage in stages.values():
        if stage.get('status') not in ['running', 'interrupted', 'failed', 'passed']:
            continue
        if stage.get('status') != 'running' and stage.get('processGroupExited') is True:
            continue
        if not (isinstance(stage.get('pid'), int) and isinstance(stage.get('processGroup'), int) and stage.get('pidIdentity')):
            raise RuntimeError('Unfinished validation has no trusted PID/group identity; inspect the original task before retrying')
        pid, group = stage['pid'], stage['processGroup']
        try:
            os.kill(pid, 0)
            alive = True
        except ProcessLookupError:
            alive = False
        if alive:
            actual = process_identity(pid)
            if actual and actual != stage['pidIdentity']:
                try:
                    reused_group = os.getpgid(pid)
                except ProcessLookupError:
                    reused_group = None
                if reused_group == group or not process_group_alive(group):
                    continue  # Original group is gone; the PID belongs to a new task.
            raise RuntimeError('An earlier validation child may still be alive; inspect its exact PID/group/log instead of starting a duplicate')
        if process_group_alive(group):
            raise RuntimeError('An earlier validation process group still has descendants; inspect it before retrying')


class GroupCleanupError(RuntimeError):
    pass


class Validator:
    def __init__(self, root, env, report):
        self.root, self.env, self.report = root, env, report
        self.directory = root / 'test-results/maintenance'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'validation.json'
        self.state = json.loads(self.path.read_text()) if self.path.is_file() else {'stages': {}}
        if not isinstance(self.state.get('stages'), dict):
            raise RuntimeError('Invalid validation record; preserve it for inspection')
        ensure_no_live_stage(self.state['stages'])
        self.lock = threading.RLock()
        self.processes = {}
        self.cancelled = threading.Event()

    def save(self):
        with self.lock:
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.state, indent=2) + '\n')
            temporary.replace(self.path)

    def run(self, name, argv, key=None, extra_env=None, timeout=900, output=False, expected_input=None):
        with self.lock:
            if self.cancelled.is_set():
                raise CancelledError('Validation was cancelled before stage admission')
            old = self.state['stages'].get(name, {})
            if key and (not output or old.get('outputDigest')) and reusable(old, key, self.root):
                old['reused'] = True
                self.save()
                print(json.dumps({'stage': name, 'status': 'reused', 'priorElapsedSeconds': old.get('elapsedSeconds')}), flush=True)
                return
            stage = {'status': 'running', 'key': key, 'argv': argv, 'startedAt': time.time(), 'reused': False}
            self.state['stages'][name] = stage
            self.save()
        started = time.monotonic()
        creation_attempted = False
        process = None
        try:
            with (self.directory / (name + '.log')).open('w') as log:
                with self.lock:
                    if self.cancelled.is_set():
                        raise CancelledError('Validation was cancelled before process creation')
                    creation_attempted = True
                    process = subprocess.Popen(argv, cwd=self.root, env={**self.env, **(extra_env or {})},
                                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    self.processes[name] = process
                    stage.update(pid=process.pid, processGroup=process.pid,
                                 pidIdentity=process_identity(process.pid), cwd=str(self.root))
                    self.save()
                try:
                    code = process.wait(timeout=timeout)
                except BaseException:
                    self.terminate(process, stage.get('pidIdentity'))
                    raise
            with self.lock:
                stage['exitCode'] = code
            if code:
                raise RuntimeError(f'{name} exited {code}; inspect {self.directory / (name + ".log")}')
            if process_group_alive(process.pid):
                raise RuntimeError(f'{name} leader exited but workers remain; inspect the recorded group before continuing')
            if output:
                if expected_input is None or identity(self.root, self.env)['nonOutput'] != expected_input:
                    raise RuntimeError('Candidate source/dependencies changed during build; output is not a reusable success')
                result = {'buildId': (self.root / '.next/BUILD_ID').read_text().strip(), 'outputDigest': bundle.tree_digest(self.root / '.next')}
                with self.lock:
                    stage.update(result)
            with self.lock:
                stage['status'] = 'passed'
        except BaseException as error:
            cleanup_error = None
            if process is not None:
                try:
                    self.terminate(process, stage.get('pidIdentity'))
                except GroupCleanupError as failure:
                    cleanup_error = failure
            with self.lock:
                stage.update(status='interrupted' if self.cancelled.is_set() or isinstance(error, (KeyboardInterrupt, CancelledError)) else 'failed', errorType=type(error).__name__)
                if cleanup_error:
                    stage.update(cleanupFailed=True, cleanupErrorType=type(cleanup_error).__name__)
            if cleanup_error:
                raise cleanup_error from error
            raise
        finally:
            with self.lock:
                self.processes.pop(name, None)
                if isinstance(stage.get('processGroup'), int):
                    stage['processGroupExited'] = not process_group_alive(stage['processGroup'])
                elif not creation_attempted:
                    stage['processGroupExited'] = True
                stage['elapsedSeconds'] = round(time.monotonic() - started, 3)
                self.save()
                print(json.dumps({'stage': name, 'status': stage['status'], 'elapsedSeconds': stage['elapsedSeconds']}), flush=True)

    @staticmethod
    def terminate(process, identity=None, grace=1.0, kill_grace=1.0):
        group = process.pid  # Popen(start_new_session=True): our private group.

        def owned_group_alive():
            exited = process.poll() is not None  # Reap the leader, not a group-exit proof.
            if not process_group_alive(group):
                return False
            if exited:
                # A failed/timed-out ps query is not proof that the PID is gone.
                try:
                    os.kill(process.pid, 0)
                except ProcessLookupError:
                    return True  # Dead leader, still-live original private group.
                except PermissionError as error:
                    raise GroupCleanupError('Cannot prove whether the old group leader PID is gone; do not signal an unknown group') from error
                current = process_identity(process.pid)
                if not current:
                    raise GroupCleanupError('Leader PID exists but its identity is unknown; do not signal the group')
                try:
                    current_group = os.getpgid(process.pid)
                except (ProcessLookupError, PermissionError) as error:
                    raise GroupCleanupError('Leader identity/group changed during cleanup; preserve it for inspection') from error
                if current_group == group:
                    if identity and current != identity:
                        return False  # PID/PGID reused; never signal the new group.
                    raise GroupCleanupError('Cannot prove ownership of a reused validation group; retain its identity for inspection')
            return True

        def wait_for_group(seconds):
            deadline = time.monotonic() + seconds
            while owned_group_alive():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                time.sleep(min(0.02, remaining))
            return True

        try:
            if not owned_group_alive():
                return
            os.killpg(group, signal.SIGTERM)
            if wait_for_group(grace):
                return
            if owned_group_alive():
                os.killpg(group, signal.SIGKILL)
            if not wait_for_group(kill_grace):
                raise GroupCleanupError(f'Validation group {group} did not exit after TERM/KILL; retain PID/group/logs and inspect it')
        except ProcessLookupError:
            process.poll()
        except PermissionError as error:
            raise GroupCleanupError('Permission denied while cleaning the owned validation group; preserve identity') from error

    def cancel(self):
        with self.lock:
            self.cancelled.set()

    def close(self):
        self.cancel()
        with self.lock:
            processes = [(name, process, self.state['stages'][name].get('pidIdentity')) for name, process in self.processes.items()]
        errors = []
        for name, process, identity in processes:
            try:
                self.terminate(process, identity)
            except GroupCleanupError as error:
                errors.append(error)
                with self.lock:
                    self.state['stages'][name].update(cleanupFailed=True, cleanupErrorType=type(error).__name__)
                    self.save()
        if errors:
            raise GroupCleanupError('One or more owned validation groups could not be cleaned; all identities/logs retained') from errors[0]


def validate(report, profile='runtime', tests=(), jobs=2, skip_build=False):
    if not report.get('passed') or report.get('phase') != 'candidate':
        raise RuntimeError('Successful candidate preflight is required')
    root = Path(report['candidateDirectory'])
    env = {key: value for key, value in os.environ.items() if key not in ['PI_SESSION_ID', 'PI_SESSION_FILE', 'TERM', 'COLUMNS', 'LINES', '_', 'PI_WEB_PRECHECKED_TYPES']}
    env.update(PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=str(root / 'node_modules/@earendil-works/pi-coding-agent'), NEXT_TELEMETRY_DISABLED='1')
    stages = commands(profile, tests)
    for file in tests:
        path = root / file
        if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
            raise RuntimeError('Targeted test is missing or outside the candidate: ' + file)
    # One validation writer per candidate, separate from the existing deploy lock.
    with (root / '.validation-lock').open('a') as file:
        fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        runner = Validator(root, env, report)
        started = time.monotonic()
        pool, futures = None, []
        try:
            if (root / 'bin/prepare-ghostty.mjs').is_file():
                runner.run('assets', ['node', 'bin/prepare-ghostty.mjs'])
            # Generate current route types before tsc; an old .next/types is not enough.
            runner.run('typegen', ['node', 'node_modules/next/dist/bin/next', 'typegen'])
            input_key = identity(root, env)
            runner.state.update(schemaVersion=1, packageRoot=str(root), inputKey=input_key, profile=profile,
                                coverage='targeted' if tests else 'full', status='validating')
            runner.save()
            pool = ThreadPoolExecutor(max_workers=jobs)
            futures = [pool.submit(runner.run, name, argv, stage_key(input_key['checks'], argv)) for name, argv in stages.items()]
            errors = []
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as error:
                    errors.append(str(error))
            if errors:
                raise RuntimeError('; '.join(errors))
            if identity(root, env) != input_key:
                raise RuntimeError('Candidate inputs/dependencies/environment changed during checks; do not reuse typecheck')
            if not skip_build:
                argv = ['npm', 'run', 'build']
                runner.run('build', argv, stage_key(input_key['build'], argv), {'PI_WEB_PRECHECKED_TYPES': '1'}, output=True, expected_input=input_key['nonOutput'])
            remaining = ['Same-build browser/quiet-tools acceptance', 'Authorized real launchd probe',
                         'Exact real-history acceptance', 'Existing guarded prepare/apply and formal confirmation']
            if profile == 'upgrade':
                remaining.insert(0, 'SDK/runner/recovery compatibility gates and same-build core evidence required by the approved migration contract')
            runner.state.update(status='static_validated' if skip_build else 'candidate_built',
                                elapsedSeconds=round(time.monotonic() - started, 3),
                                coverageScope='Application test command, not the remaining release/SDK acceptance', remaining=remaining)
            runner.save()
            return runner.state
        except BaseException:
            with runner.lock:
                runner.state['status'] = 'interrupted_or_failed'
                runner.save()
            raise
        finally:
            runner.cancel()
            for future in futures:
                future.cancel()
            try:
                runner.close()
            finally:
                if pool:
                    pool.shutdown(wait=True, cancel_futures=True)


def configuration():
    config = json.loads((HERE / 'local-update.json').read_text())
    source = (HERE / config['sourceDirectory']).resolve()
    candidate = Path(config['candidateDirectory']).expanduser().resolve()
    return config, source, candidate


def features():
    """Show what the product already supports before adding another implementation."""
    _, source, _ = configuration()
    custom = json.loads((source / 'local-customizations.json').read_text())
    navigation = (source / 'lib/settings-navigation.ts').read_text()
    sections = re.findall(r'^\s{2}"([a-z][a-z-]*)",$', navigation, re.M)
    locales = sorted(path.stem for path in (source / 'lib/i18n/messages').glob('*.ts'))
    routes = sorted({str(path.parent.relative_to(source / 'app/api')).split('/')[0] for path in (source / 'app/api').rglob('route.ts')})
    suites = sorted(path.stem for path in (source / 'e2e').glob('*.mjs') if path.stem != 'run')
    markers = sorted(custom.get('requiredSourceMarkers', {}))
    print('\n'.join([
        'Pi Web capability map · ' + str(source),
        '',
        '已有本地定制（需求可能已被覆盖）：' + '、'.join(markers),
        '设置分区：' + '、'.join(sections),
        '界面语言：' + '、'.join(locales),
        '已有浏览器验收套件：' + '、'.join(suites),
        'API 路由组：' + '、'.join(routes),
        '',
        '先检查以上入口；能复用就直说操作，不新增源码、候选或验收脚本。',
    ]), flush=True)
    return 0


NODE = shutil.which('node') or '/opt/homebrew/bin/node'


def artifact_problems(artifacts, build, package_root, fixture):
    problems = []
    for name, path, requires_history in artifacts:
        try:
            proof = json.loads(Path(path).read_text())
        except (OSError, ValueError) as error:
            problems.append(f'{name}: 缺少或无法读取 {path} ({error})')
            continue
        if proof.get('passed') is not True:
            problems.append(f'{name}: passed 不为 true')
        if proof.get('buildId') != build:
            problems.append(f'{name}: buildId 与候选不一致')
        if str(proof.get('packageRoot')) != str(package_root):
            problems.append(f'{name}: packageRoot 不是当前候选')
        if name == 'runtime-probe' and proof.get('launchd') is not True:
            problems.append(f'{name}: 缺少真实 launchd 环境证据')
        if requires_history and fixture:
            for key, expected in [('sessionId', fixture['sessionId']), ('realHistoryRunId', fixture['runId']),
                                  ('expectedChildText', fixture['expectedText'])]:
                if proof.get(key) != expected:
                    problems.append(f'{name}: {key} 与精确真实历史不一致')
    return problems


class TempServer:
    """Serve one candidate build on an isolated local port for real-history checks."""

    def __init__(self, root, log):
        self.root = Path(root)
        self.log = log
        self.process = None
        self.base = None

    def __enter__(self):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        sdk = str(self.root / 'node_modules/@earendil-works/pi-coding-agent')
        env = dict(os.environ, NODE_ENV='production', PI_WEB_HOSTNAME='127.0.0.1', PI_WEB_PASSWORD='',
                   PI_PACKAGE_DIR=sdk, PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT=sdk)
        for key in ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_WEB_VERIFY_BASE', 'PI_WEB_VERIFY_PACKAGE_ROOT']:
            env.pop(key, None)
        self.base = f'http://127.0.0.1:{port}'
        self.process = subprocess.Popen([NODE, 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', str(port)],
                                        cwd=self.root, env=env, stdout=self.log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError('Candidate server exited before accepting connections')
            try:
                urllib.request.urlopen(self.base, timeout=2)
                return self.base
            except urllib.error.HTTPError:
                return self.base
            except (urllib.error.URLError, OSError):
                time.sleep(0.3)
        raise RuntimeError('Candidate server did not become reachable: ' + self.base)

    def __exit__(self, *_):
        if self.process is None or self.process.poll() is not None:
            return False
        os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=5)
        return False


def evidence(dry_run=False, bundle_mode=None):
    """Generate the three same-build release artifacts with one command."""
    config, source, candidate = configuration()
    build_file = candidate / '.next/BUILD_ID'
    if not build_file.is_file():
        raise RuntimeError('Candidate build is missing: ' + str(candidate))
    build = build_file.read_text().strip()
    version = json.loads((candidate / 'package.json').read_text())['version']
    fixture = module('flow_history', 'history_fixture.py').load_fixture(config, HERE)
    quiet = source / 'test-results/quiet-tools/result.json'
    smoke = HERE / 'smoke-result.json'
    probe = HERE / 'runtime-probe-result.json'
    artifacts = [('quiet-tools', quiet, False), ('runtime-probe', probe, False), ('real-history', smoke, True)]
    output = candidate / 'test-results/maintenance/evidence' / build
    identity_info = {'buildId': build, 'version': version, 'candidate': str(candidate), 'source': str(source)}
    if dry_run:
        problems = artifact_problems(artifacts, build, candidate, fixture)
        print(json.dumps({'artifactsCurrent': not problems,
                          'dryRun': True, 'identity': identity_info,
                          'problems': problems,
                          'steps': ['quiet-tools', 'runtime-probe --launchd', 'real-history (temporary candidate server)'],
                          'output': str(output)}, ensure_ascii=False, indent=2), flush=True)
        return 0
    report = precheck.preflight(phase='candidate', dependency_mode=bundle_mode)
    if not report.get('passed'):
        raise RuntimeError('Candidate preflight failed; resolve blockers before generating evidence')
    output.mkdir(parents=True, exist_ok=True)
    base_env = {key: value for key, value in os.environ.items()
                if key not in ['PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_WEB_VERIFY_BASE', 'PI_WEB_VERIFY_PACKAGE_ROOT',
                               'PI_WEB_VERIFY_OUTPUT_DIR', 'PI_WEB_VERIFY_SMOKE_OUTPUT', 'PI_WEB_CHAT_PACKAGE_ROOT']}
    steps = []

    def run(name, argv, extra=None, timeout=900):
        log = output / f'{name}.log'
        started = time.monotonic()
        with log.open('w') as stream:
            result = subprocess.run(argv, cwd=HERE, env={**base_env, **(extra or {})}, stdout=stream,
                                    stderr=subprocess.STDOUT, timeout=timeout)
        steps.append({'name': name, 'exitCode': result.returncode, 'elapsedSeconds': round(time.monotonic() - started, 1), 'log': str(log)})
        if result.returncode:
            raise RuntimeError(f'{name} failed (exit {result.returncode}); see {log}')

    run('quiet-tools', [NODE, str(source / 'e2e/quiet-tools.mjs')], {'PI_WEB_CHAT_PACKAGE_ROOT': str(candidate)})
    run('runtime-probe', [sys.executable, str(HERE / 'probe_runtime.py'), str(candidate), '--launchd'], timeout=180)
    with (output / 'real-history-server.log').open('wb') as server_log, TempServer(candidate, server_log) as base:
        run('real-history', [NODE, str(HERE / 'verify-live.mjs'), fixture['sessionId'], build, version] + ([bundle_mode] if bundle_mode else []), {
            'PI_WEB_VERIFY_BASE': base,
            'PI_WEB_VERIFY_PACKAGE_ROOT': str(candidate),
            'PI_WEB_VERIFY_OUTPUT_DIR': str(output) + '/',
            'PI_WEB_VERIFY_SMOKE_OUTPUT': str(smoke),
        }, timeout=600)
    problems = artifact_problems(artifacts, build, candidate, fixture)
    release = precheck.preflight(phase='release', dependency_mode=bundle_mode)
    blockers = [check['name'] + ': ' + str(check.get('error')) for check in release.get('checks', []) if not check.get('passed')]
    print(json.dumps({'passed': not problems and not blockers, 'buildId': build, 'candidate': str(candidate),
                      'steps': steps, 'problems': problems, 'releaseReady': release.get('passed'),
                      'blockers': blockers, 'output': str(output)}, ensure_ascii=False, indent=2), flush=True)
    return 0 if not problems and not blockers else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--validate', action='store_true', help='Explicitly run checks/build only in the configured independent candidate')
    parser.add_argument('--profile', choices=['ui', 'runtime', 'upgrade'], default='runtime')
    parser.add_argument('--test', action='append', default=[])
    parser.add_argument('--jobs', type=int, choices=[1, 2, 3], default=2)
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--dependency-mode', choices=bundle.MODES)
    parser.add_argument('--features', action='store_true', help='Print existing settings/locales/API/e2e capabilities and exit')
    parser.add_argument('--evidence', action='store_true', help='Generate same-build quiet-tools, launchd and real-history evidence, then report release readiness')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--bundle', default=None)
    args = parser.parse_args(argv)
    if args.features:
        return features()
    if args.evidence:
        try:
            return evidence(dry_run=args.dry_run, bundle_mode=args.bundle)
        except Exception as error:
            print(json.dumps({'passed': False, 'error': str(error)}, ensure_ascii=False, indent=2), flush=True)
            return 1
    report = precheck.preflight(phase='candidate' if args.validate else 'source', dependency_mode=args.dependency_mode)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report['passed']:
        return 1
    if args.validate:
        storage = module('flow_storage', 'storage_policy.py')
        with storage.deployment_lock():
            storage.maintain(enforce_limits=not args.skip_build)
            if not args.skip_build:
                storage.preflight_space(report['candidateDirectory'])
        result = validate(report, args.profile, args.test, args.jobs, args.skip_build)
        print(json.dumps({key: result[key] for key in ['status', 'coverage', 'elapsedSeconds', 'remaining']}, ensure_ascii=False, indent=2))
    return 0


def interrupt_cli(signum, frame):
    # Let the main thread close admission and clean private worker groups once.
    # A hard SIGKILL still requires the durable PID/group recovery checks.
    for value in [signal.SIGINT, signal.SIGTERM, getattr(signal, 'SIGHUP', signal.SIGTERM)]:
        signal.signal(value, signal.SIG_IGN)
    raise KeyboardInterrupt('Candidate validation interrupted')


if __name__ == '__main__':
    for value in [signal.SIGINT, signal.SIGTERM, getattr(signal, 'SIGHUP', signal.SIGTERM)]:
        signal.signal(value, interrupt_cli)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('Validation interrupted; inspect the retained stage/PID/group record before retrying.', file=sys.stderr)
        sys.exit(130)
