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
# problem (the provider timeouts of a slower run in which nothing moved, the weekly run, are none of these: the runner
# names them as a provider slowdown and exits 0, acropora-ai-agent #138); and when the clone, the build or the token is missing; and ONCE when the test AI's /health has been unreadable
# for KERDES_HEALTH_ALERT_HOURS (24). A clean run or an improvement is only a log line. A run with a NETWORK error (the test AI
# not there, e.g. redeployed mid-run) is rerun once after /health answers again, and only a second one is said, as a failed
# measurement (see "A SERVICE THAT WAS NOT THERE" below).
# Never Balázs's channel: this is a measurement, not a decision.
#
# Exit: 0 nothing to do, a clean run, or an earlier round still running (KERDES_RUN_LOCK, not waited on); 1 the health read failed; otherwise the runner's code, or 2 for a setup failure.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AI_URL="${KERDES_AI_URL:-http://100.88.199.87:3110}"
TOKEN_FILE="${KERDES_TOKEN_FILE:-$ROOT/store/.acropora-ai-token-stage}"
REPORT_DIR="${KERDES_REPORT_DIR:-$ROOT/exchange/acroveliq/ai-kerdeskeszlet}"
KLON="${KERDES_KLON:-/home/marveen/work/acropora-ai-agent-or}"
GIT_AUTH="${KERDES_GIT_AUTH:-$ROOT/scripts/git-auth.sh}"
MSG="${KERDES_MSG:-$ROOT/scripts/agent-msg.sh}"
LOCK="${KERDES_LOCK:-/tmp/flotta-nehez.lock}"
RUN_LOCK="${KERDES_RUN_LOCK:-/tmp/ai-kerdeskeszlet-or.lock}"
HEALTH_ALERT_HOURS="${KERDES_HEALTH_ALERT_HOURS:-24}"
MAX_AGE_DAYS="${KERDES_MAX_AGE_DAYS:-7}"
# a run with a network error (the test AI not there, e.g. redeployed mid-run) waits this long for /health, polling this often, then reruns once
RETRY_WAIT_S="${KERDES_RETRY_WAIT_S:-900}"
RETRY_POLL_S="${KERDES_RETRY_POLL_S:-30}"
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

# ONE RUN AT A TIME (barracuda #375): a "changed" round (fetch, npm ci, a build waiting on the heavy lock, then 16 calls
# of up to 43 s each) can outlast the 15-minute tick, and the next tick would read the same "changed" from /health,
# because the new report is written only at the end: 16 calls paid twice, two messages. Not waiting: a tick that finds
# a round running leaves it to that round.
exec 8>"$RUN_LOCK"
flock -n 8 || { log "fut egy korabbi kor, ez a tick kimarad"; exit 0; }

mkdir -p "$REPORT_DIR"
# A TEST AI THAT STAYS DOWN IS SAID ONCE (barracuda #375): an unreadable /health is a log line per tick, and while it
# lasts the weekly run does not happen either. After HEALTH_ALERT_HOURS since the last good read, acrobot hears it
# ONCE; the marker is cleared by the next good read. The clock starts at the first tick that finds no mark.
HEALTH_OK="$REPORT_DIR/.health-ok"
HEALTH_ALERTED="$REPORT_DIR/.health-alerted"
[ -e "$HEALTH_OK" ] || touch "$HEALTH_OK"
health_down() {
  log "$1"
  if [ ! -e "$HEALTH_ALERTED" ] && [ -n "$(find "$HEALTH_OK" -mmin "+$((HEALTH_ALERT_HOURS * 60))" 2>/dev/null)" ]; then
    szol "[AI kerdeskeszlet-or] a teszt AI /health-je $HEALTH_ALERT_HOURS oranal regebben nem olvashato ($AI_URL): a kerdeskeszlet addig nem fut. Utolso jo olvasas: $(date -r "$HEALTH_OK" -Is)."
    touch "$HEALTH_ALERTED"
  fi
  exit 1
}

health="$(curl -fsS --max-time 15 "$AI_URL/health" 2>/dev/null)" || health_down "a /health nem olvashato ($AI_URL)"
# the newest WHOLE-SET report (barracuda on AI #111): a partial run (--only/--repeat, it carries a "repeat" field) written
# here by mistake is not a baseline. Taken as the newest, it would skip the next whole run until the weekly limit, or
# turn the questions it lacks into regressions in the comparison. An unreadable file stays a candidate, as before.
elozo="$(python3 - "$REPORT_DIR" <<'ELOZO'
import glob, json, os, sys
for path in sorted(glob.glob(os.path.join(sys.argv[1], "qs-*.json")), key=os.path.getmtime, reverse=True):
    try:
        if "repeat" in json.load(open(path, encoding="utf-8")):
            continue
    except (OSError, ValueError):
        pass
    print(path)
    break
ELOZO
)"

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
# a JSON /health is a good read, whatever comes of it
[ "$dontes" = "health-not-json" ] || { touch "$HEALTH_OK"; rm -f "$HEALTH_ALERTED"; }
case "$dontes" in
  skip) exit 0 ;;
  health-not-json) health_down "a /health valasza nem JSON ($AI_URL)" ;;
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
    # READ-ONLY, like every other user of the heavy lock (fleet-bootstrap.sh 2d creates it 0644 as one agent user): the
    # first tick, as marveen, could not open it for writing ("Permission denied", 2026-11-17 09:21), flock then failed on
    # a closed descriptor, and the build ran WITHOUT the lock. Now a lock that cannot be held stops the round.
    exec 9<"$LOCK" || { echo "FAIL a nehez-zar nem nyithato: $LOCK"; exit 1; }
    flock 9 || { echo "FAIL a nehez-zar nem veheto fel: $LOCK"; exit 1; }
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

