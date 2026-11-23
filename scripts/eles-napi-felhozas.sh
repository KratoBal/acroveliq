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
#   1b. S a fo agon van (compare main...S: behind vagy identical). A teszt neha egy PR-agra van
#      rogzitve egy meresre (2026-11-20, #2724): az is "ahead" es zold lehet, es egy be nem olvadt,
#      review nelkuli PR menne elesre.
#   3. a P..S kozotti migraciok csak bovitok (scripts/lib/migracio_kapu.py, ott a szabalyok es hogy miert);
#      egy mar meglevo migracios fajl modositasa vagy torlese is megallas (ezeket ember nezi meg)
#   4. ELO BOLTBA IRO KAPCSOLO NEM KAPCSOLODHAT BE MAGATOL (acrobot dontese, 2026-11-20, Balazs
#      allo meghatalmazasa alapjan: az eles Medusaba iro kapcsolo csak Balazs szavara kapcsolhato be):
#      a) a P..S tartomanyban a .env.production.example egy kapcsolot true-ra allit (vagy ujat true-val vesz fel);
#      b) az eles API Coolify kornyezeteben uj MEDUSA_/STRIPE_/WEBSHOP_ kulcs van az elfogadott listahoz kepest
#         (store/eles-felhozas/env-kulcsok.txt; csak a NEV kerul bele, az ertek soha);
#      c) az eles adatbazisban az ExternalReference MEDUSA sorainak szama vagy max(lastSyncedAt)-je nott a
#         legutobbi meres ota (store/eles-felhozas/medusa-ref.txt): az eles vetites elindult, Balazs szava kell.
#      Az elfogado lepes a megallas szovegeben all. Ha nincs meg mentett allapot, a szkript most menti, es
#      ezen az egyetlen futason megall (egy --nez futas is menti: az csak helyi fajl, nem telepites).
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
TESZT_API=https://api-staging.acropora.hu
TESZT_WEB=https://staging.acropora.hu
ELES_API=https://api.acropora.hu
ELES_WEB=https://app.acropora.hu
# the production database, read only (psql-ro as fleet_ro), host key pinned to the repo's file
ELES_GEP=fleet@162.55.216.28
ELES_DB=iwm34jaqp9xmwb72qkrqkwhy
SSH_KEY=/home/marveen/.ssh/id_ed25519_acropora_monitor
SSH_PIN=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$HERE/host/known_hosts" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519)
# the test points the log and the saved state at its own folder
LOG=${ELES_FELHOZAS_LOG:-$ROOT/store/eles-napi-felhozas.log}
ALLAPOT=${ELES_FELHOZAS_ALLAPOT:-$ROOT/store/eles-felhozas}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

say() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
stop() {
  say "MEGALLT: $*"
  if [ "$NEZ" = 0 ]; then
    printf '%s\n' "[ELES-FELHOZAS] Ma nem ment ki az eles OS. Ok: $*  Naplo: store/eles-napi-felhozas.log" > "$WORK/msg.txt"
    bash "$HERE/agent-msg.sh" acrobot acrobot - < "$WORK/msg.txt" >/dev/null 2>&1
    bash "$HERE/daily-log.sh" acrobot "Eles napi felhozas" "MEGALLT: $*" >/dev/null 2>&1
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

GH=$(. "$HERE/lib/github-token.sh" && github_token $REPO olvas)
[ -n "$GH" ] || stop "nincs GitHub olvaso token"
gh() { curl -s --max-time 30 -H "Authorization: Bearer $GH" -H "Accept: application/vnd.github+json" "$@"; }

gh "https://api.github.com/repos/$REPO/compare/$P...$S?per_page=100" > "$WORK/cmp.json"
read -r STATUS AHEAD BEHIND NFILES < <(python3 -c "import json
d=json.load(open('$WORK/cmp.json')); print(d.get('status'), d.get('ahead_by'), d.get('behind_by'), len(d.get('files') or []))")
[ "$STATUS" = ahead ] && [ "$BEHIND" = 0 ] || stop "a teszt commitja nem az eles utodja (status=$STATUS, behind=$BEHIND)"
# S MUST BE ON MAIN (acrobot, 2026-11-20 09:34): see 1b above
ONMAIN=$(gh "https://api.github.com/repos/$REPO/compare/main...$S" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('status'))
except Exception: print('olvashatatlan')")
case "$ONMAIN" in behind|identical) ;; *) stop "a teszt commitja ${S:0:12} NINCS a fo agon (compare main...S = $ONMAIN): a teszt egy PR-agra van rogzitve";; esac
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

