#!/usr/bin/env bash
# ANSWERS: Hitelesitett git muvelet a GitHub fele, amikor a sima fetch "unauthenticated" limitre fut.
#
# MIERT LETEZIK, merve 2026-09-03 09:35:
#   git fetch origin -> "GitHub is temporarily limiting some UNAUTHENTICATED downloads"
#   ugyanaz a repo az API-n -> megy
#
# A KET DOLOG NEM UGYANAZ A HITELESITES. A credential helper a repokban BE VAN allitva
# (mind a nautilus, mind a murena klonjaban), es MEGSEM sul el: a git a HTTPS transzporton
# eloszor hitelesites NELKUL probal, es csak 401-re kerdezi meg a helpert. A GitHub viszont
# nem 401-et ad, hanem ezt a rate-limit hibat -- tehat a helperig el sem jut a folyamat.
#
# AMI NEM MUKODIK, es murena ki is probalta: a "Bearer <token>" alak. A git BASIC auth-ot var
# (x-access-token:<token> base64-elve), nem Bearer-t. A REST API forditva.
#
# AMIT SZANDEKOSAN NEM CSINALUNK:
#   - a tokent az origin URL-jebe irni: az a repo configjaba irna a titkot, es ott maradna
#   - a tokent parancssorba tenni: a `ps` kimeneteben latszana. Ezert megy
#     GIT_CONFIG_COUNT kornyezeti valtozon at.
#
# HASZNALAT (a repo mappajabol, vagy -C kapcsoloval):
#   bash /home/marveen/marveen/scripts/git-auth.sh fetch origin
#   bash /home/marveen/marveen/scripts/git-auth.sh -C /ut/a/repohoz pull --ff-only origin main
#   bash /home/marveen/marveen/scripts/git-auth.sh ls-remote origin HEAD
#
# A token a store/.github-token fajlbol jon, es a sec-github csoport tagjai olvashatjak.

set -uo pipefail

# By default (FLEET_GITHUB_APP unset, or anything but off; since 2026-10-16, acrobot 32199; off is the
# explicit rollback to the owner token header below) no owner token is read (the owner token's
# retirement, PR 1, docs/fleet-github.md).
#   - A READ (fetch, pull, ls-remote, clone) gets the broker's `olvas` token for exactly the repository
#     the remote names, as the same Basic header, scoped to https://github.com/. WHY (the D4 step list
#     step 10, 2026-10-16): without it the fetch went out unauthenticated, and the marveen user has no
#     credential helper; and even with one, git asks a helper only on a 401, while GitHub's limit on
#     unauthenticated downloads answers otherwise (the reason this script exists, see above). No token
#     from the broker is a stop, not a silent anonymous fetch.
#   - Anything else (push) runs plain git: the credential helper (scripts/git-credential-fleet-github)
#     gives the push token for the one repository. A read header there would make the push use the
#     read token and fail.
GITHUB_TOKEN_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/github-token.sh"
if [ "${FLEET_GITHUB_APP:-on}" != off ]; then
  [ $# -ge 1 ] || { echo "FAIL: adj meg git parancsot, pl.: git-auth.sh fetch origin" >&2; exit 1; }
  # the subcommand: past git's own -C <dir> and -c <key=value>
  pre=(); i=1
  while [ $i -le $# ]; do
    a="${!i}"
    case "$a" in
      -C|-c) j=$((i + 1)); pre+=("$a" "${!j}"); i=$((i + 2)) ;;
      *) break ;;
    esac
  done
  sub="${!i:-}"
  case "$sub" in fetch|pull|ls-remote|clone) ;; *) exec git "$@" ;; esac
  # the remote: the first non-option word after the subcommand (a URL or a remote name), else origin
  remote=""; k=$((i + 1))
  while [ $k -le $# ]; do
    a="${!k}"; k=$((k + 1))
    case "$a" in --) continue ;; -*) continue ;; *) remote="$a"; break ;; esac
  done
  if [[ "$remote" =~ ^https://github\.com/ ]]; then url="$remote"
  elif [ "$sub" = clone ]; then echo "FAIL: clone csak https://github.com/ URL-lel, ez jott: '$remote'" >&2; exit 1
  else url="$(git "${pre[@]}" remote get-url "${remote:-origin}" 2>/dev/null)" || url=""
  fi
  repo="${url#https://github.com/}"; repo="${repo%.git}"; repo="${repo%/}"
  [[ "$url" =~ ^https://github\.com/ ]] && [[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]] \
    || { echo "FAIL: a(z) '${remote:-origin}' remote nem https://github.com/<owner>/<repo>: '$url'" >&2; exit 1; }
  . "$GITHUB_TOKEN_LIB"
  TOK="$(github_token "$repo" olvas)" || { echo "FAIL: a broker nem adott olvas tokent ($repo): nem fetch-elek nevtelenul" >&2; exit 1; }
  BASIC="$(TOK="$TOK" python3 -c 'import base64, os; print(base64.b64encode(("x-access-token:" + os.environ["TOK"]).encode()).decode())')" \
    || { echo "FAIL: a base64 eloallitasa nem sikerult" >&2; exit 1; }
  TOK=""
  GIT_CONFIG_COUNT=1 \
  GIT_CONFIG_KEY_0=http.https://github.com/.extraHeader \
  GIT_CONFIG_VALUE_0="Authorization: Basic ${BASIC}" \
    git "$@"
  RC=$?
  BASIC=""
  exit $RC
fi

TOKEN_FILE="/home/marveen/marveen/store/.github-token"
[ -r "$TOKEN_FILE" ] || { echo "FAIL: nem olvashato: $TOKEN_FILE (sec-github csoport kell hozza)" >&2; exit 1; }
[ $# -ge 1 ] || { echo "FAIL: adj meg git parancsot, pl.: git-auth.sh fetch origin" >&2; exit 1; }

# A base64 elemet a python allitja elo, hogy a token ne kerüljon se parancssorba, se ideiglenes fajlba.
BASIC="$(TOKEN_FILE="$TOKEN_FILE" python3 -c '
import base64, os
tok = open(os.environ["TOKEN_FILE"]).read().strip()
print(base64.b64encode(("x-access-token:" + tok).encode()).decode())
')" || { echo "FAIL: a base64 eloallitasa nem sikerult" >&2; exit 1; }

GIT_CONFIG_COUNT=1 \
GIT_CONFIG_KEY_0=http.extraHeader \
GIT_CONFIG_VALUE_0="Authorization: Basic ${BASIC}" \
  git "$@"
RC=$?

# A valtozo a folyamattal egyutt megszunik; itt csak a helyi masolatot toroljuk.
BASIC=""
exit $RC
