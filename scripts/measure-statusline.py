#!/usr/bin/env python3
# ANSWERS: Mennyi a Claude elofizetes 5 oras es heti keretebol felhasznalva, PONTOSAN (nem becsles) -- statusline-kent fut, es mintat ir; --export-usage modban a sub-agens sajat tokenjeit is kiteszi a flotta-csoport mappaba.
"""
measure-statusline.py -- Claude Code statusLine command that doubles as the
fleet's quota sampler and, for sub-agents, as their token exporter
(Measurement Layer v1).

Why here and not scripts/usage-collect.py: the authoritative endpoint that
script calls (api.anthropic.com/api/oauth/usage) answers 403 to the fleet's
setup-token (measured 2026-09-27). Claude Code itself hands the statusline a
`rate_limits` object (five_hour / seven_day used_percentage + resets_at) once
the session has made one API call. That is the same number the TUI prints as
"You've used N% of your weekly limit".

Quota sampling (every agent):
  * reads the statusline JSON on stdin,
  * if rate_limits is present and the newest sample is >= 300 s old, appends
    ONE line to store/measurements/quota-samples.jsonl (append-only, one
    write() per line, so a crash leaves at most one torn line that the
    ingester skips),
  * prints a one-line status (model, 5h %, 7d %).

Quota-gate sample (the router's own statusline only):
  The schedule runner's quota gate must not read the shared log above: the
  log is fleet-writable, so any agent could forge a high value and silence
  the heartbeats (acrobot's decision on #76, 2026-10-13). When this script
  runs as the user that owns the store/ directory (the router, the same user
  as the dashboard), it also replaces store/quota-gate-sample.json -- 0644,
  in a directory no agent can write -- at most once per 60 s. Under any
  other user it does nothing there. The dashboard checks owner and mode on
  the opened file (src/quota-snapshot.ts).

Usage export (`--export-usage`, sub-agents only):
  Since 2026-09-22 each sub-agent runs as its own OS user, and Claude Code
  writes its transcripts 0600. The dashboard (another user) cannot read them,
  so the token collector went blind to every sub-agent. The statusLine runs
  AS the agent's user, so it can read its own transcripts. At most once per
  60 s it forks a detached exporter that copies the NUMBERS of every assistant
  API call from the agent's own project dir into
      store/measurements/usage/<agent>/<transcript>.jsonl
  (group `fleet`, 0640). The exported line keeps the transcript's shape
  (type/timestamp/sessionId/message.{id,model,usage,content[tool_use name]}),
  so the dashboard collector parses it with the same code as a transcript.
  No text, no prompt, no tool input, no path, no cwd is exported. The first
  run backfills every transcript in that dir (cursor per file), so the
  2026-09-22 gap is closed, not only calls after activation.

It never records the transcript path, cwd, session id or anything
credential-shaped into the quota log: only numbers, the model id and the
agent name. Stdlib only. Must never fail the statusline: every error path
still prints, and the exporter runs detached so a large backfill cannot
delay or kill the status line.
"""
import json
import os
import re
import sys
import time

MIN_INTERVAL_S = 300
EXPORT_INTERVAL_S = 60
ROOT = os.environ.get("MARVEEN_ROOT", "/home/marveen/marveen")
MEASURE_DIR = os.environ.get("MEASURE_DIR", os.path.join(ROOT, "store", "measurements"))
OUT = os.environ.get("MEASURE_QUOTA_FILE", os.path.join(MEASURE_DIR, "quota-samples.jsonl"))
USAGE_DIR = os.environ.get("MEASURE_USAGE_DIR", os.path.join(MEASURE_DIR, "usage"))
GATE_FILE = os.environ.get("MEASURE_GATE_FILE", os.path.join(ROOT, "store", "quota-gate-sample.json"))
GATE_INTERVAL_S = 60
AGENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def pct(block):
    if isinstance(block, dict):
        v = block.get("used_percentage")
        if isinstance(v, (int, float)):
            return v
    return None


def resets(block):
    if isinstance(block, dict):
        v = block.get("resets_at")
        if isinstance(v, (int, float)):
            return int(v)
    return None


