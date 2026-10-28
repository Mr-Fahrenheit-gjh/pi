#!/usr/bin/env python3
"""Isolated real Pi TUI + installed ask_user_question, with no model calls or config writes."""
import json
import os
from pathlib import Path
import pty
import shutil
import socket
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent
PACKAGE = Path.home() / ".pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question"
if not (PACKAGE / "ask-user-question.ts").is_file():
    raise SystemExit("SKIP: installed ask_user_question package not found")

with tempfile.TemporaryDirectory(prefix="pib-cli-", dir="/tmp") as temporary:
    root = Path(temporary)
    (root / "home").mkdir()
    (root / "agent").mkdir()
    bridge = root / "bridge"
    result_file = root / "result.json"
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(root / "home"), "TMPDIR": "/tmp",
        "TERM": "xterm-256color", "PI_CODING_AGENT_DIR": str(root / "agent"),
        "PI_MENUBAR_BRIDGE_DIR": str(bridge), "PI_TEST_ASK_PACKAGE": str(PACKAGE),
        "PI_MENUBAR_TEST_RESULT": str(result_file), "PI_OFFLINE": "1", "OPENAI_API_KEY": "test-placeholder",
    }
    master, slave = pty.openpty()
    command = [shutil.which("pi"), "--no-extensions", "--no-mcp", "--no-skills", "--no-themes",
               "--no-prompt-templates", "--no-context-files", "--no-approve", "--no-session", "--offline",
               "--provider", "openai", "--model", "gpt-4.1", "-e", str(HERE.parent / "TerminalBridge/index.ts"),
               "-e", str(HERE / "terminal-cli-fixture.ts")]
    if not command[0]:
        raise SystemExit("SKIP: pi is not on PATH")
    process = subprocess.Popen(command, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    output = bytearray()

    def drain():
        try:
            while chunk := os.read(master, 8192):
                output.extend(chunk)
                if len(output) > 32768:
                    del output[:-32768]
        except OSError:
            pass

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        deadline = time.monotonic() + 20
        sockfile = None
        while time.monotonic() < deadline and process.poll() is None:
            matches = list(bridge.glob("t-*.sock")) if bridge.exists() else []
            if matches:
                sockfile = matches[0]
                break
            time.sleep(0.05)
        if sockfile is None:
            raise AssertionError("terminal bridge socket did not appear")
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(15)
        client.connect(str(sockfile))
        with client, client.makefile("rb") as incoming:
            prompt = None
            while prompt is None:
                line = incoming.readline()
                if not line:
                    raise AssertionError("terminal connection closed before question")
                snapshot = json.loads(line)
                if snapshot.get("type") == "snapshot" and snapshot.get("prompts"):
                    prompt = snapshot["prompts"][0]
            assert prompt["toolCallId"] == "real-cli-test" and prompt["canRespond"]
            assert prompt["questions"][0]["options"][1]["description"] == "原始说明 B"
            answer = {"type": "answer", "instanceId": snapshot["instanceId"], "sessionId": snapshot["sessionId"],
                      "toolCallId": "real-cli-test", "requestId": "real-request", "answers": [
                          {"questionIndex": 0, "optionIndexes": [1]},
                          {"questionIndex": 1, "optionIndexes": [0, 1], "text": "补充"}]}
            client.sendall((json.dumps(answer, ensure_ascii=False) + "\n").encode())
            while True:
                line = incoming.readline()
                if not line:
                    raise AssertionError("terminal connection closed before answer verdict")
                frame = json.loads(line)
                if frame.get("type") == "verdict":
                    assert frame.get("requestId") == "real-request" and frame.get("ok") is True, frame
                    break
        process.wait(timeout=15)
        assert process.returncode == 0, f"Pi exited {process.returncode}"
        result = json.loads(result_file.read_text())
        assert "error" not in result, result
        details = result.get("details", {})
        assert details.get("cancelled") is False, details
        answers = details.get("answers", [])
        assert len(answers) == 2, details
        assert answers[0].get("answer") == "选项 B", answers
        assert answers[1].get("selected") == ["甲", "乙"] and answers[1].get("answer") == "补充", answers
        print("PASS: isolated real Pi TUI + installed ask_user_question; exact single/multi/custom answer accepted, no model request")
    except Exception:
        print("Isolated TUI output tail:", output[-3000:].decode(errors="replace"))
        raise
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        os.close(master)
