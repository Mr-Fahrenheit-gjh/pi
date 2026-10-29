from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

history = load('history_flow_test', 'history_fixture.py')
flow = load('candidate_flow_test', 'flow.py')
preflight = flow.precheck
upgrade = load('upgrade_flow_test', 'upgrade_when_idle.py')

PARENT = '11111111-1111-4111-8111-111111111111'
RUN = '22222222-2222-4222-8222-222222222222'


def history_fixture(root, state='done', role='assistant'):
    parent = root / (PARENT + '.jsonl')
    entries = [{'type': 'session', 'id': PARENT}, {'type': 'custom', 'id': 'state', 'parentId': None,
               'customType': 'pi-durable-task', 'data': {'version': 1, 'sessionId': PARENT, 'status': state,
               'ownerPid': os.getpid(), 'admitted': True, 'tools': [], 'spent': 0}}]
    parent.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
    child = parent.with_suffix('') / 'run' / 'session.jsonl'
    child.parent.mkdir(parents=True)
    child.write_text(json.dumps({'type': 'message', 'message': {'role': role, 'content': [{'type': 'text', 'text': 'REAL_REVIEW_RESULT'}]}}) + '\n')
    runs = root / 'runs'; directory = runs / RUN; directory.mkdir(parents=True)
    status = {'runId': RUN, 'state': 'complete', 'sessionId': str(parent), 'sessionFile': str(child),
              'steps': [{'sessionFile': str(child), 'status': 'complete'}]}
    (directory / 'status.json').write_text(json.dumps(status))
    (directory / 'output-0.log').write_text('real existing output\n')
    return {'sessionId': PARENT, 'runId': RUN, 'expectedText': 'REAL_REVIEW_RESULT'}, runs, parent, child


class HistoryFlowTests(unittest.TestCase):
    def test_retention_and_restore_keep_original_bytes_and_parent_ownership(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); fixture, runs, _, _ = history_fixture(root)
            before = (runs / RUN / 'status.json').read_bytes()
            archive = root / 'archive'
            self.assertTrue(history.inspect(fixture, runs)['passed'])
            self.assertFalse(history.retain(fixture, archive, runs)['reused'])
            self.assertTrue(history.retain(fixture, archive, runs)['reused'])
            shutil.rmtree(runs / RUN)
            self.assertTrue(history.restore(fixture, archive, runs)['restored'])
            self.assertEqual((runs / RUN / 'status.json').read_bytes(), before)
            self.assertFalse(history.restore(fixture, archive, runs)['restored'])

    def test_pending_parent_is_rejected_even_when_original_owner_is_alive(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture, runs, _, _ = history_fixture(Path(temp), state='pending')
            with self.assertRaisesRegex(RuntimeError, 'not settled'):
                history.inspect(fixture, runs)
            # Offline retention is a backup, never permission to bind this parent.
            archive = Path(temp) / 'archive'
            history.retain(fixture, archive, runs)
            shutil.rmtree(runs / RUN)
            with self.assertRaisesRegex(RuntimeError, 'not settled'):
                history.restore(fixture, archive, runs)
            self.assertFalse((runs / RUN).exists())

    def test_active_branch_does_not_confuse_an_abandoned_pending_branch(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture, runs, parent, _ = history_fixture(Path(temp))
            with parent.open('a') as file:
                file.write(json.dumps({'type': 'custom', 'id': 'abandoned', 'parentId': 'state', 'customType': 'pi-durable-task', 'data': {'status': 'pending'}}) + '\n')
                file.write(json.dumps({'type': 'message', 'id': 'active', 'parentId': 'state', 'message': {'role': 'assistant'}}) + '\n')
            self.assertTrue(history.inspect(fixture, runs)['passed'])

    def test_symlink_missing_child_foreign_parent_and_user_text_fail(self):
        for fault in ['status_link', 'run_link', 'missing_child', 'foreign_parent', 'user_text']:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); fixture, runs, parent, child = history_fixture(root, role='user' if fault == 'user_text' else 'assistant')
                status = runs / RUN / 'status.json'
                if fault == 'status_link':
                    copy = root / 'copy'; copy.write_bytes(status.read_bytes()); status.unlink(); status.symlink_to(copy)
                elif fault == 'run_link':
                    other = root / 'elsewhere'; shutil.move(str(runs / RUN), other); (runs / RUN).symlink_to(other)
                elif fault == 'missing_child':
                    child.unlink()
                elif fault == 'foreign_parent':
                    parent.write_text(json.dumps({'type': 'session', 'id': RUN}) + '\n')
                with self.assertRaises((OSError, RuntimeError)):
                    history.inspect(fixture, runs)

    def test_archive_tampering_or_existing_runtime_change_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); fixture, runs, _, _ = history_fixture(root); archive = root / 'archive'
            history.retain(fixture, archive, runs)
            status = runs / RUN / 'status.json'; status.write_text('{"state":"running"}')
            before = status.read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'refusing overwrite'):
                history.restore(fixture, archive, runs)
            self.assertEqual(status.read_bytes(), before)
            shutil.rmtree(runs / RUN)
            (archive / RUN / 'output-0.log').write_text('forged')
            with self.assertRaisesRegex(RuntimeError, 'modified'):
                history.restore(fixture, archive, runs)
            self.assertFalse((runs / RUN).exists())


