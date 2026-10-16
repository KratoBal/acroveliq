#!/usr/bin/env bash
# ANSWERS: Melyik gepen mi fut, elve: mindket Coolify (eles es AI gep) alkalmazasai es adatbazisai, plusz a telepitesi mod.
# infra-allapot.sh -- what exists, on which machine, and what state it is in.
#
# WHY THIS EXISTS, measured 2026-09-01 14:51: asked whether a change had reached
# staging, I read the PRODUCTION Coolify, saw "api-staging exited", and reported a
# dead staging. Staging is a different machine and was healthy. Worse, I then wrote
# a fresh inventory document without checking that one had been measured the evening
# before -- so the answer existed twice and I had consulted neither.
#
# The failure was never missing data. It was that the data was not reachable in the
# second when the question arrived. A document nobody opens is not an answer; a
# command is. This prints the live state of BOTH machines and names the written
# record, so the two arrive together and cannot drift apart in the reader's head.
#
#   bash /home/marveen/marveen/scripts/infra-allapot.sh
#
# Read-only: it lists, it never deploys, starts or stops anything.
set -uo pipefail

INSTALL_DIR=/home/marveen/marveen

echo "=========================================================================="
echo " AZ IRAS, AMI EZT LEIRJA (eloszor ezt nyisd meg, ne ebbol kovetkeztess):"
echo "   exchange/ATVILAGITAS-eles-es-teszt-2026-08-31.md   -- a ket gep, merve"
echo "   docs/INFRA-LELTAR-2026-09-01.md                    -- a SZANDEK oszlop"
echo "=========================================================================="

show() {
  local label="$1" host="$2" tokenfile="$3"
  echo
  echo "===== $label ($host) ====="
  if [[ ! -r "$tokenfile" ]]; then
    echo "  NEM OLVASHATO a token: $tokenfile"
    return 1
  fi
  local token
  token="$(cat "$tokenfile")"
  local endpoint
  for endpoint in applications databases services; do
    echo "  --- $endpoint ---"
    curl -s -m 20 -H @<(printf 'Authorization: Bearer %s\n' "$token") "$host/api/v1/$endpoint" \
      | AC_EP="$endpoint" python3 -c '
import json, os, sys
ep = os.environ["AC_EP"]
try:
    data = json.load(sys.stdin)
except Exception:
    print("      a valasz nem JSON -- a felulet elerheto egyaltalan?")
    sys.exit(0)
if isinstance(data, dict):
    print("      %s" % str(data)[:120])
    sys.exit(0)
if not data:
    print("      (egy sem)")
    sys.exit(0)
for item in data:
    print("      %-34s %-20s %s" % (
        item.get("name") or "?",
        item.get("status") or "?",
        item.get("fqdn") or item.get("database_type") or "",
    ))
'
  done
}

# B20 (2026-10-16): coolify.acropora.hu is closed to the public; the fleet shares the host,
# so it reaches Coolify on the gateway. A fixed constant: a secret's target is not env-settable.
COOLIFY_PROD_URL="http://10.0.1.1:8000"
show "ELES GEP" "$COOLIFY_PROD_URL" "$INSTALL_DIR/store/.coolify-token-prod"
# B20b (2026-10-16): the AI machine's Coolify (coolify2) is closed to the public, only its
# /webhooks/ path stays; on the tailnet the fleet (tag:prod) may not reach its :8000. So the
# public name is asked once, and a refusal is said in words, not as an empty or broken section.
AI_COOLIFY_URL="https://coolify2.acropora.hu"
ai_coolify_elerheto() {
  [[ "$(/usr/bin/curl -s -o /dev/null -m 10 -w '%{http_code}' "$AI_COOLIFY_URL/api/health")" == 200 ]]
}
AI_ZART="  a coolify2 a flottabol nem erheto el (B20b: csak a tailneten, a 8000 a flottanak tiltott).
  Az AI gep alkalmazasait Balazs a tailnetrol latja; telepites a vegrehajton at: scripts/vegrehajto.sh"
