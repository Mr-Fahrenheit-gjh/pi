#!/usr/bin/env python3
"""Bounded Pi Web artifacts. Unknown, pending and process-referenced data fail closed."""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
LIVE = Path('/opt/homebrew/lib/node_modules/@agegr/pi-web')
TERMINAL = {'deployed', 'rolled_back', 'superseded'}
GIB = 1024 ** 3
REQUIRED_PACKAGE_FILES = ('package.json', 'bin/pi-web.js', '.next/BUILD_ID',
                          '.next/required-server-files.json', '.next/build-manifest.json',
                          '.next/server/app/page.js', 'node_modules/next/package.json',
                          'node_modules/next/dist/server/next.js',
                          'node_modules/@earendil-works/pi-coding-agent/package.json',
                          'node_modules/@earendil-works/pi-coding-agent/dist/index.js')


def external_package_links(package):
    """A rollback must not depend on files in another disposable package."""
    if package.is_symlink():
        return [str(package)]
    if not package.exists():
        return []  # Metadata-only record after an approved payload removal.
    root = package.resolve()
    external = []
    def failed(error):
        raise error
    for directory, dirs, files in os.walk(package, followlinks=False, onerror=failed):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink() and not path.resolve().is_relative_to(root):
                external.append(str(path))
    return external


def usable_backup(package):
    if not all((package / name).is_file() for name in REQUIRED_PACKAGE_FILES):
        return False
    try:
        if external_package_links(package):
            return False
        for name in ('package.json', 'node_modules/next/package.json',
                     'node_modules/@earendil-works/pi-coding-agent/package.json'):
            data = read_json(package / name)
            if not data.get('name') or not data.get('version'):
                return False
    except (ValueError, OSError, RuntimeError):
        return False
    return True


def read_json(path):
    if path.is_symlink():
        raise RuntimeError('Symlink metadata refused: ' + str(path))
    return json.loads(path.read_text())


def build_id(package):
    path = package / '.next/BUILD_ID'
    return path.read_text().strip() if path.is_file() else None


