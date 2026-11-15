"""Whole-package 0.12 upgrade, gated by evidence and idle state; never installs over a live process."""
import argparse
from contextlib import contextmanager
from functools import wraps
import os
import fcntl
import importlib.util
import json
from pathlib import Path
import shutil
import signal
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('core', HERE/'deploy_when_idle.py')
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
bundle_spec = importlib.util.spec_from_file_location('bundle', HERE/'dependency_bundle.py')
bundle = importlib.util.module_from_spec(bundle_spec)
bundle_spec.loader.exec_module(bundle)
history_spec = importlib.util.spec_from_file_location('release_history', HERE/'history_fixture.py')
history = importlib.util.module_from_spec(history_spec)
history_spec.loader.exec_module(history)
deck_spec = importlib.util.spec_from_file_location('design_deck_release', HERE/'design_deck_release.py')
deck = importlib.util.module_from_spec(deck_spec)
deck_spec.loader.exec_module(deck)
LIVE = core.LIVE
CONFIG = json.loads((HERE/'local-update.json').read_text())
SOURCE = (HERE/CONFIG['sourceDirectory']).resolve()
CANDIDATE = Path(CONFIG['candidateDirectory']).expanduser().resolve()
STATE = HERE/'upgrade-0.12-state.json'
PLAN = HERE/'upgrade-0.12-plan.json'
VERSION = CONFIG['targetVersion']
# Derived from the SHA-512-verified original 1.5.0 archive, including every dist file.
META_SDK_VERSION = '1.5.0'
META_ORIGINAL_PACKAGE_SHA256 = '990aac3caff17b717294fa792b4e3f60b991d274d9f4ab6977d6aa42aa43c95e'
META_ORIGINAL_DIST_SHA256 = '7cdb4952bc505f5f557a3b4f7d860763695eb6a6ee3144efe5263971090360b4'
DEPLOY_LOCK = HERE.parent/'.deployment.lock'
TIMING_ENABLED = False  # CLI only; library/unit-test imports stay side-effect free.


@contextmanager
def timed(stage):
    started = time.monotonic()
    outcome, error_type = 'passed', None
    try:
        yield
    except BaseException as error:
        outcome, error_type = 'failed', type(error).__name__
        raise
    finally:
        if TIMING_ENABLED:
            event = {'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'pid': os.getpid(),
                     'stage': stage, 'outcome': outcome, 'errorType': error_type,
                     'elapsedSeconds': round(time.monotonic() - started, 3)}
            try:
                fd = os.open(HERE/'release-timings.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT
                             | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0), 0o600)
                try:
                    if not stat.S_ISREG(os.fstat(fd).st_mode):
                        raise OSError('Timing target must be a regular file')
                    os.write(fd, (json.dumps(event) + '\n').encode())
                finally:
                    os.close(fd)
            except OSError:
                # Telemetry must not turn a successful release into a rollback.
                print('warning: release timing could not be saved', flush=True)


def timed_call(stage, function, *args, **kwargs):
    with timed(stage):
        return function(*args, **kwargs)


def measured(stage):
    def decorate(function):
        @wraps(function)
        def wrapper(*args, **kwargs):
            return timed_call(stage, function, *args, **kwargs)
        return wrapper
    return decorate


def assert_no_pending_plan():
    if STATE.exists():
        previous = json.loads(STATE.read_text())
        if previous.get('status') in {'prepared', 'waiting_for_idle', 'switching', 'verifying_live', 'rollback_waiting_for_idle', 'recovery_blocked', 'recovery_failed'}:
            raise RuntimeError('An unfinished deployment already owns the plan; inspect its state before replacing it')