class CandidateFlowTests(unittest.TestCase):
    def test_recorded_deployed_is_not_a_validation_shortcut_or_preflight_bypass(self):
        with patch.object(flow.precheck, 'preflight', return_value={'passed': False, 'recordedDeployed': True}) as checks, patch.object(flow, 'validate') as run:
            self.assertEqual(flow.main(['--validate']), 1)
            checks.assert_called_once_with(phase='candidate', dependency_mode=None)
            run.assert_not_called()
        ready = {'passed': True, 'recordedDeployed': True, 'phase': 'candidate', 'candidateDirectory': '/fixture'}
        result = {'status': 'candidate_built', 'coverage': 'full', 'elapsedSeconds': 0, 'remaining': ['real acceptance']}
        with patch.object(flow.precheck, 'preflight', return_value=ready) as checks, patch.object(flow, 'validate', return_value=result) as run, patch.object(flow, 'module') as storage_module:
            self.assertEqual(flow.main(['--validate']), 0)
            checks.assert_called_once_with(phase='candidate', dependency_mode=None)
            run.assert_called_once_with(ready, 'runtime', [], 2, False)
            storage_module.return_value.maintain.assert_called_once_with(enforce_limits=True)
            storage_module.return_value.preflight_space.assert_called_once_with('/fixture')

    def test_default_cli_only_runs_source_preflight(self):
        with patch.object(flow.precheck, 'preflight', return_value={'passed': True, 'phase': 'source'}) as checks, patch.object(flow, 'validate') as run:
            self.assertEqual(flow.main([]), 0)
            checks.assert_called_once_with(phase='source', dependency_mode=None)
            run.assert_not_called()

    def test_cli_term_uses_the_same_cleanup_exception_and_masks_repeat_interrupts(self):
        with patch.object(flow.signal, 'signal') as register:
            with self.assertRaises(KeyboardInterrupt):
                flow.interrupt_cli(flow.signal.SIGTERM, None)
            self.assertTrue(all(call.args[1] == flow.signal.SIG_IGN for call in register.call_args_list))

    def test_profiles_keep_upgrades_full_and_test_paths_bounded(self):
        self.assertEqual(flow.commands('upgrade', [])['test'], ['npm', 'test'])
        self.assertIn('lib/example.test.mjs', flow.commands('ui', ['lib/example.test.mjs'])['test'])
        for profile, files in [('upgrade', ['lib/a.test.mjs']), ('ui', ['../elsewhere.test.mjs']), ('ui', ['/tmp/a.test.mjs'])]:
            with self.assertRaises(RuntimeError):
                flow.commands(profile, files)

    def test_stage_cache_requires_success_and_same_actual_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / '.next').mkdir(); (root / '.next/BUILD_ID').write_text('build')
            output = root / '.next/chunk'; output.write_text('original')
            stage = {'status': 'passed', 'exitCode': 0, 'processGroupExited': True, 'key': 'key', 'buildId': 'build', 'outputDigest': flow.bundle.tree_digest(root / '.next')}
            self.assertTrue(flow.reusable(stage, 'key', root))
            self.assertFalse(flow.reusable({**stage, 'status': 'running'}, 'key', root))
            self.assertFalse(flow.reusable({**stage, 'exitCode': 1}, 'key', root))
            self.assertFalse(flow.reusable(stage, 'new-input', root))
            output.write_text('different bytes')
            self.assertFalse(flow.reusable(stage, 'key', root))

    def test_failed_or_interrupted_process_is_not_reused_and_live_stage_blocks(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = flow.Validator(Path(temp), dict(os.environ), {})
            with self.assertRaises(RuntimeError):
                runner.run('test', [sys.executable, '-c', 'raise SystemExit(4)'], 'same-key')
            self.assertEqual(runner.state['stages']['test']['status'], 'failed')
            runner.run('test', [sys.executable, '-c', 'print("passed")'], 'same-key')
            self.assertEqual(runner.state['stages']['test']['status'], 'passed')
            with self.assertRaisesRegex(RuntimeError, 'no trusted'):
                flow.ensure_no_live_stage({'test': {'status': 'running', 'pid': os.getpid()}})
            with self.assertRaisesRegex(RuntimeError, 'no trusted'):
                flow.ensure_no_live_stage({'test': {'status': 'running'}})

    def test_pid_reuse_is_not_mistaken_for_the_previous_validation_process(self):
        stage = {'status': 'running', 'pid': os.getpid(), 'processGroup': os.getpgid(os.getpid()), 'pidIdentity': 'old process identity'}
        with patch.object(flow, 'process_identity', return_value='different start time and command'):
            flow.ensure_no_live_stage({'test': stage})
        with patch.object(flow, 'process_identity', return_value='old process identity'):
            with self.assertRaisesRegex(RuntimeError, 'still be alive'):
                flow.ensure_no_live_stage({'test': stage})

    def test_dead_leader_with_surviving_group_blocks_resume(self):
        stage = {'status': 'running', 'pid': 912345, 'processGroup': 912345, 'pidIdentity': 'known identity'}
        with patch.object(flow.os, 'kill', side_effect=ProcessLookupError), patch.object(flow, 'process_group_alive', return_value=True):
            with self.assertRaisesRegex(RuntimeError, 'still has descendants'):
                flow.ensure_no_live_stage({'build': stage})
        with patch.object(flow.os, 'kill', side_effect=ProcessLookupError), patch.object(flow, 'process_group_alive', return_value=False):
            flow.ensure_no_live_stage({'build': stage})

    def test_build_input_drift_after_successful_exit_cannot_create_passed_cache(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / '.next').mkdir(); (root / '.next/BUILD_ID').write_text('build')
            runner = flow.Validator(root, dict(os.environ), {})
            with patch.object(flow, 'identity', return_value={'nonOutput': 'changed'}):
                with self.assertRaisesRegex(RuntimeError, 'changed during build'):
                    runner.run('build', [sys.executable, '-c', 'print("build exited zero")'], 'old-key', output=True, expected_input='original')
            stage = runner.state['stages']['build']
            self.assertEqual(stage['exitCode'], 0)
            self.assertEqual(stage['status'], 'failed')
            self.assertFalse(flow.reusable(stage, 'old-key', root))

    def test_cancellation_cannot_start_queued_stages_after_process_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = flow.Validator(Path(temp), dict(os.environ), {})
            started = threading.Event(); processes = []; real_popen = subprocess.Popen
            def tracked(*args, **kwargs):
                process = real_popen(*args, **kwargs); processes.append(process); started.set(); return process
            pool = ThreadPoolExecutor(max_workers=1)
            futures = []
            try:
                with patch.object(flow.subprocess, 'Popen', side_effect=tracked), patch.object(flow, 'process_identity', return_value='known identity'):
                    futures = [pool.submit(runner.run, name, argv) for name, argv in [
                        ('first', [sys.executable, '-c', 'import time; time.sleep(30)']),
                        ('second', [sys.executable, '-c', 'print("must not start")']),
                        ('third', [sys.executable, '-c', 'print("must not start")'])]]
                    self.assertTrue(started.wait(timeout=5))
                    runner.cancel()
                    for future in futures:
                        future.cancel()
                    runner.close()
                    pool.shutdown(wait=True, cancel_futures=True)
                    for future in futures:
                        try:
                            future.result(timeout=5)
                        except Exception:
                            pass
                self.assertEqual(len(processes), 1)
                self.assertFalse(flow.process_group_alive(processes[0].pid))
                self.assertNotEqual(runner.state['stages']['first']['status'], 'passed')
            finally:
                runner.close(); pool.shutdown(wait=True, cancel_futures=True)

    def test_cleanup_signals_the_group_after_leader_exit_and_escalates_for_survivors(self):
        for already_exited in [True, False]:
            with self.subTest(already_exited=already_exited):
                state = {'leaderExited': already_exited, 'groupAlive': True}
                process = Mock(pid=912345)
                process.poll.side_effect = lambda: 0 if state['leaderExited'] else None
                signals = []
                def send(group, signum):
                    signals.append((group, signum))
                    if signum == flow.signal.SIGTERM:
                        state['leaderExited'] = True  # Other workers ignore TERM.
                    elif signum == flow.signal.SIGKILL:
                        state['groupAlive'] = False
                with patch.object(flow, 'process_group_alive', side_effect=lambda group: state['groupAlive']), \
                     patch.object(flow, 'process_identity', return_value=None), patch.object(flow.os, 'kill', side_effect=ProcessLookupError), patch.object(flow.os, 'killpg', side_effect=send):
                    flow.Validator.terminate(process, 'known identity', grace=0, kill_grace=0)
                self.assertEqual(signals, [(912345, flow.signal.SIGTERM), (912345, flow.signal.SIGKILL)])
                self.assertFalse(state['groupAlive'])

    def test_cleanup_does_not_signal_a_reused_unrelated_process_group(self):
        process = Mock(pid=912345); process.poll.return_value = 0
        with patch.object(flow, 'process_group_alive', return_value=True), patch.object(flow, 'process_identity', return_value='new process'), patch.object(flow.os, 'kill', return_value=None), patch.object(flow.os, 'getpgid', return_value=912345), patch.object(flow.os, 'killpg') as send:
            flow.Validator.terminate(process, 'old process', grace=0, kill_grace=0)
            send.assert_not_called()

    def test_cleanup_refuses_existing_pid_when_identity_query_is_unknown(self):
        process = Mock(pid=912345); process.poll.return_value = 0
        with patch.object(flow, 'process_group_alive', return_value=True), patch.object(flow, 'process_identity', return_value=None), patch.object(flow.os, 'kill', return_value=None), patch.object(flow.os, 'killpg') as send:
            with self.assertRaisesRegex(flow.GroupCleanupError, 'identity is unknown'):
                flow.Validator.terminate(process, 'old process', grace=0, kill_grace=0)
            send.assert_not_called()

    def test_cleanup_failure_is_explicit_after_bounded_term_and_kill(self):
        process = Mock(pid=912345); process.poll.return_value = 0
        with patch.object(flow, 'process_group_alive', return_value=True), patch.object(flow, 'process_identity', return_value=None), patch.object(flow.os, 'kill', side_effect=ProcessLookupError), patch.object(flow.os, 'killpg') as send:
            with self.assertRaisesRegex(flow.GroupCleanupError, 'did not exit after TERM/KILL'):
                flow.Validator.terminate(process, 'known identity', grace=0, kill_grace=0)
            self.assertEqual([call.args[1] for call in send.call_args_list], [flow.signal.SIGTERM, flow.signal.SIGKILL])

    def test_cleanup_failure_preserves_pid_group_and_marks_the_durable_record(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = flow.Validator(Path(temp), dict(os.environ), {})
            runner.state['stages']['test'] = {'status': 'running', 'pid': 912345, 'processGroup': 912345, 'pidIdentity': 'known identity'}
            runner.processes['test'] = Mock(pid=912345)
            with patch.object(flow.Validator, 'terminate', side_effect=flow.GroupCleanupError('fixture cleanup failed')):
                with self.assertRaisesRegex(flow.GroupCleanupError, 'could not be cleaned'):
                    runner.close()
            saved = json.loads(runner.path.read_text())['stages']['test']
            self.assertTrue(saved['cleanupFailed']); self.assertEqual(saved['processGroup'], 912345)
            self.assertEqual(saved['pidIdentity'], 'known identity')

    def test_successful_stage_reuses_its_prior_result_without_another_process(self):
        with tempfile.TemporaryDirectory() as temp:
            runner = flow.Validator(Path(temp), dict(os.environ), {})
            argv = [sys.executable, '-c', 'print("real check")']
            runner.run('test', argv, 'key')
            with patch.object(flow.subprocess, 'Popen', side_effect=AssertionError('must not spawn')):
                runner.run('test', argv, 'key')
            self.assertTrue(runner.state['stages']['test']['reused'])

    def test_input_hash_distinguishes_tests_from_runtime_and_hashes_dependency_bytes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'node_modules').mkdir(); (root / 'node_modules/binary').write_text('a')
            (root / 'app').mkdir(); (root / 'app/code.ts').write_text('runtime')
            (root / 'app/code.test.mjs').write_text('test')
            with patch.object(flow.subprocess, 'check_output', return_value='v25.1.0'):
                first = flow.identity(root, {'BUILD_FLAG': 'a'})
                (root / 'README.md').write_text('documentation only')
                documented = flow.identity(root, {'BUILD_FLAG': 'a'})
                self.assertEqual(first['build'], documented['build'])
                self.assertNotEqual(first['checks'], documented['checks'])
                (root / 'app/code.test.mjs').write_text('new test')
                second = flow.identity(root, {'BUILD_FLAG': 'a'})
                self.assertNotEqual(first['checks'], second['checks']); self.assertEqual(first['build'], second['build'])
                (root / 'node_modules/binary').write_text('b')
                third = flow.identity(root, {'BUILD_FLAG': 'a'})
                self.assertNotEqual(second['build'], third['build'])
                self.assertNotEqual(third, flow.identity(root, {'BUILD_FLAG': 'b'}))

    def test_public_test_and_markdown_assets_invalidate_build_cache(self):
        for name in ['client.test.js', 'help.md']:
            with self.subTest(asset=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp); (root / 'node_modules').mkdir(); (root / 'public').mkdir()
                (root / 'package.json').write_text(json.dumps({'scripts': {'build': 'next build --webpack'}}))
                asset = root / 'public' / name; asset.write_text('original published bytes')
                with patch.object(flow.subprocess, 'check_output', return_value='v25.1.0'):
                    first = flow.identity(root, {})
                    asset.write_text('changed published bytes')
                    second = flow.identity(root, {})
                self.assertNotEqual(first['checks'], second['checks'])
                self.assertNotEqual(first['build'], second['build'])

    def test_cache_tracks_the_sdk_recovery_engine_outside_node_modules(self):
        with tempfile.TemporaryDirectory() as temp:
            outer = Path(temp); root = outer / 'candidate'; root.mkdir(); (root / 'node_modules').mkdir()
            engine = outer / 'engine.mjs'; engine.write_text('original external runtime')
            with patch.object(flow, 'RECOVERY_ENGINE', engine), patch.object(flow.subprocess, 'check_output', return_value='v25.1.0'):
                first = flow.identity(root, {})
                engine.write_text('changed external runtime')
                second = flow.identity(root, {})
            self.assertNotEqual(first['checks'], second['checks'])
            self.assertNotEqual(first['build'], second['build'])

    def test_interrupt_adapter_and_both_engine_copies_invalidate_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            outer = Path(temp); root = outer / 'candidate'; root.mkdir()
            (root / 'lib').mkdir(); (root / 'node_modules').mkdir()
            adapter = outer / 'install.mjs'; adapter.write_text('adapter v1')
            source_engine = root / 'lib/interrupt-steer.mjs'; source_engine.write_text('engine v1')
            vendored_engine = root / 'node_modules/pi-interrupt-engine.mjs'; vendored_engine.write_text('engine v1')
            with patch.object(flow, 'INTERRUPT_ADAPTER', adapter), patch.object(flow.subprocess, 'check_output', return_value='v25.1.0'):
                previous = flow.identity(root, {})
                for file in [adapter, source_engine, vendored_engine]:
                    file.write_text('changed actual bytes')
                    current = flow.identity(root, {})
                    self.assertNotEqual(previous['checks'], current['checks'])
                    self.assertNotEqual(previous['build'], current['build'])
                    previous = current

    def test_tests_imported_by_runtime_or_custom_build_do_invalidate_build(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'node_modules').mkdir()
            (root / 'app').mkdir(); code = root / 'app/code.ts'; test_file = root / 'app/code.test.mjs'
            code.write_text('import "./code.test.mjs";'); test_file.write_text('one')
            with patch.object(flow.subprocess, 'check_output', return_value='v25.1.0'):
                first = flow.identity(root, {})
                test_file.write_text('two')
                self.assertNotEqual(first['build'], flow.identity(root, {})['build'])
                code.write_text('runtime only')
                (root / 'package.json').write_text(json.dumps({'scripts': {'build': 'node e2e/custom-build.mjs'}}))
                first = flow.identity(root, {})
                test_file.write_text('three')
                self.assertNotEqual(first['build'], flow.identity(root, {})['build'])

    @unittest.skipUnless(shutil.which('node') and shutil.which('npm'), 'Existing Node/npm required')
    def test_real_fixture_pipeline_runs_once_then_reuses_success_without_app_build(self):
        with tempfile.TemporaryDirectory() as temp:
            outer = Path(temp); root = outer / 'candidate'; root.mkdir(); counters = outer / 'counters'; counters.mkdir()
            package = {'name': 'maintenance-fixture', 'version': '0.0.0', 'scripts': {
                'test': 'node check.cjs test', 'lint': 'node check.cjs lint', 'build': 'node build.cjs'}}
            (root / 'package.json').write_text(json.dumps(package))
            prefix = 'const fs=require("node:fs"),path=require("node:path");const out=path.join(process.env.FLOW_COUNTER_DIR,"events");'
            (root / 'check.cjs').write_text(prefix + 'fs.appendFileSync(out,process.argv[2]+"\\n");')
            (root / 'build.cjs').write_text(prefix + 'if(process.env.PI_WEB_PRECHECKED_TYPES!=="1")throw Error("missing successful typecheck");fs.appendFileSync(out,"build\\n");fs.mkdirSync(".next",{recursive:true});fs.writeFileSync(".next/BUILD_ID","fixture");fs.writeFileSync(".next/output.js","stable fixture output");')
            tsc = root / 'node_modules/typescript/bin/tsc'; tsc.parent.mkdir(parents=True)
            tsc.write_text(prefix + 'if(!fs.existsSync(".next/types/current.d.ts"))throw Error("types not generated");fs.appendFileSync(out,"typecheck\\n");')
            typegen = root / 'node_modules/next/dist/bin/next'; typegen.parent.mkdir(parents=True)
            typegen.write_text('const fs=require("node:fs");fs.mkdirSync(".next/types",{recursive:true});fs.writeFileSync(".next/types/current.d.ts","export {};\\n");')
            report = {'passed': True, 'phase': 'candidate', 'candidateDirectory': str(root)}
            with patch.dict(os.environ, {'FLOW_COUNTER_DIR': str(counters), 'npm_config_cache': str(outer / 'npm-cache'), 'npm_config_update_notifier': 'false'}):
                self.assertEqual(flow.validate(report)['status'], 'candidate_built')
                first = (counters / 'events').read_text().splitlines()
                self.assertCountEqual(first, ['typecheck', 'test', 'lint', 'build'])
                second = flow.validate(report)
                self.assertEqual((counters / 'events').read_text().splitlines(), first)
                self.assertTrue(all(second['stages'][name]['reused'] for name in ['typecheck', 'test', 'lint', 'build']))

    def test_checks_are_parallel_and_build_type_skip_requires_all_success(self):
        for failure in [False, True]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                report = {'passed': True, 'phase': 'candidate', 'candidateDirectory': temp}
                barrier = threading.Barrier(2); calls = []; guard = threading.Lock()
                def fake_run(self, name, argv, key=None, extra_env=None, **kwargs):
                    if name in ['typecheck', 'test']:
                        barrier.wait(timeout=5)
                    with guard:
                        calls.append((name, extra_env))
                    if failure and name == 'typecheck':
                        raise RuntimeError('type failure')
                with patch.object(flow.Validator, 'run', fake_run), patch.object(flow, 'identity', return_value={'checks': 'c', 'build': 'b', 'nonOutput': 'n'}):
                    if failure:
                        with self.assertRaisesRegex(RuntimeError, 'type failure'):
                            flow.validate(report)
                        self.assertNotIn('build', [name for name, _ in calls])
                    else:
                        result = flow.validate(report)
                        self.assertEqual(result['status'], 'candidate_built')
                        self.assertIn(('build', {'PI_WEB_PRECHECKED_TYPES': '1'}), calls)

    def test_input_changes_during_checks_block_build(self):
        with tempfile.TemporaryDirectory() as temp:
            report = {'passed': True, 'phase': 'candidate', 'candidateDirectory': temp}
            with patch.object(flow.Validator, 'run') as run, patch.object(flow, 'identity', side_effect=[{'checks': 'a', 'build': 'a', 'nonOutput': 'a'}, {'checks': 'b', 'build': 'b', 'nonOutput': 'b'}]):
                with self.assertRaisesRegex(RuntimeError, 'changed during checks'):
                    flow.validate(report)
                self.assertNotIn('build', [call.args[0] for call in run.call_args_list])


class PreflightTests(unittest.TestCase):
    def test_generated_meta_development_cache_is_not_source_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'app').mkdir()
            (root/'app/page.tsx').write_text('source')
            (root/'.next-pi-meta').mkdir()
            (root/'.next-pi-meta/generated.js').write_text('generated')
            self.assertEqual(set(preflight.runtime_files(root)), {'app/page.tsx'})

    def fixture(self, root):
        here = root / '工具/pi-web维护/native-agent-switcher'; here.mkdir(parents=True)
        source = here.parent / 'source'; source.mkdir(); candidate = root / 'candidate'; candidate.mkdir()
        live = root / 'live'; live.mkdir()
        deps = {'@earendil-works/pi-coding-agent': '1.3.0', 'ghostty-web': '0.4.0'}
        package = {'version': '0.12.1', 'dependencies': deps}
        lock = {'packages': {'': {'dependencies': deps}, **{'node_modules/' + name: {'version': version} for name, version in deps.items()}}}
        manifest = {'schemaVersion': 1, 'supportedSdkVersions': ['1.3.0'],
                    'dependencyOverrides': {'ghostty-web': '0.4.0'}, 'requiredSourceMarkers': {'ui.tsx': ['LOCAL_UI']},
                    'forbiddenSourceMarkers': {'ui.tsx': ['REMOVED_UI']}}
        for directory in [source, candidate, live]:
            (directory / 'package.json').write_text(json.dumps(package))
        for directory in [source, candidate]:
            (directory / 'package-lock.json').write_text(json.dumps(lock))
            (directory / 'local-customizations.json').write_text(json.dumps(manifest))
            (directory / 'ui.tsx').write_text('LOCAL_UI')
        for name, version in deps.items():
            path = candidate / 'node_modules' / name; path.mkdir(parents=True)
            (path / 'package.json').write_text(json.dumps({'version': version}))
        for filename in ['typescript/bin/tsc', 'eslint/bin/eslint.js', 'next/dist/bin/next']:
            path = candidate / 'node_modules' / filename; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('fixture')
        (here / 'local-update.json').write_text(json.dumps({'sourceDirectory': '../source', 'candidateDirectory': str(candidate), 'targetVersion': '0.12.1'}))
        return here, source, candidate, live

    def test_source_preflight_is_read_only_and_catches_contract_before_any_command(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); here, source, _, live = self.fixture(root)
            before = {str(path): path.read_bytes() for path in root.rglob('*') if path.is_file()}
            with patch.object(preflight.subprocess, 'run', side_effect=AssertionError('must not execute')):
                report = preflight.preflight(here, live, require_history=False)
            self.assertTrue(report['passed'])
            self.assertEqual(before, {str(path): path.read_bytes() for path in root.rglob('*') if path.is_file()})
            (source / 'ui.tsx').write_text('LOCAL_UI REMOVED_UI')
            with patch.object(preflight.subprocess, 'run', side_effect=AssertionError('must not execute')):
                report = preflight.preflight(here, live, require_history=False)
            self.assertFalse(report['passed'])
            self.assertTrue(any(check['name'] == 'local_customizations' and not check['passed'] for check in report['checks']))

    def test_source_history_missing_blocks_early_without_model_or_service(self):
        with tempfile.TemporaryDirectory() as temp:
            here, _, _, live = self.fixture(Path(temp))
            with patch.object(preflight.subprocess, 'run', side_effect=AssertionError('must not execute')):
                report = preflight.preflight(here, live)
            self.assertFalse(report['passed'])
            self.assertTrue(any(check['name'] == 'history_fixture_identity' and not check['passed'] for check in report['checks']))

    def test_candidate_input_drift_and_missing_tools_are_distinct_blockers(self):
        with tempfile.TemporaryDirectory() as temp:
            here, _, candidate, live = self.fixture(Path(temp))
            with patch.object(preflight.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                self.assertTrue(preflight.preflight(here, live, 'candidate', require_history=False)['passed'])
                (candidate / 'ui.tsx').write_text('different candidate')
                (candidate / 'node_modules/typescript/bin/tsc').unlink()
                report = preflight.preflight(here, live, 'candidate', require_history=False)
            failed = {check['name'] for check in report['checks'] if not check['passed']}
            self.assertIn('candidate_inputs', failed); self.assertIn('development_tools', failed)

    def test_candidate_public_assets_are_runtime_inputs_but_root_readme_is_not(self):
        for name in ['client.test.js', 'help.md']:
            with self.subTest(asset=name), tempfile.TemporaryDirectory() as temp:
                here, source, candidate, live = self.fixture(Path(temp))
                for directory in [source, candidate]:
                    (directory / 'public').mkdir()
                    (directory / 'public' / name).write_text('same published bytes')
                (source / 'README.md').write_text('source documentation')
                (candidate / 'README.md').write_text('different documentation')
                with patch.object(preflight.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
                    self.assertTrue(preflight.preflight(here, live, 'candidate', require_history=False)['passed'])
                    (candidate / 'public' / name).write_text('different published bytes')
                    report = preflight.preflight(here, live, 'candidate', require_history=False)
                self.assertFalse(report['passed'])
                self.assertTrue(any(check['name'] == 'candidate_inputs' and not check['passed'] for check in report['checks']))

    def test_candidate_common_blockers_skip_candidate_checks_before_any_command(self):
        faults = {'source_contract': 'local_customizations', 'missing_history': 'history_fixture_identity',
                  'active_deployment': 'no_active_deployment', 'dependency_delta': 'approved_dependency_delta',
                  'target_version': 'target_version'}
        for fault, failed_check in faults.items():
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temp:
                here, source, _, live = self.fixture(Path(temp))
                if fault == 'source_contract':
                    (source / 'ui.tsx').write_text('LOCAL_UI REMOVED_UI')
                elif fault == 'active_deployment':
                    (here / 'upgrade-0.12-state.json').write_text(json.dumps({'status': 'switching'}))
                elif fault == 'dependency_delta':
                    package = json.loads((live / 'package.json').read_text())
                    package['dependencies']['ghostty-web'] = '0.3.0'
                    (live / 'package.json').write_text(json.dumps(package))
                elif fault == 'target_version':
                    config = json.loads((here / 'local-update.json').read_text())
                    config['targetVersion'] = 'not-the-source-version'
                    (here / 'local-update.json').write_text(json.dumps(config))
                with patch.object(preflight.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')) as command:
                    report = preflight.preflight(here, live, 'candidate', require_history=fault == 'missing_history')
                self.assertFalse(report['passed'])
                self.assertEqual(report['nextAction'], 'resolve_preflight_blockers_before_build')
                self.assertTrue(any(check['name'] == failed_check and not check['passed'] for check in report['checks']))
                command.assert_not_called()
                self.assertFalse(any(check['name'].startswith('candidate_') for check in report['checks']))

    def test_unfinished_release_blocks_a_new_flow_before_build(self):
        with tempfile.TemporaryDirectory() as temp:
            here, _, _, live = self.fixture(Path(temp))
            (here / 'upgrade-0.12-state.json').write_text(json.dumps({'status': 'switching'}))
            report = preflight.preflight(here, live, require_history=False)
            self.assertFalse(report['passed'])
            self.assertEqual(report['nextAction'], 'resolve_preflight_blockers_before_build')
            self.assertTrue(any(check['name'] == 'no_active_deployment' and not check['passed'] for check in report['checks']))

    def test_dependency_changes_require_a_named_exact_migration(self):
        with tempfile.TemporaryDirectory() as temp:
            here, source, _, live = self.fixture(Path(temp))
            package = json.loads((live / 'package.json').read_text()); package['dependencies']['ghostty-web'] = '0.3.0'
            (live / 'package.json').write_text(json.dumps(package))
            report = preflight.preflight(here, live, require_history=False)
            self.assertFalse(report['passed'])
            self.assertTrue(any(check['name'] == 'approved_dependency_delta' and not check['passed'] for check in report['checks']))


class TimingAndFingerprintTests(unittest.TestCase):
    def test_asset_append_reuses_only_unchanged_subtrees_and_cannot_bless_tampering(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ['node_modules', '.next', 'public', 'bin']:
                (root / name).mkdir(); (root / name / 'data').write_text(name)
            for name in ['package.json', 'package-lock.json', 'next.config.ts']:
                (root / name).write_text(name)
            verified = flow.bundle.fingerprint(root)
            (root / '.next/old-chunk').write_text('retained')
            with patch.object(flow.bundle, 'tree_digest', wraps=flow.bundle.tree_digest) as scan:
                expected = flow.bundle.fingerprint_after_retaining_assets(root, verified)
                self.assertEqual([call.args[0].name for call in scan.call_args_list], ['.next', 'public'])
            self.assertEqual(expected, flow.bundle.fingerprint(root))
            (root / 'node_modules/data').write_text('tampered')
            expected = flow.bundle.fingerprint_after_retaining_assets(root, verified)
            with self.assertRaisesRegex(RuntimeError, 'changed since verification'):
                flow.bundle.assert_fingerprint(root, expected)

    def test_timing_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(upgrade, 'HERE', Path(temp)), patch.object(upgrade, 'TIMING_ENABLED', True):
            outside = Path(temp) / 'unrelated'; outside.write_text('original')
            (Path(temp) / 'release-timings.jsonl').symlink_to(outside)
            with upgrade.timed('fixture_stage'):
                pass
            self.assertEqual(outside.read_text(), 'original')

    def test_timing_records_failures_without_changing_error_or_exposing_arguments(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(upgrade, 'HERE', Path(temp)), patch.object(upgrade, 'TIMING_ENABLED', True):
            with self.assertRaisesRegex(ValueError, 'private argument'):
                with upgrade.timed('fixture_stage'):
                    raise ValueError('private argument')
            data = (Path(temp) / 'release-timings.jsonl').read_text()
            self.assertNotIn('private argument', data)
            event = json.loads(data)
            self.assertEqual(event['outcome'], 'failed'); self.assertEqual(event['errorType'], 'ValueError')
            with patch.object(upgrade.os, 'open', side_effect=OSError('unwritable')):
                with upgrade.timed('telemetry_unavailable'):
                    pass


class CapabilityAndEvidenceTests(unittest.TestCase):
    def test_feature_map_lists_reusable_capabilities_without_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            (source / 'lib/i18n/messages').mkdir(parents=True)
            (source / 'lib/i18n/messages/en.ts').write_text('')
            (source / 'lib/i18n/messages/zh-CN.ts').write_text('')
            (source / 'lib/settings-navigation.ts').write_text('export const SETTINGS_SECTION_VALUES = [\n  "general",\n  "models",\n] as const;\n')
            (source / 'app/api/agent/running').mkdir(parents=True)
            (source / 'app/api/agent/running/route.ts').write_text('')
            (source / 'e2e').mkdir()
            (source / 'e2e/quiet-tools.mjs').write_text('')
            (source / 'e2e/run.mjs').write_text('')
            (source / 'local-customizations.json').write_text(json.dumps({'requiredSourceMarkers': {'components/ChatInput.tsx': []}}))
            with patch.object(flow, 'configuration', return_value=({}, source, source)), \
                 patch('builtins.print') as printed:
                self.assertEqual(flow.features(), 0)
            text = ' '.join(str(call.args[0]) for call in printed.call_args_list if call.args)
            for expected in ['general', 'models', 'en', 'zh-CN', 'quiet-tools', 'agent', 'components/ChatInput.tsx']:
                self.assertIn(expected, text)
            self.assertNotIn('run、', text)

    def test_evidence_problems_bind_build_package_launchd_and_exact_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = {'sessionId': PARENT, 'runId': RUN, 'expectedText': 'REAL_REVIEW_RESULT'}
            quiet, probe, smoke = root / 'quiet.json', root / 'probe.json', root / 'smoke.json'
            base = {'passed': True, 'buildId': 'B1', 'packageRoot': '/candidate'}
            quiet.write_text(json.dumps(base))
            probe.write_text(json.dumps({**base, 'launchd': True}))
            smoke.write_text(json.dumps({**base, 'sessionId': PARENT, 'realHistoryRunId': RUN, 'expectedChildText': 'REAL_REVIEW_RESULT'}))
            artifacts = [('quiet-tools', quiet, False), ('runtime-probe', probe, False), ('real-history', smoke, True)]
            self.assertEqual(flow.artifact_problems(artifacts, 'B1', '/candidate', fixture), [])
            smoke.write_text(json.dumps({**base, 'sessionId': PARENT, 'realHistoryRunId': RUN, 'expectedChildText': 'OTHER'}))
            self.assertTrue(any('expectedChildText' in item for item in flow.artifact_problems(artifacts, 'B1', '/candidate', fixture)))
            probe.write_text(json.dumps(base))
            self.assertTrue(any('launchd' in item for item in flow.artifact_problems(artifacts, 'B1', '/candidate', fixture)))
            quiet.write_text(json.dumps({**base, 'buildId': 'OLD', 'packageRoot': '/old'}))
            problems = flow.artifact_problems(artifacts, 'B1', '/candidate', fixture)
            self.assertTrue(any('buildId' in item for item in problems)); self.assertTrue(any('packageRoot' in item for item in problems))

    def test_evidence_dry_run_reports_identity_without_running_any_step(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); candidate = root / 'candidate'; source = root / 'source'
            (candidate / '.next').mkdir(parents=True); (candidate / '.next/BUILD_ID').write_text('BUILD1\n')
            (candidate / 'package.json').write_text(json.dumps({'version': '0.12.1'}))
            (candidate / 'test-results/maintenance').mkdir(parents=True)
            source.mkdir()
            fixture = root / 'fixture.json'
            fixture.write_text(json.dumps({'sessionId': PARENT, 'runId': RUN, 'expectedText': 'REAL_REVIEW_RESULT'}))
            config = {'historyFixtureFile': str(fixture)}
            with patch.object(flow, 'configuration', return_value=(config, source, candidate)), \
                 patch.object(flow, 'precheck') as precheck, patch.object(flow.subprocess, 'run') as run, \
                 patch('builtins.print') as printed:
                self.assertEqual(flow.evidence(dry_run=True), 0)
                run.assert_not_called(); precheck.preflight.assert_not_called()
            payload = json.loads(printed.call_args.args[0])
            self.assertTrue(payload['dryRun']); self.assertEqual(payload['identity']['buildId'], 'BUILD1')
            self.assertFalse(payload['artifactsCurrent'])

    def test_evidence_runs_the_three_gates_and_reports_readiness(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); candidate = root / 'candidate'; source = root / 'source'; here = root / 'here'
            (candidate / '.next').mkdir(parents=True); (candidate / '.next/BUILD_ID').write_text('BUILD1\n')
            (candidate / 'package.json').write_text(json.dumps({'version': '0.12.1'}))
            (candidate / 'test-results/maintenance').mkdir(parents=True)
            (source / 'e2e').mkdir(parents=True); here.mkdir()
            shutil.copyfile(HERE / 'history_fixture.py', here / 'history_fixture.py')
            (source / 'e2e/quiet-tools.mjs').write_text('''
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path'; import { fileURLToPath } from 'node:url';
const source = dirname(dirname(fileURLToPath(import.meta.url)));
const root = process.env.PI_WEB_CHAT_PACKAGE_ROOT;
const out = join(source, 'test-results/quiet-tools'); mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'result.json'), JSON.stringify({ passed: true, buildId: readFileSync(join(root, '.next/BUILD_ID'), 'utf8').trim(), packageRoot: root }));
''')
            (here / 'probe_runtime.py').write_text('''
import json, sys
from pathlib import Path
here = Path(sys.argv[0]).resolve().parent; package = Path(sys.argv[1])
(here / 'runtime-probe-result.json').write_text(json.dumps({'passed': True, 'buildId': 'BUILD1', 'packageRoot': str(package), 'launchd': True}))
''')
            (here / 'verify-live.mjs').write_text('''
import { writeFileSync } from 'node:fs';
const payload = { passed: true, buildId: process.argv[3], packageRoot: process.env.PI_WEB_VERIFY_PACKAGE_ROOT, sessionId: process.argv[2], realHistoryRunId: '22222222-2222-4222-8222-222222222222', expectedChildText: 'REAL_REVIEW_RESULT' };
writeFileSync(process.env.PI_WEB_VERIFY_OUTPUT_DIR + 'live-result.json', JSON.stringify(payload));
writeFileSync(process.env.PI_WEB_VERIFY_SMOKE_OUTPUT, JSON.stringify(payload));
''')
            fixture = root / 'fixture.json'
            fixture.write_text(json.dumps({'sessionId': PARENT, 'runId': RUN, 'expectedText': 'REAL_REVIEW_RESULT'}))
            config = {'historyFixtureFile': str(fixture)}
            from contextlib import nullcontext
            with patch.object(flow, 'configuration', return_value=(config, source, candidate)), \
                 patch.object(flow, 'HERE', here), \
                 patch.object(flow, 'TempServer', lambda root, log: nullcontext('http://127.0.0.1:1')), \
                 patch.object(flow.precheck, 'preflight', return_value={'passed': True, 'checks': []}) as checks, \
                 patch('builtins.print') as printed:
                self.assertEqual(flow.evidence(bundle_mode='pi-core-1.4.0'), 0)
                self.assertEqual([call.kwargs for call in checks.call_args_list], [
                    {'phase': 'candidate', 'dependency_mode': 'pi-core-1.4.0'},
                    {'phase': 'release', 'dependency_mode': 'pi-core-1.4.0'}])
            payload = json.loads(printed.call_args.args[0])
            self.assertTrue(payload['passed']); self.assertTrue(payload['releaseReady'])
            self.assertEqual([step['name'] for step in payload['steps']], ['quiet-tools', 'runtime-probe', 'real-history'])
            self.assertEqual(payload['problems'], [])
            self.assertTrue((candidate / 'test-results/maintenance/evidence/BUILD1/quiet-tools.log').is_file())
            self.assertTrue((here / 'smoke-result.json').is_file())


if __name__ == '__main__':
    unittest.main()
