#!/usr/bin/env bash
# agent-msg.sh -- reliable inter-agent message send for the Marveen fleet.
#
# WHY: the common `curl -s ... >/dev/null && echo sent` pattern is DANGEROUS -- curl exits 0 even when
# the server REJECTED the request (401/400/5xx), producing a SILENT send failure: the recipient never
# gets the message and two agents can wait on each other forever. The /api/messages router itself is
# fine (HTTP 200 + a message id); the bug is that the SENDER never checks the result. This helper checks
# the HTTP status AND the returned message id, and RETRIES on failure. A message counts as sent only
# when an id came back.
#
# Usage:  bash scripts/agent-msg.sh [--felulir <msg_id>] [--task <task_id>] <from> <to> "<content>"
#   --task: link the message to a task (TC-Lite L3); it then shows on the task's timeline.
#   content: plain text (quotes / newlines OK) -- the body is built with json.dumps (no quoting pitfalls).
#   large / multi-line content may come from STDIN when the 3rd arg is "-":
#     echo "<long text>" | bash scripts/agent-msg.sh <from> <to> -
# Output: success -> "OK id=<n>"; failure -> "FAIL <reason>" + a line in store/agent-msg-failures.log, exit 1.
# Env: MARVEEN_WEB_PORT (default 3420).
set -uo pipefail

# base dir = the parent of this script's dir (scripts/..), so it works from any CWD / any install
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MARVEEN_WEB_PORT:-3420}"
# the calling user's own token if handed out, else the shared one, loudly (P0-1, plan 5.2)
if [ -r "$BASE/scripts/lib/dashboard-token.sh" ]; then
  . "$BASE/scripts/lib/dashboard-token.sh"
  TOKEN_FILE="$(dashboard_token_file "$BASE")"
else
  echo "dashboard-token: scripts/lib/dashboard-token.sh missing, using the shared token" >&2
  TOKEN_FILE="$BASE/store/.dashboard-token"
fi
URL="http://localhost:${PORT}/api/messages"
LOG="$BASE/store/agent-msg-failures.log"

