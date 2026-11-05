#!/usr/bin/env bash
# ANSWERS: All-e tetlenul egy fejleszto agens ugy, hogy senki nem lok rajta (pl. mert acrobot ujraindult)?
#
# tetlen-or.sh [kuszob_perc=20]   (cronbol, 08-24 kozott tizpercenkent)
#
# WHY (Balazs, 2026-10-12 18:02 UTC, fo csatorna): "ha te ujraindulsz es en nem kerdezek akkor
# neztek mint borju az ujkapura". Mert: 16:15 es 20:00 kozott murena, nautilus es barracuda
# tetlenul allt, mert ket atnezett PR az en beolvasztasomra vart, egy review-keres pedig el sem
# ment. A futasi-rend-orjarat (LLM-kor, felorankent) 2026-10-09 ota token-okbol ki van kapcsolva.
# Ez az or NEM LLM: csak a panelt olvassa, es CSAK tetlenseg eseten ebreszt fel egy uzenettel.
#
# MIT CSINAL: agensenkent a panel "done H:MM AM/PM" sorabol kiszamolja, mennyi ideje kesz a kore.
# Ha kuszob folott all, es nincs neki kezbesitetlen uzenete, acrobotnak kuld egy inter-agent
# uzenetet (egy korben egyet, az osszes tetlen nevevel). Ugyanarra az allapotra 60 percig nem
# ismetel (store/tetlen-or.state).
#
# ES A FLOTTA-ZARON VARO FOLYAMAT (acrobot 43759, 2026-11-05): ha egy agens folyamata a kuszobnel
# tovabb var a nehez-futas zaran (/tmp/flotta-nehez.lock), az is bekerul, a paneltol fuggetlenul.
# murena ket orat allt egy futtat-gyereken, ami a futtat altal mar tartott zarra flock-olt; a
# panel kozben "shell still running"-ot mutatott, a done-ido alapjan nem latszott tetlennek.
# A meres a kernel zartablajabol jon: scripts/zar-varakozok.py.

set -uo pipefail
# a teszt egy hamis fat (agent-pane.sh, agent-msg.sh, zar-varakozok.py, store/) es egy orat ad meg; elesben ures
ROOT="${TETLEN_OR_ROOT:-/home/marveen/marveen}"
LIMIT="${1:-20}"
STATE="$ROOT/store/tetlen-or.state"
HOUR="${TETLEN_OR_HOUR:-$(date +%H)}"
[ "$HOUR" -lt 8 ] && exit 0

IDLE=""
for A in murena nautilus barracuda; do
  PANE=$(bash "$ROOT/scripts/agent-pane.sh" "$A" 2>/dev/null | tail -25)
  # a kor fut: nincs mit nezni
  printf '%s' "$PANE" | grep -q 'esc to interrupt' && continue
  DONE=$(printf '%s' "$PANE" | grep -oE 'done [0-9]{1,2}:[0-9]{2} (AM|PM)' | tail -1 | cut -d' ' -f2-)
  [ -z "$DONE" ] && continue
  T=$(date -d "today $DONE" +%s 2>/dev/null) || continue
  NOW=$(date +%s)
  [ "$T" -gt "$NOW" ] && T=$((T-86400))
  MIN=$(( (NOW-T)/60 ))
  [ "$MIN" -lt "$LIMIT" ] && continue
  IDLE="$IDLE $A(${MIN}p)"
done

WAIT=""
while read -r W_AGENT W_PID W_MIN W_HOLDER W_KIND; do
  [ -z "${W_AGENT:-}" ] && continue
  if [ "$W_KIND" = "holtpont" ]; then
    WAIT="$WAIT $W_AGENT(${W_MIN}p, pid $W_PID, HOLTPONT: a zarat a sajat szuloje tartja, pid $W_HOLDER)"
  else
    WAIT="$WAIT $W_AGENT(${W_MIN}p, pid $W_PID, a zarat a $W_HOLDER tartja)"
  fi
done < <(python3 "$ROOT/scripts/zar-varakozok.py" --perc "$LIMIT" 2>/dev/null)

[ -z "$IDLE$WAIT" ] && { rm -f "$STATE"; exit 0; }
KEY=$(printf '%s' "$IDLE" | sed -E 's/\([0-9]+p\)//g')$(printf '%s' "$WAIT" | sed -E 's/\([^)]*\)//g; s/^/zar:/')
if [ -f "$STATE" ]; then
  read -r OLDKEY OLDT < "$STATE" || true
  if [ "${OLDKEY:-}" = "$(printf '%s' "$KEY" | tr -d ' ')" ] && [ $(( $(date +%s) - ${OLDT:-0} )) -lt 3600 ]; then exit 0; fi
fi
printf '%s %s\n' "$(printf '%s' "$KEY" | tr -d ' ')" "$(date +%s)" > "$STATE"

MSG="[TETLEN-OR]"
[ -n "$IDLE" ] && MSG="$MSG Tetlenul all:${IDLE}. Nezd meg, kire var (gyakran rad: beolvasztas, review-keres, kovetkezo tetel), es adj ki munkat."
[ -n "$WAIT" ] && MSG="$MSG A flotta-zaron var:${WAIT}. Holtpontnal a folyamat soha nem halad: a varo flock-ot kell leallitani, es a parancsot futtat nelkul vagy zar nelkuli alakkal futtatni."
MSG="$MSG (scripts/tetlen-or.sh, nem LLM)"
bash "$ROOT/scripts/agent-msg.sh" acrobot acrobot "$MSG"
