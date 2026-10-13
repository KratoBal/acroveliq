#!/usr/bin/env bash
# ANSWERS: Hogyan kerul egy kesz vazlat az Acropora OS Tartalom menujebe, atnezesre varva.
#
# MIERT LETEZIK (merve 2026-09-03): a gepi ut aznap 12 ora 00 perckor bizonyult mukodonek,
# es az elso nyolc tetelt EN vittem be kezzel, mert a tokent csak a marveen felhasznalo
# olvashatja. Ez engem tett szuk keresztmetszette: korall het kesz tetelt adott le tizenot
# perc alatt, es mindegyik egy-egy koromet vitte el. Ez a szkript ugyanazt a mintat koveti,
# mint az unas.sh es a medusa-stage.sh: a KULCS a szkriptben marad, a HIVO nem latja.
#
# HASZNALAT (a torzs FAJLBOL jon, atiranyitassal -- lasd lentebb, miert):
#   bash /home/marveen/marveen/scripts/tartalom.sh "A CIM" OTHER < torzs.md
#   bash /home/marveen/marveen/scripts/tartalom.sh "A CIM" ARTICLE torzs.md
#
# CSATORNA, pontosan egy ezek kozul (a szerver ezt ellenorzi, nem mi):
#   FACEBOOK_POST | FACEBOOK_AD | ARTICLE | OTHER
#
# AMI LETREJON: egy tetel AWAITING_REVIEW allapotban. A gepi szerep (CONTENT_AGENT) ket
# jogot ad, olvasast es letrehozast. JOVAHAGYNI NEM TUD, es ez szandekos.
#
# BIZTONSAG, es mindharom szerkezeti, nem igeret:
#   - A host HARDCODED. Nem allithato at kifele mutato csatornava.
#   - CSAK a /content/agent utvonalra megy keres, KET igevel: POST (beadas) es PATCH
#     (egy MAR beadott tetel szovegenek javitasa, lasd a JAVITAS szakaszt lentebb).
#     Nincs DELETE, nincs jovahagyo ut, es nincs mas utvonal.
#   - A token sosem kerul a kimenetbe, sem a hibauzenetbe.
#
# EZ A SOR 2026-09-07-ig AZT ALLITOTTA, hogy "CSAK POST, nincs mas ige" -- akkor is,
# amikor a PATCH ag mar ket napja bent allt (2026-09-04 este). Murena merte vissza es
# szolt. A javitas nem stilus: egy BIZTONSAGI allitas, ami tobbet iger, mint ami all,
# rosszabb a hianyanal, mert epp azt az olvasot teveszti meg, aki ellenorizni akarja,
# mit tud a szkript. Ha az igek koze uj kerul, EZ A SOR VALTOZIK ELOSZOR.
#
# A TORZS MIERT NEM MEHET PARANCSSORON (harom mert eset, mind a flotta sajat lapjan all):
#   idezojel -> a bash lezarja a stringet, es a helper CSONKA szoveget kuld, zold nyugtaval;
#   ${VALTOZO} vagy backtick -> a szoveg TELJES es ERTELMES marad, csak MAST mond;
#   es a fajl utolag OSSZEVETHETO azzal, ami bement -- egy heredoc ezt nem hagyja hatra.
#
# ARITY-ORZO: ez a parancs PONTOSAN ket vagy harom argumentumot ismer. Egy negyedik
# argumentum a legvaloszinubben azt jelenti, hogy a cim idezojelei szetestek -- olyankor a
# regi alak CSONKA cimet kuldott volna el, HTTP 201-gyel, es senki nem vette volna eszre.
set -uo pipefail

HOST=https://api.acropora.hu
ENDPOINT=/content/agent
TOKEN_FILE=/home/marveen/marveen/store/.content-agent-token
CHANNELS="FACEBOOK_POST FACEBOOK_AD ARTICLE OTHER"

usage() {
  echo "HASZNALAT:" >&2
  echo "  BEADAS:" >&2
  echo "    tartalom.sh \"A CIM\" <CSATORNA> < torzs.md" >&2
  echo "    tartalom.sh \"A CIM\" <CSATORNA> torzs.md" >&2
  echo "  JAVITAS (egy MAR beadott tetel szovegen):" >&2
  echo "    tartalom.sh javit <ID> uj-torzs.md" >&2
  echo "    tartalom.sh javit-cim <ID> uj-cim.txt" >&2
  echo "CSATORNA: $CHANNELS" >&2
}

