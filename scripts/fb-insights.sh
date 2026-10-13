#!/usr/bin/env bash
# ANSWERS: Mit mutatnak a Facebook oldal es a posztok szamai (csak olvasas).
# fb-insights.sh -- narrow, allowlist-friendly wrapper around the Facebook Graph API,
# READ-ONLY, for Page Insights.
#
# WHY: same reasoning as fleet-api.sh. The content agents (korall) must not get raw curl
# -- they read web content and are a prompt-injection surface, so a raw curl would be an
# exfiltration primitive. Here the host is HARDCODED to graph.facebook.com, only GET is
# ever issued, and the token is read from disk at call time so it never enters the model
# context, never appears in a prompt and never lands in a transcript.
#
# The token lives in store/.fb-page-token (chmod 600, store/ is gitignored).
#
# Usage:
#   bash scripts/fb-insights.sh check                       # what kind of token is this, does it expire, what scopes
#   bash scripts/fb-insights.sh pages                       # pages the token can see (id + name), and their page tokens' presence
#   bash scripts/fb-insights.sh page-token <page_id>        # store the never-expiring page token for that page
#   bash scripts/fb-insights.sh longlive                    # short user token -> 60-day token -> non-expiring page tokens
#   bash scripts/fb-insights.sh vault                       # pages whose page token is stashed (* = active)
#   bash scripts/fb-insights.sh use-page <page_id>          # switch the active page, offline, no user token needed
#   bash scripts/fb-insights.sh insights <metric>[,<metric>] [period] [since] [until]
#   bash scripts/fb-insights.sh posts [limit]               # recent posts with per-post reach/engagement
#   bash scripts/fb-insights.sh raw <edge> [querystring]    # e.g. raw me "fields=id,name" -- GET only
#
# ELO metrikak (2026-08, v21.0 -- a tobbit a Meta kivezette):
#   oldal:  page_post_engagements, page_follows (futo osszeg!), page_daily_follows_unique,
#           page_views_total, page_total_actions, page_video_views,
#           page_actions_post_reactions_total
#   poszt:  post_clicks, post_reactions_by_type_total, post_activity_by_action_type
#   HALOTT: page_impressions*, page_fans, page_reach, post_impressions*, post_engaged_users
#           -> "(#100) The value must be a valid insights metric"
#
# period: day | week | days_28 | lifetime   (default: day)
# since/until: YYYY-MM-DD
#
# Output: the raw Graph API JSON on success; "FAIL <reason>" + exit 1 otherwise.
# The token is NEVER printed, not even on failure.
set -uo pipefail

API_VER="v21.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="$ROOT/store/.fb-page-token"
PAGE_FILE="$ROOT/store/.fb-page-id"
# All page tokens the user token could see. CAVEAT, learned the hard way: a page token is
# only non-expiring when it was minted from a LONG-LIVED user token. Minted from the
# short-lived one the Graph Explorer hands out, it dies with that user session -- including
# the moment the user re-authorizes, which invalidates the old session outright (OAuth 190,
# subcode 467). So: exchange first (`longlive`), harvest second.
VAULT_FILE="$ROOT/store/.fb-page-tokens.json"
SECRET_FILE="$ROOT/store/.fb-app-secret"
USER_TOKEN_FILE="$ROOT/store/.fb-user-token"

die() { echo "FAIL $*" >&2; exit 1; }

[ -f "$TOKEN_FILE" ] || die "nincs token: $TOKEN_FILE hianyzik. Balazsnak kell letennie oda a Facebook tokent."
TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || die "a token fajl ures: $TOKEN_FILE"

# Scrub the token out of anything we print, belt and braces.
# No secret on any command line: /proc shows every process's argv to every agent
# (#85, #87), so sed gets its script from a file descriptor, not from argv.
scrub() { sed -f <(printf 's|%s|<TOKEN>|g\n' "$TOKEN"); }

