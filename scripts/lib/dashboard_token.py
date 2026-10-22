"""The dashboard token this caller should present (acrovelIQ P0-1, plan step 5.2).

The same rule as scripts/lib/dashboard-token.sh, for the Python hooks: the agent
is the CALLING OS USER's (an agent's runAsUser, or the main agent for the
install's owner), never a name the caller passes; its token is
store/tokens/<agent>.token.

THREE CASES, and they are not the same (P0-1, task p01-legacy-uzenet-hivo, acrobot 35206):
  - an AGENT's caller (its runAsUser, or the install's owner = the main agent) whose own token is missing,
    unreadable or empty: DashboardTokenError. That is a provisioning fault, and falling back to the shared
    token only hid it (the call then went out as "legacy" and, once the shared token is narrowed, was refused);
  - the install's owner while .env is unreadable or has no MAIN_AGENT_ID: DashboardTokenError. The old
    default "marveen" has no token file, so such a process silently used the shared token;
  - a caller that is no agent at all (root, cron, an unknown user): the shared store/.dashboard-token with one
    line on stderr, as before, until the scripts that legitimately use it (docs/b28-titok-kivetel.md) are moved.
The error message is also written to stderr before it is raised. That leaves a trace for a caller that swallows
the exception (thirteen callers do, `except Exception`, and take the shared path: eight hooks, fleet-doctor.py,
fleet-state.py, heartbeat-metrics.sh, pr-beolvaszt.sh, task-last-run.sh), but for a HOOK that trace is only in its
log: Claude Code shows a hook's stderr on exit 0 only in the verbose view. Those callers are being moved one by one
(card 809a2f48); until then they still use the shared token in that case.
"""
import glob
import json
import os
import pwd
import re
import sys

AGENT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class DashboardTokenError(OSError):
    """An agent's own token cannot be used. NOT a reason to fall back to the shared token."""


def _fail(message):
    full = "dashboard-token: " + message
    print(full, file=sys.stderr)
    raise DashboardTokenError(full)


def _main_agent(root):
    """MAIN_AGENT_ID from .env, or None when .env is unreadable or does not name one."""
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    value = line.split("=", 1)[1].strip().strip("'\"")
                    return value or None
    except OSError:
        pass
    return None


def token_agent(root, user):
    """The agent name for an OS user, or None."""
    if not user:
        return None
    for cfg in sorted(glob.glob(os.path.join(root, "agents", "*", "agent-config.json"))):
        try:
            with open(cfg, encoding="utf-8") as f:
                if json.load(f).get("runAsUser") == user:
                    name = os.path.basename(os.path.dirname(cfg))
                    return name if AGENT_NAME.match(name) else None
        except (OSError, ValueError):
            continue
    try:
        owner = os.stat(os.path.join(root, "store")).st_uid == os.geteuid()
    except OSError:
        owner = False
    if owner:
        main = _main_agent(root)
        if main is None:
            _fail(
                "this process runs as the install's owner but %s/.env is unreadable or has no MAIN_AGENT_ID: "
                "refusing to guess the main agent (the old default had no token file)" % root
            )
        return main if AGENT_NAME.match(main) else None
    return None


def token_file(root, user=None):
    """The token file to read."""
    if user is None:
        # the effective uid's name, the same as `id -un` in the bash resolver;
        # NOT getpass.getuser(), which reads USER/LOGNAME first, so an inherited
        # environment would name someone else (barracuda #34)
        try:
            user = pwd.getpwuid(os.geteuid()).pw_name
        except KeyError:
            user = ""
    agent = token_agent(root, user)
    if agent:
        path = os.path.join(root, "store", "tokens", agent + ".token")
        if os.access(path, os.R_OK) and os.path.getsize(path) > 0:
            return path
    if agent:
        _fail(
            "the own token of agent %s (user %s) is missing, unreadable or empty (%s): the shared token is NOT "
            "used for an agent; ask the main agent to issue it (scripts/issue-agent-token.ts)"
            % (agent, user or "?", path)
        )
    print(
        "dashboard-token: no agent for user %s, using the shared token" % (user or "?"),
        file=sys.stderr,
    )
    return os.path.join(root, "store", ".dashboard-token")


def own_token_path(root, user=None):
    """(path, None) of the caller's OWN token file, or (None, why). NEVER the shared file, and never raises.

    For callers that must carry on without a token (a hook must not stop the agent): they get the reason to
    report and decide what to do. token_file() raises DashboardTokenError for an agent whose own token is
    missing; for a caller that is no agent at all it still returns the shared path (loudly), which is refused
    here by its location, because the own tokens live in store/tokens/."""
    try:
        path = token_file(root, user)
    except OSError:
        return None, "the own dashboard token is missing, unreadable or empty"
    except Exception as e:
        return None, "the token resolver failed (%s)" % type(e).__name__
    if os.path.basename(os.path.dirname(path)) != "tokens":
        return None, "no own dashboard token (only the shared one exists, and it is not used)"
    return path, None


def own_token(root, user=None):
    """(token, None) of the caller's OWN token, or (None, why). The shared token is never returned."""
    path, why = own_token_path(root, user)
    if path is None:
        return None, why
    try:
        with open(path, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        return None, "the own dashboard token cannot be read"
    if not token:
        return None, "the own dashboard token is empty"
    return token, None


def read_token(root, user=None):
    """The token itself, stripped; '' when the file cannot be read. DashboardTokenError is NOT swallowed."""
    path = token_file(root, user)
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""
