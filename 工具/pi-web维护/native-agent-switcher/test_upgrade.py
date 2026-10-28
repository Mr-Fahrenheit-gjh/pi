import importlib.util
from pathlib import Path
import unittest
import tempfile
import json
import signal
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).with_name('upgrade_when_idle.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        config = patch.object(upgrade, 'CONFIG', {k: v for k, v in upgrade.CONFIG.items() if k != 'historyFixtureFile'})
        config.start()
        self.addCleanup(config.stop)

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
             patch.object(upgrade.core, 'command'), patch.object(upgrade.core, 'wait_stopped'):
            upgrade.stop_idle_service()
            self.assertIsNone(upgrade.RESTART_SESSION_ID)
            self.assertEqual(upgrade.blocking_sessions(['current']), ['current'])

    def test_stop_request_is_distinguished_from_confirmation_timeout(self):
        with patch.object(upgrade, 'RESTART_SESSION_ID', 'current'), \
             patch.object(upgrade, 'running_session_ids', return_value=['current']), \
             patch.object(upgrade, 'active_terminal_pids', return_value=[]), \
             patch.object(upgrade.core, 'command') as command, \
             patch.object(upgrade.core, 'wait_stopped', side_effect=RuntimeError('job still unloading')):
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
                     'sessionId': 'history', 'payloadFingerprint': {'bound': True}, 'managed': True}
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
