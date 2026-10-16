#!/usr/bin/env bash
# agent-to-own-user.sh [--dry-run] <agent>
#
# Move ONE fleet agent onto its own OS user (`agent-<name>`), the way korall was
# moved on 2026-08-19. Idempotent: every step checks first, so a re-run on an
# already-migrated agent changes nothing and still prints the verification.
#
# What it does, in order:
#   1. checks the OS user exists and is in the `fleet` group (it does NOT create users)
#   2. installs the one sudoers line the router needs: marveen -> that user, tmux only
#   3. writes `runAsUser` into agents/<name>/agent-config.json, then READS IT BACK
#      (a failed write here used to let the restart bring the agent back as the old user)
#   4. hands the agent's directory to that user (owner agent-<name>, group fleet,
#      setgid dirs + default ACLs, so the router keeps write access)
#   5. backs up the agent's .claude.json (a wrong start overwrites it with a blank profile)
#   6. restarts the agent through the dashboard API (keeps its context: --continue)
#   7. verifies: the session lives in the new user's own tmux server, and the pane reads
#
# What it deliberately does NOT do: create the user, touch /home/marveen/.claude,
# widen the sudo rule beyond `/usr/bin/tmux`, or migrate more than one agent per run.
#
# Symlink note: the config dir is full of links into /home/marveen/.claude. We use
# `chown -Rh`, which retargets the LINK and never the file it points at -- otherwise
# this would silently hand the router's own shared config to an agent.
#
#   bash /home/marveen/marveen/scripts/agent-to-own-user.sh --dry-run barracuda
#   bash /home/marveen/marveen/scripts/agent-to-own-user.sh barracuda

set -uo pipefail

DRY=0; AGENT=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -*) echo "agent-to-own-user.sh: unknown flag $a" >&2; exit 2 ;;
    *) AGENT="$a" ;;
  esac
done
[[ -z "$AGENT" ]] && { echo "usage: agent-to-own-user.sh [--dry-run] <agent>" >&2; exit 2; }

# Preflight, added 2026-08-24 with the removal of the blanket "marveen ALL=(ALL)
# NOPASSWD:ALL" line (Balazs approved it on Discord at 16:13, on 25 hours of sudo
# log data). This script needs broad root: install into /etc/sudoers.d, chown,
# setfacl. Those are now DENIED, and by design: agent creation stays a manual,
# owner-run operation. Without this check the run would get through the early
# steps and die in the middle of handing over the directory, leaving the agent
# half-migrated -- which is worse than not starting.
if ! sudo -n true 2>/dev/null; then
  cat >&2 <<'MSG'
FAIL: ez a szkript teljes jogu sudo-hozzaferest igenyel, ami 2026-08-24 ota nincs meg.
A helye ettol nem valtozott: uj agens beallitasa a GAZDA kezi muvelete.

A gazda a hostrol, rootkent futtatja:
  cd /opt/marveen-docker && docker compose exec -u root marveen \
    bash -lc 'echo "marveen ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/marveen && chmod 0440 /etc/sudoers.d/marveen && visudo -c'
  cd /opt/marveen-docker && docker compose exec -u marveen marveen \
    bash /home/marveen/marveen/scripts/agent-to-own-user.sh AGENSNEV
  cd /opt/marveen-docker && docker compose exec -u marveen marveen \
    bash /home/marveen/marveen/scripts/fleet-bootstrap.sh

A harmadik parancs teszi vissza a kerítést: a fleet-bootstrap.sh 4b lepese torli
a teljes jogu sort, miutan a szukitett szabalyok a helyukre kerultek.
MSG
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIR="$ROOT/agents/$AGENT"
CFG="$DIR/agent-config.json"
USER_NAME="agent-$AGENT"
SUDOERS="/etc/sudoers.d/fleet-tmux"
DASH="${MARVEEN_DASHBOARD_URL:-http://localhost:3420}"
TOKEN_FILE="$ROOT/store/.dashboard-token"

run() { if (( DRY )); then echo "DRY: $*"; else "$@"; fi }
step() { echo; echo "== $*"; }

[[ -d "$DIR" ]] || { echo "no such agent dir: $DIR" >&2; exit 1; }
[[ -f "$CFG" ]] || { echo "no agent-config.json: $CFG" >&2; exit 1; }

