import importlib.util
from contextlib import contextmanager, nullcontext
from pathlib import Path
import unittest
import tempfile
import json
import os
import shutil
import signal
from types import SimpleNamespace
from unittest.mock import call, patch

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).with_name('upgrade_when_idle.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


@contextmanager
def meta_stage_fixture():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        candidate, stage, source = root/'candidate', root/'stage', root/'source'
        (source/'bin').mkdir(parents=True)
        (source/'bin/pi-meta-worker.cjs').write_text('worker')
        for package in [candidate, stage]:
            (package/'bin').mkdir(parents=True)
            (package/'bin/pi-meta-worker.cjs').write_text('worker')
            sdk = package/'node_modules/@earendil-works/pi-coding-agent'
            sdk.mkdir(parents=True)
            (sdk/'package.json').write_text(json.dumps({'name': '@earendil-works/pi-coding-agent', 'version': upgrade.META_SDK_VERSION}))
        original = candidate/'node_modules/.pi-meta-original'
        (original/'dist/bundle').mkdir(parents=True)
        (original/'package.json').write_text(json.dumps({'name': '@earendil-works/pi-coding-agent', 'version': upgrade.META_SDK_VERSION}))
        for name in ['dist/cli.js', 'dist/bundle/cli.js']:
            (original/name).write_text('verified fixture')
            (original/name).chmod(0o755)
        (original/'dist/cli.js.map').write_text('verified map')
        with patch.object(upgrade, 'CANDIDATE', candidate), patch.object(upgrade, 'SOURCE', source), \
             patch.object(upgrade, 'META_ORIGINAL_PACKAGE_SHA256', upgrade.bundle.digest(original/'package.json')), \
             patch.object(upgrade, 'META_ORIGINAL_DIST_SHA256', upgrade.bundle.tree_digest(original/'dist')):
            yield candidate, stage, original


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        config = patch.object(upgrade, 'CONFIG', {k: v for k, v in upgrade.CONFIG.items() if k != 'historyFixtureFile'})
        config.start()
        self.addCleanup(config.stop)
        api = patch.object(upgrade.core, 'api', side_effect=AssertionError('Unit tests must stub core.api; live services are forbidden'))
        api.start()
        self.addCleanup(api.stop)

    def test_normal_release_replays_verified_interrupt_only_into_offline_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source'; (source/'lib').mkdir(parents=True)
            (source/'lib/interrupt-steer.mjs').write_text('verified-engine')
            stage=Path(directory)/'offline-stage'
            with patch.object(upgrade, 'SOURCE', source), patch.object(upgrade.core, 'command') as command:
                inputs=upgrade.replay_candidate_adapters(stage)
                self.assertEqual(len(command.call_args_list), 3)
                first, apply, last=[call.args for call in command.call_args_list]
                self.assertIn(str(upgrade.CANDIDATE/'node_modules/@earendil-works/pi-coding-agent'), first)
                self.assertEqual(first[-1], '--check')
                self.assertIn(str(stage/'node_modules/@earendil-works/pi-coding-agent'), apply)
                self.assertEqual(apply[-2:], ('--apply', '--allow-external'))
                self.assertEqual(last[-1], '--check')
                self.assertTrue(all(str(upgrade.LIVE/'node_modules/@earendil-works/pi-coding-agent') not in call.args for call in command.call_args_list))
                self.assertIn(str(source/'lib/interrupt-steer.mjs'), inputs)

    def test_replay_refuses_inputs_changed_after_candidate_check(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source'; (source/'lib').mkdir(parents=True)
            engine=source/'lib/interrupt-steer.mjs';engine.write_text('verified-A')
            def command(*args, **kwargs):
                if str(upgrade.CANDIDATE/'node_modules/@earendil-works/pi-coding-agent') in args:
                    engine.write_text('unverified-B')
            with patch.object(upgrade, 'SOURCE', source), patch.object(upgrade.core, 'command', side_effect=command):
                with self.assertRaisesRegex(RuntimeError, 'inputs changed during replay'):
                    upgrade.replay_candidate_adapters(Path(directory)/'stage')

    def test_runtime_payload_refuses_adapter_or_clone_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            engine=Path(directory)/'engine'; engine.write_text('before')
            plan={'runtimeAdapterInputs':{str(engine):upgrade.bundle.digest(engine)}, 'staged':str(Path(directory)/'stage'), 'payloadFingerprint':{'bound':True}}
            with patch.object(upgrade, 'package_json', return_value={'dependencies':{}}), patch.object(upgrade.bundle, 'assert_fingerprint') as fingerprint, patch.object(upgrade.core, 'command') as command:
                upgrade.assert_runtime_payload(plan)
                fingerprint.assert_called_once_with(Path(plan['staged']), plan['payloadFingerprint'])
                self.assertEqual(command.call_args.args[-1], '--check')
                command.reset_mock(); engine.write_text('tampered')
                with self.assertRaisesRegex(RuntimeError, 'adapter inputs changed'):
                    upgrade.assert_runtime_payload(plan)
                command.assert_not_called()
            engine.write_text('before')
            with patch.object(upgrade, 'package_json', return_value={'dependencies':{}}), patch.object(upgrade.bundle, 'assert_fingerprint', side_effect=RuntimeError('Runtime payload changed')), patch.object(upgrade.core, 'command') as command:
                with self.assertRaisesRegex(RuntimeError, 'payload changed'):
                    upgrade.assert_runtime_payload(plan)
                command.assert_not_called()

    def test_meta_original_is_copied_to_stage_and_bound_until_switch(self):
        with meta_stage_fixture() as (candidate, stage, original):
            proof = upgrade.stage_meta_original(stage)
            staged = stage/'node_modules/.pi-meta-original'
            self.assertEqual(proof['metaOriginalDigest'], upgrade.bundle.tree_digest(original))
            self.assertEqual(proof['metaOriginalDigest'], upgrade.bundle.tree_digest(staged))
            self.assertFalse((original/'package.json').samefile(staged/'package.json'))
            plan = {'staged': str(stage), **proof}
            upgrade.assert_runtime_payload(plan)
            installed = stage.parent/'installed'
            shutil.copytree(stage, installed)
            upgrade.assert_meta_original_payload(plan, installed)
            (installed/'node_modules/.pi-meta-original/dist/cli.js').chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'not executable'):
                upgrade.assert_meta_original_payload(plan, installed)
            (stage/'bin/pi-meta-worker.cjs').write_text('tampered marker')
            with self.assertRaisesRegex(RuntimeError, 'runtime marker changed'):
                upgrade.assert_runtime_payload(plan)
            (stage/'bin/pi-meta-worker.cjs').write_text('worker')
            (staged/'dist/cli.js').write_text('tampered after staging')
            with self.assertRaisesRegex(RuntimeError, 'original SDK changed'):
                upgrade.assert_runtime_payload(plan)
            self.assertEqual((candidate/'node_modules/.pi-meta-original/dist/cli.js').read_text(), 'verified fixture')

    def test_meta_original_staging_refuses_missing_mutated_linked_or_mismatched_inputs(self):
        for case in ['missing', 'mutated', 'linked', 'hardlink', 'nested', 'existing', 'extra_root', 'extra_map', 'marker']:
            with self.subTest(case=case), meta_stage_fixture() as (candidate, stage, original):
                if case == 'missing':
                    shutil.rmtree(original)
                elif case == 'mutated':
                    (original/'dist/cli.js').write_text('unverified')
                elif case == 'linked':
                    other = original.with_name('other')
                    original.rename(other)
                    original.symlink_to(other, target_is_directory=True)
                elif case == 'hardlink':
                    os.link(original/'dist/cli.js', candidate/'shared-original-cli')
                elif case == 'nested':
                    nested = stage/'node_modules/@earendil-works/pi-coding-agent/node_modules/pkg'
                    nested.mkdir(parents=True)
                    (nested/'file').write_text('different dependency')
                elif case == 'extra_root':
                    (original/'unverified-dependency').mkdir()
                elif case == 'extra_map':
                    (original/'dist/unverified.js.map').write_text('unexpected source map')
                elif case == 'marker':
                    (stage/'bin/pi-meta-worker.cjs').write_text('unverified marker')
                else:
                    staged = stage/'node_modules/.pi-meta-original'
                    shutil.copytree(original, staged)
                    (staged/'dist/cli.js').write_text('different existing SDK')
                with self.assertRaises(RuntimeError):
                    upgrade.stage_meta_original(stage)

    def test_meta_original_requires_marker_and_prepared_digest(self):
        with meta_stage_fixture() as (candidate, stage, original):
            with self.assertRaisesRegex(RuntimeError, 'runtime marker changed'):
                upgrade.assert_runtime_payload({'staged': str(stage)})
            (candidate/'bin/pi-meta-worker.cjs').unlink()
            (stage/'bin/pi-meta-worker.cjs').unlink()
            self.assertTrue((upgrade.SOURCE/'bin/pi-meta-worker.cjs').is_file())
            with self.assertRaisesRegex(RuntimeError, 'without its runtime marker'):
                upgrade.stage_meta_original(stage)
            shutil.rmtree(original)
            self.assertIsNone(upgrade.stage_meta_original(stage))
            upgrade.assert_runtime_payload({'staged': str(stage)})

    def test_meta_marker_changed_during_copy_is_rejected(self):
        with meta_stage_fixture() as (_, stage, _):
            command = upgrade.core.command
            def copy_then_change_marker(*args, **kwargs):
                result = command(*args, **kwargs)
                (stage/'bin/pi-meta-worker.cjs').write_text('changed while staging')
                return result
            with patch.object(upgrade.core, 'command', side_effect=copy_then_change_marker):
                with self.assertRaisesRegex(RuntimeError, 'marker changed during staging'):
                    upgrade.stage_meta_original(stage)

    def test_installed_meta_check_failure_restores_previous_package_before_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live, stage, backup = root/'live', root/'stage', root/'backup'
            for package, build in [(live, 'old'), (stage, 'new')]:
                (package/'.next').mkdir(parents=True)
                (package/'.next/BUILD_ID').write_text(build)
                (package/'package.json').write_text(json.dumps({'version': upgrade.VERSION}))
            plan = {'buildId': 'new', 'oldBuild': 'old', 'staged': str(stage),
                    'backup': str(backup), 'sessionId': 'fixture'}
            plan_file, state_file = root/'plan.json', root/'state.json'
            plan_file.write_text(json.dumps(plan))
            state_file.write_text(json.dumps({'status': 'prepared', **plan}))
            starts = []
            with patch.multiple(upgrade, LIVE=live, PLAN=plan_file, STATE=state_file), \
                 patch.object(upgrade, 'assert_history_fixture'), patch.object(upgrade, 'assert_runtime_payload'), \
                 patch.object(upgrade, 'assert_meta_original_payload', side_effect=RuntimeError('installed Meta invalid')), \
                 patch.object(upgrade, 'wait_idle'), patch.object(upgrade, 'stop_with_idle_retry'), \
                 patch.object(upgrade.core, 'preflight_launchd'), patch.object(upgrade.core, 'assert_baseline'), \
                 patch.object(upgrade.core, 'launchd_loaded', return_value=False), patch.object(upgrade.core, 'wait_stopped'), \
                 patch.object(upgrade.core, 'start', side_effect=lambda: starts.append((live/'.next/BUILD_ID').read_text())), \
                 patch.object(upgrade.core, 'healthy'), patch.object(upgrade.deck, 'assert_prepared'), \
                 patch.object(upgrade.deck, 'activate'), patch.object(upgrade.deck, 'restore'):
                with self.assertRaisesRegex(RuntimeError, 'installed Meta invalid'):
                    upgrade.apply()
            self.assertEqual(starts, ['old'])
            self.assertEqual((live/'.next/BUILD_ID').read_text(), 'old')
            self.assertEqual((backup/'withdrawn-package/.next/BUILD_ID').read_text(), 'new')
            self.assertEqual(json.loads(state_file.read_text())['status'], 'rolled_back')

    def test_feynman_work_blocks_stop_even_with_current_pi_authorization(self):
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade.core, 'api', return_value={'runningSessionIds': ['current'], 'otherRuntimeRunningSessionIds': ['feynman:current']}), \
             patch.object(upgrade.core, 'command') as command:
            with self.assertRaises(upgrade.ServiceBusy):
                upgrade.stop_idle_service()
            command.assert_not_called()

    def test_runtime_snapshot_is_backward_compatible_and_fails_closed(self):
        for snapshot, expected in [({'runningSessionIds': ['pi']}, ['pi']),
                                   ({'runningSessionIds': ['pi'], 'otherRuntimeRunningSessionIds': ['feynman:f', 'feynman:f']}, ['pi', 'feynman:f'])]:
            with patch.object(upgrade.core, 'api', return_value=snapshot):
                self.assertEqual(upgrade.running_session_ids(), expected)
        for other in [None, 'feynman:f', [None], [1]]:
            with patch.object(upgrade.core, 'api', return_value={'runningSessionIds': [], 'otherRuntimeRunningSessionIds': other}):
                with self.assertRaises(RuntimeError):
                    upgrade.running_session_ids()

    def test_meta_deployment_commits_then_disconnects_before_the_guarded_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory)/'live'
            (live/'bin').mkdir(parents=True)
            (live/'bin/pi-meta-worker.cjs').write_text('fixture')
            (live/'node_modules/.pi-meta-original').mkdir(parents=True)
            state = {'held': False, 'closed': False, 'committed': False, 'events': []}
            lease_id = '11111111-1111-4111-8111-111111111111'
            class Response:
                def readline(self, limit):
                    self_limit = limit
                    if self_limit != 4096:
                        raise AssertionError('unexpected response limit')
                    return json.dumps({'ok': True, 'leaseId': lease_id}).encode()+b'\n'
                def close(self):
                    if state['closed']: return
                    state['closed'] = True
                    state['events'].append('disconnect')
                    if not state['committed']: state['held'] = False
            def open_lease(request, timeout):
                self.assertEqual(request.get_method(), 'POST')
                self.assertEqual(json.loads(request.data), {'confirmed': True})
                self.assertEqual(timeout, 15)
                state['held'] = True
                return Response()
            def api(path):
                if path.startswith('/api/service/meta-deployment?'):
                    state['events'].append('verify')
                    return {'owns': state['held']}
                return {'runningSessionIds': [], 'otherRuntimeRunningSessionIds': ['service:restarting'] if state['held'] else [], 'piMetaDeploymentLease': 1}
            def commit(_id, action):
                self.assertEqual(action, 'commit')
                self.assertFalse(state['closed'], 'The uncommitted lease must retain its transport')
                state['committed'] = True
                state['events'].append(action)
            def command(*args):
                self.assertTrue(state['held'])
                self.assertTrue(state['committed'])
                self.assertTrue(state['closed'], 'The updater must not keep its own HTTP stream open during shutdown')
                state['events'].append('stop')
            with patch.object(upgrade, 'LIVE', live), patch.object(upgrade.core, 'api', side_effect=api), \
                 patch.object(upgrade, 'active_terminal_pids', return_value=[]), \
                 patch.object(upgrade.urllib.request, 'build_opener', return_value=SimpleNamespace(open=open_lease)), \
                 patch.object(upgrade, 'meta_lease_action', side_effect=commit), \
                 patch.object(upgrade.core, 'command', side_effect=command), patch.object(upgrade.core, 'wait_stopped'):
                upgrade.stop_idle_service()
            self.assertEqual(state['events'], ['verify', 'verify', 'commit', 'disconnect', 'stop'])
            self.assertTrue(state['closed'])
            self.assertTrue(state['held'], 'Committed admission remains closed despite transport disconnect')

    def test_meta_lease_races_and_lost_leases_never_stop_work(self):
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory)/'live'
            (live/'bin').mkdir(parents=True)
            (live/'bin/pi-meta-worker.cjs').write_text('fixture')
            (live/'node_modules/.pi-meta-original').mkdir(parents=True)
            lease_id = '11111111-1111-4111-8111-111111111111'
            class Response:
                closed = False
                def readline(self, _limit): return json.dumps({'ok': True, 'leaseId': lease_id}).encode()+b'\n'
                def close(self): self.closed = True
            for mode in ['late-work', 'lost-lease', 'missing-capability', 'meta-busy']:
                with self.subTest(mode=mode):
                    response = Response()
                    held = {'value': False}
                    def open_lease(request, timeout):
                        if mode == 'meta-busy':
                            raise upgrade.urllib.error.HTTPError(request.full_url, 409, 'busy', None, None)
                        held['value'] = True
                        return response
                    def api(path):
                        if path.startswith('/api/service/meta-deployment?'):
                            return {'owns': mode != 'lost-lease' and held['value']}
                        other = ['service:restarting', 'meta:session'] if held['value'] and mode == 'late-work' else []
                        snapshot = {'runningSessionIds': [], 'otherRuntimeRunningSessionIds': other}
                        if mode != 'missing-capability': snapshot['piMetaDeploymentLease'] = 1
                        return snapshot
                    with patch.object(upgrade, 'LIVE', live), patch.object(upgrade.core, 'api', side_effect=api), \
                         patch.object(upgrade, 'active_terminal_pids', return_value=[]), \
                         patch.object(upgrade.urllib.request, 'build_opener', return_value=SimpleNamespace(open=open_lease)), \
                         patch.object(upgrade.core, 'command') as command:
                        with self.assertRaises(RuntimeError): upgrade.stop_idle_service()
                        command.assert_not_called()
                        if held['value']: self.assertTrue(response.closed)

    def test_meta_legacy_original_still_uses_a_deployment_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory)/'live'
            (live/'bin').mkdir(parents=True)
            (live/'bin/pi-meta-worker.cjs').write_text('fixture')
            lease_id = '11111111-1111-4111-8111-111111111111'
            class Response:
                closed = False
                def readline(self, _limit): return json.dumps({'ok': True, 'leaseId': lease_id}).encode()+b'\n'
                def close(self): self.closed = True
            response = Response()
            snapshot = {'runningSessionIds': [], 'piMetaDeploymentLease': 1}
            with patch.object(upgrade, 'LIVE', live), patch.object(upgrade.core, 'api', return_value=snapshot), \
                 patch.object(upgrade.urllib.request, 'build_opener', return_value=SimpleNamespace(open=lambda _req, timeout: response)):
                with upgrade.meta_deployment_lease() as actual:
                    self.assertEqual(actual.id, lease_id)
            self.assertTrue(response.closed)

    def test_meta_commit_disconnect_and_uncertain_stop_keep_admission_safe(self):
        lease_id = '11111111-1111-4111-8111-111111111111'
        @contextmanager
        def lease():
            yield SimpleNamespace(id=lease_id, close_transport=lambda: None)
        for mode in ['disconnect-before-commit', 'unknown-stop', 'wait-failure', 'spawn-failure']:
            with self.subTest(mode=mode), \
                 patch.object(upgrade, 'meta_deployment_lease', side_effect=lease), \
                 patch.object(upgrade, 'running_session_ids', side_effect=[[], ['service:restarting']]), \
                 patch.object(upgrade, 'active_terminal_pids', return_value=[]), \
                 patch.object(upgrade, 'assert_meta_lease_owned'), \
                 patch.object(upgrade, 'meta_lease_action', side_effect=RuntimeError('disconnected') if mode == 'disconnect-before-commit' else None) as action, \
                 patch.object(upgrade, 'cancel_unsubmitted_meta_lease') as cancel, \
                 patch.object(upgrade.core, 'command', side_effect=RuntimeError('unknown') if mode == 'unknown-stop' else FileNotFoundError('spawn') if mode == 'spawn-failure' else None) as command, \
                 patch.object(upgrade.core, 'wait_stopped', side_effect=RuntimeError('not stopped') if mode == 'wait-failure' else None):
                with self.assertRaises(RuntimeError if mode != 'spawn-failure' else FileNotFoundError):
                    upgrade.stop_idle_service()
                action.assert_called_once_with(lease_id, 'commit')
                if mode in ['disconnect-before-commit', 'spawn-failure']:
                    cancel.assert_called_once_with(lease_id)
                else:
                    cancel.assert_not_called()
                if mode == 'disconnect-before-commit': command.assert_not_called()

    def test_owner_refresh_accepts_only_an_unused_matching_backup_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory)/'backup'
            plan = {'backup': str(backup), 'buildId': 'new', 'oldBuild': 'old', 'staged': '/stage'}
            self.assertIsNone(upgrade.unused_pre_switch_backup(plan))
            backup.mkdir()
            (backup/'manifest.json').write_text(json.dumps(plan))
            self.assertEqual(upgrade.unused_pre_switch_backup(plan), backup)
            (backup/'package').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'package data'):
                upgrade.unused_pre_switch_backup(plan)

    def test_owner_refresh_rejects_mismatched_backup_or_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            backup = Path(directory)/'backup'; backup.mkdir()
            plan = {'backup': str(backup), 'buildId': 'new', 'oldBuild': 'old', 'staged': '/stage'}
            manifest = backup/'manifest.json'
            manifest.write_text(json.dumps({**plan, 'buildId': 'different'}))
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                upgrade.unused_pre_switch_backup(plan)
            manifest.unlink(); (Path(directory)/'other.json').write_text(json.dumps(plan))
            manifest.symlink_to(Path(directory)/'other.json')
            with self.assertRaisesRegex(RuntimeError, 'unknown files'):
                upgrade.unused_pre_switch_backup(plan)

    def test_recovered_cli_stop_rechecks_identity_and_signals_only_bound_parent(self):
        plan = {'managed': False, 'parent': 123, 'staged': '/unused-stage'}
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade, 'running_session_ids', return_value=['current']), \
             patch.object(upgrade, 'active_terminal_pids', return_value=[]), \
             patch.object(upgrade.core, 'assert_baseline') as baseline, \
             patch.object(upgrade.core, 'command') as command, \
             patch.object(upgrade, 'meta_deployment_lease', return_value=nullcontext(None)), \
             patch.object(upgrade.os, 'kill') as kill, patch.object(upgrade.core, 'wait_stopped') as wait:
            upgrade.stop_with_idle_retry(plan)
            baseline.assert_called_once_with(plan)
            kill.assert_called_once_with(123, signal.SIGTERM)
            command.assert_not_called()
            wait.assert_called_once_with(plan)
            self.assertIsNone(upgrade.RESTART_SESSION_ID)

    def test_recovered_cli_stop_refuses_changed_owner_other_work_and_terminals(self):
        for running, terminals, identity_error in [(['other'], [], None), ([], [234], None), ([], [], RuntimeError('owner changed'))]:
            with self.subTest(running=running, terminals=terminals), \
                 patch.object(upgrade, 'running_session_ids', return_value=running), \
                 patch.object(upgrade, 'active_terminal_pids', return_value=terminals), \
                 patch.object(upgrade.core, 'assert_baseline', side_effect=identity_error), \
                 patch.object(upgrade.os, 'kill') as kill, patch.object(upgrade.core, 'command') as command:
                with self.assertRaises(RuntimeError):
                    upgrade.stop_idle_service({'managed': False, 'parent': 123})
                kill.assert_not_called()
                command.assert_not_called()

    def test_restart_authorization_exempts_only_the_exact_session(self):
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'):
            self.assertEqual(upgrade.blocking_sessions(['current']), [])
            self.assertEqual(upgrade.blocking_sessions(['current', 'other']), ['other'])
            with self.assertRaises(RuntimeError):
                upgrade.blocking_sessions(['current', None])

    def test_authorized_restart_still_protects_other_tasks_and_terminals(self):
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade.core, 'api', return_value={'runningSessionIds': ['current', 'other']}), \
             patch.object(upgrade.core, 'command') as command:
            with self.assertRaises(upgrade.ServiceBusy):
                upgrade.stop_idle_service()
            command.assert_not_called()
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade.core, 'api', return_value={'runningSessionIds': ['current']}), \
             patch.object(upgrade, 'active_terminal_pids', return_value=[123]), \
             patch.object(upgrade.core, 'command') as command:
            with self.assertRaises(upgrade.ServiceBusy):
                upgrade.stop_idle_service()
            command.assert_not_called()

    def test_restart_waiver_is_consumed_before_live_verification_or_rollback(self):
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade.core, 'api', return_value={'runningSessionIds': ['current']}), \
             patch.object(upgrade, 'active_terminal_pids', return_value=[]), \
             patch.object(upgrade.core, 'command'), patch.object(upgrade.core, 'wait_stopped'), \
             patch.object(upgrade, 'meta_deployment_lease', return_value=nullcontext(None)):
            upgrade.stop_idle_service()
            self.assertIsNone(upgrade.RESTART_SESSION_ID)
            self.assertEqual(upgrade.blocking_sessions(['current']), ['current'])

    def test_stop_request_is_distinguished_from_confirmation_timeout(self):
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade, 'running_session_ids', return_value=['current']), \
             patch.object(upgrade, 'active_terminal_pids', return_value=[]), \
             patch.object(upgrade.core, 'command') as command, \
             patch.object(upgrade.core, 'wait_stopped', side_effect=RuntimeError('job still unloading')), \
             patch.object(upgrade, 'meta_deployment_lease', return_value=nullcontext(None)):
            with self.assertRaisesRegex(upgrade.ServiceStopIncomplete, 'job still unloading'):
                upgrade.stop_idle_service()
            command.assert_called_once_with('/bin/launchctl', 'bootout', upgrade.core.SERVICE)
            self.assertIsNone(upgrade.RESTART_SESSION_ID)

    def test_authorized_restart_does_not_wait_for_its_own_conversation(self):
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade.core, 'api', return_value={'runningSessionIds': ['current']}) as api, \
             patch.object(upgrade, 'active_terminal_pids', return_value=[]), patch.object(upgrade.time, 'sleep') as sleep:
            upgrade.wait_idle()
            self.assertEqual(api.call_count, 1)
            sleep.assert_not_called()

    def test_ui_polish_requires_all_real_acceptance_flags(self):
        valid = {key: True for key in upgrade.UI_POLISH_FLAGS}
        upgrade.assert_ui_polish_evidence({'uiPolish': True}, valid)
        for key in upgrade.UI_POLISH_FLAGS:
            for value in [False, None, 'true']:
                with self.assertRaisesRegex(RuntimeError, 'sidebar/browser/wheel/recovery'):
                    upgrade.assert_ui_polish_evidence({'uiPolish': True}, {**valid, key: value})

    def test_legacy_plan_does_not_acquire_unrequested_ui_requirements(self):
        upgrade.assert_ui_polish_evidence({}, {})

    def test_unfinished_plan_cannot_be_silently_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)/'state.json'
            with patch.object(upgrade, 'STATE', state):
                for status in ['prepared', 'waiting_for_idle', 'switching', 'verifying_live', 'recovery_failed']:
                    state.write_text(json.dumps({'status': status}))
                    with self.assertRaisesRegex(RuntimeError, 'unfinished deployment'):
                        upgrade.assert_no_pending_plan()
                for status in ['deployed', 'rolled_back', 'failed']:
                    state.write_text(json.dumps({'status': status}))
                    upgrade.assert_no_pending_plan()

    def test_live_evidence_rejects_false_pass_stale_identity_and_mocks(self):
        valid = {'passed': True, 'buildId': 'build', 'version': '0.12.0', 'sessionId': 'parent', 'mocked': False,
                 'realChildVerified': True, 'retainedRuns': 1, 'quietToolsCollapsed': True,
                 'switcherVisible': True, 'taskManagementHidden': True,
                 'base': upgrade.core.BASE, 'packageRoot': str(upgrade.core.LIVE)}
        with tempfile.TemporaryDirectory() as directory, patch.object(upgrade.core, 'HERE', Path(directory)):
            evidence = Path(directory)/'live-result.json'
            plan = {'buildId': 'build', 'sessionId': 'parent'}
            evidence.write_text(json.dumps(valid))
            upgrade.core.assert_live_evidence(plan, '0.12.0')
            for key, value in [('realChildVerified', False), ('retainedRuns', 0), ('retainedRuns', True), ('mocked', True),
                               ('buildId', 'old'), ('version', '0.11.0'), ('sessionId', 'other'), ('taskManagementHidden', False),
                               ('base', 'http://127.0.0.1:9999'), ('packageRoot', '/tmp/candidate')]:
                evidence.write_text(json.dumps({**valid, key: value}))
                with self.assertRaises(RuntimeError, msg=key):
                    upgrade.core.assert_live_evidence(plan, '0.12.0')

    def test_never_stops_a_prompt_that_started_after_the_idle_gate(self):
        with patch.object(upgrade.core, 'api', return_value={'runningSessionIds': ['active']}), \
             patch.object(upgrade.core, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'refusing to stop active work'):
                upgrade.stop_idle_service()
            command.assert_not_called()

    def test_new_prompt_after_idle_retries_without_failing_or_forcing_stop(self):
        plan = {'staged': '/unused-stage'}
        with patch.object(upgrade, 'stop_idle_service', side_effect=[upgrade.ServiceBusy('busy'), upgrade.ServiceBusy('busy'), None]) as stop, \
             patch.object(upgrade, 'wait_idle') as wait, \
             patch.object(upgrade.core, 'assert_baseline') as baseline:
            upgrade.stop_with_idle_retry(plan)
            self.assertEqual(stop.call_count, 3)
            self.assertEqual(wait.call_count, 2)
            self.assertEqual(baseline.call_count, 2)
            self.assertEqual(wait.call_args_list[0].kwargs['deadline'], wait.call_args_list[1].kwargs['deadline'])

    def test_unknown_state_is_not_treated_as_a_busy_retry(self):
        with patch.object(upgrade.core, 'api', return_value={}), \
             patch.object(upgrade.core, 'command') as command, patch.object(upgrade, 'wait_idle') as wait:
            with self.assertRaisesRegex(RuntimeError, 'unknown'):
                upgrade.stop_with_idle_retry()
            command.assert_not_called()
            wait.assert_not_called()

    def test_sdk_drift_during_busy_retry_still_prevents_stop(self):
        plan = {'staged': '/stage', 'dependencyMode': upgrade.bundle.MODE, 'payloadFingerprint': {}}
        with patch.object(upgrade, 'stop_idle_service', side_effect=upgrade.ServiceBusy('busy')) as stop, \
             patch.object(upgrade, 'wait_idle'), patch.object(upgrade.core, 'assert_baseline'), \
             patch.object(upgrade, 'package_json', side_effect=[{'dependencies': {'sdk': 'new'}}, {'dependencies': {'sdk': 'old'}}]):
            with self.assertRaisesRegex(RuntimeError, 'unchanged Ghostty'):
                upgrade.stop_with_idle_retry(plan)
            self.assertEqual(stop.call_count, 1)

    def test_open_terminal_prevents_stop_even_without_web_prompts(self):
        with patch.object(upgrade.core, 'api', return_value={'runningSessionIds': []}), \
             patch.object(upgrade, 'active_terminal_pids', return_value=[123]), \
             patch.object(upgrade.core, 'command') as command:
            with self.assertRaises(upgrade.ServiceBusy):
                upgrade.stop_idle_service()
            command.assert_not_called()

    def test_terminal_detection_uses_controlling_tty_not_program_name(self):
        from types import SimpleNamespace
        with patch.object(upgrade.core, 'listener', return_value=100), \
             patch.object(upgrade.core, 'command', return_value=SimpleNamespace(stdout='100 1 ??\n200 100 ttys009\n201 100 ??\n202 9 ttys001\n')):
            self.assertEqual(upgrade.active_terminal_pids(), [200])

    def test_terminal_detection_ignores_only_listener_inherited_tty(self):
        snapshot = '100 1 ttys000\n200 100 ttys000\n201 100 ??\n202 9 ttys009\n'
        with patch.object(upgrade.core, 'listener', return_value=100), \
             patch.object(upgrade.core, 'command', return_value=SimpleNamespace(stdout=snapshot)):
            self.assertEqual(upgrade.active_terminal_pids(), [])
        with patch.object(upgrade.core, 'listener', return_value=100), \
             patch.object(upgrade.core, 'command', return_value=SimpleNamespace(stdout=snapshot+'203 100 ttys007\n')):
            self.assertEqual(upgrade.active_terminal_pids(), [203])

    def test_terminal_detection_rejects_unknown_process_snapshot(self):
        for snapshot in ['', '200 100 ttys009\n', '100 1\n', '100 1 ??\ninvalid 100 ??\n',
                         '100 1 ??\n200 invalid ??\n', '100 1 ??\n100 1 ttys000\n']:
            with self.subTest(snapshot=snapshot), \
                 patch.object(upgrade.core, 'listener', return_value=100), \
                 patch.object(upgrade.core, 'command', return_value=SimpleNamespace(stdout=snapshot)):
                with self.assertRaisesRegex(RuntimeError, 'Cannot determine live terminal state'):
                    upgrade.active_terminal_pids()

    def test_terminal_closure_is_required_for_idle_gate(self):
        with patch.object(upgrade.core, 'api', return_value={'runningSessionIds': []}), \
             patch.object(upgrade, 'active_terminal_pids', side_effect=[[123], [], [], [], [], []]) as terminals, \
             patch.object(upgrade.time, 'sleep'):
            upgrade.wait_idle()
            self.assertEqual(terminals.call_count, 6)

    def test_malformed_running_state_fails_closed(self):
        with patch.object(upgrade.core, 'api', return_value={}), \
             patch.object(upgrade.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'Malformed'):
                upgrade.wait_idle()

    def test_idle_gate_resets_when_another_session_runs(self):
        snapshots = [[], [], ['other'], [], [], [], [], []]
        with patch.object(upgrade.core, 'api', side_effect=[{'runningSessionIds': ids} for ids in snapshots]) as api, \
             patch.object(upgrade.time, 'sleep'), patch.object(upgrade, 'active_terminal_pids', return_value=[]):
            upgrade.wait_idle()
            self.assertEqual(api.call_count, 8)


class PreSwitchRecoveryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stage, self.live, self.backup = [self.root/name for name in ['stage', 'live', 'backup']]
        for root, build in [(self.stage, 'new'), (self.live, 'old')]:
            (root/'.next').mkdir(parents=True)
            (root/'.next/BUILD_ID').write_text(build)
        self.plan = {'buildId': 'new', 'oldBuild': 'old', 'staged': str(self.stage), 'backup': str(self.backup),
                     'sessionId': 'history', 'payloadFingerprint': {'bound': True}, 'managed': True,
                     'listener': 10, 'listenerIdentity': 'identity-10', 'parent': 11, 'parentIdentity': 'identity-11'}
        self.backup.mkdir()
        (self.backup/'manifest.json').write_text(json.dumps(self.plan))
        (self.root/'plan.json').write_text(json.dumps(self.plan))
        (self.root/'state.json').write_text(json.dumps({'status': 'recovery_failed', **self.plan}))
        for name, value in [('HERE', self.root), ('PLAN', self.root/'plan.json'), ('STATE', self.root/'state.json'), ('LIVE', self.live)]:
            self.patch(upgrade, name, value)
        self.patch(upgrade.core, 'listener', return_value=101)
        self.patch(upgrade.core, 'identity', side_effect=lambda pid: 'identity-'+str(pid))
        self.patch(upgrade.core, 'command', side_effect=self.command)
        self.loaded = self.patch(upgrade.core, 'launchd_loaded', return_value=False)
        self.patch(upgrade.core, 'preflight_launchd')
        self.runtime = self.patch(upgrade, 'assert_runtime_payload')
        self.history = self.patch(upgrade, 'assert_history_fixture')
        self.deck = self.patch(upgrade.deck, 'assert_prepared')
        self.fingerprint = self.patch(upgrade.bundle, 'assert_fingerprint')
        self.cli_command = 'node /opt/homebrew/bin/pi-web --no-open --port 30141'

    def patch(self, target, name, *args, **kwargs):
        patcher = patch.object(target, name, *args, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def command(self, *args, **kwargs):
        return SimpleNamespace(stdout='100\n' if args[-1] == 'ppid=' else self.cli_command+'\n', returncode=0, stderr='')

    def test_rebinds_verified_pre_switch_failure_and_preserves_original_records(self):
        upgrade.refresh_owner('new', 'authorized release recovery')
        plan = json.loads((self.root/'plan.json').read_text())
        state = json.loads((self.root/'state.json').read_text())
        self.assertEqual(state['status'], 'prepared')
        self.assertEqual((plan['listener'], plan['parent'], plan['managed']), (101, 100, False))
        self.assertFalse(self.backup.exists())
        archive = Path(state['ownerRefreshArchive'])
        self.assertEqual(json.loads((archive/'state.json').read_text())['status'], 'recovery_failed')
        self.assertEqual(json.loads((archive/'unused-backup-initialization/manifest.json').read_text()), self.plan)
        self.runtime.assert_called_once_with(plan)
        self.history.assert_called_once_with(plan)
        self.deck.assert_called_once_with(None, self.stage)
        self.fingerprint.assert_called_once_with(self.stage, self.plan['payloadFingerprint'])

    def test_failed_lease_can_refresh_only_after_explicit_managed_restoration(self):
        plan = {**self.plan, 'managed': False}
        (self.root/'plan.json').write_text(json.dumps(plan))
        (self.root/'state.json').write_text(json.dumps({'status': 'failed', 'error': 'Could not acquire Pi Meta deployment lease', **plan}))
        self.loaded.return_value = True
        upgrade.refresh_owner('new', 'operator authorized maintenance restored managed service')
        self.assertTrue(json.loads((self.root/'plan.json').read_text())['managed'])
        self.assertEqual(json.loads((self.root/'state.json').read_text())['status'], 'prepared')

    def test_failed_lease_recovery_never_authorizes_an_unmanaged_stop(self):
        for error, originally_managed in [('Could not acquire Pi Meta deployment lease', False),
                                          ('unrelated failure', False),
                                          ('Could not acquire Pi Meta deployment lease', True)]:
            plan = {**self.plan, 'managed': originally_managed}
            (self.root/'plan.json').write_text(json.dumps(plan))
            (self.root/'state.json').write_text(json.dumps({'status': 'failed', 'error': error, **plan}))
            self.loaded.return_value = error != 'Could not acquire Pi Meta deployment lease' or originally_managed
            with self.subTest(error=error, managed=originally_managed):
                with self.assertRaises(RuntimeError):
                    upgrade.refresh_owner('new', 'recover')
            self.assertTrue(self.backup.exists())

    def test_interrupted_stop_rebinds_only_after_both_old_processes_exit(self):
        (self.root/'state.json').write_text(json.dumps({'status': 'waiting_for_idle', **self.plan}))
        with patch.object(upgrade.core, 'bound_process_alive', return_value=False) as alive:
            upgrade.refresh_owner('new', 'recover interrupted service stop')
        self.assertEqual(alive.call_args_list, [call(10, 'identity-10'), call(11, 'identity-11')])
        state = json.loads((self.root/'state.json').read_text())
        self.assertEqual(state['status'], 'prepared')
        self.assertFalse(state['managed'])
        archive = Path(state['ownerRefreshArchive'])
        self.assertEqual(json.loads((archive/'state.json').read_text())['status'], 'waiting_for_idle')
        self.assertEqual(json.loads((archive/'unused-backup-initialization/manifest.json').read_text()), self.plan)

    def test_interrupted_stop_refuses_live_or_unknown_old_processes(self):
        (self.root/'state.json').write_text(json.dumps({'status': 'waiting_for_idle', **self.plan}))
        for replies in [[True], [False, True], RuntimeError('identity unavailable')]:
            with self.subTest(replies=replies), patch.object(upgrade.core, 'bound_process_alive', side_effect=replies):
                with self.assertRaises(RuntimeError):
                    upgrade.refresh_owner('new', 'recover interrupted stop')
            self.assertTrue(self.backup.exists())
            self.assertEqual(json.loads((self.root/'plan.json').read_text()), self.plan)

    def test_waiting_without_initialization_cannot_adopt_unmanaged_owner(self):
        (self.root/'state.json').write_text(json.dumps({'status': 'waiting_for_idle', **self.plan}))
        (self.backup/'manifest.json').unlink(); self.backup.rmdir()
        with self.assertRaisesRegex(RuntimeError, 'unknown service owner'):
            upgrade.refresh_owner('new', 'refresh paused plan')

    def test_interrupted_stop_requires_original_managed_owner_and_payload_binding(self):
        for change in [{'managed': False}, {'payloadFingerprint': None}]:
            plan = {**self.plan, **change}
            (self.root/'plan.json').write_text(json.dumps(plan))
            (self.root/'state.json').write_text(json.dumps({'status': 'waiting_for_idle', **plan}))
            with self.subTest(change=change), patch.object(upgrade.core, 'bound_process_alive', return_value=False):
                with self.assertRaises(RuntimeError):
                    upgrade.refresh_owner('new', 'recover interrupted stop')
            self.assertTrue(self.backup.exists())

    def test_recovery_requires_unused_manifest_and_never_touches_package_backup(self):
        (self.backup/'package').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'package data'):
            upgrade.refresh_owner('new', 'recover')
        (self.backup/'package').rmdir()
        (self.backup/'manifest.json').unlink()
        self.backup.rmdir()
        with self.assertRaisesRegex(RuntimeError, 'backup initialization'):
            upgrade.refresh_owner('new', 'recover')

    def test_recovery_refuses_changed_live_stage_and_payload(self):
        for path in [self.live/'.next/BUILD_ID', self.stage/'.next/BUILD_ID']:
            original = path.read_text()
            path.write_text('changed')
            with self.assertRaises(RuntimeError):
                upgrade.refresh_owner('new', 'recover')
            path.write_text(original)
        self.fingerprint.side_effect = RuntimeError('payload changed')
        with self.assertRaisesRegex(RuntimeError, 'payload changed'):
            upgrade.refresh_owner('new', 'recover')
        self.assertTrue(self.backup.exists())

    def test_recovery_refuses_unknown_cli_owner(self):
        self.cli_command = 'node /tmp/another-server --port 30141'
        with self.assertRaisesRegex(RuntimeError, 'unknown service owner'):
            upgrade.refresh_owner('new', 'recover')
        self.assertTrue(self.backup.exists())

    def test_recovery_refuses_mismatched_state_and_plan(self):
        (self.root/'state.json').write_text(json.dumps({'status': 'recovery_failed', **self.plan, 'oldBuild': 'different'}))
        with self.assertRaisesRegex(RuntimeError, 'state does not match'):
            upgrade.refresh_owner('new', 'recover')

    def test_paused_normal_plan_cannot_adopt_an_unmanaged_owner(self):
        (self.root/'state.json').write_text(json.dumps({'status': 'prepared', **self.plan}))
        with self.assertRaisesRegex(RuntimeError, 'unknown service owner'):
            upgrade.refresh_owner('new', 'refresh')

    def test_started_or_deployed_states_cannot_be_refreshed(self):
        for status in ['switching', 'verifying_live', 'deployed', 'rollback_waiting_for_idle']:
            (self.root/'state.json').write_text(json.dumps({'status': status, **self.plan}))
            with self.assertRaisesRegex(RuntimeError, 'pre-switch'):
                upgrade.refresh_owner('new', 'recover')


if __name__ == '__main__':
    unittest.main()
