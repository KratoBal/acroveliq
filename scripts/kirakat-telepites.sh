#!/usr/bin/env bash
# ANSWERS: Kiment-e a teszt kirakat telepitese, es ha NEM, MIERT nem (a Coolify sajat naplojabol).
#
# === MIERT LETEZIK (sajat meres, 2026-09-14 12:19) ===
#
# A PR 368 beolvasztasa utan huszonot percig nem tortent semmi. Vegigmertem, es KET
# kulon csapdaba futottam bele, mindketto ugyanazon a napon:
#
#   1. A `/api/v1/deployments` vegpont URES TOMBOT ad akkor is, amikor EPP AKKOR
#      soroltam be egy telepitest (a valasz maga adta vissza a deployment_uuid-t).
#      Ebbol azt kovetkeztettem, hogy nem fut semmi. HAMIS. A vegpont errol a
#      kerdesrol nem mond semmit -- nem ures a vilag, hanem alkalmatlan a felulet.
#
#   2. A telepites NEM lassu volt, hanem ELBUKOTT, 16 illetve 19 masodperc alatt, es
#      errol SEMMI nem szolt. A hiba a build-helper kontenerben:
#      "ssh: Could not resolve hostname github.com: Try again". A `git ls-remote` MEG
#      sikerult (visszaadta a sha-t), a `clone` mar nem -- vagyis a kimeno halozat
#      reszben mukodott, es ettol a hiba nem is latszott halozatinak.
#
# A NAPLO NEM JON AZ API-N. A `/api/v1/deployments/<uuid>` allapotot mond (queued,
# in_progress, finished, failed), de `logs` mezot nem ad. A naplo a Coolify sajat
# adatbazisaban all, es CSAK a gepen olvashato:
#   application_deployment_queues.logs, JSON tomb, soronkent {command, output, type}
#
# === HASZNALAT ===
#
#   cd /home/marveen/marveen && bash scripts/kirakat-telepites.sh allapot
#       az utolso ot telepites: uuid, allapot, ki inditotta (api vagy webhook), ido
#
#   cd /home/marveen/marveen && bash scripts/kirakat-telepites.sh naplo <uuid>
#       EGY telepites naploja: minden hibasor plusz a lathato lepesek. A rejtett
#       stdout (hosszu docker parancsok) marad kint, a rejtett STDERR nem -- a
#       valodi hibauzenet ugyanis abban all, lasd a szuro melletti indoklast
#
#   cd /home/marveen/marveen && bash scripts/kirakat-telepites.sh indit
#       telepitest indit, es kiirja az uj uuid-t (nem var ra: az `allapot` mondja meg)
#
# AMIT SZANDEKOSAN NEM CSINAL: nem var a vegere es nem ismetel automatikusan. Egy
# ujraindito ciklus egy tartos hibat (rossz kod, hianyzo valtozo) vegtelenul probalna,
# es a naplo minden koreben ugyanaz allna. A dontes, hogy ujraprobaljunk-e, a hiba
# OLVASASA utan jon.
#
# A HATOKOR: ez a TESZT kirakat (shop-staging.acropora.hu) az AI gepen. Az ELES
# telepites mas gep, mas token, es Balazs esetenkenti engedelyehez kotott.
set -uo pipefail

UUID_APP=6sbolw7oedo5sdffhpswdoyt
COOLIFY=https://coolify2.acropora.hu
TOKEN_FILE=/home/marveen/marveen/store/.coolify-token-ai
SSH_KEY=/home/marveen/.ssh/id_ed25519_acropora_monitor
GEP=fleet@100.88.199.87

[ -r "$TOKEN_FILE" ] || { echo "FAIL: nincs olvashato Coolify token: $TOKEN_FILE" >&2; exit 1; }

api() { /usr/bin/curl -s -H "Authorization: Bearer $(/bin/cat $TOKEN_FILE)" "$@"; }

case "${1:-allapot}" in
  allapot)
    # fleet-gate (B8): a named read of the Coolify database, the SQL is the gate's
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$GEP" coolify-deployments "$UUID_APP" \
      | python3 -c "
import sys
print('%-26s %-10s %-8s %-20s %s' % ('uuid','allapot','inditva','kezdet (UTC)','vege'))
for sor in sys.stdin:
    r = sor.strip().split('|')
    if len(r) < 5: continue
    print('%-26s %-10s %-8s %-20s %s' % tuple(r[:5]))
"
    ;;
  naplo)
    [ -n "${2:-}" ] || { echo "FAIL: kell egy deployment uuid (lasd: allapot)" >&2; exit 2; }
    # the gate takes a 24-character uuid only, and says so if it is not one
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$GEP" coolify-deploy-log "$2" \
      | python3 -c "
import sys, json
nyers = sys.stdin.read().strip()
if not nyers:
    print('nincs ilyen telepites, vagy meg nem irt naplot'); raise SystemExit
for e in json.loads(nyers):
    # A SZURES ALAKJA MERESBOL JON, ES AZ ELSO VALTOZAT ROSSZ VOLT (2026-09-14).
    # Eloszor a hidden sorokat dobtam el, azzal az indoklassal, hogy azok a Coolify
    # hazi parancsai. Visszamerve a bukott telepitesen: a VALODI hibauzenet (a git
    # nem tudta feloldani a github nevet) hidden=True es stderr. A lathato sorok
    # kozott csak az allt, hogy exit code 128 -- vagyis az elso szurom pontosan azt
    # az egy sort vitte el, amiert az eszkoz keszult.
    # EZERT: minden stderr atmegy, hidden-tol fuggetlenul. A hidden stdout sorok
    # (hosszu docker parancsok kimenete) maradnak kint, mert azok tenyleg hazi zaj.
    if e.get('hidden') and e.get('type') != 'stderr': continue
    szoveg = (e.get('output') or '').strip()
    if szoveg: print(szoveg[:400])
"
    ;;
  indit)
    api -X POST "$COOLIFY/api/v1/deploy?uuid=$UUID_APP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
try:
    print('elinditva, uuid:', d['deployments'][0]['deployment_uuid'])
    print('az allapotat a kirakat-telepites.sh allapot parancs mondja meg')
except Exception:
    print('NEM INDULT EL:', json.dumps(d)[:300])
"
    ;;
  *)
    echo "hasznalat: kirakat-telepites.sh [allapot | naplo <uuid> | indit]" >&2
    exit 2
    ;;
esac
