#!/usr/bin/env bash
# Quote templates and snippets from a JSON file to the production OS, through
# the fleet-gate operation quote-templates-sync (docs/fleet-gate.md).
#
#   bash scripts/arajanlat-sablon-elesre.sh plan  <sablonok.json>   # what it would do, writes nothing
#   bash scripts/arajanlat-sablon-elesre.sh apply <sablonok.json>   # the writes, then the re-measure
#
# The file: {"templates":[{name, priceDisplay, defaultValidityDays, blocks,
# milestones}], "snippets":[{name, kind, content, milestones}]}, made from the
# test system's API read. The gate's program checks it with the image's own
# editor rules and refuses it whole on the first error (exit 3).
#
# APPLY IS A WRITE TO THE PRODUCTION DATABASE: run it only on Balázs's word for
# this round. The plan reads only.
set -uo pipefail

HOST="${ELES_HOST:-fleet@162.55.216.28}"
KEY="${ELES_KEY:-/home/marveen/.ssh/id_ed25519_acropora_monitor}"

MODE="${1:-}"
FILE="${2:-}"
case "$MODE" in plan|apply) ;; *) echo "hasznalat: $0 plan|apply <sablonok.json>" >&2; exit 2 ;; esac
[ "$#" -eq 2 ] || { echo "hasznalat: $0 plan|apply <sablonok.json>" >&2; exit 2; }
[ -f "$FILE" ] && [ -s "$FILE" ] || { echo "nincs ilyen fajl, vagy ures: $FILE" >&2; exit 2; }

ssh -o BatchMode=yes -o ConnectTimeout=10 -i "$KEY" "$HOST" quote-templates-sync "$MODE" < "$FILE"
