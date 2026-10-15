#!/usr/bin/env bash
# hasonlo-kulcs-orzo.sh -- a HASONLO-kapcsolatok metaadat-kulcsa KET repoban all,
# es ha a ket oldal elcsuszik, SEMMI NEM HIBAZIK: a doboz nem jelenik meg, a hiba
# NEMA. Ez a szkript hangossa teszi.
#
# MERT LELET (barracuda, 2026-09-08): mindket oldal ugyanazt mondja,
# `unas_similar_ids`, es az elvalaszto mindketton `,`. Az orzo tehat ZOLDROL indul
# -- ez fontos, mert egy orzo, ami mar szuletesekor piros, nem orzo, hanem hibalista.
#
# === MIT NEZ, ES MIERT HARMAT, NEM EGYET ===
#
#   a HASONLO KULCS     iro:    export const MEDUSA_SIMILAR_IDS_KEY = "..."
#                       olvaso: export const HASONLO_KULCS = "..."
#   a KIEGESZITO KULCS  iro:    export const MEDUSA_ACCESSORY_IDS_KEY = "..."
#                       olvaso: export const KIEGESZITO_KULCS = "..."
#   az ELVALASZTO       iro:    const ELVALASZTO = ","
#                       olvaso: nyers.split(",")
#
# A KIEGESZITO PAR 2026-09-08 ESTE KERULT BE (nautilus jelezte, 16220). Addig az iro
# oldal kiirta a kulcsot, de SENKI NEM OLVASTA, tehat egy elcsuszas nem latszott volna
# semmin. A #239-cel olvasoja lett (az "Ami meg kellhet hozza" doboz), es ezzel ugyanaz
# a nema kockazat all ra, mint a hasonlora.
#
# ES NEM ELMELETI: a UNAS-forrasban 1007 termek visel kiegeszito kapcsolatot, osszesen
# 13854-et (barracuda merese, 2026-09-08, a friss exporton). Van mit elveszteni.
#
# AZ ELVALASZTOT NEM KELL KETSZER NEZNI: nautilus merese szerint mindket kulcs ugyanabbol
# az egy konstansbol veszi, tehat a meglevo ellenorzes mind a kettore szol.
#
# A kulcs elcsuszasa a nyilvanvalo eset. Az ELVALASZTO ugyanolyan nema, es meg
# alattomosabb: a doboz MEGJELENIK, csak rossz tartalommal (egy `;`-re valtott iro
# oldal utan az olvaso EGYETLEN, osszeragadt azonositot lat, es nulla termeket talal).
#
# === MIERT A GITHUB API, ES NEM A KLONOK (acrobot dontese, 2026-09-08 10:31) ===
#
# Az elso valtozat agens-klonokbol olvasott, `git show origin/main:<fajl>` alakban.
# Ket eles futas ket kulon bajt hozott elo, es mind a ketto ugyanabbol fakadt: egy
# klon nem a rendszer allapota, hanem egy PILLANAT.
#
#   1. ELAVULT REF. A `git show origin/main:` MAGABIZTOSAN nez ki, es a neve azt
#      igeri, hogy a fo agrol beszel -- kozben azt olvassa, amit a klon LEGUTOBB
#      latott. acrobot futasa 2-est adott ("a fajl nem olvashato") egy fajlra, ami
#      OTT VOLT a fo agon.
#      Es a kort NEM lehet kuszobbel elkapni: a ref akkor HUSZONKET PERCES volt
#      (reflog 09:59:18, futas 10:21), es mar elavult, mert kozben olvasztottak be.
#   2. TULAJDONOS-KAPU. `fatal: detected dubious ownership` -- a klon tulajdonosa
#      `agent-murena`, a futtato `marveen`. A git nem a JOGOT nezi (a `fleet`
#      csoportnak van irasjoga), hanem a TULAJDONOST, es ezt jogositvany nem oldja
#      fel, csak egy kifejezett `safe.directory` kivetel.
#
# AZ API-VAL AZ EGESZ OSZTALY MEGSZUNIK: nincs ref, amit frissiteni kell; nincs
# fetch, ami elhasalhat; nincs tulajdonos-kapu; es nincs mihez kepest elavulni.
# A kerdes, amit az orzo feltesz ("mi all MA a ket fo agon"), pontosan az, amire az
# API valaszol.
#
# === HAROM KIMENET, NEM KETTO ===
#
#   0  a ket oldal egyezik
#   1  ELCSUSZTAK -- kiirja, melyik oldal mit mond
#   2  NEM MERHETO -- a hivas nem sikerult, a fajl nincs a fo agon, vagy a konstans
#      nem talalhato benne
#
# A 2 azert KULON kod, mert a nulla talalat NEM ugyanaz, mint az egyezes. Ha az
# egyik oldalon atnevezik a konstanst, a "ket ures ertek egyenlo" osszehasonlitas
# ZOLDET adna, es az orzo pont akkor hallgatna, amikor a legnagyobb a baj.
# (Kalibralva: az atnevezett valtozat 0 talalatot ad, es a mintak SORELEJERE
# horgonyoznak, mert mindket fajl KOMMENTJEBEN is szerepel a masik konstans neve.)
#
# UGYANEZ ALL A SIKERTELEN HIVASRA: ha az API nem valaszol, nem 0 jon, hanem 2.
# Egy orzo, ami halozati hiba utan zoldet mond, rosszabb a semminel.
#
# === HASZNALAT ===
#
#   hasonlo-kulcs-orzo.sh [--token-file <ut>] [--owner <tulaj>]
#
#   A tokent a szkript FUTASIDOBEN olvassa fel, es sehol nem irja ki -- ugyanaz a
#   minta, mint a fleet-api.sh-nal. Aki a szkriptet irta, nem latta a tokent.
#
#   GITHUB_TOKEN_FILE kornyezeti valtozo ugyanazt allitja, mint a --token-file.

