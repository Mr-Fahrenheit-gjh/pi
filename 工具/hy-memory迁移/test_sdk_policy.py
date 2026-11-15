import unittest
from types import SimpleNamespace
from sdk_engine import checked_write, strict_reconcile_result
from sdk_service import Service


class PolicyTests(unittest.TestCase):
    def test_degraded_reconcile_cannot_persist_fallback(self):
        value=SimpleNamespace(success=True,degraded=True,error=None,ops=['unsafe ADD'])
        self.assertIs(strict_reconcile_result(value),value)
        self.assertFalse(value.success)
        self.assertEqual(value.ops,[])

    def test_normal_reconcile_is_unchanged(self):
        value=SimpleNamespace(success=True,degraded=False,error=None,ops=['UPDATE'])
        self.assertEqual(strict_reconcile_result(value).ops,['UPDATE'])

    def test_canonical_readback_does_not_expose_private_l1(self):
        class Client:
            def get(self,identifier):
                self.seen=identifier
                return {'content':'saved fact'} if identifier=='public-fact' else None
        client=Client()
        result=checked_write(client,{'success':True,'memory_id':'private-raw','memory_ids':['public-fact'],'agent_status':'success'})
        self.assertEqual(result['verified_ids'],['public-fact'])
        self.assertEqual(client.seen,'public-fact')

    def test_failed_write_never_reported_as_saved(self):
        with self.assertRaises(RuntimeError):
            checked_write(None,{'success':False})

    def test_validation_failure_does_not_create_unknown_receipt(self):
        import tempfile
        import threading
        import uuid
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            service=Service.__new__(Service)
            service.ledger=Path(directory)/'receipts.sqlite3'
            service.operation_lock=threading.Lock()
            service.accepting=True
            service.client=SimpleNamespace(get=lambda identifier:None)
            with service.db() as db:
                db.execute('CREATE TABLE receipts (id TEXT PRIMARY KEY, fingerprint TEXT, state TEXT, result TEXT)')
            for action,extra in [('write',{'content':''}),('write',{'content':'valid','memory_at':'bad-date'}),('update',{'memory_id':'missing','content':'valid'}),('delete',{'memory_id':'missing'})]:
                request_id=str(uuid.uuid4())
                with self.assertRaises(ValueError):
                    service.execute(action,{'project':'/tmp','scope':'global','request_id':request_id,**extra})
                self.assertEqual(service.status(request_id)['state'],'not_found')
            with service.db() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM receipts').fetchone()[0],0)

    def test_project_scope_isolation_and_no_arbitrary_user_id(self):
        one=Service.namespaces({'project':'/tmp/one','scope':'project'})
        two=Service.namespaces({'project':'/tmp/two','scope':'project'})
        self.assertNotEqual(one,two)
        self.assertEqual(Service.namespaces({'project':'/tmp/one','scope':'global'}),['pi-global'])
        with self.assertRaises(ValueError):
            Service.namespaces({'project':'/tmp/one','scope':'someone-else'})


if __name__=='__main__':
    unittest.main()
