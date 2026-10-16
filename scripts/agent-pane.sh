#!/usr/bin/env bash
# ANSWERS: Mit csinal EPPEN egy flotta-agens: a tmux panelje, a helyes helyrol olvasva. A 'running' allapot nem ez.
# agent-pane.sh [--prompts] <agent> | [--prompts] --all
#
# Capture a fleet agent's tmux pane FROM THE RIGHT PLACE, and fail loudly when
# it cannot be captured.
#
# Why this exists (measured 2026-08-20 02:14, night approval round):
# the night procedure ran `tmux capture-pane -p -t agent-$a | grep -c 'Do you
# want to'` as marveen for all four agents. korall had been migrated to its own
# OS user (agents/korall/agent-config.json -> runAsUser) hours earlier, so its
# tmux server belongs to agent-korall, not to marveen. The capture failed, the
# pipeline still printed `0`, and the round read as "no permission prompt
# anywhere" while korall's pane had never been looked at. A zero from a failed
# capture is indistinguishable from a zero from a clean pane -- unless the tool
# refuses to print it. This one exits non-zero instead.
#
# The router already resolves runAsUser (src/web/agent-process.ts,
# agentTmuxTarget); this is the same rule for shell callers, read from the same
# file, so the two cannot drift apart by being written twice.
#
#   bash /home/marveen/marveen/scripts/agent-pane.sh korall            # print the pane
#   bash /home/marveen/marveen/scripts/agent-pane.sh --prompts --all   # per-agent prompt count
#
# --prompts prints one line per agent: `<name>: <n> prompt` or `<name>: UNREACHABLE (reason)`.
# Exit code is 0 only if EVERY agent asked for was actually reached.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$HERE/.." && pwd)"
# Overridable so the prompt counter can be exercised against a throwaway
# session: a counter that has only ever returned 0 is not a verified counter.
AGENTS_DIR="${AGENT_PANE_AGENTS_DIR:-$INSTALL_DIR/agents}"
TMUX_BIN="${TMUX_BIN:-/usr/bin/tmux}"
# The fleet-pane switch, read the router's way (scripts/lib/fleet_pane_switch.py).
BROKER=0
python3 -I "$HERE/lib/fleet_pane_switch.py" "$INSTALL_DIR" >/dev/null 2>&1 && BROKER=1

MODE="pane"
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --prompts) MODE="prompts" ;;
    --all)     TARGETS=(ALL) ;;
    -*)        echo "agent-pane.sh: unknown flag $arg" >&2; exit 2 ;;
    *)         TARGETS+=("$arg") ;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "usage: agent-pane.sh [--prompts] <agent> | [--prompts] --all" >&2
  exit 2
fi

if [[ "${TARGETS[0]}" == "ALL" ]]; then
  TARGETS=()
  for d in "$AGENTS_DIR"/*/; do
    [[ -d "$d" ]] || continue
    TARGETS+=("$(basename "$d")")
  done
fi

# runAsUser for one agent, empty if it runs as us. Mirrors resolveRunAsUser():
# the value must be a plain user name, anything else is treated as absent.
run_as_user() {
  local name="$1"
  python3 - "$AGENTS_DIR/$name/agent-config.json" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1]) as fh:
        cfg = json.load(fh)
except Exception:
    sys.exit(0)
u = cfg.get("runAsUser") if isinstance(cfg, dict) else None
if isinstance(u, str):
    u = u.strip()
    if u and re.fullmatch(r"[A-Za-z0-9._-]+", u):
        print(u)
PY
}

remote_host() {
  local name="$1"
  python3 - "$AGENTS_DIR/$name/agent-config.json" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as fh:
        cfg = json.load(fh)
except Exception:
    sys.exit(0)
r = cfg.get("remote") if isinstance(cfg, dict) else None
if isinstance(r, dict) and isinstance(r.get("host"), str) and r["host"].strip():
    print(r["host"].strip())
PY
}

# Capture one pane. Prints the pane on stdout, the reason on stderr, and
# returns non-zero when the pane could not be read for ANY reason.
capture_one() {
  local name="$1" session="agent-$1"
  local host user
  host="$(remote_host "$name")"
  if [[ -n "$host" ]]; then
    echo "runs on remote host $host -- not readable from here" >&2
    return 3
  fi
  user="$(run_as_user "$name")"
  if [[ -n "$user" ]] && (( BROKER )); then
    # The router's road (B48 (2), docs/fleet-pane.md): with the switch on, the old tmux line may
    # already be gone, so the pane is read through the broker's capture verb.
    sudo -n /usr/local/sbin/fleet-pane capture "$name"
  elif [[ -n "$user" ]]; then
    sudo -n -u "$user" "$TMUX_BIN" capture-pane -p -t "$session"
  else
    "$TMUX_BIN" capture-pane -p -t "$session"
  fi
}

rc=0
for name in "${TARGETS[@]}"; do
  out="$(capture_one "$name" 2>/tmp/agent-pane.$$.err)"
  cap_rc=$?
  err="$(tr '\n' ' ' </tmp/agent-pane.$$.err)"
  rm -f /tmp/agent-pane.$$.err
  if [[ $cap_rc -ne 0 ]]; then
    if [[ "$MODE" == "prompts" ]]; then
      echo "$name: UNREACHABLE (${err:-tmux exit $cap_rc})"
    else
      echo "agent-pane.sh: $name UNREACHABLE (${err:-tmux exit $cap_rc})" >&2
    fi
    rc=1
    continue
  fi
  if [[ "$MODE" == "prompts" ]]; then
    # Count the DIALOG, not one line of it. Measured 2026-08-22 01:35: murena
    # sat on a permission prompt whose command block (an inline commit message)
    # was long enough to push the "Do you want to proceed?" line off the top of
    # the captured pane. The old pattern printed 0 while the dialog was plainly
    # on screen, and the round read as "no prompt anywhere" -- the same failure
    # this script was written to stop, arriving through a different door.
    # The footer is the reliable anchor: it is the LAST thing the dialog draws,
    # so it survives exactly the case that scrolls the question away.
    #
    # Counted SEPARATELY and combined with max, not with one alternation
    # pattern: a dialog that shows both lines would otherwise count as two
    # prompts, and "2 prompt" for one dialog is a different lie than the one
    # being fixed. Measured against a live pane the same night.
    n_question="$(printf '%s\n' "$out" | grep -cE 'Do you want to')"
    n_footer="$(printf '%s\n' "$out" | grep -cE 'Esc to cancel')"
    n=$(( n_question > n_footer ? n_question : n_footer ))
    echo "$name: $n prompt"
  else
    printf '===== %s =====\n%s\n' "$name" "$out"
  fi
done

exit $rc
