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
for fw in ufw firewalld; do
  if systemctl is-active --quiet "$fw" 2>/dev/null; then echo "FIGYELEM: a $fw fut; egy ujratoltese az INPUT-ot atrendezheti, a unit ilyenkor nem fut ujra"; else echo "$fw: nem fut"; fi
done

# 1. the script and the unit, root-owned
install -o root -g root -m 755 "$SRC/host/tuzfal.sh" /opt/gpt-futtato/tuzfal.sh
install -o root -g root -m 644 "$SRC/host/gpt-futtato-tuzfal.service" /etc/systemd/system/gpt-futtato-tuzfal.service
cp "$SRC/compose.yaml" /opt/gpt-futtato/compose.yaml && chmod 644 /opt/gpt-futtato/compose.yaml
systemctl daemon-reload
systemctl enable --now gpt-futtato-tuzfal.service

# 2. persistence, measured: take our rules away, the unit must bring them back
iptables -D INPUT -i "$BRIDGE" -j GPTF-GEP 2>/dev/null || true
iptables -D DOCKER-USER -i "$BRIDGE" -j GPTF-PRIVAT 2>/dev/null || true
iptables -F GPTF-GEP 2>/dev/null || true
iptables -F GPTF-PRIVAT 2>/dev/null || true
systemctl restart gpt-futtato-tuzfal.service
echo "== a szabalyok a unit ujrafuttatasa utan"
iptables -S INPUT | grep -F GPTF-GEP || { echo "STOP: az INPUT ugras hianyzik"; exit 1; }
iptables -S DOCKER-USER | grep -F GPTF-PRIVAT || { echo "STOP: a DOCKER-USER ugras hianyzik"; exit 1; }
iptables -S FORWARD | grep -F -- '-j DOCKER-USER' || echo "FIGYELEM: a FORWARD nem ugrik a DOCKER-USER-re ebben az iptables-hatterben; a privat-tartomany szabaly igy nem hat (a proba N1-je megmutatja)"
iptables -S GPTF-GEP
iptables -S GPTF-PRIVAT
echo "== a unit kotesei (boot es docker-ujrainditas)"
systemctl is-enabled gpt-futtato-tuzfal.service
systemctl show -p WantedBy -p PartOf -p After -p ActiveState gpt-futtato-tuzfal.service
systemctl show -p WantedBy gpt-futtato-tuzfal.service | grep -q 'docker.service' || echo "FIGYELEM: a docker.service nem huzza be a unitot (WantedBy)"

# 3. the host's own IPv4 addresses for the probe (gateway, public, tailnet): all must be closed
GEP=$(hostname -I | tr ' ' '\n' | { grep -v ':' || true; } | { grep -v '^$' || true; } | paste -sd, -)
[ -n "$GEP" ] || echo "FIGYELEM: a gepnek nincs IPv4 cime a hostname -I szerint; a proba csak az atjarot nezi"
sed -i '/^GPT_FUTTATO_GEP_CIMEK=/d' /opt/gpt-futtato/.env
echo "GPT_FUTTATO_GEP_CIMEK=$GEP" >> /opt/gpt-futtato/.env
cat /opt/gpt-futtato/.env

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

# 5. the stop rule (acrobot): if the control or name resolution broke under the rules, say so
if grep -qE "^PROBA N1 NEM_MERHETO" /opt/gpt-futtato/proba-teljes.log; then
  echo "STOP: a kontroll (api.openai.com:443) a szabalyok utan nem ert ki; a nevfeloldas vagy a kimeno ut torhetett el. A szabalyok levetele: iptables -D INPUT -i $BRIDGE -j GPTF-GEP; iptables -D DOCKER-USER -i $BRIDGE -j GPTF-PRIVAT"
fi
