#!/bin/bash
# Installs the GPT runner's host firewall, measures that it persists, and re-runs the probe.
# ON THE HOST, AS ROOT, from the reviewed clone: /opt/gpt-futtato/src at the approved commit.
# No login, no auth.json, no secret. Docker itself is NOT restarted (that would restart the
# fleet's container); the persistence is measured by removing the rules and letting the unit
# put them back, and by the unit's enablement and its docker binding.
set -euo pipefail
# a silent stop under set -e is the worst kind (barracuda, #140 review 1; it happened on the host today)
trap 'echo "STOP: a telepito a(z) $LINENO. sorban megallt ennel a parancsnal: $BASH_COMMAND" >&2' ERR
SRC=/opt/gpt-futtato/src/gpt-runner
BRIDGE=gptki0

command -v systemctl >/dev/null || { echo "STOP: nincs systemd a gepen, a tartos inditas ezzel a unittal nem oldhato meg"; exit 1; }

# 0. what else shapes the firewall (barracuda, #140 review 3 and 4): another iptables backend than
# Docker's would leave our DOCKER-USER jump in an unwired chain; ufw/firewalld may reorder INPUT
echo "== tuzfal-kornyezet"
iptables -V
docker info 2>/dev/null | grep -iE 'firewall|iptables' || echo "(a docker info nem nevez meg tuzfal-hatteret)"
# ufw is judged by ITS OWN status, not by the service: on the host (2026-10-14 18:55 UTC) the ufw
# service ran with the firewall off, "Firewall not enabled (skipping reload)" (acrobot, 30839)
# read first, then searched: `cmd | grep -q` under pipefail fails when grep stops early (SIGPIPE)
ufw_aktiv() { command -v ufw >/dev/null && grep -q '^Status: active' <<< "$(ufw status 2>/dev/null || true)"; }
if ufw_aktiv; then echo "FIGYELEM: a ufw tuzfala aktiv; egy ujratoltese az INPUT-ot atrendezheti (a timer percen belul visszateszi)"; else echo "ufw: a tuzfala nem aktiv (a ufw status szerint)"; fi
if systemctl is-active --quiet firewalld 2>/dev/null; then echo "FIGYELEM: a firewalld fut; egy ujratoltese az INPUT-ot atrendezheti (a timer percen belul visszateszi)"; else echo "firewalld: nem fut"; fi

# 1. the script and the unit, root-owned
install -o root -g root -m 755 "$SRC/host/tuzfal.sh" /opt/gpt-futtato/tuzfal.sh
install -o root -g root -m 644 "$SRC/host/gpt-futtato-tuzfal.service" /etc/systemd/system/gpt-futtato-tuzfal.service
install -o root -g root -m 644 "$SRC/host/gpt-futtato-tuzfal-ellenor.service" /etc/systemd/system/gpt-futtato-tuzfal-ellenor.service
install -o root -g root -m 644 "$SRC/host/gpt-futtato-tuzfal-ellenor.timer" /etc/systemd/system/gpt-futtato-tuzfal-ellenor.timer
cp "$SRC/compose.yaml" /opt/gpt-futtato/compose.yaml && chmod 644 /opt/gpt-futtato/compose.yaml
systemctl daemon-reload
systemctl enable --now gpt-futtato-tuzfal.service
systemctl enable --now gpt-futtato-tuzfal-ellenor.timer

