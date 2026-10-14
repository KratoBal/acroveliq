#!/usr/bin/env bash
# ANSWERS: Hogyan adok at egy PR-t barracudanak atnezesre ugy, hogy a diff tenyleg nala legyen?
#
# review-csomag.sh <os|commerce|marveen|ai> <PR> <task_id> [cimke]
#   -> review-csomagok/pr-<PR> (os), pr-c<PR> (commerce), pr-marveen<PR> (a flotta
#      repoja, KratoBal/marveen) vagy pr-ai<PR> (KratoBal/acropora-ai-agent): diff.patch + README.md
#      (pr: owner/repo#N, task_id, fej, merge-base, origin/main). Ha a mappa mar letezik, diff-vN.patch-et ir,
#      a kovetkezo szabad N-nel, a README-hez egy sort fuz.
#   A task_id KOTELEZO (TC-Lite L4): barracuda a verdict esemenyt erre irja, es eddig
#   visszakerdezett, ha a kerdesben nem allt.
#
# review-csomag.sh docs <fajl> <task_id> [cimke]
#   -> review-csomagok/doc-<task_id>: a fajl MASOLATA (v1-<nev>, a kovetkezo korben v2-<nev>)
#      + README.md (fajl: az ut a flotta gyokere alatt, task_id, sha256: a masolate).
#
# WHY docs (task review-docs-verdict, acrobot 2026-10-14, msg 30226): a docs or ops task is
# reviewed as a file, and barracuda could not record that verdict, because
# review-ellenoriz.sh took pr-<N> packets only (30212). The copy is what was reviewed: the
# file itself may change after packaging, its sha256 in the README pins the version, and
# the verdict's ref carries the path, which the Task Core takes for a docs/ops profile.
# The copy lands in a zone every fleet user reads, so it may not widen who reads the file:
# the fleet must reach it ALREADY, every folder from the root down o+x (or g+x with the
# fleet group) and the file o+r (or g+r with the fleet group). Asking only whether the file
# is "readable beyond its owner" let a 640 file of another group, or a 644 file under an
# agent's 750 folder, through (barracuda, #106 review). Nothing under store/ or behind a
# dot-component (.env, .claude) either, as a second layer.
# The path must be the real one: a symlink on it is refused, so the ref names what was copied.
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
USAGE="usage: [REVIEW_CSOMAG_REPO=<sajat klon>] review-csomag.sh <os|commerce|marveen|ai> <PR> <task_id> [cimke]
       review-csomag.sh docs <fajl> <task_id> [cimke]"
ZONA="${REVIEW_CSOMAG_DIR:-/home/marveen/marveen/review-csomagok}"

# The packet folder in the shared zone: created here, or this caller's own from an earlier
# round. A folder someone else made first (or a symlink, or a file) is refused.
claim_folder() {
  local d="$1"
  if [ ! -d "$ZONA" ] || [ -L "$ZONA" ]; then
    echo "FAIL: nincs atadasi zona ($ZONA). Root hozza letre: install -d -m 3775 -o marveen -g fleet $ZONA" >&2
    return 1
  fi
  if [ -L "$d" ]; then
    echo "FAIL: $d symlink. Nem irok bele: valaki mas tette oda." >&2; return 1
  fi
  if [ -e "$d" ]; then
    if [ ! -d "$d" ] || [ "$(stat -c %u "$d")" != "$(id -u)" ]; then
      echo "FAIL: $d mar letezik, es nem az enyem ($(stat -c %U "$d")). Elofoglalt csomag-mappa: nem irok bele, szolj acrobotnak." >&2
      return 1
    fi
  else
    mkdir -m 755 "$d" || { echo "FAIL: $d nem hozhato letre (kozben letrejott?)" >&2; return 1; }
  fi
}

