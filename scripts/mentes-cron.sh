#!/usr/bin/env bash
# ANSWERS: Lefutott-e ma a flotta es az AI adatbazis NAS-mentese, akkor is, ha egy agens sem fut?
#
# mentes-cron.sh <fleet|ai> -- the backups run from cron, NOT from an agent session.
#
# WHY (measured 2026-10-07, Balazs asked "Miert lett a lyuk?"): the fleet backup on the NAS has
# no file between 2026-09-10 and 2026-09-19. The backup was a scheduled task, and a scheduled
# task only fires into a RUNNING agent session that has credits. 09-11..09-13 the main agent was
# not running at all (zero daily-log entries), and the 09-14 credit stop switched 20 schedules
# off, this one included, until they were turned back on. A backup that depends on the thing it
# protects is not a backup. Cron runs without the agent and without credits.
#
# The agent-side schedules (flotta-mentes, ai-db-nas-mentes) now only READ the result line this
# writes, and speak up on FAIL or on a missing line.
set -uo pipefail
ROOT=/home/marveen/marveen
LOG="$ROOT/store/backup-work/mentes-cron.log"
mkdir -p "$ROOT/store/backup-work"
case "${1:-}" in
  fleet) CMD=(bash "$ROOT/scripts/fleet-backup.sh") ;;
  ai)    CMD=(bash "$ROOT/scripts/ai-db-nas-mentes.sh") ;;
  proba) CMD=(bash "$ROOT/scripts/visszaallitasi-proba.sh" all) ;;
  *) echo "usage: mentes-cron.sh fleet|ai|proba" >&2; exit 2 ;;
esac
OUT="$ROOT/store/backup-work/mentes-cron-$1.last"
# One run per kind at a time: a hung sftp must not have the next night pile onto it.
exec 9>"$ROOT/store/backup-work/mentes-cron-$1.lock"
flock -n 9 || { echo "$(date '+%Y-%m-%d %H:%M:%S %z') $1 rc=75 MEG FUT az elozo, kihagyva" >> "$LOG"; exit 75; }
timeout 3h "${CMD[@]}" > "$OUT" 2>&1
RC=$?
LAST=$(tail -1 "$OUT")
echo "$(date '+%Y-%m-%d %H:%M:%S %z') $1 rc=$RC $LAST" >> "$LOG"
exit $RC
