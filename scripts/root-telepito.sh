#!/usr/bin/env bash
# The fleet's side of the root installer (docs/root-telepito.md): ask root for an R, put it up for the
# owner's approval on the dashboard (#33), and hand the approved R back to root. Root trusts none of this:
# it reads the owner's Discord answer itself. This script only gets the request into the exact shape root
# will accept, so a refusal means something, not a typo. The same shape as scripts/vegrehajto.sh.
#
#   root-telepito.sh kerj <agent> <kulcs> <commit40>
#   root-telepito.sh kerj-vissza <agent> <kulcs> <verzio>
#       1. sudo root-telepito kerj ...   -> R, its canonical line, its expiry
#       2. POST /api/approvals, category root_telepites, the canonical line as the WHOLE description,
#          an expiry inside the R's window; <agent> must be the dashboard token's owner, because #33
#          shows the token's owner as the requester and root compares the whole message
#       prints: R=<r> approval=<id> lejar=<epoch>, then the canonical line
#   root-telepito.sh vegrehajt <R> <approval_id>
#       the approval must be approved, carry the Discord message id, and describe this very R;
#       then sudo root-telepito vegrehajt <R> <message id>
#   root-telepito.sh allapot
#
# Exit: 0 done; 1 FAIL; 2 usage; 3 no decision yet; 4 rejected or timed out; 5 root refused.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
API="http://localhost:${PORT}/api"
RT=/usr/local/sbin/root-telepito
CATEGORY='root_telepites'
MARGIN_SECONDS=60

usage() {
  echo "hasznalat: root-telepito.sh kerj <agent> <kulcs> <commit40> | kerj-vissza <agent> <kulcs> <verzio> | vegrehajt <R> <approval_id> | allapot" >&2
  exit 2
}

fail() { echo "FAIL: $*"; exit 1; }

if [ -r "$BASE/scripts/lib/dashboard-token.sh" ]; then
  . "$BASE/scripts/lib/dashboard-token.sh"
  TOKEN_FILE="$(dashboard_token_file "$BASE")"
else
  echo "dashboard-token: scripts/lib/dashboard-token.sh missing, using the shared token" >&2
  TOKEN_FILE="$BASE/store/.dashboard-token"
fi

json_field() {
  python3 -c '
import json, sys
try:
    v = json.loads(sys.argv[1]).get(sys.argv[2])
except Exception:
    v = None
print("" if v is None else v)' "$1" "$2"
}

call() {
  local method="$1" url="$2" body="${3-}" resp
  local -a args=(-s --max-time 120 -X "$method" "$url" -w $'\n%{http_code}')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  [ -r "$TOKEN_FILE" ] || fail "no dashboard token file at $TOKEN_FILE"
  resp="$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")") 2>/dev/null || true)"
  CODE="$(printf '%s' "$resp" | tail -n1)"
  BODY="$(printf '%s' "$resp" | sed '$d')"
}

# root <verb> <args...>: sets OUT and RC; root's own refusal text goes to stderr unchanged
root_call() {
  OUT="$(sudo -n "$RT" "$@")"; RC=$?
}

request() {
  local verb="$1" agent="$2" key="$3" ref="$4"
  [[ "$agent" =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]] || fail "agent alakja hibas: ${agent}"
  root_call "$verb" "$key" "$ref" "$agent"
  case "$RC" in 0) ;; 2) usage ;; *) echo "ROOT ELUTASITOTTA (kod ${RC})"; exit 5 ;; esac
  R="$(json_field "$OUT" r)"; LINE="$(json_field "$OUT" canonicalLine)"; EXPIRES="$(json_field "$OUT" expiresAt)"
  [ -n "$R" ] && [ -n "$LINE" ] && [[ "$EXPIRES" =~ ^[0-9]+$ ]] || fail "a root valasza hianyos: $(printf '%s' "$OUT" | head -c 200)"
  TIMEOUT=$(( EXPIRES - $(date +%s) - MARGIN_SECONDS ))
  [ "$TIMEOUT" -gt 0 ] || fail "az R ablaka mar nem eleg egy jovahagyasra; R=${R} lejar magatol"
  APR="$(AGENT="$agent" LINE="$LINE" TIMEOUT="$TIMEOUT" CATEGORY="$CATEGORY" python3 -c '
