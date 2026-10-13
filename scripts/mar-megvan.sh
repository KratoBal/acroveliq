#!/usr/bin/env bash
# ANSWERS: Nem csinaltuk-e mar meg? A NYITOTT es a kozelmultban BEOLVADT PR-ek cime es fajllistaja, kulcsszora szurve.
#
# MIERT LETEZIK (sajat meres, 2026-09-03 hajnal). Tegnap este beolvasztottam a #374-et
# ("every method that takes a scope has to use it"), es ma hajnalban kiadtam egy kartyat
# (cba1e37a), ami UGYANARRA A LELETRE hivatkozva ugyanazt az orzot kerte. Nautilus
# elkezdte megirni, es nem a kartyabol vette eszre, hanem abbol, hogy a sajat teszt-
# futasaban olyan allitas-nevek lettek pirosak, amiket nem o irt.
#
# A hiba nem az volt, hogy nem neztem meg a TABLAT -- azt megneztem, es a masik jeloltet
# epp ezert vetettem el. Azt nem neztem meg, MI OLVADT BE. A kartya-kiadas es a
# beolvasztas ugyanaz a kez volt, ugyanazon a napon.
#
# A HATARA, ES EZT TUDNI KELL, MIELOTT BARKI ELHISZI A NULLAT:
#   - NYITOTT es BEOLVADT PR-eket is lat, ket kulon szakaszban. A nyitottakra nincs
#     idokorlat, a beolvadtakra a --nap ervenyes.
#   - A cimre es a FAJLNEVEKRE illeszt, a diff TARTALMARA nem. Egy javitas, aminek sem a
#     cime, sem a fajlneve nem tartalmazza a kulcsszot, itt nem jelenik meg.
#   - A GitHub code search erre a repora NEM hasznalhato: merve 2026-09-03, harom ismert
#     pozitiv mintara (DOKUMENTALT_KIVETELEK, partner-scope-usage, PrismaService) is
#     total_count=0 jott, incomplete_results=true mellett. Nem jogosultsagi kerdes, hanem
#     alkalmatlan felulet -- ne kerj hozza hozzaferest.
#
# HASZNALAT:
#   bash /home/marveen/marveen/scripts/mar-megvan.sh scope hatokor
#   bash /home/marveen/marveen/scripts/mar-megvan.sh --nap 14 spec
#   bash /home/marveen/marveen/scripts/mar-megvan.sh            # az osszes, szures nelkul
#   PR_REPO=KratoBal/marveen bash .../mar-megvan.sh update
#   bash .../mar-megvan.sh --repo commerce fulek     # az acropora-commerce repoban
#
# A --repo KAPCSOLO MIERT KELLETT (nautilus merese, 2026-09-07, KET eset egy napon):
# az alapertelmezes az acropora-os, es a kirakat-munka a commerce repoban folyik.
# A szkript MAGABIZTOS NULLAT adott olyan keresesre, aminek a masik repoban lett
# volna talalata. A nulla nem a vilag tulajdonsaga volt, hanem a hivase -- es a
# kimenet fejlece ezert MOSTANTOL kiirja, melyik repot kerdezte.
#   --repo commerce | os | <tulajdonos/repo>
#
# A kulcsszo-illesztes EKEZET- es kis-nagybetu-fuggetlen (ugyanaz az osszehajtas, mint a
# keres.sh-ban), es NULLA TALALATNAL kiirja, mit keresett es mekkora halmazban.
set -uo pipefail
ROOT=/home/marveen/marveen
REPO="${PR_REPO:-KratoBal/acropora-os}"
TOKEN_FILE="$ROOT/store/.github-token"
[ -r "$TOKEN_FILE" ] || { echo "FAIL: nincs github token itt: $TOKEN_FILE" >&2; exit 1; }

# A NULLA A KERDES TULAJDONSAGA IS LEHET, ES ITT AZ ALAPERTELMEZES MUTAT ROSSZ IRANYBA
# (murena merese, 2026-09-10): a `lap-vaz` keresese az acropora-os repoban NULLAT adott,
# a commerce-ben 111 talalatot -- es a kirakat-munka ott folyik. A csapda a fejlecben
# eddig is ott allt (nautilus, 2026-09-07), es murena megis belefutott, mert a kapcsolo
# nelkul hivta. Egy dokumentalt csapda nem vedelem, ha az alapertelmezes rossz iranyba
# mutat. Ezert MOSTANTOL: ha nem valasztottal repot ES nulla jott, a szkript magatol
# megkerdezi a masikat is, es kiirja, hogy megtette.
REPO_VALASZTVA=0
[ -n "${PR_REPO:-}" ] && REPO_VALASZTVA=1
for _a in "$@"; do [ "$_a" = "--repo" ] && REPO_VALASZTVA=1; done

