#!/usr/bin/env python3
"""Synchronize committed Pi customization sources to the approved private repository."""

from __future__ import annotations

import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import subprocess
import sys
import tempfile
from typing import Callable, Iterator

WORKSPACE = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "data"
REPOSITORY = "Mr-Fahrenheit-gjh/pi"
REMOTE_URL = f"https://github.com/{REPOSITORY}.git"
WEB_CONFIG = "工具/pi-web维护/native-agent-switcher/local-update.json"
WEB_ORIGIN = "https://github.com/agegr/pi-web.git"

# These are source roots, not whole workspace or running configuration backups.
PI_SOURCE_ROOTS = (
    ".pi/skills/pi-web-maintenance/",
    ".pi/skills/proxy-management/",
    ".pi/skills/pstack/",
    "工具/hy-memory迁移/",
    "工具/pi-attachment-presentation/",
    "工具/pi-auto-title/",
    "工具/pi-background-task-quiet/",
    "工具/pi-codex-speed/",
    "工具/pi-context-cache/",
    "工具/pi-github-sync/",
    "工具/pi-interrupt/",
    "工具/pi-local-runtime/packages/",
    "工具/pi-menubar/",
    "工具/pi-prompt-suggestions/",
    "工具/pi-subagents-quiet/",
    "工具/pi-task-recovery/",
    "工具/pi-tui-session-background/",
    "工具/pi-workflow-integrity/",
)
MAINTENANCE_ROOT = "工具/pi-web维护/native-agent-switcher/"
SOURCE_SUFFIXES = frozenset({
    ".py", ".ts", ".tsx", ".js", ".mjs", ".mts", ".cjs", ".sh", ".swift",
    ".md", ".patch", ".svg", ".plist", ".yml", ".yaml", ".html", ".css", ".toml",
})
SOURCE_FILENAMES = frozenset({
    "license", "license.pi-web", "package.json", "package-lock.json", "tsconfig.json",
    "requirements.lock", "local-update.json", "integration-0.12.0-manifest.json",
    "integration-manifest.json",
})
EXCLUDED_PARTS = frozenset({
    "data", "records", "backfills", "experiments", "evidence", ".evidence", "test-results",
    "node_modules", ".next", ".git", "__pycache__",
})
BAD_SUFFIXES = frozenset({".jsonl", ".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx"})
MAX_BLOB = 25 * 1024 * 1024

