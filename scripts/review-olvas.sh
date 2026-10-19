#!/usr/bin/env bash
# ANSWERS: Mi van egy review-csomagban, egy hivasban?
#
# review-olvas.sh <csomag>
#   csomag: a mappa neve a pr- utan: 1650 (os), c512 (commerce), marveen68 (a flotta repoja), ai37 (az AI szolgaltatas),
#      cap3 (a Caparium nAPPlo, az elso ugyfelprojekt),
#      vagy egy dokumentum-csomag teljes neve: doc-<task_id> (review-csomag.sh docs)
#   -> a README teljes szovege, majd minden .patch fajlra: tulajdonos, meret, ido, es a
#      valtozott fajlok listaja soronkent (+ - ut), a vegen az osszesites. Dokumentum-
#      csomagnal a masolatok (vN-<nev>): tulajdonos, meret, sorok, sha256 es a teljes ut,
#      amit olvasni kell (task review-docs-verdict).
#
# WHY (reviewer-profil, 2026-10-13): reading a packet took barracuda three to five piped
# calls per review (cat, grep '^diff --git', a count), and every pipe or `$(...)` is a
# permission stop in a strict profile. This is the same reading as one named command.
#
# The packet name is checked against a pattern and the zone is fixed here: the caller
# names a packet, never a path. A packet folder or file that is a symlink is not read
# (someone else put it there), and each file's owner is printed, because the owner is
# who packaged it.
#
# The statistics come from `git apply --numstat` run on the patch as data, outside any
# repository, with an emptied environment: it parses, applies nothing, runs nothing.
#
# review-olvas.sh --fej <csomag>   (a PR packet only)
#   -> the diff of the packet's head, made HERE from GitHub, not taken from the packet
#      (the D4 step list E3 (b), acrobot 31441): scripts/lib/review-fej-diff.py asks GitHub
#      anonymously (the fleet repositories are public) whether the PR's head is still the
#      packet's latest full head, takes the compare diff of THAT sha, writes it to
#      ~/.review-fej/ (0700/0600) and compares it with the packet's latest patch, file by file and
#      line by line (the changed lines and the mode lines, not only the counts). Only a full match
#      leaves the <...>.egyezik marker review-ellenoriz.sh needs for an APPROVE.
#      WHY: the approver approves the head the README names, and the README and diff.patch are
#      the developer's. A head with more in it than diff.patch would pass. Read the file it names.
#
# Exit: 0 read (--fej: and the packet's patch is the head's diff); 1 no such packet, nothing
# readable in it (--fej: or the head is not 40 hex, the PR moved on, GitHub did not answer, or
# the patch differs); 2 bad argument.
set -uo pipefail
set -f

# the zone, one line: tests replace it in a copy
ZONA=/home/marveen/marveen/review-csomagok
GIT_BIN=/usr/bin/git
GH_API=https://api.github.com
FEJ_DIFF=/home/marveen/marveen/scripts/lib/review-fej-diff.py

FEJ=0
if [ "$#" -eq 2 ] && [ "$1" = --fej ]; then FEJ=1; shift; fi
[ "$#" -eq 1 ] || { echo "usage: review-olvas.sh [--fej] <csomag>   (pl. 1650, c512, marveen68, ai37, cap3, doc-<task_id>)" >&2; exit 2; }
C="$1"
DOCS=0
if [[ "$C" =~ ^doc-[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]]; then DOCS=1; D="$ZONA/$C"
elif [[ "$C" =~ ^(cap|c|marveen|ai)?[0-9]{1,6}$ ]]; then D="$ZONA/pr-$C"
else echo "FAIL: a csomag neve szam, c<szam>, marveen<szam>, ai<szam>, cap<szam> vagy doc-<task_id>: '$C'" >&2; exit 2
fi
[ -L "$D" ] && { echo "FAIL: $D symlink, nem olvasom: valaki mas tette oda" >&2; exit 1; }
[ -d "$D" ] || { echo "FAIL: nincs ilyen csomag: $D" >&2; exit 1; }

echo "== csomag: $D (tulajdonos: $(stat -c %U "$D"))"
found=0
for r in README.md README; do
  f="$D/$r"
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ] || [ ! -f "$f" ]; then echo "!! $r: symlink vagy nem fajl, kihagyva"; continue; fi
  echo "== $r (tulajdonos: $(stat -c %U "$f"))"
  cat "$f"
  found=1
done
[ "$found" = 1 ] || echo "!! nincs README a csomagban"

