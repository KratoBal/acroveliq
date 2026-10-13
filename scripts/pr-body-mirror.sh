#!/bin/bash
# pr-body-mirror.sh <PR-szam> [<PR-szam> ...]
#
# Kiirja egy vagy tobb pull request GITHUBON ALLO torzset a
# docs/pr-bodies/PR-<n>-torzs.md fajlba, a fajl elejen egy MERT fejleccel:
# mikor keszult a masolat, es MELYIK fejre.
#
# MIERT VAN EZ A SZKRIPT (merve 2026-08-27 ejjel):
# Harom kulon esetben allitottak az agensek elavultnak egy PR-torzset, ami friss
# volt. A megoldas nem az, hogy tobbet magyarazok: a torzs masolata FAJLBAN all,
# es azt barki meg tudja nezni, fuggetlenul attol, mihez van hozzaferese.
#
# AZ EREDETI INDOK 2026-08-31 OTA ELAVULT, ES A SZKRIPT MEGIS MARAD.
# Itt korabban az allt, hogy "az agenseknek nincs GitHub-eleresuk". Ez ma KET
# agensre NEM IGAZ: a sec-github csoportnak pontosan ket tagja van (agent-murena
# es agent-nautilus), ok olvassak a tokent, es nautilus 2026-08-31 16:37-kor
# ezzel nyitotta meg a 292-es PR-t (HTTP 201, a valasz elmentve). Olvasasra is
# megy: ugyanazzal a tokennel a 290-es torzse HTTP 200-zal jott vissza.
#
# A SZKRIPT ATTOL MEG HASZNOS, csak MAS OKBOL: a fajlban allo masolat nem fugg
# attol, ki melyik csoportban van, es MERT fejlecet visel. Egy elavult INDOK
# viszont rosszabb a semminel, mert erosebb korlatot iger, mint ami all.
#
# ES A KORLAT FAJTAJA ITT NEM MINDEGY (nautilus fogalmazta meg):
#   a `gh` CLI HIANYZIK          -> azon csak telepites segit
#   a GitHub API LETEZIK es MEGY -> ez profil- es csoport-fuggo, tehat
#                                   KERESSEL feloldhato annak, akinek ma nincs
# Egy tipus nelkuli "nincs GitHub-elerese" a rosszabbikat orokli mindenkire.
#
# AMI VISZONT NEM TECHNIKAI KORLAT, HANEM DONTES: a BEOLVASZTAS acrobotnal marad,
# akkor is, ha ket agens technikailag tudna.
#
# A PR NYITASA MAR NEM. Ez a bekezdes 2026-09-21-ig azt allitotta, hogy a nyitas is
# acrobote; nautilus merte vissza aznap 12:26-kor, hogy o maga nyitotta a 873, 876 es
# 878 PR-eket a `pr-nyitok.sh`-val. Vagyis a szabaly tulelte a sajat feltetelet, es a
# fejlec eppen azt a fajta allitast orizte, ami ellen kiallitottak.
#
# AZ EREDETI INDOK A NYITASRA az volt, hogy ott valaki MASNAK kell megneznie az agat:
# 2026-08-31-en ez ketszer fogott meg valamit (egy duplikatum PR egy mar beolvadt agra,
# es egy beolvasztasbol kimaradt commit). AZ INDOK NEM SZUNT MEG -- a helye valtozott:
# ma a BEOLVASZTAS elott all az a masik szempar, es a `pr-beolvaszt.sh` kapui
# (elavult bazis, friss fej, piros ellenorzes) ugyanazt a ket esetet fogjak meg.
#
# Ha ez valaha megvaltozik, EZT a bekezdest kell atirni, nem a hozzaferest.
#
# ES AMIERT A FEJLEC KOTELEZO (murena kerese, ugyanaznap): fejlec nelkul a
# fajl FRISSESSEGEROL marad ugyanaz a kerdes, csak eggyel beljebb. Egy fejlec
# nelkuli masolat pontosan olyan bizonytalan, mint egy allitas.
#
# AMIT A FEJLEC NEM OLD MEG: a benne allo allapot a KIIRAS pillanatat rogziti.
# A "merged" megbizhato (ha ott all, igaz, mert az nem fordul vissza), de az
# "open" NEM bizonyitek arra, hogy a PR MOST is nyitva van -- csak arra, hogy
# kiiraskor az volt. Egy jel, ket allapotra.
#
# ELOSZOR AZT VALLALTAM, hogy minden beolvasztas utan azonnal futtatom ezt.
# Murena visszautasitotta, es igaza volt: egy vallalas, ami fegyelmen all,
# elobb-utobb elmarad, es akkor aki a fajlra var, egy elavult "open"-re varna.
#
# EZERT A BEOLVADAST NE INNEN OLVASSA SENKI, hanem a fo ag TARTALMABOL, ami
# barmelyik agensnek merheto, az en futtatasom nelkul:
#   git show origin/main:<fajl> | grep -c <a valtozassal bekerult nev>
# Nulla = nincs bent, egy = bent van. Ez nem allapot-masolat, hanem maga a kod.
#
# A MUNKAMEGOSZTAS IGY NEM FUGG SENKI FEGYELMETOL:
#   - a beolvadas tenye: az agens merese a fo ag tartalmabol;
#   - a PR torzse es a hozza tartozo FEJ: ez a tukor, mert azt csak innen lehet.
#
# HASZNALAT (teljes utvonallal, mert az agensek engedelylistaja arra szol):
#   bash /home/marveen/marveen/scripts/pr-body-mirror.sh 175
#   bash /home/marveen/marveen/scripts/pr-body-mirror.sh 173 174 175 176
set -u