# ARGUMENTUM-SZAM ORZO. A helper a HARMADIK argumentumot viszi tartalomkent, a tobbit eddig
# CSENDBEN eldobta. Ez azert veszelyes, mert van egy gyakori mod, ahogy egy ep uzenet TOBB
# argumentumra esik szet: ha a szovegben DUPLA IDEZOJEL all, es az egeszet dupla idezojelbe
# tesszuk a parancssorban, a bash az elso belso idezojelnel LEZARJA a stringet. Merve
# 2026-08-27 (murena): egy hatvan szavas uzenetbol hat argumentum lett, es a cimzett ennyit
# kapott: "elso resz, aztan a te". A kuldes kozben VEGIG zold maradt -- HTTP 200, OK id=5305,
# delivered allapot --, mert a helper a kezbesitest ellenorzi, a TARTALMAT nem, es nem is
# tudhatja, mit szantak neki. A jel viszont gepileg mereheto: TOBB MINT HAROM ARGUMENTUM.
# A helyes hivasokat nem erinti, azok mind harommal mennek. (nautilus javaslata, ugyanaznap.)
# ES A CSALAD TAGABB, MINT AZ IDEZOJEL: ugyanezen az estén nautilus tizenot naplobejegyzese
# ugy veszett el, hogy az idezojelei RENDBEN voltak, csak eggyel tobb argumentumot adott at,
# mint amennyit a parancs olvas. Ezert ez ARITY-orzo, nem idezojel-orzo: barmely helper, ami
# rogzitett poziciokat olvas, csendben eldobja a tobbit, es a jel mindket okra ugyanaz.
# ES AMI TULMEGY AZ ORZO HATARAN, hogy ne higgyuk tobbnek, mint ami: ez CSONKULAST fog meg,
# BEHELYETTESITEST nem. Ha a szovegben ${VALTOZO} vagy backtick all, az argumentumszam NEM no,
# tehat itt semmi nem szolal meg -- a cimzett teljes, ertelmes mondatot kap, csak MASIKAT.
# Merve 2026-08-27 (murena leletebol, visszamerve): "az utvonal ${BASE}/owners alakban all"
# ugy erkezett meg, hogy "az utvonal /home/marveen/marveen/owners alakban all". Technikai
# szoveget ezert akkor is STDIN-rol kell kuldeni, ha rovid es nincs benne idezojel.
# === --felulir <msg_id> : EGY VISSZAVONT DONTES MEGNEVEZI, MIT IR FELUL ===
#
# MIERT LETEZIK (murena kerese, 2026-09-08 06:14, sajat mert esetembol):
# egy uzenet KETORAS keseessel is megerkezhet (murena ot esetet mert: 115 es 146
# perc kozott). Ha kozben visszavonok egy dontest, a cimzett KET indokot lat,
# EGYFORMAN hihetot, es csak a kuldesi idobol tippelhet. A tartozek-doboznal ez
# elo is allt: a 14898 es a 14941 ellentmondott egymasnak.
#
# A 14941-ben odairtam, MELYIK uzenetet irja felul, es murena epp ezert tudta
# eldonteni, melyik az ervenyes. Ez akkor eszembe jutott -- de "eszembe jut" nem
# szabaly. Ezert kapcsolo lett belole.
#
# ES AMIT EZ SZANDEKOSAN NEM CSINAL: nem ellenorzi, hogy a hivatkozott uzenet
# letezik-e, es nem is jelöli meg amazt. A sor egy ALLITAS, amit en teszek --
# annyit er, amennyit a kuldo hozzatesz. A cimzettnek viszont van mire
# visszakeresnie, es ez a kulonbseg a tippeleshez kepest.
# === --task <task_id> : AZ UZENET A FELADATHOZ KOTVE (TC-Lite L3) ===
# A dashboard a task_id-t eltarolja, es az uzenet megjelenik a feladat idovonalan
# (GET /api/tasks/<task>/timeline). Az alak ugyanaz, mint a futtato feladat-nevee
# (scripts/futtat.py SAFE_NAME): szabad szoveg nem lehet, a szerver 400-zal elutasitja.
# A ket kapcsolo barmely sorrendben jöhet, a from/to/content ELOTT.
FELULIR=""
TASK=""
while :; do
  case "${1:-}" in
    --felulir)
      FELULIR="${2:?--felulir utan msg_id kell}"
      case "$FELULIR" in
        ''|*[!0-9]*) echo "FAIL: a --felulir utan szam (msg_id) all, ez erkezett: $FELULIR" >&2; exit 1 ;;
      esac
      shift 2
      ;;
    --task)
      TASK="${2:?--task utan feladat-azonosito kell}"
      if ! [[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]]; then
        echo "FAIL: a --task utan feladat-azonosito all (betu, szam, . _ -), ez erkezett: $TASK" >&2; exit 1
      fi
      shift 2
      ;;
    *) break ;;
  esac
done

if [ "$#" -gt 3 ]; then
  echo "FAIL: $# argumentum erkezett, de az agent-msg.sh harmat ismer (from, to, content)." >&2
  echo "  Ket oka lehet, es mindketto CSENDBEN dobta volna el a tobbit:" >&2
  echo "    (1) a szoveg szetesett egy dupla idezojelnel," >&2
  echo "    (2) eggyel tobb argumentumot adtal at, mint amennyit a helper olvas." >&2
  echo "  A helyes alak: bash scripts/agent-msg.sh <from> <to> - < uzenet.txt" >&2
  exit 1
fi

FROM="${1:?from required}"; TO="${2:?to required}"; C="${3:?content required (or - for STDIN)}"

