import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import sync


def command(*args, cwd=None):
    env = os.environ.copy()
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_TERMINAL_PROMPT": "0"})
    return subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout.decode().strip()


def repository(path):
    path.mkdir(parents=True)
    command("git", "init", "-q", "-b", "main", str(path))
    command("git", "-C", str(path), "config", "user.name", "Test")
    command("git", "-C", str(path), "config", "user.email", "test@example.invalid")


def save(root, path, value):
    file = root / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(value)


def commit(root, message="test"):
    command("git", "-C", str(root), "add", "-A")
    command("git", "-C", str(root), "commit", "-q", "-m", message)
    return command("git", "-C", str(root), "rev-parse", "HEAD")


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root, self.web = base / "workspace", base / "web"
        self.remote, self.snapshot = base / "remote.git", base / "state" / "snapshot.git"
        repository(self.root)
        repository(self.web)
        command("git", "init", "--bare", "-q", str(self.remote))
        save(self.root, "工具/pi-interrupt/install.mjs", "committed Pi\n")
        save(self.root, "工具/pi-interrupt/records/run.jsonl", "private runtime data\n")
        save(self.root, "工具/pi-interrupt/.env", "PRIVATE=not-for-upload\n")
        save(self.root, "unrelated-personal.txt", "not-for-upload\n")
        commit(self.root)
        save(self.web, "README.md", "committed Web\n")
        commit(self.web)
        command("git", "-C", str(self.web), "tag", "local-tag")
        self.private_checks = 0

    def private(self):
        self.private_checks += 1

    def synchronize(self):
        return sync.sync_once(self.root, self.web, self.snapshot, str(self.remote), self.private)

    def remote_rev(self, ref):
        return command("git", "--git-dir", str(self.remote), "rev-parse", ref)

    def test_committed_only_no_unrelated_files_or_tags(self):
        save(self.root, "工具/pi-interrupt/install.mjs", "staged Pi\n")
        command("git", "-C", str(self.root), "add", "工具/pi-interrupt/install.mjs")
        save(self.root, "工具/pi-interrupt/install.mjs", "unstaged Pi\n")
        save(self.web, "README.md", "staged Web\n")
        command("git", "-C", str(self.web), "add", "README.md")
        before_root = command("git", "-C", str(self.root), "status", "--porcelain=v1")
        before_web = command("git", "-C", str(self.web), "status", "--porcelain=v1")
        result = self.synchronize()
        self.assertEqual(command("git", "--git-dir", str(self.remote), "show", "main:工具/pi-interrupt/install.mjs"), "committed Pi")
        self.assertEqual(command("git", "--git-dir", str(self.remote), "show", "pi-web:README.md"), "committed Web")
        paths = command("git", "--git-dir", str(self.remote), "ls-tree", "-r", "--name-only", "main")
        self.assertNotIn("unrelated-personal", paths)
        self.assertNotIn("records", paths)
        self.assertNotIn(".env", paths)
        self.assertEqual(command("git", "--git-dir", str(self.remote), "tag"), "")
        self.assertEqual(before_root, command("git", "-C", str(self.root), "status", "--porcelain=v1"))
        self.assertEqual(before_web, command("git", "-C", str(self.web), "status", "--porcelain=v1"))
        self.assertEqual(result["pi-web"], self.remote_rev("refs/heads/pi-web"))
        self.assertEqual(self.private_checks, 4)

    def test_pinned_workspace_revision_avoids_mixed_source_identity(self):
        pinned = sync.git_head(self.root)
        save(self.root, "工具/pi-interrupt/install.mjs", "newer committed Pi\n")
        commit(self.root)
        result = sync.sync_once(self.root, self.web, self.snapshot, str(self.remote), self.private,
                                workspace_head=pinned)
        self.assertEqual(result["workspace"], pinned)
        self.assertEqual(command("git", "--git-dir", str(self.remote), "show",
                                 "main:工具/pi-interrupt/install.mjs"), "committed Pi")

    def test_incremental_sync_and_noop(self):
        initial = self.synchronize()
        self.assertEqual(initial, self.synchronize())
        save(self.root, "工具/pi-interrupt/install.mjs", "Pi next\n")
        commit(self.root)
        save(self.web, "README.md", "Web next\n")
        web_head = commit(self.web)
        updated = self.synchronize()
        self.assertNotEqual(initial["main"], updated["main"])
        self.assertEqual(updated["pi-web"], web_head)
        self.assertEqual(command("git", "--git-dir", str(self.remote), "rev-list", "--count", "main"), "2")
        command("git", "--git-dir", str(self.remote), "merge-base", "--is-ancestor", initial["main"], updated["main"])

    def test_historical_secret_blocks_both_pushes(self):
        token = "ghp_" + "A" * 36
        save(self.web, "old.md", token)
        commit(self.web)
        (self.web / "old.md").unlink()
        commit(self.web)
        with self.assertRaisesRegex(sync.SyncError, "GitHub token"):
            self.synchronize()
        self.assertEqual(command("git", "--git-dir", str(self.remote), "for-each-ref", "--format=%(refname)"), "")

    def test_historical_commit_message_secret_blocks_both_pushes(self):
        token = "ghp_" + "A" * 36
        save(self.web, "README.md", "second\n")
        commit(self.web, "sensitive " + token)
        save(self.web, "README.md", "third\n")
        commit(self.web)
        with self.assertRaisesRegex(sync.SyncError, "Git commit"):
            self.synchronize()
        self.assertEqual(command("git", "--git-dir", str(self.remote), "for-each-ref", "--format=%(refname)"), "")

    def test_historical_same_blob_at_unapproved_path_is_scanned(self):
        token = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789"
        save(self.web, "other.mjs", token)
        commit(self.web)
        (self.web / "lib").mkdir(exist_ok=True)
        (self.web / "other.mjs").rename(self.web / "lib/mcp-secrets.test.mjs")
        commit(self.web)
        with self.assertRaisesRegex(sync.SyncError, "other.mjs"):
            self.synchronize()

    def test_pi_same_blob_at_unapproved_path_is_scanned(self):
        token = "ghp_" + "A" * 36
        allowed = "工具/pi-interrupt/a.mjs"
        forbidden = "工具/pi-interrupt/b.mjs"
        save(self.root, allowed, token)
        save(self.root, forbidden, token)
        commit(self.root)
        digest = hashlib.sha256(token.encode()).hexdigest()
        with mock.patch.dict(sync.FIXTURE_HASHES, {allowed: {digest}}):
            with self.assertRaisesRegex(sync.SyncError, "b.mjs"):
                self.synchronize()

    def test_historical_sensitive_path_blocks_both_pushes(self):
        save(self.web, ".env", "a=example\n")
        commit(self.web)
        (self.web / ".env").unlink()
        commit(self.web)
        with self.assertRaisesRegex(sync.SyncError, "敏感文件路径"):
            self.synchronize()
        self.assertEqual(command("git", "--git-dir", str(self.remote), "for-each-ref", "--format=%(refname)"), "")

    def test_shallow_web_history_completed_in_isolated_mirror(self):
        save(self.web, "more.md", "second Web commit\n")
        web_head = commit(self.web)
        shallow = Path(self.temp.name) / "shallow-web"
        command("git", "clone", "-q", "--depth", "1", self.web.as_uri(), str(shallow))
        self.assertEqual(command("git", "-C", str(shallow), "rev-parse", "--is-shallow-repository"), "true")
        before = command("git", "-C", str(shallow), "status", "--porcelain=v1")
        sync.sync_once(self.root, shallow, self.snapshot, str(self.remote), self.private, upstream_url=str(self.web))
        self.assertEqual(self.remote_rev("refs/heads/pi-web"), web_head)
        self.assertEqual(command("git", "--git-dir", str(self.remote), "rev-list", "--count", "pi-web"), "2")
        self.assertEqual(command("git", "-C", str(shallow), "rev-parse", "--is-shallow-repository"), "true")
        self.assertEqual(command("git", "-C", str(shallow), "status", "--porcelain=v1"), before)

    def test_git_url_rewrites_block_push(self):
        command("git", "-C", str(self.web), "config", "url.https://untrusted.invalid/.insteadOf", "https://github.com/")
        with self.assertRaisesRegex(sync.SyncError, "URL 重写"):
            self.synchronize()
        self.assertEqual(command("git", "--git-dir", str(self.remote), "for-each-ref", "--format=%(refname)"), "")

    def test_unavailable_private_check_stops_before_push(self):
        def not_private():
            raise sync.SyncError("不是私有仓库")
        with self.assertRaisesRegex(sync.SyncError, "私有仓库"):
            sync.sync_once(self.root, self.web, self.snapshot, str(self.remote), not_private)
        self.assertFalse(self.snapshot.exists())
        self.assertEqual(command("git", "--git-dir", str(self.remote), "for-each-ref", "--format=%(refname)"), "")

    def test_web_remote_divergence_blocks_pi_update(self):
        old = self.synchronize()
        clone = Path(self.temp.name) / "other-clone"
        command("git", "clone", "-q", "-b", "pi-web", str(self.remote), str(clone))
        command("git", "-C", str(clone), "config", "user.name", "Other")
        command("git", "-C", str(clone), "config", "user.email", "other@example.invalid")
        save(clone, "elsewhere.md", "remote change")
        unexpected_web = commit(clone)
        command("git", "-C", str(clone), "push", "-q", "origin", "HEAD:refs/heads/pi-web")
        save(self.root, "工具/pi-interrupt/install.mjs", "Pi newer\n")
        commit(self.root)
        with self.assertRaisesRegex(sync.SyncError, "Pi Web 远端分支"):
            self.synchronize()
        self.assertEqual(self.remote_rev("refs/heads/main"), old["main"])
        self.assertEqual(self.remote_rev("refs/heads/pi-web"), unexpected_web)

    def test_push_rejects_remote_rollback_after_preflight(self):
        first = self.synchronize()["main"]
        save(self.root, "工具/pi-interrupt/install.mjs", "version 2\n")
        commit(self.root)
        expected = self.synchronize()["main"]
        save(self.root, "工具/pi-interrupt/install.mjs", "version 3\n")
        source_head = commit(self.root)
        entries, contents = sync.committed_pi(self.root, source_head)
        tree = sync.snapshot_tree(self.snapshot, entries, contents)
        desired = sync.make_snapshot(self.snapshot, tree, expected, source_head)
        # Another client rolls the remote back after our preflight. A plain push
        # would be a fast-forward from first to desired, but must still be rejected.
        command("git", "--git-dir", str(self.remote), "update-ref", "refs/heads/main", first)
        with self.assertRaises(sync.SyncError):
            sync.guarded_push(self.snapshot, str(self.remote), "refs/heads/main", expected, desired)
        self.assertEqual(self.remote_rev("refs/heads/main"), first)

    def test_recovers_when_push_succeeded_before_local_record(self):
        previous = self.synchronize()["main"]
        save(self.root, "工具/pi-interrupt/install.mjs", "new version\n")
        source_head = commit(self.root)
        entries, contents = sync.committed_pi(self.root, source_head)
        tree = sync.snapshot_tree(self.snapshot, entries, contents)
        pending = sync.make_snapshot(self.snapshot, tree, previous, source_head)
        sync.git(self.snapshot, "update-ref", "refs/heads/pending", pending, bare=True)
        sync.git(self.snapshot, "push", str(self.remote), f"{pending}:refs/heads/main", bare=True)
        self.assertEqual(sync.reconcile_snapshot(self.snapshot, pending), pending)
        self.assertIsNone(sync.local_ref(self.snapshot, "refs/heads/pending"))
        self.assertEqual(self.synchronize()["main"], pending)

    def test_unrelated_symlink_ignored_but_selected_symlink_rejected(self):
        os.symlink("missing", self.root / "unrelated-link")
        commit(self.root)
        self.synchronize()
        os.symlink("missing", self.root / "工具/pi-interrupt/unsafe.py")
        commit(self.root)
        with self.assertRaisesRegex(sync.SyncError, "链接或子仓库"):
            self.synchronize()

    def test_lfs_pointer_is_rejected(self):
        save(self.web, "asset.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n")
        commit(self.web)
        with self.assertRaisesRegex(sync.SyncError, "Git LFS"):
            self.synchronize()

    def test_fixture_exception_is_exact_and_path_scoped(self):
        example = b"ghp_" + b"abcdefghijklmnopqrstuvwxyz0123456789"
        sync.scan_content("lib/mcp-secrets.test.mjs", example)
        with self.assertRaisesRegex(sync.SyncError, "GitHub token"):
            sync.scan_content("another-file.mjs", example)
        with self.assertRaisesRegex(sync.SyncError, "GitHub token"):
            sync.scan_content("lib/mcp-secrets.test.mjs", example + b"\n" + b"ghp_" + b"A" * 36)

    def test_session_example_allowed_but_real_record_blocked(self):
        example = (b'{"type":"session","version":3,"id":"<uuid>","timestamp":"...",'
                   b'"cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}')
        sync.scan_content("AGENTS.md", b"Documentation\n\n" + example + b"\n")
        sync.scan_content("AGENTS.md", example.replace(b"/abs/path/to/parent.jsonl", b"/path/to/parent.jsonl"))
        actual = b'{"type":"session","version":3,"id":"abc123","timestamp":"2026-01-01","cwd":"/home/user"}'
        with self.assertRaisesRegex(sync.SyncError, "session record"):
            sync.scan_content("AGENTS.md", actual)
        imitated = b'{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/real/path"}'
        with self.assertRaisesRegex(sync.SyncError, "session record"):
            sync.scan_content("AGENTS.md", imitated)


if __name__ == "__main__":
    unittest.main()
