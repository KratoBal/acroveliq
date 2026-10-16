#!/usr/bin/env bash
# fleet-api.sh -- narrow, allowlist-friendly wrapper around the LOCAL dashboard API.
#
# WHY: the strict security profiles (marketer, researcher) intentionally withhold raw
# `curl` from sub-agents, because those agents read web content and are a prompt-injection
# surface -- a raw curl is an exfiltration primitive. But the very same agents are REQUIRED
# by their persona to save memory, post a daily-log entry and status their kanban cards.
# Without a way to do that they stop on a permission prompt mid-task and the session hangs
# (observed on the korall agent right after its first task).
#
# This wrapper is the middle ground: the target host is HARDCODED to the local dashboard,
# so approving `Bash(bash .../scripts/fleet-api.sh:*)` grants dashboard access WITHOUT
# granting arbitrary outbound HTTP. No URL is ever taken from the caller.
#
# Usage:
#   bash scripts/fleet-api.sh memory <agent> <category> "<content>" "<keywords>"
#   bash scripts/fleet-api.sh memory-search <agent> "<query>" [category]
#   bash scripts/fleet-api.sh daily-log <agent> "<content>"
#   bash scripts/fleet-api.sh daily-log-now <agent> "<tema>" "<szoveg>"   # a "## HH:MM --"
#         fejlecet a RENDSZERORA teszi ra; ezt hasznald, ne gepeld be az idopontot
#   bash scripts/fleet-api.sh daily-log-read <agent> [YYYY-MM-DD] [full]   # READ it back
#         (hossz + elso sor bejegyzesenkent; "full" a teljes szoveget irja ki)
#   bash scripts/fleet-api.sh kanban-list
#   bash scripts/fleet-api.sh kanban-keres [--cim ELOTAG] [--statusz S] [--id ELOTAG] [--felelos NEV]
#   bash scripts/fleet-api.sh kanban-archive <card_id>
#   bash scripts/fleet-api.sh kanban-new "<title>" <status> <assignee> <priority>
#   bash scripts/fleet-api.sh kanban-move <card_id> <status> [actor]
#   bash scripts/fleet-api.sh kanban-assign <card_id> <assignee>
#   bash scripts/fleet-api.sh kanban-cim <card_id> - < cim.txt      # a CIM atirasa
#   bash scripts/fleet-api.sh kanban-comment <card_id> <author> "<content>"
#   bash scripts/fleet-api.sh kanban-comments <card_id>          # READ them back
#   bash scripts/fleet-api.sh message-read <id>       # a TELJES tartalom, vagas nelkul
#   bash scripts/fleet-api.sh message-status <id>
#   bash scripts/fleet-api.sh messages-sent <agent> [limit]
#   bash scripts/fleet-api.sh inbox <agent> [limit]   # a SAJAT bejovo sor, ujak elol
#   bash scripts/fleet-api.sh schedule-new <nev> <leiras> <prompt> <cron> <agent> [tipus]
#   bash scripts/fleet-api.sh approval-new <agent> <kategoria> <leiras>
#         (a lejarat a KATEGORIABOL jon, nem adhato meg hivaskor -- lasd a parancsnal)
#   bash scripts/fleet-api.sh approval-get <id>
#   bash scripts/fleet-api.sh task-new <task_id> [projekt] [szulo] [valtozat] [brief]
#   bash scripts/fleet-api.sh task-new <task_id> - < feladat.json   # ANGOL kulcsok: title, goal, assignee, reviewer, verification_profile, priority...
#         (egy ismeretlen kulcsot, pl. a magyar "felelos"-t, a szerver NEM tarol: a valasz "ignored"-ban sorolja, a parancs figyelmeztet)
#   bash scripts/fleet-api.sh task-event <task_id> <fajta> <szereplo> [ido] [hivatkozas] [--data - < adat.json]
#   bash scripts/fleet-api.sh task-timeline <task_id>
#   bash scripts/fleet-api.sh open-matters         # a nyitott ugyek osszefoglaloja (koord-munkamenet)
#   bash scripts/fleet-api.sh task-busy <agens>     # a feladatai, amik foglalva tartjak
#   bash scripts/fleet-api.sh vita-valasz <vita> <kor-token> [--vege] - < valasz.txt   # Acrobot vitakore (Tobbmodelles V1)
#   bash scripts/fleet-api.sh vita-lista [projekt]   # a vitak, ujak elol
#   bash scripts/fleet-api.sh task-session <task_id> <agens> <session_id>
#         (a HIVO SAJAT munkamenetet: egy masik agenset az agent-restart --task regisztralja)
#   bash scripts/fleet-api.sh agent-restart <agens> [--fresh] [--task <task_id>]
#   bash scripts/fleet-api.sh task-usage <task_id> [variants]   # 3: atfedo ablak, ervenytelen
#         (a kiado admin-hivasai feladatonkent jelzo ertekek, feladatok kozott nem osszeadhatok)
#   bash scripts/fleet-api.sh kiadas <task_id> <agens> [--continue] [--parallel "<indok>"] [--kiado <nev>]
#         (egy feladat kiadasa, megismetelheto; kilepes: 3 atado rekord, 4 feladat, 5 foglalt,
#          6 restart, 7 uzenet, 8 a panel nem tetlen)
#   bash scripts/fleet-api.sh task-project <task_id> <projekt> [indok]   # a projekt-csere egyetlen utja
#   bash scripts/fleet-api.sh project-repo <task_id> <owner/repo>        # a repo a feladat projektjee-e
#   bash scripts/fleet-api.sh deployed [--nez] marveen <task_id> [--commit <cherry-pick sha>]
#   bash scripts/fleet-api.sh deployed [--nez] acropora <task_id> --app api|web|partner|commerce [--app ...]
#         (egy beolvadt valtozas kint van-e: mer, es csak utana ir deployed esemenyt;
#          kilepes: 3 a commit nincs a fan, 4 nincs merged vagy mas repo, 5 nincs kint)
#
# Any argument may be "-" to read that value from STDIN (for long/multi-line content).
# Output: the raw API response on success; "FAIL <reason>" + exit 1 otherwise.
# Env: MARVEEN_WEB_PORT (default 3420).
#
# For SENDING inter-agent messages use scripts/agent-msg.sh -- it has the retry + id check.
# For CHECKING whether they arrived, use `message-status` / `messages-sent` here. The two
# are not the same thing and the difference has cost us: agent-msg.sh printing `OK id=<n>`
# means the queue ACCEPTED the message, not that the recipient read it. Measured 2026-08-17:
# eight messages went to one agent, exactly one was delivered, six sat `pending` for up to
# 52 minutes (its context was full, and a saturated session stops draining its queue) --
# and the sender reported all eight as handed over. Before writing that someone "was told",
# check the status. Added because polip asked for it: the rule was unenforceable without
# a tool, and its profile has no raw curl.
set -uo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
API="http://localhost:${PORT}/api"
# the calling user's own token if handed out, else the shared one, loudly (P0-1, plan 5.2)
if [ -r "$BASE/scripts/lib/dashboard-token.sh" ]; then
  . "$BASE/scripts/lib/dashboard-token.sh"
  TOKEN_FILE="$(dashboard_token_file "$BASE")"
else
  echo "dashboard-token: scripts/lib/dashboard-token.sh missing, using the shared token" >&2
  TOKEN_FILE="$BASE/store/.dashboard-token"
fi

[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

# "-" means: take this value from STDIN. Only the first such argument can be piped.
stdin_used=0
arg() {
  local v="${1-}"
  if [ "$v" = "-" ] && [ "$stdin_used" -eq 0 ]; then stdin_used=1; cat; else printf '%s' "$v"; fi
}

# ARGUMENTUM-SZAM ORZO, PARANCSONKENT. Ugyanaz a nema hiba, mint az agent-msg.sh-ban: ha egy
# szoveges argumentumban DUPLA IDEZOJEL all, es az egeszet dupla idezojelbe tesszuk a
# parancssorban, a bash az elso belso idezojelnel lezarja a stringet, a maradek kulon
# argumentumokka esik szet, es a felesleget a case ag CSENDBEN eldobja. Merve 2026-08-27
# (murena): egy hatvan szavas uzenetbol hat argumentum lett, es a hivas VEGIG zold maradt.
# Itt GLOBALIS felso hatar nem hasznalhato: a tizenot parancs arityja 1 es 7 kozott szor
# (kanban-list 1, memory 5, schedule-new 7), tehat egyetlen kozos szam HELYES hivast is
# elutasitana -- az a hamis pozitiv rosszabb, mint a hianyzo orzo. Ezert a hatar ott all,
# ahol az arity ugyis ki van irva: a sajat case againak elejen. A szam a SHIFT UTANI
# argumentumokra vonatkozik (a parancsszo mar le van valasztva).
argc_max() {
  local max="$1" got="$2" hint="$3"
  [ "$got" -le "$max" ] && return 0
  echo "FAIL: ${CMD}: ${got} argumentum erkezett, de a parancs legfeljebb ${max}-t ismer." >&2
  echo "  Ket oka lehet, es mindketto CSENDBEN dobta volna el a tobbit:" >&2
  echo "    (1) a szoveg szetesett egy dupla idezojelnel," >&2
  echo "    (2) eggyel tobb argumentumot adtal at, mint amennyit a parancs olvas." >&2
  echo "  A helyes alak: ${hint}" >&2
  exit 1
}

# Build a JSON object from alternating key/value pairs, without quoting pitfalls.
json_obj() {
  python3 -c '
import json,sys
a=sys.argv[1:]
print(json.dumps({a[i]: a[i+1] for i in range(0,len(a),2)}))' "$@"
}

# POST <path> <json-body>; prints the response, fails loudly on a non-2xx status.
post() {
  local path="$1" body="$2"
  local resp code json
  resp="$(curl -s -X POST "${API}${path}" \
    -H 'Content-Type: application/json' \
    -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
    -d "$body" -w $'\n%{http_code}' 2>/dev/null || true)"
  code="$(printf '%s' "$resp" | tail -n1)"
  json="$(printf '%s' "$resp" | sed '$d')"
  case "$code" in
    200|201) printf '%s\n' "$json" ;;
    *) echo "FAIL http=${code:-?} path=${path} resp=$(printf '%s' "$json" | head -c 200)"; exit 1 ;;
  esac
}

get() {
  local path="$1"
  curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}${path}" || { echo "FAIL: GET ${path}"; exit 1; }
}

# PUT <path> <json-body>; same contract as post(). Kanban card fields (assignee,
# title, priority) are updated with PUT, not POST -- without this a sub-agent
# cannot hand a blocked card back to its delegator, because the strict profiles
# withhold raw curl. Observed 2026-08-15: polip wrote the hand-back comment and
# set waiting, but its own name stayed on the card, so the ownership change was
# invisible on the dashboard.
put() {
  local path="$1" body="$2"
  local resp code json
  resp="$(curl -s -X PUT "${API}${path}" \
    -H 'Content-Type: application/json' \
    -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
    -d "$body" -w $'\n%{http_code}' 2>/dev/null || true)"
  code="$(printf '%s' "$resp" | tail -n1)"
  json="$(printf '%s' "$resp" | sed '$d')"
  case "$code" in
    200|201) printf '%s\n' "$json" ;;
    *) echo "FAIL http=${code:-?} path=${path} resp=$(printf '%s' "$json" | head -c 200)"; exit 1 ;;
  esac
}

CMD="${1:?command required}"; shift || true

# PROJEKTEK V1 (Balazs, A valtozat, 2026-10-14 13:11:32 UTC): uj feladathoz projekt kell. Ha a
# feladat MEG NEM LETEZIK (a timeline 404) es nincs projekt, a hivas megall es felsorolja a
# nyilvantartast. Letezo feladatnal a szerver a projektet amugy is megtartja (tartos), ott nincs mit kerni.
proj_need_if_new() {
  [ -n "${2:-}" ] && return 0
  local enc code ids
  enc="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1")"
  code="$(curl -s -o /dev/null -w '%{http_code}' -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/tasks/${enc}/timeline" 2>/dev/null || true)"
  [ "$code" = "404" ] || return 0
  ids="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/projects" 2>/dev/null \
    | python3 -c 'import json,sys
try: print("|".join(p["id"] for p in json.load(sys.stdin)))
except Exception: pass' 2>/dev/null)"
  echo "FAIL 4: uj feladathoz projekt kell (Projektek V1): ${ids:-acropora|os|commerce|reefclub}. JSON alakban \"project\": \"os\", a poziciosban a masodik argumentum." >&2
  return 4
}
# a szerver project_warning-ja a stderr-re (naplo modban ez a jelzes, a kilepes 0 marad)
proj_warn() {
  python3 -c '
import json,sys
try:
    d=json.loads(sys.argv[1])
except ValueError:
    sys.exit(0)
w=d.get("project_warning") if isinstance(d, dict) else None
if w: print("FIGYELEM (projekt): %s" % w, file=sys.stderr)
' "$1"
}

