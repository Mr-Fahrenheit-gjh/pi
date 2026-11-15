"""Import the backed-up pi-memory snapshot through the verified local SDK service.
No payloads or model responses are printed; uncertain mutation receipts stop the import.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parent
PROJECT='/Users/guojiahang/Documents/pi'


def api(action,body):
    token=(ROOT/'data/bridge-token').read_text().strip()
    request=urllib.request.Request('http://127.0.0.1:30148/v1/'+action,data=json.dumps(body,ensure_ascii=False).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=300) as response:
        return json.load(response)


def atoms(content):
    text=content.split('\n',1)[1] if content.startswith('[Migrated curated memory;') else content
    text=re.sub(r'<!--.*?-->','',text,flags=re.S)
    text=re.sub(r'^#{1,6}\s+.*$','',text,flags=re.M)
    return [part.strip().removeprefix('- ').strip() for part in re.split(r'\n\s*\n|\n(?=- )',text) if part.strip()]


def build_jobs():
    directory=ROOT/'data/imports'
    manifest=json.loads((directory/'manifest.json').read_text())
    jobs=[]
    for entry in manifest:
        raw=(directory/entry['file']).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==entry['import_sha256']
        parsed=json.loads(raw)
        records=parsed['memories'] if entry['kind']=='memory_content' else parsed
        for index,record in enumerate(records):
            content=atoms(record['content']) if entry['kind']=='memory_content' else record['content']
            if not content:
                continue
            identifier=str(uuid.uuid5(uuid.NAMESPACE_URL,'pi-hy-import-v1:'+entry['import_sha256']+':'+str(index)))
            body={'project':PROJECT,'scope':'global' if entry['kind']=='memory_content' else 'archive',
                'content':content,'raw':entry['kind']!='memory_content','request_id':identifier,
                'session_id':'pi-memory-migration-v1','origin':'pi-memory:'+entry['source']+'#'+str(index)}
            if record.get('time'):
                body['memory_at']=record['time']
            jobs.append((entry['source'],body))
    delta_file=ROOT/'data/import-deltas.json'
    if delta_file.exists():
        sources={entry['source']:entry['source_sha256'] for entry in manifest}
        for delta in json.loads(delta_file.read_text()):
            if delta['source']!='MEMORY.md' or delta['source_sha256']!=sources[delta['source']]:
                raise RuntimeError('delta_source_mismatch')
            body={'project':PROJECT,'scope':'global','content':atoms(delta['content']),'raw':False,
                'request_id':delta['request_id'],'session_id':'pi-memory-migration-v1',
                'origin':delta['origin'],'memory_at':delta['memory_at']}
            jobs.append((delta['source'],body))
    return manifest,jobs


def migration_identity():
    manifest,jobs=build_jobs()
    return {'schema':1,'manifest_sha256':hashlib.sha256((ROOT/'data/imports/manifest.json').read_bytes()).hexdigest(),
        'jobs_sha256':hashlib.sha256(json.dumps(jobs,sort_keys=True,ensure_ascii=False).encode()).hexdigest(),
        'request_ids':[body['request_id'] for _,body in jobs]}


def main():
    os.umask(0o077)
    manifest,jobs=build_jobs()
    receipts=[]
    output=ROOT/'data/migration-receipts.json'
    for index,(source,body) in enumerate(jobs):
        previous=api('status',{'request_id':body['request_id']})
        if previous['state']=='not_found':
            result=api('write',body)
        elif previous['state']=='completed':
            result=previous
        else:
            raise RuntimeError('import_request_uncertain:'+body['request_id'])
        if result.get('state')!='completed':
            raise RuntimeError('import_not_completed:'+body['request_id'])
        verified=result.get('result') or {}
        receipts.append({'source':source,'request_id':body['request_id'],'state':result['state'],
            'verified_ids':verified.get('verified_ids',[]),'noop':verified.get('noop',False)})
        temporary=output.with_suffix('.pending')
        temporary.write_text(json.dumps(receipts,ensure_ascii=False,indent=2));temporary.replace(output)
        print(json.dumps({'completed':index+1,'total':len(jobs),'source':source,'verified_nodes':len(verified.get('verified_ids',[]))}),flush=True)
    summary={'identity':migration_identity(),'source_files':len(manifest),'requests':len(jobs),'completed':len(receipts),
        'verified_node_references':sum(len(item['verified_ids']) for item in receipts),'unknown':0,
        'source_sha256':{entry['source']:entry['source_sha256'] for entry in manifest}}
    (ROOT/'data/migration-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print(json.dumps({'migration':'completed','requests':len(receipts)}),flush=True)


if __name__=='__main__':
    main()
