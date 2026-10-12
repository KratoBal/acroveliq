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

Read-only: it queries the dashboard API and prints. It writes nothing.
"""

import datetime
import json
import os
import sys
import urllib.error
import urllib.request

# the calling user's own dashboard token if handed out, else the shared one,
# loudly (acrovelIQ P0-1, plan 5.2; scripts/lib/dashboard_token.py). Defensive:
# a hook run from elsewhere falls back to the shared path instead of failing.
def _dashboard_token_file(root):
    try:
        import sys as _sys
        _lib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
        if _lib not in _sys.path:
            _sys.path.insert(0, _lib)
        from dashboard_token import token_file
        return token_file(root)
    except Exception:
        return os.path.join(root, "store", ".dashboard-token")

INSTALL_DIR = os.environ.get("CLAUDE_PROJECT_DIR", "/home/marveen/marveen")
API = "http://localhost:3420/api/daily-log"
TOKEN_FILE = _dashboard_token_file(INSTALL_DIR)
AGENT = "acrobot"
DAYS = 2
MAX_ROWS = 12


def token():
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return None


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
    tok = token()
    if not tok:
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
    out.append(
        "A teljes szoveg: curl -s -H \"Authorization: Bearer $(cat "
        + INSTALL_DIR
        + '/store/.dashboard-token)" "http://localhost:3420/api/daily-log?agent=acrobot&date=<EEEE-HH-NN>"'
    )
    sys.stdout.write("\n".join(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
