#!/bin/bash
# After the login: the whole probe again (Balázs's condition 4; acrobot, 30822 and 30834).
# ON THE HOST, AS ROOT. Not interactive. The probe now also runs V3: with OUR exec flags (the
# read-only sandbox, approval never, both shell tools off) the model cannot run a command, and
# the control run (shell_tool on, still read-only) shows the attempt. Two short model calls on
# Balázs's ChatGPT plan. If V3 is not OK, the GPT side stays off, and that is the report.
set -euo pipefail
trap 'echo "STOP: a meres a(z) $LINENO. sorban megallt ennel a parancsnal: $BASH_COMMAND" >&2' ERR
DIR="${GPT_FUTTATO_DIR:-/opt/gpt-futtato}"
cd "$DIR"
LOG="$DIR/proba-belepes-utan.log"

docker compose up --no-color > "$LOG" 2>&1 || true
docker logs gpt-futtato >> "$LOG" 2>&1 || true
chmod 600 "$LOG"
echo "== a proba a belepes utan"
grep -E "^(PROBA |PROBA-NAPLO v3|OSSZESITES)" "$LOG" || { echo "NINCS PROBA SOR: a teljes naplo $LOG"; exit 1; }

# a missing line is "nincs", not a silent pipefail stop
v3=$( { grep -E "^PROBA V3 " "$LOG" || true; } | awk '{print $3}' | tail -1)
auth=$( { grep -E "^PROBA H1-AUTH " "$LOG" || true; } | awk '{print $3}' | tail -1)
fails=$( { grep -E "^PROBA [^ ]+ FAIL" "$LOG" || true; } | wc -l | tr -d ' ')
echo "== osszegzes: V3=${v3:-nincs} H1-AUTH=${auth:-nincs} FAIL-sorok=$fails"
if [ "$v3" = "OK" ] && [ "$auth" = "OK" ] && [ "$fails" = "0" ]; then
  echo "A parancsfuttatas tiltasa bizonyitott, a hitelesito fajl rendben: a GPT-oldal aktivalasa Balazs dontese."
else
  echo "A GPT-oldal KIKAPCSOLVA MARAD: a V3 vagy a H1-AUTH nem OK, vagy van FAIL-sor. Ezt kell jelenteni."
fi
