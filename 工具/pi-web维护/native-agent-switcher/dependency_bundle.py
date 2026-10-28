"""Evidence-bound independent payloads for explicitly approved runtime migrations."""
import argparse
import hashlib
import json
from pathlib import Path
import os

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE / 'dependency-bundle.json'
MODE = 'ghostty-0.4.0'
CORE_MODE = 'pi-core-1.3.0'
CORE_14_MODE = 'pi-core-1.4.0'
CORE_MIGRATIONS = {CORE_MODE: ('1.2.0', '1.3.0'), CORE_14_MODE: ('1.3.0', '1.4.0')}
MODES = (MODE, *CORE_MIGRATIONS)
CORE_PACKAGES = tuple('@earendil-works/' + name for name in (
    'pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-coding-agent', 'pi-mcp', 'pi-telemetry', 'pi-tui'))
APPROVED_DELTA = {
    '@xterm/addon-fit': ('0.11.0', None),
    '@xterm/xterm': ('6.0.0', None),
    'ghostty-web': (None, '0.4.0'),
}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def tree_digest(root):
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError('Runtime tree must be independent: ' + str(root))
    root = root.resolve()
    h = hashlib.sha256()
    for directory, directories, files in os.walk(root, followlinks=False):
        directories.sort()
        for name in sorted(directories + files):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                if not path.resolve().is_relative_to(root) or not path.exists():
                    raise RuntimeError('External or broken runtime symlink: ' + str(path))
                value = 'link:' + os.readlink(path)
            elif path.is_file():
                value = 'file:' + digest(path)
            elif path.is_dir():
                value = 'directory'
            else:
                raise RuntimeError('Unexpected runtime file: ' + str(path))
            h.update(json.dumps([relative, value], separators=(',', ':')).encode())
            h.update(b'\n')
    return h.hexdigest()


def fingerprint(root):
    return {
        'files': {name: digest(root / name) for name in ['package.json', 'package-lock.json', 'next.config.ts'] + (['local-customizations.json'] if (root / 'local-customizations.json').exists() else [])},
        'trees': {name: tree_digest(root / name) for name in ['node_modules', '.next', 'public', 'bin']},
    }


def fingerprint_after_retaining_assets(root, verified):
    """Only .next/public are deliberately changed after the verified clone.

    Keep the already-verified dependency/bin/file expectations, rather than
    rehashing (and accidentally blessing a concurrent change to) those bytes.
    Apply still performs its complete before-wait and pre-switch comparisons.
    """
    return {'files': dict(verified['files']),
            'trees': {**verified['trees'], **{name: tree_digest(root / name) for name in ['.next', 'public']}}}


def assert_fingerprint(root, expected):
    if fingerprint(root) != expected:
        raise RuntimeError('Runtime payload changed since verification: ' + str(root))


def validate_dependency_delta(live, candidate, mode=MODE):
    delta = {name: (live.get(name), candidate.get(name)) for name in live.keys() | candidate.keys() if live.get(name) != candidate.get(name)}
    if mode in CORE_MIGRATIONS:
        versions = CORE_MIGRATIONS[mode]
        expected = {name: versions for name in CORE_PACKAGES}
        if delta != expected:
            raise RuntimeError(f'Only the approved seven-package Pi {versions[0]} to {versions[1]} upgrade is supported')
        return
    if mode != MODE:
        raise RuntimeError('Unknown dependency migration mode')
    same_ghostty_runtime = (not delta and candidate.get('ghostty-web') == '0.4.0'
                            and not any(name in candidate for name in ['@xterm/xterm', '@xterm/addon-fit']))
    if delta != APPROVED_DELTA and not same_ghostty_runtime:
        raise RuntimeError('Only the approved Ghostty migration or an unchanged Ghostty dependency set is supported')