case "$CMD" in
  memory)
    argc_max 4 "$#" "fleet-api.sh memory <agent> <category> - < szoveg.txt \"kulcsszavak\""
    : "${1:?agent required}"; AGENT="$(arg "$1")"; : "${2:?category required}"; CAT="$(arg "$2")"
    : "${3:?content required}"; CONTENT="$(arg "$3")"; KEYWORDS="$(arg "${4-}")"
    post /memories "$(json_obj agent_id "$AGENT" category "$CAT" content "$CONTENT" keywords "$KEYWORDS")"
    ;;
  memory-search)
    argc_max 3 "$#" "fleet-api.sh memory-search <agent> \"kulcsszo\" [kategoria]"
    : "${1:?agent required}"; AGENT="$(arg "$1")"; : "${2:?query required}"; Q="$(arg "$2")"; CAT="${3-}"
    Q_ENC="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$Q")"
    P="/memories?agent=${AGENT}&q=${Q_ENC}"
    [ -n "$CAT" ] && P="${P}&category=${CAT}"
    get "$P"
    ;;
  daily-log)
    # A hatar KETTO, es ez pontosan az az ag, ahol 2026-08-27 este nautilus tizenot bejegyzese
    # csonkan ment el: negy szoval hivta (daily-log <agens> "Tema" "torzs"), a torzs elveszett,
    # es a valasz mind a tizenotszor {"ok":true} volt. Ott nem idezojel esett szet, hanem eggyel
    # tobb argumentumot adott at -- ezert ez arity-orzo, nem idezojel-orzo. Ha tema es torzs kell
    # kulon, a daily-log-now valo hozza (az a HH:MM fejlecet is meri).
    argc_max 2 "$#" "fleet-api.sh daily-log <agent> - < szoveg.txt   (tema+torzs: daily-log-now <agent> \"Tema\" - < szoveg.txt)"
    : "${1:?agent required}"; AGENT="$(arg "$1")"; : "${2:?content required}"; CONTENT="$(arg "$2")"
    # ES EGY MASODIK ORZO, MERT AZ ARITY NEM FOGJA MEG (korall mereseе, 2026-08-31).
    # Ez az ag NYERS atvitel: a fejlecet a HIVO irja. Az arity-orzo azt nezi, hany
    # argumentum jott, tehat a helyesen, KETTO argumentummal hivott parancs atmegy --
    # akkor is, ha a torzs elejere a hivo KEZZEL gepelt egy "## HH:MM" fejlecet.
    # Korall igy irt delelott begepelt idopontokat a naplojaba: a fajl ep volt, a
    # tartalom ep volt, csak a MIKOR volt tippelve. A fajl-mtime ertekek (08:32-09:22)
    # es a bejegyzesek cimkei (13:3x) ot orat tertek el.
    # A KETTO KOZOTTI KULONBSEG NEM A HASZNALO FEGYELME, HANEM A NEV: a rovidebb,
    # kezenfekvobb nevu ag az, amelyik NEM meri az idot. Ezert nem eleg dokumentalni.
    # Amit ez az orzo NEM tesz: nem tiltja a nyers utat. Az kell a korrekcios es a
    # visszamenoleges bejegyzeshez, ahol a fejlec SZANDEKOSAN nem a mostani ido.
    # Csak azt az egy alakot zarja ki, amit mertunk: gepelt ora-fejlec a torzs elejen.
    case "$CONTENT" in
      '## '[0-9][0-9]:[0-9][0-9]*)
        echo "FAIL a torzs '## HH:MM' fejleccel kezdodik, es ez az ag NEM meri az idot -- a fejlec az lenne, amit a mondat MEGIRASAKOR hittel, nem a kikuldes ideje." >&2
        echo "     Hasznald ehelyett:  fleet-api.sh daily-log-now $AGENT \"Tema\" - < szoveg.txt   (az a rendszerorarol belyegez, es megtagadja a kikuldest, ha nem tud merni)" >&2
        echo "     Ha SZANDEKOSAN mas idopontot irsz (korrekcio, visszamenoleges bejegyzes), ne a torzs ELEJERE tedd a fejlecet: nevezd meg a szovegben, melyik bejegyzest javitja." >&2
        exit 2
        ;;
    esac
    post /daily-log "$(json_obj agent_id "$AGENT" content "$CONTENT")"
    ;;
  daily-log-now)
    # Same as daily-log, but the "## HH:MM -- " header is stamped from the SYSTEM CLOCK
    # instead of being typed into the text. Twice on 2026-08-18 a log entry carried a
    # header two to five minutes ahead of the real time, both times for the same reason:
    # `date` ran in the same call that wrote the entry, so the header was a guess made
    # before the measurement came back. An append-only log cannot be edited afterwards --
    # the fix is a correction entry, which is more noise than the entry was worth.
    # Pass the TOPIC as the second argument and the body as the third; the timestamp is
    # not yours to write.
    #   fleet-api.sh daily-log-now acrobot "Tema" "A szoveg"
    #   fleet-api.sh daily-log-now acrobot "Tema" - < body.txt
    argc_max 3 "$#" "fleet-api.sh daily-log-now <agent> \"Tema\" - < szoveg.txt"
    : "${1:?agent required}"; AGENT="$(arg "$1")"; : "${2:?topic required}"; TOPIC="$(arg "$2")"
    : "${3:?content required}"; BODY="$(arg "$3")"
    # NOT `date`: glibc here answers UTC (the Europe/Budapest zone file is an
    # empty read-only bind mount from the host), so `date` is two hours behind.
    # local-now.sh reads Node's tz data and fails rather than guessing.
    STAMP="$(bash "$BASE/scripts/local-now.sh")"
    [ -n "$STAMP" ] || { echo "FAIL local clock unmeasurable -- refusing a guessed header" >&2; exit 1; }
    post /daily-log "$(json_obj agent_id "$AGENT" content "## $STAMP -- ${TOPIC}
${BODY}")"
    ;;
  daily-log-read)
    # A NAPLO VISSZAOLVASASA. Eddig CSAK IRNI lehetett, es 2026-08-27 este kiderult, hogy ez nem
    # elmeleti hiany: nautilus tizenot bejegyzese csonkan ment el (42 es 67 karakter kozott, csak
    # a temasor), mert a daily-log agat negy szoval hivta, es MIND A TIZENOTSZOR {"ok":true} jott
    # vissza. Aki ir, a sajat eredmenyet nem latta. Murena ugyanaznap kerte, hogy legyen olvaso:
    # o a daily-log-now agat hasznalta helyesen, de a szerkezetbol csak KOVETKEZTETNI tudott arra,
    # hogy a bejegyzesei epek -- merni nem.
    # Ezert a kimenet elso oszlopa a HOSSZ: az arulja el a csonkulast, nem a szoveg. A zaro sor
    # kulon kiirja a legrovidebb bejegyzest, es szol, ha barmelyik 120 karakter alatt van.
    argc_max 3 "$#" "fleet-api.sh daily-log-read <agent> [YYYY-MM-DD] [full]"
    : "${1:?agent required}"; AGENT="$(arg "$1")"; DATE="${2-}"; MODE="${3-}"
    P="/daily-log?agent=${AGENT}"
    [ -n "$DATE" ] && P="${P}&date=${DATE}"
    get "$P" | LOG_MODE="$MODE" python3 -c '
import json, os, sys
mode = os.environ.get("LOG_MODE", "")
rows = json.load(sys.stdin)
if not isinstance(rows, list) or not rows:
    print("nincs bejegyzes erre a napra"); raise SystemExit(0)
lens = []
for r in rows:
    c = r.get("content") or ""
    lens.append(len(c))
    if mode == "full":
        print("--- id %s | %d karakter" % (r.get("id"), len(c)))
        print(c); print()
    else:
        first = c.split("\n")[0]
        print("%5d kar | %s" % (len(c), first[:78]))
print()
print("%d bejegyzes | legrovidebb %d | leghosszabb %d karakter" % (len(rows), min(lens), max(lens)))
# A CSONKULAS JELE A HOSSZ. Egy csak-temasor bejegyzes 40 es 70 karakter kozott van.
short = [l for l in lens if l < 120]
if short:
    print("FIGYELEM: %d bejegyzes 120 karakter alatt van (%s)." % (len(short), ", ".join(str(x) for x in short)))
    print("          Ez a csonkulas jele: valoszinuleg csak a temasor ment el, a torzs elveszett.")
    print("          A daily-log KETTOT olvas (agens, tartalom); tema+torzs eseten daily-log-now valo.")
'
    ;;
  kanban-list)
    get /kanban
    ;;
  handoff-write)
    # A STRUKTURALT FELADATATADAS IRASA (acrovelIQ token-brief, 3. pont). A rekord
    # JSON, FAJLBOL, atiranyitassal: a szoveg dontest, tilalmat es kodallapotot
    # visz, tehat idezojel, backtick es dollarjel biztosan van benne.
    # Hianyzo kotelezo mezonel a szerver 400-at ad, es a parancs MINDET kiirja.
    argc_max 3 "$#" "fleet-api.sh handoff-write <task_id> <agens> - < atadas.json"
    TASK="${1:?task id required}"; AGENT="${2:?agent required}"; : "${3:?record required (-)}"
    # az azonosito URL-be kerul: szokoz vagy ? nem torheti el az utat
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    RECORD="$(arg "$3")"
    BODY="$(python3 -c '
import json,sys
try:
    record=json.loads(sys.argv[2])
except ValueError as e:
    sys.exit("FAIL: a rekord nem ervenyes JSON: %s" % e)
print(json.dumps({"agent": sys.argv[1], "record": record}))' "$AGENT" "$RECORD")" || { echo "$BODY"; exit 1; }
    RESP="$(curl -s -X POST "${API}/tasks/${TASK_URL}/handoffs" \
      -H 'Content-Type: application/json' -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
      -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
    CODE="$(printf '%s' "$RESP" | tail -n1)"; JSON="$(printf '%s' "$RESP" | sed '$d')"
    if [ "$CODE" = "201" ]; then printf '%s\n' "$JSON"; exit 0; fi
    printf '%s' "$JSON" | python3 -c '
import json,sys
code=sys.argv[1]
try:
    body=json.load(sys.stdin)
except ValueError:
    body={}
print("FAIL http=%s: %s" % (code, body.get("error","")))
for field in body.get("missing",[]):
    print("  hianyzik: %s" % field)
if body.get("required"):
    print("  a rekord kotelezo mezoi:")
    for field in body["required"]:
        print("    %s" % field)' "${CODE:-?}"
    exit 1
    ;;
  handoff-read)
    # A STRUKTURALT FELADATATADAS OLVASASA ES A KODALLAPOT VISSZAMERESE. Egy uj
    # munkamenet ELSO lepese. A szerver meri vissza az ag fejet es a PR-t (a
    # flotta tokenjevel), es ELTERESNEL a parancs 3-as koddal ALL MEG: a rekord
    # akkor egy mar nem letezo allapotrol szol, arra epiteni nem szabad.
    argc_max 1 "$#" "fleet-api.sh handoff-read <task_id>"
    TASK="${1:?task id required}"
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    RESP="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/tasks/${TASK_URL}/handoffs/latest?verify=1" -w $'\n%{http_code}' 2>/dev/null || true)"
    CODE="$(printf '%s' "$RESP" | tail -n1)"; JSON="$(printf '%s' "$RESP" | sed '$d')"
    [ "$CODE" = "200" ] || { echo "FAIL http=${CODE:-?} $(printf '%s' "$JSON" | head -c 200)"; exit 1; }
    printf '%s' "$JSON" | python3 -c '
import json,sys
d=json.load(sys.stdin); r=d["record"]; c=d["check"]
print(json.dumps(r, ensure_ascii=False, indent=2))
print("-- irta: %s, %s (rekord %s)" % (d["agent"], d["created_at"], d["id"]))
if c["ok"]:
    print("KODALLAPOT RENDBEN: a rekord a mai allapotrol szol. Kovetkezo lepes: %s" % r["next_step"])
    sys.exit(0)
print("ELTERES, ALLJ MEG. A rekord egy azota megvaltozott allapotrol szol:")
for line in c["mismatches"]:
    print("  - %s" % line)
print("Merd le, mi tortent azota, es jelezd, mielott barmit folytatsz.")
sys.exit(3)'
    exit $?
    ;;
  task-new)
    # FELADATONKENTI TOKENMERES (acrovelIQ token-brief, 1. pont). Egy feladat
    # (a kanban kartya id-je, vagy egy kiserleti valtozat sajat id-je). A szulo
    # es a valtozat a kiserlet V1/V2/V3 aganak egymas melle tetelehez kell.
    # A TC-Lite mezok (title, goal, acceptance, assignee, reviewer, authorization_ref,
    # verification_profile, kanban_card_id) FAJLBOL jonnek: `task-new <task_id> - < feladat.json`,
    # egy JSON objektum. A szoveg igy nem megy at a shellen.
    if [ "${2:-}" = "-" ]; then
      argc_max 2 "$#" "fleet-api.sh task-new <task_id> - < feladat.json"
      TASK="${1:?task id required}"
      BODY="$(python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except ValueError as e:
    sys.exit("FAIL: a STDIN nem JSON: %s" % e)
if not isinstance(d, dict):
    sys.exit("FAIL: a STDIN egy JSON objektum legyen")
d["id"]=sys.argv[1]
print(json.dumps(d))' "$TASK")" || exit 1
      P_GIVEN="$(printf '%s' "$BODY" | python3 -c 'import json,sys; v=json.load(sys.stdin).get("project"); print(v.strip() if isinstance(v,str) else "")')"
      proj_need_if_new "$TASK" "$P_GIVEN" || exit 4
      # A post a parancs-behelyettesitesben fut: a sajat `exit`-je csak az alhejbol lep ki,
      # ezert a kodot itt kell tovabbadni, kulonben egy elbukott hivas utan is 0 jonne.
      OUT="$(post /tasks "$BODY")"; RC=$?
      printf '%s\n' "$OUT"
      [ "$RC" -eq 0 ] || exit "$RC"
      # A szerver az el nem olvasott kulcsokat az "ignored" listaban nevezi meg (aktualis-munka-ures):
      # egy "felelos" kulcsu feladatnak nincs felelose, tehat SOHA nem lesz Aktualis munka.
      # Figyelmeztetes a stderr-re, a kilepes 0 marad (acrobot dontese, 2026-10-14).
      python3 -c '
import json,sys
try:
    d=json.loads(sys.argv[1])
except ValueError:
    sys.exit(0)
ig=d.get("ignored") if isinstance(d, dict) else None
if ig:
    print("FIGYELEM: a szerver ezeket a kulcsokat NEM tarolta (ismeretlen mezo): %s. Angol kulcsok kellenek: title, goal, acceptance, assignee, reviewer, authorization_ref, verification_profile, kanban_card_id, priority, project, type, parent_task, variant, brief_ref." % ", ".join(map(str, ig)), file=sys.stderr)
