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
#   3. naploz, es 3-as koddal kilep; ha az uzenet NEM ment el (agent-msg.sh nem `OK id=`), 4-gyel.
# Ha a feladat lezarul (review_requested vagy done esemeny), 0-val kilep.
#
# A keret a feladat MUNKA-ablakara szol (task-usage "work" sora), tehat a review es az admin nem
# szamit bele. Az ido a gyujto kesesevel egyutt <perc>+1 perc pontossagu.

set -uo pipefail
TASK="${1:?task_id}"; AGENT="${2:?agent}"; MAX_CR="${3:?max cache-read millio}"; MAX_CALLS="${4:?max hivas}"; EVERY="${5:-5}"
# KERET_OR_ROOT only exists for the contract test (scripts/__tests__/feladat-keret-or.test.sh).
ROOT="${KERET_OR_ROOT:-/home/marveen/marveen}"
TOKEN="$(cat "$ROOT/store/.dashboard-token")"
DB="$ROOT/store/claudeclaw.db"

while true; do
  curl -s -m 300 -X POST -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") http://localhost:3420/api/token-usage/collect >/dev/null
  read -r CALLS CR CLOSED < <(python3 - "$DB" "$TASK" "$ROOT" <<'PY'
import sqlite3, sys, subprocess, re
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
task = sys.argv[2]
out = subprocess.run(["bash", sys.argv[3] + "/scripts/fleet-api.sh", "task-usage", task],
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
    # The message only claims the interruption when a send-keys call actually succeeded:
    # without the sudo tmux rule both calls fail, and "I interrupted your turn" would be false.
    # With the fleet-pane switch on the tmux line may be gone: the broker's interrupt verb sends
    # the Escape, and only while a turn runs and no dialog is up (exit 0 = sent; B48 (2)).
    if python3 -I "$ROOT/scripts/lib/fleet_pane_switch.py" "$ROOT" >/dev/null 2>&1; then
      INTERRUPT=(sudo -n /usr/local/sbin/fleet-pane interrupt "$AGENT")
    else
      INTERRUPT=(sudo -n -u "agent-$AGENT" /usr/bin/tmux send-keys -t "agent-$AGENT" Escape)
    fi
    if "${INTERRUPT[@]}" 2>/dev/null \
      || /usr/bin/tmux send-keys -t "agent-$AGENT" Escape 2>/dev/null; then
      STOPPED="A futo koredet en szakitottam meg (Escape), a feladat-keret-or.sh miatt."
      LOGSTOP="$AGENT megallitva (Escape)."
    else
      STOPPED="A futo koredet NEM tudtam megszakitani (a tmux send-keys elbukott), ezert ez az uzenet a kor vegen er hozzad."
      LOGSTOP="$AGENT Escape NEM ment (tmux send-keys elbukott), csak uzenet."
    fi
    # WHY a private directory (barracuda, review of tcl-l0, 2026-10-13): the old fixed
    # /tmp/keret-<task>.txt could be pre-created by any other user. With
    # fs.protected_regular=2 our write into it is refused, the script (no -e) went on, and
    # agent-msg.sh sent THAT user's text in acrobot's name. mktemp -d gives a 0700
    # directory with an unpredictable name, and a failed write now stops the send.
    MSGDIR="$(mktemp -d)" || { echo "FAIL: mktemp -d" >&2; exit 1; }
    MSG="$MSGDIR/keret.txt"
    if ! printf '%s\n' "KERET ELERVE, $TASK: $CALLS hivas, ${CR}M olvasott token (keret: $MAX_CALLS hivas, ${MAX_CR}M). $STOPPED Allj meg, ird le egy sorban, hol tartasz, es varj. Ne folytasd." > "$MSG"; then
      echo "FAIL: az uzenetet nem tudtam kiirni ($MSG), nem kuldok semmit" >&2
      rm -rf "$MSGDIR"; exit 1
    fi
    # A send counts only with exit 0 AND an `OK id=` line (barracuda, review of #39): the log
    # used to read as if the agent had been told even when agent-msg.sh printed FAIL.
    SENDOUT="$(bash "$ROOT/scripts/agent-msg.sh" acrobot "$AGENT" - < "$MSG")"; SENDRC=$?
    rm -rf "$MSGDIR"
    printf '%s\n' "$SENDOUT"
    if [ "$SENDRC" -eq 0 ] && printf '%s\n' "$SENDOUT" | grep -q '^OK id='; then
      SENT="uzenet sorba kerult (a kezbesitest a message-status mondja meg) ($(printf '%s\n' "$SENDOUT" | grep -o '^OK id=[0-9]*' | head -1))."
      RC=3
    else
      SENT="az uzenet NEM ment el (agent-msg.sh rc=$SENDRC), $AGENT nem tud rola."
      echo "FAIL: $SENT" >&2
      RC=4
    fi
    bash "$ROOT/scripts/daily-log.sh" acrobot "Feladat-keret elerve: $TASK" "$CALLS hivas, ${CR}M olvasas; keret $MAX_CALLS / ${MAX_CR}M; $LOGSTOP $SENT"
    exit "$RC"
  fi
  sleep "$((EVERY * 60))"
done