if [ "${1:-}" = docs ]; then
  ROOT="${REVIEW_CSOMAG_ROOT:-/home/marveen/marveen}"
  F="${2:-}"; TASK="${3:-}"; LABEL="${4:-}"
  if ! [[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]]; then
    echo "FAIL: a harmadik hely a task_id (kotelezo, feladat-azonosito), ez erkezett: '${TASK}'" >&2
    echo "$USAGE" >&2
    exit 2
  fi
  REL="${F#"$ROOT"/}"
  SEG='[A-Za-z0-9_][A-Za-z0-9._-]*'
  if ! [[ "$REL" =~ ^$SEG(/$SEG)+$ ]]; then
    echo "FAIL: a fajl a flotta gyokere ($ROOT) alatti ut legyen, legalabb egy mappaval, pont-kezdetu resz es szokoz nelkul: '$F'" >&2
    exit 2
  fi
  case "$REL" in store/*) echo "FAIL: a store/ alol nem csomagolok (titkok, adatbazis): $REL" >&2; exit 1 ;; esac
  RROOT="$(realpath -e -- "$ROOT")" || { echo "FAIL: a gyoker nem letezik: $ROOT" >&2; exit 1; }
  REAL="$(realpath -e -- "$RROOT/$REL" 2>/dev/null)" || { echo "FAIL: nincs ilyen fajl: $ROOT/$REL" >&2; exit 1; }
  [ "$REAL" = "$RROOT/$REL" ] || { echo "FAIL: az ut symlinken at vezet ($REL -> $REAL): a ref mast nevezne meg, mint amit masolok" >&2; exit 1; }
  { [ -f "$REAL" ] && [ -r "$REAL" ]; } || { echo "FAIL: nem olvashato rendes fajl: $REL" >&2; exit 1; }
  FLEET_GROUP="${REVIEW_CSOMAG_GROUP:-fleet}"
  # reaches <path> <other bits> <group bits>: the fleet gets there without this packet
  reaches() { local m g; m="$(stat -c %a "$1")"; g="$(stat -c %G "$1")"
    (( 8#$m & $2 )) && return 0; [ "$g" = "$FLEET_GROUP" ] && (( 8#$m & $3 )) && return 0; return 1; }
  DIR="$RROOT"
  reaches "$DIR" 8#001 8#010 || { echo "FAIL: a flotta nem jut be ide: $DIR (a csomagolas tagitana, ki olvassa)" >&2; exit 1; }
  IFS=/ read -ra PARTS <<< "${REL%/*}"
  for part in "${PARTS[@]}"; do
    DIR="$DIR/$part"
    reaches "$DIR" 8#001 8#010 || { echo "FAIL: a flotta nem jut be ide: $DIR ($(stat -c '%a %U:%G' "$DIR")); a csomagolas tagitana, ki olvassa" >&2; exit 1; }
  done
  reaches "$REAL" 8#004 8#040 || { echo "FAIL: a flotta nem olvassa a fajlt ($(stat -c '%a %U:%G' "$REAL")); a csomagolas tagitana, ki olvassa" >&2; exit 1; }
  SIZE="$(stat -c %s "$REAL")"
  { [ "$SIZE" -gt 0 ] && [ "$SIZE" -le 1048576 ]; } || { echo "FAIL: a fajl merete $SIZE bajt (1 es 1048576 kozott lehet)" >&2; exit 1; }
  D="$ZONA/doc-$TASK"
  claim_folder "$D" || exit 1
  [ "${REVIEW_CSOMAG_GUARD_ONLY:-0}" = 1 ] && { echo "ok: $D fajl: $REL umask=$(umask)"; exit 0; }
  n=1; while compgen -G "$D/v$n-*" > /dev/null; do n=$((n + 1)); done
  OUT="$D/v$n-${REL##*/}"
  cat -- "$REAL" > "$OUT" || { echo "FAIL: a masolat nem irhato: $OUT" >&2; exit 1; }
  # the hash is the COPY's: that is what the reviewer reads, whatever the file does next
  H="$(sha256sum < "$OUT")"; H="${H%% *}"
  if [ "$n" = 1 ]; then
    printf "docs %s %s\ntask_id: %s\nfajl: %s\nsha256: %s\n" "$REL" "$LABEL" "$TASK" "$REL" "$H" > "$D/README.md"
  else
    printf "v%s: task_id %s, fajl %s, sha256 %s %s\n" "$n" "$TASK" "$REL" "$H" "$LABEL" >> "$D/README.md"
  fi
  echo "$OUT (sha256 $H, $(stat -c %s "$OUT") bajt)"
  exit 0
fi

