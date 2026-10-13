#!/usr/bin/env bash
# B45 guard for the two provisioning scripts (agent-to-own-user.sh, fleet-provision.py).
#
# Pins two things:
#  1. Neither script grants the `fleet` group WRITE any more (`g:fleet:rwX`,
#     `chmod ... g+rw`): `fleet` is every agent's PRIMARY group, so that was a write
#     for all six agents into one agent's CLAUDE.md, settings.json and skills, and a
#     re-provisioning would bring the B45 hole back after the fix.
#  2. The ACL is only put on entries the group can ALREADY read. The filter is a
#     find predicate; this test RUNS that exact predicate on a scratch tree and
#     checks that a 0600 file (.claude.json, .credentials.json) and a symlink are
#     not selected: a `g::rX` on a 0600 file would OPEN group read.
#
# Run: bash scripts/__tests__/b45-provizionalas.test.sh   Exit 0 = all pass.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
A="$HERE/../agent-to-own-user.sh"
P="$HERE/../fleet-provision.py"
fails=0
check() { if [ "$2" = "$3" ]; then echo "  [PASS] $1"; else echo "  [FAIL] $1 (got '$3', want '$2')"; fails=$((fails + 1)); fi; }
code() { grep -v '^[[:space:]]*#' "$1"; }   # executable lines only

echo '1. no group write'
check 'agent-to-own-user.sh: no g:fleet:rwX' 0 "$(code "$A" | grep -c 'g:fleet:rwX')"
check 'agent-to-own-user.sh: no chmod g+rw' 0 "$(code "$A" | grep -c 'chmod g+rw')"
check 'fleet-provision.py: no g:fleet:rwX' 0 "$(code "$P" | grep -c 'g:fleet:rwX')"
check 'fleet-provision.py: no chmod -R g+rwX' 0 "$(code "$P" | grep -c 'g+rwX')"
check 'agent-to-own-user.sh: router gets a named entry' 1 "$(code "$A" | grep -c 'u:marveen:rwX,g::rX,g:fleet:rX')"
check 'fleet-provision.py: router gets a named entry' 1 "$(code "$P" | grep -c 'u:marveen:rwX,g::rX,g:fleet:rX')"

echo '2. the filter, the same text in both scripts, and what it selects'
PRED='! -type l \( -type d -o -perm -g=r \)'
check 'agent-to-own-user.sh uses the predicate' 1 "$(code "$A" | grep -cF "$PRED")"
check 'fleet-provision.py emits the predicate' 1 "$(code "$P" | grep -cF '! -type l \\( -type d -o -perm -g=r \\)')"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/d/.claude-config"
install -m 600 /dev/null "$T/d/.claude-config/.claude.json"
install -m 600 /dev/null "$T/d/.claude-config/.credentials.json"
install -m 664 /dev/null "$T/d/CLAUDE.md"
install -m 640 /dev/null "$T/d/key.env"
ln -s "$T/d/CLAUDE.md" "$T/d/link"
got="$(cd "$T" && find d ! -type l \( -type d -o -perm -g=r \) | sort | tr '\n' ' ')"
check 'selected: dirs + group-readable files only' 'd d/.claude-config d/CLAUDE.md d/key.env ' "$got"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