get() {
  # get <path> [querystring] [token_param]   -- querystring is "a=1&b=2"; each pair is
  # url-encoded here, so nothing (least of all the token) is ever built into a
  # shell-visible URL. token_param names a query parameter that carries the page
  # token (debug_token's input_token): curl reads its value from a file descriptor,
  # so the token is not in curl's argv either (#87).
  local path="$1" qs="${2:-}" token_param="${3:-}"
  local url="https://graph.facebook.com/$API_VER/$path"
  local -a args=(-sS -G --max-time 30 -w '\n%{http_code}')
  local pair
  if [ -n "$qs" ]; then
    local IFS='&'
    for pair in $qs; do
      [ -n "$pair" ] && args+=(--data-urlencode "$pair")
    done
  fi
  local body code
  if [ -n "$token_param" ]; then
    body="$(curl "${args[@]}" --data-urlencode "$token_param@"<(printf '%s' "$TOKEN") \
      -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$url" 2>&1)" || die "halozati hiba a Graph API fele"
  else
    body="$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$url" 2>&1)" || die "halozati hiba a Graph API fele"
  fi
  code="$(tail -n1 <<< "$body")"
  body="$(sed '$d' <<< "$body")"
  if [ "$code" != "200" ]; then
    echo "$body" | scrub >&2
    die "Graph API HTTP $code"
  fi
  echo "$body" | scrub
}

# Same contract as get(), but with the long-lived USER token instead of the page token.
#
# Why this exists: some edges only accept a user token. The clearest case is
# `ads_archive` (the public Ad Library). Calling it with the page token returns
# HTTP 400, OAuthException code 10, subcode 2332004, "Application does not have
# permission for this action" -- and the Hungarian rendering says a ROLE is needed
# from the app owner. That reads like a failed business verification and is NOT one:
# an app role belongs to a PERSON, and a Page cannot hold one. The proof is one call:
# `raw me 'fields=id,name'` comes back as the Page, not as the human.
# (Measured by barracuda, 2026-08-18. Before escalating an ads_archive refusal to the
# owner as a portal problem, retry it here with raw-user -- otherwise the question
# sent to a human is the wrong question.)
# THE TWO TOKENS PULL IN OPPOSITE DIRECTIONS, and neither error says so. Measured
# 2026-08-21, both directions in one day:
#   * ads_archive and the ad account need the USER token. With the page token they
#     fail as "(#10) Application does not have permission", which reads like an app
#     problem and is not one -- an app role belongs to a person, and a Page cannot
#     hold one.
#   * posts and insights need the PAGE token. With the user token they fail as
#     "Felhasznaloi hozzaferesi kod nem tamogatott" (code 190, subcode 2069032).
# So a refusal on one branch is a reason to try the OTHER branch before escalating
# anything to a human. Both messages sound final and neither mentions the other.
get_user() {
  local path="$1" qs="${2:-}"
  [ -f "$USER_TOKEN_FILE" ] || die "nincs user token: $USER_TOKEN_FILE hianyzik (a 'longlive' parancs keszíti)"
  local utok; utok="$(tr -d ' \t\r\n' < "$USER_TOKEN_FILE")"
  [ -n "$utok" ] || die "a user token fajl ures: $USER_TOKEN_FILE"
  local url="https://graph.facebook.com/$API_VER/$path"
  local -a args=(-sS -G --max-time 30 -w '\n%{http_code}')
  local pair
  if [ -n "$qs" ]; then
    local IFS='&'
    for pair in $qs; do
      [ -n "$pair" ] && args+=(--data-urlencode "$pair")
    done
  fi
  local body code
  body="$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$utok") "$url" 2>&1)" || die "halozati hiba a Graph API fele"
  code="$(tail -n1 <<< "$body")"
  body="$(sed '$d' <<< "$body")"
  # Scrub BOTH tokens: the page token via scrub(), the user token here.
  if [ "$code" != "200" ]; then
    echo "$body" | scrub | sed -f <(printf 's|%s|<USER_TOKEN>|g\n' "$utok") >&2
    die "Graph API HTTP $code"
  fi
  echo "$body" | scrub | sed -f <(printf 's|%s|<USER_TOKEN>|g\n' "$utok")
}

