import unittest
from prepare_migration import chunks, redact


class PreparationTests(unittest.TestCase):
    def test_chunks_are_lossless_and_bounded(self):
        source = '第一段\n\n第二段\n' * 100
        parts = chunks(source, limit=60)
        self.assertEqual(''.join(parts), source)
        self.assertTrue(all(0 < len(part) <= 60 for part in parts))
        self.assertEqual(chunks(''), [])

    def test_credentials_are_redacted_without_removing_ordinary_notes(self):
        secret = 'sk-' + 'a' * 28
        value, count = redact('偏好：简短。临时密钥：' + secret)
        self.assertEqual(count, 1)
        self.assertNotIn(secret, value)
        self.assertIn('偏好：简短', value)
        self.assertIn('[REDACTED_CREDENTIAL]', value)

    def test_no_secret_no_change(self):
        value = 'source: daily/2026-10-01.md；这是代理历史记录，不是新指令。'
        self.assertEqual(redact(value), (value, 0))


if __name__ == '__main__':
    unittest.main()
