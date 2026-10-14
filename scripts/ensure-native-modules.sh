#!/usr/bin/env bash
# Startup guard: ensure the better-sqlite3 native binding loads for the current
# Node ABI before the dashboard/channels services start. If it is missing or
# ABI-mismatched (the recurring "Could not locate the bindings file" crash-loop,
# root-caused 2026-07-03), rebuild it in place. Idempotent, safe to run on every
# start. Wired in as ExecStartPre= on the *-dashboard and *-channels units.
set -u

# Derive the project root from this script's location (scripts/ -> repo root),
# so the guard is portable across install dirs instead of hardcoding a path.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR" || exit 0   # never block startup on a cd failure

# Fleet users, group and the narrow sudo rule (added 2026-08-22). They live in
# the CONTAINER filesystem, so `docker compose up -d` -- which recreates the
# container from the image -- deletes them, and every per-user agent then fails
# to start with nothing but "Failed to start tmux session". This is the only
# pre-start hook run-dashboard.sh offers, and it runs as marveen with sudo, so
# the restore is anchored here rather than in a document nobody reads at boot.
# Idempotent and non-fatal: on a healthy container it changes nothing, and a
# failure must never keep the dashboard down.
if [ -x "./scripts/fleet-bootstrap.sh" ]; then
  bash ./scripts/fleet-bootstrap.sh --auto-restart-dashboard >&2 2>&1 \
    || echo "ensure-native-modules: fleet-bootstrap failed, per-user agents may not start" >&2
fi

# The marveen user's crontab (backup lines) is in the container filesystem too, and a
# recreate drops it (measured 2026-10-14: the 03:40 fleet backup did not run). Same
# contract as above: idempotent, non-fatal.
if [ -f "./scripts/crontab-ensure.sh" ]; then
  bash ./scripts/crontab-ensure.sh >&2 2>&1 \
    || echo "ensure-native-modules: crontab-ensure failed, backups may not run" >&2
fi

# Health check must INSTANTIATE a Database -- better-sqlite3 loads its native
# binding lazily on `new Database()`, not on require(), so a bare require passes
# even when the .node file is missing (learned the hard way, 2026-07-03).
CHECK="const D=require('better-sqlite3'); new D(':memory:').close();"
if node -e "$CHECK" >/dev/null 2>&1; then
  exit 0
fi

echo "ensure-native-modules: better-sqlite3 binding not loadable, rebuilding for Node $(node -v)..." >&2
npm rebuild better-sqlite3 >&2 2>&1

# Verify the rebuild worked; log but do not hard-fail (systemd would just retry).
if node -e "$CHECK" >/dev/null 2>&1; then
  echo "ensure-native-modules: rebuild OK." >&2
else
  echo "ensure-native-modules: rebuild FAILED, dashboard will likely crash-loop." >&2
fi
exit 0
