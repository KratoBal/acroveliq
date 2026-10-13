#!/usr/bin/env bash
# fb-campaign-draft.sh -- create a PAUSED copy of an existing Facebook campaign.
#
# A DECISION WAS REVERSED TO GET HERE, and it is written down so the second one
# does not later look like the only one. On 2026-08-21 barracuda asked for a
# write path and I refused it (msg 2269): an agent that reads foreign web pages
# all day must not hold a tool that can create objects in a live ad account, and
# one campaign was not worth building a permanent money-spending capability for.
# Balazs then asked for the draft to be uploaded automatically. The refusal still
# stands where it was aimed -- no agent got this tool, and the researcher profiles
# now DENY it by name -- but the tool itself exists, lives in its own file, and is
# run by the orchestrator, which does not read the open web. What changed is who
# holds it, not whether an exposed agent may have it.
#
# WHY THIS IS A SEPARATE FILE: fb-insights.sh is documented and relied upon as
# READ-ONLY ("only GET is ever issued"), and other agents' security profiles were
# written on that promise. Adding a write path there would quietly break a
# property someone else already trusted. This file is the only place in the
# fleet that can create an advertising object, and it is deliberately small.
#
# WHAT IT CAN AND CANNOT DO, and why that is in the tool and not in a prompt:
#
#   * It can ONLY copy an existing campaign. It cannot compose a new one from
#     free-form fields, so it cannot invent targeting, creative or placements.
#     That is also what we want editorially: the whole point of the measurement
#     plan is that this year's campaign matches last year's.
#   * Every copy is created with status_option=PAUSED, and the script then
#     re-asserts PAUSED on the new campaign. There is NO flag to activate
#     anything. Going live is a human action in Ads Manager, always.
#   * The daily budget is capped at DAILY_MAX below. Above it the script exits
#     without calling the API at all -- not a warning, a refusal.
#   * Every write is appended to store/fb-campaign-writes.log with a measured
#     timestamp, so "who created this" is answerable later.
#
# CURRENCY, MEASURED 2026-08-21, do not "fix" this: the account is HUF and the
# Graph API uses WHOLE FORINTS for it (offset 1), not fillers. Proof, two
# independent readings from the live account: the 2025 Webshop campaign reports
# daily_budget "3500" for a budget that was 3 500 Ft, and the account reports
# min_daily_budget 317, which is a plausible floor in forints and absurd in
# fillers. A wrong assumption here is a 100x money bug in either direction.
#
# KNOWN LIMIT, measured 2026-08-21 on the live account: `clone` uses the Graph
# API's deep copy, and deep copy FAILS on our 2025 campaign. The error is not a
# permission: "A kreativ tartalom nem tartalmazhat normal korrekciokat" (code
# 100, subcode 3858504) -- the 2025 creative uses an enhancement field Meta has
# since retired, and the copy refuses to carry it. What worked instead, and what
# the September draft was actually built from:
#   1. shallow copy of the campaign   (deep_copy=false, status_option=PAUSED)
#   2. shallow copy of the ad set     (deep_copy=false, campaign_id=<new>)
#   3. a NEW creative from the same page post (object_story_id), no retired field
#   4. a NEW ad in the copied ad set, status=PAUSED
# Targeting, optimisation and the conversion event therefore come from last
# year unchanged; only the ad wrapper is new, and the post inside it is the same.
#
# A SECOND MEASURED TRAP, and it cost a wrong belief for a few minutes: setting
# start_time/stop_time on the CAMPAIGN returns {"success":true} and changes
# NOTHING. The schedule lives on the AD SET. Worse, once an ad set has started,
# Meta refuses to move its start ("A kezdesi idopontot nem lehet modositani"),
# so a copy made today starts today; only end_time can still be set. For a
# PAUSED campaign that is harmless -- delivery begins when a human activates it
# -- but the plan must say so, because the start date is not ours to choose.
#
# Usage:
#   bash scripts/fb-campaign-draft.sh clone --from <campaign_id> --name "<name>" \
#        --daily-budget <HUF> --days <n> [--start YYYY-MM-DD]
#   bash scripts/fb-campaign-draft.sh verify <campaign_id>
#
# Output: "OK <new_campaign_id>" plus the verification JSON, or "FAIL <reason>".
# The token is NEVER printed, not even on failure.
set -uo pipefail

