#!/usr/bin/env bash
# Append a daily-log entry whose timestamp the SCRIPT measures.
#
# Why this exists: the entry header used to be typed by hand into the curl
# body, so the time was whatever the writer believed it to be when composing
# the sentence -- and composing happens before the call runs. Measured
# 2026-08-19: two entries in one morning were off by four and five minutes,
# both drifting forward, both in an append-only log where the only fix is a
# second entry. A rule in a document gets skipped; a script that stamps the
# time itself cannot be.
#
# Usage:
#   daily-log.sh <agent> "<title>" "<body>"
#   daily-log.sh <agent> "<title>" -        # body on stdin (use redirection)
#
# Prints the API response. Exits non-zero if the API did not return ok.
set -u

ROOT=/home/marveen/marveen
# the calling user's own token if handed out, else the shared one, loudly (P0-1, plan 5.2)
if [ -r "$ROOT/scripts/lib/dashboard-token.sh" ]; then
  . "$ROOT/scripts/lib/dashboard-token.sh"
  TOKEN_FILE="$(dashboard_token_file "$ROOT")"
else
  echo "dashboard-token: scripts/lib/dashboard-token.sh missing, using the shared token" >&2
  TOKEN_FILE="$ROOT/store/.dashboard-token"
fi
PORT="$(sed -n 's/^WEB_PORT=//p' "$ROOT/.env" 2>/dev/null | head -1 | tr -d '"')"
PORT="${PORT:-3420}"

if [ "$#" -lt 3 ]; then
  echo "usage: daily-log.sh <agent> \"<title>\" \"<body>\"   (body '-' reads stdin)" >&2
  exit 2
fi

AGENT="$1"
TITLE="$2"
BODY="$3"

if [ "$BODY" = "-" ]; then
  BODY="$(cat)"
fi

if [ ! -r "$TOKEN_FILE" ]; then
  echo "FAIL: token not readable at $TOKEN_FILE (wrong working directory?)" >&2
  exit 1
fi

# The one thing this script is for: the header time is measured here, at send
# time -- never taken from the caller.
#
# It does NOT come from `date`. In this container /usr/share/zoneinfo/Europe/
# Budapest is a read-only bind mount from the host and the host file is empty,
# so glibc falls back to UTC while still printing the zone name: `date` answers
# two hours behind Budapest. local-now.sh reads Node's own tz data instead and
# fails loudly rather than returning a wrong hour.
STAMP="$(bash "$ROOT/scripts/local-now.sh")"
if [ -z "$STAMP" ]; then
  echo "FAIL: could not measure the local time -- refusing to write an entry with a guessed header" >&2
  exit 1
fi

RESPONSE="$(
  AGENT="$AGENT" STAMP="$STAMP" TITLE="$TITLE" BODY="$BODY" python3 - "$PORT" "$TOKEN_FILE" <<'PY'
import json, os, sys, urllib.request, urllib.error

port, token_file = sys.argv[1], sys.argv[2]
token = open(token_file).read().strip()
content = f"## {os.environ['STAMP']} -- {os.environ['TITLE']}\n{os.environ['BODY']}"
payload = json.dumps({"agent_id": os.environ["AGENT"], "content": content}).encode()
req = urllib.request.Request(
    f"http://localhost:{port}/api/daily-log",
    data=payload,
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
)
try:
    print(urllib.request.urlopen(req).read().decode())
except urllib.error.HTTPError as err:
    print(f"HTTP {err.code}: {err.read().decode()[:200]}")
    sys.exit(1)
PY
)"
STATUS=$?

echo "$RESPONSE"
case "$RESPONSE" in
  *'"ok":true'*) echo "OK $STAMP"; exit 0 ;;
  *) echo "FAIL -- the entry was NOT written" >&2; exit "${STATUS:-1}" ;;
esac
