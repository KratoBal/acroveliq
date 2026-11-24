#!/usr/bin/env bash
# ANSWERS: Hogyan kotjuk be a ticket@acropora.hu postafiokot (Gmail) a flottahoz, es
# mi all benne -- OLVASO ag; a kuldes NEM itt lakik.
#
# === MIERT LETEZIK (Balazs kerese, 2026-09-18 12:52: "csinaljuk a bekotest") ===
#
# Ket dolog all ezen a bekotesen, es egyetlen jovahagyas szolgalja mind a kettot:
#   1. a lezart hibajegy csomagjanak KIKULDESE a partnernek     (kartya 5247bf3c)
#   2. a beerkezo hibabejelentes FELDOLGOZASA AI-jal            (kartya ec7b947b)
#
# === AMIERT A KULDES SZANDEKOSAN NINCS BENNE EBBEN A SZKRIPTBEN ===
#
# A `gmail.send` scope BENNE VAN a kert keszletben, mert kulonben masodik jovahagyasi kor
# kellene. De ez a szkript nem tud kuldeni, es nem is fog: egy kimeno level a VEVO ele
# megy, es annak a helye az API, ahol a cimzett, a targy es a torzs a rendszer adatabol
# all ossze, nem egy parancssorbol. Egy shell-parancs, ami levelet kuld, pontosan az a
# fajta eszkoz, amit egy rossz pillanatban ki lehet adni tevedesbol.
#
# === A MERES, AMI A BEALLITAST ELDONTOTTE (2026-09-18) ===
#
#   curl -s -H "accept: application/dns-json" "https://1.1.1.1/dns-query?name=acropora.hu&type=MX"
#   -> aspmx.l.google.com es tarsai
#
# Vagyis az acropora.hu levelezese a Google rendszeren fut: WORKSPACE fiok. Ez azert
# szamit, mert a consent kepernyon EKKOR valaszthato a "User type: Internal", es az
# egyszerre ket dolgot old meg:
#   - nincs het napos refresh-token lejarat (az a Testing plusz External sajatja), es
#   - a Gmail scope-ok (a Google besorolasaban "restricted") NEM vonnak maguk utan
#     biztonsagi atvilagitast, mert a hatokor a szervezeten belul marad.
# Az Internal viszont CSAK akkor valaszthato, ha a Cloud projekt a SZERVEZETHEZ tartozik,
# nem egy maganfiokhoz -- ezt kivulrol nem latni, a consent kepernyon latszik.
#
# Hitelesito adatok (chmod 600, a store/ gitignore alatt all):
#   store/.ticket-mail-client-id      OAuth kliens azonosito (Desktop app tipus)
#   store/.ticket-mail-client-secret  OAuth kliens titok
#   store/.ticket-mail-refresh-token  az `auth-code` irja ki, ez a hosszu eletu
#   store/.ticket-mail-access-token   rovid eletu gyorsitotar, magatol frissul
#
# Hasznalat:
#   bash scripts/ticket-mail.sh auth-url          # a jovahagyasi link
#   bash scripts/ticket-mail.sh auth-code <kod>   # a cimsorbol kimasolt code= ertek
#   bash scripts/ticket-mail.sh whoami            # MELYIK postafiokra kotottuk
#   bash scripts/ticket-mail.sh lista [n]         # a legutobbi levelek (felado, targy)
#
# AZ OLVASO TOKEN (kartya ec7b947b, acrobot 60314; Balazs Google-engedelye 2026-11-24 09:54 UTC):
#   bash scripts/ticket-mail.sh auth-url-olvaso      # jovahagyasi link CSAK gmail.readonly-ra
#   bash scripts/ticket-mail.sh auth-code-olvaso     # a cimsort a TERMINALBAN keri be (nem argv)
#   bash scripts/ticket-mail.sh olvaso-ellenoriz     # a token hatokore, a postafiok, es hogy NEM kuld
set -uo pipefail

