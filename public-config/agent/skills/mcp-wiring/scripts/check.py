#!/usr/bin/env python3
"""只读：校验 mcp.json（JSON 合法性、疑似明文密钥、@latest、端口占用）。"""
import json, os, re, socket, sys


def is_reference(value):
    text = str(value)
    return ((text.startswith('!') and bool(text[1:].strip()))
            or re.fullmatch(r'(?:Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}', text) is not None)


p = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/.pi/agent/mcp.json')
d = json.load(open(p))
srv = d.get('mcpServers', {})
print(f'OK JSON, {len(srv)} servers:', ', '.join(srv))
bad = 0
for k, v in srv.items():
    blob = json.dumps(v)
    for ek, ev in {**v.get('env', {}), **v.get('headers', {})}.items():
        if re.search('KEY|TOKEN|SECRET|PASS|AUTH', ek, re.I) and not is_reference(ev):
            print(f'WARN {k}: {ek} 疑似明文密钥'); bad += 1
    if '@latest' in blob:
        print(f'WARN {k}: 使用 @latest，建议固定版本')
    m = re.search(r'://(?:localhost|127\.0\.0\.1):(\d+)', v.get('url', ''))
    if m:
        s = socket.socket(); s.settimeout(1)
        up = s.connect_ex(('127.0.0.1', int(m.group(1)))) == 0; s.close()
        print(f'{k}: port {m.group(1)} {"up" if up else "DOWN"}')
sys.exit(1 if bad else 0)
