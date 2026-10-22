#!/usr/bin/env python3
"""UserPromptSubmit hook: PULL the MAIN agent's inter-agent inbox into context.

The main agent's channel session is effectively always busy, so the message
router cannot reliably tmux-inject inter-agent messages into it -- they stall as
'pending' (the ~1h silent-delivery incidents). This hook delivers them the other
way: on each main-agent turn it calls the dashboard
  POST /api/agents/<main>/drain-inbox
which ATOMICALLY claims the pending messages and returns them ALREADY WRAPPED
(the trusted/untrusted/channel-inbound security framing is single-sourced in TS
-- never duplicated here), and prints them so they enter the agent's context.

Main-agent ONLY: agent_id is derived from the session cwd; sub-agents keep the
router's tmux-push path (draining them here too would double-deliver). The
router skips main-agent delivery, so this is the main agent's sole inbound path.
Never blocks the prompt (always exit 0); a drain error just retries next turn.

THE TOKEN IS THE MAIN AGENT'S OWN, AND NOTHING ELSE (P0-1, task p01-inbox-drain-token, acrobot 35215).
This hook is the main agent's ONLY inbound path, and POST /api/agents/<main>/drain-inbox is closed to the
shared token (docs/access-matrix.md, column L). It used to fall back to the shared file silently, so once the
access mode enforces, a missing own token or any refused call would have stopped every inter-agent message
without a sound. Now: no own token, or a drain that does not succeed -> the hook still exits 0 and does not
block, but writes ONE line into the agent's context ("the inbox is not arriving: <why>") at most every
NOTICE_SECONDS (marker in the install's own store/), so the main agent KNOWS. The line never carries the token or the URL.
"""
import sys
import os
import json
import stat
import time
import urllib.error
import urllib.request

# how often the "the inbox is not arriving" line may repeat (the hook runs on every prompt)
NOTICE_SECONDS = 600
# its marker lives in the install's store/, which only the install's owner (the main agent's user) can write: a marker in
# the shared temp dir could be pre-created and kept fresh by any other agent's user, which would mute the notice for good
# (barracuda on #288)
NOTICE_MARKER = os.path.join("store", ".inbox-drain-notice")

def _own_token_path(root):
    """(path, None) of the main agent's OWN token file, or (None, why). Never the shared file.

    token_file() raises DashboardTokenError (an OSError) for an agent whose own token is missing; an older
    checkout of the resolver still returns the shared path instead, which is refused here by its location
    (the own tokens live in store/tokens/)."""
    try:
        import sys as _sys
        _lib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
        if _lib not in _sys.path:
            _sys.path.insert(0, _lib)
        from dashboard_token import token_file
        path = token_file(root)
    except OSError:
        return None, "the main agent's own dashboard token is missing, unreadable or empty"
    except Exception as e:
        return None, "the token resolver failed (%s)" % type(e).__name__
    if os.path.basename(os.path.dirname(path)) != "tokens":
        return None, "no own dashboard token for the main agent (only the shared one exists, and it is not used)"
    return path, None


def _marker_fresh(marker):
    """True only for a REGULAR file (not a link, not a directory) younger than NOTICE_SECONDS."""
    try:
        st = os.lstat(marker)
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and time.time() - st.st_mtime < NOTICE_SECONDS


def _notice(why, root):
    """One line into the agent's context, at most every NOTICE_SECONDS. Hook stdout is prepended to the prompt."""
    marker = os.path.join(root, NOTICE_MARKER)
    if _marker_fresh(marker):
        return
    try:
        # O_NOFOLLOW: a link planted at the marker is never written through
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        os.close(fd)
    except OSError:
        pass  # no marker: the line may repeat, which is the safe side
    sys.stdout.write("[inbox-drain] A bejovo inter-agent uzenetek NEM erkeznek ebben a fordulon: %s. "
                     "Rogzitsd a vezerlopulton (kartya vagy naplo); ez a sor legfeljebb %d percenkent ismetlodik.\n"
                     % (why, NOTICE_SECONDS // 60))


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402


def _web_port():
    """Dashboard port: WEB_PORT env, then the install .env, default 3420. Never
    hardcode an install-specific value (distribution rule)."""
    v = os.environ.get("WEB_PORT")
    if v and v.strip().isdigit():
        return v.strip()
    try:
        with open(os.path.join(ledger_lib._install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("WEB_PORT="):
                    p = line.split("=", 1)[1].strip()
                    if p.isdigit():
                        return p
    except Exception:
        pass
    return "3420"


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    agent_id = ledger_lib.agent_id_from_payload(payload)
    if agent_id != ledger_lib.main_agent_id():
        sys.exit(0)  # sub-agents are delivered by the router push path

    root = ledger_lib._install_dir()
    token_path, why = _own_token_path(root)
    if token_path is None:
        _notice(why, root)
        sys.exit(0)

    try:
        with open(token_path) as f:
            token = f.read().strip()
        if not token:
            _notice("the main agent's own dashboard token is empty", root)
            sys.exit(0)
        url = "http://127.0.0.1:%s/api/agents/%s/drain-inbox" % (_web_port(), agent_id)
        req = urllib.request.Request(
            url,
            data=b"{}",
            method="POST",
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.load(resp)
        text = (data or {}).get("text") or ""
        if text:
            # UserPromptSubmit hook stdout is prepended to the agent's context.
            sys.stdout.write(text)
            sys.stdout.write("\n")
    except urllib.error.HTTPError as e:
        _notice("the drain was refused (HTTP %d)" % e.code, root)  # never block the prompt: the next turn retries
    except Exception as e:
        _notice("the drain failed (%s)" % type(e).__name__, root)  # never block the prompt: the next turn retries

    sys.exit(0)


if __name__ == "__main__":
    main()