ROOT=/home/marveen/marveen
CID_FILE="$ROOT/store/.ticket-mail-client-id"
SEC_FILE="$ROOT/store/.ticket-mail-client-secret"
REFRESH_FILE="$ROOT/store/.ticket-mail-refresh-token"
ACCESS_FILE="$ROOT/store/.ticket-mail-access-token"
# AZ OLVASO TOKEN KULON FAJL, ES SOSEM A FENTI: a hibajegy-bevitel (GMAIL_TICKET_READ_*) sajat,
# csak olvaso tokent kap, hogy az olvaso folyamat ne tudjon kuldeni. Ugyanaz a Desktop kliens
# (ticket-mail-2026-10, emlek 2355), csak a hozzajarulas ker kevesebbet. A regi `auth-code` a
# kuldo tokent irja; ha ugyanabba a fajlba irna, a kuldes csendben elhalna.
READ_REFRESH_FILE="$ROOT/store/.ticket-mail-read-refresh-token"
READ_ACCESS_FILE="$ROOT/store/.ticket-mail-read-access-token"
READ_SCOPE="https://www.googleapis.com/auth/gmail.readonly"
TICKET_USER="ticket@acropora.hu"
REDIRECT="http://localhost:8765/"

# A KET SCOPE, ES MIERT PONTOSAN EZ A KETTO:
#   gmail.readonly  a beerkezo bejelentes elolvasasahoz (csatolmanyostul)
#   gmail.send      a lezart jegy csomagjanak kikuldesehez
# AMI SZANDEKOSAN KIMARAD: `gmail.modify` es `mail.google.com`. Azok TORLESRE es a
# postafiok atrendezesere is jogot adnanak, es azt egyik feladat sem keri. Ha egyszer
# kellene (peldaul olvasottra allitas), az kulon dontes es kulon jovahagyasi kor.
SCOPES="https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send"

die() { echo "FAIL: $*" >&2; exit 1; }

# A `die` PARANCS-BEHELYETTESITESEN BELUL CSAK A RESZHEJAT OLLI EL, A HIVOT NEM.
# Sajat hiba, merve 2026-09-18 15:0x, a szkript elso probajan: a `cid="$(read_file ...)"`
# alakban a hianyzo fajl FAIL-t irt ki, a fuggveny MEGIS tovabb futott, es kiirt egy
# jovahagyasi linket URES `client_id=` ertekkel. Az a link megnyilik, es a Google egy
# ertelmezhetetlen hibaval utasitja el -- vagyis a gazda kezebe adtam volna egy nem
# mukodo linket, ugy, hogy a FAIL sor kozvetlenul FOLOTTE all a kimeneten.
# Ugyanaz a csalad, mint a pipe bal oldalan allo `die`: a hibajelzes megvan, a megallas nincs.
# A megoldas: a beolvasas a hivoban ellenoriz, es a fuggveny csak ELLENORZOTT ertekkel indul.
need_file() { [ -r "$1" ] || die "hianyzik vagy nem olvashato: $1"; }
read_file() { need_file "$1"; cat "$1"; }

auth_url() {
  need_file "$CID_FILE"
  local cid; cid="$(cat "$CID_FILE")"
  CID="$cid" REDIRECT="$REDIRECT" SCOPES="$SCOPES" python3 -c '
import os, urllib.parse
q = {
    "client_id": os.environ["CID"],
    "redirect_uri": os.environ["REDIRECT"],
    "response_type": "code",
    "scope": os.environ["SCOPES"],
    # E KETTO NELKUL A BEKOTES EGY ORA MULVA HALOTT:
    "access_type": "offline",   # enelkul NINCS refresh token, csak access
    "prompt": "consent",        # enelkul ismetelt jovahagyasnal nem ad UJ refresht
}
print("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(q))
'
  echo
  echo "NYISD MEG, ES A FIOKVALASZTOBAN A ticket@acropora.hu FIOKOT VALASZD."
  echo "A jovahagyas utan a bongeszo egy localhost cimre dob, ami NEM TOLT BE -- ez NORMALIS."
  echo "A cimsorbol a code= erteket kell kimasolni."
}

auth_code() {
  local code="${1:-}"
  [ -n "$code" ] || die "hasznalat: ticket-mail.sh auth-code <a code= ertek>"
  # A teljes cimsor is elfogadhato: kiszedjuk belole a code parametert.
  case "$code" in *code=*) code="${code#*code=}"; code="${code%%&*}";; esac
  local cid sec; cid="$(read_file "$CID_FILE")"; sec="$(read_file "$SEC_FILE")"
  local resp
  resp="$(curl -s -m 30 -X POST https://oauth2.googleapis.com/token \
    --data-urlencode "code@"<(printf '%s' "$code") --data-urlencode "redirect_uri=$REDIRECT" \
    --data-urlencode "client_id=$cid" --data-urlencode "client_secret@"<(printf '%s' "$sec") \
    --data-urlencode "grant_type=authorization_code")"
  RESP="$resp" OUT="$REFRESH_FILE" python3 -c '
import json, os, sys
d = json.loads(os.environ["RESP"])
if "refresh_token" not in d:
    # A LEGGYAKORIBB NEMA HIBA: jon access token, minden jonak tunik, es egy ora mulva vege.
    extra = " (jott access token, de refresh NEM -- hianyzik az access_type=offline, vagy a prompt=consent?)" if "access_token" in d else ""
    print("FAIL: nincs refresh_token a valaszban%s\n%s" % (extra, json.dumps(d)[:400]), file=sys.stderr)
    sys.exit(1)
p = os.environ["OUT"]
old = os.umask(0o077)
with open(p, "w") as f: f.write(d["refresh_token"])
os.umask(old)
print("OK, a refresh token kiirva:", p)
'
}

