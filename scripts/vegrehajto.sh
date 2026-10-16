#!/usr/bin/env bash
# The fleet's side of the deploy executor (SB1, P0-3): ask for an R, put it up
# for the owner's approval on the dashboard (#33), and hand the approved R back
# to the executor. The executor trusts none of this: it reads the owner's
# Discord answer itself. This script only gets the request into the exact shape
# the executor will accept, so a refusal means something, not a typo.
#
#   vegrehajto.sh kerj <agent> <env> <app> <sha40>
#       1. POST $VEGREHAJTO_URL/requests -> R and its canonical line
#       2. POST /api/approvals, category coolify_deploy, the canonical line as the
#          WHOLE description, an expiry inside the R's window (the dashboard's
#          default is 1440 minutes, and an approval that shows a later expiry
#          than the R's own is refused by the executor)
#       prints: R=<r> approval=<id> lejar=<epoch>, then the canonical line
#   vegrehajto.sh vegrehajt <R> <approval_id>
#       the approval must be approved, carry the Discord message id, and describe
#       this very R; then POST $VEGREHAJTO_URL/executions
#   vegrehajto.sh allapot <R>
#       the R as the executor sees it (status, outcome, deployment uuid)
#
# Exit: 0 done; 1 FAIL; 2 usage; 3 no decision yet; 4 rejected or timed out;
#       5 the executor refused (403) or is rate limited (429).
# Env: VEGREHAJTO_URL (default http://vegrehajto:8787), MARVEEN_WEB_PORT (3420).
# Install and the executor's own rules: deploy-executor/README.md.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
API="http://localhost:${PORT}/api"
EXEC_URL="${VEGREHAJTO_URL:-http://vegrehajto:8787}"
CATEGORY='coolify_deploy'
# the displayed expiry must not be later than the R's own: the dashboard counts
# timeout_seconds from its own clock, this margin covers the gap between the calls
MARGIN_SECONDS=60

usage() {
  echo "hasznalat: vegrehajto.sh kerj <agent> <env> <app> <sha40> | vegrehajt <R> <approval_id> | allapot <R>" >&2
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

# json_field <json> <key>: one top-level field as text ("" when missing or null)
json_field() {
  python3 -c '
import json, sys
try:
    v = json.loads(sys.argv[1]).get(sys.argv[2])
except Exception:
    v = None
print("" if v is None else v)' "$1" "$2"
}

# call <method> <url> [json-body] [dashboard]: sets CODE and BODY, never exits
call() {
  local method="$1" url="$2" body="${3-}" auth="${4-}" resp
  local -a args=(-s --max-time 120 -X "$method" "$url" -w $'\n%{http_code}')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  if [ -n "$auth" ]; then
    [ -r "$TOKEN_FILE" ] || fail "no dashboard token file at $TOKEN_FILE"
    resp="$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")") 2>/dev/null || true)"
  else
    resp="$(curl "${args[@]}" 2>/dev/null || true)"
  fi
  CODE="$(printf '%s' "$resp" | tail -n1)"
  BODY="$(printf '%s' "$resp" | sed '$d')"
}

# executor answers other than 2xx: a refusal is the executor's word, say it as such
executor_fail() {
  local what="$1" reason
  reason="$(json_field "$BODY" error 2>/dev/null)"
  case "$CODE" in
    403) echo "MEGTAGADVA (${what}): ${reason}"; exit 5 ;;
    429) echo "TULTERHELT (${what}): ${reason}"; exit 5 ;;
    000|'') fail "${what}: a vegrehajto nem erheto el (${EXEC_URL})" ;;
    *) fail "${what}: http=${CODE} ${reason:-$(printf '%s' "$BODY" | head -c 200)}" ;;
  esac
}