' "$OUT"
      proj_warn "$OUT"
      exit 0
    fi
    argc_max 5 "$#" "fleet-api.sh task-new <task_id> [projekt] [szulo_feladat] [valtozat] [brief_hivatkozas]"
    TASK="${1:?task id required}"
    proj_need_if_new "$TASK" "${2:-}" || exit 4
    OUT="$(post /tasks "$(json_obj id "$TASK" project "${2:-}" parent_task "${3:-}" variant "${4:-}" brief_ref "${5:-}")")"; RC=$?
    printf '%s\n' "$OUT"
    [ "$RC" -eq 0 ] || exit "$RC"
    proj_warn "$OUT"
    ;;
  task-project)
    # PROJEKTEK V1: egy feladat projektjenek EGYETLEN cserelesi utja (a task-new nem irja at, tartos).
    # A fo agens sajat tokenjevel megy; a szerver project_changed esemenyt ir mellé. Csak nyilvantartott id.
    argc_max 3 "$#" "fleet-api.sh task-project <task_id> <projekt> [indok]"
    TASK="${1:?task id required}"; PROJ="${2:?projekt kell (acropora|os|commerce|reefclub)}"
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    post "/tasks/${TASK_URL}/project" "$(json_obj project "$PROJ" reason "${3:-}")"
    ;;
  project-repo)
    # PROJEKTEK V1: a repo a feladat projektjee-e (a pr-beolvaszt.sh hivja a beolvasztas elott).
    # Naplo: csak kiir, a kilepes 0; 1 csak akkor, ha a szerver nem valaszol.
    argc_max 2 "$#" "fleet-api.sh project-repo <task_id> <owner/repo>"
    TASK="${1:?task id required}"; REPO_ARG="${2:?repo kell}"
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    TL="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/tasks/${TASK_URL}/timeline" -w $'\n%{http_code}' 2>/dev/null || true)"
    PR_LIST="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/projects" -w $'\n%{http_code}' 2>/dev/null || true)"
    [ "$(printf '%s' "$TL" | tail -n1)" = "200" ] && [ "$(printf '%s' "$PR_LIST" | tail -n1)" = "200" ] \
      || { echo "FAIL: a feladat vagy a projekt-lista nem olvashato (timeline $(printf '%s' "$TL" | tail -n1), projects $(printf '%s' "$PR_LIST" | tail -n1))"; exit 1; }
    TL_JSON="$(printf '%s' "$TL" | sed '$d')" PR_JSON="$(printf '%s' "$PR_LIST" | sed '$d')" python3 -c '
import json,os,sys
repo=sys.argv[1]
f=json.loads(os.environ["TL_JSON"]).get("fields") or {}
pid=f.get("project_id")
if not pid:
    print("FIGYELEM (projekt): a feladat projektje (%s) nincs a nyilvantartasban" % f.get("project")); sys.exit(0)
p=[x for x in json.loads(os.environ["PR_JSON"]) if x.get("id")==pid]
repos=p[0].get("repos",[]) if p else []
if repo in repos: print("PROJEKT rendben: a %s a(z) %s projekte" % (repo,pid))
else: print("FIGYELEM (projekt): a %s NEM a(z) %s projekte (%s)" % (repo,pid,", ".join(repos)))' "$REPO_ARG"
    ;;
  task-event)
    # Egy esemeny: assigned|started|review_requested|verdict|fix_started|done|merged,
    # es a koordinacios egyseg kezdo es zaro jele: coord_open|coord_close (a csatorna-munkamenete).
    # Az ido masodperc vagy ISO (2026-10-12T07:03:00Z); hianyaban MOST. A besorolas
    # ezekbol vezetodik le, a hivasokra semmi nem irodik.
    # Zaro fajtak a done mellett: blocked|cancelled|failed|partial.
    # review_requested es verdict: a hivatkozasban a repo#PR ALLJON ("KratoBal/acroveliq#76 fej <sha>"),
    # vagy a --data nevezze meg ({"repo":"KratoBal/acroveliq","pr":76}); docs/ops profilnal a fajl utja is jo.
    # Nelkule a szerver naplo modban would_reject jelet tesz ra, kenyszerit modban 409.
    # `--data -` a VEGEN: egy JSON objektum STDIN-rol (fajlbol, atiranyitassal), pl. a merged
    # esemeny {"repo":"KratoBal/acroveliq","pr":41,"merge_sha":"<40 jegy>"} adata.
    # IDEMPOTENCIA: a futas EGY kulcsot general, es halozati hibanal vagy 5xx-nel UGYANAZZAL
    # probalja ujra, tehat egy elveszett valasz utan sem lesz ket sor. Ket kulon FUTAS ket
    # kulon kulcs: a masodik javitasi kor fix_started-je nem nyelodik el (barracuda, review 1).
    DATA_STDIN=0
    if [ "$#" -ge 2 ] && [ "${*: -2:1}" = "--data" ]; then
      [ "${*: -1}" = "-" ] || { echo "FAIL: a --data utan csak - allhat (JSON STDIN-rol)"; exit 1; }
      DATA_STDIN=1; set -- "${@:1:$(($# - 2))}"
    fi
    argc_max 5 "$#" "fleet-api.sh task-event <task_id> <fajta> <szereplo> [ido] [hivatkozas] [--data - < adat.json]"
    TASK="${1:?task id required}"; KIND="${2:?kind required}"; ACTOR="${3:?actor required}"
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    BODY="$(python3 -c '
import json,sys
kind,actor,at,ref,with_data=sys.argv[1:6]
d={"kind":kind,"actor":actor,"ref":ref}
if at: d["at"]=at
if with_data=="1":
    try:
        data=json.load(sys.stdin)
    except ValueError as e:
        sys.exit("FAIL: a --data STDIN-je nem JSON: %s" % e)
    if not isinstance(data, dict):
        sys.exit("FAIL: a --data egy JSON objektum legyen")
    d["data"]=data
print(json.dumps(d))' "$KIND" "$ACTOR" "${4:-}" "${5:-}" "$DATA_STDIN")" || exit 1
    KEY="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    for attempt in 1 2 3; do
      RESP="$(curl -s -X POST "${API}/tasks/${TASK_URL}/events" \
        -H 'Content-Type: application/json' -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "Idempotency-Key: $KEY" \
        -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
      CODE="$(printf '%s' "$RESP" | tail -n1)"; JSON="$(printf '%s' "$RESP" | sed '$d')"
      case "$CODE" in
        200|201) printf '%s\n' "$JSON"; exit 0 ;;
        000|5??) [ "$attempt" -lt 3 ] && sleep "$attempt" ;;
        *) break ;;
      esac
    done
    echo "FAIL http=${CODE:-?} path=/tasks/${TASK_URL}/events kulcs=${KEY} resp=$(printf '%s' "$JSON" | head -c 300)"
    exit 1
    ;;
  task-timeline)
    # Egy feladat minden nyoma idorendben: esemenyek, atado rekordok, regisztralt sessionok.
    argc_max 1 "$#" "fleet-api.sh task-timeline <task_id>"
    TASK="${1:?task id required}"
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    RESP="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/tasks/${TASK_URL}/timeline" -w $'\n%{http_code}' 2>/dev/null || true)"
    CODE="$(printf '%s' "$RESP" | tail -n1)"; JSON="$(printf '%s' "$RESP" | sed '$d')"
    [ "$CODE" = "200" ] || { echo "FAIL http=${CODE:-?} $(printf '%s' "$JSON" | head -c 200)"; exit 1; }
    printf '%s' "$JSON" | python3 -c '
import json,sys,time
d=json.load(sys.stdin)
for i in d["items"]:
    t=time.strftime("%Y-%m-%d %H:%M:%S%z", time.localtime(i["at"]))
    if i["source"]=="event":
        extra=" "+json.dumps(i["data"], ensure_ascii=False) if i.get("data") else ""
        print("%s  esemeny  %-16s %-10s %s%s" % (t, i["kind"], i["actor"], i.get("ref") or "", extra))
    elif i["source"]=="handoff":
        print("%s  atadas   rekord %-9s %-10s %s" % (t, i["id"], i["agent"], i["status"]))
    elif i["source"]=="session":
        print("%s  session  %-16s %-10s" % (t, i["session_id"], i["agent"]))
    elif i["source"]=="message":
        print("%s  uzenet   %-16s %-10s %s" % (t, i["id"], "%s -> %s" % (i["from"], i["to"]), i["status"]))
    else:
        # A szerver ujabb tetelfajtat is adhat: ne hasaljon el, mutassa nyersen.
        print("%s  %s  %s" % (t, i["source"], json.dumps(i, ensure_ascii=False)))
print("-- %d tetel, %s" % (len(d["items"]), d["task"]))'
    exit $?
    ;;
  open-matters)
    # A NYITOTT UGYEK OSSZEFOGLALOJA (koord-munkamenet, terv 1. pont): egy koordinacios
    # munkamenet ELSO olvasasa. Generalt, minden sor a forrasat nevezi meg, es a keretbol
    # kimaradtakat a vegen darabszammal es azonositoval sorolja: nem masodik memoria.
    argc_max 0 "$#" "fleet-api.sh open-matters"
    RESP="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/open-matters?format=text" -w $'\n%{http_code}' 2>/dev/null || true)"
    CODE="$(printf '%s' "$RESP" | tail -n1)"; BODYTXT="$(printf '%s' "$RESP" | sed '$d')"
    [ "$CODE" = "200" ] || { echo "FAIL http=${CODE:-?} $(printf '%s' "$BODYTXT" | head -c 200)"; exit 1; }
    printf '%s\n' "$BODYTXT"
    ;;
  vita-valasz)
    # TOBBMODELLES V1 (src/debates.ts): Acrobot leadja a vita egy koret a vezerlotol kapott,
    # egyszer hasznalhato kor-azonositoval. A szovegnek STDIN-rol kell jonnie (a tartalom ne
    # menjen at a shellen). A szalba a vezerlo teszi ki; egy korre csak egy leadas szamit (409).
    # --vege: a szakasz itt megallhat (egyetertes, vagy eleg ez az egy valasz).
    argc_max 4 "$#" "fleet-api.sh vita-valasz <vita> <kor-token> [--vege] - < valasz.txt"
    VITA="${1:?vita id required}"; KOR="${2:?kor token required}"; shift 2
    FINAL=false; DASH=0
    for a in "$@"; do
      case "$a" in
        --vege) FINAL=true ;;
        -) DASH=1 ;;
        *) echo "FAIL: ismeretlen argumentum: $a (--vege, -)" >&2; exit 2 ;;
      esac
    done
    [ "$DASH" = "1" ] || { echo "FAIL: a valasz STDIN-rol jon: fleet-api.sh vita-valasz $VITA $KOR [--vege] - < valasz.txt" >&2; exit 2; }
    for v in "$VITA" "$KOR"; do
      [[ "$v" =~ ^[A-Za-z0-9._-]{1,100}$ ]] || { echo "FAIL: az azonosito alakja (betu, szam, . _ -): $v" >&2; exit 2; }
    done
    BODY="$(FINAL="$FINAL" python3 -c 'import json,os,sys
t=sys.stdin.read()
if not t.strip(): sys.exit("FAIL: ures valasz")
print(json.dumps({"text": t, "final": os.environ["FINAL"] == "true"}))')" || exit 2
    post "/debates/${VITA}/turns/${KOR}" "$BODY"
    ;;
  vita-lista)
    argc_max 1 "$#" "fleet-api.sh vita-lista [projekt]"
    Q=""; [ -n "${1:-}" ] && Q="?project=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1")"
    get "/debates${Q}" | python3 -c '
import json,sys,time
rows=json.load(sys.stdin)
if not rows: print("nincs vita")
for d in rows:
    print("%s  %-12s %-9s %d. szakasz  GPT %s  %s  %s" % (d["id"], d["status"], d["project"], d["phase"], "igen" if d["gpt_invited"] else "nem",
        time.strftime("%m-%d %H:%M", time.localtime(d["created_at"])), d["topic"][:60]))'
    ;;
  task-busy)
    # Egy agens feladatai, amik FOGLALVA tartjak: az utolso esemeny assigned, started vagy
    # fix_started. A review_requested utan mar nem foglalt.
    argc_max 1 "$#" "fleet-api.sh task-busy <agens>"
    AGENT="${1:?agent required}"
    A_ENC="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$AGENT")"
    get "/tasks?assignee=${A_ENC}&busy=1"
    ;;
  agent-restart)
    # TC-Lite L2: egy agens ujrainditasa. --fresh: uj beszelgetes (nincs --continue).
    # --task <id>: a SZERVER valaszt munkamenet-azonositot, azzal inditja, es a feladathoz
    # regisztralja, az UTVONAL agensere (nem a hivora). A valaszban: {"ok":true,"session_id":...}.
    # A --task csak --fresh mellett megy: a folytatott munkamenet a sajat azonositojat tartja.
    argc_max 4 "$#" "fleet-api.sh agent-restart <agens> [--fresh] [--task <task_id>]"
    AGENT="${1:?agent required}"; shift
    FRESH=0; TASK=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --fresh) FRESH=1; shift ;;
        --task) TASK="${2:?--task utan feladat-azonosito kell}"; shift 2 ;;
        *) echo "FAIL: ismeretlen kapcsolo: $1 (--fresh, --task <task_id>)" >&2; exit 1 ;;
      esac
    done
    if [ -n "$TASK" ] && [ "$FRESH" != 1 ]; then
      echo "FAIL: a --task csak --fresh mellett megy (a folytatott munkamenet a sajat azonositojat tartja)" >&2; exit 1
    fi
    A_ENC="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$AGENT")"
    BODY="$(FRESH="$FRESH" TASK="$TASK" python3 -c 'import json,os
