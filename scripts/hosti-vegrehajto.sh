#!/usr/bin/env bash
# The fleet's side of the host executor (docs/hosti-vegrehajto.md): ask for an R through the B8 gate, put it up for the
# owner's approval on the dashboard (#33), and hand the approved R back. The executor trusts none of this: it reads the owner's
# Discord answer itself. This script only gets the request into the exact shape the executor will accept, so a refusal means
# something, not a typo. The same shape as scripts/root-telepito.sh and scripts/vegrehajto.sh.
#
#   hosti-vegrehajto.sh kerj <agent> <projekt> <telepit|up|visszaallit> <commit40|->
#       1. ssh fleet@host hosti-kerj ...   -> R, its canonical line, its expiry (the gate checks the shape, the executor the rest)
#       2. POST /api/approvals, category hosti_vegrehajt, the canonical line as the WHOLE description, an expiry inside the R's
#          window; <agent> must be the dashboard token's owner (#33 shows it as the requester and the executor compares the
#          whole message)
#       prints: R=<r> approval=<id> lejar=<epoch>, then the canonical line
#   hosti-vegrehajto.sh vegrehajt <R> <approval_id>
#       the approval must be approved, carry the Discord message id, and describe this very R; then hosti-vegrehajt. The
#       executor answers `elfogadva` AT ONCE and works on without this call: the result is `allapot <R>`.
#   hosti-vegrehajto.sh allapot [<R>]
#
# Exit: 0 done; 1 FAIL; 2 usage; 3 no decision yet; 4 rejected or timed out; 5 the executor refused (foglalt included) or is
# not reachable.
# Env: ELES_HOST (default fleet@162.55.216.28) and ELES_KEY (the monitor key), as the other scripts that go through the gate;
# MARVEEN_WEB_PORT (3420).
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
API="http://localhost:${PORT}/api"
HOST="${ELES_HOST:-fleet@162.55.216.28}"
KEY="${ELES_KEY:-/home/marveen/.ssh/id_ed25519_acropora_monitor}"
CATEGORY='hosti_vegrehajt'
MARGIN_SECONDS=60

usage() {
  echo "hasznalat: hosti-vegrehajto.sh kerj <agent> <projekt> <telepit|up|visszaallit> <commit40|-> | vegrehajt <R> <approval_id> | allapot [R]" >&2
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

# gate <word...>: the B8 gate's op on the production host; sets OUT (the executor's JSON) and RC (the client's exit code)
gate() {
  OUT="$(timeout 300 ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -- "$HOST" "$@" 2>/dev/null)"; RC=$?
}

# the executor's own refusal text, as its word: nothing was changed
refused() {
  local what="$1" why
  why="$(json_field "$OUT" hiba)"
  case "$RC" in
    10) echo "MEGTAGADVA (${what}): ${why:-a vegrehajto elutasitotta}"; [ "$(json_field "$OUT" foglalt)" = True ] && echo "(foglalt: az R nyitva maradt, kesobb ujra lehet probalni)"; exit 5 ;;
    14|255) echo "NEM ERHETO EL (${what}): a hosti vegrehajto vagy a kapu nem valaszol"; exit 5 ;;
    *) echo "HIBA (${what}, kod ${RC}): ${why:-$(printf '%s' "$OUT" | head -c 200)}"; exit 5 ;;
  esac
}

