#!/bin/bash
# ANSWERS: Mikor futott le utoljara egy utemezett feladat (a futasok ts mezoje EZREDMASODPERC).
#
# === EZ A JAVITOTT VALTOZAT, ES NEM A HELYEN ALL ===
#
# A flotta valtozata a `scripts/task-last-run.sh`. Oda NEM tudok irni: a
# konyvtar `marveen:marveen`, `drwxr-xr-x`, en `agent-murena` vagyok. Ez
# RENDSZER-szintu korlat (fajl-tulajdon), nem munkamenet-beallitas -- egy
# ujraindulas nem valtoztat rajta. Ezert all itt, es a beemeles mas keze.
#
# === MIERT KELLETT UJRAIRNI (merve 2026-09-02 este) ===
#
# A regi valtozat `sqlite3`-at hivott, ot helyen. AZ EBBEN A KONTENERBEN NINCS
# TELEPITVE -- tehat a szkript MINDEN hivasa azonnal elhasalt. Egy eszkoz, ami
# nem fut le, ugyanugy nez ki, mint egy eszkoz, aminek nincs adata.
#
# ES A KOZVETLEN ADATBAZIS-OLVASAS SEM UT: a `store/claudeclaw.db` modja 600,
# tulajdonosa `marveen`. Megmertem: a python3 beepitett `sqlite3` modulja MEGY
# (3.40.1), a FAJL nem olvashato. Ket kulonbozo korlat, es csak az egyik latszik
# a hibauzeneten.
#
# Ami viszont megy: a dashboard API, ugyanazzal a Bearer tokennel, amit a tobbi
# flotta-szkript is hasznal.
#
#   GET /api/schedules            -> az utemezett feladatok
#   GET /api/schedules/<nev>/runs -> az utolso 10 futas (ts, status, agent)
#
# === A MERTEKEGYSEG, AMI CSENDBEN ELROMLIK ===
#
# A `ts` EZREDMASODPERC epoch, mert a `task_runs` tablabol jon valtozatlanul.
# Masodperckent ertelmezve 58641-et ir 2026 helyett -- ez HANGOS, tehat nem ez a
# veszelyes eset. A veszelyes az, ha valaki "javit" egy osztassal ott, ahol nem
# kell: akkor a datum nehany nappal melle megy, es az mar nem tunik fel. Ezert
# all a valtas EGY helyen (`_ido`), es sehol maskor nem osztunk.
#
# === AMIT EZ A VALTOZAT NEM TUD, ES KI IS MONDJA ===
#
# A `--stats` (fired/skipped arany egy ablakban) nem keszult el. Az ok
# szerkezeti: a runs vegpont feladatonkent az UTOLSO TIZ futast adja, es a tizes
# hatar a szerver utvonalaban all, nem parameterben. Egy 24 oras ablakra vett
# arany ezert csonka lenne -- es egy csonka arany ugy nez ki, mint egy meres.
#
# Hasznalat:
#   task-last-run.sh                 # minden feladat utolso futasa
#   task-last-run.sh pr-figyeles     # egy feladat utolso 10 futasa
#   task-last-run.sh pr-figyeles 24  # ebbol az utolso 24 oraban allok
set -uo pipefail

# an explicit MARVEEN_TOKEN_FILE wins; otherwise the calling user's own token (P0-1, plan 5.2)
TL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -z "${MARVEEN_TOKEN_FILE:-}" ]; then
  if [ -r "$TL_ROOT/scripts/lib/dashboard-token.sh" ]; then
    . "$TL_ROOT/scripts/lib/dashboard-token.sh"
    # an error from the resolver (an agent without its own token) must STOP this script: an empty result used
    # to fall through the :- below to the shared token
    MARVEEN_TOKEN_FILE="$(dashboard_token_file "$TL_ROOT")" || { echo "FAIL: nincs hasznalhato sajat token (a kozos tokent nem hasznalom)" >&2; exit 1; }
  else
    echo "dashboard-token: scripts/lib/dashboard-token.sh missing, using the shared token" >&2
    MARVEEN_TOKEN_FILE="$TL_ROOT/store/.dashboard-token"
  fi
fi
TOKEN_FILE="$MARVEEN_TOKEN_FILE"
PORT="${MARVEEN_WEB_PORT:-3420}"