if ai_coolify_elerheto; then
  show "AI GEP -- ITT VAN A VALODI STAGING" "$AI_COOLIFY_URL" "$INSTALL_DIR/store/.coolify-token-ai"
else
  echo; echo "===== AI GEP ($AI_COOLIFY_URL) ====="; echo "$AI_ZART"
fi

echo
echo "=========================================================================="
echo " TELEPITESI MOD -- MERVE, NEM A DOKUMENTUMBOL ATVEVE."
echo
echo " MIERT LETT MERES (2026-09-18 12:47): itt korabban HAROM SOR allt, szo"
echo " szerint az ATVILAGITAS 10. es 14.g szakaszabol masolva, es mind a harom"
echo " azt mondta, hogy MANUAL ONLY. Ugyanaz a szakasz NYITOTT PONTKENT nevezte"
echo " meg, hogy ha az auto-deploy valaha visszakerul egy eles alkalmazasra,"
echo " akkor egy beolvasztas azonnal telepit, proba nelkul."
echo
echo " ES PONTOSAN EZ TORTENT, csak nem ugy, ahogy a mondat varta: az"
echo " acropora-partner (ticket.acropora.hu) NEM visszakapta az automatikat,"
echo " hanem UGY SZULETETT 2026-09-17-en -- a Coolify alapertelmezese a"
echo " bekapcsolt allapot. A lap tovabbra is MANUAL ONLY-t allitott volna rola,"
echo " mert azt a harom nevet sorolta fel, amelyek 09-01-en leteztek."
echo
echo " EGY UJ ALKALMAZAS TEHAT NEM CSAK KIMARAD A LISTABOL: a lista allitasa"
echo " VALTOZATLANUL IGAZNAK LATSZIK mellette. Ezert all itt lekerdezes."
echo
mod() {
  local label="$1" host="$2" tokenfile="$3"
  echo " --- $label ---"
  if [[ ! -r "$tokenfile" ]]; then
    echo "     NEM OLVASHATO a token: $tokenfile"
    return 1
  fi
  local token uuid
  token="$(cat "$tokenfile")"
  for uuid in $(curl -s -m 20 -H @<(printf 'Authorization: Bearer %s\n' "$token") "$host/api/v1/applications" \
      | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: d=[]
for a in d if isinstance(d,list) else []:
    if a.get("uuid"): print(a["uuid"])'); do
    curl -s -m 20 -H @<(printf 'Authorization: Bearer %s\n' "$token") "$host/api/v1/applications/$uuid" \
      | python3 -c 'import json,sys
try: a=json.load(sys.stdin)
except Exception: sys.exit(0)
s=a.get("settings") or {}
v=s.get("is_auto_deploy_enabled")
mode="AUTOMATIKUS" if v is True else ("kezi" if v is False else "NEM MERHETO")
print("     %-30s %-12s %s" % (a.get("name") or "?", mode, a.get("fqdn") or ""))'
  done
}
mod "ELES GEP" "$COOLIFY_PROD_URL" "$INSTALL_DIR/store/.coolify-token-prod"
if ai_coolify_elerheto; then
  mod "AI GEP (teszt)" "$AI_COOLIFY_URL" "$INSTALL_DIR/store/.coolify-token-ai"
else
  echo " --- AI GEP (teszt) ---"; echo "$AI_ZART"
fi
echo
echo " AMIT EZ A LEKERDEZES NEM MER: a GitHub App tovabbra is az ELES gep"
echo " Coolify-jara mutat, tehat a kapcsolat adott. Az 'AUTOMATIKUS' sor azt"
echo " jelenti, hogy azon az alkalmazason egy beolvasztas a fo agba KIMEGY az"
echo " elesre, jovahagyas nelkul."
echo "=========================================================================="
echo
echo "FIGYELEM: az 'exited' allapot ONMAGABAN nem hiba. Harom szolgaltatas az eles"
echo "gepen SZANDEKOSAN all 2026-08-31 ota. Mielott barmelyikre azt mondanad, hogy"
echo "elszallt, nezd meg a szandek oszlopot a fenti lapon."
