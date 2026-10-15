#!/usr/bin/env bash
# ANSWERS: Hogyan megy ki egy eteren at kuldott (OTA) frissites a telefonokra, es
# MI LESZ a runtimeVersion-je -- a kiadas ELOTT, ellenorizhetoen.
#
# === MIERT LETEZIK (merve 2026-09-17) ===
#
# A flotta harom EAS-eszkozt tart a BUILD korul (mobil-build.sh, eas-feltoltes.sh,
# eas-keret.sh), es EGYIK SEM ad ki frissitest. Az `eas update` parancs a fejben
# allt, nem a lemezen -- es ketszer sult el rosszul emiatt:
#
#   1. APP_VARIANT nelkul a kiadas MAS runtimeVersion-t szamol, mint a telepitett
#      build, es a frissites NEMAN nem talal celba (nem hibazik: senki nem kapja meg).
#   2. `--environment` nelkul a parancs el sem indul -- lasd lent, MIERT.
#
# Ez a kilencedik korlat-tipus a lapomon: a KEPESSEG megvan, a parancs nincs.
#
# === AMIT LEMERTEM, ES AMI MIATT EZ IGY NEZ KI ===
#
# BAZIS: aa2982de (origin/main, 2026-09-17), @expo/fingerprint 0.20.6,
# projekt-utvonal `apps/mobile`. Egy ujjlenyomat-szam CSAK ezekkel egyutt ertheto:
# mas utvonalra, mas CLI-vel mas szam jon.
#
#   ios,     APP_VARIANT nelkul       3f4966325b3b6e20f295f8da21cc45f668d1f8e9
#   ios,     APP_VARIANT=production   ba70c226689d4c6daa860b11d67156e9cb873aee
#
# A masodik BETURE (mind a 40 karakteren) az, amit a 2026-09-17 13:22-es eles
# kiadas kiirt. Vagyis a cel a kiadas ELOTT ismert, es utana ELLENORIZHETO --
# nem remelheto.
#
# === ES AZ ANDROID SZAMA HELYBEN NEM REPRODUKALHATO. EZ NEM HIBA, HANEM HATAR ===
#
#   android, APP_VARIANT=production, HELYBEN   2c93a7558e97a7f57e6e503645f96e3d31dc098c
#   ugyanaz a kiadasbol (EAS oldalon)          a5666bdb49dd06f9f9ed7a0e168327661c56e650
#
# Az ok merve: a `google-services.json` a `.gitignore` alatt all, a build gepen EAS
# titokkent jelenik meg, es a TARTALMA benne van az android ujjlenyomatban. Helyben
# a fajl NEM LETEZIK, tehat az itt szamolt android szam egy HARMADIK allapotrol
# szol. A szaraz ag ezert az android erteket KULON megjeloli -- egy mero, ami
# olyat allit, amit nem mert, rosszabb a hianyzo merestnel.
#
# === ES EGY HATAR A SZARAZ AG ERTEKEN: KET KULONBOZO IMPLEMENTACIO SZAMOLJA ===
#
# A szaraz ag a repo SAJAT `@expo/fingerprint`-jevel szamol (0.20.6, a
# node_modules-bol), a valodi kiadas viszont az `eas-cli` BEEPITETT szamitasat
# hasznalja. A ketto MA egyezik -- a 2026-09-17 13:22-es eles kiadas ugyanazt a
# ba70c226... erteket irta ki, amit a szaraz ag ad --, de ezt semmi nem
# garantalja elore.
#
# ES A `@latest` MAR MOZDULT EGY NAP ALATT: a scripts/mobil-build.sh fejlece
# 24.6.0-t mer (2026-09-16), ma 24.7.0 jon. Vagyis a szaraz ag erteke NEM
# jóslat, hanem egy MASODIK meres ugyanarra a kerdesre -- es epp ezert hasznos:
# ha a kiadas MAST ir ki, mint amit itt lattal, az ONMAGABAN lelet.
#
# A zaro blokk ezert keri az osszevetest, ahelyett hogy a szaraz erteket
# igazsagnak nevezne.
#
# === ES EGY HARMADIK ALLAPOT, MERVE 2026-09-18 01:5x: A WORKTREE NEM A KLON ===
#
# Kezenfekvonek latszik, hogy ha a klon piszkos vagy mas commiton all, akkor egy
# `git worktree` mappara szamoltatjuk az ujjlenyomatot, es a CLI-t a klonbol
# hivjuk meg (`fingerprint:generate <utvonal>`). A hivas LEFUT es szamot ad --
# csak nem ugyanazt:
#
#   klonban, 6e2ba89f fejen                ba70c226...  (= amit a kiadas kiirt)
#   worktree UGYANARRA a commitra          a8417fbe...
#   worktree + belinkelt node_modules      439c0e2a...
#
# Harom szam ugyanarra a commitra, es a masodik-harmadik EGYIKE SEM a cel. A
# node_modules belinkelese nem hozza vissza, csak egy harmadik erteket ad.
#
# EZ UGYANAZ A CSALAD, MINT FENT AZ ANDROID: a szam nem hibas, csak MASROL szol,
# es kivulrol megkulonboztethetetlen a jotol. Aki calibracio nelkul veszi at,
# egy nem letezo runtimeVersion-re adna ki frissitest -- ami NEM hibazik, csak
# senki nem kapja meg.
#
# AMIRE VISZONT JO, ES EZT IS MERTEM: KULONBSEG-JELZONEK. Ket worktree ugyanazzal
# a modszerrel szamolva osszevetheto egymassal (6e2ba89f es ee771a76 mindketto
# a8417fbe-t adott, tehat a ket commit kozott a felulet nem mozdult). Abszolut
# ertekként hasznalni tilos, kulonbsegkent szabad.
#
# === MIERT KELL AZ `--environment`, ES MIERT NEM AZERT, AMIT A HIBAUZENET MOND ===
#
# A nem-interaktiv proba ezzel all meg:
#   "The `--environment` flag must be set when running in `--non-interactive` mode."
#
# Ebbol konnyu azt olvasni, hogy a `--non-interactive` teszi kotelezove. A parancs
# SAJAT sugoja mast mond, es az tagabb:
#   "Environment to use for the server-side defined EAS environment variables
#    during command execution. Required for projects using Expo SDK 55 or greater."
#
# Merve: ez a projekt expo 57.0.11-en all, tehat 55 FOLOTT. A kapcsolo tehat
# interaktiv modban is kell -- ott a CLI vart is ra, csak megkerdezi. A
# `--non-interactive` annyit tesz hozza, hogy nincs kit megkerdezni.
# (FELTEVES, es igy is jeloljuk: interaktiv modban NEM probaltam ki.)
#
# === EGY NYITOTT KERDES, AMIT EZ A SZKRIPT NEM DONT EL ===
#
# Az `--environment production` a SZERVER-OLDALI EAS valtozokat tolti be a parancs
# futasa alatt. Ha az EAS `production` kornyezeteben all egy `APP_VARIANT=production`
# bejegyzes, akkor a lenti `APP_VARIANT=` ELOTAG FOLOSLEGES. Ha nem all ott, akkor
# kell. A ketto kivulrol MEGKULONBOZTETHETETLEN: mindketto ugyanazt a hasht adja.
#
# INNEN NEM MERHETO: a lekerdezes (`eas env:list --environment production`) tokent
# kiván, a token pedig a `store/.expo-token` fajlban all, `marveen:sec-expo` 640
# modban. ACROBOT LATJA (o fut `marveen` alatt), egy olvaso paranccsal.
#
# Amig nyitva van, a szkript MINDKETTOT beallitja. Ez a biztonsagos irany: egy
# folosleges kornyezeti valtozo nem ront el semmit, egy hianyzo viszont nemán
# melle kuldi a frissitest.
#
# === HASZNALAT ===
#
#   bash .../mobil-ota.sh                                  <- SZARAZ: csak szamol, NEM ad ki
#   OTA_AG=preview bash .../mobil-ota.sh kiadas "uzenet"   <- valodi kiadas a preview agra
#   bash .../mobil-ota.sh kiadas "az uzenet"               <- NEM ad ki: kiirja Balazsnak a sort
#
# === ELESRE A FLOTTA NEM AD KI (Balazs D5 dontese, A valtozat, 2026-10-15 12:24 UTC) ===
#
# A flotta eles frissitest (production csatorna) NEM ad ki, csak tesztre (preview),
# akkor sem, ha a csatorna az Expoban meg nem vedett. Az elest Balazs futtatja, a sajat
# Expo-belepesevel. Ezert a `kiadas` CSAK a `preview` agra fut le; minden mas agnal
# (production, orzo-meres, barmi ismeretlen) a szkript a token olvasasa es barmilyen
# hivas ELOTT megall, kiirja a Balazs gepen futtatando sort, es 5-tel lep ki.
# Engedelylista, nem tiltolista: egy uj vagy elirt agnev is a megallasra esik.
#
# Az engedely a PARRA szol: preview ag ES preview kornyezet (a preview build is
# `environment: preview`, `APP_VARIANT=preview` mellett epul, apps/mobile/eas.json).
# A kornyezet alaperteke ezert az ag neve: OTA_AG=preview -> --environment preview.
# Egy preview ag production kornyezettel az eles valtozokkal epulne (barracuda, #199).
#
# A KIIRT SOR BALAZS SHELLJEBE KERUL, ezert a hivo szovege nyersen nem mehet bele: az ag
# es a kornyezet neve szuk mintara illeszkedik (kulonben nincs kiirt parancs, csak
# megallas), az uzenet egyes idezojelben, escape-elve all (barracuda, #199).
#
# AMIRE AZ ORZO TAMASZKODIK, ES AMIT NEM MER: hogy egy frissites kihez jut el, az Expo
# csatorna-ag lekepezesen mulik. Az orzo az ag NEVET nezi; ha a production csatornat
# valaki a preview agra allitana, a preview-kiadas elesre menne. A csatorna szerkesztese
# a production csatorna vedette tetele utan (B49 / D5, `channel:protect production`)
# vedett muvelet, amit a flotta robotja nem vegezhet. Lekepezes-ellenorzes a szkriptben
# nincs, mert a `channel:view` kimenetenek alakjat nem mertem.
#
# A szaraz ag az ALAPERTELMEZES, szandekosan: egy `eas update` sikeres futasa utan
# egy KIADAS marad a vilagban, tehat muvelet, nem meres.