API_VER="v21.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_TOKEN_FILE="$ROOT/store/.fb-user-token"
ACCOUNT_FILE="$ROOT/store/.fb-ad-account"
WRITE_LOG="$ROOT/store/fb-campaign-writes.log"

# The refusal threshold, in whole forints per day. The agreed campaign is 2 900,
# and last year's actual pace was 2 996. 5 000 leaves room for a deliberate
# change of plan while making a fat-fingered 29 000 impossible.
DAILY_MAX=5000
# A copy is only ever made of a campaign in THIS account.
die() { echo "FAIL $*" >&2; exit 1; }

[ -f "$USER_TOKEN_FILE" ] || die "nincs user token: $USER_TOKEN_FILE"
TOKEN="$(tr -d ' \t\r\n' < "$USER_TOKEN_FILE")"
[ -n "$TOKEN" ] || die "a user token fajl ures: $USER_TOKEN_FILE"
scrub() { sed "s|$TOKEN|<TOKEN>|g"; }

[ -f "$ACCOUNT_FILE" ] || die "nincs hirdetesi fiok azonosito: $ACCOUNT_FILE (egy sor, pl. act_123)"
ACCOUNT="$(tr -d ' \t\r\n' < "$ACCOUNT_FILE")"
case "$ACCOUNT" in
  act_[0-9]*) : ;;
  *) die "a fiok azonosito alakja rossz: '$ACCOUNT' (act_<szam> kell)" ;;
esac

# now, measured -- never typed. local-now.sh reads node's tz data.
now_stamp() { bash "$ROOT/scripts/local-now.sh" full; }

api_post() {
  # api_post <path> <field=value>...   -- POST, and the ONLY writing function here.
  local path="$1"; shift
  local url="https://graph.facebook.com/$API_VER/$path"
  local -a args=(-sS --max-time 60 -w '\n%{http_code}')
  local pair
  for pair in "$@"; do
    args+=(--data-urlencode "$pair")
  done
  local body code
  body="$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$url" 2>&1)" || die "halozati hiba a Graph API fele"
  code="$(tail -n1 <<< "$body")"
  body="$(sed '$d' <<< "$body" | scrub)"
  if [ "$code" != "200" ]; then
    echo "$body" >&2
    die "Graph API HTTP $code"
  fi
  printf '%s' "$body"
}

api_get() {
  local path="$1" qs="${2:-}"
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
  body="$(curl "${args[@]}" -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$url" 2>&1)" || die "halozati hiba a Graph API fele"
  code="$(tail -n1 <<< "$body")"
  body="$(sed '$d' <<< "$body" | scrub)"
  [ "$code" = "200" ] || { echo "$body" >&2; die "Graph API HTTP $code"; }
  printf '%s' "$body"
}

log_write() {
  # log_write <what> <detail>
  printf '%s\t%s\t%s\n' "$(now_stamp)" "$1" "$2" >> "$WRITE_LOG"
  chmod 600 "$WRITE_LOG" 2>/dev/null || true
}

json_field() {
  # json_field <json> <key>   -- one scalar, no jq on this machine.
  python3 -c '
import json,sys
try:
    d=json.loads(sys.argv[1])
except Exception:
    sys.exit(1)
v=d.get(sys.argv[2])
if v is None: sys.exit(1)
print(v)
' "$1" "$2"
}

cmd="${1:-}"; shift || true

