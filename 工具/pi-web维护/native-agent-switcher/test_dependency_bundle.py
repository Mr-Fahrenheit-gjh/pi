import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).with_name('upgrade_when_idle.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
bundle = upgrade.bundle


class BundleTests(unittest.TestCase):
    def setUp(self):
        config = patch.object(upgrade, 'CONFIG', {k: v for k, v in upgrade.CONFIG.items() if k != 'historyFixtureFile'})
        config.start()
        self.addCleanup(config.stop)

    def test_real_history_fixture_is_bound_and_cannot_change_parent_or_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = {'sessionId': '01a142c9-2e81-764e-bdbc-1c44a4123328',
                       'runId': '6bf7d770-9f45-4ab4-818f-de157974cd5a', 'expectedText': 'No issues found.'}
            path = root/'fixture.json'; path.write_text(json.dumps(fixture))
            with patch.object(upgrade, 'CONFIG', {'historyFixtureFile': str(path)}), patch.object(upgrade, 'assert_history_available'):
                plan = {'sessionId': fixture['sessionId'], 'historyFixture': fixture}
                upgrade.assert_history_fixture(plan)
                for changed in [{**fixture, 'expectedText': 'Different text'},
                                {**fixture, 'sessionId': '01a13009-3f42-767a-b47f-6a1ab9c1d7ea'},
                                {**fixture, 'runId': '../outside'}, {**fixture, 'expectedText': 'short'}]:
                    path.write_text(json.dumps(changed))
                    with self.assertRaises((RuntimeError, ValueError)):
                        upgrade.assert_history_fixture(plan)

    def test_only_the_named_migration_is_allowed(self):
        live = {'@xterm/xterm': '6.0.0', '@xterm/addon-fit': '0.11.0', 'next': '16.3.8'}
        new = {'ghostty-web': '0.4.0', 'next': '16.3.8'}
        bundle.validate_dependency_delta(live, new)
        for candidate in [{**new, 'next': '17.0.0'}, {**new, 'ghostty-web': '0.5.0'}, live]:
            with self.assertRaises(RuntimeError):
                bundle.validate_dependency_delta(live, candidate)

    def test_followup_ui_release_allows_only_identical_ghostty_dependencies(self):
        live = {'ghostty-web': '0.4.0', 'next': '16.3.8'}
        bundle.validate_dependency_delta(live, dict(live))
        for candidate in [{**live, 'next': '17.0.0'}, {**live, 'ghostty-web': '0.5.0'},
                          {**live, '@xterm/xterm': '6.0.0'}]:
            with self.assertRaises(RuntimeError):
                bundle.validate_dependency_delta(live, candidate)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta({'next': '16.3.8'}, {'next': '16.3.8'})

    def test_core_upgrade_is_exact_and_cannot_ride_on_ui_mode(self):
        live = {'ghostty-web': '0.4.0', 'next': '16.3.8', **{name: '1.2.0' for name in bundle.CORE_PACKAGES}}
        new = {**live, **{name: '1.3.0' for name in bundle.CORE_PACKAGES}}
        bundle.validate_dependency_delta(live, new, bundle.CORE_MODE)
        for candidate in [live, {**new, 'next': '17.0.0'},
                          {**new, bundle.CORE_PACKAGES[0]: '1.2.0'},
                          {**new, bundle.CORE_PACKAGES[0]: '1.3.1'}]:
            with self.assertRaises(RuntimeError):
                bundle.validate_dependency_delta(live, candidate, bundle.CORE_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(live, new)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(new, live, bundle.CORE_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(live, new, 'unknown')

    def test_core_14_requires_exact_seven_package_upgrade(self):
        live = {'ghostty-web': '0.4.0', **{name: '1.3.0' for name in bundle.CORE_PACKAGES}}
        target = {**live, **{name: '1.4.0' for name in bundle.CORE_PACKAGES}}
        bundle.validate_dependency_delta(live, target, bundle.CORE_14_MODE)
        for candidate in [live, {**target, 'ghostty-web': '0.5.0'}, {**target, bundle.CORE_PACKAGES[0]: '1.3.0'}]:
            with self.assertRaises(RuntimeError):
                bundle.validate_dependency_delta(live, candidate, bundle.CORE_14_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(target, live, bundle.CORE_14_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(live, target, bundle.CORE_MODE)

    def test_core_15_requires_exact_seven_package_upgrade(self):
        live = {'ghostty-web': '0.4.0', **{name: '1.4.0' for name in bundle.CORE_PACKAGES}}
        target = {**live, **{name: '1.5.0' for name in bundle.CORE_PACKAGES},
                  '@earendil-works/pi-schema': '1.5.0'}
        bundle.validate_dependency_delta(live, target, bundle.CORE_15_MODE)
        for candidate in [live, {**target, 'ghostty-web': '0.5.0'},
                          {**target, bundle.CORE_PACKAGES[0]: '1.4.0'},
                          {name: version for name, version in target.items() if name != '@earendil-works/pi-schema'}]:
            with self.assertRaises(RuntimeError):
                bundle.validate_dependency_delta(live, candidate, bundle.CORE_15_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(target, live, bundle.CORE_15_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(live, target, bundle.CORE_14_MODE)

    def test_security_upgrade_is_exact_and_retains_core(self):
        live = {'ghostty-web': '0.4.0', 'next': '16.3.8', 'undici': '8.11.0',
                **{name: '1.5.0' for name in (*bundle.CORE_PACKAGES, '@earendil-works/pi-schema')}}
        target = {**live, 'next': '16.4.4', 'undici': '8.12.3'}
        bundle.validate_dependency_delta(live, target, bundle.SECURITY_MODE)
        for candidate in [live, {**target, 'next': '17.0.0'}, {**target, 'ghostty-web': '0.5.0'},
                          {**target, bundle.CORE_PACKAGES[0]: '1.4.0'}, {**target, 'extra': '1.0.0'}]:
            with self.assertRaises(RuntimeError):
                bundle.validate_dependency_delta(live, candidate, bundle.SECURITY_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(target, live, bundle.SECURITY_MODE)
        with self.assertRaises(RuntimeError):
            bundle.validate_dependency_delta(live, target)

    def test_bundle_refuses_removed_local_ui_before_install_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deps = {'@earendil-works/pi-coding-agent': '1.3.0', 'ghostty-web': '0.4.0'}
            (root/'package.json').write_text(json.dumps({'dependencies': deps}))
            (root/'package-lock.json').write_text(json.dumps({}))
            (root/'local-customizations.json').write_text(json.dumps({'schemaVersion': 1,
                'supportedSdkVersions': ['1.3.0'], 'requiredSourceMarkers': {},
                'forbiddenSourceMarkers': {'ui.tsx': ['REMOVED_UI']}}))
            (root/'ui.tsx').write_text('REMOVED_UI')
            with self.assertRaisesRegex(RuntimeError, 'Removed local UI'):
                bundle.validate_install(root)

    def test_sdk_drift_after_prepare_cannot_be_downgraded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root/'stage'; (stage/'.next').mkdir(parents=True)
            (stage/'.next/BUILD_ID').write_text('candidate')
            plan = {'buildId': 'candidate', 'staged': str(stage), 'backup': str(root/'backup'),
                    'dependencyMode': bundle.MODE, 'payloadFingerprint': {}}
            (root/'plan').write_text(json.dumps(plan))
            (root/'state').write_text(json.dumps({'status': 'prepared', 'buildId': 'candidate'}))
            def package(path):
                return {'version': upgrade.VERSION, 'dependencies': {'ghostty-web': '0.4.0',
                        '@earendil-works/pi-coding-agent': '1.1.0' if path == stage else '1.2.0'}}
            with patch.object(upgrade, 'PLAN', root/'plan'), patch.object(upgrade, 'STATE', root/'state'), \
                 patch.object(upgrade, 'package_json', side_effect=package), \
                 patch.object(bundle, 'assert_fingerprint'), patch.object(upgrade.core, 'preflight_launchd'), \
                 patch.object(upgrade.core, 'assert_baseline'), patch.object(upgrade, 'wait_idle'), \
                 patch.object(upgrade, 'stop_idle_service') as stop:
                with self.assertRaisesRegex(RuntimeError, 'unchanged Ghostty'):
                    upgrade.apply()
                stop.assert_not_called()
                self.assertFalse((root/'backup').exists())

    def test_payload_binds_all_dependency_and_asset_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['node_modules', '.next', 'public', 'bin']:
                (root/name).mkdir()
                (root/name/'data').write_text(name)
            for name in ['package.json', 'package-lock.json', 'next.config.ts']:
                (root/name).write_text(name)
            original = bundle.fingerprint(root)
            bundle.assert_fingerprint(root, original)
            for path in ['node_modules/data', 'public/data', 'bin/data', '.next/data', 'package-lock.json']:
                file = root/path
                before = file.read_text()
                file.write_text('changed')
                with self.assertRaisesRegex(RuntimeError, 'changed since verification'):
                    bundle.assert_fingerprint(root, original)
                file.write_text(before)

    def test_external_dependency_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)/'modules'; root.mkdir()
            outside = Path(directory)/'outside'; outside.write_text('outside')
            (root/'link').symlink_to(outside)
            with self.assertRaisesRegex(RuntimeError, 'External'):
                bundle.tree_digest(root)
            (root/'link').unlink()
            (root/'file').write_text('inside')
            (root/'link').symlink_to('file')
            bundle.tree_digest(root)
            linked_root = Path(directory)/'linked-root'; linked_root.symlink_to(root)
            with self.assertRaisesRegex(RuntimeError, 'independent'):
                bundle.tree_digest(linked_root)

    def test_default_prepare_still_refuses_dependency_changes(self):
        with patch.object(upgrade, 'assert_no_pending_plan'), patch.object(upgrade, 'package_json', side_effect=[
            {'version': upgrade.VERSION, 'dependencies': {'ghostty-web': '0.4.0'}},
            {'version': upgrade.VERSION, 'dependencies': {'@xterm/xterm': '6.0.0'}},
        ]), patch.object(upgrade.core, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'dependency versions changed'):
                upgrade.prepare('session')
            command.assert_not_called()

    def test_supersede_is_explicit_pre_switch_and_preserves_old_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage = root/'stage'; (stage/'.next').mkdir(parents=True)
            (stage/'.next/BUILD_ID').write_text('old-candidate')
            state = root/'state.json'; plan_file = root/'plan.json'
            plan = {'buildId': 'old-candidate', 'staged': str(stage), 'backup': str(root/'backup')}
            previous = {'status': 'waiting_for_idle', **plan}
            plan_file.write_text(json.dumps(plan)); state.write_text(json.dumps(previous))
            with patch.object(upgrade, 'HERE', root), patch.object(upgrade, 'STATE', state), patch.object(upgrade, 'PLAN', plan_file), patch.object(upgrade.core, 'assert_baseline') as baseline:
                for status in ['switching', 'verifying_live', 'rollback_waiting_for_idle', 'recovery_failed']:
                    state.write_text(json.dumps({**previous, 'status': status}))
                    with self.assertRaises(RuntimeError): upgrade.supersede('old-candidate', 'approved')
                state.write_text(json.dumps(previous))
                with self.assertRaises(RuntimeError): upgrade.supersede('wrong-build', 'approved')
                with self.assertRaises(RuntimeError): upgrade.supersede('old-candidate', '')
                upgrade.supersede('old-candidate', 'User approved unified release')
                self.assertEqual(json.loads(state.read_text())['status'], 'superseded')
                self.assertTrue((stage/'.next/BUILD_ID').is_file())
                self.assertEqual(json.loads(plan_file.read_text()), plan)
                baseline.assert_called_once_with(plan)

    def test_superseded_plan_cannot_be_applied(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'plan').write_text(json.dumps({'buildId': 'old'}))
            (root/'state').write_text(json.dumps({'status': 'superseded', 'buildId': 'old'}))
            with patch.object(upgrade, 'PLAN', root/'plan'), patch.object(upgrade, 'STATE', root/'state'), patch.object(upgrade.core, 'command') as command:
                with self.assertRaisesRegex(RuntimeError, 'current prepared'):
                    upgrade.apply()
                command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
