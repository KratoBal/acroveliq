#!/bin/bash
# The mail sorter of balazs@ (task level-kozvetito-4b; src/level-besorol.ts, plan exchange-out/level-kozvetito-terv-v2-2026-10-19.md B).
# A TOOL-LESS reader places the redacted mails into the five labels; THIS code checks its table, puts the labels on through the
# mail relay's `cimkez`, and prints the daily list for Balázs (no model-written text in it). It never archives.
#
#   bash /home/marveen/marveen/scripts/level-besorol.sh [--nez] [--q <gmail search>] [--max <1-50>] [--allapot <file>]
#   exit 0: the daily list; 2: a hard stop (why, on stdout)
#   --nez: reads and classifies, prints what it would do; no label is made or put on, no state is written
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/dist/level-besorol.js" "$@"
