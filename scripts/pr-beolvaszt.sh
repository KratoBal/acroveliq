#!/usr/bin/env bash
# ANSWERS: Beolvaszt egy pull requestet, de CSAK akkor, ha minden ellenorzes ZOLD.
#
# MIERT LETEZIK: 2026-09-04-en beolvasztottam egy PR-t, aminek a `verify` ellenorzese
# KETSZER elbukott. A figyelom kiirta, es en nem olvastam el. A beolvaszto hivasom csak a
# `mergeable` mezot nezte -- az azt mondja meg, hogy nincs UTKOZES, nem azt, hogy a kod JO.
# A ket dolog kulonbozik, es a `mergeable: true` megnyugtatoan nez ki.
#
# Ez a szkript a szabalyt ESZKOZBE teszi: a "nezd meg az ellenorzest" eddig szokas volt,
# amire emlekezni kellett; mostantol a beolvasztas felteteel.
#
# HASZNALAT:  bash scripts/pr-beolvaszt.sh <PR-szam> [tulajdonos/repo]
#             bash scripts/pr-beolvaszt.sh --nez <PR-szam> [tulajdonos/repo]
#             bash scripts/pr-beolvaszt.sh --friss-fej-rendben "megkerdeztem, kesz" <PR-szam>
#             bash scripts/pr-beolvaszt.sh --kozos-fajl-rendben "a #N kesobb kesz" <PR-szam>
#
# === A `--nez` ALAK, ES MIERT NEM KENYELMI KAPCSOLO (sajat meres, 2026-09-08 05:20) ===
#
# Kifejezetten megirtam murenanak, hogy a #158-at NEM olvasztom be, amig egy mert
# gyengeseget ki nem javit. Kilenc perccel kesobb beolvasztottam. Nem gondoltam meg
# magam: HAROM NYITOTT PR CI-allapotat akartam megnezni, es ehhez EZT a szkriptet
# hivtam meg mindharomra, ciklusban. A ketto, amelyik meg futott, kiirta hogy "NEM
# OLVASZTOK"; a harmadik idokozben zold lett, es a lekerdezesem BEOLVASZTOTTA.
#
# A hiba tehat NEM a dontesben volt, hanem az ALAKBAN: mellekhatassal jaro parancsot
# hasznaltam meresnek. A szkript pontosan azt tette, amire keszult.
#
# EZERT KETTO KELL, ES A MASIK A TARTAS-LISTA ALATTA. Egy kapcsolo, ami nem olvaszt,
# csak akkor ved, ha eszembe jut hasznalni -- a tartas-lista akkor is ved, ha nem.
# (Ugyanaz a ketto, mint mindenhol: a szandek es a szerkezet.)
set -uo pipefail

NEZ=0
TASK=""
FRISS_OK=""
BAZIS_OK=""
SORREND_OK=""
DUPLA_OK=""
KOZOS_OK=""
while :; do
  case "${1:-}" in
    --nez) NEZ=1; shift ;;
    # TC-Lite L4: a feladat, amihez a beolvasztas tartozik. A PUT 200-as valasza utan
    # (es csak ha a merge commit a cel-agon van) `merged` esemeny megy ra, data-val:
    # {repo, pr, head_sha, merge_sha} -- ebbol meri ujra a done-or (scripts/beolvadt-esemeny.py).
    --task)
      shift
      TASK="${1:?a --task utan feladat-azonosito kell}"
      [[ "$TASK" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || { echo "FAIL: a --task nem feladat-azonosito: $TASK" >&2; exit 2; }
      shift ;;
    # A MAR BEOLVADT COMMIT feloldasa. Kulon kapcsolo, es NEM a --elavult-bazis-rendben,
    # mert MAS a baja es MAS a feloldasa: ott a zold futott regi fan, itt a PR olyan
    # commitot hordoz, aminek a TARTALMA mar a main-en all. Az elsot egy indok oldja
    # fel, a masodikat egy REBASE -- egy kozos kapcsolo azt sugallna, hogy ugyanaz.
    --duplikatum-rendben)
      shift
      DUPLA_OK="${1:?a --duplikatum-rendben INDOKOT var: mibol tudod, hogy a mar beolvadt commit ujboli bevitele itt nem baj}"
      shift ;;
    # A MIGRACIO-SORREND feloldasa. Ugyanaz az alak, mint a masik kettonel, es
    # ugyanabbol az okbol: az INDOK KOTELEZO es kiirodik.
    --migracio-sorrend-rendben)
      shift
      SORREND_OK="${1:?a --migracio-sorrend-rendben INDOKOT var: mibol tudod, hogy a korabbi datumu migracio itt nem baj}"
      shift ;;
    # Az ELAVULT BAZIS feloldasa. Ugyanaz az alak, mint a friss fejnel, es ugyanabbol
    # az okbol: az INDOK KOTELEZO es kiirodik. Az a mondat, amivel allitod, hogy a
    # zold akkor is all, ha a fo ag azota mozdult.
    --elavult-bazis-rendben)
      shift
      BAZIS_OK="${1:?a --elavult-bazis-rendben INDOKOT var: mibol tudod, hogy a zold a mai fan is allna}"
      shift ;;
    # A friss fej feloldasa. Az INDOK KOTELEZO es kiirodik: az a mondat, amivel
    # allitod, hogy a szerzo befejezte (megkerdezted, o kerte a beolvasztast, stb.).
    # A KOZOS FAJLU NYITOTT PR feloldasa (lasd a kaput a beolvasztas elott).
    --kozos-fajl-rendben)
      shift
      KOZOS_OK="${1:?a --kozos-fajl-rendben INDOKOT var: miert mehet ez elobb, mint a kozos fajlu masik PR}"
      shift ;;
    --friss-fej-rendben)
      shift
      FRISS_OK="${1:?a --friss-fej-rendben INDOKOT var: mibol tudod, hogy a szerzo befejezte}"
      shift ;;
    *) break ;;
  esac
done
PR="${1:?hasznalat: pr-beolvaszt.sh [--nez] [--task <task_id>] [--friss-fej-rendben \"indok\"] [--elavult-bazis-rendben \"indok\"] [--migracio-sorrend-rendben \"indok\"] [--kozos-fajl-rendben \"indok\"] <PR-szam> [tulajdonos/repo]}"
# A repo masodik argumentumkent adhato meg. Alapertelmezes az Acropora OS, mert a
# beolvasztasok tulnyomo resze oda megy -- de a commerce repora is kell, es ott a
# check-runs vegpont 403-at ad ugyanezzel a tokennel (merve 2026-09-04, murena
# jelezte, en visszamertem: check-runs 403, actions/runs 200, pulls 200).
#
# ES A REPO MEGADASA KET ESZKOZBEN KETFELE VOLT, AMI MA KEVESEN MULT (sajat meres,
# 2026-09-07): a pr-allapot.sh a PR_REPO KORNYEZETI VALTOZOT olvassa, ez a szkript
# viszont a MASODIK ARGUMENTUMOT. Ugyanazzal a PR_REPO ertekkel hivtam mind a kettot,
# es ez a szkript az acropora-os 109-es PR-jet nezte meg, nem a commerce-et. Csak azert
# nem lett baj, mert az ott CLOSED volt. Ha nyitva es zold, egy MASIK REPO PR-jet
# olvasztottam volna be, es a kimenet ugyanigy sikert jelentett volna.
# Ezert a PR_REPO itt is szamit, de a pozicionalis argumentum eros marad.
REPO="${2:-${PR_REPO:-KratoBal/acropora-os}}"

# A --task HIANYA (TC-Lite L4): ket hetig hangos figyelmeztetes, utana a beolvasztas
# nelkule nem indul. A hatarido a bevezetes napjatol (2026-10-13) ket het. A --nez
# alakot nem allitja meg: az csak nez.
TASK_KOTELEZO_ETTOL=2026-10-27
if [ -z "$TASK" ]; then
  if [[ "$(date -u +%F)" < "$TASK_KOTELEZO_ETTOL" ]] || [ "$NEZ" = 1 ]; then
    echo "FIGYELEM: nincs --task <task_id>: a beolvasztas NEM kerul a feladat idovonalara, es a done-or nem latja." >&2
    echo "  ${TASK_KOTELEZO_ETTOL}-tol kotelezo. Alak: pr-beolvaszt.sh --task <task_id> <PR-szam> [repo]" >&2
  else
    echo "FAIL: ${TASK_KOTELEZO_ETTOL} ota a --task <task_id> kotelezo (a beolvasztas a feladat idovonalara kerul)." >&2
    exit 2
  fi
