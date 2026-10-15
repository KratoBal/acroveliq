#!/usr/bin/env bash
# ANSWERS: Hogyan rogziti a reviewer az iteletet ugy, hogy CSAK azt az egyet irhassa?
#
# review-ellenoriz.sh <csomag> <task_id> <APPROVE|CHANGES>
#   csomag: a review-csomag neve a pr- utan (1650, c512, marveen68, ai37), VAGY egy dokumentum-
#      csomag teljes neve (doc-<task_id>, review-csomag.sh docs)
#   -> egy `verdict` esemeny a feladaton, a szereplo a HIVO (az OS-felhasznalobol), a
#      hivatkozas "<ITELET> <owner/repo>#<N> pr-<csomag> fej <sha7>", dokumentumnal
#      "<ITELET> <fajl utja> doc-<task_id> sha256 <12 jegy>"; utana visszaolvasva,
#      hogy tenyleg ott van.
#
# A DOCUMENT packet (task review-docs-verdict, acrobot 2026-10-14, msg 30226): a docs or
# ops task is reviewed as a file, and its verdict could not be recorded here (30212). The
# ref carries the file's path, which the Task Core takes for a docs/ops profile; the round
# is the latest `vN:` line (or the first one), and the copy the reviewer read must still
# hash to the README's sha256, so a copy swapped after packaging is refused.
#
# WHY (reviewer-profil, Balazs 2026-10-13 18:07 UTC, msg 1559628609390383170, condition 2):
# this script may record only the proper verdict OF THE GIVEN REVIEW, and gives no general
# event writing. So nothing about the event is free text from the caller:
#   - the kind is always `verdict`, the verdict one of two words (the ones in use:
#     APPROVE and CHANGES, measured on the 2026-10-13 timelines);
#   - the actor is the calling OS user without its agent- prefix, not an argument: the
#     reviewer cannot write a verdict in another agent's name;
#   - the task must be the one the packet's README names (task_id:, task:, or "task X" in
#     the title line, the three shapes in the zone on 2026-10-13), and that task must have
#     a review_requested event: no verdict on a task nobody asked a review for;
#   - the packet and its README must not be symlinks. The zone is fixed here, the caller
#     names a packet, never a path.
#   - the ref names the PR as owner/repo#N (card f1e388e5): the Task Core refuses a
#     review_requested or verdict without it in kenyszerit mode (#78), and a bare "pr-77"
#     exists for two repos. The name comes from the PACKET NAME (pr-N acropora-os, pr-cN
#     commerce, pr-marveenN the fleet repo: review-csomag.sh's prefixes), so a hand-made
#     packet works too; a README `pr:` line (review-csomag.sh writes one) must agree.
#   - the head is the LATEST round's (a `vN: ... fej <sha>` line), not the first one: a
#     verdict on round 2 named round 1's head until 2026-10-13.
# The write goes through fleet-api.sh task-event (its own retry and idempotency key), and
# is then READ BACK from the timeline: the verdict lines with this ref must be one more
# than before. A 200 alone is not the proof (the queue accepting is not the record).
# The timeline prints an event's data after its ref (` {"would_reject": true, ...}`), so the
# comparison drops that tail first: with it, a recorded verdict counted 0 before and 0 after
# and the script reported a failure while the line stood there, twice (acrobot 31015,
# t-20261015-p1-00f-karanten, 10:18:16 and 10:18:19). A ref never holds `{"`: every part of
# it is checked above. A would_reject mark on the new line is printed as a warning: the
# verdict is recorded, but the Task Core would refuse it in kenyszerit mode.
#
# Exit: 0 recorded and read back; 1 refused or not confirmed; 2 bad argument.
set -uo pipefail
set -f

# fixed places, one line each: tests replace them in a copy
ZONA=/home/marveen/marveen/review-csomagok
FLEET_API=/home/marveen/marveen/scripts/fleet-api.sh

