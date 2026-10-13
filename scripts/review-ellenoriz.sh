#!/usr/bin/env bash
# ANSWERS: Hogyan rogziti a reviewer az iteletet ugy, hogy CSAK azt az egyet irhassa?
#
# review-ellenoriz.sh <csomag> <task_id> <APPROVE|CHANGES>
#   csomag: a review-csomag neve a pr- utan (1650, c512, marveen68)
#   -> egy `verdict` esemeny a feladaton, a szereplo a HIVO (az OS-felhasznalobol), a
#      hivatkozas "<ITELET> pr-<csomag> fej <sha7>"; utana visszaolvasva, hogy tenyleg ott van.
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
# The write goes through fleet-api.sh task-event (its own retry and idempotency key), and
# is then READ BACK from the timeline: the verdict lines with this ref must be one more
# than before. A 200 alone is not the proof (the queue accepting is not the record).
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
[[ "$C" =~ ^(c|marveen)?[0-9]{1,6}$ ]] || { echo "FAIL: a csomag neve szam, c<szam> vagy marveen<szam>: '$C'" >&2; exit 2; }
[[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || { echo "FAIL: ervenytelen task_id: '$TASK'" >&2; exit 2; }
case "$V" in APPROVE|CHANGES) ;; *) echo "FAIL: az itelet APPROVE vagy CHANGES, ez jott: '$V'" >&2; exit 2 ;; esac

# the caller, one line: tests replace it in a copy (CI runs as `runner`)
ME="$(id -un)"
case "$ME" in
  agent-?*) ACTOR="${ME#agent-}" ;;
  *) echo "FAIL: csak agens-felhasznalo rogzithet iteletet (a szereplo az OS-felhasznalobol jon), ez: $ME" >&2; exit 1 ;;
esac

D="$ZONA/pr-$C"
{ [ -d "$D" ] && [ ! -L "$D" ]; } || { echo "FAIL: nincs ilyen csomag, vagy symlink: $D" >&2; exit 1; }
README=""
for r in README.md README; do
  [ -e "$D/$r" ] || [ -L "$D/$r" ] || continue
  { [ -f "$D/$r" ] && [ ! -L "$D/$r" ]; } || { echo "FAIL: $D/$r symlink vagy nem fajl" >&2; exit 1; }
  README="$D/$r"; break
done
[ -n "$README" ] || { echo "FAIL: a csomagban nincs README, tehat nem tudom, melyik feladate" >&2; exit 1; }

# the task ids the README names, and the head it was packaged at
NAMED=" "; HEAD7=""
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" =~ (^|[[:space:],])task(_id)?:?[[:space:]]+([A-Za-z0-9][A-Za-z0-9._-]*) ]]; then
    NAMED="$NAMED${BASH_REMATCH[3]} "
  fi
  if [ -z "$HEAD7" ] && [[ "$line" =~ ^(fej|head):?[[:space:]]+([0-9a-f]{7,40}) ]]; then
    HEAD7="${BASH_REMATCH[2]:0:7}"
  fi
done < "$README"
case "$NAMED" in
  *" $TASK "*) ;;
  *) echo "FAIL: a csomag ($README) nem ezt a feladatot nevezi meg: '$TASK' (a README-ben: ${NAMED# })" >&2; exit 1 ;;
esac

T="$(mktemp -d)" || exit 1
trap 'rm -rf "$T"' EXIT
if ! bash "$FLEET_API" task-timeline "$TASK" > "$T/before" 2>&1; then
  echo "FAIL: a feladat idovonala nem olvashato ($TASK): $(head -c 300 "$T/before")" >&2; exit 1
fi
grep -q '  esemeny  review_requested ' "$T/before" \
  || { echo "FAIL: a(z) $TASK feladaton nincs review_requested esemeny: nem kert senki reviewt" >&2; exit 1; }

REF="$V pr-$C${HEAD7:+ fej $HEAD7}"
count_ref() { grep -c -F -x -e "$1" < <(grep '  esemeny  verdict ' "$2" | sed -E 's/^.*  esemeny  verdict +[^ ]+ +//') || true; }
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
