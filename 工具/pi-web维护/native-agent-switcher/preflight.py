"""Read-only early checks. Never installs, opens a session, starts or restarts a service."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load_module(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_json(path):
    result = json.loads(Path(path).read_text())
    if not isinstance(result, dict):
        raise RuntimeError('Expected JSON object: ' + str(path))
    return result


def runtime_files(root, include_docs=False):
    """Runtime inventory, or the broader check/fixture inventory when requested."""
    root = Path(root)
    excluded = {'.git', 'node_modules', '.next', '.next-pi-meta', 'test-results', '__pycache__'}
    generated = {'next-env.d.ts', 'tsconfig.tsbuildinfo', 'public/vendor/ghostty-web/0.4.0/ghostty-vt.wasm',
                 'public/vendor/ghostty-web/0.4.0/LICENSE', '.gitignore'}
    files = {}
    for directory, directories, names in os.walk(root, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in excluded)
        for name in directories:
            if (Path(directory) / name).is_symlink():
                raise RuntimeError('Source directory link is not a sealed input: ' + name)
        for name in sorted(names):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if name in excluded or (not include_docs and path.suffix.lower() == '.md' and not relative.startswith('public/')) or relative in generated or name.startswith('.validation-'):
                continue
            if path.is_symlink():
                raise RuntimeError('Source file link is not a sealed input: ' + relative)
            files[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


def preflight(here=HERE, live=None, phase='source', dependency_mode=None, require_history=True):
    started = time.monotonic()
    here = Path(here).resolve()
    live = Path(live) if live is not None else Path('/opt/homebrew/lib/node_modules/@agegr/pi-web')
    checks, warnings, pending = [], [], []
    context = {}

    def check(name, function):
        try:
            result = function()
            checks.append({'name': name, 'passed': True})
            return result
        except Exception as error:
            checks.append({'name': name, 'passed': False, 'error': str(error)})
            return None

    state_path = here / 'upgrade-0.12-state.json'
    if state_path.is_file():
        state = check('deployment_record', lambda: read_json(state_path))
        if state:
            context['deploymentStatus'] = state.get('status')
            if state.get('status') in ['prepared', 'waiting_for_idle', 'switching', 'verifying_live', 'rollback_waiting_for_idle', 'recovery_blocked', 'recovery_failed']:
                checks.append({'name': 'no_active_deployment', 'passed': False,
                               'error': 'An unfinished deployment owns the plan; inspect/wait for its exact task, never duplicate prepare/apply'})
    config = check('configuration', lambda: read_json(here / 'local-update.json'))
    if config is not None:
        try:
            source = (here / config['sourceDirectory']).resolve()
            candidate = (here / Path(config['candidateDirectory']).expanduser()).resolve()
            context.update(sourceDirectory=str(source), candidateDirectory=str(candidate), targetVersion=config['targetVersion'])
        except (KeyError, TypeError) as error:
            checks.append({'name': 'configuration_paths', 'passed': False, 'error': str(error)})
            config = None
    if config is not None:
        migration = load_module('migration_preflight', HERE / 'prepare-local-update.py')
        bundle = load_module('bundle_preflight', HERE / 'dependency_bundle.py')
        history = load_module('history_preflight', HERE / 'history_fixture.py')
        source_package = check('local_customizations', lambda: migration.validate_customizations(source, read_json(source / 'local-customizations.json')))
        live_package = check('installed_manifest', lambda: read_json(live / 'package.json'))
        if source_package and live_package:
            def dependency_delta():
                if dependency_mode:
                    bundle.validate_dependency_delta(live_package['dependencies'], source_package['dependencies'], dependency_mode)
                elif live_package['dependencies'] != source_package['dependencies']:
                    raise RuntimeError('Dependency changes require an explicitly approved named migration mode')
            check('approved_dependency_delta', dependency_delta)
        snapshot_file = here.parents[2] / '.pi/skills/pi-web-maintenance/scripts/snapshot.py'
        already_deployed = False
        if snapshot_file.is_file() and source_package:
            try:
                saved = load_module('flow_snapshot', snapshot_file).snapshot(here.parents[2], live)
                already_deployed = (saved['deployment']['records_match_installed_files'] is True
                    and saved['candidate']['build_id'] == saved['installed']['build_id']
                    and read_json(candidate / 'package.json') == source_package
                    and runtime_files(source) == runtime_files(candidate))
            except (OSError, ValueError, KeyError, RuntimeError):
                pass
        context['recordedDeployed'] = already_deployed
        context['nextAction'] = 'confirm_existing_task_and_inputs_before_reuse' if already_deployed else 'prepare_or_validate_candidate'
        if source_package and source_package.get('version') != config['targetVersion']:
            checks.append({'name': 'target_version', 'passed': False, 'error': 'Source version differs from local-update target'})
        fixture = None
        if require_history and not (already_deployed and phase == 'source'):
            fixture = check('history_fixture_identity', lambda: history.load_fixture(config, here))
            if fixture:
                proof = check('real_history_available', lambda: history.inspect(fixture))
                if proof:
                    context['historySessionId'] = fixture['sessionId']
                    archive = here / 'retained-history'
                    if not (archive / fixture['runId'] / 'manifest.json').is_file():
                        warnings.append('Real history is only in the runner temporary directory; retain it before release')
                else:
                    try:
                        history.inspect_archive(fixture, here / 'retained-history')
                        directory = history.run_root() / fixture['runId']
                        pending.append('Restore the byte-identical retained history before candidate verification' if not directory.exists()
                                       else 'Existing real-history data or its parent is unsafe; do not overwrite it or open a pending parent')
                    except Exception:
                        pending.append('Select an existing completed real run; never create a model call just to manufacture evidence')
        # A candidate preflight includes the common gate; do not run candidate
        # adapter checks when that gate has already failed.
        if phase in ['candidate', 'release'] and all(item['passed'] for item in checks):
            candidate_package = check('candidate_manifest', lambda: read_json(candidate / 'package.json'))
            if candidate_package and source_package:
                def independent_candidate():
                    if candidate == source or candidate == live.resolve() or (candidate / 'node_modules').is_symlink():
                        raise RuntimeError('Candidate must be independent of source/live packages')
                    if candidate_package != source_package:
                        raise RuntimeError('Candidate package declaration differs from the source')
                    if runtime_files(candidate) != runtime_files(source):
                        raise RuntimeError('Candidate source inputs differ; synchronize once before validation')
                check('candidate_inputs', independent_candidate)
                def installed_dependencies():
                    lock = read_json(candidate / 'package-lock.json')
                    if lock != read_json(source / 'package-lock.json'):
                        raise RuntimeError('Candidate/source lockfiles differ')
                    for name in candidate_package['dependencies']:
                        installed = read_json(candidate / 'node_modules' / name / 'package.json')
                        if installed['version'] != lock['packages']['node_modules/' + name]['version']:
                            raise RuntimeError('Installed dependency differs from lockfile: ' + name)
                check('installed_dependencies', installed_dependencies)
                def recovery():
                    result = subprocess.run(['node', str(HERE / 'apply-candidate-recovery.mjs'), str(candidate), '--check'], capture_output=True, text=True, timeout=20)
                    if result.returncode:
                        raise RuntimeError('Candidate recovery adapter is missing/unsupported: ' + result.stderr[-1200:])
                check('candidate_recovery', recovery)
                def interrupt_steer():
                    result = subprocess.run(['node', str(HERE.parents[1] / 'pi-interrupt/install.mjs'), '--sdk',
                                             str(candidate / 'node_modules/@earendil-works/pi-coding-agent'), '--check'],
                                            capture_output=True, text=True, timeout=20)
                    if result.returncode:
                        raise RuntimeError('Candidate interrupt-steer adapter is missing/unsupported: ' + result.stderr[-1200:])
                check('candidate_interrupt_steer', interrupt_steer)
                def dev_tools():
                    for path in ['node_modules/typescript/bin/tsc', 'node_modules/eslint/bin/eslint.js', 'node_modules/next/dist/bin/next']:
                        if not (candidate / path).is_file():
                            raise RuntimeError('Missing candidate development tool: ' + path)
                check('development_tools', dev_tools)
            if phase == 'release':
                def release_evidence():
                    build = (candidate / '.next/BUILD_ID').read_text().strip()
                    for path in [here / 'smoke-result.json', source / 'test-results/quiet-tools/result.json', here / 'runtime-probe-result.json']:
                        proof = read_json(path)
                        if proof.get('passed') is not True or proof.get('buildId') != build or proof.get('packageRoot') != str(candidate):
                            raise RuntimeError('Missing exact candidate evidence: ' + str(path))
                        if path.name == 'runtime-probe-result.json' and proof.get('launchd') is not True:
                            raise RuntimeError('Real launchd evidence required')
                        if path.name == 'smoke-result.json' and fixture and any(proof.get(key) != value for key, value in {
                                'sessionId': fixture['sessionId'], 'realHistoryRunId': fixture['runId'], 'expectedChildText': fixture['expectedText']}.items()):
                            raise RuntimeError('Real-history evidence does not match the configured exact run')
                    bundle.validate_install(candidate) if dependency_mode else None
                check('release_evidence', release_evidence)
    if any(not check['passed'] for check in checks):
        context['nextAction'] = 'resolve_preflight_blockers_before_build'
    return {'passed': all(check['passed'] for check in checks), 'phase': phase, **context,
            'checks': checks, 'warnings': warnings, 'pending': pending,
            'elapsedSeconds': round(time.monotonic() - started, 3),
            'limits': ['Read-only filesystem/SDK checks; no service, model or network requests',
                       'Does not replace full payload fingerprints, idle protection or formal acceptance']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['source', 'candidate', 'release'], default='source')
    parser.add_argument('--dependency-mode', choices=['ghostty-0.4.0', 'pi-core-1.3.0', 'pi-core-1.4.0'])
    args = parser.parse_args()
    result = preflight(phase=args.phase, dependency_mode=args.dependency_mode)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result['passed'] else 1)