def open_shared(path, flags):
    """Open for append/create so other fleet users can append too.

    Agent users run with a restrictive umask; a file created 0600 by the first
    writer would lock every other agent out of the shared quota log. fchmod
    after create fixes the mode regardless of umask.
    """
    fd = os.open(path, flags | os.O_CREAT, 0o664)
    try:
        st = os.fstat(fd)
        if st.st_uid == os.getuid() and (st.st_mode & 0o777) != 0o664:
            os.fchmod(fd, 0o664)
    except OSError:
        pass
    return fd


def ensure_dir(path, mode):
    os.makedirs(path, exist_ok=True)
    try:
        st = os.stat(path)
        if st.st_uid == os.getuid() and (st.st_mode & 0o7777) != mode:
            os.chmod(path, mode)
    except OSError:
        pass


def sample_quota(data, agent):
    model = (data.get("model") or {}).get("id") if isinstance(data.get("model"), dict) else None
    rl = data.get("rate_limits") if isinstance(data.get("rate_limits"), dict) else None
    five = pct(rl.get("five_hour")) if rl else None
    seven = pct(rl.get("seven_day")) if rl else None

    if rl and (five is not None or seven is not None):
        now = int(time.time())
        sample = {
            "sampled_at": now,
            "source": "claude-code-statusline",
            "agent": agent,
            "model": model,
            "five_hour_pct": five,
            "five_hour_resets_at": resets(rl.get("five_hour")),
            "seven_day_pct": seven,
            "seven_day_resets_at": resets(rl.get("seven_day")),
        }
        line = json.dumps(sample, separators=(",", ":")) + "\n"
        try:
            fresh = os.path.exists(OUT) and now - int(os.stat(OUT).st_mtime) < MIN_INTERVAL_S
        except OSError:
            fresh = False
        if not fresh:
            try:
                ensure_dir(os.path.dirname(OUT), 0o2775)
                fd = open_shared(OUT, os.O_WRONLY | os.O_APPEND)
                try:
                    os.write(fd, line.encode("utf-8"))
                finally:
                    os.close(fd)
            except OSError:
                pass
        write_gate_sample(line, now)
    return model, five, seven