set -uo pipefail

KLON="${MOBIL_KLON:-/home/marveen/work/acropora-os}"
TOKEN_FILE="/home/marveen/marveen/store/.expo-token"
AG_NEV="${OTA_AG:-production}"
VALTOZAT="${OTA_VALTOZAT:-$AG_NEV}"

MIT="${1:-szaraz}"
UZENET="${2:-}"

case "$MIT" in
  szaraz|kiadas) ;;
  *)
    echo "hasznalat: mobil-ota.sh [szaraz|kiadas] [uzenet]" >&2
    exit 2
    ;;
esac

# D5 (lasd fent): kiadni csak a preview agra, preview kornyezettel. Ez az ELSO lepes:
# elotte nincs klon, token, npx, tehat egy eles kiadasnak semmilyen resze nem indul el.
KIADHATO_AG="preview"
NEV_MINTA='^[A-Za-z0-9._-]{1,64}$'

# egyes idezojelbe tesz egy szoveget ugy, hogy egy shell egyetlen szokent, szo szerint lassa
egyes() {
  local v="$1"
  printf "'%s'" "${v//\'/\'\\\'\'}"
}

if ! [[ "$AG_NEV" =~ $NEV_MINTA ]] || ! [[ "$VALTOZAT" =~ $NEV_MINTA ]]; then
  echo "MEGALLOK: az ag vagy a kornyezet neve nem illeszkedik a mintara ($NEV_MINTA)."
  echo "   Parancsot nem irok ki: a kiirt sor Balazs shelljebe kerulne."
  exit 5
