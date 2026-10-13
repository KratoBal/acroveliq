#!/usr/bin/env bash
# ANSWERS: Hogyan adok at egy PR-t barracudanak atnezesre ugy, hogy a diff tenyleg nala legyen?
#
# review-csomag.sh <os|commerce> <PR> [cimke]
#   -> review-csomagok/pr-<PR> (os) vagy pr-c<PR> (commerce): diff.patch + README.md
#      (fej, merge-base, origin/main). Ha a mappa mar letezik, diff-vN.patch-et ir,
#      a kovetkezo szabad N-nel, a README-hez egy sort fuz.
#
# WHY: 2026-10-07 este negyszer kertem reviewt csomag nelkul (#529, #1586 v3, #1592),
# es barracuda mindegyiknel egy korbe kerult, hogy jelezze: nincs nala a diff.
#
# B45 (2026-10-13): the packet no longer goes into agents/barracuda/. Writing there
# needed every agent to be able to write barracuda's whole tree. The shared zone is
# /home/marveen/marveen/review-csomagok, created by root as 3775 marveen:fleet (sticky:
# nobody can rename or delete another packager's folder). The sticky bit does not stop
# someone from creating pr-<N> FIRST and then swapping diff.patch before barracuda reads
# it, so this script refuses a folder that is not its own, or that is a symlink.
#
# Who can run it (measured 2026-10-13, B1 zone probe): the default clone under
# /home/marveen/work is marveen-owned, so an AGENT cannot fetch into it and the run
# failed with "FAIL: fetch". An agent passes its OWN clone: REVIEW_CSOMAG_REPO=<path>.
# The clone is checked BEFORE the packet folder is created, so a failed run leaves
# nothing behind, and git's own error is shown instead of being swallowed.
#
# umask 022 first: the packet must not be group-writable even when the caller's
# session still runs with the old 002 (every agent's primary group is `fleet`, so a
# 664 diff.patch could be swapped by any agent before review; barracuda, 2026-10-13).
umask 022
set -uo pipefail
case "${1:-}" in
  os) DEFAULT_REPO=/home/marveen/work/acropora-os; PFX="pr-" ;;
  commerce) DEFAULT_REPO=/home/marveen/work/acropora-commerce; PFX="pr-c" ;;
  *) echo "usage: [REVIEW_CSOMAG_REPO=<sajat klon>] review-csomag.sh <os|commerce> <PR> [cimke]" >&2; exit 2 ;;
esac
REPO="${REVIEW_CSOMAG_REPO:-$DEFAULT_REPO}"
PR="${2:?PR szam}"; LABEL="${3:-}"
case "$PR" in ''|*[!0-9]*) echo "FAIL: a PR szam csak szamjegy lehet: $PR" >&2; exit 2 ;; esac
ZONA="${REVIEW_CSOMAG_DIR:-/home/marveen/marveen/review-csomagok}"
D="$ZONA/${PFX}${PR}"
if [ ! -d "$REPO/.git" ] || [ ! -w "$REPO/.git" ]; then
  echo "FAIL: a klon ($REPO) nem git-klon, vagy nem irhato ennek a felhasznalonak ($(id -un)). Agenskent a sajat klonodat add meg: REVIEW_CSOMAG_REPO=<ut>" >&2
  exit 1
fi
if [ ! -d "$ZONA" ] || [ -L "$ZONA" ]; then
  echo "FAIL: nincs atadasi zona ($ZONA). Root hozza letre: install -d -m 3775 -o marveen -g fleet $ZONA" >&2
  exit 1
fi
if [ -L "$D" ]; then
  echo "FAIL: $D symlink. Nem irok bele: valaki mas tette oda." >&2; exit 1
fi
if [ -e "$D" ]; then
  if [ ! -d "$D" ] || [ "$(stat -c %u "$D")" != "$(id -u)" ]; then
    echo "FAIL: $D mar letezik, es nem az enyem ($(stat -c %U "$D")). Elofoglalt csomag-mappa: nem irok bele, szolj acrobotnak." >&2
    exit 1
  fi
else
  mkdir -m 755 "$D" || { echo "FAIL: $D nem hozhato letre (kozben letrejott?)" >&2; exit 1; }
fi
[ "${REVIEW_CSOMAG_GUARD_ONLY:-0}" = 1 ] && { echo "ok: $D umask=$(umask)"; exit 0; }
cd "$REPO" || exit 1
if ! ferr=$(bash /home/marveen/marveen/scripts/git-auth.sh fetch origin main "pull/$PR/head:pr-$PR" -f 2>&1 >/dev/null); then
  echo "FAIL: fetch ($REPO): $ferr" >&2; exit 1
fi
H=$(git rev-parse "pr-$PR"); M=$(git rev-parse origin/main); B=$(git merge-base "$M" "$H")
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
