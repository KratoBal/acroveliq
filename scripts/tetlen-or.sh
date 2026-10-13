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

set -uo pipefail
ROOT=/home/marveen/marveen
LIMIT="${1:-20}"
STATE="$ROOT/store/tetlen-or.state"
HOUR=$(date +%H)
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

[ -z "$IDLE" ] && { rm -f "$STATE"; exit 0; }
KEY=$(printf '%s' "$IDLE" | sed -E 's/\([0-9]+p\)//g')
if [ -f "$STATE" ]; then
  read -r OLDKEY OLDT < "$STATE" || true
  if [ "${OLDKEY:-}" = "$(printf '%s' "$KEY" | tr -d ' ')" ] && [ $(( $(date +%s) - ${OLDT:-0} )) -lt 3600 ]; then exit 0; fi
fi
printf '%s %s\n' "$(printf '%s' "$KEY" | tr -d ' ')" "$(date +%s)" > "$STATE"

MSG="[TETLEN-OR] Tetlenul all:${IDLE}. Nezd meg, kire var (gyakran rad: beolvasztas, review-keres, kovetkezo tetel), es adj ki munkat. (scripts/tetlen-or.sh, nem LLM)"
bash "$ROOT/scripts/agent-msg.sh" acrobot acrobot "$MSG"