# BEHELYETTESITES-ORZO AZ INLINE ALAKRA (murena javaslata, 2026-09-01 17:48).
#
# Az arity-orzo fenti fejlece maga mondja ki, hogy a CSONKULAST fogja meg, a
# BEHELYETTESITEST nem -- es hogy technikai szoveget ezert STDIN-rol kell kuldeni. Ez a
# mondat 2026-08-27 ota all ott, es 2026-09-01-en acrobot KETSZER futott bele ugyanabba,
# harom oraval azutan, hogy ugyanezt a szabalyt felirta mind a het agens lapjara. Egyszer
# egy operator neve tunt el a szovegbol, egyszer egy mezonev.
#
# MIERT NEM ELEG A SZABALY, es miert kerult ide orzo: nem tudas hianyzott, hanem az inline
# alak EGY SOR, a helyes alak harom lepes (fajl, atiranyitas, hivas). Murena mondata:
# "egy szabaly, ami kenyelemben versenyez egy rovidites-sel, veszit." Ugyanaz a valasz,
# amit ma a teszt-duplaknal adtunk: nem azt kertuk, hogy mindenki emlekezzen, hanem a
# fordito kezebe adtuk.
#
# A TILTAS SZUK, SZANDEKOSAN. Csak az INLINE harmadik argumentumra szol, es csak arra a ket
# karakterre, amelyik kart okoz. Egy rovid, jelmentes uzenetnel az inline alak biztonsagos,
# es marad is -- a STDIN-alak pedig erintetlen, ott a $ es a backtick teljesen legitim,
# hiszen epp azert megy fajlbol, hogy a shell ne lassa.
if [ "$C" != "-" ]; then
  case "$C" in
    *'`'*|*'$'*)
      echo "FAIL: az inline szoveg backtickot vagy dollarjelet tartalmaz." >&2
      echo "  A shell ezeket MAR ERTELMEZTE, mielott a helper megkapta oket: a backtick" >&2
      echo "  parancskent FUTOTT LE, a dollaros alak pedig behelyettesitodott. A cimzett" >&2
      echo "  igy csonka vagy MASIK mondatot kapna, es a kuldes kozben minden zold marad." >&2
      echo "  A helyes alak (a tartalom nem megy at a shellen):" >&2
      echo "    bash /home/marveen/marveen/scripts/agent-msg.sh $FROM $TO - < uzenet.txt" >&2
      exit 1
      ;;
  esac
fi

[ "$C" = "-" ] && C="$(cat)"

# URES TORZS ORZO (2026-09-04, mert eppen most kerult belem). Egy heredoc, aminek a lezaro
# jele soha nem erkezik meg, URES STDIN-t ad: a bash figyelmeztet, de nem all le, a kuldes
# lefut, es "OK id=<n>" jon vissza. A cimzett egy idobelyeget kap, torzs nelkul, es NEKI kell
# eszrevennie -- korall vette eszre (12480), nem en.
#
# MIERT NEM FOGTA MEG A MEGLEVO KET ORZO: a HTTP-kod es az `id` a KEZBESITEST igazolja, az
# arity-orzo pedig a TOBBLET argumentumot. Egy ures torzs mindkettonek szabalyos.
#
# A TESZTJE NEM AZ, HOGY SZOL, HANEM HOGY NEM KELETKEZIK UZENET: a szkript itt kilep, mielott
# a curl elindulna.
if [ -z "${C//[[:space:]]/}" ]; then
  echo "FAIL ures uzenet-torzs -- nem kuldtem el semmit." >&2
  echo "  Ha STDIN-rol kuldted: a heredoc lezaro jele valoszinuleg hianyzik, vagy a fajl ures." >&2
  echo "  A helyes alak:  bash $0 <from> <to> - < uzenet.txt" >&2
  exit 1
