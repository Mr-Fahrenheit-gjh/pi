import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
import tempfile
import itertools
import json
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).with_name('deploy_when_idle.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeployTests(unittest.TestCase):
    def test_bootstrap_retries_transient_failure(self):
        with patch.object(deploy, 'launchd_loaded', return_value=False), \
             patch.object(deploy, 'command', side_effect=[SimpleNamespace(returncode=5, stderr='removal in progress'), SimpleNamespace(returncode=0)] ) as command, \
             patch.object(deploy.time, 'sleep'):
            deploy.start()
            self.assertEqual(command.call_count, 2)

    def test_loaded_service_is_started_without_duplicate_bootstrap(self):
        with patch.object(deploy, 'launchd_loaded', return_value=True), patch.object(deploy, 'command') as command:
            deploy.start()
            command.assert_called_once_with('/bin/launchctl', 'kickstart', deploy.SERVICE)

    def test_stop_waits_for_launchd_removal_after_port_is_released(self):
        with patch.object(deploy, 'command', return_value=SimpleNamespace(stdout='')) as command, \
             patch.object(deploy, 'launchd_loaded', side_effect=[True, True, False]) as loaded, \
             patch.object(deploy.time, 'sleep') as sleep:
            deploy.wait_stopped()
            self.assertEqual(loaded.call_count, 3)
            self.assertEqual(command.call_count, 3)
            self.assertEqual(sleep.call_count, 2)

    def test_stop_still_waits_for_listener_after_job_is_unloaded(self):
        with patch.object(deploy, 'command', side_effect=[SimpleNamespace(stdout='123\n'), SimpleNamespace(stdout='')]) as command, \
             patch.object(deploy, 'launchd_loaded', return_value=False), patch.object(deploy.time, 'sleep'):
            deploy.wait_stopped()
            self.assertEqual(command.call_count, 2)

    def test_stop_times_out_without_forcing_a_stuck_job_or_listener(self):
        for loaded, stdout in [(True, ''), (False, '123\n')]:
            clock = itertools.count(step=10)
            with self.subTest(loaded=loaded), \
                 patch.object(deploy, 'command', return_value=SimpleNamespace(stdout=stdout)) as command, \
                 patch.object(deploy, 'launchd_loaded', return_value=loaded), \
                 patch.object(deploy.time, 'monotonic', side_effect=lambda: next(clock)), \
                 patch.object(deploy.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, 'no forced kill'):
                    deploy.wait_stopped()
                self.assertTrue(all(call.args[0] == '/usr/sbin/lsof' for call in command.call_args_list))

    def test_stop_waits_for_bound_listener_and_parent_after_port_and_job_disappear(self):
        listener = '123 122 Fri Oct 23 16:22:43 2026 next-server'
        parent = '122 1 Fri Oct 23 16:22:43 2026 node pi-web'
        plan = {'listener': 123, 'listenerIdentity': listener, 'parent': 122, 'parentIdentity': parent}
        identities = {'123': iter([listener, '123 1 Fri Oct 23 16:22:43 2026 draining-server', None,
                                   '123 1 Fri Oct 23 16:23:00 2026 unrelated reused pid']),
                      '122': iter([parent, None])}
        def command(*args, **kwargs):
            if args[0] == '/usr/sbin/lsof':
                return SimpleNamespace(stdout='', returncode=1, stderr='')
            identity = next(identities[args[2]])
            return SimpleNamespace(stdout=identity or '', returncode=0 if identity else 1, stderr='')
        with patch.object(deploy, 'command', side_effect=command), \
             patch.object(deploy, 'launchd_loaded', return_value=False), patch.object(deploy.time, 'sleep') as sleep:
            deploy.wait_stopped(plan)
            self.assertEqual(sleep.call_count, 3)

    def test_unknown_process_state_is_not_treated_as_an_exited_process(self):
        for result in [SimpleNamespace(returncode=2, stdout='', stderr='error'),
                       SimpleNamespace(returncode=1, stdout='', stderr='not permitted'),
                       SimpleNamespace(returncode=0, stdout='', stderr=''),
                       SimpleNamespace(returncode=0, stdout='malformed', stderr='')]:
            with self.subTest(result=result), patch.object(deploy, 'command', return_value=result):
                with self.assertRaisesRegex(RuntimeError, 'process identity'):
                    deploy.bound_process_alive(123, 'original')

    def test_command_error_preserves_stderr(self):
        with patch.object(deploy.subprocess, 'run', return_value=SimpleNamespace(returncode=5, stderr='precise cause')):
            with self.assertRaisesRegex(RuntimeError, 'precise cause'):
                deploy.command('launchctl', 'bootstrap')

    def test_health_probe_records_success_without_headers(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(deploy, 'HERE', Path(directory)), \
             patch.object(deploy, 'api', return_value={'runningSessionIds': []}):
            deploy.healthy()
            probe = json.loads((Path(directory)/'health-probes.jsonl').read_text())
            self.assertTrue(probe['ok'])
            self.assertNotIn('headers', probe)

    def test_health_failure_preserves_precise_cause(self):
        clock = itertools.count()
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(deploy, 'HERE', Path(directory)), \
             patch.object(deploy, 'api', side_effect=RuntimeError('precise health cause')), \
             patch.object(deploy.time, 'monotonic', side_effect=lambda: next(clock)), \
             patch.object(deploy.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'precise health cause'):
                deploy.healthy(timeout=4)
            self.assertIn('precise health cause', (Path(directory)/'health-probes.jsonl').read_text())

    def test_ambiguous_listener_is_rejected(self):
        with patch.object(deploy, 'command', return_value=SimpleNamespace(stdout='1\n2\n')):
            with self.assertRaisesRegex(RuntimeError, 'exactly one'):
                deploy.listener()

    def test_process_identity_change_is_rejected(self):
        with patch.object(Path, 'read_text', return_value='old'), \
             patch.object(deploy, 'listener', return_value=1), \
             patch.object(deploy, 'identity', return_value='reused-pid'):
            with self.assertRaisesRegex(RuntimeError, 'process changed'):
                deploy.assert_baseline({'oldBuild': 'old', 'listener': 1, 'listenerIdentity': 'original-process'})


if __name__ == '__main__':
    unittest.main()
