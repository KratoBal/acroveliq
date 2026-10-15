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
    # with-data: the server stored data on the event, and fleet-api.sh prints it after the ref
    if [ -f "$T/with-data" ]; then
      printf '2026-10-13 20:00:00+0200  esemeny  %-16s %-10s %s %s\n' "\$3" "\$4" "\$6" '{"would_reject": true, "would_reject_reason": "a verdict ref mezojebol hianyzik a repo#PR"}' >> "$T/tl-\$2"
    else
      printf '2026-10-13 20:00:00+0200  esemeny  %-16s %-10s %s\n' "\$3" "\$4" "\$6" >> "$T/tl-\$2"
    fi
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
  "task-event tsk-a verdict $ACTOR  APPROVE KratoBal/acroveliq#70 pr-marveen70 fej 1234567890abcdef1234567890abcdef12345678" "$(tail -n1 "$EV")"
check '... and it says it read it back' 1 "$(grep -c '^OK verdict rogzitve' "$T/out")"
check 'the same verdict again (a second round) -> 0, read back as a NEW line' 0 "$(ell marveen70 tsk-a APPROVE)"
check 'hand-made README with task: -> 0' 0 "$(ell 1700 tsk-b CHANGES)"
check '... the PR named from the packet name (pr-N: acropora-os)' "task-event tsk-b verdict $ACTOR  CHANGES KratoBal/acropora-os#1700 pr-1700 fej abcdef1" "$(tail -n1 "$EV")"
check 'hand-made README with task in the title -> 0' 0 "$(ell c80 tsk-c CHANGES)"
check '... ref with the head from "head <sha>"' "task-event tsk-c verdict $ACTOR  CHANGES KratoBal/acropora-commerce#80 pr-c80 fej 7654321fedcba" "$(tail -n1 "$EV")"
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
mkdir "$Z/pr-marveen71"; printf 'marveen PR 71 \npr: KratoBal/marveen#17\ntask_id: tsk-a\nfej: 1234567\n' > "$Z/pr-marveen71/README.md"
check 'a README pr: line naming another PR than the packet -> 1' 1 "$(ell marveen71 tsk-a APPROVE)"
mkdir "$Z/pr-marveen72"; printf 'marveen PR 72 \npr: KratoBal/acropora-os#72\ntask_id: tsk-a\nfej: 1234567\n' > "$Z/pr-marveen72/README.md"
check 'a README pr: line naming another repo than the packet -> 1' 1 "$(ell marveen72 tsk-a APPROVE)"
check 'packet 0 -> 2' 2 "$(ell 0 tsk-a APPROVE)"
check 'a packet number with a leading zero -> 2' 2 "$(ell marveen070 tsk-a APPROVE)"
check 'no refusal wrote an event' "$n" "$(events)"
mkdir "$Z/pr-1709"; printf 'os PR 1709 \ntask_id: tsk-a\nfej: 1111111aaaa\nv2: task_id tsk-b, fej 2222222bbbb, merge-base x, origin/main y \n' > "$Z/pr-1709/README.md"
check 'a later round line (vN: task_id X,) binds that task -> 0' 0 "$(ell 1709 tsk-b CHANGES)"
check '... and the ref names THAT round head, not the first' "task-event tsk-b verdict $ACTOR  CHANGES KratoBal/acropora-os#1709 pr-1709 fej 2222222bbbb" "$(tail -n1 "$EV")"
mkdir "$Z/pr-marveen73"; printf 'marveen PR 73 \npr: KratoBal/marveen#73\ntask_id: tsk-a\nfej: 3333333cccc\n' > "$Z/pr-marveen73/README.md"
check 'a README pr: line with the fleet repo old name (a packet from before the rename) -> 0' 0 "$(ell marveen73 tsk-a APPROVE)"
check '... and the verdict keeps the name the README gave' "task-event tsk-a verdict $ACTOR  APPROVE KratoBal/marveen#73 pr-marveen73 fej 3333333cccc" "$(tail -n1 "$EV")"
mkdir "$Z/pr-marveen74"; printf 'marveen PR 74 \npr: KratoBal/acroveliq#74\ntask_id: tsk-a\nfej: 4444444dddd\n' > "$Z/pr-marveen74/README.md"
check 'a README pr: line that agrees (review-csomag.sh shape, the new name) -> 0' 0 "$(ell marveen74 tsk-a APPROVE)"
check '... ref KratoBal/acroveliq#74' "task-event tsk-a verdict $ACTOR  APPROVE KratoBal/acroveliq#74 pr-marveen74 fej 4444444dddd" "$(tail -n1 "$EV")"
n="$(events)"

echo 'the profile: the Task Core writers are denied for the reviewer only'
RV="$HERE/../../templates/profiles/reviewer.json"; RR="$HERE/../../templates/profiles/researcher-reader.json"
for c in task-event kiadas task-new task-session handoff-write; do
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

