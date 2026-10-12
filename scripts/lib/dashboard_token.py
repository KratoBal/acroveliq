"""The dashboard token this caller should present (acrovelIQ P0-1, plan step 5.2).

The same rule as scripts/lib/dashboard-token.sh, for the Python hooks: the agent
is the CALLING OS USER's (an agent's runAsUser, or the main agent for the
install's owner), never a name the caller passes; its token is
store/tokens/<agent>.token. No readable per-agent token: the shared
store/.dashboard-token, with one line on stderr, never a stop.
"""
import glob
import json
import os
import pwd
import re
import sys

AGENT_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _main_agent(root):
    try:
        with open(os.path.join(root, ".env"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    value = line.split("=", 1)[1].strip().strip("'\"")
                    return value or "marveen"
    except OSError:
        pass
    return "marveen"


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
        if os.stat(os.path.join(root, "store")).st_uid == os.geteuid():
            main = _main_agent(root)
            return main if AGENT_NAME.match(main) else None
    except OSError:
        pass
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
    print(
        "dashboard-token: no readable per-agent token for user %s (agent %s), using the shared token"
        % (user or "?", agent or "?"),
        file=sys.stderr,
    )
    return os.path.join(root, "store", ".dashboard-token")


def read_token(root, user=None):
    """The token itself, stripped; '' when unreadable."""
    try:
        with open(token_file(root, user), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""
