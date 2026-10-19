#!/usr/bin/env bash
# The fleet's way to READ a log of the production host or of a host executor project (the no-command-line plan, point G;
# docs/fleet-gate.md "naplo-szuro", docs/hosti-vegrehajto.md). A log line is text an outsider can influence (a header, a URL, an
# error message can carry an instruction), so it does not go into an agent's session as it is: the host has already run it
# through the secret filter, and this script hands it to the QUARANTINE READER, which returns a summary inside an <untrusted>
# envelope with its own secret check and a length limit.
#
#   naplo-olvas.sh app <kulcs> [sorok]       the production app's log through the gate's app-log (1..5000 lines, 500 by default)
#   naplo-olvas.sh hosti <projekt> [sorok]   a host executor project's service logs through hosti-naplo (1..1000, 200)
#   naplo-olvas.sh kep <kulcs>               fixed fields of an app's container (no free text: printed as it is)
#   naplo-olvas.sh hosti-kep <projekt>       fixed fields of a project's image and containers (printed as it is)
#
# The filtered log is written to a PRIVATE temporary file (0600, in its own 0700 directory), read by
# scripts/karanten-olvas.sh, and the file is removed when the script ends, on every path (a trap). Nothing of the log is kept.
# Exit: 0 done; 2 the quarantine reader gave nothing; 3 it held a secret shape, nothing came through; 4 the gate refused or did
# not answer; 5 usage. (karanten-olvas.sh's own codes 2 and 3 are passed on as they are.)
# Env: ELES_HOST (default fleet@162.55.216.28) and ELES_KEY, as the other scripts that go through the gate.
set -uo pipefail
# every file this script makes is private to its user: the log lands in a file created by a redirection, and a redirection takes
# the umask, not the mode of the directory (a test measured 0644 in a 0700 directory)
umask 077

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${ELES_HOST:-fleet@162.55.216.28}"
KEY="${ELES_KEY:-/home/marveen/.ssh/id_ed25519_acropora_monitor}"
READER="$BASE/scripts/karanten-olvas.sh"

usage() {
  echo "hasznalat: naplo-olvas.sh app <kulcs> [sorok] | hosti <projekt> [sorok] | kep <kulcs> | hosti-kep <projekt>" >&2
  exit 5
}

# gate <word...>: the B8 gate's op on the production host; the answer on stdout, the gate's exit code returned
gate() {
  timeout 300 ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -- "$HOST" "$@" 2>/dev/null
}

WORK="$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/naplo-olvas.XXXXXX")" || { echo "FAIL: nincs ideiglenes konyvtar" >&2; exit 4; }
trap 'rm -rf "$WORK"' EXIT
FILE="$WORK/naplo.txt"

# the quarantine reader on the file; its exit code and its envelope go through unchanged
read_through_reader() {
  [ -s "$FILE" ] || { echo "FAIL: a kapu ures valaszt adott" >&2; exit 4; }
  bash "$READER" "$FILE"
  exit $?
}

CMD="${1-}"; [ $# -gt 0 ] && shift
case "$CMD" in
  app)
    [ $# -ge 1 ] && [ $# -le 2 ] || usage
    [[ "$1" =~ ^[a-z0-9]{24}$ ]] || { echo "FAIL: a kulcs 24 kisbetus jegy vagy szamjegy" >&2; exit 5; }
    LINES="${2:-500}"
    [[ "$LINES" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$LINES" -le 5000 ] || { echo "FAIL: a sorok szama 1 es 5000 kozotti egesz" >&2; exit 5; }
    gate app-log "$1" "$LINES" > "$FILE" || { echo "FAIL: a kapu elutasitotta vagy nem valaszolt (app-log)" >&2; exit 4; }
    read_through_reader
    ;;
  hosti)
    [ $# -ge 1 ] && [ $# -le 2 ] || usage
    [[ "$1" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "FAIL: a projekt neve [a-z][a-z0-9-]" >&2; exit 5; }
    LINES="${2:-200}"
    [[ "$LINES" =~ ^[1-9][0-9]{0,3}$ ]] && [ "$LINES" -le 1000 ] || { echo "FAIL: a sorok szama 1 es 1000 kozotti egesz" >&2; exit 5; }
    ANSWER="$(gate hosti-naplo "$1" "$LINES")" || { echo "FAIL: a kapu elutasitotta vagy nem valaszolt (hosti-naplo)" >&2; exit 4; }
    # the log is the `naplo` field of the executor's JSON line; it goes to the private file, never to the terminal
    printf '%s' "$ANSWER" | python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
if d.get("ok") is not True or not isinstance(d.get("naplo"), str):
    sys.exit(1)
sys.stdout.write(d["naplo"])' > "$FILE" || { echo "FAIL: a hosti vegrehajto valasza nem naplo" >&2; exit 4; }
    read_through_reader
    ;;
  kep)
    [ $# -eq 1 ] || usage
    [[ "$1" =~ ^[a-z0-9]{24}$ ]] || { echo "FAIL: a kulcs 24 kisbetus jegy vagy szamjegy" >&2; exit 5; }
    gate kep "$1" || { echo "FAIL: a kapu elutasitotta vagy nem valaszolt (kep)" >&2; exit 4; }
    ;;
  hosti-kep)
    [ $# -eq 1 ] || usage
    [[ "$1" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || { echo "FAIL: a projekt neve [a-z][a-z0-9-]" >&2; exit 5; }
    gate hosti-kep "$1" || { echo "FAIL: a kapu elutasitotta vagy nem valaszolt (hosti-kep)" >&2; exit 4; }
    ;;
  *) usage ;;
esac
