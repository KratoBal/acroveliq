#!/usr/bin/env bash
# Close an inter-agent message, and FAIL LOUDLY if the close did not happen.
#
# Why this exists, measured 2026-08-26. Closing a message is a PUT to
# /api/messages/<id>, and every caller hand-rolled it as
#
#   curl -s -X PUT ... -d '{"status":"done","result":"..."}' >/dev/null
#
# That line reports success in three situations that are not success: the token
# was rejected (401), the body was malformed JSON (400), or the id does not
# exist (404). It happened twice in one day on this install. The second time the
# result text contained an unbalanced quote, the API answered with an error, the
# response went to /dev/null, and the message stayed OPEN -- which the router
# then kept re-delivering, because an unhandled inbox starves every other
# agent's delivery.
#
# The same shape already had a fix on the sending side (agent-msg.sh checks the
# HTTP status and the returned id). The closing side had none, so the raw curl
# was the only way to do it -- and a guard that can be bypassed is optional.
#
# Usage:
#   msg-close.sh <id> "<result>"
#   msg-close.sh <id> -            # result on stdin (use redirection, not a pipe)
#
# Exits non-zero, with a reason, if the message did not actually close.
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

if [ "$#" -lt 2 ]; then
  echo "usage: msg-close.sh <id> \"<result>\"   (result '-' reads stdin)" >&2
  exit 2
fi

ID="$1"
RESULT="$2"
[ "$RESULT" = "-" ] && RESULT="$(cat)"

case "$ID" in
  ''|*[!0-9]*) echo "FAIL: the id must be a number, got: $ID" >&2; exit 2 ;;
esac

if [ ! -r "$TOKEN_FILE" ]; then
  echo "FAIL: token not readable at $TOKEN_FILE (wrong working directory?)" >&2
  exit 1
fi

# The result is carried in the environment and encoded by python, never pasted
# into a shell-quoted JSON string. A Hungarian result text with an apostrophe or
# a quotation mark is exactly what produced the malformed body the first time.
attempt=1
while [ "$attempt" -le 3 ]; do
  OUT="$(
    ID="$ID" RESULT="$RESULT" python3 - "$PORT" "$TOKEN_FILE" <<'PY'
import json, os, sys, urllib.request, urllib.error

port, token_file = sys.argv[1], sys.argv[2]
token = open(token_file).read().strip()
payload = json.dumps({"status": "done", "result": os.environ["RESULT"]}).encode()
req = urllib.request.Request(
    f"http://localhost:{port}/api/messages/{os.environ['ID']}",
    data=payload,
    method="PUT",
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
)
try:
    body = urllib.request.urlopen(req).read().decode()
except urllib.error.HTTPError as err:
    print(f"HTTP {err.code}: {err.read().decode()[:200]}")
    sys.exit(1)
except Exception as err:  # connection refused, DNS, timeout
    print(f"UNREACHABLE: {err}")
    sys.exit(1)

# HTTP 200 is not enough: the route answers 200 with an error object too.
try:
    parsed = json.loads(body)
except ValueError:
    print(f"UNPARSEABLE: {body[:200]}")
    sys.exit(1)

if parsed.get("ok") is not True:
    print(f"REJECTED: {body[:200]}")
    sys.exit(1)

print("ok")
PY
  )"
  if [ "$OUT" = "ok" ]; then
    echo "OK closed $ID"
    exit 0
  fi
  echo "attempt $attempt failed: $OUT" >&2
  attempt=$((attempt + 1))
  sleep 1
done

echo "FAIL: message $ID is still OPEN after 3 attempts -- it will keep being re-delivered" >&2
exit 1
