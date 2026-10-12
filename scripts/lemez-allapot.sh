#!/usr/bin/env bash
# ANSWERS: Mennyi hely van a ket gepen, es mi foglalja: a Docker melyik resze no, es mennyi nyerheto vissza.
# lemez-allapot.sh -- disk state of BOTH machines, with the Docker breakdown.
#
# WHY THIS EXISTS, measured 2026-09-02 10:55: the stage host stood at 82 percent and
# 30 GB of it was Docker build cache, of which 29.87 GB had never been reused. One
# prune took it to 49 percent. The cache grows with EVERY deploy and never cleans
# itself, so this comes back. Balazs asked for a twice-daily look rather than a weekly
# automatic sweep, because he wants to see the number before anything is deleted.
#
# WHAT IT MEASURES, AND WHAT IT CANNOT:
#   PROD (this host)  -- df only. There is no docker binary inside this container, so
#                        the Docker breakdown is NOT available here. A rising number
#                        on prod therefore names a symptom, not a cause.
#   STAGE / AI host   -- df AND docker system df, over ssh as user fleet.
#
# It NEVER prunes. Deleting is a separate command, and a separate decision.
#
#   bash /home/marveen/marveen/scripts/lemez-allapot.sh
#
set -uo pipefail

STAGE_HOST=fleet@100.88.199.87
STAGE_KEY="$HOME/.ssh/id_ed25519_acropora_monitor"
WARN=70   # percent: above this the line is marked

mark() {
  # $1 = use percent as plain number
  if [[ -n "${1:-}" ]] && [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= WARN )); then
    echo "   >>> $1 SZAZALEK, A KUSZOB ($WARN) FOLOTT <<<"
  fi
}

echo "=========================================================================="
echo " LEMEZ-ALLAPOT   $(date '+%Y-%m-%d %H:%M')"
echo "=========================================================================="

echo
echo "===== ELES GEP (acropora-prod-01) ====="
echo "  A GEPNEK KET LEMEZE VAN, ES NEM UGYANAZ TELIK MEG (merve 2026-09-18 13:3x):"
echo "    /dev/sda1  a rendszere      -- ritkan mozdul"
echo "    /dev/sdb   a /var/lib/docker -- EZ telik meg, es a flotta kontenere IS ezen all"
echo "  Ezert a lenti 'belulrol' sor NEM a gep gyokerlemeze, hanem a DOCKER lemez."
echo "  Aki a hoston 'df -h /'-t nez, MASIK szamot lat -- 2026-09-18-an 68 kontra 86 szazalek."
echo
echo "  --- belulrol (a flotta kontenere = /dev/sdb) ---"
df -h / | tail -1
PROD_PCT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
mark "$PROD_PCT"

echo "  --- a hostrol, ssh-val (mind a ket lemez + Docker-bontas) ---"
if [[ ! -r "$STAGE_KEY" ]]; then
  echo "     NEM OLVASHATO a kulcs: $STAGE_KEY"