case "${1:-}" in
  os) DEFAULT_REPO=/home/marveen/work/acropora-os; PFX="pr-"; SLUG=KratoBal/acropora-os ;;
  commerce) DEFAULT_REPO=/home/marveen/work/acropora-commerce; PFX="pr-c"; SLUG=KratoBal/acropora-commerce ;;
  # The fleet's own repo. Until 2026-10-13 these packets were made by hand, with three
  # README shapes (task_id:, task:, "task X" in the title): review-ellenoriz.sh binds a
  # verdict to the task the README names, so the shape now comes from here.
  marveen) DEFAULT_REPO=/home/marveen/marveen; PFX="pr-marveen"; SLUG=KratoBal/marveen ;;
  # the AI service (acrobot, 2026-10-14, msg 30257: pr-ai37 was made by hand, and the
  # reviewer's two scripts did not know the prefix; barracuda 30249)
  ai) DEFAULT_REPO=/home/marveen/work/acropora-ai-agent; PFX="pr-ai"; SLUG=KratoBal/acropora-ai-agent ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
REPO="${REVIEW_CSOMAG_REPO:-$DEFAULT_REPO}"
PR="${2:?PR szam}"; TASK="${3:-}"; LABEL="${4:-}"
case "$PR" in ''|0*|*[!0-9]*) echo "FAIL: a PR szam csak szamjegy lehet, nullaval nem kezdodik: $PR" >&2; exit 2 ;; esac
if ! [[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]]; then
  echo "FAIL: a harmadik hely a task_id (kotelezo, feladat-azonosito), ez erkezett: '${TASK}'" >&2
  echo "$USAGE" >&2
  exit 2
fi
PRREF="$SLUG#$PR"
D="$ZONA/${PFX}${PR}"
if [ ! -d "$REPO/.git" ] || [ ! -w "$REPO/.git" ]; then
  echo "FAIL: a klon ($REPO) nem git-klon, vagy nem irhato ennek a felhasznalonak ($(id -un)). Agenskent a sajat klonodat add meg: REVIEW_CSOMAG_REPO=<ut>" >&2
  exit 1
fi
# The README names the PR as owner/repo#N (card f1e388e5): a bare "PR 77" exists in two
# repos, and review-ellenoriz.sh writes this name into the verdict's ref, where the
# Task Core binds it to the merge (#78). The name comes from the mode, so the clone must
# BE that repo: a clone of another repo would fetch another repo's PR under this name.
ORIGIN="$(git -C "$REPO" remote get-url origin 2>/dev/null || true)"
if ! [[ "$ORIGIN" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)${SLUG}(\.git)?/?$ ]]; then
  echo "FAIL: a klon ($REPO) origin-ja nem a $SLUG repo: '${ORIGIN}'" >&2
  exit 1
fi
claim_folder "$D" || exit 1
[ "${REVIEW_CSOMAG_GUARD_ONLY:-0}" = 1 ] && { echo "ok: $D pr: $PRREF umask=$(umask)"; exit 0; }
cd "$REPO" || exit 1
if ! ferr=$(bash /home/marveen/marveen/scripts/git-auth.sh fetch origin main "pull/$PR/head:pr-$PR" -f 2>&1 >/dev/null); then
  echo "FAIL: fetch ($REPO): $ferr" >&2; exit 1
fi
H=$(git rev-parse "pr-$PR"); M=$(git rev-parse origin/main); B=$(git merge-base "$M" "$H")
if [ -e "$D/diff.patch" ]; then
  n=2; while [ -e "$D/diff-v$n.patch" ]; do n=$((n + 1)); done
  OUT="$D/diff-v$n.patch"
  printf "v%s: task_id %s, fej %s, merge-base %s, origin/main %s %s\n" "$n" "$TASK" "$H" "$B" "$M" "$LABEL" >> "$D/README.md"
else
  OUT="$D/diff.patch"
  printf "%s PR %s %s\npr: %s\ntask_id: %s\nfej: %s\nmerge-base: %s\norigin/main: %s\n" "$1" "$PR" "$LABEL" "$PRREF" "$TASK" "$H" "$B" "$M" > "$D/README.md"
fi
git diff "$B" "$H" > "$OUT"
echo "$OUT ($(git diff --shortstat "$B" "$H"))"
