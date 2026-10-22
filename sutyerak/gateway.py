#!/usr/bin/env python3
# ANSWERS: How does a question reach Sutyerák and its answer come back? POST /ask on this gateway, streamed NDJSON, one thread per employee and topic.
"""Sutyerák's gateway: the one door between the Acropora OS and the model.

  POST /ask   Authorization: Bearer <gateway secret>
  {
    "token":    "<ASSISTANT_READONLY session token, minted by the OS for the asking employee>",
    "user":     {"id": "...", "name": "..."},
    "question": "...",
    "threadId": "<optional: continue this thread>",
    "context":  {"page": "/szerviz/munkalapok/abc", "entity": "worksheet abc"}   (optional)
  }

  -> application/x-ndjson, one event per line:
     {"type":"thread","threadId":"...","new":true}
     {"type":"text","delta":"..."}            (as the answer is written)
     {"type":"done","answer":"...","durationMs":1234,"toolCalls":3}
     {"type":"error","message":"..."}

  GET /health  -> {"ok":true}

The CALLER is trusted for the user's identity (only the OS backend holds the
gateway secret). The token is not: whatever it is, the OS answers with that
employee's rights only.

Threads: one thread belongs to ONE user. A thread id presented by another user
is refused, never continued; an expired one starts a new thread. Within a
thread the Claude session is resumed, so a follow-up ("bontsd havonta") works
on what was already read. The token rotates (10 minutes); it is passed to the
tool process per run and never written into the session.

Isolation of a run: no built-in tools (--tools ""), only the sutyerak MCP
(--strict-mcp-config), no settings sources, an empty working directory and a
private CLAUDE_CONFIG_DIR; authentication by the fleet setup token (the
subscription, never an API key: ANTHROPIC_API_KEY is stripped).
"""
import hmac
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("SUTYERAK_STATE", "/home/marveen/sutyerak")
OS_BASE = os.environ.get("SUTYERAK_OS_BASE", "https://api.acropora.hu")
PORT = int(os.environ.get("SUTYERAK_PORT", "3430"))
BIND = os.environ.get("SUTYERAK_BIND", "127.0.0.1")
MODEL = os.environ.get("SUTYERAK_MODEL", "claude-sonnet-5-5")
SECRET_FILE = os.environ.get("SUTYERAK_SECRET_FILE", "/home/marveen/marveen/store/.sutyerak-gateway-secret")
OAUTH_FILE = os.environ.get("SUTYERAK_OAUTH_FILE", "/home/marveen/marveen/store/.claude-oauth-token")
# The install's root: this file lives in <root>/sutyerak/.
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "scripts", "lib"))
from dashboard_token import token_file  # noqa: E402  (the one resolver every fleet script uses)
RUN_TIMEOUT = 240
THREAD_IDLE_S = 2 * 3600
THREAD_MAX_S = 24 * 3600
MAX_PARALLEL = 3

THREADS_DIR = os.path.join(STATE, "threads")
LOG_DIR = os.path.join(STATE, "log")
RUN_DIR = os.path.join(STATE, "run")
CONFIG_DIR = os.path.join(STATE, "config")
CATALOG = os.path.join(STATE, "endpoints.json")
for d in (THREADS_DIR, LOG_DIR, RUN_DIR, CONFIG_DIR):
    os.makedirs(d, mode=0o700, exist_ok=True)

slots = threading.BoundedSemaphore(MAX_PARALLEL)
thread_locks: dict[str, threading.Lock] = {}
locks_guard = threading.Lock()
log_guard = threading.Lock()


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read().strip()


