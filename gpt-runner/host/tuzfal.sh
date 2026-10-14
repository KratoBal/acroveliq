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
#   GPTF-BE      every NEW connection INTO the runner's bridge (DOCKER-USER, -o): DROP, except
#                the controller channel: from the fleet container's fixed address, to the runner
#                service's fixed address and port (barracuda 30866/30873, acrobot 30868/30875).
#                DOCKER-USER runs AFTER the DNAT, so the destination here is the service's
#                container address and port, not the published host address.
#   GPTF-GEPROL  everything the HOST itself sends into the runner's bridge (OUTPUT): DROP. A
#                connection from the host does not pass FORWARD, so GPTF-BE would not see it.
# The private-range drops match only what is not a reply (! RELATED,ESTABLISHED): the runner's
# answer to the controller goes back to a private address. A NEW connection from the runner is
# still dropped, so it can never have an established flow of its own to a private address.
#   GPTF-TOVABB  the one DOCKER-USER jump, to GPTF-PRIVAT (-i) and GPTF-BE (-o).
# Every rule in our chains is a DROP (GPTF-TOVABB: a jump to one), so their order does not matter
# and a refill never opens more than wanted. The canonical (`iptables -S`) spelling is written, because the chains are
# compared to that text; the installer runs this script a second time and wants it quiet.
# Outward traffic to public addresses (the vendor's API) is untouched; the probe's control
# (api.openai.com:443) proves it, and its name resolution, after these rules.
set -euo pipefail
BRIDGE="${GPT_FUTTATO_BRIDGE:-gptki0}"
IPT="${IPTABLES:-iptables}"
PRIVATE_RANGES="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16"
# the controller channel's addresses, from the compose project's .env (root-owned). Read with a
# strict pattern, never sourced. Missing or malformed: the channel stays closed, nothing else moves
ENV_FILE="${GPT_FUTTATO_ENV:-/opt/gpt-futtato/.env}"
ALLAPOT_DIR="${GPT_FUTTATO_ALLAPOT_DIR:-/run/gpt-futtato}"
SZOLGA_PORT=8790
envval() { if [ -r "$ENV_FILE" ]; then sed -n "s/^$1=\([0-9.]*\)\$/\1/p" "$ENV_FILE" | tail -1; fi; }
ipv4() {
  local IFS=. o
  [[ "$1" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  for o in $1; do [ "$o" -le 255 ] || return 1; done
}
VEZERLO="$(envval GPT_FUTTATO_VEZERLO_CIM)"
SZOLGA="$(envval GPT_FUTTATO_SZOLGA_CIM)"
FLOTTA="$(if [ -r "$ENV_FILE" ]; then sed -n 's/^GPT_FUTTATO_FLOTTA_KONTENER=\([A-Za-z0-9_.-]*\)$/\1/p' "$ENV_FILE" | tail -1; fi)"

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
for range in $PRIVATE_RANGES; do private_rules+=("-d $range -m conntrack ! --ctstate RELATED,ESTABLISHED -j DROP"); done
ensure_chain GPTF-PRIVAT "${private_rules[@]}"

# into the runner: no NEW connection, except the channel; each part of "except" is its own DROP
be_rules=("-m conntrack --ctstate INVALID -j DROP")
if ipv4 "$VEZERLO" && ipv4 "$SZOLGA"; then
  be_rules+=(
    "! -s $VEZERLO/32 -m conntrack --ctstate NEW -j DROP"
    "! -d $SZOLGA/32 -m conntrack --ctstate NEW -j DROP"
    "! -p tcp -m conntrack --ctstate NEW -j DROP"
    "-p tcp -m tcp ! --dport $SZOLGA_PORT -m conntrack --ctstate NEW -j DROP"
  )
else
  be_rules+=("-m conntrack --ctstate NEW -j DROP")
fi
ensure_chain GPTF-BE "${be_rules[@]}"
ensure_chain GPTF-GEPROL "-j DROP"
ensure_chain GPTF-TOVABB "-i $BRIDGE -j GPTF-PRIVAT" "-o $BRIDGE -j GPTF-BE"

ensure_first INPUT "-i $BRIDGE -j GPTF-GEP"
ensure_first OUTPUT "-o $BRIDGE -j GPTF-GEPROL"
# DOCKER-USER exists once Docker has started (After=docker.service); create it if not, Docker keeps it
ipt -N DOCKER-USER 2>/dev/null || true
ensure_first DOCKER-USER "-j GPTF-TOVABB"
# the jump of the first version (before the channel), now inside GPTF-TOVABB: removed AFTER the
# new jump is in place, so the private ranges are never open
while ipt -C DOCKER-USER -i "$BRIDGE" -j GPTF-PRIVAT 2>/dev/null; do
  ipt -D DOCKER-USER -i "$BRIDGE" -j GPTF-PRIVAT
  echo "ATTETTE: a DOCKER-USER regi ugrasa (-i $BRIDGE -j GPTF-PRIVAT) a GPTF-TOVABB lancba"
done

# The fleet container's address can change when it is re-created: then the fixed controller
# address no longer matches, the channel does not work (the safe way), and this says so. One
# journal line when the state CHANGES, not every minute.
cim_allapot() {
  if ! ipv4 "$VEZERLO" || ! ipv4 "$SZOLGA"; then echo "a csatorna zarva: nincs ervenyes GPT_FUTTATO_VEZERLO_CIM es GPT_FUTTATO_SZOLGA_CIM"; return; fi
  [ -n "$FLOTTA" ] || { echo "a flotta kontener cime nem ellenorizheto: nincs GPT_FUTTATO_FLOTTA_KONTENER"; return; }
  local ips
  if ! ips="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$FLOTTA" 2>/dev/null)"; then
    echo "a flotta kontener ($FLOTTA) nem olvashato: a csatorna cime nem ellenorizheto"; return
  fi
  case " $ips " in
    *" $VEZERLO "*) echo "rendben" ;;
    *) echo "a flotta kontener ($FLOTTA) cimei: ${ips% }; a rogzitett vezerlo-cim ($VEZERLO) nincs koztuk: a csatorna zarva marad" ;;
  esac
}
allapot="$(cim_allapot)"
if mkdir -p "$ALLAPOT_DIR" 2>/dev/null; then
  elozo="$(cat "$ALLAPOT_DIR/cim-allapot" 2>/dev/null || true)"
  if [ "$allapot" != "$elozo" ]; then
    printf '%s\n' "$allapot" > "$ALLAPOT_DIR/cim-allapot"
    echo "CSATORNA: $allapot"
  fi
fi