if [ "$FEJ" = 1 ]; then
  [ "$DOCS" = 0 ] || { echo "FAIL: --fej csak PR-csomagra: egy dokumentumnak nincs feje" >&2; exit 2; }
  [ "$found" = 1 ] || exit 1
  [[ "$C" =~ ^(cap|c|marveen|ai)?([0-9]{1,6})$ ]]
  case "${BASH_REMATCH[1]}" in
    c) REPO=KratoBal/acropora-commerce ;; marveen) REPO=KratoBal/acroveliq ;;
    ai) REPO=KratoBal/acropora-ai-agent ;; cap) REPO=KratoBal/caparium-napplo ;; *) REPO=KratoBal/acropora-os ;;
  esac
  PRN="${BASH_REMATCH[2]}"
  # the latest round's head and patch: review-csomag.sh writes `fej: <sha>` and diff.patch for the
  # first round, a `vN: task_id X, fej <sha>, ...` line and diff-vN.patch for each later one
  HEAD="" PATCH="$D/diff.patch"
  for r in README.md README; do
    { [ -f "$D/$r" ] && [ ! -L "$D/$r" ]; } || continue
    while IFS= read -r line || [ -n "$line" ]; do
      if [[ "$line" =~ ^fej:[[:space:]]+([0-9a-f]+)[[:space:]]*$ ]] && [ -z "$HEAD" ]; then HEAD="${BASH_REMATCH[1]}"
      elif [[ "$line" =~ ^v([0-9]+):.*[[:space:]]fej[[:space:]]+([0-9a-f]+)(,|[[:space:]]|$) ]]; then
        HEAD="${BASH_REMATCH[2]}"; PATCH="$D/diff-v${BASH_REMATCH[1]}.patch"
      fi
    done < "$D/$r"
    break
  done
  [[ "$HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: a csomag legutolso feje nem 40 jegyu ('$HEAD'): a fejbol nem allithato elo diff" >&2; exit 1; }
  echo
  python3 -I "$FEJ_DIFF" "$GH_API" "$REPO" "$PRN" "$HEAD" "$HOME/.review-fej" "$PATCH"
  exit $?
fi

if [ "$DOCS" = 1 ]; then
  n_doc=0
  set +f; shopt -s nullglob; COPIES=("$D"/v[0-9]*-*); shopt -u nullglob; set -f
  for f in "${COPIES[@]}"; do
    b="${f##*/}"
    if [ -L "$f" ] || [ ! -f "$f" ]; then echo "!! $b: symlink vagy nem fajl, kihagyva"; continue; fi
    n_doc=$((n_doc + 1))
    h="$(sha256sum < "$f")"
    echo
    echo "== $b (tulajdonos: $(stat -c %U "$f"), $(stat -c %s "$f") bajt, $(wc -l < "$f") sor, $(date -d "@$(stat -c %Y "$f")" '+%Y-%m-%d %H:%M:%S%z'))"
    echo "   sha256 ${h%% *}"
    echo "   olvasd: $f"
  done
  [ "$n_doc" -gt 0 ] || { echo "!! nincs olvashato masolat a csomagban"; exit 1; }
  exit 0
fi

T="$(mktemp -d)" || exit 1
trap 'rm -rf "$T"' EXIT
n_patch=0
# globbing is off for the whole script (set -f); this one list is the only glob, on a
# fixed folder with a fixed suffix
set +f; shopt -s nullglob; PATCHES=("$D"/*.patch); shopt -u nullglob; set -f
for f in "${PATCHES[@]}"; do
  b="${f##*/}"
  if [ -L "$f" ] || [ ! -f "$f" ]; then echo "!! $b: symlink vagy nem fajl, kihagyva"; continue; fi
  n_patch=$((n_patch + 1))
  echo
  echo "== $b (tulajdonos: $(stat -c %U "$f"), $(stat -c %s "$f") bajt, $(date -d "@$(stat -c %Y "$f")" '+%Y-%m-%d %H:%M:%S%z'))"
  if [ ! -s "$f" ]; then echo "   (ures patch)"; continue; fi
  if ! (cd "$T" && env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$T" GIT_CEILING_DIRECTORIES="$T" \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
        "$GIT_BIN" apply --numstat "$f" > "$T/numstat" 2> "$T/err"); then
    echo "   !! a patch nem olvashato: $(head -c 300 "$T/err")"
    continue
  fi
  files=0; plus=0; minus=0; bin=0
  while IFS=$'\t' read -r a d p; do
    files=$((files + 1))
    if [ "$a" = "-" ]; then bin=$((bin + 1)); printf '   bin   %s\n' "$p"; continue; fi
    plus=$((plus + a)); minus=$((minus + d))
    printf '   +%-5s -%-5s %s\n' "$a" "$d" "$p"
  done < "$T/numstat"
  echo "   osszesen: $files fajl, +$plus -$minus$([ "$bin" -gt 0 ] && echo ", $bin binaris")"
done
[ "$n_patch" -gt 0 ] || { echo "!! nincs olvashato .patch a csomagban"; exit 1; }
exit 0