def write_gate_sample(line, now):
    """Replace the router-owned gate sample, only when we ARE the router user.

    Ownership of the target directory decides, not MEASURE_AGENT: the agent
    name is self-declared, the uid is not. Written to a private temp name and
    renamed, so the dashboard never reads a half-written file.
    """
    gate_dir = os.path.dirname(GATE_FILE)
    tmp = None
    try:
        if os.stat(gate_dir).st_uid != os.geteuid():
            return
        try:
            if now - int(os.lstat(GATE_FILE).st_mtime) < GATE_INTERVAL_S:
                return
        except OSError:
            pass
        tmp = os.path.join(gate_dir, f".quota-gate-sample.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        try:
            os.fchmod(fd, 0o644)
            os.write(fd, line.encode("utf-8"))
        finally:
            os.close(fd)
        os.replace(tmp, GATE_FILE)
    except OSError:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


# ---------- usage export (sub-agents) ----------

def usage_line(obj):
    """Numbers-only copy of one assistant transcript line, or None."""
    if not isinstance(obj, dict) or obj.get("type") != "assistant":
        return None
    msg = obj.get("message")
    if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
        return None
    ts = obj.get("timestamp")
    if not isinstance(ts, str) or not ts:
        return None
    u = msg["usage"]
    usage = {}
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
        v = u.get(k)
        if isinstance(v, (int, float)):
            usage[k] = int(v)
    content = []
    thinking_chars = 0
    if isinstance(msg.get("content"), list):
        for b in msg["content"]:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use" and isinstance(b.get("name"), str) and not content:
                content.append({"type": "tool_use", "name": b["name"]})
            if b.get("type") == "thinking" and isinstance(b.get("thinking"), str):
                thinking_chars += len(b["thinking"])
    out_msg = {"id": msg.get("id") if isinstance(msg.get("id"), str) else None,
               "model": msg.get("model") if isinstance(msg.get("model"), str) else None,
               "usage": usage,
               "content": content}
    if thinking_chars:
        # Same estimate the collector applies to a real transcript (chars / 4).
        out_msg["thinking_tokens_est"] = -(-thinking_chars // 4)
    line = {"type": "assistant", "timestamp": ts, "message": out_msg}
    if isinstance(obj.get("sessionId"), str):
        line["sessionId"] = obj["sessionId"]
    return json.dumps(line, separators=(",", ":"))


def export_file(src, dst, cursor):
    """Append the numbers of complete new lines of src to dst. Returns new cursor."""
    size = os.path.getsize(src)
    off = cursor.get("offset", 0) if cursor.get("size", -1) <= size else 0
    if cursor.get("size") == size:
        return cursor
    out = []
    with open(src, "rb") as f:
        f.seek(off)
        chunk = f.read(size - off)
    # Only whole lines: a transcript being written may end mid-line.
    end = chunk.rfind(b"\n")
    if end < 0:
        return {"offset": off, "size": off}
    for raw in chunk[:end].split(b"\n"):
        if not raw.strip():
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        ln = usage_line(obj)
        if ln:
            out.append(ln + "\n")
    new_off = off + end + 1
    if out:
        fd = os.open(dst, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
        try:
            try:
                os.fchmod(fd, 0o640)
            except OSError:
                pass
            os.write(fd, "".join(out).encode("utf-8"))
        finally:
            os.close(fd)
    return {"offset": new_off, "size": new_off}


def export_usage(agent, project_dir):
    import fcntl
    agent_dir = os.path.join(USAGE_DIR, agent)
    ensure_dir(os.path.dirname(USAGE_DIR), 0o2775)
    ensure_dir(USAGE_DIR, 0o2775)
    ensure_dir(agent_dir, 0o2750)
    lock_fd = os.open(os.path.join(agent_dir, ".lock"), os.O_WRONLY | os.O_CREAT, 0o640)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(lock_fd)
        return  # another exporter for this agent is running
    try:
        state_path = os.path.join(agent_dir, ".cursors.json")
        try:
            with open(state_path) as f:
                state = json.load(f)
            if not isinstance(state, dict):
                state = {}
        except (OSError, ValueError):
            state = {}
        for dirpath, _dirs, files in os.walk(project_dir):
            for name in files:
                if not name.endswith(".jsonl"):
                    continue
                src = os.path.join(dirpath, name)
                rel = os.path.relpath(src, project_dir)
                dst = os.path.join(agent_dir, rel.replace(os.sep, "__"))
                try:
                    state[rel] = export_file(src, dst, state.get(rel, {}))
                except OSError:
                    continue
        tmp = state_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, separators=(",", ":"))
        os.replace(tmp, state_path)
    finally:
        os.close(lock_fd)


def maybe_export(data, agent):
    """Throttled, detached export of this agent's own transcripts."""
    tp = data.get("transcript_path")
    if not agent or not isinstance(tp, str) or not tp.endswith(".jsonl"):
        return
    project_dir = os.path.dirname(tp)
    stamp = os.path.join(USAGE_DIR, agent, ".last-export")
    try:
        if time.time() - os.stat(stamp).st_mtime < EXPORT_INTERVAL_S:
            return
    except OSError:
        pass
    try:
        pid = os.fork()
    except OSError:
        return
    if pid:
        return  # parent: print the status line and exit
    try:
        os.setsid()
        devnull = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(devnull, fd)
        ensure_dir(os.path.dirname(USAGE_DIR), 0o2775)
        ensure_dir(USAGE_DIR, 0o2775)
        ensure_dir(os.path.join(USAGE_DIR, agent), 0o2750)
        with open(stamp, "a"):
            pass
        os.utime(stamp, None)
        export_usage(agent, project_dir)
    except Exception:
        pass
    finally:
        os._exit(0)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        print("statusline: no input")
        return
    if not isinstance(data, dict):
        print("statusline: no input")
        return
    agent = os.environ.get("MEASURE_AGENT") or None
    if agent and not AGENT_RE.match(agent):
        agent = None
    model, five, seven = sample_quota(data, agent)
    if "--export-usage" in sys.argv[1:]:
        try:
            maybe_export(data, agent)
        except Exception:
            pass

    parts = [model or "?"]
    parts.append("5h " + (f"{five:g}%" if five is not None else "?"))
    parts.append("7d " + (f"{seven:g}%" if seven is not None else "?"))
    print(" | ".join(parts))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("statusline: error")
