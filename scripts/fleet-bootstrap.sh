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
for pair in $AGENTS; do
  agent="${pair##*:}"; user="agent-$agent"
  rule="$ROUTER_USER ALL=($user) NOPASSWD: /usr/bin/tmux"
  if grep -qF "($user) NOPASSWD: /usr/bin/tmux" "$tmp" 2>/dev/null; then
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
  sudo -n -l -U "$ROUTER_USER" -u "$user" /usr/bin/tmux >/dev/null 2>&1 \
    || { echo "MISSING: $user cannot be reached with tmux" >&2; rc=1; }
  # -U: the question is what the ROUTER may do. Asked as root without -U, root may run
  # anything as anyone, and this line reported TOO WIDE on a healthy container (2026-10-12).
  if sudo -n -l -U "$ROUTER_USER" -u "$user" /usr/bin/cat >/dev/null 2>&1; then
    echo "TOO WIDE: $user also allows /usr/bin/cat, the rule is not tmux-only" >&2; rc=1
  fi
done
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