access_token() {
  [ -f "$REFRESH_FILE" ] || { echo "FAIL: nincs meg jovahagyas. Eloszor: ticket-mail.sh auth-url, majd auth-code" >&2; return 1; }
  # Gyorsitotar, lejarat elott 60 masodperccel valtunk.
  if [ -f "$ACCESS_FILE" ]; then
    local age; age=$(( $(date +%s) - $(stat -c %Y "$ACCESS_FILE" 2>/dev/null || echo 0) ))
    if [ "$age" -lt 3540 ]; then cat "$ACCESS_FILE"; return 0; fi
  fi
  local cid sec rt resp; cid="$(read_file "$CID_FILE")"; sec="$(read_file "$SEC_FILE")"; rt="$(read_file "$REFRESH_FILE")"
  resp="$(curl -s -m 30 -X POST https://oauth2.googleapis.com/token \
    --data-urlencode "client_id=$cid" --data-urlencode "client_secret@"<(printf '%s' "$sec") \
    --data-urlencode "refresh_token@"<(printf '%s' "$rt") --data-urlencode "grant_type=refresh_token")"
  RESP="$resp" OUT="$ACCESS_FILE" python3 -c '
import json, os, sys
d = json.loads(os.environ["RESP"])
if "access_token" not in d:
    print("FAIL: nincs access_token: %s" % json.dumps(d)[:400], file=sys.stderr); sys.exit(1)
old = os.umask(0o077)
with open(os.environ["OUT"], "w") as f: f.write(d["access_token"])
os.umask(old)
print(d["access_token"])
'
}

# UGYANAZ AZ OK, MINT A need_file-nal: az `access_token` a reszhejban hal el, tehat a
# kilepesi kodot KULON kell megnezni, kulonben a hivo egy URES tokennel megy tovabb, es a
# hiba egy python traceback alakjaban jelenik meg -- a valodi ok (nincs jovahagyas) helyett.
api_get() {
  local path="$1" tok
  tok="$(access_token)" || exit 1
  [ -n "$tok" ] || die "ures access token -- a jovahagyas hianyzik vagy lejart"
  curl -s -m 30 -H @<(printf 'Authorization: Bearer %s\n' "$tok") "https://gmail.googleapis.com/gmail/v1/users/me/$path"
}

# ELOELLENORZES A CSOVEZETEK ELE, ES EZ NEM OVATOSSAG, HANEM MERT HIBA.
# Sajat probam, 2026-09-18 15:0x: a `whoami` helyesen kiirta, hogy nincs jovahagyas, majd
# MEGIS lefutott a python a cso jobb oldalan -- ures bemeneten --, es a valodi uzenet ala
# begorgott egy JSONDecodeError traceback. A cso BAL oldalan allo `exit` csak a reszhejat
# olli el; a jobb oldal akkor is elindul.
# Ezert minden csovezetekes parancs ELOTT all ez, kulonben minden hitelesitesi hiba
# ertelmezhetetlen stacktrace-kent jelenik meg.
require_auth() {
  [ -r "$CID_FILE" ] && [ -r "$SEC_FILE" ] && [ -r "$REFRESH_FILE" ] \
    || die "nincs meg a bekotes. Sorrend: auth-url -> a gazda jovahagyja -> auth-code <kod>"
}

# AZ ELLENORZES AZT A VEGPONTOT HIVJA, AMIT A MUNKA IS HASZNAL (profil, nem fiokbeallitas):
# egy szuk scope a "altalanos" vegpontokon 403-at ad, es abbol hamis negativ lesz.
whoami() {
  require_auth
  api_get "profile" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if "emailAddress" not in d:
    print("FAIL: %s" % json.dumps(d)[:400], file=sys.stderr); sys.exit(1)
print("postafiok:", d["emailAddress"], "| levelek:", d.get("messagesTotal"), "| szalak:", d.get("threadsTotal"))
'
}

