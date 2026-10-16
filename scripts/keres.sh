#!/usr/bin/env bash
# ANSWERS: Hol all egy szoveg, EKEZETTOL es kis-nagybetutol fuggetlenul. A minta SZO SZERINT megy, nem regularis kifejezeskent: alternacio (\|) eseten a nulla A KERDES tulajdonsaga.
#
# MIERT LETEZIK (merve 2026-09-02, EGY NAPON KET AGENSNEL):
#
#   nautilus  a semaban a "lezar" szora nulla talalatot kapott -- a fajlban "lezárt" all
#   acrobot   a "masik partnerhez" mondatra nulla talalatot kapott -- a fajlban "másik" all
#
# Mindketten arra a kovetkeztetesre jutottak, hogy a keresett dolog NINCS OTT. Mindkétszer
# ott volt. A masodik esetben az mentette meg a jelentest, hogy a szam melle ki lett iratva
# minden gyanus sor is -- vagyis egy szokas, nem egy eszkoz.
#
# Nautilus mondata, amiert ez a szkript megszuletett: "ha egy harmadik is belefut, az mar
# nem veletlen: akkor a keresesnek MAGANAK kell ekezet-fuggetlennek lennie, nem a keresonek
# emlekeznie ra."
#
# HASZNALAT:
#   bash /home/marveen/marveen/scripts/keres.sh "minta" <fajl-vagy-konyvtar> [tovabbi utak...]
#
# AMIT AD: soronkenti talalatok (utvonal, sorszam, sor), es a vegen a darabszam.
# AMIT NEM AD: nem allitja, hogy valami nincs ott. Nulla talalatnal kiirja, MIT keresett
# osszehajtott alakban, hogy a kovetkezo olvaso lassa, a kerdes tudott volna-e mast hozni.
#
# === A MINTA SZO SZERINT MEGY (nautilus merese, 2026-09-17, KET futasban) ===
#
#   keres.sh "resolvePdfFontPath"                       7 talalat
#   keres.sh "registerFont\|resolvePdfFont\|betuUtja"   0 talalat, UGYANAZON A FAN
#
# Az elso nullat ELFOGADTA, es majdnem azt jelentette, hogy nincs allitas a betu-feloldora.
# Volt: het talalat es ket kalibralt allitas. A `cel in hajt(sor)` reszszoveg-vizsgalat,
# tehat a `\|` nem alternacio, hanem ket keresendo karakter.
#
# EZ A SZKRIPT FEJLECE KORABBAN AZT ALLITOTTA, hogy "a nulla talalat itt nem a kerdes
# tulajdonsaga". Alternacios mintanal PONTOSAN AZ VOLT, es a fejlec megnyugtatott.
# Ezert all most az ellenkezoje a leirasban, es ezert nevezi meg a nulla-kiiras a
# mintaban talalt operator-jelolt karaktert. Egy hamis megnyugtatas dragabb, mint a
# hianyzo figyelmeztetes: az elso ELFOGADTATJA a nullat.
# === KERESO, NEM KAPU (nautilus merese 2026-09-18, visszamerve ugyanaznap) ===
#
# Ez a szkript NULLA TALALATNAL IS 0-val lep ki. Egy keresonel ez helyes (a "nem talaltam"
# nem hiba), de azt jelenti, hogy KAPUNAK NEM HASZNALHATO:
#
#   keres.sh "minta" <ut> && <kovetkezo lepes>   -> a kovetkezo lepes NULLA TALALATNAL IS LEFUT
#
# Merve: mindket ag (nulla es nem-nulla) 0-val ter vissza, es a `&&` lanc atengedi.
# Ha valaha feltetelbe kerul, a darabszamot kell olvasni, nem a kilepesi kodot.
#
# ES EGY CSAPDA A MERESHEZ MAGAHOZ: a szkript KET argumentumot var (minta ES ut). Egy
# argumentummal hasznalati uzenetet ir es 2-vel lep ki -- ez konnyen ugy nez ki, mintha a
# kereses hibazott volna. Az elso meresem pont ezen bukott el: a nulla es a nem-nulla ag
# egyarant 2-t adott, mert egyik sem futott le.
#
# === A TITKOT NEM OLVASSA, AKKOR SEM, HA ODA MUTATSZ (B28, 2026-10-16) ===
#
# 2026-10-14 14:38:54 UTC-kor egy keres.sh a flotta gyokereben 56 titok-fajlt olvasott
# vegig (murena lelete, barracuda 31950): ha egy titok tartalmazza a mintat, a talalati
# sor kiirja az erteket. Ezert a keresesbol kimarad, a VALODI utvonal szerint (szimlinken
# at is), es kifejezett argumentumkent is:
#   - minden .env es .env.* fajl, barhol;
#   - egy store/ konyvtar alatt: minden ponttal kezdodo nev, a tokens/ alatti fajlok, es
#     minden, ami (vagy aminek egy store/ alatti szulo-konyvtara) NEM vilag-olvashato.
#     A titok-fajlok 0600/0640 alakuak (a titok-jog-figyelo ezt tartja), tehat egy uj
#     titok nev-lista nelkul is kimarad. Az ara: a store/ alatti NEM titkos, de nem
#     vilag-olvashato fajlokban (pl. claudeclaw.db, jev-shadow.json) sem keres.
# A kimenet a vegen kiirja, hany fajl maradt ki igy: egy nulla mellett ez a lathatar.
#
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "hasznalat: keres.sh \"minta\" <fajl-vagy-konyvtar> [tovabbi utak...]" >&2
  exit 2
