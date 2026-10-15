#!/bin/bash
# Activates the debate channel's runner service (gpt-szolga) PERMANENTLY (task
# t-20261014-gpt-futtato-kontener; acrobot 31023). ON THE HOST, AS ROOT, ONLY ON BALÁZS'S APPROVAL.
# Run it after csatorna.sh has set the channel up and measured it (the v6 host run).
#
# It touches nothing in the fleet: it PRINTS what the fleet side must set (DEBATE_GPT_RUNNER_* and
# the debate threads), and setting that is acrobot's or Balázs's step. Any failed check stops it,
# and a stop after the service was enabled disables it again (the channel stays closed).
#   1. preconditions: the channel's addresses and token hash in .env; the fleet store's token file
#      whose SHA-256 is that hash (the dashboard and the runner hold the same token); the host
#      firewall unit and its timer active; the Codex login in the runner's volume; the fleet address
#      state "rendben"
#   2. gpt-szolga.service installed and enabled (systemd starts it after the firewall; see the unit)
#   3. the service listens on its fixed address; the firewall ordered again (Docker re-orders on a
#      container start); the source address the service sees is the fleet container's
#   4. the state, the restart policy ("no": only systemd starts it), and the fleet-side settings
set -euo pipefail
DIR="${GPT_FUTTATO_DIR:-/opt/gpt-futtato}"
SRC="$DIR/src/gpt-runner"
ENVF="$DIR/.env"
FLEET_STORE="${GPT_FUTTATO_FLOTTA_STORE:-/opt/marveen-docker/data/marveen/store}"
TOKEN_FILE="$FLEET_STORE/.gpt-futtato-token"
UNIT_DIR="${GPT_FUTTATO_UNIT_DIR:-/etc/systemd/system}"
ALLAPOT_DIR="${GPT_FUTTATO_ALLAPOT_DIR:-/run/gpt-futtato}"
PORT=8790
ENABLED=""