import json, os
print(json.dumps({"agent_id": os.environ["AGENT"], "category": os.environ["CATEGORY"],
                  "action_description": os.environ["LINE"], "timeout_seconds": int(os.environ["TIMEOUT"])}))')"
  call POST "${API}/approvals" "$APR"
  [ "$CODE" = 201 ] || fail "jovahagyas kerese: http=${CODE} $(printf '%s' "$BODY" | head -c 200); R=${R} felhasznalatlan, lejar magatol"
  APR_ID="$(json_field "$BODY" id)"
  ROW_AGENT="$(json_field "$BODY" agent_id)"; ROW_DESC="$(json_field "$BODY" action_description)"
  ROW_TIMEOUT="$(json_field "$BODY" timeout_at)"
  [ "$ROW_AGENT" = "$agent" ] || fail "a dashboard ${ROW_AGENT}-kent rogzitette a kerest, az R ${agent}-nak szol: a root elutasitana. approval=${APR_ID} R=${R}"
  [ "$ROW_DESC" = "$LINE" ] || fail "a jovahagyas leirasa nem betura a kanonikus sor: approval=${APR_ID} R=${R}"
  [[ "$ROW_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$ROW_TIMEOUT" -le "$EXPIRES" ] || fail "a jovahagyas lejarata kesobbi, mint az R-e: approval=${APR_ID} R=${R}"
  echo "R=${R} approval=${APR_ID} lejar=${EXPIRES}"
  echo "$LINE"
  echo "a dontes utan: bash ${BASE}/scripts/root-telepito.sh vegrehajt ${R} ${APR_ID}"
}

CMD="${1-}"; [ $# -gt 0 ] && shift
case "$CMD" in
  kerj)
    [ $# -eq 3 ] || usage
    [[ "$3" =~ ^[0-9a-f]{40}$ ]] || fail "a commit 40 jegyu kisbetus sha legyen (git rev-parse), kapott: ${3}"
    request kerj "$1" "$2" "$3"
    ;;
  kerj-vissza)
    [ $# -eq 3 ] || usage
    request kerj-vissza "$1" "$2" "$3"
    ;;
  vegrehajt)
    [ $# -eq 2 ] || usage
    R="$1"; APR_ID="$2"
    [[ "$R" =~ ^[0-9a-f]{8}$ ]] || fail "R alakja hibas: ${R}"
    [[ "$APR_ID" =~ ^[A-Za-z0-9-]{1,64}$ ]] || fail "approval id alakja hibas: ${APR_ID}"
    call GET "${API}/approvals/${APR_ID}"
    [ "$CODE" = 200 ] || fail "jovahagyas lekerdezese: http=${CODE}"
    STATUS="$(json_field "$BODY" status)"
    case "$STATUS" in
      approved) ;;
      pending) echo "meg nincs dontes: approval=${APR_ID}"; exit 3 ;;
      rejected|timeout) echo "NEM: approval=${APR_ID} status=${STATUS}"; exit 4 ;;
      *) fail "ismeretlen jovahagyasi allapot: ${STATUS}" ;;
    esac
    MSG_ID="$(json_field "$BODY" discord_message_id)"; ROW_CAT="$(json_field "$BODY" category)"
    ROW_DESC="$(json_field "$BODY" action_description)"
    [ -n "$MSG_ID" ] || fail "a jovahagyasnak nincs Discord-uzenete: a root csak a Discord-valaszt fogadja el"
    [ "$ROW_CAT" = "$CATEGORY" ] || fail "a jovahagyas kategoriaja ${ROW_CAT}, nem ${CATEGORY}"
    [[ "$ROW_DESC" == "ROOT-TELEPITO R=${R} / "* ]] || fail "a jovahagyas (${APR_ID}) nem ezt az R-t irja le (${R})"
    root_call vegrehajt "$R" "$MSG_ID"
    case "$RC" in
      0) echo "$OUT" ;;
      11) echo "meg nincs dontes (root szerint): R=${R}"; exit 3 ;;
      12) echo "NEM (root szerint): R=${R}"; exit 4 ;;
      *) echo "ROOT ELUTASITOTTA VAGY HIBA (kod ${RC}): R=${R}"; exit 5 ;;
    esac
    ;;
  allapot)
    [ $# -eq 0 ] || usage
    root_call allapot
    [ "$RC" = 0 ] || { echo "ROOT ELUTASITOTTA (kod ${RC})"; exit 5; }
    echo "$OUT"
    ;;
  *) usage ;;
esac