b={"fresh": os.environ["FRESH"] == "1"}
if os.environ["TASK"]: b["task_id"] = os.environ["TASK"]
print(json.dumps(b))')"
    post "/agents/${A_ENC}/restart" "$BODY"
    ;;
  kiadas)
    # TC-Lite L5: EGY feladat kiadasa EGY agensnek, egyetlen, megismetelheto paranccsal.
    # A lepesek a terv tablaja szerint (exchange/acroveliq/tcl-elokeszites-2026-10-13.md, ### L5),
    # mindegyik a SAJAT kilepesi kodjaval all meg, hogy a hivo tudja, hol:
    #   1  a feladat letezik, es van goal, authorization_ref, verification_profile, a felelose
    #      pedig ez az agens (enelkul a foglaltsag-lekerdezes sosem latna)    -> 4
    #   2  az atado rekord, visszamerve (handoff-read)                         -> 3 tovabbadva
    #   3  az agensnek nincs MASIK foglalt feladata; --parallel "<indok>" atengedi -> 5
    #   4  assigned esemeny, csak ha a feladat meg nincs ennek az agensnek kiadva, VAGY ugyan nala
    #      van, de a szerver szerint nem foglalja (a 3. lepes busy=1 listajan nincs rajta): az
    #      utolso allapot-esemenye nem assigned, started vagy fix_started (review_requested, verdict,
    #      merged, deployed, done, blocked ...), es a vezerlopult is szabadnak mutatja. Egy uj szakasz
    #      kiadasa ilyenkor ujra foglalja. A szabalyt a szerver adja (task-usage.ts BUSY_KINDS,
    #      NON_STATE_KINDS es a szunet), a szkriptben nincs masolata.
    #   4b a panel tetlen (idle vagy stopped) ES nincs neki szolo fuggo uzenet -> 8, restart nincs
    #   5  friss inditas a feladat munkamenet-azonositojaval, ha nincs --continue
    #      es a feladaton meg nincs az agensnek munkamenete                    -> 6
    #   6  indito uzenet --task-kal, ha a feladaton meg nincs neki szolo uzenet, VAGY a 4. lepes
    #      ujra foglalta (uj szakasz: a regi uzenet az elozo szakaszrol szolt)  -> 7
    # SZUNET (Feladatkezeles V1): szuneteltetett feladatot az 1. lepes nem ad ki (4-es kod), es
    # a 4., 5. es 6. lepes CSAK az utolso paused UTANI tetelekbol dont, kulonben a folytatas
    # utani ujrakiadas mindharmat kihagyna (a szunet elotti assigned, munkamenet es uzenet miatt).
    # FUTO KORT NEM SZAKITUNK MEG: a 4b CSAK akkor fut, ha az 5 ujrainditana. Ha nem tetlen,
    # a kiadas --continue alakban ismetelheto (akkor az uzenet a sorba megy, restart nelkul).
    # Ismetleskor a 4, 5 es 6 a feladat idovonalabol latja, hogy mar megtortent, es kihagyja.
    # A kiado (az esemeny szereploje, az uzenet feladoja) alapbol acrobot: a restart utvonalat
    # csak a fo agens tokenje nyitja; --kiado <nev> felulirja.
    TASK="${1:?task id required}"; AGENT="${2:?agent required}"; shift 2
    CONTINUE=0; PARALLEL=""; KIADO="acrobot"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --continue) CONTINUE=1; shift ;;
        --parallel) PARALLEL="${2:-}"; [ -n "$PARALLEL" ] || { echo "FAIL: a --parallel utan indok kell" >&2; exit 1; }; shift 2 ;;
        --kiado) KIADO="${2:?--kiado utan agens-nev kell}"; shift 2 ;;
        *) echo "FAIL: ismeretlen kapcsolo: $1 (--continue, --parallel \"<indok>\", --kiado <nev>)" >&2; exit 1 ;;
      esac
    done
    if ! [[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]]; then
      echo "FAIL: a feladat-azonosito alakja (betu, szam, . _ -), ez erkezett: $TASK" >&2; exit 1
    fi
    TASK_URL="$TASK"
    A_ENC="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$AGENT")"
    # GET <path>: a torzs a KI_JSON-ba, a kod a KI_CODE-ba (a get() a kodot nem nezi)
    kget() {
      local resp
      resp="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}$1" -w $'\n%{http_code}' 2>/dev/null || true)"
      KI_CODE="$(printf '%s' "$resp" | tail -n1)"; KI_JSON="$(printf '%s' "$resp" | sed '$d')"
    }
    # 1. a feladat es a mezoi
    kget "/tasks/${TASK_URL}/timeline"
    if [ "$KI_CODE" = "404" ]; then echo "FAIL 1: nincs ilyen feladat: $TASK (fleet-api.sh task-new)"; exit 4; fi
    [ "$KI_CODE" = "200" ] || { echo "FAIL 1: http=${KI_CODE:-?} $(printf '%s' "$KI_JSON" | head -c 200)"; exit 1; }
    TIMELINE="$KI_JSON"
    printf '%s' "$TIMELINE" | python3 -c '
import json,sys
agent=sys.argv[1]
try:
    d=json.load(sys.stdin)
    f=d.get("fields")
except (ValueError, AttributeError):
    print("FAIL 1: a timeline valasza nem olvashato JSON objektum"); sys.exit(1)
if d.get("paused") is True:
    print("FAIL 1: a feladat szunetel: kiadni csak Balazs folytatasa utan lehet (AcrovelIQ, Folytatas)"); sys.exit(4)
if not isinstance(f, dict):
    print("FAIL 1: a valaszban nincs a feladat mezoinek listaja (fields): a dashboard regebbi, mint az L5"); sys.exit(4)
missing=[k for k in ("goal","authorization_ref","verification_profile") if not f.get(k)]
if not f.get("assignee"): missing.append("assignee")
for k in missing: print("FAIL 1: hianyzik a feladatrol: %s" % k)
if missing:
    print("  Potlas: fleet-api.sh task-new %s - < feladat.json. A goal, assignee es tarsai, ha nincsenek benne, maradnak;" % sys.argv[2])
    print("  a type, parent_task, variant es brief_ref viszont felulirodik: azokat is add meg (a project nem: tartos, csere: task-project).")
    sys.exit(4)
if f["assignee"] != agent:
    print("FAIL 1: a feladat felelose %s, nem %s" % (f["assignee"], agent))
    print("  Atiras: fleet-api.sh task-new %s - < feladat.json, benne \"assignee\": \"%s\"; a type," % (sys.argv[2], agent))
    print("  parent_task, variant es brief_ref felulirodik, azokat is add meg (a goal es tarsai maradnak; a project nem: tartos).")
    sys.exit(4)
proj = f.get("project_id") or ("ISMERETLEN: %s" % f.get("project")) if "project" in f else "-"
print("1 rendben: %s, felelos %s, profil %s, projekt %s" % (sys.argv[2], agent, f["verification_profile"], proj))' "$AGENT" "$TASK"
    RC1=$?; [ "$RC1" -eq 0 ] || exit "$RC1"
    # 2. az atado rekord, visszamerve
    HO_OUT="$(bash "${BASH_SOURCE[0]}" handoff-read "$TASK" 2>&1)"; HO_RC=$?
    if [ "$HO_RC" -ne 0 ]; then
      printf '%s\n' "$HO_OUT" | grep -E '^(FAIL|ELTERES|  - )' || printf '%s\n' "$HO_OUT" | tail -n 3
      echo "FAIL 2: az atado rekord nem hasznalhato (handoff-read kilepes $HO_RC)"
      [ "$HO_RC" -eq 3 ] && exit 3; exit 1
    fi
    echo "2 rendben: $(printf '%s\n' "$HO_OUT" | grep -m1 -- '^-- irta:')"
    # 3. foglaltsag: a MASIK feladatai (ez a feladat ismetleskor mar foglalt, az nem akadaly)
    kget "/tasks?assignee=${A_ENC}&busy=1"
    [ "$KI_CODE" = "200" ] || { echo "FAIL 3: http=${KI_CODE:-?} $(printf '%s' "$KI_JSON" | head -c 200)"; exit 1; }
    BUSY="$(printf '%s' "$KI_JSON" | python3 -c '
import json,sys
print(" ".join("%s(%s)" % (t["id"], t.get("last_kind")) for t in json.load(sys.stdin) if t["id"] != sys.argv[1]))' "$TASK")" || exit 1
    # Is THIS task among the ones keeping the agent busy? (step 4: a free task is claimed again)
    THIS_BUSY="$(printf '%s' "$KI_JSON" | python3 -c '
import json,sys
print(int(any(t.get("id")==sys.argv[1] for t in json.load(sys.stdin))))' "$TASK")" || exit 1
    if [ -n "$BUSY" ]; then
      if [ -z "$PARALLEL" ]; then
        echo "FAIL 3: $AGENT foglalt: $BUSY"
        echo "  Ha szandekosan parhuzamos: --parallel \"<indok>\" (az indok az assigned esemenybe kerul)"
        exit 5
      fi
      echo "3 foglalt ($BUSY), de --parallel: $PARALLEL"
    else
      echo "3 rendben: $AGENT nem foglalt"
    fi
    # Mi tortent mar a feladaton? (4, 5 es 6 ismetlesre ebbol dont)
    read -r HAS_ASSIGNED HAS_SESSION HAS_MESSAGE ASSIGNED_N < <(printf '%s' "$TIMELINE" | python3 -c '
import json,sys
agent=sys.argv[1]
items=json.load(sys.stdin)["items"]
# only what happened since the last pause counts (a resumed task is handed out again)
pauses=[n for n,i in enumerate(items) if i.get("source")=="event" and i.get("kind")=="paused"]
if pauses: items=items[pauses[-1]+1:]
assigned=[i for i in items if i["source"]=="event" and i["kind"]=="assigned"]
last=assigned[-1] if assigned else None
to_me = bool(last) and ((last.get("data") or {}).get("agent")==agent or last.get("ref")==agent)
session=any(i["source"]=="session" and i["agent"]==agent for i in items)
# The start message counts only if it came AFTER the last assigned to this agent: a re-claimed
# stage whose message failed (exit 7) gets it on the rerun, like a first hand-out does (barracuda
# #133). The timeline is in time order, a message after an event of the same second (task-usage.ts).
mine=[n for n,i in enumerate(items) if i["source"]=="event" and i["kind"]=="assigned"
      and ((i.get("data") or {}).get("agent")==agent or i.get("ref")==agent)]
since=items[mine[-1]+1:] if mine else items
message=any(i["source"]=="message" and i.get("to")==agent for i in since)
print(int(to_me), int(session), int(message), len(mine))' "$AGENT")
    # ZARVA hibazik: ures ertek mellett a 4, 5 es 6 ujra lefutna (dupla assigned, restart, uzenet)
    case "${HAS_ASSIGNED:-}${HAS_SESSION:-}${HAS_MESSAGE:-}" in
      [01][01][01]) ;;
      *) echo "FAIL: az idovonalbol nem olvashato, mi tortent mar a feladaton; nem irok semmit"; exit 1 ;;
    esac
    case "${ASSIGNED_N:-}" in
      ''|*[!0-9]*) echo "FAIL: az idovonalbol nem olvashato, mi tortent mar a feladaton; nem irok semmit"; exit 1 ;;
    esac
    case "${THIS_BUSY:-}" in
      0|1) ;;
      *) echo "FAIL: a foglaltsag-valaszbol nem olvashato, foglalja-e ez a feladat; nem irok semmit"; exit 1 ;;
    esac
    # 4. assigned. A task already handed to this agent is skipped only while it keeps the agent
    # busy: after review_requested, verdict, merged, deployed, blocked ... it reads as free (busy
    # check and dashboard), and the next stage must claim it again (acrobot, 2026-10-14 15:28,
    # the dashboard showed no active task; manual assigned 819; barracuda #132).
    WROTE_ASSIGNED=0
    if [ "${HAS_ASSIGNED:-0}" = "1" ] && [ "$THIS_BUSY" = "1" ]; then
      echo "4 kihagyva: a feladat mar ki van adva $AGENT agensnek"
    else
      [ "${HAS_ASSIGNED:-0}" = "1" ] && echo "4 ujra foglal: a feladat $AGENT agensnel van, de a szerver szerint nem foglalja (az utolso allapot-esemenye nem assigned, started vagy fix_started)"
      DATA="$(AGENT="$AGENT" PARALLEL="$PARALLEL" python3 -c 'import json,os
d={"agent":os.environ["AGENT"]}
if os.environ["PARALLEL"]: d["parallel"]=os.environ["PARALLEL"]
print(json.dumps(d))')"
      EV_OUT="$(printf '%s' "$DATA" | bash "${BASH_SOURCE[0]}" task-event "$TASK" assigned "$KIADO" "" "$AGENT" --data - 2>&1)" \
        || { printf '%s\n' "$EV_OUT"; echo "FAIL 4: az assigned esemeny nem ment be"; exit 1; }
      echo "4 rendben: assigned -> $AGENT ($EV_OUT)"
      WROTE_ASSIGNED=1
      ASSIGNED_N=$((ASSIGNED_N + 1))
    fi
    # 4b es 5: friss inditas, csak tetlen panelre
    if [ "$CONTINUE" = "1" ]; then
      echo "5 kihagyva: --continue (a futo munkamenet marad, az uzenet a sorba megy)"
    elif [ "${HAS_SESSION:-0}" = "1" ]; then
      echo "5 kihagyva: a feladaton mar van $AGENT munkamenete (ismetles)"
    else
      kget "/agents/activity"
      [ "$KI_CODE" = "200" ] || { echo "FAIL 4b: http=${KI_CODE:-?} $(printf '%s' "$KI_JSON" | head -c 200)"; exit 1; }
      ACT="$KI_JSON"
      kget "/messages?agent=${A_ENC}&status=pending"
      [ "$KI_CODE" = "200" ] || { echo "FAIL 4b: http=${KI_CODE:-?} $(printf '%s' "$KI_JSON" | head -c 200)"; exit 1; }
      PENDING="$KI_JSON"
      ACT="$ACT" PENDING="$PENDING" python3 -c '
import json,os,sys
agent=sys.argv[1]
me=[a for a in json.loads(os.environ["ACT"]) if a.get("name")==agent]
pending=[m for m in json.loads(os.environ["PENDING"]) if m.get("to_agent")==agent]
state=me[0].get("state") if me else None
if state in ("idle","stopped") and not pending:
    print("4b rendben: %s %s, nincs fuggo uzenete" % (agent, state)); sys.exit(0)
print("FAIL 4b: %s nem tetlen, restart nincs. Allapot: %s, fuggo uzenet: %d%s" % (
    agent, state or "nem latom az agenst", len(pending),
    " (" + ", ".join(str(m.get("id")) for m in pending[:10]) + ")" if pending else ""))
for line in (me[0].get("tail") or [])[-5:] if me else []:
    print("  | %s" % line)
print("  Ismeteld kesobb, vagy --continue alakban (restart nelkul, az uzenet a sorba megy).")
sys.exit(8)' "$AGENT" || exit 8
      BODY="$(TASK="$TASK" python3 -c 'import json,os; print(json.dumps({"fresh": True, "task_id": os.environ["TASK"]}))')"
      RESP="$(curl -s -X POST "${API}/agents/${A_ENC}/restart" -H 'Content-Type: application/json' \
        -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
      CODE="$(printf '%s' "$RESP" | tail -n1)"; JSON="$(printf '%s' "$RESP" | sed '$d')"
      SID="$(printf '%s' "$JSON" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except ValueError: d={}
