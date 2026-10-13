#!/usr/bin/env bash
# Schedule a photo post on the Acropora Facebook page.
#
# The token is read from disk at call time and never printed, the same way
# fb-insights.sh does it. Nothing here publishes immediately: every post is
# created with a scheduled_publish_time, which is what makes the fleet's
# "draft with a fuse" rule possible (upload day + 30 days, deleted on day 25
# if nobody moved the date).
#
# Usage:
#   fb-schedule-post.sh photo <image> <textfile> <unix_time>   create a scheduled photo post
#   fb-schedule-post.sh photos <textfile> <unix_time> <img> [img...]  several photos, one post
#   fb-schedule-post.sh list                                   list the scheduled posts
#   fb-schedule-post.sh show <post_id>                         one scheduled post
#   fb-schedule-post.sh settext <post_id> <textfile>           replace the text of a scheduled post
#   fb-schedule-post.sh setdate <post_id> <unix_time>          move the scheduled publish time
#   fb-schedule-post.sh delete <post_id>                       delete a scheduled post
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOKEN_FILE="$ROOT/store/.fb-page-token"
PAGE_FILE="$ROOT/store/.fb-page-id"
API="https://graph.facebook.com/v21.0"

die() { echo "HIBA: $*" >&2; exit 1; }

[ -f "$TOKEN_FILE" ] || die "nincs token: $TOKEN_FILE"
[ -f "$PAGE_FILE" ] || die "nincs page id: $PAGE_FILE"
TOKEN="$(tr -d ' \t\r\n' < "$TOKEN_FILE")"
PAGE="$(tr -d ' \t\r\n' < "$PAGE_FILE")"
[ -n "$TOKEN" ] || die "ures token fajl"

# No secret on any command line: /proc shows every process's argv to every agent
# (#85, #87). The token reaches curl as a form field read from a file descriptor
# (-F "name=<file", curl(1) --form), and sed gets its script the same way.
scrub() { sed -f <(printf 's|%s|<TOKEN>|g\n' "$TOKEN"); }

