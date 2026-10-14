#!/bin/bash
# The GPT runner's host firewall (task t-20261014-gpt-futtato-kontener). ON THE HOST, AS ROOT,
# started by gpt-futtato-tuzfal.service at boot and after every docker (re)start. Idempotent:
# a second run changes nothing.
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

# our own chains: created once, refilled every run (so a changed list here takes effect)
"$IPT" -N GPTF-GEP 2>/dev/null || true
"$IPT" -N GPTF-PRIVAT 2>/dev/null || true
"$IPT" -F GPTF-GEP
"$IPT" -F GPTF-PRIVAT
"$IPT" -A GPTF-GEP -j DROP
for range in $PRIVATE_RANGES; do
  "$IPT" -A GPTF-PRIVAT -d "$range" -j DROP
done

# the jumps, at the top of each chain, only once (-C first)
"$IPT" -C INPUT -i "$BRIDGE" -j GPTF-GEP 2>/dev/null || "$IPT" -I INPUT 1 -i "$BRIDGE" -j GPTF-GEP
# DOCKER-USER exists once Docker has started (After=docker.service); create it if not, Docker keeps it
"$IPT" -N DOCKER-USER 2>/dev/null || true
"$IPT" -C DOCKER-USER -i "$BRIDGE" -j GPTF-PRIVAT 2>/dev/null || "$IPT" -I DOCKER-USER 1 -i "$BRIDGE" -j GPTF-PRIVAT

echo "gpt-futtato tuzfal: $BRIDGE -> GPTF-GEP (INPUT), GPTF-PRIVAT (DOCKER-USER) rendben"
