#!/usr/bin/env bash
# ANSWERS: Romlott-e a teszt AI valasza a rogzitett kerdeskeszleten, amikor a kodja vagy az utasitasa valtozott, vagy
#          egy hete nem merte senki? Ember nelkul, es csak romlasnal szol.
#
# ai-kerdeskeszlet-or.sh          a cron hivja (scripts/crontab/marveen.cron), 15 percenkent
#
# WHY (task t-20261116-kerdeskeszlet-or, acrobot 53794/53796; the standing rule of 2026-10-13: a recurring check is
# automated): the pinned question set (acropora-ai-agent question-set.ts) is the measure of the AI's language rules,
# and on 2026-11-16 four runs were needed in one morning, each started by hand.
#
# WHEN IT RUNS THE SET: the test AI's /health (no auth) names its code (`version`) and its instruction text
# (`instructionsVersion`). The set runs when that pair differs from the newest report's, or when the newest report is
# older than KERDES_MAX_AGE_DAYS (default 7: the model drifts without any change on our side). Otherwise the script
# exits 0 and writes nothing: a quiet tick costs no model call. A run is 16 calls on the test AI's OpenAI key.
#
# HOW: the runner lives in the AI repo, so a dedicated clone (KERDES_KLON, created once by acrobot with git-auth.sh)
# is fetched and set to origin/main (detached; the clone must be clean, it is nobody's workspace), and built when its
# head moved, under the fleet's heavy-command lock. The token is read from KERDES_TOKEN_FILE into the runner's
# environment, never onto a command line, and never printed. The report goes to KERDES_REPORT_DIR as
# qs-<UTC time>-<server sha>.json, compared with the newest earlier report (`--compare`).
#
# WHO HEARS ABOUT IT: acrobot, one inter-agent line, ONLY when the runner exits non-zero: 3 a regression (a pass turned
# fail or replaced, more fails, replaced answers or avoided glossary forms, an error), 1 a failed call, 2 a setup
# problem; and when the clone, the build or the token is missing. A clean run or an improvement is only a log line.
# Never Balázs's channel: this is a measurement, not a decision.
#
# Exit: 0 nothing to do or a clean run; 1 the health read failed; otherwise the runner's code, or 2 for a setup failure.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AI_URL="${KERDES_AI_URL:-http://100.88.199.87:3110}"
TOKEN_FILE="${KERDES_TOKEN_FILE:-$ROOT/store/.acropora-ai-token-stage}"
REPORT_DIR="${KERDES_REPORT_DIR:-$ROOT/exchange/acroveliq/ai-kerdeskeszlet}"
KLON="${KERDES_KLON:-/home/marveen/work/acropora-ai-agent-or}"
GIT_AUTH="${KERDES_GIT_AUTH:-$ROOT/scripts/git-auth.sh}"
MSG="${KERDES_MSG:-$ROOT/scripts/agent-msg.sh}"
LOCK="${KERDES_LOCK:-/tmp/flotta-nehez.lock}"
MAX_AGE_DAYS="${KERDES_MAX_AGE_DAYS:-7}"
# the two steps a test replaces: building the runner, and running it (KERDES_RUNNER gets the runner's arguments)
BUILD="${KERDES_BUILD:-}"
RUNNER="${KERDES_RUNNER:-}"

log() { echo "$(date -Is) $*"; }

szol() {
  local body
  body="$(mktemp)"
  printf '%s\n' "$1" > "$body"
  bash "$MSG" acrobot acrobot - < "$body" >/dev/null 2>&1 || log "az uzenet nem ment el"
  rm -f "$body"
}

health="$(curl -fsS --max-time 15 "$AI_URL/health" 2>/dev/null)" || { log "a /health nem olvashato ($AI_URL)"; exit 1; }

mkdir -p "$REPORT_DIR"
elozo="$(ls -1t "$REPORT_DIR"/qs-*.json 2>/dev/null | head -n 1)"

# decide in one python call: prints "run <reason>" or "skip", then the server sha for the file name
dontes="$(python3 - "$health" "$elozo" "$MAX_AGE_DAYS" <<'DONTES'
import json, sys, datetime
health, previous, max_age = sys.argv[1], sys.argv[2], float(sys.argv[3])
try:
    h = json.loads(health)
except ValueError:
    print("health-not-json"); sys.exit(0)
server = h.get("version") if isinstance(h.get("version"), str) else "unknown"
instr = h.get("instructionsVersion") if isinstance(h.get("instructionsVersion"), str) else None
if not previous:
    print(f"run first {server}"); sys.exit(0)
try:
    p = json.load(open(previous, encoding="utf-8"))