set -u

OWNER="KratoBal"
IRO_REPO_NEV="acropora-os"
OLV_REPO_NEV="acropora-commerce"

IRO_PATH="apps/api/src/integrations/medusa/medusa-relations.policy.ts"
OLV_PATH="apps/storefront/src/modules/products/components/related-products/gondozott-kapcsolatok.ts"

# an explicit token file (--token-file or GITHUB_TOKEN_FILE: the tests) wins; otherwise one token per
# repository from github_token (the owner token file with the switch off, the broker with it on)
TOKEN_FILE="${GITHUB_TOKEN_FILE:-}"
. "$(dirname "${BASH_SOURCE[0]}")/lib/github-token.sh"   # github_token <owner/repo> <role> (FLEET_GITHUB_APP)

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --owner)      OWNER="${2:-}";      shift 2 ;;
    *) echo "ismeretlen kapcsolo: $1" >&2; exit 2 ;;
  esac
done

tok() { if [ -n "${TOKEN_FILE}" ]; then cat "${TOKEN_FILE}"; else github_token "${OWNER}/$1" olvas; fi; }
if [ -n "${TOKEN_FILE}" ] && [ ! -r "${TOKEN_FILE}" ]; then
  echo "NEM MERHETO -- a token-fajl nem olvashato: ${TOKEN_FILE}" >&2
  echo "               (a tartalmat a szkript nem irja ki, es nem is naplozza)" >&2
  exit 2
fi

HIBA=0
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

# EGY FAJL A FO AGROL. A `raw` media-tipus miatt a valasz MAGA a fajl: nincs base64,
# nincs JSON-bontas, tehat egy egesz kinyeresi hibaosztaly kimarad.
#
# A HAROM BUKAS KULON VAN, MERT KULON A TEENDOJUK. Az elso valtozat ezeket egyetlen
# mondatba mosta ("a fajl ures vagy nem olvashato"), es acrobot pont ezen a mondaton
# indult volna rossz iranyba.
API_BAJ=""
letolt() {
  repo="$1"
  utvonal="$2"
  ki="$3"
  API_BAJ=""
  # the token first, on its own: inside the process substitution a failure would send an empty header
  if ! _tok="$(tok "${repo}")"; then API_BAJ="NEM MERHETO -- nincs token a(z) ${OWNER}/${repo} repohoz"; return 1; fi
  kod="$(curl -s -o "${ki}" -w '%{http_code}' \
    -H @<(printf 'Authorization: Bearer %s\n' "${_tok}") \
    -H "Accept: application/vnd.github.raw" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${OWNER}/${repo}/contents/${utvonal}?ref=main" 2>/dev/null)"
  case "${kod}" in
    200) return 0 ;;
    404) API_BAJ="404 -- a fajl NINCS a fo agon (vagy rossz a repo/utvonal). Ez LELET, nem uzemzavar." ;;
    401) API_BAJ="401 -- a token nem ervenyes. Ez NEM mondd semmit a fajlrol." ;;
    403) API_BAJ="403 -- a token nem jogosult erre a repora, vagy kimeritettuk a keretet." ;;
    000) API_BAJ="000 -- a hivas el sem jutott a GitHubig (halozat vagy DNS)." ;;
    *)   API_BAJ="${kod} -- varatlan valasz." ;;
  esac
  return 1
}

