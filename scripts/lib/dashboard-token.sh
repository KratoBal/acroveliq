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
# No readable per-agent token: the shared store/.dashboard-token, with ONE line
# on stderr. Loud on purpose, and never a stop: the fleet keeps working while
# the tokens are handed out one by one.

DASHBOARD_TOKEN_AGENT_NAME='^[a-z0-9][a-z0-9_-]{0,63}$'

# dashboard_token_agent <install_root> <os_user>: the agent name, or nothing
dashboard_token_agent() {
  local root="$1" user="$2" cfg name main
  [ -n "$user" ] || return 0
  for cfg in "$root"/agents/*/agent-config.json; do
    [ -f "$cfg" ] || continue
    if grep -Eq "\"runAsUser\"[[:space:]]*:[[:space:]]*\"${user}\"" "$cfg" 2>/dev/null; then
      name="$(basename "$(dirname "$cfg")")"
      [[ "$name" =~ $DASHBOARD_TOKEN_AGENT_NAME ]] && printf '%s\n' "$name"
      return 0
    fi
  done
  # the install's owner runs the main agent
  if [ -O "$root/store" ]; then
    main="$(sed -n 's/^MAIN_AGENT_ID=//p' "$root/.env" 2>/dev/null | head -n 1 | tr -d "\"'\r ")"
    main="${main:-marveen}"
    [[ "$main" =~ $DASHBOARD_TOKEN_AGENT_NAME ]] && printf '%s\n' "$main"
  fi
  return 0
}

# dashboard_token_file <install_root>: the token file to read
dashboard_token_file() {
  local root="$1" user agent file
  user="$(id -un 2>/dev/null)"
  agent="$(dashboard_token_agent "$root" "$user")"
  if [ -n "$agent" ]; then
    file="$root/store/tokens/${agent}.token"
    if [ -r "$file" ] && [ -s "$file" ]; then
      printf '%s\n' "$file"
      return 0
    fi
  fi
  printf 'dashboard-token: no readable per-agent token for user %s (agent %s), using the shared token\n' \
    "${user:-?}" "${agent:-?}" >&2
  printf '%s\n' "$root/store/.dashboard-token"
}
