#!/usr/bin/env python3
"""Check repeated /new and /reload in isolated real PTYs; no model or credentials."""
import json
import os
import re
from pathlib import Path
import shlex
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent
NPM = Path.home() / ".pi/agent/npm"


def tmux(*args):
    return subprocess.check_output(["tmux", *args], text=True)


def assert_no_extension_errors(screen):
    assert not re.search(r'Extension\s+"[\s\S]*?"\s+error:|Extension error|Failed to load extension', screen), screen


def verify_error_assertion():
    for screen in ('Extension "/tmp/fixture.ts" error: editor failed', 'Extension error: failed', 'Failed to load extension'):
        try:
            assert_no_extension_errors(screen)
        except AssertionError:
            continue
        raise AssertionError(f"extension-error assertion missed {screen!r}")


def run(mode):
    name = "pi-layout-" + uuid.uuid4().hex[:12]
    channel = name + "-ready"
    with tempfile.TemporaryDirectory(prefix="pi-session-layout-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        agent.mkdir()
        (agent / "npm").symlink_to(NPM, target_is_directory=True)
        fixture = root / "ready.ts"
        fixture.write_text('''import { execFileSync } from "node:child_process";
export default function(pi) {
  pi.on("session_start", async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    execFileSync("tmux", ["wait-for", "-S", process.env.PI_LAYOUT_READY]);
  });
}
''')
        (agent / "settings.json").write_text(json.dumps({
            "packages": [{"source": "npm:pi-beautiful-tui", "extensions": []}],
            "extensions": [str(ROOT / "beautiful-tui-filter.ts"), str(fixture)],
        }))
        (agent / "pi-beautiful-tui.json").write_text(json.dumps({
            "enabled": True, "style": "open-tui", "settingsLanguage": "en",
        }))
        env = {
            "HOME": str(root), "PI_CODING_AGENT_DIR": str(agent),
            "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1",
            "PI_LAYOUT_READY": channel, "TERM": "xterm-256color",
            "TERM_PROGRAM": "ghostty",
        }
        command = ["env", *[f"{key}={value}" for key, value in env.items()],
                   "pi", "--tui-mode", mode, "--provider", "openai-codex",
                   "--model", "gpt-6.1-sol", "--no-session", "--offline",
                   "--no-skills", "--no-prompt-templates", "--no-context-files",
                   "--no-themes", "--no-mcp"]
        try:
            tmux("new-session", "-d", "-s", name, "-x", "100", "-y", "52",
                 "-c", str(root), shlex.join(command))
            for step in range(12):
                subprocess.run(["tmux", "wait-for", channel], timeout=25, check=True)
                screen = tmux("capture-pane", "-p", "-t", name)
                for text in ("pi v1.4.0", "Let's build something great", "gpt-6.1-sol", "OpenAI Codex"):
                    assert text in screen, f"{mode} step {step}: missing {text!r}\n{screen}"
                assert screen.count("╭") >= 2 and screen.count("╰") >= 2, f"{mode} step {step}: incomplete header/editor\n{screen}"
                assert_no_extension_errors(screen)
                if step == 11:
                    break
                if step == 4:
                    tmux("resize-window", "-t", name, "-x", "80", "-y", "32")
                if step == 7:
                    tmux("resize-window", "-t", name, "-x", "120", "-y", "45")
                tmux("send-keys", "-t", name, "-l", "/reload" if step == 10 else "/new")
                tmux("send-keys", "-t", name, "Enter")
            print(f"PASS {mode}: startup + 10 /new + /reload; header, editor, footer preserved across resize")
        finally:
            subprocess.run(["tmux", "kill-session", "-t", name], capture_output=True)


if __name__ == "__main__":
    verify_error_assertion()
    for mode in ("fullscreen", "regular"):
        run(mode)
