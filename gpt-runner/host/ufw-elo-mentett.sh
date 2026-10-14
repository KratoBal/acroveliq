#!/bin/bash
# Are there ufw user rules that live ONLY in the running state? A `ufw reload` rebuilds from the
# saved files and would drop them, so the installer runs this BEFORE a reload and stops on any
# (acrobot, 30825: on a production host, stop before, not compare after).
#
#   ufw-elo-mentett.sh <iptables|ip6tables> <saved rules file>
#   prints the rules found only in the running state; exit 0 none, 1 some, 2 cannot tell
#
# The running form (`iptables -S`) and the saved form (iptables-restore lines in
# /etc/ufw/user.rules) spell some rules differently: the running one adds the implicit
# `-m tcp` / `-m udp`, and quotes comments differently. Both sides are normalized the same
# way; a difference left over is printed, and a false one only stops the reload (the safe side).
set -euo pipefail
IPT="${1:?iptables or ip6tables}"
SAVED="${2:?the saved ufw rules file}"
[ -r "$SAVED" ] || { echo "nem olvashato: $SAVED"; exit 2; }

norm() { sed -E 's/ -m (tcp|udp)( |$)/ /g; s/["'\'']//g; s/  +/ /g; s/ +$//' | LC_ALL=C sort -u; }
# a failing `iptables -S` must not read as "no running rule": that would allow the reload
running="$("$IPT" -w 5 -S)" || { echo "az $IPT -S nem futott le"; exit 2; }
live() { printf '%s\n' "$running" | { grep -E '^-A ufw6?-user-' || true; } | norm; }
saved() { { grep -E '^-A ufw6?-user-' "$SAVED" || true; } | norm; }

only_live="$(LC_ALL=C comm -23 <(live) <(saved))"
if [ -n "$only_live" ]; then
  echo "$only_live"
  exit 1
fi
exit 0