fi

if [ "$MIT" = "kiadas" ] && { [ "$AG_NEV" != "$KIADHATO_AG" ] || [ "$VALTOZAT" != "$KIADHATO_AG" ]; }; then
  echo "MEGALLOK: a(z) '$AG_NEV' ag '$VALTOZAT' kornyezettel nem adhato ki a flottabol (Balazs D5 dontese, 2026-10-15)."
  echo "   A flotta csak a '$KIADHATO_AG' agra, '$KIADHATO_AG' kornyezettel ad ki; az elest Balazs futtatja, a sajat Expo-belepesevel."
  echo
  echo "--- Balazsnak: a friss main-en, a sajat gepeden ---"
  echo "  cd acropora-os && git pull --ff-only origin main && cd apps/mobile && \\"
  echo "    npx eas-cli@24.8.0 update --branch $AG_NEV --environment $VALTOZAT \\"
  echo "    --message $(egyes "${UZENET:-<uzenet>}")"
  echo
  echo "Elotte, ha meg nem vagy belepve: cd acropora-os/apps/mobile && npx eas-cli@24.8.0 login"
  exit 5
fi

cd "$KLON" 2>/dev/null || { echo "NINCS KLON: $KLON" >&2; exit 1; }

AG="$(git rev-parse --abbrev-ref HEAD)"
FEJ="$(git rev-parse --short HEAD)"
TAVOLI="$(git rev-parse --short origin/main 2>/dev/null || echo ismeretlen)"

