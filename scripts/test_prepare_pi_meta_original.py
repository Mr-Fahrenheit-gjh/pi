import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("pi_meta_original", HERE / "prepare-pi-meta-original.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrepareOriginalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-meta-prepare-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidate = self.root / "candidate"
        self.sdk = self.candidate / "node_modules/@earendil-works/pi-coding-agent"
        (self.sdk / "node_modules/example").mkdir(parents=True)
        (self.sdk / "package.json").write_text(json.dumps({"name": "@earendil-works/pi-coding-agent", "version": "1.5.0"}))
        (self.sdk / "node_modules/example/index.js").write_text("fixture\n")
        source = self.root / "original"
        (source / "dist/bundle").mkdir(parents=True)
        (source / "package.json").write_text(json.dumps({"name": "@earendil-works/pi-coding-agent", "version": "1.5.0"}))
        (source / "dist/cli.js").write_text("// cli\n")
        (source / "dist/bundle/cli.js").write_text("// bundle\n")
        (source / "dist/cli.js").chmod(0o755)
        (source / "dist/bundle/cli.js").chmod(0o755)
        self.archive = self.root / "original.tgz"
        with tarfile.open(self.archive, "w:gz") as bundle:
            for path in [source / "package.json", source / "dist/cli.js", source / "dist/bundle/cli.js"]:
                bundle.add(path, arcname="package/" + path.relative_to(source).as_posix())
        self.hashes = patch.multiple(module, ARCHIVE_SHA512=base64.b64encode(hashlib.sha512(self.archive.read_bytes()).digest()).decode(), ORIGINAL_FINGERPRINT=module.original_fingerprint(source))
        self.hashes.start()
        self.addCleanup(self.hashes.stop)

    def test_prepare_and_repeat_without_overwriting(self):
        self.assertEqual(module.prepare(self.candidate, self.archive), "created")
        target = self.candidate / "node_modules/.pi-meta-original"
        self.assertTrue(os.access(target / "dist/cli.js", os.X_OK))
        self.assertTrue(os.access(target / "dist/bundle/cli.js", os.X_OK))
        self.assertEqual((target / "node_modules/example/index.js").read_text(), "fixture\n")
        self.assertEqual(module.prepare(self.candidate, self.archive), "already-present")
        (target / "dist/cli.js").chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "not executable"):
            module.prepare(self.candidate, self.archive)
        (target / "dist/cli.js").chmod(0o755)
        (self.sdk / "node_modules/example/index.js").write_text("changed\n")
        with self.assertRaisesRegex(RuntimeError, "dependencies do not match"):
            module.prepare(self.candidate, self.archive)

    def test_invalid_archive_and_existing_target_fail_closed(self):
        original_archive = self.archive.read_bytes()
        self.archive.write_bytes(b"tampered")
        with self.assertRaisesRegex(RuntimeError, "integrity mismatch"):
            module.prepare(self.candidate, self.archive)
        self.assertFalse((self.candidate / "node_modules/.pi-meta-original").exists())
        target = self.candidate / "node_modules/.pi-meta-original"
        target.mkdir()
        (target / "sentinel").write_text("keep")
        self.archive.write_bytes(original_archive)
        with self.assertRaisesRegex(RuntimeError, "metadata is missing"):
            module.prepare(self.candidate, self.archive)
        self.assertEqual((target / "sentinel").read_text(), "keep")

    def test_unsafe_nested_symlink_and_live_target_are_refused(self):
        (self.sdk / "node_modules/unsafe").symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe symlink"):
            module.prepare(self.candidate, self.archive)
        self.assertFalse((self.candidate / "node_modules/.pi-meta-original").exists())
        with patch.object(module, "LIVE", self.candidate):
            with self.assertRaisesRegex(RuntimeError, "live Web"):
                module.prepare(self.candidate, self.archive)

    def test_archive_path_traversal_is_refused_even_with_matching_digest(self):
        malicious = self.root / "malicious.tgz"
        with tarfile.open(malicious, "w:gz") as bundle:
            data = b"unsafe"
            entry = tarfile.TarInfo("package/dist/../../outside")
            entry.size = len(data)
            bundle.addfile(entry, io.BytesIO(data))
        digest = base64.b64encode(hashlib.sha512(malicious.read_bytes()).digest()).decode()
        with patch.object(module, "ARCHIVE_SHA512", digest):
            with self.assertRaisesRegex(RuntimeError, "Unsafe SDK archive path"):
                module.prepare(self.candidate, malicious)
        self.assertFalse((self.root / "outside").exists())

    @unittest.skipUnless(os.environ.get("PI_META_TEST_ARCHIVE"), "requires the verified local 1.5.0 archive")
    def test_real_original_archive_matches_the_pinned_fingerprint(self):
        self.hashes.stop()
        archive = Path(os.environ["PI_META_TEST_ARCHIVE"])
        self.assertEqual(module.prepare(self.candidate, archive), "created")
        target = self.candidate / "node_modules/.pi-meta-original"
        self.assertEqual(module.original_fingerprint(target), module.ORIGINAL_FINGERPRINT)


if __name__ == "__main__":
    unittest.main()