except (OSError, ValueError):
    print(f"run unreadable-previous {server}"); sys.exit(0)
if p.get("serverVersion") != server or p.get("instructionsVersion") != instr:
    print(f"run changed {server}"); sys.exit(0)
try:
    started = datetime.datetime.fromisoformat(str(p.get("startedAt")).replace("Z", "+00:00"))
except ValueError:
    print(f"run no-start-time {server}"); sys.exit(0)
age = datetime.datetime.now(datetime.timezone.utc) - started
print(f"run weekly {server}" if age.total_seconds() >= max_age * 86400 else "skip")
DONTES
)"
case "$dontes" in
  skip) exit 0 ;;
  health-not-json) log "a /health valasza nem JSON ($AI_URL)"; exit 1 ;;
  run\ *) ;;
  *) log "ismeretlen dontes: $dontes"; exit 2 ;;
esac
ok="$(printf '%s' "$dontes" | cut -d' ' -f2)"
server="$(printf '%s' "$dontes" | cut -d' ' -f3)"

if [ ! -r "$TOKEN_FILE" ]; then
  log "a teszt AI tokenje nem olvashato: $TOKEN_FILE"
  szol "[AI kerdeskeszlet-or] beallitasi hiba: a teszt AI tokenje nem olvashato ($TOKEN_FILE). Futas nem volt."
  exit 2
fi

# the runner from the AI repo's main, built under the heavy-command lock
if [ -z "$RUNNER" ]; then
  if [ ! -d "$KLON/.git" ]; then
    log "nincs AI-klon: $KLON"
    szol "[AI kerdeskeszlet-or] beallitasi hiba: nincs AI-klon itt: $KLON (egyszeri: bash scripts/git-auth.sh clone https://github.com/KratoBal/acropora-ai-agent.git $KLON). Futas nem volt."
    exit 2
  fi
  epites="$(
    exec 9>"$LOCK"
    flock 9
    bash "$GIT_AUTH" -C "$KLON" fetch --quiet --no-tags --no-auto-maintenance origin '+refs/heads/main:refs/remotes/origin/main' 2>&1 || { echo "FAIL fetch"; exit 1; }
    if [ -n "$(git -C "$KLON" status --porcelain)" ]; then echo "FAIL a klon nem tiszta"; exit 1; fi
    cel="$(git -C "$KLON" rev-parse refs/remotes/origin/main)"
    if [ "$(git -C "$KLON" rev-parse HEAD)" != "$cel" ] || [ ! -f "$KLON/dist/question-set-run.js" ]; then
      git -C "$KLON" checkout --quiet --detach "$cel" 2>&1 || { echo "FAIL checkout"; exit 1; }
      if [ -n "$BUILD" ]; then
        bash -c "$BUILD" 2>&1 || { echo "FAIL build"; exit 1; }
      else
        ( cd "$KLON" && npm ci --silent --no-audit --no-fund && NODE_OPTIONS=--max-old-space-size=1536 npm run -s build ) 2>&1 | tail -n 5
        [ "${PIPESTATUS[0]}" -eq 0 ] || { echo "FAIL build"; exit 1; }
      fi
    fi
  )" || {
    log "az AI-futtato nem epult: $(printf '%s' "$epites" | tail -n 3 | tr '\n' ' ')"
    szol "[AI kerdeskeszlet-or] beallitasi hiba: az AI-futtato nem epult ($KLON): $(printf '%s' "$epites" | tail -n 1). Futas nem volt."
    exit 2
  }
  RUNNER="node $KLON/scripts/question-set-run.mjs"
fi

kimenet="$REPORT_DIR/qs-$(date -u +%Y-%m-%dT%H%MZ)-${server:0:8}.json"
osszevet=()
[ -n "$elozo" ] && osszevet=(--compare "$elozo")
sorok="$(AI_API_TOKEN="$(cat "$TOKEN_FILE")" $RUNNER --url "$AI_URL" --out "$kimenet" "${osszevet[@]}" 2>&1)"
rc=$?
utolso="$(printf '%s\n' "$sorok" | tail -n 2 | tr '\n' ' ')"
log "futas ($ok, szerver ${server:0:8}): kod $rc. $utolso"
case "$rc" in
  0) ;;
  3) szol "[AI kerdeskeszlet-or] ROMLAS ($ok, szerver ${server:0:8}): $utolso Jelentes: $kimenet" ;;
  1) szol "[AI kerdeskeszlet-or] hivasi hiba a futasban ($ok, szerver ${server:0:8}): $utolso Jelentes: $kimenet" ;;
  *) szol "[AI kerdeskeszlet-or] a futtato $rc koddal allt meg ($ok): $utolso" ;;
esac
exit "$rc"