echo "--- mobil-ota ($(date '+%Y-%m-%d %H:%M:%S %Z')) ---"
echo "mod        $MIT"
echo "klon       $KLON"
echo "ag         $AG"
echo "fej        $FEJ"
echo "origin     $TAVOLI"
echo "EAS ag     $AG_NEV"
echo "valtozat   $VALTOZAT"

# ORZO: ami ITT all, az megy ki a telefonra. Egy elavult klonbol egy OTA
# frissites REGI kodot kuld ki -- es az nem hibazik, csak rossz.
if [ "$FEJ" != "$TAVOLI" ]; then
  echo
  echo "MEGALLOK: a klon feje NEM egyezik az origin/main fejevel."
  echo "   Egy OTA frissites AZONNAL a telefonokra megy: ami itt all, az megy ki."
  echo "   Huzd ra eloszor:"
  echo "     bash /home/marveen/marveen/scripts/git-auth.sh -C $KLON pull --ff-only origin main"
  exit 3
fi

# ES A MASODIK ORZO, AMIT A FEJ-EGYEZES NEM FED LE: a NEM COMMITOLT valtozas.
# Az `eas update` a MUNKAFABOL csomagol (a Metro a fajlrendszerbol olvas), nem a
# git-bol -- tehat egy felkesz szerkesztes ugyanugy kimegy a telefonokra, mint
# egy beolvadt commit, es a fenti fej-osszevetes ezt NEM latja: a fej attol meg
# egyezik. (Hogy a csomagolas pontosan a munkafat veszi, FELTEVES: `--input-dir`
# nelkul nem tudtam kozvetlenul merni. A szigor iranya viszont eldontheto: egy
# folosleges megallas HANGOS es egy sorral feloldhato, egy kimeno felkesz kod
# NEMA.)
PISZOK="$(git status --porcelain | head -20)"
if [ -n "$PISZOK" ]; then
  echo
  echo "MEGALLOK: a munkafa NEM tiszta. Ami itt all, az megy ki a telefonokra:"
  echo "$PISZOK" | /usr/bin/sed 's/^/     /'
  echo "   Commitold vagy tedd felre, mielott kiadsz."
  exit 5
fi

cd "$KLON/apps/mobile" || exit 1

