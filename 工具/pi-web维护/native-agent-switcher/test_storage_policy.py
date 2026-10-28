import importlib.util
import json
from pathlib import Path
import tempfile
import time
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage_policy', Path(__file__).with_name('storage_policy.py'))
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StoragePolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.here = self.home / 'maintenance/native-agent-switcher'
        self.here.mkdir(parents=True)
        self.backups = self.home / '.pi/backups'
        self.candidates = self.home / '.pi/pi-web-candidates'
        self.backups.mkdir(parents=True)
        self.candidates.mkdir(parents=True)
        self.current = self.candidate('current', 'new')
        (self.here / 'local-update.json').write_text(json.dumps({'candidateDirectory': str(self.current / 'package')}))
        self.live = self.home / 'live'
        self.live.mkdir()

    def package(self, root, build):
        (root / '.next').mkdir(parents=True)
        (root / '.next/BUILD_ID').write_text(build)

    def candidate(self, name, build):
        root = self.candidates / name
        self.package(root / 'package', build)
        return root

    def backup(self, n):
        root = self.backups / f'pi-web-upgrade-0.12-20261019-{n:06d}'
        self.package(root / 'package', str(n))
        for name in storage.REQUIRED_PACKAGE_FILES:
            target = root / 'package' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_text(json.dumps({'name': 'fixture', 'version': '0.12.1'}) if name.endswith('package.json') else '{}')
        (root / 'manifest.json').write_text(json.dumps({'backup': str(root), 'oldBuild': str(n), 'buildId': str(n + 1)}))
        return root

    def run_cleanup(self, apply=False, references=''):
        return storage.cleanup(self.here, self.home, self.live, references, apply)

    def test_two_backups_and_current_candidate_retained_with_idempotence(self):
        backups = [self.backup(n) for n in range(1, 5)]
        old = self.candidate('old', '1')
        (old / 'evidence.json').write_text('{}')
        plan = self.run_cleanup()
        self.assertEqual(len(plan['remove']), 3)
        self.assertTrue(backups[0].exists())  # dry run
        self.run_cleanup(apply=True)
        self.assertFalse(backups[0].exists())
        self.assertTrue(backups[2].exists())
        self.assertTrue(backups[3].exists())
        self.assertFalse((old / 'package').exists())
        self.assertTrue((old / 'evidence.json').exists())
        self.assertTrue(self.current.exists())
        self.assertEqual(self.run_cleanup()['remove'], [])

    def accept_live(self, status='deployed', verified=True, build='live'):
        if not (self.live / '.next').exists():
            self.package(self.live, 'live')
        (self.here / 'upgrade-0.12-state.json').write_text(json.dumps({
            'status': status, 'verifiedLive': verified, 'buildId': build,
            'backup': str(self.backups / 'pi-web-upgrade-0.12-20261019-000002')}))

    def test_verified_deployment_removes_all_rollbacks_and_is_idempotent(self):
        backups = [self.backup(n) for n in (1, 2)]
        self.accept_live()
        self.assertEqual(set(self.run_cleanup()['remove']), set(map(str, backups)))
        self.run_cleanup(apply=True)
        self.assertTrue(all(not p.exists() for p in backups))
        self.assertTrue(self.live.exists())
        self.assertTrue(self.current.exists())
        self.assertEqual(self.run_cleanup()['remove'], [])

    def test_unverified_mismatched_or_unfinished_release_keeps_rollbacks(self):
        backups = [self.backup(n) for n in (1, 2)]
        for status, verified, build in [('deployed', False, 'live'),
                                         ('deployed', True, 'different'),
                                         ('verifying_live', True, 'live'),
                                         ('rolled_back', True, 'live')]:
            with self.subTest(status=status, verified=verified, build=build):
                self.accept_live(status, verified, build)
                self.assertEqual(set(self.run_cleanup()['keepBackups']), set(map(str, backups)))
        self.accept_live()
        (self.here / 'deployment-state.json').write_text(json.dumps({'status': 'switching'}))
        self.assertEqual(set(self.run_cleanup()['keepBackups']), set(map(str, backups)))

    def test_success_does_not_override_process_pending_or_validation_protection(self):
        old = self.backup(1)
        self.accept_live()
        self.assertNotIn(str(old), self.run_cleanup(references=str(old / 'package/server.js'))['remove'])
        with (old / 'package/.validation-lock').open('w') as lock:
            storage.fcntl.flock(lock, storage.fcntl.LOCK_EX)
            self.assertNotIn(str(old), self.run_cleanup()['remove'])
        pending = self.here.parent / '待上线'; pending.mkdir()
        (pending / 'a.json').write_text(json.dumps({'status': 'pending', 'codeLocations': [str(old)]}))
        self.assertNotIn(str(old), self.run_cleanup()['remove'])

    def test_zero_retention_journal_cannot_override_new_unfinished_release(self):
        backups = [self.backup(n) for n in (1, 2)]
        self.accept_live()
        with patch.object(storage.shutil, 'rmtree', side_effect=OSError('interrupted')):
            with self.assertRaisesRegex(OSError, 'interrupted'):
                self.run_cleanup(apply=True)
        self.accept_live(status='prepared')
        self.assertEqual(self.run_cleanup()['remove'], [])
        self.run_cleanup(apply=True)
        self.assertTrue(all(path.exists() for path in backups))
        self.accept_live()
        self.run_cleanup(apply=True)
        self.assertTrue(all(not path.exists() for path in backups))

    def test_unknown_candidate_and_invalid_backup_never_deleted(self):
        self.backup(1); self.backup(2); self.backup(3)
        unknown = self.candidate('unfinished', 'unknown')
        broken = self.backup(4)
        (broken / 'withdrawn-package').mkdir()
        plan = self.run_cleanup()
        self.assertIn(str(unknown), plan['unknown'])
        self.assertIn(str(broken), plan['unknown'])

    def test_incomplete_backup_does_not_take_valid_retention_slot(self):
        old, middle, broken = self.backup(1), self.backup(2), self.backup(3)
        (broken / 'package/bin/pi-web.js').unlink()
        plan = self.run_cleanup()
        self.assertIn(str(broken), plan['unknown'])
        self.assertIn(str(old), plan['keepBackups'])
        self.assertIn(str(middle), plan['keepBackups'])
        self.assertNotIn(str(old), plan['remove'])

    def test_current_rollback_pending_and_process_references_protected(self):
        old = self.backup(1)
        self.backup(2); self.backup(3)
        (self.here / 'upgrade-0.12-state.json').write_text(json.dumps({'status': 'deployed', 'backup': str(old)}))
        candidate = self.candidate('busy', '2')
        self.assertNotIn(str(old), self.run_cleanup()['remove'])
        self.assertNotIn(str(candidate / 'package'), self.run_cleanup(references=str(candidate / 'package/server.js'))['remove'])
        pending = self.here.parent / '待上线'
        pending.mkdir()
        (pending / 'a.json').write_text(json.dumps({'status': 'pending', 'codeLocations': [str(candidate)]}))
        self.assertNotIn(str(candidate / 'package'), self.run_cleanup()['remove'])

    def test_symlink_root_and_corrupt_pending_fail_closed(self):
        saved = self.candidates.with_name('saved-candidates')
        self.candidates.rename(saved)
        self.candidates.symlink_to(self.live)
        with self.assertRaises(RuntimeError):
            self.run_cleanup()
        self.candidates.unlink(); self.candidates.mkdir()
        pending = self.here.parent / '待上线'; pending.mkdir()
        (pending / 'a.json').write_text('bad json')
        with self.assertRaises(ValueError):
            self.run_cleanup()

    def test_interrupted_removal_resumes_but_replacement_is_not_approved(self):
        old = self.candidate('partial', '1')
        package = old / 'package'
        identity = package.stat()
        (package / '.next/BUILD_ID').unlink()
        journal = self.here / 'storage-removal.json'
        journal.write_text(json.dumps({'path': str(package), 'identity': [identity.st_dev, identity.st_ino]}))
        self.assertIn(str(package), self.run_cleanup()['remove'])
        package.rename(old / 'replaced')
        package.mkdir()
        self.assertNotIn(str(package), self.run_cleanup()['remove'])

    def test_multiple_interrupted_targets_survive_other_deletions(self):
        targets = []
        for name in ('partial-a', 'partial-b'):
            package = self.candidate(name, '1') / 'package'
            identity = package.stat()
            (package / '.next/BUILD_ID').unlink()
            targets.append({'path': str(package), 'identity': [identity.st_dev, identity.st_ino]})
        (self.here / 'storage-removal.json').write_text(json.dumps({'targets': targets}))
        self.backup(1); self.backup(2); self.backup(3)
        self.run_cleanup(apply=True)
        for intent in targets:
            self.assertFalse(Path(intent['path']).exists())
        self.assertFalse((self.here / 'storage-removal.json').exists())

    def test_validation_lock_protects_superseded_candidate(self):
        self.backup(1)
        old = self.candidate('validating', '1')
        with (old / 'package/.validation-lock').open('w') as lock:
            storage.fcntl.flock(lock, storage.fcntl.LOCK_EX)
            self.assertNotIn(str(old / 'package'), self.run_cleanup()['remove'])
        self.assertIn(str(old / 'package'), self.run_cleanup()['remove'])

    def historical_workspace_candidate(self, build='1', name='old-feature'):
        root = self.here.parent / name / 'candidate'
        self.package(root, build)
        for name in storage.REQUIRED_PACKAGE_FILES:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_text(json.dumps({'name': '@agegr/pi-web', 'version': '0.12.1'}) if name.endswith('package.json') else '{}')
        (root / 'package-lock.json').write_text('{}')
        (root / 'source.ts').write_text('keep source')
        (root.parent / 'evidence.json').write_text('{}')
        subprocess.run(['git', 'init', '-q', str(self.here.parent)], check=True)
        (self.here.parent / '.gitignore').write_text('.next/\nnode_modules/\n')
        return root

    def weekly(self, apply=False, references=''):
        with patch.object(storage.time, 'time', return_value=time.time() + 15 * 86400):
            return storage.cleanup(self.here, self.home, self.live, references, apply, include_history=True)

    def test_weekly_removes_obsolete_workspace_payload_only(self):
        self.backup(1)
        root = self.historical_workspace_candidate()
        self.assertNotIn(str(root / '.next'), self.run_cleanup()['remove'])
        plan = self.weekly()
        self.assertIn(str(root / '.next'), plan['remove'])
        self.assertIn(str(root / 'node_modules'), plan['remove'])
        generic_cwd = self.weekly(references='n' + str(self.here.parent))
        self.assertIn(str(root / '.next'), generic_cwd['remove'])
        self.assertTrue((root / '.next').exists())
        self.weekly(apply=True)
        self.assertFalse((root / '.next').exists())
        self.assertFalse((root / 'node_modules').exists())
        self.assertTrue((root / 'source.ts').exists())
        self.assertTrue((root / 'package-lock.json').exists())
        self.assertTrue((root.parent / 'evidence.json').exists())
        self.assertEqual(self.weekly()['remove'], [])

    def test_weekly_keeps_fresh_unknown_tracked_and_symlinked_payloads(self):
        self.backup(1)
        root = self.historical_workspace_candidate()
        plan = storage.cleanup(self.here, self.home, self.live, '', include_history=True)
        self.assertNotIn(str(root / '.next'), plan['remove'])
        (root / '.next/BUILD_ID').write_text('unknown')
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])
        (root / '.next/BUILD_ID').write_text('1')
        subprocess.run(['git', '-C', str(root), 'add', '-f', '.next/BUILD_ID'], check=True)
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])
        subprocess.run(['git', '-C', str(root), 'rm', '--cached', '-q', '.next/BUILD_ID'], check=True)
        (root / 'node_modules').rename(root / 'saved-dependencies')
        (root / 'node_modules').symlink_to(root / 'saved-dependencies', target_is_directory=True)
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])

    def test_weekly_parent_pending_and_validation_lock_protect_candidate(self):
        self.backup(1)
        root = self.historical_workspace_candidate()
        pending = self.here.parent / '待上线'; pending.mkdir()
        entry = pending / 'a.json'
        entry.write_text(json.dumps({'status': 'pending', 'codeLocations': [str(root.parent)]}))
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])
        entry.write_text(json.dumps({'status': 'pending', 'codeLocations': ['old-feature/candidate']}))
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])
        entry.unlink()
        self.assertNotIn(str(root / '.next'), self.weekly(references=str(root / 'node_modules/next/server.js'))['remove'])
        with (root / '.validation-lock').open('w') as lock:
            storage.fcntl.flock(lock, storage.fcntl.LOCK_EX)
            self.assertNotIn(str(root / '.next'), self.weekly()['remove'])

    def test_weekly_failed_payload_and_extra_backup_preserve_metadata(self):
        old = self.backup(1); self.backup(2); self.backup(3)
        (old / 'design-deck').mkdir()
        (old / 'design-deck/config.json').write_text('keep')
        failed = self.backups / 'pi-web-failed-0.12-20261019-000004'
        failed.mkdir()
        import shutil
        shutil.copytree(old / 'package', failed / 'withdrawn-package')
        (failed / 'manifest.json').write_text(json.dumps({'oldBuild': '2', 'buildId': '1'}))
        self.assertIn(str(old / 'package'), self.weekly()['remove'])
        self.assertIn(str(failed / 'withdrawn-package'), self.weekly()['remove'])
        self.weekly(apply=True)
        self.assertTrue((old / 'manifest.json').exists())
        self.assertTrue((old / 'design-deck/config.json').exists())
        self.assertTrue((failed / 'manifest.json').exists())
        self.assertFalse((failed / 'withdrawn-package').exists())

    def test_weekly_nested_git_repository_is_kept(self):
        self.backup(1)
        root = self.historical_workspace_candidate()
        nested = root / 'node_modules/local-module'
        nested.mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(nested)], check=True)
        (nested / 'source.py').write_text('unique source')
        subprocess.run(['git', '-C', str(nested), 'add', 'source.py'], check=True)
        self.assertNotIn(str(root / 'node_modules'), self.weekly()['remove'])
        self.weekly(apply=True)
        self.assertTrue((nested / 'source.py').exists())

    def test_standard_candidate_rotation_also_preserves_nested_git(self):
        self.backup(1)
        old = self.candidate('nested-source', '1')
        nested = old / 'package/node_modules/local-module'
        nested.mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(nested)], check=True)
        (nested / 'source.py').write_text('keep')
        self.assertNotIn(str(old / 'package'), self.weekly()['remove'])
        self.weekly(apply=True)
        self.assertTrue((nested / 'source.py').exists())

    def test_external_rollback_dependencies_refuse_cleanup(self):
        first, second = self.backup(1), self.backup(2)
        root = self.historical_workspace_candidate()
        import shutil
        for backup in (first, second):
            modules = backup / 'package/node_modules'
            shutil.rmtree(modules)
            modules.symlink_to(root / 'node_modules', target_is_directory=True)
            self.assertFalse(storage.usable_backup(backup / 'package'))
        with self.assertRaisesRegex(RuntimeError, 'External backup dependency'):
            self.weekly(apply=True)
        self.assertTrue((root / 'node_modules').exists())

    def test_pending_symlink_alias_protects_real_candidate(self):
        self.backup(1)
        root = self.historical_workspace_candidate()
        alias = self.here.parent / 'release-input'
        alias.symlink_to(root, target_is_directory=True)
        pending = self.here.parent / '待上线'; pending.mkdir()
        (pending / 'a.json').write_text(json.dumps({'status': 'pending', 'codeLocations': ['release-input']}))
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])
        self.weekly(apply=True)
        self.assertTrue((root / 'node_modules').exists())

    def test_weekly_journal_cannot_delete_latest_complete_rollback(self):
        old = self.backup(1); self.backup(2)
        package = old / 'package'
        identity = package.stat()
        (self.here / 'storage-removal.json').write_text(json.dumps({'targets': [
            {'path': str(package), 'identity': [identity.st_dev, identity.st_ino]}
        ]}))
        self.assertNotIn(str(package), self.weekly()['remove'])

    def test_weekly_source_repo_and_ancestor_symlink_are_kept(self):
        self.backup(1)
        root = self.historical_workspace_candidate()
        (root / '.git').write_text('gitdir: elsewhere')
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])
        (root / '.git').unlink()
        task = root.parent
        task.rename(task.with_name('moved-feature'))
        task.symlink_to(task.with_name('moved-feature'), target_is_directory=True)
        self.assertNotIn(str(root / '.next'), self.weekly()['remove'])

    def test_weekly_interrupted_payload_removal_resumes(self):
        self.backup(1)
        root = self.historical_workspace_candidate()
        original = storage.shutil.rmtree
        def interrupt(path):
            if Path(path).name == 'node_modules':
                raise OSError('interrupted removal')
            return original(path)
        with patch.object(storage.shutil, 'rmtree', side_effect=interrupt):
            with self.assertRaisesRegex(OSError, 'interrupted removal'):
                self.weekly(apply=True)
        self.assertFalse((root / '.next').exists())
        self.assertIn(str(root / 'node_modules'), self.weekly()['remove'])
        self.weekly(apply=True)
        self.assertFalse((root / 'node_modules').exists())
        self.assertFalse((self.here / 'storage-removal.json').exists())

    def test_low_space_stops_before_build(self):
        with patch.object(storage.shutil, 'disk_usage') as usage:
            usage.return_value.free = 4 * storage.GIB
            with self.assertRaisesRegex(RuntimeError, 'need 8.0 GiB'):
                storage.preflight_space(self.home)
            usage.return_value.free = 9 * storage.GIB
            storage.preflight_space(self.home)

    def test_process_probe_failure_refuses_cleanup(self):
        with patch.object(storage.subprocess, 'run') as run:
            run.return_value.returncode = 1
            run.return_value.stdout = ''
            with self.assertRaisesRegex(RuntimeError, 'Cannot inspect'):
                storage.process_references()


if __name__ == '__main__':
    unittest.main()
