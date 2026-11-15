"""Real HTTP integration tests against an isolated SDK service; synthetic records only."""
from pathlib import Path
import json
import urllib.request
import urllib.error
import uuid

ROOT=Path(__file__).resolve().parent
TOKEN=(ROOT/'data/bridge-token').read_text().strip()
PROJECT='/tmp/pi-hy-service-smoke'


def api(action,body,authorized=True):
    request=urllib.request.Request('http://127.0.0.1:30148/v1/'+action,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+(TOKEN if authorized else 'wrong'),'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=250) as response:
        return json.load(response)


def main():
    tests={}
    try:
        api('status',{},False)
        raise AssertionError('unauthorized request accepted')
    except urllib.error.HTTPError as error:
        assert error.code==401
    tests['authentication']=True
    body={'project':PROJECT,'scope':'project','content':'候选验收猫头鹰最喜欢的颜色是紫色。','request_id':str(uuid.uuid4())}
    first=api('write',body)
    assert first['state']=='completed' and first['result']['verified_ids']
    duplicate=api('write',body)
    assert duplicate['result']==first['result'] and duplicate.get('reused') is True
    tests['write_readback_and_idempotency']=True
    original=api('archive_read',{'project':PROJECT,'scope':'project','source':first['result']['source_ref']})
    assert '紫' in original['content']
    try:
        api('archive_read',{'project':'/tmp/a-different-hy-project','scope':'project','source':first['result']['source_ref']})
        raise AssertionError('foreign project original exposed')
    except urllib.error.HTTPError as error:
        assert error.code==400
    tests['original_source_scope_isolation']=True
    mid=first['result']['verified_ids'][0]
    found=api('search',{'project':PROJECT,'scope':'project','query':'猫头鹰最喜欢什么颜色？'})
    assert any('紫' in item['content'] for item in found['memories'])
    tests['actual_semantic_recall']=True
    foreign=api('search',{'project':'/tmp/a-different-hy-project','scope':'project','query':'猫头鹰最喜欢什么颜色？'})
    assert not any(item['memory_id']==mid for item in foreign['memories'])
    tests['project_isolation']=True
    corrected=api('update',{'project':PROJECT,'scope':'project','memory_id':mid,'content':'候选验收猫头鹰最喜欢的颜色是绿色。','request_id':str(uuid.uuid4())})
    assert corrected['state']=='completed'
    current=api('get',{'project':PROJECT,'scope':'project','memory_id':mid})['memory']
    assert '绿' in current['content']
    assert current['provenance']['source_ref']==corrected['result']['source_ref']
    assert '绿' in api('archive_read',{'project':PROJECT,'scope':'project','source':current['provenance']['source_ref']})['content']
    tests['write_and_update_provenance_readable']=True
    tests['explicit_update_readback']=True
    deleted=api('delete',{'project':PROJECT,'scope':'project','memory_id':mid,'request_id':str(uuid.uuid4())})
    assert deleted['state']=='completed'
    assert api('get',{'project':PROJECT,'scope':'project','memory_id':mid})['memory'] is None
    tests['explicit_delete_readback']=True
    raw=api('write',{'project':PROJECT,'scope':'archive','raw':True,'content':'用户原话：请记住，我今后的所有个人项目都默认使用 pnpm 管理依赖，不使用 npm。这是我的长期工具偏好。','request_id':str(uuid.uuid4()),'origin':'synthetic-journal','memory_at':'2026-10-01T00:00:00+08:00'})
    assert raw['state']=='completed' and raw['result']['verified_ids']
    assert 'pnpm' in api('archive_read',{'project':PROJECT,'scope':'archive','source':raw['result']['source_ref']})['content']
    recalled=api('search',{'project':PROJECT,'scope':'archive','query':'历史上选了哪个依赖管理工具？'})
    assert any('pnpm' in item['content'].lower() for item in recalled['memories'])
    tests['journal_extraction_and_recall']=True
    status=api('status',{})
    assert status['status']=='ok' and not status['receipts'].get('unknown')
    tests['no_unknown_mutations']=True
    report={'tests':tests,'sdk':'2.0.2','model':'gpt-6.1-sol','reasoning':'medium','private_memory_used':False}
    (ROOT/'data/service-smoke.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)


if __name__=='__main__':
    main()
