#!/usr/bin/env python3
"""Exercise the installed Beautiful TUI in an isolated Pi pseudo-terminal."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent
PACKAGE_NPM = Path.home() / ".pi/agent/npm"
FIXTURE = '''export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("codex-computer-use", "codex-cua: computer on · browser on · ready");
    ctx.ui.setStatus("lsp", "LSP: 1/8 servers");
    ctx.ui.setStatus("codex-speed", "Codex fast");
  });
}
'''


def run_tui(
    filtered: bool,
    term_program: str | None = None,
    *,
    startup_order: str | None = None,
) -> str:
    with tempfile.TemporaryDirectory(prefix="pi-footer-smoke-") as temporary:
        root = Path(temporary)
        agent = root / "agent"
        agent.mkdir()
        (agent / "npm").symlink_to(PACKAGE_NPM, target_is_directory=True)
        fixture = root / "fixture.ts"
        fixture.write_text(FIXTURE)
        package = {"source": "npm:pi-beautiful-tui", "extensions": []} if filtered else "npm:pi-beautiful-tui"
        extensions = ([str(ROOT / "beautiful-tui-filter.ts")] if filtered else []) + [str(fixture)]
        packages = [package]
        config = {"footerSegments": {"extensionStatuses": True}}
        if startup_order is not None:
            assert filtered and startup_order in ("late", "early")
            # Explicit settings.extensions have priority over package resources.
            # Compare package-late UI with the active top-level wrapper.
            delay = root / "slow-start.ts"
            delay.write_text('''export default function (pi) {
  pi.on("session_start", async () => {
    process.stderr.write("STARTUP_PROBE_BEGIN\\n");
    await new Promise(resolve => setTimeout(resolve, 1200));
    process.stderr.write("STARTUP_PROBE_END\\n");
  });
}
''')
            wrapper = str(ROOT / "beautiful-tui-filter.ts")
            packages = [package, str(delay)]
            extensions = [str(fixture)]
            if startup_order == "early":
                extensions.insert(0, wrapper)
            else:
                packages.append(wrapper)
            config["settingsLanguage"] = "en"
        (agent / "settings.json").write_text(json.dumps({
            "packages": packages, "extensions": extensions,
        }))
        (agent / "pi-beautiful-tui.json").write_text(json.dumps(config))

        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(root),
            "PI_CODING_AGENT_DIR": str(agent),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
        }
        if term_program is not None:
            env["TERM_PROGRAM"] = term_program
        expected_status = "⚡".encode() if filtered else b"Codex fast"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
        process = subprocess.Popen(
            ["pi", "--provider", "openai-codex", "--model", "gpt-6.1-sol", "--no-session", "--offline", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-mcp"],
            cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
        )
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 20
        found_at = None
        try:
            while time.monotonic() < deadline and process.poll() is None:
                ready, _, _ = select.select([master], [], [], 0.2)
                if ready:
                    try:
                        chunk = os.read(master, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
                if expected_status in output and found_at is None:
                    found_at = time.monotonic()
                startup_finished = (
                    startup_order is None or b"STARTUP_PROBE_END" in output
                )
                if (found_at is not None and startup_finished
                        and time.monotonic() - found_at > 1):
                    break
        finally:
            if process.poll() is None:
                os.write(master, b"/quit\r")
                stop_deadline = time.monotonic() + 2
                while process.poll() is None and time.monotonic() < stop_deadline:
                    ready, _, _ = select.select([master], [], [], 0.1)
                    if ready:
                        try:
                            output.extend(os.read(master, 65536))
                        except OSError:
                            break
                if process.poll() is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                process.wait(timeout=4)
            os.close(master)
        return output.decode("utf-8", "replace")


def verify_startup_order() -> None:
    header = "Let's build something great"
    late = run_tui(True, startup_order="late")
    early = run_tui(True, startup_order="early")
    assert late.index("STARTUP_PROBE_END") < late.index(header), (
        "baseline must reproduce late UI"
    )
    assert early.index(header) < early.index("STARTUP_PROBE_END"), (
        "UI must appear before slow initialization completes"
    )
    for output in (late, early):
        themed_output = output[output.index(header):]
        assert "⚡" in themed_output and "LSP" not in themed_output, "only model lightning should remain"
        assert "codex-cua:" not in themed_output, "CU filtering must survive"
        for error in ("Extension error", "Failed to load extension"):
            assert error not in output, output[-3000:]
    print("PASS: UI appears before 1200ms initialization; filtering intact")


if __name__ == "__main__":
    import sys
    if "--startup-order" in sys.argv:
        verify_startup_order()
        sys.exit(0)
    original = run_tui(False)
    assert "LSP: 1/8 servers" in original and "codex-cua:" in original, f"baseline missing statuses: {original[-3000:]}"
    filtered = run_tui(True)
    assert "⚡" in filtered and "Codex fast" not in filtered and "LSP" not in filtered, f"unexpected filtered statuses: {filtered[-3000:]}"
    assert "codex-cua:" not in filtered, f"computer-use status still visible: {filtered[-3000:]}"
    assert "Extension error" not in filtered and "Failed to load extension" not in filtered, filtered[-3000:]
    ghostty = run_tui(True, "ghostty")
    assert "⚡" in ghostty and "Codex fast" not in ghostty and "LSP" not in ghostty and "codex-cua:" not in ghostty, ghostty[-3000:]
    assert "" not in ghostty, "extension-status row must be absent"
    for glyph in ("", "", "", ""):
        assert glyph in ghostty, f"Ghostty icon {glyph!r} missing: {ghostty[-3000:]}"
        assert glyph not in filtered, f"unknown terminal should keep ASCII fallback: {glyph!r}"
    assert "Extension error" not in ghostty and "Failed to load extension" not in ghostty, ghostty[-3000:]
    herdr = run_tui(True, "herdr")
    assert "⚡" in herdr and "Codex fast" not in herdr and "LSP" not in herdr and "codex-cua:" not in herdr, herdr[-3000:]
    assert "Extension error" not in herdr and "Failed to load extension" not in herdr, herdr[-3000:]
    assert "" not in herdr, "extension-status row must be absent"
    for glyph in ("", "", "", ""):
        assert glyph in herdr, f"Herdr icon {glyph!r} missing: {herdr[-3000:]}"
    print("PASS: isolated TUI preserves fallback/Ghostty/Herdr icons and shows Fast as model lightning only")
