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
git init -q "$T/repo"
run() { REVIEW_CSOMAG_REPO="$T/repo" REVIEW_CSOMAG_DIR="$1" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os "$2" tcl-proba >/dev/null 2>&1; echo $?; }
# TC-Lite L4: the third place is a task id, mandatory, checked before the zone is touched
run3() { REVIEW_CSOMAG_REPO="$T/repo" REVIEW_CSOMAG_DIR="$1" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os "$2" "$3" >/dev/null 2>&1; echo $?; }

check 'no zone -> refuse' 1 "$(run "$T/nincs" 101)"
mkdir -m 3775 "$T/zona"
check 'non-numeric PR -> usage error' 2 "$(run "$T/zona" '12/../x')"
check 'no task_id -> usage error' 2 "$(run3 "$T/zona" 108 '')"
check 'a label in the task_id place -> usage error' 2 "$(run3 "$T/zona" 108 'B1 proba')"
check 'a refused task_id creates no folder' 1 "$([ -e "$T/zona/pr-108" ]; echo $?)"
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

echo 'B45 B1 follow-up: the clone and the umask'
check 'not a writable git clone -> refuse' 1 "$(REVIEW_CSOMAG_REPO="$T/nincs" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os 106 tcl-proba >/dev/null 2>&1; echo $?)"
check '... and no packet folder left behind' 1 "$([ -e "$T/zona/pr-106" ] && echo 0 || echo 1)"
out="$(umask 002; REVIEW_CSOMAG_REPO="$T/repo" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os 107 tcl-proba 2>&1)"
check 'caller with umask 002: the script runs with 0022' 'umask=0022' "${out##* }"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