case "${1:-}" in
  photo)
    IMG="${2:-}"; TXT="${3:-}"; WHEN="${4:-}"
    [ -f "$IMG" ] || die "nincs ilyen kep: $IMG"
    [ -f "$TXT" ] || die "nincs ilyen szovegfajl: $TXT"
    [ -n "$WHEN" ] || die "hianyzik az idopont (unix time)"
    NOW=$(date +%s)
    [ "$WHEN" -gt $((NOW + 600)) ] || die "az idopont tul kozeli: a Facebook legalabb 10 percet koetel"
    # Measured 2026-08-19: +30 days is already rejected ("(#100) The specified
    # scheduled publish time is invalid"), +25 days is accepted. The real
    # ceiling is 30 days, exclusive -- so the fleet's "upload day + 30 days"
    # rule has to live at +29 days.
    [ "$WHEN" -lt $((NOW + 2588400)) ] || die "az idopont tul tavoli: a Facebook 30 napnal kevesebbet enged (merve: 30 nap mar elbukik, 29 nap megy)"
    # Two steps on purpose. The /photos edge rejects scheduled_publish_time
    # ("(#100) The specified scheduled publish time was invalid", measured
    # 2026-08-19), so the photo is uploaded unpublished first and then
    # attached to a scheduled feed post, which is the documented path.
    PHOTO_JSON=$(curl -s -X POST "$API/$PAGE/photos" \
      -F "access_token=<"<(printf '%s' "$TOKEN") \
      -F "published=false" \
      -F "source=@$IMG")
    PHOTO_ID=$(printf '%s' "$PHOTO_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    if [ -z "$PHOTO_ID" ]; then
      echo "A kep feltoltese nem sikerult:" >&2
      printf '%s\n' "$PHOTO_JSON" | scrub >&2
      exit 1
    fi
    echo "kep feltoltve (nem publikalt): $PHOTO_ID"
    POST_JSON=$(curl -s -X POST "$API/$PAGE/feed" \
      -F "access_token=<"<(printf '%s' "$TOKEN") \
      -F "published=false" \
      -F "scheduled_publish_time=$WHEN" \
      -F "attached_media[0]={\"media_fbid\":\"$PHOTO_ID\"}" \
      -F "message=<$TXT")
    POST_ID=$(printf '%s' "$POST_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    if [ -z "$POST_ID" ]; then
      echo "Az idozitett bejegyzes NEM jott letre. A feltoltott kep arvan maradt: $PHOTO_ID" >&2
      echo "Torles: fb-schedule-post.sh delete $PHOTO_ID" >&2
      printf '%s\n' "$POST_JSON" | scrub >&2
      exit 1
    fi
    printf '%s\n' "$POST_JSON" | scrub
    # Record the REAL upload moment. Measured 2026-08-20 09:00: for an unpublished
    # scheduled post the Graph API reports `created_time` EQUAL TO the scheduled
    # time, not the upload time -- so the patrol's "created + 30 days" arithmetic
    # computes a date in the FUTURE, the 25-day deletion rule can never fire, and
    # the round looks healthy while checking nothing. The upload day is only
    # knowable here, at upload time, so it gets written down here.
    python3 - "$ROOT/store/fb-scheduled-uploads.json" "$POST_ID" "$NOW" "$WHEN" <<'PY'
import json, sys, os
path, post_id, uploaded, scheduled = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    with open(path) as fh:
        led = json.load(fh)
except Exception:
    led = {}
led[post_id] = {"uploaded_at": uploaded, "scheduled_publish_time": scheduled}
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(led, fh, indent=2)
os.replace(tmp, path)
print("feljegyezve a feltoltes ideje:", path)
PY
    ;;
  photos)
    # TOBB KEP EGY IDOZITETT BEJEGYZESBEN.
    #
    # Miert kulon ag, es miert nem bovitettem a `photo`-t: a `photo` hivasi
    # alakja (kep, szoveg, ido) mar hasznalatban van, es egy valtozo hosszu
    # argumentumlista a VEGERE kell, kulonben a regi alak csendben mast jelent.
    # Ugyanaz a csalad, mint a helperek arity-orzoje: aki a regi sorrendet
    # gepeli be, ne rossz helyre tegye a kepet.
    #
    # A kockazat, ami tobb kepnel NAGYOBB, mint egynel: ha a feed-hivas elbukik,
    # MINDEN feltoltott kep arvan marad, nem csak egy. Ezert a hibaag mind
    # felsorolja, egyenkent torolheto azonositoval.
    TXT="${2:-}"; WHEN="${3:-}"; shift 3 2>/dev/null || true
    [ -f "$TXT" ] || die "nincs ilyen szovegfajl: $TXT"
    [ -n "$WHEN" ] || die "hianyzik az idopont (unix time)"
    [ "$#" -ge 1 ] || die "adj meg legalabb egy kepet"
    case "$WHEN" in ''|*[!0-9]*) die "a datum unix idobelyeg legyen: $WHEN";; esac
    for IMG in "$@"; do [ -f "$IMG" ] || die "nincs ilyen kep: $IMG"; done
    NOW=$(date +%s)
    [ "$WHEN" -gt $((NOW + 600)) ] || die "az idopont tul kozeli: a Facebook legalabb 10 percet koetel"
    [ "$WHEN" -lt $((NOW + 2588400)) ] || die "az idopont tul tavoli: a Facebook 30 napnal kevesebbet enged (merve: 30 nap mar elbukik, 29 nap megy)"
    IDS=""
    ATTACH=()
    N=0
    for IMG in "$@"; do
      PHOTO_JSON=$(curl -s -X POST "$API/$PAGE/photos" \
        -F "access_token=<"<(printf '%s' "$TOKEN") \
        -F "published=false" \
        -F "source=@$IMG")
      PHOTO_ID=$(printf '%s' "$PHOTO_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
      if [ -z "$PHOTO_ID" ]; then
        echo "A kep feltoltese nem sikerult: $IMG" >&2
        printf '%s\n' "$PHOTO_JSON" | scrub >&2
        [ -n "$IDS" ] && echo "MAR FELTOLTOTT, ARVA KEPEK: $IDS" >&2
        exit 1
      fi
      echo "kep feltoltve (nem publikalt): $IMG -> $PHOTO_ID"
      ATTACH+=(-F "attached_media[$N]={\"media_fbid\":\"$PHOTO_ID\"}")
      IDS="$IDS $PHOTO_ID"
      N=$((N + 1))
    done
    POST_JSON=$(curl -s -X POST "$API/$PAGE/feed" \
      -F "access_token=<"<(printf '%s' "$TOKEN") \
      -F "published=false" \
      -F "scheduled_publish_time=$WHEN" \
      "${ATTACH[@]}" \
      -F "message=<$TXT")
    POST_ID=$(printf '%s' "$POST_JSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
    if [ -z "$POST_ID" ]; then
      echo "Az idozitett bejegyzes NEM jott letre. ARVAN MARADT KEPEK:$IDS" >&2
      echo "Torles egyenkent: fb-schedule-post.sh delete <id>" >&2
      printf '%s\n' "$POST_JSON" | scrub >&2
      exit 1
    fi
    printf '%s\n' "$POST_JSON" | scrub
    # Ugyanaz a fofok, mint a `photo` again: a feltoltes VALODI ideje csak itt
    # ismerheto meg, mert a Graph API egy idozitett bejegyzesnel a created_time
    # mezoben az IDOZITETT idot adja vissza.
    python3 - "$ROOT/store/fb-scheduled-uploads.json" "$POST_ID" "$NOW" "$WHEN" <<'LEDGER'
import json, sys, os
path, post_id, uploaded, scheduled = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
try:
    with open(path) as fh:
        led = json.load(fh)
except Exception:
    led = {}
led[post_id] = {"uploaded_at": uploaded, "scheduled_publish_time": scheduled}
tmp = path + ".tmp"
with open(tmp, "w") as fh:
    json.dump(led, fh, indent=2)
os.replace(tmp, path)
print("feljegyezve a feltoltes ideje:", path)
LEDGER
    ;;
  delete)
    ID="${2:-}"; [ -n "$ID" ] || die "hianyzik az id"
    curl -s -X DELETE "$API/$ID" -F "access_token=<"<(printf '%s' "$TOKEN") | scrub
    echo
    ;;
  list)
    curl -s -G "$API/$PAGE/scheduled_posts" \
      --data-urlencode "access_token@"<(printf '%s' "$TOKEN") \
      --data-urlencode "fields=id,message,scheduled_publish_time,created_time,is_published" | scrub
    echo
    ;;
  show)
    ID="${2:-}"; [ -n "$ID" ] || die "hianyzik a post id"
    curl -s -G "$API/$ID" \
      --data-urlencode "access_token@"<(printf '%s' "$TOKEN") \
      --data-urlencode "fields=id,message,scheduled_publish_time,created_time,is_published,permalink_url" | scrub
    echo
    ;;
  settext)
    ID="${2:-}"; TXT="${3:-}"
    [ -n "$ID" ] || die "hianyzik a post id"
    [ -f "$TXT" ] || die "nincs ilyen szovegfajl: $TXT"
    curl -s -X POST "$API/$ID" \
      -F "access_token=<"<(printf '%s' "$TOKEN") \
      -F "message=<$TXT" | scrub
    echo
    ;;
  setdate)
    ID="${2:-}"; WHEN="${3:-}"
    [ -n "$ID" ] || die "hianyzik a post id"
    case "$WHEN" in ''|*[!0-9]*) die "a datum unix idobelyeg legyen: $WHEN";; esac
    # The ledger (store/fb-scheduled-uploads.json) is deliberately NOT touched here.
    # The patrol decides "somebody dealt with this post" by comparing the live
    # scheduled_publish_time against the recorded upload + 29 days; rewriting the
    # ledger would erase exactly that evidence and re-arm the 25 day deletion.
    curl -s -X POST "$API/$ID" \
      -F "access_token=<"<(printf '%s' "$TOKEN") \
      -F "scheduled_publish_time=$WHEN" | scrub
    echo
    # A success response is not proof. Read the object back.
    curl -s -G "$API/$ID" \
      --data-urlencode "access_token@"<(printf '%s' "$TOKEN") \
      --data-urlencode "fields=id,scheduled_publish_time,is_published" | scrub
    echo
    ;;
  *)
    /bin/grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -20
    exit 1
    ;;
esac
