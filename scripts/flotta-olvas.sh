#!/usr/bin/env bash
# ANSWERS: Mit lat a fo agens a flotta adatbazisabol, ha a munkamenete nem nyithatja meg a store-t? (B29)
#
#   bash scripts/flotta-olvas.sh <kerdes> [kulcs=ertek ...]
#   bash scripts/flotta-olvas.sh access-decisions nap=2026-10-16 actor=nautilus outcome=would-deny
#   bash scripts/flotta-olvas.sh request-actors actor=nautilus ido=1792132017 ablak=5
#   bash scripts/flotta-olvas.sh uzenet-ablak agens=nautilus tol=1792131500 ig=1792131700
#   bash scripts/flotta-olvas.sh uzenet id=31909
#   bash scripts/flotta-olvas.sh tool-log-osszesito agens=acrobot napok=7 csoport=elotag
#   bash scripts/flotta-olvas.sh tool-log-minta agens=acrobot elotag='Bash: curl' napok=7
#   bash scripts/flotta-olvas.sh kartya-letrehozas tol=1792111090 ig=1792111092
#
# A thin client of GET /api/fleet-reads/<kerdes> (src/web/routes/fleet-reads.ts): fixed questions,
# no SQL, the server checks every parameter. Only the session and the main agent get an answer.
# Output: one JSON object per row, then "<n> sor". A refusal (400, 403, 404) is FAIL with the
# server's reason, exit 1. The token is the caller's own, through a file descriptor
# (scripts/dashboard-fejlec.sh).
set -uo pipefail
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
Q="${1:-}"
case "$Q" in
  access-decisions|request-actors|uzenet-ablak|uzenet|tool-log-osszesito|tool-log-minta|kartya-letrehozas) ;;
  *) echo "hasznalat: flotta-olvas.sh <access-decisions|request-actors|uzenet-ablak|uzenet|tool-log-osszesito|tool-log-minta|kartya-letrehozas> [kulcs=ertek ...]" >&2; exit 2 ;;
esac
shift
QS="$(python3 -I - "$@" <<'PY'
import re, sys, urllib.parse
pairs = []
for a in sys.argv[1:]:
    k, sep, v = a.partition('=')
    if not sep or not re.fullmatch(r'[a-z]{1,20}', k):
        print('FAIL: a parameter alakja kulcs=ertek (kisbetus kulcs): ' + a[:40], file=sys.stderr); sys.exit(2)
    pairs.append((k, v))
print(urllib.parse.urlencode(pairs))
PY
)" || exit 2
RESP="$(curl -s -H @<(bash "$BASE/scripts/dashboard-fejlec.sh") -w $'\n%{http_code}' "http://localhost:${PORT}/api/fleet-reads/${Q}${QS:+?$QS}")"
CODE="$(printf '%s' "$RESP" | tail -n1)"
printf '%s' "$RESP" | sed '$d' | FR_CODE="$CODE" python3 -I -c '
import json, os, sys
code = os.environ["FR_CODE"]
try:
    d = json.load(sys.stdin)
except ValueError:
    print("FAIL http=%s: a valasz nem JSON" % code); sys.exit(1)
if code != "200":
    print("FAIL http=%s: %s" % (code, d.get("error", "?") if isinstance(d, dict) else "?")); sys.exit(1)
for r in d.get("sorok", []):
    print(json.dumps(r, ensure_ascii=False))
print("%d sor" % d.get("darab", 0))
'
