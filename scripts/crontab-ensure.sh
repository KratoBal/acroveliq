#!/usr/bin/env bash
# ANSWERS: Visszakerulnek-e a mentes cron-sorai egy kontener-ujrateremtes utan, ember nelkul?
#
# crontab-ensure.sh [--dry-run]
#
# Restore the marveen user's crontab lines listed in scripts/crontab/marveen.cron.
#
# WHY (measured 2026-10-14 04:11): the container was recreated on 2026-10-13 18:09, the user
# crontab lives in the CONTAINER filesystem (/var/spool/cron), so it was gone ("no crontab for
# marveen") and the 03:40 fleet backup silently did not run. The image entrypoint only writes
# /etc/cron.d/marveen (the morning briefing); nothing brought the backup lines back.
#
# Called on every start from scripts/ensure-native-modules.sh (runs as marveen, before the
# dashboard). Idempotent: only lines MISSING from the live crontab are appended, every other
# line (hand-added or otherwise) is kept as is. Non-fatal by contract: exits 0 on failure so a
# broken cron never keeps the dashboard down; the failure is printed to stderr.
set -u

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WANT="$SCRIPT_DIR/crontab/marveen.cron"
[ -f "$WANT" ] || { echo "crontab-ensure: $WANT missing, nothing to restore" >&2; exit 0; }

# "No crontab" and a failed read both exit 1. Only the first may be treated as empty: on any
# other error the install below would REPLACE the whole crontab with these lines (barracuda,
# review of #96). So an unreadable crontab means: report and write nothing.
OUT="$(crontab -l 2>&1)"; RC=$?
if [ "$RC" -eq 0 ]; then
  CUR="$OUT"
elif [[ "$OUT" == "no crontab for "* ]]; then
  CUR=""
else
  echo "crontab-ensure: cannot read the crontab (rc $RC: $OUT), not writing" >&2
  exit 0
fi
MISSING=""
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  if ! printf '%s\n' "$CUR" | grep -qxF -- "$line"; then
    MISSING="${MISSING}${line}"$'\n'
  fi
done < "$WANT"

if [ -z "$MISSING" ]; then
  echo "crontab-ensure: OK, all lines present" >&2
  exit 0
fi

if (( DRY )); then
  printf 'crontab-ensure: DRY, would add:\n%s' "$MISSING" >&2
  exit 0
fi

NEW="$CUR"
[ -n "$NEW" ] && NEW="${NEW}"$'\n'
NEW="${NEW}${MISSING}"
if printf '%s' "$NEW" | crontab -; then
  printf 'crontab-ensure: restored:\n%s' "$MISSING" >&2
else
  echo "crontab-ensure: FAILED to install crontab" >&2
fi
exit 0