usage() { echo "usage: review-ellenoriz.sh <csomag> <task_id> <APPROVE|CHANGES>" >&2; exit 2; }
[ "$#" -eq 3 ] || usage
C="$1"; TASK="$2"; V="$3"
DOCS=0
if [[ "$C" =~ ^doc-[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]]; then
  DOCS=1; DIRNAME="$C"; PRREF=""
elif [[ "$C" =~ ^(c|marveen|ai)?([1-9][0-9]{0,5})$ ]]; then
  DIRNAME="pr-$C"
  case "${BASH_REMATCH[1]}" in
    c) PRREF="KratoBal/acropora-commerce#${BASH_REMATCH[2]}" ;;
    marveen) PRREF="KratoBal/acroveliq#${BASH_REMATCH[2]}"; PRREF_OLD="KratoBal/marveen#${BASH_REMATCH[2]}" ;;
    ai) PRREF="KratoBal/acropora-ai-agent#${BASH_REMATCH[2]}" ;;
    *) PRREF="KratoBal/acropora-os#${BASH_REMATCH[2]}" ;;
  esac
else
  echo "FAIL: a csomag neve szam, c<szam>, marveen<szam>, ai<szam> vagy doc-<task_id>: '$C'" >&2; exit 2
fi
[[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || { echo "FAIL: ervenytelen task_id: '$TASK'" >&2; exit 2; }
case "$V" in APPROVE|CHANGES) ;; *) echo "FAIL: az itelet APPROVE vagy CHANGES, ez jott: '$V'" >&2; exit 2 ;; esac

# the caller, one line: tests replace it in a copy (CI runs as `runner`)
ME="$(id -un)"
case "$ME" in
  agent-?*) ACTOR="${ME#agent-}" ;;
  *) echo "FAIL: csak agens-felhasznalo rogzithet iteletet (a szereplo az OS-felhasznalobol jon), ez: $ME" >&2; exit 1 ;;
esac

D="$ZONA/$DIRNAME"
{ [ -d "$D" ] && [ ! -L "$D" ]; } || { echo "FAIL: nincs ilyen csomag, vagy symlink: $D" >&2; exit 1; }
README=""
for r in README.md README; do
  [ -e "$D/$r" ] || [ -L "$D/$r" ] || continue
  { [ -f "$D/$r" ] && [ ! -L "$D/$r" ]; } || { echo "FAIL: $D/$r symlink vagy nem fajl" >&2; exit 1; }
  README="$D/$r"; break
done
[ -n "$README" ] || { echo "FAIL: a csomagban nincs README, tehat nem tudom, melyik feladate" >&2; exit 1; }

# Who packaged it: the folder and its README must have the SAME owner, an agent user or
# marveen (acrobot's packets). The README is the only thing that binds the verdict to a
# task, and the zone lets anyone create a pr-<N> folder first (barracuda, review of #69).
PACKAGERS_RE='^(agent-.+|marveen)$'
DO="$(stat -c %U "$D")"; RO="$(stat -c %U "$README")"
[ "$DO" = "$RO" ] || { echo "FAIL: a csomagmappa ($DO) es a README ($RO) tulajdonosa elter" >&2; exit 1; }
[[ "$DO" =~ $PACKAGERS_RE ]] || { echo "FAIL: a csomag tulajdonosa ($DO) nem agens es nem marveen" >&2; exit 1; }

