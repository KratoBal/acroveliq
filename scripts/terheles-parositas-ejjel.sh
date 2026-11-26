#!/usr/bin/env bash
# ANSWERS: Melyik banki terheles all szamla nelkul UGY, ahogy az OS Hianyzo szamlak oldala latja (nem a nyers 50-es szam), es miert nem parosit magatol?
#
# Balazs kerese, 2026-11-12 21:17 UTC (Eldontendo szal, msg 1570548064123359384): "Kerek egy naponta ejszaka lefuto
# ellenorzest az ilyen esetekre is. Bar nem ertem ami fut es reggel kapok rola jelentest az miert nem fogja meg az
# ilyeneket". A valasz arra, miert nem fogta meg: a napi-szamla-ellenorzes terheles_szamla_nelkul sora MINDEN parositatlan
# terhelest szamol (fizetes, adó, berlet is, ma 50), es csak a 8 legnagyobbat irja ki: a niceshops benne volt, a Hetzner
# nem latszott, es a zaj eltemette mindkettot. Ez a szkript az OS SAJAT besorolasat olvassa (a Hianyzo szamlak honap-lapja,
# eles API, flotta@ FINANCE_VIEW, csak olvas): csak a "nincs parositva" es a "nincs szamla" allapotu sorok, MIND, es
# soronkent egy gepi ok-jelzes:
#   - jelolt van, de nem parosodott     -> az automatikus parosito kuszobe / dontese a kerdes
#   - jelolt nincs, a kozlemenyben deviza all, az eredeti osszeg nincs kiolvasva -> kivonat-olvaso hiba (Hetzner 11-12)
#   - jelolt nincs                      -> a szamla nincs a rendszerben, vagy az olvasata hianyos (niceshops 11-12)
# 2026-09-tol (a rendszer innen vezeti) minden honapot nez (Balazs: "A mult honapban ugyanez volt").
#
#   bash /home/marveen/marveen/scripts/terheles-parositas-ejjel.sh          -> osszesito a stdout-on, nyers JSON a store/ alatt
set -uo pipefail
ROOT=/home/marveen/marveen
OUT_DIR="$ROOT/store/terheles-parositas"
mkdir -p "$OUT_DIR"
exec python3 - "$ROOT" "$OUT_DIR" <<'EOF'
import json, sys, re, http.cookiejar, urllib.request, datetime, os
root, out_dir = sys.argv[1], sys.argv[2]
B = "https://api.acropora.hu"
pw = open(os.path.join(root, "store/.os-flotta-jelszo")).read().strip()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
try:
    op.open(urllib.request.Request(B + "/auth/login/password",
        data=json.dumps({"email": "flotta@acropora.hu", "password": pw}).encode(),
        headers={"Content-Type": "application/json"}), timeout=30)
except Exception as e:
    print("HIBA: az eles OS bejelentkezes nem sikerult (%s). Ma nincs terheles-ellenorzes." % e); sys.exit(1)

today = datetime.date.today()
first = today.replace(day=1)
prev = (first - datetime.timedelta(days=1)).replace(day=1)
# every month since the system keeps missing invoices (2026-09, Balazs 10-01 "az augusztus mar kesz", memory 1981)
months, d = [], datetime.date(2026, 9, 1)
while d <= first:
    months.append(d.strftime("%Y-%m"))
    d = (d + datetime.timedelta(days=32)).replace(day=1)
WATCH = {"NOT_MATCHED", "NO_INVOICE"}
cur = re.compile(r"\d[\d.,]*\s?(EUR|USD|GBP|CHF)", re.I)
rows, raw = [], {}
for m in months:
    page, items = 1, []
    while True:
        t = json.load(op.open(B + "/missing-invoices/months/%s?page=%d" % (m, page), timeout=60))
        items += t.get("items", [])
        p = t.get("pagination") or {}
        if page >= (p.get("totalPages") or 1): break
        page += 1
    raw[m] = items
    for i in items:
        if i.get("state") not in WATCH: continue
        det = json.load(op.open(B + "/missing-invoices/items/" + i["id"], timeout=60))
        cands = det.get("candidates") or []
        narr = det.get("narrative") or ""
        if cands:
            ok = "jelolt van (%d), megsem parosodott" % len(cands)
        elif cur.search(narr) and not det.get("original"):
            ok = "devizas terheles, az eredeti osszeg nincs kiolvasva a kozlemenybol"
        else:
            ok = "nincs jelolt: a szamla nincs bent, vagy az olvasata hianyos (osszeg, elado)"
        rows.append((m, det.get("bookingDate"), det.get("amount"), det.get("currency"),
                     (det.get("partner") or "?")[:40], det.get("state"), ok))

stamp = today.isoformat()
with open(os.path.join(out_dir, stamp + ".json"), "w") as f:
    json.dump({"months": months, "rows": rows}, f, ensure_ascii=False, indent=1)
if not rows:
    print("Terheles-parositas (%s): minden terheles rendben az OS szerint." % ", ".join(months)); sys.exit(0)
print("Terheles-parositas (%s): %d terheles all szamla nelkul az OS szerint." % (", ".join(months), len(rows)))
for r in sorted(rows, key=lambda r: (r[0], r[1] or "")):
    m, d, a, c, p, s, ok = r
    try: a = "{:,.0f}".format(float(a)).replace(",", " ")
    except Exception: pass
    print("  %s  %s %s  %s  [%s]  %s" % (d, a, c, p, "nincs szamla" if s == "NO_INVOICE" else "nincs parositva", ok))
EOF
