#!/usr/bin/env bash
# Idempotent installer: protect the MAIN checkout (the tree the dashboard
# serves static files from and host updates pull into) against branch-ops.
# Auto-run by scripts/sync-hooks.sh on every update, so a re-clone or a new
# host regains the guard on its first update instead of silently losing it
# (PRODFAAG822 / RESPAWNZAJ822, 2026-08-22: a context-less resumed session
# branch-switched and committed on the live prod tree).
#
# Two git hooks, both scoped to the MAIN worktree only (linked worktrees have
# a different toplevel and pass untouched):
#   pre-commit.d/05-prod-tree-guard -- BLOCKS a commit on the main checkout.
#                    Override: MARVEEN_PROD_COMMIT_OK=1 git commit ...
#                    Installed as a CHAIN ENTRY, not as the pre-commit file:
#                    the secret gate (install-secret-gate-hook.sh) shares the
#                    same pre-commit.d dispatcher, and a monolithic pre-commit
#                    would couple the end state to installer ORDER -- run
#                    second, it would demote the other guard's runner to a
#                    .bak and silently disable it (review finding, msg 14196).
#   post-checkout -- git has no pre-checkout, so a branch switch cannot be
#                    blocked; this ALERTS the main agent and, when the tracked
#                    tree is clean, auto-reverts to the default branch.
#                    Override: MARVEEN_PROD_CHECKOUT_OK=1 git checkout ...
#
# No operator-specific paths are baked in: the guarded root is derived from
# the repository itself (the main worktree of the .git the hook lives in), so
# the same guard ships to every deployment.
#
# THE ALERT'S ADDRESS (task flotta-or-es-infra-javitas, 2026-10-19): the installed hook of
# 2026-10-14 sent the alert with the SHARED token and `from`/`to` = "marveen". Since P0-1 the
# shared token may not send (route-access.ts LEGACY_KEPT: HTTP 403), and "marveen" is the main
# agent's id only where MAIN_AGENT_ID is unset (here the main agent's token file is acrobot.token, so
# its id is probably acrobot; .env is not readable to an agent and was not measured), and a message to an
# id nobody has is accepted and delivered to nobody. The installed copy was STALE: this installer had been fixed
# on 2026-10-16 (#211), but it runs only from sync-hooks.sh on a dashboard update, and a live-tree
# update by git does not run it. Now:
#   - the main agent's id is read from .env at INSTALL time (the installer runs as the owner; an
#     agent user cannot read .env) into $HOOK_DIR/prod-tree-guard.conf, a plain 0644 file the hook
#     reads at run time. No id: the hook does NOT guess one, it says on stderr that the alert did
#     not go anywhere;
#   - `--check` says whether the INSTALLED hook is the one this script would write (exit 0 current,
#     1 stale or missing); scripts/infra-allapot.sh shows it, so a stale guard cannot sit unseen.
#     It changes nothing and needs no .env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# the main checkout's .git is a directory: read it directly (git itself refuses another user's tree as "dubious
# ownership", and --check is run by agents); a linked worktree's .git is a file, and git answers there
if [ -d "$ROOT/.git" ]; then COMMON_DIR="$ROOT/.git"; else COMMON_DIR="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)" && pwd)"; fi
HOOK_DIR="$COMMON_DIR/hooks"
DISPATCH="$HOOK_DIR/pre-commit"
GUARD="$HOOK_DIR/pre-commit.d/05-prod-tree-guard"
DISPATCH_MARK="marveen-pre-commit-dispatcher"
MARK="marveen-prod-tree-guard"

post_checkout_body() {
  cat <<'EOF'
#!/usr/bin/env bash
# marveen-prod-tree-guard : loud (non-blocking) alert + clean-tree auto-revert
# when the main (prod) checkout switches branches. Git has no pre-checkout
# hook, so the switch itself cannot be blocked -- but it must not sit silent
# either (PRODFAAG822: the 10:10 switch was found only on the next manual
# look). Managed by scripts/install-prod-tree-guard-hook.sh -- edit there.
# Deliberate switch: MARVEEN_PROD_CHECKOUT_OK=1 git checkout ...
# Never fails the checkout itself (no set -e; every step is best-effort).
[ "${3:-0}" = "1" ] || exit 0   # flag=1 -> branch switch; file checkouts exit here
PROD_ROOT="${MARVEEN_PROD_ROOT:-$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")}"
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo)"
[ "$TOPLEVEL" = "$PROD_ROOT" ] || exit 0
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo ismeretlen)"
case "$BRANCH" in develop|main|master) exit 0 ;; esac
[ "${MARVEEN_PROD_CHECKOUT_OK:-0}" = "1" ] && exit 0
# Revert target: the deployment's default branch, derived, not assumed.
HOME_BRANCH=""
for b in develop main master; do
  if git show-ref --verify --quiet "refs/heads/$b"; then HOME_BRANCH="$b"; break; fi
