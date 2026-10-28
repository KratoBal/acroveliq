#!/usr/bin/env bash
# ANSWERS: Hany keresés van Magyarorszagon egy kifejezesre, es milyen rokon kifejezesek (Google Ads Kulcsszotervezo, csak olvasas).
#
# Ugyanaz a loopback-minta, mint a gsc.sh: a jovahagyas EGY emberi kattintas. A kliens
# azonos a YouTube/Drive/Search Console kliensevel (store/.yt-client-id, .yt-client-secret).
#
# Balazs 2026-10-04 09:45 UTC (fo csatorna, message_id 1556240917852196996): "a google ads
# kulcsot is kerjuk meg most hogy meglegyen". Hasznalat: a termek-tudas SEO mezoihez
# (oldalcim, leiras) a valodi magyar keresesi szamok. Kampanyt NEM kezel, csak a
# KeywordPlanIdeaService-t hivja.
#
# Fajlok a store/ alatt:
#   .google-ads-developer-token   a kezeloi fiok API kozpontjabol (titok)
#   .google-ads-login-customer-id 6343878660, a hirdetesi fiok (info@ kozvetlenul eri el; a
#                                 kezeloi 7340345196 alatt USER_PERMISSION_DENIED jott, merve 10-04)
#   .gads-refresh-token           a jovahagyasbol (titok)
#
#   bash scripts/gads.sh auth-url
#   bash scripts/gads.sh auth-code <kod|teljes cimsor>
#   bash scripts/gads.sh accounts                     -> mely hirdetesi fiokokhoz fer hozza
#   bash scripts/gads.sh ideas <customer-id> <kifejezes> [kifejezes ...]
#                                                     -> magyar, Magyarorszag, havi atlag
#
# API-VERZIO: v25, merve 2026-10-04 (v19..v21 404 HTML: megszunt; v22..v25 el; v26 "Method not found"). Ha 404 jon, a verzio szunt meg.
# A fejlesztoi kulcs eleinte TESZT szintu: valodi fiokra csak a Basic access
# jovahagyasa utan valaszol (a hiba ilyenkor DEVELOPER_TOKEN_NOT_APPROVED).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "FAIL $*" >&2; exit 1; }

cmd="${1:-}"; shift || true
case "$cmd" in
  auth-url|auth-code) ;;
  accounts|ideas)
    [ -f "$ROOT/store/.gads-refresh-token" ] || die "nincs refresh token: eloszor gads.sh auth-url, majd auth-code <kod>"
    [ -r "$ROOT/store/.google-ads-developer-token" ] || die "a fejlesztoi kulcs nem olvashato: store/.google-ads-developer-token" ;;
  *) die "ismeretlen parancs: '${cmd}' -- auth-url | auth-code | accounts | ideas" ;;
esac

GA_ROOT="$ROOT" GA_CMD="$cmd" python3 - "$@" <<'PYEOF'
import json, os, sys, urllib.error, urllib.parse, urllib.request

STORE = os.path.join(os.environ["GA_ROOT"], "store")
CMD = os.environ["GA_CMD"]
REDIRECT = "http://localhost:8765/"
SCOPES = "https://www.googleapis.com/auth/adwords"
RT_FILE = ".gads-refresh-token"
API = "https://googleads.googleapis.com/v25"
HUNGARY = "geoTargetConstants/2348"
HUNGARIAN = "languageConstants/1024"


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


def call(url, data=None, headers=None, form=False):
    headers = dict(headers or {})
    body = None
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
        else:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, body, headers)
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        die("HTTP %s: %s" % (e.code, e.read().decode()[:600]))


def ads_headers():
    t = call("https://oauth2.googleapis.com/token", {
        "client_id": rd(".yt-client-id"),
        "client_secret": rd(".yt-client-secret"),
        "refresh_token": rd(RT_FILE),
        "grant_type": "refresh_token",
    }, form=True)
    if "access_token" not in t:
        die("nem jott access token: " + json.dumps(t)[:200])
    h = {"Authorization": "Bearer " + t["access_token"],
         "developer-token": rd(".google-ads-developer-token")}
    # A GADS_LOGIN felulirja: a kozvetlen hozzaferesu fiokhoz sajat maga a login-customer-id,
    # csak a kezeloi fiokon AT elert fiokhoz kell a kezelo azonositoja.
    login = os.path.join(STORE, ".google-ads-login-customer-id")
    if os.environ.get("GADS_LOGIN"):
        h["login-customer-id"] = os.environ["GADS_LOGIN"].replace("-", "")
    elif os.path.exists(login):
        h["login-customer-id"] = open(login).read().strip().replace("-", "")
    return h


a = sys.argv[1:]

if CMD == "auth-url":
    print("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": rd(".yt-client-id"),
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",
    }))

elif CMD == "auth-code":
    if not a:
        die("hasznalat: gads.sh auth-code <a code= ertek, vagy a teljes cimsor>")
    code = a[0]
    if "code=" in code:
        code = (urllib.parse.parse_qs(urllib.parse.urlparse(code).query).get("code") or [""])[0]
    if not code:
        die("nem talalok code= erteket abban, amit kaptam")
    r = call("https://oauth2.googleapis.com/token", {
        "client_id": rd(".yt-client-id"),
        "client_secret": rd(".yt-client-secret"),
        "code": code,
        "redirect_uri": REDIRECT,
        "grant_type": "authorization_code",
    }, form=True)
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

elif CMD == "accounts":
    r = call(API + "/customers:listAccessibleCustomers", headers=ads_headers())
    for n in r.get("resourceNames", []):
        print(n)

elif CMD == "ideas":
    if len(a) < 2:
        die("hasznalat: gads.sh ideas <customer-id> <kifejezes> [kifejezes ...]")
    cid = a[0].replace("-", "")
    r = call(API + "/customers/%s:generateKeywordIdeas" % cid, {
        "language": HUNGARIAN,
        "geoTargetConstants": [HUNGARY],
        "keywordPlanNetwork": "GOOGLE_SEARCH",
        "keywordSeed": {"keywords": a[1:]},
    }, headers=ads_headers())
    rows = r.get("results", [])
    print("otletek: %d" % len(rows))
    for x in rows:
        m = x.get("keywordIdeaMetrics", {})
        print("%s\thavi %s\tverseny %s" % (x.get("text"), m.get("avgMonthlySearches", "?"), m.get("competition", "?")))
PYEOF