# ============================================================================
# JAVITAS -- PATCH /content/agent/:id
#
# MIERT LETEZIK (merve 2026-09-04 este): korall huszonket MAR BEADOTT
# termekleirasaban osszesen negyven helyen belso jegyzet allt a VEVONEK szant
# cellaban. A lanc a boltba vezet, tehat a jegyzet a termeklapon jelent volna
# meg. Javitani viszont SEMMILYEN uton nem lehetett: ez a szkript egyetlen
# iget ismert, es a szerveren sem volt modosito metodus -- se gepi, se emberi.
# Balazs dontese aznap este, szo szerint: "Masodik", vagyis epuljon a bejarat.
#
# A CIM IS FAJLBOL JON, ES EZ SZANDEKOS ELTERES A BEADASTOL. A beadasnal a cim
# a parancssoron megy, arity-orzovel -- az egy regi kompromisszum. Uj uton nem
# ismeteljuk meg: ami szoveg, az nem megy at a shellen.
#
# A 409 KET KULONBOZO DOLGOT JELENT, ES KET KULONBOZO TEENDO TARTOZIK HOZZAJUK.
# Ugyanaz a statuszkod, tehat a szovegbol kell szetvalasztani, es a hivonak meg
# kell mondani, MELYIKET kapta -- kulonben ujraprobal ott, ahol nem szabad.
# ============================================================================
revise() {
  local MODE="$1" ID="$2" SRC="$3"

  [ -r "$SRC" ] || { echo "FAIL: nem olvashato fajl: $SRC" >&2; exit 2; }
  [ -r "$TOKEN_FILE" ] || { echo "FAIL: nincs olvashato token ($TOKEN_FILE)" >&2; exit 1; }

  local TMP
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT

  MODE="$MODE" SRC="$SRC" python3 - > "$TMP" <<'PY'
import json, os, sys
with open(os.environ["SRC"], encoding="utf-8", errors="replace") as fh:
    text = fh.read()
mode = os.environ["MODE"]
if mode == "javit-cim":
    # A cim egysoros mezo: a fajl vegen allo sortores a szerkeszto nyoma, nem
    # tartalom. A torzsnel viszont NEM vagunk, mert ott a zaro ures sor a
    # szoveg resze lehet.
    text = text.strip()
    if not text:
        sys.stderr.write("FAIL: a cim-fajl ures.\n")
        raise SystemExit(2)
    sys.stdout.write(json.dumps({"title": text}, ensure_ascii=False))
else:
    if not text.strip():
        sys.stderr.write("FAIL: a torzs ures.\n")
        raise SystemExit(2)
    sys.stdout.write(json.dumps({"body": text}, ensure_ascii=False))
PY
  local BUILD_RC=$?
  [ "$BUILD_RC" -eq 0 ] || exit "$BUILD_RC"

  local OUT CODE RESP
  OUT="$(/usr/bin/curl -s -w '\n%{http_code}' -X PATCH \
    -H "Content-Type: application/json" \
    -H @<(printf 'Authorization: Bearer %s\n' "$(/bin/cat "$TOKEN_FILE")") \
    --data-binary @"$TMP" \
    "$HOST$ENDPOINT/$ID" 2>&1)"

  CODE="$(printf '%s' "$OUT" | /usr/bin/tail -n1)"
  RESP="$(printf '%s' "$OUT" | /usr/bin/head -n-1)"

  if [ "$CODE" = "200" ]; then
    ID="$ID" TARTALOM_FORRAS="$SRC" printf '%s' "$RESP" | ID="$ID" TARTALOM_FORRAS="$SRC" python3 -c '
import json, os, sys, time
try:
    d = json.load(sys.stdin)
except ValueError:
    print("FAIL: 200 jott, de a valasz nem JSON. NE tekintsd javitottnak.")
    raise SystemExit(1)
if not d.get("id"):
    print("FAIL: 200 jott, de nincs id a valaszban: %s" % json.dumps(d)[:300])
    raise SystemExit(1)
kommentek = d.get("comments") or []
print("OK  javitva id=%s  allapot=%s  cim=%s" % (
    d["id"], d.get("state", "?"), d.get("title", "")))
# A NYOM UGYANABBAN A TRANZAKCIOBAN SZULETIK, mint a javitas (murena merese).
# Ha megsem all ott, azt ki kell mondani: egy javitas nyom nelkul pontosan az,
# amit ez az ut meg akart szuntetni.
if kommentek:
    print("    nyom: %s" % (kommentek[-1].get("body", "")[:160].replace("\n", " ")))
else:
    print("    FIGYELEM: a javitas megtortent, de NYOM nem jott vissza a valaszban.")
try:
    with open(os.environ.get("TARTALOM_LEDGER",
              "/home/marveen/marveen/store/tartalom-beadva.tsv"),
              "a", encoding="utf-8") as fh:
        fh.write("%s\t%s\tJAVITAS\t%s\t%s\n" % (
            time.strftime("%Y-%m-%d %H:%M:%S"), d["id"],
            os.environ.get("TARTALOM_FORRAS", "-"), d.get("title", "")))
except OSError as err:
    print("FIGYELEM: a javitas MEGTORTENT, de a naplozas elhasalt: %s" % err)
'
    exit $?
  fi

  echo "FAIL: HTTP $CODE" >&2
  printf '%s\n' "$RESP" | /usr/bin/head -c 600 >&2
  echo >&2
  case "$CODE" in
    400) echo "  -> a szerver visszautasitotta a TARTALMAT. Gyakori ok: a szoveg AZONOS a mostanival." >&2 ;;
    401) echo "  -> a token nem ervenyes. Ez NEM jogosultsag-bovitessel oldodik: mas token kell." >&2 ;;
    404)
      # KET KULONBOZO 404, ES A KULONBSEG A KOVETKEZO LEPEST DONTI EL. Ha a
      # tetel hianyzik, rossz az azonosito. Ha maga az UTVONAL nincs meg, akkor
      # a vegpont beolvadt, de MEG NINCS TELEPITVE -- es az varakozas, nem hiba.
      case "$RESP" in
        *"tartalom nem"*) echo "  -> ez a tetel nem letezik. Ellenorizd az azonositot." >&2 ;;
        *) echo "  -> a vegpont MAGA nincs meg ezen a kiszolgalon. Valoszinuleg beolvadt, de meg nincs telepitve." >&2 ;;
      esac
      ;;
    409)
      case "$RESP" in
        *"llapotban van"*)
          echo "  -> EMBER DONTOTT rola: a tetel tul van azon az allaponton, ahol gepi javitas indulhat." >&2
          echo "     NE probald ujra. A javitas innentol emberi uton mehet." >&2 ;;
        *"zben megv"*)
          echo "  -> VERSENYHELYZET: a lekerdezes es az iras kozott mozdult az allapot." >&2
          echo "     Kerdezd le ujra a tetelt, es a MAI allapot szerint dontsd el, mi legyen." >&2 ;;
        *) echo "  -> 409, de az alakja ismeretlen. Olvasd el a fenti valaszt, mielott ujraprobalsz." >&2 ;;
      esac
      ;;
    000) echo "  -> a kerés el sem jutott a szerverig (halozat vagy nev-feloldas)." >&2 ;;
  esac
  exit 1
}

