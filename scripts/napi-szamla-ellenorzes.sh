#!/usr/bin/env bash
# ANSWERS: Rendben van-e a honap konyveloi csomagja: parosodtak-e a szamlak, megvan-e a PDF, ki vannak-e toltve az adatok?
#
# Balazs kerese, 2026-10-21 14:15 UTC (Acropora OS szal): a ho vegere a konyvelo egy csomagot kapjon, amiben lehetoseg
# szerint minden benne van, es minden nap fusson egy ellenorzes. Ez az ellenorzes: csak olvas (psql-ro, fleet_ro), a
# kerdesek az exchange/havi-elszamolas/napi-ellenorzes.sql fajlban allnak. Kimenet: egy rovid magyar osszesito a
# stdout-on (ezt kuldi a reggeli utemezes a Havi elszamolasok szalba), es a nyers sorok a store/napi-szamla-ellenorzes/
# alatt, napi fajlban, hogy a valtozas napra visszakeresheto legyen.
#
#   bash /home/marveen/marveen/scripts/napi-szamla-ellenorzes.sh
set -uo pipefail
ROOT=/home/marveen/marveen
SQL="$ROOT/exchange/havi-elszamolas/napi-ellenorzes.sql"
OUT_DIR="$ROOT/store/napi-szamla-ellenorzes"
KEY=/home/marveen/.ssh/id_ed25519_acropora_monitor
mkdir -p "$OUT_DIR"
NAP=$(bash "$ROOT/scripts/local-now.sh" full | cut -c1-10)
NYERS="$OUT_DIR/$NAP.txt"
if ! ssh -i "$KEY" fleet@162.55.216.28 psql-ro iwm34jaqp9xmwb72qkrqkwhy acropora tuples-pipe < "$SQL" > "$NYERS" 2>&1 || ! grep -q '^ki_osszes|' "$NYERS"; then
  echo "HIBA: a napi szamla-ellenorzes nem futott le ($NYERS)"; exit 1
fi
# The bank line comes from the app's own verdict (GET /missing-invoices/months, the flotta@ OS account, finance.view
# since 2026-10-21 20:33 UTC). If that call fails, the line falls back to the old upper bound and says so.
APP="$OUT_DIR/$NAP-app.json"
timeout 90 python3 "$ROOT/scripts/os-hianyzo-honapok.py" > "$APP" 2>/dev/null || : > "$APP"
python3 - "$NYERS" "$APP" <<'PY'
import json, sys
from decimal import Decimal, ROUND_HALF_UP
rows = {}
for line in open(sys.argv[1], encoding='utf-8'):
    parts = line.rstrip('\n').split('|', 2)
    if len(parts) == 3:
        rows[parts[0]] = (int(parts[1]), parts[2])
g = lambda k: rows.get(k, (0, ''))
lines = ['Napi számla-ellenőrzés, a hónap állása:']
lines.append(f'• Kimenő: {g("ki_osszes")[0]} számla, PDF nélkül {g("ki_pdf_nelkul")[0]}')
# the live tree's line since 2026-10-30 (acrobot): the query's fields are be_pdf_nelkul_tarolt, be_pdf_levelbol_van and
# be_pdf_nincs_egyezes; the older be_pdf_nelkul and be_pdf_megvan_de_nincs_kotve are gone from napi-ellenorzes.sql, and g()
# answers 0 for a missing key, so the old line would have printed zeros without a word (drift fixed, task drift-rogzites-1031)
lines.append(f'• Bejövő: {g("be_osszes")[0]} számla. A tárolt jelző (csak a Számlázz.hu feed jelzése) szerint PDF nélkül {g("be_pdf_nelkul_tarolt")[0]}; '
             f'ebből a begyűjtött levélben, Drive-on vagy feltöltésben megvan a PDF (számlaszám és adószám egyezik): {g("be_pdf_levelbol_van")[0]}; '
             f'nincs egyező PDF: {g("be_pdf_nincs_egyezes")[0]} (a kézi csatolást a mérés nem látja, a felület ezeket még mutathatja)')
lines.append(f'• Átnézésre vár: {g("atnezesre_var")[0]}; hiányos összeg: {g("be_hianyos_osszeg")[0]}; határidő nélkül: {g("be_hatarido_nelkul")[0]}')
try:
    months = json.load(open(sys.argv[2], encoding='utf-8'))['months']
except Exception:
    months = None
def bank_line(m):
    # the amount as the app sends it: a whole number in text today ("1239297", measured 2026-10-28), a
    # decimal ("12345.00") or a number tomorrow; int("12345.00") would take the whole summary down
    # (barracuda on #314), so it is read as a Decimal and rounded to forints
    amount = f'{int(Decimal(str(m["missingAmountHuf"])).quantize(Decimal(1), ROUND_HALF_UP)):,}'.replace(',', ' ')
    return (f'• Banki terhelések ({m["month"]}, a Hiányzó számlák lap szerint): {m["debitCount"]} terhelés, {m["found"]} párosítva, '
            f'{m["notMatched"]} még nem párosodott, {m["noInvoice"]} számla nélkül, {m["noInvoiceNeeded"]} nem kér számlát; hiányzik {amount} Ft')
bank, why = None, 'lapot most nem értem el'
if months:
    try:
        bank = bank_line(months[0])
    except Exception:
        why = 'lap válaszát most nem tudtam olvasni'
if bank:
    lines.append(f'• Olvasatlan dokumentum: {g("olvasatlan_dokumentum")[0]}')
    lines.append(bank)
else:
    # the other lines stand either way: one unreadable answer does not take the summary down
    lines.append(f'• Olvasatlan dokumentum: {g("olvasatlan_dokumentum")[0]}; számla nélküli banki terhelés: {g("terheles_szamla_nelkul")[0]} (a Hiányzó számlák {why}, ezért ez a régi felső becslés: csak a kézi párosítást látja)')
print('\n'.join(lines))
PY
