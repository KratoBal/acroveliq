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

# "-S <chain>" prints "-P ..." / "-N ..." and then the rules as "-A <chain> <spec>"; every check
# below compares that form, so the script writes ONLY when something differs (a quiet journal
# for the per-minute timer) and never flushes a correct chain (no instant with an empty chain).

# ensure_chain CHAIN SPEC...: the chain holds exactly these rules, in this order
ensure_chain() {
  local chain="$1"; shift
  "$IPT" -N "$chain" 2>/dev/null || true
  local want="" spec
  for spec in "$@"; do want+="-A $chain $spec"$'\n'; done
  local have
  have="$("$IPT" -S "$chain" | grep '^-A ' || true)"$'\n'
  if [ "$have" != "$want" ]; then
    "$IPT" -F "$chain"
    for spec in "$@"; do
      # shellcheck disable=SC2086
      "$IPT" -A "$chain" $spec
    done
    echo "VISSZATETTE: a $chain lanc tartalma"
  fi
}

# ensure_first CHAIN SPEC: our jump is the FIRST rule of the chain, exactly once. Not just
# "exists" (-C): a ufw reload puts its own jumps at the top of INPUT, and ours behind them
# would only act on what ufw lets through (acrobot, 30821).
ensure_first() {
  local chain="$1" spec="$2"
  local first
  first="$("$IPT" -S "$chain" | grep -m1 '^-A ' || true)"
  local count
  count="$("$IPT" -S "$chain" | grep -cxF -- "-A $chain $spec" || true)"
  if [ "$first" != "-A $chain $spec" ] || [ "$count" != "1" ]; then
    # shellcheck disable=SC2086
    while "$IPT" -C "$chain" $spec 2>/dev/null; do "$IPT" -D "$chain" $spec; done
    # shellcheck disable=SC2086
    "$IPT" -I "$chain" 1 $spec
    echo "VISSZATETTE: $chain elejere: $spec"
  fi
}

ensure_chain GPTF-GEP "-j DROP"
private_rules=()
for range in $PRIVATE_RANGES; do private_rules+=("-d $range -j DROP"); done
ensure_chain GPTF-PRIVAT "${private_rules[@]}"

ensure_first INPUT "-i $BRIDGE -j GPTF-GEP"
# DOCKER-USER exists once Docker has started (After=docker.service); create it if not, Docker keeps it
"$IPT" -N DOCKER-USER 2>/dev/null || true
ensure_first DOCKER-USER "-i $BRIDGE -j GPTF-PRIVAT"