def log_conversation(event: dict) -> None:
    event = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), **event}
    with log_guard, open(os.path.join(LOG_DIR, "conversations.jsonl"), "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def lock_for(thread_id: str) -> threading.Lock:
    with locks_guard:
        return thread_locks.setdefault(thread_id, threading.Lock())


def thread_path(thread_id: str) -> str:
    return os.path.join(THREADS_DIR, thread_id + ".json")


def open_thread(thread_id: str | None, user_id: str) -> tuple[dict, bool]:
    """(thread, is_new). Raises PermissionError for another user's thread."""
    now = time.time()
    if thread_id:
        try:
            uuid.UUID(thread_id)
            with open(thread_path(thread_id), encoding="utf-8") as f:
                t = json.load(f)
        except (ValueError, OSError):
            t = None
        if t is not None:
            if t["userId"] != user_id:
                raise PermissionError("thread belongs to another user")
            if now - t["lastAt"] < THREAD_IDLE_S and now - t["createdAt"] < THREAD_MAX_S:
                return t, False
    t = {"threadId": str(uuid.uuid4()), "userId": user_id, "sessionId": None, "createdAt": now, "lastAt": now, "turns": 0}
    return t, True


def save_thread(t: dict) -> None:
    tmp = thread_path(t["threadId"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(t, f)
    os.replace(tmp, thread_path(t["threadId"]))


def system_prompt() -> str:
    """The persona file plus the web menu from the catalog, so a "how do I"
    question can name the real page instead of inventing one."""
    base = read(os.path.join(HERE, "system-prompt.md"))
    try:
        with open(CATALOG, encoding="utf-8") as f:
            menu = json.load(f).get("menu", [])
    except (OSError, ValueError):
        menu = []
    if not menu:
        return base
    lines = "\n".join(f"- {m['label']}: {m['href']}" for m in menu)
    return base + "\n\nAz Acropora OS menüje (felirat: útvonal a böngészőben):\n" + lines + "\n"


def build_prompt(question: str, context: dict | None, user_name: str) -> str:
    parts = []
    if context:
        where = ", ".join(f"{k}: {v}" for k, v in context.items() if v and k != "conversationId")
        if where:
            parts.append(f"[Ahol a dolgozó éppen áll: {where}]")
    parts.append(f"[Mai dátum: {time.strftime('%Y-%m-%d')}, kérdező: {user_name}]")
    parts.append(question)
    return "\n".join(parts)


def mcp_env(t: dict, body: dict) -> dict:
    """The environment of the sutyerak MCP process for one run (pure: no I/O besides the token file's NAME).

    THE HANDOFF TOKEN is the main agent's OWN dashboard token, picked by the same resolver as every fleet
    script (scripts/lib/dashboard_token.py: this process runs as the install's owner, so the owner's token is
    the main agent's). It used to be the shared store/.dashboard-token: the message it posts is
    acrobot -> acrobot, and with the shared token the server cannot say who sent it (and, once the shared token
    is narrowed to its minimum, refuses POST /api/messages altogether). P0-1, task p01-legacy-uzenet-hivo; the
    two legacy calls of 2026-10-21 10:46 and 10:48 UTC were this handoff.
    The MCP child reads the file only to post one fixed body to one fixed URL; the model supplies the request
    text only. If the resolver cannot find the own token it falls back to the shared one with a line on stderr."""
    user = body["user"]
    return {
        "SUTYERAK_OS_BASE": OS_BASE,
        "SUTYERAK_OS_TOKEN": body["token"],
        "SUTYERAK_CATALOG": CATALOG,
        "SUTYERAK_USER_ID": str(user["id"]),
        "SUTYERAK_USER_NAME": str(user.get("name", "")),
        "SUTYERAK_THREAD_ID": t["threadId"],
        # The Messages conversation the question came from (empty for the widget):
        # the handoff file carries it so acrobot's answer can go back there.
        "SUTYERAK_CONVERSATION_ID": str((body.get("context") or {}).get("conversationId") or "")[:64],
        "SUTYERAK_TOOL_LOG": os.path.join(LOG_DIR, "tools.jsonl"),
        "SUTYERAK_HANDOFF_URL": "http://localhost:3420/api/messages",
        "SUTYERAK_HANDOFF_TOKEN_FILE": token_file(ROOT),
        "SUTYERAK_HANDOFF_DIR": os.path.join(STATE, "atadas"),
    }


def run_claude(t: dict, is_new: bool, prompt: str, body: dict, emit) -> dict:
    user = body["user"]
    with tempfile.TemporaryDirectory(dir=RUN_DIR) as tmp:
        mcp_path = os.path.join(tmp, "mcp.json")
        mcp = {"mcpServers": {"sutyerak": {
            "type": "stdio",
            "command": "python3",
            "args": [os.path.join(HERE, "os_read_mcp.py")],
            "env": mcp_env(t, body),
        }}}
        fd = os.open(mcp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(mcp, f)
        cmd = [
            "claude", "-p", prompt,
            "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--model", MODEL,
            "--tools", "",
            "--strict-mcp-config", "--mcp-config", mcp_path,
            "--setting-sources", "",
            "--allowedTools", "mcp__sutyerak__os_get", "mcp__sutyerak__os_endpoints", "mcp__sutyerak__acrobot_atadas",
            "--system-prompt", system_prompt(),
        ]
        if is_new:
            t["sessionId"] = str(uuid.uuid4())
            cmd += ["--session-id", t["sessionId"]]
        else:
            cmd += ["--resume", t["sessionId"]]
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": STATE,
            "LANG": "C.UTF-8",
            "CLAUDE_CONFIG_DIR": CONFIG_DIR,
            "CLAUDE_CODE_OAUTH_TOKEN": read(OAUTH_FILE),
        }
        work = os.path.join(RUN_DIR, "cwd")
        os.makedirs(work, exist_ok=True)
        proc = subprocess.Popen(cmd, cwd=work, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        timer = threading.Timer(RUN_TIMEOUT, proc.kill)
        timer.start()
        answer, tool_calls, result = "", 0, None
        try:
            for line in proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("type") == "stream_event":
                    inner = ev.get("event", {})
                    if inner.get("type") == "content_block_start" and inner.get("content_block", {}).get("type") == "text" and answer:
                        # a text block after a tool call: keep it a new paragraph
                        emit({"type": "text", "delta": "\n\n"})
                    if inner.get("type") == "content_block_delta" and inner.get("delta", {}).get("type") == "text_delta":
                        answer += inner["delta"]["text"]
                        emit({"type": "text", "delta": inner["delta"]["text"]})
                elif ev.get("type") == "assistant":
                    for block in ev.get("message", {}).get("content", []):
                        if block.get("type") == "tool_use":
                            tool_calls += 1
                elif ev.get("type") == "result":
                    result = ev
            proc.wait()
        finally:
            timer.cancel()
        err = proc.stderr.read()[-500:]
        if not result or result.get("is_error"):
            raise RuntimeError((result or {}).get("result") or err or f"exit {proc.returncode}")
        answer = result.get("result", "")
        return {"answer": answer, "toolCalls": tool_calls, "turns": result.get("num_turns")}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet; conversations have their own log
        pass

    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/ask":
            return self._json(404, {"error": "not found"})
        auth = self.headers.get("Authorization", "")
        if not hmac.compare_digest(auth.encode(), ("Bearer " + read(SECRET_FILE)).encode()):
            return self._json(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 20_000:
                return self._json(413, {"error": "too large"})
            body = json.loads(self.rfile.read(length) or b"{}")
            question = str(body["question"]).strip()
            user = body["user"]
            if not (question and body.get("token") and user.get("id")):
                raise KeyError
        except (ValueError, KeyError, TypeError, AttributeError):
            return self._json(400, {"error": "token, user.id and question are required"})
        if len(question) > 4000:
            return self._json(400, {"error": "question too long"})
        try:
            t, is_new = open_thread(body.get("threadId"), str(user["id"]))
        except PermissionError:
            log_conversation({"event": "thread-refused", "user": user.get("id"), "thread": body.get("threadId")})
            return self._json(403, {"error": "this thread belongs to another user"})
        if not slots.acquire(timeout=30):
            return self._json(503, {"error": "busy"})
        lock = lock_for(t["threadId"])
        if not lock.acquire(blocking=False):
            slots.release()
            return self._json(409, {"error": "this thread is already answering"})

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def emit(obj: dict) -> None:
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
            try:
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        started = time.time()
        try:
            emit({"type": "thread", "threadId": t["threadId"], "new": is_new})
            prompt = build_prompt(question, body.get("context"), str(user.get("name", "")))
            out = run_claude(t, is_new, prompt, body, emit)
            t["lastAt"] = time.time()
            t["turns"] += 1
            save_thread(t)
            ms = int((time.time() - started) * 1000)
            emit({"type": "done", "answer": out["answer"], "durationMs": ms, "toolCalls": out["toolCalls"]})
            log_conversation({"event": "answer", "user": user.get("id"), "name": user.get("name"), "thread": t["threadId"],
                              "new": is_new, "context": body.get("context"), "question": question,
                              "answer": out["answer"], "durationMs": ms, "toolCalls": out["toolCalls"]})
        except Exception as e:
            emit({"type": "error", "message": "Sutyerák most nem tud válaszolni."})
            log_conversation({"event": "error", "user": user.get("id"), "thread": t["threadId"],
                              "question": question, "error": str(e)[:500]})
        finally:
            lock.release()
            slots.release()
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass


def sweep_expired() -> None:
    """Drop expired threads AND their session transcripts: a closed thread's
    conversation (with the employee's data in it) does not outlive it."""
    while True:
        now = time.time()
        for name in os.listdir(THREADS_DIR):
            if not name.endswith(".json"):
                continue
            path = os.path.join(THREADS_DIR, name)
            try:
                with open(path, encoding="utf-8") as f:
                    t = json.load(f)
            except (OSError, ValueError):
                continue
            if now - t["lastAt"] < THREAD_IDLE_S and now - t["createdAt"] < THREAD_MAX_S:
                continue
            if t.get("sessionId"):
                for root, _, files in os.walk(os.path.join(CONFIG_DIR, "projects")):
                    for fn in files:
                        if fn.startswith(t["sessionId"]):
                            os.remove(os.path.join(root, fn))
            os.remove(path)
        time.sleep(600)


if __name__ == "__main__":
    threading.Thread(target=sweep_expired, daemon=True).start()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    server.daemon_threads = True
    print(f"sutyerak gateway on {BIND}:{PORT}, OS {OS_BASE}, model {MODEL}", flush=True)
    server.serve_forever()
