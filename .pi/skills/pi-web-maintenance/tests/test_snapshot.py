import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('snapshot', Path(__file__).resolve().parents[1] / 'scripts/snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pi-web-skill-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.maintenance = self.root / '工具/pi-web维护/native-agent-switcher'
        self.source = self.maintenance.parent / 'source'
        self.candidate = self.maintenance / 'candidate'
        self.live = self.root / 'live'
        self.put(self.maintenance / 'local-update.json', {'sourceDirectory': '../source', 'candidateDirectory': 'candidate', 'targetVersion': '0.12.1'})
        self.source.mkdir()

    def put(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def build(self, root, name):
        path = root / '.next/BUILD_ID'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
        self.put(root / 'package.json', {'version': '0.12.1', 'dependencies': {'existing': '1.0.0'}})

    def ready(self):
        self.build(self.candidate, 'new-build')
        self.build(self.live, 'new-build')
        candidate = {'passed': True, 'buildId': 'new-build', 'packageRoot': str(self.candidate), 'launchd': True}
        for path in [self.maintenance / 'smoke-result.json', self.maintenance / 'runtime-probe-result.json', self.source / 'test-results/quiet-tools/result.json']:
            self.put(path, candidate)
        self.put(self.maintenance / 'upgrade-0.12-state.json', {'status': 'deployed', 'verifiedLive': True, 'buildId': 'new-build', 'version': '0.12.1', 'sessionId': 'history'})
        self.put(self.maintenance / 'live-result.json', {**candidate, 'packageRoot': str(self.live), 'version': '0.12.1', 'sessionId': 'history', 'realChildVerified': True, 'mocked': False, 'base': 'http://127.0.0.1:30141'})

    def read(self):
        return module.snapshot(self.root, self.live)

    def test_missing_candidate_does_not_look_verified(self):
        result = self.read()
        self.assertFalse(result['candidate']['exists'])
        self.assertFalse(any(result['candidate']['required_evidence_matches'].values()))
        self.assertFalse(result['deployment']['records_match_installed_files'])

    def test_complete_binding_is_recognized_without_claiming_health(self):
        self.ready()
        result = self.read()
        self.assertTrue(all(result['candidate']['required_evidence_matches'].values()))
        self.assertTrue(result['deployment']['records_match_installed_files'])
        self.assertIn('Not a process or HTTP health check', result['limits'])

    def test_stale_candidate_evidence_is_rejected(self):
        self.ready()
        self.put(self.maintenance / 'smoke-result.json', {'passed': True, 'buildId': 'old-build', 'packageRoot': str(self.candidate)})
        self.assertFalse(self.read()['candidate']['required_evidence_matches']['smoke'])

    def test_wrong_runtime_path_or_non_launchd_proof_is_rejected(self):
        self.ready()
        self.put(self.maintenance / 'runtime-probe-result.json', {'passed': True, 'buildId': 'new-build', 'packageRoot': str(self.live), 'launchd': True})
        self.assertFalse(self.read()['candidate']['required_evidence_matches']['runtime'])
        self.put(self.maintenance / 'runtime-probe-result.json', {'passed': True, 'buildId': 'new-build', 'packageRoot': str(self.candidate), 'launchd': False})
        self.assertFalse(self.read()['candidate']['required_evidence_matches']['runtime'])

    def test_installed_build_drift_cannot_be_reported_as_deployed(self):
        self.ready()
        self.build(self.live, 'other-build')
        self.assertFalse(self.read()['deployment']['records_match_installed_files'])

    def test_malformed_record_reports_warning_and_never_writes(self):
        self.ready()
        path = self.maintenance / 'live-result.json'
        path.write_text('{broken')
        before = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = self.read()
        self.assertFalse(result['deployment']['records_match_installed_files'])
        self.assertTrue(result['warnings'])
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()})


if __name__ == '__main__':
    unittest.main()
