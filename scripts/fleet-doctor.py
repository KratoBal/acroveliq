#!/usr/bin/env python3
"""fleet-doctor -- one command that answers "is the fleet actually healthy?"

WHY THIS EXISTS. On 2026-09-01 an update broke the fleet at 09:22 and it was not fully
understood until 11:25. The repair itself was minutes; the two hours went into MEASURING,
by hand, one agent at a time: which OS user each agent runs as, which security profile it
resolved, whether it is parked on a dialog, whether its transcript is being written, whether
it can still receive messages. Every one of those is one line of code. None of them existed.

Six checks per agent, and each one of them was a separate discovery that morning:

  1. process     -- is a claude process alive, and under WHICH OS user
  2. user        -- does that match runAsUser in agent-config.json
                    (they silently diverged, and five agents ran TWICE)
  3. profile     -- does the securityProfile file exist, and what permissionMode
                    (two profile files were deleted; the agents fell back to permissive)
  4. launch      -- does --dangerously-skip-permissions match the profile's mode
                    (this is what EXPOSED the missing profile; it is the sharpest signal here)
  5. pane        -- idle / busy / parked on approval / parked on a start-up dialog
                    (a parked agent receives no inter-agent messages and reads as silent)
  6. transcript  -- is a session log being written at all
                    (one agent ran for 90 minutes writing nothing, its context RAM-only)

Plus the message queue depth per agent, from the dashboard API.

USAGE
  python3 scripts/fleet-doctor.py            # table + what to do
  python3 scripts/fleet-doctor.py --quiet    # only agents that need attention

EXIT 0 = nothing needs attention. EXIT 1 = at least one agent does.

WHAT IT DOES NOT DO: it does not restart, answer dialogs, or change permissions. Reading is
safe to run at any time; every repair stays a decision. Same rule as fleet-patch-check.sh.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.environ.get("FLEET_ROOT", "/home/marveen/marveen")
AGENTS_DIR = os.path.join(ROOT, "agents")
PROFILES_DIR = os.path.join(ROOT, "templates", "profiles")
DASH = os.environ.get("FLEET_DASH", "http://localhost:3420")


def run(cmd, timeout=15):
    """Run a command, return (rc, stdout). Never raises."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout
    except Exception:
        return 1, ""


def _own_token():
    """(token, None) of the caller's OWN token, or (None, why). Never the shared one (P0-1, 4/4)."""
    try:
        lib = os.path.join(ROOT, "scripts", "lib")
        if lib not in sys.path:
            sys.path.insert(0, lib)
        from dashboard_token import own_token
        return own_token(ROOT)
    except Exception as e:
        return None, "the token resolver could not be loaded (%s)" % type(e).__name__


_WHY = [None]  # why the last api() call returned nothing: a missing token is not "the dashboard did not answer"


def api(path):
    """The parsed answer, or None with the reason in _WHY. The caller's OWN token only, never the shared one."""
    t, why = _own_token()
    if not t:
        _WHY[0] = why
        return None
    try:
        req = urllib.request.Request(DASH + path, headers={"Authorization": "Bearer " + t})
        return json.load(urllib.request.urlopen(req, timeout=10))
    except Exception as e:
        _WHY[0] = "the dashboard did not answer (%s)" % type(e).__name__
        return None


def agent_names():
    if not os.path.isdir(AGENTS_DIR):
        return []
    out = []
    for n in sorted(os.listdir(AGENTS_DIR)):
        if os.path.isfile(os.path.join(AGENTS_DIR, n, "agent-config.json")):
            out.append(n)
    return out


def agent_config(name):
    try:
        with open(os.path.join(AGENTS_DIR, name, "agent-config.json")) as f:
            return json.load(f)
    except Exception:
        return {}


def profile_mode(profile_id):
    """(exists, permissionMode). A MISSING profile is the finding, not an error."""
    if not profile_id:
        return True, "default"
    path = os.path.join(PROFILES_DIR, profile_id + ".json")
    if not os.path.isfile(path):
        return False, None
    try:
        with open(path) as f:
            return True, json.load(f).get("permissionMode")
    except Exception:
        return True, None


