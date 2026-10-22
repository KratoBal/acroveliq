#!/usr/bin/env python3
"""SessionStart hook: the last few things I did, so a restart does not erase the day.

WHY THIS EXISTS, measured 2026-09-01 22:02. The container was recreated at 21:41 and the
live conversation went with it. Minutes later I asked the owner a question whose answer we
had produced together that same afternoon. His words: *"Tenyleg ki kell erre talalnunk
valamit, hogy tudd mit csinalunk mert ebbol elobb utobb baj lesz."*

The record was never missing: every one of those rounds is in the daily log, written by me,
with a measured timestamp. What was missing is that nothing PUT IT IN FRONT OF ME at the
moment the session began. A log nobody opens is not a memory.

This prints only the HEADLINE of each recent entry (the first line), newest first, and
names the command that opens the full text. The point is recognition, not recall: enough to
know that a subject was already handled, and where to read the rest.

Read-only: it queries the dashboard API and prints. It writes nothing, except when it has no own dashboard token:
then it prints one rate-limited line and keeps a marker and a one-line-a-day note (ledger_lib.hook_context_notice).
"""

import datetime
import json
import os
import sys
import urllib.error
import urllib.request

# The calling user's OWN dashboard token, or nothing (acrovelIQ P0-1, task p01-csendes-visszaeso-hivok).
# NEVER the shared one. Without it the hook SAYS so (one rate-limited line into the context): a session start
# that silently brings back nothing hides that the day's log was not read.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402

INSTALL_DIR = os.environ.get("CLAUDE_PROJECT_DIR", "/home/marveen/marveen")


def _web_port():
    port = os.environ.get("WEB_PORT")
    if not port:
        try:
            with open(os.path.join(INSTALL_DIR, ".env")) as f:
                for line in f:
                    if line.startswith("WEB_PORT="):
                        port = line.split("=", 1)[1].strip().strip('"')
                        break
        except OSError:
            pass
    return port or "3420"


API = "http://localhost:%s/api/daily-log" % _web_port()
AGENT = "acrobot"
DAYS = 2
MAX_ROWS = 12


def fetch(day, tok):
    url = "%s?agent=%s&date=%s" % (API, AGENT, day)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, ValueError, OSError):
        # A hook that fails must stay silent: a session start is not the place to
        # report that the dashboard was slow.
        return []


def headline(entry):
    text = (entry.get("content") or "").strip()
    for line in text.splitlines():
        line = line.strip().lstrip("#").strip()
        if not line:
            continue
        # The log's own header already carries the time ("21:49 -- Topic"); this hook
        # prints a measured timestamp of its own, so keeping both would read as two
        # different clocks on one row.
        parts = line.split(" -- ", 1)
        if len(parts) == 2 and len(parts[0]) <= 5 and ":" in parts[0]:
            return parts[1].strip()
        return line
    return ""


def main():
    tok, why = _own_token(INSTALL_DIR)
    if not tok:
        sys.stdout.write(ledger_lib.hook_context_notice("session-recent-log", why))
        return 0
    rows = []
    today = datetime.date.today()
    for back in range(DAYS):
        day = (today - datetime.timedelta(days=back)).isoformat()
        for e in fetch(day, tok):
            rows.append((e.get("created_at") or 0, day, headline(e)))
    if not rows:
        return 0
    rows.sort(key=lambda r: r[0], reverse=True)
    out = ["AMIN MA DOLGOZTAM (a napi naplo fejlecei, ujak elol). Mielott barmit ujra"]
    out.append("elkezdenel vagy megkerdeznel, nezd meg, hogy nem all-e itt mar.")
    out.append("")
    for stamp, day, head in rows[:MAX_ROWS]:
        when = ""
        try:
            when = datetime.datetime.fromtimestamp(int(stamp)).strftime("%m-%d %H:%M")
        except (ValueError, OSError, TypeError):
            when = day
        out.append("  %s  %s" % (when, head[:110]))
    out.append("")
    # the helper presents the reader's own token; a printed curl with the shared
    # token is what the reader would copy (acrovelIQ P0-1, legacy_callers)
    out.append(
        "A teljes szoveg: bash "
        + INSTALL_DIR
        + "/scripts/fleet-api.sh daily-log-read %s <EEEE-HH-NN> full" % AGENT
    )
    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
