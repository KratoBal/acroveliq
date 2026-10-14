#!/bin/bash
# The GPT runner's host firewall (task t-20261014-gpt-futtato-kontener). ON THE HOST, AS ROOT,
# started by gpt-futtato-tuzfal.service at boot and after every docker (re)start. Idempotent:
# a second run changes nothing and prints nothing. A per-minute timer
# (gpt-futtato-tuzfal-ellenor.timer) runs it too, so a ufw/firewalld reload that drops or
# reorders our rules is undone within a minute, with one journal line (VISSZATETTE: ...).
#
# Why (the first live probe, 2026-10-14 17:50 UTC): from the runner, 10.0.5.1:8000 answered:
# the gateway of its own network is the HOST, and a bridge network alone does not close the
# host's services. Balázs's conditions 1 and 3: no internal service, proven by negative tests.
#
#   GPTF-GEP     everything from the runner's bridge TO THE HOST (INPUT): DROP. This covers
#                every address of the host (gateway, public, tailnet) and every port.
#   GPTF-PRIVAT  everything from the runner's bridge to a PRIVATE range (DOCKER-USER, before
#                Docker's own forwarding): DROP. A port the host publishes is DNAT-ed to a
#                container address, and that packet is forwarded, not delivered: INPUT never
#                sees it. The ranges: RFC 1918, the tailnet (100.64/10), link-local (cloud
#                metadata at 169.254.169.254).
# Outward traffic to public addresses (the vendor's API) is untouched; the probe's control
# (api.openai.com:443) proves it, and its name resolution, after these rules.
set -euo pipefail
BRIDGE="${GPT_FUTTATO_BRIDGE:-gptki0}"
IPT="${IPTABLES:-iptables}"
PRIVATE_RANGES="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16"

# every call waits for the xtables lock (-w 5): Docker, ufw and this timer share it, and a call
# that fails on a busy lock under set -e would stop the script half way (barracuda, #144)
ipt() { "$IPT" -w 5 "$@"; }

# "-S <chain>" prints "-P ..." / "-N ..." and then the rules as "-A <chain> <spec>"; every check
# below compares that form, so the script writes ONLY when something differs (a quiet journal
# for the per-minute timer).

# ensure_chain CHAIN SPEC...: the chain holds exactly these rules. Never flushed (acrobot and
# barracuda, #144): the missing rules are ADDED first, the extra ones removed after. All our
# rules are DROP, so every state in between drops at least what the final one does: the chain
# is never empty and never more open than wanted, not even for an instant or after a stop.
ensure_chain() {
  local chain="$1"; shift
  ipt -N "$chain" 2>/dev/null || true
  local changed="" spec line
  for spec in "$@"; do
    # shellcheck disable=SC2086
    if ! ipt -C "$chain" $spec 2>/dev/null; then ipt -A "$chain" $spec; changed=1; fi
  done
  # the extra ones and the duplicates, after: a wanted rule is kept once
  local -A seen=()
  while IFS= read -r line; do
    spec="${line#-A "$chain" }"
    local wanted=""
    local w; for w in "$@"; do [ "$w" = "$spec" ] && wanted=1; done
    if [ -z "$wanted" ] || [ -n "${seen[$spec]:-}" ]; then
      # shellcheck disable=SC2086
      ipt -D "$chain" $spec; changed=1
    else
      seen[$spec]=1
    fi
  done < <(ipt -S "$chain" | grep '^-A ' || true)
  if [ -n "$changed" ]; then echo "VISSZATETTE: a $chain lanc tartalma"; fi
}

# ensure_first CHAIN SPEC: our jump is the FIRST rule of the chain, exactly once. Not just
# "exists" (-C): a ufw reload puts its own jumps at the top of INPUT, and ours behind them
# would only act on what ufw lets through (acrobot, 30821). The new copy goes in at the top
# BEFORE the old ones are removed, so the jump is never missing.
ensure_first() {
  local chain="$1" spec="$2"
  local first count
  first="$(ipt -S "$chain" | grep -m1 '^-A ' || true)"
  count="$(ipt -S "$chain" | grep -cxF -- "-A $chain $spec" || true)"
  if [ "$first" != "-A $chain $spec" ] || [ "$count" != "1" ]; then
    # shellcheck disable=SC2086
    ipt -I "$chain" 1 $spec
    # every other copy (the first one now is the new one)
    local n
    n="$(ipt -S "$chain" | grep -cxF -- "-A $chain $spec" || true)"
    while [ "$n" -gt 1 ]; do
      # the LAST copy: rule numbers counted on the -A lines
      local num
      num="$(ipt -S "$chain" | grep '^-A ' | grep -nxF -- "-A $chain $spec" | tail -1 | cut -d: -f1)"
      ipt -D "$chain" "$num"
      n=$((n - 1))
    done
    echo "VISSZATETTE: $chain elejere: $spec"
  fi
}

ensure_chain GPTF-GEP "-j DROP"
private_rules=()
for range in $PRIVATE_RANGES; do private_rules+=("-d $range -j DROP"); done
ensure_chain GPTF-PRIVAT "${private_rules[@]}"

ensure_first INPUT "-i $BRIDGE -j GPTF-GEP"
# DOCKER-USER exists once Docker has started (After=docker.service); create it if not, Docker keeps it
ipt -N DOCKER-USER 2>/dev/null || true
ensure_first DOCKER-USER "-i $BRIDGE -j GPTF-PRIVAT"