futtat() {
  _repo="$1"; shift
  TOKEN="$(cat "$TOKEN_FILE")" REPO="$_repo" python3 - "$@" <<'PY'
import json, os, subprocess, sys, datetime, unicodedata, time

tok, repo = os.environ["TOKEN"], os.environ["REPO"]

argv = sys.argv[1:]
napok = 7
csak_cim = False
while argv and argv[0].startswith("--"):
    if argv[0] == "--nap":
        if len(argv) < 2 or not argv[1].isdigit():
            print("HASZNALAT: mar-megvan.sh [--nap N] [--cim] [kulcsszo ...]", file=sys.stderr)
            sys.exit(2)
        napok = int(argv[1]); argv = argv[2:]
    elif argv[0] == "--repo":
        if len(argv) < 2:
            print("HASZNALAT: --repo commerce | os | <tulajdonos/repo>", file=sys.stderr)
            sys.exit(2)
        rovid = {"commerce": "KratoBal/acropora-commerce", "os": "KratoBal/acropora-os"}
        repo = rovid.get(argv[1], argv[1])
        if "/" not in repo:
            print("ISMERETLEN REPO: " + argv[1] + " (commerce, os, vagy tulajdonos/repo)", file=sys.stderr)
            sys.exit(2)
        argv = argv[2:]
    elif argv[0] == "--cim":
        # A fajlnevekre illesztes GYAKORI szonal hasznalhatatlan: merve 2026-09-03,
        # a "service" szo az osszes beolvadt PR-t visszaadta (unas-apply.service.ts,
        # content.service.ts, ...). A --cim csak a PR CIMERE illeszt.
        csak_cim = True; argv = argv[1:]
    else:
        print("ISMERETLEN KAPCSOLO: " + argv[0], file=sys.stderr)
        print("HASZNALAT: mar-megvan.sh [--nap N] [--cim] [kulcsszo ...]", file=sys.stderr)
        sys.exit(2)
# A KAPCSOLO CSAK A KULCSSZAVAK ELOTT ERVENYES, ES A HATSO ALAK NEMAN ROMLOTT EL
# (nautilus merese, 2026-09-09). A `mar-megvan.sh kategoria --repo commerce --nap 1`
# alakban mind a negy szo KULCSSZOKENT ment be a keresesbe, a repo az alapertelmezesre,
# az ablak het napra esett vissza -- es az eredmeny egy MAGABIZTOS NULLA lett, ami
# pontosan ugy nez ki, mint egy valodi "nincs ilyen".
#
# Miert sulyosabb itt, mint egy PR-szamot varo eszkozben: ott a rossz argumentum nem
# szam, tehat feltunhet. Itt BARMILYEN szoveg ervenyes kulcsszo, tehat semmi nem tunik fel.
# Ezert nem figyelmeztetes, hanem MEGALLAS: egy figyelmeztetes mellett ott all egy hiheto
# valasz, es azt veszi at az ember.
for maradek in argv:
    if maradek.startswith("-"):
        print("FAIL: kapcsolo a kulcsszavak UTAN: " + maradek, file=sys.stderr)
        print("A kapcsolok csak a kulcsszavak ELOTT allhatnak.", file=sys.stderr)
        print("HASZNALAT: mar-megvan.sh [--nap N] [--repo commerce|os] [--cim] [kulcsszo ...]", file=sys.stderr)
        sys.exit(2)

kulcsok = argv

def hajt(s):
    # ekezet le, kisbetu -- ugyanaz az osszehajtas, mint a keres.sh-ban
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()

def api(path):
    # the header on stdin, not the argv: every agent's `ps` shows argv (P0-1)
    r = subprocess.run(["curl", "-s", "-H", "@-",
                        "https://api.github.com/repos/" + repo + path],
                       input="Authorization: Bearer " + tok + "\n", capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None

hatar = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=napok)
# Zonaval, es NEM `%Z`-vel a naiv datetime-on: az ures sztringre fordul (lasd
# pr-allapot.sh). A time.strftime a C konyvtar zonajat olvassa.
most = time.strftime("%H:%M:%S %Z (%z)")
print(f"--- mar-megvan (lekerdezve {most}, repo {repo}, utolso {napok} nap) ---")

beolvadt, oldal = [], 1
while oldal <= 5:
    d = api(f"/pulls?state=closed&sort=updated&direction=desc&per_page=100&page={oldal}")
    if not isinstance(d, list) or not d:
        break
    regi = False
    for p in d:
        if not p.get("merged_at"):
            continue
        t = datetime.datetime.fromisoformat(p["merged_at"].replace("Z", "+00:00"))
        if t < hatar:
            regi = True
            continue
        beolvadt.append(p)
    if regi:
        break
    oldal += 1

# A NYITOTT PR-EK UGYANEZ A KERDES (nautilus kerese, 2026-09-03): egy duplikatum ugyanugy
# allhat egy meg be nem olvadt agon. Ket kulon parancs ket kulon lepes, es a masodikat
# konnyu kihagyni -- ezert mindketto ITT van, ket szakaszban.
nyitott = api("/pulls?state=open&per_page=100")
nyitott = nyitott if isinstance(nyitott, list) else []

def fajljai(p):
    # A fajllista PR-enkent egy kulon keres. Sorosan hivva het nap alatt tobb percig
    # futott (merve 2026-09-03: idotullepes), ezert parhuzamosan megy.
    fd = api(f"/pulls/{p['number']}/files?per_page=100")
    return p, ([f["filename"] for f in fd] if isinstance(fd, list) else [])

from concurrent.futures import ThreadPoolExecutor
sorrend = (sorted(nyitott, key=lambda x: x["number"], reverse=True)
           + sorted(beolvadt, key=lambda x: x["merged_at"], reverse=True))
with ThreadPoolExecutor(max_workers=8) as ex:
    parok = list(ex.map(fajljai, sorrend))

def illeszkedik(p, fajlok):
    szoveg = hajt(p["title"] if csak_cim else p["title"] + " " + " ".join(fajlok))
    return (not kulcsok) or any(hajt(k) in szoveg for k in kulcsok)

def kiir(p, fajlok, nyitva):
    # A DATUM UTC-BOL JON, ES MEGJELOLVE ALL. Nem szamolom at helyire: egy este
    # 23 orakor beolvadt PR datuma atszamolva MASNAP lenne, es a "mikor csinaltuk"
    # kerdesre egy jelöletlen datum rosszabb, mint egy megjelolt UTC. (nautilus
    # merese, 2026-09-08: ket ido kulonbsege csak azonos bazison lelet, es a ket
    # ora eltolas epp azert veszelyes, mert HIHETO marad.)
    jel = "NYITVA " if nyitva else p["merged_at"][:10] + "Z "
    print(f"\n#{p['number']}  {jel}{p['title']}")
    for f in fajlok[:20]:
        print(f"    {f}")
    if len(fajlok) > 20:
        print(f"    ... es meg {len(fajlok) - 20} fajl")

n_nyit = {p["number"] for p in nyitott}
talalt_ny = [(p, f) for p, f in parok if p["number"] in n_nyit and illeszkedik(p, f)]
talalt_be = [(p, f) for p, f in parok if p["number"] not in n_nyit and illeszkedik(p, f)]

print(f"\n=== NYITOTT PR-EKBEN ({len(talalt_ny)} a {len(nyitott)}-bol) ===")
for p, f in talalt_ny:
    kiir(p, f, True)
if not talalt_ny:
    print("  (nincs illeszkedo)")

print(f"\n=== BEOLVADT PR-EKBEN, utolso {napok} nap ({len(talalt_be)} a {len(beolvadt)}-bol) ===")
for p, f in talalt_be:
    kiir(p, f, False)
if not talalt_be:
    print("  (nincs illeszkedo)")

if not talalt_ny and not talalt_be:
    # A nulla itt is lehet a kerdes tulajdonsaga: ezert a hatokor is kiirodik.
    if kulcsok:
        print("\nNULLA TALALAT. Amit kerestem: " + ", ".join(kulcsok))
        print("  osszehajtott alakban: " + ", ".join(hajt(k) for k in kulcsok))
    else:
        print("\nNULLA TALALAT (szures nelkul).")
    print(f"  a halmaz: {len(nyitott)} nyitott es {len(beolvadt)} beolvadt PR "
          f"(utobbi az utolso {napok} napbol)")
    print("  csak a CIMRE illesztettem (--cim)" if csak_cim
          else "  a cimre ES a fajlnevekre illesztek, a diff tartalmara NEM")
    sys.exit(9)   # a hivo szkript ebbol tudja, hogy erdemes a masik repot is megkerdezni
PY
}

futtat "$REPO" "$@"
KOD=$?
if [ "$KOD" = "9" ] && [ "$REPO_VALASZTVA" = "0" ]; then
  MASIK="KratoBal/acropora-commerce"
  [ "$REPO" = "$MASIK" ] && MASIK="KratoBal/acropora-os"
  echo
  echo "=== A NULLA UTAN MEGKERDEZTEM A MASIK REPOT IS: $MASIK ==="
  echo "    Ok: nem adtal meg --repo kapcsolot es PR_REPO sincs beallitva, tehat az"
  echo "    alapertelmezes ($REPO) valaszolt. A kirakat-munka a commerce repoban folyik,"
  echo "    ezert a fenti nulla a KERDES tulajdonsaga is lehet, nem a vilage."
  futtat "$MASIK" "$@"
  KOD=$?
fi
exit "$KOD"
