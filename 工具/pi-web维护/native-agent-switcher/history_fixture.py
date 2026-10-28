"""Retain/restore byte-identical, completed real-run metadata; never invent sessions."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

HERE = Path(__file__).resolve().parent
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)


def read_regular(path, limit=4 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise RuntimeError('Not a bounded regular file: ' + str(path))
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(limit + 1)
    finally:
        os.close(fd)


def run_root():
    base = os.environ.get('PI_SUBAGENTS_TEMP_ROOT')
    return Path(base).expanduser().resolve() / 'async-subagent-runs' if base else Path(tempfile.gettempdir()) / f'pi-subagents-uid-{os.getuid()}' / 'async-subagent-runs'


def validate_fixture(fixture):
    if not isinstance(fixture, dict) or not all(isinstance(fixture.get(k), str) and UUID.fullmatch(fixture[k]) for k in ['sessionId', 'runId']):
        raise RuntimeError('Exact parent/run UUIDs required')
    text = fixture.get('expectedText')
    if not isinstance(text, str) or not 8 <= len(text.strip()) <= 160 or len(text) > 160:
        raise RuntimeError('Bounded real assistant text required')
    return fixture


def load_fixture(config, here=HERE):
    filename = config.get('historyFixtureFile')
    if not filename:
        raise RuntimeError('Configure an existing real historyFixtureFile before building')
    return validate_fixture(json.loads(read_regular((here / filename).resolve())))


@contextmanager
def parent_reader(parent):
    fd = os.open(parent, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 64 * 1024 * 1024:
            raise RuntimeError('Parent must be a bounded regular transcript')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            yield stream
    finally:
        os.close(fd)


def assert_parent_settled(parent):
    """Follow the same last-entry/parentId active branch as SessionManager.getBranch.

    Do not rely on the old owner's PID: it will disappear during a restart.
    Refuse every pending task, even if it would merely pause rather than resume.
    """
    entries, leaf, session_id = {}, None, None
    with parent_reader(parent) as stream:
        for line in stream:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if isinstance(entry, dict) and entry.get('type') == 'session':
                session_id = entry.get('id')
            if isinstance(entry, dict) and entry.get('type') != 'session' and isinstance(entry.get('id'), str):
                leaf = entry['id']
                entries[leaf] = {key: entry.get(key) for key in ['parentId', 'type', 'customType', 'data']}
    seen = set()
    while leaf:
        if leaf in seen or leaf not in entries:
            raise RuntimeError('Cannot prove the active parent branch is settled')
        seen.add(leaf)
        entry = entries[leaf]
        if entry['type'] == 'custom' and entry['customType'] == 'pi-durable-task':
            state = entry['data']
            if (not isinstance(state, dict) or state.get('version') != 1 or state.get('sessionId') != session_id
                    or state.get('status') not in ['done', 'cancelled', 'paused']):
                raise RuntimeError('History parent is not settled; opening it after restart may resume a model task')
            return
        leaf = entry['parentId']


def inspect(fixture, root=None, require_settled=True):
    validate_fixture(fixture)
    root = Path(root) if root is not None else run_root()
    directory = root / fixture['runId']
    if root.is_symlink() or directory.is_symlink():
        raise RuntimeError('History run directory must not be a symlink')
    raw = read_regular(directory / 'status.json')
    status = json.loads(raw)
    if status.get('runId') != fixture['runId'] or status.get('state') != 'complete':
        raise RuntimeError('Only the exact completed real run may be retained')
    parent = Path(status['sessionId']).resolve(strict=True)
    with parent_reader(parent) as stream:
        header = json.loads(stream.readline(65536))
    if header.get('type') != 'session' or header.get('id') != fixture['sessionId'] or parent.suffix != '.jsonl':
        raise RuntimeError('Real history parent identity mismatch')
    if require_settled:
        assert_parent_settled(parent)
    children = [step.get('sessionFile') for step in status.get('steps', []) if isinstance(step, dict)]
    children += [status.get('sessionFile')]
    child_root = parent.with_suffix('')
    marker_found = False
    for child in dict.fromkeys(child for child in children if isinstance(child, str)):
        path = Path(child).resolve(strict=True)
        if not path.is_relative_to(child_root) or path.suffix != '.jsonl':
            raise RuntimeError('Real child escaped its verified parent tree')
        # Match the Web's bounded tail: no user/tool text can satisfy this proof.
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError('Child transcript must be a regular file')
            start = max(0, info.st_size - 1024 * 1024)
            os.lseek(fd, start, os.SEEK_SET)
            lines = os.read(fd, 1024 * 1024).splitlines()
        finally:
            os.close(fd)
        if start:
            lines = lines[1:]
        messages = []
        for line in lines:
            try:
                entry = json.loads(line)
                if entry.get('type') == 'message' and entry.get('message', {}).get('role') in ['user', 'assistant', 'toolResult', 'bashExecution']:
                    messages.append(entry['message'])
            except (ValueError, AttributeError):
                continue
        marker_found |= any(message.get('role') == 'assistant' and any(
            block.get('type') == 'text' and fixture['expectedText'] in block.get('text', '')
            for block in message.get('content', []) if isinstance(block, dict)) for message in messages[-100:])
    if not marker_found:
        raise RuntimeError('Expected real assistant text is absent from the retained transcript')
    return {'passed': True, 'parentFile': str(parent), 'runDirectory': str(directory),
            'statusSha256': hashlib.sha256(raw).hexdigest()}


def retain(fixture, archive_root=None, root=None):
    # Retention is an offline byte backup, not permission to open a pending parent.
    verified = inspect(fixture, root, require_settled=False)
    directory = Path(verified['runDirectory'])
    archive_root = Path(archive_root) if archive_root is not None else HERE / 'retained-history'
    archive_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if archive_root.is_symlink():
        raise RuntimeError('Archive root must not be a symlink')
    target = archive_root / fixture['runId']
    files = {'status.json': read_regular(directory / 'status.json')}
    if hashlib.sha256(files['status.json']).hexdigest() != verified['statusSha256']:
        raise RuntimeError('Run changed during retention')
    for file in directory.iterdir():
        if re.fullmatch(r'output-\d+\.log', file.name):
            if len(files) > 64:
                raise RuntimeError('Too many runtime outputs to retain safely')
            files[file.name] = read_regular(file, 8 * 1024 * 1024)
            if sum(map(len, files.values())) > 32 * 1024 * 1024:
                raise RuntimeError('Retained runtime outputs exceed the size bound')
    manifest = {'schemaVersion': 1, 'fixture': fixture,
                'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    if target.exists():
        existing, _ = inspect_archive(fixture, archive_root)
        if existing != manifest:
            raise RuntimeError('An existing archive differs; never overwrite real history')
        return {'passed': True, 'archive': str(target), 'reused': True}
    temporary = Path(tempfile.mkdtemp(prefix='.retaining-', dir=archive_root))
    try:
        for name, data in files.items():
            (temporary / name).write_bytes(data)
            (temporary / name).chmod(0o600)
        (temporary / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (temporary / 'manifest.json').chmod(0o600)
        temporary.rename(target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {'passed': True, 'archive': str(target), 'reused': False}


def inspect_archive(fixture, archive_root=None):
    validate_fixture(fixture)
    archive_root = Path(archive_root) if archive_root is not None else HERE / 'retained-history'
    directory = archive_root / fixture['runId']
    if archive_root.is_symlink() or directory.is_symlink():
        raise RuntimeError('Archive directory must not be a symlink')
    manifest = json.loads(read_regular(directory / 'manifest.json'))
    if manifest.get('schemaVersion') != 1 or manifest.get('fixture') != fixture or 'status.json' not in manifest.get('files', {}):
        raise RuntimeError('Archive identity mismatch')
    files = {}
    if not isinstance(manifest['files'], dict) or len(manifest['files']) > 65:
        raise RuntimeError('Invalid retained output inventory')
    for name, digest in manifest['files'].items():
        if name != 'status.json' and not re.fullmatch(r'output-\d+\.log', name):
            raise RuntimeError('Unsafe archive filename')
        data = read_regular(directory / name, 8 * 1024 * 1024)
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError('Retained real history was modified')
        files[name] = data
        if sum(map(len, files.values())) > 32 * 1024 * 1024:
            raise RuntimeError('Retained runtime outputs exceed the size bound')
    return manifest, files


def restore(fixture, archive_root=None, root=None):
    root = Path(root) if root is not None else run_root()
    manifest, files = inspect_archive(fixture, archive_root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.is_symlink():
        raise RuntimeError('Runtime root must not be a symlink')
    target = root / fixture['runId']
    if target.exists() or target.is_symlink():
        # Even a partial directory may belong to a live runner: never merge it.
        for name, data in files.items():
            if read_regular(target / name, 8 * 1024 * 1024) != data:
                raise RuntimeError('Runtime history differs; refusing overwrite')
        inspect(fixture, root)
        return {'passed': True, 'restored': False}
    temporary = Path(tempfile.mkdtemp(prefix='.restoring-', dir=root))
    try:
        for name, data in files.items():
            (temporary / name).write_bytes(data)
            (temporary / name).chmod(0o600)
        # Validate all ownership and the real transcript before publishing status.
        status = json.loads(files['status.json'])
        if status.get('runId') != fixture['runId'] or status.get('state') != 'complete':
            raise RuntimeError('Invalid retained terminal run')
        # inspect expects a run-id directory; use an isolated temporary parent.
        with tempfile.TemporaryDirectory(prefix='.verify-history-', dir=root) as check:
            verify_dir = Path(check) / fixture['runId']; verify_dir.mkdir()
            (verify_dir / 'status.json').write_bytes(files['status.json'])
            inspect(fixture, Path(check))
        temporary.rename(target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {'passed': True, 'restored': True, 'runDirectory': str(target)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'retain', 'restore'])
    args = parser.parse_args()
    fixture = load_fixture(json.loads((HERE / 'local-update.json').read_text()))
    result = {'check': inspect, 'retain': retain, 'restore': restore}[args.action](fixture)
    print(json.dumps(result))