else
  # A HATARIDO 120, NEM 60, ES EZT EGY SAJAT HIBA MERTE KI (2026-09-18 13:44):
  # a `docker system df` ezen a gepen 105 kepet es 792 gyorsitotar-reteget jar
  # be, es hatvan masodperc alatt NEM vegez. A timeout ilyenkor a felenel vagta
  # el a kimenetet -- a `df` sorok mar megvoltak, a Docker-bontas nem --, a
  # kilepesi kod pedig nem nulla lett.
  #
  # ES A REGI AG EBBOL AZT IRTA KI, HOGY "az ssh NEM ERTE EL a gepet", KOZBEN
  # OTT ALLTAK A HELYES SOROK ALATTA. Egy mero, ami elerhetetlennek nevez egy
  # gepet, amirol epp adatot hozott, rosszabb a hallgatasnal: a kovetkezo olvaso
  # a halozatot fogja keresni, nem a hataridot.
  # ES 2026-09-23 20:1x-KOR A 120 IS KEVES LETT, UGYANEBBOL AZ OKBOL: a gep azota
  # 544 gyorsitotar-rekordot hordoz, es a bejaras tobb mint ket percig tart. A
  # kimenet megint a `df` sorok utan vagodott el. Ez a hatarido tehat NEM egy
  # allando: a gep novekedesevel egyutt no, es a kovetkezo olvaso szamitson ra,
  # hogy megint keves lesz. Ha a CSONKA ag sul el, EZT emeld, ne a halozatot keresd.
  #
  # ES EGY MASIK HIBA UGYANONNAN, AMI NEM A HATARIDO: ugyanaz a parancs egyszer
  # hibaval tert vissza ("snapshotter.Usage failed ... no such file or directory"),
  # masodszorra hibatlanul lefutott. Egy ideiglenes fajl tunt el a szamolas kozben,
  # vagyis VERSENY volt, nem serules. Ezert egy sikertelen futas onmagaban nem
  # jelent romlast: ujra kell probalni, mielott barmit allitanank rola.
  PROD_OUT="$(timeout 300 ssh -i "$STAGE_KEY" -o BatchMode=yes -o ConnectTimeout=15 \
    fleet@162.55.216.28 'df -h / /var/lib/docker; echo "---DOCKER---"; docker system df || docker system df' 2>&1)"
  PROD_RC=$?
  echo "$PROD_OUT" | /bin/sed 's/^/     /'
  # A KILEPESI KOD ES A TARTALOM KET KULON KERDES. Csak akkor mondjuk azt, hogy
  # nem ertuk el, ha TENYLEG nem jott semmi; ha jott, de csonka, azt CSONKANAK
  # nevezzuk, mert a ket eset feloldasa mas (halozat kontra hatarido).
  if (( PROD_RC != 0 )); then
    if [[ -z "${PROD_OUT//[[:space:]]/}" ]]; then
      echo "     NEM ERTUK EL a gepet (nulla kimenet, kilepesi kod $PROD_RC)."
    else
      echo "     FIGYELEM: a fenti kimenet CSONKA (kilepesi kod $PROD_RC), valoszinuleg"
      echo "     hatarido. A megjelent sorok ervenyesek, a hianyzok nem leteznek."
    fi
  fi
fi

echo
echo "===== STAGE / AI GEP ($STAGE_HOST) ====="
if [[ ! -r "$STAGE_KEY" ]]; then
  echo "  NEM OLVASHATO a kulcs: $STAGE_KEY"
else
  STAGE_OUT="$(timeout 40 ssh -i "$STAGE_KEY" -o BatchMode=yes -o ConnectTimeout=15 \
    "$STAGE_HOST" 'df -h / /var/lib/docker; echo "---DOCKER---"; docker system df' 2>&1)"
  RC=$?
  if (( RC != 0 )); then
    echo "  NEM ERHETO EL (kilepesi kod $RC). A kimenet:"
    echo "$STAGE_OUT" | sed 's/^/    /'
  else
    echo "$STAGE_OUT" | sed 's/^/  /'
    STAGE_PCT="$(echo "$STAGE_OUT" | /bin/grep -m1 -E '^/dev/' | awk '{print $5}' | tr -dc '0-9')"
    mark "$STAGE_PCT"
  fi
fi

echo
echo "=========================================================================="
echo " HA A BUILD CACHE NOTT MEG (csak a stage gepen merheto):"
echo "   ssh -i $STAGE_KEY $STAGE_HOST docker builder prune -f"
echo " Ez CSAK a nem hasznalt fordito-gyorsitotarat viszi el."
echo
echo " A KEPEKHEZ (docker image prune -a) ENGEDELY NELKUL NE NYULJ. Az indok"
echo " 2026-09-02-en HELYESBITVE lett, mert ez a szoveg hamisat allitott:"
echo "   itt korabban az allt, hogy a STAGE gepen harom szolgaltatas van"
echo "   szandekosan leallitva. NEM. A harom szandekosan allo szolgaltatas az"
echo "   ELES gepre vonatkozik. A stage gepen a takaritas elott KETTO allt"
echo "   (infra-caddy-1 es a restore-proba, utobbi acrobot sajat mentes-"
echo "   probajanak maradeka)."
echo " A ket gep osszemosasa nem reszletkerdes volt: a dontes IRANYAT tolta el,"
echo " mert ugy tunt, tobbet kockaztatunk a stage-en, mint amennyit valojaban."
echo
echo " AMI VALTOZATLANUL ALL: egy allo kontener kepe ugyanugy hasznalatlannak"
echo " latszik, mint egy sose hasznalt kep, es a prune elvinne. Ezert kell"
echo " engedely -- de a szam, amit Balazs ele teszel, a HELYES gepre vonatkozzon."
echo "=========================================================================="