fi
TOK="$(cat /home/marveen/marveen/store/.github-token)"

# === A TARTAS-LISTA ===
#
# A tartasnak AZON A DOLGON kell laknia, amit tart. Ha csak uzenetben all, akkor
# ugyanannyit er, mint az emlekezetem -- es a #158-nal ez pontosan nullat ert.
# A PR-re magara nem tudom rairni (a tokenunk a PR torzsere es kommentjeire 403-at
# ad), ezert oda kerul, ahol a BEOLVASZTAS tortenik: ebbe a szkriptbe.
#
# A fajl az `exchange` konyvtarban all, tehat a flotta is olvassa ES irja: barmelyik
# agens megtarthatja a sajat PR-jet, nem csak en.
#
# Alak, soronkent. Az indokot SZOKOZ utani `#` kezdi -- nem barmelyik `#`, mert az
# elso a PR-hivatkozas belsejeben all. Az indok kiirodik a megtagadaskor:
#   KratoBal/acropora-commerce#158  # az orzo szeletelese vak, murena javitja
TARTAS=/home/marveen/marveen/exchange/pr-tartas.txt

ESEMENY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/beolvadt-esemeny.py"
# the token goes in the environment, not the argv (every agent's `ps` shows argv;
# acrovelIQ P0-1); argv[3] stays a placeholder so the positions do not move
PR_BEOLVASZT_TOK="$TOK" python3 - "$PR" "$REPO" "-" "$NEZ" "$TARTAS" "$FRISS_OK" "$BAZIS_OK" "$SORREND_OK" "$DUPLA_OK" "$KOZOS_OK" "$TASK" "$ESEMENY" << 'PYEOF'
import json, os, re as _re, subprocess, sys, time
pr, repo = sys.argv[1], sys.argv[2]
# popped, so the curl, git and python children do not inherit it
tok = os.environ.pop('PR_BEOLVASZT_TOK', '')
nez = sys.argv[4] == '1'
tartas_fajl = sys.argv[5]
friss_ok = sys.argv[6] if len(sys.argv) > 6 else ''
bazis_ok = sys.argv[7] if len(sys.argv) > 7 else ''
sorrend_ok = sys.argv[8] if len(sys.argv) > 8 else ''
dupla_ok = sys.argv[9] if len(sys.argv) > 9 else ''
kozos_ok = sys.argv[10] if len(sys.argv) > 10 else ''
task = sys.argv[11] if len(sys.argv) > 11 else ''
esemeny_szkript = sys.argv[12] if len(sys.argv) > 12 else ''

# A TARTAS ELOSZOR, MINDEN API-HIVAS ELOTT: egy tartott PR-t meg megnezni sem kell
# ahhoz, hogy tudjuk, nem megy be.
if os.path.exists(tartas_fajl):
    for _sor in open(tartas_fajl, encoding='utf-8'):
        _sor = _sor.strip()
        if not _sor or _sor.startswith('#'):
            continue
        # A `#` KETSZER SZEREPEL EGY SORBAN, ES EZ MEGFOGTA A SAJAT KALIBRACIOMAT.
        # Az elso valtozat `partition('#')`-kel vagta le az indokot -- csakhogy az
        # ELSO `#` a PR-hivatkozas belsejeben all (`.../acropora-commerce#160`),
        # tehat a cim `KratoBal/acropora-commerce` lett, es semmire nem illeszkedett.
        # A kalibracio ezt azonnal kimutatta: a tartott #160 BEOLVADT. Vagyis az
        # orzo elso valtozata pontosan arra volt vak, amiert epult -- masodszor
        # ugyanaz a nap alatt, es masodszor a kalibracio fogta meg, nem en.
        # Ezert az indokot CSAK szokoz utani `#` kezdi.
        _m = _re.match(r'^(\S+)(?:\s+#\s*(.*))?$', _sor)
        if not _m:
            continue
        _cim, _indok = _m.group(1), _m.group(2) or ''
        if _cim in (f'{repo}#{pr}', f'#{pr}', pr):
            print(f'NEM OLVASZTOK: a(z) {repo}#{pr} TARTAS alatt all.')
            print(f'   indok: {_indok.strip() or "(nincs megadva)"}')
            print(f'   a tartas helye: {tartas_fajl}')
            print('   Ha felold, VEDD KI a sort -- a feloldas is mert lepes legyen,')
            print('   ne az, hogy epp maskepp emlekszem.')
            sys.exit(1)

def api(method, path, body=None):
    # the header on stdin, not the argv: every agent's `ps` shows argv (P0-1)
    cmd = ['curl', '-sL', '-w', '\nHTTP %{http_code}', '-m', '60', '-X', method,
           '-H', '@-',
           '-H', 'Accept: application/vnd.github+json',
           f'https://api.github.com/repos/{repo}{path}']
    if body is not None:
        cmd += ['-d', json.dumps(body)]
    out = subprocess.run(cmd, input='Authorization: Bearer ' + tok + '\n', capture_output=True, text=True).stdout
    text, _, code = out.rpartition('\nHTTP ')
    return text, code.strip()

text, kod = api('GET', f'/pulls/{pr}')
d = json.loads(text)
# HA A PR NEM LETEZIK EBBEN A REPOBAN, MONDJUK KI, NE TRACEBACKET ADJUNK.
# Merve 2026-09-15: a 686-ot eloszor a commerce repoval kerdeztem le, ahol a szamozas
# meg a 380-asoknal tart. A valasz egy sima 404-es hibaobjektum volt, a szkript pedig
# `KeyError: 'head'` hibaval elszallt. Egy traceback ugy nez ki, mintha az ESZKOZ
# romlott volna el -- holott a valasz pontos volt: ilyen PR ott nincs. A ket dolog
# kulonbozo lepest kovetel (masik repo kontra hibakereses az eszkozben), es a
# traceback pont azt a kulonbseget mossa el.
if 'head' not in d:
    uzenet = d.get('message', '(a valasz nem tartalmaz uzenetet)')
    print(f'--- repo: {repo} ---')
    print(f'NEM OLVASZTOK: a(z) #{pr} nem kerdezheto le ebbol a repobol (HTTP {kod}): {uzenet}')
    # A JAVASLAT A MASIK REPOT NEVEZZE MEG, NE AZT, AMIT A HIVO MAR HASZNALT.
    # Elso alakjaban ugyanazt a repot irta vissza, amivel a hivas epp elbukott --
    # egy tanacs, ami a mar megtett lepest ismetli, rosszabb a semminel.
    masik = ('KratoBal/acropora-commerce' if repo == 'KratoBal/acropora-os'
             else 'KratoBal/acropora-os')
    print(f'   ha a PR a MASIK repoban van ({masik}), add meg masodik argumentumkent:')
    print(f'   cd /home/marveen/marveen && bash scripts/pr-beolvaszt.sh {pr} {masik}')
    raise SystemExit(1)
sha, state = d['head']['sha'], d['state']
# A REPO A KIMENET ELSO SORABA KERUL, ES EZ ITT SULYOSABB, MINT A LEKERDEZONEL.
# A fejlec fentebb mar leirja, hogy ugyanaz a PR-szam KET repoban is letezik, es hogy
# 2026-09-07-en kevesen mult egy MASIK repo PR-jenek beolvasztasa. A kimenet viszont a
# repot NEM irta ki: a `#158 allapot=open` sor pontosan ugyanigy nezett volna ki a rossz
# repobol is. Egy beolvasztas visszafordithatatlan, tehat itt a megnevezes nem kenyelem.
print(f'--- repo: {repo}   ({"PR_REPO/argumentum" if repo != "KratoBal/acropora-os" else "ez az ALAPERTELMEZES"}) ---')
print(f'#{pr}  allapot={state}  fej={sha[:12]}  mergeable={d.get("mergeable")}')

if state != 'open':
    print(f'NEM OLVASZTOK: a PR allapota {state}.'); sys.exit(1)

