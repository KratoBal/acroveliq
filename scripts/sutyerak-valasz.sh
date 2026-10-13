#!/usr/bin/env bash
# ANSWERS: How does my answer to a Sutyerák handoff get back to the employee who asked (into Messages, as Sutyerák)?
#
# Usage:
#   bash scripts/sutyerak-valasz.sh <handoff.json> <answer.md>          # dry: prints what would be sent
#   bash scripts/sutyerak-valasz.sh <handoff.json> <answer.md> --send   # posts it
#
# The handoff file is the one Sutyerák's acrobot_atadas tool writes under
# /home/marveen/sutyerak/atadas/. It carries conversationId (a question asked in
# Messages) or only userId (a question asked in the floating widget). The API
# writes the answer into that conversation, or into the employee's one-to-one
# conversation with Sutyerák, marked as acrobot's answer, with push.
#
# The token is the SUTYERAK_HANDOFF_TOKEN_ID service token, stored only in
# store/.sutyerak-handoff-token (0600); it opens POST /assistant/handoff-reply and
# nothing else. The answer text goes from a FILE, never through the shell.
# On success the handoff file moves to atadas/kesz/.
set -euo pipefail
HANDOFF="${1:?handoff json}"
ANSWER="${2:?answer file}"
MODE="${3:-dry}"
BASE="${SUTYERAK_OS_BASE:-https://api.acropora.hu}"
TOKEN_FILE="/home/marveen/marveen/store/.sutyerak-handoff-token"

BODY=$(python3 - "$HANDOFF" "$ANSWER" <<'EOF'
import json, sys
h = json.load(open(sys.argv[1], encoding="utf-8"))
text = open(sys.argv[2], encoding="utf-8").read().strip()
if not text:
    sys.exit("ures valasz")
body = {"text": text}
if h.get("conversationId"):
    body["conversationId"] = h["conversationId"]
elif h.get("userId"):
    body["userId"] = h["userId"]
else:
    sys.exit("az atadasban sem conversationId, sem userId")
print(json.dumps(body, ensure_ascii=False))
EOF
)

if [ "$MODE" != "--send" ]; then
  echo "SZARAZ (--send nelkul nem kuld):"
  echo "$BODY"
  exit 0
fi

RESP=$(mktemp)
CODE=$(curl -s -o "$RESP" -w '%{http_code}' -X POST "$BASE/assistant/handoff-reply" \
  -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")") \
  -H "Content-Type: application/json" \
  --data-binary "$BODY")
echo "HTTP $CODE"
head -c 400 "$RESP"; echo
rm -f "$RESP"
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  mkdir -p "$(dirname "$HANDOFF")/kesz"
  case "$HANDOFF" in */kesz/*) ;; *) mv "$HANDOFF" "$(dirname "$HANDOFF")/kesz/";; esac
  echo "OK, az atadas lezarva"
else
  exit 1
fi