def state(status, **fields):
    payload = {'status': status, 'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'version': VERSION, **fields}
    core.save(STATE, payload)
    print(status, fields, flush=True)


def package_json(root):
    return json.loads((root/'package.json').read_text())


def supersede(expected_build, reason):
    """Explicitly retire a paused, never-applied plan under the shared deploy lock."""
    previous = json.loads(STATE.read_text())
    plan = json.loads(PLAN.read_text())
    if not reason or previous.get('status') not in {'prepared', 'waiting_for_idle'}:
        raise RuntimeError('Only a paused, pre-switch plan may be superseded with a reason')
    if previous.get('buildId') != expected_build or plan.get('buildId') != expected_build:
        raise RuntimeError('Supersession build identity mismatch')
    if Path(plan['backup']).exists() or (Path(plan['staged'])/'.next/BUILD_ID').read_text().strip() != expected_build:
        raise RuntimeError('Previous plan may have switched or its stage changed')
    core.assert_baseline(plan)
    archive = HERE/'superseded-plans'/time.strftime('%Y%m%d-%H%M%S')
    archive.mkdir(parents=True, exist_ok=False)
    core.save(archive/'state.json', previous)
    core.save(archive/'plan.json', plan)
    state('superseded', previousBuildId=expected_build, reason=reason, archive=str(archive), retainedStage=plan['staged'])


def unused_pre_switch_backup(plan):
    backup = Path(plan['backup'])
    if not backup.exists():
        return None
    manifest = backup/'manifest.json'
    if backup.is_symlink() or not backup.is_dir() or {item.name for item in backup.iterdir()} != {'manifest.json'} or manifest.is_symlink() or not manifest.is_file():
        raise RuntimeError('Backup contains package data or unknown files; refresh is forbidden')
    recorded = json.loads(manifest.read_text())
    if any(recorded.get(key) != plan.get(key) for key in ['buildId', 'oldBuild', 'staged', 'backup']):
        raise RuntimeError('Unused backup initialization does not match the plan')
    return backup


def refresh_owner(expected_build, reason):
    """Rebind a paused plan, including a proven untouched pre-switch failure."""
    previous, plan = json.loads(STATE.read_text()), json.loads(PLAN.read_text())
    # A host shutdown can interrupt wait_stopped before the exception handler
    # records recovery_failed. The untouched manifest and dead bound processes
    # below are required before treating that stale waiting state as recovery.
    interrupted_stop = previous.get('status') == 'waiting_for_idle' and Path(plan['backup']).exists()
    failed_lease = (previous.get('status') == 'failed' and plan.get('managed') is False
                    and previous.get('error') == 'Could not acquire Pi Meta deployment lease')
    recovering = previous.get('status') == 'recovery_failed' or interrupted_stop or failed_lease
    if not reason or (previous.get('status') not in {'prepared', 'waiting_for_idle', 'recovery_failed'} and not failed_lease):
        raise RuntimeError('Only a paused pre-switch plan may refresh its owner with a reason')
    if previous.get('buildId') != expected_build or plan.get('buildId') != expected_build:
        raise RuntimeError('Owner refresh build identity mismatch')
    if recovering and any(previous.get(key) != plan.get(key) for key in ['oldBuild', 'staged', 'backup', 'sessionId']):
        raise RuntimeError('Recovery state does not match the prepared plan')
    stage = Path(plan['staged'])
    if (stage/'.next/BUILD_ID').read_text().strip() != expected_build:
        raise RuntimeError('Staged build changed')
    unused_backup = unused_pre_switch_backup(plan)
    if recovering and (unused_backup is None or not plan.get('payloadFingerprint')):
        raise RuntimeError('Recovery requires matching unused backup initialization and a bound payload')
    if interrupted_stop and (plan.get('managed') is not True or any(
            core.bound_process_alive(plan[key], plan[key+'Identity']) for key in ('listener', 'parent'))):
        raise RuntimeError('Interrupted stop is not proven complete; refusing owner refresh')
    if (LIVE/'.next/BUILD_ID').read_text().strip() != plan['oldBuild']:
        raise RuntimeError('Installed build changed; process-only refresh is forbidden')
    if plan.get('payloadFingerprint'):
        bundle.assert_fingerprint(stage, plan['payloadFingerprint'])
    if plan.get('dependencyMode'):
        bundle.validate_dependency_delta(package_json(LIVE)['dependencies'], package_json(stage)['dependencies'], plan['dependencyMode'])
    assert_history_fixture(plan)
    assert_runtime_payload(plan)
    deck.assert_prepared(plan.get('designDeck'), stage)
    core.preflight_launchd()
    listener = core.listener()
    parent = int(core.command('/bin/ps', '-p', str(listener), '-o', 'ppid=').stdout)
    parent_identity = core.identity(parent)
    managed = core.launchd_loaded()
    parent_command = core.command('/bin/ps', '-p', str(parent), '-o', 'command=').stdout.strip()
    if failed_lease and not managed:
        raise RuntimeError('Failed lease requires an already restored managed service; no unleased stop is authorized')
    if (not managed and not recovering) or parent_command != 'node /opt/homebrew/bin/pi-web --no-open --port 30141':
        raise RuntimeError('Refusing to refresh an unknown service owner')
    archive = HERE/'superseded-plans'/('owner-refresh-'+time.strftime('%Y%m%d-%H%M%S'))
    archive.mkdir(parents=True, exist_ok=False)
    core.save(archive/'plan.json', plan)
    core.save(archive/'state.json', previous)
    if unused_backup:
        unused_backup.rename(archive/'unused-backup-initialization')
    plan.update(listener=listener, listenerIdentity=core.identity(listener), parent=parent,
                parentIdentity=parent_identity, managed=managed)
    core.save(PLAN, plan)
    state('prepared', **plan, ownerRefreshed=True, reason=reason, ownerRefreshArchive=str(archive))


def history_fixture(session_id):
    filename = CONFIG.get('historyFixtureFile')
    if not filename:
        return None
    import uuid
    fixture = json.loads((HERE/filename).read_text())
    if fixture.get('sessionId') != session_id:
        raise RuntimeError('History fixture parent mismatch')
    uuid.UUID(session_id)
    uuid.UUID(fixture['runId'])
    text = fixture.get('expectedText')
    if not isinstance(text, str) or not 8 <= len(text.strip()) <= 160 or len(text) > 160:
        raise RuntimeError('Bounded real child text required')
    return fixture


def assert_history_available(fixture):
    if fixture:
        history.inspect(fixture)


def assert_history_fixture(plan):
    if not plan.get('historyFixture') and not CONFIG.get('historyFixtureFile'):
        return
    if plan.get('historyFixture') != history_fixture(plan['sessionId']):
        raise RuntimeError('Real history fixture changed after preparation')
    assert_history_available(plan.get('historyFixture'))


def replay_candidate_adapters(stage):
    """Replay verified SDK-only adapters on the offline clone, never on LIVE."""
    engine = SOURCE/'lib/interrupt-steer.mjs'
    if not engine.is_file():
        return None
    installer = HERE.parents[1]/'pi-interrupt/install.mjs'
    sdk = Path('node_modules/@earendil-works/pi-coding-agent')
    inputs = {str(path): bundle.digest(path) for path in [engine, installer]}
    core.command('/opt/homebrew/bin/node', str(installer), '--sdk', str(CANDIDATE/sdk), '--check')
    core.command('/opt/homebrew/bin/node', str(installer), '--sdk', str(stage/sdk), '--apply', '--allow-external')
    core.command('/opt/homebrew/bin/node', str(installer), '--sdk', str(stage/sdk), '--check')
    if inputs != {str(path): bundle.digest(path) for path in [engine, installer]}:
        raise RuntimeError('Runtime adapter inputs changed during replay')
    return inputs


def meta_original_digest(original):
    digest = bundle.tree_digest(original)
    for directory, _, files in os.walk(original, followlinks=False):
        for name in files:
            path = Path(directory)/name
            if not path.is_symlink() and path.stat().st_nlink != 1:
                raise RuntimeError('Pi Meta original SDK contains a hardlinked file')
    for name in ['dist/cli.js', 'dist/bundle/cli.js']:
        cli = original/name
        if cli.is_symlink() or not cli.is_file() or not os.access(cli, os.X_OK):
            raise RuntimeError('Pi Meta original SDK CLI is missing or not executable')
    return digest


def inspect_meta_original(root):
    modules = root/'node_modules'
    sdk = modules/'@earendil-works/pi-coding-agent'
    original = modules/'.pi-meta-original'
    metadata = sdk/'package.json'
    original_metadata = original/'package.json'
    if (modules.is_symlink() or sdk.is_symlink() or original.is_symlink() or metadata.is_symlink()
            or original_metadata.is_symlink() or not modules.is_dir() or not sdk.is_dir()
            or not original.is_dir() or not metadata.is_file() or not original_metadata.is_file()):
        raise RuntimeError('Pi Meta requires independent candidate and staged SDK directories')
    package = json.loads(metadata.read_text())
    if package.get('name') != '@earendil-works/pi-coding-agent' or package.get('version') != META_SDK_VERSION:
        raise RuntimeError('Pi Meta SDK version does not match the verified original')
    entries = {path.name for path in original.iterdir()}
    if not {'package.json', 'dist'} <= entries or entries - {'package.json', 'dist', 'node_modules'}:
        raise RuntimeError('Pi Meta original SDK contains an unexpected root entry')
    if (bundle.digest(original_metadata) != META_ORIGINAL_PACKAGE_SHA256
            or bundle.tree_digest(original/'dist') != META_ORIGINAL_DIST_SHA256):
        raise RuntimeError('Pi Meta original SDK fingerprint mismatch')
    sdk_nested, original_nested = sdk/'node_modules', original/'node_modules'
    has_sdk_nested = sdk_nested.exists() or sdk_nested.is_symlink()
    has_original_nested = original_nested.exists() or original_nested.is_symlink()
    if has_sdk_nested != has_original_nested:
        raise RuntimeError('Pi Meta original SDK dependencies do not match the staged SDK')
    if has_sdk_nested and bundle.tree_digest(sdk_nested) != bundle.tree_digest(original_nested):
        raise RuntimeError('Pi Meta original SDK dependencies do not match the staged SDK')
    return meta_original_digest(original)


def stage_meta_original(stage):
    """Add only the verified original SDK to the offline stage, never the live tree."""
    source_marker = SOURCE/'bin/pi-meta-worker.cjs'
    candidate_marker = CANDIDATE/'bin/pi-meta-worker.cjs'
    staged_marker = stage/'bin/pi-meta-worker.cjs'
    candidate_original = CANDIDATE/'node_modules/.pi-meta-original'
    staged_original = stage/'node_modules/.pi-meta-original'
    for marker in [candidate_marker, staged_marker]:
        if marker.is_symlink() or (marker.exists() and not marker.is_file()):
            raise RuntimeError('Pi Meta runtime marker is invalid')
    if not candidate_marker.is_file() and not staged_marker.is_file():
        if any(path.exists() or path.is_symlink() for path in [candidate_original, staged_original]):
            raise RuntimeError('Pi Meta original SDK exists without its runtime marker')
        return None
    if source_marker.is_symlink() or (source_marker.exists() and not source_marker.is_file()):
        raise RuntimeError('Pi Meta runtime marker is invalid')
    if not all(marker.is_file() for marker in [source_marker, candidate_marker, staged_marker]):
        raise RuntimeError('Pi Meta runtime markers do not match')
    marker_digest = bundle.digest(source_marker)
    if any(bundle.digest(marker) != marker_digest for marker in [candidate_marker, staged_marker]):
        raise RuntimeError('Pi Meta runtime markers do not match')
    expected = inspect_meta_original(CANDIDATE)
    if staged_original.exists() or staged_original.is_symlink():
        if inspect_meta_original(stage) != expected:
            raise RuntimeError('Existing staged Pi Meta original differs from the candidate')
    else:
        core.command('/bin/cp', '-cR', str(candidate_original), str(staged_original), timeout=180)
    if inspect_meta_original(CANDIDATE) != expected or inspect_meta_original(stage) != expected:
        raise RuntimeError('Pi Meta original SDK changed during staging')
    if any(bundle.digest(marker) != marker_digest for marker in [source_marker, candidate_marker, staged_marker]):
        raise RuntimeError('Pi Meta runtime marker changed during staging')
    return {'metaOriginalDigest': expected, 'metaWorkerDigest': marker_digest}


def assert_meta_original_payload(plan, package_root=None):
    root = Path(package_root) if package_root is not None else Path(plan['staged'])
    marker = root/'bin/pi-meta-worker.cjs'
    original = root/'node_modules/.pi-meta-original'
    expected = plan.get('metaOriginalDigest')
    marker_digest = plan.get('metaWorkerDigest')
    if marker.is_symlink() or (marker.exists() and not marker.is_file()):
        raise RuntimeError('Staged Pi Meta runtime marker is invalid')
    if not marker.is_file():
        if expected is not None or marker_digest is not None or original.exists() or original.is_symlink():
            raise RuntimeError('Staged Pi Meta runtime marker is missing')
        return
    if not isinstance(marker_digest, str) or len(marker_digest) != 64 or bundle.digest(marker) != marker_digest:
        raise RuntimeError('Staged Pi Meta runtime marker changed after preparation')
    if not isinstance(expected, str) or len(expected) != 64 or meta_original_digest(original) != expected:
        raise RuntimeError('Staged Pi Meta original SDK changed after preparation')


def assert_runtime_payload(plan):
    assert_meta_original_payload(plan)
    inputs = plan.get('runtimeAdapterInputs')
    if not inputs:
        return
    if any(bundle.digest(Path(path)) != expected for path, expected in inputs.items()):
        raise RuntimeError('Runtime adapter inputs changed after preparation')
    stage = Path(plan['staged'])
    if not plan.get('dependencyMode') and package_json(LIVE)['dependencies'] != package_json(stage)['dependencies']:
        raise RuntimeError('Runtime dependency declarations changed after preparation')
    bundle.assert_fingerprint(stage, plan['payloadFingerprint'])
    installer = HERE.parents[1]/'pi-interrupt/install.mjs'
    core.command('/opt/homebrew/bin/node', str(installer), '--sdk', str(stage/'node_modules/@earendil-works/pi-coding-agent'), '--check')


@measured('prepare_total')
def prepare(session_id, dependency_mode=None, ui_polish=False, design_deck=False):
    assert_no_pending_plan()
    source, live = package_json(CANDIDATE), package_json(LIVE)
    if source['version'] != VERSION or live['version'] not in ('0.11.0', VERSION):
        raise RuntimeError('Version drift; refusing this prepared upgrade path')
    payload = None
    if dependency_mode in bundle.MODES:
        bundle.validate_dependency_delta(live['dependencies'], source['dependencies'], dependency_mode)
    elif source['dependencies'] != live['dependencies']:
        raise RuntimeError('Runtime dependency versions changed; needs a separately installed and tested candidate')
    fixture = history_fixture(session_id)
    timed_call('history_preflight', assert_history_available, fixture)
    build = (CANDIDATE/'.next/BUILD_ID').read_text().strip()
    for evidence in [HERE/'smoke-result.json', SOURCE/'test-results/quiet-tools/result.json', HERE/'runtime-probe-result.json']:
        result = json.loads(evidence.read_text())
        if not result.get('passed') or result.get('buildId') != build or result.get('packageRoot') != str(CANDIDATE):
            raise RuntimeError('Missing exact candidate evidence: '+str(evidence))
        if evidence.name == 'runtime-probe-result.json' and not result.get('launchd'):
            raise RuntimeError('The candidate must pass the launchd-environment probe')
        if evidence.name == 'smoke-result.json' and fixture and any(result.get(key) != value for key, value in {
                'sessionId': fixture['sessionId'], 'realHistoryRunId': fixture['runId'], 'expectedChildText': fixture['expectedText']}.items()):
            raise RuntimeError('Candidate evidence must bind the exact real history fixture')
    core.preflight_launchd()
    listener = core.listener()
    parent = int(core.command('/bin/ps', '-p', str(listener), '-o', 'ppid=').stdout)
    parent_identity = core.identity(parent)
    if 'node /opt/homebrew/bin/pi-web --no-open --port 30141' not in parent_identity or not core.launchd_loaded():
        raise RuntimeError('Expected the known managed Web service; refusing an unknown owner')
    # Fail cheap identity/history/owner checks before walking all dependency bytes.
    if dependency_mode in bundle.MODES:
        payload = timed_call('candidate_payload_verification', bundle.verify, CANDIDATE, dependency_mode)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    stage = LIVE.parent/('.pi-web-stage-0.12-'+stamp)
    backup = Path.home()/('.pi/backups/pi-web-upgrade-0.12-'+stamp)
    timed_call('copy_application', shutil.copytree, CANDIDATE, stage, symlinks=True, ignore=shutil.ignore_patterns('node_modules'))
    # APFS copy-on-write clone: independent dependency files, no symlink back into the package being replaced.
    dependency_source = CANDIDATE if payload else LIVE
    timed_call('clone_dependencies', core.command, '/bin/cp', '-cR', str(dependency_source/'node_modules'), str(stage/'node_modules'), timeout=180)
    if (stage/'node_modules').is_symlink():
        raise RuntimeError('Staged dependencies must not point at the live package')
    meta_payload = timed_call('stage_meta_original', stage_meta_original, stage)
    runtime_inputs = timed_call('replay_runtime_adapters', replay_candidate_adapters, stage)
    if payload:
        timed_call('clone_integrity', bundle.assert_fingerprint, stage, payload['fingerprint'])
    runtime_fingerprint = bundle.fingerprint(stage) if runtime_inputs and not payload else None
    # Existing tabs may still request their old hashed chunks until refreshed.
    for old in (LIVE/'.next/static').rglob('*'):
        destination = stage/'.next/static'/old.relative_to(LIVE/'.next/static')
        if old.is_file() and not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, destination)
    # Retain versioned WASM for still-open tabs, without replacing new assets.
    for old in (LIVE/'public/vendor').rglob('*'):
        destination = stage/'public/vendor'/old.relative_to(LIVE/'public/vendor')
        if old.is_file() and not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, destination)
    plan = {'sessionId': session_id, 'version': VERSION, 'oldVersion': live['version'], 'buildId': build,
        'oldBuild': (LIVE/'.next/BUILD_ID').read_text().strip(), 'staged': str(stage), 'backup': str(backup),
        'listener': listener, 'listenerIdentity': core.identity(listener), 'parent': parent,
        'parentIdentity': parent_identity, 'managed': True}
    if fixture:
        plan['historyFixture'] = fixture
    if meta_payload:
        plan.update(meta_payload)
    if ui_polish:
        plan['uiPolish'] = True
    if payload:
        plan.update(dependencyMode=dependency_mode, payloadFingerprint=timed_call('retained_assets_fingerprint', bundle.fingerprint_after_retaining_assets, stage, payload['fingerprint']),
                    dependencyEvidence=str(bundle.EVIDENCE))
    if runtime_inputs:
        plan['runtimeAdapterInputs'] = runtime_inputs
        if not payload:
            plan['payloadFingerprint'] = bundle.fingerprint_after_retaining_assets(stage, runtime_fingerprint)
    if design_deck:
        plan['designDeck'] = timed_call('prepare_design_deck', deck.prepare, stage, SOURCE/'scripts/patch-design-deck.mjs')
    assert_meta_original_payload(plan)
    core.save(PLAN, plan)
    state('prepared', **plan)


