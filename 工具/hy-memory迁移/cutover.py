"""Scoped memory cutover/rollback. Old store is preserved; Web must be stopped."""
from contextlib import contextmanager
from pathlib import Path
import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tarfile

ROOT=Path(__file__).resolve().parent
BASE=Path.home()/'.pi/agent/hy-memory'
SETTINGS=Path.home()/'.pi/agent/settings.json'
OLD='/Users/guojiahang/Documents/pi/项目/规则优化/agent-eval-20261002/packages/pi-memory-local'
NEW=str(BASE/'runtime/plugin')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@contextmanager
def configuration_lock():
    with (BASE/'configuration.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        yield


def require_quiesced():
    # The activation worker uses the existing Web idle/PTY guard to stop Web.
    # Refuse direct live switches and known standalone CLI writers as well.
    from install_runtime import registered
    if registered('gui/'+str(os.getuid())+'/cn.pi.web'):
        raise RuntimeError('stop_web_with_idle_guard_before_configuration_change')
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        listener.bind(('127.0.0.1',30141))
    rows=subprocess.run(['/bin/ps','-axo','command='],capture_output=True,text=True,check=True).stdout
    if re.search(r'(?:pi-coding-agent|/pi)/dist/cli\.(?:js|mjs)',rows):
        raise RuntimeError('standalone_pi_writer_active')


def source_check():
    backup=Path(json.loads((ROOT/'data/backup-location.json').read_text())['path'])
    manifest=json.loads((backup/'manifest.json').read_text())
    source=Path.home()/'.pi/agent/memory'
    expected={item['path']:item for item in manifest}
    actual={str(p.relative_to(source)) for p in source.rglob('*') if p.is_file()}
    if actual!=set(expected) or any(digest(source/name)!=item['sha256'] for name,item in expected.items()):
        raise RuntimeError('old_memory_changed_refresh_snapshot_before_migration')
    return backup


def verify_migration():
    from migrate_sdk import migration_identity
    identity=migration_identity()
    expected=identity['request_ids']
    summary=json.loads((ROOT/'data/migration-summary.json').read_text())
    receipts=json.loads((ROOT/'data/migration-receipts.json').read_text())
    actual=[row['request_id'] for row in receipts]
    if not expected or len(expected)!=len(set(expected)) or actual!=expected:
        raise RuntimeError('migration_receipt_set_incomplete_or_stale')
    if summary.get('identity')!=identity or summary.get('unknown')!=0 or summary.get('completed')!=len(expected) or summary.get('requests')!=len(expected):
        raise RuntimeError('migration_summary_incomplete_or_stale')
    if any(row.get('state')!='completed' for row in receipts):
        raise RuntimeError('migration_receipt_not_completed')
    return identity,receipts


def archive(store):
    backup=source_check()
    output=store/'archive';output.mkdir(mode=0o700,parents=True,exist_ok=True)
    with tarfile.open(backup/'pi-memory-original.tar.gz') as tar:
        for member in tar:
            source=member.name.removeprefix('memory/')
            if source=='MEMORY.md' or (re.fullmatch(r'daily/\d{4}-\d{2}-\d{2}\.md',source)):
                if not member.isfile():raise RuntimeError('archive_nonfile_refused')
                target=output/source;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                target.write_bytes(tar.extractfile(member).read());target.chmod(0o600)
    verify_archive(store)


def verify_archive(store):
    manifest=json.loads((ROOT/'data/imports/manifest.json').read_text())
    for item in manifest:
        if digest(store/'archive'/item['source'])!=item['source_sha256']:
            raise RuntimeError('archive_hash_mismatch')
    return len(manifest)


def write_provenance(store):
    from migrate_sdk import build_jobs
    identity,receipts=verify_migration()
    _,jobs=build_jobs()
    origins={body['request_id']:{'owner':'pi-'+body['scope'],'origin':body['origin'],
        'source_ref':source,'entry_ref':'entry:'+body['request_id'] if body['raw'] else None,
        'memory_at':body.get('memory_at'),'historical_original':True} for source,body in jobs}
    if set(origins)!=set(identity['request_ids']):raise RuntimeError('provenance_identity_mismatch')
    # Canonical IDs can survive SDK reconciliation with older custom metadata.
    # Bind their latest verified import source without changing SDK facts/ranking.
    for row in receipts:
        for memory_id in row['verified_ids']:
            origins['memory:'+memory_id]=origins[row['request_id']]
    temporary=store/'import-provenance.pending';temporary.write_text(json.dumps(origins,ensure_ascii=False,indent=2));temporary.chmod(0o600)
    temporary.replace(store/'import-provenance.json')


def prepare_provenance(store):
    with (store/'writer.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        write_provenance(store)
    print('provenance_prepared_offline')


def stage(store):
    source_check();identity,_=verify_migration();verify_archive(store)
    # Caller must cleanly stop the candidate first; never copy live SQLite/vectors.
    with (store/'writer.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        write_provenance(store)
        target=BASE/'data'
        if target.exists():raise RuntimeError('existing_production_store_refused')
        shutil.copytree(store,target)
        for p in [target,*target.rglob('*')]:
            if p.is_symlink():raise RuntimeError('symlink_refused')
            p.chmod(0o700 if p.is_dir() else 0o600)
        # This marker is mandatory at switch, bound to this import and destination.
        marker={'identity':identity,'target':str(target),'source':str(store.resolve())}
        (target/'staged-migration.json').write_text(json.dumps(marker,indent=2))
    print(json.dumps({'staged':True,'pi_settings_changed':False}))


def switch():
    with configuration_lock():
        require_quiesced()
        backup=source_check()
        before=SETTINGS.read_bytes()  # one immutable snapshot for parse/backup/state
        if before!=(backup/'settings.json').read_bytes():
            raise RuntimeError('settings_changed_reconcile_before_switch')
        identity,receipts=verify_migration()
        marker=json.loads((BASE/'data/staged-migration.json').read_text())
        if marker.get('identity')!=identity or marker.get('target')!=str(BASE/'data'):
            raise RuntimeError('verified_staged_store_required')
        verify_archive(BASE/'data')
        from migrate_sdk import api
        if api('status',{}).get('status')!='ok':raise RuntimeError('production_engine_unhealthy')
        for row in receipts:
            if api('status',{'request_id':row['request_id']}).get('state')!='completed':
                raise RuntimeError('production_receipt_missing')
        settings=json.loads(before);packages=settings['packages']
        if packages.count(OLD)!=1 or NEW in packages:raise RuntimeError('unexpected_packages')
        settings['packages']=[NEW if item==OLD else item for item in packages]
        original=BASE/'settings-before-cutover.json'
        if original.exists():raise RuntimeError('previous_cutover_exists')
        after=(json.dumps(settings,ensure_ascii=False,indent=2)+'\n').encode()
        temporary=SETTINGS.with_name('settings.hy-memory.pending')
        try:
            temporary.write_bytes(after);temporary.chmod(0o600)
            # No network work between this final validation and atomic replace.
            # Web/CLI writers remain stopped; the lock serializes our own tools.
            require_quiesced();source_check()
            if SETTINGS.read_bytes()!=before:raise RuntimeError('settings_changed_during_switch')
            original.write_bytes(before);original.chmod(0o600)
            state={'before_sha256':hashlib.sha256(before).hexdigest(),'after_sha256':hashlib.sha256(after).hexdigest(),
                'identity':identity,'old_package':OLD,'new_package':NEW}
            (BASE/'cutover-state.json').write_text(json.dumps(state,indent=2))
            temporary.replace(SETTINGS)
        finally:
            temporary.unlink(missing_ok=True)
        return {'settings_switched':True,'web_restarted':False,'old_memory_preserved':True}


def rollback():
    with configuration_lock():
        require_quiesced()
        state=json.loads((BASE/'cutover-state.json').read_text())
        before=SETTINGS.read_bytes()
        if hashlib.sha256(before).hexdigest()!=state['after_sha256']:
            raise RuntimeError('settings_changed_do_not_overwrite')
        original=(BASE/'settings-before-cutover.json').read_bytes()
        if hashlib.sha256(original).hexdigest()!=state['before_sha256']:raise RuntimeError('backup_changed')
        from migrate_sdk import api
        status=api('status',{})
        expected=len(state['identity']['request_ids'])
        if status.get('status')!='ok' or status.get('receipts')!={'completed':expected}:
            raise RuntimeError('new_memory_writes_require_manual_reconciliation_before_rollback')
        temporary=SETTINGS.with_name('settings.hy-memory.pending')
        try:
            temporary.write_bytes(original);temporary.chmod(0o600)
            require_quiesced()
            if SETTINGS.read_bytes()!=before:raise RuntimeError('settings_changed_during_rollback')
            temporary.replace(SETTINGS)
        finally:temporary.unlink(missing_ok=True)
        return {'settings_restored':True,'web_restarted':False,'memory_stores_preserved':True}


if __name__=='__main__':
    os.umask(0o077)
    action=sys.argv[1]
    if action=='check-source':source_check();print('source_snapshot_unchanged')
    elif action=='archive':archive(Path(sys.argv[2]));print('archive_hashes_verified')
    elif action=='stage':stage(Path(sys.argv[2]))
    elif action=='provenance':prepare_provenance(Path(sys.argv[2]))
    elif action=='switch':print(json.dumps(switch()))
    elif action=='rollback':print(json.dumps(rollback()))
    else:raise ValueError('check-source | archive STORE | provenance STOPPED_STORE | stage STOPPED_STORE | switch | rollback')
