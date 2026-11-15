"""Opt-in pi-design-deck 0.5.1 transaction, owned by the Web deploy lock.

prepare only patches an offline copy. activate/restore require the caller to have
stopped the verified Web host; neither function starts or stops any process.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

PACKAGE = Path.home()/'.pi/agent/npm/node_modules/pi-design-deck'
FILES = ('index.ts', 'form/js/deck-session.js', 'deck-server.ts')
PAYLOAD = '.release-design-deck'


def regular(path):
    path = Path(path)
    if path.resolve(strict=True) != path.absolute() or not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError('Design Deck requires regular, non-symlink paths: '+str(path))
    return path


def snapshot(path):
    path = regular(path)
    return {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'mode': stat.S_IMODE(path.stat().st_mode)}


def require(path, expected):
    if snapshot(path) != expected:
        raise RuntimeError('Design Deck input drift: '+str(path))


def metadata():
    result = snapshot(PACKAGE/'package.json')
    value = json.loads((PACKAGE/'package.json').read_text())
    if value.get('name') != 'pi-design-deck' or value.get('version') != '0.5.1':
        raise RuntimeError('Design Deck release requires pi-design-deck 0.5.1')
    return result


def prepare(stage, script):
    """Bind installed originals and patched bytes without touching the shared package."""
    record = {'packageRoot': str(PACKAGE), 'metadata': metadata(),
              'script': str(script), 'scriptIdentity': snapshot(script), 'files': {}}
    for name in FILES:
        record['files'][name] = {'before': snapshot(PACKAGE/name)}
    payload = stage/PAYLOAD
    payload.mkdir(mode=0o700)  # Never reuse an unknown payload.
    for name in ('package.json', *FILES):
        target = payload/'package'/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PACKAGE/name, target)
    shutil.copy2(script, payload/'patch.mjs')
    require(payload/'patch.mjs', record['scriptIdentity'])
    require(payload/'package/package.json', record['metadata'])
    for name in FILES:
        require(payload/'package'/name, record['files'][name]['before'])
    subprocess.run(['/opt/homebrew/bin/node', str(payload/'patch.mjs'), '--apply', str(payload/'package')],
                   check=True, capture_output=True, text=True, timeout=30)
    for name in FILES:
        record['files'][name]['after'] = snapshot(payload/'package'/name)
        if record['files'][name]['after']['mode'] != record['files'][name]['before']['mode']:
            raise RuntimeError('Design Deck patch must preserve permissions')
    assert_prepared(record, stage)
    return record


def assert_record(record):
    if record['packageRoot'] != str(PACKAGE) or set(record['files']) not in (set(FILES), {'index.ts', 'form/js/deck-session.js'}):
        raise RuntimeError('Design Deck plan has an unsupported package or file set')
    if metadata() != record['metadata']:
        raise RuntimeError('Design Deck package metadata drift')


def assert_prepared(record, stage):
    if not record:
        return
    assert_record(record)
    require(Path(record['script']), record['scriptIdentity'])
    payload = stage/PAYLOAD
    require(payload/'patch.mjs', record['scriptIdentity'])
    require(payload/'package/package.json', record['metadata'])
    for name in record['files']:
        require(PACKAGE/name, record['files'][name]['before'])
        require(payload/'package'/name, record['files'][name]['after'])


def assert_installed(record):
    if not record:
        return
    assert_record(record)
    for name in record['files']:
        require(PACKAGE/name, record['files'][name]['after'])


def replace_file(path, data, expected):
    """Same-directory atomic replacement; never overwrite a concurrent unknown edit."""
    require(path, expected)
    fd, filename = tempfile.mkstemp(prefix='.pi-web-release-', dir=path.parent)
    temporary = Path(filename)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            os.fchmod(stream.fileno(), expected['mode'])
            stream.flush()
            os.fsync(stream.fileno())
        require(path, expected)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def activate(record, stage, backup):
    if not record:
        return
    assert_prepared(record, stage)
    saved = backup/'design-deck'
    saved.mkdir(mode=0o700)
    # All originals must be backed up and checked before the first live write.
    for name in record['files']:
        target = saved/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PACKAGE/name, target)
    for name in record['files']:
        require(saved/name, record['files'][name]['before'])
    assert_prepared(record, stage)
    for name in record['files']:
        data = (stage/PAYLOAD/'package'/name).read_bytes()
        if hashlib.sha256(data).hexdigest() != record['files'][name]['after']['sha256']:
            raise RuntimeError('Design Deck patched bytes changed during activation')
        replace_file(PACKAGE/name, data, record['files'][name]['before'])
    assert_installed(record)


def restore(record, backup):
    if not record:
        return
    assert_record(record)
    current = {name: snapshot(PACKAGE/name) for name in record['files']}
    # Validate all current files before restoring any; never cover someone else's update.
    for name in record['files']:
        if current[name] not in (record['files'][name]['before'], record['files'][name]['after']):
            raise RuntimeError('Design Deck rollback blocked by an unknown edit: '+name)
    changed = [name for name in record['files'] if current[name] != record['files'][name]['before']]
    if changed:
        for name in record['files']:
            require(backup/'design-deck'/name, record['files'][name]['before'])
        for name in changed:
            data = (backup/'design-deck'/name).read_bytes()
            if hashlib.sha256(data).hexdigest() != record['files'][name]['before']['sha256']:
                raise RuntimeError('Design Deck backup changed during rollback')
            replace_file(PACKAGE/name, data, current[name])
    for name in record['files']:
        require(PACKAGE/name, record['files'][name]['before'])
