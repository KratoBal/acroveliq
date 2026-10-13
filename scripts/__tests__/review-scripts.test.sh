#!/usr/bin/env bash
# Guard for scripts/review-olvas.sh and scripts/review-ellenoriz.sh (reviewer-profil,
# Balazs 2026-10-13 18:07 UTC). review-ellenoriz may write ONE kind of event: the verdict
# of the review the packet names, in the caller's own name. Every refusal below is
# checked twice: the exit code, AND that the stub's event log did not grow (a guard is
# proven by what did not happen, not by its message).
#
# Both scripts keep their fixed places on one line each; this test replaces them in
# COPIES, and fleet-api.sh is a stub that keeps the timeline in a file.
#
# Run: bash scripts/__tests__/review-scripts.test.sh   Exit 0 = all pass.
set -u
umask 022
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
check() {  # name, expected, actual
  if [ "$2" = "$3" ]; then echo "  [PASS] $1"; else echo "  [FAIL] $1 (got '$3', want '$2')"; fails=$((fails + 1)); fi
}
Z="$T/zona"; mkdir "$Z"
EV="$T/events"; : > "$EV"

# the stub: task-timeline prints the timeline format fleet-api.sh prints, task-event
# appends to it. A task with no file does not exist.
cat > "$T/fleet-api.sh" <<EOF
#!/usr/bin/env bash
case "\$1" in
  task-timeline) f="$T/tl-\$2"; [ -f "\$f" ] || { echo "FAIL http=404"; exit 1; }; cat "\$f" ;;
  task-event)
    [ -f "$T/fail-event" ] && { echo "FAIL http=500"; exit 1; }
    printf '%s\n' "\$*" >> "$EV"
    [ -f "$T/swallow" ] && { echo '{"ok":true}'; exit 0; }
    printf '2026-10-13 20:00:00+0200  esemeny  %-16s %-10s %s\n' "\$3" "\$4" "\$6" >> "$T/tl-\$2"
    echo '{"ok":true}' ;;
  *) echo "stub: unexpected \$1"; exit 1 ;;
esac
EOF
sed -e "s|^ZONA=.*|ZONA=$Z|" -e "s|^FLEET_API=.*|FLEET_API=$T/fleet-api.sh|" -e 's|^ME=.*|ME=agent-tesztelo|' \
  "$HERE/../review-ellenoriz.sh" > "$T/ell.sh"
sed -e 's|^ME=agent-tesztelo|ME=runner|' "$T/ell.sh" > "$T/ell-nem-agens.sh"
# the packets below are owned by whoever runs the test (CI: runner): the main copy also
# accepts that owner, a second copy accepts nobody
RUNNER="$(id -un)"
sed -i "s|^PACKAGERS_RE=.*|PACKAGERS_RE='^(agent-.+\\|marveen\\|$RUNNER)\$'|" "$T/ell.sh"
sed -e "s|^PACKAGERS_RE=.*|PACKAGERS_RE='^senki-sem\$'|" "$T/ell.sh" > "$T/ell-idegen-csomag.sh"
check 'the main copy accepts the runner' 1 "$(grep -cxF "PACKAGERS_RE='^(agent-.+|marveen|$RUNNER)\$'" "$T/ell.sh")"
check 'the second copy accepts nobody' 1 "$(grep -cxF "PACKAGERS_RE='^senki-sem\$'" "$T/ell-idegen-csomag.sh")"
sed -e "s|^ZONA=.*|ZONA=$Z|" "$HERE/../review-olvas.sh" > "$T/olv.sh"
check 'the copies point at the test zone' 2 "$(grep -c "^ZONA=$Z\$" "$T/ell.sh" "$T/olv.sh" | grep -c ':1$')"
check '... and name a test caller' 1 "$(grep -c '^ME=agent-tesztelo$' "$T/ell.sh")"
ACTOR=tesztelo
# a packet made the way review-csomag.sh makes it, plus the two hand-made shapes
mkdir "$Z/pr-marveen70" "$Z/pr-1700" "$Z/pr-c80"
printf 'marveen PR 70 \ntask_id: tsk-a\nfej: 1234567890abcdef1234567890abcdef12345678\nmerge-base: aaa\norigin/main: aaa\n' > "$Z/pr-marveen70/README.md"
printf 'PR: KratoBal/acropora-os #1700\nfej: abcdef1\ntask: tsk-b\n' > "$Z/pr-1700/README"
printf 'PR KratoBal/acropora-commerce #80, task tsk-c\nhead 7654321fedcba\n' > "$Z/pr-c80/README"
git init -q "$T/r"; printf 'a\n' > "$T/r/f.txt"
git -C "$T/r" add f.txt; git -C "$T/r" -c user.name=t -c user.email=t@t commit -q -m a
printf 'b\n' >> "$T/r/f.txt"; printf 'x\n' > "$T/r/g.txt"; git -C "$T/r" add -N g.txt
git -C "$T/r" diff > "$Z/pr-marveen70/diff.patch"
cp "$Z/pr-marveen70/diff.patch" "$Z/pr-1700/diff.patch"
for t in tsk-a tsk-b tsk-c; do
  printf '2026-10-13 19:00:00+0200  esemeny  review_requested murena     PR\n' > "$T/tl-$t"