# the task ids the README names, and the head it was packaged at. Only three shapes, so
# a prose line ("a task blocks ...") names nothing: `task_id: X` or `task: X` at a line's
# start, `vN: task_id X,` (review-csomag.sh's later rounds), and "task X" in the TITLE line
# (the hand-made packets before 2026-10-13).
NAMED=" "; HEAD7=""; first=1; README_PR=""
# a document packet: the file, its copy's sha256 and the round (the first, or the latest vN:)
FAJL=""; SHA=""; ROUND=1
ID_RE='([A-Za-z0-9][A-Za-z0-9._-]*)'
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ ^task(_id)?:[[:space:]]+$ID_RE([[:space:]]|$) ]]; then
    NAMED="$NAMED${BASH_REMATCH[2]} "
  elif [[ "$line" =~ ^v[0-9]+:[[:space:]]+task_id[[:space:]]+$ID_RE(,|[[:space:]]|$) ]]; then
    NAMED="$NAMED${BASH_REMATCH[1]} "
    # a later round: its head replaces the first one
    [[ "$line" =~ [[:space:]]fej[[:space:]]+([0-9a-f]{7,40}) ]] && HEAD7="${BASH_REMATCH[1]:0:7}"
    # ... and for a document, its file and its copy's hash
    if [[ "$line" =~ ^v([0-9]+):.*[[:space:]]fajl[[:space:]]+([^,[:space:]]+),[[:space:]]+sha256[[:space:]]+([0-9a-f]{64})([[:space:]]|$) ]]; then
      ROUND="${BASH_REMATCH[1]}"; FAJL="${BASH_REMATCH[2]}"; SHA="${BASH_REMATCH[3]}"
    fi
  elif [ "$first" = 1 ] && [[ "$line" =~ (^|[[:space:],])task[[:space:]]+$ID_RE([[:space:],]|$) ]]; then
    NAMED="$NAMED${BASH_REMATCH[2]} "
  fi
  first=0
  if [ -z "$README_PR" ] && [[ "$line" =~ ^pr:[[:space:]]+([^[:space:]]+) ]]; then
    README_PR="${BASH_REMATCH[1]}"
  fi
  if [ -z "$HEAD7" ] && [[ "$line" =~ ^(fej|head):?[[:space:]]+([0-9a-f]{7,40}) ]]; then
    HEAD7="${BASH_REMATCH[2]:0:7}"
  fi
  if [ "$ROUND" = 1 ] && [[ "$line" =~ ^fajl:[[:space:]]+([^[:space:]]+)[[:space:]]*$ ]]; then FAJL="${BASH_REMATCH[1]}"; fi
  if [ "$ROUND" = 1 ] && [[ "$line" =~ ^sha256:[[:space:]]+([0-9a-f]{64})[[:space:]]*$ ]]; then SHA="${BASH_REMATCH[1]}"; fi
done < "$README"
case "$NAMED" in
  *" $TASK "*) ;;
  *) echo "FAIL: a csomag ($README) nem ezt a feladatot nevezi meg: '$TASK' (a README-ben: ${NAMED# })" >&2; exit 1 ;;
esac

if [ "$DOCS" = 1 ]; then
  # the packet folder is the task's own: a hand-made doc-<x> naming another task is refused
  [ "$C" = "doc-$TASK" ] || { echo "FAIL: a dokumentum-csomag ($C) nem ennek a feladatnak a mappaja: doc-$TASK" >&2; exit 1; }
  [ -z "$README_PR" ] || { echo "FAIL: dokumentum-csomag ($C), a README megis PR-t nevez: '$README_PR'" >&2; exit 1; }
  { [ -n "$FAJL" ] && [ -n "$SHA" ]; } || { echo "FAIL: a dokumentum-csomag README-je nem nevez fajlt es sha256-ot (fajl:, sha256: vagy vN: ... fajl X, sha256 Y)" >&2; exit 1; }
  SEG='[A-Za-z0-9_][A-Za-z0-9._-]*'
  [[ "$FAJL" =~ ^$SEG(/$SEG)+$ ]] || { echo "FAIL: a README fajl-utja nem relativ ut mappaval: '$FAJL'" >&2; exit 1; }
  COPY="$D/v$ROUND-${FAJL##*/}"
  { [ -f "$COPY" ] && [ ! -L "$COPY" ]; } || { echo "FAIL: a(z) $ROUND. kor masolata nincs a csomagban, vagy symlink: $COPY" >&2; exit 1; }
  [ "$(stat -c %U "$COPY")" = "$DO" ] || { echo "FAIL: a masolat ($COPY) tulajdonosa nem a csomagolo ($DO)" >&2; exit 1; }
  GOT="$(sha256sum < "$COPY")"; GOT="${GOT%% *}"
  [ "$GOT" = "$SHA" ] || { echo "FAIL: a masolat lenyomata ($GOT) nem az, amit a README nevez ($SHA): csomagolas utan valtozott" >&2; exit 1; }