CMD="${1-}"; [ $# -gt 0 ] && shift
case "$CMD" in
  kerj)
    [ $# -eq 4 ] || usage
    AGENT="$1"; PROJEKT="$2"; IGE="$3"; COMMIT="$4"
    [[ "$AGENT" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || fail "agent alakja hibas: ${AGENT}"
    [[ "$PROJEKT" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || fail "a projekt neve [a-z][a-z0-9-]: ${PROJEKT}"
    case "$IGE" in telepit|up|visszaallit) ;; *) fail "az ige telepit, up vagy visszaallit: ${IGE}" ;; esac
    if [ "$IGE" = telepit ]; then
      [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "a commit 40 jegyu kisbetus sha legyen (git rev-parse), kapott: ${COMMIT}"
    else
      [ "$COMMIT" = - ] || fail "ennek az igenek nincs commitja: -"
    fi
    gate hosti-kerj "$PROJEKT" "$IGE" "$COMMIT" "$AGENT"
    [ "$RC" = 0 ] || refused "R kerese"
    R="$(json_field "$OUT" r)"; LINE="$(json_field "$OUT" canonicalLine)"; EXPIRES="$(json_field "$OUT" expiresAt)"
    [[ "$R" =~ ^[0-9a-f]{8}$ ]] && [ -n "$LINE" ] && [[ "$EXPIRES" =~ ^[0-9]+$ ]] || fail "a vegrehajto valasza hianyos: $(printf '%s' "$OUT" | head -c 200)"
    TIMEOUT=$(( EXPIRES - $(date +%s) - MARGIN_SECONDS ))
    [ "$TIMEOUT" -gt 0 ] || fail "az R ablaka (${EXPIRES}) mar nem eleg egy jovahagyasra; R=${R} lejar magatol"
    APR="$(AGENT="$AGENT" LINE="$LINE" TIMEOUT="$TIMEOUT" CATEGORY="$CATEGORY" python3 -c '
import json, os
print(json.dumps({"agent_id": os.environ["AGENT"], "category": os.environ["CATEGORY"],
                  "action_description": os.environ["LINE"], "timeout_seconds": int(os.environ["TIMEOUT"])}))')"
    call POST "${API}/approvals" "$APR"
    [ "$CODE" = 201 ] || fail "jovahagyas kerese: http=${CODE} $(printf '%s' "$BODY" | head -c 200); R=${R} felhasznalatlan, lejar magatol"
    APR_ID="$(json_field "$BODY" id)"
    ROW_AGENT="$(json_field "$BODY" agent_id)"; ROW_DESC="$(json_field "$BODY" action_description)"
    ROW_TIMEOUT="$(json_field "$BODY" timeout_at)"
    [ "$ROW_AGENT" = "$AGENT" ] || fail "a dashboard ${ROW_AGENT}-kent rogzitette a kerest, az R ${AGENT}-nak szol: a vegrehajto elutasitana. approval=${APR_ID} R=${R}"
    [ "$ROW_DESC" = "$LINE" ] || fail "a jovahagyas leirasa nem betura a kanonikus sor: approval=${APR_ID} R=${R}"
    [[ "$ROW_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$ROW_TIMEOUT" -le "$EXPIRES" ] || fail "a jovahagyas lejarata (${ROW_TIMEOUT}) kesobbi, mint az R-e (${EXPIRES}): approval=${APR_ID} R=${R}"
    echo "R=${R} approval=${APR_ID} lejar=${EXPIRES}"
    echo "$LINE"
    echo "a dontes utan: bash scripts/hosti-vegrehajto.sh vegrehajt ${R} ${APR_ID}"
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
    [ -n "$MSG_ID" ] || fail "a jovahagyasnak nincs Discord-uzenete: a vegrehajto csak a Discord-valaszt fogadja el"
    [ "$ROW_CAT" = "$CATEGORY" ] || fail "a jovahagyas kategoriaja ${ROW_CAT}, nem ${CATEGORY}"
    [[ "$ROW_DESC" == "HOSTI R=${R} / "* ]] || fail "a jovahagyas (${APR_ID}) nem ezt az R-t irja le (${R})"
    gate hosti-vegrehajt "$R" "$MSG_ID"
    case "$RC" in
      0) echo "R=${R} allapot=$(json_field "$OUT" allapot)"
         echo "a munka a kapcsolattol fuggetlenul fut; az eredmeny: bash scripts/hosti-vegrehajto.sh allapot ${R}" ;;
      11) echo "meg nincs dontes (a vegrehajto szerint): R=${R}"; exit 3 ;;
      12) echo "NEM (a vegrehajto szerint): R=${R}"; exit 4 ;;
      *) refused "vegrehajtas" ;;
    esac
    ;;
  allapot)
    [ $# -le 1 ] || usage
    if [ $# -eq 1 ]; then
      [[ "$1" =~ ^[0-9a-f]{8}$ ]] || fail "R alakja hibas: ${1}"
      gate hosti-allapot "$1"
    else
      gate hosti-allapot
    fi
    [ "$RC" = 0 ] || refused "allapot"
    echo "$OUT"
    ;;
  *) usage ;;
esac