echo 'the AI service packet (acrobot 30257): pr-ai<N> is KratoBal/acropora-ai-agent#N'
n="$(events)"
mkdir "$Z/pr-ai37"
# the shape murena made by hand on 2026-10-14 (pr-ai37), and the second round line
printf 'KratoBal/acropora-ai-agent#37 feat(recommendation): three parts\ntask_id: tsk-a\nfej: 278c1d363134486fd48c69a8e3ae7d47c4d0d296\nmerge-base: fe29f6e\nv2: task_id tsk-a, fej 2a4c62f661f628ad557170e9ed80aadecabec6fd\n' > "$Z/pr-ai37/README"
cp "$Z/pr-marveen70/diff.patch" "$Z/pr-ai37/diff.patch"
check 'olvas: an ai packet -> 0' 0 "$(olv ai37)"
check 'ellenoriz: an ai packet -> 0' 0 "$(ell ai37 tsk-a APPROVE)"
check '... the ref names the AI repo and the latest round head' \
  "task-event tsk-a verdict $ACTOR  APPROVE KratoBal/acropora-ai-agent#37 pr-ai37 fej 2a4c62f661f628ad557170e9ed80aadecabec6fd" "$(tail -n1 "$EV")"
mkdir "$Z/pr-ai38"; printf 'ai PR 38 \npr: KratoBal/acropora-os#38\ntask_id: tsk-a\nfej: 1234567\n' > "$Z/pr-ai38/README.md"
check 'an ai packet whose README pr: names another repo -> 1' 1 "$(ell ai38 tsk-a APPROVE)"
check 'an unknown prefix -> 2' 2 "$(ell xy37 tsk-a APPROVE)"
check 'olvas: an unknown prefix -> 2' 2 "$(olv xy37)"
check 'one event, from the good packet only' "$((n + 1))" "$(events)"

echo 'a document packet (task review-docs-verdict): the file path in the ref, the copy checked'
n="$(events)"
mkdir "$Z/doc-tsk-d"; printf 'terv\n' > "$Z/doc-tsk-d/v1-terv.md"
H1="$(sha256sum < "$Z/doc-tsk-d/v1-terv.md")"; H1="${H1%% *}"
printf 'docs exchange/acroveliq/terv.md \ntask_id: tsk-d\nfajl: exchange/acroveliq/terv.md\nsha256: %s\n' "$H1" > "$Z/doc-tsk-d/README.md"
printf '2026-10-13 19:00:00+0200  esemeny  review_requested nautilus   exchange/acroveliq/terv.md\n' > "$T/tl-tsk-d"
check 'olvas: a document packet -> 0' 0 "$(olv doc-tsk-d)"
check '... names the copy with its sha256 and the path to read' 2 "$(grep -cE "^   (sha256 $H1|olvasd: $Z/doc-tsk-d/v1-terv\.md)\$" "$T/out")"
check 'the first round -> 0' 0 "$(ell doc-tsk-d tsk-d APPROVE)"
check '... the ref carries the path, the packet and the hash' \
  "task-event tsk-d verdict $ACTOR  APPROVE exchange/acroveliq/terv.md doc-tsk-d sha256 ${H1:0:12}" "$(tail -n1 "$EV")"
printf 'terv v2\n' > "$Z/doc-tsk-d/v2-terv2.md"
H2="$(sha256sum < "$Z/doc-tsk-d/v2-terv2.md")"; H2="${H2%% *}"
printf 'v2: task_id tsk-d, fajl exchange/acroveliq/terv2.md, sha256 %s masodik kor\n' "$H2" >> "$Z/doc-tsk-d/README.md"
check 'a later round -> 0' 0 "$(ell doc-tsk-d tsk-d CHANGES)"
check '... the ref names THAT round file and hash' \
  "task-event tsk-d verdict $ACTOR  CHANGES exchange/acroveliq/terv2.md doc-tsk-d sha256 ${H2:0:12}" "$(tail -n1 "$EV")"
