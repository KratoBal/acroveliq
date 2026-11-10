#!/usr/bin/env bash
# ANSWERS: Friss-e a review munka-klonok origin/main-je, ember nelkul?
#
# munka-klon-fetch.sh            minden klonra egy fetch, csak a valtozas es a hiba kerul a kimenetre
#
# WHY (card a9cef971, 2026-11-10): the review clones under /home/marveen/work had a stale origin/main
# twice in one day, and barracuda had to ask for a manual fetch each time (measured 22:2x: the commerce
# clone's origin/main stood at 725f1b3, 2026-11-06). Nothing fetched them on its own.
#
# ONLY A FETCH, AND ONLY THE REMOTE-TRACKING REF: `+refs/heads/main:refs/remotes/origin/main`, named in
# full, so it does not depend on the clone's own fetch refspec (one clone has only main, one has all
# branches). No checkout, no pull, no merge, no reset: work may be in progress in these clones, and a
# fetch never touches HEAD, the index or the working tree. The read token comes from git-auth.sh (the
# same broker read as every fleet fetch).
#
# NO BACKGROUND MAINTENANCE (barracuda, #352): a fetch may start `maintenance --auto` (a gc) behind it; every five
# minutes on three clones of an 8 GB machine that is an unplanned gc beside a heavy run. --no-auto-maintenance.
#
# Each clone gets at most FETCH_TIMEOUT seconds; a failure is printed and the next clone still goes.
# Exit 1 if any clone failed or is missing, 0 otherwise. Runs from cron (scripts/crontab/marveen.cron).
set -uo pipefail

KLONOK="${MUNKA_KLONOK:-/home/marveen/work/acropora-os /home/marveen/work/acropora-commerce /home/marveen/work/caparium-napplo}"
GIT_AUTH="${MUNKA_KLON_GIT_AUTH:-$(dirname "${BASH_SOURCE[0]}")/git-auth.sh}"
FETCH_TIMEOUT="${MUNKA_KLON_FETCH_TIMEOUT:-120}"

rc=0
for klon in $KLONOK; do
  if [ ! -d "$klon/.git" ]; then
    echo "$(date -Is) $klon: nincs git-klon itt"
    rc=1
    continue
  fi
  elotte="$(git -C "$klon" rev-parse -q --verify refs/remotes/origin/main 2>/dev/null || echo nincs)"
  if kimenet="$(timeout "$FETCH_TIMEOUT" bash "$GIT_AUTH" -C "$klon" fetch --quiet --no-tags --no-auto-maintenance origin \
      '+refs/heads/main:refs/remotes/origin/main' 2>&1)"; then
    utana="$(git -C "$klon" rev-parse -q --verify refs/remotes/origin/main 2>/dev/null || echo nincs)"
    [ "$elotte" != "$utana" ] && echo "$(date -Is) $klon: origin/main ${elotte:0:8} -> ${utana:0:8}"
  else
    echo "$(date -Is) $klon: FAIL a fetch: $(printf '%s' "$kimenet" | head -c 300 | tr '\n' ' ')"
    rc=1
  fi
done
exit "$rc"
