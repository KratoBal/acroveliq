#!/usr/bin/env bash
# fleet-bootstrap.sh [--dry-run]
#
# Rebuild the parts of the fleet that live in the CONTAINER filesystem and are
# therefore lost on `docker compose up -d` (a volume change recreates the
# container from the image; `restart` does not).
#
# Measured 2026-08-22 08:52, when the acropora-commerce-stage mount was added:
# /etc/passwd went back to the image baseline, so the four agent users, the
# `fleet` group and /etc/sudoers.d/fleet-tmux were gone, and all four per-user
# agents failed to start with nothing but "Failed to start tmux session".
# Everything under /home/marveen survived (bind mount from the host), including
# file ownership -- which is why the users MUST come back at their original uids:
# then not a single chown is needed and the ACLs still match.
#
# Idempotent: every step checks first. Safe to run on a healthy container.
# It does NOT start agents (the dashboard's desired-state monitor does that, or
# scripts/agent-to-own-user.sh <agent> per agent).
#
#   bash /home/marveen/marveen/scripts/fleet-bootstrap.sh --dry-run
#   bash /home/marveen/marveen/scripts/fleet-bootstrap.sh
#
# --auto-restart-dashboard is for the boot path only (scripts/ensure-native-modules.sh,
# which run-dashboard.sh calls before the service starts). See step 6.

set -uo pipefail

DRY=0
AUTO_RESTART=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --auto-restart-dashboard) AUTO_RESTART=1 ;;
    *) echo "fleet-bootstrap.sh: unknown flag $a" >&2; exit 2 ;;
  esac
done

# Repo root derived from this script's location, so the checks work whatever the
# caller's cwd is (the boot hook runs from run-dashboard.sh, not from a shell).
# THE PROJECT ROOT IS EXPLICIT, NOT DERIVED FROM THIS FILE'S LOCATION (Balazs, 2026-10-12).
# The reviewed copy runs as root from /usr/local/sbin, so "my directory/.." would point at
# /usr/local. FLEET_ROOT overrides the default; either way it is checked before use.
ROOT="${FLEET_ROOT:-/home/marveen/marveen}"
if [[ ! -d "$ROOT/scripts" || ! -d "$ROOT/store" ]]; then
  echo "FAIL: project root $ROOT has no scripts/ or store/ (set FLEET_ROOT)" >&2; exit 2
fi
AS_ROOT=0; (( EUID == 0 )) && AS_ROOT=1

FLEET_GID=1001
# uid:agent -- the uids are not cosmetic, the files on the bind mount carry them.
AGENTS="1001:korall 1002:polip 1003:barracuda 1004:murena 1005:nautilus 1006:picasso"
# gid:group -- one group per secret, exactly the gids the store/ files carry
# (`ls -l store/` shows them as bare numbers once the groups are gone). The files
# are 0640 marveen:sec-*, so a missing group does not deny loudly: the agent user
# simply falls through to "other" and reads nothing. Measured 2026-08-22: after the
# recreate murena's session came up with an EMPTY CLAUDE_CODE_OAUTH_TOKEN (the
# launcher cats the token file at start) and every turn died with "Not logged in".
SEC_GROUPS="1007:sec-dashboard 1008:sec-github 1009:sec-fb 1010:sec-unas 1011:sec-google 1012:sec-expo 1013:sec-vault 1014:sec-claude-oauth 1015:logs-acropora"
# logs-acropora (2026-10-12, Balazs jovahagyasaval): a strukturalt parancsfuttato (scripts/futtat.py)
# teljes naploi (logs/acropora/) es a titok-lenyomat lista (store/secret-hashes.txt). Csak a futtatot
# hasznalo fejlesztok es a reviewer olvassak; NEM a fleet csoport, mert abban mind a hat agens benne van.
# agent -> the secret groups Balázs approved for it (2026-08-19 + 2026-08-21).
# Every agent needs the dashboard token and the OAuth token; the rest is per role.
SEC_MEMBERS_korall="sec-dashboard sec-claude-oauth"
SEC_MEMBERS_polip="sec-dashboard sec-claude-oauth sec-unas"
SEC_MEMBERS_barracuda="sec-dashboard sec-claude-oauth sec-fb sec-unas logs-acropora"
SEC_MEMBERS_murena="sec-dashboard sec-claude-oauth sec-github sec-expo logs-acropora"
# nautilus, felvéve 2026-08-24: a lista négy ágenssel készült, ő 08-23-án jött, és
# a bootstrap ezért egy konténer-újrateremtés után NEM hozta volna vissza a felhasználóját.
SEC_MEMBERS_nautilus="sec-dashboard sec-claude-oauth sec-github logs-acropora"
# picasso, felveve 2026-08-30: tervezo agens. Csak a ket alap titok kell neki
# (dashboard token es OAuth). Se GitHub, se FB, se UNAS, se Google: HTML-t es
# CSS-t ir a sajat mappajaban, es a sajat munkajarol keszit kepernyokepet.
SEC_MEMBERS_picasso="sec-dashboard sec-claude-oauth"
ROUTER_USER=marveen
SUDOERS=/etc/sudoers.d/fleet-tmux
DEVDB=/etc/sudoers.d/fleet-devdb
# The blanket "marveen ALL=(ALL) NOPASSWD:ALL" line. Baked into the image, so a
# container recreate brings it back; steps 4 and 4b key off its presence, because
# once it is gone this script can no longer write to /etc/sudoers.d at all.
BLANKET=/etc/sudoers.d/marveen
# Dry runs only (the tests): a stand-in blanket file, so step 4 shows the rules it would build.
if (( DRY )) && [[ -n "${FLEET_BLANKET_DRYRUN:-}" ]]; then BLANKET="$FLEET_BLANKET_DRYRUN"; fi
# B48 (2), the fleet-pane broker (docs/fleet-pane.md). Its root files come from the owner's host
# directory, mounted read-only here; `no-tmux-line` in it is the owner's decision that the old
# `marveen ALL=(agent-*) NOPASSWD: /usr/bin/tmux` line is retired. The marker lives in the mount
# so a recreate keeps the decision and `marveen` cannot take it back.
FP_CONF=/etc/fleet-pane/conf
# Only a dry run may look at another directory (the tests); a real run always checks the mount.
if (( DRY )) && [[ -n "${FLEET_PANE_CONF_DRYRUN:-}" ]]; then FP_CONF="$FLEET_PANE_CONF_DRYRUN"; fi
fp_mounted() {
  if (( DRY )) && [[ -n "${FLEET_PANE_CONF_DRYRUN:-}" ]]; then test -d "$FP_CONF"; else mountpoint -q -- "$FP_CONF"; fi
}
TMUX_RETIRED=0
if fp_mounted && test -f "$FP_CONF/no-tmux-line"; then TMUX_RETIRED=1; fi