print(d.get("session_id","") if d.get("ok") is True and d.get("registered") is not False else "")' 2>/dev/null)"
      if { [ "$CODE" != "200" ] && [ "$CODE" != "201" ]; } || [ -z "$SID" ]; then
        echo "FAIL 5: a friss inditas nem sikerult vagy a munkamenet nincs a feladathoz kotve: http=${CODE:-?} $(printf '%s' "$JSON" | head -c 200)"
        exit 6
      fi
      echo "5 rendben: $AGENT frissen indult, munkamenet $SID"
    fi
    # 6. indito uzenet: one per assigned. Needed when step 4 just wrote assigned, or when no message
    # to the agent stands after its last assigned (a rerun after a failed message, exit 7). A
    # re-claimed stage gets one again, the old message was about the previous stage (acrobot 30677).
    # A repeat stays silent: its message already stands after the assigned.
    if [ "$WROTE_ASSIGNED" = "0" ] && [ "${HAS_MESSAGE:-0}" = "1" ]; then
      echo "6 kihagyva: a feladathoz mar van $AGENT agensnek szolo uzenet"
    else
      # an earlier assigned to this agent than the one this message belongs to: a new stage
      if [ "$ASSIGNED_N" -ge 2 ]; then
        MSG="Uj szakasz ugyanezen a feladaton: ${TASK}. Az elso lepes az atado rekord: bash ${BASE}/scripts/fleet-api.sh handoff-read ${TASK}"
      else
        MSG="Uj feladat: ${TASK}. Az elso lepes az atado rekord: bash ${BASE}/scripts/fleet-api.sh handoff-read ${TASK}"
      fi
      MSG_OUT="$(printf '%s' "$MSG" | bash "$BASE/scripts/agent-msg.sh" --task "$TASK" "$KIADO" "$AGENT" - 2>&1)"
      MSG_ID="$(printf '%s\n' "$MSG_OUT" | sed -n 's/^OK id=\([0-9][0-9]*\).*/\1/p' | head -n 1)"
      if [ -z "$MSG_ID" ]; then
        printf '%s\n' "$MSG_OUT" | tail -n 3
        echo "FAIL 6: az indito uzenet nem ment el (nincs OK id= sor)"
        exit 7
      fi
      echo "6 rendben: indito uzenet OK id=$MSG_ID (sorba kerult; a kezbesitest a message-status mondja meg)"
    fi
    echo "KIADVA: $TASK -> $AGENT"
    ;;
  deployed)
    # TC-03 MINIMUM (task deployed-esemeny, acrobot 30524): egy BEOLVADT valtozas KINT VAN-E.
    # A feladat utolso `merged` esemenyebol indul (repo, pr, merge_sha: a pr-beolvaszt.sh irja),
    # lemeri, hogy a valtozas fut-e, es CSAK UTANA ir egy `deployed` esemenyt. A done-or nem keri
    # (az kulon dontes). Ket cel:
    #
    #   deployed [--nez] marveen <task_id> [--commit <sha>]
    #     A flotta elo fajan (DEPLOYED_LIVE_TREE, alapbol a repo gyokere): ha a merge_sha az elo HEAD
    #     ose, evidence=ancestor. Ha nem (cherry-pick a release-agra), a --commit kotelezo: az legyen
    #     a HEAD ose, ES a git patch-id-ja egyezzen a merge commit valtozasaeval (kulonben egy MASIK
    #     PR cherry-pickje is atmenne), evidence=cherry-pick. A futo build (dist) frissesseget NEM meri.
    #   deployed [--nez] acropora <task_id> --app api|web|partner|commerce [--app ...]
    #     Az eles gep kep-cimkejet olvassa a fleet-gate `ps` muveleten at (ELES_HOST, ELES_KEY, mint az
    #     eles-verziok.sh), es a merge_sha a kep commitjanak ose-e (DEPLOYED_OS_CLONE, illetve a
    #     commerce appnal DEPLOYED_COMMERCE_CLONE klonban, fetch utan). Appenkent egy esemeny,
    #     evidence=image-tag; ha barmelyik app kepe nem tartalmazza, SEMMIT nem ir.
    #
    # Kilepes: 0 rendben (vagy --nez); 1 hivas- vagy halozati hiba; 3 a commit nincs a fan;
    # 4 nincs hasznalhato merged esemeny vagy mas repo; 5 nincs kint. Ismetles: a kulcs
    # deployed:<task>:<cel>:<sha>, tehat ugyanaz a telepites masodszor is egy sor.
    NEZ=0; [ "${1:-}" = "--nez" ] && { NEZ=1; shift; }
    CEL="${1:-}"; TASK="${2:-}"
    case "$CEL" in marveen|acropora) ;; *) echo "FAIL: deployed [--nez] marveen|acropora <task_id> [--commit <sha>] [--app <nev>]" >&2; exit 1 ;; esac
    [ -n "$TASK" ] || { echo "FAIL: hianyzik a feladat-azonosito" >&2; exit 1; }
    [[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || { echo "FAIL: a feladat-azonosito alakja: $TASK" >&2; exit 1; }
    shift 2
    COMMIT=""; APPS=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --commit) COMMIT="${2:?a --commit utan sha kell}"; shift 2 ;;
        --app) APPS+=("${2:?az --app utan nev kell}"); shift 2 ;;
        *) echo "FAIL: ismeretlen kapcsolo: $1" >&2; exit 1 ;;
      esac
    done
    [ "$CEL" = "marveen" ] && [ "${#APPS[@]}" -gt 0 ] && { echo "FAIL: az --app csak az acropora celnal" >&2; exit 1; }
    [ "$CEL" = "acropora" ] && [ -n "$COMMIT" ] && { echo "FAIL: a --commit csak a marveen celnal" >&2; exit 1; }
    [ "$CEL" = "acropora" ] && [ "${#APPS[@]}" -eq 0 ] && { echo "FAIL: az acropora celnal legalabb egy --app kell (api, web, partner, commerce)" >&2; exit 1; }
    RESP="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/tasks/${TASK}/timeline" -w $'\n%{http_code}' 2>/dev/null || true)"
    CODE="$(printf '%s' "$RESP" | tail -n1)"; JSON="$(printf '%s' "$RESP" | sed '$d')"
    [ "$CODE" = "404" ] && { echo "FAIL 4: nincs ilyen feladat: $TASK"; exit 4; }
    [ "$CODE" = "200" ] || { echo "FAIL: http=${CODE:-?} $(printf '%s' "$JSON" | head -c 200)"; exit 1; }
    MERGED="$(printf '%s' "$JSON" | python3 -c '
import json,re,sys
items=json.load(sys.stdin).get("items") or []
m=[i for i in items if i.get("source")=="event" and i.get("kind")=="merged"]
if not m: sys.exit("nincs merged esemeny a feladaton (a pr-beolvaszt.sh --task irja)")
d=m[-1].get("data") or {}
repo,pr,sha=d.get("repo"),d.get("pr"),d.get("merge_sha")
if not (isinstance(repo,str) and re.fullmatch(r"[\w.-]+/[\w.-]+",repo)): sys.exit("a merged esemenyben nincs repo")
if isinstance(pr,str) and pr.isdigit(): pr=int(pr)
if not (isinstance(pr,int) and pr>0): sys.exit("a merged esemenyben nincs pr")
if not (isinstance(sha,str) and re.fullmatch(r"[0-9a-f]{40}",sha.lower())): sys.exit("a merged esemenyben nincs 40 jegyu merge_sha")
print(repo, pr, sha.lower())' 2>&1)" || { echo "FAIL 4: $MERGED"; exit 4; }
    read -r M_REPO M_PR M_SHA <<< "$MERGED"
    # egy esemeny kiirasa (vagy --nez), rogzitett kulccsal
    dep_write() {
      local target="$1" dsha="$2" evid="$3" app="${4:-}" key body resp code json attempt
      key="deployed:${TASK}:${target}${app:+:$app}:${dsha}"
      body="$(M_REPO="$M_REPO" M_PR="$M_PR" M_SHA="$M_SHA" T="$target" D="$dsha" E="$evid" A="$app" python3 -c '
import json,os
data={"target":os.environ["T"],"repo":os.environ["M_REPO"],"pr":int(os.environ["M_PR"]),"merge_sha":os.environ["M_SHA"],
      "deployed_sha":os.environ["D"],"evidence":os.environ["E"]}
if os.environ["A"]: data["app"]=os.environ["A"]
# marveen-live: az elo fa HEAD-je, ami meg nem biztos, hogy fut (a dist nincs merve): nem "kint" (barracuda, #121)
where="az elo fan" if os.environ["T"]=="marveen-live" else "eles kepben"
ref="%s#%s %s %s %s%s" % (os.environ["M_REPO"],os.environ["M_PR"],where,os.environ["T"],os.environ["D"][:12],(" "+os.environ["A"]) if os.environ["A"] else "")
print(json.dumps({"kind":"deployed","actor":"acrobot","ref":ref,"data":data}))')"
      if [ "$NEZ" = "1" ]; then echo "NEZ (nem irok): $body"; return 0; fi
      for attempt in 1 2 3; do
        resp="$(curl -s -X POST "${API}/tasks/${TASK}/events" -H 'Content-Type: application/json' \
          -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H "Idempotency-Key: $key" \
          -d "$body" -w $'\n%{http_code}' 2>/dev/null || true)"
        code="$(printf '%s' "$resp" | tail -n1)"; json="$(printf '%s' "$resp" | sed '$d')"
        case "$code" in
          200|201) echo "IRVA: deployed $target${app:+ $app} $dsha ($evid) $json"; return 0 ;;
          000|5??) [ "$attempt" -lt 3 ] && sleep "$attempt" ;;
          *) break ;;
        esac
      done
      echo "FAIL: http=${code:-?} kulcs=$key $(printf '%s' "$json" | head -c 200)"; return 1
    }
    if [ "$CEL" = "marveen" ]; then
      # a flotta repoja 2026-10-15 ota KratoBal/acroveliq; a regi merged esemenyek a regi nevvel allnak
      case "$M_REPO" in
        KratoBal/acroveliq|KratoBal/marveen) ;;
        *) echo "FAIL 4: a merged repo $M_REPO, nem a flotta repoja (KratoBal/acroveliq, korabban KratoBal/marveen)"; exit 4 ;;
      esac
      LIVE="${DEPLOYED_LIVE_TREE:-$BASE}"
      git -C "$LIVE" cat-file -e "${M_SHA}^{commit}" 2>/dev/null \
        || { echo "FAIL 3: a merge commit (${M_SHA:0:12}) nincs az elo faban ($LIVE): elobb git -C $LIVE fetch origin main"; exit 3; }
      HEAD_SHA="$(git -C "$LIVE" rev-parse HEAD)"
      if git -C "$LIVE" merge-base --is-ancestor "$M_SHA" "$HEAD_SHA"; then
        echo "MERT: a ${M_SHA:0:12} az elo HEAD (${HEAD_SHA:0:12}) ose"
        dep_write marveen-live "$HEAD_SHA" ancestor || exit 1
        exit 0
      fi
      [ -n "$COMMIT" ] || { echo "FAIL 5: a ${M_SHA:0:12} nem ose az elo HEAD-nek (${HEAD_SHA:0:12}); cherry-pick eseten: --commit <a cherry-pick sha-ja>"; exit 5; }
      C_SHA="$(git -C "$LIVE" rev-parse --verify -q "${COMMIT}^{commit}")" || { echo "FAIL 3: a --commit (${COMMIT}) nincs az elo faban"; exit 3; }
      git -C "$LIVE" merge-base --is-ancestor "$C_SHA" "$HEAD_SHA" || { echo "FAIL 5: a --commit (${C_SHA:0:12}) nem ose az elo HEAD-nek"; exit 5; }
      P_MERGE="$(git -C "$LIVE" show "$M_SHA" | git -C "$LIVE" patch-id --stable | cut -d' ' -f1)"
      P_PICK="$(git -C "$LIVE" show "$C_SHA" | git -C "$LIVE" patch-id --stable | cut -d' ' -f1)"
      [ -n "$P_MERGE" ] && [ "$P_MERGE" = "$P_PICK" ] \
        || { echo "FAIL 5: a --commit valtozasa nem a merge commite (patch-id ${P_PICK:0:12} kontra ${P_MERGE:0:12})"; exit 5; }
      echo "MERT: a ${C_SHA:0:12} cherry-pick az elo HEAD ose, a patch-id egyezik a ${M_SHA:0:12}-val"
      dep_write marveen-live "$C_SHA" cherry-pick || exit 1
      exit 0
    fi
    # acropora: az eles kep-cimke
    # the production machine's key is pinned (scripts/host/known_hosts; task ssh-hostkulcs-rogzites):
    # an unknown or changed key fails here, before any line of the answer can become an event
    KNOWN_HOSTS="${FLEET_KNOWN_HOSTS:-$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/host/known_hosts}"
    PS_OUT="$(timeout 45 ssh -o BatchMode=yes -o ConnectTimeout=10 \
      -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null \
      -o HostKeyAlgorithms=ssh-ed25519 \
      -i "${ELES_KEY:-/home/marveen/.ssh/id_ed25519_acropora_monitor}" "${ELES_HOST:-fleet@162.55.216.28}" ps 2>&1)" \
      || { echo "FAIL: az eles gep nem erheto el: $(printf '%s' "$PS_OUT" | head -c 200)"; exit 1; }
    declare -a OUT_T=() OUT_S=() OUT_A=()
    for app in "${APPS[@]}"; do
      case "$app" in
        api) uuid=t9gxx94ecwekwruxngps5i6v; repo=KratoBal/acropora-os; clone="${DEPLOYED_OS_CLONE:-/home/marveen/work/acropora-os}" ;;
        web) uuid=dnt6jzza68wnuamvi93whn28; repo=KratoBal/acropora-os; clone="${DEPLOYED_OS_CLONE:-/home/marveen/work/acropora-os}" ;;
        partner) uuid=iknrqjk9xeyydc5fibrk5tbp; repo=KratoBal/acropora-os; clone="${DEPLOYED_OS_CLONE:-/home/marveen/work/acropora-os}" ;;
        commerce) uuid=obpxbcqgjturybmemmdi7wid; repo=KratoBal/acropora-commerce; clone="${DEPLOYED_COMMERCE_CLONE:-/home/marveen/work/acropora-commerce}" ;;
        *) echo "FAIL: ismeretlen app: $app (api, web, partner, commerce)"; exit 1 ;;
      esac
      [ "$repo" = "$M_REPO" ] || { echo "FAIL 4: a(z) $app a $repo repoe, a merged esemeny a $M_REPO repoe"; exit 4; }
      # MINDEN egyezo kontener: telepites kozben a regi es az uj egyszerre fut ugyanazzal az
      # azonositoval, es amig a regi is el, a valtozas nem mondhato kintnek (barracuda, #121)
      lines="$(printf '%s\n' "$PS_OUT" | grep -F "$uuid")"
      [ -n "$lines" ] || { echo "FAIL 5: a(z) $app nem fut (nincs kontener ezzel az azonositoval)"; exit 5; }
      git -C "$clone" fetch -q origin main 2>/dev/null || true
      git -C "$clone" cat-file -e "${M_SHA}^{commit}" 2>/dev/null || { echo "FAIL 3: a merge commit (${M_SHA:0:12}) nincs a $clone klonban"; exit 3; }
      full=""
      while IFS= read -r line || [ -n "$line" ]; do
        [ -n "$line" ] || continue
        img="$(printf '%s' "$line" | cut -d'|' -f2)"; isha="${img##*:}"
        [[ "$isha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "FAIL 5: a(z) $app kep-cimkeje nem commit: $img"; exit 5; }
        one="$(git -C "$clone" rev-parse --verify -q "${isha}^{commit}")" || { echo "FAIL 3: a(z) $app kep-commitja (${isha:0:12}) nincs a $clone klonban"; exit 3; }
        git -C "$clone" merge-base --is-ancestor "$M_SHA" "$one" \
          || { echo "FAIL 5: a(z) $app egyik kepe (${one:0:12}) NEM tartalmazza a ${M_SHA:0:12}-t: meg nincs (teljesen) kint"; exit 5; }
        full="$one"
      done <<< "$lines"
      echo "MERT: a(z) $app minden kepe tartalmazza a ${M_SHA:0:12}-t (utolso: ${full:0:12})"
      OUT_T+=("acropora-prod"); OUT_S+=("$full"); OUT_A+=("$app")
    done
    # csak ha MIND kint van, akkor ir: egy reszleges telepites nem kerul fel felig
    for i in "${!OUT_A[@]}"; do dep_write "${OUT_T[$i]}" "${OUT_S[$i]}" image-tag "${OUT_A[$i]}" || exit 1; done
    exit 0
    ;;
  task-session)
    # Egy munkamenet a feladate (a V3 eset): akkor minden hivasa a feladathoz megy.
    # A HIVO SAJAT munkamenetere valo. Egy masik agens friss inditasat az agent-restart
    # <agens> --fresh --task <id> regisztralja, a szerver altal valasztott azonositoval.
    argc_max 3 "$#" "fleet-api.sh task-session <task_id> <agens> <session_id>"
    TASK="${1:?task id required}"; AGENT="${2:?agent required}"; SESSION="${3:?session id required}"
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    post "/tasks/${TASK_URL}/sessions" "$(json_obj agent "$AGENT" session_id "$SESSION")"
    ;;
  task-usage)
    # A feladat bontasa tokenfajtankent es kapacitas-fajtankent; "variants" mellett
    # a valtozatai is mellette. ATFEDO ABLAKNAL a feladat ERVENYTELEN: a parancs
    # ezt kiirja, es 3-as koddal lep ki, mert a szamai akkor nem teljesek.
    # A KIADO admin-hivasai (az assigned esemeny admin-ablakot nyit a szereplojenek a done
    # vagy merged esemenyig) FELADATONKENT JELZO ERTEKEK: parhuzamos kiadasoknal az ablakok
    # szandekosan atfednek, ezert feladatok kozott NEM ADHATOK OSSZE (acrobot dontese, #60).
    # A KOORDINACIOS ABLAK (koord-munkamenet): a csatorna-munkamenet a kiadas es az atvetel
    # idejere coord_open / coord_close esemenyt ir a feladatra; a ketto kozotti hivasai a
    # coord sorba kerulnek. Ha kozben mas feladat ablaka is nyitva volt, kulon sor mondja ki.
    argc_max 2 "$#" "fleet-api.sh task-usage <task_id> [variants]"
    TASK="${1:?task id required}"
    TASK_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$TASK")"
    Q=""; [ "${2:-}" = "variants" ] && Q="?variants=1"
    RESP="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/tasks/${TASK_URL}/usage${Q}" -w $'\n%{http_code}' 2>/dev/null || true)"
    CODE="$(printf '%s' "$RESP" | tail -n1)"; JSON="$(printf '%s' "$RESP" | sed '$d')"
    [ "$CODE" = "200" ] || { echo "FAIL http=${CODE:-?} $(printf '%s' "$JSON" | head -c 200)"; exit 1; }
    printf '%s' "$JSON" | python3 -c '