# A VART runtimeVersion, a kiadas ELOTT. Ez a lepes teszi a kiadast
# ellenorizhetove: utana a kiirt ertek OSSZEVETHETO azzal, amit a CLI mond.
# ES ITT AZ ELOTAG MARAD, HOLOTT A KIADASBOL KIVETTUK. Ez NEM kovetkezetlenseg:
# a ket hivas ket kulonbozo rendszerbol veszi a valtozot.
#
#   eas update                az `--environment production` betolti a SZERVER
#                             oldali EAS valtozokat, koztuk az APP_VARIANT-ot
#   @expo/fingerprint CLI     NEM hitelesit es nem lat EAS-kornyezetet, tehat
#                             csak a HELYI process.env-bol dolgozik
#
# Merve: elotag nelkul a helyi szamolas 3f496632-t ad (a "development" valtozat),
# elotaggal ba70c226-ot -- es a masodik az, amit a kiadas kiir. Ha valaki
# "egysegesitesbol" innen is kiveszi, a szaraz ag egy HAMIS CELT fog mutatni,
# es a kiadas utani osszevetes ertelmetlenne valik.
ujjlenyomat() {
  local platform="$1"
  APP_VARIANT="$VALTOZAT" npx --no-install @expo/fingerprint \
    fingerprint:generate . --platform "$platform" 2>/dev/null \
    | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])' 2>/dev/null
}

echo
echo "--- vart runtimeVersion (APP_VARIANT=$VALTOZAT) ---"
IOS="$(ujjlenyomat ios)"
AND="$(ujjlenyomat android)"
echo "  ios       ${IOS:-(nem szamolhato)}"
# AZ ANDROID SOR SZOVEGE MERESBOL JON, NEM BEEGETVE -- ES EZT EGY MERT ESET
# TANITOTTA MEG (acrobot, 2026-09-17 18:33). Az elso valtozatom azt ALLITOTTA,
# hogy a kiirt android ertek "NEM a cel". Nalam igaz volt; NALA NEM, mert az o
# klonjaban ott all a google-services.json (1610 bajt, 600 mod). Ugyanaz a
# szoveg ket gepen, az egyiken hazugsag. A dontő adat tehat MERT adat, nem
# feltetelezes.
#
# ES A KRITERIUM NEM A LETEZES, HANEM AZ OLVASHATOSAG (nautilus merese,
# 2026-09-18). A ket eset, amit a `-f` nem valaszt szet:
#
#   a fajl nincs ott           -f hamis, -r hamis   egyeznek
#   ott van, de 600/marveen    -f IGAZ,  -r HAMIS   a `-f` OSSZEVETHETO-t
#                                                   allitana, pedig az ujjlenyomatot
#                                                   szamolo folyamat el sem olvassa
#
# A flotta agensei sajat OS-felhasznalo alatt futnak, a klonokban levo titkok
# marveen tulajdonuak: a masodik eset nem elmeleti.
#
# ES A VALTOZO-AG UGYANEZ: a `-n "$GOOGLE_SERVICES_JSON"` csak azt nezte, hogy
# BE VAN-E ALLITVA, a celt nem -- egy elgepelt utvonal is "megvan"-t adott. Ezert
# hasznaljuk a valtozot UTKENT, es azon futtatunk `-r`-t.
TITOK="${GOOGLE_SERVICES_JSON:-google-services.json}"
if [ -r "$TITOK" ]; then
  ANDROID_MEGJEGYZES="OSSZEVETHETO (a google-services.json megvan)"
else
  ANDROID_MEGJEGYZES="NEM a cel -- lasd lent"
fi
echo "  android   ${AND:-(nem szamolhato)}   <- $ANDROID_MEGJEGYZES"
echo
if [ -r "$TITOK" ]; then
  echo "  A google-services.json OLVASHATO ($TITOK), tehat az android ujjlenyomat"
  echo "  kap bemenetet ott, ahol nalad kulonben hianyozna."
  echo
  echo "  DE EZ CSAK AZ OLVASHATOSAGOT MERI, A TARTALMAT NEM -- es a tartalom is"
  echo "  beleszamol."
  echo "  Merve (2026-09-17): ugyanazon a fan a fajl NELKUL 2c93a755, a valodi"
  echo "  kiadassal a5666bdb. A ket szelso ertek pinnelheto, mert a bemenetuk adott."
  echo "  A KOZEPSO NEM: barmilyen nem-valodi tartalom HARMADIK, mind a kettotol"
  echo "  kulonbozo hasht ad -- de hogy MELYIKET, az attol fugg, mi all a fajlban."
  echo "  (A repos parja ugyanide 1ecf6378-at ir, mert MAS dummyval merte. Egyik sem"
  echo "  elavult: egy szam bazis nelkul nem referencia.)"
  echo "  Harom allapot, harom hash. Ha tehat a fenti android ertek nem egyezik a"
  echo "  telepitett buildevel, az"
  echo "  elso kerdes ne az legyen, hogy a kiadas rossz, hanem hogy UGYANAZ-e a fajl,"
  echo "  mint ami a build gepre megy."
