"""Private loopback transport and mutation receipts around the OFFICIAL Hy-Memory SDK."""
from __future__ import annotations

from datetime import datetime
from contextlib import contextmanager
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import signal
import sqlite3
import threading
import uuid
from sdk_engine import make_client, checked_write, memory_items


class Service:
    def __init__(self, root: Path, token_file: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
        self.lock_file = (root/'writer.lock').open('a')
        fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.token = token_file.read_text().strip()
        self.ledger = root/'receipts.sqlite3'
        self.operation_lock = threading.Lock()
        self.accepting = True
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS sources (memory_id TEXT PRIMARY KEY, request_id TEXT NOT NULL)')
            db.execute("UPDATE receipts SET state='unknown' WHERE state='running'")
        self.client = make_client(root/'engine', token_file)
        provenance=root/'import-provenance.json'
        self.import_provenance=json.loads(provenance.read_text()) if provenance.exists() else {}

    def with_provenance(self, memory):
        if not isinstance(memory,dict):
            return memory
        custom=memory.get('custom')
        request_id=custom.get('request_id') if isinstance(custom,dict) else None
        with self.db() as db:
            current=db.execute('SELECT request_id FROM sources WHERE memory_id=?',(memory.get('memory_id',''),)).fetchone()
        if current:
            request_id=current[0]
        else:
            origin=self.import_provenance.get('memory:'+str(memory.get('memory_id','')))
            if origin and origin.get('owner')==memory.get('user_id'):
                return {**memory,'provenance':{k:v for k,v in origin.items() if k!='owner'}}
        try:
            request_id=str(uuid.UUID(request_id))
        except (ValueError,TypeError,AttributeError):
            return memory
        origin=self.import_provenance.get(request_id)
        if origin and origin.get('owner')==memory.get('user_id'):
            return {**memory,'provenance':{k:v for k,v in origin.items() if k!='owner'}}
        entry=self.root/'entries'/(request_id+'.json')
        if entry.exists():
            original=json.loads(entry.read_text())
            if original.get('owner')==memory.get('user_id'):
                return {**memory,'provenance':{'source_ref':'entry:'+request_id,'origin':original.get('origin','pi-tool')}}
        return memory

    @contextmanager
    def db(self):
        connection=sqlite3.connect(self.ledger, timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def backend_snapshot(self):
        import urllib.request
        request=urllib.request.Request('http://127.0.0.1:30147/health',headers={'Authorization':'Bearer '+self.token})
        with urllib.request.urlopen(request,timeout=2) as response:
            backend=json.load(response)
        if backend.get('status')!='ok' or backend.get('reasoning')!='medium' or backend.get('dimensions')!=768:
            raise RuntimeError('backend_not_ready')
        return backend

    def status(self, request_id=None):
        with self.db() as db:
            if request_id:
                row=db.execute('SELECT state,result FROM receipts WHERE id=?',(request_id,)).fetchone()
                return {'request_id':request_id,'state':row[0] if row else 'not_found', 'result':json.loads(row[1]) if row and row[1] else None}
            states=dict(db.execute('SELECT state,count(*) FROM receipts GROUP BY state'))
        try:
            self.backend_snapshot()
            backend_ok=True
        except Exception:
            backend_ok=False
        return {'status':'ok' if not states.get('unknown') and backend_ok and self.accepting else 'degraded','backend':'ok' if backend_ok else 'unavailable','engine':'hy-memory','version':'2.0.2',
            'model':'gpt-6.1-sol','reasoning':'medium','embedding':'qmd-local-768','receipts':states,'accepting':self.accepting}

    @staticmethod
    def namespaces(body):
        project=body.get('project','')
        if not isinstance(project,str) or not project or len(project)>4096:
            raise ValueError('project_required')
        project_id='pi-project-'+hashlib.sha256(os.path.realpath(project).encode()).hexdigest()[:24]
        scope=body.get('scope','all')
        choices={'global':['pi-global'],'project':[project_id],'archive':['pi-archive'],
            'current':['pi-global',project_id], 'all':['pi-global',project_id,'pi-archive']}
        if scope not in choices:
            raise ValueError('invalid_scope')
        return choices[scope]

    def execute(self, action, body):
        if action=='status':
            return self.status(body.get('request_id'))
        owners=self.namespaces(body)
        with self.operation_lock:
            if not self.accepting:
                raise ValueError('service_stopping')
            if action=='archive_read':
                source=body.get('source','')
                import re
                if re.fullmatch(r'entry:[a-f0-9-]{36}',source):
                    file=self.root/'entries'/(source[6:]+'.json')
                    data=json.loads(file.read_text())
                    if data.get('owner') not in owners:
                        raise ValueError('archive_outside_scope')
                    text=data['content']
                    if not isinstance(text,str):
                        text=json.dumps(text,ensure_ascii=False)
                elif re.fullmatch(r'daily/\d{4}-\d{2}-\d{2}\.md|MEMORY\.md',source):
                    if 'pi-archive' not in owners:
                        raise ValueError('archive_outside_scope')
                    text=(self.root/'archive'/source).read_text()
                else:
                    raise ValueError('invalid_archive_source')
                offset=max(0,int(body.get('offset',0)))
                return {'source':source,'historical_original':True,'content':text[offset:offset+12000],'next_offset':offset+12000 if len(text)>offset+12000 else None}
            if action=='search':
                query=body.get('query','')
                if not isinstance(query,str) or not query.strip() or len(query)>4000:
                    raise ValueError('invalid_query')
                limit=min(20,max(1,int(body.get('limit',8))))
                before=self.backend_snapshot()['counters']['failed']
                result=self.client.search(query,user_ids=owners,scene='chat',reader='hybrid',limit=limit,min_score=0.25)
                after=self.backend_snapshot()['counters']['failed']
                if after>before or result.get('error_code') or result.get('error_message'):
                    raise RuntimeError('search_backend_failed_not_empty_memory')
                items=[self.with_provenance(item) for item in memory_items(result)]
                unique={item['memory_id']:item for item in items}
                return {'memories':sorted(unique.values(),key=lambda item:item.get('score',0),reverse=True)[:limit],'elapsed_ms':result.get('elapsed_ms')}
            if action=='list':
                return self.client.list_memories(user_ids=owners,limit=100,offset=max(0,int(body.get('offset',0))))
            if action=='get':
                value=self.client.get(body.get('memory_id',''))
                if value and value.get('user_id') not in owners:
                    raise ValueError('memory_outside_scope')
                return {'memory':self.with_provenance(value)}
            if action not in ('write','update','delete'):
                raise ValueError('unsupported_action')
            if action in ('write','update'):
                import re
                content_text=json.dumps(body.get('content',''),ensure_ascii=False)
                if re.search(r'\bsk-[A-Za-z0-9_-]{16,}\b|\b(?:ghp_|github_pat_|hf_)[A-Za-z0-9_]{20,}\b|BEGIN [A-Z ]*PRIVATE KEY',content_text):
                    raise ValueError('credential_content_not_allowed')
            request_id=str(uuid.UUID(body.get('request_id','')))
            fingerprint=hashlib.sha256(json.dumps([action,body],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
            with self.db() as db:
                previous=db.execute('SELECT fingerprint,state,result FROM receipts WHERE id=?',(request_id,)).fetchone()
                if previous:
                    if previous[0]!=fingerprint:
                        raise ValueError('request_identity_conflict')
                    return {'request_id':request_id,'state':previous[1],'result':json.loads(previous[2]) if previous[2] else None,'reused':True}
            # Reject deterministic validation errors BEFORE creating a running
            # receipt. Only failures after the mutation boundary are uncertain.
            if action in ('write','update'):
                content=body.get('content')
                if action=='write':
                    if len(owners)!=1:
                        raise ValueError('write_requires_one_scope')
                    if not isinstance(content,(str,list)) or not content or len(json.dumps(content))>150000:
                        raise ValueError('invalid_content')
                    if body.get('memory_at'):
                        timestamp=datetime.fromisoformat(body['memory_at'].replace('Z','+00:00'))
                        if timestamp.utcoffset() is None:
                            raise ValueError('timezone_required')
                elif not isinstance(content,str) or not content.strip() or len(content)>12000:
                    raise ValueError('invalid_content')
            if action in ('update','delete'):
                value=self.client.get(body.get('memory_id',''))
                if not value or value.get('user_id') not in owners:
                    raise ValueError('memory_not_found_in_scope')
            with self.db() as db:
                db.execute('INSERT INTO receipts VALUES (?,?,?,NULL)',(request_id,fingerprint,'running'))
            try:
                if action=='write':
                    if len(owners)!=1:
                        raise ValueError('write_requires_one_scope')
                    content=body.get('content')
                    if not isinstance(content,(str,list)) or not content or len(json.dumps(content))>150000:
                        raise ValueError('invalid_content')
                    kwargs={'user_id':owners[0],'agent_id':'pi','source':'pi','request_id':request_id,
                        'session_id':str(body.get('session_id','manual'))[:200],
                        'metadata':{'origin':str(body.get('origin','pi-tool'))[:500]}}
                    if body.get('memory_at'):
                        timestamp=datetime.fromisoformat(body['memory_at'].replace('Z','+00:00'))
                        if timestamp.utcoffset() is None:
                            raise ValueError('timezone_required')
                        kwargs['memory_at']=timestamp
                    # Preserve authorized input as provenance, independently of
                    # the SDK's deliberately private L1_RAW implementation.
                    directory=self.root/'entries';directory.mkdir(mode=0o700,exist_ok=True)
                    original=directory/(request_id+'.json')
                    original.write_text(json.dumps({'owner':owners[0],'origin':kwargs['metadata']['origin'],'content':content},ensure_ascii=False))
                    original.chmod(0o600)
                    source_ref='entry:'+request_id
                    raw=self.client.add(content,scene='chat',**kwargs) if body.get('raw') else self.client.add_extracted(content,**kwargs)
                    result=checked_write(self.client,raw)
                    if source_ref:
                        result['source_ref']=source_ref
                else:
                    memory_id=body.get('memory_id','')
                    value=self.client.get(memory_id)
                    if not value or value.get('user_id') not in owners:
                        raise ValueError('memory_not_found_in_scope')
                    if action=='update':
                        content=body.get('content','')
                        if not isinstance(content,str) or not content.strip() or len(content)>12000:
                            raise ValueError('invalid_content')
                        directory=self.root/'entries';directory.mkdir(mode=0o700,exist_ok=True)
                        original=directory/(request_id+'.json')
                        original.write_text(json.dumps({'owner':value['user_id'],'origin':'pi-tool-update','content':content},ensure_ascii=False))
                        original.chmod(0o600)
                        raw=self.client.update(memory_id,content)
                        result=checked_write(self.client,raw)
                        saved=self.client.get(memory_id)
                        if not saved or saved.get('content')!=content:
                            raise RuntimeError('update_readback_failed')
                        result['source_ref']='entry:'+request_id
                    else:
                        result=self.client.delete(memory_id)
                        if result.get('success') is not True or self.client.get(memory_id) is not None:
                            raise RuntimeError('delete_readback_failed')
                with self.db() as db:
                    changed=result.get('verified_ids',[]) if action=='write' else [body['memory_id']] if action=='update' else []
                    db.executemany('INSERT OR REPLACE INTO sources VALUES (?,?)',[(mid,request_id) for mid in changed])
                    db.execute("UPDATE receipts SET state='completed',result=? WHERE id=?",(json.dumps(result,ensure_ascii=False),request_id))
                return {'request_id':request_id,'state':'completed','result':result}
            except Exception:
                # Never replay an uncertain mutation or report an exception as success.
                with self.db() as db:
                    db.execute("UPDATE receipts SET state='unknown' WHERE id=?",(request_id,))
                raise

    def close(self):
        self.accepting=False
        with self.operation_lock:
            self.client.close()
        fcntl.flock(self.lock_file,fcntl.LOCK_UN)
        self.lock_file.close()


def serve(root, token_file, port):
    service=Service(root,token_file)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):
            pass  # No URLs, query text, payloads, personal paths, or exception bodies in logs.
        def do_POST(self):
            if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+service.token):
                return self.respond(401,{'error':'unauthorized'})
            if self.headers.get('Origin'):
                return self.respond(403,{'error':'browser_origin_not_allowed'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if length<2 or length>512*1024:
                    return self.respond(413,{'error':'invalid_body_size'})
                self.connection.settimeout(15)
                body=json.loads(self.rfile.read(length))
                if not isinstance(body,dict) or not self.path.startswith('/v1/') or '?' in self.path:
                    raise ValueError('invalid_request')
                result=service.execute(self.path[4:],body)
                self.respond(200,result)
            except Exception as error:
                known={'hy_write_failed_or_partial','hy_write_readback_failed','update_readback_failed','delete_readback_failed','memory_outside_scope','memory_not_found_in_scope','invalid_content','credential_content_not_allowed'}
                code=str(error) if str(error) in known else type(error).__name__
                print(json.dumps({'event':'operation_failed','code':code}),flush=True)
                self.respond(400 if isinstance(error,(ValueError,TypeError)) else 503,{'error':'memory_operation_failed','request_id':body.get('request_id') if isinstance(locals().get('body'),dict) else None})
        def respond(self,status,value):
            try:
                payload=json.dumps(value,ensure_ascii=False).encode()
                self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
            except (BrokenPipeError,ConnectionResetError):
                pass
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    server.daemon_threads=False
    def stop(*_):
        service.accepting=False
        threading.Thread(target=server.shutdown,daemon=True).start()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    print(json.dumps({'event':'ready','port':port,'sdk':'2.0.2'}),flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close();service.close()


if __name__=='__main__':
    os.umask(0o077)
    serve(Path(os.environ['HY_MEMORY_HOME']),Path(os.environ['HY_BRIDGE_TOKEN_FILE']),int(os.environ.get('HY_MEMORY_PORT','30148')))
