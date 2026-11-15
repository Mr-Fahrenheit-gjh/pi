"""Restart-only memory activation; reuses existing Pi Web idle/PTY/deploy lock guard.
No package rebuild or Web payload change. Invoke only after explicit restart authorization.
"""
from pathlib import Path
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import time
import uuid
import cutover

ROOT=Path(__file__).resolve().parent
MAINTENANCE=ROOT.parent/'pi-web维护/native-agent-switcher'
STATE=ROOT/'data/activation-state.json'


def save(status,**fields):
    payload={'status':status,'at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),**fields}
    temporary=STATE.with_suffix('.pending');temporary.write_text(json.dumps(payload,ensure_ascii=False,indent=2));temporary.replace(STATE)
    print(json.dumps({'status':status}),flush=True)


def load_guard():
    spec=importlib.util.spec_from_file_location('hy_memory_web_guard',MAINTENANCE/'upgrade_when_idle.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def activate(session_id,wait_seconds=3600):
    if str(uuid.UUID(session_id))!=os.environ.get('PI_SESSION_ID'):
        raise RuntimeError('restart_waiver_must_match_authorized_current_session')
    guard=load_guard();core=guard.core
    guard.IDLE_WAIT_SECONDS=wait_seconds
    with guard.DEPLOY_LOCK.open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        cutover.source_check();cutover.verify_migration()
        build=(core.LIVE/'.next/BUILD_ID').read_text().strip()
        package_hash=hashlib.sha256((core.LIVE/'package.json').read_bytes()).hexdigest()
        from migrate_sdk import api
        if api('status',{}).get('status')!='ok':raise RuntimeError('engine_not_ready')
        core.preflight_launchd()
        guard.RESTART_SESSION_ID=session_id
        save('waiting_for_idle',authorized_session=session_id,build_id=build)
        guard.wait_idle(deadline=time.monotonic()+wait_seconds)
        stopped=False;switched=False
        try:
            # Reuses final running-session/PTY recheck and one-shot waiver consumption.
            guard.stop_with_idle_retry();stopped=True
            save('web_stopped_switching',build_id=build)
            cutover.switch();switched=True
            core.start();stopped=False
            core.healthy()
            if (core.LIVE/'.next/BUILD_ID').read_text().strip()!=build or hashlib.sha256((core.LIVE/'package.json').read_bytes()).hexdigest()!=package_hash:
                raise RuntimeError('web_payload_changed_during_memory_activation')
            # Actual installed settings + plugin loader, without a main-agent model call.
            subprocess.run(['/opt/homebrew/bin/node',str(ROOT/'pi_live_smoke.mjs')],check=True,timeout=180)
            save('verified_live',settings_switched=True,web_healthy=True,build_unchanged=True,build_id=build,main_agent_model_calls=0)
        except BaseException as error:
            # Do not overwrite a newer settings edit. The rollback helper enforces
            # quiescence + matching hash; failure is explicit, never fake recovery.
            if switched:
                try:
                    if not stopped:
                        guard.RESTART_SESSION_ID=None
                        guard.wait_idle(deadline=time.monotonic()+wait_seconds)
                        guard.stop_with_idle_retry();stopped=True
                    cutover.rollback();switched=False
                except BaseException:
                    save('recovery_blocked',error_type=type(error).__name__,settings_may_be_switched=switched)
                    if stopped:core.start()
                    raise
            # A stop guard may raise AFTER bootout but before returning. Starting
            # an already loaded service is harmless; never leave Web down on that path.
            core.start();core.healthy()
            save('failed_original_settings_preserved',error_type=type(error).__name__,settings_switched=switched)
            raise


if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('--authorized-session',required=True);parser.add_argument('--wait-seconds',type=int,default=3600)
    args=parser.parse_args();activate(args.authorized_session,args.wait_seconds)
