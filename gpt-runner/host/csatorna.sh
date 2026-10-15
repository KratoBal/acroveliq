#!/bin/bash
# The controller channel of the GPT runner, set up and MEASURED on the host (task
# t-20261014-gpt-futtato-kontener; acrobot 30868/30875, barracuda 30866/30873).
# ON THE HOST, AS ROOT, from the reviewed clone (/opt/gpt-futtato/src at the approved commit).
# Not interactive. Docker itself is not restarted, the fleet container is not touched (it joins
# no network; its address is only READ), and no model is called through the channel.
#
# The channel is ROUTED: the service's port is published on ONE host address, the gateway of a
# fleet network, and the host firewall (tuzfal.sh, GPTF-BE) lets a new connection in only from the
# fleet container's fixed address. What the whole design stands on is measured here, and any
# difference STOPS:
#   - the source address the service SEES is the fleet container's (DNAT + routed path), not a
#     gateway (a docker-proxy in the way would make the source filter filter the wrong thing);
#   - another container on the same fleet network does NOT reach the port,
#     while the same container DOES reach the fleet's own port (the control);
#   - the probe (N1) still finds no fleet or host address open from the runner.
# The fleet container's address may change when it is re-created, and the old one may later go to
# another container (barracuda, #148): so tuzfal.sh CLOSES the channel (GPTF-BE closed, the two
# ACCEPTs out) whenever the fleet container does not hold the fixed address, at every timer round,
# and logs it once (journalctl -u gpt-futtato-tuzfal-ellenor.service, CSATORNA: ...). Running this
# script again re-reads the address.
#
# At the end the service is STOPPED: running it for the debates is Balázs's separate activation,
# and the controller has no runner until PR 2's package and filters exist anyway.
set -euo pipefail
DIR="${GPT_FUTTATO_DIR:-/opt/gpt-futtato}"
SRC="$DIR/src/gpt-runner"
ENVF="$DIR/.env"
FLEET_STORE="${GPT_FUTTATO_FLOTTA_STORE:-/opt/marveen-docker/data/marveen/store}"
TOKEN_FILE="$FLEET_STORE/.gpt-futtato-token"
ALLAPOT_DIR="${GPT_FUTTATO_ALLAPOT_DIR:-/run/gpt-futtato}"
PORT=8790

