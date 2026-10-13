#!/usr/bin/env bash
# B45 guard for scripts/review-csomag.sh: the packet goes into the shared zone,
# and a folder that is not the packager's own (pre-claimed, a symlink, a file)
# is refused BEFORE anything is fetched or written.
#
# The foreign-OWNER case needs a second uid and is not reproducible here; the
# B45 step sheet probes it with runuser. Everything else runs in a tmp zone via
# REVIEW_CSOMAG_DIR, and REVIEW_CSOMAG_GUARD_ONLY=1 stops right after the guard.
#
# Run: bash scripts/__tests__/review-csomag.test.sh   Exit 0 = all pass.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$HERE/../review-csomag.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
check() {  # name, expected rc, actual rc
  if [ "$2" = "$3" ]; then echo "  [PASS] $1"; else echo "  [FAIL] $1 (rc $3, want $2)"; fails=$((fails + 1)); fi
}
run() { REVIEW_CSOMAG_DIR="$1" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os "$2" >/dev/null 2>&1; echo $?; }

check 'no zone -> refuse' 1 "$(run "$T/nincs" 101)"
mkdir -m 3775 "$T/zona"
check 'non-numeric PR -> usage error' 2 "$(run "$T/zona" '12/../x')"
check 'fresh folder -> created' 0 "$(run "$T/zona" 102)"
m=$(stat -c %a "$T/zona/pr-102")
check 'fresh folder is not group-writable' 0 "$(( 0$m & 020 ))"
check 'own existing folder -> accepted' 0 "$(run "$T/zona" 102)"
ln -s "$T" "$T/zona/pr-103"
check 'symlink folder -> refuse' 1 "$(run "$T/zona" 103)"
: > "$T/zona/pr-104"
check 'a file in place of the folder -> refuse' 1 "$(run "$T/zona" 104)"
ln -s "$T/zona" "$T/zona-link"
check 'zone itself a symlink -> refuse' 1 "$(run "$T/zona-link" 105)"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