# === A PR-OBJEKTUM FEJE LEMARAD A PUSH UTAN, ES EZ NEM A MI HIBANK ===
#
# MIERT LETEZIK (murena merese, 2026-09-21 18:40, a #911-en). Ujraalapozas utan
# azonnal lekerdezte a sajat PR-jeit, es a valasz a REGI fejhez tartozo 10/10 zoldet
# adta -- friss hivasbol, ugyanabban a percben. A ket eszkoze ellentmondott egymasnak,
# es EGYIK SEM hazudott: MAS SHA-rol beszeltek. A GitHub PR-objektuma a push utan meg
# egy ideig a korabbi `head.sha`-t adja vissza.
#
# MIERT VESZELYESEBB EZ, MINT EGY SIMA ELAVULT ZOLD: az elavult zoldnel a mero
# felejtett el ujramerni. Itt UJRAMERT, es a FORRAS adta a regi fejet. Semmi nem
# latszik rajta.
#
# EZ A SZKRIPT EDDIG IS TULELTE VOLNA, de nem ezen a kapun: a beolvaszto hivas atadja
# a `sha` mezot, tehat a GitHub 405-tel MEGTAGADNA a beolvasztast, ha a fej kozben
# elmozdult. Az eredmeny tehat helyes -- csak a kimenet HAZUDIK elotte: vegigirja,
# hogy minden ellenorzes zold, es a 405 utana ugy nez ki, mint egy atmeneti hiba.
# Egy zold jelentes egy MASIK tartalomrol akkor is kart okoz, ha a beolvasztas nem megy
# vegig: tovabbadom szoban, es a szam mar a sajat eletet eli.
#
# AZ AG REFERENCIAJA NEM KESIK -- ez ugyanaz a ketto, amit a `pr-allapot.sh` fejlece is
# szetvalaszt (mi a legfrissebb munka kontra mit olvasztana be). Ha a ketto elter, itt
# MEGALLUNK, mert onnantol minden alatta kovetkezo meres egy nem letezo fejre szol.
_hrepo = ((d.get('head') or {}).get('repo') or {}).get('full_name') or repo
_href = d['head']['ref']
_ht = subprocess.run(
    ['curl', '-sL', '-m', '30', '-H', '@-',
     '-H', 'Accept: application/vnd.github+json',
     f'https://api.github.com/repos/{_hrepo}/git/ref/heads/{_href}'],
    input='Authorization: Bearer ' + tok + '\n', capture_output=True, text=True).stdout
try:
    _agfej = json.loads(_ht)['object']['sha']
except Exception:
    # A NULLA ITT NEM BIZONYITEK. Ha az ag referenciaja nem kerdezheto le (fork,
    # torolt ag, halozat), az NEM azt jelenti, hogy a fej egyezik. Kiirjuk, es
    # megyunk tovabb -- a 405-os kapu a beolvasztasnal akkor is all.
    _agfej = None
    print(f'   [az ag referenciaja nem volt lekerdezheto: {_hrepo}#{_href} -- '
          f'a fej-egyezest NEM ellenoriztem]')
if _agfej and _agfej != sha:
    print(f'NEM OLVASZTOK: a PR-objektum LEMARADT a tenyleges fej mogott.')
    print(f'   a PR ezt mondja:  {sha[:12]}')
    print(f'   az ag valojaban:  {_agfej[:12]}   ({_hrepo} / {_href})')
    print('   Ez a push utani par perc szokasos allapota, NEM hiba es NEM a tied.')
    print('   Amit ilyenkor NEM szabad: elhinni az alatta jovo zoldet -- az a REGI')
    print('   fejre szol. Varj fel percet, es futtasd ujra.')
    sys.exit(1)

# === A CIMBE IRT TARTAS, A LISTA MELLETT ===
#
# MIERT LETEZIK (merve 2026-09-09 10:52): murena tartast tett a #265-re -- de a PR
# CIMEBE irta, nem a tartas-listaba, mert a tartasnak AZON A DOLGON kell laknia, amit
# tart. Az oszton helyes volt, a vedelem viszont NULLA: ez a szkript addig csak a
# listat olvasta, tehat a cimben allo "NE OLVASZD BE" semmit nem tartott vissza. Egy
# hatterben futo beolvaszto ciklusom pontosan ezt tette volna, ha ket perccel kesobb
# all zoldre a CI.
#
# Ez ugyanaz a csalad, mint a lapunkon a hamis szabaly: egy szabaly, aminek nincs
# eszkoze, ROSSZABB a hianyzonal, mert megnyugtat. Murena ugy tette le a munkat, hogy
# a PR-t vedve hitte.
#
# A ket hely tehat MEGMARAD, es ez szandekos: a lista akkor is ved, ha valaki a
# GitHubon nem ir at semmit, a cim pedig ott latszik, ahol a PR-t nezik.
_cim_szoveg = (d.get('title') or '')
for _jel in ('NE OLVASZD BE', 'DO NOT MERGE', '[WIP]', 'NE OLVASSZ'):
    if _jel.lower() in _cim_szoveg.lower():
        print(f'NEM OLVASZTOK: a PR CIME tartast hordoz ({_jel}).')
        print(f'   cim: {_cim_szoveg}')
        print('   A feloldas: vedd ki a jelet a cimbol, es nezd meg a tartas-listat is')
        print(f'   ({tartas_fajl}) -- a ketto kulon all.')
        sys.exit(1)

# === A FEJ KORA, MERT EGY MOZGO AGRA SEMMI NEM FIGYELMEZTET ===
#
# MIERT LETEZIK (sajat hibam, 2026-09-08 06:11): a #167-et akkor olvasztottam be,
# amikor a verify zoldre valt a caa2f60a-n. A szerzo hat perccel kesobb tolt ra egy
# javitast, a PR mar zart volt, es a javitas kimaradt -- ugy, hogy a fo agra
# ellentmondo szoveg kerult. A beolvasztas NEM volt hibas: a `sha` mezot atadjuk,
# tehat pontosan azt vitte, amit megmertunk. A hianyzo dolog a MASIK kerdes volt:
# BEFEJEZTE-E A SZERZO. Arra a zold CI nem valaszol, es semmi mas sem.
#
# Itt annyi merheto, hogy mikor keszult a fej es milyen regi. 2026-09-09 22:20-ig ez
# csak FIGYELMEZTETES volt, azzal az indokkal, hogy egy gyors CI utan a fej
# termeszetesen friss. Az indok igaz, a kovetkeztetes rossz volt: a figyelmeztetes
# ketszer kiirodott es ketszer olvasztottam be nelkule (#167, #325). Ma TILTAS,
# `--friss-fej-rendben "<indok>"` oldja fel. A reszletes indoklas lent, a kodnal.
# A FELOLDAS INDOKA EDDIG ALLITAS VOLT, NEM BIZONYITEK -- ES EZT A LENTI KOMMENT KI IS
# MONDTA MAGAROL. 2026-09-22 delutan HATSZOR oldottam fel ezt a kaput, es mind a
# hatszor UGYANAZT csinaltam kezzel: megkerestem a szerzo uzenetet, osszevetettem az
# idejet a push idejevel, es atgepeltem mind a kettot a szabad szoveges indokba.
#
# KET BAJA VAN ENNEK, es a masodik a sulyosabb:
#   1. hatszor egy perc, ami semmit nem mer -- csak masol
#   2. A KEZZEL ATGEPELT IDOPONT MAGA IS ALLITAS. Ha elvetem, a feloldas indoka
#      magabiztosan hivatkozik egy uzenetre, ami nem is letezik vagy korabbi a
#      pushnal. Senki nem nezne utana: az indok a naploban ugy all, mintha meres
#      lenne.
#
# EZERT A SZKRIPT MOSTANTOL KIKERESI A JELOLTEKET: a sajat uzenetsorunkbol azokat,
# amik a push UTAN keletkeztek ES megnevezik ezt a shat. A DONTES tovabbra is az
# olvasoe -- azt, hogy egy uzenet "kesz munkat jelent" vagy csak reszletet, gep nem
# tudja eldonteni, es nem is szabad ratoltani. Ami automatizalodik, az a KERESES,
# nem a MEGITELES.
def _jeloltek_kiir(_sha, _push_epoch):
    try:
        with open('/home/marveen/marveen/store/.dashboard-token') as _f:
            _tok = _f.read().strip()
        _r = subprocess.run(
            ['curl', '-s', '-m', '10', '-H', '@-',
             'http://localhost:3420/api/messages?limit=120'],
            input='Authorization: Bearer ' + _tok + '\n', capture_output=True, text=True)
        _d = json.loads(_r.stdout)
        _ms = _d if isinstance(_d, list) else _d.get('messages', [])
    except Exception:
        print('   (a jelolt-kereso nem ert el a uzenetsorhoz -- a kezi indok marad)')
        return
    _rovid = [_sha[:n] for n in (12, 10, 8, 7)]
    _tal = []
    for _m in _ms:
        _c = _m.get('content') or ''
        _ts = _m.get('created_at') or 0
        if _ts and _ts > _push_epoch and any(_r2 in _c for _r2 in _rovid):
            _tal.append(_m)
    if not _tal:
        print('   JELOLT UZENET NINCS: a push ota egyetlen uzenet sem nevezi meg ezt a shat.')
        print('   Ha megis feloldod, az indok NEM tamaszkodhat szerzoi visszaigazolasra.')
        return
    print(f'   JELOLT UZENETEK (a push UTAN keletkeztek ES megnevezik a shat) -- {len(_tal)} db:')
    for _m in _tal[-4:]:
        _mt = time.strftime('%H:%M:%S', time.localtime(_m.get('created_at', 0)))
        _elso = (_m.get('content') or '').strip().split('\n')[0][:88]
        print(f'     id={_m.get("id")}  {_mt}  {_m.get("from_agent")}  {_elso}')
    print('   A DONTES A TIED: ezek megnevezik a shat, de azt, hogy KESZ munkat')
    print('   jelentenek-e, el kell olvasnod. A kereses automatikus, a megiteles nem.')

