#!/usr/bin/env python3
"""Human on/off switch for current-page fill, and the private Keychain consumer.

setup / revoke: run by the user in their own terminal.
private-consume: internal; fill.mjs passes an inherited pipe on fd 3 and the password
travels only through that pipe. Never prints secrets to stdout/stderr.
"""
import ctypes as C
import hashlib
import ipaddress
import json
import math
import os
import re
import resource
import stat
import sys
import time
from urllib.parse import urlsplit

SERVICE = b'local.pi.chrome-enrollment.v1'  # Items created by the original Chrome CSV import.
ROOT = os.path.expanduser('~/.pi-current-page-fill')
GRANT = os.path.join(ROOT, 'permission.json')
SCOPE = 'inventory-current-main-https-fill-only'


class Failure(Exception):
    pass


def terminal():
    # Misuse barrier so an agent cannot flip the switch for the user; not a defence against same-UID code.
    if sys.platform != 'darwin' or os.environ.get('TERM_PROGRAM') not in ('Apple_Terminal', 'iTerm.app', 'ghostty'):
        raise Failure('请在「终端」/iTerm/ghostty 中亲自运行')
    if any(k.startswith('PI_') or k in ('SSH_CONNECTION', 'SSH_TTY') for k in os.environ):
        raise Failure('请在普通本机终端中运行，而不是在 agent 内')
    if not all(os.isatty(fd) for fd in (0, 1, 2)):
        raise Failure('需要交互式终端')


def bound_origin(url):
    if not url.startswith('https://') or any(ord(c) <= 32 or ord(c) == 127 for c in url) or '\\' in url:
        raise Failure()
    host = urlsplit(url).hostname or ''
    if urlsplit(url).netloc != host or not host.isascii() or len(host) > 253:
        raise Failure()
    labels = host.split('.')
    if len(labels) < 2 or any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', x) for x in labels):
        raise Failure()
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return 'https://' + host
    raise Failure()


def valid_expiry(expires):
    return expires is None or (type(expires) in (int, float) and math.isfinite(expires) and expires > time.time())


def permission():
    for path, mode in ((ROOT, 0o700), (GRANT, 0o600)):
        s = os.lstat(path)
        if s.st_uid != os.getuid() or stat.S_ISLNK(s.st_mode) or stat.S_IMODE(s.st_mode) != mode:
            raise Failure()
    with os.fdopen(os.open(GRANT, os.O_RDONLY | os.O_NOFOLLOW)) as f:
        p = json.load(f)
    if set(p) != {'scope', 'revision', 'expires'} or p['scope'] != SCOPE or not valid_expiry(p['expires']):
        raise Failure()
    return p


def read_item(origin, username):
    """Exact Keychain item lookup. Returns the password, or raises Failure(category)."""
    sec = C.CDLL('/System/Library/Frameworks/Security.framework/Security')
    find = sec.SecKeychainFindGenericPassword
    find.argtypes = [C.c_void_p, C.c_uint32, C.c_char_p, C.c_uint32, C.c_char_p,
                     C.POINTER(C.c_uint32), C.POINTER(C.c_void_p), C.c_void_p]
    find.restype = C.c_int32
    sec.SecKeychainItemFreeContent.argtypes = [C.c_void_p, C.c_void_p]
    account = hashlib.sha256(json.dumps([origin, username], ensure_ascii=True, separators=(',', ':')).encode()).hexdigest().encode()
    size, data = C.c_uint32(), C.c_void_p()
    rc = find(None, len(SERVICE), SERVICE, len(account), account, C.byref(size), C.byref(data), None)
    try:
        if rc == -25300:
            raise Failure('CREDENTIAL_MISSING')
        if rc:
            raise Failure('SYSTEM_PERMISSION')
        if not data.value or not 0 < size.value <= 512 * 1024:
            raise Failure('CREDENTIAL_MISSING')
        try:
            item = json.loads(C.string_at(data, size.value))
        except ValueError:
            raise Failure('CREDENTIAL_MISSING') from None
        # The encrypted payload must be bound to the same origin/username as the lookup key.
        if (not isinstance(item, dict) or item.get('schema') != 1 or item.get('origin') != origin
                or item.get('username') != username or not isinstance(item.get('password'), str)
                or not 0 < len(item['password'].encode()) <= 4096):
            raise Failure('CREDENTIAL_MISSING')
        return item['password']
    finally:
        if data.value:
            sec.SecKeychainItemFreeContent(None, data)


def setup():
    terminal()
    if os.path.lexists(GRANT):
        print('已经启用。如需重设，先运行 revoke。')
        return
    print('启用后，agent 可以把钥匙串里已导入的网站密码填进它自己浏览器的登录页（只填写，不提交）。')
    print('密码不会出现在聊天或日志里；但网页本身的脚本能读到填进去的密码，这和你手动填写一样。')
    choice = input('有效期：直接回车 = 一直有效直到你 revoke；或输入 1–365 天：').strip()
    expires = None if choice == '' else time.time() + int(choice) * 86400 if choice.isdecimal() and 1 <= int(choice) <= 365 else False
    if expires is False:
        print('输入无效，已取消。')
        return
    if input('输入 yes 确认启用：').strip().lower() != 'yes':
        print('已取消。')
        return
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    os.chmod(ROOT, 0o700)
    with os.fdopen(os.open(GRANT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as f:
        json.dump({'scope': SCOPE, 'revision': os.urandom(16).hex(), 'expires': expires}, f)
    print('已启用。')


def private_consume():
    if not (stat.S_ISFIFO(os.fstat(3).st_mode) or stat.S_ISSOCK(os.fstat(3).st_mode)):
        raise Failure()
    req = json.loads(sys.stdin.read(16384))
    if set(req) != {'origin', 'username', 'revision'}:
        raise Failure()
    if bound_origin(req['origin']) != req['origin'] or not isinstance(req['username'], str) or not 0 < len(req['username']) <= 4096:
        raise Failure()
    p = permission()
    if p['revision'] != req['revision']:
        raise Failure()
    try:
        secret = read_item(req['origin'], req['username'])
    except Failure as error:
        if str(error) in ('CREDENTIAL_MISSING', 'SYSTEM_PERMISSION'):
            with os.fdopen(3, 'w') as f:
                json.dump({'failure': str(error)}, f)
            return
        raise
    if permission() != p:
        raise Failure()
    with os.fdopen(3, 'w') as f:
        json.dump({'username': req['username'], 'password': secret}, f)


def main():
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    action = sys.argv[1:]
    if action == ['setup']:
        setup()
    elif action == ['revoke']:
        terminal()
        try:
            os.unlink(GRANT)
        except FileNotFoundError:
            pass
        print('已关闭。已经填进网页的内容无法撤回。')
    elif action == ['private-consume']:
        private_consume()
    else:
        print('用法：permission.py setup | revoke', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        if sys.argv[1:] == ['private-consume']:
            try:
                if stat.S_ISFIFO(os.fstat(3).st_mode) or stat.S_ISSOCK(os.fstat(3).st_mode):
                    os.write(3, b'{"failure":"SYSTEM_PERMISSION"}')
            except OSError:
                pass
            print('REFUSED', file=sys.stderr)
        elif isinstance(error, Failure) and str(error):
            print(str(error), file=sys.stderr)
        elif not isinstance(error, SystemExit):
            print('失败', file=sys.stderr)
        sys.exit(getattr(error, 'code', 1) if isinstance(error, SystemExit) else 1)
