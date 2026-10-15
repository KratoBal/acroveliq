#!/usr/bin/env bash
# ANSWERS: Milyen allapotban van az a PR, amirol epp allitani akarok valamit?
#
# MIERT LETEZIK (sajat meres, 2026-09-02, NEGY eset egy napon). Negyszer allitottam
# valamit egy PR-rol ugy, hogy a SAJAT AGAM fejet kerdeztem le, a PR ALLAPOTAT nem:
#
#   22:36  commitoltam egy PR agara, ami addigra be volt olvasztva
#   22:4x  a PR fejenek elterese melle okot talaltam ki (a state mezot nem neztem)
#   23:34  "mindketto nyitva" -- az egyik ot perce beolvadt
#   00:05  a listamban nyitottkent szerepelt egy PR, ami 22:57 ota bent volt
#
# Mind a negyszer ugyanaz: a HEAD egyezett, es a STATE mast mondott. A szabalyt
# ketszer is felirtam a lapomra, es a negyedik eset a masodik felírás ELOTT ket
# perccel tortent -- vagyis nem a szabaly hianyzott, hanem az, hogy hasznalni
# konnyebb legyen, mint emlekezni ra.
#
# A HAROM ADAT HAROM KULONBOZO KERDESRE VALASZOL, es ez a szkript mindharmat kiirja:
#   az ag referenciaja  ->  mi a legfrissebb munka
#   a PR state          ->  nyitva van-e egyaltalan
#   a PR head.sha       ->  MIT olvasztana be
#
# A HATARA: a GitHubot kerdezi, tehat a valasz a LEKERDEZES pillanatara szol. Ha
# a jelentesed kesobb megy ki, a ketto kozott is mozdulhat -- ezert a kimenet a
# lekerdezes idejet is kiirja, mert az az allitas kora, nem a jelentese.
#
# HASZNALAT (a klon konyvtarabol vagy barhonnan):
#   bash .../pr-allapotom.sh 392 396 398
#   bash .../pr-allapotom.sh --repo KratoBal/acropora-commerce 158
set -uo pipefail
ROOT=/home/marveen/marveen
# A REPO MEGNEVEZESE NEM DISZ: MURENA MAJDNEM ROSSZ REPOT OLVASOTT (merese, 2026-09-08).
# A commerce #158 es az acropora-os #158 IS letezik, es a valasz ALAKJA teljesen azonos --
# csak az egyik egy 2026-08-26-i, mas targyu PR. Semmi nem jelezte, hogy nem azt nezi,
# amit keres.
# Ezert a fejlec mostantol kimondja, hogy a repo VALASZTOTT volt-e vagy alapertelmezes.
# Egy alapertelmezes, amit senki nem valasztott, ugyanugy nez ki, mint egy dontes.
# A --repo KAPCSOLO 2026-09-22 OTA MUKODIK, ES AZ OK EGY MERT ELAKADAS.
# Nautilus `--repo <owner/name>` alakban hivta, mert a ket SAJAT eszkoze igy veszi.
# Ez a szkript akkor MIND A KET tokent PR-SZAMNAK olvasta, es "NEM KERDEZHETO LE"
# sorral valaszolt rajuk -- a helyes eredmenyt csak azert kapta meg, mert az
# alapertelmezett repo eleve az volt, amit keresett.
# KET HIBA VOLT BENNE, ES A MASODIK A SULYOSABB:
#   1. nem ismerte a kapcsolot
#   2. ISMERETLEN KAPCSOLOT ADATKENT olvasott, tehat nem szolt, hanem felreertett
# A 2. javitasa altalanos: minden `--` kezdetu ismeretlen argumentum HIBA, nem adat.
# Enelkul a kovetkezo kitalalt kapcsolo ugyanigy csendben PR-szamma valna.
PR_REPO_CLI=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || { echo "FAIL: a --repo utan owner/name kell" >&2; exit 2; }
            PR_REPO_CLI="$2"; shift 2 ;;
    --repo=*) PR_REPO_CLI="${1#--repo=}"; shift ;;
    --) shift; while [ "$#" -gt 0 ]; do ARGS+=("$1"); shift; done ;;
    --*) echo "FAIL: ismeretlen kapcsolo: $1  (ismert: --repo <owner/name>)" >&2; exit 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