step "1. OS user"
if ! getent passwd "$USER_NAME" >/dev/null; then
  echo "FAIL: OS user $USER_NAME does not exist. Create it first (this script will not)." >&2
  exit 1
fi
if ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx fleet; then
  echo "FAIL: $USER_NAME is not in the 'fleet' group -- the router could not write its files." >&2
  exit 1
fi
echo "ok: $USER_NAME exists, groups: $(id -nG "$USER_NAME")"

step "2. sudoers rule (tmux only)"
RULE="marveen ALL=($USER_NAME) NOPASSWD: /usr/bin/tmux"
if test -f /etc/fleet-pane/conf/no-tmux-line; then
  # B48 (2): the owner retired the tmux line. The router reaches this agent through fleet-pane
  # only when the agent is in the root agents list, which is the owner's file on the host
  # (docs/fleet-pane.md, "Adding an agent"), not something this script may write.
  echo "skip: the tmux line is retired (/etc/fleet-pane/conf/no-tmux-line)."
  echo "      $AGENT must be in /etc/fleet-pane/conf/agents.json (the owner's host file) before step 6."
elif sudo -n grep -qF "($USER_NAME) NOPASSWD: /usr/bin/tmux" "$SUDOERS" 2>/dev/null; then
  echo "ok: already present"
else
  if (( DRY )); then
    echo "DRY: append to $SUDOERS -> $RULE"
  else
    tmp="$(mktemp)"
    sudo -n cat "$SUDOERS" > "$tmp" 2>/dev/null || true
    echo "$RULE" >> "$tmp"
    # Never install a sudoers file that does not parse: that can lock sudo out.
    if ! sudo -n visudo -c -f "$tmp" >/dev/null; then
      echo "FAIL: the new sudoers content does not parse; nothing installed." >&2
      rm -f "$tmp"; exit 1
    fi
    sudo -n install -m 0440 -o root -g root "$tmp" "$SUDOERS"
    rm -f "$tmp"
    echo "installed: $RULE"
  fi
fi

step "3. runAsUser in agent-config.json"
CUR_RUN_AS="$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('runAsUser') or '')
except Exception: print('')
" "$CFG")"
if [[ "$CUR_RUN_AS" == "$USER_NAME" ]]; then
  echo "ok: runAsUser already $USER_NAME"
elif (( DRY )); then
  echo "DRY: set runAsUser=$USER_NAME in $CFG"
else
  # Written via sudo ON PURPOSE. Measured 2026-08-20 07:29: this shell's process
  # carries only gid marveen -- group membership is granted at process start, and
  # the router/session predates the `fleet` grant -- so a plain write into an
  # already-chowned agent dir fails with EACCES even though the file is g+rw.
  sudo -n python3 - "$CFG" "$USER_NAME" <<'PY'
import json, sys
path, user = sys.argv[1], sys.argv[2]
with open(path) as fh:
    cfg = json.load(fh)
cfg["runAsUser"] = user
with open(path, "w") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
PY
  if [[ $? -ne 0 ]]; then
    echo "FAIL: could not write runAsUser into $CFG -- stopping BEFORE the restart." >&2
    echo "      (Restarting without it would bring the agent back as the old user.)" >&2
    exit 1
  fi
  sudo -n chown "$USER_NAME:fleet" "$CFG"
  sudo -n chmod 0664 "$CFG"
  echo "set: runAsUser=$USER_NAME"
fi
# Read it back from the file, not from what we believe we wrote.
VERIFY_RUN_AS="$(python3 -c "
import json,sys
try: print(json.load(open(sys.argv[1])).get('runAsUser') or '')
except Exception: print('')
" "$CFG")"
if (( ! DRY )) && [[ "$VERIFY_RUN_AS" != "$USER_NAME" ]]; then
  echo "FAIL: agent-config.json still says runAsUser='$VERIFY_RUN_AS'. Not restarting." >&2
  exit 1
fi

step "4. directory ownership (owner $USER_NAME, group fleet; the group READS, the router WRITES)"
CUR_OWNER="$(stat -c %U "$DIR")"
if [[ "$CUR_OWNER" == "$USER_NAME" ]]; then
  echo "ok: already owned by $USER_NAME"