lista() {
  require_auth
  local n="${1:-10}" tok
  tok="$(access_token)" || exit 1
  [ -n "$tok" ] || die "ures access token -- a jovahagyas hianyzik vagy lejart"
  curl -s -m 30 -H @<(printf 'Authorization: Bearer %s\n' "$tok") \
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=$n" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
ids = [m["id"] for m in d.get("messages", [])]
print("azonositok:", len(ids))
for i in ids: print(" ", i)
'
}

# === AZ OLVASO TOKEN ===
#
# A link CSAK a gmail.readonly-t keri, es `include_granted_scopes` NINCS benne: e nelkul a Google
# a mar korabban megadott (send) jogot NEM teszi hozza, tehat az uj token valoban csak olvas.
# A `login_hint` a ticket@ fiokot ajanlja a fiokvalasztoban: egy rossz fiokra kotott token
# olvasna, csak nem azt a postafiokot.
auth_url_olvaso() {
  need_file "$CID_FILE"
  local cid; cid="$(cat "$CID_FILE")"
  [ -n "$cid" ] || die "ures: $CID_FILE"
  CID="$cid" REDIRECT="$REDIRECT" SCOPE="$READ_SCOPE" HINT="$TICKET_USER" python3 -c '
import os, urllib.parse
q = {
    "client_id": os.environ["CID"],
    "redirect_uri": os.environ["REDIRECT"],
    "response_type": "code",
    "scope": os.environ["SCOPE"],
    "access_type": "offline",
    "prompt": "consent",
    "login_hint": os.environ["HINT"],
}
print("https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(q))
'
  echo
  echo "NYISD MEG ${TICKET_USER}-kent. A jovahagyas utan a bongeszo egy localhost cimre dob,"
  echo "ami NEM TOLT BE -- ez NORMALIS. A TELJES cimsort masold ki, es a auth-code-olvaso kerje be."
}

# A KOD A TERMINALBOL JON, NEM ARGUMENTUMKENT: az argv-t minden folyamat-lista mutatja (P0-1).
# A kod egyszer hasznalhato es percek alatt lejar, de a terminal-bekeres semmibe sem kerul.
auth_code_olvaso() {
  [ "$#" -eq 0 ] || die "a kodot NE argumentumkent add meg: auth-code-olvaso, utana a terminal kerdezi"
  local cid sec code
  cid="$(read_file "$CID_FILE")"; sec="$(read_file "$SEC_FILE")"
  printf 'Illeszd be a localhost cimsort (vagy csak a code= erteket), majd Enter: ' >&2
  IFS= read -r -s code || die "nem jott bemenet"
  echo >&2
  case "$code" in *code=*) code="${code#*code=}"; code="${code%%&*}";; esac
  code="$(printf '%s' "$code" | python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read().strip()))')"
  [ -n "$code" ] || die "ures kod"
  local resp
  resp="$(curl -s -m 30 -X POST https://oauth2.googleapis.com/token \
    --data-urlencode "code@"<(printf '%s' "$code") --data-urlencode "redirect_uri=$REDIRECT" \
    --data-urlencode "client_id=$cid" --data-urlencode "client_secret@"<(printf '%s' "$sec") \
    --data-urlencode "grant_type=authorization_code")"
  RESP="$resp" OUT="$READ_REFRESH_FILE" WANT="$READ_SCOPE" python3 -c '
import json, os, sys
try:
    d = json.loads(os.environ["RESP"])
except ValueError:
    print("FAIL: a token-valasz nem JSON", file=sys.stderr); sys.exit(1)
if "refresh_token" not in d:
    # a hibaszoveg a Google sajatja (pl. invalid_grant: a kod lejart vagy mar felhasznaltak); titok nincs benne
    print("FAIL: nincs refresh_token a valaszban: %s %s" % (d.get("error", ""), d.get("error_description", "")), file=sys.stderr)
    sys.exit(1)
scopes = set(d.get("scope", "").split())
if scopes != {os.environ["WANT"]}:
    # egy szelesebb token itt NEM kerul fajlba: a READ_* nev olvaso jogot iger
    print("FAIL: a token hatokore nem csak gmail.readonly: %s -- nem irom ki" % " ".join(sorted(scopes)), file=sys.stderr)
    sys.exit(1)
p = os.environ["OUT"]
old = os.umask(0o077)
with open(p, "w") as f: f.write(d["refresh_token"])
os.umask(old)
print("OK, az olvaso refresh token kiirva:", p, "(hatokor: gmail.readonly)")
'
}