# 4a. a switch turned on in .env.production.example within P..S (a missing patch is a stop: then it cannot be read)
ONSW=$(python3 -c "import json,re
d=json.load(open('$WORK/cmp.json'))
for f in d['files']:
  if not f['filename'].endswith('.env.production.example'): continue
  if 'patch' not in f: print(f['filename']+': a valtozas nem olvashato (nincs patch)'); continue
  on=lambda sign: {m.group(1) for m in re.finditer(r'^'+sign+r'\\s*([A-Z0-9_]+)\\s*=\\s*(true|yes|on|1)\\s*$', f['patch'], re.M|re.I) if not m.group(1).endswith('_VERSION')}
  for k in sorted(on(r'\\+') - on('-')): print(k)")
# Accepted switches: store/eles-felhozas/kapcsolo-elfogadva.txt, one line per switch:
#   NAME <tab> who/when/message id (the decision that turned it on)
# A name listed there no longer stops the rollout; it is logged instead.
ELF="$ALLAPOT/kapcsolo-elfogadva.txt"
if [ -n "$ONSW" ] && [ -f "$ELF" ]; then
  REST=""
  for k in $ONSW; do
    if grep -q "^$k[[:space:]]" "$ELF"; then say "kapcsolo elfogadva: $k ($(grep "^$k[[:space:]]" "$ELF" | cut -f2- | head -1))"; else REST="$REST $k"; fi
  done
  ONSW=$(echo $REST)
fi
[ -z "$ONSW" ] || stop "a P..S tartomany bekapcsol egy kapcsolot a .env.production.example-ben: $(echo $ONSW), Balazs szava kell (elfogadas: a nev es a dontes sora a store/eles-felhozas/kapcsolo-elfogadva.txt fajlba)"

mkdir -p "$ALLAPOT"
# 4b. new MEDUSA_ / STRIPE_ / WEBSHOP_ keys in the production API's environment: the names only, never a value
coolify "$COOLIFY/applications/$API_UUID/envs" | python3 -c "import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(3)
if not isinstance(d,list): sys.exit(3)
for k in sorted({e.get('key','') for e in d if isinstance(e,dict)}):
  if k.startswith(('MEDUSA_','STRIPE_','WEBSHOP_')): print(k)" > "$WORK/env-most.txt" \
  || stop "az eles API kornyezeti kulcsai nem olvashatok (Coolify envs)"
if [ ! -f "$ALLAPOT/env-kulcsok.txt" ]; then
  cp "$WORK/env-most.txt" "$ALLAPOT/env-kulcsok.txt"
  stop "nem volt mentett eles kulcslista; most mentve ($(wc -l < "$WORK/env-most.txt") kulcs: $(echo $(cat "$WORK/env-most.txt"))), a kovetkezo futas ehhez mer"
fi
UJ=$(grep -vxF -f "$ALLAPOT/env-kulcsok.txt" "$WORK/env-most.txt")
[ -z "$UJ" ] || stop "uj kulcs az eles API kornyezeteben: $(echo $UJ). Ha Balazs jovahagyta, a nevet egy sorba ird a store/eles-felhozas/env-kulcsok.txt vegere"

# 4c. the production projection into Medusa: did ExternalReference MEDUSA grow since the last measure?
printf '%s\n' "SELECT 'medusa_ref|' || count(*) || '|' || coalesce(to_char(max(\"lastSyncedAt\"), 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'), '-') FROM \"ExternalReference\" WHERE \"system\" = 'MEDUSA';" > "$WORK/medusa.sql"
ssh -i "$SSH_KEY" "${SSH_PIN[@]}" "$ELES_GEP" psql-ro "$ELES_DB" acropora tuples-pipe < "$WORK/medusa.sql" > "$WORK/medusa.txt" 2>&1
MREF=$(grep -m1 '^medusa_ref|' "$WORK/medusa.txt" | cut -d'|' -f2-)
[ -n "$MREF" ] || stop "az eles ExternalReference MEDUSA nem olvashato (psql-ro): $(head -c 200 "$WORK/medusa.txt")"
if [ ! -f "$ALLAPOT/medusa-ref.txt" ]; then
  echo "$MREF" > "$ALLAPOT/medusa-ref.txt"
  stop "nem volt mentett eles Medusa-vetites allapot; most mentve ($MREF: sorok|max lastSyncedAt), a kovetkezo futas ehhez mer"
fi
read -r MREF0 < "$ALLAPOT/medusa-ref.txt"
# the ISO times compare as text; '-' (no row synced) is below any time
NOTT=$(python3 -c "import sys
a,b=sys.argv[1].split('|'),sys.argv[2].split('|')
print('igen' if int(b[0])>int(a[0]) or (b[1]!='-' and (a[1]=='-' or b[1]>a[1])) else '')" "$MREF0" "$MREF")
[ -z "$NOTT" ] || stop "az eles OS vetit a Medusaba: ExternalReference MEDUSA $MREF0 -> $MREF (sorok|max lastSyncedAt). Balazs szava kell; ha jovahagyta, a store/eles-felhozas/medusa-ref.txt tartalma legyen: $MREF"
echo "$MREF" > "$ALLAPOT/medusa-ref.txt"

say "kapuk rendben: $AHEAD commit, $NFILES fajl, $NMIG migracio (mind bovito), CI zold, a fo agon; nincs uj eles kapcsolo, Medusa $MREF"


# the commit each production app is pinned to, read back from Coolify (empty: unreadable)
app_sha() { coolify "$COOLIFY/applications/$1" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('git_commit_sha') or '')
except Exception: print('')"; }
nev() { case "$1" in $API_UUID) echo api;; $WEB_UUID) echo web;; *) echo partner;; esac; }