_t2, _c2 = api('GET', f'/commits/{sha}')
if _c2 == '200':
    import datetime as _dt
    # A `committer` IDO KELL, NEM A `author` -- ES EZ NEM IZLES (murena merese,
    # 2026-09-10 00:24). Egy commiton KET idobelyeg all, es ujraalapozas utan
    # ELTERNEK: a 332 fejen a szerzoi ido 22:51:43, a committer ido 23:07:14.
    # Ha ez a sor a szerzoi idot olvasna, egy FRISSEN ujraalapozott fej 16 perccel
    # oregebbnek latszana, es a tiz perces hatar CSENDBEN atengedne -- pont abban a
    # helyzetben, amire a kapu keszult, mert ujraalapozas utan a leggyakoribb, hogy
    # a szerzo meg igazit rajta. A valtozas nem hibazna, csak a kapu vakulna meg.
    _iso = json.loads(_t2)['commit']['committer']['date']
    _push_dt = _dt.datetime.fromisoformat(_iso.replace('Z', '+00:00'))
    _push_epoch = _push_dt.timestamp()
    _kor = (_dt.datetime.now(_dt.timezone.utc) - _push_dt).total_seconds()
    print(f'   a fej kora: {int(_kor // 60)} perc  ({_iso})')
    _hatar = int(os.environ.get('PR_FRISS_HATAR', '600'))
    if _kor < _hatar and not nez and not friss_ok:
        # === MIERT TILTAS EZ MA, ES MIERT VOLT CSAK FIGYELMEZTETES 2026-09-09 22:20-IG ===
        #
        # A fenti bekezdes azt irta, hogy a friss fej "NEM tiltas", mert egy gyors CI utan
        # a fej termeszetesen friss. Ez igaz, es MEGIS ROSSZ VOLT: a figyelmeztetes
        # KETSZER kiirodott, es ketszer olvasztottam be nelkule.
        #
        #   2026-09-08 06:11   acropora-os #167   a szerzo hat perccel kesobb tolt ra
        #   2026-09-09 22:11   commerce   #325    a szerzo 57 MASODPERCCEL kesobb tolt ra
        #
        # A masodiknal a fo agra olyan cim-szamitas kerult, amirol a szerzo epp akkor
        # merte le, hogy 77 kategoria-lapon utkozne. En elolvastam a figyelmeztetest,
        # es beolvasztottam.
        #
        # A KULONBSEG, AMI SZAMIT: egy FIGYELMEZTETES a dontest az olvasora bizza, tehat
        # a valasza alapertelmezes szerint "tovabb". Egy TILTAS a hallgatast forditja meg:
        # nem tortenik semmi, amig ki nem mondom, mibol tudom, hogy a szerzo befejezte.
        # Ugyanaz a ketto, ami mar a `--nez` mellett is all: a szandek es a szerkezet.
        #
        # AMIT EZ NEM TUD: az indokot a szkript nem tudja ellenorizni -- allitas, nem
        # bizonyitek (a sajat lapunkon ez a "flag that is an assertion" csapda). A cel
        # nem is az ellenorzes, hanem hogy a KERDES elhangozzon, es a valasz kiirodjon.
        print(f'NEM OLVASZTOK: a fej {int(_kor // 60)} perc {int(_kor % 60)} masodperc regi, '
              f'a hatar {_hatar // 60} perc.')
        print('   A zold CI EZT a shat igazolja, azt nem, hogy a szerzo BEFEJEZTE.')
        _jeloltek_kiir(sha, _push_epoch)
        print('   Ket ut van:')
        print('     1. kerdezd meg a szerzot, aztan:')
        print('        --friss-fej-rendben "megkerdeztem, kesz" <PR>')
        print('     2. varj, amig a fej megoregszik.')
        print('   A `--nez` alak ettol fuggetlenul mindig megnezi az allapotot.')
        sys.exit(1)
    if _kor < _hatar and friss_ok:
        print(f'   a friss fej feloldva: {friss_ok}')
        # A JELOLTEK AKKOR IS KIMENNEK, AMIKOR FELOLDOK. Ha az indokom szerzoi
        # visszaigazolasra hivatkozik, de a szkript NULLA jeloltet talal, az
        # ellentmondas itt, a naploban lathato -- nem egy kesobbi olvasonak kell
        # utanajarnia. Ez a resz nem allit meg semmit, csak nem hagyja, hogy egy
        # hamis hivatkozas nyom nelkul maradjon.
        _jeloltek_kiir(sha, _push_epoch)

# KET UT UGYANARRA A KERDESRE, mert a check-runs vegpont repotol fuggoen 403-at ad.
# A 403 NEM azt jelenti, hogy nincs ellenorzes -- ezert TILOS ures listakent kezelni:
# az pontosan az a nema atengedes lenne, ami miatt ez a szkript letezik.
text, code = api('GET', f'/commits/{sha}/check-runs')
if code == '200':
    runs = [{'name': c['name'], 'status': c['status'], 'conclusion': c.get('conclusion')}
            for c in json.loads(text).get('check_runs', [])]
    forras = 'check-runs'
else:
    text2, code2 = api('GET', f'/actions/runs?head_sha={sha}&per_page=100')
    if code2 != '200':
        print(f'NEM OLVASZTOK: az ellenorzeseket NEM tudom elolvasni '
              f'(check-runs {code}, actions/runs {code2}).'); sys.exit(1)
    runs = [{'name': r['name'], 'status': r['status'], 'conclusion': r.get('conclusion')}
            for r in json.loads(text2).get('workflow_runs', [])]
    forras = f'actions/runs (a check-runs {code}-at adott)'
print(f'   [az ellenorzesek forrasa: {forras}]')

if not runs:
    print('NEM OLVASZTOK: egyetlen ellenorzes sincs ezen a fejen.'); sys.exit(1)

fut  = [c['name'] for c in runs if c['status'] != 'completed']
bukott = [c['name'] for c in runs if c['status'] == 'completed' and c['conclusion'] != 'success']
for c in runs:
    print(f"   {c['name'][:40]:42} {c['status']:12} {c['conclusion']}")

if fut:
    print('NEM OLVASZTOK: meg fut', len(fut), 'ellenorzes:', fut); sys.exit(1)
if bukott:
    print('NEM OLVASZTOK: NEM SIKERES ellenorzes:', bukott); sys.exit(1)