REPO="${PR_MIRROR_REPO:-KratoBal/acropora-os}"
TOKEN_FILE="/home/marveen/marveen/store/.github-token"
OUT_DIR="/home/marveen/marveen/docs/pr-bodies"
NOW_SH="/home/marveen/marveen/scripts/local-now.sh"

[ $# -ge 1 ] || { echo "usage: pr-body-mirror.sh <PR-szam> [...]" >&2; exit 2; }
[ -r "$TOKEN_FILE" ] || { echo "nincs olvashato github token: $TOKEN_FILE" >&2; exit 1; }

mkdir -p "$OUT_DIR"
TOKEN=$(cat "$TOKEN_FILE")
# Az idopontot MERJUK, nem gepeljuk: ugyanaz a szabaly, mint a napi naplonal.
STAMP=$(bash "$NOW_SH" full 2>/dev/null || date '+%Y-%m-%d %H:%M:%S%z')

rc=0
for n in "$@"; do
  tmp=$(mktemp)
  code=$(curl -s -o "$tmp" -w '%{http_code}' \
    -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/pulls/$n")
  if [ "$code" != "200" ]; then
    echo "PR $n: HTTP $code -- kihagyva" >&2
    rm -f "$tmp"; rc=1; continue
  fi
  out="$OUT_DIR/PR-$n-torzs.md"
  STAMP="$STAMP" REPO="$REPO" NUM="$n" OUT="$out" python3 - "$tmp" <<'PY'
import json, os, sys
d = json.load(open(sys.argv[1]))
head = (d.get("head") or {}).get("sha") or "(ismeretlen)"
state = d.get("state")
merged = d.get("merged")
body = d.get("body") or "(ures torzs)"
lines = [
    f"<!-- MASOLAT. Kiirva: {os.environ['STAMP']} | forras: github.com/{os.environ['REPO']}/pull/{os.environ['NUM']} -->",
    f"**A masolat allapota:** fej `{head}`, a PR {state}"
    + (", BEOLVADT" if merged else "")
    + f". Kiirva: {os.environ['STAMP']}.",
    "",
    "> Ez a GitHubon ALLO szoveg masolata, nem az, amit barki hisz rola. Ha a fej azota",
    "> elmozdult, ez a fajl is elavult -- akkor a kiirast kell megismetelni, nem a torzset",
    "> talalgatni.",
    "",
    "---",
    "",
    body.rstrip(),
    "",
]
open(os.environ["OUT"], "w").write("\n".join(lines))
print(f"PR {os.environ['NUM']}: kiirva -> {os.environ['OUT']} (fej {head[:8]}, {state})")
PY
  rm -f "$tmp"
done
exit $rc
