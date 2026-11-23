# review-kor.sh: the rounds of one PR review packet across its folders (card efdce058). Sourced by
# review-csomag.sh, review-olvas.sh and review-ellenoriz.sh; it defines functions only.
#
# A PR packet is review-csomagok/pr-<N>: the first packager's folder, with its own rounds inside (diff.patch
# and a `fej:` README line for the first, diff-vK.patch and a `vK:` line for each later one). An agent who
# takes over the PR does not own that folder (0755, its packager's) and cannot write into it, which stopped
# a takeover twice on 2026-11-23 (#2738, #821). Its round goes into a SIBLING folder of its own,
# pr-<N>.r<K>, with one round in it: a `vK:` README line and diff-vK.patch. K is the PR's next round over
# all its folders, and mkdir is atomic, so two packagers cannot write the same round.
#
# What this keeps: each folder is its writer's (0755; the sticky zone keeps others from renaming or deleting
# it), so a round once given out is not overwritten by anyone else, and a round's author is its folder's
# owner. The latest round, the HIGHEST K over the base folder and its siblings, is the one reviewed; so
# whoever can create a sibling can put a round on top, and review-ellenoriz.sh checks a sibling round's
# author against the task's review requests (acrobot 59968).

# kor_readme <folder>: the folder's README path; empty when it has none, or it is a symlink or not a file
kor_readme() {
  local r
  for r in README.md README; do
    if [ -e "$1/$r" ] || [ -L "$1/$r" ]; then
      { [ -f "$1/$r" ] && [ ! -L "$1/$r" ]; } && echo "$1/$r"
      return 0
    fi
  done
}

# kor_max_readme <folder>: the highest round the folder's README names (a fej:/head line is round 1, a vK:
# line round K), 0 when it names none
kor_max_readme() {
  local rd max=0 line
  rd="$(kor_readme "$1")"
  [ -n "$rd" ] || { echo 0; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" =~ ^v([1-9][0-9]{0,3}):[[:space:]] ]]; then
      [ "${BASH_REMATCH[1]}" -gt "$max" ] && max="${BASH_REMATCH[1]}"
    elif [ "$max" -lt 1 ] && [[ "$line" =~ ^(fej|head):?[[:space:]] ]]; then
      max=1
    fi
  done < "$rd"
  echo "$max"
}

# kor_testverek <zone> <dirname>: the sibling folder names (pr-<N>.r<K>), one per line, K in the name.
# Only the name shape is checked here; kor_legutobbi checks each folder.
kor_testverek() {
  local f b
  local oldf=0; case $- in *f*) oldf=1; set +f ;; esac
  for f in "$1/$2".r[1-9]*; do
    b="${f##*/}"
    [[ "$b" =~ ^${2}\.r[1-9][0-9]{0,3}$ ]] || continue
    { [ -e "$f" ] || [ -L "$f" ]; } && echo "$b"
  done
  [ "$oldf" = 1 ] && set -f
  return 0
}

# kor_kovetkezo <zone> <dirname>: the PR's next round number over every folder: the base folder's README,
# its diff.patch/diff-vK.patch files, and every sibling's NAME (a broken sibling still holds its number)
kor_kovetkezo() {
  local z="$1" n="$2" max k f b
  max="$(kor_max_readme "$z/$n")"
  [ -e "$z/$n/diff.patch" ] && [ "$max" -lt 1 ] && max=1
  local oldf=0; case $- in *f*) oldf=1; set +f ;; esac
  for f in "$z/$n"/diff-v[1-9]*.patch; do
    b="${f##*/}"
    [[ "$b" =~ ^diff-v([1-9][0-9]{0,3})\.patch$ ]] && [ "${BASH_REMATCH[1]}" -gt "$max" ] && max="${BASH_REMATCH[1]}"
  done
  [ "$oldf" = 1 ] && set -f
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    k="${b##*.r}"
    [ "$k" -gt "$max" ] && max="$k"
  done < <(kor_testverek "$z" "$n")
  echo $((max + 1))
}

# kor_legutobbi <zone> <dirname>: "<K> <folder>" of the latest round. A sibling counts only when it is a
# real folder (not a symlink), has a README, and that README's highest round is exactly its K (a vK: line);
# one that does not is named on stderr and left out. Two places claiming the same highest round is an
# error (exit 1): nothing decides between them. Exit 1 also when the base folder names no round.
kor_legutobbi() {
  local z="$1" n="$2" best bestd bk b f k dup=0
  best="$(kor_max_readme "$z/$n")"; bestd="$z/$n"
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    f="$z/$b"; k="${b##*.r}"
    if [ -L "$f" ] || [ ! -d "$f" ]; then echo "!! $b: symlink vagy nem mappa, kihagyva" >&2; continue; fi
    bk="$(kor_max_readme "$f")"
    if [ "$bk" != "$k" ]; then echo "!! $b: a README-je nem a(z) v$k kort nevezi (hanem: $bk), kihagyva" >&2; continue; fi
    if [ "$k" -gt "$best" ]; then best="$k"; bestd="$f"; dup=0
    elif [ "$k" -eq "$best" ]; then dup=1; fi
  done < <(kor_testverek "$z" "$n")
  [ "$dup" = 1 ] && { echo "FAIL: a(z) $best. kort ket hely is nevezi ($n es egy testver-mappa): nem dontheto el, melyik a review alapja" >&2; return 1; }
  [ "$best" -gt 0 ] || { echo "FAIL: a(z) $n README-je egy kort sem nevez (fej: vagy vN: sor)" >&2; return 1; }
  echo "$best $bestd"
}

# kor_szereplo <os user>: the fleet actor a packet folder's owner stands for (agent-<name> -> <name>, marveen -> acrobot)
kor_szereplo() {
  case "$1" in
    agent-?*) echo "${1#agent-}" ;;
    marveen) echo acrobot ;;
    *) echo "" ;;
  esac
}
