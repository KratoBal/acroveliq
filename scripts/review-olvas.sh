#!/usr/bin/env bash
# ANSWERS: Mi van egy review-csomagban, egy hivasban?
#
# review-olvas.sh <csomag>
#   csomag: a mappa neve a pr- utan: 1650 (os), c512 (commerce), marveen68 (a flotta repoja)
#   -> a README teljes szovege, majd minden .patch fajlra: tulajdonos, meret, ido, es a
#      valtozott fajlok listaja soronkent (+ - ut), a vegen az osszesites.
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
# Exit: 0 read; 1 no such packet or nothing readable in it; 2 bad argument.
set -uo pipefail
set -f

# the zone, one line: tests replace it in a copy
ZONA=/home/marveen/marveen/review-csomagok
GIT_BIN=/usr/bin/git

[ "$#" -eq 1 ] || { echo "usage: review-olvas.sh <csomag>   (pl. 1650, c512, marveen68)" >&2; exit 2; }
C="$1"
[[ "$C" =~ ^(c|marveen)?[0-9]{1,6}$ ]] || { echo "FAIL: a csomag neve szam, c<szam> vagy marveen<szam>: '$C'" >&2; exit 2; }
D="$ZONA/pr-$C"
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
