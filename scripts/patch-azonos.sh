#!/usr/bin/env bash
# ANSWERS: Ugyanaz-e ket patch-fajl tartalma, ha az `index` sorokat (kerestre a `@@` sorokat is) nem szamitjuk?
#
# patch-azonos.sh [--hunk-fejek-nelkul] <a> <b>
#   a, b: egy patch-fajl TELJES utja. Az egyik tartalmazhat egy csillagot (a ~/.review-fej/ fajlneveiben a rovid
#         sha utan csillag all): pontosan EGY fajlra kell illeszkednie.
#   --hunk-fejek-nelkul: a `@@` sorokat is kihagyja az osszehasonlitasbol (a sorszamok eltolodasa nem szamit).
#   -> `TARTALOM_AZONOS`, kilepes 0; vagy `ELTER` es az elso elteres helye, kilepes 1.
#
# WHY (bash_command jovahagyasok, 2026-10-19, barracuda ket sora: 14:51 es 15:07): a barracuda ugyanazt az
# osszehasonlitast `cmp <(grep -v '^index ' A) <(grep -v '^index ' B) && echo ...` alakban futtatta, es ez
# kovetelt Discord-jovahagyast, mert a `<(...)` behelyettesites es a `cmp` nincs a profil olvaso listajan.
# Ez ugyanaz az olvasas, egy nevesitett parancsban (mint a review-olvas.sh).
#
# WHAT IT DOES NOT DO: nem ir, nem torol, nem hiv halozatot. Csak olvas, kizarolag harom zonabol: a review-csomagok
# mappabol, a hivo SAJAT ~/.review-fej mappajabol es a hivo SAJAT /tmp/claude-<uid> scratchpadjebol. Szimlinket nem
# olvas, a tiltott utvonal-szegmenseket (store, .channels-config, .env, .ssh, .aws, .gnupg) nem engedi, 5 MB felett
# nem olvas.
set -uo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }

hunk=0
if [ "${1:-}" = "--hunk-fejek-nelkul" ]; then hunk=1; shift; fi
[ "$#" -eq 2 ] || fail "hasznalat: patch-azonos.sh [--hunk-fejek-nelkul] <a.patch> <b.patch>"

ME_UID="$(id -u)"
ZONES=("/home/marveen/marveen/review-csomagok/" "${HOME}/.review-fej/" "/tmp/claude-${ME_UID}/")

resolve() {
  local pat="$1"
  case "$pat" in /*) ;; *) fail "abszolut ut kell: $pat" ;; esac
  case "$pat" in *..*) fail "az ut nem tartalmazhat ..-t: $pat" ;; esac
  case "$pat" in *[[:space:]]*) fail "az ut nem tartalmazhat szokozt: $pat" ;; esac
  case "$pat" in *[\?\[\{]*) fail "csak egy csillag megengedett (nincs ? [ {): $pat" ;; esac
  local stars="${pat//[^*]/}"
  [ "${#stars}" -le 1 ] || fail "legfeljebb egy csillag: $pat"
  shopt -s nullglob
  # shellcheck disable=SC2206 -- the glob is the point; spaces, ? [ { and .. are refused above
  local -a m=( $pat )
  shopt -u nullglob
  [ "${#m[@]}" -eq 1 ] || fail "pontosan egy fajlra kell illeszkednie (${#m[@]} talalat): $pat"
  local f="${m[0]}"
  [ -f "$f" ] && [ ! -L "$f" ] || fail "nem sima fajl (vagy szimlink): $f"
  local real
  real="$(realpath -e -- "$f")" || fail "nem oldhato fel: $f"
  [ "$real" = "$f" ] || fail "az ut szimlinken at vezet: $f"
  local ok=0 z
  for z in "${ZONES[@]}"; do
    case "$real" in "$z"*) ok=1 ;; esac
  done
  [ "$ok" = 1 ] || fail "a fajl nem a megengedett zonakban all (review-csomagok, ~/.review-fej, a sajat scratchpad): $real"
  case "/${real}/" in
    */store/*|*/.channels-config/*|*/.env/*|*/.ssh/*|*/.aws/*|*/.gnupg/*) fail "tiltott utvonal-szegmens: $real" ;;
  esac
  local size
  size="$(stat -c %s -- "$real")" || fail "nem merheto: $real"
  [ "$size" -le 5242880 ] || fail "5 MB felett nem olvasom: $real"
  printf '%s' "$real"
}

A="$(resolve "$1")" || exit 1
B="$(resolve "$2")" || exit 1

filter() {
  if [ "$hunk" = 1 ]; then grep -v -e '^index ' -e '^@@' -- "$1"; else grep -v -e '^index ' -- "$1"; fi
}

if cmp -s <(filter "$A") <(filter "$B"); then
  echo "TARTALOM_AZONOS"
  exit 0
fi
echo "ELTER"
cmp <(filter "$A") <(filter "$B") 2>&1 | head -n 1 || true
exit 1
