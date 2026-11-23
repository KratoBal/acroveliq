#!/usr/bin/env bash
# ANSWERS: Ujraindult-e ma egy flotta-agens, es visszakerult-e az elozmenye. Kulso jel, nem belso benyomas.
# folytonossag.sh <agens> [YYYY-MM-DD]   |   folytonossag.sh --all [YYYY-MM-DD]
#
# MIERT LETEZIK (merve 2026-09-02, nautilus): egy agens BELULROL nem tudja
# eldonteni, hogy ujraindult-e. Egy friss sessionbe visszajatszott uzenet
# pontosan ugy nez ki, mint egy folytatolagos sessionben megkapott -- a ket
# allapot AZONOS KEPET ad, tehat belso jel nincs. Aznap ketszer indult ujra
# (11:40 es 16:17), egyikrol sem tudott, es az egyiknel teves allitast is
# adott at a fonoknek, johiszemuen.
#
# A session-ATIRATOK kulso forrast adnak: fajlonkent egy session.
#
# AMIT SOHA NEM CSINAL: nem olvas bele az atiratok TARTALMABA. Soronkent csak
# az idobelyeget es a rekordtipust nezi szuk mintaval, es a kimenetbe csak
# szamok es idopontok kerulnek. Mas agens atirata mas munkat tartalmaz, es
# annak nem kell atfolynia egy meresen.
#
# KILEPESI KODOK: 0 rendben | 2 rossz hivas | 3 nincs ilyen atirat-konyvtar
#                 4 jogosultsagi fal (EGYETLEN fajl sem olvashato)
#                 5 RESZLEGES kep: van olvashatatlan fajl, tehat a valasz also
#                   korlat, vagy egyaltalan nem eldontheto
#
# UGYANAZ A SZKRIPT MAST MOND UGYANARROL AZ AGENSROL ATTOL FUGGOEN, KI FUTTATJA:
# egy agens a SAJAT mai fajljait olvashatja (mod 600), masokét nem. Ezert all a
# kimenet fejleceben, ki futtatta -- kulonben ket kulonbozo eredmeny kereng
# ugyanarrol az agensrol, es ugy nez ki, mintha az egyik hazudna.
set -uo pipefail

AGENSEK="nautilus murena barracuda korall polip picasso acrobot"

