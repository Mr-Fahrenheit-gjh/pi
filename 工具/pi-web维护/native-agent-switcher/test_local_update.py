import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('local_update', Path(__file__).with_name('prepare-local-update.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class LocalUpdateTests(unittest.TestCase):
    def fixture(self, root):
        source = root/'source'; source.mkdir()
        def git(*args):
            return module.git(source, *args)
        git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Fixture')
        package = {'name': 'fixture', 'version': '0.12.0', 'dependencies': {'@earendil-works/pi-coding-agent': '1.1.0', '@xterm/xterm': '6.0.0'}}
        def save_package(package):
            lock = {'version': package['version'], 'packages': {'': {'version': package['version'], 'dependencies': package['dependencies']}, 'node_modules/ghostty-web': {'version': '0.4.0'}}}
            (source/'package.json').write_text(json.dumps(package)); (source/'package-lock.json').write_text(json.dumps(lock))
        save_package(package); (source/'upstream.txt').write_text('old')
        git('add', '.'); git('commit', '-qm', 'upstream 0.12.0'); git('tag', 'v0.12.0')
        package['version'] = '0.12.1'; package['dependencies']['@earendil-works/pi-coding-agent'] = '1.2.0'
        package['dependencies']['@earendil-works/pi-mcp'] = '1.2.0'
        save_package(package); (source/'upstream.txt').write_text('fixed')
        git('add', '.'); git('commit', '-qm', 'upstream 0.12.1'); git('tag', 'v0.12.1')
        git('checkout', '-qb', 'local', 'v0.12.0')
        package['version'] = '0.12.0'; package['dependencies'].pop('@earendil-works/pi-mcp')
        package['dependencies'].pop('@xterm/xterm'); package['dependencies']['ghostty-web'] = '0.4.0'
        save_package(package); (source/'local.txt').write_text('LOCAL_FEATURE')
        manifest = {'schemaVersion': 1, 'upstreamRef': 'v0.12.0', 'supportedSdkVersions': ['1.2.0'],
                    'dependencyOverrides': {'ghostty-web': '0.4.0', '@xterm/xterm': None},
                    'requiredSourceMarkers': {'local.txt': ['LOCAL_FEATURE']}}
        (source/'local-customizations.json').write_text(json.dumps(manifest))
        git('add', '.'); git('commit', '-qm', 'local customizations')
        return source

    def test_migration_keeps_local_features_and_upstream_fix_without_installing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = self.fixture(root)
            before = module.git(source, 'rev-parse', 'HEAD').stdout
            output = root/'candidate'; result = module.prepare(source, 'v0.12.1', output)
            self.assertEqual(result['status'], 'prepared_source'); self.assertFalse(result['installed']); self.assertFalse(result['deployed'])
            self.assertEqual((output/'upstream.txt').read_text(), 'fixed')
            self.assertEqual((output/'local.txt').read_text(), 'LOCAL_FEATURE')
            package = json.loads((output/'package.json').read_text())
            self.assertEqual(package['version'], '0.12.1'); self.assertEqual(package['dependencies']['ghostty-web'], '0.4.0')
            self.assertEqual(package['dependencies']['@earendil-works/pi-mcp'], '1.2.0'); self.assertNotIn('@xterm/xterm', package['dependencies'])
            self.assertEqual(module.git(source, 'rev-parse', 'HEAD').stdout, before)
            self.assertFalse(module.git(source, 'status', '--porcelain').stdout)
            with self.assertRaisesRegex(RuntimeError, 'already exists'): module.prepare(source, 'v0.12.1', output)
            module.git(source, 'worktree', 'remove', '--force', str(output))

    def test_conflicting_settings_are_not_silently_overwritten(self):
        with self.assertRaisesRegex(RuntimeError, 'requires review'): module.merge_json({'value': 1}, {'value': 2}, {'value': 3})
        self.assertEqual(module.merge_json({'base': 1}, {'base': 1, 'local': True}, {'base': 2}), {'base': 2, 'local': True})

    def test_dirty_source_is_refused_before_allocating(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = self.fixture(root); (source/'local.txt').write_text('edited')
            with self.assertRaisesRegex(RuntimeError, 'tracked changes'): module.prepare(source, 'v0.12.1', root/'candidate')
            self.assertFalse((root/'candidate').exists())

    def test_revision_expressions_are_not_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = self.fixture(root)
            with self.assertRaisesRegex(RuntimeError, 'exact version tag'): module.prepare(source, 'HEAD~1', root/'candidate')
            self.assertFalse((root/'candidate').exists())

    def test_missing_local_feature_fails_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = self.fixture(root); (source/'local.txt').unlink()
            manifest = json.loads((source/'local-customizations.json').read_text())
            with self.assertRaisesRegex(RuntimeError, 'customization missing'): module.validate_customizations(source, manifest)

    def test_removed_local_ui_cannot_be_restored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = self.fixture(root)
            manifest = json.loads((source/'local-customizations.json').read_text())
            manifest['forbiddenSourceMarkers'] = {'local.txt': ['REMOVED_UI']}
            module.validate_customizations(source, manifest)
            (source/'local.txt').write_text('LOCAL_FEATURE REMOVED_UI')
            with self.assertRaisesRegex(RuntimeError, 'was restored'):
                module.validate_customizations(source, manifest)

    def test_unsupported_sdk_is_refused_before_allocating(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = self.fixture(root)
            module.git(source, 'checkout', '-q', 'v0.12.1')
            package = json.loads((source/'package.json').read_text()); package['version'] = '0.12.2'; package['dependencies']['@earendil-works/pi-coding-agent'] = '1.3.0'
            (source/'package.json').write_text(json.dumps(package)); module.git(source, 'add', 'package.json'); module.git(source, 'commit', '-qm', 'new sdk'); module.git(source, 'tag', 'v0.12.2'); module.git(source, 'checkout', '-q', 'local')
            with self.assertRaisesRegex(RuntimeError, 'tested recovery adapter'): module.prepare(source, 'v0.12.2', root/'candidate')
            self.assertFalse((root/'candidate').exists())
