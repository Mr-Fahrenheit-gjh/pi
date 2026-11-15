from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
import json
import os
import tempfile
import unittest
from unittest.mock import Mock,patch
import activate
import migrate_sdk

SESSION='00000000-0000-4000-8000-000000000001'


class ActivationTests(unittest.TestCase):
    def fixture(self,root):
        (root/'.next').mkdir();(root/'.next/BUILD_ID').write_text('unchanged-build');(root/'package.json').write_text('{}')
        core=SimpleNamespace(LIVE=root,preflight_launchd=Mock(),start=Mock(),healthy=Mock())
        guard=SimpleNamespace(core=core,DEPLOY_LOCK=root/'deploy.lock',wait_idle=Mock(),stop_with_idle_retry=Mock())
        stack=ExitStack()
        stack.enter_context(patch.object(activate,'STATE',root/'activation.json'))
        stack.enter_context(patch.object(activate,'load_guard',return_value=guard))
        stack.enter_context(patch.dict(os.environ,PI_SESSION_ID=SESSION))
        stack.enter_context(patch.object(activate.cutover,'source_check'))
        stack.enter_context(patch.object(activate.cutover,'verify_migration'))
        stack.enter_context(patch.object(migrate_sdk,'api',return_value={'status':'ok'}))
        switch=stack.enter_context(patch.object(activate.cutover,'switch'))
        rollback=stack.enter_context(patch.object(activate.cutover,'rollback'))
        run=stack.enter_context(patch.object(activate.subprocess,'run'))
        return stack,guard,switch,rollback,run

    def test_success_uses_idle_guard_and_keeps_web_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);stack,guard,switch,rollback,run=self.fixture(root)
            with stack:activate.activate(SESSION)
            guard.wait_idle.assert_called_once();guard.stop_with_idle_retry.assert_called_once();switch.assert_called_once()
            self.assertEqual(json.loads((root/'activation.json').read_text())['status'],'verified_live')
            rollback.assert_not_called()

    def test_failure_after_bootout_still_restores_web(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);stack,guard,switch,rollback,run=self.fixture(root)
            guard.stop_with_idle_retry.side_effect=RuntimeError('wait_stopped_failed_after_bootout')
            with stack,self.assertRaises(RuntimeError):activate.activate(SESSION)
            guard.core.start.assert_called_once();switch.assert_not_called()
            self.assertEqual(json.loads((root/'activation.json').read_text())['status'],'failed_original_settings_preserved')

    def test_failed_live_probe_rolls_back_only_after_new_idle_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);stack,guard,switch,rollback,run=self.fixture(root)
            run.side_effect=RuntimeError('live_probe_failed')
            with stack,self.assertRaises(RuntimeError):activate.activate(SESSION)
            self.assertEqual(guard.wait_idle.call_count,2);self.assertEqual(guard.stop_with_idle_retry.call_count,2)
            rollback.assert_called_once();self.assertEqual(guard.core.start.call_count,2)

    def test_other_active_work_prevents_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);stack,guard,switch,rollback,run=self.fixture(root)
            guard.wait_idle.side_effect=RuntimeError('other_work_active')
            with stack,self.assertRaises(RuntimeError):activate.activate(SESSION)
            guard.stop_with_idle_retry.assert_not_called();switch.assert_not_called();guard.core.start.assert_not_called()


if __name__=='__main__':unittest.main()