# === A HARMADIK KERDES: MELYIK FO AGON FUTOTT EZ A ZOLD ===
#
# Murena javaslata, 2026-09-10 00:12, es a hianyzo harmadik lepes ebben a szkriptben.
# Eddig ketto allt itt: MELYIK TARTALOMRA szol a zold (a fej sha-ja), es BEFEJEZTE-E
# a szerzo (a fej kora). A harmadik ugyanolyan olcso, es mast fog meg:
#
# Egy `pull_request` futas NEM a fejet ellenorzi, hanem a fej es a BAZIS EGYESITETT
# fajat. A zold tehat ket dologrol szol: a fejrol ES arrol a fo agrol, ami a futas
# pillanataban allt. Ha a fo ag azota mozdult, a zold egy olyan fara vonatkozik,
# ami mar nem letezik.
#
# MIERT NEM ELEG A `mergeable` VAGY EGY TISZTA OSSZEFESULES: azok azt mondjak meg,
# hogy nincs SZOVEGES utkozes. Egy tipushiba, egy atnevezett fuggveny vagy egy
# megvaltozott szerzodes ket kulon fajlban is elront egy buildet ugy, hogy a
# szoveges osszefesules tokeletes. Murena mert esete ugyanaznap: a 329-et es a
# 332-t tiszta `merge-tree` mellett is ujraalapozta, mert "egy tiszta osszefesules
# nem ugyanaz, mint egy lefuttatott kapu a mai fan".
#
# MIERT TILTAS ES NEM FIGYELMEZTETES: ugyanaz a lecke, mint a friss fejnel, ket
# hettel korabbrol. Egy figyelmeztetes a dontest az olvasora bizza, tehat ha az
# olvaso nem szol semmit, a valasz "tovabb" -- a hallgatas alapertelmezese az igen.
# Ket ilyen figyelmeztetest olvastam el es leptem at ugyanazon a soron.
#
# ES AMIT A TILTAS MELLE KIIR, AZ TESZI OLCSOVA A DONTEST: nem csak azt mondja,
# hogy a bazis elavult, hanem azt is, hogy a fo ag AZOTA MELYIK FAJLOKAT valtoztatta
# meg, es azokbol MELYIK erinti a PR-t is. Ha a metszet ures, a feloldas indoka
# egy mondat. Ha nem ures, a valasz szinte biztosan ujraalapozas.
#
# A FELOLDAS: --elavult-bazis-rendben "<indok>". Az indok kiirodik.
_bazis_ref = d.get('base', {}).get('ref') or 'main'

# A BASE-AG NEVE ONMAGABAN KAPU, ES EZ 2026-09-21-ig NEM ALLT ITT.
#
# A MERT ESET: a #882 a #881 AGARA volt nyitva. Beolvasztottam, a valasz
# `"merged": true` es egy sha volt -- a tartalom viszont SOHA nem kerult a
# mainre, mert a beolvasztas a SZULO AGBA ment, es az a szulo beolvadasakor
# megszunt. A merge commit arvan maradt: `git branch -r --contains <sha>`
# NULLA agat ad. Murena merte vissza, a fajlbol, nem a jelzobol:
# a mainen tovabbra is a REGI, 161 soros lap allt.
#
# A JELZO TEHAT HAZUDHAT: `state: closed, merged: true` ugy is eloall, hogy a
# munka sehol nincs. A GitHub ezen a ponton mar nem segit: egy lezart PR
# base-agat NEM lehet atallitani (422, "Cannot change the base branch of a
# closed pull request"), tehat a javitas UJ PR.
#
# AMIERT A KIIRAS NEM VOLT ELEG: a szkript eddig is kiirta a base NEVET (lentebb,
# "a bazis: X = a mai <ref> feje"), csak nem allt meg rajta. Egy sor, ami
# CSAK a kimeneten all, pontosan addig ved, amig valaki az egesz kimenetet
# elolvassa -- es aznap en `tail -2`-vel neztem.
#
# A FELOLDAS SZANDEKOSAN LETEZIK: egy agra epulo PR-t be LEHET olvasztani, ha
# tudatos (pl. egy hosszabb szeleteles kozben). De akkor ki kell mondani.
if _bazis_ref != 'main' and not bazis_ok:
    print(f'NEM OLVASZTOK: a PR BASE-AGA NEM a main, hanem `{_bazis_ref}`.')
    print('   Ha ezt beolvasztom, a tartalom ABBA AZ AGBA kerul, nem a fo agba --')
    print('   es ha a szulo ag kozben beolvad, a munka NYOM NELKUL elveszik.')
    print('   Merve 2026-09-21 a #882-n: merged=true, a tartalom sehol.')
    print('   A HELYES LEPES: a szerzo allitsa at a base-t main-re ES rebase-eljen,')
    print('   MIELOTT a szulo beolvad. Lezart PR base-aga mar nem allithato at.')
    print('   Ha tudatos (szeletelt sorozat kozben), mondd ki:')
    print(f'        --elavult-bazis-rendben "a #{pr} szandekosan a {_bazis_ref} agra epul" {pr}')
    raise SystemExit(1)

# === A MAR BEOLVADT COMMIT: A BASE ATALLITASA A CELT VALTOZTATJA, A TARTALMAT NEM ===
#
# MIERT LETEZIK (sajat meres, 2026-09-21, a #890-en -- es MASODSZOR ugyanez, mert
# 2026-09-17-en a #805-on mar megtortent, es a tanulsag CSAK EMLEKBE kerult):
#
# Egy agra epulo PR-nel a helyes lepessor HAROM lepes, nem ketto:
#   1. az also PR beolvad
#   2. a felso PR base mezoje main-re
#   3. ES a felso ag UJRAALAPOZASA, a mar beolvadt commitok NELKUL
# A harmadikat hagytam ki mind a ketszer.
#
# AZ OK, ES AMIERT EZ NEM LATSZIK A FELULETEN: a tarhaz SQUASH-sal olvaszt. Az also PR
# EGYETLEN uj commitkent kerul a main-re, uj azonositoval; a felso ag viszont tovabbra
# is az EREDETI commitokat hordozza. Ugyanaz a valtozas ket kulonbozo sha alatt all a
# ket oldalon, es a git nem tudja parositani oket.
#
# ES A KET ESET A PR LAPJAN TELJESEN EGYFORMAN NEZ KI: `mergeable: True`, nincs utkozes
# (a tartalom azonos azzal, ami mar bent van). A kulonbseg csak ket helyen latszik: a
# merge commit SZULEINEK SZAMABAN (squash-nal egy), es a merge-base-ben. A #890-nel a
# PR tizennegy fajlt mutatott, ebbol tizenketto a MAR BEOLVADT munkae volt -- vagyis az
# atnezes is lehetetlen, nem csak a tortenet romlik el.
#
# MIERT A COMMIT-TARGYRA MER, ES NEM A TARTALOMRA: a squash MEGTARTJA a PR cimet
# targykent, csak egy ` (#NNN)` utotagot tesz ra. Egy targy-egyezes tehat olcso es
# pontos jel. A fajl-tartalom osszevetese dragabb lenne, es a TARTALOM azonossaga
# amugy sem hiba onmagaban -- a baj az, hogy a commit MEGISMETLODIK.
if not dupla_ok:
    _pkt, _pkk = api('GET', f'/pulls/{pr}/commits?per_page=100')
    _fkt, _fkk = api('GET', f'/commits?sha={_bazis_ref}&per_page=60')
    if _pkk == '200' and _fkk == '200':
        def _targy(_uzenet):
            _elso = (_uzenet or '').split('\n')[0].strip()
            return _re.sub(r'\s*\(#\d+\)\s*$', '', _elso)
        _fo_targyak = {_targy(_c.get('commit', {}).get('message'))
                       for _c in json.loads(_fkt)}
        _fo_targyak.discard('')
        _dupla = [(_c['sha'][:12], _targy(_c.get('commit', {}).get('message')))
                  for _c in json.loads(_pkt)
                  if _targy(_c.get('commit', {}).get('message')) in _fo_targyak]
        if _dupla:
            print(f'NEM OLVASZTOK: a PR {len(_dupla)} olyan commitot hordoz, aminek a')
            print(f'   TARTALMA MAR A `{_bazis_ref}` AGON ALL (osszenyomva, mas azonosito alatt):')
            for _s, _t in _dupla[:10]:
                print(f'     {_s}  {_t[:72]}')
            if len(_dupla) > 10:
                print(f'     ... es meg {len(_dupla)-10}')
            print('   A base-atallitas a CELT valtoztatja meg, a TARTALMAT nem: az ag')
            print('   tovabbra is hordozza a mar beolvadt commitokat. A `mergeable: True`')
            print('   ettol meg igaz, mert nincs szoveges utkozes -- es epp ezert nem ved.')
            print('   A HELYES LEPES az UJRAALAPOZAS, a mar beolvadt commitok nelkul:')
            print(f'        git rebase --onto origin/{_bazis_ref} <az utolso mar-beolvadt commit> <ag>')
            print('   Utana nezd meg, hogy a PR diffje CSAK a sajat valtozasait tartalmazza:')
            print('   a CI zoldje ezt NEM fogja meg, mert a vegallapotot meri, nem azt, hogy')
            print('   a valtozas honnan jott.')
            print('   Ha tudatos (pl. a targy veletlenul egyezik), mondd ki:')
            print(f'        --duplikatum-rendben "a targy-egyezes veletlen, mas valtozas" {pr}')
            raise SystemExit(1)
