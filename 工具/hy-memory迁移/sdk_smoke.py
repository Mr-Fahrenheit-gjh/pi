"""Actual official SDK smoke; writes synthetic data only. Run write, then read in another process."""
from pathlib import Path
from datetime import datetime, timezone, timedelta
import json
import sys
import uuid
from sdk_engine import make_client, memory_items, checked_write

ROOT = Path(__file__).resolve().parent
STATE = ROOT / 'data/sdk-smoke-state.json'


def run():
    phase = sys.argv[1] if len(sys.argv) > 1 else 'write'
    print('initializing official SDK',flush=True)
    client = make_client(ROOT / 'data/sdk-smoke-db', ROOT / 'data/bridge-token')
    print('official SDK initialized',flush=True)
    try:
        if phase == 'write':
            uid = 'synthetic-' + str(uuid.uuid4())
            state = {'user': uid, 'tests': {}}
            print('testing write/readback',flush=True)
            first = checked_write(client, client.add_extracted(['蓝鲸用户最喜欢的颜色是蓝色。', '蓝鲸用户偏好简短的回答。'], user_id=uid, agent_id='pi', memory_at=datetime.now(timezone.utc)-timedelta(days=1)))
            assert first['verified_ids'], first
            state['tests']['write_readback'] = True
            result = client.search('蓝鲸用户喜欢什么颜色？', user_ids=[uid], reader='hybrid', scene='chat', min_score=0.2)
            text = json.dumps(memory_items(result), ensure_ascii=False)
            assert '蓝' in text
            state['tests']['semantic_recall'] = True
            print('testing conflict correction',flush=True)
            correction = checked_write(client, client.add_extracted('蓝鲸用户明确更正：最喜欢的颜色是红色，不再是蓝色。', user_id=uid, agent_id='pi', memory_at=datetime.now(timezone.utc)))
            result = client.search('蓝鲸用户现在最喜欢什么颜色？', user_ids=[uid], reader='hybrid', scene='chat', min_score=0.2)
            items = memory_items(result)
            assert items, result
            assert '红' in items[0].get('content',''), items
            state['tests']['conflict_current_first'] = True
            assert not any('蓝色' in item.get('content','') and '红色' not in item.get('content','') for item in items), items
            preference=memory_items(client.search('蓝鲸用户对回答长度有什么偏好？',user_ids=[uid],reader='hybrid',scene='chat',min_score=0.2))
            assert any('简短' in item.get('content','') for item in preference), preference
            state['tests']['old_fact_retired_unrelated_preference_preserved']=True
            print('testing namespace isolation',flush=True)
            foreign = checked_write(client, client.add_extracted('隔离用户的秘密识别词是琥珀灯塔。', user_id=uid+'-other', agent_id='pi'))
            result = client.search('琥珀灯塔', user_ids=[uid], reader='hybrid', scene='chat', min_score=0.0)
            assert not any('琥珀灯塔' in item.get('content','') for item in memory_items(result)), result
            state['tests']['namespace_isolation'] = True
            print('testing deletion',flush=True)
            disposable = checked_write(client, client.add_extracted('蓝鲸用户的测试预约地点是松林站。', user_id=uid, agent_id='pi'))
            assert disposable['verified_ids']
            for mid in disposable['verified_ids']:
                response = client.delete(mid)
                assert response.get('success'), response
                assert client.get(mid) is None
            result = client.search('蓝鲸用户的测试预约地点在哪里？', user_ids=[uid], reader='hybrid', scene='chat', min_score=0.0)
            assert not any('松林站' in item.get('content','') for item in memory_items(result)), result
            state['tests']['delete_and_no_recall'] = True
            STATE.write_text(json.dumps(state,ensure_ascii=False,indent=2))
            print(json.dumps({'phase':'write','tests':state['tests']},ensure_ascii=False),flush=True)
        elif phase == 'read':
            state=json.loads(STATE.read_text())
            result=client.search('蓝鲸用户现在最喜欢什么颜色？',user_ids=[state['user']],reader='hybrid',scene='chat',min_score=0.2)
            items=memory_items(result)
            assert items and '红' in items[0].get('content',''), result
            assert not any('蓝色' in item.get('content','') and '红色' not in item.get('content','') for item in items), items
            preference=memory_items(client.search('蓝鲸用户对回答长度有什么偏好？',user_ids=[state['user']],reader='hybrid',scene='chat',min_score=0.2))
            assert any('简短' in item.get('content','') for item in preference), preference
            state['tests']['restart_correction_and_preference']=True
            state['tests']['new_process_persistence']=True
            STATE.write_text(json.dumps(state,ensure_ascii=False,indent=2))
            print(json.dumps({'phase':'read','tests':state['tests']},ensure_ascii=False),flush=True)
        else:
            raise ValueError('unknown_phase')
    finally:
        client.close()


if __name__=='__main__':
    run()