def claude_process(user):
    """The agent's own claude process line, or None. Excludes the tmux wrapper.

    None means "NOT SEEN FROM HERE", which is not the same as "not running": /proc is mounted with hidepid=invisible
    (a process of another user is invisible to a caller outside that group), and the launcher's path is not always
    .../bin/claude (the broker runs /etc/fleet-pane/conf/claude/<version>/claude). The match is the executable's
    BASENAME, the first word of the command, not a substring of the whole line (measured 2026-10-22: the substring
    "/bin/claude" matched none of the six agents, so the doctor said "not running" for all of them while the dashboard
    said running)."""
    rc, out = run(["ps", "-u", user, "-o", "pid=,cmd="])
    if rc != 0:
        return None
    for line in out.splitlines():
        words = line.split(None, 2)
        if len(words) >= 2 and os.path.basename(words[1]) == "claude":
            return line.strip()
    return None


def running_map():
    """name -> running, as the dashboard says (GET /api/agents: the dashboard's own tmux-session check), or None when
    it cannot be read. The authority for "is it running"; the process line is a cross-check for user and flags."""
    rows = api("/api/agents")
    if isinstance(rows, dict):
        rows = rows.get("agents", [])
    if not isinstance(rows, list):
        if rows is not None:
            _WHY[0] = "the dashboard's agent list had an unexpected shape"
        return None
    return {r.get("name"): bool(r.get("running")) for r in rows if isinstance(r, dict) and r.get("name")}


def broker_on():
    """The router's fleet-pane switch (scripts/lib/fleet_pane_switch.py, B48 (2))."""
    sys.path.insert(0, os.path.join(ROOT, "scripts", "lib"))
    try:
        from fleet_pane_switch import broker_on as on
    except ImportError:
        return False
    finally:
        sys.path.pop(0)
    return on(ROOT)


def pane(user, session):
    """Captured pane WITH scrollback. A bare capture-pane came back empty on a parked
    agent and read as 'dead' -- measured 2026-09-01, cost an hour."""
    if user != "marveen" and broker_on():
        # With the switch on the tmux line may already be gone: the broker's capture verb.
        rc, out = run(["sudo", "-n", "/usr/local/sbin/fleet-pane", "capture", session[len("agent-"):], "--lines", "40"])
        return out if rc == 0 else None
    rc, out = run(["sudo", "-n", "-u", user, "tmux", "capture-pane", "-p", "-S", "-40", "-t", session])
    if rc != 0:
        return None
    return out


def classify(text):
    """Order matters: a start-up dialog and an approval prompt both look like silence."""
    if text is None:
        return "NO-PANE"
    if "Select login method" in text or "Paste code here" in text:
        return "LOGIN"
    if "trust this folder" in text or "Accessing workspace" in text or "trust the files" in text:
        return "TRUST"
    if "requires approval" in text or "Do you want to proceed" in text:
        return "APPROVAL"
    if "esc to interrupt" in text:
        return "BUSY"
    if "⏵⏵" in text or re.search(r"\n❯\s*\n", text):
        return "IDLE"
    return "UNKNOWN"


def transcript_state(name):
    """Newest .jsonl under the agent's own config dir. Unreadable is NOT 'absent':
    an agent that owns its dir may deny us, and calling that 'no log' is the same
    mistake as reading a failed capture as zero."""
    base = os.path.join(AGENTS_DIR, name, ".claude-config", "projects")
    if not os.path.isdir(base):
        return "no-dir"
    newest = 0
    seen_denied = False
    for root, dirs, files in os.walk(base, onerror=lambda e: None):
        try:
            for fn in files:
                if fn.endswith(".jsonl"):
                    m = os.path.getmtime(os.path.join(root, fn))
                    newest = max(newest, m)
        except PermissionError:
            seen_denied = True
    if newest:
        import time
        age = int((time.time() - newest) / 60)
        return "%dm" % age
    return "denied" if seen_denied else "NONE"


