#!/usr/bin/env python3
"""Read macOS system proxy choices for URLs; no requests or setting changes."""
import argparse
import ctypes as c
import json
import plistlib
import sys
from urllib.parse import urlsplit


def public_url(value):
    """Validate the full routing input without accepting embedded credentials."""
    try:
        parts = urlsplit(value)
        if parts.scheme not in ('http', 'https') or not parts.hostname:
            raise ValueError('需要完整 http(s) URL')
        if parts.username is not None or parts.password is not None:
            raise ValueError('URL 不能包含凭据')
        _ = parts.port  # Validate malformed ports before invoking CFNetwork.
        return value
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def system_routes(urls):
    if sys.platform != 'darwin':
        raise RuntimeError('仅支持 macOS；没有查询或修改网络设置')
    cf = c.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    net = c.CDLL('/System/Library/Frameworks/CFNetwork.framework/CFNetwork')
    signatures = [
        (cf, 'CFStringCreateWithCString', [c.c_void_p, c.c_char_p, c.c_uint32], c.c_void_p),
        (cf, 'CFURLCreateWithString', [c.c_void_p, c.c_void_p, c.c_void_p], c.c_void_p),
        (cf, 'CFPropertyListCreateData', [c.c_void_p, c.c_void_p, c.c_long, c.c_ulong, c.c_void_p], c.c_void_p),
        (cf, 'CFDataGetLength', [c.c_void_p], c.c_long),
        (cf, 'CFDataGetBytePtr', [c.c_void_p], c.c_void_p),
        (cf, 'CFRelease', [c.c_void_p], None),
        (net, 'CFNetworkCopySystemProxySettings', [], c.c_void_p),
        (net, 'CFNetworkCopyProxiesForURL', [c.c_void_p, c.c_void_p], c.c_void_p),
    ]
    for library, name, args, result in signatures:
        function = getattr(library, name)
        function.argtypes, function.restype = args, result
    settings = net.CFNetworkCopySystemProxySettings()
    if not settings:
        raise RuntimeError('无法读取系统代理设置')
    rows = []
    try:
        for url in urls:
            owned = []
            try:
                def keep(pointer):
                    if not pointer:
                        raise RuntimeError('CFNetwork 返回空对象')
                    owned.append(pointer)
                    return pointer
                string = keep(cf.CFStringCreateWithCString(None, url.encode(), 0x08000100))
                cf_url = keep(cf.CFURLCreateWithString(None, string, None))
                choices = keep(net.CFNetworkCopyProxiesForURL(cf_url, settings))
                data = keep(cf.CFPropertyListCreateData(None, choices, 100, 0, None))
                proxies = plistlib.loads(c.string_at(cf.CFDataGetBytePtr(data), cf.CFDataGetLength(data)))
                # Whitelist fields: proxy credentials and PAC contents are never printed.
                safe = [{k: item[k] for k in ('kCFProxyTypeKey', 'kCFProxyHostNameKey', 'kCFProxyPortNumberKey') if k in item}
                        for item in proxies]
                parts = urlsplit(url)
                label = parts.scheme + '://' + parts.netloc + '/'
                rows.append({'url': label, 'direct': bool(safe) and all(
                    p.get('kCFProxyTypeKey') == 'kCFProxyTypeNone' for p in safe), 'proxies': safe})
            finally:
                for pointer in reversed(owned):
                    cf.CFRelease(pointer)
    finally:
        cf.CFRelease(settings)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('urls', nargs='+', type=public_url)
    args = parser.parse_args()
    if len(args.urls) > 20:
        parser.error('每次最多检查 20 个 URL')
    try:
        print(json.dumps({'scope': 'macOS system proxy selection only; not TUN or actual traffic',
                          'routes': system_routes(args.urls)}, ensure_ascii=False, indent=2))
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
