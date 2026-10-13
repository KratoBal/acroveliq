#!/usr/bin/env bash
# ANSWERS: Hogyan adok at egy PR-t barracudanak atnezesre ugy, hogy a diff tenyleg nala legyen?
#
# review-csomag.sh <os|commerce> <PR> [cimke]
#   -> agents/barracuda/pr-<PR> (os) vagy pr-c<PR> (commerce): diff.patch + README.md
#      (fej, merge-base, origin/main). Ha a mappa mar letezik, diff-vN.patch-et ir,
#      a kovetkezo szabad N-nel, a README-hez egy sort fuz.
#
# WHY: 2026-10-07 este negyszer kertem reviewt csomag nelkul (#529, #1586 v3, #1592),
# es barracuda mindegyiknel egy korbe kerult, hogy jelezze: nincs nala a diff.
set -uo pipefail
case "${1:-}" in
  os) REPO=/home/marveen/work/acropora-os; PFX="pr-" ;;
  commerce) REPO=/home/marveen/work/acropora-commerce; PFX="pr-c" ;;
  *) echo "usage: review-csomag.sh <os|commerce> <PR> [cimke]" >&2; exit 2 ;;
esac
PR="${2:?PR szam}"; LABEL="${3:-}"
D="/home/marveen/marveen/agents/barracuda/${PFX}${PR}"
cd "$REPO" || exit 1
bash /home/marveen/marveen/scripts/git-auth.sh fetch origin main "pull/$PR/head:pr-$PR" -f >/dev/null 2>&1 || { echo "FAIL: fetch" >&2; exit 1; }
H=$(git rev-parse "pr-$PR"); M=$(git rev-parse origin/main); B=$(git merge-base "$M" "$H")
mkdir -p "$D"
if [ -e "$D/diff.patch" ]; then
  n=2; while [ -e "$D/diff-v$n.patch" ]; do n=$((n + 1)); done
  OUT="$D/diff-v$n.patch"
  printf "v%s: fej %s, merge-base %s, origin/main %s %s\n" "$n" "$H" "$B" "$M" "$LABEL" >> "$D/README.md"
else
  OUT="$D/diff.patch"
  printf "%s PR %s %s\nfej: %s\nmerge-base: %s\norigin/main: %s\n" "$1" "$PR" "$LABEL" "$H" "$B" "$M" > "$D/README.md"
fi
git diff "$B" "$H" > "$OUT"
echo "$OUT ($(git diff --shortstat "$B" "$H"))"
