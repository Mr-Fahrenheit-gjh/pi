#!/usr/bin/env python3
"""Reproducible source patch; never patches installed .next or user configuration."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
VERSION = '0.12.0'
SOURCE = HERE.parent / 'pi-web-source-0.12'
PATCH = HERE / 'integration-0.12.0.patch'
MANIFEST = HERE / 'integration-0.12.0-manifest.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def generate(base):
    assert json.loads((base / 'package.json').read_text())['version'] == VERSION
    changes, chunks = [], []
    for folder in ('app', 'components', 'hooks', 'lib', 'e2e', 'docs', 'public', 'bin', 'next.config.ts', 'package.json', 'package-lock.json'):
        candidates = [SOURCE / folder] if (SOURCE / folder).is_file() else sorted((SOURCE / folder).rglob('*'))
        for new in candidates:
            if not new.is_file() or new.suffix not in ('.ts', '.tsx', '.mjs', '.js', '.css', '.md', '.svg', '.json'):
                continue
            rel = new.relative_to(SOURCE).as_posix()
            old = base / rel
            if digest(old) == digest(new):
                continue
            chunks.extend(difflib.unified_diff(old.read_text().splitlines(True) if old.exists() else [], new.read_text().splitlines(True),
                fromfile='a/' + rel if old.exists() else '/dev/null', tofile='b/' + rel))
            changes.append({'path': rel, 'before': digest(old), 'after': digest(new)})
    PATCH.write_text(''.join(chunks))
    revision = subprocess.check_output(['git', '-C', str(base), 'rev-parse', 'HEAD'], text=True).strip()
    MANIFEST.write_text(json.dumps({'webVersion': VERSION, 'baseRevision': revision, 'packageRpcVersion': 1,
        'historyAdapterTestedVersion': '0.75.0', 'patchSha256': digest(PATCH), 'files': changes,
        'generatedAssets': {str(path.relative_to(SOURCE)): digest(path) for path in sorted((SOURCE/'public/vendor/ghostty-web/0.4.0').glob('*')) if path.is_file()},
        'generatedAssetsCommand': 'npm ci --ignore-scripts && node bin/prepare-terminal.js && node bin/prepare-ghostty.mjs'}, indent=2) + '\n')
    print(f'Generated {PATCH}: {len(changes)} files')


def check_or_apply(target, apply):
    manifest = json.loads(MANIFEST.read_text())
    if json.loads((target / 'package.json').read_text())['version'] != manifest['webVersion']:
        raise SystemExit('Version changed: port/review the source patch, then rerun type, lint, browser and real-child tests. Refusing old-build overwrite.')
    if digest(PATCH) != manifest['patchSha256']:
        raise SystemExit('Patch integrity mismatch')
    if all(digest(target / f['path']) == f['after'] for f in manifest['files']):
        print('Exact patched source verified'); return
    conflicts = [f['path'] for f in manifest['files'] if digest(target / f['path']) != f['before']]
    if conflicts:
        raise SystemExit('Source drift; preserve and merge changes first: ' + ', '.join(conflicts))
    subprocess.run(['git', 'apply', '--check', str(PATCH)], cwd=target, check=True)
    if apply:
        subprocess.run(['git', 'apply', str(PATCH)], cwd=target, check=True)
    print('Patch applied' if apply else 'Patch can be applied without overwriting local changes')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', choices=['0.11.0', '0.12.0'], default='0.12.0')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--generate', type=Path, metavar='PRISTINE_SOURCE')
    group.add_argument('--check', type=Path, metavar='TARGET_SOURCE')
    group.add_argument('--apply', type=Path, metavar='TARGET_SOURCE')
    args = parser.parse_args()
    VERSION = args.version
    SOURCE = HERE.parent / ('pi-web-source-' + VERSION.rsplit('.', 1)[0])
    PATCH = HERE / ('integration-' + VERSION + '.patch')
    MANIFEST = HERE / ('integration-manifest.json' if VERSION == '0.11.0' else 'integration-' + VERSION + '-manifest.json')
    if args.generate:
        generate(args.generate.resolve())
    else:
        check_or_apply((args.check or args.apply).resolve(), bool(args.apply))