elif dupla_ok:
    print(f'   a duplikatum-ellenorzes feloldva: {dupla_ok}')

_futas_bazis = None
_bt, _bk = api('GET', f'/actions/runs?head_sha={sha}&per_page=100')
if _bk == '200':
    for _r in json.loads(_bt).get('workflow_runs', []):
        for _p in (_r.get('pull_requests') or []):
            _b = (_p.get('base') or {}).get('sha')
            if _b:
                _futas_bazis = _b
                break
        if _futas_bazis:
            break

_ft2, _fk2 = api('GET', f'/git/ref/heads/{_bazis_ref}')
_mai_fej = json.loads(_ft2)['object']['sha'] if _fk2 == '200' else None

if _futas_bazis is None or _mai_fej is None:
    # NEM engedjuk at nemán: a hianyzo adat NEM ugyanaz, mint az egyezes. Ez pontosan
    # az a nema atengedes, ami miatt ez a szkript letezik -- de nem is tiltas, mert
    # nem talaltunk elavulast. A kiiras a dontest az olvasora bizza, KIMONDVA.
    print(f'   [a bazis nem ellenorizheto: futas-bazis={_futas_bazis}, mai fej={_mai_fej}]')
elif _futas_bazis == _mai_fej:
    print(f'   a bazis: {_futas_bazis[:12]} = a mai {_bazis_ref} feje. A zold a mai fan all.')
else:
    print(f'   a bazis: {_futas_bazis[:12]}, a mai {_bazis_ref} feje: {_mai_fej[:12]}  -- ELTER')
    _pr_fajlok = set()
    _pt, _pk = api('GET', f'/pulls/{pr}/files?per_page=100')
    if _pk == '200':
        _pr_fajlok = {_f['filename'] for _f in json.loads(_pt)}
    _ag_fajlok = set()
    _ct, _ck = api('GET', f'/compare/{_futas_bazis}...{_mai_fej}')
    if _ck == '200':
        _cmp = json.loads(_ct)
        _ag_fajlok = {_f['filename'] for _f in _cmp.get('files', [])}
        print(f'   a fo ag azota {_cmp.get("ahead_by", "?")} commitot lepett, '
              f'{len(_ag_fajlok)} fajlt erintve')
    else:
        # A NEMA URES METSZET A LEGROSSZABB KIMENET: ha az osszehasonlitas nem sikerul,
        # a fajl-listak uresek maradnak, es a kiiras ugy nezne ki, mintha a fo ag
        # semmit nem valtoztatott volna. Ezert all itt kimondva, hogy NEM TUDJUK.
        print(f'   a valtozott fajlokat NEM tudom osszevetni (compare {_ck}), '
              f'tehat a metszet alabbi hianya NEM jelent egyezest')
    _metszet = sorted(_pr_fajlok & _ag_fajlok)
    if _metszet:
        print(f'   ES A METSZET NEM URES ({len(_metszet)} fajl), ezek mind a ket oldalon valtoztak:')
        for _f in _metszet[:20]:
            print(f'     {_f}')
        if len(_metszet) > 20:
            print(f'     ... es meg {len(_metszet)-20}')
    elif _ag_fajlok:
        print('   a metszet URES: a fo ag azota mas fajlokat erintett, mint a PR.')
        # ES EZ KEVESEBBET ER, MINT AMENNYIRE MEGNYUGTATO -- nautilus merese,
        # 2026-09-22, visszamerve. A fenti mondat CSAK a fajl-szintu utkozest
        # zarja ki. A repoban 19 olyan spec all az `apps/api/src` alatt, ami a
        # FAT JARJA BE (readdirSync, glob), es olyat allit, ami a fa EGESZERE
        # szol: hany helyen all egy lista, van-e minden szolgaltatashoz spec,
        # szerepel-e minden valtozo a sablonban.
        #
        # Egy ilyen orzot egy MASIK fajl hozzaadasa is pirosra vihet -- tehat a
        # ket valtozas "nem er egymashoz" allitas ATMEGY, es a kozos futas megis
        # bukik. Aznap HATSZOR hivatkoztam erre a sorra feloldaskor; mindannyiszor
        # tettem melle tartalmi ervet is, de a sor ONMAGABAN nem lett volna eleg.
        #
        # nautilus ezert NEM erre hivatkozott a sajat PR-jenel, hanem lefuttatta
        # a kapukat a MAI FAN. Az a helyes lepes: a metszet egy GYANUJEL hianya,
        # nem bizonyitek.
        print('   FIGYELEM: ez CSAK fajl-szintu. Az apps/api/src alatt 19 spec a')
        print('   FAT jarja be es a fa EGESZERE allit -- azokat egy masik fajl')
        print('   hozzaadasa is elviheti. A metszet hianya GYANUJEL hianya, nem')
        print('   bizonyitek: ha teheted, futtasd a kapukat a MAI fan.')
    if not nez and not bazis_ok:
        print('NEM OLVASZTOK: a zold egy MAS fo agon futott, mint ami most all.')
        print('   Ha ujraalapozod, a kapu a mai fan fut le, es a zold arra fog szolni.')
        print('   Ha meggyozodtel rola, hogy a zold igy is all, mondd ki az indokot:')
        print('        --elavult-bazis-rendben "a metszet ures, a PR csak a kirakat CSS-et erinti" <PR>')
        sys.exit(1)
    if bazis_ok:
        print(f'   az elavult bazis feloldva: {bazis_ok}')
# === A MIGRACIOK SORRENDJE ===
#
# A MERT ESET (2026-09-17): ket migracio ment be egy oran belul, ket kulonbozo
# szerzotol, es a MASODIK volt a KORABBI datumu:
#
#     20260917110000_add_partner_service_role   #760
#     20260917103000_document_caption           #762, KESOBB olvadt be
#
# A 110000-es addigra mar LEFUTOTT az elesen (10:52), tehat a caption-migracio a
# kovetkezo telepitesnel sorrenden kivul erkezik. Nem allt meg semmi: ez a kapu a
# fajllistat es a bazist nezte, a migraciok SORRENDJET nem.
#
# ES A HIANY A KIADO SAJAT LEPESET IS ATENGEDTE -- nem egy agens hibaja volt.
#
# A HATARA, KIMONDVA: ez a FAJLNEVEKBOL dolgozik. Azt mondja meg, hogy a PR
# migracioja KORABBI-e a fo agon allo utolsonal -- es NEM azt, hogy az mar
# alkalmazva van-e valahol. A ketto legtobbszor egybeesik, de nem ugyanaz, es a
# kulonbseg pont akkor szamit, amikor a fo ag elorebb jar, mint az eles.
#
# MIERT TILTAS ES NEM FIGYELMEZTETES: ugyanaz, ami a masik ket kapunal all. Egy
# figyelmeztetes a dontest az olvasora bizza, es a hallgatas alapertelmezese az
# igen.
#
# A FELOLDAS: --migracio-sorrend-rendben "<indok>". Az indok kiirodik.
_MIG_ELOTAG = 'packages/database/prisma/migrations/'
_mt, _mk = api('GET', f'/pulls/{pr}/files?per_page=100')
_uj_migraciok = []
if _mk == '200':
    for _f in json.loads(_mt):
        _fn = _f.get('filename', '')
        if _fn.startswith(_MIG_ELOTAG) and _fn.endswith('/migration.sql'):
            _nev = _fn[len(_MIG_ELOTAG):].split('/', 1)[0]
            if _nev and _nev not in _uj_migraciok:
                _uj_migraciok.append(_nev)

