#!/usr/bin/env python3
"""SessionStart hook: re-inject a sub-agent's in-flight TASK-STATE after an
in-place compact (or a resume/respawn), so the agent does NOT continue
amnesically -- worst case re-delegating work already in flight (#4).

Distinct from ledger-replay.py (that re-injects CHANNEL conversation turns for
the channel agents). This one targets sub-agent task-state, written by the
PreCompact agent-hook into store/agent-taskstate/<agent>.json.

Ordering (deliberate): read -> inject(print) -> mark consumed. If we die before
printing, the record stays consumed=false so the next start still catches it.

Thin by design: the decision (source/consumed/TTL/empty) + the injection text
live in the dashboard (TS, unit-tested). This hook only carries source, prints
what the dashboard returns, then confirms consume. Never breaks session start
(always exit 0).
"""
import sys
import os
import json
import urllib.request

# The calling user's OWN dashboard token, or nothing (acrovelIQ P0-1, task p01-csendes-visszaeso-hivok).
# NEVER the shared one: the replay route is the agent's own. Without an own token the hook says so
# (one rate-limited line into the context) instead of silently bringing nothing.
def _own_token(root):
    try:
        import sys as _sys
        _lib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
        if _lib not in _sys.path:
            _sys.path.insert(0, _lib)
        from dashboard_token import own_token
        return own_token(root)
    except Exception as e:
        return None, "the token resolver could not be loaded (%s)" % type(e).__name__

# Agent identity comes from the ledger library -- ONE resolver for every hook
# (LEDGERCWD828: the cwd is mutable within a session, so this file's private
# cwd-based copy could re-attribute a session that merely cd-ed somewhere; the
# shared resolver anchors on the session's transcript_path instead).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

def _project_root():
    # scripts/hooks/ -> project root is two up.
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _web_port():
    # Config-driven dashboard port: WEB_PORT env, else .env, default 3420.
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(_project_root(), ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except Exception:
            pass
    return port or "3420"


API = "http://localhost:%s/api" % _web_port()


def _main_agent_id():
    """MAIN_AGENT_ID from env, else .env, else the upstream default."""
    v = os.environ.get("MAIN_AGENT_ID")
    if v and v.strip():
        return v.strip()
    try:
        with open(os.path.join(_project_root(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return "marveen"




def _req(method, path, token):
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    source = payload.get("source") or ""
    agent = ledger_lib.agent_id_from_payload(payload)
    if not agent:
        sys.exit(0)  # main agent / unknown -> not a sub-agent task-state target
    token, why = _own_token(_project_root())
    if not token:
        # a replay that silently does not happen is the amnesia this hook exists to prevent: say so
        notice = ledger_lib.hook_context_notice("taskstate-replay", why, agent)
        if notice:
            print(json.dumps({
                "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": notice}
            }, ensure_ascii=False))
            sys.stdout.flush()
        sys.exit(0)

    # READ: ask the dashboard whether to replay (it applies source/consumed/TTL/empty).
    try:
        res = _req("GET", "/agent-taskstate/%s/replay?source=%s" % (agent, source), token)
    except Exception:
        sys.exit(0)  # dashboard unavailable -> no-op (fail-safe)
    inject = (res or {}).get("additionalContext")
    if not inject:
        sys.exit(0)  # nothing to replay

    # INJECT: emit the SessionStart additionalContext.
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": inject,
        }
    }, ensure_ascii=False))
    sys.stdout.flush()

    # MARK CONSUMED -- only AFTER a successful print, so a crash before this
    # leaves the record re-injectable on the next start.
    try:
        _req("POST", "/agent-taskstate/%s/consume" % agent, token)
    except Exception:
        pass  # best effort; worst case it replays once more next start

    sys.exit(0)


if __name__ == "__main__":
    main()
