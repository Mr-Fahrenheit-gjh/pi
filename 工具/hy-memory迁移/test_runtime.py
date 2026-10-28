import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import install_runtime as runtime


class RuntimeTests(unittest.TestCase):
    def fixture(self,home):
        base=home/'runtime';base.mkdir()
        target=home/'Library/LaunchAgents/cn.pi.hy-memory.plist'
        target.parent.mkdir(parents=True);target.write_bytes(b'managed')
        state={'phases':{'engine_registered':True},'plist_sha256':{'engine':hashlib.sha256(b'managed').hexdigest()}}
        (base/'install-state.json').write_text(json.dumps(state))
        return base,target,state

    def test_stop_failure_preserves_configuration_and_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);base,target,state=self.fixture(home)
            with patch.object(runtime,'BASE',base),patch.object(Path,'home',return_value=home),patch.object(runtime,'registered',return_value=True),patch.object(runtime.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','failed')):
                with self.assertRaisesRegex(RuntimeError,'stop_failed'):
                    runtime.stop('engine')
            self.assertTrue(target.exists())
            self.assertEqual(json.loads((base/'install-state.json').read_text()),state)

    def test_missing_plist_active_never_reports_stopped(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);base,target,state=self.fixture(home);target.unlink()
            with patch.object(runtime,'BASE',base),patch.object(Path,'home',return_value=home),patch.object(runtime,'registered',return_value=True):
                with self.assertRaisesRegex(RuntimeError,'missing_managed_plist'):
                    runtime.stop('engine')
            self.assertEqual(json.loads((base/'install-state.json').read_text()),state)

    def test_confirmed_stop_clears_only_managed_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp);base,target,state=self.fixture(home)
            with patch.object(runtime,'BASE',base),patch.object(Path,'home',return_value=home),patch.object(runtime,'registered',side_effect=[True,False]),patch.object(runtime.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'','')):
                runtime.stop('engine')
            self.assertFalse(target.exists())
            self.assertFalse(json.loads((base/'install-state.json').read_text())['phases']['engine_registered'])

    def test_candidate_has_distinct_store_and_reuses_managed_engine_entry(self):
        value=runtime.plist('candidate')
        self.assertEqual(value['Label'],'cn.pi.hy-memory-candidate')
        self.assertEqual(value['EnvironmentVariables']['HY_MEMORY_HOME'],str(runtime.BASE/'candidate-data'))
        self.assertEqual(value['ProgramArguments'],['/bin/bash',str(runtime.BASE/'runtime/engine.sh')])

    def test_unknown_launchctl_error_is_not_absence(self):
        with patch.object(runtime.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','permission denied')):
            with self.assertRaisesRegex(RuntimeError,'status_uncertain'):
                runtime.registered('gui/501/cn.pi.hy-memory')


if __name__=='__main__':unittest.main()
