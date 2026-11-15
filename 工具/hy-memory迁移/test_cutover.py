import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cutover
import migrate_sdk

IDENTITY={'schema':1,'manifest_sha256':'manifest','jobs_sha256':'jobs','request_ids':['one','two']}
RECEIPTS=[{'request_id':i,'state':'completed'} for i in IDENTITY['request_ids']]


class CutoverTests(unittest.TestCase):
    def fixture(self,root):
        base=root/'runtime';base.mkdir();(base/'data').mkdir();backup=root/'backup';backup.mkdir();(root/'data').mkdir()
        settings=root/'settings.json'
        original=json.dumps({'packages':['npm:notesoup@0.51.2',cutover.OLD,'other-extension'],'model':'unchanged','nested':{'x':1}}).encode()
        settings.write_bytes(original);(backup/'settings.json').write_bytes(original)
        (root/'data/migration-receipts.json').write_text(json.dumps(RECEIPTS))
        (root/'data/migration-summary.json').write_text(json.dumps({'identity':IDENTITY,'unknown':0,'completed':2,'requests':2}))
        (base/'data/staged-migration.json').write_text(json.dumps({'identity':IDENTITY,'target':str(base/'data')}))
        return base,backup,settings,original

    def test_switch_preserves_other_settings_and_rollback_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base,backup,settings,original=self.fixture(root)
            def api(action,body):return {'state':'completed'} if body.get('request_id') else {'status':'ok','receipts':{'completed':2}}
            with patch.object(cutover,'ROOT',root),patch.object(cutover,'BASE',base),patch.object(cutover,'SETTINGS',settings),patch.object(cutover,'source_check',return_value=backup),patch.object(cutover,'require_quiesced'),patch.object(cutover,'verify_archive'),patch.object(migrate_sdk,'migration_identity',return_value=IDENTITY),patch.object(migrate_sdk,'api',side_effect=api):
                cutover.switch()
                actual=json.loads(settings.read_text());expected=json.loads(original)
                expected['packages']=[cutover.NEW if p==cutover.OLD else p for p in expected['packages']]
                self.assertEqual(actual,expected)
                cutover.rollback();self.assertEqual(settings.read_bytes(),original)

    def test_concurrent_settings_change_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base,backup,settings,original=self.fixture(root)
            def api(action,body):
                settings.write_bytes(b'new user settings')
                return {'state':'completed'} if body.get('request_id') else {'status':'ok'}
            with patch.object(cutover,'ROOT',root),patch.object(cutover,'BASE',base),patch.object(cutover,'SETTINGS',settings),patch.object(cutover,'source_check',return_value=backup),patch.object(cutover,'require_quiesced'),patch.object(cutover,'verify_archive'),patch.object(migrate_sdk,'migration_identity',return_value=IDENTITY),patch.object(migrate_sdk,'api',side_effect=api):
                with self.assertRaisesRegex(RuntimeError,'settings_changed_during_switch'):cutover.switch()
            self.assertEqual(settings.read_bytes(),b'new user settings')
            self.assertFalse((base/'settings-before-cutover.json').exists())

    def test_concurrent_source_change_refuses_switch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base,backup,settings,original=self.fixture(root)
            with patch.object(cutover,'ROOT',root),patch.object(cutover,'BASE',base),patch.object(cutover,'SETTINGS',settings),patch.object(cutover,'source_check',side_effect=[backup,RuntimeError('source_changed')]),patch.object(cutover,'require_quiesced'),patch.object(cutover,'verify_archive'),patch.object(migrate_sdk,'migration_identity',return_value=IDENTITY),patch.object(migrate_sdk,'api',return_value={'status':'ok','state':'completed'}):
                with self.assertRaisesRegex(RuntimeError,'source_changed'):cutover.switch()
            self.assertEqual(settings.read_bytes(),original)

    def test_incomplete_duplicate_stale_and_empty_receipts_rejected(self):
        for rows in [[],RECEIPTS[:1],[RECEIPTS[0],RECEIPTS[0]],[{'request_id':'old','state':'completed'},RECEIPTS[1]]]:
            with self.subTest(rows=rows),tempfile.TemporaryDirectory() as tmp:
                root=Path(tmp);self.fixture(root)
                (root/'data/migration-receipts.json').write_text(json.dumps(rows))
                with patch.object(cutover,'ROOT',root),patch.object(migrate_sdk,'migration_identity',return_value=IDENTITY):
                    with self.assertRaisesRegex(RuntimeError,'receipt_set'):cutover.verify_migration()

    def test_stale_summary_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);self.fixture(root)
            (root/'data/migration-summary.json').write_text(json.dumps({'identity':{},'unknown':0,'completed':2,'requests':2}))
            with patch.object(cutover,'ROOT',root),patch.object(migrate_sdk,'migration_identity',return_value=IDENTITY):
                with self.assertRaisesRegex(RuntimeError,'summary'):cutover.verify_migration()

    def test_missing_stage_marker_refuses_switch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base,backup,settings,original=self.fixture(root)
            (base/'data/staged-migration.json').unlink()
            with patch.object(cutover,'ROOT',root),patch.object(cutover,'BASE',base),patch.object(cutover,'SETTINGS',settings),patch.object(cutover,'source_check',return_value=backup),patch.object(cutover,'require_quiesced'),patch.object(migrate_sdk,'migration_identity',return_value=IDENTITY):
                with self.assertRaises(FileNotFoundError):cutover.switch()
            self.assertEqual(settings.read_bytes(),original)

    def test_live_writer_refuses_switch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base,backup,settings,original=self.fixture(root)
            with patch.object(cutover,'BASE',base),patch.object(cutover,'require_quiesced',side_effect=RuntimeError('live_writer')):
                with self.assertRaisesRegex(RuntimeError,'live_writer'):cutover.switch()
            self.assertEqual(settings.read_bytes(),original)

    def test_rollback_refuses_newer_user_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);settings=base/'settings.json';settings.write_text('new user changes')
            (base/'cutover-state.json').write_text(json.dumps({'after_sha256':hashlib.sha256(b'expected').hexdigest()}))
            with patch.object(cutover,'BASE',base),patch.object(cutover,'SETTINGS',settings),patch.object(cutover,'require_quiesced'):
                with self.assertRaisesRegex(RuntimeError,'settings_changed'):cutover.rollback()
            self.assertEqual(settings.read_text(),'new user changes')

    def test_rollback_refuses_to_hide_post_cutover_memory_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);settings=base/'settings.json';settings.write_bytes(b'new');(base/'settings-before-cutover.json').write_bytes(b'old')
            (base/'cutover-state.json').write_text(json.dumps({'identity':IDENTITY,'after_sha256':hashlib.sha256(b'new').hexdigest(),'before_sha256':hashlib.sha256(b'old').hexdigest()}))
            with patch.object(cutover,'BASE',base),patch.object(cutover,'SETTINGS',settings),patch.object(cutover,'require_quiesced'),patch.object(migrate_sdk,'api',return_value={'status':'ok','receipts':{'completed':3}}):
                with self.assertRaisesRegex(RuntimeError,'new_memory_writes'):cutover.rollback()
            self.assertEqual(settings.read_bytes(),b'new')

    def test_concurrent_rollback_change_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp);settings=base/'settings.json';settings.write_bytes(b'new');(base/'settings-before-cutover.json').write_bytes(b'old')
            (base/'cutover-state.json').write_text(json.dumps({'identity':IDENTITY,'after_sha256':hashlib.sha256(b'new').hexdigest(),'before_sha256':hashlib.sha256(b'old').hexdigest()}))
            calls=[]
            def quiesced():
                calls.append(True)
                if len(calls)==2:settings.write_bytes(b'newer')
            with patch.object(cutover,'BASE',base),patch.object(cutover,'SETTINGS',settings),patch.object(cutover,'require_quiesced',side_effect=quiesced),patch.object(migrate_sdk,'api',return_value={'status':'ok','receipts':{'completed':2}}):
                with self.assertRaisesRegex(RuntimeError,'settings_changed_during_rollback'):cutover.rollback()
            self.assertEqual(settings.read_bytes(),b'newer')


if __name__=='__main__':unittest.main()
