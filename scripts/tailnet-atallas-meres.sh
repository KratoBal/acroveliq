#!/usr/bin/env bash
# ANSWERS: Mukodik-e a tailnet atallas kozben minden, aminek mukodnie kell (eles AI, NAS sftp es rsync, NAS utvonalak, kulcslejarat)? Csak olvas.
# Usage: bash scripts/tailnet-atallas-meres.sh
set -u
K=/home/marveen/.ssh/id_ed25519_acropora_monitor
echo "--- $(bash /home/marveen/marveen/scripts/local-now.sh full)"
ssh -i $K -o ConnectTimeout=10 fleet@162.55.216.28 '
  printf "eles AI 3110 (eles geprol): "; curl -s -o /dev/null -m 10 -w "%{http_code}\n" http://100.88.199.87:3110/health
  printf "NAS rsync 873 (modul-lista): "; timeout 15 rsync --list-only rsync://csupor/ >/dev/null 2>&1 && echo OK || echo HIBA
  tailscale status --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in list(d[\"Peer\"].values())+[d[\"Self\"]]:
  print(\"  \",p[\"HostName\"],\"tags=\"+\",\".join(p.get(\"Tags\") or []),\"| routes=\",p.get(\"PrimaryRoutes\"),\"| exitOpt=\",p.get(\"ExitNodeOption\"),\"| KeyExpiry=\",p.get(\"KeyExpiry\",\"kikapcsolva\"))"
  tailscale debug prefs 2>/dev/null | grep -E "\"ExitNodeID\""'
printf "NAS sftp 22 (ls, a flotta kontenerebol): "; echo ls | timeout 20 sftp -o BatchMode=yes -o ConnectTimeout=10 -i /home/marveen/.ssh/id_ed25519_csupor_backup -b - AcroBot@100.98.191.44 >/dev/null 2>&1 && echo OK || echo HIBA
printf "eles app: "; curl -s -o /dev/null -m 10 -w "%{http_code}\n" https://app.acropora.hu
printf "eles api: "; curl -s -o /dev/null -m 10 -w "%{http_code}\n" https://api.acropora.hu/health
