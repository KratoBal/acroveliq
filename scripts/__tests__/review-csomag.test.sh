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
git init -q "$T/repo"; git -C "$T/repo" remote add origin https://github.com/KratoBal/acropora-os.git
git init -q "$T/mrepo"; git -C "$T/mrepo" remote add origin git@github.com:KratoBal/marveen.git
run() { REVIEW_CSOMAG_REPO="$T/repo" REVIEW_CSOMAG_DIR="$1" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os "$2" tcl-proba >/dev/null 2>&1; echo $?; }
# TC-Lite L4: the third place is a task id, mandatory, checked before the zone is touched
run3() { REVIEW_CSOMAG_REPO="$T/repo" REVIEW_CSOMAG_DIR="$1" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os "$2" "$3" >/dev/null 2>&1; echo $?; }

check 'no zone -> refuse' 1 "$(run "$T/nincs" 101)"
mkdir -m 3775 "$T/zona"
check 'non-numeric PR -> usage error' 2 "$(run "$T/zona" '12/../x')"
check 'PR 0 -> usage error' 2 "$(run "$T/zona" 0)"
check 'a leading zero -> usage error' 2 "$(run "$T/zona" 0101)"
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

echo 'reviewer-profil: the fleet repo gets its own prefix'
check 'marveen -> accepted' 0 "$(REVIEW_CSOMAG_REPO="$T/mrepo" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" marveen 109 tcl-proba >/dev/null 2>&1; echo $?)"
check '... into pr-marveen<N>' 0 "$([ -d "$T/zona/pr-marveen109" ]; echo $?)"
check 'an unknown repo name -> usage error' 2 "$(REVIEW_CSOMAG_REPO="$T/mrepo" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" nincs 110 tcl-proba >/dev/null 2>&1; echo $?)"

echo 'B45 B1 follow-up: the clone and the umask'
check 'not a writable git clone -> refuse' 1 "$(REVIEW_CSOMAG_REPO="$T/nincs" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os 106 tcl-proba >/dev/null 2>&1; echo $?)"
check '... and no packet folder left behind' 1 "$([ -e "$T/zona/pr-106" ] && echo 0 || echo 1)"
out="$(umask 002; REVIEW_CSOMAG_REPO="$T/repo" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" os 107 tcl-proba 2>&1)"
check 'caller with umask 002: the script runs with 0022' 'umask=0022' "${out##* }"

echo 'card f1e388e5: the packet names its PR as owner/repo#N, and the clone must be that repo'
g() { REVIEW_CSOMAG_REPO="$1" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GUARD_ONLY=1 bash "$S" "$2" "$3" tcl-proba 2>&1; }
check 'os -> KratoBal/acropora-os#N' 1 "$(g "$T/repo" os 111 | grep -c ' pr: KratoBal/acropora-os#111 umask=')"
check 'marveen over ssh -> KratoBal/marveen#N' 1 "$(g "$T/mrepo" marveen 112 | grep -c ' pr: KratoBal/marveen#112 umask=')"
check 'the README line review-ellenoriz.sh reads' 1 "$(grep -c '"%s PR %s %s\\npr: %s\\ntask_id: %s' "$S")"
check 'a clone of another repo for the mode -> refuse' 1 "$(g "$T/repo" marveen 113 >/dev/null; echo $?)"
check '... and no packet folder left behind' 1 "$([ -e "$T/zona/pr-marveen113" ] && echo 0 || echo 1)"
k=0
for u in https://github.com/KratoBal/acropora-os-fork.git https://github.com/evil/KratoBal/acropora-os.git https://evil.example/KratoBal/acropora-os.git; do
  git init -q "$T/r-$((++k))"; git -C "$T/r-$k" remote add origin "$u"
  check "a lookalike origin ($u) -> refuse" 1 "$(g "$T/r-$k" os 114 >/dev/null; echo $?)"
done
git init -q "$T/noorigin"
check 'a clone with no origin -> refuse' 1 "$(g "$T/noorigin" os 115 >/dev/null; echo $?)"
check 'no refused clone left a folder' 0 "$(ls "$T/zona" | grep -cE '^pr-(marveen)?11[345]$')"

echo 'the AI service (acrobot 30257): its own prefix and repo'
git init -q "$T/airepo"; git -C "$T/airepo" remote add origin https://github.com/KratoBal/acropora-ai-agent.git
check 'ai -> KratoBal/acropora-ai-agent#N in pr-ai<N>' 1 "$(g "$T/airepo" ai 116 | grep -c 'pr-ai116 pr: KratoBal/acropora-ai-agent#116 umask=')"
check 'ai with a clone of another repo -> refuse' 1 "$(g "$T/repo" ai 117 >/dev/null; echo $?)"