stop() {
  echo "STOP: $*"
  if [ -n "$ENABLED" ]; then
    systemctl disable --now gpt-szolga.service >/dev/null 2>&1 || true
    echo "a gpt-szolga.service letiltva es leallitva: a csatorna zarva maradt"
  fi
  exit 1
}
trap 'stop "az aktivalo szkript a(z) $LINENO. sorban megallt ennel a parancsnal: $BASH_COMMAND"' ERR
envval() { sed -n "s/^$1=\\([0-9a-f.]*\\)\$/\\1/p" "$ENVF" | tail -1; }
ipv4() {
  local IFS=. o
  [[ "${1:-}" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  for o in $1; do [ "$o" -le 255 ] || return 1; done
}

# 1. preconditions
echo "== elofeltetelek"
[ -r "$ENVF" ] || stop "nincs $ENVF: elobb a csatorna.sh"
VEZ=$(envval GPT_FUTTATO_VEZERLO_CIM); KOZZ=$(envval GPT_FUTTATO_KOZZETETT_CIM); SZOLGA=$(envval GPT_FUTTATO_SZOLGA_CIM)
HASH=$(envval GPT_FUTTATO_SZOLGA_TOKEN_SHA256)
FLOTTA=$(sed -n 's/^GPT_FUTTATO_FLOTTA_KONTENER=\([A-Za-z0-9_.-]*\)$/\1/p' "$ENVF" | tail -1)
ipv4 "$VEZ" && ipv4 "$KOZZ" && ipv4 "$SZOLGA" || stop "a csatorna cimei nincsenek (ervenyesen) a $ENVF-ben: elobb a csatorna.sh"
[[ "$HASH" =~ ^[0-9a-f]{64}$ ]] || stop "nincs a token lenyomata a $ENVF-ben"
[ -n "$FLOTTA" ] || stop "nincs GPT_FUTTATO_FLOTTA_KONTENER a $ENVF-ben"
[ -s "$TOKEN_FILE" ] || stop "nincs futtato-token a flotta store-jaban ($TOKEN_FILE)"
[ "$(stat -c '%a' "$TOKEN_FILE")" = 600 ] || stop "a $TOKEN_FILE joga nem 600"
[ "$(tr -d '\n' < "$TOKEN_FILE" | sha256sum | cut -d' ' -f1)" = "$HASH" ] || stop "a flotta tokenjenek lenyomata nem egyezik a futtatoeval (az erteket nem irom ki)"
echo "a token: a flotta es a futtato ugyanazt tartja (lenyomat egyezik), 600"
systemctl is-active --quiet gpt-futtato-tuzfal.service || stop "a gpt-futtato-tuzfal.service nem aktiv"
systemctl is-active --quiet gpt-futtato-tuzfal-ellenor.timer || stop "a percenkenti tuzfal-ellenorzo nem aktiv"
DOCKER_BIN="${GPT_FUTTATO_DOCKER_BIN:-/usr/bin/docker}"
[ "$(command -v docker || true)" = "$DOCKER_BIN" ] || stop "a docker nem a $DOCKER_BIN (a unit ezt az utat hivja)"
(cd "$DIR" && docker compose run --rm --no-deps --entrypoint sh gpt-futtato -c 'test -f /home/gpt/.codex/auth.json') || stop "nincs Codex-belepes a futtato koteten"
bash "$DIR/tuzfal.sh" || stop "a tuzfal.sh rendezo futasa elbukott"
allapot=$(cat "$ALLAPOT_DIR/cim-allapot" 2>/dev/null || echo "nincs allapot")
[ "$allapot" = rendben ] || stop "a tuzfal szerint a flotta cime nem egyezik: $allapot"
echo "a host-tuzfal es az idozito aktiv, a flotta cime rendben, a belepes a koteten"

# 2. the unit, after the firewall
echo "== a gpt-szolga.service"
install -o root -g root -m 644 "$SRC/host/gpt-szolga.service" "$UNIT_DIR/gpt-szolga.service"
systemctl daemon-reload
ENABLED=1
systemctl enable --now gpt-szolga.service

# 3. listening, ordered, and the source the service sees
ok=""
for _ in $(seq 1 60); do
  naplo=$(docker logs gpt-szolga 2>&1 || true)
  if grep -qxF "SZOLGA figyel $SZOLGA:$PORT" <<< "$naplo"; then ok=1; break; fi
  sleep 1
done
[ -n "$ok" ] || stop "a szolgaltatas 60 mp alatt nem figyel a $SZOLGA:$PORT cimen"
# starting the container re-ordered raw PREROUTING (Docker's DROP at the head): order first
bash "$DIR/tuzfal.sh" || stop "a tuzfal.sh rendezo futasa elbukott a szolgaltatas inditasa utan"
forras=$(docker exec "$FLOTTA" node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(8000)}).then(r=>r.json()).then(j=>console.log(j.forras)).catch(e=>console.log("HIBA "+e.message))' "http://$KOZZ:$PORT/health")
echo "a szolgaltatas ezt latta: $forras"
[ "$forras" = "$VEZ" ] || stop "a futtato nem a flotta kontener cimet ($VEZ) latta, hanem: $forras"

# 4. the state and the fleet side
echo "== allapot"
echo "gpt-szolga.service: $(systemctl is-enabled gpt-szolga.service), $(systemctl is-active gpt-szolga.service)"
echo "a kontener ujrainditasi szabalya: $(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' gpt-szolga) (csak a systemd inditja, a tuzfal utan)"
cat <<EOF
== a flotta oldalan (acrobot vagy Balazs allitja be; ez a szkript NEM)
  DEBATE_GPT_RUNNER_ENABLED=on
  DEBATE_GPT_RUNNER_URL=http://$KOZZ:$PORT
  DEBATE_GPT_RUNNER_TOKEN_FILE: az alapertelmezett store/.gpt-futtato-token (megvan, a lenyomata egyezik)
  DEBATE_DISCORD_THREADS=<a vita-szalak chat_id-jai, vesszovel>   (enelkul a vezerlo nem fut)
  DEBATE_OWNER_IDS=<Balazs Discord-azonositoja>                    (ha ures, a jovahagyasi ut felhasznaloi)
  helye: a flotta .env-je vagy store/config-overrides.json; utana a dashboard ujrainditasa:
    cd /opt/marveen-docker && docker compose exec -u marveen marveen supervisorctl restart dashboard
== visszavonas
  systemctl disable --now gpt-szolga.service, es a flotta oldalan DEBATE_GPT_RUNNER_ENABLED=off
EOF