fi

MINTA="$1"
shift

MINTA="$MINTA" python3 - "$@" <<'PY'
import os
import sys
import unicodedata

minta = os.environ["MINTA"]


def hajt(s):
    # ekezet le, kisbetu -- a magyar hosszu o es u (o, u kettos ekezettel) is igy esik ossze
    n = unicodedata.normalize("NFD", s)
    return "".join(c for c in n if not unicodedata.combining(c)).lower()


cel = hajt(minta)
if not cel:
    print("URES MINTA -- nincs mit keresni")
    sys.exit(2)

def titok_e(ut):
    """A keresesbol kimarado fajl: .env, vagy egy store/ alatti titok (a fejlec szerint)."""
    valodi = os.path.realpath(ut)
    reszek = valodi.split(os.sep)
    nev = reszek[-1]
    if nev == ".env" or nev.startswith(".env."):
        return True
    szulok = reszek[:-1]
    if "store" not in szulok:
        return False
    i = len(szulok) - 1 - szulok[::-1].index("store")
    alatta = reszek[i + 1:]
    if any(r.startswith(".") for r in alatta) or "tokens" in alatta[:-1]:
        return True
    hely = os.sep.join(reszek[:i + 1]) or os.sep
    for r in alatta:
        hely = os.path.join(hely, r)
        try:
            if not os.stat(hely).st_mode & 0o004:
                return True
        except OSError:
            return True
    return False


utak = []
for arg in sys.argv[1:]:
    if os.path.isdir(arg):
        for gyoker, konyvtarak, fajlok in os.walk(arg):
            konyvtarak[:] = [k for k in konyvtarak
                             if k not in (".git", "node_modules", "dist", ".next")]
            for f in fajlok:
                utak.append(os.path.join(gyoker, f))
    else:
        utak.append(arg)

kizart = [ut for ut in utak if titok_e(ut)]
for arg in sys.argv[1:]:
    if not os.path.isdir(arg) and arg in kizart:
        print("KIZARVA (titok-hely, nem olvasom): %s" % arg)
kizart_halmaz = set(kizart)
utak = [ut for ut in utak if ut not in kizart_halmaz]

talalat = 0
atugrott = 0
for ut in utak:
    try:
        with open(ut, encoding="utf-8") as f:
            sorok = f.read().splitlines()
    except (UnicodeDecodeError, OSError):
        atugrott += 1
        continue
    for i, sor in enumerate(sorok, 1):
        if cel in hajt(sor):
            talalat += 1
            print("%s:%d: %s" % (ut, i, sor.strip()[:160]))

print()
print("TALALAT: %d  (%d fajlban keresve, %d atugorva, %d titok-helyen kizarva)"
      % (talalat, len(utak) - atugrott, atugrott, len(kizart)))
if talalat == 0:
    print("A NULLA MELLE, hogy a kovetkezo olvaso ellenorizhesse a KERDEST:")
    print("  a beirt minta        : %r" % minta)
    print("  osszehajtott alakja  : %r" % cel)
    print("  Ez a keresés ekezet- es kis-nagybetu-fuggetlen volt. Ha a nulla megis")
    print("  meglepo, akkor NEM az irasmod a magyarazat -- keress mas SZORA vagy mas HELYEN.")
    print("  A MINTA SZO SZERINT MEGY, NEM REGULARIS KIFEJEZESKENT: a keresés a")
    print("  megadott szoveget RESZSZOVEGKENT keresi, tehat egy | \\| .* [] () ? +")
    print("  karakter NEM operator, hanem keresendo karakter.")
    for jel in ("\\|", "|", ".*", "[", "(", "?", "+"):
        if jel in minta:
            print("  FIGYELEM: a mintad tartalmazza ezt: %r -- ha operatornak szantad," % jel)
            print("  akkor EZ A NULLA A KERDES TULAJDONSAGA, nem a vilage. Futtasd kulon,")
            print("  tagonkent, vagy hasznalj /bin/grep -E alakot.")
            break
PY
