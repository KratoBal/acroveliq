#!/usr/bin/env bash
# yt-stats.sh -- narrow wrapper around the YouTube Data + Analytics APIs for our own channel.
#
# WHY: same reasoning as fb-insights.sh. Content agents must not get raw curl -- they read
# web content and are a prompt-injection surface. Here the hosts are hardcoded, the write
# surface is deliberately tiny, and every credential is read from disk at call time so it
# never enters the model context, a prompt, or a transcript.
#
# WRITE SURFACE ("B-minusz", Balazs, 2026-08-16): analytics read + upload-as-private only.
# NO editing, deleting or publishing of existing videos, NO comment management. That is not
# a promise, it is the requested OAuth scope set: without youtube.force-ssl the API itself
# refuses. Uploads are pinned to privacyStatus=private in code; going public is a human
# click in YouTube Studio. Do not add force-ssl or a privacy flag without asking Balazs.
#
# Credentials (chmod 600, store/ is gitignored):
#   store/.yt-client-id      OAuth client id      (Desktop app -- NOT the TV/device type)
#   store/.yt-client-secret  OAuth client secret
#   store/.yt-refresh-token  written by `auth`, this is the long-lived one
#   store/.yt-access-token   short-lived cache, refreshed automatically
#
# Usage:
#   bash scripts/yt-stats.sh auth-url              # prints the consent URL to open in a browser
#   bash scripts/yt-stats.sh auth-code <code>      # redeems the code from the redirect address bar
#   bash scripts/yt-stats.sh whoami                # which channel are we actually attached to
#   bash scripts/yt-stats.sh stats [since] [until] # channel totals for a date range
#   bash scripts/yt-stats.sh top [n] [since] [until]  # best performing videos in the range
#   bash scripts/yt-stats.sh videos [n]            # most recent uploads (title, date, id)
#   bash scripts/yt-stats.sh upload <fajl> <cim> [leiras]   # ALWAYS private, no way to publish
#   bash scripts/yt-stats.sh raw-analytics "<querystring>"   # escape hatch, GET only
#
# Dates: YYYY-MM-DD. Default range: last 28 days.
# Output: raw JSON on success; "FAIL <reason>" + exit 1 otherwise. Secrets are NEVER printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLIENT_ID_FILE="$ROOT/store/.yt-client-id"
CLIENT_SECRET_FILE="$ROOT/store/.yt-client-secret"
REFRESH_FILE="$ROOT/store/.yt-refresh-token"
ACCESS_FILE="$ROOT/store/.yt-access-token"

# B-minusz scope set. yt-analytics-monetary.readonly is added only if Balazs asks for
# revenue figures -- see store/.yt-want-revenue (presence = yes).
#
# DO NOT add Drive (or other non-YouTube) scopes here. MEASURED 2026-08-16: Google rejects
# the consent outright with "This request contains scopes that cannot be requested together"
# (400 invalid_request) when yt-analytics.readonly is combined with drive.file. The YouTube
# Analytics scopes live in their own consent group. Drive therefore has its OWN authorization
# and its OWN refresh token -- see scripts/gdrive.sh (store/.gdrive-refresh-token).
SCOPES="https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload"
[ -f "$ROOT/store/.yt-want-revenue" ] && SCOPES="$SCOPES https://www.googleapis.com/auth/yt-analytics-monetary.readonly"

die() { echo "FAIL $*" >&2; exit 1; }

read_secret() {
  [ -f "$1" ] || die "hianyzik: $1"
  local v; v="$(tr -d ' \t\r\n' < "$1")"
  [ -n "$v" ] || die "ures fajl: $1"
  printf '%s' "$v"
}

# --- OAuth -------------------------------------------------------------------

# Google's device flow (TVs and Limited Input devices) accepts only a SHORT ALLOWLIST of
# scopes, and the Analytics ones are not on it: "Invalid device flow scope:
# .../auth/yt-analytics.readonly". Measured 2026-08-16, not guessed. So the device flow is
# out, and we use the loopback flow instead -- which still needs no software on Balazs's
# machine: he approves in the browser, the redirect lands on a dead localhost page, and he
# copies the `code=` value out of the address bar. Client type must be "Desktop app".
REDIRECT="http://localhost:8765/"