done
printf '2026-10-13 19:00:00+0200  esemeny  started          murena     \n' > "$T/tl-nincs-kerve"
ell() { bash "$T/ell.sh" "$@" >"$T/out" 2>&1; echo $?; }
olv() { bash "$T/olv.sh" "$@" >"$T/out" 2>&1; echo $?; }
events() { wc -l < "$EV" | tr -d ' '; }

echo 'review-olvas: one call'
check 'a packet -> 0' 0 "$(olv marveen70)"
check '... prints the README' 1 "$(grep -c '^task_id: tsk-a$' "$T/out")"
check '... and both changed files with their counts' 2 "$(grep -cE '^   \+1 +-(0|1) +(f|g)\.txt$' "$T/out")"
check '... and the total' 1 "$(grep -c '^   osszesen: 2 fajl, +2 -0$' "$T/out")"
check 'a path as packet name -> 2' 2 "$(olv ../x)"
check 'a missing packet -> 1' 1 "$(olv 999)"
mkdir "$Z/pr-1701"; ln -s "$Z/pr-marveen70/diff.patch" "$Z/pr-1701/diff.patch"
check 'a symlinked patch is not read -> 1' 1 "$(olv 1701)"
check '... and says so' 1 "$(grep -c 'symlink vagy nem fajl, kihagyva' "$T/out")"
ln -s "$Z/pr-marveen70" "$Z/pr-1702"
check 'a symlinked packet folder -> 1' 1 "$(olv 1702)"

echo 'review-ellenoriz: the one write it may do'
check 'the packet task, APPROVE -> 0' 0 "$(ell marveen70 tsk-a APPROVE)"
check '... one event' 1 "$(events)"
check '... kind verdict, actor the caller, ref from the packet' \
  "task-event tsk-a verdict $ACTOR  APPROVE pr-marveen70 fej 1234567" "$(tail -n1 "$EV")"
check '... and it says it read it back' 1 "$(grep -c '^OK verdict rogzitve' "$T/out")"
check 'the same verdict again (a second round) -> 0, read back as a NEW line' 0 "$(ell marveen70 tsk-a APPROVE)"
check 'hand-made README with task: -> 0' 0 "$(ell 1700 tsk-b CHANGES)"
check 'hand-made README with task in the title -> 0' 0 "$(ell c80 tsk-c CHANGES)"
check '... ref with the head from "head <sha>"' "task-event tsk-c verdict $ACTOR  CHANGES pr-c80 fej 7654321" "$(tail -n1 "$EV")"
n="$(events)"