UI_POLISH_FLAGS = ['sidebarPolishVerified', 'terminalWheelVerified', 'sharedRecoveryHooksVerified', 'terminalToolbarRemovedVerified', 'htmlIframePreviewVerified']


def assert_ui_polish_evidence(plan, acceptance):
    if plan.get('uiPolish') and any(acceptance.get(key) is not True for key in UI_POLISH_FLAGS):
        raise RuntimeError('Missing real sidebar/browser/wheel/recovery acceptance')


IDLE_WAIT_SECONDS = 24 * 60 * 60
# Explicit operator authorization only; consumed at the first successful stop.
RESTART_SESSION_ID = None


def blocking_sessions(ids):
    if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids):
        raise RuntimeError('Malformed running snapshot; refusing a stop')
    return [item for item in ids if item != RESTART_SESSION_ID]


def running_session_ids():
    snapshot = core.api('/api/agent/running')
    ids = snapshot.get('runningSessionIds')
    other = snapshot.get('otherRuntimeRunningSessionIds', [])
    if not isinstance(ids, list) or not isinstance(other, list) or any(not isinstance(item, str) for item in ids + other):
        raise RuntimeError('Idle state is unknown: Malformed running snapshot; refusing a stop')
    return list(dict.fromkeys(ids + other))