# MELYIK COMMITROL SZOL A VALASZ. Ez valtja ki a regi valtozat ref-kor sorat: nem
# azt mondja meg, milyen REGI az adat, hanem hogy PONTOSAN MIROL szol.
#
# A `sha` media-tipussal a valasz MAGA a negyven karakteres azonosito: nincs
# JSON-bontas, tehat nincs mit eltalalni. Elobb egy JSON-valaszbol akartam kivagni
# az ELSO "sha" mezot, es azt elvetettem: az "elso mezo" megint POZICIO, es a regi
# valtozat mert hibaja epp ez volt (a reflogbol `cut -d' ' -f5` alakkal vettem az
# idobelyeget, ami EGYSZAVAS szerzonevnel szamot ad, KETSZAVASNAL emailt -- a ket
# repot pont ilyen kulonbozo nevek irjak).
#
# AMI EBBEN MEG MERETLEN, ES KIMONDOM: nem probaltam ki, hogy ez a media-tipus
# el-e. Ha nem, a valasz nem negyven hexa karakter lesz, az ellenorzes elbukik, es
# "ismeretlen" kerul a helyere. TEHAT A ROSSZ FELTEVES ARA EGY HIANYZO SOR, NEM EGY
# KITALALT AZONOSITO -- es az orzo iteletet nem erinti, mert a sha PROVENIENCIA,
# nem az osszehasonlitas resze.
fo_ag_sha() {
  repo="$1"
  if ! _tok="$(tok "${repo}")"; then echo "ismeretlen"; return 0; fi
  valasz="$(curl -s \
    -H @<(printf 'Authorization: Bearer %s\n' "${_tok}") \
    -H "Accept: application/vnd.github.sha" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${OWNER}/${repo}/commits/main" 2>/dev/null)"
  case "${valasz}" in
    *[!0-9a-f]* | "") echo "ismeretlen" ;;
    *) if [ "${#valasz}" = "40" ]; then echo "${valasz}"; else echo "ismeretlen"; fi ;;
  esac
}

# EGY ertek kinyerese, es a talalatszam ELLENORZESE. A nulla es a tobbszoros
# talalat egyarant "nem merheto", nem "ures ertek".
kinyer() {
  fajl="$1"
  minta="$2"
  oldal="$3"
  mi="$4"

  db="$(grep -c -E "${minta}" "${fajl}")"
  if [ "${db}" != "1" ]; then
    echo "NEM MERHETO -- ${oldal}: a(z) ${mi} ${db} helyen illeszkedik (pontosan 1 kellene)." >&2
    echo "               minta: ${minta}" >&2
    echo "               Ha 0: atneveztek a konstanst, vagy elmozdult a fajl." >&2
    echo "               Ha tobb: a minta tul tag, javitani KELL, mert az orzo talalgatna." >&2
    return 2
  fi
  grep -o -E "${minta}" "${fajl}" | sed -E 's/.*"([^"]*)".*/\1/'
  return 0
}

echo "=== A HASONLO-KAPCSOLATOK METAADAT-KULCSA, KET REPOBAN ==="
echo
echo "Forras: a GitHub API, kozvetlenul a fo agrol (ref=main). Nincs klon, nincs ref,"
echo "        tehat nincs mihez kepest elavulni."
echo

IRO_SHA="$(fo_ag_sha "${IRO_REPO_NEV}")"
OLV_SHA="$(fo_ag_sha "${OLV_REPO_NEV}")"
echo "iro oldal    ${OWNER}/${IRO_REPO_NEV}       main = ${IRO_SHA}"
echo "olvaso oldal ${OWNER}/${OLV_REPO_NEV} main = ${OLV_SHA}"
echo

if ! letolt "${IRO_REPO_NEV}" "${IRO_PATH}" "${TMP}/iro.ts"; then
  echo "NEM MERHETO -- iro oldal: ${API_BAJ}" >&2
  echo "               utvonal: ${IRO_PATH}" >&2
  exit 2