if not _uj_migraciok:
    # KULON MONDAT, NEM "rendben": egy "a sorrend rendben" olyan PR-en, ami nem is
    # visz migraciot, azt sugallna, hogy volt mit ellenoriznunk.
    print('   migraciot nem visz, tehat a sorrend nem kerdes')
else:
    _bref = d.get('base', {}).get('ref') or 'main'
    _ct2, _ck2 = api('GET', f'/contents/{_MIG_ELOTAG.rstrip("/")}?ref={_bref}')
    _fo_agi = []
    if _ck2 == '200':
        _fo_agi = sorted(
            _e['name'] for _e in json.loads(_ct2) if _e.get('type') == 'dir'
        )
    if not _fo_agi:
        # A NEMA URES LISTA A LEGROSSZABB KIMENET: ugy nezne ki, mintha a fo agon
        # nem allna migracio, es MINDENT atengedne. Ezert ez is megallas.
        print(f'   a fo agi migraciokat NEM tudom lekerdezni (contents {_ck2}) --')
        print('   ez NEM jelenti azt, hogy a sorrend rendben van.')
        if not nez and not sorrend_ok:
            sys.exit(1)
    else:
        _utolso = _fo_agi[-1]
        _korabbiak = sorted(_n for _n in _uj_migraciok if _n < _utolso)
        if _korabbiak:
            print(f'   MIGRACIO-SORREND: a fo agon allo utolso {_utolso}')
            print('   es a PR ezeket viszi, amik KORABBI datumuak:')
            for _n in _korabbiak:
                print(f'     {_n}')
            print('   Ha a fo agi utolso mar lefutott valahol, ez a migracio')
            print('   SORRENDEN KIVUL fog erkezni. Az atnevezes MOST meg ingyen van;')
            print('   a beolvasztas utan mar nem, mert a Prisma a MAPPANEVET tarolja.')
            if not nez and not sorrend_ok:
                print('NEM OLVASZTOK: a PR migracioja korabbi datumu, mint a fo agon allo utolso.')
                print('   Ha atnevezed a mappat a mai idore, a kerdes megszunik.')
                print('   Ha meggyozodtel rola, hogy igy is rendben van, mondd ki az indokot:')
                print('        --migracio-sorrend-rendben "<indok>" <PR>')
                sys.exit(1)
            if sorrend_ok:
                print(f'   a migracio-sorrend feloldva: {sorrend_ok}')
        else:
            print(f'   migracio-sorrend rendben: a fo agi utolso {_utolso}, a PR ujabbat visz')

# A mergeable HAROM erteku, es a None NEM utkozes: a GitHub meg SZAMOLJA.
# Merve 2026-09-04, ketszer egy delutan: a szkript "utkozest" irt ki olyan PR-re,
# aminek tiz masodperccel kesobb mergeable=True lett. A ket allapot ket kulonbozo
# teendo -- az egyiknel rebase kell, a masiknal varni --, es egy nev alatt
# osszemosva az elsot hisszuk el.
if d.get('mergeable') is None:
    import time as _t
    for _ in range(6):
        _t.sleep(5)
        text, _ = api('GET', f'/pulls/{pr}')
        d = json.loads(text)
        if d.get('mergeable') is not None:
            break
    print(f'   [a mergeable elso lekerdezeskor meg szamolodott; ujrakerdezve: {d.get("mergeable")}]')

if d.get('mergeable') is None:
    print('NEM OLVASZTOK: a GitHub fel perc utan sem szamolta ki, egyesitheto-e. '
          'Ez NEM utkozes, csak nem tudjuk -- probald ujra.'); sys.exit(1)
if not d.get('mergeable'):
    print('NEM OLVASZTOK: a PR nem egyesitheto (VALODI utkozes).'); sys.exit(1)

# === UJ NEV, AMI MAR ALL A BASE-EN: MAS MAR BEVITTE UGYANAZT? ===
#
# MIERT LETEZIK (sajat meres, 2026-09-08 hajnal): a #153 olyan tokent vezetett be,
# amit a #145 egy oraval korabban MAR bevitt. En olvasztottam be a duplikatumot: a
# CI zold volt, a `mergeable` igaz, es a szkript helyesen mondta, hogy nincs
# akadalya -- csak epp nem arra a kerdesre valaszolt, ami szamitott.
#
# AZ ELSO VALTOZATOM NEM MUKODOTT, ES EZT ITT HAGYOM, MERT TANULSAG. Eloszor a
# FAJL-ATFEDEST neztem: "olvadt-e be mas ugyanabba a fajlba, MIUTAN ez a PR
# megnyilt". Lekalibraltam, es KIDERULT, HOGY A MOTIVALO ESETRE SEM TUZELT: a #145
# 01:37-kor olvadt be, a #153 pedig 02:37-kor NYILT MEG -- egy teljes oraval kesobb.
# Nem az volt a baj, hogy az ag nem lathatta, hanem hogy a szerzo nem nezte meg.
# Egy orzo, ami epp arra vak, amiert epult, rosszabb a semminel: hamis nyugalmat ad.
#
# A MUKODO JEL: a diff bevezet-e OLYAN NEVET (CSS valtozo vagy exportalt szimbolum),
# ami a base agon MAR OTT ALL ugyanabban a fajlban. Ket kizarassal:
#   - ha ugyanaz a nev a diffben TOROLVE is van, az MODOSITAS, nem uj nev
#   - ujonnan letrehozott fajlra nincs base-verzio, tehat kimarad
#
# KALIBRALVA hat PR-en (2026-09-08): #153 -> TUZEL (`--terv-kiemel-tinta`),
# #148, #149, #151, #152, #154 -> csendes. A #151 az elso valtozatban HAMISAN tuzelt
# (a `szakaszokVilagra` mar letezett, mert a PR MODOSITOTTA) -- ezt zarja ki a
# torles-vizsgalat.
#
# NEM KAPU, HANEM FIGYELMEZTETES: egymasra epulo munkanal elofordulhat jogosan, es
# aki blokkolna vele, azt harom nap alatt kikapcsoljak.
import re as _re

_DEF = [_re.compile(r'^\+\s*(--[a-z0-9-]+)\s*:'),
        _re.compile(r'^\+\s*export\s+(?:const|function|type|interface|class)\s+([A-Za-z0-9_]+)')]

def _nyers(path):
    r = subprocess.run(['curl', '-sL', '-m', '30',
                        '-H', '@-',
                        '-H', 'Accept: application/vnd.github.raw',
                        f'https://api.github.com/repos/{repo}{path}'],
                       input='Authorization: Bearer ' + tok + '\n', capture_output=True, text=True)
    return r.stdout

_base = d.get('base', {}).get('sha')
_ft, _fk = api('GET', f'/pulls/{pr}/files?per_page=100')
_utkozo = []
if _fk == '200' and _base:
    try:
        _files = json.loads(_ft)
    except Exception:
        _files = []
    _nevek, _torolt = {}, set()
    for _f in _files:
        for _sor in (_f.get('patch') or '').splitlines():
            for _rx in _DEF:
                _m = _rx.match(_sor)
                if _m:
                    _nevek.setdefault(_m.group(1), set()).add(_f['filename'])
                if _sor.startswith('-'):
                    _m2 = _rx.match('+' + _sor[1:])
                    if _m2:
                        _torolt.add(_m2.group(1))
    _nevek = {k: v for k, v in _nevek.items() if k not in _torolt}
    if _nevek:
        _alap = {}
        for _f in _files:
            if _f.get('status') == 'added':
                continue
            _alap[_f['filename']] = _nyers(f"/contents/{_f['filename']}?ref={_base}")
        for _nev, _hol in _nevek.items():
            for _fn in _hol:
                if _nev in _alap.get(_fn, ''):
                    _utkozo.append((_nev, _fn))
                    break

