#!/usr/bin/env python3
"""Read-only maintenance snapshot. No service calls, model calls or file writes."""
import argparse
import json
from pathlib import Path
import subprocess


def snapshot(workspace, live_package):
    workspace, live = Path(workspace).resolve(), Path(live_package).expanduser().resolve()
    maintenance = workspace / '工具/pi-web维护/native-agent-switcher'
    warnings = []

    def read_json(path):
        if not path.is_file():
            return {}
        try:
            value = json.loads(path.read_text())
            if not isinstance(value, dict):
                raise ValueError('Expected a JSON object')
            return value
        except (OSError, ValueError) as error:
            warnings.append(f'{path}: {type(error).__name__}')
            return {}

    def build_id(root):
        path = root / '.next/BUILD_ID'
        try:
            return path.read_text().strip() if path.is_file() else None
        except OSError as error:
            warnings.append(f'{path}: {type(error).__name__}')
            return None

    config = read_json(maintenance / 'local-update.json')
    if not all(config.get(key) for key in ('sourceDirectory', 'candidateDirectory', 'targetVersion')):
        return {'error': 'Missing/invalid local-update.json', 'warnings': warnings}
    source = (maintenance / config['sourceDirectory']).resolve()
    raw_candidate = Path(config['candidateDirectory']).expanduser()
    candidate = raw_candidate.resolve() if raw_candidate.is_absolute() else (maintenance / raw_candidate).resolve()
    candidate_build, live_build = build_id(candidate), build_id(live)
    candidate_package = read_json(candidate / 'package.json')
    live_json = read_json(live / 'package.json')
    state = read_json(maintenance / 'upgrade-0.12-state.json')
    acceptance = read_json(maintenance / 'live-result.json')

    def bound(proof, root, build):
        if not build or proof.get('passed') is not True:
            return False
        recorded = proof.get('packageRoot')
        return (isinstance(recorded, str) and Path(recorded).expanduser().resolve() == root
                and proof.get('buildId') == build)

    proof_paths = {
        'smoke': maintenance / 'smoke-result.json',
        'quiet_tools': source / 'test-results/quiet-tools/result.json',
        'runtime': maintenance / 'runtime-probe-result.json',
    }
    proofs = {name: read_json(path) for name, path in proof_paths.items()}
    evidence_matches = {name: bound(value, candidate, candidate_build) for name, value in proofs.items()}
    evidence_matches['runtime'] = evidence_matches['runtime'] and proofs['runtime'].get('launchd') is True
    records_match = bool(
        live_build and state.get('status') == 'deployed' and state.get('verifiedLive') is True
        and state.get('buildId') == live_build and bound(acceptance, live, live_build)
        and state.get('version') == live_json.get('version') == acceptance.get('version')
        and state.get('sessionId') and state.get('sessionId') == acceptance.get('sessionId')
        and acceptance.get('realChildVerified') is True and acceptance.get('mocked') is False
        and acceptance.get('base') == 'http://127.0.0.1:30141'
    )
    git = {}
    for key, arguments in [('revision', ['rev-parse', '--short', 'HEAD']), ('status', ['status', '--porcelain'])]:
        try:
            result = subprocess.run(['git', '--no-optional-locks', '-C', str(source), *arguments], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                git[key] = result.stdout.strip() if key == 'revision' else len(result.stdout.splitlines())
        except (OSError, subprocess.TimeoutExpired):
            warnings.append(f'Git {key} unavailable')
    return {
        'source': {'path': str(source), 'revision': git.get('revision'), 'dirty_entries': git.get('status')},
        'candidate': {'path': str(candidate), 'exists': candidate.is_dir(), 'build_id': candidate_build,
                      'version': candidate_package.get('version'), 'required_evidence_matches': evidence_matches},
        'installed': {'path': str(live), 'build_id': live_build, 'version': live_json.get('version')},
        'deployment': {'status': state.get('status'), 'planned_build_id': state.get('buildId'),
                       'records_match_installed_files': records_match},
        'dependency_declarations_equal': (bool(candidate_package.get('dependencies'))
                                        and candidate_package.get('dependencies') == live_json.get('dependencies')),
        'target_version': config['targetVersion'],
        'limits': ['Not a process or HTTP health check', 'Does not prove source/installed dependency/build-environment equivalence',
                   'Matching evidence metadata is not a new test result or a reuse decision'],
        'warnings': warnings,
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument('--live-package', type=Path, default=Path('/opt/homebrew/lib/node_modules/@agegr/pi-web'))
    args = parser.parse_args()
    result = snapshot(args.workspace, args.live_package)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(2 if result.get('error') else 0)