[ -r "$TOKEN_FILE" ] || { echo "FAIL: nincs olvashato token: $TOKEN_FILE" >&2; exit 1; }

if [ "${1:-}" = "--stats" ]; then
  cat >&2 <<'MSG'
A --stats nem erheto el ebben a valtozatban, es szandekosan nem adok helyette
becslest.

AZ OK: a futasokat kiszolgalo vegpont feladatonkent az UTOLSO TIZ futast adja
vissza, es a tizes hatar a szerver utvonalaban all, nem parameterben. Egy 24
oras ablakra vett fired/skipped arany ezert csonka lenne -- es egy csonka arany
ugy nez ki, mint egy meres.

Ha erre szukseg van, az nem szkript-kerdes: a szervernek kell egy vegpont, ami
ablakra szamol.
MSG
  exit 2
fi

MARVEEN_TASK_NAME="${1:-}" MARVEEN_TASK_HOURS="${2:-}" \
MARVEEN_TOKEN_FILE="$TOKEN_FILE" MARVEEN_PORT="$PORT" python3 - <<'PY'
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

TOKEN = open(os.environ["MARVEEN_TOKEN_FILE"]).read().strip()
API = "http://localhost:%s/api" % os.environ["MARVEEN_PORT"]
NEV = os.environ.get("MARVEEN_TASK_NAME") or ""
ORA = os.environ.get("MARVEEN_TASK_HOURS") or ""


def get(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode())


def _ido(ts):
    """AZ EGYETLEN HELY, AHOL EZREDMASODPERCET MASODPERCRE VALTUNK."""
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts / 1000))


def runs(nev):
    return get("/schedules/%s/runs" % urllib.parse.quote(nev, safe=""))


try:
    nevek = [s["name"] for s in get("/schedules")]
except urllib.error.URLError as hiba:
    print("FAIL: a dashboard API nem elerheto (%s). Fut a szolgaltatas?" % hiba, file=sys.stderr)
    raise SystemExit(1)

if NEV:
    if NEV not in nevek:
        print("Nincs ilyen utemezett feladat: %s" % NEV, file=sys.stderr)
        print("A letezok: %s" % ", ".join(sorted(nevek)), file=sys.stderr)
        raise SystemExit(1)
    sorok = runs(NEV)
    if ORA:
        hatar = time.time() * 1000 - float(ORA) * 3600 * 1000
        szurt = [r for r in sorok if r["ts"] >= hatar]
        print("-- %s | utolso %s ora | %d futas a rendelkezesre allo %d-bol --"
              % (NEV, ORA, len(szurt), len(sorok)))
        if len(szurt) == len(sorok) == 10:
            # A CSONKULAST KIMONDJUK. Ha mind a tiz belefer az ablakba, akkor az
            # ablakban ALLHAT TOBB is, amirol a vegpont nem szol.
            print("   FIGYELEM: mind a tiz futas belefer az ablakba, tehat az")
            print("   ablakban allhat tobb is. A vegpont feladatonkent tizet ad.")
        sorok = szurt
    else:
        print("-- %s | az utolso %d futas --" % (NEV, len(sorok)))
    if not sorok:
        print("   (nincs futas)")
    for r in sorok:
        print("   %s  %-8s %s" % (_ido(r["ts"]), r.get("status", "?"), r.get("agent", "")))
    raise SystemExit(0)

utolsok = []
nelkul = []
for nev in nevek:
    sorok = runs(nev)
    if sorok:
        utolsok.append((sorok[0]["ts"], nev, sorok[0].get("status", "?")))
    else:
        nelkul.append(nev)

utolsok.sort(reverse=True)
print("-- %d utemezett feladat, ebbol %d-nek van futasa | most: %s --"
      % (len(nevek), len(utolsok), time.strftime("%Y-%m-%d %H:%M:%S")))
for ts, nev, status in utolsok:
    print("   %s  %-8s %s" % (_ido(ts), status, nev))
if nelkul:
    # A "nincs futasa" NEM ugyanaz, mint a "nem tudjuk". Kulon irjuk ki, hogy egy
    # hianyzo sor ne latszodjon hibanak.
    print("\n-- %d feladatnak NINCS rogzitett futasa --" % len(nelkul))
    for nev in sorted(nelkul):
        print("   %s" % nev)
PY
