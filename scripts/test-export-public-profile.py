#!/usr/bin/env python3
"""Offline synthetic tests. Fixtures use an isolated OS temporary directory."""
import builtins
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("public_export", HERE / "export-public-profile.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pi-export-tests-", dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.workspace = self.base / "workspace"
        self.agent = self.base / "agent"
        self.workspace.mkdir()
        self.agent.mkdir()

    def put(self, root, name, data):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else exporter.json_bytes(data))
        return path

    def settings(self):
        packages = []
        for name in exporter.NPM_PACKAGES:
            self.put(self.agent, f"npm/node_modules/{name}/package.json", {"name": name, "version": "1.2.3"})
            packages.append({"source": f"npm:{name}@1.2.3", "extensions": [], "skills": [], "prompts": []} if name == "pi-subagents" else f"npm:{name}")
        packages += [str(self.agent / "hy-memory/runtime/plugin"), "../../Documents/pi/工具/pi-prompt-suggestions"]
        return self.put(self.agent, "settings.json", {
            "packages": packages,
            "extensions": [str(self.workspace / "工具/pi-web维护/终端状态过滤/beautiful-tui-filter.ts"), "-" + str(self.agent / "extensions/powerline-terminal.ts")],
            "model": "PRIVATE-MODEL-SENTINEL",
            "privateField": "PRIVATE-SETTINGS-SENTINEL",
        })

    def manifest(self):
        source = "项目/规则优化/运行规则/design-skills/sources.json"
        self.put(self.workspace, source, {"sources": [{"skills": list(exporter.RESTRICTED), "repository": "https://example.invalid/source", "revision": "fixture"}], "skills": {name: {"fixture": True} for name in exporter.RESTRICTED}})
        self.put(self.workspace, "APPEND.md", (str(self.workspace) + "\n" + str(self.agent)).encode())
        self.put(self.workspace, "tool.mjs", b'const root = "/Users/guojiahang/Documents/pi";\n')
        files = [
            {"root": "workspace", "path": source, "destination": source, "transform": "template"},
            {"root": "workspace", "path": "APPEND.md", "destination": "public-config/agent/APPEND_SYSTEM.md", "transform": "template"},
            {"root": "workspace", "path": "tool.mjs", "destination": "工具/tool.mjs", "transform": "verbatim"},
        ]
        return self.put(self.base, "allowlist.json", {"schemaVersion": 1, "files": files})

    def test_required_arguments_have_no_personal_defaults(self):
        source = (HERE / "export-public-profile.py").read_text()
        for flag in ("--workspace", "--agent-dir", "--output"):
            self.assertIn(f'parser.add_argument("{flag}", type=Path, required=True', source)
        self.assertNotIn("Path.home()", source)

    def test_deny_private_paths_and_restricted_skill_content(self):
        for path in (".api-key", "skills/a/.api-key", "node_modules/pkg/package.json", ".git/config", "logs/a.md", "state/a.json", "prompt-suggestions.json", "skills/claude-slides/SKILL.md", "pi-meta/main.ts", "feynman/SKILL.md", "x.jsonl", "a.bak", "../../secret.md", "/absolute.md"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                exporter.allowed_payload(path)
        exporter.allowed_payload("skills/teach/LEARNING-RECORD-FORMAT.md")
        exporter.allowed_payload("design-skills/baoyu-pi.patch")

    def test_source_symlink_rejected_before_read(self):
        secret = self.put(self.base, "private.md", b"SYNTHETIC-DO-NOT-READ")
        (self.workspace / "linked.md").symlink_to(secret)
        with self.assertRaisesRegex(ValueError, "symlink"):
            exporter.source_path(self.workspace, "linked.md")

    def test_output_source_overlap_git_and_symlink_rejected(self):
        for output in (self.workspace, self.workspace / "subdir", self.base):
            with self.assertRaisesRegex(ValueError, "overlap"):
                exporter.safe_output_root(output, self.workspace, self.agent)
        fake_git = self.base / "not-a-real-repository"
        (fake_git / ".git").mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "Git"):
            exporter.safe_output_root(fake_git / "output", self.workspace, self.agent)
        linked = self.base / "linked-output"
        linked.symlink_to(self.base / "elsewhere")
        with self.assertRaisesRegex(ValueError, "symlink"):
            exporter.safe_output_root(linked, self.workspace, self.agent)

    def test_settings_projection_pins_and_preserves_empty_filters_and_disable(self):
        self.settings()
        settings, inputs, installed = exporter.settings_template(self.workspace, self.agent)
        self.assertEqual(set(settings), {"packages", "extensions"})
        self.assertEqual(len(installed), len(exporter.NPM_PACKAGES))
        package = next(p for p in settings["packages"] if isinstance(p, dict))
        self.assertEqual(package, {"source": "npm:pi-subagents@1.2.3", "extensions": [], "skills": [], "prompts": []})
        self.assertEqual(settings["extensions"][1], "-{{AGENT_DIR}}/extensions/powerline-terminal.ts")
        self.assertIn("{{REPO_ROOT}}/工具/pi-subagents-quiet/index.ts", settings["extensions"])
        self.assertIn("{{REPO_ROOT}}/工具/pi-background-task-quiet/index.ts", settings["extensions"])
        self.assertEqual(len(settings["extensions"]), 9)
        serialized = json.dumps([settings, inputs, installed])
        self.assertNotIn("PRIVATE-", serialized)
        self.assertNotIn(str(self.base), serialized)
        self.assertIn("{{REPO_ROOT}}/工具/hy-memory迁移", settings["packages"])

    def test_installed_version_drift_and_unknown_package_fail_closed(self):
        path = self.settings()
        settings = json.loads(path.read_text())
        settings["packages"][0] = "npm:pi-web-access@9.9.9"
        path.write_bytes(exporter.json_bytes(settings))
        with self.assertRaisesRegex(ValueError, "version drift"):
            exporter.settings_template(self.workspace, self.agent)
        settings["packages"][0] = "npm:unreviewed-package"
        path.write_bytes(exporter.json_bytes(settings))
        with self.assertRaisesRegex(ValueError, "Unreviewed npm"):
            exporter.settings_template(self.workspace, self.agent)

    def test_replaced_output_ancestor_cannot_redirect_write(self):
        self.settings()
        manifest = self.manifest()
        output, outside = self.base / "output", self.base / "outside"
        outside.mkdir()
        original = builtins.open
        attempted = []

        def racing_open(file, mode="r", *args, **kwargs):
            if mode == "xb" and not attempted:
                attempted.append(True)
                output.rename(self.base / "selected-output")
                output.symlink_to(outside, target_is_directory=True)
            return original(file, mode, *args, **kwargs)

        with patch.object(exporter, "ALLOWLIST", manifest), patch.object(builtins, "open", racing_open):
            with self.assertRaisesRegex(ValueError, "link rejected"):
                exporter.export(self.workspace, self.agent, output)
        self.assertTrue(attempted)
        self.assertEqual(list(outside.iterdir()), [])

    def test_export_hashes_reproducibility_templates_and_no_private_discovery(self):
        self.settings()
        manifest = self.manifest()
        self.put(self.agent, ".api-key", b"SYNTHETIC-SECRET-NOT-EXPORTED")
        first, second = self.base / "first", self.base / "second"
        with patch.object(exporter, "ALLOWLIST", manifest):
            report = exporter.export(self.workspace, self.agent, first)
            self.assertEqual(report, exporter.export(self.workspace, self.agent, second))
            before = {p.relative_to(first).as_posix(): p.read_bytes() for p in first.rglob("*") if p.is_file()}
            with self.assertRaisesRegex(ValueError, "overwrite"):
                exporter.export(self.workspace, self.agent, first)
            self.assertEqual(before, {p.relative_to(first).as_posix(): p.read_bytes() for p in first.rglob("*") if p.is_file()})
        after = {p.relative_to(second).as_posix(): p.read_bytes() for p in second.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        sources = json.loads(before["public-config/sources.json"])
        for item in sources["payloadFiles"]:
            self.assertEqual(item["sha256"], exporter.sha256(before[item["path"]]))
        self.assertEqual(before["public-config/agent/APPEND_SYSTEM.md"], b"{{REPO_ROOT}}\n{{AGENT_DIR}}")
        self.assertEqual(before["工具/tool.mjs"], b'const root = "/Users/guojiahang/Documents/pi";\n')
        self.assertNotIn(str(self.base), before["public-config/sources.json"].decode())
        self.assertFalse(any("SYNTHETIC-SECRET" in b.decode() for b in before.values()))
        self.assertEqual(sources["machineDefaultReview"][0]["path"], "工具/tool.mjs")


if __name__ == "__main__":
    unittest.main(verbosity=2)