auth_url() {
  local cid; cid="$(read_secret "$CLIENT_ID_FILE")" || exit 1
  CID="$cid" REDIRECT="$REDIRECT" SCOPES="$SCOPES" python3 -c '
import os, urllib.parse
q = urllib.parse.urlencode({
    "client_id": os.environ["CID"],
    "redirect_uri": os.environ["REDIRECT"],
    "response_type": "code",
    "scope": os.environ["SCOPES"],
    "access_type": "offline",     # without this there is no refresh token at all
    "prompt": "consent",          # force a fresh refresh token even on re-approval
})
print("https://accounts.google.com/o/oauth2/v2/auth?" + q)
'
}

auth_code() {
  # Exchange the one-time code for a refresh token. The code dies in minutes and is
  # single-use; the client secret never leaves this machine.
  local code="$1" cid csec resp
  [ -n "$code" ] || die "hasznalat: yt-stats.sh auth-code <a code= ertek, vagy a teljes cimsor>"
  # Accept the whole redirect URL too: slicing the code out by hand is where a human
  # tired of clicking makes the one mistake that costs another round trip.
  case "$code" in
    *code=*) code="$(RAW="$code" python3 -c '
import os, urllib.parse as u
q = u.parse_qs(u.urlparse(os.environ["RAW"]).query)
print((q.get("code") or [""])[0])
')" ;;
  esac
  [ -n "$code" ] || die "nem talalok code= erteket abban amit kaptam"
  cid="$(read_secret "$CLIENT_ID_FILE")" || exit 1
  csec="$(read_secret "$CLIENT_SECRET_FILE")" || exit 1
  resp="$(curl -sS --max-time 30 -X POST "https://oauth2.googleapis.com/token" \
    --data-urlencode "client_id=$cid" --data-urlencode "client_secret@"<(printf '%s' "$csec") \
    --data-urlencode "code@"<(printf '%s' "$code") --data-urlencode "redirect_uri=$REDIRECT" \
    --data-urlencode "grant_type=authorization_code")" || die "halozati hiba a token cserenel"
  printf '%s' "$resp" | REFRESH="$REFRESH_FILE" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
if "refresh_token" not in d:
    err = d.get("error_description") or d.get("error") or "ismeretlen"
    extra = "" if "refresh" not in str(d) else " (jott access token, de refresh nem -- hianyzik az access_type=offline?)"
    print("FAIL " + err + extra, file=sys.stderr)
    raise SystemExit(1)
p = os.environ["REFRESH"]
with open(p, "w") as f: f.write(d["refresh_token"])
os.chmod(p, 0o600)
print("OK jovahagyva, refresh token elmentve")
' || die "a kod beváltása nem sikerult (lejart? mar felhasznaltad? rossz redirect?)"
  rm -f "$ACCESS_FILE"
}

access_token() {
  # Cached until 60s before expiry, then refreshed off the refresh token.
  if [ -f "$ACCESS_FILE" ]; then
    local cached
    cached="$(ACCESS="$ACCESS_FILE" python3 -c '
import json,os,time
try:
    d = json.load(open(os.environ["ACCESS"]))
    print(d["token"] if d.get("expires_at", 0) > time.time() + 60 else "")
except Exception:
    print("")
')"
    [ -n "$cached" ] && { printf '%s' "$cached"; return 0; }
  fi
  local cid csec resp
  cid="$(read_secret "$CLIENT_ID_FILE")" || exit 1
  csec="$(read_secret "$CLIENT_SECRET_FILE")" || exit 1
  [ -f "$REFRESH_FILE" ] || die "nincs refresh token. Futtasd elobb: yt-stats.sh auth-url, majd auth-code"
  local rt; rt="$(tr -d ' \t\r\n' < "$REFRESH_FILE")"
  resp="$(curl -sS --max-time 30 -X POST "https://oauth2.googleapis.com/token" \
    --data-urlencode "client_id=$cid" --data-urlencode "client_secret@"<(printf '%s' "$csec") \
    --data-urlencode "refresh_token@"<(printf '%s' "$rt") --data-urlencode "grant_type=refresh_token")" \
    || die "halozati hiba a token frissitesnel"
  printf '%s' "$resp" | ACCESS="$ACCESS_FILE" python3 -c '
