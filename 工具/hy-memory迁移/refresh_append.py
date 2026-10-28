"""Refresh a migration snapshot ONLY for append-only MEMORY.md changes; no model calls."""
from pathlib import Path
from datetime import datetime,timezone
import hashlib
import io
import json
import os
import tarfile
import uuid

ROOT=Path(__file__).resolve().parent
SOURCE=Path.home()/'.pi/agent/memory'


def main():
    os.umask(0o077)
    data=ROOT/'data';old=Path(json.loads((data/'backup-location.json').read_text())['path'])
    manifest=json.loads((old/'manifest.json').read_text());expected={x['path']:x for x in manifest}
    current={str(p.relative_to(SOURCE)):p.read_bytes() for p in SOURCE.rglob('*') if p.is_file()}
    if set(current)!=set(expected):raise RuntimeError('source_file_set_changed')
    if any(hashlib.sha256(value).hexdigest()!=expected[name]['sha256'] for name,value in current.items() if name!='MEMORY.md'):
        raise RuntimeError('non_curated_source_changed')
    settings=(Path.home()/'.pi/agent/settings.json').read_bytes()
    if settings!=(old/'settings.json').read_bytes():raise RuntimeError('settings_changed')
    with tarfile.open(old/'pi-memory-original.tar.gz') as archive:before=archive.extractfile('memory/MEMORY.md').read()
    after=current['MEMORY.md']
    if not after.startswith(before) or len(after)==len(before):raise RuntimeError('not_a_nonempty_append')
    delta=after[len(before):].decode();sha=hashlib.sha256(after).hexdigest()
    target=data/('backup-'+datetime.now().strftime('%Y%m%d-%H%M%S'));target.mkdir(mode=0o700)
    updated=[]
    with tarfile.open(target/'pi-memory-original.tar.gz','w:gz') as archive:
        for name,value in sorted(current.items()):
            info=tarfile.TarInfo('memory/'+name);info.size=len(value);info.mode=0o600
            archive.addfile(info,io.BytesIO(value));updated.append({'path':name,'size':len(value),'sha256':hashlib.sha256(value).hexdigest()})
    (target/'manifest.json').write_text(json.dumps(updated,indent=2));(target/'settings.json').write_bytes(settings)
    if any((SOURCE/name).read_bytes()!=value for name,value in current.items()):raise RuntimeError('source_changed_during_snapshot')
    if (Path.home()/'.pi/agent/settings.json').read_bytes()!=settings:raise RuntimeError('settings_changed_during_snapshot')
    imports=data/'imports/manifest.json';entries=json.loads(imports.read_text())
    for entry in entries:
        if entry['source']=='MEMORY.md':entry['source_sha256']=sha
    delta_file=data/'import-deltas.json';deltas=json.loads(delta_file.read_text()) if delta_file.exists() else []
    for entry in deltas:entry['source_sha256']=sha
    identifier=str(uuid.uuid5(uuid.NAMESPACE_URL,'pi-hy-append:'+hashlib.sha256(delta.encode()).hexdigest()))
    deltas.append({'source':'MEMORY.md','source_sha256':sha,'content':delta,'request_id':identifier,
        'origin':'pi-memory:MEMORY.md#append-'+identifier,'memory_at':datetime.now(timezone.utc).isoformat()})
    delta_file.write_text(json.dumps(deltas,ensure_ascii=False,indent=2));imports.write_text(json.dumps(entries,ensure_ascii=False,indent=2))
    (data/'backup-location.json').write_text(json.dumps({'path':str(target),'files':len(current),'bytes':sum(map(len,current.values()))},ensure_ascii=False,indent=2))
    print(json.dumps({'append_bytes':len(after)-len(before),'delta_requests_added':1,'source_files':len(current)}))


if __name__=='__main__':main()
