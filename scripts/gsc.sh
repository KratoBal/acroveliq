#!/usr/bin/env bash
# ANSWERS: Milyen Google keresesekre jelenik meg az acropora.hu (Search Console, csak olvasas).
#
# Ugyanaz a loopback-minta, mint a gcal.sh es a gdrive.sh: a jovahagyas EGY emberi
# kattintas, a tobbi innen megy. A kliens azonos a YouTube/Drive/Calendar kliensevel
# (Desktop app, store/.yt-client-id es .yt-client-secret).
#
# SCOPE: CSAK `webmasters.readonly`. Balazs 2026-10-04 09:34 UTC (fo csatorna,
# message_id 1556238188123660340): "akkor kossuk be eloszor a search consolet". Iras
# (sitemap bekuldes, tulajdonos hozzaadasa) nem kell, ezert a teljes `webmasters` nem.
#
#   bash scripts/gsc.sh auth-url                       -> jovahagyo link
#   bash scripts/gsc.sh auth-code <kod|teljes cimsor>  -> a kod bevaltasa
#   bash scripts/gsc.sh sites                          -> mely tulajdonokat latja a fiok
#   bash scripts/gsc.sh queries <site> [nap] [oldal-szuro]
#                                                      -> keresesek: kattintas, megjelenes,
#                                                         atlagos helyezes (alap 90 nap)
#
# KET FIOK, KET TOKEN (2026-10-05): az alap token a balazs@ fioke, az a REGI URL-elotagos
# tulajdonokat latja (https:// es http://shop.acropora.hu/, 2024 ota). A domain-tulajdont
# (sc-domain:acropora.hu) egy masik fiok latja: GSC_TOKEN_FILE=.gsc-refresh-token-domainfiok.
#
# A cimsor NEM fog betoltodni (http://localhost:8765/...), ez NEM hiba: a kodot
# onnan kell kimasolni.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "FAIL $*" >&2; exit 1; }

cmd="${1:-}"; shift || true
case "$cmd" in
  auth-url|auth-code) ;;
  sites|queries) [ -f "$ROOT/store/${GSC_TOKEN_FILE:-.gsc-refresh-token}" ] || die "nincs refresh token: eloszor gsc.sh auth-url, majd auth-code <kod>" ;;
  *) die "ismeretlen parancs: '${cmd}' -- auth-url | auth-code | sites | queries" ;;
esac

GSC_ROOT="$ROOT" GSC_CMD="$cmd" python3 - "$@" <<'PYEOF'
import datetime, json, os, sys, urllib.error, urllib.parse, urllib.request

STORE = os.path.join(os.environ["GSC_ROOT"], "store")
CMD = os.environ["GSC_CMD"]
REDIRECT = "http://localhost:8765/"
SCOPES = "https://www.googleapis.com/auth/webmasters.readonly"
RT_FILE = os.environ.get("GSC_TOKEN_FILE", ".gsc-refresh-token")


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


def post(url, data, token=None, as_json=False):
    if as_json:
        body = json.dumps(data).encode()
        headers = {"Content-Type": "application/json"}
    else:
        body = urllib.parse.urlencode(data).encode()
        headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, body, headers)
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        die("HTTP %s: %s" % (e.code, e.read().decode()[:400]))


def access_token():
    r = post("https://oauth2.googleapis.com/token", {
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
        die("HTTP %s: %s" % (e.code, e.read().decode()[:400]))


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
        die("hasznalat: gsc.sh auth-code <a code= ertek, vagy a teljes cimsor>")
    code = a[0]
    if "code=" in code:
        code = (urllib.parse.parse_qs(urllib.parse.urlparse(code).query).get("code") or [""])[0]
    if not code:
        die("nem talalok code= erteket abban, amit kaptam")
    r = post("https://oauth2.googleapis.com/token", {
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

elif CMD == "sites":
    r = get("https://www.googleapis.com/webmasters/v3/sites", access_token())
    entries = r.get("siteEntry", [])
    if not entries:
        print("A fiok egyetlen Search Console tulajdont sem lat (0). Masik fiokkal kell jovahagyni.")
    for s in entries:
        print("%s\t%s" % (s.get("siteUrl"), s.get("permissionLevel")))

elif CMD == "queries":
    if not a:
        die("hasznalat: gsc.sh queries <site, pl. sc-domain:acropora.hu> [nap] [oldal-szuro]")
    site = a[0]
    days = int(a[1]) if len(a) > 1 else 90
    end = datetime.date.today() - datetime.timedelta(days=2)   # a GSC adat 2-3 napot kesik
    start = end - datetime.timedelta(days=days)
    body = {"startDate": start.isoformat(), "endDate": end.isoformat(),
            "dimensions": ["query"], "rowLimit": 1000}
    if len(a) > 2:
        body["dimensionFilterGroups"] = [{"filters": [
            {"dimension": "page", "operator": "contains", "expression": a[2]}]}]
    r = post("https://www.googleapis.com/webmasters/v3/sites/%s/searchAnalytics/query"
             % urllib.parse.quote(site, safe=""), body, access_token(), as_json=True)
    rows = r.get("rows", [])
    print("idoszak %s .. %s, sorok: %d" % (start, end, len(rows)))
    for x in rows:
        print("%s\tkatt %d\tmegj %d\thely %.1f" % (x["keys"][0], x["clicks"], x["impressions"], x["position"]))
PYEOF
