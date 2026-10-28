"""Fresh, isolated real-memory migration; never changes Pi settings or starts Web."""
from pathlib import Path
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import cutover
import migrate_sdk

ROOT=Path(__file__).resolve().parent
STORE=ROOT/'data/sdk-candidate-store'


def main():
    os.umask(0o077)
    cutover.source_check()
    if STORE.exists():raise RuntimeError('candidate_exists_use_receipts_to_resume_not_fresh_replay')
    cutover.archive(STORE)
    env={k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy')}
    env.update(HY_MEMORY_HOME=str(STORE),HY_BRIDGE_TOKEN_FILE=str(ROOT/'data/bridge-token'),PYTHONFAULTHANDLER='1')
    log=(ROOT/'data/candidate-engine.log').open('ab')
    process=subprocess.Popen([sys.executable,'-u',str(ROOT/'sdk_service.py')],env=env,stdout=log,stderr=log)
    log.close()
    try:
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            if process.poll() is not None:raise RuntimeError('candidate_start_failed')
            try:
                status=migrate_sdk.api('status',{})
                break
            except urllib.error.URLError:time.sleep(.1)
        else:raise RuntimeError('candidate_start_timeout')
        if status.get('status')!='ok' or status.get('receipts'):
            raise RuntimeError('fresh_healthy_candidate_required')
        migrate_sdk.main()
        cutover.source_check();cutover.verify_migration();cutover.verify_archive(STORE)
        status=migrate_sdk.api('status',{})
        if status.get('status')!='ok' or status['receipts'].get('unknown'):
            raise RuntimeError('candidate_not_healthy_after_import')
        print(json.dumps({'candidate_import_verified':True,'pi_settings_changed':False}),flush=True)
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            if process.wait(timeout=120)!=0:raise RuntimeError('candidate_shutdown_failed')


if __name__=='__main__':main()