# A SERVICE THAT WAS NOT THERE IS NO MEASUREMENT (task kerdeskeszlet-or-halozati-ujrafutas-20261123; acrobot 59534): the 2026-11-23 10:00Z
# run lost 8 of its 16 questions to a redeploy of the test AI mid-run (UND_ERR_SOCKET, then ECONNREFUSED, and a follow-up whose parent had
# no conversation), and the guard reported it as a failed run. A run with a network error ("network: ...", the runner's own label for a
# call that got no HTTP answer) is set aside under another name (not a baseline for the next comparison, kept as evidence), the guard
# waits for /health (up to RETRY_WAIT_S), and runs the set ONCE more; that run's outcome is the round's. Only a second network failure,
# or a /health that does not come back, is said, and as a failed measurement, not as a regression. An HTTP error, the provider's
# timeout among them ("HTTP 504 ai_provider_timeout"), is an answer, not a missing service: it stays with the runner's rules.
halozati_hiba() {
  python3 - "$1" <<'HALO'
import json, sys
try:
    results = json.load(open(sys.argv[1], encoding="utf-8")).get("results") or []
except (OSError, ValueError):
    results = []
errors = [r.get("error") for r in results if isinstance(r, dict) and isinstance(r.get("error"), str)]
print("igen" if any(e.startswith("network:") for e in errors) else "nem")
HALO
}
if [ "$rc" -ne 0 ] && [ -f "$kimenet" ] && [ "$(halozati_hiba "$kimenet")" = igen ]; then
  felre="$REPORT_DIR/halozati-$(basename "$kimenet")"
  mv "$kimenet" "$felre"
  log "halozati hiba a futasban: a jelentes felreteve ($felre), varok a /health-re (legfeljebb $RETRY_WAIT_S mp), utana egyszer ujrafuttatom"
  varva=0
  until health="$(curl -fsS --max-time 15 "$AI_URL/health" 2>/dev/null)"; do
    if [ "$varva" -ge "$RETRY_WAIT_S" ]; then
      szol "[AI kerdeskeszlet-or] HIBA, a meres nem sikerult ($ok, szerver ${server:0:8}): a futas kozben a teszt AI nem volt elerheto (halozati hiba), es $RETRY_WAIT_S mp alatt sem valaszolt ujra a /health. Ez nem romlas. Felretett jelentes: $felre"
      exit 1
    fi
    sleep "$RETRY_POLL_S"
    varva=$((varva + RETRY_POLL_S))
  done
  uj_server="$(printf '%s' "$health" | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("version")
except ValueError:
    v = None
print(v if isinstance(v, str) else "unknown")')"
  # A NEW SERVER IS A NEW ROUND, NOT A RERUN (barracuda on #394): a network error mid-run is mostly a redeploy, and then /health comes back
  # with new code, maybe with a new question set; the runner built at this round's start would measure the new server with the old set,
  # and the next tick would find the report's server equal to /health and run nothing. So when the version moved, the round ends here
  # (exit 0, a log line); the next tick sees "changed" against the old baseline and runs a whole round, fetched and built afresh.
  if [ "$uj_server" != "$server" ]; then
    log "a /health uj verzioval jott vissza (${server:0:8} -> ${uj_server:0:8}): nem futtatom ujra, a kovetkezo tick teljes kort fut"
    exit 0
  fi
  kimenet="$REPORT_DIR/qs-$(date -u +%Y-%m-%dT%H%MZ)-${server:0:8}-ujra.json"
  sorok="$(AI_API_TOKEN="$(cat "$TOKEN_FILE")" $RUNNER --url "$AI_URL" --out "$kimenet" "${osszevet[@]}" 2>&1)"
  rc=$?
  utolso="$(printf '%s\n' "$sorok" | tail -n 2 | tr '\n' ' ')"
  log "ujrafuttatas ($ok, szerver ${server:0:8}): kod $rc. $utolso"
  if [ "$rc" -ne 0 ] && [ -f "$kimenet" ] && [ "$(halozati_hiba "$kimenet")" = igen ]; then
    masodik="$REPORT_DIR/halozati-$(basename "$kimenet")"
    mv "$kimenet" "$masodik"
    szol "[AI kerdeskeszlet-or] HIBA, a meres nem sikerult ($ok, szerver ${server:0:8}): az ujrafuttatasban is halozati hiba volt (a teszt AI nem valaszolt minden hivasra). Ez nem romlas. Felretett jelentesek: $felre, $masodik"
    exit 1
  fi
fi
case "$rc" in
  0) ;;
  3) szol "[AI kerdeskeszlet-or] ROMLAS ($ok, szerver ${server:0:8}): $utolso Jelentes: $kimenet" ;;
  1) szol "[AI kerdeskeszlet-or] hivasi hiba a futasban ($ok, szerver ${server:0:8}): $utolso Jelentes: $kimenet" ;;
  *) szol "[AI kerdeskeszlet-or] a futtato $rc koddal allt meg ($ok): $utolso" ;;
esac
exit "$rc"
