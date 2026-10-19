#!/usr/bin/env bash
# ANSWERS: Lejart-e valamelyik fleet_ro oszlop-jog, es visszavette-e a kapu? (task parancssor-a-fleet-ro-grant)
#
#   bash /home/marveen/marveen/scripts/fleet-ro-szukit.sh
#
# Runs the B8 gate's `fleet-ro-grant <key> <database> szukit` on the fleet's own key. The gate takes back ONLY the
# expired lines of the LAST APPLIED list, takes no list from the caller, and never takes back a line that is merely
# missing (that is `alkalmaz`, with the owner's approval). It needs no approval because it only narrows. It stops at 40
# columns in one run and asks for a human decision. This script can run `szukit` and nothing else: the mode is in the
# command line below, not an argument.
#
# The first line of the output is the verdict, for a scheduled task to read:
#   SZUKIT nincs-teendo            nothing expired, or no list applied yet
#   SZUKIT visszavett <N>          N REVOKE lines ran
#   SZUKIT HIBA rc=<code>: <line>  the gate refused or did not answer (more than 40 columns, no key, no network ...)
# Exit: 0 for the first two, 1 for the third.
#
# Env: ELES_HOST (default fleet@162.55.216.28), ELES_KEY (default the monitor key), the same as the other fleet scripts
# that read the production host through the gate.
set -uo pipefail

HOST="${ELES_HOST:-fleet@162.55.216.28}"
KEY="${ELES_KEY:-/home/marveen/.ssh/id_ed25519_acropora_monitor}"
# the gate's container key and database: the same pair as GRANT_TARGETS in scripts/host/fleet-gate.sh
GATE_KEY='iwm34jaqp9xmwb72qkrqkwhy'
DATABASE='acropora'

OUT="$(timeout 120 ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -- "$HOST" "fleet-ro-grant ${GATE_KEY} ${DATABASE} szukit" 2>&1)"
RC=$?

if [ "$RC" -ne 0 ]; then
  FIRST="$(printf '%s\n' "$OUT" | grep -m1 . | cut -c1-200)"
  echo "SZUKIT HIBA rc=${RC}: ${FIRST}"
  exit 1
fi
if printf '%s\n' "$OUT" | grep -qE 'nincs lej[^ ]*rt sor|nincs alkalmazott lista'; then
  echo "SZUKIT nincs-teendo"
  printf '%s\n' "$OUT" | cut -c1-200
  exit 0
fi
N="$(printf '%s\n' "$OUT" | grep -c 'REVOKE SELECT' || true)"
echo "SZUKIT visszavett ${N}"
printf '%s\n' "$OUT" | cut -c1-200
exit 0