page_id() {
  [ -f "$PAGE_FILE" ] || die "nincs page id: $PAGE_FILE hianyzik. Futtasd elobb: fb-insights.sh page-token <page_id>"
  tr -d ' \t\r\n' < "$PAGE_FILE"
}

cmd="${1:-}"; shift || true

case "$cmd" in
  check)
    # debug_token needs an app-or-user token as the inspector; the token inspects itself,
    # which Graph allows and which is enough to read type / expiry / scopes.
    get "debug_token" "" input_token
    ;;

  pages)
    get "me/accounts" "fields=id,name,access_token,tasks&limit=50" \
      | python3 -c '
import json,sys
d=json.load(sys.stdin)
for p in d.get("data",[]):
    tasks = ",".join(p.get("tasks",[]))
    tok = "igen" if p.get("access_token") else "nem"
    print(p["id"], p.get("name","?"), "tasks=" + tasks, "page_token=" + tok, sep="\t")
if not d.get("data"): print("(a token egyetlen oldalt sem lat)")
'
    ;;

  page-token)
    pid="${1:-}"; [ -n "$pid" ] || die "hasznalat: fb-insights.sh page-token <page_id>"
    tok="$(get "$pid" "fields=access_token,name" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("access_token",""))')"
    [ -n "$tok" ] || die "nem jott vissza page token erre az id-re: $pid (nincs jogod az oldalhoz?)"
    umask 077
    printf '%s' "$tok" > "$TOKEN_FILE"
    printf '%s' "$pid" > "$PAGE_FILE"
    chmod 600 "$TOKEN_FILE" "$PAGE_FILE"
    echo "OK page token elmentve, page_id=$pid"
    ;;

  longlive)
    # Short-lived user token -> long-lived (60 day) user token -> non-expiring page tokens.
    # Needs the app secret; the app id is read back off the token itself, so it is one less
    # thing to keep in sync. Neither secret nor token is ever printed.
    [ -f "$SECRET_FILE" ] || die "nincs app secret: $SECRET_FILE hianyzik (App Dashboard > App settings > Basic > App secret)"
    SECRET="$(tr -d ' \t\r\n' < "$SECRET_FILE")"
    [ -n "$SECRET" ] || die "az app secret fajl ures: $SECRET_FILE"
    app_id="$(get "debug_token" "" input_token \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("app_id",""))')"
    [ -n "$app_id" ] || die "nem sikerult kiolvasni az app_id-t a tokenbol"
    long="$(curl -sS -G --max-time 30 "https://graph.facebook.com/$API_VER/oauth/access_token" \
      --data-urlencode "grant_type=fb_exchange_token" \
      --data-urlencode "client_id=$app_id" \
      --data-urlencode "client_secret@"<(printf '%s' "$SECRET") \
      --data-urlencode "fb_exchange_token@"<(printf '%s' "$TOKEN") \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("access_token",""))')"
    [ -n "$long" ] || die "a hosszu eletu tokenre valtas nem sikerult (rossz app secret, vagy mar lejart a rovid token?)"
    umask 077
    printf '%s' "$long" > "$USER_TOKEN_FILE"
    chmod 600 "$USER_TOKEN_FILE"
    # Harvest the page tokens with the LONG-LIVED token, and merge into the vault rather
    # than replacing it -- a later grant may cover a different subset of pages.
    curl -sS -G --max-time 30 -H @<(printf 'Authorization: Bearer %s\n' "$long") \
      --data-urlencode "fields=id,name,access_token" --data-urlencode "limit=100" \
      "https://graph.facebook.com/$API_VER/me/accounts" \
      | VAULT="$VAULT_FILE" python3 -c '
import json,os,sys
d = json.load(sys.stdin)
if "error" in d:
    print("FAIL me/accounts: " + d["error"].get("message","?"), file=sys.stderr); sys.exit(1)
path = os.environ["VAULT"]
try:
    vault = json.load(open(path))
