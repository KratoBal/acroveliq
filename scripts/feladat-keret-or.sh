#!/usr/bin/env bash
# ANSWERS: Megall-e TENYLEG egy agens, ha egy mert feladata atlepi a fogyasztasi keretet (olvasott token, hivasszam)?
#
# feladat-keret-or.sh <task_id> <agent> <max_cache_read_millio> <max_hivas> [perc=5]
#
# WHY (Balazs, 2026-10-12 13:21 UTC, Token-proba, 1. feltetel): a vegszamla-meresnel a
# "hasonlo tetelek ketszerese" leallitasi szabaly csak SZOVEGBEN allt. Senki nem figyelte elo:
# a tokengyujto orankent fut, es 14:38-tol 15:18-ig egy adatot sem hozott, tehat a 92. hivasnal
# sem latszott semmi, es a feladat 120 hivasig ment. Egy keret, amit semmi nem mer a futas
# kozben, nem keret.
#
# MIT CSINAL: <perc> percenkent elinditja a gyujtest (POST /api/token-usage/collect), lekeri a
# feladat fogyasztasat (task-usage), es ha a cache-olvasas VAGY a hivasszam eleri a keretet:
#   1. Escape-pel megszakitja az agens futo koret (a panelbe kerul, szoveg NEM),
#   2. boritekos uzenetet kuld neki az okkal,
#   3. naploz, es 3-as koddal kilep.
# Ha a feladat lezarul (review_requested vagy done esemeny), 0-val kilep.
#
# A keret a feladat MUNKA-ablakara szol (task-usage "work" sora), tehat a review es az admin nem
# szamit bele. Az ido a gyujto kesesevel egyutt <perc>+1 perc pontossagu.

set -uo pipefail
TASK="${1:?task_id}"; AGENT="${2:?agent}"; MAX_CR="${3:?max cache-read millio}"; MAX_CALLS="${4:?max hivas}"; EVERY="${5:-5}"
ROOT=/home/marveen/marveen
TOKEN="$(cat "$ROOT/store/.dashboard-token")"
DB="$ROOT/store/claudeclaw.db"

while true; do
  curl -s -m 300 -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3420/api/token-usage/collect >/dev/null
  read -r CALLS CR CLOSED < <(python3 - "$DB" "$TASK" <<'PY'
import sqlite3, sys, subprocess, re
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
task = sys.argv[2]
out = subprocess.run(["bash", "/home/marveen/marveen/scripts/fleet-api.sh", "task-usage", task],
                     capture_output=True, text=True).stdout
m = re.search(r"^\s*work\s+(\d+) hivas.*cache-olv\s+([\d.]+)M", out, re.M)
calls, cr = (m.group(1), m.group(2)) if m else ("0", "0")
last = db.execute("select kind from task_events where task_id=? order by at desc limit 1", (task,)).fetchone()
closed = 1 if last and last[0] in ("review_requested", "done", "merged") else 0
print(calls, cr, closed)
PY
)
  echo "$(date +%T) $TASK: $CALLS hivas, ${CR}M olvasas (keret: $MAX_CALLS hivas, ${MAX_CR}M)"
  if [ "$CLOSED" = "1" ]; then echo "lezarva, a keret alatt maradt"; exit 0; fi
  if python3 -c "import sys; sys.exit(0 if float('$CR') >= float('$MAX_CR') or int('$CALLS') >= int('$MAX_CALLS') else 1)"; then
    sudo -n -u "agent-$AGENT" /usr/bin/tmux send-keys -t "agent-$AGENT" Escape 2>/dev/null \
      || /usr/bin/tmux send-keys -t "agent-$AGENT" Escape 2>/dev/null
    printf '%s\n' "KERET ELERVE, $TASK: $CALLS hivas, ${CR}M olvasott token (keret: $MAX_CALLS hivas, ${MAX_CR}M). A futo koredet en szakitottam meg (Escape), a feladat-keret-or.sh miatt. Allj meg, ird le egy sorban, hol tartasz, es varj. Ne folytasd." \
      > "/tmp/keret-$TASK.txt"
    bash "$ROOT/scripts/agent-msg.sh" acrobot "$AGENT" - < "/tmp/keret-$TASK.txt"
    bash "$ROOT/scripts/daily-log.sh" acrobot "Feladat-keret elerve: $TASK" "$CALLS hivas, ${CR}M olvasas; keret $MAX_CALLS / ${MAX_CR}M; $AGENT megallitva."
    exit 3
  fi
  sleep "$((EVERY * 60))"
done