# 2. persistence, measured: take our rules away, the unit must bring them back
iptables -w 5 -D INPUT -i "$BRIDGE" -j GPTF-GEP 2>/dev/null || true
iptables -w 5 -D OUTPUT -o "$BRIDGE" -j GPTF-GEPROL 2>/dev/null || true
iptables -w 5 -D DOCKER-USER -j GPTF-TOVABB 2>/dev/null || true
iptables -w 5 -t nat -D POSTROUTING -o "$BRIDGE" -j GPTF-NAT 2>/dev/null || true
iptables -w 5 -t raw -D PREROUTING -i "$BRIDGE" -j GPTF-RAW 2>/dev/null || true
iptables -w 5 -F GPTF-GEP 2>/dev/null || true
iptables -w 5 -F GPTF-PRIVAT 2>/dev/null || true
iptables -w 5 -F GPTF-BE 2>/dev/null || true
systemctl restart gpt-futtato-tuzfal.service
echo "== a szabalyok a unit ujrafuttatasa utan"
iptables -w 5 -S INPUT | grep -F GPTF-GEP || { echo "STOP: az INPUT ugras hianyzik"; exit 1; }
iptables -w 5 -S OUTPUT | grep -F GPTF-GEPROL || { echo "STOP: az OUTPUT ugras hianyzik"; exit 1; }
iptables -w 5 -S DOCKER-USER | grep -F GPTF-TOVABB || { echo "STOP: a DOCKER-USER ugras hianyzik"; exit 1; }
iptables -w 5 -t nat -S POSTROUTING | grep -F GPTF-NAT || { echo "STOP: a nat POSTROUTING ugras hianyzik"; exit 1; }
iptables -w 5 -t raw -S PREROUTING | grep -F GPTF-RAW || { echo "STOP: a raw PREROUTING ugras hianyzik"; exit 1; }
iptables -w 5 -S FORWARD | grep -F -- '-j DOCKER-USER' || echo "FIGYELEM: a FORWARD nem ugrik a DOCKER-USER-re ebben az iptables-hatterben; a privat-tartomany szabaly igy nem hat (a proba N1-je megmutatja)"
iptables -w 5 -S GPTF-GEP
iptables -w 5 -S GPTF-PRIVAT
iptables -w 5 -S GPTF-BE
iptables -w 5 -S GPTF-GEPROL
iptables -w 5 -S GPTF-TOVABB
# the canonical spelling, measured on THIS iptables: a second run must change nothing and say nothing
masodik=$(/opt/gpt-futtato/tuzfal.sh)
masodik=$(printf '%s\n' "$masodik" | grep -v '^CSATORNA: ' || true)
[ -z "$masodik" ] || { echo "STOP: a tuzfal.sh masodik futasa is valtoztatott (a szabaly irasmodja nem a kanonikus):"; echo "$masodik"; exit 1; }
echo "a tuzfal.sh masodik futasa csendes: a szabalyok irasmodja egyezik a kanonikus (listazott) alakkal"
echo "== a unit kotesei (boot es docker-ujrainditas)"
systemctl is-enabled gpt-futtato-tuzfal.service
systemctl show -p WantedBy -p PartOf -p After -p ActiveState gpt-futtato-tuzfal.service
grep -q 'docker.service' <<< "$(systemctl show -p WantedBy gpt-futtato-tuzfal.service)" || echo "FIGYELEM: a docker.service nem huzza be a unitot (WantedBy)"

# 2b. the per-minute check, measured in ONE timer round (not by restarting a unit): a rule put
# ABOVE our INPUT jump (what a ufw reload does) and the DOCKER-USER jump removed; within the
# timer's period our jump must be first again and the DOCKER-USER jump back, with a journal line.
# The runner container is stopped (restart: "no"), so the short gap opens nothing that runs.
echo "== a percenkenti ellenorzo (timer): egy kor"
systemctl is-active gpt-futtato-tuzfal-ellenor.timer
iptables -w 5 -I INPUT 1 -m comment --comment gptf-ufw-proba
iptables -w 5 -D DOCKER-USER -j GPTF-TOVABB
start=$(date +%s); back=""
for _ in $(seq 1 18); do
  sleep 5
  if [ "$(iptables -w 5 -S INPUT | grep -m1 '^-A ' || true)" = "-A INPUT -i $BRIDGE -j GPTF-GEP" ] && iptables -w 5 -C DOCKER-USER -j GPTF-TOVABB 2>/dev/null; then back=1; break; fi
