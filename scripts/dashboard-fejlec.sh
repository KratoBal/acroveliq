#!/usr/bin/env bash
# ANSWERS: Milyen fejléccel hívja egy skill vagy egy kézi parancs a vezérlőpultot, hogy a SAJÁT tokenjét mutassa?
#
#   curl -s -H @<(bash /home/marveen/marveen/scripts/dashboard-fejlec.sh) http://localhost:3420/api/...
#
# Prints `Authorization: Bearer <token>` for the CALLING OS user's own dashboard token
# (scripts/lib/dashboard-token.sh: the agent from runAsUser, or the main agent for the install's
# owner; store/tokens/<agent>.token). The header goes through a file descriptor, so the token is
# never on a command line. No readable own token: the shared one, with the resolver's stderr line
# (loud, never a stop), the same as every other caller (P0-1, task p0-1-harom-javitas).
#
# Replaces the `Authorization: Bearer $(cat store/.dashboard-token)` form in the skills: that one
# always shows the shared token, so every call it makes is `legacy` in the access log, and stops
# working once the shared token is narrowed.
set -u
BASE="${FLEET_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# shellcheck source=lib/dashboard-token.sh
. "$BASE/scripts/lib/dashboard-token.sh" || { echo "dashboard-fejlec: no resolver under $BASE/scripts/lib" >&2; exit 1; }
f="$(dashboard_token_file "$BASE")"
[ -n "$f" ] && [ -r "$f" ] || { echo "dashboard-fejlec: no readable token ($f)" >&2; exit 1; }
tok="$(cat -- "$f")"
[ -n "$tok" ] || { echo "dashboard-fejlec: empty token file ($f)" >&2; exit 1; }
printf 'Authorization: Bearer %s\n' "$tok"