done
# Auto-revert only when the TRACKED tree is clean: a guard must never lose
# work. Untracked files deliberately do not count (--untracked-files=no): a
# branch switch never touches them, and on a live tree untracked host-local
# files are the steady state -- counting them would make this revert never
# fire (measured 2026-08-22). Recursion is self-limiting: the revert lands on
# the home branch, where this hook exits at the case-guard above.
REVERTED="nem"
if [ -z "$HOME_BRANCH" ]; then
  REVERTED="nem (nincs develop/main/master ag)"
elif [ -z "$(git status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  if git checkout "$HOME_BRANCH" -q 2>/dev/null; then
    REVERTED="igen ($HOME_BRANCH)"
  else
    REVERTED="nem sikerult (checkout $HOME_BRANCH hibazott)"
  fi
else
  REVERTED="nem (a fa DIRTY, kezi beavatkozas kell)"
fi
# the calling user's own token if handed out, else the shared one, loudly (P0-1,
# plan 5.2): the shared token may no longer send (route-access.ts LEGACY_KEPT)
TOKEN_FILE="$PROD_ROOT/store/.dashboard-token"
if [ -r "$PROD_ROOT/scripts/lib/dashboard-token.sh" ]; then
  . "$PROD_ROOT/scripts/lib/dashboard-token.sh"
  TOKEN_FILE="$(dashboard_token_file "$PROD_ROOT")"
fi
[ -r "$TOKEN_FILE" ] || exit 0
# The main agent's id comes from prod-tree-guard.conf, written by the installer (an agent user
# cannot read .env). It is where the alert goes and the registered `from` the shared token's
# naplo mode would need; with an agent's own token the server takes the sender from the token. No
# id: say so, never guess one ("marveen" is only the app's default, and a message to an id nobody
# has is accepted and delivered to nobody).
MAIN_ID="$(sed -n 's/^MAIN_AGENT_ID=//p' "$(dirname "$0")/prod-tree-guard.conf" 2>/dev/null | head -n 1)"
[[ "$MAIN_ID" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || MAIN_ID=""
ALERT_TO="${MARVEEN_GUARD_ALERT_TO:-$MAIN_ID}"
if ! [[ "$ALERT_TO" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ && "$MAIN_ID" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
  echo "[prod-tree-guard] FIGYELEM: a branch-valtas riasztas NEM ert celba (nincs cimzett: a prod-tree-guard.conf hianyzik vagy ures, futtasd a telepitot a tulajdonosként) -- a koordinator nem tud a valtasrol" >&2
  exit 0
fi
# 'from' must be a registered fleet agent id (the API rejects made-up names,
# measured 2026-08-22) -- the source is named in the content prefix instead.
# The alert MUST name the tree it fired in: without it a test alert raised
# from a scratch root is word-for-word identical to a real one, and the
# reader starts an investigation (cost one wasted round on 2026-08-22).
ORIGIN="${MARVEEN_DASHBOARD_ORIGIN:-http://localhost:3420}"
# a branch name is the caller's text: keep it to the characters a branch name uses, so the JSON below holds
BRANCH_TXT="${BRANCH//[^A-Za-z0-9._\/-]/?}"
TREE_TXT="${TOPLEVEL//[^A-Za-z0-9._\/-]/?}"
# Honest delivery (NOTIFYVAKSWEEP826): the alert POST used to be fire-and-
# forget -- a failed send left the branch-switch alert lost with no trace.
# The hook stays exit-0 (a guard must not break git), but a delivery failure
# is now loud on the git command's own output.
GUARD_HTTP="$(curl -s -m 5 -X POST "$ORIGIN/api/messages" \
  -H "Content-Type: application/json" \
  -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$TOKEN_FILE")") \
  -o /dev/null -w '%{http_code}' \
  -d "{\"from\":\"$MAIN_ID\",\"to\":\"$ALERT_TO\",\"content\":\"[PROD-FA ORSEG, post-checkout hook] Fa: $TREE_TXT -- agat valtott a(z) $BRANCH_TXT agra. (Ha ez az utvonal nem a telepites fo faja, ez PROBA, nem eles riasztas.) AUTO-VISSZAALLITAS: $REVERTED. Commitot a pre-commit hook blokkol; szandekos valtashoz MARVEEN_PROD_CHECKOUT_OK=1.\"}" 2>/dev/null)" || GUARD_HTTP="000"
case "$GUARD_HTTP" in
  2*) : ;;
  *) echo "[prod-tree-guard] FIGYELEM: a branch-valtas riasztas NEM ert celba (HTTP ${GUARD_HTTP:-000}) -- a koordinator nem tud a valtasrol" >&2 ;;
esac
exit 0
EOF
}

# --check: is the INSTALLED post-checkout hook the one this script would write? Changes nothing, needs no .env.
if [ "${1:-}" = "--check" ]; then
  HOOK="$HOOK_DIR/post-checkout"
  [ -f "$HOOK" ] || { echo "prod-tree-guard: NINCS telepitve post-checkout hook ($HOOK): cd $ROOT && bash scripts/install-prod-tree-guard-hook.sh (tulajdonoskent)"; exit 1; }
  if ! post_checkout_body | cmp -s - "$HOOK"; then
    echo "prod-tree-guard: ELAVULT a telepitett post-checkout hook ($HOOK): cd $ROOT && bash scripts/install-prod-tree-guard-hook.sh (tulajdonoskent)"
    exit 1
  fi
  CONF_ID="$(sed -n 's/^MAIN_AGENT_ID=//p' "$HOOK_DIR/prod-tree-guard.conf" 2>/dev/null | head -n 1 || true)"
  [[ "$CONF_ID" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || { echo "prod-tree-guard: a hook friss, de a prod-tree-guard.conf hianyzik vagy ures, a riasztasnak nincs cimzettje: futtasd a telepitot tulajdonoskent"; exit 1; }
  if [ -r "$ROOT/.env" ]; then
    ENV_ID="$(sed -n 's/^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=//p' "$ROOT/.env" | tail -n 1 | tr -d "\"' \r")"
    ENV_ID="${ENV_ID:-marveen}"
    [ "$ENV_ID" = "$CONF_ID" ] || { echo "prod-tree-guard: a prod-tree-guard.conf cimzettje ($CONF_ID) mas, mint a .env MAIN_AGENT_ID-je ($ENV_ID): futtasd a telepitot tulajdonoskent"; exit 1; }
  fi
  echo "prod-tree-guard: a telepitett hook aktualis (a riasztas cimzettje: $CONF_ID)"
  exit 0
fi

mkdir -p "$HOOK_DIR/pre-commit.d"

# A hook file is OURS (a superseded hand-install or an earlier version of this
# installer) if it carries the marker OR a full sentence of OUR OWN prose.
# Content matters, not just the marker: the 2026-08-22 hand-installed host
# files PREDATE the marker convention this PR introduced (review, msg 14200).
# But the recognition is deliberately NARROW: never match the override/alert
# TOKENS (MARVEEN_PROD_COMMIT_OK etc.) -- those are published in our own
# error messages, so a foreign hook whose comment merely mentions the bypass
# would match and be deleted without trace (review, msg 14204; measured with
# a foreign lint-hook). On any doubt the default is PRESERVATION: a wrongly
# preserved duplicate is recoverable, a wrongly deleted foreign hook is not.
is_ours_precommit() {
  grep -qF 'marveen-prod-tree-guard' "$1" 2>/dev/null ||
  grep -qF 'BLOCKED: commit on the running prod checkout' "$1" 2>/dev/null
}
is_ours_postcheckout() {
  grep -qF 'marveen-prod-tree-guard' "$1" 2>/dev/null ||
  grep -qF 'Loud (non-blocking) alert when the running prod checkout switches branches' "$1" 2>/dev/null
}

# 0. A superseded MONOLITHIC prod-guard pre-commit is OURS: remove it instead
#    of preserving it, or it would ride along in the chain as a duplicate.
if [ -f "$DISPATCH" ] && is_ours_precommit "$DISPATCH" && ! grep -q "$DISPATCH_MARK" "$DISPATCH" 2>/dev/null; then
  rm "$DISPATCH"
  echo "  (removed superseded monolithic prod-guard pre-commit)"
fi

# 1. The sub-hook: block commits on the main checkout.
cat > "$GUARD" <<'EOF'
#!/usr/bin/env bash
# marveen-prod-tree-guard : block commits on the main (prod) checkout.
# The dashboard serves static files from this tree and host updates pull into
# it; repo work belongs in a worktree. Managed by
# scripts/install-prod-tree-guard-hook.sh -- edit there, not here.
# Deliberate override: MARVEEN_PROD_COMMIT_OK=1 git commit ...
set -euo pipefail
PROD_ROOT="${MARVEEN_PROD_ROOT:-$(dirname "$(cd "$(git rev-parse --git-common-dir)" && pwd)")}"
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo)"
if [ "$TOPLEVEL" = "$PROD_ROOT" ] && [ "${MARVEEN_PROD_COMMIT_OK:-0}" != "1" ]; then
  echo "" >&2
  echo "BLOCKED: commit on the running main checkout ($PROD_ROOT)." >&2
  echo "The dashboard serves static files from this tree and host updates pull into it." >&2
  echo "Work in a worktree instead:" >&2
  echo "  git worktree add ../$(basename "$PROD_ROOT")-wt-<topic> -b <branch> origin/develop" >&2
  echo "Deliberate override: MARVEEN_PROD_COMMIT_OK=1 git commit ..." >&2
  exit 1
fi
exit 0
EOF
chmod +x "$GUARD"

# 2. Dispatcher: byte-for-byte the same contract as install-secret-gate-hook.sh
#    (same marker), so whichever installer runs first creates it and the other
#    leaves it alone -- no ordering dependency between the two guards.
if [ -f "$DISPATCH" ] && ! grep -q "$DISPATCH_MARK" "$DISPATCH" 2>/dev/null; then
  mv "$DISPATCH" "$HOOK_DIR/pre-commit.d/00-existing-precommit"
  chmod +x "$HOOK_DIR/pre-commit.d/00-existing-precommit"
  echo "  (preserved existing pre-commit as pre-commit.d/00-existing-precommit)"
fi
cat > "$DISPATCH" <<EOF
#!/usr/bin/env bash
# $DISPATCH_MARK : run every executable in pre-commit.d/.
set -euo pipefail
HOOK_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
status=0
for h in "\$HOOK_DIR"/pre-commit.d/*; do
  [ -x "\$h" ] || continue
  "\$h" "\$@" || status=1
done
exit \$status
EOF
chmod +x "$DISPATCH"

# 3. post-checkout: no chain exists for this hook type; a pre-existing foreign
#    hook is preserved out of the way (a guard must not clobber, and the .bak
#    is inspectable). Our own superseded copy (marker OR content match, see
#    is_ours_postcheckout) is simply replaced -- backing up our own old file
#    would recreate the misleading-.bak class on this hook (review, msg 14200).
if [ -f "$HOOK_DIR/post-checkout" ] && ! is_ours_postcheckout "$HOOK_DIR/post-checkout"; then
  mv "$HOOK_DIR/post-checkout" "$HOOK_DIR/post-checkout.pre-prod-guard.bak"
  echo "  (preserved existing post-checkout as post-checkout.pre-prod-guard.bak)"
fi
post_checkout_body > "$HOOK_DIR/post-checkout"
chmod +x "$HOOK_DIR/post-checkout"

# the main agent's id, for the hook's alert (see the header): read from .env as the owner, MAIN_AGENT_ID unset = the
# app's own default. An unreadable .env keeps the file that is there; no file and no .env is said, not guessed.
CONF="$HOOK_DIR/prod-tree-guard.conf"
MAIN_ID=""
if [ -r "$ROOT/.env" ]; then
  MAIN_ID="$(sed -n 's/^[[:space:]]*MAIN_AGENT_ID[[:space:]]*=//p' "$ROOT/.env" | tail -n 1 | tr -d "\"' \r")"
  MAIN_ID="${MAIN_ID:-marveen}"
fi
if [[ "$MAIN_ID" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
  printf 'MAIN_AGENT_ID=%s\n' "$MAIN_ID" > "$CONF.tmp"
  chmod 644 "$CONF.tmp"
  mv "$CONF.tmp" "$CONF"
elif [ -s "$CONF" ]; then
  echo "  (.env not readable or MAIN_AGENT_ID malformed: kept the existing prod-tree-guard.conf)"
else
  echo "  WARNING: no prod-tree-guard.conf written (.env not readable by $(id -un), or MAIN_AGENT_ID malformed): the branch-switch alert has no recipient until the installer runs as the owner" >&2
fi

echo "✓ prod-tree-guard: commit block + branch-switch alert/revert installed for the main checkout."
