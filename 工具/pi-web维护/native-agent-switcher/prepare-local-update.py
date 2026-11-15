"""Prepare a local customization update in an isolated Git worktree. Never installs or deploys."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
MISSING = object()


def git(root, *args, check=True):
    return subprocess.run(['git', '-C', str(root), *args], check=check, capture_output=True, text=True)


def merge_json(base, local, upstream, path='package'):
    if local == base:
        return upstream
    if upstream == base or local == upstream:
        return local
    if all(isinstance(item, dict) for item in [base, local, upstream]):
        result = {}
        for key in sorted(base.keys() | local.keys() | upstream.keys()):
            value = merge_json(base.get(key, MISSING), local.get(key, MISSING), upstream.get(key, MISSING), path + '.' + key)
            if value is not MISSING:
                result[key] = value
        return result
    raise RuntimeError('Conflicting upstream/local setting requires review: ' + path)


def ref_json(source, ref, path):
    return json.loads(git(source, 'show', f'{ref}:{path}').stdout)


def validate_customizations(root, manifest):
    package = json.loads((root / 'package.json').read_text())
    sdk = package['dependencies'].get('@earendil-works/pi-coding-agent')
    if sdk not in manifest['supportedSdkVersions']:
        raise RuntimeError(f'SDK {sdk} requires a tested recovery adapter; no installation performed')
    for name, wanted in manifest['dependencyOverrides'].items():
        if package['dependencies'].get(name) != wanted:
            raise RuntimeError('Local dependency override missing: ' + name)
    for path, markers in manifest['requiredSourceMarkers'].items():
        target = root / path
        if not target.is_file() or any(marker not in target.read_text() for marker in markers):
            raise RuntimeError('Local customization missing: ' + path)
    for path, markers in manifest.get('forbiddenSourceMarkers', {}).items():
        target = root / path
        if not target.is_file() or any(marker in target.read_text() for marker in markers):
            raise RuntimeError('Removed local customization was restored: ' + path)
    lock = json.loads((root / 'package-lock.json').read_text())
    if lock['packages']['']['dependencies'] != package['dependencies']:
        raise RuntimeError('Package/lockfile dependency mismatch')
    return package


def prepare(source, target_ref, output, base_ref=None):
    source, output = source.resolve(), output.resolve()
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', target_ref):
        raise RuntimeError('Target must be one exact version tag, not a branch or revision expression')
    if output.exists():
        raise RuntimeError('Output already exists; inspect the previous result, do not overwrite it')
    workspace = HERE.parents[2]
    if not (output.is_relative_to(workspace) or output.is_relative_to(Path(tempfile.gettempdir()).resolve())):
        raise RuntimeError('Output must stay inside the workspace or its temporary directory')
    if git(source, 'status', '--porcelain', '--untracked-files=no').stdout.strip():
        raise RuntimeError('Source has tracked changes; preserve/commit them before migration')
    manifest = json.loads((source / 'local-customizations.json').read_text())
    base_ref = base_ref or manifest['upstreamRef']
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', base_ref):
        raise RuntimeError('Baseline must be one exact version tag')
    # Resolve both before allocating anything. Fetching tags is an explicit owner action.
    for ref in [base_ref, target_ref]:
        git(source, 'rev-parse', '--verify', ref + '^{commit}')
    base_package = ref_json(source, base_ref, 'package.json')
    upstream_package = ref_json(source, target_ref, 'package.json')
    if upstream_package['dependencies'].get('@earendil-works/pi-coding-agent') not in manifest['supportedSdkVersions']:
        raise RuntimeError('Target SDK requires a tested recovery adapter; no worktree allocated')
    local_package = json.loads((source / 'package.json').read_text())
    # The explicit local engine choices survive changes in the upstream dependency table.
    for name in manifest['dependencyOverrides']:
        for package in [base_package, local_package, upstream_package]:
            package['dependencies'].pop(name, None)
    merged = merge_json(base_package, local_package, upstream_package)
    for name, value in manifest['dependencyOverrides'].items():
        if value is not None:
            merged['dependencies'][name] = value
    if merged['dependencies'].get('@earendil-works/pi-coding-agent') not in manifest['supportedSdkVersions']:
        raise RuntimeError('Target SDK requires a tested recovery adapter; no worktree allocated')
    lock = ref_json(source, target_ref, 'package-lock.json')
    local_lock = json.loads((source / 'package-lock.json').read_text())
    lock['version'] = merged['version']
    lock['packages']['']['version'] = merged['version']
    lock['packages']['']['dependencies'] = merged['dependencies']
    for name, value in manifest['dependencyOverrides'].items():
        path = 'node_modules/' + name
        if value is None:
            lock['packages'].pop(path, None)
        else:
            entry = local_lock['packages'][path]
            if entry['version'] != value or entry.get('dependencies'):
                raise RuntimeError('Local dependency needs an explicit transitive-lock adapter: ' + name)
            lock['packages'][path] = entry
    patch = git(source, 'diff', '--binary', base_ref, target_ref, '--', '.', ':(exclude)package.json', ':(exclude)package-lock.json').stdout
    git(source, 'worktree', 'add', '--detach', str(output), 'HEAD')
    result = {'status': 'blocked', 'source': str(source), 'output': str(output), 'baseline': base_ref, 'target': target_ref}
    try:
        if patch:
            applied = subprocess.run(['git', '-C', str(output), 'apply', '--3way', '--index', '-'], input=patch, text=True, capture_output=True)
            if applied.returncode:
                result['conflicts'] = git(output, 'diff', '--name-only', '--diff-filter=U').stdout.splitlines()
                raise RuntimeError('Upstream patch requires review; worktree preserved: ' + applied.stderr[-1500:])
        (output / 'package.json').write_text(json.dumps(merged, ensure_ascii=False, indent=2) + '\n')
        (output / 'package-lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n')
        manifest['upstreamRef'] = target_ref
        (output / 'local-customizations.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
        validate_customizations(output, manifest)
        git(output, 'add', '--', 'package.json', 'package-lock.json', 'local-customizations.json')
        result.update(status='prepared_source', version=merged['version'], installed=False, deployed=False,
                      remaining=['align exact candidate dependencies', 'apply/check external SDK recovery adapter', 'build', 'same-build UI/runtime acceptance', 'unique guarded deployment'])
    except Exception as error:
        result['error'] = str(error)
        raise
    finally:
        (output / 'local-update-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--target-ref', required=True)
    parser.add_argument('--base-ref')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((HERE / 'local-update.json').read_text())
    source = args.source or (HERE / config['sourceDirectory'])
    print(json.dumps(prepare(source, args.target_ref, args.output, args.base_ref), ensure_ascii=False, indent=2))