check 'olvas lists both rounds' 2 "$(olv doc-tsk-d >/dev/null; grep -c '^   olvasd: ' "$T/out")"
# acrobot 31015: a verdict whose event carries data (a would_reject mark) was recorded, and
# the read-back still failed, because the timeline prints the data after the ref
touch "$T/with-data"
check 'a recorded verdict with data on its event -> 0' 0 "$(ell doc-tsk-d tsk-d CHANGES)"
check '... a second identical one too (the count before already holds the first)' 0 "$(ell doc-tsk-d tsk-d CHANGES)"
check '... and the would_reject mark is named as a warning' 1 "$(grep -c '^FIGYELEM: a szerver would_reject jelet tett az esemenyre (kenyszerit modban 409 lenne): a verdict ref mezojebol hianyzik a repo#PR$' "$T/out")"
rm "$T/with-data"
check 'without data, no warning' 0 "$(ell doc-tsk-d tsk-d APPROVE)"
check '... none printed' 0 "$(grep -c '^FIGYELEM' "$T/out")"
n="$(events)"
for x in e f g h i j; do printf '2026-10-13 19:00:00+0200  esemeny  review_requested nautilus   x/a.md\n' > "$T/tl-tsk-$x"; done
mkdir "$Z/doc-tsk-e"; printf 'eredeti\n' > "$Z/doc-tsk-e/v1-a.md"
HE="$(sha256sum < "$Z/doc-tsk-e/v1-a.md")"; HE="${HE%% *}"
printf 'docs x/a.md \ntask_id: tsk-e\nfajl: x/a.md\nsha256: %s\n' "$HE" > "$Z/doc-tsk-e/README.md"
printf 'kicserelve\n' > "$Z/doc-tsk-e/v1-a.md"
check 'a copy changed after packaging -> 1' 1 "$(ell doc-tsk-e tsk-e APPROVE)"
check '... and says so' 1 "$(grep -c 'csomagolas utan valtozott' "$T/out")"
mkdir "$Z/doc-tsk-f"; printf 'docs x/a.md \ntask_id: tsk-f\nfajl: x/a.md\nsha256: %s\n' "$HE" > "$Z/doc-tsk-f/README.md"
check 'the copy missing -> 1' 1 "$(ell doc-tsk-f tsk-f APPROVE)"
mkdir "$Z/doc-tsk-g"; printf 'x\n' > "$Z/doc-tsk-g/real.md"; ln -s "$Z/doc-tsk-g/real.md" "$Z/doc-tsk-g/v1-a.md"
HG="$(sha256sum < "$Z/doc-tsk-g/real.md")"; HG="${HG%% *}"
printf 'docs x/a.md \ntask_id: tsk-g\nfajl: x/a.md\nsha256: %s\n' "$HG" > "$Z/doc-tsk-g/README.md"
check 'a symlinked copy -> 1' 1 "$(ell doc-tsk-g tsk-g APPROVE)"
mkdir "$Z/doc-tsk-h"; printf 'docs x/a.md \ntask_id: tsk-h\nfajl: x/a.md\n' > "$Z/doc-tsk-h/README.md"; printf 'x\n' > "$Z/doc-tsk-h/v1-a.md"
check 'a README with no sha256 -> 1' 1 "$(ell doc-tsk-h tsk-h APPROVE)"
mkdir "$Z/doc-tsk-i"; printf 'x\n' > "$Z/doc-tsk-i/v1-a.md"; HI="$(sha256sum < "$Z/doc-tsk-i/v1-a.md")"; HI="${HI%% *}"
printf 'docs a.md \ntask_id: tsk-i\nfajl: a.md\nsha256: %s\n' "$HI" > "$Z/doc-tsk-i/README.md"
check 'a path with no folder (the Task Core would not read it as a path) -> 1' 1 "$(ell doc-tsk-i tsk-i APPROVE)"
mkdir "$Z/doc-tsk-j"; cp "$Z/doc-tsk-i/v1-a.md" "$Z/doc-tsk-j/v1-a.md"
printf 'docs x/a.md \npr: KratoBal/marveen#1\ntask_id: tsk-j\nfajl: x/a.md\nsha256: %s\n' "$HI" > "$Z/doc-tsk-j/README.md"
check 'a document packet whose README names a PR -> 1' 1 "$(ell doc-tsk-j tsk-j APPROVE)"
mkdir "$Z/doc-tsk-k"; cp "$Z/doc-tsk-d/v1-terv.md" "$Z/doc-tsk-k/v1-terv.md"
printf 'docs exchange/acroveliq/terv.md \ntask_id: tsk-a\nfajl: exchange/acroveliq/terv.md\nsha256: %s\n' "$H1" > "$Z/doc-tsk-k/README.md"
check 'a doc folder of one task whose README names another (tsk-a has a review request) -> 1' 1 "$(ell doc-tsk-k tsk-a APPROVE)"
check '... and says why' 1 "$(grep -c 'nem ennek a feladatnak a mappaja' "$T/out")"
check 'the document packet of another task -> 1' 1 "$(ell doc-tsk-d tsk-a APPROVE)"
check 'doc- with a path in it -> 2' 2 "$(ell doc-../x tsk-d APPROVE)"
check 'doc- alone -> 2' 2 "$(ell doc- tsk-d APPROVE)"
check 'olvas: doc- with a path -> 2' 2 "$(olv doc-../x)"
check 'no document refusal wrote an event' "$n" "$(events)"

# the refs the script wrote, for the Task Core guard test (src/__tests__/review-ref-shape.test.ts)
[ -n "${REVIEW_REFS_OUT:-}" ] && grep ' verdict ' "$EV" | sed -E 's/^task-event [^ ]+ verdict [^ ]+  //' > "$REVIEW_REFS_OUT"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