import json,sys,time
d=json.load(sys.stdin)
rows=[d["task"]]+d["variants"] if "variants" in d else [d]
M=lambda n: "%.2fM" % (n/1e6)
HM=lambda ts: time.strftime("%m-%d %H:%M", time.localtime(ts)) if ts else "nincs"
# HOW FAR THE DATA GOES (task-usage-continue-res): token_usage holds what the collector has
# read (hourly and at start). A window reaching past its last run is not counted yet, and a 0
# read then is not a fact: 2026-10-14 a task that ran 100 calls read 0 until the collector ran.
LR=(d.get("collector_last_run") or {}).get("at")
def line(name,t):
    return "  %-10s %5d hivas  in %8s  ki %8s  cache-olv %8s  cache-ir %8s" % (name,t["calls"],M(t["input"]),M(t["output"]),M(t["cache_read"]),M(t["cache_write"]))
bad=False
for u in rows:
    t=u["task"]
    print("%s (%s%s)%s" % (t["id"], t["project"], ", "+t["variant"] if t.get("variant") else "", "" if u["valid"] else "  ERVENYTELEN"))
    print(line("osszesen",u["totals"]))
    for k,v in u["by_capacity"].items():
        if v["calls"]: print(line(k,v))
    print("  hozzarendeles: munkamenet %d, idoablak %d; idotartam %s mp" % (u["by_mode"]["session"],u["by_mode"]["window"],u["duration_seconds"]))
    ing=u.get("ingested")
    if ing is not None:
        lc=ing.get("last_call") or {}
        print("  beolvasva: a gyujto utoljara %s; utolso beolvasott hivas: %s" % (
            HM(LR) if LR else "ISMERETLEN (ebben a dashboard-folyamatban meg nem futott le)",
            ", ".join("%s %s" % (a, HM(t)) for a, t in sorted(lc.items())) or "-"))
        au=ing.get("activity_until")
        if au and (not LR or au > LR):
            print("  FIGYELEM: a feladat ablaka eddig tart: %s, a gyujto utolso futasa: %s. Az azutani hivasok meg nincsenek" % (HM(au), HM(LR) if LR else "nincs"))
            print("    beolvasva, a szam HIANYOS lehet (a 0 is). Teljes szam: POST /api/token-usage/collect (fo agens), vagy a kovetkezo orai kor.")
    if u["repeated_of"]: print("  ismetelt munka, elozmeny: %s" % u["repeated_of"])
    for k,v in u["unassigned"].items():
        if v["calls"]: print("  %s: nem rendelheto, %d hivas az atfedo ablakban (cache-olv %s)" % (k,v["calls"],M(v["cache_read"])))
    c=u.get("coordination") or {}
    cc=c.get("concurrent") or {}
    cd_=c.get("ceded") or {}
    if cd_.get("calls"): print("  coord: %d hivas a feladat sajat ablakaban egy masik feladat coord ablakaba esett (%s), ott szamolva (cache-olv %s)" % (cd_["calls"], ", ".join(c.get("ceded_to") or []), M(cd_["cache_read"])))
    if c.get("open_since"): print("  coord: LEZARATLAN ablak %s ota (nincs coord_close): a lekerdezes pillanataig fut" % c["open_since"])
    if cc.get("calls"): print("  coord: ebbol %d hivas idejen mas feladat ablaka is nyitva volt (%s): a csatorna-munkamenet mast is csinalhatott, szet nem valaszthato" % (cc["calls"], ", ".join(c.get("concurrent_tasks") or [])))
    for o in u["overlaps"]:
        bad=True
        print("  ATFEDES: %s hivasa (%s) egyszerre ezekhez: %s" % (o["agent"],o["timestamp"],", ".join(o["tasks"])))
sys.exit(3 if bad else 0)'
    exit $?
    ;;
  kanban-new)
    argc_max 4 "$#" "fleet-api.sh kanban-new - < cim.txt [status] [assignee] [priority]"
    : "${1:?title required}"; TITLE="$(arg "$1")"; STATUS="${2:-planned}"; ASSIGNEE="${3:-}"; PRIORITY="${4:-normal}"
    post /kanban "$(json_obj title "$TITLE" status "$STATUS" assignee "$ASSIGNEE" priority "$PRIORITY")"
    ;;
  kanban-move)
    # `actor` is optional but should always be passed: it tells the board WHO moved
    # the card. Without it a self-pickup (an agent moving its OWN card to in_progress)
    # is indistinguishable from an assignment, and the dispatcher echoes the task back
    # at the agent that just started it. Upstream added the field to the raw-curl
    # instructions (v1.33.0); the helper has to carry it too, otherwise the agents that
    # cannot use raw curl silently lose the fix.
    argc_max 3 "$#" "fleet-api.sh kanban-move <card_id> <status> [actor]"
    CARD="${1:?card id required}"; STATUS="${2:?status required}"; ACTOR="$(arg "${3-}")"
    if [ -n "$ACTOR" ]; then
      post "/kanban/${CARD}/move" "$(json_obj status "$STATUS" actor "$ACTOR")"
    else
      post "/kanban/${CARD}/move" "$(json_obj status "$STATUS")"
    fi
    ;;
  kanban-assign)
    argc_max 2 "$#" "fleet-api.sh kanban-assign <card_id> <assignee>"
    CARD="${1:?card id required}"; : "${2:?assignee required}"; ASSIGNEE="$(arg "$2")"
    put "/kanban/${CARD}" "$(json_obj assignee "$ASSIGNEE")"
    ;;
  kanban-cim)
    # A KARTYA CIMENEK ATIRASA. Ez a parancs 2026-09-08-ig NEM LETEZETT, es a
    # hianya EGY ELO KARTYAT irt at egy kozos tablan.
    #
    # MI TORTENT: nautilus at akart irni egy elavult cimet, es mivel nem volt ra
    # parancs, a nyers vegpontot probalta ki. A PATCH 404-et adott, a POST is,
    # a PUT viszont 200-at -- csakhogy a proba TESTE `{"title":"proba"}` volt,
    # tehat a siker nem csak megmondta, hogy a vegpont letezik: AT IS IRTA a
    # cimet, es a kartya nehany masodpercig szo szerint `proba` volt.
    #
    # AZ OK NEM AZ O HIBAJA VOLT, HANEM EZ A HIANYZO AG. Egy ismeretlen
    # vegpontot ki KELL probalni ahhoz, hogy megtudd, letezik-e -- es amig
    # nincs parancs, a proba mindig valodi rekordon fut. Ezert a feloldas nem
    # figyelmeztetes, hanem ez a nyolc sor.
    #
    # A CIM STDIN-ROL JON, es ez sem kenyelmi kerdes: a kartya-cimek
    # ekezeteket, idezojelet es zarojelet tartalmaznak, es a lapunkon mert
    # eset all arra, hogy az idezojel a bash-ben csonkolja a szoveget -- zold
    # nyugtaval.
    argc_max 2 "$#" "fleet-api.sh kanban-cim <card_id> - < cim.txt"
    CARD="${1:?card id required}"; : "${2:?title required}"; TITLE="$(arg "$2")"
    put "/kanban/${CARD}" "$(json_obj title "$TITLE")"
    ;;
  kanban-comment)
    argc_max 3 "$#" "fleet-api.sh kanban-comment <card_id> <author> - < szoveg.txt"
    CARD="${1:?card id required}"; : "${2:?author required}"; AUTHOR="$(arg "$2")"; : "${3:?content required}"; CONTENT="$(arg "$3")"
    post "/kanban/${CARD}/comments" "$(json_obj author "$AUTHOR" content "$CONTENT")"
    ;;
  kanban-keres)
    # B29 (task b29-fleet-api-kanban): the open cards, filtered, one line each. The main agent
    # used to pipe the raw list into a python3 one-off; under a strict profile that one-off is a
    # permission question every time. Filters are ANDed; none given lists every open card.
    #   --cim ELOTAG     title starts with (case-insensitive)
    #   --statusz S      planned | in_progress | waiting | done
    #   --id ELOTAG      card id starts with
    #   --felelos NEV    assignee
    # Output: id, status, assignee, priority, title (tab-separated; the title cut to 120), then
    # the count. Archived cards are not in this list (GET /api/kanban/archived has them).
    argc_max 8 "$#" "fleet-api.sh kanban-keres [--cim ELOTAG] [--statusz S] [--id ELOTAG] [--felelos NEV]"
    K_CIM=""; K_ST=""; K_ID=""; K_FEL=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --cim) K_CIM="${2-}"; shift 2 || { echo "FAIL: --cim ertek nelkul"; exit 1; } ;;
        --statusz) K_ST="${2-}"; shift 2 || { echo "FAIL: --statusz ertek nelkul"; exit 1; } ;;
        --id) K_ID="${2-}"; shift 2 || { echo "FAIL: --id ertek nelkul"; exit 1; } ;;
        --felelos) K_FEL="${2-}"; shift 2 || { echo "FAIL: --felelos ertek nelkul"; exit 1; } ;;
        *) echo "FAIL: kanban-keres: ismeretlen kapcsolo: $1"; exit 1 ;;
      esac
    done
    case "$K_ST" in ''|planned|in_progress|waiting|done) ;; *) echo "FAIL: --statusz: planned|in_progress|waiting|done"; exit 1 ;; esac
    get /kanban | K_CIM="$K_CIM" K_ST="$K_ST" K_ID="$K_ID" K_FEL="$K_FEL" python3 -c '
import json, os, sys
try:
    cards = json.load(sys.stdin)
except ValueError:
    print("FAIL: a kanban lista nem JSON"); sys.exit(1)
if not isinstance(cards, list):
    print("FAIL: a kanban lista nem lista"); sys.exit(1)