read_access_token() {
  local cid sec rt resp
  cid="$(read_file "$CID_FILE")"; sec="$(read_file "$SEC_FILE")"; rt="$(read_file "$READ_REFRESH_FILE")"
  resp="$(curl -s -m 30 -X POST https://oauth2.googleapis.com/token \
    --data-urlencode "client_id=$cid" --data-urlencode "client_secret@"<(printf '%s' "$sec") \
    --data-urlencode "refresh_token@"<(printf '%s' "$rt") --data-urlencode "grant_type=refresh_token")"
  RESP="$resp" OUT="$READ_ACCESS_FILE" python3 -c '
import json, os, sys
try:
    d = json.loads(os.environ["RESP"])
except ValueError:
    print("FAIL: a token-valasz nem JSON", file=sys.stderr); sys.exit(1)
if "access_token" not in d:
    print("FAIL: nincs access_token: %s %s" % (d.get("error", ""), d.get("error_description", "")), file=sys.stderr); sys.exit(1)
old = os.umask(0o077)
with open(os.environ["OUT"], "w") as f: f.write(d["access_token"])
os.umask(old)
'
}

# HAROM ALLITAS, MIND A MUNKA SAJAT VEGPONTJAN (a skill buktatoja: egy rossz vegpont hamis 403-at ad):
#   1. a token hatokore PONTOSAN gmail.readonly  (tokeninfo, a token a TORZSBEN, nem az URL-ben)
#   2. a postafiok a ticket@                     (users/me/profile)
#   3. KULDENI NEM TUD                            (users/me/messages/send ures torzzsel: 403 kell;
#      egy kuldo token erre 400-at adna, level akkor sem menne ki, mert nincs mit kuldeni)
olvaso_ellenoriz() {
  need_file "$CID_FILE"; need_file "$SEC_FILE"
  [ -r "$READ_REFRESH_FILE" ] || die "nincs olvaso token. Sorrend: auth-url-olvaso -> jovahagyas -> auth-code-olvaso"
  read_access_token || exit 1
  local tok; tok="$(cat "$READ_ACCESS_FILE")"
  [ -n "$tok" ] || die "ures access token"
  local info prof send hibak=0
  info="$(curl -s -m 30 -X POST https://oauth2.googleapis.com/tokeninfo --data-urlencode "access_token@"<(printf '%s' "$tok"))"
  prof="$(curl -s -m 30 -H @<(printf 'Authorization: Bearer %s\n' "$tok") https://gmail.googleapis.com/gmail/v1/users/me/profile)"
  send="$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$tok") \
    -d '{}' https://gmail.googleapis.com/gmail/v1/users/me/messages/send)"
  INFO="$info" PROF="$prof" SEND="$send" WANT="$READ_SCOPE" USER_="$TICKET_USER" python3 -c '
import json, os, sys
def load(k):
    try: return json.loads(os.environ[k])
    except ValueError: return {}
bad = 0
scopes = set(load("INFO").get("scope", "").split())
if scopes == {os.environ["WANT"]}:
    print("OK    hatokor: csak gmail.readonly")
else:
    bad += 1; print("HIBA  hatokor: %s" % (" ".join(sorted(scopes)) or "(nem olvashato)"))
mail = load("PROF").get("emailAddress")
if mail == os.environ["USER_"]:
    print("OK    postafiok: %s" % mail)
else:
    bad += 1; print("HIBA  postafiok: %s (a vart: %s)" % (mail, os.environ["USER_"]))
if os.environ["SEND"] == "403":
    print("OK    kuldes: 403, az olvaso token nem kuld")
else:
    bad += 1; print("HIBA  kuldes: %s (403 kellene)" % os.environ["SEND"])
print("OSSZESEN: minden OK" if bad == 0 else "OSSZESEN: %d HIBA" % bad)
sys.exit(1 if bad else 0)
'
}

cmd="${1:-}"; shift || true
case "$cmd" in
  auth-url|auth) auth_url ;;
  auth-code) auth_code "${1:-}" ;;
  whoami) whoami ;;
  lista) lista "${1:-10}" ;;
  auth-url-olvaso) auth_url_olvaso ;;
  auth-code-olvaso) auth_code_olvaso "$@" ;;
  olvaso-ellenoriz) olvaso_ellenoriz ;;
  *) die "ismeretlen parancs: '${cmd:-}' -- auth-url | auth-code | whoami | lista | auth-url-olvaso | auth-code-olvaso | olvaso-ellenoriz" ;;
esac