else
  echo "current owner: $CUR_OWNER"
  run sudo -n chown -Rh "$USER_NAME:fleet" "$DIR"
  run sudo -n find "$DIR" -type d -exec chmod 2775 {} +
  # B45 (2026-10-13): `fleet` is the PRIMARY group of every agent, so a group write
  # here is a write for all six agents into this one's CLAUDE.md, settings.json,
  # skills and agent-config.json. The group only READS; the router (marveen), which
  # provisions into the dir on every start, gets its write through a NAMED entry,
  # and the default ACL carries both to new files.
  # Only entries the group can already read get an ACL: a 0600 file (.claude.json,
  # .credentials.json) or a mask::--- entry stays closed. A `g::rX` on those would
  # OPEN group read, so `-perm -g=r` is the filter, not a name list.
  run sudo -n find "$DIR" ! -type l \( -type d -o -perm -g=r \) -exec setfacl -m "u:marveen:rwX,g::rX,g:fleet:rX" {} +
  run sudo -n setfacl -R -d -m "u:marveen:rwX,u:$USER_NAME:rwX,g::rX,g:fleet:rX" "$DIR"
fi

step "5. back up the agent's Claude profile"
# Measured on barracuda, 2026-08-20 07:30: a start that lands wrong (agent cannot
# read its own .claude.json) makes Claude Code write a BRAND NEW profile over it.
# The old one -- 37 KB of accumulated consents -- is then gone. One copy first.
DOTC="$DIR/.claude-config/.claude.json"
if [[ -f "$DOTC" ]]; then
  BAK="$DOTC.bak-$(date +%Y%m%d-%H%M%S)"
  run sudo -n cp -p "$DOTC" "$BAK"
  echo "backup: $BAK"
else
  echo "note: no .claude.json yet (the router will seed one)"
fi

step "6. restart the agent (keeps context, --continue)"
if (( DRY )); then
  echo "DRY: POST $DASH/api/agents/$AGENT/stop then /start"
else
  TOKEN="$(cat "$TOKEN_FILE")"
  # The API stop happens AFTER runAsUser is set, so the router already looks for the
  # session in the NEW user's tmux -- and answers "Agent is not running" while the
  # real, pre-migration session is still alive in the router's own tmux. Left there,
  # it becomes a second pane with the same name (measured on polip, 2026-08-20 07:39,
  # and on barracuda before it). Kill the old-side session by hand first.
  if tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -qx "agent-$AGENT"; then
    echo "stopping the pre-migration session in the router's own tmux"
    tmux kill-session -t "agent-$AGENT" 2>/dev/null || true
  fi
  curl -s -X POST -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$DASH/api/agents/$AGENT/stop"; echo
  sleep 3
  curl -s -X POST -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$DASH/api/agents/$AGENT/start"; echo
  sleep 8
fi

step "7. verify"
if (( DRY )); then
  echo "DRY: would check process owner and pane readability"
  exit 0
fi
# The definitive check is WHICH TMUX SERVER holds the session, not a ps line: a
# `tmux new-session` client exits once the server is up, so grepping for it finds
# an agent only by accident (measured 2026-08-20 07:29 -- it found korall and
# nobody else). A session listed by the target user's own tmux server can only
# have been created by that user.
if python3 -I "$HERE/lib/fleet_pane_switch.py" "$ROOT" >/dev/null 2>&1; then
  # The router's road (B48 (2)): the broker answers for the agent user's own tmux server only.
  IN_OWN="$(sudo -n /usr/local/sbin/fleet-pane status "$AGENT" 2>/dev/null | grep -cx "agent-$AGENT")"
else
  IN_OWN="$(sudo -n -u "$USER_NAME" tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -cx "agent-$AGENT")"
fi
IN_ROUTER="$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -cx "agent-$AGENT")"
echo "session in $USER_NAME's tmux: $IN_OWN | still in the router's tmux: $IN_ROUTER"
bash "$HERE/agent-pane.sh" --prompts "$AGENT"
PANE_RC=$?
if [[ "$IN_OWN" == "1" && "$IN_ROUTER" == "0" && $PANE_RC -eq 0 ]]; then
  echo "OK: $AGENT runs as $USER_NAME and its pane is readable."
else
  echo "CHECK FAILED: own=$IN_OWN router=$IN_ROUTER pane rc=$PANE_RC." >&2
  exit 1
fi
