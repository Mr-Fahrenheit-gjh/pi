"""Offline fixtures only: never launch/stop a service or edit installed extensions."""
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deck_upgrade', Path(__file__).with_name('upgrade_when_idle.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
ORIGINAL_STOP_RETRY = upgrade.stop_with_idle_retry


def extension_fixture(root):
    package = root/'extension'
    (package/'form/js').mkdir(parents=True)
    (package/'package.json').write_text(json.dumps({'name': 'pi-design-deck', 'version': '0.5.1'}))
    for name in upgrade.deck.FILES:
        (package/name).write_text('original '+name)
    script = root/'patch.mjs'
    script.write_text('import {readFileSync,writeFileSync} from "node:fs";\n'
                      'for (const f of ["index.ts","form/js/deck-session.js","deck-server.ts"]) {\n'
                      'const p=process.argv[3]+"/"+f; writeFileSync(p,readFileSync(p,"utf8")+" patched"); }\n')
    return package, script


class DeckPayloadTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.package, self.script = extension_fixture(self.root)
        self.stack.enter_context(patch.object(upgrade.deck, 'PACKAGE', self.package))
        self.stage, self.backup = self.root/'stage', self.root/'backup'
        self.stage.mkdir(); self.backup.mkdir()
        self.originals = {name: (self.package/name).read_bytes() for name in upgrade.deck.FILES}

    def prepare(self):
        return upgrade.deck.prepare(self.stage, self.script)

    def test_prepare_is_offline_and_binds_all_files_and_permissions(self):
        (self.package/'index.ts').chmod(0o640)
        record = self.prepare()
        self.assertEqual(record['files']['index.ts']['after']['mode'], 0o640)
        for name, original in self.originals.items():
            self.assertEqual((self.package/name).read_bytes(), original)
            self.assertEqual((self.stage/upgrade.deck.PAYLOAD/'package'/name).read_bytes(), original+b' patched')

    def test_wrong_version_and_symlink_are_refused_before_payload_writes(self):
        (self.package/'package.json').write_text('{"name":"pi-design-deck","version":"9"}')
        with self.assertRaisesRegex(RuntimeError, '0.5.1'):
            self.prepare()
        self.assertFalse((self.stage/upgrade.deck.PAYLOAD).exists())
        (self.package/'package.json').write_text('{"name":"pi-design-deck","version":"0.5.1"}')
        (self.package/'index.ts').unlink()
        (self.package/'index.ts').symlink_to(self.script)
        with self.assertRaisesRegex(RuntimeError, 'non-symlink'):
            self.prepare()

    def test_drift_of_every_bound_input_prevents_activation(self):
        record = self.prepare()
        paths = [self.script, self.package/'package.json', self.package/'index.ts', self.package/'deck-server.ts',
                 self.stage/upgrade.deck.PAYLOAD/'patch.mjs',
                 self.stage/upgrade.deck.PAYLOAD/'package/form/js/deck-session.js']
        for path in paths:
            before = path.read_bytes()
            path.write_bytes(before+b' ')
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                upgrade.deck.activate(record, self.stage, self.backup)
            self.assertFalse((self.backup/'design-deck').exists())
            path.write_bytes(before)

    def test_activation_and_rollback_preserve_exact_originals(self):
        record = self.prepare()
        upgrade.deck.activate(record, self.stage, self.backup)
        upgrade.deck.assert_installed(record)
        for name, original in self.originals.items():
            self.assertEqual((self.backup/'design-deck'/name).read_bytes(), original)
        upgrade.deck.restore(record, self.backup)
        upgrade.deck.assert_prepared(record, self.stage)
        self.assertFalse(list(self.package.rglob('.pi-web-release-*')))

    def test_legacy_two_file_plan_remains_recoverable(self):
        self.script.write_text(self.script.read_text().replace(',"deck-server.ts"', ''))
        with patch.object(upgrade.deck, 'FILES', ('index.ts', 'form/js/deck-session.js')):
            record = self.prepare()
        upgrade.deck.activate(record, self.stage, self.backup)
        upgrade.deck.restore(record, self.backup)
        upgrade.deck.assert_prepared(record, self.stage)
        self.assertEqual((self.package/'deck-server.ts').read_bytes(), self.originals['deck-server.ts'])

    def test_second_replace_failure_is_recoverable(self):
        record = self.prepare()
        real = upgrade.deck.replace_file
        def replace(path, data, expected):
            if path.name == 'deck-session.js':
                raise OSError('second write failed')
            real(path, data, expected)
        with patch.object(upgrade.deck, 'replace_file', side_effect=replace):
            with self.assertRaisesRegex(OSError, 'second write'):
                upgrade.deck.activate(record, self.stage, self.backup)
        upgrade.deck.restore(record, self.backup)
        upgrade.deck.assert_prepared(record, self.stage)

    def test_backup_failure_never_writes_live_and_needs_no_backup_to_recover(self):
        record = self.prepare()
        with patch.object(upgrade.deck.shutil, 'copy2', side_effect=OSError('backup failed')):
            with self.assertRaisesRegex(OSError, 'backup failed'):
                upgrade.deck.activate(record, self.stage, self.backup)
        upgrade.deck.restore(record, self.backup)
        upgrade.deck.assert_prepared(record, self.stage)

    def test_unknown_live_edit_or_backup_drift_blocks_all_rollback_writes(self):
        record = self.prepare()
        upgrade.deck.activate(record, self.stage, self.backup)
        for path in [self.package/'form/js/deck-session.js', self.backup/'design-deck/index.ts']:
            before = path.read_bytes(); path.write_bytes(b'unknown update')
            with self.subTest(path=path), patch.object(upgrade.deck, 'replace_file') as replace:
                with self.assertRaises(RuntimeError):
                    upgrade.deck.restore(record, self.backup)
                replace.assert_not_called()
            path.write_bytes(before)


class ApplyTransactionTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.here = self.root/'maintenance'
        self.here.mkdir()
        (self.root/'简洁工具显示').mkdir()
        self.live, self.stage, self.backup = [self.root/name for name in ('live', 'stage', 'backup')]
        for root, build in [(self.live, 'old'), (self.stage, 'new')]:
            (root/'.next').mkdir(parents=True)
            (root/'.next/BUILD_ID').write_text(build)
            (root/'package.json').write_text(json.dumps({'version': upgrade.VERSION}))
        self.plan = {'sessionId': 'fixture', 'buildId': 'new', 'oldBuild': 'old',
                     'staged': str(self.stage), 'backup': str(self.backup)}
        for key, value in {'HERE': self.here, 'LIVE': self.live, 'PLAN': self.here/'plan.json',
                           'STATE': self.here/'state.json', 'CONFIG': {}, 'RESTART_SESSION_ID': None}.items():
            self.stack.enter_context(patch.object(upgrade, key, value))
        for name in ('wait_idle', 'stop_with_idle_retry'):
            setattr(self, name, self.stack.enter_context(patch.object(upgrade, name)))
        for name in ('preflight_launchd', 'assert_baseline', 'wait_stopped', 'start', 'healthy'):
            setattr(self, name, self.stack.enter_context(patch.object(upgrade.core, name)))
        self.stack.enter_context(patch.object(upgrade.core, 'launchd_loaded', return_value=False))
        self.stack.enter_context(patch.object(upgrade.core, 'command', return_value=SimpleNamespace(returncode=0, stdout='', stderr='')))
        self.stack.enter_context(patch.object(upgrade.core, 'assert_live_evidence', return_value={}))
        self.save_plan()

    def save_plan(self):
        upgrade.PLAN.write_text(json.dumps(self.plan))
        upgrade.STATE.write_text(json.dumps({'status': 'prepared', 'buildId': 'new'}))

    def test_failure_after_stop_before_first_move_restarts_unchanged_web(self):
        with patch.object(upgrade.shutil, 'move', side_effect=OSError('first move failed')):
            with self.assertRaisesRegex(OSError, 'first move failed'):
                upgrade.apply()
        self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'old')
        self.start.assert_called_once()
        self.assertEqual(json.loads(upgrade.STATE.read_text())['status'], 'rolled_back')

    def test_stop_confirmation_timeout_safely_restarts_old_package_once_stopped(self):
        self.stop_with_idle_retry.side_effect = upgrade.ServiceStopIncomplete('job still unloading')
        with patch.object(upgrade, 'running_session_ids') as running, patch.object(upgrade.shutil, 'move') as move:
            with self.assertRaisesRegex(upgrade.ServiceStopIncomplete, 'job still unloading'):
                upgrade.apply()
            running.assert_not_called()
            move.assert_not_called()
        self.wait_stopped.assert_any_call(self.plan)
        self.start.assert_called_once()
        self.assertEqual(json.loads(upgrade.STATE.read_text())['status'], 'rolled_back')
        self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'old')
        self.assertEqual({path.name for path in self.backup.iterdir()}, {'manifest.json'})

    def test_unconfirmed_stop_leaves_recoverable_state_without_starting_or_swapping(self):
        self.stop_with_idle_retry.side_effect = upgrade.ServiceStopIncomplete('job still unloading')
        self.wait_stopped.side_effect = RuntimeError('bound process still alive')
        with patch.object(upgrade.shutil, 'move') as move:
            with self.assertRaisesRegex(RuntimeError, 'bound process still alive'):
                upgrade.apply()
            move.assert_not_called()
        self.start.assert_not_called()
        state = json.loads(upgrade.STATE.read_text())
        self.assertEqual(state['status'], 'recovery_failed')
        self.assertEqual(state['error'], 'job still unloading')
        self.assertEqual(state['recoveryError'], 'bound process still alive')
        self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'old')
        self.assertEqual({path.name for path in self.backup.iterdir()}, {'manifest.json'})

    def add_extension(self):
        self.package, script = extension_fixture(self.root)
        self.stack.enter_context(patch.object(upgrade.deck, 'PACKAGE', self.package))
        self.plan['designDeck'] = upgrade.deck.prepare(self.stage, script)
        self.save_plan()

    def test_success_patches_only_after_stop_and_before_start(self):
        self.add_extension()
        def stopped(*args):
            upgrade.deck.assert_prepared(self.plan['designDeck'], self.stage)
            self.start.assert_not_called()
        def started():
            upgrade.deck.assert_installed(self.plan['designDeck'])
            self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'new')
        self.stop_with_idle_retry.side_effect = stopped
        self.start.side_effect = started
        upgrade.apply()
        self.assertTrue(json.loads(upgrade.STATE.read_text())['designDeckVerified'])
        self.assertEqual((self.backup/'package/.next/BUILD_ID').read_text(), 'old')

    def test_stop_failure_cannot_modify_extension(self):
        self.add_extension()
        self.stop_with_idle_retry.side_effect = RuntimeError('cannot prove idle')
        with self.assertRaisesRegex(RuntimeError, 'cannot prove idle'):
            upgrade.apply()
        upgrade.deck.assert_prepared(self.plan['designDeck'], self.stage)
        self.start.assert_not_called()
        self.assertFalse((self.backup/'design-deck').exists())

    def test_activation_failure_before_web_move_rolls_back_and_restarts_old_web(self):
        self.add_extension()
        real = upgrade.deck.replace_file
        def replace(path, data, expected):
            if path.name == 'deck-session.js':
                raise OSError('second activation failed')
            real(path, data, expected)
        with patch.object(upgrade.deck, 'replace_file', side_effect=replace):
            with self.assertRaisesRegex(OSError, 'second activation failed'):
                upgrade.apply()
        upgrade.deck.assert_prepared(self.plan['designDeck'], self.stage)
        self.start.assert_called_once()
        self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'old')
        self.assertEqual(json.loads(upgrade.STATE.read_text())['status'], 'rolled_back')

    def test_formal_failure_waits_for_idle_before_restoring_either_package(self):
        self.add_extension()
        def waiting():
            if self.wait_idle.call_count == 2:
                upgrade.deck.assert_installed(self.plan['designDeck'])
                self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'new')
        self.wait_idle.side_effect = waiting
        with patch.object(upgrade.core, 'launchd_loaded', side_effect=[False, True]), \
             patch.object(upgrade.core, 'assert_live_evidence', side_effect=RuntimeError('formal failed')), \
             patch.object(upgrade, 'running_session_ids', return_value=['busy']):
            with self.assertRaisesRegex(RuntimeError, 'formal failed'):
                upgrade.apply()
        self.assertEqual(self.wait_idle.call_count, 2)
        self.assertEqual(self.stop_with_idle_retry.call_count, 2)
        self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'old')
        for name, states in self.plan['designDeck']['files'].items():
            upgrade.deck.require(self.package/name, states['before'])

    def assert_blocked_recovery(self, unknown):
        self.add_extension()
        reason = 'unknown snapshot' if unknown else 'busy past deadline'
        if not unknown:
            self.wait_idle.side_effect = [None, RuntimeError(reason)]
        with patch.object(upgrade.core, 'launchd_loaded', side_effect=[False, True]), \
             patch.object(upgrade.core, 'assert_live_evidence', side_effect=RuntimeError('formal failed')), \
             patch.object(upgrade, 'running_session_ids', side_effect=RuntimeError(reason) if unknown else None, return_value=['busy']), \
             patch.object(upgrade.deck, 'restore') as restore:
            with self.assertRaisesRegex(RuntimeError, reason):
                upgrade.apply()
        restore.assert_not_called()
        upgrade.deck.assert_installed(self.plan['designDeck'])
        self.assertEqual((self.live/'.next/BUILD_ID').read_text(), 'new')

    def test_unknown_new_service_blocks_rollback_writes(self):
        self.assert_blocked_recovery(unknown=True)

    def test_still_busy_new_service_blocks_rollback_writes(self):
        self.assert_blocked_recovery(unknown=False)

    def test_busy_retry_rechecks_extension_drift_before_stopping(self):
        self.add_extension()
        # Use the real retry loop, not the fixture's stop mock.
        def change_while_waiting(**kwargs):
            (self.package/'index.ts').write_text('concurrent update')
        with patch.object(upgrade, 'stop_idle_service', side_effect=upgrade.ServiceBusy('busy')) as stop, \
             patch.object(upgrade, 'wait_idle', side_effect=change_while_waiting):
            with self.assertRaisesRegex(RuntimeError, 'drift'):
                ORIGINAL_STOP_RETRY(self.plan)
            self.assertEqual(stop.call_count, 1)


if __name__ == '__main__':
    unittest.main()