case "${1:-}" in
  javit|javit-cim)
    if [ "$#" -ne 3 ]; then
      echo "FAIL: $# argumentum erkezett, a javitas PONTOSAN harmat ismer." >&2
      usage
      exit 2
    fi
    revise "$1" "$2" "$3"
    ;;
esac

if [ "$#" -lt 2 ]; then
  echo "FAIL: cim es csatorna kell." >&2
  usage
  exit 2
fi
if [ "$#" -gt 3 ]; then
  echo "FAIL: $# argumentum erkezett, ez a parancs kettot vagy harmat ismer." >&2
  echo "      A cim valoszinuleg szetesett az idezojeleknel. NEM kuldtem el semmit." >&2
  usage
  exit 2
fi

TITLE="$1"
CHANNEL="$2"
BODY_FILE="${3:-}"

case " $CHANNELS " in
  *" $CHANNEL "*) ;;
  *) echo "FAIL: ismeretlen csatorna: $CHANNEL" >&2; usage; exit 2 ;;
esac

[ -r "$TOKEN_FILE" ] || { echo "FAIL: nincs olvashato token ($TOKEN_FILE)" >&2; exit 1; }

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ -n "$BODY_FILE" ]; then
  [ -r "$BODY_FILE" ] || { echo "FAIL: nem olvashato torzs-fajl: $BODY_FILE" >&2; exit 2; }
  BODY_SRC="$BODY_FILE"
else
  # STDIN-rol jon. Ha a hivo elfelejtette atiranyitani, itt vegtelenul varna egy
  # terminalon -- ezert kimondjuk, mi tortenik, mielott olvasunk.
  if [ -t 0 ]; then
    echo "FAIL: a torzs sem fajlbol, sem STDIN-rol nem erkezett." >&2
    usage
    exit 2
  fi
  # ES ITT VOLT EGY HIBA 2026-09-07-ig, ami A DOKUMENTALT ELSODLEGES ALAKOT rontotta el.
  # Korabban BODY_SRC=/dev/stdin allt itt, es a lentebbi python a HEREDOC-bol kapja a sajat
  # stdin-jet -- vagyis mire megnyitotta a /dev/stdin-t, az mar NEM az atiranyitott fajl volt,
  # hanem a heredoc elfogyott maradeka. Eredmeny: a `tartalom.sh "CIM" OTHER < torzs.html`
  # alak MINDIG "a torzs ures" hibaval allt meg, barmilyen fajllal.
  # Szerencsere HANGOSAN bukott, nem csendben csonkitott -- de a "tartalom ne menjen at a
  # shellen" doktrina epp erre az alakra epul, tehat a szabaly kotelezo alakja volt torott.
  # A javitas: a STDIN-t ITT olvassuk ki egy valodi fajlba, MIELOTT a heredoc elindul.
  STDIN_COPY="$(mktemp)"
  trap 'rm -f "$TMP" "$STDIN_COPY"' EXIT
  /bin/cat > "$STDIN_COPY"
  BODY_SRC="$STDIN_COPY"