done
iptables -w 5 -D INPUT -m comment --comment gptf-ufw-proba
if [ -n "$back" ]; then
  echo "a timer $(( $(date +%s) - start )) mp alatt visszatette (az INPUT elso szabalya ujra a mienk, a DOCKER-USER ugras megvan)"
  journalctl -u gpt-futtato-tuzfal-ellenor.service --since "@$start" --no-pager | grep VISSZATETTE || echo "FIGYELEM: a journalban nincs VISSZATETTE sor"
else
  echo "STOP: a timer 90 mp alatt nem tette vissza a szabalyokat"; exit 1
fi

# 2c. a REAL ufw reload (acrobot, 30822: not just a hand-removed rule). Its risk: ufw rebuilds
# from its saved files, so a rule that lives only in the running ufw state would be dropped.
# Measured, not assumed: `ufw status` and the rules OUTSIDE ufw's and our chains, before and
# after; any difference is printed. Then the timer must put our jumps first again.
if ufw_aktiv; then
  echo "== valodi ufw reload"
  # BEFORE the reload (acrobot, 30825): a ufw user rule that lives only in the running state
  # would be dropped by the reload; any such rule (or no way to tell) stops here, no reload
  only_live_all=""
  for pair in "iptables /etc/ufw/user.rules" "ip6tables /etc/ufw/user6.rules"; do
    read -r ipt saved_file <<< "$pair"
    command -v "$ipt" >/dev/null || continue
    rc=0; out=$("$SRC/host/ufw-elo-mentett.sh" "$ipt" "$saved_file") || rc=$?
    if [ "$rc" = 2 ]; then echo "STOP reload nelkul: nem eldontheto, van-e csak elo ufw-szabaly ($ipt, $saved_file): $out"; exit 1; fi
    [ "$rc" = 1 ] && only_live_all+="$ipt:"$'\n'"$out"$'\n'
  done
  if [ -n "$only_live_all" ]; then
    echo "STOP reload nelkul: ezek a ufw-szabalyok csak eloben leteznek, a mentett fajlokban nincsenek, a reload eldobna oket:"
    echo "$only_live_all"
    exit 1
  fi
  echo "a reload elotti osszevetes: nincs csak eloben letezo ufw-szabaly"
  # a full save before the reload, root-only, for a restore if something is lost (barracuda, #144)
  ( umask 077
    iptables-save > /opt/gpt-futtato/iptables-elotte.rules
    if command -v ip6tables-save >/dev/null; then ip6tables-save > /opt/gpt-futtato/ip6tables-elotte.rules; fi )
  chmod 600 /opt/gpt-futtato/ip*tables-elotte.rules
  ls -l /opt/gpt-futtato/ip*tables-elotte.rules
  echo "visszaallitas, ha kell: iptables-restore < /opt/gpt-futtato/iptables-elotte.rules (es ip6tables-restore ugyanigy)"
  ufw_before=$(ufw status verbose)
  # an empty result is a result, not a failure (pipefail would stop the installer on it)
  other_rules() { iptables-save | grep -v '^#' | grep -vE 'ufw-|GPTF-|gptf-ufw-proba' | grep -vE '^:' || true; }
  rules_before=$(other_rules)
  start=$(date +%s)
  ufw reload
  first_after_reload=$(iptables -w 5 -S INPUT | grep -m1 '^-A ' || true)
  echo "az INPUT elso szabalya kozvetlenul a reload utan: $first_after_reload"
  back=""
  for _ in $(seq 1 18); do
    if [ "$(iptables -w 5 -S INPUT | grep -m1 '^-A ' || true)" = "-A INPUT -i $BRIDGE -j GPTF-GEP" ] && iptables -w 5 -C DOCKER-USER -j GPTF-TOVABB 2>/dev/null; then back=1; break; fi
    sleep 5
  done
  [ -n "$back" ] || { echo "STOP: a ufw reload utan 90 mp alatt nem allt vissza a szabalyunk"; exit 1; }
  if [ "$first_after_reload" = "-A INPUT -i $BRIDGE -j GPTF-GEP" ]; then
    echo "a ufw reload a szabalyunkat nem mozditotta el (a timert a 2b kor meri)"
  else
    echo "a ufw reload elmozditotta, a timer $(( $(date +%s) - start )) mp alatt visszatette"
    journalctl -u gpt-futtato-tuzfal-ellenor.service --since "@$start" --no-pager | grep VISSZATETTE || echo "FIGYELEM: a journalban nincs VISSZATETTE sor"
  fi
  [ "$ufw_before" = "$(ufw status verbose)" ] && echo "ufw status: a reload elott es utan azonos" || { echo "FIGYELEM: a ufw status a reload utan mas:"; diff <(echo "$ufw_before") <(ufw status verbose) || true; }
  rules_diff=$(diff <(echo "$rules_before") <(other_rules) || true)
  [ -z "$rules_diff" ] && echo "a ufw-n es a mi lancainkon kivuli szabalyok a reload utan azonosak" || { echo "FIGYELEM: a reload a ufw-n kivul is valtoztatott:"; echo "$rules_diff"; }
