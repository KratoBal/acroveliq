# shellcheck shell=bash
# github_token <owner/repo> <role>: a GitHub token for exactly that repository, on stdout.
#
# THE OWNER TOKEN'S RETIREMENT, PR 1 (D4 step 2, docs/fleet-github.md): the fleet's scripts read the
# owner token file (store/.github-token), one token for every repository. Before that token is
# revoked, every reader goes through this function:
#   the default           the root broker (/usr/local/sbin/fleet-github): a one-hour installation token
#   (unset, or not off)   for the one repository, with the role's permissions only
#   FLEET_GITHUB_APP=off  the owner token file: the explicit rollback, nothing else
# THE DEFAULT IS THE BROKER since 2026-10-16 (acrobot 32199): the switch was read from each process's
# environment, and the agents' sessions never had it, so an "on" in .env reached the dashboard only.
# A broker failure is a stop with its reason (the broker's stderr), never a fall back to the owner token.
# A broker token covers ONE repository, so a script that reads several asks once per repository.
#
# Roles: olvas (read), push, pr (open or edit a PR), beolvaszt (merge). A refusal is said on stderr
# and the function returns non-zero: the caller stops, it does not go on with an empty token.
#
# Fixed places, one line each: the tests replace them in a copy.
GITHUB_OWNER_TOKEN_FILE=/home/marveen/marveen/store/.github-token
GITHUB_TOKEN_BROKER=/usr/local/sbin/fleet-github
GITHUB_TOKEN_SUDO="sudo -n"

github_token() {
  local repo="${1:-}" role="${2:-}" tok
  if [[ ! "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]]; then
    echo "github_token: not an owner/repo: ${repo}" >&2; return 2
  fi
  case "$role" in olvas|push|pr|beolvaszt) ;; *) echo "github_token: unknown role: ${role}" >&2; return 2 ;; esac
  if [ "${FLEET_GITHUB_APP:-on}" != off ]; then
    if ! tok="$($GITHUB_TOKEN_SUDO "$GITHUB_TOKEN_BROKER" token "$repo" "$role")" || [ -z "$tok" ]; then
      echo "github_token: the broker gave no ${role} token for ${repo}" >&2; return 1
    fi
  else
    if [ ! -r "$GITHUB_OWNER_TOKEN_FILE" ]; then
      echo "github_token: the owner token is not readable: ${GITHUB_OWNER_TOKEN_FILE}" >&2; return 1
    fi
    tok="$(cat "$GITHUB_OWNER_TOKEN_FILE")"
    [ -n "$tok" ] || { echo "github_token: the owner token file is empty" >&2; return 1; }
  fi
  printf '%s\n' "$tok"
}
