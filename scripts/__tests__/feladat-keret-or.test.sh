#!/bin/bash
# Contract tests for scripts/feladat-keret-or.sh.
# Run: bash scripts/__tests__/feladat-keret-or.test.sh
#
# Pins two things barracuda found in the review of tcl-l0 (2026-10-13):
#   (a) the message sent in acrobot's name is always the script's own text. The old
#       fixed /tmp/keret-<task>.txt could be pre-created by another user; our write was
#       refused, and the foreign file was sent. Here the pre-made file is read-only,
#       which makes our write fail the same way without a second user.
#   (b) the message claims "I interrupted your turn" only when send-keys succeeded.
#
# Everything outside the script is stubbed under a temporary ROOT (KERET_OR_ROOT):
# fleet-api.sh, agent-msg.sh (records what it was asked to send), daily-log.sh,
# the token, the database, and curl / sudo on PATH.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# KERET_OR_GUARD: run the same contract against another copy (calibration on the old code).
GUARD="${KERET_OR_GUARD:-$INSTALL_DIR/scripts/feladat-keret-or.sh}"

# One fixture per case: a fake ROOT whose task is already over its call limit.
# $1: "ok" or "fail" -- what the stubbed sudo returns (and tmux is made to fail).
setup() {
  local sudo_rc="$1"
  T="$(mktemp -d)"
  mkdir -p "$T/root/scripts" "$T/root/store" "$T/bin"
  echo "stub-token" > "$T/root/store/.dashboard-token"
  python3 -c 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("create table task_events(task_id text, kind text, at integer)"); db.execute("insert into task_events values(?,?,?)", (sys.argv[2],"started",1)); db.commit()' \
    "$T/root/store/claudeclaw.db" "$TASK"
  cat > "$T/root/scripts/fleet-api.sh" <<'EOF'
echo "  work   130 hivas  ki 1k  cache-olv 12.5M"
EOF
  cat > "$T/root/scripts/agent-msg.sh" <<EOF
cat > "$T/sent.txt"
echo "OK id=1"
EOF
  : > "$T/root/scripts/daily-log.sh"
  printf '#!/bin/sh\nexit 0\n' > "$T/bin/curl"
  printf '#!/bin/sh\nexit %s\n' "$([ "$sudo_rc" = ok ] && echo 0 || echo 1)" > "$T/bin/sudo"
  chmod +x "$T/bin/curl" "$T/bin/sudo"
}

run_guard() {
  # The agent name must NOT be a real session: the script's fallback calls /usr/bin/tmux by
  # absolute path (PATH cannot stub it), and on a fleet machine "murena" would get the Escape.
  KERET_OR_ROOT="$T/root" PATH="$T/bin:$PATH" bash "$GUARD" "$TASK" keret-or-test-nobody 100 50 1 >"$T/out.txt" 2>&1
  echo $?
}

echo "feladat-keret-or tests"
echo "======================"

TASK="keret-or-test-$$"
OLD="/tmp/keret-$TASK.txt"

echo ""
echo "(a) A pre-made, unwritable /tmp/keret-<task>.txt is never what gets sent"
setup ok
printf 'IDEGEN SZOVEG\n' > "$OLD"; chmod 444 "$OLD"
rc="$(run_guard)"
if [ "$rc" = "3" ]; then pass "exit 3 when the limit is reached"; else fail "exit 3 expected, got $rc ($(cat "$T/out.txt"))"; fi
if [ -f "$T/sent.txt" ] && ! grep -q 'IDEGEN' "$T/sent.txt" && grep -q '^KERET ELERVE, ' "$T/sent.txt"; then
  pass "the sent message is the script's own text"
else
  fail "the sent message is not the script's own text: $(cat "$T/sent.txt" 2>/dev/null)"
fi
if grep -q 'IDEGEN' "$OLD"; then pass "the pre-made file is left alone"; else fail "the pre-made file was changed"; fi
chmod 644 "$OLD"; rm -f "$OLD"; rm -rf "$T"

echo ""
echo "(b) The interruption is claimed only when it happened"
setup ok
run_guard >/dev/null
if grep -q 'en szakitottam meg' "$T/sent.txt"; then pass "send-keys ok: 'en szakitottam meg'"; else fail "send-keys ok, but: $(cat "$T/sent.txt")"; fi
rm -rf "$T"

setup fail
# The real tmux fallback runs too; there is no agent-keret-or-test-nobody session, so it fails.
run_guard >/dev/null
if grep -q 'NEM tudtam megszakitani' "$T/sent.txt" && ! grep -q 'en szakitottam meg' "$T/sent.txt"; then
  pass "send-keys failed: the message says so"
else
  fail "send-keys failed, but: $(cat "$T/sent.txt")"
fi
rm -rf "$T"

echo ""
echo "======================"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
