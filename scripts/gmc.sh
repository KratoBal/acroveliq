#!/usr/bin/env bash
# ANSWERS: Mit lat a Google Merchant Center es a GA4 (Analytics) a boltrol: fiokok, termek-allapotok, forgalom (csak olvasas).
#
# Ugyanaz a loopback-minta, mint a gsc.sh: a jovahagyas EGY emberi kattintas, a tobbi
# innen megy. A kliens azonos a YouTube/Drive/Search Console kliensevel (Desktop app,
# store/.yt-client-id es .yt-client-secret).
#
# SCOPE: `content` (Merchant API) es `analytics.readonly`. Balazs 2026-10-05 15:53 UTC
# (Google szal, message_id 1556695815538479176): "kuld", a javaslatom 1. pontjara
# (olvasasi jog a Merchant Centerhez es a GA4-hez). A Merchant API-nak NINCS csak-olvaso
# scope-ja, a `content` irni is tudna: ez a szkript ezert CSAK GET hivast tartalmaz, es
# irast ide felvenni kulon engedely nelkul nem szabad.
#
#   bash scripts/gmc.sh auth-url                       -> jovahagyo link
#   bash scripts/gmc.sh auth-code <kod|teljes cimsor>  -> a kod bevaltasa
#   bash scripts/gmc.sh merchant-accounts              -> mely Merchant fiokokat latja
#   bash scripts/gmc.sh product-issues <mc-azonosito>  -> termek-allapotok es hibak osszesitve
#   bash scripts/gmc.sh ga4-properties                 -> mely GA4 tulajdonokat latja
#
# A cimsor NEM fog betoltodni (http://localhost:8765/...), ez NEM hiba: a kodot
# onnan kell kimasolni.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "FAIL $*" >&2; exit 1; }

cmd="${1:-}"; shift || true
case "$cmd" in
  auth-url|auth-code) ;;
  merchant-accounts|ga4-properties|product-issues) [ -f "$ROOT/store/.gmc-refresh-token" ] || die "nincs refresh token: eloszor gmc.sh auth-url, majd auth-code <kod>" ;;
  *) die "ismeretlen parancs: '${cmd}' -- auth-url | auth-code | merchant-accounts | product-issues | ga4-properties" ;;
esac

GMC_ROOT="$ROOT" GMC_CMD="$cmd" python3 - "$@" <<'PYEOF'
import json, os, sys, urllib.error, urllib.parse, urllib.request

STORE = os.path.join(os.environ["GMC_ROOT"], "store")
CMD = os.environ["GMC_CMD"]
REDIRECT = "http://localhost:8765/"
SCOPES = "https://www.googleapis.com/auth/content https://www.googleapis.com/auth/analytics.readonly"
RT_FILE = ".gmc-refresh-token"


def die(msg):
    print("FAIL " + msg, file=sys.stderr)
    sys.exit(1)


def rd(name):
    p = os.path.join(STORE, name)
    if not os.path.exists(p):
        die("hianyzik: store/" + name)
    v = open(p).read().strip()
    if not v:
        die("ures fajl: store/" + name)
    return v


def post_form(url, data):
    req = urllib.request.Request(url, urllib.parse.urlencode(data).encode())
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        die("HTTP %s: %s" % (e.code, e.read().decode()[:400]))


def access_token():
    r = post_form("https://oauth2.googleapis.com/token", {
        "client_id": rd(".yt-client-id"),
        "client_secret": rd(".yt-client-secret"),
        "refresh_token": rd(RT_FILE),
        "grant_type": "refresh_token",
    })
    if "access_token" not in r:
        die("nem jott access token: " + json.dumps(r)[:200])
    return r["access_token"]


def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    try:
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        die("HTTP %s: %s" % (e.code, e.read().decode()[:600]))


a = sys.argv[1:]

if CMD == "auth-url":
    print("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": rd(".yt-client-id"),
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",   # enelkul NINCS refresh token
        "prompt": "consent",        # ismetelt jovahagyasnal is adjon UJ refresh tokent
    }))

elif CMD == "auth-code":
    if not a:
        die("hasznalat: gmc.sh auth-code <a code= ertek, vagy a teljes cimsor>")
    code = a[0]
    if "code=" in code:
        code = (urllib.parse.parse_qs(urllib.parse.urlparse(code).query).get("code") or [""])[0]
    if not code:
        die("nem talalok code= erteket abban, amit kaptam")
    r = post_form("https://oauth2.googleapis.com/token", {
        "client_id": rd(".yt-client-id"),
        "client_secret": rd(".yt-client-secret"),
        "code": code,
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    })
    if "refresh_token" not in r:
        die("jott access token, de refresh NEM -- hianyzik az access_type=offline, vagy a prompt=consent")
    p = os.path.join(STORE, RT_FILE)
    old = os.umask(0o077)
    with open(p, "w") as f:
        f.write(r["refresh_token"])
    os.umask(old)
    os.chmod(p, 0o600)
    print("OK refresh token mentve: store/" + RT_FILE)
    print("scope: " + r.get("scope", "(nem jott vissza)"))

elif CMD == "merchant-accounts":
    r = get("https://merchantapi.googleapis.com/accounts/v1/accounts", access_token())
    accts = r.get("accounts", [])
    if not accts:
        print("A fiok egyetlen Merchant Center fiokot sem lat (0).")
    for x in accts:
        print("%s\t%s" % (x.get("name"), x.get("accountName")))

elif CMD == "product-issues":
    if not a:
        die("hasznalat: gmc.sh product-issues <merchant azonosito (a merchant-accounts kimenetebol)>")
    tok = access_token()
    url = "https://merchantapi.googleapis.com/products/v1/accounts/%s/products?pageSize=1000" % a[0]
    prods, page = [], None
    while True:
        r = get(url + ("&pageToken=" + urllib.parse.quote(page) if page else ""), tok)
        prods += r.get("products", [])
        page = r.get("nextPageToken")
        if not page:
            break
    states, issues, examples = {}, {}, {}
    for p in prods:
        st = p.get("productStatus", {})
        for d in st.get("destinationStatuses", []):
            for k in ("approvedCountries", "pendingCountries", "disapprovedCountries"):
                if d.get(k):
                    key = (d.get("reportingContext"), k)
                    states[key] = states.get(key, 0) + 1
        # one issue is listed once PER reporting context, so count each product once
        seen = set()
        for i in st.get("itemLevelIssues", []):
            key = (i.get("severity"), i.get("code"), i.get("description"))
            if key in seen:
                continue
            seen.add(key)
            issues[key] = issues.get(key, 0) + 1
            examples.setdefault(key, (p.get("productAttributes") or {}).get("title") or p.get("offerId"))
    print("termek: %d" % len(prods))
    for (ctx, k), n in sorted(states.items()):
        print("%s\t%s\t%d" % (ctx, k, n))
    print("--- hibak (sulyossag, kod, leiras, darab, pelda) ---")
    for key, n in sorted(issues.items(), key=lambda x: -x[1]):
        print("%s\t%s\t%s\t%d\t%s" % (key[0], key[1], key[2], n, examples[key]))

elif CMD == "ga4-properties":
    r = get("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200", access_token())
    sums = r.get("accountSummaries", [])
    if not sums:
        print("A fiok egyetlen GA4 fiokot sem lat (0).")
    for s in sums:
        for p in s.get("propertySummaries", []):
            print("%s\t%s\t%s" % (s.get("displayName"), p.get("property"), p.get("displayName")))
PYEOF
