from pathlib import Path
import json
import tempfile
import unittest
import uuid
from sdk_service import Service


class ProvenanceTests(unittest.TestCase):
    def fixture(self,directory):
        service=Service.__new__(Service);service.root=Path(directory);service.ledger=service.root/'receipts.sqlite3';service.import_provenance={}
        with service.db() as db:db.execute('CREATE TABLE sources (memory_id TEXT PRIMARY KEY, request_id TEXT NOT NULL)')
        return service

    def test_migrated_fact_links_to_dated_original_without_rewriting_sdk_fact(self):
        with tempfile.TemporaryDirectory() as directory:
            service=self.fixture(directory);request_id=str(uuid.uuid4())
            service.import_provenance[request_id]={'owner':'pi-archive','source_ref':'daily/2026-08-17.md','memory_at':'2026-08-17T00:00:00+08:00'}
            original={'memory_id':'fact','user_id':'pi-archive','content':'synthetic fact','custom':{'request_id':request_id}}
            result=service.with_provenance(original)
            self.assertEqual(result['provenance']['source_ref'],'daily/2026-08-17.md')
            self.assertNotIn('owner',result['provenance']);self.assertNotIn('provenance',original)
            self.assertEqual(result['content'],original['content'])

    def test_canonical_id_link_survives_missing_sdk_custom_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            service=self.fixture(directory)
            service.import_provenance['memory:fact']={'owner':'pi-global','source_ref':'MEMORY.md'}
            result=service.with_provenance({'memory_id':'fact','user_id':'pi-global'})
            self.assertEqual(result['provenance']['source_ref'],'MEMORY.md')

    def test_foreign_owner_original_is_never_exposed(self):
        with tempfile.TemporaryDirectory() as directory:
            service=self.fixture(directory);request_id=str(uuid.uuid4())
            service.import_provenance[request_id]={'owner':'pi-project-other','source_ref':'secret'}
            memory={'memory_id':'fact','user_id':'pi-global','custom':{'request_id':request_id}}
            self.assertNotIn('provenance',service.with_provenance(memory))

    def test_explicit_update_source_overrides_older_sdk_custom_request(self):
        with tempfile.TemporaryDirectory() as directory:
            service=self.fixture(directory);old=str(uuid.uuid4());new=str(uuid.uuid4());(service.root/'entries').mkdir()
            service.import_provenance['memory:fact']={'owner':'pi-global','source_ref':'MEMORY.md'}
            (service.root/'entries'/(new+'.json')).write_text(json.dumps({'owner':'pi-global','origin':'pi-tool-update','content':'synthetic correction'}))
            with service.db() as db:db.execute('INSERT INTO sources VALUES (?,?)',('fact',new))
            memory={'memory_id':'fact','user_id':'pi-global','custom':{'request_id':old}}
            result=service.with_provenance(memory)
            self.assertEqual(result['provenance'],{'source_ref':'entry:'+new,'origin':'pi-tool-update'})


if __name__=='__main__':unittest.main()