fi
if ! letolt "${OLV_REPO_NEV}" "${OLV_PATH}" "${TMP}/olvaso.ts"; then
  echo "NEM MERHETO -- olvaso oldal: ${API_BAJ}" >&2
  echo "               utvonal: ${OLV_PATH}" >&2
  exit 2
fi

echo "iro fajl    ${IRO_PATH}    $(wc -c < "${TMP}/iro.ts") bajt"
echo "olvaso fajl ${OLV_PATH}    $(wc -c < "${TMP}/olvaso.ts") bajt"
echo

IRO_KULCS="$(kinyer "${TMP}/iro.ts" '^export const MEDUSA_SIMILAR_IDS_KEY[[:space:]]*=[[:space:]]*"[^"]*"' "iro" "hasonlo kulcs")" || exit 2
OLV_KULCS="$(kinyer "${TMP}/olvaso.ts" '^export const HASONLO_KULCS[[:space:]]*=[[:space:]]*"[^"]*"' "olvaso" "hasonlo kulcs")" || exit 2
IRO_KIEG="$(kinyer "${TMP}/iro.ts" '^export const MEDUSA_ACCESSORY_IDS_KEY[[:space:]]*=[[:space:]]*"[^"]*"' "iro" "kiegeszito kulcs")" || exit 2
OLV_KIEG="$(kinyer "${TMP}/olvaso.ts" '^export const KIEGESZITO_KULCS[[:space:]]*=[[:space:]]*"[^"]*"' "olvaso" "kiegeszito kulcs")" || exit 2
IRO_ELV="$(kinyer "${TMP}/iro.ts" '^const ELVALASZTO[[:space:]]*=[[:space:]]*"[^"]*"' "iro" "elvalaszto")" || exit 2
OLV_ELV="$(kinyer "${TMP}/olvaso.ts" 'nyers\.split\("[^"]*"\)' "olvaso" "elvalaszto")" || exit 2

echo "hasonlo kulcs      iro: '${IRO_KULCS}'     olvaso: '${OLV_KULCS}'"
echo "kiegeszito kulcs   iro: '${IRO_KIEG}'     olvaso: '${OLV_KIEG}'"
echo "elvalaszto         iro: '${IRO_ELV}'     olvaso: '${OLV_ELV}'"
echo

if [ "${IRO_KULCS}" != "${OLV_KULCS}" ]; then
  echo "ELCSUSZTAK -- A HASONLO METAADAT-KULCS." >&2
  echo "    iro oldal ir:      '${IRO_KULCS}'   (${IRO_PATH})" >&2
  echo "    olvaso oldal var:  '${OLV_KULCS}'   (${OLV_PATH})" >&2
  echo "    KOVETKEZMENY: a hasonlo termekek doboza ELTUNIK a lapokrol, hibauzenet nelkul." >&2
  HIBA=1
fi

if [ "${IRO_KIEG}" != "${OLV_KIEG}" ]; then
  echo "ELCSUSZTAK -- A KIEGESZITO METAADAT-KULCS." >&2
  echo "    iro oldal ir:      '${IRO_KIEG}'   (${IRO_PATH})" >&2
  echo "    olvaso oldal var:  '${OLV_KIEG}'   (${OLV_PATH})" >&2
  echo "    KOVETKEZMENY: az 'Ami meg kellhet hozza' doboz ELTUNIK, hibauzenet nelkul." >&2
  HIBA=1
fi

if [ "${IRO_ELV}" != "${OLV_ELV}" ]; then
  echo "ELCSUSZTAK -- AZ ELVALASZTO." >&2
  echo "    iro oldal ezzel fuz:     '${IRO_ELV}'" >&2
  echo "    olvaso oldal ezzel bont: '${OLV_ELV}'" >&2
  echo "    KOVETKEZMENY: a doboz MEGJELENIK, de nulla termeket talal -- az olvaso" >&2
  echo "    egyetlen, osszeragadt azonositot lat. Ez meg nemabb, mint a kulcs-elcsuszas." >&2
  HIBA=1
fi

if [ "${HIBA}" = "0" ]; then
  echo "EGYEZIK. A ket oldal MIND A KET kulcsot es ugyanazt az elvalasztot hasznalja."
  echo "         (${IRO_REPO_NEV} ${IRO_SHA}, ${OLV_REPO_NEV} ${OLV_SHA})"
fi

exit "${HIBA}"