fi

TITLE="$TITLE" CHANNEL="$CHANNEL" BODY_SRC="$BODY_SRC" python3 - > "$TMP" <<'PY'
import json, os, sys
with open(os.environ["BODY_SRC"], encoding="utf-8", errors="replace") as fh:
    body = fh.read()
if not body.strip():
    sys.stderr.write("FAIL: a torzs ures.\n")
    raise SystemExit(2)
sys.stdout.write(json.dumps({
    "title": os.environ["TITLE"],
    "channel": os.environ["CHANNEL"],
    "body": body,
}, ensure_ascii=False))
PY
BUILD_RC=$?
[ "$BUILD_RC" -eq 0 ] || exit "$BUILD_RC"

export TARTALOM_FORRAS="${BODY_FILE:-stdin}"
OUT="$(/usr/bin/curl -s -w '\n%{http_code}' -X POST \
  -H "Content-Type: application/json" \
  -H @<(printf 'Authorization: Bearer %s\n' "$(/bin/cat "$TOKEN_FILE")") \
  --data-binary @"$TMP" \
  "$HOST$ENDPOINT" 2>&1)"

CODE="$(printf '%s' "$OUT" | /usr/bin/tail -n1)"
RESP="$(printf '%s' "$OUT" | /usr/bin/head -n-1)"

# A HTTP-KOD ES A VISSZAKAPOTT ID EGYUTT A BIZONYITEK, KULON-KULON EGYIK SEM. A curl
# nullaval ter vissza akkor is, ha a szerver elutasitotta a kerest -- ez a flotta egyik
# legregebbi mert csapdaja, es itt is all.
if [ "$CODE" = "201" ]; then
  printf '%s' "$RESP" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except ValueError:
    print("FAIL: 201 jott, de a valasz nem JSON. NE tekintsd elkuldottnek.")
    raise SystemExit(1)
if d.get("id") and d.get("state") == "AWAITING_REVIEW":
    print("OK  id=%s  allapot=%s  cim=%s" % (d["id"], d["state"], d.get("title", "")))
    # NAPLO, ES EZ NEM DISZ: 2026-09-04 hajnalban 156 kesz vazlat allt beadatlanul,
    # mert a beadasrol SEHOL nem keletkezett nyom. A visszakapott id csak a kimeneten
    # jelent meg, es a kovetkezo sessionben mar nem letezett. A tartalom API GET agan
    # 401 jon, tehat visszakerdezni sem lehet: ha itt nem irodik le, sehol nem all.
    import os, time
    try:
        with open(os.environ.get("TARTALOM_LEDGER",
                  "/home/marveen/marveen/store/tartalom-beadva.tsv"),
                  "a", encoding="utf-8") as fh:
            fh.write("%s\t%s\t%s\t%s\n" % (
                time.strftime("%Y-%m-%d %H:%M:%S"), d["id"],
                os.environ.get("TARTALOM_FORRAS", "-"), d.get("title", "")))
    except OSError as err:
        # A naplozas hibaja NEM teheti sikertelenne a beadast: az mar megtortent.
        # De nemán elnyelni sem szabad, mert epp az a hiany, amit javitunk.
        print("FIGYELEM: a beadas MEGTORTENT, de a naplozas elhasalt: %s" % err)
else:
    print("FAIL: 201 jott, de nincs id vagy nem AWAITING_REVIEW: %s" % json.dumps(d)[:300])
    raise SystemExit(1)
'
  exit $?
fi

echo "FAIL: HTTP $CODE" >&2
printf '%s\n' "$RESP" | /usr/bin/head -c 600 >&2
echo >&2
case "$CODE" in
  400) echo "  -> a szerver visszautasitotta a TARTALMAT (hianyzo cim vagy rossz csatorna)." >&2 ;;
  401) echo "  -> a token nem ervenyes. Ez NEM jogosultsag-bovitessel oldodik: mas token kell." >&2 ;;
  000) echo "  -> a kerés el sem jutott a szerverig (halozat vagy nev-feloldas)." >&2 ;;
esac
exit 1
