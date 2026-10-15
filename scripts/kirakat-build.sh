#!/usr/bin/env bash
# ANSWERS: Volt-e UJ TELEPITES a teszt kirakaton, viselkedes-meres nelkul (build-ujjlenyomat).
#
# Murena eszkoze, 2026-09-10, a flotta egeszenek atveve. Az eredeti:
# agents/murena/scripts/kirakat-build-ujjlenyomat.sh
#
# A Next a lapok HTML-jebe egy build-azonositot tesz HTML-megjegyzeskent. Ez MINDEN
# ujraepitesnel valtozik, tehat a kitelepules abbol is latszik, hogy semmilyen
# viselkedes nem valtozott meg.
#
# AMIT MEGMOND:  a build MAS, mint amit legutobb lattal -> volt uj telepites.
# AMIT NEM MOND: hogy MELYIK commit van kint. Ez nem SHA, hanem build-azonosito, es
#                ket epites UGYANABBOL a commitbol is ket kulonbozo erteket ad.
#
# A KETTO EGYUTT HASZNALANDO, ES MAS A KOLTSEGUK:
#   ez az ujjlenyomat   VOLT-E telepites            olcso, viselkedestol fuggetlen
#   viselkedes-meres    A MI valtozasunk van-e kint draga, de ez a valodi kerdes
# Ha az ujjlenyomat NEM valtozott, felesleges viselkedest merni.
#
# === KET KULON GEP, ES 2026-09-10-EN OSSZEKEVERTEM OKET (acrobot) ===
#
#   https://shop-staging.acropora.hu     a KIRAKAT (Next). Innen jon az ujjlenyomat.
#   https://commerce-stage.acropora.hu   a Medusa HATTER. A /health-je csak "OK"-ot mond,
#                                        /api/health-je "Cannot GET", /hu-ja 404.
#
# Azt allitottam, hogy "a teszt kirakat /health valasza nem mond commitot, tehat alkalmatlan
# felulet". A merest a HATTEREN vegeztem, nem a kirakaton. Egy alkalmatlannak nevezett
# felulet, amit a rossz rendszeren mertek, ugyanugy nez ki, mint egy valodi korlat.
#
# === EGY NEMA HIBA, AMIT MURENA ELKAPOTT, ES AMIERT ITT ALL ===
#
# A `tr -d '<!->'` alak HELYTELEN: a `!->` a tr szemeben TARTOMANY (0x21-0x3E), tehat a
# SZAMJEGYEKET is torli. A valodi `6TD1hUrXwAv5AZKdWyz4s` ertekbol `TDhUrXwAvAZKdWyzs` lett,
# ami tokeletesen hiheto build-azonositonak nez ki, es soha nem egyezett volna semmivel.
# Csak azert derult ki, mert volt egy ISMERT ertek, amihez merni lehetett.
#
# HASZNALAT:  bash /home/marveen/marveen/scripts/kirakat-build.sh [alap-url]
set -euo pipefail
ALAP="${1:-https://shop-staging.acropora.hu}"
UT="${2:-/api/health}"
# A `|| true` NEM kenyelmi: nelkule a grep nulla talalata (exit 1) a `set -e` miatt
# megoli a szkriptet MIELOTT a lenti magyarazat kiirodna. Merve 2026-09-10: a hatteren
# futtatva nema `exit 1` jott, es epp az a mondat veszett el, amiert a szkript letezik.
# The test storefront sits behind HTTP basic auth since 2026-10-15 (Balazs, stage P1-00b).
# The credentials go to curl through a config file on a process-substitution fd, never on
# argv; without them a stage host answers 401 and the fingerprint would read as missing.
# The password is generated alphanumeric-safe (token_urlsafe): a quote or backslash in it
# would break curl's config parsing.
AUTH_FILE="/home/marveen/marveen/store/.stage-basic-auth"
lekeres() {
  # Exact host match, https only: a substring test would hand the password to
  # https://staging.anything.example, https://anything.example/staging, or (with a
  # colon allowed after the host) the userinfo form https://staging.acropora.hu:x@evil/.
  if [[ "$ALAP" =~ ^https://(staging|partner-staging|shop-staging)\.acropora\.hu(/|$) && -r "$AUTH_FILE" ]]; then
    curl -s -m 20 -K <(printf 'user = "%s:%s"\n' "$(sed -n 1p "$AUTH_FILE")" "$(sed -n 2p "$AUTH_FILE")") "$1"
  else
    curl -s -m 20 "$1"
  fi
}
ERTEK="$(lekeres "${ALAP}${UT}" \
  | grep -o '<!--[A-Za-z0-9_-]\{15,\}-->' \
  | head -1 \
  | sed -e 's/^<!--//' -e 's/-->$//' || true)"
if [[ -z "$ERTEK" ]]; then
  echo "NINCS UJJLENYOMAT: ${ALAP}${UT}" >&2
  echo "  Ez NEM azt jelenti, hogy nem volt telepites. Eloszor nezd meg, hogy ez a gep" >&2
  echo "  egyaltalan a KIRAKAT-e: a Medusa hatter (commerce-stage) soha nem ad ujjlenyomatot." >&2
  echo "  A locale nelkuli nem letezo ut (/nincs-ilyen) szinten nem adja vissza; a ket mukodo" >&2
  echo "  alak (merve 2026-09-10): /api/health es /hu/<nem-letezo-lap>." >&2
  exit 2
fi
echo "$ERTEK"