if _utkozo:
    print('   ---')
    print('   FIGYELEM: a PR olyan nevet vezet be, ami a base agon MAR OTT ALL.')
    print('   Nezd meg, nem ugyanazt a munkat viszi-e, amit mas mar beadott:')
    for _nev, _fn in _utkozo:
        print(f'     {_nev}   mar all itt: {_fn}')
    print('   (Ez NEM akadaly: egymasra epulo munkanal lehet jogos.)')
    print('   ---')

# === A KOZOS FAJLU NYITOTT PR-EK (sajat hiba, 2026-10-08 19:04) ===
#
# A #1640 mar jova volt hagyva, en megis elobb a #1638-at olvasztottam be. A ketto egy
# fajlon osztozott (docs/FIGMA-MAP.md), tehat a #1640 ujra a fo agra kellett hozni, es
# a CI-je negyedszer futott. Balazs 19:23-kor rakerdezett, es aznap MASODSZOR csusztunk
# a sorrenden (11:29). A szabaly ("a korabban kesz megy elobb") addig uzenetben allt.
#
# Ezert itt KAPU: ha egy masik nyitott, nem draft PR ugyanazt a fajlt modositja, a
# beolvasztas megall, es kiirja, melyik PR, melyik fajl. A jovahagyas sorrendjet a
# GitHub nem tudja (barracuda uzenetben hagy jova), tehat azt csak az indok mondhatja
# meg: --kozos-fajl-rendben "a #N kesobb kesz / meg nincs jovahagyva".
if not kozos_ok:
    _lt, _lk = api('GET', '/pulls?state=open&per_page=50')
    _sajat = {_f['filename'] for _f in json.loads(_ft)} if _fk == '200' else set()
    _kozos = []
    if _lk == '200' and _sajat:
        for _p in json.loads(_lt):
            if str(_p['number']) == str(pr) or _p.get('draft'):
                continue
            _pt2, _pk2 = api('GET', f"/pulls/{_p['number']}/files?per_page=100")
            if _pk2 != '200':
                continue
            _m = sorted(_sajat & {_f['filename'] for _f in json.loads(_pt2)})
            if _m:
                _kozos.append((_p['number'], _m))
    elif _lk != '200':
        print(f'NEM OLVASZTOK: a nyitott PR-ek listaja nem jott meg (HTTP {_lk}), a kozos fajlt nem tudom kizarni.')
        sys.exit(1)
    if _kozos:
        print('NEM OLVASZTOK: masik nyitott PR ugyanazt a fajlt modositja, es a beolvasztas')
        print('ujrafuttatast kenyszerit ra. Ha az a PR korabban lett kesz, az menjen elobb:')
        for _n, _m in _kozos:
            print(f"   #{_n}: {', '.join(_m[:5])}{' ...' if len(_m) > 5 else ''}")
        print('Feloldas: --kozos-fajl-rendben "a #N kesobb kesz / meg nincs jovahagyva"')
        sys.exit(1)
else:
    print(f'   kozos fajl feloldva: {kozos_ok}')

def _feladat_esemeny(extra):
    # TC-Lite L4: a merged esemeny a feladatra, a sajat ellenorzeseivel (beolvadt-esemeny.py)
    subprocess.run(['python3', '-B', esemeny_szkript, '--task', task, '--repo', repo, '--pr', str(pr),
                    '--head', sha, '--base', _bazis_ref] + extra)

if nez:
    print('CSAK NEZEM (--nez): minden feltetel teljesul, de NEM olvasztok be.')
    if task:
        _feladat_esemeny(['--put-code', '000', '--nez'])
    sys.exit(0)

text, code = api('PUT', f'/pulls/{pr}/merge', {'merge_method': 'squash', 'sha': sha})
print('HTTP', code, text.strip()[:200])
if task:
    import tempfile
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as _tf:
        _tf.write(text)
    try:
        _feladat_esemeny(['--put-code', code, '--put-body-file', _tf.name])
    finally:
        os.unlink(_tf.name)

# A BEOLVASZTAS NEM TELEPITES -- ES A REPON BELUL A KET ALKALMAZAS MASKENT MEGY.
#
# MERVE 2026-09-22 14:2x, es a mulasztas az enyem volt. Az `acropora-partner`
# Coolify-alkalmazasan BE van kapcsolva az automatikus telepites, az
# `acropora-api`-n NINCS. Egy PR, ami mind a kettot erinti, tehat beolvasztaskor
# KIMEGY FELIG: a felulet a mai fejre ugrik, a hatterszolgaltatas a regi kodon
# marad.
#
# AMIERT EZ ROSSZABB, MINT HA EGYIK SEM MENNE KI: valami LATHATOAN telepult,
# tehat a "beolvadt" ugy nez ki, mint a "kint van". A #974-nel a szukites
# teljes egeszeben a hatterszolgaltatasban allt, a partner-fel pedig csak egy
# atszervezes volt -- fel oraig ugy allt a rendszer, hogy a javitas bent volt
# es semmit nem valtoztatott. Balazs talalta meg, nem en szoltam.
#
# A tanulsag aznap reggel 10:50-kor MAR LE VOLT IRVA a naplomban ("a telepites
# utani 'mi NINCS meg kesz' mondatot azelott kell megirni, hogy a gazda
# kiprobalja"), es negy oraval kesobb ugyanabban a sessionben megszegtem.
# Ezert kerult ORZOBE: egy szabaly, ami csak jegyzetben all, a leiroja ellen
# sem ved.
#
# 2026-10-07 06:43 UTC OTA a partner-felulet automatikus telepitese is KI van
# kapcsolva (Balazs: "kapcsold ki", Eldontendo szal, msg 1557282082898575401,
# mert ket allatkerti partner mar hasznalja). A felig-kimenes tehat mar nem
# fenyeget; az orzo marad, mert a beolvasztas utan a kiadas tovabbra is kulon lepes.
if code == '200':
    # A SZUKITES OKA: AZ ELSO ALAKOM ZAJT ADOTT (merve 2026-09-22, a #978-on).
    # Az a PR EGYETLEN fajlt vitt az apps/api ala, egy `.spec.ts`-t, 24 hozzaadott
    # sorral, amibol NULLA volt nem-komment. A figyelmeztetes megis elsult, es
    # telepitesi engedelyt kert valamire, ami nem valtoztat a futo szolgaltatason.
    #
    # Ez ugyanaz a hiba, amit a gyorsitotar-jaratnal mar egyszer kijavitottam:
    # egy orzo, ami elsul, de nem tud segiteni, nem vedelem, hanem diszlet -- es
    # ami rosszabb, SZOKTAT. Ha minden masodik beolvasztas utan szol, a nap vegen
    # senki nem olvassa el, es akkor az a beolvasztas is atcsuszik, amelyik
    # tenyleg kimaradt volna.
    #
    # A teszt-fajlok SOHA nem valtoztatnak a telepitett viselkedesen: a futo kep
    # nem hivja oket. Ezert kimaradnak a szamolasbol. Ha egy PR CSAK ilyeneket
    # visz az apps/api ala, a figyelmeztetes nem sul el.
    def _csak_teszt(nev):
        return ('.spec.' in nev or '.test.' in nev or '/__tests__/' in nev)
    _api_fajlok = []
    try:
        if _fk == '200':
            _api_fajlok = [f['filename'] for f in json.loads(_ft)
                           if f.get('filename', '').startswith('apps/api/')
                           and not _csak_teszt(f.get('filename', ''))]
    except Exception:
        _api_fajlok = []
    if _api_fajlok:
        print('   ---')
        print('   EZ A PR A HATTERSZOLGALTATAST IS ERINTI (%d fajl az apps/api ala).' % len(_api_fajlok))
        print('   AZ `acropora-api` NEM TELEPUL MAGATOL (2026-10-07 ota a partner-felulet')
        print('   sem): a valtozas csak a te kiadasoddal megy ki, es addig bent van, de nem el.')
        print('   A telepites KIFEJEZETT ENGEDELYT igenyel a gazdatol -- kerd el, es')
        print('   mondd meg, MI menne ki. Ne hagyd a beolvasztast telepites nelkul')
        print('   ugy, hogy nem szoltal rola.')
        print('   ---')

sys.exit(0 if code == '200' else 1)
PYEOF