run() { if (( DRY )); then echo "DRY: $*"; else "$@"; fi }
step() { echo; echo "== $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step "1. fleet group (gid $FLEET_GID)"
if getent group fleet >/dev/null; then
  echo "ok: $(getent group fleet)"
else
  run sudo -n groupadd -g "$FLEET_GID" fleet || fail "could not create the fleet group"
  echo "created: fleet (gid $FLEET_GID)"
fi

step "2. agent users"
for pair in $AGENTS; do
  uid="${pair%%:*}"; agent="${pair##*:}"; user="agent-$agent"
  if getent passwd "$user" >/dev/null; then
    have_uid="$(id -u "$user")"
    [[ "$have_uid" == "$uid" ]] || fail "$user exists with uid $have_uid, expected $uid (its files on the mount are owned by $uid)"
    echo "ok: $user (uid $uid)"
  else
    run sudo -n useradd -u "$uid" -g fleet -m -d "/home/$user" -s /bin/bash "$user" \
      || fail "could not create $user"
    echo "created: $user (uid $uid)"
  fi
done

step "2b. secret groups and memberships"
for pair in $SEC_GROUPS; do
  gid="${pair%%:*}"; grp="${pair##*:}"
  if getent group "$grp" >/dev/null; then
    have="$(getent group "$grp" | cut -d: -f3)"
    [[ "$have" == "$gid" ]] || fail "$grp exists with gid $have, expected $gid (store/ files carry $gid)"
    echo "ok: $grp (gid $gid)"
  else
    run sudo -n groupadd -g "$gid" "$grp" || fail "could not create $grp"
    echo "created: $grp (gid $gid)"
  fi
done
for pair in $AGENTS; do
  agent="${pair##*:}"; user="agent-$agent"
  eval "want=\${SEC_MEMBERS_$agent:-}"
  for grp in $want; do
    if id -nG "$user" | tr ' ' '\n' | grep -qx "$grp"; then
      echo "ok: $user in $grp"
    else
      run sudo -n usermod -aG "$grp" "$user" || fail "could not add $user to $grp"
      echo "added: $user -> $grp"
    fi
  done
done

step "2c. the futtat log tree and the secret-hash list (logs-acropora, 2770 / 0640)"
# Created HERE, not by the first run: a directory the first run creates carries that user's
# umask and group, and an agent under another uid then cannot open a task folder under it
# (barracuda, marveen #17 review). setgid (2770) keeps every new task folder in the group.
LOGROOT="$ROOT/logs"
# THESE PATHS ARE OWNED BY THE ROUTER USER, SO AS ROOT THEY ARE TOUCHED AS THE ROUTER USER
# (barracuda, #24 v3 review). install/chgrp/chmod follow a symlink: if marveen swaps logs/
# for a link to /etc/sudoers.d, a root chmod 2770 lands there. runuser drops to marveen
# (with a fresh group list, so the logs-acropora membership added just above counts), and a
# link is refused outright, before anything touches its target.
# Not as root (the old path), sudo -n here only exists while the blanket rule does, and then
# marveen is root-equivalent anyway: nothing to escalate to.
as_owner() { if (( AS_ROOT )); then run runuser -u "$ROUTER_USER" -- "$@"; else run sudo -n "$@"; fi }
no_link() { [[ -L "$1" ]] && fail "$1 is a symlink (-> $(readlink "$1")); refusing to change it or its target"; return 0; }
if id -nG "$ROUTER_USER" | tr ' ' '\n' | grep -qx logs-acropora; then echo "ok: $ROUTER_USER in logs-acropora"
else run sudo -n usermod -aG logs-acropora "$ROUTER_USER" || fail "could not add $ROUTER_USER to logs-acropora"; echo "added: $ROUTER_USER -> logs-acropora"; fi
for d in "$LOGROOT" "$LOGROOT/acropora"; do
  no_link "$d"
  if [[ -d "$d" ]] && [[ "$(stat -c '%G %a' "$d")" == "logs-acropora 2770" ]]; then
    echo "ok: $d"
  else
    as_owner install -d -g logs-acropora -m 2770 "$d" || fail "could not create $d"
    as_owner chgrp logs-acropora "$d" || fail "could not chgrp $d"
    as_owner chmod 2770 "$d" || fail "could not chmod $d"
    echo "set: $d (logs-acropora 2770)"
  fi
done
HASHES="$ROOT/store/secret-hashes.txt"
no_link "$HASHES"
if [[ -f "$HASHES" ]]; then
  if [[ "$(stat -c '%G %a' "$HASHES")" == "logs-acropora 640" ]]; then echo "ok: $HASHES"
  else
    as_owner chgrp logs-acropora "$HASHES" || fail "could not chgrp $HASHES"
    as_owner chmod 0640 "$HASHES" || fail "could not chmod $HASHES"
    echo "set: $HASHES (logs-acropora 0640)"
  fi
else
  echo "note: $HASHES does not exist yet (futtat.sh lenyomat-hozzaad creates it; rerun this step after)"
fi

step "3. the router is in the fleet group"
# Needed so the dashboard can write into the agent directories (owner agent-*,
# group fleet, setgid). A process gets its groups AT START, so a plain usermod
# does not reach the already-running dashboard -- hence the restart below.
GROUP_GRANTED=0
if id -nG "$ROUTER_USER" | tr ' ' '\n' | grep -qx fleet; then
  echo "ok: $ROUTER_USER is in fleet"
else
  run sudo -n usermod -aG fleet "$ROUTER_USER" || fail "could not add $ROUTER_USER to fleet"
  GROUP_GRANTED=1
  echo "added: $ROUTER_USER -> fleet (the dashboard needs a restart to pick it up)"
fi

step "4. the narrow sudo rule (tmux only, one line per agent)"
# Only rebuildable while the blanket line is still there: writing a sudoers file
# needs root, and after the removal the only root-side powers left are the narrow
# ones. Measured 2026-08-24 by re-running this script right after the removal: the
# opening `sudo cat` came back empty, every rule was re-queued as if missing, and
# visudo could not validate the result. Nothing was installed, but the script
# exited FAIL on a perfectly healthy container.
# AS ROOT (the reviewed copy in the image, Balazs 2026-10-12) the narrow rules are built
# from scratch every time, independent of the blanket line, validated, and installed only
# if they differ. Without root and without the blanket line nothing can be written: then
# this step only reports, and step 7 checks the rules by capability.
if (( ! AS_ROOT )) && ! test -f "$BLANKET"; then
  echo "ok: not root and no blanket line: nothing can be written from here"
  echo "    (run the reviewed root copy to rebuild). Step 7 checks the rules by capability."
else
tmp="$(mktemp)"
if (( ! AS_ROOT )); then sudo -n cat "$SUDOERS" > "$tmp" 2>/dev/null || true; fi
changed=0
# Retired (the owner's no-tmux-line, see FP_CONF): the tmux line is not generated, and a copy read
# back from the old file loses it. As root the file is built from scratch, so it simply is not there.
if (( TMUX_RETIRED )); then
  echo "retired: the tmux line ($FP_CONF/no-tmux-line); the router reaches the agents through fleet-pane"
  if grep -qF "NOPASSWD: /usr/bin/tmux" "$tmp" 2>/dev/null; then
    grep -vF "NOPASSWD: /usr/bin/tmux" "$tmp" > "$tmp.keep" || true
    mv -f -- "$tmp.keep" "$tmp"; changed=1
    echo "queued: removal of the tmux lines"
  fi
fi
for pair in $AGENTS; do
  agent="${pair##*:}"; user="agent-$agent"
  rule="$ROUTER_USER ALL=($user) NOPASSWD: /usr/bin/tmux"
  if (( TMUX_RETIRED )); then
    :
  elif grep -qF "($user) NOPASSWD: /usr/bin/tmux" "$tmp" 2>/dev/null; then
    echo "ok: rule present for $user"
  else
    echo "$rule" >> "$tmp"; changed=1
    echo "queued: $rule"
  fi
  # Second rule, added 2026-08-24 with the removal of the blanket NOPASSWD:ALL
  # line. The verify section below asks "can this user READ the OAuth token",
  # which is the check that actually predicts a start; it ran on the blanket
  # line, so without a rule of its own it would have quietly stopped working.
  # Bound to one file and read-only: `test` prints nothing and changes nothing.
  trule="$ROUTER_USER ALL=($user) NOPASSWD: /usr/bin/test -r $ROOT/store/.claude-oauth-token"
  if grep -qF "($user) NOPASSWD: /usr/bin/test -r $ROOT/store/.claude-oauth-token" "$tmp" 2>/dev/null; then
    echo "ok: token-read check rule present for $user"
  else
    echo "$trule" >> "$tmp"; changed=1
    echo "queued: token-read check rule for $user"
  fi
  # Third rule, added 2026-08-28 with Balazs's approval on Discord. The agents
  # cannot read the channel allowlist (it lives under /home/marveen/.claude), so
  # when an unknown sender writes to one of them, the only way to settle whether
  # that sender is paired used to be asking the main agent. On 2026-08-28 the main
  # agent was the one that was down, so that chain was exactly what was missing.
  # is-paired.sh answers ONE question with PAROSITOTT or NEM PAROSITOTT, never
  # prints the list, never extends it, and logs who asked about what.
  # FIGYELEM, AZ IRANY ITT FORDITOTT a fenti ket szabalyhoz kepest, es ez szandekos:
  # ott marveen fut AZ AGENSKENT (tmux, token-olvasas), itt viszont AZ AGENS fut
  # MARVEENKENT, mert az allowlistat marveen olvashatja, nem az agens. Egy masolassal
  # atvett irany szintaktikailag helyes szabalyt ad, ami sosem sul el.
  prule="$user ALL=($ROUTER_USER) NOPASSWD: $ROOT/scripts/is-paired.sh"
  if grep -qF "$user ALL=($ROUTER_USER) NOPASSWD: $ROOT/scripts/is-paired.sh" "$tmp" 2>/dev/null; then
    echo "ok: is-paired rule present for $user"
  else
    echo "$prule" >> "$tmp"; changed=1
    echo "queued: is-paired rule for $user"
  fi
done
if (( AS_ROOT )) && test -f "$SUDOERS" && cmp -s "$tmp" "$SUDOERS"; then changed=0; echo "ok: $SUDOERS is exactly the generated content"; fi
if (( changed )); then
  if (( DRY )); then
    echo "DRY: install $SUDOERS with the queued rules"
  else
    # Never install a sudoers file that does not parse: that can lock sudo out.
    sudo -n visudo -c -f "$tmp" >/dev/null || { rm -f "$tmp"; fail "the new sudoers content does not parse; nothing installed"; }
    sudo -n install -m 0440 -o root -g root "$tmp" "$SUDOERS" || { rm -f "$tmp"; fail "could not install $SUDOERS"; }
    echo "installed: $SUDOERS"
  fi
fi
rm -f "$tmp"
fi

step "4a. the D4 GitHub broker: its two root scripts and their sudo rule (docs/fleet-github.md)"
# A CONTAINER RECREATE TAKES THESE WITH IT (acrobot 31595, the D4 step list E2): /usr/local/sbin and
# /etc/sudoers.d come back from the image, so without this step every recreate stops all fleet
# writes on GitHub until a human reinstalls steps 7 and 8. The key, the approver token and
# app.json are NOT handled here: they live on the host and come in read-only as /etc/fleet-github
# (the bind mount, step 6b), so they survive by themselves.
#
# ONLY WHERE D4 IS DEPLOYED. The mount (mountpoint -q, not a mere directory) is the sign that
# the owner did step 6b; without it this step installs nothing, because a sudo rule installed
# on its own would be a permission change nobody asked for.
#
# THE PINNED HASHES ARE THE REVIEWED VERSIONS (main a0e9fb4; fleet-approve.py: the E3 (a) root record). The source is the router's tree,
# so a pin here does not stop the router itself (at boot it holds the blanket line anyway); it
# stops an unreviewed or half-updated tree from becoming root code. scripts/__tests__/
# fleet-bootstrap-d4.test.py fails while a pin differs from the file, so a change to either
# script carries its new pin in the same PR.
#
# NEVER `fail` HERE: step 4b below removes the blanket line, and an exit before it would leave
# the whole fence open, which is worse than a missing broker. Problems are counted (D4_RC) and
# step 7 reports them.
D4_MOUNT=/etc/fleet-github
# Only a dry run may look at another directory (the tests); a real run always checks the mount.
if (( DRY )) && [[ -n "${FLEET_D4_MOUNT_DRYRUN:-}" ]]; then D4_MOUNT="$FLEET_D4_MOUNT_DRYRUN"; fi
D4_SUDOERS=/etc/sudoers.d/fleet-github
D4_SBIN=/usr/local/sbin
# source-in-scripts/root:installed-name:sha256
D4_SCRIPTS="fleet-github.py:fleet-github:9c1e090aea5401d649f5174bfc93759459d62a435fa5e28eb525f1955857457e
fleet-approve.py:fleet-approve:3566a92d136ba219fe45ae31b677e4e3915f97fa27e9a4a38eeb48f76e8fbcac"
D4_RC=0
D4_DEPLOYED=0
as_root() { if (( AS_ROOT )); then run "$@"; else run sudo -n "$@"; fi }
d4_sudoers_content() {
  echo "# The D4 GitHub broker and the guarded approver (docs/fleet-github.md, step 8). Written by fleet-bootstrap.sh 4a."
  echo "$ROUTER_USER ALL=(root) NOPASSWD: $D4_SBIN/fleet-github token *"
  echo "agent-nautilus ALL=(root) NOPASSWD: $D4_SBIN/fleet-github token *"
  echo "agent-murena ALL=(root) NOPASSWD: $D4_SBIN/fleet-github token *"
  echo "agent-barracuda ALL=(root) NOPASSWD: $D4_SBIN/fleet-approve approve *"
  # the verdict's root record (the D4 step list E3 (a)): review-ellenoriz.sh calls it, as barracuda
  echo "agent-barracuda ALL=(root) NOPASSWD: $D4_SBIN/fleet-approve record *"
  # read, and only read, on the one private customer repo: the reviewer's own head diff (review-fej-diff.py;
  # Balázs 2026-10-19 10:49 UTC, Eldöntendő msg 1561692771733999658). Exact arguments, no wildcard.
  echo "agent-barracuda ALL=(root) NOPASSWD: $D4_SBIN/fleet-github token KratoBal/caparium-napplo olvas"
}
d4_tmpdir="$(mktemp -d)"
d4_src_ok=1
# The source is copied FIRST and the copy is hashed and installed: checking the file and then
# installing it by name would leave a window in which it could change.
while IFS=: read -r src dst want; do
  [[ -n "$src" ]] || continue
  path="$ROOT/scripts/root/$src"
  if [[ -L "$path" ]]; then
    echo "REFUSED: $path is a symlink; not reading or installing it" >&2; d4_src_ok=0; continue
  fi
  if ! cat -- "$path" > "$d4_tmpdir/$dst" 2>/dev/null; then
    echo "MISSING: $path (the live tree is not on the main branch?)" >&2; d4_src_ok=0; continue
  fi
  got="$(sha256sum < "$d4_tmpdir/$dst" | cut -d' ' -f1)"
  if [[ "$got" == "$want" ]]; then
    echo "ok: scripts/root/$src is the pinned version"
  else
    echo "MISMATCH: scripts/root/$src sha256 $got, pinned $want: not installing it" >&2; d4_src_ok=0
  fi
done <<< "$D4_SCRIPTS"
# A real run asks whether it is a MOUNT, not a directory (barracuda, #205): a directory made by
# hand inside the container, or left from an older in-container layout, is not the owner's step 6b.
d4_mounted() {
  if (( DRY )) && [[ -n "${FLEET_D4_MOUNT_DRYRUN:-}" ]]; then test -d "$D4_MOUNT"; else mountpoint -q -- "$D4_MOUNT"; fi
}
if ! d4_mounted; then
  echo "skip: $D4_MOUNT is not mounted, D4 is not deployed here: nothing installed"
elif (( ! d4_src_ok )); then
  D4_DEPLOYED=1; D4_RC=1
  echo "NOT INSTALLED: D4 is deployed ($D4_MOUNT is there), but a source above is not the pinned version" >&2
elif (( ! DRY && ! AS_ROOT )) && ! test -f "$BLANKET"; then
  D4_DEPLOYED=1
  echo "ok: not root and no blanket line: nothing can be written from here; step 7 checks the installed copies"
else
  D4_DEPLOYED=1
  while IFS=: read -r src dst want; do
    [[ -n "$src" ]] || continue
    have="$(sha256sum < "$D4_SBIN/$dst" 2>/dev/null | cut -d' ' -f1)"
    if [[ "$have" == "$want" ]]; then echo "ok: $D4_SBIN/$dst is the pinned version"; continue; fi
    if as_root install -o root -g root -m 0755 "$d4_tmpdir/$dst" "$D4_SBIN/$dst"; then
      echo "installed: $D4_SBIN/$dst"
    else
      echo "FAILED: could not install $D4_SBIN/$dst" >&2; D4_RC=1
    fi
  done <<< "$D4_SCRIPTS"
  d4_sudoers_content > "$d4_tmpdir/sudoers"
  current="$d4_tmpdir/current"
  if (( AS_ROOT )); then cat -- "$D4_SUDOERS" > "$current" 2>/dev/null || : > "$current"
  else sudo -n cat -- "$D4_SUDOERS" > "$current" 2>/dev/null || : > "$current"; fi
  if cmp -s "$d4_tmpdir/sudoers" "$current"; then
    echo "ok: $D4_SUDOERS is exactly the generated content"
  elif (( DRY )); then
    echo "DRY: install $D4_SUDOERS (0440) with:"; sed 's/^/DRY:   /' "$d4_tmpdir/sudoers"
  else
    # Never install a sudoers file that does not parse: that can lock sudo out.
    if ! as_root visudo -c -f "$d4_tmpdir/sudoers" >/dev/null; then
      echo "FAILED: the generated $D4_SUDOERS does not parse; nothing installed" >&2; D4_RC=1
    elif as_root install -o root -g root -m 0440 "$d4_tmpdir/sudoers" "$D4_SUDOERS"; then
      echo "installed: $D4_SUDOERS"
    else
      echo "FAILED: could not install $D4_SUDOERS" >&2; D4_RC=1
    fi
  fi
fi
rm -rf -- "$d4_tmpdir"

step "4c. the fleet-pane broker: its root script, start directory and sudo rule (docs/fleet-pane.md)"
# B48 (2). The same shape as 4a, for the same reason: a recreate resets /usr/local/sbin,
# /etc/sudoers.d and /etc/fleet-pane/start to the image, and once the tmux line is retired
# (no-tmux-line) the router reaches no agent without the broker. The agents list, the start
# values and the claude binary come from the owner's host directory ($FP_CONF, read-only mount)
# and survive by themselves.
#
# ONLY WHERE THE BROKER IS DEPLOYED, i.e. $FP_CONF is a mount: without it nothing is installed,
# a sudo rule appearing by itself would be a permission change nobody asked for.
# THE PIN IS THE REVIEWED VERSION. scripts/__tests__/fleet-bootstrap-fleet-pane.test.py fails while
# it differs from scripts/root/fleet-pane.py, so a broker change carries its new pin in the same PR.
# NEVER `fail` HERE: step 4b must always run. Problems are counted (FP_RC), step 7 reports them.
FP_SUDOERS=/etc/sudoers.d/fleet-pane
FP_BIN=/usr/local/sbin/fleet-pane
FP_START=/etc/fleet-pane/start
FP_PIN=cd78b99161218695a72ca6f4219cea2ac0d243ee1f1d5e3db03b459261ea03a3
FP_RC=0
FP_DEPLOYED=0
fp_tmpdir="$(mktemp -d)"
fp_src_ok=1
fp_path="$ROOT/scripts/root/fleet-pane.py"
# Copied FIRST, the copy is hashed and installed: checking the file and then installing it by
# name would leave a window in which it could change.
if [[ -L "$fp_path" ]]; then
  echo "REFUSED: $fp_path is a symlink; not reading or installing it" >&2; fp_src_ok=0
elif ! cat -- "$fp_path" > "$fp_tmpdir/fleet-pane" 2>/dev/null; then
  echo "MISSING: $fp_path (the live tree is not on the main branch?)" >&2; fp_src_ok=0
elif [[ "$(sha256sum < "$fp_tmpdir/fleet-pane" | cut -d' ' -f1)" != "$FP_PIN" ]]; then
  echo "MISMATCH: scripts/root/fleet-pane.py sha256 $(sha256sum < "$fp_tmpdir/fleet-pane" | cut -d' ' -f1), pinned $FP_PIN: not installing it" >&2; fp_src_ok=0
else
  echo "ok: scripts/root/fleet-pane.py is the pinned version"
fi
if ! fp_mounted; then
  echo "skip: $FP_CONF is not mounted, the broker is not deployed here: nothing installed"
elif (( ! fp_src_ok )); then
  FP_DEPLOYED=1; FP_RC=1
  echo "NOT INSTALLED: the broker is deployed ($FP_CONF is there), but its source is not the pinned version" >&2
elif (( ! DRY && ! AS_ROOT )) && ! test -f "$BLANKET"; then
  FP_DEPLOYED=1
  echo "ok: not root and no blanket line: nothing can be written from here; step 7 checks the installed copy"
else
  FP_DEPLOYED=1
  if [[ "$(sha256sum < "$FP_BIN" 2>/dev/null | cut -d' ' -f1)" == "$FP_PIN" ]]; then
    echo "ok: $FP_BIN is the pinned version"
  elif as_root install -o root -g root -m 0755 "$fp_tmpdir/fleet-pane" "$FP_BIN"; then
    echo "installed: $FP_BIN"
  else
    echo "FAILED: could not install $FP_BIN" >&2; FP_RC=1
  fi
  # generate writes the start scripts here; root's, nobody else writes it.
  if test -d "$FP_START" && [[ "$(stat -c '%U:%G %a' "$FP_START" 2>/dev/null)" == "root:root 755" ]]; then
    echo "ok: $FP_START"
  elif as_root install -d -o root -g root -m 0755 /etc/fleet-pane "$FP_START"; then
    echo "installed: $FP_START"
  else
    echo "FAILED: could not create $FP_START" >&2; FP_RC=1
  fi
  echo "# The fleet-pane broker (docs/fleet-pane.md, B48 (2)). Written by fleet-bootstrap.sh 4c." > "$fp_tmpdir/sudoers"
  # No arguments in the rule on purpose: the broker filters its own (plan 4.1).
  echo "$ROUTER_USER ALL=(root) NOPASSWD: $FP_BIN" >> "$fp_tmpdir/sudoers"
  if (( AS_ROOT )); then cat -- "$FP_SUDOERS" > "$fp_tmpdir/current" 2>/dev/null || : > "$fp_tmpdir/current"
  else sudo -n cat -- "$FP_SUDOERS" > "$fp_tmpdir/current" 2>/dev/null || : > "$fp_tmpdir/current"; fi
  if cmp -s "$fp_tmpdir/sudoers" "$fp_tmpdir/current"; then
    echo "ok: $FP_SUDOERS is exactly the generated content"
  elif (( DRY )); then
    echo "DRY: install $FP_SUDOERS (0440) with:"; sed 's/^/DRY:   /' "$fp_tmpdir/sudoers"
  elif ! as_root visudo -c -f "$fp_tmpdir/sudoers" >/dev/null; then
    echo "FAILED: the generated $FP_SUDOERS does not parse; nothing installed" >&2; FP_RC=1
  elif as_root install -o root -g root -m 0440 "$fp_tmpdir/sudoers" "$FP_SUDOERS"; then
    echo "installed: $FP_SUDOERS"
  else
    echo "FAILED: could not install $FP_SUDOERS" >&2; FP_RC=1
  fi
fi
rm -rf -- "$fp_tmpdir"

step "4b. the dev-database sudo rule, and the removal of the blanket line"
# 2026-08-24, Balazs approved on Discord at 16:13 ("Kivezetheted ha jonak latod").
# The blanket "marveen ALL=(ALL) NOPASSWD:ALL" line lives in /etc/sudoers.d/marveen,
# and that file is baked into the IMAGE (dated Aug 15), so a container recreate
# brings it straight back. Removing it once by hand is therefore not enough: this
# step has to run on every bootstrap, or the fence quietly disappears.
#
# The evidence for the removal, measured over 25 hours of sudo logging:
# 148 207 calls, of which 148 170 were /usr/bin/tmux as the five agent users
# (99.98%), already covered by the narrow rules above. 33 calls ran as root and
# every one was accounted for. dev-db.sh never appeared, because postgres and
# redis had been up since the 08-22 recreate: the need is real but rare, which is
# exactly what a narrow rule is for.
if test -f "$DEVDB"; then
  echo "ok: $DEVDB present"
elif (( DRY )); then
  echo "DRY: install $DEVDB"
else
  tmp2="$(mktemp)"
  {
    echo "# Fejlesztoi adatbazis eletciklusa (scripts/dev-db.sh). Lasd fleet-bootstrap.sh 4b."
    echo "$ROUTER_USER ALL=(root) NOPASSWD: /usr/bin/pg_ctlcluster 16 main start, /usr/bin/pg_ctlcluster 16 main stop"
    echo "$ROUTER_USER ALL=(root) NOPASSWD: /usr/bin/redis-server /etc/redis/redis.conf --daemonize yes"
    echo "$ROUTER_USER ALL=(postgres) NOPASSWD: /usr/lib/postgresql/16/bin/pg_isready, /usr/bin/pg_isready, /usr/bin/psql"
  } > "$tmp2"
  sudo -n visudo -c -f "$tmp2" >/dev/null || { rm -f "$tmp2"; fail "the dev-db sudoers content does not parse; nothing installed"; }
  sudo -n install -m 0440 -o root -g root "$tmp2" "$DEVDB" || { rm -f "$tmp2"; fail "could not install $DEVDB"; }
  rm -f "$tmp2"
  echo "installed: $DEVDB"
fi
# The removal goes LAST inside this step, and only once the narrow rules are in
# place: after it, this script cannot write to /etc/sudoers.d at all any more.
if test -f "$BLANKET"; then
  if (( DRY )); then
    echo "DRY: remove $BLANKET (the blanket NOPASSWD:ALL line)"
  else
    # FAIL-CLOSED (Balazs, 2026-10-12): a blanket line that stays is not a warning,
    # it is the whole fence missing. Stop here, so nothing downstream reports "ok".
    sudo -n rm -f "$BLANKET" || fail "could not remove $BLANKET (blanket NOPASSWD:ALL): the fence is NOT in place"
    test -f "$BLANKET" && fail "$BLANKET still exists after removal"
    echo "removed: $BLANKET (blanket NOPASSWD:ALL)"
  fi
else
  echo "ok: $BLANKET is already gone"
fi

step "5. dev database (report only, this script never installs)"
# postgresql-16 comes from the PGDG repo (bookworm ships 15) and redis from
# Debian; both are apt installs, so a container recreate takes them with it.
# Reinstalling here would make every boot depend on the network, so the boot
# path only SAYS what is missing. Restore by hand:
#   sudo apt-get install -y postgresql-16 redis-server acl   (PGDG repo needed for 16)
#   sudo -u postgres psql -tAc "CREATE ROLE acropora LOGIN PASSWORD 'acropora';"
#   bash scripts/dev-db.sh reset && bash scripts/dev-db.sh start
for f in /usr/lib/postgresql/16/bin/postgres /usr/bin/redis-server /usr/bin/setfacl; do
  [[ -e "$f" ]] && echo "ok: $f" || echo "MISSING (dev only, does not block the fleet): $f"
done

step "6. group refresh for the running dashboard"
# A process gets its groups AT START. On the boot path this script runs from
# run-dashboard.sh's pre-start hook, so the dashboard that is about to exec
# still carries the OLD group set -- without gid fleet it cannot write into the
# agent directories (owner agent-*, group fleet), and agent starts fail. One
# delayed restart fixes that, and it cannot loop: on the next start the
# membership already exists, so GROUP_GRANTED is 0 and nothing is scheduled.
if (( GROUP_GRANTED && AUTO_RESTART && ! DRY )); then
  echo "scheduling: supervisorctl restart dashboard in 25s (fleet group was just granted)"
  nohup bash -c 'sleep 25; supervisorctl restart dashboard' >/dev/null 2>&1 &
elif (( GROUP_GRANTED )); then
  echo "NOTE: run 'supervisorctl restart dashboard' -- it is running without the fleet group"
else
  echo "ok: nothing to refresh"
fi

step "6b. no unrestricted sudo left (proof, not assumption)"
# Checked by CAPABILITY, from root: does any sudoers source still grant the router
# an unrestricted rule? `sudo -l -U` reads every file in /etc/sudoers.d, so a
# blanket line that came back under another file name is also caught.
if (( DRY )); then
  echo "DRY: sudo -n -l -U $ROUTER_USER | grep unrestricted rule"
else
  if test -f "$BLANKET"; then fail "$BLANKET exists"; fi
  allowed="$(sudo -n -l -U "$ROUTER_USER" 2>/dev/null)" || fail "cannot list sudo rules for $ROUTER_USER (run this as root, or as $ROUTER_USER with a NOPASSWD rule)"
  # Any tag list (NOPASSWD:, SETENV:, NOEXEC: ...) and ALL anywhere in the comma list,
  # as its own item (barracuda, #24 review): "(ALL) SETENV: NOPASSWD: ALL" and
  # "(ALL) NOPASSWD: /usr/bin/tmux, ALL" are both unrestricted.
  if printf '%s\n' "$allowed" | grep -Eq '\((ALL|root)( ?: ?(ALL|root))?\) +([A-Z_]+: *)*(.*, *)?ALL *(,|$)'; then
    fail "an unrestricted sudo rule is still granted to $ROUTER_USER"
  fi
  # A shell or an editor of sudo itself is unrestricted under another name.
  if printf '%s\n' "$allowed" | grep -Eq '\((ALL|root)( ?: ?(ALL|root))?\) .*((/usr)?/bin/(ba|da|z)?sh|/usr/bin/env|(/usr)?/bin/su|/usr/bin/sudo|/usr/sbin/visudo|/usr/bin/tee)( |,|$)'; then
    fail "a root shell-equivalent sudo rule (sh, bash, env, su, sudo, visudo, tee) is granted to $ROUTER_USER"
  fi
  echo "ok: $ROUTER_USER has no unrestricted sudo rule"
fi

step "7. verify"
rc=0
getent group fleet >/dev/null || { echo "MISSING: fleet group" >&2; rc=1; }
for pair in $AGENTS; do
  uid="${pair%%:*}"; agent="${pair##*:}"; user="agent-$agent"
  if [[ "$(id -u "$user" 2>/dev/null)" == "$uid" ]]; then
    echo "ok: $user uid $uid, groups $(id -nG "$user")"
  else
    echo "MISSING: $user at uid $uid" >&2; rc=1
  fi
  # The check that actually matters for a start: can this user READ the OAuth
  # token? Without it the session comes up unauthenticated and every turn dies.
  if sudo -n -u "$user" test -r "$ROOT/store/.claude-oauth-token"; then
    echo "ok: $user can read the OAuth token"
  else
    echo "MISSING: $user cannot read store/.claude-oauth-token (it would start logged out)" >&2; rc=1
  fi
  # The rule must allow tmux AND NOTHING ELSE. Until 2026-08-24 only the first
  # half could be checked, and not even by capability: the blanket NOPASSWD:ALL
  # line answered yes to everything, so the check read the rule TEXT with a root
  # grep. With the blanket line gone both halves are measurable, and the reading
  # form stopped working anyway (grep as root is no longer permitted), which is
  # how the gap surfaced. `sudo -l -u <user> <cmd>` asks the policy itself and
  # runs nothing.
  if (( TMUX_RETIRED )); then
    # N3 (plan section 8): the retired line must be GONE, asked of the policy, not of the file.
    if sudo -n -l -U "$ROUTER_USER" -u "$user" /usr/bin/tmux >/dev/null 2>&1; then
      echo "STILL OPEN: $ROUTER_USER can run tmux as $user, but the tmux line is retired ($FP_CONF/no-tmux-line)" >&2; rc=1
    else
      echo "ok: no tmux line for $user (retired)"
    fi
  else
    sudo -n -l -U "$ROUTER_USER" -u "$user" /usr/bin/tmux >/dev/null 2>&1 \
      || { echo "MISSING: $user cannot be reached with tmux" >&2; rc=1; }
  fi
  # -U: the question is what the ROUTER may do. Asked as root without -U, root may run
  # anything as anyone, and this line reported TOO WIDE on a healthy container (2026-10-12).
  if sudo -n -l -U "$ROUTER_USER" -u "$user" /usr/bin/cat >/dev/null 2>&1; then
    echo "TOO WIDE: $user also allows /usr/bin/cat, the rule is not tmux-only" >&2; rc=1
  fi
done
# D4 (step 4a): where the broker is deployed, the installed copies are the pinned versions and the
# sudo rule file is there. Read as the router: the scripts are 0755, the rule file is checked by
# existence, and the router's own line by capability (sudo -l asks the policy, runs nothing).
if (( D4_RC )); then echo "D4: step 4a reported a problem above" >&2; rc=1; fi
if (( D4_DEPLOYED && ! DRY )); then
  while IFS=: read -r src dst want; do
    [[ -n "$src" ]] || continue
    if [[ "$(sha256sum < "$D4_SBIN/$dst" 2>/dev/null | cut -d' ' -f1)" == "$want" ]]; then
      echo "ok: $D4_SBIN/$dst is the pinned version"
    else
      echo "MISSING: $D4_SBIN/$dst is absent or not the pinned version" >&2; rc=1
    fi
  done <<< "$D4_SCRIPTS"
  test -f "$D4_SUDOERS" || { echo "MISSING: $D4_SUDOERS" >&2; rc=1; }
  if (( ! AS_ROOT )); then
    sudo -n -l "$D4_SBIN/fleet-github" token KratoBal/acroveliq olvas >/dev/null 2>&1 \
      || { echo "MISSING: $ROUTER_USER cannot run fleet-github token" >&2; rc=1; }
  fi
fi
# fleet-pane (step 4c): where the broker is deployed, the installed copy is the pinned version,
# the start directory is root's and the router's line is there (asked of the policy, runs nothing).
if (( FP_RC )); then echo "FLEET-PANE: step 4c reported a problem above" >&2; rc=1; fi
if (( FP_DEPLOYED && ! DRY )); then
  if [[ "$(sha256sum < "$FP_BIN" 2>/dev/null | cut -d' ' -f1)" == "$FP_PIN" ]]; then
    echo "ok: $FP_BIN is the pinned version"
  else
    echo "MISSING: $FP_BIN is absent or not the pinned version" >&2; rc=1
  fi
  [[ "$(stat -c '%U:%G %a' "$FP_START" 2>/dev/null)" == "root:root 755" ]] \
    || { echo "MISSING: $FP_START is absent or not root:root 0755" >&2; rc=1; }
  sudo -n -l -U "$ROUTER_USER" "$FP_BIN" status probe >/dev/null 2>&1 \
    || { echo "MISSING: $ROUTER_USER cannot run $FP_BIN" >&2; rc=1; }
fi
# B45 B2-4: the last daily write check (scripts/b45-jogellenorzo-napi.py, as marveen). A
# JELZES fails this step: a recreate is exactly when a lost ACL or a wrong owner comes back.
# It is DATA, read with the router's rights, never a script run as root (the file and the
# scripts/ tree are the router's), and a missing or stale result is said, not hidden.
B45_LAST="$ROOT/store/b45/jogellenorzo-napi.last"
if (( AS_ROOT )); then b45_line="$(runuser -u "$ROUTER_USER" -- head -c 512 -- "$B45_LAST" 2>/dev/null)"
else b45_line="$(head -c 512 -- "$B45_LAST" 2>/dev/null)"; fi
read -r b45_ts b45_verdict b45_rest <<< "${b45_line%%$'\n'*}"
if [[ ! "${b45_ts:-}" =~ ^[0-9]+$ ]]; then
  echo "NOTE: B45 daily write check has no result ($B45_LAST)" >&2
elif [[ "$b45_verdict" == JELZES ]]; then
  echo "B45 REGRESSION: the daily write check reports: $b45_rest" >&2; rc=1
elif [[ "$b45_verdict" != RENDBEN ]]; then
  echo "NOTE: B45 daily write check result is unreadable ($B45_LAST)" >&2
elif (( $(date +%s) - b45_ts > 172800 )); then
  echo "STALE: B45 daily write check last ran $(( ($(date +%s) - b45_ts) / 3600 ))h ago" >&2
else
  echo "ok: B45 daily write check: $b45_rest"
fi
echo
if (( rc == 0 )); then
  echo "OK: users, group and sudo rules are in place."
  echo "Next, if the agents are down: supervisorctl restart dashboard, then"
  # A NEVSOR NEM KEZZEL IROTT, ES EZ NEM STILUS. 2026-08-31-ig ez a sor OT agenst
  # sorolt fel, mikozben a 45. sor AGENTS valtozoja mar hatot ismert: picasso
  # 2026-08-30-an keletkezett, es a hint nem kovette. Egy visszaallitas, ami ezt a
  # sort masolja, PONTOSAN azt az agenst hagyta volna le, amelyik a legujabb --
  # es a gazda mult alkalommal is azert vadaszott terminalokat, mert valaki nem
  # jott vissza. Ezert a hint ugyanabbol a forrasbol epul, mint az ellenorzes.
  names=""
  for pair in $AGENTS; do names="$names ${pair#*:}"; done
  echo "  for a in${names}; do bash /home/marveen/marveen/scripts/agent-to-own-user.sh \$a; done"
  # EZ A SOR 2026-08-31 19:26-IG HAZUDOTT, ES ACROBOT MERTE VISSZA. Addig ez a
  # szkript sajat magat ajanlotta a "ki nem jott vissza" kerdesre. NEM tudja
  # megvalaszolni: itt csak felhasznalot, csoportot es sudo-szabalyt ellenorzunk,
  # vagyis azt, hogy el TUDNANK erni az agenst. Azt nem nezzuk, hogy a tmux
  # munkamenete letezik-e -- egy leallt agens mellett is OK-t irtunk volna.
  # Ez pontosan az a fajta ellenorzes, ami abban az iranyban nem tud elbukni,
  # amelyikben szamit. Az agent-pane.sh viszont TENYLEG eleri a munkamenetet, es
  # csak akkor lep ki nullaval, ha mindegyiket elerte (merve: nem letezo nevre
  # UNREACHABLE, kilepesi kod 1).
  echo "Utana ellenorzes (ez mondja meg, KI NEM jott vissza; NEM ez a szkript):"
  echo "  bash /home/marveen/marveen/scripts/agent-pane.sh --prompts --all"
else
  echo "CHECK FAILED, see the lines above." >&2
fi
exit $rc