CMD="${1-}"; [ $# -gt 0 ] && shift
case "$CMD" in
  kerj)
    [ $# -eq 4 ] || usage
    AGENT="$1"; ENV_NAME="$2"; APP="$3"; SHA="$4"
    # the executor accepts only the full lowercase sha; a short one is refused there
    # anyway, here it is refused before an R is spent on it
    [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "a sha 40 jegyu kisbetus commit legyen (git rev-parse), kapott: ${SHA}"
    REQ="$(AGENT="$AGENT" ENV_NAME="$ENV_NAME" APP="$APP" SHA="$SHA" python3 -c '
import json, os
print(json.dumps({"env": os.environ["ENV_NAME"], "app": os.environ["APP"], "action": "deploy",
                  "sha": os.environ["SHA"], "requester": os.environ["AGENT"]}))')"
    call POST "${EXEC_URL}/requests" "$REQ"
    [ "$CODE" = 201 ] || executor_fail "R kerese"
    R="$(json_field "$BODY" r)"; LINE="$(json_field "$BODY" canonicalLine)"; EXPIRES="$(json_field "$BODY" expiresAt)"
    [ -n "$R" ] && [ -n "$LINE" ] && [[ "$EXPIRES" =~ ^[0-9]+$ ]] || fail "a vegrehajto valasza hianyos: $(printf '%s' "$BODY" | head -c 200)"
    TIMEOUT=$(( EXPIRES - $(date +%s) - MARGIN_SECONDS ))
    [ "$TIMEOUT" -gt 0 ] || fail "az R ablaka (${EXPIRES}) mar nem eleg egy jovahagyasra; R=${R} lejar magatol"
    APR="$(AGENT="$AGENT" LINE="$LINE" TIMEOUT="$TIMEOUT" CATEGORY="$CATEGORY" python3 -c '
import json, os
print(json.dumps({"agent_id": os.environ["AGENT"], "category": os.environ["CATEGORY"],
                  "action_description": os.environ["LINE"], "timeout_seconds": int(os.environ["TIMEOUT"])}))')"
    call POST "${API}/approvals" "$APR" dashboard
    [ "$CODE" = 201 ] || fail "jovahagyas kerese: http=${CODE} $(printf '%s' "$BODY" | head -c 200); R=${R} felhasznalatlan, lejar magatol"
    APR_ID="$(json_field "$BODY" id)"
    # the Discord message shows the dashboard's row: its requester and its text must be
    # the R's, or the executor refuses the answer later, after the owner gave it
    ROW_AGENT="$(json_field "$BODY" agent_id)"; ROW_DESC="$(json_field "$BODY" action_description)"
    ROW_TIMEOUT="$(json_field "$BODY" timeout_at)"
    [ "$ROW_AGENT" = "$AGENT" ] || fail "a dashboard ${ROW_AGENT}-kent rogzitette a kerest, az R ${AGENT}-nak szol: a vegrehajto elutasitana. approval=${APR_ID} R=${R}"
    [ "$ROW_DESC" = "$LINE" ] || fail "a jovahagyas leirasa nem betura a kanonikus sor: approval=${APR_ID} R=${R}"
    [[ "$ROW_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$ROW_TIMEOUT" -le "$EXPIRES" ] || fail "a jovahagyas lejarata (${ROW_TIMEOUT}) kesobbi, mint az R-e (${EXPIRES}): approval=${APR_ID} R=${R}"
    echo "R=${R} approval=${APR_ID} lejar=${EXPIRES}"
    echo "$LINE"
    echo "a dontes utan: bash scripts/vegrehajto.sh vegrehajt ${R} ${APR_ID}"
    ;;
  vegrehajt)
    [ $# -eq 2 ] || usage
    R="$1"; APR_ID="$2"
    [[ "$R" =~ ^[A-Z0-9]{1,16}$ ]] || fail "R alakja hibas: ${R}"
    [[ "$APR_ID" =~ ^[A-Za-z0-9-]{1,64}$ ]] || fail "approval id alakja hibas: ${APR_ID}"
    call GET "${API}/approvals/${APR_ID}" '' dashboard
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
    # an approval decided on Telegram or the dashboard page has no Discord message:
    # the executor reads only Discord, so there is nothing it could verify
    [ -n "$MSG_ID" ] || fail "a jovahagyasnak nincs Discord-uzenete (APPROVAL_DISCORD ki, vagy nem Discordon dontottek): a vegrehajto csak a Discord-valaszt fogadja el"
    [ "$ROW_CAT" = "$CATEGORY" ] || fail "a jovahagyas kategoriaja ${ROW_CAT}, nem ${CATEGORY}"
    call GET "${EXEC_URL}/requests/${R}"
    [ "$CODE" = 200 ] || executor_fail "R lekerdezese"
    LINE="$(json_field "$BODY" canonicalLine)"
    # two Rs open at once: the approval must be the one this R was put up with
    [ "$ROW_DESC" = "$LINE" ] || fail "a jovahagyas (${APR_ID}) nem ezt az R-t irja le (${R})"
    EXE="$(R="$R" MSG_ID="$MSG_ID" python3 -c '
import json, os
print(json.dumps({"r": os.environ["R"], "requestMessageId": os.environ["MSG_ID"]}))')"
    call POST "${EXEC_URL}/executions" "$EXE"
    [ "$CODE" = 200 ] || executor_fail "vegrehajtas"
    echo "R=${R} status=$(json_field "$BODY" status) outcome=$(json_field "$BODY" outcome) deployment=$(json_field "$BODY" deploymentUuid)"
    echo "a telepites allapota: bash scripts/vegrehajto.sh allapot ${R}"
    ;;
  allapot)
    [ $# -eq 1 ] || usage
    R="$1"
    [[ "$R" =~ ^[A-Z0-9]{1,16}$ ]] || fail "R alakja hibas: ${R}"
    call GET "${EXEC_URL}/requests/${R}"
    [ "$CODE" = 200 ] || executor_fail "R lekerdezese"
    echo "R=${R} status=$(json_field "$BODY" status) outcome=$(json_field "$BODY" outcome) deployment=$(json_field "$BODY" deploymentUuid) lejar=$(json_field "$BODY" expiresAt)"
    echo "$(json_field "$BODY" canonicalLine)"
    ;;
  *) usage ;;
esac