def validate_install(root):
    package = json.loads((root / 'package.json').read_text())
    lock = json.loads((root / 'package-lock.json').read_text())
    deps = package['dependencies']
    manifest = json.loads((root / 'local-customizations.json').read_text())
    if manifest.get('schemaVersion') != 1 or deps.get('@earendil-works/pi-coding-agent') not in manifest['supportedSdkVersions']:
        raise RuntimeError('Missing/unsupported local customization contract')
    for relative, markers in manifest['requiredSourceMarkers'].items():
        path = root / relative
        if not path.is_file() or any(marker not in path.read_text() for marker in markers):
            raise RuntimeError('Required local customization missing: ' + relative)
    for relative, markers in manifest.get('forbiddenSourceMarkers', {}).items():
        path = root / relative
        if not path.is_file() or any(marker in path.read_text() for marker in markers):
            raise RuntimeError('Removed local UI was restored: ' + relative)
    if deps.get('ghostty-web') != '0.4.0' or any(name in deps for name in ['@xterm/xterm', '@xterm/addon-fit']):
        raise RuntimeError('Expected the approved Ghostty dependency set')
    if lock['packages']['']['dependencies'] != deps:
        raise RuntimeError('Package/lockfile dependency mismatch')
    for name in deps:
        installed = json.loads((root / 'node_modules' / name / 'package.json').read_text())
        if installed['version'] != lock['packages']['node_modules/' + name]['version']:
            raise RuntimeError('Installed dependency does not match lockfile: ' + name)
    wasm = 'ghostty-vt.wasm'
    if digest(root / 'public/vendor/ghostty-web/0.4.0' / wasm) != digest(root / 'node_modules/ghostty-web' / wasm):
        raise RuntimeError('Published WASM does not match installed dependency')


def verify(root, mode=MODE):
    result = json.loads(EVIDENCE.read_text())
    if (result.get('passed') is not True or result.get('mode') != mode or result.get('packageRoot') != str(root)
            or result.get('buildId') != (root / '.next/BUILD_ID').read_text().strip()):
        raise RuntimeError('Missing exact dependency-bundle evidence')
    for path, expected in result['evidence'].items():
        if digest(Path(path)) != expected:
            raise RuntimeError('Candidate acceptance evidence changed: ' + path)
    validate_install(root)
    assert_fingerprint(root, result['fingerprint'])
    return result


def record(root, ui_evidence_root=None, mode=MODE):
    validate_install(root)
    build = (root / '.next/BUILD_ID').read_text().strip()
    proofs = [HERE / 'smoke-result.json', HERE / 'runtime-probe-result.json',
              (HERE / json.loads((HERE / 'local-update.json').read_text())['sourceDirectory']).resolve() / 'test-results/quiet-tools/result.json']
    if mode == MODE:
        ui_evidence_root = ui_evidence_root or HERE.parent / '统一更新-20261013/evidence'
        proofs += [ui_evidence_root / kind / 'result.json' for kind in ['motion', 'theme', 'terminal']]
    elif mode in CORE_MIGRATIONS:
        proofs += [root / 'test-results/core-upgrade/result.json']
    else:
        raise RuntimeError('Unknown dependency migration mode')
    for path in proofs:
        proof = json.loads(path.read_text())
        if proof.get('passed') is not True or proof.get('buildId') != build or proof.get('packageRoot') != str(root):
            raise RuntimeError('Missing unified candidate evidence: ' + str(path))
        if path.name == 'runtime-probe-result.json' and proof.get('launchd') is not True:
            raise RuntimeError('Real launchd probe is required')
    result = {'passed': True, 'mode': mode, 'packageRoot': str(root), 'buildId': build,
              'fingerprint': fingerprint(root), 'evidence': {str(path): digest(path) for path in proofs}}
    EVIDENCE.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': True, 'buildId': build, 'evidence': str(EVIDENCE)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--record', type=Path, required=True)
    parser.add_argument('--ui-evidence-root', type=Path)
    parser.add_argument('--mode', choices=MODES, default=MODE)
    args = parser.parse_args()
    record(args.record.resolve(), args.ui_evidence_root.resolve() if args.ui_evidence_root else None, args.mode)
