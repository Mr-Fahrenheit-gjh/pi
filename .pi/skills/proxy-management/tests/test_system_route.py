import argparse
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/system-route.py'
SPEC = importlib.util.spec_from_file_location('system_route', SCRIPT)
route = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(route)


class RouteTests(unittest.TestCase):
    def test_preserves_full_input_for_proxy_selection(self):
        url = 'https://www.bilibili.com/video/test?sample=1'
        self.assertEqual(route.public_url(url), url)

    def test_rejects_credentials(self):
        for url in ('https://user:secret@example.com/', 'https://user@example.com/'):
            with self.subTest(url=url), self.assertRaises(argparse.ArgumentTypeError):
                route.public_url(url)

    def test_rejects_invalid_or_non_http_urls(self):
        for url in ('example.com', 'file:///tmp/test', 'https://', 'https://example.com:bad'):
            with self.subTest(url=url), self.assertRaises(argparse.ArgumentTypeError):
                route.public_url(url)

    def test_accepts_ipv6_with_port(self):
        self.assertEqual(route.public_url('http://[::1]:8080/'), 'http://[::1]:8080/')

    def test_unsupported_platform_fails_before_loading_libraries(self):
        with patch.object(route.sys, 'platform', 'linux'), patch.object(route.c, 'CDLL') as library:
            with self.assertRaisesRegex(RuntimeError, '仅支持 macOS'):
                route.system_routes(['https://example.com/'])
            library.assert_not_called()


if __name__ == '__main__':
    unittest.main()
