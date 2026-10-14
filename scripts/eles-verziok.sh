#!/usr/bin/env bash
# ANSWERS: MELYIK VERZIO fut TENYLEG az eles gep egyes alkalmazasain (kontenerenkent, a kep cimkejebol).
#
# MIERT LETEZIK, merve 2026-09-22 13:10. A telepitesek ellenorzesehez a
# szolgaltatasok sajat /health valaszat hasznaltam, es azt hittem, harom
# fuggetlen merest vegzek:
#
#   https://api.acropora.hu/health          205d4e69f730 | uptime 1391
#   https://app.acropora.hu/api/health      205d4e69f730 | uptime 1391
#   https://ticket.acropora.hu/api/health   205d4e69f730 | uptime 1391
#
# UGYANABBAN A MASODPERCBEN a gepen HAROM kulonbozo kontener futott, KET
# verzioval (api 205d4e69, web es partner 8100c901). A ket masik cim ugyanis az
# API-t kerdezi, nem magat -- tehat egy szolgaltatast mertem haromszor.
#
# AZ UPTIME EGYEZESE A DONTO JEL, nem a commite: ket kulonbozo processz nem
# indulhatott ugyanabban a masodpercben. Ha valaha harom forras masodpercre
# ugyanazt mondja, az nem megerosites, hanem gyanu.
#
# A HELYES FORRAS a Coolify sajat kep-cimkeje: `<alkalmazas-uuid>:<commit-sha>`.
# Az kontenerenkent kulon all, es a `Status` mondja meg, mennyi ideje fut.
#
# CSAK OLVAS. Nem indit telepitest es nem all le semmit.
set -uo pipefail

HOST="${ELES_HOST:-fleet@162.55.216.28}"

# THE HOST KEYS ARE PINNED (Security Baseline, task ssh-hostkulcs-rogzites, nautilus's finding):
# the production and the stage machines' public keys live in the repo (scripts/host/known_hosts),
# and ssh checks against that file ONLY. An unknown or changed key fails the call, and nothing is
# read or written from a machine that may not be ours (StrictHostKeyChecking=no would have taken
# any key, and a fake machine could have handed back a fake version or a fake deployed event).
KNOWN_HOSTS="${FLEET_KNOWN_HOSTS:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/host/known_hosts}"
SSH_PIN=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519)
KEY="${ELES_KEY:-/home/marveen/.ssh/id_ed25519_acropora_monitor}"

# nev|alkalmazas-uuid  -- ha uj alkalmazas keletkezik, ide kell felvenni, es a
# hianya UGYANUGY csendes, mint barmelyik kezzel kartbantartott liste. Az
# ellenorzese: scripts/infra-allapot.sh listaja a Coolify sajat valaszabol jon.
ALKALMAZASOK=(
  "api|t9gxx94ecwekwruxngps5i6v"
  "web|dnt6jzza68wnuamvi93whn28"
  "partner|iknrqjk9xeyydc5fibrk5tbp"
  "commerce|obpxbcqgjturybmemmdi7wid"
)

MOST="$(TZ=Europe/Budapest date '+%Y-%m-%d %H:%M:%S %Z')"
echo "--- eles-verziok (lekerdezve $MOST, gep: $HOST) ---"
echo "    a forras a kontener KEP-CIMKEJE, nem a /health valasz"
echo

SZURO=""
for sor in "${ALKALMAZASOK[@]}"; do
  SZURO="$SZURO ${sor##*|}"
done

KIMENET="$(timeout 45 ssh -o BatchMode=yes -o ConnectTimeout=10 "${SSH_PIN[@]}" \
  -i "$KEY" "$HOST" \
  ps 2>&1)" || {  # fleet-gate: docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}"
    echo "FAIL: a gep nem erheto el ($HOST)"
    echo "$KIMENET" | head -3
    exit 1
  }

for sor in "${ALKALMAZASOK[@]}"; do
  nev="${sor%%|*}"
  uuid="${sor##*|}"
  talalat="$(printf '%s\n' "$KIMENET" | grep -F "$uuid" | head -1)"
  if [ -z "$talalat" ]; then
    printf '  %-10s NEM FUT (nincs kontener ezzel az azonositoval)\n' "$nev"
    continue
  fi
  kep="$(printf '%s' "$talalat" | cut -d'|' -f2)"
  allapot="$(printf '%s' "$talalat" | cut -d'|' -f3)"
  sha="${kep##*:}"
  printf '  %-10s %-14s %s\n' "$nev" "${sha:0:12}" "$allapot"
done

echo
echo "  A fo ag feje osszevetesre:"
git -C /home/marveen/work/acropora-os fetch -q origin main 2>/dev/null || true
echo "    origin/main  $(git -C /home/marveen/work/acropora-os rev-parse --short=12 origin/main 2>/dev/null || echo '(nem merheto)')"