echo 'a document packet (task review-docs-verdict): a copy and its sha256, nothing private'
R="$T/root"; mkdir -p "$R/exchange/acroveliq" "$R/store" "$R/agents/x/.claude" "$R/elo"
printf 'terv\n' > "$R/exchange/acroveliq/terv.md"
# the fleet group is pinned: on a fleet machine the test user's own group IS fleet, and the
# group-readable case below would pass for the wrong reason
d() { REVIEW_CSOMAG_ROOT="$R" REVIEW_CSOMAG_DIR="$T/zona" REVIEW_CSOMAG_GROUP="${GRP:-nincs-ilyen-csoport}" bash "$S" docs "$@" 2>&1; }
dr() { d "$@" >/dev/null; echo $?; }
check 'a file under the root -> 0' 0 "$(dr exchange/acroveliq/terv.md doc-proba)"
P="$T/zona/doc-doc-proba"
check '... the copy is v1-<name>, byte-equal' 0 "$(cmp -s "$R/exchange/acroveliq/terv.md" "$P/v1-terv.md"; echo $?)"
H="$(sha256sum < "$P/v1-terv.md")"; H="${H%% *}"
check '... the README names the task, the path and the copy hash (one line each)' 111 \
  "$(grep -c "^task_id: doc-proba\$" "$P/README.md")$(grep -c "^fajl: exchange/acroveliq/terv.md\$" "$P/README.md")$(grep -c "^sha256: $H\$" "$P/README.md")" 
check '... nothing in it is group-writable' 0 "$(find "$P" -perm /022 | wc -l)"
printf 'terv v2\n' > "$R/exchange/acroveliq/terv.md"
check 'a second round -> 0' 0 "$(dr "$R/exchange/acroveliq/terv.md" doc-proba masodik)"
H2="$(sha256sum < "$P/v2-terv.md")"; H2="${H2%% *}"
check '... v2 copy and a vN: line with its hash (an absolute path under the root is taken as relative)' 1 \
  "$(grep -c "^v2: task_id doc-proba, fajl exchange/acroveliq/terv.md, sha256 $H2 masodik\$" "$P/README.md")"
check '... the first copy is untouched' 0 "$(printf 'terv\n' | cmp -s - "$P/v1-terv.md"; echo $?)"
printf 's\n' > "$R/store/x.md"; printf 's\n' > "$R/agents/x/.claude/s.md"; printf 'p\n' > "$R/elo/privat.md"; chmod 600 "$R/elo/privat.md"
: > "$R/elo/ures.md"; printf 't\n' > "$R/teteje.md"; ln -s "$R/exchange/acroveliq/terv.md" "$R/elo/link.md"
ln -s "$R/exchange" "$R/linkdir"
check 'under store/ -> 1' 1 "$(dr store/x.md t1)"
check 'a dot-component -> 2' 2 "$(dr agents/x/.claude/s.md t2)"
check '.. in the path -> 2' 2 "$(dr exchange/../store/x.md t3)"
check 'a file only its owner reads -> 1' 1 "$(dr elo/privat.md t4)"
check 'an empty file -> 1' 1 "$(dr elo/ures.md t5)"
check 'no folder in the path (the Task Core reads no path there) -> 2' 2 "$(dr teteje.md t6)"
check 'a symlinked file -> 1' 1 "$(dr elo/link.md t7)"
check 'a symlinked folder on the path -> 1' 1 "$(dr linkdir/acroveliq/terv.md t8)"
check 'a missing file -> 1' 1 "$(dr elo/nincs.md t9)"
check 'an absolute path outside the root -> 2' 2 "$(dr /etc/passwd t10)"
check 'a path with a space -> 2' 2 "$(dr 'elo/a b.md' t11)"
check 'no task_id -> 2' 2 "$(dr exchange/acroveliq/terv.md '')"

echo '... and the copy may not widen who reads the file (barracuda, #106 review)'
mkdir -p "$R/csoport" "$R/zart"; chmod 755 "$R/csoport"; chmod 750 "$R/zart"
printf 'c\n' > "$R/csoport/negyven.md"; chmod 640 "$R/csoport/negyven.md"
printf 'z\n' > "$R/zart/nyitott.md"; chmod 644 "$R/zart/nyitott.md"
check 'a 640 file whose group is not the fleet -> 1' 1 "$(dr csoport/negyven.md t12)"
check '... and says the packet would widen it' 1 "$(d csoport/negyven.md t12 | grep -c 'tagitana, ki olvassa')"
check 'a 644 file under a 750 folder -> 1' 1 "$(dr zart/nyitott.md t13)"
check '... and names the folder' 1 "$(d zart/nyitott.md t13 | grep -c "be ide: $R/zart ")"
check 'the same 640 file when its group IS the fleet -> 0' 0 "$(GRP="$(id -gn)" dr csoport/negyven.md t14)"
check 'the same 750 folder when its group IS the fleet -> 0' 0 "$(GRP="$(id -gn)" dr zart/nyitott.md t15)"
check 'no refused document left a packet' 0 "$(ls "$T/zona" | grep -cE '^doc-(t([0-9]|1[0-3]))?$')"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