else
  echo "== a ufw tuzfala nem aktiv: a ufw reload ezen a gepen nem nyul az iptableshez, igy a valodi reload-meres nem ertelmezheto; a timer bizonyiteka a 2b kor"
fi

# 3. the host's own IPv4 addresses for the probe (gateway, public, tailnet): all must be closed
GEP=$(hostname -I | tr ' ' '\n' | { grep -v ':' || true; } | { grep -v '^$' || true; } | paste -sd, -)
[ -n "$GEP" ] || echo "FIGYELEM: a gepnek nincs IPv4 cime a hostname -I szerint; a proba csak az atjarot nezi"
sed -i '/^GPT_FUTTATO_GEP_CIMEK=/d' /opt/gpt-futtato/.env
echo "GPT_FUTTATO_GEP_CIMEK=$GEP" >> /opt/gpt-futtato/.env
# the service token's hash is not printed (not a secret, but nothing to read in it)
grep -v '^GPT_FUTTATO_SZOLGA_TOKEN_SHA256=' /opt/gpt-futtato/.env

# 4. the network is re-created with the fixed bridge name, then the probe runs once
cd /opt/gpt-futtato
docker compose down
docker compose build -q
docker compose up --no-color > /opt/gpt-futtato/proba-teljes.log 2>&1 || true
docker logs gpt-futtato >> /opt/gpt-futtato/proba-teljes.log 2>&1 || true
chmod 600 /opt/gpt-futtato/proba-teljes.log
ip -br link show "$BRIDGE" || echo "FIGYELEM: a $BRIDGE bridge nem letezik, a szabalyok nem hatnak"
echo "== a proba"
grep -E "^(PROBA |OSSZESITES)" /opt/gpt-futtato/proba-teljes.log || echo "NINCS PROBA SOR: a teljes naplo /opt/gpt-futtato/proba-teljes.log"
# F2's full list (every flagged path), whenever there is one (acrobot 30889)
grep -E "^PROBA-NAPLO f2 " /opt/gpt-futtato/proba-teljes.log || true

# 5. the stop rule (acrobot): if the control or name resolution broke under the rules, say so
if grep -qE "^PROBA N1 NEM_MERHETO" /opt/gpt-futtato/proba-teljes.log; then
  echo "STOP: a kontroll (api.openai.com:443) a szabalyok utan nem ert ki; a nevfeloldas vagy a kimeno ut torhetett el. A szabalyok levetele: iptables -w 5 -D INPUT -i $BRIDGE -j GPTF-GEP; iptables -w 5 -D OUTPUT -o $BRIDGE -j GPTF-GEPROL; iptables -w 5 -D DOCKER-USER -j GPTF-TOVABB"
fi
