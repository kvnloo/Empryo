#!/usr/bin/env python3
"""POSIX PTY acceptance: real Bun boot -> Tern SDK -> runChat -> local Ollama adapter.

Only stdlib Python + Bun. All model replies come from the synthetic 127.0.0.1
fixture, never from a credentialed or external provider. No fake SDK Session.
"""
from __future__ import annotations

import json
import os
import pty
import select
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
ESC = b"\x1b"
START = ESC + b"_tsp;"
END = ESC + b"\\"
EXPECTED = "typing é😀 pasted\nλ"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def strip_secrets(source: dict[str, str]) -> dict[str, str]:
    # Even an accidental resolver change must not be able to use user keys.
    dangerous = ("_API_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_CREDENTIAL")
    return {
        key: value
        for key, value in source.items()
        if not any(key.upper().endswith(suffix) for suffix in dangerous)
    }


def fork_boot(cwd: Path, env: dict[str, str]) -> tuple[int, int]:
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.execvpe("bun", ["bun", "run", str(REPO / "src" / "boot.tsx")], env)
        except Exception as error:
            os.write(2, ("TRN3 spawn failed: " + str(error) + "\n").encode())
            os._exit(127)
    os.set_blocking(master, False)
    return pid, master


class Pane:
    def __init__(self, pid: int, fd: int):
        self.pid = pid
        self.fd = fd
        self.tail = bytearray()
        self.pending = bytearray()
        self.messages: list[tuple[str, dict]] = []
        self.raw_tail = bytearray()
        self.exited = False
        self.status: int | None = None

    def send(self, raw: bytes) -> None:
        total = 0
        while total < len(raw):
            try:
                total += os.write(self.fd, raw[total:])
            except BlockingIOError:
                time.sleep(0.005)

    def message(self, verb: str, body: dict) -> None:
        self.send(START + verb.encode() + b";" + json.dumps(body).encode() + END)

    def pump(self, delay: float = 0.02) -> None:
        ready, _, _ = select.select([self.fd], [], [], delay)
        if ready:
            try:
                chunk = os.read(self.fd, 131072)
            except (OSError, BlockingIOError):
                chunk = b""
            if chunk:
                self.pending.extend(chunk)
                self.raw_tail.extend(chunk)
                del self.raw_tail[:-100000]
                self.tail.extend(chunk)
                del self.tail[:-3000]
        while True:
            pos = self.pending.find(START)
            if pos < 0:
                del self.pending[:-64]
                break
            end = self.pending.find(END, pos + len(START))
            if end < 0:
                if pos > 0:
                    del self.pending[:pos]
                break
            body = bytes(self.pending[pos + len(START):end])
            del self.pending[:end + len(END)]
            verb, _, json_data = body.partition(b";")
            try:
                payload = json.loads(json_data)
            except (ValueError, UnicodeDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            kind = verb.decode("ascii", "replace")
            self.messages.append((kind, payload))
            if kind == "f":
                self.message("e", {
                    "ev": "ack", "sf": payload["sf"], "s": payload["s"]
                })
        if not self.exited:
            found, status = os.waitpid(self.pid, os.WNOHANG)
            if found:
                self.exited = True
                self.status = status

    def until(self, condition, description: str, timeout: float = 25) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            if condition():
                return
            if self.exited:
                raise AssertionError(
                    description + ": child exited early, tail=" +
                    bytes(self.tail).decode("utf-8", "replace")[-700:]
                )
        raise AssertionError(
            description + ": timed out; tail=" +
            bytes(self.tail).decode("utf-8", "replace")[-700:]
        )

    def stop(self) -> None:
        if not self.exited:
            try:
                os.killpg(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _ in range(100):
                self.pump(0.02)
                if self.exited:
                    break
        if not self.exited:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            _, self.status = os.waitpid(self.pid, 0)
            self.exited = True
        os.close(self.fd)


def jsonlines(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def has_prompt(rows: list[dict], prompt: str) -> bool:
    return any(
        any(message.get("role") == "user" and message.get("content") == prompt
            for message in row.get("messages", []))
        for row in rows
    )


def live_acceptance(workspace: Path, env: dict[str, str], requests: Path, record: Path) -> None:
    pid, fd = fork_boot(workspace, env)
    pane = Pane(pid, fd)
    try:
        pane.until(
            lambda: any(verb == "q" and body.get("q") == "hello"
                        for verb, body in pane.messages),
            "real TSP hello", 30,
        )
        pane.message("r", {
            "r": "hello", "v": 1, "term": "trn3-pty", "ver": "1",
            "cols": 100, "credits": 8, "apc": 65536,
            "features": ["dock", "settle"],
        })
        pane.until(lambda: any(verb == "o" for verb, _ in pane.messages) and
                   any(verb == "f" for verb, _ in pane.messages),
                   "real Session.open + Surface.render")
        pane.send(b"typing ")
        # Deliberate separate writes across UTF-8 codepoint boundaries.
        for byte in "é😀".encode("utf-8"):
            pane.send(bytes((byte,)))
            time.sleep(0.004)
        pane.send(b"\x1b[200~ pasted\n" + "λ".encode() + b"\x1b[201~")
        time.sleep(0.01)
        pane.send(b"\r")
        pane.until(lambda: has_prompt(jsonlines(requests), EXPECTED),
                   "exact complete PTY-byte prompt via real model adapter")
        pane.until(lambda: "SYNTHETIC_ECHO" in str(pane.messages),
                   "streamed synthetic answer on real TSP view")
        # A *real* Empryo read tool runs against workspace/fixture.txt.
        pane.send(b"TRN3_READ_FILE\r")
        pane.until(lambda: has_prompt(jsonlines(requests), "TRN3_READ_FILE"),
                   "fixture read request reached provider")
        pane.until(lambda: any(
            any(msg.get("role") == "tool" for msg in row.get("messages", []))
            for row in jsonlines(requests)
        ), "actual tool result reached provider", 30)
        rows = jsonlines(requests)
        require(any("read" in row.get("offeredTools", []) for row in rows),
                "the actual Empryo tool definition was not offered")
        require(any("TRN3_OWNED_CONTENT" in json.dumps(row) for row in rows),
                "the real read tool did not return the owned fixture's bytes")
        pane.until(lambda: "SYNTHETIC_READ_DONE" in str(pane.messages),
                   "streamed post-tool synthetic answer")
        # The terminal, not an in-process mock, drops the real surface.
        pane.message("e", {"ev": "gone", "sf": "empryo", "ids": ["empryo"]})
        pane.until(lambda: pane.exited, "SDK/app teardown after terminal gone", 15)
        require(os.WIFEXITED(pane.status or 0) and
                os.WEXITSTATUS(pane.status or 0) == 0,
                "native app did not exit successfully")
        log = jsonlines(record)
        require(any(row.get("dir") == "out" and row.get("verb") == "q" for row in log),
                "missing recorded hello")
        require(any(row.get("dir") == "in" and row.get("verb") == "r" for row in log),
                "missing recorded handshake reply")
        require(any(row.get("dir") == "out" and row.get("verb") == "f" for row in log),
                "missing recorded real Surface frame")
        require(any(row.get("dir") == "in" and row.get("verb") == "e"
                    and row.get("body", {}).get("ev") == "gone" for row in log),
                "missing recorded terminal drop")
        require(b"\x1b[?2004l" in pane.raw_tail and b"\x1b[<u" in pane.raw_tail,
                "bracketed paste / kitty keyboard modes were not restored")
        print("PASS: OS PTY bytes, split Unicode, paste, Enter, runChat, real tool, replay log, disconnect")
    finally:
        pane.stop()


def fallback_acceptance(workspace: Path, env: dict[str, str]) -> None:
    fallback = {**env, "TERN_TSP": "0", "TERN_TSP_RECORD": ""}
    pid, fd = fork_boot(workspace, fallback)
    pane = Pane(pid, fd)
    try:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            pane.pump()
            if pane.exited or len(pane.raw_tail) >= 100:
                break
        require(not any(verb == "q" and body.get("q") == "hello"
                        for verb, body in pane.messages),
                "TERN_TSP=0 unexpectedly tried native SDK handshake")
        require(not pane.exited and len(pane.raw_tail) > 0,
                "normal OpenTUI fallback did not start; output=" +
                bytes(pane.tail).decode("utf-8", "replace")[-400:])
        print("PASS: TERN_TSP=0 entered actual OpenTUI boot, no TSP hello")
    finally:
        pane.stop()


def main() -> None:
    if os.name != "posix":
        raise SystemExit("PTY acceptance requires macOS/Linux")
    with tempfile.TemporaryDirectory(prefix="empryo-trn3-") as raw:
        root = Path(raw)
        home = root / "home"
        workspace = root / "workspace"
        workspace.mkdir()
        (home / ".soulforge").mkdir(parents=True)
        (workspace / "fixture.txt").write_text("TRN3_OWNED_CONTENT\n")
        (home / ".soulforge" / "config.json").write_text(json.dumps({
            "defaultModel": "ollama/trn3-fixture",
            "addonsPromptShown": True,
            "repoMap": False,
            "webSearch": False,
            "telemetry": False,
        }))
        record = root / "tsp.jsonl"
        requests = root / "requests.jsonl"
        port = get_free_port()
        env = strip_secrets(dict(os.environ))
        env.update({
            "HOME": str(home),
            "TERM": "xterm-256color",
            "SOULFORGE_TERN": "1",
            "SOULFORGE_NO_PROMPT": "1",
            "SOULFORGE_NO_REPOMAP": "1",
            "SOULFORGE_TERN_RECORD": "",
            "TERN_TSP_RECORD": str(record),
            "OLLAMA_HOST": f"http://127.0.0.1:{port}",
        })
        # Strip upstream tty manager markers: this PTY is its own Tern endpoint.
        for key in ("TMUX", "TMUX_PANE", "STY", "ZELLIJ", "TERN_TSP"):
            env.pop(key, None)
        provider_env = {**env, "TRN3_PORT": str(port), "TRN3_REQUEST_LOG": str(requests)}
        provider = subprocess.Popen(
            ["bun", "run", str(REPO / "experiments/tern-native/loopback-provider.ts")],
            cwd=REPO, env=provider_env,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 12
            while True:
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/api/tags", timeout=0.25
                    ) as response:
                        require(response.status == 200, "fixture health check failed")
                    break
                except OSError:
                    if provider.poll() is not None or time.monotonic() > deadline:
                        raise AssertionError("synthetic provider failed to start")
                    time.sleep(0.05)
            live_acceptance(workspace, env, requests, record)
            fallback_acceptance(workspace, env)
        finally:
            provider.terminate()
            try:
                provider.wait(timeout=5)
            except subprocess.TimeoutExpired:
                provider.kill()
                provider.wait()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("FAIL TRN3 OS-PTY smoke: " + str(exc), file=sys.stderr)
        raise