def active_terminal_pids():
    # node-pty allocates a different controlling TTY, including after `exec codex`.
    # Ordinary children may inherit a manually started listener's controlling TTY.
    listener = core.listener()
    rows = [line.split() for line in core.command('/bin/ps', '-axo', 'pid=,ppid=,tty=').stdout.splitlines() if line.strip()]
    if not rows or any(len(row) != 3 or not row[0].isdecimal() or not row[1].isdecimal() for row in rows):
        raise RuntimeError('Cannot determine live terminal state; refusing a stop')
    listener_rows = [row for row in rows if int(row[0]) == listener]
    if len(listener_rows) != 1:
        raise RuntimeError('Cannot determine live terminal state; refusing a stop')
    inherited_tty = listener_rows[0][2]
    return [int(pid) for pid, parent, tty in rows if int(parent) == listener and tty not in {'??', '?', '-', inherited_tty}]


@measured('idle_wait')
def wait_idle(deadline=None):
    deadline, idle = deadline if deadline is not None else time.monotonic()+IDLE_WAIT_SECONDS, 0
    while time.monotonic() < deadline:
        ids = running_session_ids()
        blockers = blocking_sessions(ids)
        idle = idle+1 if not blockers and not active_terminal_pids() else 0
        if idle >= (1 if RESTART_SESSION_ID else 5):
            return
        time.sleep(2)
    raise RuntimeError('Web work or terminals still active after 24 hours; no active work stopped')