cim, st, cid, fel = (os.environ[k] for k in ("K_CIM", "K_ST", "K_ID", "K_FEL"))
n = 0
for c in cards:
    t = c.get("title") or ""
    if cim and not t.lower().startswith(cim.lower()): continue
    if st and c.get("status") != st: continue
    if cid and not str(c.get("id", "")).startswith(cid): continue
    if fel and (c.get("assignee") or "") != fel: continue
    n += 1
    print("\t".join([str(c.get("id", "")), c.get("status") or "", c.get("assignee") or "-", c.get("priority") or "", t[:120].replace("\t", " ").replace("\n", " ")]))
print("%d kartya" % n)
'
    ;;
  kanban-archive)
    # B29: archive a card (POST /api/kanban/<id>/archive, empty body); 404 says the card is not there.
    argc_max 1 "$#" "fleet-api.sh kanban-archive <card_id>"
    CARD="${1:?card id required}"
    CARD_URL="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$CARD")"
    post "/kanban/${CARD_URL}/archive" '{}'
    ;;
  kanban-comments)
    # READING a card's comments. This existed only as a WRITE (kanban-comment)
    # until 2026-08-27, and the gap cost four separate round trips in one day:
    # a card's title says what the work is, the DECIDING detail sits in a
    # comment, and an agent that cannot read comments has to ask the
    # orchestrator to copy them over. Twice that day an agent started -- or
    # nearly started -- work that a comment would have ruled out, and once it
    # measured the wrong system entirely because the title used our vocabulary
    # for someone else's model.
    #
    # Read-only, same endpoint the dashboard uses. The single-card GET
    # (/api/kanban/<id>) does NOT exist and answers 404; the comments path does.
    CARD="${1:?card id required}"
    get "/kanban/${CARD}/comments"
    ;;
  message-close)
    # EGY UZENET LEZARASA, ES A NYUGTA HOSSZANAK KAPUZASA.
    #
    # A `result` mezo NEM privat konyvelo sor: a szerver uj uzenetkent visszakuldi a KULDONEK,
    # es 500 karakternel elvagja (src/web/routes/messages.ts, RESULT_SUMMARY_LIMIT). A levagas
    # ota jelolt, tehat nem nema -- de a levagott resz ettol meg nem erkezik meg.
    #
    # AMIERT ESZKOZBE KERULT, ES NEM MARADT SZABALYNAK: 2026-08-27 este NEGYSZER futottam bele,
    # miutan a szabalyt magamnak MAR leirtam. A negyedik a tanulsagos: meg is szamoltam a
    # karaktereket, csak UGYANABBAN a parancsban, amelyik el is kuldte. A szam kiirodott (574),
    # es nem allitott meg semmit. Egy meres, ami nem kapuz, nem ellenorzes.
    #
    # Ezert ez az ag a hosszt MERI, es 500 folott NEM KULD: kiirja, mennyivel hosszabb, es hogy
    # a tartalom rendes uzenetbe valo. Ugyanaz a fajta orzo, mint az arity-orzo, csak a masik
    # iranyba: ott a tul sok argumentum, itt a tul hosszu nyugta.
    argc_max 2 "$#" "fleet-api.sh message-close <uzenet_id> - < nyugta.txt"
    ID="${1:?message id required}"; : "${2:?result required}"; RESULT="$(arg "$2")"
    LEN="$(RESULT="$RESULT" python3 -c 'import os; print(len(os.environ["RESULT"]))')"
    if [ "$LEN" -gt 500 ]; then
      echo "FAIL: a nyugta $LEN karakter, a hatar 500 -- $((LEN - 500)) karakterrel hosszabb." >&2
      echo "  A tulnyulo resz NEM erkezne meg a kuldohoz. Ket lehetoseg:" >&2
      echo "  (1) rovidits 500 ala, es akkor a nyugta viszi a valaszt;" >&2
      echo "  (2) kuldd rendes uzenetkent (agent-msg.sh), a nyugtaba pedig egy sor kerüljon arrol, hol a valasz." >&2
      exit 1
    fi
    put "/messages/${ID}" "$(json_obj status "done" result "$RESULT")"
    ;;
  message-read)
    # EGY UZENET TELJES TARTALMA, VAGAS NELKUL.
    #
    # AMIERT KELL: 2026-08-27 este murena ujraindult tele kontextussal, es a riportjahoz a
    # SAJAT hat lepes-jelenteset kellett volna visszaolvasnia. Azt tanacsoltam neki, hogy a
    # messages-sent paranccsal tegye. TEVEDTEM: az a lista 56 KARAKTERRE vagja a torzset, a
    # message-status pedig a NYUGTA szoveget adja vissza 300 karakteren. Egyik sem viszi
    # vissza a tartalmat. Az eloiras jo volt ("a potlas is meres legyen, ne visszaemlekezes"),
    # az UT nem letezett -- egy eszkoz NEVE nem bizonyitja, hogy az eszkoz odavisz.
    #
    # Ez az ag a nyers tartalmat adja, ahogy a szerver tarolja. Read-only.
    # A MASODIK ARGUMENTUM (agens) A LATOHATART NYITJA KI, ES EGY HAMIS KORLATOT VALT KI.
    #
    # Ez az ag korabban azt irta ki, hogy "ennel REGEBBI uzenet ezen az uton nem erheto el".
    # NEM IGAZ, es szerkezeti tiltasnak latszott. A `/api/messages` vegpont ismer `before`
    # kurzort -- csak az `agent` parameterrel egyutt (a szures nelkuli ag eldobja).
    #
    # Ezert: ha megadod, KINEK az uzenete, egyetlen hivassal barmilyen regi azonosito
    # elerheto (`agent=X&before=<id+1>`, es a keresett sor a lap ELSO eleme lesz).
    # Az agens nelkuli alak tovabbra is csak az utolso 200-at latja -- az nem hiba, csak
    # kevesebb, es a kimenet meg is mondja, mivel lehet tovabbmenni.
    #
    # 2026-10-16 (P0-1 kikenyszerites elokeszites): az uzenet a `/api/messages/<id>` vegpontrol
    # jon, EGY sor, ablak nelkul. A listas ut (agens nelkul a flotta utolso 200 uzenete, vagy egy
    # MASIK agens postafiokja) a hozzaferesi matrixban nem a hivo sajatja: egy alagens tokenjevel
    # a kikenyszerites 403-at ad ra. Az egy-soros ut a feladot es a cimzettet egyarant sajatnak
    # tekinti. A masodik argumentumot elfogadjuk a regi hivasok miatt, de mar nem kell.
    argc_max 2 "$#" "fleet-api.sh message-read <uzenet_id> [agens]"
    ID="${1:?message id required}"
    case "$ID" in ''|*[!0-9]*) echo "FAIL: az uzenet-azonosito szam: $ID"; exit 1 ;; esac
    get "/messages/${ID}" | MSG_ID="$ID" python3 -c '
import json, os, sys, time
mid = int(os.environ["MSG_ID"])
raw = sys.stdin.read()
try:
    m = json.loads(raw)
except ValueError:
    print("FAIL: a valasz nem JSON: %s" % raw[:200]); raise SystemExit(1)
# a 404-es valasz is visz `id` mezot, tehat elobb a hibat kell nezni
if not isinstance(m, dict) or m.get("error") or m.get("id") != mid:
    err = m.get("error") if isinstance(m, dict) else None
    if err == "message not found":
        print("FAIL: nincs %d azonositoju uzenet." % mid)
    elif err == "Forbidden":
        # a kikenyszerito allasban egy nem letezo uzenet is ide jut: a tulajdonosa ismeretlen
        print("FAIL: a %d uzenet nem a tied, vagy nem letezik: %s" % (mid, m.get("reason", "")))
    else:
        print("FAIL: varatlan valasz: %s" % raw[:200])
    raise SystemExit(1)
print("%d | %s -> %s | %s | %s" % (
    m["id"], m.get("from_agent"), m.get("to_agent"), m.get("status"),
    time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m.get("created_at", 0)))))
print("-" * 78)
print(m.get("content") or "(ures)")
r = m.get("result")
if r:
    print("-" * 78)
    print("EREDMENY (a lezaraskor irt nyugta, teljes szoveg):")
    print(r)
'
    ;;
  message-status)
    ID="${1:?message id required}"
    # A cimzett letezese az EGYETLEN gepileg ellenorizheto megkulonbozteto jel egy
    # `done` uzenetnel: a status maga nem arulja el, hogy a cimzett dolgozta-e fel,
    # vagy valaki mas vonta vissza. (Korall merte 2026-08-18: a figyelmezteto szoveg
    # onmagaban minden done-ra kiirodik, tehat par het alatt hattérzaj lesz -- ez a
    # sor viszont CSAK akkor szolal meg, ha tenyleg baj van.)
    AGENTS_JSON="$(curl -s -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "${API}/agents" 2>/dev/null || true)"
    # A LEKERDEZES AZ AZONOSITOVAL MEGY, NEM ABLAKKAL (javitva 2026-09-08 21:15).
    # Addig ez a parancs a szures nelkuli /messages listat nezte, amit a szerver 200
    # sornal vag -- tehat MINDEN ennel regebbi azonositora azt felelte, hogy "nincs az
    # utolso 200-ban", mikozben a sor ott allt az adatbazisban. Ket agens ezt a RENDSZER
    # korlatjanak vette ("a regi uzenetek idejet nem lehet lemerni"), pedig csak a parancs
    # nezett rossz helyre. Az uj /api/messages/<id> vegpont egy sort ad, ablak nelkul.
    get "/messages/${ID}" | MSG_ID="$ID" AGENTS_JSON="$AGENTS_JSON" MAIN_AGENT="${MAIN_AGENT_ID:-acrobot}" python3 -c '
import json, os, sys, time
mid = int(os.environ["MSG_ID"])
d = json.load(sys.stdin)
# A 404 TORZSE IS TARTALMAZZA AZ id MEZOT ({"error": ..., "id": 99999999}), tehat az
# id egyezese ONMAGABAN nem bizonyitja, hogy uzenetet kaptunk. Merve 2026-09-08 21:17,
# egy nem letezo azonositoval: az elso alak egy KITALALT sort irt ki (None -> None) es
# 0-val tert vissza. A "status" megletet kerjuk, mert azt csak valodi sor viseli.
m = d if isinstance(d, dict) and d.get("id") == mid and d.get("status") and not d.get("error") else None
if m is None:
    print("FAIL: nincs %d azonositoju uzenet (a szerver valasza: %s)" % (mid, json.dumps(d)[:200]))
    raise SystemExit(1)
print("%d | %s -> %s | %s | letrehozva %s" % (
    m["id"], m.get("from_agent"), m.get("to_agent"), m.get("status"),
    time.strftime("%H:%M:%S", time.localtime(m.get("created_at", 0)))))
# A status a lenyeg, ezert kulon is kimondjuk, mit jelent.
s = m.get("status")
print({"pending":   "MEG NEM ALL RAJTA A KEZBESITES. Frissen kuldott uzenetnel varj fel percet es kerdezd ujra:\n           a router elobb beirja a cimzett sessionjebe, a statuszt csak utana allitja at.\n           Ha percek mulva is pending: a cimzett foglalt, engedelykeresen all, vagy betelt a kontextusa.",
       "delivered": "MEGKAPTA. Ez az, amire hivatkozni lehet.",
       "done":      "LEZARVA -- de NEM feltetlenul a cimzett zarta le. A `done`-t barki\n           beallithatja a PUT /api/messages/<id> hivassal (a fougens is, pl. ha\n           visszavon egy elavult vagy kezbesithetetlen uzenetet). Ha van alatta\n           EREDMENY sor, azt olvasd el: az mondja meg, ki es miert zarta le.",
       "failed":    "NEM KAPTA MEG, es a probalkozas veget ert."}.get(s, "ismeretlen statusz: %s" % s))
# A result mezo az egyetlen hely, ahol a lezaras INDOKA all. `done`-nal ez donti el,
# hogy a cimzett dolgozta-e fel, vagy valaki mas vonta vissza. (Korall merte 2026-08-18:
# a "MEGKAPTA es lezarta" szoveg egy kezbesithetetlen uzenetre is kiirodott.)
r = m.get("result")
if r:
    _r = str(r).replace("\n", " ")
    if len(_r) > 300:
        print("EREDMENY (LEVAGVA: %d karakterbol az elso 300 latszik): %s" % (len(_r), _r[:300]))
        print("           A TELJES SZOVEG NEM EZEN AZ UTON JON. Kerd el a kuldotol uzenetben,")
        print("           vagy olvasd ki a GET /api/messages valaszabol a result mezot.")
    else:
        print("EREDMENY: %s" % _r)
# Gepileg ellenorizheto jel: letezik-e egyaltalan a cimzett. Ha nem, a status
# BARMI is, az uzenet SOHA nem jutott el emberi/agens olvasohoz.
try:
    _a = json.loads(os.environ.get("AGENTS_JSON") or "[]")
    _a = _a if isinstance(_a, list) else _a.get("agents", [])
    known = [str(x.get("name") or x.get("id")) for x in _a if (x.get("name") or x.get("id"))]
except Exception:
    known = []
# A fougens sosem szerepel az /api/agents listaban (pull-modellel kapja az uzeneteit),
# ezert kezzel hozza kell venni, kulonben minden neki szolo uzenetre hamisan riasztunk.
if known:
    known.append(os.environ.get("MAIN_AGENT") or "acrobot")
to = m.get("to_agent")
if known and to and to not in known:
    print("FIGYELEM: a cimzett (%s) NEM letezo agens. Az ismertek: %s." % (to, ", ".join(known)))
    print("          Ez az uzenet nem jutott el senkihez, fuggetlenul a statusztol.")
    print("          Ami EMBERNEK szol (Balazs, Luca), azt a fougensnek kell kuldeni, megnevezve a cimzettet.")
'
    ;;
  messages-sent)
    : "${1:?agent required}"; AGENT="$(arg "$1")"; LIMIT="${2:-10}"
    # Az agens SAJAT beszelgetese (kuldott es kapott, a szerver legfeljebb 200 sort ad), nem a
    # flotta utolso uzenetei: azok egy alagens tokenjevel nem a hivo sajatjai, a kikenyszerites
    # 403-at adna (P0-1, 2026-10-16). A szures a feladora ugyanugy itt tortenik.
    get "/messages?agent=${AGENT}&limit=200" | MSG_AGENT="$AGENT" MSG_LIMIT="$LIMIT" python3 -c '
