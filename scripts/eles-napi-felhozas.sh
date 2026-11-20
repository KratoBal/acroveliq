#!/usr/bin/env bash
# ANSWERS: Felment-e ma hajnalban az eles Acropora OS (api, web, partner) arra a commitra, ami a
# teszten fut, es ha nem, MI allitotta meg?
#
# MIERT LETEZIK: Balazs 2026-11-20 08:03 UTC (fo csatorna, msg 1573247325801812019), szo szerint:
# "holnap hajnaltol amikor jonak latod automatikusan legyen az eles felhozva minden nap".
# Eddig az eles kezzel ment, es rendszeresen 30-40 commitot csuszott (11-10: 33, 11-20: 39).
#
# MIT VISZ KI: PONTOSAN a teszt API /health commitjat (S), nem a fo ag fejet. A Coolify /deploy a
# fo ag fejet epiti, ezert a harom eles alkalmazast elobb S-re rogziti (git_commit_sha), a vegen
# visszaallitja HEAD-re. Igy az megy ki, amit a teszten mar futtattunk.
#
# A COMMERCE NEM: az eles commerce telepitese Balazs kulon szavara megy (2026-11-01: "Egyelore teszt").
#
# KAPUK (barmelyik bukik: NEM telepit, uzen acrobotnak, a napi naplo egy sort kap):
#   1. a teszt API el, a commitja S; az eles API commitja P; S a P utodja (compare: ahead, behind 0)
#   2. S-en minden check-run sikeres (a beolvasztaskor barracuda APPROVE mar kotelezo, pr-beolvaszt.sh)
#   0. a teszt web ugyanarra a commitra all, mint a teszt API (a web /health commit mezoje). A szkript
#      S-t viszi ki MINDHAROM eles alkalmazasra, tehat egy csak-webes teszt telepites (vagy egy, ami a
#      weben elbukott) nem jutna ki, illetve olyan web menne ki, amit a teszten senki nem latott.
#      Ha a teszt web nem mondja meg a commitjat (RELEASE_COMMIT_SHA nincs a kornyezeteben), az is megallas.
#   3. a P..S kozotti migraciok csak bovitok (scripts/lib/migracio_kapu.py, ott a szabalyok es hogy miert);
#      egy mar meglevo migracios fajl modositasa vagy torlese is megallas (ezeket ember nezi meg)
#   (az eles lemezt ez a szkript NEM meri: a flotta ssh-ja az eles gepen csak docker ps-t futtathat;
#    a lemez-figyeles kulon utemezes)
# Utana: api -> varja a finished allapotot es az eles /health commit = S; csak akkor web es partner.
#
# Hasznalat:  eles-napi-felhozas.sh          (eles futas)
#             eles-napi-felhozas.sh --nez    (csak a kapukat meri, nem telepit)
set -uo pipefail