class ServiceBusy(RuntimeError):
    """A known active prompt is a retryable idle race, not a deployment failure."""


class ServiceStopIncomplete(RuntimeError):
    """A stop was requested successfully, but its completion remains unproven."""


class MetaDeploymentLease:
    def __init__(self, lease_id, response):
        self.id = lease_id
        self.close_transport = response.close


@contextmanager
def meta_deployment_lease():
    """Keep Meta and Web admission drained until the authorized stop has started."""
    marker = LIVE/'bin/pi-meta-worker.cjs'
    original = LIVE/'node_modules/.pi-meta-original'
    if marker.is_symlink() or original.is_symlink():
        raise RuntimeError('Pi Meta runtime identity is linked; refusing to stop')
    if not marker.exists():
        if original.exists():
            raise RuntimeError('Pi Meta runtime marker is missing; refusing to stop')
        yield None  # Existing Web versions do not yet contain Pi Meta.
        return
    if not marker.is_file():
        raise RuntimeError('Pi Meta runtime marker is invalid; refusing to stop')
    snapshot = core.api('/api/agent/running')
    if type(snapshot.get('piMetaDeploymentLease')) is not int or snapshot['piMetaDeploymentLease'] != 1:
        raise RuntimeError('Pi Meta deployment lease is unavailable; refusing to stop')
    ids = snapshot.get('runningSessionIds')
    other = snapshot.get('otherRuntimeRunningSessionIds', [])
    if not isinstance(ids, list) or not isinstance(other, list) or any(not isinstance(item, str) for item in ids + other):
        raise RuntimeError('Idle state is unknown: Malformed running snapshot; refusing a stop')
    if blocking_sessions(ids + other):
        raise ServiceBusy('A new prompt started; refusing to stop active work')
    request = urllib.request.Request(
        core.BASE+'/api/service/meta-deployment', data=b'{"confirmed":true}', method='POST',
        headers={'Origin': core.BASE, 'Referer': core.BASE+'/', 'Content-Type': 'application/json'},
    )
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=15)
    except urllib.error.HTTPError as error:
        error.close()
        if error.code == 409:
            raise ServiceBusy('Pi Meta is busy; refusing to stop active work') from error
        raise RuntimeError('Could not acquire Pi Meta deployment lease') from error
    try:
        line = response.readline(4096)
        try:
            result = json.loads(line)
            if not isinstance(result, dict):
                raise ValueError('invalid response')
            lease_id = result['leaseId']
            if result.get('ok') is not True or not isinstance(lease_id, str) or str(uuid.UUID(lease_id)) != lease_id:
                raise ValueError('invalid lease')
        except (ValueError, TypeError, KeyError) as error:
            raise RuntimeError('Pi Meta deployment lease response is invalid') from error
        yield MetaDeploymentLease(lease_id, response)
    finally:
        response.close()