elif [ -n "$README_PR" ] && [ -n "${PRREF_OLD:-}" ] && [ "$README_PR" = "$PRREF_OLD" ]; then
  # a package made before the fleet repo's rename (KratoBal/marveen -> KratoBal/acroveliq, 2026-10-15)
  # names the old repo: the same PR; the verdict keeps the README's name, so it binds to that package
  PRREF="$README_PR"
elif [ -n "$README_PR" ] && [ "$README_PR" != "$PRREF" ]; then
  echo "FAIL: a csomag neve ($C) a $PRREF PR-t jelenti, a README pr: sora mast: '$README_PR'" >&2; exit 1
fi

T="$(mktemp -d)" || exit 1
trap 'rm -rf "$T"' EXIT
if ! bash "$FLEET_API" task-timeline "$TASK" > "$T/before" 2>&1; then
  echo "FAIL: a feladat idovonala nem olvashato ($TASK): $(head -c 300 "$T/before")" >&2; exit 1
fi
grep -q '  esemeny  review_requested ' "$T/before" \
  || { echo "FAIL: a(z) $TASK feladaton nincs review_requested esemeny: nem kert senki reviewt" >&2; exit 1; }

if [ "$DOCS" = 1 ]; then
  REF="$V $FAJL $C sha256 ${SHA:0:12}"
else
  REF="$V $PRREF pr-$C${HEAD7:+ fej $HEAD7}"
fi
verdict_refs() { grep '  esemeny  verdict ' "$1" | sed -E -e 's/^.*  esemeny  verdict +[^ ]+ +//' -e 's/ \{".*$//'; }
count_ref() { grep -c -F -x -e "$1" < <(verdict_refs "$2") || true; }
mine() { grep '  esemeny  verdict ' "$1" | grep -c -F " $ACTOR " || true; }
n0="$(count_ref "$REF" "$T/before")"; a0="$(mine "$T/before")"

if ! bash "$FLEET_API" task-event "$TASK" verdict "$ACTOR" "" "$REF" > "$T/resp" 2>&1; then
  echo "FAIL: a verdict esemeny nem ment at: $(head -c 300 "$T/resp")" >&2; exit 1
fi
if ! bash "$FLEET_API" task-timeline "$TASK" > "$T/after" 2>&1; then
  echo "FAIL: beirva, de az idovonal visszaolvasasa nem sikerult: $(head -c 300 "$T/after")" >&2; exit 1
fi
n1="$(count_ref "$REF" "$T/after")"; a1="$(mine "$T/after")"
if [ "$n1" -ne $((n0 + 1)) ] || [ "$a1" -ne $((a0 + 1)) ]; then
  echo "FAIL: a valasz sikeres volt, de az idovonalon nem latszik az uj sor (elotte $n0, utana $n1: '$REF')" >&2; exit 1
fi
echo "OK verdict rogzitve: $TASK, $ACTOR, '$REF' (visszaolvasva az idovonalrol)"
LAST="$(grep '  esemeny  verdict ' "$T/after" | grep -F " $REF {" | tail -n1 || true)"
case "$LAST" in
  *'"would_reject": true'*)
    WR="$(printf '%s' "$LAST" | sed -E -n 's/^.*"would_reject_reason": "([^"]*)".*$/\1/p')"
    echo "FIGYELEM: a szerver would_reject jelet tett az esemenyre (kenyszerit modban 409 lenne): ${WR:-ok nelkul}" >&2 ;;
esac
