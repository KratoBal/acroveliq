#!/usr/bin/env bash
# ANSWERS: Hitelesitett git muvelet a GitHub fele, amikor a sima fetch "unauthenticated" limitre fut.
#
# MIERT LETEZIK, merve 2026-09-03 09:35:
#   git fetch origin -> "GitHub is temporarily limiting some UNAUTHENTICATED downloads"
#   ugyanaz a repo az API-n -> megy
#
# A KET DOLOG NEM UGYANAZ A HITELESITES. A credential helper a repokban BE VAN allitva
# (mind a nautilus, mind a murena klonjaban), es MEGSEM sul el: a git a HTTPS transzporton
# eloszor hitelesites NELKUL probal, es csak 401-re kerdezi meg a helpert. A GitHub viszont
# nem 401-et ad, hanem ezt a rate-limit hibat -- tehat a helperig el sem jut a folyamat.
#
# AMI NEM MUKODIK, es murena ki is probalta: a "Bearer <token>" alak. A git BASIC auth-ot var
# (x-access-token:<token> base64-elve), nem Bearer-t. A REST API forditva.
#
# AMIT SZANDEKOSAN NEM CSINALUNK:
#   - a tokent az origin URL-jebe irni: az a repo configjaba irna a titkot, es ott maradna
#   - a tokent parancssorba tenni: a `ps` kimeneteben latszana. Ezert megy
#     GIT_CONFIG_COUNT kornyezeti valtozon at.
#
# HASZNALAT (a repo mappajabol, vagy -C kapcsoloval):
#   bash /home/marveen/marveen/scripts/git-auth.sh fetch origin
#   bash /home/marveen/marveen/scripts/git-auth.sh -C /ut/a/repohoz pull --ff-only origin main
#   bash /home/marveen/marveen/scripts/git-auth.sh ls-remote origin HEAD
#
# A token a store/.github-token fajlbol jon, es a sec-github csoport tagjai olvashatjak.

set -uo pipefail

# FLEET_GITHUB_APP=on: the agent's git asks the credential helper (scripts/git-credential-fleet-github),
# which gets a token for exactly the repository git talks to; this script adds no header and reads no
# owner token (the owner token's retirement, PR 1, docs/fleet-github.md)
if [ "${FLEET_GITHUB_APP:-off}" = on ]; then
  [ $# -ge 1 ] || { echo "FAIL: adj meg git parancsot, pl.: git-auth.sh fetch origin" >&2; exit 1; }
  exec git "$@"
fi

TOKEN_FILE="/home/marveen/marveen/store/.github-token"
[ -r "$TOKEN_FILE" ] || { echo "FAIL: nem olvashato: $TOKEN_FILE (sec-github csoport kell hozza)" >&2; exit 1; }
[ $# -ge 1 ] || { echo "FAIL: adj meg git parancsot, pl.: git-auth.sh fetch origin" >&2; exit 1; }

# A base64 elemet a python allitja elo, hogy a token ne kerüljon se parancssorba, se ideiglenes fajlba.
BASIC="$(TOKEN_FILE="$TOKEN_FILE" python3 -c '
import base64, os
tok = open(os.environ["TOKEN_FILE"]).read().strip()
print(base64.b64encode(("x-access-token:" + tok).encode()).decode())
')" || { echo "FAIL: a base64 eloallitasa nem sikerult" >&2; exit 1; }

GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=http.extraHeader \
GIT_CONFIG_VALUE_0="Authorization: Basic ${BASIC}" \
  git "$@"
RC=$?

# A valtozo a folyamattal egyutt megszunik; itt csak a helyi masolatot toroljuk.
BASIC=""
exit $RC