def assert_meta_lease_owned(lease_id):
    reply = core.api('/api/service/meta-deployment?leaseId='+urllib.parse.quote(lease_id, safe=''))
    if reply.get('owns') is not True:
        raise RuntimeError('Pi Meta deployment lease was lost; refusing to stop')


def meta_lease_action(lease_id, action):
    if action not in {'commit', 'cancel'}:
        raise ValueError('Invalid Pi Meta lease action')
    body = json.dumps({'confirmed': True, 'action': action, 'leaseId': lease_id}).encode()
    request = urllib.request.Request(
        core.BASE+'/api/service/meta-deployment', data=body, method='POST',
        headers={'Origin': core.BASE, 'Referer': core.BASE+'/', 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=15) as response:
            reply = json.load(response)
    except urllib.error.HTTPError as error:
        error.close()
        raise RuntimeError('Pi Meta deployment lease action was refused') from error
    if not isinstance(reply, dict) or reply.get('ok') is not True:
        raise RuntimeError('Pi Meta deployment lease action was not confirmed')


def cancel_unsubmitted_meta_lease(lease_id):
    # Safe only before a stop was submitted or after a definite spawn failure.
    try:
        meta_lease_action(lease_id, 'cancel')
    except Exception:
        pass  # Preserve the committed lease if cancellation is uncertain.


def stop_idle_service(plan=None):
    global RESTART_SESSION_ID
    # Rollback uses this guard too: the one-shot restart waiver is already consumed.
    ids = running_session_ids()
    if not isinstance(ids, list):
        raise RuntimeError('Idle state is unknown; refusing to stop active work')
    if blocking_sessions(ids):
        raise ServiceBusy('A new prompt started; refusing to stop active work')
    if active_terminal_pids():
        raise ServiceBusy('Terminal sessions are still open; refusing to stop active work')
    if plan is not None:
        core.assert_baseline(plan)
    with meta_deployment_lease() as lease:
        lease_id = lease.id if lease is not None else None
        if lease_id is not None:
            assert_meta_lease_owned(lease_id)
            # The marker is this updater's own drain, not another running session.
            remaining = [item for item in running_session_ids() if item != 'service:restarting']
            if blocking_sessions(remaining) or active_terminal_pids():
                raise ServiceBusy('New work appeared during the Pi Meta drain')
            assert_meta_lease_owned(lease_id)
            try:
                # After this commit, a lost stream must not reopen admission.
                meta_lease_action(lease_id, 'commit')
                # The committed latch survives disconnect; Next must not wait on our stream.
                lease.close_transport()
            except Exception:
                cancel_unsubmitted_meta_lease(lease_id)
                raise
        try:
            if plan is not None and plan.get('managed') is False:
                # Only refresh_owner can bind this exact CLI parent after an untouched
                # failure; its lifecycle handler closes Next. Never signal the listener.
                os.kill(plan['parent'], signal.SIGTERM)
            else:
                core.command('/bin/launchctl', 'bootout', core.SERVICE)
        except (FileNotFoundError, PermissionError):
            if lease_id is not None: cancel_unsubmitted_meta_lease(lease_id)
            raise
        except Exception as error:
            if lease_id is not None:
                raise ServiceStopIncomplete('Stop request result is unknown; admission remains closed') from error
            raise
        RESTART_SESSION_ID = None
        try:
            core.wait_stopped(plan)
        except Exception as error:
            raise ServiceStopIncomplete(str(error)) from error


def stop_with_idle_retry(plan=None):
    deadline = time.monotonic()+IDLE_WAIT_SECONDS
    while True:
        if plan is not None:
            deck.assert_prepared(plan.get('designDeck'), Path(plan['staged']))
        try:
            stop_idle_service(plan)
            return
        except ServiceBusy:
            # The last check may race with a new prompt. Keep waiting, never force it.
            if plan is not None:
                deck.assert_prepared(plan.get('designDeck'), Path(plan['staged']))
            wait_idle(deadline=deadline)
            if plan is not None:
                assert_history_fixture(plan)
                core.assert_baseline(plan)
                assert_runtime_payload(plan)
                if plan.get('dependencyMode'):
                    stage = Path(plan['staged'])
                    bundle.validate_dependency_delta(package_json(LIVE)['dependencies'], package_json(stage)['dependencies'], plan['dependencyMode'])
                    bundle.assert_fingerprint(stage, plan['payloadFingerprint'])


@measured('apply_total')
def apply():
    plan = json.loads(PLAN.read_text())
    if RESTART_SESSION_ID:
        plan['authorizedRestartSession'] = RESTART_SESSION_ID
    current = json.loads(STATE.read_text())
    if current.get('status') not in {'prepared', 'waiting_for_idle'} or current.get('buildId') != plan['buildId']:
        raise RuntimeError('Only the current prepared plan may be applied')
    assert_history_fixture(plan)
    stage, backup = Path(plan['staged']), Path(plan['backup'])
    if backup.exists() or (stage/'.next/BUILD_ID').read_text().strip() != plan['buildId']:
        raise RuntimeError('Prepared stage changed or backup already exists')
    if package_json(stage)['version'] != VERSION:
        raise RuntimeError('Staged package version mismatch')
    if plan.get('dependencyMode'):
        if plan['dependencyMode'] not in bundle.MODES:
            raise RuntimeError('Unknown dependency migration mode')
        timed_call('staged_payload_before_wait', bundle.assert_fingerprint, stage, plan['payloadFingerprint'])
    assert_runtime_payload(plan)
    deck.assert_prepared(plan.get('designDeck'), stage)
    core.preflight_launchd()
    state('waiting_for_idle', **plan)
    wait_idle()
    assert_history_fixture(plan)
    core.assert_baseline(plan)
    assert_runtime_payload(plan)
    deck.assert_prepared(plan.get('designDeck'), stage)
    if plan.get('dependencyMode'):
        # Another maintenance task may upgrade the SDK without changing BUILD_ID.
        # Never let an older prepared UI stage downgrade that runtime.
        bundle.validate_dependency_delta(package_json(LIVE)['dependencies'], package_json(stage)['dependencies'], plan['dependencyMode'])
        timed_call('pre_switch_integrity', bundle.assert_fingerprint, stage, plan['payloadFingerprint'])
    backup.mkdir(parents=True, mode=0o700)
    core.save(backup/'manifest.json', plan)
    installed, stopped = False, False
    try:
        timed_call('service_stop', stop_with_idle_retry, plan)
        stopped = True
        if core.launchd_loaded():
            raise RuntimeError('Web service reappeared after stop; refusing extension activation')
        state('switching', **plan)
        timed_call('activate_design_deck', deck.activate, plan.get('designDeck'), stage, backup)
        shutil.move(str(LIVE), str(backup/'package'))
        shutil.move(str(stage), str(LIVE))
        installed = True
        timed_call('installed_meta_original', assert_meta_original_payload, plan, LIVE)
        timed_call('service_start', core.start)
        timed_call('service_health', core.healthy)
        if plan.get('runtimeAdapterInputs'):
            installer = HERE.parents[1]/'pi-interrupt/install.mjs'
            core.command('/opt/homebrew/bin/node', str(installer), '--sdk', str(LIVE/'node_modules/@earendil-works/pi-coding-agent'), '--check')
        state('verifying_live', **plan)
        # Never inherit a candidate probe's destination for formal acceptance.
        result = timed_call('formal_acceptance', core.command, '/usr/bin/env', 'PI_WEB_VERIFY_BASE='+core.BASE,
            'PI_WEB_VERIFY_PACKAGE_ROOT='+str(LIVE), 'PI_WEB_VERIFY_OUTPUT_DIR='+str(HERE)+'/',
            '/opt/homebrew/bin/node', str(HERE/'verify-live.mjs'), plan['sessionId'], plan['buildId'], VERSION, plan.get('dependencyMode', ''),
            'sidebar-browser' if plan.get('uiPolish') else '', check=False, timeout=300)
        (HERE/'live-verification.log').write_text(result.stdout+result.stderr)
        if result.returncode:
            raise RuntimeError('Live verification failed: '+result.stderr[-2500:])
        acceptance = core.assert_live_evidence(plan, VERSION)
        fixture = plan.get('historyFixture')
        if fixture and (acceptance.get('realHistoryRunId') != fixture['runId'] or acceptance.get('expectedChildText') != fixture['expectedText']):
            raise RuntimeError('Formal evidence must bind the prepared real history fixture')
        if plan.get('dependencyMode') in bundle.CORE_MIGRATIONS and (acceptance.get('sdkVersion') != bundle.CORE_MIGRATIONS[plan['dependencyMode']][1] or acceptance.get('sharedRecoveryHooksVerified') is not True):
            raise RuntimeError('Missing real Pi core/recovery acceptance for the approved target')
        if plan.get('dependencyMode') == bundle.MODE and any(acceptance.get(key) is not True for key in ['conversationMotionVerified', 'claudeThemeVerified', 'claudeWhiteThemeVerified', 'ghosttyTerminalVerified', 'nativeGhosttyFontVerified', 'terminalThemeVerified']):
            raise RuntimeError('Missing real unified UI acceptance')
        assert_ui_polish_evidence(plan, acceptance)
        deck.assert_installed(plan.get('designDeck'))
        state('deployed', **plan, wholePackage=True, verifiedLive=True,
              designDeckVerified=bool(plan.get('designDeck')), evidence=str(HERE/'live-result.json'))
        core.save(HERE/'deployment-state.json', {'status': 'deployed', **plan, 'verifiedLive': True, 'upgradeState': str(STATE)})
        core.save(HERE.parent/'简洁工具显示/deployment-state.json', {'status': 'deployed', 'buildId': plan['buildId'], 'version': VERSION,
            'combinedDeployment': str(STATE), 'verifiedLive': True})
    except Exception as error:
        # Preserve the initial failure even if recovery has a second failure.
        state('failed', error=str(error), **plan)
        if stopped or isinstance(error, ServiceStopIncomplete) or (backup/'package').exists():
            try:
                if isinstance(error, ServiceStopIncomplete):
                    # The stop request succeeded before any activation or move.
                    # Wait without signalling again; only restart the old package
                    # once the bound processes, port and job have all disappeared.
                    core.wait_stopped(plan)
                elif core.launchd_loaded():
                    try:
                        running = running_session_ids()
                        if not isinstance(running, list):
                            raise RuntimeError('Invalid running snapshot during recovery')
                    except Exception:
                        # An unresponsive service is not evidence of idleness. Keep
                        # the unverified package rather than possibly aborting a prompt.
                        state('recovery_blocked', error=str(error), reason='Cannot prove that the new service is idle', **plan)
                        raise
                    if running:
                        state('rollback_waiting_for_idle', error=str(error), **plan)
                        wait_idle()
                    stop_with_idle_retry()
                # An unloaded launchd job alone does not prove the port has stopped.
                core.wait_stopped()
                deck.restore(plan.get('designDeck'), backup)
                if installed:
                    shutil.move(str(LIVE), str(backup/'withdrawn-package'))
                if (backup/'package').exists():
                    shutil.move(str(backup/'package'), str(LIVE))
                core.start()
                core.healthy()
                state('rolled_back', error=str(error), **plan)
            except Exception as recovery_error:
                state('recovery_failed', error=str(error), recoveryError=str(recovery_error), **plan)
                raise
        raise


if __name__ == '__main__':
    TIMING_ENABLED = True
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--prepare', metavar='SESSION_ID')
    group.add_argument('--apply', action='store_true')
    group.add_argument('--supersede', metavar='EXPECTED_BUILD_ID')
    group.add_argument('--refresh-owner', metavar='EXPECTED_BUILD_ID')
    parser.add_argument('--reason')
    parser.add_argument('--restart-session', metavar='SESSION_ID', help='Explicitly authorize interrupting only this session for the first service restart')
    parser.add_argument('--dependency-mode', choices=bundle.MODES)
    parser.add_argument('--ui-polish', action='store_true', help='Require formal sidebar, browser, wheel and recovery-hook acceptance')
    parser.add_argument('--design-deck', action='store_true', help='Bind the pi-design-deck 0.5.1 adapter for activation after the guarded service stop')
    args = parser.parse_args()
    if args.dependency_mode and not args.prepare:
        parser.error('--dependency-mode requires --prepare')
    if args.design_deck and not args.prepare:
        parser.error('--design-deck requires --prepare')
    if args.ui_polish and (not args.prepare or args.dependency_mode != bundle.MODE):
        parser.error('--ui-polish requires --prepare and the evidence-bound dependency mode')
    if args.restart_session:
        import uuid
        if not args.apply:
            parser.error('--restart-session requires --apply')
        try:
            uuid.UUID(args.restart_session)
        except ValueError:
            parser.error('--restart-session requires an exact session UUID')
        RESTART_SESSION_ID = args.restart_session
    with DEPLOY_LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.supersede:
            supersede(args.supersede, args.reason)
        elif args.refresh_owner:
            refresh_owner(args.refresh_owner, args.reason)
        elif args.prepare:
            storage_spec = importlib.util.spec_from_file_location('release_storage', HERE/'storage_policy.py')
            storage = importlib.util.module_from_spec(storage_spec)
            storage_spec.loader.exec_module(storage)
            assert_no_pending_plan()
            storage.maintain()
            storage.preflight_space(LIVE.parent)
            prepare(args.prepare, args.dependency_mode, args.ui_polish, args.design_deck)
        else:
            apply()
            # Post-acceptance housekeeping is outside apply's rollback block.
            # A cleanup failure must never roll back a verified release.
            try:
                storage_spec = importlib.util.spec_from_file_location('release_storage', HERE/'storage_policy.py')
                storage = importlib.util.module_from_spec(storage_spec)
                storage_spec.loader.exec_module(storage)
                storage.maintain()
            except Exception as error:
                print('warning: release succeeded but storage cleanup needs attention:', error, flush=True)
