#!/usr/bin/env bash
# ANSWERS: Friss-e a ReefClub adag-lista vetitese az OS-ben, es ha nem, miert. Egy sor: OK vagy RIASZT.
#
#   bash scripts/vetites-figyelo.sh                                  # a teszt OS (stage)
#   bash scripts/vetites-figyelo.sh https://api.acropora.hu          # az eles, amint ott is kint van
#
# KARTYA 2f0d7acd (acrobot 34061). Az OS a ReefClub-szerepnek egy vetitett adag-listat epit; ha
# az elavul, a vevo az ajanlasnal nem kap adagot (a 8. szelet kapuja), es ezt kivulrol semmi nem
# latja. Ez a szkript az utemezett feladat szeme.
#
# AMIT OLVAS, ES MIERT EZT: a szolgaltatas nyilvanos /health valaszanak doseProjection mezojet
# (stale, ageHours, rowCount, failingSinceLastSuccess; acropora-os #1763). A reszletes vegpont
# (GET /dose-effects/projection) PRODUCTS_VIEW jogot ker, es a flottanak a stage OS-ben nincs
# ilyen felhasznaloja (merve 2026-10-21: hitelesites nelkul 401). Kulcs es titok itt nincs.
#
# A KIMENET EGY SOR, es a kilepesi kod is mond:
#   0  OK      vetites friss, es az ujraepites nem bukik most
#   1  RIASZT  az okkal: elavult; az ujraepites a legutobbi siker ota bukik; a mezo hianyzik
#              (regi kiadas fut, a #1763 elott); a mezo null (az OS nem tudta olvasni); a /health
#              nem elerheto vagy nem JSON
#   2  hibas hivas
#
# AMIT NEM MOND MEG: a hiba SZOVEGET. Az a PRODUCTS_VIEW mogott marad; RIASZT utan a reszleteket
# az OS felhasznaloi feluleten vagy a vegponton kell megnezni, bejelentkezve.

set -uo pipefail

if [ "$#" -gt 1 ]; then
  echo "hasznalat: bash scripts/vetites-figyelo.sh [alap-url]" >&2
  exit 2
fi
BASE="${1:-https://api-staging.acropora.hu}"
BASE="${BASE%/}"
case "$BASE" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "hasznalat: az alap-url https:// (vagy helyi teszthez http://127.0.0.1:<port>)" >&2; exit 2 ;;
esac

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
CODE="$(curl -s -o "$BODY_FILE" -w '%{http_code}' --max-time 15 "${BASE}/health" 2>/dev/null || true)"

python3 - "$BASE" "${CODE:-000}" "$BODY_FILE" <<'FIGYELO'
import json, sys
base, code, path = sys.argv[1], sys.argv[2], sys.argv[3]

def alarm(reason):
    print(f"RIASZT vetites ({base}): {reason}")
    sys.exit(1)

if code == "000":
    alarm("a /health nem erheto el")
try:
    health = json.load(open(path, encoding="utf-8"))
except ValueError:
    alarm(f"a /health valasza nem JSON (http {code})")
if not isinstance(health, dict):
    alarm(f"a /health valasza nem objektum (http {code})")
if "doseProjection" not in health:
    alarm(f"a /health nem ad doseProjection mezot (http {code}): regi kiadas fut, a #1763 elotti")
p = health["doseProjection"]
if p is None:
    alarm(f"az OS nem tudta olvasni a vetites allapotat (doseProjection: null, http {code})")

# The shape first (barracuda, #274): a missing or renamed key read as False would say OK on a
# field this script does not understand, and a non-object would crash with no line. Unknown shape
# is RIASZT. After this only checked numbers reach the line (it lands in an agent's context).
def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)
known = (
    isinstance(p, dict)
    and isinstance(p.get("stale"), bool)
    and isinstance(p.get("failingSinceLastSuccess"), bool)
    and isinstance(p.get("rowCount"), int) and not isinstance(p.get("rowCount"), bool)
    and "ageHours" in p and (p["ageHours"] is None or is_number(p["ageHours"]))
)
if not known:
    alarm(f"a doseProjection alakja ismeretlen (http {code})")

reasons = []
if p.get("failingSinceLastSuccess"):
    reasons.append("az ujraepites a legutobbi siker ota bukik")
if p.get("stale"):
    age = p.get("ageHours")
    reasons.append("elavult: meg soha nem epult fel" if age is None else f"elavult: {age} oraja epult utoljara")
if reasons:
    alarm("; ".join(reasons) + f" ({p.get('rowCount')} sor)")
print(f"OK vetites ({base}): {p.get('ageHours')} oraja epult, {p.get('rowCount')} sor")
FIGYELO
