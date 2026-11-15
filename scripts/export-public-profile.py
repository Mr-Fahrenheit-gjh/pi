#!/usr/bin/env python3
"""Export a static, reviewed public profile. Never installs or loads Pi resources.

All roots are explicit. The adjacent allowlist is the complete payload authority;
there is no recursive discovery, private-sync integration, or home-directory default.
The output root may contain the exporter, but existing payloads are never overwritten.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

HERE = Path(__file__).resolve().parent
ALLOWLIST = HERE / "export-public-profile.allowlist.json"
RESTRICTED = ("claude-design", "claude-slides", "claude-design-system", "claude-dashboard", "dataviz")
NPM_PACKAGES = (
    "pi-web-access", "@juicesharp/rpiv-ask-user-question", "@juicesharp/rpiv-todo",
    "pi-lsp-adapter", "@narumitw/pi-btw", "pi-powerline-footer", "pi-subagents",
    "pi-beautiful-tui", "pi-background-task", "notesoup", "@buyong/pi-codex-computer-use",
)
SOURCE_TOOLS = (
    "hy-memory迁移", "pi-prompt-suggestions", "pi-subagents-quiet", "pi-interrupt",
    "pi-background-task-quiet", "pi-workflow-integrity",
)
DENIED_PARTS = {
    ".git", "node_modules", "__pycache__", ".cache", "cache", "caches", "logs",
    "state", "sessions", "archives", "backups", "backup", "系统数据",
    "pi-meta", "feynman", ".api-key", "prompt-suggestions.json",
}
ALLOWED_SUFFIXES = {
    ".md", ".json", ".yaml", ".yml", ".tex", ".txt", ".mjs", ".js", ".ts",
    ".py", ".sh", ".lock", ".png", ".jpg", ".tsv", ".patch",
}
ALLOWED_BASENAMES = {".ignore", ".gitignore", "LICENSE", "watch-pr"}
SETTINGS_KEYS = ("packages", "extensions", "skills", "prompts")


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def relative_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(p in {".", ".."} for p in path.parts):
        raise ValueError(f"Not a safe relative path: {value}")
    if "\\" in value or str(path) != value:
        raise ValueError(f"Not a canonical relative path: {value}")
    return path


def allowed_payload(value):
    path = relative_path(value)
    parts = {p.lower() for p in path.parts}
    if parts & DENIED_PARTS or any(p.startswith(".env") or p.endswith((".bak", ".backup", ".jsonl")) for p in parts):
        raise ValueError(f"Private/runtime path rejected: {value}")
    if path.suffix not in ALLOWED_SUFFIXES and path.name not in ALLOWED_BASENAMES:
        raise ValueError(f"Unreviewed payload type: {value}")
    if "skills" in path.parts and any(name in path.parts for name in RESTRICTED):
        raise ValueError(f"Restricted skill payload rejected: {value}")


def source_path(root, value):
    """No symlinks, even within a source tree. Known skill links use workspace paths."""
    path = root
    for part in relative_path(value).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"Source symlink rejected: {value}")
    if not path.is_file():
        raise ValueError(f"Missing regular source file: {value}")
    return path


@contextmanager
def anchored_directory(directory, create=False):
    """Bind to verified directory identities before any single-leaf operation."""
    previous = Path.cwd()
    try:
        os.chdir(directory.anchor)
        for part in directory.parts[1:]:
            try:
                info = os.lstat(part)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, mode=0o700)
                info = os.lstat(part)
            reparse = getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
            if stat.S_ISLNK(info.st_mode) or reparse:
                raise ValueError(f"Directory link rejected: {directory}")
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError(f"Not a source/output directory: {directory}")
            os.chdir(part)
            if not os.path.samestat(info, os.stat(".")):
                raise ValueError(f"Directory changed during traversal: {directory}")
        yield
    finally:
        os.chdir(previous)


def read_source(root, value):
    path = source_path(root, value)
    with anchored_directory(path.parent):
        info = os.lstat(path.name)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"Source is not a regular file: {value}")
        descriptor = os.open(path.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            if not os.path.samestat(info, os.fstat(descriptor)):
                raise ValueError(f"Source changed during open: {value}")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                return stream.read(), info.st_mode
        finally:
            os.close(descriptor)


def replace_paths(text, workspace, agent):
    # Longest first, including the approved snapshot's original author prefixes.
    replacements = {
        str(workspace): "{{REPO_ROOT}}", str(agent): "{{AGENT_DIR}}",
        "/Users/guojiahang/Documents/pi": "{{REPO_ROOT}}",
        "/Users/guojiahang/.pi/agent": "{{AGENT_DIR}}",
    }
    for old, new in sorted(replacements.items(), key=lambda item: -len(item[0])):
        text = text.replace(old, new)
    return text


def render(data, transform, workspace, agent):
    if transform == "verbatim":
        return data
    if transform != "template":
        raise ValueError(f"Unknown transform: {transform}")
    return replace_paths(data.decode("utf-8"), workspace, agent).encode("utf-8")


def portable_document(destination, data):
    """Keep the source snapshot, but make active rules describe this public checkout."""
    if destination == "public-config/workspace/AGENTS.md":
        text = data.decode("utf-8")
        text = text.replace("适用于 `{{REPO_ROOT}}` 及子目录", "适用于使用者选择的工作区及子目录")
        text = text.replace("项目/规则优化/运行规则/references/repositories.md", "{{REPO_ROOT}}/项目/规则优化/运行规则/references/repositories.md")
        text = text.replace("`.pi/skills/pi-web-maintenance/SKILL.md`", "`{{REPO_ROOT}}/.pi/skills/pi-web-maintenance/SKILL.md`")
        text = text.replace("`项目/规则优化/运行规则/README.md`", "`{{REPO_ROOT}}/项目/规则优化/运行规则/README.md`")
        return text.encode("utf-8")
    if destination == "项目/规则优化/运行规则/references/repositories.md":
        note = ("# 公开分发适用范围\n\n本公开包是单一 Git checkout，不包含作者的个人独立仓库清单或本机发布工作树。"
                "先用当前仓库的 Git 状态和实际目录确认范围；以下历史仓库/launchd发布说明仅供维护源码参考，"
                "不得据此寻找作者目录、覆盖全局安装或重启服务。公开应用使用根目录 start.cmd/start.sh。\n\n")
        return note.encode("utf-8") + data
    return data


def safe_output_root(output, workspace, agent):
    absolute = output.absolute()
    for parent in (absolute, *absolute.parents):
        if parent.is_symlink() and not (parent == Path("/tmp") and parent.resolve() == Path("/private/tmp")):
            raise ValueError("Output ancestors must not be symlinks (except macOS /tmp)")
    output = absolute.resolve()
    for source in (workspace, agent):
        if output == source or output.is_relative_to(source) or source.is_relative_to(output):
            raise ValueError("Output and source roots must not overlap")
    if any((parent / ".git").exists() for parent in (output, *output.parents)):
        raise ValueError("Refusing to export into a Git working tree")
    return output


def safe_destination(output, value):
    relative_path(value)
    path = output
    for part in PurePosixPath(value).parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f"Output symlink rejected: {value}")
        if (path / ".git").exists():
            raise ValueError(f"Nested Git tree rejected: {value}")
    if path.exists():
        raise ValueError(f"Refusing to overwrite existing payload: {value}")
    return path


def settings_template(workspace, agent):
    """Read only declared resource fields; never serialize other settings fields."""
    original = json.loads(read_source(agent, "settings.json")[0])
    selected = {key: original[key] for key in SETTINGS_KEYS if key in original}
    if not isinstance(selected.get("packages"), list) or not isinstance(selected.get("extensions"), list):
        raise ValueError("Expected explicit packages/extensions arrays")
    inputs = [{"source": "agent:settings.json#packages,extensions,skills,prompts", "projectionSha256": sha256(json_bytes(selected))}]
    packages = []
    installed = []
    seen = []
    for package in selected["packages"]:
        if not isinstance(package, (str, dict)):
            raise ValueError("Unexpected package declaration")
        declaration = package if isinstance(package, str) else package.get("source")
        if not isinstance(declaration, str):
            raise ValueError("Missing package source")
        if isinstance(package, dict) and set(package) - {"source", "extensions", "skills", "prompts", "themes"}:
            raise ValueError("Unreviewed package fields")
        if declaration.startswith("npm:"):
            match = re.fullmatch(r"npm:((?:@[^/@]+/)?[^/@]+)(?:@([^/]+))?", declaration)
            if not match or match[1] not in NPM_PACKAGES:
                raise ValueError(f"Unreviewed npm dependency: {declaration}")
            name, declared_version = match.groups()
            # Explicit metadata-only exception: no package code or dependencies are copied/loaded.
            metadata_rel = f"npm/node_modules/{name}/package.json"
            metadata_bytes = read_source(agent, metadata_rel)[0]
            metadata = json.loads(metadata_bytes)
            version = metadata.get("version")
            if metadata.get("name") != name or not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version):
                raise ValueError(f"Invalid installed metadata: {name}")
            if declared_version and declared_version != version:
                raise ValueError(f"Declared/installed version drift: {name}")
            replacement = f"npm:{name}@{version}"
            seen.append(name)
            installed.append({"name": name, "version": version, "license": metadata.get("license"), "repository": metadata.get("repository"), "source": f"agent:{metadata_rel}", "sha256": sha256(metadata_bytes)})
        elif declaration in {str(agent / "hy-memory/runtime/plugin"), "/Users/guojiahang/.pi/agent/hy-memory/runtime/plugin"}:
            replacement = "{{REPO_ROOT}}/工具/hy-memory迁移"
        elif declaration == "../../Documents/pi/工具/pi-prompt-suggestions":
            replacement = "{{REPO_ROOT}}/工具/pi-prompt-suggestions"
        else:
            raise ValueError(f"Unreviewed local dependency: {declaration}")
        packages.append(replacement if isinstance(package, str) else {**package, "source": replacement})
    if sorted(seen) != sorted(NPM_PACKAGES):
        raise ValueError("Installed package set changed; review the static package allowlist")
    selected["packages"] = packages
    selected = json.loads(replace_paths(json.dumps(selected, ensure_ascii=False), workspace, agent))
    expected_extensions = [
        "{{REPO_ROOT}}/工具/pi-web维护/终端状态过滤/beautiful-tui-filter.ts",
        "-{{AGENT_DIR}}/extensions/powerline-terminal.ts",
    ]
    if selected["extensions"] != expected_extensions:
        raise ValueError("Extension declarations changed; review before exporting")
    # These directories are discovered through local symlinks on the source
    # machine. Public imports use explicit checkout paths instead of exporting
    # symlinks or accidentally losing the wrappers while upstream stays disabled.
    selected["extensions"] += [
        "{{REPO_ROOT}}/工具/pi-background-task-quiet/index.ts",
        "{{REPO_ROOT}}/工具/pi-subagents-quiet/index.ts",
        "{{REPO_ROOT}}/工具/pi-codex-speed/index.ts",
        "{{REPO_ROOT}}/工具/pi-auto-title/index.ts",
        "{{REPO_ROOT}}/工具/pi-task-recovery/index.ts",
        "{{REPO_ROOT}}/工具/pi-workflow-integrity/index.ts",
        "{{REPO_ROOT}}/工具/pi-menubar/TerminalBridge/index.ts",
    ]
    # These are absent in this snapshot. Explicit future empty arrays may be kept,
    # but arbitrary author-local resource paths must not be silently exported.
    for key in ("skills", "prompts"):
        if key in selected and selected[key] != []:
            raise ValueError(f"Unreviewed top-level resource declarations: {key}")
    return selected, inputs, installed


def requirements():
    return {
        "schemaVersion": 1,
        "settingsTemplate": "agent/settings.template.json",
        "importPolicy": {
            "default": ["agent/APPEND_SYSTEM.md", "agent/rules/", "agent/agents/", "agent/skills/"],
            "withExtensionsOnly": ["agent/extensions/", "agent/settings.template.json -> settings.json"],
            "workspaceRequiresExplicitOptIn": "workspace/AGENTS.md; never replace the Web development AGENTS.md implicitly",
            "packageActivation": "Writing package declarations can trigger installation on the next Pi start. Only opt-in --with-extensions may configure them; copying is not activation or availability proof.",
            "disabledFilters": "Preserve empty package filter arrays and negative extension entries; do not expand them into defaults.",
        },
        "optionalEnvironments": [
            {"id": "memory", "requires": ["工具/hy-memory迁移 adapter and separately configured Hy-Memory service", "user-owned configuration/token; no memory/token/model payload included"], "defaultAction": "Do not start a service or scan/import existing memories"},
            {"id": "browser", "requires": ["user-selected Chrome/backend and matching computer-use host", "OpenCLI + Browser Bridge for authenticated OpenCLI tasks", "separate Playwright MCP localhost:8931 only if configured"], "defaultAction": "No browser/profile/login/service is opened by import"},
            {"id": "lsp", "requires": ["pi-lsp-adapter-compatible host", "separately installed language servers for selected languages"], "defaultAction": "Do not install language servers"},
            {"id": "tmux", "requires": ["tmux and compatible shell/PTY for background terminals"], "defaultAction": "Do not start terminals/tasks"},
            {"id": "mac", "requires": ["macOS launchd/Homebrew paths only for optional pi-web-service and maintenance wrappers", "macOS Keychain + already authorized agent-browser for password-fill", "optional Herdr socket/pane environment for herdr-agent-state"], "defaultAction": "Do not read Keychain, enumerate accounts, register launchd, or activate platform-specific helpers"},
            {"id": "history", "requires": ["explicit user-selected archive root", "QMD/Obsidian/archive integration configured separately"], "defaultAction": "Do not run archive_health.py with its author-specific default; no archive/index/session data is shipped"},
            {"id": "search-proxy-and-typesetting", "requires": ["user-provided BRAVE_API_KEY if Brave search is selected", "explicit user proxy configuration before proxy-env use", "separately installed TeX tools/fonts for latex-homework"], "defaultAction": "Do not import .api-key, proxy rules.yaml, install tools, or enable the author's proxy"},
        ],
        "hostCompatibility": [
            "Seven roles rely on the customized pi-subagents host for advertised roles, nested tools and inheritance/fork settings.",
            "Empty upstream pi-subagents/background-task extension filters remain empty; settings explicitly register their local quiet adapters instead of source-machine symlinks.",
            "Package installation or copying direct extension source does not prove terminal/Web discovery, reload, model response or external-service readiness.",
        ],
    }


def skill_provenance():
    local = {name: {"source": f"agent:skills/{name}", "licenseStatus": "not independently verified; no new license assigned"} for name in (
        "brave-search", "browser-harness", "domain-modeling", "frontend-design", "grill-with-docs", "grilling",
        "history-recall", "latex-homework", "mcp-wiring", "opencli-adapter-author", "opencli-autofix", "opencli-browser",
        "opencli-usage", "password-fill", "pi-upgrade-check", "pi-web-candidate", "pi-web-service", "project-scaffold",
        "proxy-env", "research-method", "smart-search", "socratic-tutor", "teach", "pstack",
    )}
    local["pstack"] = {"source": "workspace:.pi/skills/pstack", "upstream": "https://github.com/cursor/plugins/tree/main/pstack", "license": "MIT (upstream/LICENSE)", "evidence": "upstream/MIRROR.md and upstream/LICENSE; local wrapper/working-copy edits preserved, no reset or Git-clean assumption", "snapshot": "per-file original hashes include existing uncommitted poteto-mode edits"}
    local["frontend-design"].update({"upstream": "https://github.com/anthropics/claude-plugins-official", "revision": "a7ba5b93db0c7c8d17f3f1d25853adca79598a1a", "path": "plugins/frontend-design/skills/frontend-design", "license": "Apache-2.0", "licenseStatus": "included LICENSE.txt and existing design-skills/sources.json provenance"})
    local["teach"].update({"license": "MIT", "licenseStatus": "included LICENSE, copyright Matt Pocock; no additional upstream revision asserted"})
    local["socratic-tutor"].update({"license": "MIT", "licenseStatus": "included LICENSE.md, copyright Jane Street Group; no additional upstream revision asserted"})
    local["brave-search"].update({"license": "MIT declared in package.json", "licenseStatus": "local package metadata declaration only; no standalone license file found"})
    local["history-recall"]["source"] = "workspace:项目/规则优化/agent-eval-20261002/skills/history-recall"
    for name in ("opencli-adapter-author", "opencli-autofix", "opencli-browser", "opencli-usage", "smart-search"):
        local[name]["relatedUpstream"] = "https://github.com/jackwener/OpenCLI (project reference, not proof of identical skill contents or license)"
    return local


def export(workspace, agent, output):
    workspace, agent = workspace.resolve(strict=True), agent.resolve(strict=True)
    if not workspace.is_dir() or not agent.is_dir() or workspace == Path("/") or agent == Path("/"):
        raise ValueError("Explicit workspace and agent directories are required")
    output = safe_output_root(output, workspace, agent)
    allowlist_bytes = ALLOWLIST.read_bytes()
    manifest = json.loads(allowlist_bytes)
    if manifest.get("schemaVersion") != 1:
        raise ValueError("Unsupported allowlist schema")
    payloads, records, destinations, code_paths = [], [], set(), []
    for item in manifest["files"]:
        if set(item) != {"root", "path", "destination", "transform"} or item["root"] not in {"workspace", "agent"}:
            raise ValueError("Invalid static allowlist entry")
        allowed_payload(item["path"])
        allowed_payload(item["destination"])
        destination = item["destination"]
        if destination in destinations:
            raise ValueError(f"Duplicate destination: {destination}")
        destinations.add(destination)
        source = source_path(workspace if item["root"] == "workspace" else agent, item["path"])
        data, source_mode = read_source(workspace if item["root"] == "workspace" else agent, item["path"])
        if item["path"] == "agents/settings.json":
            value = json.loads(data)
            if set(value) != {"version", "builtInEnabled", "disabledBuiltIns"} or value != {"version": 1, "builtInEnabled": False, "disabledBuiltIns": ["plan", "general-purpose", "explore"]}:
                raise ValueError("Role settings changed; review safe fields")
        if item["path"] == "extensions/subagent/config.json":
            value = json.loads(data)
            expected = {"globalConcurrencyLimit": 3, "maxActiveAsyncRunsPerSession": 3, "maxSubagentDepth": 2, "scheduledRuns": {"enabled": False}, "toolActivation": "eager"}
            if value != expected:
                raise ValueError("Subagent config changed; review safe fields")
        rendered = portable_document(destination, render(data, item["transform"], workspace, agent))
        mode = 0o755 if source_mode & stat.S_IXUSR else 0o644
        payloads.append((destination, rendered, mode))
        records.append({"path": destination, "source": f"{item['root']}:{item['path']}", "sourceSha256": sha256(data), "sha256": sha256(rendered), "bytes": len(rendered), "mode": oct(mode), "transform": item["transform"]})
        if item["transform"] == "verbatim" and source.suffix in {".sh", ".mjs", ".js", ".ts", ".py"}:
            text = data.decode("utf-8")
            hints = []
            for number, line in enumerate(text.splitlines(), 1):
                if re.search(r"/Users/|/opt/homebrew|Obsidian Vault|pi-route|launchctl|cn\.pi\.web", line):
                    hints.append(number)
            if hints:
                code_paths.append({"path": destination, "lines": hints, "action": "Review machine/platform defaults before optional execution; code preserved verbatim, not token-rewritten into executable strings"})
    settings, input_records, installed = settings_template(workspace, agent)
    for name, value in (("public-config/agent/settings.template.json", settings), ("public-config/settings.requirements.json", requirements())):
        data = json_bytes(value)
        payloads.append((name, data, 0o644))
        records.append({"path": name, "source": "generated:allowlisted-resource-declarations" if name.endswith("settings.template.json") else "generated:optional-environment-contract", "sha256": sha256(data), "bytes": len(data), "mode": "0o644", "transform": "generated"})
    license_source = "项目/规则优化/运行规则/design-skills/sources.json"
    license_provenance = json.loads(next(data for path, data, _ in payloads if path == license_source))
    summary = {
        "schemaVersion": 1,
        "scope": "independent static public profile snapshot; no installation, upload, activation or private sync",
        "sourceRoots": {"workspace": "{{REPO_ROOT}}", "agent": "{{AGENT_DIR}}"},
        "templateTokens": ["{{REPO_ROOT}}", "{{AGENT_DIR}}"],
        "templatePolicy": "Render text documents/config templates only. Executable tool sources remain verbatim; machine defaults are listed for parent adaptation. Do not run templates before import.",
        "portableAdaptations": ["workspace AGENTS scopes the selected workspace and locates references in the checkout", "repository rules distinguish this public checkout from the author's private worktrees", "source-machine extension symlinks become explicit quiet-adapter paths in opt-in settings"],
        "settingsRequirements": "settings.requirements.json",
        "inputs": input_records,
        "exporter": {"source": "exporter:scripts/export-public-profile.py", "sha256": sha256(Path(__file__).read_bytes()), "allowlistSource": "exporter:scripts/export-public-profile.allowlist.json", "allowlistSha256": sha256(allowlist_bytes)},
        "packages": installed,
        "skills": skill_provenance(),
        "restrictedSkills": {"names": list(RESTRICTED), "status": "source-manifest-and-local-patch-only; no skill text, editor, font, runtime or other restricted material copied", "sourceManifest": license_source, "patch": "项目/规则优化/运行规则/design-skills/baoyu-pi.patch", "patchBoundary": "Existing user-maintained host adaptation patch only; not a license to redistribute the upstream materials. Obtain authorized upstream separately, without implicit download/install.", "upstream": [s for s in license_provenance["sources"] if any(n in s["skills"] for n in RESTRICTED)], "recordedFingerprints": {n: license_provenance["skills"][n] for n in RESTRICTED}, "fingerprintNote": "Restricted fingerprints are historical records from the approved source manifest, not newly read or recomputed restricted payloads"},
        "excluded": ["Pi Meta", "Feynman", "personal memories/chat/learning records", "credentials/accounts/browser state", ".api-key", "node_modules payloads", ".git", "backups/caches/logs/state", "private prompt-suggestions.json", "proxy rules.yaml", "MCP private config and environment", "all non-allowlisted source files"],
        "existingPublicToolReferences": [{"path": f"工具/{name}", "referenceTree": "工具/pi-platform-compat", "status": "existing public tree reference only, not re-copied or activated"} for name in SOURCE_TOOLS],
        "machineDefaultReview": code_paths,
        "payloadFiles": sorted(records, key=lambda item: item["path"]),
        "payloadCount": len(records),
        "payloadBytes": sum(item["bytes"] for item in records),
        "hashPolicy": "SHA-256 of raw source bytes and exported payload bytes. sources.json is metadata and intentionally not self-hashed. Settings input hash covers only the allowed resource-field projection. All source identifiers are root-relative, not author absolute paths.",
    }
    payloads.append(("public-config/sources.json", json_bytes(summary), 0o644))
    # Complete all reads, rendering and collision/symlink checks before creating output.
    paths = [(safe_destination(output, name), data, mode) for name, data, mode in payloads]
    for path, data, mode in paths:
        with anchored_directory(path.parent, create=True):
            with open(path.name, "xb") as stream:
                stream.write(data)
                if hasattr(os, "fchmod"):
                    os.fchmod(stream.fileno(), mode)
    return {"files": len(payloads), "bytes": sum(len(data) for _, data, _ in payloads), "payloadFiles": len(records), "payloadBytes": summary["payloadBytes"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True, help="Explicit authorized workspace source root")
    parser.add_argument("--agent-dir", type=Path, required=True, help="Explicit authorized agent code/config root; no other home discovery")
    parser.add_argument("--output", type=Path, required=True, help="Non-Git output bundle root; existing payload files are rejected")
    args = parser.parse_args()
    try:
        result = export(args.workspace, args.agent_dir, args.output)
    except (ValueError, OSError, KeyError, TypeError, UnicodeError) as error:
        parser.exit(1, f"Export rejected: {error}\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
