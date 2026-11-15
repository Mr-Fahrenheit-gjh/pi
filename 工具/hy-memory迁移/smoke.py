"""Non-private backend integration checks. No existing memory content is read."""
from pathlib import Path
import json
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
TOKEN = (ROOT / 'data/bridge-token').read_text().strip()


def call(endpoint, body=None):
    request = urllib.request.Request(
        'http://127.0.0.1:30147' + endpoint,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'},
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=250) as response:
        result = json.load(response)
    return result, round(time.monotonic() - started, 3)


def cosine(a, b):
    return sum(x*y for x, y in zip(a, b)) / (sum(x*x for x in a)*sum(y*y for y in b))**0.5


def main():
    results = {}
    health, _ = call('/health')
    assert health['reasoning'] == 'medium'
    completion, elapsed = call('/v1/chat/completions', {
        'model': 'gpt-6.1-sol',
        'messages': [
            {'role': 'system', 'content': 'Return JSON only.'},
            {'role': 'user', 'content': 'Extract the preference: 测试用户喜欢蓝色。 Return {"preference": "..."}.'},
        ],
        'response_format': {'type': 'json_object'}, 'max_tokens': 2048,
    })
    preference = json.loads(completion['choices'][0]['message']['content'])
    assert '蓝' in str(preference) or 'blue' in str(preference).lower()
    results['chat'] = {'ok': True, 'seconds': elapsed, 'model': completion['model'], 'usage': completion.get('usage')}
    print('Chat:', results['chat'], flush=True)
    embedding, elapsed = call('/v1/embeddings', {
        'model': 'qmd-embeddinggemma-300m',
        'input': ['用户喜欢蓝色。', '用户偏爱的颜色是蓝色。', '数据库连接超时。'],
        'encoding_format': 'float',
    })
    vectors = [item['embedding'] for item in embedding['data']]
    assert all(len(vector) == 768 for vector in vectors)
    near, far = cosine(vectors[0], vectors[1]), cosine(vectors[0], vectors[2])
    assert near > far
    results['embedding'] = {'ok': True, 'seconds': elapsed, 'dimensions': 768, 'near': near, 'unrelated': far}
    print('Embedding:', results['embedding'], flush=True)
    (ROOT / 'data/backend-smoke.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