case "$cmd" in
  clone)
    FROM=""; NAME=""; BUDGET=""; DAYS=""; START=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --from)         FROM="${2:-}"; shift 2 ;;
        --name)         NAME="${2:-}"; shift 2 ;;
        --daily-budget) BUDGET="${2:-}"; shift 2 ;;
        --days)         DAYS="${2:-}"; shift 2 ;;
        --start)        START="${2:-}"; shift 2 ;;
        # No --status, and no catch-all pass-through. A flag this script does
        # not know is a refusal, not something forwarded to the API.
        *) die "ismeretlen kapcsolo: '$1'" ;;
      esac
    done

    [ -n "$FROM" ]   || die "kell a --from <campaign_id>"
    [ -n "$NAME" ]   || die "kell a --name"
    [ -n "$BUDGET" ] || die "kell a --daily-budget (egesz forint)"
    [ -n "$DAYS" ]   || die "kell a --days"

    case "$FROM"   in ''|*[!0-9]*) die "a --from csak szam lehet: '$FROM'" ;; esac
    case "$BUDGET" in ''|*[!0-9]*) die "a --daily-budget csak egesz szam lehet: '$BUDGET'" ;; esac
    case "$DAYS"   in ''|*[!0-9]*) die "a --days csak egesz szam lehet: '$DAYS'" ;; esac

    [ "$BUDGET" -le "$DAILY_MAX" ] || die "a napi keret $BUDGET Ft, a plafon $DAILY_MAX Ft. Megtagadva, a Graph API-t meg sem hivtam."
    [ "$BUDGET" -ge 317 ] || die "a napi keret $BUDGET Ft, a fiok minimuma 317 Ft."
    [ "$DAYS" -ge 1 ] && [ "$DAYS" -le 92 ] || die "a --days ertek 1 es 92 kozott lehet, kapott: $DAYS"

    # The source campaign must live in OUR account. Without this the tool would
    # happily copy anything the token can see.
    src="$(api_get "$FROM" "fields=id,name,account_id,objective")"
    src_acct="$(json_field "$src" account_id)" || die "a forras kampany account_id mezoje nem olvashato"
    [ "act_$src_acct" = "$ACCOUNT" ] || die "a forras kampany nem ebben a fiokban van (act_$src_acct vs $ACCOUNT)"

    if [ -z "$START" ]; then
      START="$(bash "$ROOT/scripts/local-now.sh" date)"
    fi
    case "$START" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) : ;;
      *) die "a --start alakja YYYY-MM-DD legyen: '$START'" ;;
    esac
    STOP="$(python3 -c '
import datetime,sys
d=datetime.date.fromisoformat(sys.argv[1])+datetime.timedelta(days=int(sys.argv[2]))
print(d.isoformat())
' "$START" "$DAYS")" || die "a zaro datumot nem sikerult kiszamolni"

    echo "forras: $(json_field "$src" name) ($FROM), cel: $(json_field "$src" objective)" >&2
    echo "uj kampany: '$NAME', napi $BUDGET Ft, $START -> $STOP ($DAYS nap), PAUSED" >&2

    # 1) deep copy, paused. status_option=PAUSED is what keeps the adsets and
    #    ads from inheriting an active state from the source.
    copy="$(api_post "$FROM/copies" "deep_copy=true" "status_option=PAUSED")"
    new_id="$(json_field "$copy" copied_campaign_id)" || {
      echo "$copy" >&2; die "a masolat valaszabol nem jott copied_campaign_id"
    }
    log_write "campaign-copy" "from=$FROM new=$new_id"

    # 2) name, budget, window -- and PAUSED re-asserted, belt and braces.
    api_post "$new_id" \
      "name=$NAME" \
      "daily_budget=$BUDGET" \
      "start_time=${START}T09:00:00+0200" \
      "stop_time=${STOP}T09:00:00+0200" \
      "status=PAUSED" > /dev/null
    log_write "campaign-update" "id=$new_id budget=$BUDGET start=$START stop=$STOP"

    echo "OK $new_id"
    echo "--- visszamerve, kulon lekerdezessel ---" >&2
    api_get "$new_id" "fields=id,name,status,effective_status,objective,daily_budget,start_time,stop_time,special_ad_categories,bid_strategy"
    echo
    ;;

  verify)
    id="${1:-}"; [ -n "$id" ] || die "hasznalat: fb-campaign-draft.sh verify <campaign_id>"
    echo "--- kampany ---"
    api_get "$id" "fields=id,name,status,effective_status,objective,daily_budget,start_time,stop_time"
    echo
    echo "--- hirdetescsoportok ---"
    api_get "$id/adsets" "fields=id,name,status,effective_status,optimization_goal,billing_event&limit=25"
    echo
    echo "--- hirdetesek ---"
    api_get "$id/ads" "fields=id,name,status,effective_status&limit=25"
    echo
    ;;

  *)
    die "ismeretlen parancs: '${cmd:-}' -- clone | verify"
    ;;
esac