set -- ${ARGS+"${ARGS[@]}"}

if [ -n "$PR_REPO_CLI" ]; then REPO_FORRAS="--repo"; REPO="$PR_REPO_CLI"
elif [ -n "${PR_REPO:-}" ]; then REPO_FORRAS="PR_REPO"; REPO="$PR_REPO"
else REPO_FORRAS="ALAPERTELMEZES -- ha a commerce kell: --repo KratoBal/acropora-commerce"; REPO="KratoBal/acropora-os"; fi
. "$(dirname "${BASH_SOURCE[0]}")/lib/github-token.sh"   # github_token <owner/repo> <role> (FLEET_GITHUB_APP)
[ "$#" -ge 1 ] || { echo "HASZNALAT: pr-allapotom.sh <PR-szam> [PR-szam ...]" >&2; exit 2; }

GH_TOK="$(github_token "$REPO" olvas)" || exit 1
TOKEN="$GH_TOK" REPO="$REPO" REPO_FORRAS="$REPO_FORRAS" python3 - "$@" <<'PY'
import calendar, json, os, subprocess, sys, datetime, time

tok, repo = os.environ["TOKEN"], os.environ["REPO"]

def api(path):
    # the header on stdin, not the argv: every agent's `ps` shows argv (P0-1)
    r = subprocess.run(
        ["curl", "-s", "-H", "@-",
         "https://api.github.com/repos/" + repo + path],
        input="Authorization: Bearer " + tok + "\n", capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None

# A ZONA NEVE ES A NAIV IDO (nautilus merese, 2026-09-08). Itt eddig zona NELKUL allt
# az idopont, es a kezenfekvo javitas -- egy `%Z` a formatumhoz -- NEM MUKODIK: a
# `datetime.now()` naiv erteket ad, tehat a `%Z` URES sztringre fordul, es a kimenet
# egyetlen zaro szokozzel bovul. Ugyanaz az alak, mint egy orzo, ami szol, de a muvelet
# vegigmegy: ugy nez ki, mintha megtortent volna. A mukodo alak a `time.strftime`, ami a
# C konyvtar zonajat olvassa. (Az ELTOLAS is kimegy, mert a zona NEVE tud hazudni, az
# eltolas nem -- ez a lapom regi szabalya, es 2026-08-20-an ket orat tevedtunk rajta.)
most = time.strftime("%H:%M:%S %Z (%z)")
print(f"--- pr-allapot (lekerdezve {most}, repo {repo}) ---")
print(f"    [a repo forrasa: {os.environ.get('REPO_FORRAS', '?')}]")
# A FO AG NEVE NEM MINDIG "main". Az acropora-os fo aga main, a marveen repoe develop --
# es az elso valtozat mindket helyen a main-t kerdezte, tehat a marveen soraban egy LETEZO,
# de NEM a fo ag fejet irta ki. Egy rossz szam, ami helyesnek latszik, rosszabb, mint ha
# hianyozna, ezert a nevet a repotol kerdezzuk meg.
info = api("")
agnev = info.get("default_branch") if isinstance(info, dict) else None
if agnev:
    fej = api("/commits/" + agnev)
    if isinstance(fej, dict) and fej.get("sha"):
        print(f"fo ag ({agnev}): {fej['sha'][:12]}")
else:
    print("fo ag: NEM KERDEZHETO LE (a repo adatai nem jottek meg)")

hibas = 0
for szam in sys.argv[1:]:
    d = api("/pulls/" + szam)
    if not isinstance(d, dict) or "number" not in d:
        print(f"#{szam}: NEM KERDEZHETO LE (a valasz nem egy PR)")
        hibas += 1
        continue
    # A HAROM ADAT KULON, nem osszevonva: a state az elso, mert azt hagytam ki
    # mind a negy esetben.
    allapot = "MERGED" if d["merged"] else d["state"].upper()
    sor = f"#{d['number']}  {allapot:6s}  fej={d['head']['sha'][:12]}  ag={d['head']['ref']}"
    if d["merged"]:
        # A GITHUB UTC-BEN AD IDOT, ES EZ MAJDNEM HAMIS VADAT SZULT (murena merese,
        # 2026-09-08). A `merged_at` nyersen `03:19:51Z` alakban ment ki, jelzes nelkul.
        # Az en mondatom 05:17-kor kelt, tehat ugy nezett ki, mint egy KET ORAVAL KORABBI
        # beolvasztas -- vagyis mintha ellentmondtam volna magamnak. Valojaban 05:19:51
        # Budapesten, ket perccel a mondatom UTAN.
        #
        # KET HELYES SZAM, KET ZONABAN, ES A KULONBSEGBOL EGY NEM LETEZO SZANDEK LATSZIK.
        # Murena atszamolt, es ezert NEM irt rolam szabalyszeges-jelentest -- de ez a
        # helyes viselkedesen mult, nem az eszkozon. Az a fajta jelentes a legdragabb,
        # ha teved, tehat az eszkoznek nem szabad ra csabitania.
        #
        # Ezert MIND A KETTO kimegy, megnevezve: a helyi ido dontesekhez, az UTC azert,
        # hogy a GitHub felulettel osszevetheto maradjon.
        helyi = "?"
        try:
            _t = calendar.timegm(time.strptime(d["merged_at"], "%Y-%m-%dT%H:%M:%SZ"))
            helyi = time.strftime("%Y-%m-%d %H:%M:%S %Z (%z)", time.localtime(_t))
        except Exception:
            pass
        sor += (f"\n        beolvadt: {helyi}   [UTC: {d['merged_at']}]"
                f"\n        merge commit: {(d.get('merge_commit_sha') or '')[:12]}")
    elif d["state"] == "closed":
        # A LEZART, BE NEM OLVASZTOTT PR A LEGFELREVEZETOBB ALLAPOT (nautilus merese,
        # 2026-09-22). A `MERGED` es az `OPEN` onmagaban valaszol; a `CLOSED` viszont
        # epp azt NEM mondja meg, ami erdekel: BENT VAN-E A MUNKA. Lehet, hogy egy masik
        # PR vitte be ugyanazt, lehet, hogy elvetettuk -- a szo mind a kettore ugyanaz.
        # Aki csak az allapotszot olvassa, otven szazalekkal teved, es magabiztosan.
        #
        # Ezert a szo melle kimegy a DONTES MODJA is: a valasz nem a PR-ben all, hanem a
        # fo agon. Egy horgonyt (fuggvenynev, hibauzenet, mezonev) kell keresni a PR
        # sajat fajljaiban, a fo ag JELENLEGI tartalmaban.
        fajlok = api("/pulls/" + szam + "/files?per_page=5")
        nevek = [f["filename"] for f in fajlok] if isinstance(fajlok, list) else []
        sor += "\n        LEZARVA, NEM BEOLVASZTVA -- ez NEM mondja meg, bent van-e a munka."
        if nevek:
            sor += "\n        a dontes modja (a fo agon, NEM a PR-ben keresve):"
            for n in nevek[:3]:
                sor += f"\n          git show origin/{agnev or 'main'}:{n} | grep <horgony>"
            if len(nevek) > 3:
                sor += f"\n          (... es meg {len(nevek) - 3} fajl)"
        else:
            sor += "\n        a fajllista nem jott meg; a fo agon kell horgonyra keresni."
    print(sor)

# A ZARO SOR NEM UDVARIASSAG (nautilus merese, 2026-09-22, ketszer egy ejszaka).
# A fenti szamok a LEKERDEZES pillanatara szolnak. Aki ezekbol kezzel GEPEL at egy
# allapot-mondatot egy uzenetbe, az a gepeles es a kuldes kozott elavulhat -- es a
# mondat akkor is magabiztosan all, amikor mar hamis. A bemasolt blokk viszont a
# meres idejet is viszi magaval, tehat az olvaso latja az allitas KORAT.
print("--- masold be ezt a blokkot, ne gepeld at: a fenti idobelyeg az allitas kora ---")

if hibas:
    sys.exit(1)
PY