if [ $# -lt 1 ]; then
  echo "hasznalat: folytonossag.sh <agens> [YYYY-MM-DD]" >&2
  echo "           folytonossag.sh --all [YYYY-MM-DD]" >&2
  echo "ismert agensek: $AGENSEK" >&2
  exit 2
fi

if [ "$1" = "--all" ]; then
  NAP="${2:-}"
  VEG=0
  for A in $AGENSEK; do
    echo "########## $A"
    bash "$0" "$A" $NAP
    RC=$?
    [ "$RC" -gt "$VEG" ] && VEG=$RC
    echo
  done
  exit "$VEG"
fi

AGENS="$1"
NAP="${2:-$(/bin/date +%Y-%m-%d)}"

# KOZVETLEN KONYVTAR, HOGY A SZKRIPT MERHETO LEGYEN. Ha az elso argumentum
# utvonal (van benne `/`), akkor azt hasznaljuk atirat-konyvtarkent. Ez NEM
# kerulout semmilyen jogosultsag korul: a fajlokat ugyanugy az operacios
# rendszer engedi vagy tiltja. Az onmeres fix fixturakon fut igy -- valodi
# agens-mappan mert varhato ertekek holnap mar masok lennenek, es a
# kalibracio elavulna.
if [ "${AGENS#*/}" != "$AGENS" ]; then
  if [ -d "$AGENS" ]; then
    DIR_KOZVETLEN="$AGENS"
    AGENS="$(/usr/bin/basename "$AGENS")"
  else
    echo "NINCS ILYEN KONYVTAR: $AGENS" >&2
    exit 3
  fi
fi

# AZ UTVONALAT MERJUK, NEM FELTETELEZZUK. Ket gyoker letezik, es NEM symlinkek
# egymasra: 2026-09-02-en lemerve a `.claude-config` VALODI konyvtar (readlink
# -f onmagat adja), a masik gyoker alatti agens-konyvtarak pedig URESEK. A
# foagens (acrobot) atirata megint mashol all, mert a projekt-nev a
# munkakonyvtarbol keszul, es az ove nem melyebb.
JELOLTEK="
/home/marveen/marveen/agents/$AGENS/.claude-config/projects/-home-marveen-marveen-agents-$AGENS
/home/marveen/.claude/projects/-home-marveen-marveen-agents-$AGENS
/home/marveen/.claude/projects/-home-marveen-marveen
"

DIR="${DIR_KOZVETLEN:-}"
for J in $JELOLTEK; do
  [ -n "$DIR" ] && break
  [ -d "$J" ] || continue
  # Csak akkor fogadjuk el, ha VAN benne atirat: egy ures kagylo-konyvtar
  # ugyanugy letezik, es a "nulla session" hamis valasz lenne.
  # A `ls` a NEVEKET nezi: egy fajl, aminek a tartalma nem olvashato, ITT meg
  # latszik -- es ez fontos, mert kulonben a jogosultsagi fal ures konyvtarnak
  # nezne ki, es a szkript tovabblepne egy masik jeloltre.
  # A here-string, nem cso (pipefail-korai-olvaso-20261123): a grep -q az elso talalatnal kilep, es pipefail alatt a
  # meg iro ls SIGPIPE-ot kap, tehat egy atiratos konyvtar uresnek latszott, es a kovetkezo jelolt (a foagense) lett
  # a valasz. Merve: 400 fajlnal 11/200, 1000 fajlnal 179/200 teves kihagyas; 2026-11-23-an a legnagyobb 55 fajl.
  if /bin/grep -q '\.jsonl$' <<< "$(/bin/ls "$J" 2>/dev/null)"; then
    DIR="$J"
    break
  fi
done

if [ -z "$DIR" ]; then
  echo "$AGENS: NINCS ATIRAT-KONYVTAR egyik ismert helyen sem."
  echo "  Ez HIANY, nem jogosultsag: mas utvonalon allhat. A megnezett helyek:"
  for J in $JELOLTEK; do echo "    $J"; done
  exit 3
fi

DIR="$DIR" NAP="$NAP" AGENS="$AGENS" FUTTATO="$(/usr/bin/id -un)" python3 <<'PYEOF'
import calendar, os, re, time

d = os.environ["DIR"]
nap = os.environ["NAP"]
agens = os.environ["AGENS"]
futtato = os.environ.get("FUTTATO") or "?"
KOD = 0

# SZUK MINTAK: csak idobelyeg es rekordtipus. Semmi mas nem kerul ki a fajlbol,
# es teljes JSON-elemzes sincs -- igy egy hibauzenet sem hozhat magaval szoveget.
RE_TS = re.compile(r'"timestamp":"(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d)')
RE_TIPUS = re.compile(r'"type":"([a-z-]{1,24})"')
# A MERT JELOLO, nem a kitalalt: a b2c239ff atiratban az
# `isCompactSummary:true` EGYSZER all, a `type:"summary"` alak NULLASZOR.
# Az elso fixturam az utobbira epult -- olyan alakra, ami elo sem fordul.
RE_SUMMARY = re.compile(r'"isCompactSummary":true')

def helyi(iso):
    # `calendar.timegm`, es NEM `mktime` minusz `time.timezone`: az utobbi a
    # nyari idoszamitast hagyja ki, es epp egy orat tevedne.
    return time.localtime(calendar.timegm(time.strptime(iso, "%Y-%m-%dT%H:%M:%S")))

try:
    nevek = sorted(n for n in os.listdir(d) if n.endswith(".jsonl"))
except OSError:
    print("%s: A KONYVTAR NEM LISTAZHATO. Jogosultsagi korlat." % agens)
    raise SystemExit(4)

sorok = []
olvashatatlan = 0
for n in nevek:
    p = os.path.join(d, n)
    elso = utolso = ""
    darab = summary = 0
    try:
        with open(p, encoding="utf-8", errors="replace") as f:
            for l in f:
                darab += 1
                if RE_SUMMARY.search(l):
                    summary += 1
                m = RE_TS.search(l)
                if not m:
                    continue
                ts = m.group(1)
                utolso = ts
                if not elso:
                    t = RE_TIPUS.search(l)
                    if t and t.group(1) == "user":
                        elso = ts
    except OSError:
        # A FAJL NEVE LATSZIK, A TARTALMA NEM. Ezt SZAMOLJUK, nem hallgatjuk el.
        olvashatatlan += 1
        continue
    if elso:
        sorok.append((elso, utolso, n[:8], darab, summary))

if not sorok and olvashatatlan:
    print("%s: JOGOSULTSAGI FAL." % agens)
    print("  %d atirat-fajl NEVE latszik, EGYIK SEM olvashato." % olvashatatlan)
    print("  Ez nem hiany es nem hiba: jogkor-kerdes, es NEM a szkript dolga feloldani.")
    print("  Amit ez jelent: errol az agensrol NEM tudjuk megmondani, ujraindult-e.")
    raise SystemExit(4)

sorok.sort()

def ora(iso):
    """Ido, es DATUM IS, ha nem a vizsgalt napra esik.

    Egy datum nelkuli idopont ugy olvasodik, mintha ma lett volna. Merve
    2026-09-02: korall sessionje 17:45:27-kor kezdodott -- az ELOZO napon, es
    a kimenet ettol ugy nezett ki, mintha ket ora mulva indult volna.
    """
    t = helyi(iso)
    if time.strftime("%Y-%m-%d", t) == nap:
        return time.strftime("%H:%M:%S", t)
    return time.strftime("%m-%d %H:%M", t)


def erinti(r):
    return nap in (
        time.strftime("%Y-%m-%d", helyi(r[0])),
        time.strftime("%Y-%m-%d", helyi(r[1])) if r[1] else "",
    )

mai = [r for r in sorok if erinti(r)]

print("--- folytonossag: %s (%s), futtatta: %s ---" % (agens, nap, futtato))
if olvashatatlan:
    print("FIGYELEM: %d fajl NEM OLVASHATO (jogosultsag). A lenti kep RESZLEGES." % olvashatatlan)
    print("  Egy olvashatatlan atiratrol azt sem tudom, MIKOR volt aktiv, tehat")
    print("  akar ERRE a napra is eshet. Minden lenti szam ALSO KORLAT.")

if not mai:
    if olvashatatlan:
        # NEM UGYANAZ A KETTO, ES EZ A KULONBSEG A LENYEG: a "nincs" a VILAGROL
        # allit, a "nem latom" ROLAM. Merve 2026-09-02: acrobot alatt futtatva
        # ez az ag azt mondta, hogy ma nincs atiratom -- kozvetlenul azutan,
        # hogy ket mai ujraindulast mertem. A ket mai fajlom modja 600.
        print("NEM ELDONTHETO: egyetlen LATHATO atirat sem erinti ezt a napot,")
        print("  de %d fajlt nem tudtam elolvasni. Lehet, hogy epp azok a mai sessionok." % olvashatatlan)
        print("  Ez NEM azt jelenti, hogy nem futott ma semmi.")
        raise SystemExit(5)
    print("MA NINCS ATIRAT: %d korabbi session lathato, egyik sem erinti ezt a napot." % len(sorok))
    raise SystemExit(0)

print("%-9s %-11s %-11s %7s %8s" % ("atirat", "elso", "utolso", "sorok", "summary"))
for elso, utolso, nev, darab, summary in mai:
    print("%-9s %-11s %-11s %7d %8d" % (
        nev, ora(elso), ora(utolso) if utolso else "-", darab, summary))

print()
if olvashatatlan:
    print("LEGALABB %d ATIRAT FUTOTT MA (also korlat, %d fajl olvashatatlan)." % (len(mai), olvashatatlan))
    print("  Legalabb %d ujraindulas. Tobb is lehetett: egy nem olvasott atirat is" % (len(mai) - 1))
    print("  eshet erre a napra.")
elif len(mai) == 1:
    print("EGY ATIRAT MA: nincs jele ujraindulasnak.")
    print("  Az aktualis session %s ota fut." % ora(mai[0][0]))
else:
    print("MA %d ATIRAT FUTOTT: UJRAINDULAS TORTENT, %d alkalommal." % (len(mai), len(mai) - 1))
    print("  A legutolso session %s ota fut." % ora(mai[-1][0]))
    vissza = sum(r[4] for r in mai[1:])
    if vissza:
        print("  A kesobbi atiratokban %d compact-summary rekord all:" % vissza)
        print("  a korabbi elozmeny valamennyire VISSZAKERULT.")
    else:
        print("  A kesobbi atiratokban NULLA compact-summary rekord:")
        print("  az elozmeny NEM kerult vissza osszefoglalo alakban.")
if olvashatatlan:
    KOD = 5
print()
print("A HATARA: ez az ATIRATOT meri, nem a modell tenyleges kontextusat. Ha egy")
print("visszaallitas ugy tortenne, hogy a rekonstrualt elozmeny nem kerul be az")
print("atiratba, azt ez nem latja.")
raise SystemExit(KOD)
PYEOF