except Exception:
    vault = {}
fresh = 0
for p in d.get("data", []):
    if p.get("access_token"):
        vault[p["id"]] = {"name": p.get("name","?"), "token": p["access_token"]}
        fresh += 1
with open(path, "w") as f:
    json.dump(vault, f, ensure_ascii=False, indent=1)
os.chmod(path, 0o600)
print("OK hosszu eletu user token elmentve, %d oldal-token frissitve (vault: %d)" % (fresh, len(vault)))
for k, v in vault.items():
    print("  ", k, v["name"])
' || die "az oldal-tokenek begyujtese nem sikerult"
    ;;

  use-page)
    # Activate one of the never-expiring page tokens stashed in the vault. Offline: needs
    # no user token, so it still works long after the user token that created it expired.
    pid="${1:-}"; [ -n "$pid" ] || die "hasznalat: fb-insights.sh use-page <page_id>  (lista: fb-insights.sh vault)"
    [ -f "$VAULT_FILE" ] || die "nincs vault: $VAULT_FILE hianyzik"
    tok="$(python3 -c '
import json,sys
v=json.load(open(sys.argv[1]))
e=v.get(sys.argv[2])
print(e["token"] if e else "")
' "$VAULT_FILE" "$pid")"
    [ -n "$tok" ] || die "nincs ilyen page_id a vaultban: $pid"
    umask 077
    printf '%s' "$tok" > "$TOKEN_FILE"
    printf '%s' "$pid" > "$PAGE_FILE"
    chmod 600 "$TOKEN_FILE" "$PAGE_FILE"
    echo "OK aktiv oldal: $pid"
    ;;

  vault)
    # What is in the vault. Never prints a token, only its presence.
    [ -f "$VAULT_FILE" ] || die "nincs vault: $VAULT_FILE hianyzik"
    active=""; [ -f "$PAGE_FILE" ] && active="$(tr -d ' \t\r\n' < "$PAGE_FILE")"
    python3 -c '
import json,sys
v=json.load(open(sys.argv[1])); active=sys.argv[2]
for k,e in v.items():
    print(("* " if k==active else "  ") + k, e["name"], sep="\t")
' "$VAULT_FILE" "$active"
    ;;

  insights)
    metric="${1:-}"; [ -n "$metric" ] || die "hasznalat: fb-insights.sh insights <metric>[,<metric>] [period] [since] [until]"
    period="${2:-day}"; since="${3:-}"; until_="${4:-}"
    qs="metric=$metric&period=$period"
    [ -n "$since" ] && qs="$qs&since=$since"
    [ -n "$until_" ] && qs="$qs&until=$until_"
    get "$(page_id)/insights" "$qs"
    ;;

  posts)
    limit="${1:-10}"
    # post_impressions* and post_engaged_users were retired; these three still answer.
    get "$(page_id)/posts" "limit=$limit&fields=id,created_time,message,permalink_url,insights.metric(post_clicks,post_reactions_by_type_total,post_activity_by_action_type)"
    ;;

  raw)
    edge="${1:-}"; [ -n "$edge" ] || die "hasznalat: fb-insights.sh raw <edge> [querystring]"
    case "$edge" in
      *..*|/*) die "gyanus edge: $edge" ;;
    esac
    get "$edge" "${2:-}"
    ;;

  raw-user)
    # Ugyanaz mint a raw, de a FELHASZNALOI tokennel. Az ads_archive (hirdetestar) csak
    # igy megy -- lasd a get_user() feletti magyarazatot.
    edge="${1:-}"; [ -n "$edge" ] || die "hasznalat: fb-insights.sh raw-user <edge> [querystring]"
    case "$edge" in
      *..*|/*) die "gyanus edge: $edge" ;;
    esac
    get_user "$edge" "${2:-}"
    ;;

  *)
    die "ismeretlen parancs: '${cmd:-}' -- check | pages | page-token | longlive | vault | use-page | insights | posts | raw | raw-user"
    ;;
esac
