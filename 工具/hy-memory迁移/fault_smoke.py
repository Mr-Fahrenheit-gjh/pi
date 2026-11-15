"""Synthetic real-process interruption, dropped-response and shutdown checks."""
from pathlib import Path
import concurrent.futures
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT=Path(__file__).resolve().parent
TOKEN=(ROOT/'data/bridge-token').read_text().strip()
STORE=ROOT/('data/sdk-service-fault-test-'+uuid.uuid4().hex[:8])
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
PROJECT='/tmp/pi-hy-fault-smoke'


def api(action,body):
    request=urllib.request.Request('http://127.0.0.1:30148/v1/'+action,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
    with OPENER.open(request,timeout=250) as response:return json.load(response)


def start():
    env={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy')}
    env.update(HY_MEMORY_HOME=str(STORE),HY_BRIDGE_TOKEN_FILE=str(ROOT/'data/bridge-token'),PYTHONFAULTHANDLER='1')
    log=(ROOT/'data/fault-service.log').open('ab')
    process=subprocess.Popen([sys.executable,'-u',str(ROOT/'sdk_service.py')],env=env,stdout=log,stderr=log)
    log.close()
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        if process.poll() is not None:raise RuntimeError('candidate_start_failed')
        try:api('status',{});return process
        except urllib.error.URLError:time.sleep(.1)
    raise RuntimeError('candidate_start_timeout')


def stop(process):
    process.send_signal(signal.SIGTERM)
    assert process.wait(timeout=60)==0,'unclean_sdk_shutdown'


def main():
    os.umask(0o077)
    process=start();tests={}
    try:
        identifier=str(uuid.uuid4())
        body={'project':PROJECT,'scope':'project','content':'故障验收海鸥最喜欢的饮料是柠檬茶。','request_id':identifier}
        payload=json.dumps(body).encode()
        # Send a complete mutation, then close without reading any response.
        with socket.create_connection(('127.0.0.1',30148),timeout=10) as connection:
            header=f'POST /v1/write HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n'.encode()
            connection.sendall(header+payload)
        deadline=time.monotonic()+250
        while time.monotonic()<deadline:
            receipt=api('status',{'request_id':identifier})
            if receipt['state']=='completed':break
            assert receipt['state'] in ('not_found','running')
            time.sleep(.2)
        assert receipt['state']=='completed'
        assert receipt['result']['verified_ids']
        reused=api('write',body);assert reused['reused'] is True
        tests['real_dropped_response_recovered_by_receipt']=True
        # Stop/restart the real model adapter, and require an explicit failure.
        subprocess.run([sys.executable,str(ROOT/'install_runtime.py'),'stop','models'],check=True)
        try:
            assert api('status',{})['backend']=='unavailable'
            try:api('search',{'project':PROJECT,'scope':'project','query':'海鸥喜欢什么饮料？'})
            except urllib.error.HTTPError as error:assert error.code==503
            else:raise AssertionError('offline_backend_returned_empty_success')
            tests['backend_unavailable_not_empty_memory']=True
        finally:subprocess.run([sys.executable,str(ROOT/'install_runtime.py'),'start','models'],check=True)
        # Drain concurrent SDK reads during graceful shutdown, then reopen the store.
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            futures=[pool.submit(api,'list',{'project':PROJECT,'scope':'project'}) for _ in range(16)]
            for future in futures:future.result()
        stop(process);process=start()
        receipt=api('status',{'request_id':identifier})
        assert receipt['state']=='completed'
        for mid in receipt['result']['verified_ids']:
            assert api('get',{'project':PROJECT,'scope':'project','memory_id':mid})['memory']
        assert not api('status',{})['receipts'].get('unknown')
        tests['concurrent_reads_clean_shutdown_restart_persistence']=True
        # Interrupted receipts are unknown after restart, never implicitly replayed.
        stop(process)
        import sqlite3
        interrupted=str(uuid.uuid4())
        with sqlite3.connect(STORE/'receipts.sqlite3') as db:
            db.execute('INSERT INTO receipts VALUES (?,?,?,NULL)',(interrupted,'synthetic-interrupted','running'))
        process=start()
        assert api('status',{'request_id':interrupted})['state']=='unknown'
        tests['interrupted_receipt_never_replayed']=True
    finally:
        if process.poll() is None:stop(process)
    report={'tests':tests,'store':str(STORE),'private_memory_used':False,'source_sha256':{name:__import__('hashlib').sha256((ROOT/name).read_bytes()).hexdigest() for name in ['sdk_engine.py','sdk_service.py','install_runtime.py','index.ts']}}
    (ROOT/'data/fault-smoke.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report),flush=True)


if __name__=='__main__':main()