import json, os, sys, time
agent = os.environ["MSG_AGENT"]; limit = int(os.environ["MSG_LIMIT"])
d = json.load(sys.stdin)
if isinstance(d, dict) and d.get("error"):
    # egy 403 vagy 400 ne latsszon "nincs kimeno uzenet"-nek
    print("FAIL: %s %s" % (d.get("error"), d.get("reason", ""))); raise SystemExit(1)
rows = d if isinstance(d, list) else d.get("messages", d.get("data", []))
mine = [r for r in rows if r.get("from_agent") == agent]
mine.sort(key=lambda r: r.get("id", 0), reverse=True)
# A lista SZANDEKOSAN rovidit, de a rovidites LATSZODJON: egy jeloletlen levagas
# felbehagyott mondatnak nez ki, es az olvaso azt hiszi, ennyi volt az uzenet.
# (Murena merte 2026-08-25 a result mezon: a csonkolast elhallgatasnak olvasta.)
def _cut(s, n):
    return s if len(s) <= n else s[:n - 3] + "..."
mine = mine[:limit]
if not mine:
    print("nincs kimeno uzenet ettol: %s" % agent); raise SystemExit(0)
for m in mine:
    print("%5d | -> %-12s | %-9s | %s | %s" % (
        m["id"], m.get("to_agent"), m.get("status"),
        time.strftime("%H:%M", time.localtime(m.get("created_at", 0))),
        _cut((m.get("content") or "").replace("\n", " "), 56)))
pend = [m["id"] for m in mine if m.get("status") == "pending"]
print()
print("kezbesitetlen (pending): %d %s" % (len(pend), pend if pend else ""))
if pend:
    print("EZEKET NEM KAPTA MEG A CIMZETT. Ne jelentsd oket atadottkent.")
# A LATOHATAR KIIRASA. A lekerdezes limit=200-at ker (a szerver ennel tobbet nem ad),
# es a szures a KAPOTT ablakon belul fut. Ami az ablak ELE esik, az egyszeruen nem latszik --
# jelzes nelkul. Murena merte 2026-08-27: a helper 41 sajat uzenetet mutatott neki, a
# legregebbi lathato 5227-es azonositoval, holott aznap a 5118-cal kezdett. Aki egy REGEBBI
# uzenetrol akarja megtudni, elment-e, HAMIS NEGATIVOT kap: nem latja, es azt hiszi, nincs.
# Ezert a lista vegen ott all, meddig lat vissza. A szam nem korlatozza a valaszt, csak
# megnevezi, mire vonatkozik.
if rows:
    oldest = min(r.get("id", 0) for r in rows)
    print()
    print("LATOHATAR: ez a lista %s utolso %d uzenetet nezte at (kuldott es kapott), a legregebbi benne: %d."
          % (agent, len(rows), oldest))
    print("           Ennel REGEBBI sajat uzenet NEM latszik itt, es a hianya nem bizonyitek.")
    print("           Egy konkret regebbi uzenetet a message-status <id> paranccsal kerdezz le.")
'
    ;;
  inbox)
    # A SAJAT BEJOVO SOR, ujak elol.
    #
    # MIERT LETEZIK (murena merese, 2026-09-08): a lapjan ket hete allt egy szabaly --
    # "mielott egy megkapott utasitas alapjan cselekszem vagy jelentek, nezzem meg, jott-e
    # ujabb uzenet ugyanarrol" --, es melle az volt irva, hogy "egy hivas (inbox.sh)".
    # AKKOR nem letezett ilyen szkript sehol, es ez a sor eredetileg ugy szolt, hogy "soha
    # nem is volt". AZ MA MAR HAMIS: murena 2026-09-08-an megirta a sajatjat
    # (agents/murena/scripts/inbox.sh), es hasznalja is. A megjegyzes tehat datumozott
    # allitas, nem orok igazsag -- 2026-09-21-en mertem vissza. A `messages-sent` azt mutatja, amit
    # O kuldott; a `message-read` es a `message-status` ismert azonositot ker. A sajat sorat
    # tehat nem tudta vegignezni, mikozben a szabaly VEGREHAJTHATONAK LATSZOTT.
    #
    # ES A KEPESSEG VEGIG MEGVOLT: a `/api/messages?agent=<nev>` vegpont mind a ket iranyt
    # adja. Nem hozzaferes hianyzott es nem jogosultsag, hanem az, hogy a vegpont es a
    # felulet kulon-kulon jo volt, es senki nem kotoette ossze oket.
    #
    # Az ara nem egy hianyzo parancs volt, hanem egy HAMIS SZABALY: murena ket hetig hitte,
    # hogy van lepese, amivel ellenorizhet. Egy szabaly, aminek nincs eszkoze, rosszabb a
    # hianyzo szabalynal, mert megnyugtat.
    # ===================================================================================
    # A LATOHATAR NEM FAL, HANEM LAP -- ES EZ EGY ORAN BELUL A HARMADIK ELOFORDULASA
    # ANNAK, HOGY A KEPESSEG MEGVOLT ES A PARANCS NEM (barracuda merese, 2026-09-08 05:40).
    #
    # Az elso valtozat `limit=500`-at kert, a szerver 200-nal vag, es a lista ala odairtam,
    # hogy ennel regebbi "nem latszik". Barracuda ezt lemerte KET regi azonositoval (13895,
    # 14006), ISMERT POZITIV KONTROLLAL egyutt (a 15031-re valaszt kapott, tehat a parancs
    # mukodik) -- es azt is megmerte, hogy AZ ABLAK CSUSZIK: negy perc alatt 14834-rol
    # 14838-ra mozdult, a flotta forgalmaval egyutt.
    #
    # EN EBBOL AZT MONDTAM NEKI, hogy ami a listabol kiesett, azt egyedi lekerdezessel meg
    # meg lehet nezni. TEVEDTEM: a `message-status` UGYANAZT a szures nelkuli ablakot nezi.
    # O visszamerte, mielott rahagyatkozott volna, es a mondatom megdolt.
    #
    # DE A BELOLE LEVONT KOVETKEZTETES ("utolag nem lehet visszamenni") SEM ALL, es ezt en
    # mertem meg utana: a `/api/messages` vegpont ismer `before` kurzort -- CSAK az `agent`
    # parameterrel egyutt (a szures nelkuli ag a route-ban eldobja). Az `agent=X&before=N`
    # alakkal tetszolegesen visszalapozhato a sor: a 13895 igy MEGVAN, es a lap ablaka
    # (13177 .. 13895) is kiirodik.
    #
    # Vagyis harmadszor ugyanaz: nem hozzaferes hianyzott es nem jogosultsag, hanem hogy
    # senki nem adta at a kurzort a parancsnak. Ezert a harmadik argumentum.
    #
    # AMI EBBOL NYITVA MARADT, MA ESTE LEZARULT (2026-09-08 21:15). A `message-status`
    # tobbe NEM ablakot nez: a sajat azonositojaval kerdez, a most felvett
    # GET /api/messages/<id> vegponton. Egy sor, amit az id azonosit, nem tud kiesni egy
    # ablakbol, amit nem hasznal. A negyedik elofordulas ugyanabbol a csaladbol: az adat
    # megvolt, a parancs nezett rossz helyre.
    # A `message-read` tovabbra is a szures nelkuli agon fut, es ott a `before` valoban
    # nem szamit -- de az mar nem ad hamis negativot, mert ismert azonositot ker.
    # ===================================================================================
    argc_max 3 "$#" "fleet-api.sh inbox <agent> [limit] [before-azonosito]"
    : "${1:?agent required}"; AGENT="$(arg "$1")"; LIMIT="${2:-15}"
    BEFORE="${3:-}"
    QS="/messages?agent=${AGENT}&limit=200"
    [ -n "$BEFORE" ] && QS="${QS}&before=${BEFORE}"
    get "$QS" | MSG_AGENT="$AGENT" MSG_LIMIT="$LIMIT" python3 -c '
import json, os, sys, time
agent = os.environ["MSG_AGENT"]; limit = int(os.environ["MSG_LIMIT"])
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get("messages", d.get("data", []))
mine = [r for r in rows if r.get("to_agent") == agent]
mine.sort(key=lambda r: r.get("id", 0), reverse=True)
def _cut(s, n):
    return s if len(s) <= n else s[:n - 3] + "..."
latszik = mine[:limit]
if not latszik:
    print("nincs bejovo uzenet ide: %s" % agent)
else:
    for m in latszik:
        print("%5d | <- %-12s | %-9s | %s | %s" % (
            m["id"], m.get("from_agent"), m.get("status"),
            time.strftime("%H:%M", time.localtime(m.get("created_at", 0))),
            _cut((m.get("content") or "").replace("\n", " "), 56)))
    print()
    print("A TELJES SZOVEG: fleet-api.sh message-read <id> -- a fenti sorok 56 karakteren")
    print("vagnak, es egy levagott mondat mast allithat, mint a teljes.")
# A NYITOTT TETELEK KULON, mert a lista maga nem valaszol arra, mi maradt kezeletlenul.
# A `done` az EGYETLEN allapot, ami lezarast jelent (a message-close teszi ra); a
# `delivered` csak annyit mond, hogy megerkezett a panelbe.
nyitott = [m["id"] for m in mine if m.get("status") != "done"]
print()
print("NEM LEZART bejovo (a teljes latott ablakban): %d" % len(nyitott))
if nyitott:
    print("  %s" % nyitott[:30])
    print("  A `delivered` NEM lezaras: azt jelenti, hogy megkaptad, nem hogy elintezted.")
# UGYANAZ A LATOHATAR, MINT A messages-sent AGON, es ugyanabbol az okbol: a szures a
# KAPOTT ablakon belul fut, es ami ele esik, jelzes nelkul hianyzik.
if rows:
    oldest = min(r.get("id", 0) for r in rows)
    print()
    print("LATOHATAR: ez a lap a te %d uzeneted nezte at, a legregebbi benne: %d." % (len(rows), oldest))
    print("           Ennel REGEBBI itt NEM latszik, es a hianya nem bizonyitek --")
    print("           DE VISSZA LEHET LAPOZNI, nem fal:")
    print("             fleet-api.sh inbox %s %d %d" % (agent, limit, oldest))
    print("           Ismeteld, amig a lap ki nem urul. Az ablak a flotta forgalmaval CSUSZIK,")
    print("           tehat ugyanaz a hivas ot perc mulva mar mashonnan indul.")
'
    ;;
  # 2026-08-23: azert kerult ide, hogy a store/ mappa olvasasat MEG LEHESSEN tiltani az
  # agenseknek. Amig az utemezes es a jovahagyas csak nyers curl-lel ment, minden agens
  # CLAUDE.md-je eloirta a token kozvetlen felolvasasat, tehat a tiltas nem szabalyt hozott
  # volna, hanem torest. Egy tiltas, ami a normal mukodest vagja el, nem vedelem.
  schedule-new)
    argc_max 6 "$#" "fleet-api.sh schedule-new <nev> \"leiras\" - < prompt.txt \"<cron>\" <agent> [type]"
    : "${1:?name required}"; NAME="$(arg "$1")"; : "${2:?description required}"; DESC="$(arg "$2")"
    : "${3:?prompt required}"; PROMPT="$(arg "$3")"; : "${4:?cron required}"; CRON="$(arg "$4")"
    : "${5:?agent required}"; AGENT="$(arg "$5")"; TYPE="${6:-heartbeat}"
    BODY="$(NAME="$NAME" DESC="$DESC" PROMPT="$PROMPT" CRON="$CRON" AGENT="$AGENT" TYPE="$TYPE" python3 -c '
import json, os
print(json.dumps({
    "name": os.environ["NAME"], "description": os.environ["DESC"],
    "prompt": os.environ["PROMPT"], "schedule": os.environ["CRON"],
    "agent": os.environ["AGENT"], "type": os.environ["TYPE"],
}))')"
    post "/schedules" "$BODY"
    ;;
  # A LEJARAT NEM ADHATO MEG HIVASKOR, es ezert nincs is ilyen argumentum. Merve 2026-08-23:
  # a szerver (src/web/routes/approvals.ts, getTimeoutAt) a lejaratot a KATEGORIABOL veszi, a
  # store/autonomy-config.json timeout_minutes mezojebol; a torzsben kuldott timeout_seconds
  # erteket FIGYELMEN KIVUL HAGYJA. Ha a kategoria nincs a configban, a timeout_at NULL lesz,
  # tehat a keres soha nem jar le magatol. Egy argumentum, ami nem hat, rosszabb a hianyanal:
  # azt sugallja, hogy allitottunk egy hatarido, holott nem.
  approval-new)
    argc_max 3 "$#" "fleet-api.sh approval-new <agent> <kategoria> - < leiras.txt"
    : "${1:?agent required}"; AGENT="$(arg "$1")"; : "${2:?category required}"; CATEGORY="$(arg "$2")"
    : "${3:?action_description required}"; DESC="$(arg "$3")"
    BODY="$(AGENT="$AGENT" CATEGORY="$CATEGORY" DESC="$DESC" python3 -c '
import json, os
print(json.dumps({
    "agent_id": os.environ["AGENT"], "category": os.environ["CATEGORY"],
    "action_description": os.environ["DESC"],
}))')"
    post "/approvals" "$BODY"
    ;;
  approval-get)
    : "${1:?approval id required}"; ID="$(arg "$1")"
    get "/approvals/${ID}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("id: %s | status: %s" % (d.get("id"), d.get("status")))
# az approvals tabla resolved_at (epoch masodperc) es resolved_by mezot tarol; a
# korabbi decided_at kulcs sosem letezett, ezert a dontes ideje sosem latszott
# (barracuda, #36)
if d.get("resolved_at"):
    import datetime
    mikor = datetime.datetime.fromtimestamp(int(d["resolved_at"])).astimezone()
    print("dontes ideje: %s" % mikor.strftime("%Y-%m-%d %H:%M:%S %z"))
if d.get("resolved_by"):
    print("dontott: %s" % d.get("resolved_by"))
if d.get("action_description"):
    print("mit kert: %s" % d.get("action_description"))
'
    ;;
  *)
    echo "FAIL: unknown command '$CMD' (memory|memory-search|daily-log|daily-log-now|daily-log-read|kanban-list|kanban-keres|kanban-new|kanban-move|kanban-assign|kanban-cim|kanban-comment|kanban-comments|kanban-archive|inbox|message-status|messages-sent|schedule-new|approval-new|approval-get|message-close|message-read|agent-restart|kiadas|deployed|task-project|project-repo)"
    exit 1
    ;;
esac