import json,os,sys,time
d = json.load(sys.stdin)
if "access_token" not in d:
    print("FAIL token frissites: " + (d.get("error_description") or d.get("error","?")), file=sys.stderr)
    raise SystemExit(1)
p = os.environ["ACCESS"]
with open(p, "w") as f:
    json.dump({"token": d["access_token"], "expires_at": time.time() + d.get("expires_in", 3600)}, f)
os.chmod(p, 0o600)
print(d["access_token"], end="")
' || die "nem sikerult access tokent szerezni (visszavontad a hozzaferest?)"
}

api_get() {
  # api_get <full-url> <querystring>   -- GET only, token in the header, never in the URL.
  local url="$1" qs="${2:-}" tok body code
  tok="$(access_token)" || exit 1
  local -a args=(-sS -G --max-time 60 -w '\n%{http_code}')
  if [ -n "$qs" ]; then
    local IFS='&' pair
    for pair in $qs; do [ -n "$pair" ] && args+=(--data-urlencode "$pair"); done
  fi
  body="$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$tok") "$url")" || die "halozati hiba: $url"
  code="$(tail -n1 <<< "$body")"; body="$(sed '$d' <<< "$body")"
  [ "$code" = "200" ] || { echo "$body" >&2; die "HTTP $code"; }
  echo "$body"
}

DATA_API="https://www.googleapis.com/youtube/v3"
ANALYTICS_API="https://youtubeanalytics.googleapis.com/v2/reports"

default_since() { date -u -d '28 days ago' +%F; }
default_until() { date -u +%F; }

cmd="${1:-}"; shift || true

# Preflight. Without this, a missing credential dies inside a command substitution on the
# left of a pipe, python3 gets empty stdin, and the user sees a JSONDecodeError traceback
# instead of the one line that says what is actually missing.
require_auth() {
  [ -f "$CLIENT_ID_FILE" ] || die "hianyzik: $CLIENT_ID_FILE (Balazsnak kell letennie a Google OAuth client id-t)"
  [ -f "$CLIENT_SECRET_FILE" ] || die "hianyzik: $CLIENT_SECRET_FILE"
  [ -f "$REFRESH_FILE" ] || die "nincs meg jovahagyas. Futtasd elobb: bash scripts/yt-stats.sh auth-url, majd auth-code"
  access_token > /dev/null || exit 1
}

case "$cmd" in
  auth|auth-url) auth_url ;;

  auth-code) auth_code "${1:-}" ;;

  whoami)
    require_auth
    api_get "$DATA_API/channels" "part=snippet,statistics&mine=true" | python3 -c '
import json,sys
d = json.load(sys.stdin)
items = d.get("items") or []
if not items:
    print("(a token egyetlen csatornat sem lat -- rossz fiokot valasztottal a jovahagyasnal?)")
for c in items:
    s, st = c["snippet"], c.get("statistics", {})
    print("csatorna:", s.get("title"))
    print("id:      ", c["id"])
    print("feliratkozo:", st.get("subscriberCount"), "| video:", st.get("videoCount"), "| megtekintes:", st.get("viewCount"))
'
    ;;

  stats)
    require_auth
    since="${1:-$(default_since)}"; until_="${2:-$(default_until)}"
    api_get "$ANALYTICS_API" "ids=channel==MINE&startDate=$since&endDate=$until_&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares"
    ;;

  top)
    require_auth
    n="${1:-10}"; since="${2:-$(default_since)}"; until_="${3:-$(default_until)}"
    rows="$(api_get "$ANALYTICS_API" "ids=channel==MINE&startDate=$since&endDate=$until_&metrics=views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes&dimensions=video&sort=-views&maxResults=$n")" || exit 1
    ids="$(printf '%s' "$rows" | python3 -c '
import json,sys
print(",".join(r[0] for r in (json.load(sys.stdin).get("rows") or [])))
')"
    # The Analytics API only ever returns video IDs. A report full of bare IDs is unreadable,
    # so resolve the titles through the Data API before printing.
    titles="{}"
    [ -n "$ids" ] && titles="$(api_get "$DATA_API/videos" "part=snippet&id=$ids" | python3 -c '