@contextmanager
def deployment_lock(here=HERE):
    with (here.parent / '.deployment.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def process_references():
    # Include open files as well as CWD and absolute command paths.
    ps = subprocess.run(['/bin/ps', '-axo', 'command='], check=True, capture_output=True, text=True, timeout=30)
    files = subprocess.run(['/usr/sbin/lsof', '-nP', '-Fn'], capture_output=True, text=True, timeout=30)
    if files.returncode not in (0, 1) or not files.stdout.strip() or files.stderr.strip():
        raise RuntimeError('Cannot inspect process files/working directories; cleanup refused')
    return ps.stdout + '\n' + files.stdout


def reference_paths(value, bases):
    """Resolve direct and inline path aliases without reading referenced files."""
    if isinstance(value, dict):
        values = value.values()
    elif isinstance(value, (list, tuple)):
        values = value
    elif isinstance(value, str):
        values = None
    else:
        return []
    if values is not None:
        return [path for item in values for path in reference_paths(item, bases)]
    paths = []
    for token in dict.fromkeys([value.strip('` '), *re.findall(r"[^\s`\"'<>|,，;；()（）]+", value)]):
        if not token or len(token) > 4096:
            continue
        if token.startswith('n/'):
            token = token[1:]  # lsof -Fn field
        try:
            candidate = Path(token).expanduser()
            if candidate.is_absolute():
                paths.append(candidate.resolve())
            else:
                for base in bases:
                    path = base / candidate
                    if path.exists() or path.is_symlink():
                        paths.append(path.resolve())
        except (OSError, RuntimeError, ValueError):
            continue
    return paths


def disposable_contents(path, device):
    """Do not erase nested repositories or traverse mounted subtrees."""
    def failed(error):
        raise error
    try:
        for directory, dirs, files in os.walk(path, followlinks=False, onerror=failed):
            if '.git' in dirs or '.git' in files:
                return False
            for name in dirs + files:
                if (Path(directory) / name).lstat().st_dev != device:
                    return False
        return True
    except OSError:
        return False


def safe_artifact_tree(path, boundary, check_git=False):
    """Only bounded real directories; workspace payloads must be ignored and untracked."""
    try:
        path.relative_to(boundary)
        for node in (path, *path.parents):
            if node.is_symlink() or node.stat().st_dev != boundary.stat().st_dev:
                return False
            if node == boundary:
                break
            if (node / '.git').exists():
                return False
        if not path.is_dir() or (path / '.git').exists():
            return False
        if check_git:
            tracked = subprocess.run(['git', '-C', str(path.parent), 'ls-files', '-z', '--', str(path)],
                                     check=True, capture_output=True, timeout=15)
            ignored = subprocess.run(['git', '-C', str(path.parent), 'check-ignore', '-q', '--', str(path)],
                                     capture_output=True, timeout=15)
            if tracked.stdout or ignored.returncode != 0 or ignored.stderr:
                return False
        return disposable_contents(path, boundary.stat().st_dev)
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def history_target(path, here, backups):
    """Return the protected package/task and boundary for exact weekly payload shapes."""
    try:
        parts = path.relative_to(here.parent).parts
        if (len(parts) in (3, 4) and parts[1] == 'candidate'
                and (len(parts) == 3 or parts[2] == 'package')
                and parts[-1] in {'.next', 'node_modules'}):
            return path.parent, here.parent / parts[0], here.parent, True
    except ValueError:
        pass
    if path.parent.parent == backups:
        name = path.parent.name
        if ((path.name == 'package' and re.fullmatch(r'pi-web-upgrade-0\.12-\d{8}-\d{6}', name))
                or (path.name == 'withdrawn-package' and re.fullmatch(r'pi-web-failed-0\.12-\d{8}-\d{6}', name))):
            return path, path.parent, backups, False
    return None


def inventory(here=HERE, home=None, live=LIVE, references=None, include_history=False):
    home = home or Path.home()
    backups, candidates = home / '.pi/backups', home / '.pi/pi-web-candidates'
    for root in (backups, candidates):
        if root.is_symlink():
            raise RuntimeError('Symlink artifact root refused: ' + str(root))
    config = read_json(here / 'local-update.json')
    current = Path(config['candidateDirectory']).expanduser()
    if not current.is_absolute():
        current = here / current
    protected = [current.resolve(), live.resolve()]
    states = [read_json(here / name) for name in ('upgrade-0.12-state.json', 'deployment-state.json')
              if (here / name).exists()]
    # Drop rollback retention only after formal verification of the installed build.
    deployed = (bool(states) and all(state.get('status') == 'deployed'
                and state.get('verifiedLive') is True and state.get('buildId')
                and state['buildId'] == build_id(live) for state in states))
    retain_backups = 0 if deployed else 2
    for name in ('upgrade-0.12-state.json', 'deployment-state.json'):
        path = here / name
        if path.exists():
            state = read_json(path)
            # Successful formal acceptance releases rollback payloads, not active inputs.
            keys = (() if deployed else ('backup',)) if state.get('status') in TERMINAL else ('backup', 'staged', 'candidate')
            protected.extend(Path(state[k]).expanduser().resolve() for k in keys if state.get(k))
            if state.get('status') not in TERMINAL:
                plan_path = here / ('upgrade-0.12-plan.json' if name.startswith('upgrade') else 'deployment-plan.json')
                if plan_path.exists():
                    plan = read_json(plan_path)
                    protected.extend(Path(plan[k]).expanduser().resolve() for k in ('backup', 'staged', 'candidate') if plan.get(k))
    pending = []
    bases = (here.parent, here.parent.parent.parent)
    for path in (here.parent / '待上线').glob('*.json'):
        entry = read_json(path)
        if entry.get('status') != 'deployed':
            pending.append(json.dumps(entry, ensure_ascii=False))
            protected.extend(reference_paths(entry, bases))
    settings = home / '.pi/agent/settings.json'
    if settings.exists():
        entry = read_json(settings)
        pending.append(json.dumps(entry, ensure_ascii=False))
        protected.extend(reference_paths(entry, bases))
    process_text = process_references() if references is None else references
    artifact_roots = (backups.resolve(), candidates.resolve(), here.parent.resolve())
    protected.extend(path for path in reference_paths(process_text.splitlines(), bases)
                     if any(path != root and path.is_relative_to(root) for root in artifact_roots))
    text = process_text + '\n' + '\n'.join(pending)

    def in_use(path):
        resolved = path.resolve()
        for validation_lock in (path / '.validation-lock', path / 'package/.validation-lock'):
            if validation_lock.is_symlink():
                return True
            if validation_lock.exists():
                with validation_lock.open('r') as lock:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        return True
        names = [str(path), str(path).replace(str(home), '~', 1)]
        try:
            names.append(path.relative_to(here.parent).as_posix())
        except ValueError:
            pass
        return (any(resolved == p or resolved in p.parents or p in resolved.parents for p in protected)
                or any(name in text for name in names))

    recognized, known_builds, skipped = [], set(), []
    # Retain a tiny build ledger: deleting a backup must not erase proof that a
    # candidate has been superseded by a deployed release.
    ledger = here / 'storage-builds.json'
    if ledger.exists():
        known_builds.update(read_json(ledger)['builds'])
    for path in sorted(backups.glob('pi-web-upgrade-0.12-*'), reverse=True):
        if path.is_symlink() or not re.fullmatch(r'pi-web-upgrade-0\.12-\d{8}-\d{6}', path.name):
            skipped.append(str(path)); continue
        manifest = path / 'manifest.json'
        if not manifest.is_file():
            skipped.append(str(path)); continue
        data = read_json(manifest)
        if external_package_links(path / 'package'):
            raise RuntimeError('External backup dependency; cleanup refused: ' + str(path))
        if ((path / 'package').is_symlink() or data.get('backup') != str(path) or not data.get('oldBuild')
                or not usable_backup(path / 'package') or build_id(path / 'package') != data['oldBuild']
                or set(p.name for p in path.iterdir()) != {'package', 'manifest.json'}):
            skipped.append(str(path)); continue
        recognized.append(path)
        known_builds.update(filter(None, (data.get('buildId'), data.get('oldBuild'))))
    remove_backups = [p for p in recognized[retain_backups:] if not in_use(p)]
    remove_candidates, retained = [], []
    for path in sorted(candidates.iterdir()) if candidates.exists() else []:
        if (path.is_symlink() or not path.is_dir() or (path / '.git').exists()
                or (path / 'package/.git').exists()):
            skipped.append(str(path)); continue
        if not (path / 'package').exists():
            continue  # Lightweight evidence directories are not installed candidates.
        if (path / 'package').is_symlink():
            skipped.append(str(path)); continue
        if in_use(path):
            retained.append(str(path)); continue
        if build_id(path / 'package') in known_builds:
            remove_candidates.append(path / 'package')
        else:
            skipped.append(str(path))
    history = []
    if include_history:
        cutoff = time.time() - 14 * 86400

        def old_payload(package):
            paths = [package, package / '.next', package / '.next/BUILD_ID', package / 'node_modules']
            return (usable_backup(package) and all(max(p.stat().st_mtime, p.stat().st_ctime) < cutoff for p in paths))

        # These are disposable copies, not source/worktrees. Keep source, lockfiles and evidence.
        for task in sorted(here.parent.iterdir()):
            candidate = task / 'candidate'
            if not candidate.is_dir():
                continue
            package = candidate / 'package' if (candidate / 'package').is_dir() else candidate
            targets = [package / '.next', package / 'node_modules']
            if (in_use(task) or in_use(package) or not safe_artifact_tree(package, here.parent)
                    or not all(safe_artifact_tree(p, here.parent, check_git=True) for p in targets)):
                continue
            if build_id(package) in known_builds and old_payload(package):
                history.extend(targets)
            elif build_id(package):
                skipped.append(str(package))

        # A backup with extra recovery metadata is not disposable as a whole.
        # Only its superseded package can be removed; extras and manifest stay.
        complete = []
        for root in sorted(backups.glob('pi-web-upgrade-0.12-*'), reverse=True):
            package = root / 'package'
            if (not re.fullmatch(r'pi-web-upgrade-0\.12-\d{8}-\d{6}', root.name)
                    or not safe_artifact_tree(package, backups) or not (root / 'manifest.json').is_file()):
                continue
            data = read_json(root / 'manifest.json')
            if (data.get('backup') == str(root) and usable_backup(package)
                    and data.get('oldBuild') == build_id(package)):
                complete.append(root)
        for root in complete[retain_backups:]:
            package = root / 'package'
            if root not in recognized and not in_use(root) and old_payload(package):
                history.append(package)
        # Withdrawn payloads are failed installs, never a live/approved rollback.
        for root in sorted(backups.glob('pi-web-failed-0.12-*')):
            package = root / 'withdrawn-package'
            if (not re.fullmatch(r'pi-web-failed-0\.12-\d{8}-\d{6}', root.name)
                    or not safe_artifact_tree(package, backups) or in_use(root)
                    or not (root / 'manifest.json').is_file()):
                continue
            data = read_json(root / 'manifest.json')
            if (data.get('oldBuild') in known_builds and data.get('buildId') == build_id(package)
                    and build_id(package) != build_id(live) and old_payload(package)):
                history.append(package)

    # Resume interrupted rmtree only when a prior approved target still has the
    # same inode; a replacement directory is never covered by old approval.
    journal = here / 'storage-removal.json'
    if journal.exists():
        record = read_json(journal)
        for intent in record.get('targets', [record] if 'path' in record else []):
            path = Path(intent['path'])
            allowed = (path.parent == backups and re.fullmatch(r'pi-web-upgrade-0\.12-\d{8}-\d{6}', path.name)) or (path.parent.parent == candidates and path.name == 'package')
            shape = history_target(path, here, backups) if include_history else None
            if shape:
                package, task, boundary, check_git = shape
                rollback_safe = (path.name != 'package' or path.parent.parent != backups
                                 or (len(complete) >= retain_backups and path.parent not in complete[:retain_backups]))
                if (rollback_safe and safe_artifact_tree(path, boundary, check_git)
                        and not in_use(package) and not in_use(task)
                        and [path.stat().st_dev, path.stat().st_ino] == intent['identity']):
                    if path not in history:
                        history.append(path)
            elif (allowed and (path.parent != backups or deployed)
                  and path.exists() and not path.is_symlink() and not path.parent.is_symlink()):
                # A prior zero-retention intent is not authority after release state changes.
                identity = path.stat()
                if [identity.st_dev, identity.st_ino] == intent['identity'] and not in_use(path.parent if path.name == 'package' else path):
                    if path not in remove_backups + remove_candidates:
                        remove_candidates.append(path)
    safe = []
    for path in dict.fromkeys(remove_backups + remove_candidates + history):
        boundary = backups if path.is_relative_to(backups) else (candidates if path.is_relative_to(candidates) else here.parent)
        if safe_artifact_tree(path, boundary):
            safe.append(path)
        else:
            skipped.append(str(path))
    return {'remove': [str(p) for p in safe],
            'keepBackups': [str(p) for p in recognized if p not in safe],
            'keepCandidates': retained, 'unknown': skipped, 'builds': sorted(known_builds)}


def cleanup(here=HERE, home=None, live=LIVE, references=None, apply=False, include_history=False):
    plan = inventory(here, home, live, references, include_history)
    if apply:
        # Save proof before removing any directories. Caller owns deployment lock.
        ledger = here / 'storage-builds.json'
        temp = ledger.with_suffix('.tmp')
        temp.write_text(json.dumps({'builds': plan['builds']}, indent=2) + '\n')
        temp.replace(ledger)
        journal = here / 'storage-removal.json'
        targets = []
        if journal.exists():
            record = read_json(journal)
            targets.extend(record.get('targets', [record] if 'path' in record else []))
        for name in plan['remove']:
            identity = Path(name).stat()
            intent = {'path': name, 'identity': [identity.st_dev, identity.st_ino]}
            if intent not in targets:
                targets.append(intent)
        temp = journal.with_suffix('.tmp')
        temp.write_text(json.dumps({'targets': targets}) + '\n')
        temp.replace(journal)
        for name in plan['remove']:
            # Re-inventory just before each removal; do not use an old CLI plan.
            fresh = inventory(here, home, live, references, include_history)
            if name not in fresh['remove']:
                raise RuntimeError('Artifact acquired a reference during cleanup: ' + name)
            shutil.rmtree(name)
        remaining = [intent for intent in targets if Path(intent['path']).exists()]
        if remaining:
            temp.write_text(json.dumps({'targets': remaining}) + '\n')
            temp.replace(journal)
        else:
            journal.unlink()
    return plan


def preflight_space(target, reserve=5 * GIB, growth=3 * GIB):
    """Require room for one full package/build, plus a non-negotiable reserve."""
    path = Path(target)
    while not path.exists():
        path = path.parent
    free = shutil.disk_usage(path).free
    if free < reserve + growth:
        raise RuntimeError(f'Pi Web storage: need {(reserve + growth) / GIB:.1f} GiB free, have {free / GIB:.1f}; clean artifacts before copying/building')


def maintain(here=HERE, enforce_limits=True):
    result = cleanup(here=here, apply=True)
    # Never auto-delete an unknown candidate. Refuse more growth instead.
    root = Path.home() / '.pi/pi-web-candidates'
    if enforce_limits and root.exists() and len([p for p in root.iterdir() if (p / 'package').exists()]) > 3:
        raise RuntimeError('More than 3 candidate directories remain (protected/unknown); resolve them before creating another build')
    backups = Path.home() / '.pi/backups'
    if enforce_limits and len([p for p in backups.glob('pi-web-upgrade-0.12-*') if p.is_dir()]) > 3:
        raise RuntimeError('More than 3 upgrade backups remain (protected/unknown); resolve them before another release')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Delete only recognized, superseded artifacts; default is read-only')
    parser.add_argument('--history', action='store_true', help='Also inspect 14-day-old superseded workspace/failed payloads (weekly policy)')
    parser.add_argument('--before-copy', metavar='TARGET', help='Rotate artifacts and check capacity before creating/copying a candidate')
    args = parser.parse_args()
    with deployment_lock():
        if args.before_copy:
            result = maintain(enforce_limits=False)
            root = Path.home() / '.pi/pi-web-candidates'
            if (not Path(args.before_copy).expanduser().exists() and root.exists()
                    and len([p for p in root.iterdir() if (p / 'package').exists()]) >= 3):
                raise RuntimeError('Candidate limit reached; reuse an existing candidate or resolve references first')
            preflight_space(args.before_copy)
        else:
            result = cleanup(apply=args.apply, include_history=args.history)
        print(json.dumps(result, ensure_ascii=False, indent=2))