def main():
    quiet = "--quiet" in sys.argv

    msgs = api("/api/messages?limit=200")
    # None is NOT an empty queue: a failed capture read as zero is the mistake this tool exists to prevent
    queue_known = msgs is not None
    if isinstance(msgs, dict):
        msgs = msgs.get("messages", [])
    msgs = msgs or []
    pending = {}
    for m in msgs:
        if m.get("status") == "pending":
            to = m.get("to_agent") or m.get("to")
            pending[to] = pending.get(to, 0) + 1

    running_by_api = running_map()
    why_running = _WHY[0]

    rows = []
    problems = []

    for name in agent_names():
        cfg = agent_config(name)
        want_user = cfg.get("runAsUser") or "marveen"
        prof_id = cfg.get("securityProfile")
        prof_ok, mode = profile_mode(prof_id)

        proc = claude_process(want_user)
        seen = proc is not None
        # "is it running": the dashboard's answer first; the process line only when the dashboard cannot be read.
        # A process we cannot see is NOT evidence of "not running" (hidepid), so that case is UNKNOWN, never a verdict.
        said = running_by_api.get(name) if running_by_api is not None else None
        if said is not None:
            running = said
        elif seen:
            running = True
        else:
            running = None
        skip = seen and "--dangerously-skip-permissions" in proc
        # strict profile -> no skip flag. Anything else -> flag expected.
        want_skip = mode != "strict"

        session = "agent-" + name
        state = classify(pane(want_user, session)) if running else ("?" if running is None else "-")
        tr = transcript_state(name) if running else ("?" if running is None else "-")
        q = pending.get(name, 0) if queue_known else None

        notes = []
        infos = []
        if running is False:
            notes.append("not running (the dashboard says so)" if said is not None else "not running")
            if seen:
                notes.append("a claude process of %s EXISTS although the dashboard says not running" % want_user)
        elif running is None:
            notes.append("running state UNKNOWN (not 'not running'): the process is not visible from here and the dashboard gave no answer (%s)" % why_running)
        elif not seen:
            infos.append("the process is not visible from here (/proc hidepid): the user and launch-flag checks were skipped, not passed")
        if not prof_ok:
            notes.append("profile file MISSING (%s) -> falls back to permissive" % prof_id)
        if running and seen and prof_ok and skip != want_skip:
            notes.append("launch flag does not match profile (%s, skip=%s)" % (mode, skip))
        if state in ("LOGIN", "TRUST"):
            notes.append("parked on a start-up dialog -- answer it, do NOT restart")
        if state == "APPROVAL":
            notes.append("parked on an approval prompt -- receives no messages while there")
        if tr == "NONE":
            notes.append("NO transcript is being written -- its context is RAM-only")
        if q is None:
            notes.append("message queue UNKNOWN (not zero): %s" % _WHY[0])
        elif q:
            notes.append("%d message(s) queued" % q)

        rows.append((name, want_user, prof_id or "-", mode or "?", state, tr, q, notes, infos))
        if notes:
            problems.append(name)

    hdr = "%-11s %-17s %-18s %-10s %-9s %-7s %s" % (
        "AGENT", "USER", "PROFILE", "MODE", "PANE", "LOG", "Q")
    if not quiet:
        print(hdr)
        print("-" * len(hdr))
    for name, user, prof, mode, state, tr, q, notes, infos in rows:
        if quiet and not notes:
            continue
        print("%-11s %-17s %-18s %-10s %-9s %-7s %s" % (name, user, prof, mode, state, tr, "?" if q is None else q))
        for n in notes:
            print("    ! %s" % n)
        for i in infos:
            print("    i %s" % i)

    print()
    if not problems:
        print("RESULT: %d agents, nothing needs attention." % len(rows))
        return 0
    print("RESULT: %d agents, %d need attention: %s" % (len(rows), len(problems), ", ".join(problems)))
    print()
    if broker_on():
        # No broker verb answers a dialog (docs/fleet-pane.md); who may, and through what, is
        # the plan's D6, the owner's decision.
        print("A parked dialog is read through the broker; no broker verb answers it (plan D6):")
        print("  sudo -n /usr/local/sbin/fleet-pane capture <name> --lines 40")
        print("A missing profile is restored, not worked around:")
        print("  cd %s && git checkout rebase-proba -- templates/profiles/<id>.json" % ROOT)
        return 1
    print("A parked dialog is answered from the pane, never by a number:")
    print("  sudo -n -u <user> tmux capture-pane -p -S -40 -t agent-<name>   # find the > marker")
    print("  sudo -n -u <user> tmux send-keys -t agent-<name> Enter          # only if > is on the right option")
    print("A missing profile is restored, not worked around:")
    print("  cd %s && git checkout rebase-proba -- templates/profiles/<id>.json" % ROOT)
    return 1


if __name__ == "__main__":
    sys.exit(main())