if [ "$NEZ" = 1 ]; then
  # --nez measures that the pin can be read back (the field the live run relies on), and changes nothing
  MOST=""
  for u in $API_UUID $WEB_UUID $PARTNER_UUID; do
    v=$(app_sha "$u"); [ -n "$v" ] || stop "a Coolify nem adja vissza a(z) $(nev "$u") git_commit_sha mezojet: a rogzites nem volna ellenorizheto"
    MOST="$MOST $(nev "$u")=${v:0:12}"
  done
  say "--nez: itt telepitene ${S:0:12}-t (api, web, partner); a rogzites most:$MOST"
  exit 0
fi

pin() { coolify -X PATCH -H 'Content-Type: application/json' -d "{\"git_commit_sha\":\"$2\"}" "$COOLIFY/applications/$1" >/dev/null; }
# its own loop variable: the callers name the failed app from theirs ($u) after unpinning
unpin_all() { local a; for a in $API_UUID $WEB_UUID $PARTNER_UUID; do pin "$a" HEAD; done; }
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
# A PIN THAT DID NOT TAKE BUILDS THE HEAD OF MAIN, NOT S (barracuda, #387): its migrations past S, which the gate never
# read, would run on the production database, and the web and the partner have no check after their deploy. So every
# pin is read back BEFORE any deploy starts.
for u in $API_UUID $WEB_UUID $PARTNER_UUID; do
  v=$(app_sha "$u")
  [ "$v" = "$S" ] || { unpin_all; stop "a(z) $(nev "$u") rogzitese nem sikerult (git_commit_sha=${v:-olvashatatlan}, nem ${S:0:12}); semmi nem telepult"; }
done
R=$(deploy_wait $API_UUID) || { unpin_all; stop "az eles API telepitese: $R (a Coolify a regi kontenert hagyja futni)"; }
say "api: $R"
NOW=$(health_commit "$ELES_API")
[ "$NOW" = "$S" ] || { unpin_all; stop "az API telepites utan az eles /health commit ${NOW:0:12}, nem ${S:0:12}"; }
R=$(deploy_wait $WEB_UUID) || { unpin_all; stop "az eles web telepitese: $R (az API mar ${S:0:12})"; }
say "web: $R"
# the production web says its commit since RELEASE_COMMIT_SHA=${SOURCE_COMMIT} is set there (acrobot, 2026-11-20 10:06):
# a silent or another commit stops before the partner
NOW=$(health_commit "$ELES_WEB")
[ "$NOW" = "$S" ] || { unpin_all; stop "a web telepites utan az eles web /health commit ${NOW:-ures}, nem ${S:0:12} (az API mar ${S:0:12}, a partner nem telepult)"; }
R=$(deploy_wait $PARTNER_UUID) || { unpin_all; stop "az eles partner telepitese: $R (az API es a web mar ${S:0:12})"; }
say "partner: $R"
unpin_all
say "KESZ: az eles OS ${P:0:12} -> ${S:0:12} ($AHEAD commit, $NMIG migracio)"
bash "$HERE/daily-log.sh" acrobot "Eles napi felhozas" "Kesz: az eles OS (api, web, partner) ${P:0:12} -> ${S:0:12}, $AHEAD commit, $NMIG bovito migracio. A commerce nem resze." >/dev/null 2>&1
exit 0