import json,sys
print(json.dumps({v["id"]: v["snippet"].get("title","?") for v in json.load(sys.stdin).get("items",[])}))
')"
    printf '%s' "$rows" | TITLES="$titles" python3 -c '
import json,os,sys
t = json.loads(os.environ["TITLES"])
rows = json.load(sys.stdin).get("rows") or []
if not rows:
    print("(nincs adat erre az idoszakra)")
for vid, views, mins, avg, pct, likes in rows:
    # Percentage matters more than minutes: 40 min on a long live stream and 40 min on a
    # short video are not comparable, the share of the video actually watched is.
    print("%5d megtekintes | %6d perc | atlag %3d mp (%4.1f%%) | %2d like | %s" %
          (views, mins, avg, pct, likes, t.get(vid, vid)))
'
    ;;

  videos)
    require_auth
    n="${1:-10}"
    up="$(api_get "$DATA_API/channels" "part=contentDetails&mine=true" | python3 -c '
import json,sys
i = (json.load(sys.stdin).get("items") or [{}])[0]
print(i.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads", ""))
')"
    [ -n "$up" ] || die "nem talalom a feltoltesek lejatszasi listajat"
    api_get "$DATA_API/playlistItems" "part=snippet,contentDetails&playlistId=$up&maxResults=$n" | python3 -c '
import json,sys
for it in json.load(sys.stdin).get("items", []):
    s = it["snippet"]
    print(it["contentDetails"]["videoId"], s.get("publishedAt","")[:10], s.get("title","")[:70], sep="\t")
'
    ;;

  upload)
    require_auth
    # The ONLY write this script can do, and it is pinned to private. There is deliberately
    # no flag to change privacyStatus: publishing is Balazs clicking in YouTube Studio.
    file="${1:-}"; title="${2:-}"; desc="${3:-}"
    [ -n "$file" ] && [ -n "$title" ] || die "hasznalat: yt-stats.sh upload <fajl> <cim> [leiras]"
    [ -f "$file" ] || die "nincs ilyen fajl: $file"
    size="$(stat -c %s "$file")" || die "nem tudom megmerni a fajlt: $file"
    tok="$(access_token)" || exit 1
    meta="$(TITLE="$title" DESC="$desc" python3 -c '
import json,os
print(json.dumps({"snippet": {"title": os.environ["TITLE"], "description": os.environ["DESC"]},
                  "status": {"privacyStatus": "private", "selfDeclaredMadeForKids": False}}))
')"
    loc="$(curl -sS --max-time 60 -D - -o /dev/null -X POST \
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status" \
      -H @<(printf 'Authorization: Bearer %s\n' "$tok") -H "Content-Type: application/json; charset=UTF-8" \
      -H "X-Upload-Content-Length: $size" -H "X-Upload-Content-Type: video/*" \
      --data-binary "$meta" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p' | tail -1)"
    [ -n "$loc" ] || die "nem kaptam feltoltesi cimet (lejart a jovahagyas, vagy hianyzik a youtube.upload scope?)"
    echo "feltoltes indul, $size byte..."
    curl -sS --max-time 3600 -X PUT "$loc" \
      -H @<(printf 'Authorization: Bearer %s\n' "$tok") -H "Content-Type: video/*" \
      --data-binary "@$file" | python3 -c '
import json,sys
d = json.load(sys.stdin)
if "error" in d:
    print("FAIL feltoltes: " + d["error"].get("message","?"), file=sys.stderr); raise SystemExit(1)
print("OK feltoltve PRIVATKENT")
print("video id:", d.get("id"))
print("statusz: ", d.get("status", {}).get("privacyStatus"))
print("link:     https://studio.youtube.com/video/%s/edit" % d.get("id"))
print("A nyilvanossa tetel a Studio-ban, kezzel. Innen en nem tudom megtenni.")
' || die "a feltoltes nem fejezodott be"
    ;;

  raw-analytics)
    require_auth
    qs="${1:-}"; [ -n "$qs" ] || die "hasznalat: yt-stats.sh raw-analytics \"ids=channel==MINE&...\""
    api_get "$ANALYTICS_API" "$qs"
    ;;

  *)
    die "ismeretlen parancs: '${cmd:-}' -- auth-url | auth-code | whoami | stats | top | videos | upload | raw-analytics"
    ;;
esac