fi
# HALASZTAS-JELZO (NEM szuro: az uzenet ELMEGY). Balazs allo szabalya: nincs olyan, hogy "majd
# holnap". Ha valami tenyleg nem mehet most, akkor NEM napszakot nevezunk meg, hanem a VALODI
# AKADALYT (mire varunk, kitol, mi hianyzik). A szabaly dokumentumban allt, es 2026-08-19
# estejen igy is elhangzott tobbszor -- ezert kerult eszkozbe.
#
# A NEVE 2026-08-29-ig "szuro" volt, es ez FELREVEZETETT (murena merte): a nev tiltast igert,
# a viselkedes viszont csak figyelmeztet. Ez maga a nap tanulsaga -- egy orzo, ami szol, de nem
# allit meg. Itt a NEM-tiltas SZANDEKOS: agensek kozott egy halaszto mondat jelzes, nem hiba, es
# egy szo-egyezesre alapozott tiltas hamis pozitivokat gyartana ("a holnapi napindito"). Amin
# viszont valtoztattunk: a figyelmeztetes MOST MAR a zaro sor melle is kikerul, mert a hivo az
# "OK id=" sort nezi, es a stderr harom sorral folotte egy hosszu kimenetben nem latszik.
# ES EGY MERT HAMIS POZITIV, AMI A LEGERDEKESEBB FAJTA (acrobot, 2026-08-31 19:47): a jelzo
# akkor is megszolal, amikor az uzenet eppen VISSZAVONJA a halasztast. Idezni kellett a sajat
# korabbi mondatomat ("... akkor holnap reggel elso korben"), hogy megnevezzem helyette a
# valodi akadalyt -- es a szo-egyezes nem tud kulonbseget tenni javaslat es idezet kozott.
#
# AKKOR AZT IRTAM IDE, HOGY EZ NEM JAVITANDO. NAUTILUS ESTE MEGMERTE, ES MEGFORDITOTTA AZ
# ERVET (2026-08-31 22:57). Az en indokom az volt, hogy a hamis pozitiv ara egy elolvasott
# sor. Az o meresebol viszont az jott ki, hogy nem egy sorrol van szo, hanem egy
# rendszeressegrol: a jelzo KETSZER sult el egymas utan, es a masodik EPPEN AZ AZ UZENET
# volt, amelyik az elsot javitotta. Vagyis MINDEN VISSZAVONAS elsuti -- es par kor utan
# mindenki atlapozza. Egy orzo, amit megszoktunk atlapozni, mar nem orzo. Ez ugyanaz a
# csalad, mint az "orzo, ami szol es a muvelet vegigmegy", csak eggyel odebb: nem a
# hallgatas, hanem a folosleges beszed uti ki.
# EZERT: az IDEZOJELBE vagy backtickbe tett reszek NEM szamitanak. A hasznalat es az emlites
# kulonbsege ennyi mintaillesztessel megfoghato, es pont a javito uzeneteket engedi at.
# A jelzo tovabbra sem tilt, es a 2026-08-31 22:53-as valodi halasztasomat (idezojel nelkuli
# zaro mondat) ez a valtozas TOVABBRA IS elkapja -- ez a kalibracio, nem a szandek.
#
# ES EGY HARMADIK ESET, AMIT SZANDEKOSAN NEM JAVITUNK (nautilus merte, 2026-08-31 23:19).
# A jelzo A SAJAT MUNKA idozitesere valo. Egy mondat, ami jovobeli idopontot EMLIT, de nem
# halaszt -- peldaul allitas arrol, mikor lesz hasznos egy MAR ELKESZULT lap --, ELSULHET.
# Ez hamis riasztas, es tudni kell rola: aki tudja, egy masodperc alatt atlapozza; aki nem,
# az vagy atir egy jo mondatot, vagy megszokja, hogy atlapozza a jelzot.
# MIERT NEM JAVITJUK: a megkulonboztetes ("a sajat munkam" kontra "barmi mas") mar a mondat
# ERTELMEZESE lenne, nem mintaillesztes. Egy mintaillesztotol ez nem varhato, es minden
# tovabbi finomitas kozelebb visz ahhoz a hibaosztalyhoz, amit ez a jelzo epp elkerul.
# A hamis riasztas ara itt alacsony, mert a mondat ATIRHATO -- es a pontosabb alak
# rendszerint jobb is: nem "holnap reggel lesz hasznos", hanem "keszen all, a sorrendet a
# hivo szabja meg".
# Kikapcsolas egy adott uzenetre: MSG_ALLOW_DEFER=1.
if [ "${MSG_ALLOW_DEFER:-0}" != "1" ]; then
  DEFER_SCAN="$(printf '%s' "$C" | /bin/sed 's/"[^"]*"/ /g; s/`[^`]*`/ /g')"
  DEFER_HIT="$(printf '%s' "$DEFER_SCAN" | /bin/grep -oiE 'majd holnap|holnap reggel|reggel csinal|reggel nezz|friss fejjel|kipihen|holnapra hagy' | head -3 | tr '\n' ' ')"
  if [ -n "$DEFER_HIT" ]; then
    echo "FIGYELEM (halasztas-jelzo, NEM tilt -- az uzenet el fog menni): halaszto fordulat -> ${DEFER_HIT}" >&2
    echo "  Ha tenyleg nem mehet most, nevezd meg az AKADALYT (kire/mire vartok), ne a napszakot." >&2
    echo "  Ha szandekos: MSG_ALLOW_DEFER=1 elotaggal kuldd ujra." >&2
  fi
fi

# A KULDES MERT IDEJE, ES MIERT A SZKRIPT TESZI ODA (murena javaslata, 2026-08-31 este).
#
# Ma este bevezettunk egy konvenciot: az idopontot tartalmazo mondat melle "MERVE: HH:MM"
# sort irunk, hogy a szam ne becslesbol jojjon. A konvencio NEHANY ORAN BELUL KETSZER
# LEVALT arrol, amit garantalni hivatott -- eloszor nalam, aztan murenanal --, mert a
# cimket ugyanaz a kez irja, amelyik a mondatot, ugyanabban a pillanatban, es SEMMI nem
# all a ketto kozott. Murena kerdese dontotte el: mi kellene ahhoz, hogy a cimke hamis
# legyen? Annyi, hogy valaki begepelje meres nelkul. Akadalyozza-e ezt barmi? Nem.
#
# Ezert a szam nem a mondat irojatol jon tobbe. Ugyanaz a megoldas, mint a napi naplonal,
# ahol a daily-log.sh meri a fejlecet kikuldeskor -- ott ez a hiba NULLA esetben fordult
# elo, ugyanazon a napon, amikor a kezzel irt idopontok 3 es 101 perc kozott csusztak.
#
# AMIT EZ NEM OLD MEG, es ezt murena mondta ki: a KULDES ideje nem a MERES ideje. Ha
# valaki fel oraval korabban mert es most kuld, a szkript szama igaz lesz, a mondate nem.
# A ketto EGYUTT viszont lathatova teszi az eltérest -- pontosan igy bukott le ma este a
# 8484-es uzenet, ahol a szerver letrehozasi belyege cafolta a szovegben allo szamot.
# KET RESET MURENA TALALT A BEVEZETES UTAN PERCEKKEL, A SAJAT BEVEZETO UZENETEMEN.
#
# ELSO: a sor teljes ertelme az az EGY allitas, hogy ezt a szamot nem a kuldo keze irta.
# Ha ugyanezt a sort a kuldo keze is le tudja irni, akkor a FORMA nem hordozza az
# allitast -- a megkulonboztetes csak a POZICION allna (az utolso ilyen sor a gepe), ami
# sehol nincs kimondva es egy idezett uzenetben elveszik. Bizonyitek: a bevezeto
# uzenetemben KET ilyen sor allt, 42 masodperc kulonbseggel, mert az elsot peldakent
# begepeltem. Ezert a szkript most MEGNEZI a torzset, es ha talal ilyen alaku sort,
# megjeloli. Nem tagadja meg a kuldest: lathatova teszi.
#
# MASODIK: a meres eddig `|| true` mogott allt, es ures ertek eseten a szkript NEM fuzott
# oda semmit. Vagyis a sor HIANYA ket kulonbozo dolgot jelentett: regi uzenet a funkcio
# elottrol, VAGY az oramerés elhasalt. Ugyanaz a hiba, mint egy SQL-nel, ahol az ures
# eredmeny a nullat es a rossz adatbazist egyformán mutatja. Most hiba eseten is kimegy
# egy sor, tehat a hianynak egyetlen jelentese marad.
# A FELULIRAS SORA A TORZS ELEJERE MEGY, nem a vegere: aki egy ket oraval korabbi
# utasitas utan olvassa, az elso soron dol el, hogy a regi meg all-e.
if [ -n "$FELULIR" ]; then
  C="FELULIRJA A(Z) ${FELULIR} SZAMU UZENETET: ami abban all, az ettol a sortol nem
ervenyes. Ha az meg olvasatlan a soradban, ezt vedd ervenyesnek.

${C}"
fi

SENT_AT="$("$(dirname "${BASH_SOURCE[0]}")/local-now.sh" full 2>/dev/null || true)"
PRE_STAMP=""
if printf '%s' "$C" | /bin/grep -qF -- "--- a kuldes mert ideje:"; then
  PRE_STAMP="  FIGYELEM: a kuldo torzsében MAR allt ilyen alaku sor, azt NEM a szkript irta."
  echo "FIGYELEM: a torzsben mar all egy 'a kuldes mert ideje' alaku sor." >&2
  echo "  A szkript sora az UTOLSO. A korabbi a kuldo sajat szovege, nem mert ertek." >&2
fi
if [ -n "$SENT_AT" ]; then
  C="${C}

--- a kuldes mert ideje: ${SENT_AT} (a szkript merte, nem a kuldo irta)${PRE_STAMP:+
${PRE_STAMP}}"
else
  C="${C}

--- a kuldes idejet NEM sikerult megmerni (a local-now.sh nem adott erteket)${PRE_STAMP:+
${PRE_STAMP}}"
fi

[ -r "$TOKEN_FILE" ] || { echo "FAIL: no token file at $TOKEN_FILE"; exit 1; }
TOKEN="$(cat "$TOKEN_FILE")"

BODY="$(FROM="$FROM" TO="$TO" C="$C" TASK="$TASK" python3 -c 'import json,os
b={"from":os.environ["FROM"],"to":os.environ["TO"],"content":os.environ["C"]}
if os.environ["TASK"]: b["task_id"]=os.environ["TASK"]
print(json.dumps(b))')"

attempt=0; max=3; CODE=""; ID=""
while [ "$attempt" -lt "$max" ]; do
  attempt=$((attempt+1))
  RESP="$(curl -s -X POST "$URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$BODY" -w $'\n%{http_code}' 2>/dev/null || true)"
  CODE="$(printf '%s' "$RESP" | tail -n1)"
  JSON="$(printf '%s' "$RESP" | sed '$d')"
  ID="$(printf '%s' "$JSON" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print(d.get("id","") if isinstance(d,dict) else "")
except Exception:
  print("")' 2>/dev/null)"
  if { [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; } && [ -n "$ID" ]; then
    # A halasztas-jelzo a zaro sorra IS kikerul. A stderr-en mar szolt, de a hivo az "OK id="
    # sort nezi, es egy hosszu kimenetben harom sorral feljebb nem latszik. Az uzenet ettol meg
    # ELMEGY: ez jelzes, nem tiltas (lasd a jelzo kommentjet fentebb).
    if [ -n "${DEFER_HIT:-}" ]; then
      echo "OK id=$ID  [halasztas-jelzo: ${DEFER_HIT}-- az uzenet ELMENT, de nevezd meg az akadalyt]"
    else
      echo "OK id=$ID"
    fi
    exit 0
  fi
  sleep 1
done
echo "FAIL from=$FROM to=$TO http=${CODE:-?} id='$ID' (after $max tries)"
printf '%s\tFAIL\tfrom=%s\tto=%s\thttp=%s\tresp=%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$FROM" "$TO" "${CODE:-?}" "$(printf '%s' "${JSON:-}" | head -c 200)" >> "$LOG" 2>/dev/null || true
exit 1