else
  if [ -e "$TITOK" ]; then
    echo "  A google-services.json OTT VAN, DE EZ A FOLYAMAT NEM OLVASSA ($TITOK)."
    echo "  Nem hianyzik: a jogosultsaga zarja ki. Az ujjlenyomat ettol ugyanugy"
    echo "  bemenet nelkul szamol, mintha ott sem lenne."
  else
    echo "  A google-services.json NINCS ITT (gitignore alatt all, a build gepen EAS"
    echo "  titokkent erkezik)."
  fi
  echo "  A TARTALMA benne van az android ujjlenyomatban."
  echo "  A fenti android ertek tehat egy HARMADIK allapotrol szol -- ne hasonlitsd"
  echo "  a telepitett buildehez. Az iOS ertek az, amit ossze lehet vetni."
fi

if [ "$MIT" = "szaraz" ]; then
  echo
  echo "--- a parancs, ami KIADASKOR futna (production agnal Balazs futtatja, D5) ---"
  echo "  npx --yes eas-cli@24.8.0 update \\"
  echo "    --branch $AG_NEV --environment $VALTOZAT \\"
  echo "    --message \"<uzenet>\" --non-interactive"
  echo
  echo "SZARAZ FUTAS: semmi nem ment ki. Kiadashoz: mobil-ota.sh kiadas \"az uzenet\""
  exit 0
fi

if [ -z "$UZENET" ]; then
  echo
  echo "MEGALLOK: a kiadashoz uzenet kell (a masodik argumentum)." >&2
  echo "   Az uzenet az, amibol ket het mulva kiderul, MIT kuldtunk ki." >&2
  exit 2
fi

if [ ! -r "$TOKEN_FILE" ]; then
  echo
  echo "MEGALLOK: a token nem olvashato: $TOKEN_FILE" >&2
  echo "   Ez RENDSZER-retegu korlat (fajl-mod es csoport-tagsag), nem harness:" >&2
  echo "   a fajl marveen:sec-expo 640 modban all. Aki marveen alatt fut, latja." >&2
  exit 4
fi

export EXPO_TOKEN
EXPO_TOKEN="$(cat "$TOKEN_FILE")"

echo
echo "=== KIADAS a(z) $AG_NEV agra ==="
# AZ `APP_VARIANT=` ELOTAG SZANDEKOSAN NINCS ITT. A szerver oldalon all
# (merve acrobot altal, 2026-09-17 18:31: az `eas env:list --environment
# production` kiirja), es az `--environment production` betolti. Egy helyi
# elotag CSENDBEN FELULIRNA azt, amit a projekt beallitasa mond -- es epp
# akkor lenne a legveszelyesebb, amikor a ketto ELTER, mert addig ugyanazt
# mondjak, tehat a kulonbseg nem latszik.
#
# HA EZ VALAHA VISSZAKERUL, elotte merd le: all-e meg a szerver oldalon.
npx --yes eas-cli@24.8.0 update \
  --branch "$AG_NEV" \
  --environment "$VALTOZAT" \
  --message "$UZENET" \
  --non-interactive
allapot=$?

echo
echo "--- utana: VESD OSSZE ---"
echo "  a fent kiirt ios ertek:  ${IOS:-(nem szamolhato)}"
echo "  a CLI altal kiirt ios runtimeVersion: lasd a fenti kimenetet"
echo "  Ha a ketto NEM egyezik, a frissites MAS celkozonsegnek ment ki."
exit "$allapot"