ROOT=/home/marveen/marveen
HERE=$(dirname "$(readlink -f "$0")")
NEZ=0; [ "${1:-}" = "--nez" ] && NEZ=1
COOLIFY=http://162.55.216.28:8000/api/v1
TOKFILE=$ROOT/store/.coolify-token-prod-rw
REPO=KratoBal/acropora-os
API_UUID=t9gxx94ecwekwruxngps5i6v
WEB_UUID=dnt6jzza68wnuamvi93whn28
PARTNER_UUID=iknrqjk9xeyydc5fibrk5tbp
# the test points these at a local stand-in; the cron runs with the defaults
TESZT_API=${ELES_FELHOZAS_TESZT_API:-https://api-staging.acropora.hu}
TESZT_WEB=${ELES_FELHOZAS_TESZT_WEB:-https://staging.acropora.hu}
ELES_API=${ELES_FELHOZAS_ELES_API:-https://api.acropora.hu}
LOG=${ELES_FELHOZAS_LOG:-$ROOT/store/eles-napi-felhozas.log}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
stop() {
  say "MEGALLT: $*"
  if [ "$NEZ" = 0 ]; then
    printf '%s\n' "[ELES-FELHOZAS] Ma nem ment ki az eles OS. Ok: $*  Naplo: store/eles-napi-felhozas.log" > "$WORK/msg.txt"
    bash $ROOT/scripts/agent-msg.sh acrobot acrobot - < "$WORK/msg.txt" >/dev/null 2>&1
    bash $ROOT/scripts/daily-log.sh acrobot "Eles napi felhozas" "MEGALLT: $*" >/dev/null 2>&1
  fi
  exit 1
}
coolify() { curl -s --max-time 30 -H "Authorization: Bearer $(cat "$TOKFILE")" "$@"; }
health_commit() {
  curl -s --max-time 20 "$1/health" | python3 -c "import json,sys
try: print(json.load(sys.stdin)['application']['commit'] or '')
except Exception: print('')"
}

S=$(health_commit "$TESZT_API")
P=$(health_commit "$ELES_API")
[ -n "$S" ] || stop "a teszt API /health nem adott commitot"
[ -n "$P" ] || stop "az eles API /health nem adott commitot"
say "teszt S=${S:0:12} eles P=${P:0:12}"
if [ "$S" = "$P" ]; then say "nincs mit felhozni (az eles = a teszt)"; exit 0; fi

W=$(health_commit "$TESZT_WEB")
[ -n "$W" ] || stop "a teszt web /health nem mondja meg a commitjat (RELEASE_COMMIT_SHA nincs a kornyezeteben), igy nem tudni, hogy a web is ${S:0:12}-n all"
[ "$W" = "$S" ] || stop "a teszt web commitja ${W:0:12}, a teszt API-e ${S:0:12}: a ket teszt alkalmazas nem ugyanazt futtatja"

GH=$(. $ROOT/scripts/lib/github-token.sh && github_token $REPO olvas)
[ -n "$GH" ] || stop "nincs GitHub olvaso token"
gh() { curl -s --max-time 30 -H "Authorization: Bearer $GH" -H "Accept: application/vnd.github+json" "$@"; }

gh "https://api.github.com/repos/$REPO/compare/$P...$S?per_page=100" > "$WORK/cmp.json"
read -r STATUS AHEAD BEHIND NFILES < <(python3 -c "import json
d=json.load(open('$WORK/cmp.json')); print(d.get('status'), d.get('ahead_by'), d.get('behind_by'), len(d.get('files') or []))")
[ "$STATUS" = ahead ] && [ "$BEHIND" = 0 ] || stop "a teszt commitja nem az eles utodja (status=$STATUS, behind=$BEHIND)"
[ "$NFILES" -lt 300 ] || stop "a compare $NFILES fajlt adott, a GitHub 300-nal vag: a migracio-kapu nem latna mindent"

gh "https://api.github.com/repos/$REPO/commits/$S/check-runs?per_page=100" > "$WORK/cr.json"
BAD=$(python3 -c "import json
d=json.load(open('$WORK/cr.json')); r=d.get('check_runs') or []
latest={}
for c in r:
  n=c['name']
  if n not in latest or (c.get('started_at') or '')>(latest[n].get('started_at') or ''): latest[n]=c
bad=[n+':'+str(c.get('conclusion')) for n,c in latest.items() if c.get('conclusion') not in ('success','skipped','neutral')]
print('NINCS-FUTAS' if not latest else ' '.join(bad))")
[ -z "$BAD" ] || stop "a CI nem zold a $S commiton: $BAD"

python3 -c "import json
d=json.load(open('$WORK/cmp.json'))
for f in d['files']:
  if '/prisma/migrations/' in f['filename'] and f['filename'].endswith('.sql'): print(f['status'], f['filename'])" > "$WORK/mig-all.txt"
# an applied migration that changed or went away: prod already ran the old text, a person decides
CHANGED=$(grep -v '^added ' "$WORK/mig-all.txt" | head -3 | tr '\n' ' ')
[ -z "$CHANGED" ] || stop "egy mar letezo migracios fajl valtozott, ember nezze meg: $CHANGED"
sed 's/^added //' "$WORK/mig-all.txt" > "$WORK/mig.txt"
NMIG=$(wc -l < "$WORK/mig.txt")
while read -r m; do
  [ -n "$m" ] || continue
  gh -H "Accept: application/vnd.github.raw" "https://api.github.com/repos/$REPO/contents/$m?ref=$S" > "$WORK/m.sql"
  [ -s "$WORK/m.sql" ] || stop "a migracio nem olvashato: $m"
  python3 -B "$HERE/lib/migracio_kapu.py" "$WORK/m.sql" > "$WORK/hit.txt" 2>&1
  RC=$?
  [ "$RC" = 0 ] || stop "nem bovito migracio, ember nezze meg: $m :: $(head -3 "$WORK/hit.txt" | sed "s#^$WORK/m.sql: ##" | tr '\n' ' ')"
done < "$WORK/mig.txt"
say "kapuk rendben: $AHEAD commit, $NFILES fajl, $NMIG migracio (mind bovito), CI zold"


if [ "$NEZ" = 1 ]; then say "--nez: itt telepitene ${S:0:12}-t (api, web, partner)"; exit 0; fi

pin() { coolify -X PATCH -H 'Content-Type: application/json' -d "{\"git_commit_sha\":\"$2\"}" "$COOLIFY/applications/$1" >/dev/null; }
unpin_all() { for u in $API_UUID $WEB_UUID $PARTNER_UUID; do pin "$u" HEAD; done; }
deploy_wait() {
  local dep st i
  dep=$(coolify -X POST "$COOLIFY/deploy?uuid=$1" | python3 -c "import json,sys
try: print(json.load(sys.stdin)['deployments'][0]['deployment_uuid'])
except Exception: print('')")
  [ -n "$dep" ] || { echo "nincs deployment azonosito"; return 1; }
  for i in $(seq 1 90); do
    st=$(coolify "$COOLIFY/deployments/$dep" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('status'))
except Exception: print('')")
    case "$st" in finished) echo "$dep finished"; return 0;; failed|cancelled*) echo "$dep $st"; return 1;; esac
    sleep 20
  done
  echo "$dep idotullepes ($st)"; return 1
}

for u in $API_UUID $WEB_UUID $PARTNER_UUID; do pin "$u" "$S"; done
R=$(deploy_wait $API_UUID) || { unpin_all; stop "az eles API telepitese: $R (a Coolify a regi kontenert hagyja futni)"; }
say "api: $R"
NOW=$(health_commit https://api.acropora.hu)
[ "$NOW" = "$S" ] || { unpin_all; stop "az API telepites utan az eles /health commit ${NOW:0:12}, nem ${S:0:12}"; }
R=$(deploy_wait $WEB_UUID) || { unpin_all; stop "az eles web telepitese: $R (az API mar ${S:0:12})"; }
say "web: $R"
R=$(deploy_wait $PARTNER_UUID) || { unpin_all; stop "az eles partner telepitese: $R (az API es a web mar ${S:0:12})"; }
say "partner: $R"
unpin_all
say "KESZ: az eles OS ${P:0:12} -> ${S:0:12} ($AHEAD commit, $NMIG migracio)"
bash $ROOT/scripts/daily-log.sh acrobot "Eles napi felhozas" "Kesz: az eles OS (api, web, partner) ${P:0:12} -> ${S:0:12}, $AHEAD commit, $NMIG bovito migracio. A commerce nem resze." >/dev/null 2>&1
exit 0
