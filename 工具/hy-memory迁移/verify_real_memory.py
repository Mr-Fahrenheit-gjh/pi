"""Real migrated-memory read-only acceptance. Prints booleans/counts, never payloads."""
from pathlib import Path
from datetime import datetime,timezone,timedelta
import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import cutover
from migrate_sdk import api,PROJECT

ROOT=Path(__file__).resolve().parent


def check(store):
    cutover.source_check();identity,_=cutover.verify_migration();cutover.verify_archive(store)
    before=api('status',{})
    assert before.get('status')=='ok','engine_unhealthy'
    assert before.get('receipts')=={'completed':len(identity['request_ids'])},'unexpected_receipts'
    queries=[('Pi Web升级的时候，需要保留我的本地定制和主题吗？',('定制','主题','覆盖')),
        ('每次完成一项任务以后，Git应该怎么处理？',('提交','commit')),
        ('我对回复语言和重点格式有什么偏好？',('中文','自然','简洁','简短','加粗'))]
    canonical_sources=0
    for query,expected in queries:
        result=api('search',{'project':PROJECT,'scope':'global','query':query,'limit':8})
        assert any(any(word in item.get('content','').lower() for word in expected) for item in result.get('memories',[])),'real_preference_not_recalled'
        for item in result['memories']:
            memory=api('get',{'project':PROJECT,'scope':'global','memory_id':item['memory_id']})['memory']
            if memory and memory.get('provenance',{}).get('source_ref')=='MEMORY.md':canonical_sources+=1
    assert canonical_sources,'curated_source_missing'
    manifest=json.loads((ROOT/'data/imports/manifest.json').read_text())
    pages=0
    for item in manifest:
        expected=(store/'archive'/item['source']).read_text();parts=[];offset=0
        while True:
            result=api('archive_read',{'project':PROJECT,'scope':'archive','source':item['source'],'offset':offset})
            assert result.get('historical_original') is True,'original_not_identified'
            parts.append(result['content']);pages+=1
            offset=result.get('next_offset')
            if offset is None:break
        assert ''.join(parts)==expected,'original_api_readback_mismatch'
    historical=api('search',{'project':PROJECT,'scope':'archive','query':'过去日志里记录过哪些用户偏好和明确决定？','limit':10})
    assert historical.get('memories'),'historical_semantic_recall_empty'
    dated_sources=0;original_dates=0
    for item in historical['memories']:
        memory=api('get',{'project':PROJECT,'scope':'archive','memory_id':item['memory_id']})['memory']
        if not memory:continue
        provenance=memory.get('provenance',{});source=provenance.get('source_ref','')
        if source.startswith('daily/') and provenance.get('memory_at','')[:10]==Path(source).stem:
            dated_sources+=1
            value=memory.get('memory_at')
            if isinstance(value,(int,float)):
                day=datetime.fromtimestamp(value/1000 if value>1e11 else value,timezone(timedelta(hours=8))).date().isoformat()
            else:day=str(value)[:10]
            if day==Path(source).stem:original_dates+=1
    assert dated_sources,'historical_source_or_date_missing'
    assert original_dates,'canonical_original_dates_missing'
    after=api('status',{})
    assert after.get('status')=='ok' and after['receipts']==before['receipts'],'read_only_check_changed_mutations'
    return {'real_preference_queries_passed':len(queries),'original_files_read_back':len(manifest),'original_api_pages':pages,
        'canonical_curated_source_links':canonical_sources,'historical_semantic_recall':True,'dated_source_links':dated_sources,
        'canonical_original_dates_retained':original_dates,'completed_requests':len(identity['request_ids']),'unknown':0,'read_only':True}


def start(store):
    env={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy')}
    env.update(HY_MEMORY_HOME=str(store),HY_BRIDGE_TOKEN_FILE=str(ROOT/'data/bridge-token'),PYTHONFAULTHANDLER='1')
    log=(ROOT/'data/real-memory-verify-engine.log').open('ab')
    process=subprocess.Popen([sys.executable,'-u',str(ROOT/'sdk_service.py')],env=env,stdout=log,stderr=log);log.close()
    try:
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if process.poll() is not None:raise RuntimeError('verification_engine_start_failed')
            try:
                api('status',{})
                listener=subprocess.run(['/usr/sbin/lsof','-nP','-iTCP:30148','-sTCP:LISTEN','-t'],capture_output=True,text=True,check=True).stdout.split()
                if listener!=[str(process.pid)]:raise RuntimeError('verification_port_owned_by_other_process')
                return process
            except urllib.error.URLError:time.sleep(.1)
        raise RuntimeError('verification_engine_start_timeout')
    except BaseException:
        if process.poll() is None:process.send_signal(signal.SIGTERM);process.wait(timeout=90)
        raise


def stop(process):
    process.send_signal(signal.SIGTERM)
    if process.wait(timeout=90)!=0:raise RuntimeError('verification_engine_unclean_shutdown')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--store',type=Path,required=True);parser.add_argument('--phase',choices=['isolated','production'],required=True);args=parser.parse_args()
    os.umask(0o077);store=args.store.resolve()
    if args.phase=='isolated':
        cutover.prepare_provenance(store)
        reports=[]
        for _ in range(2):
            process=start(store)
            try:reports.append(check(store))
            finally:stop(process)
        report={'phase':'isolated','checks':reports,'cold_restart_persistence':True}
    else:report={'phase':'production','checks':[check(store)]}
    report['source_sha256']={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['sdk_engine.py','sdk_service.py','index.ts','cutover.py','migrate_sdk.py']}
    (ROOT/('data/real-memory-'+args.phase+'.json')).write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)


if __name__=='__main__':main()