# stops the service and SAYS its state after (acrobot 30907: from a silent stop one could not tell
# whether the service was left running after a STOP)
stop_szolga() {
  (cd "$DIR" && docker compose --profile szolga stop gpt-szolga >/dev/null 2>&1) || true
  echo "a gpt-szolga allapota a leallitas utan: $(docker inspect -f '{{.State.Status}}' gpt-szolga 2>/dev/null || echo 'nincs ilyen kontener')"
}
trap 'echo "STOP: a csatorna-meres a(z) $LINENO. sorban megallt ennel a parancsnal: $BASH_COMMAND" >&2; stop_szolga' ERR
stop() { echo "STOP: $*"; stop_szolga; exit 1; }
ipv4() {
  local IFS=. o
  [[ "${1:-}" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  for o in $1; do [ "$o" -le 255 ] || return 1; done
}
set_env() { sed -i "/^$1=/d" "$ENVF"; printf '%s=%s\n' "$1" "$2" >> "$ENVF"; }
# a TCP connect from a given place: prints NYITOTT or ZART (with the reason)
CONNECT_JS='const net=require("net");const [h,p]=process.argv.slice(1);const s=net.connect({host:h,port:+p});s.setTimeout(5000);s.on("connect",()=>{console.log("NYITOTT");s.destroy()});s.on("timeout",()=>{console.log("ZART (idotullepes)");s.destroy()});s.on("error",(e)=>console.log("ZART ("+e.code+")"))'

# after the activation (aktivalas.sh) systemd runs the service: this script's own `up -d` would
# collide with it, and its final stop would stop it with a CLEAN exit that Restart=on-failure does
# not restart, so the debate channel would stay down silently (barracuda, #166). So it stops here,
# WITHOUT touching the service (no stop_szolga).
# enabled OR running (a `systemctl start` without enable is stopped by the final stop all the same;
# barracuda, #169)
if systemctl is-enabled --quiet gpt-szolga.service 2>/dev/null || systemctl is-active --quiet gpt-szolga.service 2>/dev/null; then
  echo "STOP: a gpt-szolga.service engedelyezve vagy fut: a csatorna-meres ezt leallitana. Elobb: systemctl disable --now gpt-szolga.service, a meres utan az aktivalas ujra."
  exit 1
fi
[ -d "$SRC" ] || stop "nincs $SRC: elobb a forras kell a jovahagyott commiton"
[ -r "$ENVF" ] || stop "nincs $ENVF"

# 1. the fleet container: the running one that mounts the fleet's data tree; exactly one
echo "== a flotta kontenere"
mapfile -t cands < <(docker ps -q | xargs -r docker inspect -f '{{.Name}}|{{range .Mounts}}{{.Source}} {{end}}' | { grep -F '/opt/marveen-docker/data' || true; } | cut -d'|' -f1 | sed 's#^/##')
[ "${#cands[@]}" = 1 ] || stop "pontosan egy flotta-kontener kell (a /opt/marveen-docker/data csatolasaval), ennyi van: ${#cands[@]} (${cands[*]:-})"
FLOTTA="${cands[0]}"
echo "flotta-kontener: $FLOTTA"

# 2. which fleet network: the one with the fewest containers (the fewest neighbours who could try
# the port); its gateway is the published address, the fleet's address on it is the allowed source
echo "== a flotta halozatai (nev, a flotta cime, atjaro, kontenerek szama)"
best="" best_n=""
while read -r net ip gw; do
  [ -n "$net" ] || continue
  n=$(docker network inspect -f '{{len .Containers}}' "$net")
  echo "$net $ip $gw $n"
  ipv4 "$ip" && ipv4 "$gw" || continue
  if [ -z "$best" ] || [ "$n" -lt "$best_n" ]; then best="$net $ip $gw"; best_n="$n"; fi
done < <(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{$n}} {{$v.IPAddress}} {{$v.Gateway}}{{"\n"}}{{end}}' "$FLOTTA")
[ -n "$best" ] || stop "a flotta kontenerenek nincs IPv4-es halozata atjaroval"
read -r NET VEZ KOZZ <<< "$best"
echo "valasztott: $NET (kontenerek: $best_n); a vezerlo forrascime $VEZ, a kozzetett cim $KOZZ:$PORT"

# 3. the runner network's subnet, as Docker gave it (measured, kept): a /24, the service at .10
ki=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' gpt-futtato-ki 2>/dev/null | xargs || true)
[ -n "$ki" ] || ki=$(sed -n 's/^GPT_FUTTATO_KI_ALHALO=//p' "$ENVF" | tail -1)
[[ "$ki" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.0/24$ ]] || stop "a gpt-futtato-ki alhalozata nem /24 (vagy nincs): '$ki'; a rogzitett cimhez kezzel kell donteni"
pre="${BASH_REMATCH[1]}"
SZOLGA="$pre.10"
echo "a futtato halozata: $ki; a szolgaltatas rogzitett cime: $SZOLGA:$PORT"

# 4. the token: in the fleet's store, owned like the dashboard's own token, 0600, never printed;
# the runner gets only its SHA-256
[ -f "$FLEET_STORE/.dashboard-token" ] || stop "nincs $FLEET_STORE/.dashboard-token (a tulajdonosat masolnank)"
owner=$(stat -c '%u:%g' "$FLEET_STORE/.dashboard-token")
if [ ! -s "$TOKEN_FILE" ]; then
  ( umask 077
    head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$TOKEN_FILE.uj" )
  chown "$owner" "$TOKEN_FILE.uj"
  chmod 600 "$TOKEN_FILE.uj"
  mv "$TOKEN_FILE.uj" "$TOKEN_FILE"
  echo "uj futtato-token keszult (az erteket ez a lepes nem irja ki)"
fi
grep -qxE '[A-Za-z0-9._~+/=-]{16,512}' "$TOKEN_FILE" || stop "a $TOKEN_FILE tartalma nem token alaku"
HASH=$(tr -d '\n' < "$TOKEN_FILE" | sha256sum | cut -d' ' -f1)
chown "$owner" "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"
stat -c '%a %u:%g %s bajt %n' "$TOKEN_FILE"

# 5. the addresses into the compose project's .env (root, 0600)
set_env GPT_FUTTATO_FLOTTA_KONTENER "$FLOTTA"
set_env GPT_FUTTATO_VEZERLO_CIM "$VEZ"
set_env GPT_FUTTATO_KOZZETETT_CIM "$KOZZ"
set_env GPT_FUTTATO_SZOLGA_CIM "$SZOLGA"
set_env GPT_FUTTATO_KI_ALHALO "$ki"
set_env GPT_FUTTATO_KI_TARTOMANY "$pre.128/25"
set_env GPT_FUTTATO_SZOLGA_TOKEN_SHA256 "$HASH"
chmod 600 "$ENVF"
echo "== $ENVF (a lenyomat nelkul)"
grep -v '^GPT_FUTTATO_SZOLGA_TOKEN_SHA256=' "$ENVF"

# 6. the firewall with the channel, its persistence and the timer, the image, and the probe: the
# installer measures all of these (and that a second run of tuzfal.sh is quiet)
# a service container from an earlier round would keep the runner network from being re-created
(cd "$DIR" && docker compose --profile szolga rm -sf gpt-szolga >/dev/null 2>&1) || true
# what Codex wrote into the runner's volume and the runner does not need, removed here as the
# runner's own user, ONLY these two directories (auth.json is in neither): the plugin cache of the
# remote sync (acrobot 30889) and the built-in skills (acrobot 30902). The probe's PLUGIN and SKILLS
# lines then prove neither comes back after its Codex runs (both are off in the fixed flags).
echo "== a Codex plugin-gyorsitotara es beepitett skilljei a futtato koteten"
(cd "$DIR" && docker compose run --rm --no-deps --entrypoint sh gpt-futtato -c 'for p in /home/gpt/.codex/plugins /home/gpt/.codex/skills/.system; do echo "$p elotte: $(find "$p" -type f 2>/dev/null | wc -l) fajl"; rm -rf -- "$p"; if [ -e "$p" ]; then echo "MEGMARADT: $p"; exit 1; fi; echo "$p utana: a mappa nincs"; done; if [ -f /home/gpt/.codex/auth.json ]; then echo "az auth.json a helyen"; else echo "FIGYELEM: az auth.json nincs a koteten (a torles nem erintette)"; fi') || stop "a plugin-gyorsitotar vagy a beepitett skillek nem torolhetok"
echo "== a tuzfal, a tartossag, az idozito es a proba (telepit-tuzfal.sh)"
bash "$SRC/host/telepit-tuzfal.sh"
# ORDER FIRST, THEN MEASURE (acrobot 30972). Docker re-orders our chains when it creates a network or
# a container: the probe's down/up re-creates gpt-futtato-ki and Docker puts its MASQUERADE at the
# head of nat POSTROUTING; starting gpt-szolga puts its direct-access DROP at the head of raw
# PREROUTING. The per-minute timer fixes that within a minute, but this script must not race it
# (the v5 host run: a 3.7 s cached build, and the check came before the timer). So after every such
# Docker step, the SAME idempotent tuzfal.sh the timer runs puts our rules first, and only then
# are they checked. A check that still fails after it is a real STOP.
rend_es_ellenoriz() {
  echo "== a tuzfal rendezese ($1): ugyanaz a tuzfal.sh, amit a percenkenti idozito futtat"
  bash "$DIR/tuzfal.sh" || stop "a tuzfal.sh rendezo futasa elbukott ($1)"
  # the chain is read ONCE into a variable, then searched: `iptables -S | grep -q` under pipefail
  # fails when grep stops early and iptables gets SIGPIPE (a false STOP; measured in the tests)
  be=$(iptables -w 5 -S GPTF-BE)
  printf '%s\n' "$be"
  grep -qxF -- "-A GPTF-BE ! -s $VEZ/32 -m conntrack --ctstate NEW -j DROP" <<< "$be" || stop "a GPTF-BE lanc nem a $VEZ forrasra szukit"
  grep -qxF -- "-A GPTF-BE ! -d $SZOLGA/32 -m conntrack --ctstate NEW -j DROP" <<< "$be" || stop "a GPTF-BE lanc nem a $SZOLGA celra szukit"
  # the one flow past Docker's isolation (barracuda, #148), both ways, exactly as tuzfal.sh writes it
  tovabb=$(iptables -w 5 -S GPTF-TOVABB)
  printf '%s\n' "$tovabb"
  grep -qxF -- "-A GPTF-TOVABB -s $VEZ/32 -d $SZOLGA/32 -o gptki0 -p tcp -m tcp --dport $PORT -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT" <<< "$tovabb" || stop "a GPTF-TOVABB-ban nincs meg a csatorna oda-iranyu ACCEPT-je"
  grep -qxF -- "-A GPTF-TOVABB -s $SZOLGA/32 -d $VEZ/32 -i gptki0 -p tcp -m tcp --sport $PORT -m conntrack --ctstate ESTABLISHED -j ACCEPT" <<< "$tovabb" || stop "a GPTF-TOVABB-ban nincs meg a csatorna valasz-iranyu ACCEPT-je"
  # the channel flow is not masqueraded (the v3 host run: Docker's MASQUERADE made the source the
  # runner network's gateway); our chain must be FIRST in nat POSTROUTING, before Docker's
  natpost=$(iptables -w 5 -t nat -S POSTROUTING)
  natch=$(iptables -w 5 -t nat -S GPTF-NAT)
  printf '%s\n' "$natch"
  [ "$(grep -m1 '^-A ' <<< "$natpost" || true)" = "-A POSTROUTING -o gptki0 -j GPTF-NAT" ] || stop "a nat POSTROUTING elso szabalya nem a GPTF-NAT ugras"
  grep -qxF -- "-A GPTF-NAT -s $VEZ/32 -d $SZOLGA/32 -p tcp -m tcp --dport $PORT -j ACCEPT" <<< "$natch" || stop "a GPTF-NAT-ban nincs meg a csatorna (maszkolas nelkuli) szabalya"
  # the reply past Docker's raw direct-access guard (the v4 host run: the SYN-ACK to the fleet
  # container's address came in on gptki0 and was dropped there); our chain FIRST in raw PREROUTING
  rawpre=$(iptables -w 5 -t raw -S PREROUTING)
  rawch=$(iptables -w 5 -t raw -S GPTF-RAW)
  printf '%s\n' "$rawch"
  [ "$(grep -m1 '^-A ' <<< "$rawpre" || true)" = "-A PREROUTING -i gptki0 -j GPTF-RAW" ] || stop "a raw PREROUTING elso szabalya nem a GPTF-RAW ugras"
  grep -qxF -- "-A GPTF-RAW -s $SZOLGA/32 -d $VEZ/32 -p tcp -m tcp --sport $PORT -j ACCEPT" <<< "$rawch" || stop "a GPTF-RAW-ban nincs meg a csatorna valaszanak szabalya"
}
rend_es_ellenoriz "a proba down/up utan"
fails=$( { grep -E '^PROBA [^ ]+ FAIL' "$DIR/proba-teljes.log" || true; } | wc -l | tr -d ' ')
grep -qE '^PROBA N1 OK' "$DIR/proba-teljes.log" || stop "a proba N1 sora nem OK (a futtatobol elerheto lehet a flotta vagy a gep)"
[ "$fails" = 0 ] || stop "a probaban $fails FAIL sor van"

# 7. the service, on its fixed address only
echo "== a szolgaltatas"
cd "$DIR"
docker compose --profile szolga up -d gpt-szolga
ok=""
for _ in $(seq 1 30); do
  naplo=$(docker logs gpt-szolga 2>&1 || true)
  if grep -qxF "SZOLGA figyel $SZOLGA:$PORT" <<< "$naplo"; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || { { docker logs gpt-szolga 2>&1 || true; } | tail -20; stop "a szolgaltatas nem indult el a $SZOLGA:$PORT cimen"; }
echo "a szolgaltatas figyel: $SZOLGA:$PORT"
# starting the container re-ordered raw PREROUTING (Docker's DROP for its address at the head):
# order again, check again, and only then measure
rend_es_ellenoriz "a gpt-szolga inditasa utan"

# 8. THE measurement the design stands on: the source address the service sees
echo "== a forrascim, amit a szolgaltatas lat (a flotta kontenerebol hivva)"
forras=$(docker exec "$FLOTTA" node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(j=>console.log(j.forras)).catch(e=>console.log("HIBA "+e.message))' "http://$KOZZ:$PORT/health")
echo "a szolgaltatas ezt latta: $forras"
# read first, then searched: with no FORRAS line (a timed-out call) a `grep | tail` under pipefail
# stopped the script HERE and hid the real step's message (the v4 host run)
szolganaplo=$(docker logs gpt-szolga 2>&1 || true)
{ grep '^FORRAS ' <<< "$szolganaplo" || echo "(a szolgaltatas naplojaban nincs FORRAS sor: a hivas nem ert el hozza)"; } | tail -3
[ "$forras" = "$VEZ" ] || stop "a futtato nem a flotta kontener cimet ($VEZ) latta, hanem: $forras. A forras-szures igy nem azt szuri, amit hiszunk."

# 9. negative controls in the SAME round, each with its own positive control from the same place
echo "== negativ kontroll: egy masik kontener a $NET halozaton"
masik() { docker run --rm --network "$NET" --user 10002:10002 --cap-drop ALL --read-only --security-opt no-new-privileges:true --entrypoint node gpt-futtato:local -e "$CONNECT_JS" "$1" "$2"; }
k1=$(masik "$VEZ" 3420); n1=$(masik "$KOZZ" "$PORT"); n2=$(masik "$SZOLGA" "$PORT")
echo "kontroll: a flotta sajat portja ($VEZ:3420): $k1"
echo "a kozzetett port ($KOZZ:$PORT): $n1"
echo "a szolgaltatas cime ($SZOLGA:$PORT): $n2 (ezt a Docker sajat raw-orzoje is zarja: NEM a mi GPTF-BE-nket bizonyitja, azt a kozzetett port sora meri)"
[ "$k1" = NYITOTT ] || stop "a kontroll sem ert el semmit a masik kontenerbol: a negativ eredmeny igy nem bizonyit"
[[ "$n1" == ZART* && "$n2" == ZART* ]] || stop "egy masik kontener a flotta-halon eleri a futtato szolgaltatasat"
# No negative control from the host itself (acrobot 30972/31023, the v6 host run): the host's root
# is not the threat, and from the host even the fleet's own port did not answer (192.168.250.2:3420
# closed), so its "closed" proved nothing. GPTF-GEPROL (OUTPUT) stays; it is just not measured here.

# 10. the timer's view of the fleet address
allapot=$(cat "$ALLAPOT_DIR/cim-allapot" 2>/dev/null || echo "nincs allapot")
echo "== az idozito allapota: $allapot"
[ "$allapot" = rendben ] || stop "a tuzfal szerint a flotta cime nem egyezik: $allapot"

# 11. the service stops: activation is Balázs's separate decision
stop_szolga
echo "== kesz: a csatorna mert, a szolgaltatas leallitva"
echo "a forrascim $VEZ (egyezik); egy masik kontener a flotta-halon: zart (a sajat portja nyitott); a proba N1: OK"
echo "A GPT-oldal KIKAPCSOLVA marad. A bekapcsolas (kulon jovahagyas, es a 2. PR szuroi nelkul hatastalan):"
echo "  a szolgaltatas: cd $DIR && docker compose --profile szolga up -d gpt-szolga"
echo "  a dashboard: DEBATE_GPT_RUNNER_URL=http://$KOZZ:$PORT es DEBATE_GPT_RUNNER_ENABLED=on"
