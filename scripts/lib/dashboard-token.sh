# shellcheck shell=bash
# The dashboard token this caller should present (acrovelIQ P0-1, plan step 5.2).
# Sourced:   . "$BASE/scripts/lib/dashboard-token.sh"; TOKEN_FILE="$(dashboard_token_file "$BASE")"
#
# The agent is the CALLING OS USER's, never a name the caller passes: an
# agent's `runAsUser` in agents/<name>/agent-config.json, or the main agent
# (MAIN_AGENT_ID in .env, default marveen) for the install's owner. Its token
# is store/tokens/<agent>.token. That file being 0400 and the agent's own is
# the real gate; this function only picks the file.
#
# THREE CASES, and they are not the same (P0-1, task p01-legacy-uzenet-hivo, acrobot 35206;
# the same rule as scripts/lib/dashboard_token.py):
#   - an AGENT's caller (its runAsUser, or the install's owner = the main agent) whose own token is missing,
#     unreadable or empty: an ERROR (one line on stderr, nothing on stdout, status 1). That is a provisioning
#     fault; falling back to the shared token only hid it;
#   - the install's owner while .env is unreadable or has no MAIN_AGENT_ID: an ERROR. The old default
#     "marveen" has no token file, so such a process silently used the shared token;
#   - a caller that is no agent at all (root, cron, an unknown user): the shared store/.dashboard-token with
#     ONE line on stderr, as before, until the scripts that legitimately use it (docs/b28-titok-kivetel.md)
#     are moved.

DASHBOARD_TOKEN_AGENT_NAME='^[a-z0-9][a-z0-9_-]{0,63}$'

# _dashboard_token_owns <dir>: does the calling process own the directory (the install's owner)?
# A function of its own so that a test can stand in for "root / cron / unknown user".
_dashboard_token_owns() {
  [ -O "$1" ]
}

# dashboard_token_agent <install_root> <os_user>: the agent name, or nothing; status 2 (with a line on
# stderr) when the process is the install's owner but .env does not say which agent that is
dashboard_token_agent() {
  local root="$1" user="$2" cfg name main
  [ -n "$user" ] || return 0
  # the name as a literal inside the pattern (a dot must not match any character)
  local user_re
  user_re="$(printf '%s' "$user" | sed 's/[][\\.^$*+?(){}|/]/\\&/g')"
  for cfg in "$root"/agents/*/agent-config.json; do
    [ -f "$cfg" ] || continue
    if grep -Eq "\"runAsUser\"[[:space:]]*:[[:space:]]*\"${user_re}\"" "$cfg" 2>/dev/null; then
      name="$(basename "$(dirname "$cfg")")"
      [[ "$name" =~ $DASHBOARD_TOKEN_AGENT_NAME ]] && printf '%s\n' "$name"
      return 0
    fi
  done
  # the install's owner runs the main agent
  if _dashboard_token_owns "$root/store"; then
    main="$(sed -n 's/^MAIN_AGENT_ID=//p' "$root/.env" 2>/dev/null | head -n 1 | tr -d "\"'\r ")"
    if [ -z "$main" ]; then
      printf 'dashboard-token: this process runs as the install'"'"'s owner but %s/.env is unreadable or has no MAIN_AGENT_ID: refusing to guess the main agent (the old default had no token file)\n' "$root" >&2
      return 2
    fi
    [[ "$main" =~ $DASHBOARD_TOKEN_AGENT_NAME ]] && printf '%s\n' "$main"
  fi
  return 0
}

# dashboard_token_file <install_root>: the token file to read
dashboard_token_file() {
  local root="$1" user agent file
  user="$(id -un 2>/dev/null)"
  agent="$(dashboard_token_agent "$root" "$user")" || return 1
  if [ -n "$agent" ]; then
    file="$root/store/tokens/${agent}.token"
    if [ -r "$file" ] && [ -s "$file" ]; then
      printf '%s\n' "$file"
      return 0
    fi
    printf 'dashboard-token: the own token of agent %s (user %s) is missing, unreadable or empty (%s): the shared token is NOT used for an agent; ask the main agent to issue it (scripts/issue-agent-token.ts)\n' \
      "$agent" "${user:-?}" "$file" >&2
    return 1
  fi
  printf 'dashboard-token: no agent for user %s, using the shared token\n' "${user:-?}" >&2
  printf '%s\n' "$root/store/.dashboard-token"
}
