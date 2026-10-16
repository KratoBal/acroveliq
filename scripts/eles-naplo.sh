#!/usr/bin/env bash
# ANSWERS: Meddig lat vissza az eles kontenerek naploja, es mi all a legelejen (nem a vegen).
# eles-naplo.sh -- the production log WINDOW, read-only.
#
# WHY THIS EXISTS, measured 2026-09-15 22:25: the open question was whether the live
# API log survives a redeploy. Nobody had to touch the production machine: Coolify's
# read-only log endpoint hands out the container log, and the FIRST line answers it.
# All three apps begin with their own entrypoint/boot banner -- so the window starts
# at container creation, and everything before it is already gone.
#
# The habit this encodes: a log's END looks like state. Its BEGINNING tells you what
# you cannot see. Same family as reading a clone's working tree instead of the ref.
#
#   bash /home/marveen/marveen/scripts/eles-naplo.sh            # mind a harom eles app
#   bash /home/marveen/marveen/scripts/eles-naplo.sh teljes     # a nyers naplo is
#
# Read-only: csak GET hivasok. Nem telepit, nem indit ujra semmit.
set -uo pipefail

TOKEN_FILE=/home/marveen/marveen/store/.coolify-token-prod
# B20 (2026-10-16): the public name coolify.acropora.hu is being closed (tailnet only).
# The fleet runs on the same host, so it reaches Coolify on the coolify network gateway.
COOLIFY_PROD_URL="${COOLIFY_PROD_URL:-http://10.0.1.1:8000}"
[ -r "$TOKEN_FILE" ] || { echo "FAIL: nem olvashato: $TOKEN_FILE" >&2; exit 1; }
MODE="${1:-}"

curl -s -m 20 -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")") \
  "${COOLIFY_PROD_URL}/api/v1/applications" \
  | python3 -c 'import json,sys
for a in json.load(sys.stdin):
    print(a.get("uuid",""), a.get("name","?"), sep="\t")' \
  | while IFS=$'\t' read -r uuid name; do
      echo
      echo "===== $name ====="
      curl -s -m 40 -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")") \
        "${COOLIFY_PROD_URL}/api/v1/applications/${uuid}/logs?lines=100000" \
        | AC_NAME="$name" AC_MODE="$MODE" python3 -c '
import json, os, sys
try:
    txt = json.load(sys.stdin).get("logs", "")
except Exception:
    print("  a valasz nem JSON -- elerheto a Coolify?"); sys.exit(0)
lines = [l for l in txt.split("\n") if l.strip()]
if not lines:
    print("  (ures naplo)"); sys.exit(0)
print("  sorok:            %d   (100000-et kertem, tehat ez NEM levagas)" % len(lines))
print("  A NAPLO ELEJE:    %s" % lines[0][:150])
print("  a naplo vege:     %s" % lines[-1][:150])
print("  Ha az elso sor a kontener sajat indulasa (entrypoint, framework banner),")
print("  akkor az ablak a kontener letrejottekor kezdodik: ami elotte volt, nincs meg.")
if os.environ.get("AC_MODE") == "teljes":
    print("  --- nyers ---"); print(txt)
'
    done