echo 'review-ellenoriz: what it refuses, and that nothing was written'
check 'a task the packet does not name -> 1' 1 "$(ell marveen70 tsk-b APPROVE)"
check 'a verdict word outside the two -> 2' 2 "$(ell marveen70 tsk-a done)"
check 'a lower-case verdict -> 2' 2 "$(ell marveen70 tsk-a approve)"
check 'a path as packet name -> 2' 2 "$(ell ../../x tsk-a APPROVE)"
check 'an id with a space -> 2' 2 "$(ell marveen70 'tsk-a x' APPROVE)"
check 'a fourth argument (an actor, a ref) -> 2' 2 "$(ell marveen70 tsk-a APPROVE barracuda)"
check 'a missing packet -> 1' 1 "$(ell 999 tsk-a APPROVE)"
check 'a symlinked packet folder -> 1' 1 "$(ell 1702 tsk-a APPROVE)"
mkdir "$Z/pr-1703"; ln -s "$Z/pr-marveen70/README.md" "$Z/pr-1703/README.md"
check 'a symlinked README -> 1' 1 "$(ell 1703 tsk-a APPROVE)"
mkdir "$Z/pr-1704"; printf 'fej: abcdef1\n' > "$Z/pr-1704/README"
check 'a README naming no task -> 1' 1 "$(ell 1704 tsk-a APPROVE)"
mkdir "$Z/pr-1705"; printf 'task_id: nincs-kerve\n' > "$Z/pr-1705/README.md"
check 'a task with no review_requested -> 1' 1 "$(ell 1705 nincs-kerve APPROVE)"
mkdir "$Z/pr-1706"; printf 'task_id: nincs-ilyen\n' > "$Z/pr-1706/README.md"
check 'a task that does not exist -> 1' 1 "$(ell 1706 nincs-ilyen APPROVE)"
mkdir "$Z/pr-1707"; printf 'task_id: tsk-a-masik\n' > "$Z/pr-1707/README.md"
cp "$T/tl-tsk-a" "$T/tl-tsk-a-masik"
check 'a task id that only STARTS like the named one -> 1' 1 "$(ell 1707 tsk-a APPROVE)"
check 'a caller that is not an agent user -> 1' 1 "$(bash "$T/ell-nem-agens.sh" marveen70 tsk-a APPROVE >/dev/null 2>&1; echo $?)"
mkdir "$Z/pr-1708"; printf 'task_id: tsk-a\nmegjegyzes: a task blocks merging until review\n' > "$Z/pr-1708/README.md"
cp "$T/tl-tsk-a" "$T/tl-blocks"
check 'a prose line ("a task blocks ...") names no task -> 1' 1 "$(ell 1708 blocks APPROVE)"
check 'a packet owner that is not a packager -> 1' 1 "$(bash "$T/ell-idegen-csomag.sh" marveen70 tsk-a APPROVE >/dev/null 2>&1; echo $?)"
check 'no refusal wrote an event' "$n" "$(events)"
mkdir "$Z/pr-1709"; printf 'os PR 1709 \ntask_id: tsk-a\nfej: 1111111aaaa\nv2: task_id tsk-b, fej 2222222bbbb, merge-base x, origin/main y \n' > "$Z/pr-1709/README.md"
check 'a later round line (vN: task_id X,) binds that task -> 0' 0 "$(ell 1709 tsk-b CHANGES)"
n="$(events)"

echo 'the profile: the event writers are denied for the reviewer only'
RV="$HERE/../../templates/profiles/reviewer.json"; RR="$HERE/../../templates/profiles/researcher-reader.json"
for c in task-event kiadas; do
  rule="\"Bash(bash \${HOME}/marveen/scripts/fleet-api.sh $c:*)\""
  check "reviewer.json denies fleet-api.sh $c" 1 "$(grep -cF "$rule" "$RV")"
  check "... researcher-reader.json (polip) does not" 0 "$(grep -cF "$rule" "$RR")"
done
check 'review-ellenoriz.sh writes from its own process, not through the harness' 1 \
  "$(grep -cF 'bash "$FLEET_API" task-event "$TASK" verdict "$ACTOR"' "$HERE/../review-ellenoriz.sh")"

echo 'review-ellenoriz: the write is read back'
touch "$T/fail-event"
check 'the event call fails -> 1' 1 "$(ell marveen70 tsk-a CHANGES)"
rm "$T/fail-event"
touch "$T/swallow"
check 'a 200 that left no line on the timeline -> 1' 1 "$(ell marveen70 tsk-a CHANGES)"
check '... and says why' 1 "$(grep -c 'nem latszik az uj sor' "$T/out")"
rm "$T/swallow"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