# Patterns are deliberately high-confidence; a pass is not a proof that all secrets were found.
SECRET_PATTERNS = (
    ("private key", re.compile(rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----")),
    ("GitHub token", re.compile(rb"\b(?:gh[pousr]_[A-Za-z0-9]{32,255}|github_pat_[A-Za-z0-9_]{40,255})\b")),
    ("API token", re.compile(rb"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,200}\b")),
    ("AWS key", re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("Slack token", re.compile(rb"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("session record", re.compile(rb'(?m)^[ \t]*\{[ \t]*"type"[ \t]*:[ \t]*"session"[^\n]{0,500}"cwd"[ \t]*:')),
)
SECRET_ASSIGNMENT = re.compile(
    rb"(?i)\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['\"]([^'\"\r\n\s]{16,})['\"]"
)
# SHA-256 fingerprints of reviewed synthetic values in upstream/local test fixtures only.
# Exceptions are path- and value-specific; additional matches in these files still fail.
FIXTURE_HASHES = {
    "app/api/project-trust/route.test.mjs": {"8c1bed10ff6f381fae4508036ecf1f0f6aa813a4fceb594a319909361cdb7b49"},
    "components/mcp-add-helpers.test.mjs": {"b41b949bed747ef14ad205c5497017adb341c7bdfd0cef5ab33361f287f4d072"},
    "lib/mcp-add.test.mjs": {"b41b949bed747ef14ad205c5497017adb341c7bdfd0cef5ab33361f287f4d072"},
    "lib/mcp-config-read.test.mjs": {"03aafb028d538b06c4341bf8cf2a692a3c6d1f36e34e0e0b376f407c6117a246", "fd9c6c783685c4c752e89627327fe68f72b3b50ca97cfe26919b813c56d983ae"},
    "lib/mcp-config-values.test.mjs": {"756c6becb44abd81e9f27e24d981dedf7d0905c06038db9548f61308e00a8cf0"},
    "lib/mcp-import.test.mjs": {"02d41c2e58900657c03c400f7698d93f55edb7558ba2819d0b66df821505df52", "03aafb028d538b06c4341bf8cf2a692a3c6d1f36e34e0e0b376f407c6117a246", "896485a896489e0a00b4a9e0a35fa02fe3eac8a7bbce5fc4f3f1ff4dc9394da2", "c1b59d55cb72a35096fc7afd518960372afe4977c4bed042c40e8936ce851f47"},
    "lib/mcp-secrets.test.mjs": {"03aafb028d538b06c4341bf8cf2a692a3c6d1f36e34e0e0b376f407c6117a246", "1a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3", "9787577eb430f3966c1b64cb1f15b26fa3227d92ab4c71ceca9a5e49c9624979", "f6882d07519e04f1d8be97934115b8569143f50ec1217814603aace9d83b2a4e"},
    "lib/mcp-sign-in.test.mjs": {"f06e5bfc61500163622c0964e097168831117f76779bfee404d135fb40770a62"},
    "lib/mcp-test.test.mjs": {"ca43a0a764e0517d3678ede268969c83ce658144be8f1ce366deae2a9d978a53"},
    "lib/mcp-transport.test.mjs": {"756c6becb44abd81e9f27e24d981dedf7d0905c06038db9548f61308e00a8cf0"},
    "lib/model-runtime.integration.test.mjs": {"86e7f972612a5775edaf88162b5f6a4e96d7f044296d2ae8d3c1325607afbd74", "bf5cc946fb98abf7bc41e6067832008873f9739f088356be8927c28f4b7886dd"},
    "lib/web-auth.test.mjs": {"21a7c490b5771694cfc11134286f5895e51b4714da53243a9263096db8f87936"},
    "工具/pi-prompt-suggestions/tests/web-fixture.mjs": {"3c35efb21258562c403ef9ee6e1c4b6b803341ef08946a8f9d70bc53f97f1a5c"},
}


class SyncError(RuntimeError):
    pass


def environment(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    for key in list(env):
        if key in {"GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                   "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
                   "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE", "GIT_NAMESPACE"} or key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
            env.pop(key, None)
    env.update({"GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1",
                "GH_PROMPT_DISABLED": "1", "GH_NO_UPDATE_NOTIFIER": "1"})
    if extra:
        env.update(extra)
    return env


def run(args: list[str], *, cwd: Path | None = None, data: bytes | None = None,
        extra_env: dict[str, str] | None = None, timeout: int = 120,
        allowed: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(args, cwd=cwd, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=environment(extra_env), timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SyncError(f"无法运行 {Path(args[0]).name}: {type(exc).__name__}") from exc
    if result.returncode not in allowed:
        # Do not put command stderr in logs: credentials may appear in helper diagnostics.
        raise SyncError(f"{Path(args[0]).name} 操作失败，退出码 {result.returncode}")
    return result


def git(repo: Path, *args: str, data: bytes | None = None, bare: bool = False,
        extra_env: dict[str, str] | None = None, timeout: int = 120,
        allowed: tuple[int, ...] = (0,)) -> subprocess.CompletedProcess[bytes]:
    prefix = ["git", "--git-dir", str(repo)] if bare else ["git", "-C", str(repo)]
    return run(prefix + list(args), data=data, extra_env=extra_env, timeout=timeout, allowed=allowed)


def text(result: subprocess.CompletedProcess[bytes]) -> str:
    return result.stdout.decode("utf-8", "strict").strip()


def git_head(repo: Path) -> str:
    return text(git(repo, "rev-parse", "--verify", "HEAD^{commit}"))


def ensure_no_url_rewrites(repo: Path) -> None:
    result = git(repo, "config", "--get-regexp", r"^url\..*\.(insteadof|pushinsteadof)$", allowed=(0, 1))
    if result.returncode == 0:
        raise SyncError("Git 配置包含 URL 重写，无法保证推送目标")


def ensure_no_grafts(repo: Path) -> None:
    name = text(git(repo, "rev-parse", "--git-path", "info/grafts"))
    grafts = Path(name)
    if not grafts.is_absolute():
        grafts = repo / grafts
    if grafts.exists() and grafts.stat().st_size:
        raise SyncError("Git 历史使用 grafts，无法验证完整历史")


def verify_private() -> None:
    result = run(["gh", "api", "--hostname", "github.com", f"repos/{REPOSITORY}",
                  "--jq", "{full_name,private,archived,permissions}"])
    try:
        meta = json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise SyncError("无法确认 GitHub 仓库身份和私有状态") from exc
    if (not isinstance(meta, dict) or meta.get("full_name") != REPOSITORY or meta.get("private") is not True
            or meta.get("archived") is not False or not isinstance(meta.get("permissions"), dict)
            or meta["permissions"].get("push") is not True):
        raise SyncError("目标仓库并非预期的可写私有仓库，停止同步")


def web_source(workspace: Path, workspace_head: str) -> Path:
    try:
        config = json.loads(git(workspace, "show", f"{workspace_head}:{WEB_CONFIG}").stdout)
        source = config["sourceDirectory"]
        if not isinstance(source, str) or not source:
            raise ValueError("invalid sourceDirectory")
        maintenance = (workspace / "工具/pi-web维护").resolve(strict=True)
        web = (workspace / "工具/pi-web维护/native-agent-switcher" / source).resolve(strict=True)
        web.relative_to(maintenance)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SyncError("已提交的 Pi Web 源码路径无效或超出维护目录") from exc
    if Path(text(git(web, "rev-parse", "--show-toplevel"))).resolve() != web:
        raise SyncError("Pi Web 路径不是独立工作树根目录")
    if text(git(web, "remote", "get-url", "origin")) != WEB_ORIGIN:
        raise SyncError("Pi Web 上游身份不匹配，停止同步")
    if git(web, "symbolic-ref", "--quiet", "HEAD", allowed=(0, 1)).returncode:
        raise SyncError("Pi Web 处于 detached HEAD，停止同步")
    return web


def validate_path(path: str) -> None:
    parts = PurePosixPath(path).parts
    if (not parts or path.startswith("/") or any(ord(c) < 32 for c in path)
            or any(p in {"", ".", ".."} for p in parts)):
        raise SyncError("源码包含不安全的路径")
    name = parts[-1].lower()
    if (name == ".env" or name.startswith(".env.") or name in {
        "auth.json", "credentials.json", "credential.json", "secrets.json",
        "credentials.yaml", "credentials.yml",
    } or PurePosixPath(name).suffix in BAD_SUFFIXES):
        raise SyncError(f"发现禁止同步的敏感文件路径: {path}")


def pi_source(path: str) -> bool:
    if not any(path.startswith(root) for root in PI_SOURCE_ROOTS) and not path.startswith(MAINTENANCE_ROOT):
        return False
    relative = path[len(MAINTENANCE_ROOT):] if path.startswith(MAINTENANCE_ROOT) else path
    # The maintenance directory contains generated live state and screenshots: only its top-level sources.
    if path.startswith(MAINTENANCE_ROOT) and ("/" in relative or relative == "README.md"):
        return False
    parts = PurePosixPath(path).parts
    if any(part.lower() in EXCLUDED_PARTS or part.startswith("验收-") for part in parts):
        return False
    name = parts[-1].lower()
    if (name.startswith(("activation.", "validation.", "verification.", "smoke-result.", "live-result."))
            or re.fullmatch(r"history-\d{8}\.md", name)):
        return False
    return PurePosixPath(name).suffix in SOURCE_SUFFIXES or name in SOURCE_FILENAMES


def scan_content(path: str, blob: bytes) -> None:
    if len(blob) > MAX_BLOB:
        raise SyncError(f"源码文件超过安全检查上限: {path}")
    if blob.startswith(b"version https://git-lfs.github.com/spec/v1\n"):
        raise SyncError(f"源码包含未备份的 Git LFS 对象: {path}")
    def reviewed(value: bytes) -> bool:
        return hashlib.sha256(value).hexdigest() in FIXTURE_HASHES.get(path, ())
    for label, pattern in SECRET_PATTERNS:
        for match in pattern.finditer(blob):
            value = match.group()
            start = blob.rfind(b"\n", 0, match.start()) + 1
            end = blob.find(b"\n", match.start())
            line = blob[start:end if end >= 0 else len(blob)].strip()
            examples = (
                b'{"type":"session","version":3,"id":"<uuid>","timestamp":"...",'
                b'"cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}',
                b'{"type":"session","version":3,"id":"<uuid>","timestamp":"...",'
                b'"cwd":"/path","parentSession":"/path/to/parent.jsonl"}',
            )
            if label == "session record" and path == "AGENTS.md" and line in examples:
                continue
            if not reviewed(value):
                raise SyncError(f"源码安全检查发现疑似{label}: {path}")
    for match in SECRET_ASSIGNMENT.finditer(blob):
        if not reviewed(match.group(1)):
            raise SyncError(f"源码安全检查发现疑似密钥赋值: {path}")


def tree_entries(repo: Path, commit: str, include: Callable[[str], bool] | None = None,
                 paths: tuple[str, ...] = ()) -> list[tuple[str, str, str]]:
    args = ["ls-tree", "-r", "-z", "--full-tree", commit]
    if paths:
        args.extend(["--", *(p.rstrip("/") for p in paths)])
    result = git(repo, *args)
    entries = []
    for item in result.stdout.split(b"\0"):
        if not item:
            continue
        try:
            metadata, raw_path = item.split(b"\t", 1)
            mode, kind, oid = metadata.decode("ascii").split(" ")
            path = raw_path.decode("utf-8", "strict")
        except (ValueError, UnicodeError) as exc:
            raise SyncError("Git 树包含无法安全处理的路径") from exc
        if include is not None and not include(path):
            continue
        if kind != "blob" or mode not in {"100644", "100755"}:
            raise SyncError(f"源码树包含链接或子仓库，不自动同步: {path}")
        entries.append((mode, oid, path))
    return entries


def blobs(repo: Path, objects: dict[str, str], expected_type: str = "blob") -> Iterator[tuple[str, str, bytes]]:
    try:
        proc = subprocess.Popen(["git", "-C", str(repo), "cat-file", "--batch"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                env=environment())
    except OSError as exc:
        raise SyncError("无法读取 Git 内容") from exc
    try:
        assert proc.stdin and proc.stdout
        for oid, path in objects.items():
            proc.stdin.write((oid + "\n").encode("ascii"))
            proc.stdin.flush()
            header = proc.stdout.readline().decode("ascii", "strict").strip().split()
            if len(header) != 3 or header[0] != oid or header[1] != expected_type:
                raise SyncError(f"无法读取源码对象: {path}")
            size = int(header[2])
            if size > MAX_BLOB:
                raise SyncError(f"源码文件超过安全检查上限: {path}")
            content = proc.stdout.read(size)
            if len(content) != size or proc.stdout.read(1) != b"\n":
                raise SyncError(f"源码对象不完整: {path}")
            yield oid, path, content
    finally:
        if proc.stdin:
            proc.stdin.close()
        if proc.poll() is None:
            proc.terminate()
        proc.wait()
        if proc.stdout:
            proc.stdout.close()


def committed_pi(repo: Path, commit: str) -> tuple[list[tuple[str, str, str]], dict[str, bytes]]:
    entries = tree_entries(repo, commit, include=pi_source, paths=PI_SOURCE_ROOTS + (MAINTENANCE_ROOT,))
    if not entries:
        raise SyncError("Pi 源码白名单为空，停止同步")
    object_paths: dict[str, set[str]] = {}
    for _, oid, path in entries:
        validate_path(path)
        object_paths.setdefault(oid, set()).add(path)
    contents = {}
    representatives = {oid: min(paths) for oid, paths in object_paths.items()}
    for oid, _, content in blobs(repo, representatives):
        for path in sorted(object_paths[oid]):
            scan_content(path, content)
        contents[oid] = content
    return entries, contents


def scan_web_history(repo: Path, head: str) -> None:
    if text(git(repo, "rev-parse", "--is-shallow-repository")) != "false":
        raise SyncError("Pi Web 历史不完整，停止同步")
    ensure_no_grafts(repo)
    commits = text(git(repo, "rev-list", head)).splitlines()
    commit_paths = {oid: f"Git commit {oid}" for oid in commits}
    for _, path, content in blobs(repo, commit_paths, expected_type="commit"):
        scan_content(path, content)
    object_paths: dict[str, set[str]] = {}
    for commit in commits:
        for _, oid, path in tree_entries(repo, commit):
            validate_path(path)
            object_paths.setdefault(oid, set()).add(path)
    representatives = {oid: min(paths) for oid, paths in object_paths.items()}
    for oid, _, content in blobs(repo, representatives):
        for path in sorted(object_paths[oid]):
            scan_content(path, content)


def remote_heads(repo: Path, url: str) -> dict[str, str]:
    result = git(repo, "ls-remote", "--heads", url, "refs/heads/main", "refs/heads/pi-web", timeout=60)
    heads = {}
    for line in text(result).splitlines():
        oid, ref = line.split("\t", 1)
        if ref not in {"refs/heads/main", "refs/heads/pi-web"} or not re.fullmatch(r"[0-9a-f]{40,64}", oid):
            raise SyncError("远端分支信息无效")
        heads[ref] = oid
    return heads


def local_ref(repo: Path, ref: str) -> str | None:
    result = git(repo, "rev-parse", "--verify", "--quiet", ref, bare=True, allowed=(0, 1))
    return text(result) if result.returncode == 0 else None


def init_snapshot(repo: Path) -> None:
    if repo.exists():
        if not (repo / "HEAD").is_file():
            raise SyncError("同步快照仓库状态异常")
        return
    repo.parent.mkdir(parents=True, exist_ok=True)
    run(["git", "init", "--bare", "--quiet", str(repo)])


def prepare_web_mirror(web: Path, head: str, mirror: Path, upstream_url: str) -> None:
    # A worktree may be shallow. Complete its upstream ancestry in our own bare mirror,
    # never by changing the shared Git directory of the original worktree.
    ensure_no_grafts(web)
    init_snapshot(mirror)
    ensure_no_url_rewrites(mirror)
    shallow_name = text(git(web, "rev-parse", "--git-path", "shallow"))
    shallow = Path(shallow_name)
    if not shallow.is_absolute():
        shallow = web / shallow
    boundaries = set(shallow.read_text().splitlines()) if shallow.is_file() else set()
    reachable = set(text(git(web, "rev-list", head)).splitlines())
    parents = set()
    for boundary in boundaries & reachable:
        raw = git(web, "cat-file", "-p", boundary).stdout.split(b"\n\n", 1)[0]
        parents.update(line.split(b" ", 1)[1].decode("ascii") for line in raw.splitlines()
                       if line.startswith(b"parent "))
    def missing_parents() -> list[str]:
        return [parent for parent in parents if git(mirror, "cat-file", "-e", f"{parent}^{{commit}}",
                                                     bare=True, allowed=(0, 1, 128)).returncode]
    if missing_parents():
        git(mirror, "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", upstream_url,
            "+refs/heads/*:refs/remotes/upstream/*", "+refs/tags/*:refs/tags/upstream/*",
            bare=True, timeout=120)
        if missing_parents():
            raise SyncError("无法从官方上游补齐 Pi Web 的浅克隆历史")
    git(mirror, "-c", "core.hooksPath=/dev/null", "fetch", "--no-tags", str(web), head,
        bare=True, timeout=120)
    git(mirror, "update-ref", "refs/heads/source", head, bare=True)
    if text(git(mirror, "rev-parse", "--is-shallow-repository", bare=True)) != "false":
        raise SyncError("隔离的 Pi Web 镜像历史不完整")
    ensure_no_grafts(mirror)


def reconcile_snapshot(repo: Path, remote: str | None) -> str | None:
    synced = local_ref(repo, "refs/heads/main")
    pending = local_ref(repo, "refs/heads/pending")
    if pending:
        if remote == pending:
            git(repo, "update-ref", "refs/heads/main", pending, bare=True)
            synced = pending
        elif remote != synced:
            raise SyncError("Pi 远端分支与上次同步记录不一致，停止同步")
        git(repo, "update-ref", "-d", "refs/heads/pending", bare=True)
    if remote != synced:
        raise SyncError("Pi 远端分支与上次同步记录不一致，停止同步")
    return synced


def snapshot_tree(repo: Path, entries: list[tuple[str, str, str]], contents: dict[str, bytes]) -> str:
    with tempfile.TemporaryDirectory(prefix="pi-sync-index-") as temp:
        env = {"GIT_INDEX_FILE": str(Path(temp) / "index")}
        git(repo, "read-tree", "--empty", bare=True, extra_env=env)
        updates = bytearray()
        written = {}
        for mode, oid, path in entries:
            if oid not in written:
                written[oid] = text(git(repo, "hash-object", "-w", "--stdin", data=contents[oid], bare=True))
            updates.extend(f"{mode} {written[oid]}\t{path}\0".encode("utf-8"))
        git(repo, "update-index", "-z", "--index-info", data=bytes(updates), bare=True, extra_env=env)
        return text(git(repo, "write-tree", bare=True, extra_env=env))


def make_snapshot(repo: Path, tree: str, previous: str | None, source_head: str) -> str:
    args = ["commit-tree", tree]
    if previous:
        args.extend(["-p", previous])
    args.extend(["-m", f"Sync committed Pi customizations (workspace {source_head})"])
    identity = {"GIT_AUTHOR_NAME": "Pi Sync", "GIT_AUTHOR_EMAIL": "pi-sync@localhost",
                "GIT_COMMITTER_NAME": "Pi Sync", "GIT_COMMITTER_EMAIL": "pi-sync@localhost"}
    return text(git(repo, *args, bare=True, extra_env=identity))


def guarded_push(repo: Path, url: str, ref: str, expected: str | None, desired: str) -> None:
    # The pre-push hook sees the advertised old oid from this exact push. If it differs
    # from our preflight, abort. receive-pack atomically rejects a later ref change.
    hook_source = """#!/bin/sh
set -eu
IFS=' ' read -r local_ref local_oid remote_ref remote_oid || exit 1
[ "$local_oid" = "$PI_SYNC_EXPECT_NEW" ] || exit 1
[ "$remote_ref" = "$PI_SYNC_EXPECT_REF" ] || exit 1
[ "$remote_oid" = "$PI_SYNC_EXPECT_OLD" ] || exit 1
if IFS= read -r extra; then exit 1; fi
"""
    with tempfile.TemporaryDirectory(prefix="pi-sync-hook-") as temp:
        hook = Path(temp) / "pre-push"
        hook.write_text(hook_source)
        hook.chmod(0o700)
        env = {"PI_SYNC_EXPECT_NEW": desired, "PI_SYNC_EXPECT_REF": ref,
               "PI_SYNC_EXPECT_OLD": expected or "0" * len(desired)}
        git(repo, "-c", f"core.hooksPath={temp}", "push", "--no-follow-tags", url,
            f"{desired}:{ref}", bare=True, extra_env=env, timeout=120)


def sync_once(workspace: Path, web: Path, snapshot: Path, url: str,
              check_private: Callable[[], None], upstream_url: str = WEB_ORIGIN,
              workspace_head: str | None = None) -> dict[str, str]:
    check_private()
    ensure_no_url_rewrites(workspace)
    ensure_no_url_rewrites(web)
    source_head, web_head = workspace_head or git_head(workspace), git_head(web)
    # Scan both source sets before any push, including all history that Git will transfer.
    entries, contents = committed_pi(workspace, source_head)
    web_mirror = snapshot.parent / "web-mirror.git"
    prepare_web_mirror(web, web_head, web_mirror, upstream_url)
    scan_web_history(web_mirror, web_head)
    remote = remote_heads(workspace, url)
    web_remote = remote.get("refs/heads/pi-web")
    if web_remote:
        result = git(web_mirror, "merge-base", "--is-ancestor", web_remote, web_head, allowed=(0, 1, 128))
        if result.returncode != 0:
            raise SyncError("Pi Web 远端分支不是本地已提交历史的祖先，停止同步")
    init_snapshot(snapshot)
    ensure_no_url_rewrites(snapshot)
    previous = reconcile_snapshot(snapshot, remote.get("refs/heads/main"))
    tree = snapshot_tree(snapshot, entries, contents)
    old_tree = text(git(snapshot, "rev-parse", f"{previous}^{{tree}}", bare=True)) if previous else None
    pi_head = previous
    if tree != old_tree:
        pi_head = make_snapshot(snapshot, tree, previous, source_head)
        git(snapshot, "update-ref", "refs/heads/pending", pi_head, bare=True)
        check_private()
        if remote_heads(workspace, url).get("refs/heads/main") != previous:
            raise SyncError("Pi 远端分支在同步期间发生变化")
        guarded_push(snapshot, url, "refs/heads/main", previous, pi_head)
        if remote_heads(workspace, url).get("refs/heads/main") != pi_head:
            raise SyncError("Pi 远端提交核对失败")
        git(snapshot, "update-ref", "refs/heads/main", pi_head, bare=True)
        git(snapshot, "update-ref", "-d", "refs/heads/pending", bare=True)
    if web_remote != web_head:
        check_private()
        if remote_heads(workspace, url).get("refs/heads/pi-web") != web_remote:
            raise SyncError("Pi Web 远端分支在同步期间发生变化")
        guarded_push(web_mirror, url, "refs/heads/pi-web", web_remote, web_head)
    check_private()
    final = remote_heads(workspace, url)
    if final.get("refs/heads/main") != pi_head or final.get("refs/heads/pi-web") != web_head:
        raise SyncError("远端分支最终核对失败")
    assert pi_head is not None
    return {"workspace": source_head, "main": pi_head, "pi-web": web_head}


def verify_committed_self(workspace: Path, head: str) -> None:
    script = Path(__file__).resolve()
    try:
        relative = script.relative_to(workspace.resolve()).as_posix()
    except ValueError as exc:
        raise SyncError("同步脚本不在预期工作区") from exc
    expected = git(workspace, "show", f"{head}:{relative}").stdout
    if hashlib.sha256(expected).digest() != hashlib.sha256(script.read_bytes()).digest():
        raise SyncError("同步脚本有未提交修改，停止同步")


def write_status(data: Path, success: bool, details: dict[str, str] | str) -> None:
    status_path = data / "status.json"
    old = {}
    try:
        old = json.loads(status_path.read_text())
    except (OSError, ValueError):
        pass
    if not isinstance(old, dict):
        old = {}
    stamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    result = {"lastAttempt": stamp, "ok": success, "details": details, "lastSuccess": old.get("lastSuccess")}
    if success:
        result["lastSuccess"] = {"at": stamp, "revisions": details}
    temp = data / "status.json.tmp"
    temp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    os.replace(temp, status_path)


def main() -> int:
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (DATA / "sync.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("已有同步正在运行，本次跳过")
            return 0
        try:
            def timeout_handler(_signum: int, _frame: object) -> None:
                raise SyncError("同步超过五分钟，已停止")
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(300)
            head = git_head(WORKSPACE)
            verify_committed_self(WORKSPACE, head)
            web = web_source(WORKSPACE, head)
            result = sync_once(WORKSPACE, web, DATA / "snapshot.git", REMOTE_URL, verify_private,
                               workspace_head=head)
            write_status(DATA, True, result)
            print("同步成功: " + json.dumps(result, ensure_ascii=False))
            return 0
        except (SyncError, OSError, ValueError) as exc:
            message = str(exc)
            try:
                write_status(DATA, False, message)
            except OSError:
                pass
            print("同步失败: " + message, file=sys.stderr)
            # Best effort only; notification permissions may be disabled.
            try:
                subprocess.run(["/usr/bin/osascript", "-e", 'display notification "请查看 Pi GitHub 同步状态和日志" with title "Pi 同步失败"'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
            except (OSError, subprocess.TimeoutExpired):
                pass
            return 1
        finally:
            signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
