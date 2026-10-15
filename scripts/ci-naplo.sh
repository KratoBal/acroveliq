#!/usr/bin/env bash
# ANSWERS: MELYIK ALLITAS bukott el egy CI futasban? Nem "piros a teszt lepes", hanem a NEV.
#          Es `--meres <sha>`-val: egy meres-ag ZOLD futasanak TAP sorai, mert ott a zold a lelet.
#
# MIERT LETEZIK (merve 2026-09-03). A fonok haromszor kert naplot tolem vagy murenatol,
# mert azt hitte, a tokenunk nem jogosult ra. Nem a jogkor hianyzott: a
# `/actions/jobs/<id>/logs` vegpont egy ALAIRT letoltesi cimre iranyit at, es `-L` nelkul
# a curl 302-t ad nulla bajttal. Ugyanazzal a fejleccel, `-L`-lel: HTTP 200, 558 513 bajt.
#
# ES AMIERT ESZKOZ LETT BELOLE, NEM EGY MONDAT EGY LAPON: enelkul a bukott lepes NEVE
# ("Unit and workspace tests") az egyetlen, amit latunk -- abbol pedig nem lehet
# megkulonboztetni egy billegot egy valodi hibatol. Ma pontosan ez tortent a #440-nel:
# a piros a fo agon ulo billego volt, nem a valtozas, es ezt CSAK a naplo mondta meg.
#
# HASZNALAT:
#   bash .../ci-naplo.sh <PR-szam>          # a PR fejere futott legutobbi futasok
#   bash .../ci-naplo.sh --sha <commit-sha>
#   bash .../ci-naplo.sh --job <job-azonosito>
#   bash .../ci-naplo.sh --meres <sha>      # MERES-AG: a ZOLD naplot is lehuzza, es
#                                           # MINDEN TAP allitas-sort kiir, sorrendben
#
# A `--meres` AZERT KELL, MERT OTT A POLARITAS FORDITOTT: egy `meres/**` agon a zold
# azt jelenti, hogy a szandekos rontas ELSULT, tehat eppen a ZOLD futas naplojat kell
# elolvasni -- az alapertelmezes pedig a zold jobot at is lepi. Enelkul a kalibraciot
# csak az agens SZAVARA lehet atvenni, holott a napló ott van.
#
# A TELJES naplot fajlba menti (a merete tobb szaz kilobajt), es CSAK a bukott
# allitasokat irja ki. A fajl utja a kimenet vegen all, hogy utolag ellenorizheto legyen.
#
# A HATARA: a GitHubot kerdezi, tehat a valasz a LEKERDEZES pillanatara szol; a fejlecben
# ott az ido. Es CSAK azt latja, amit a futtato a naploba irt -- egy elnyelt hiba itt sem
# jelenik meg.
#
# KALIBRALVA, ES A BEMENETEK TARTOSAK (a GitHub megorzi oket, tehat barki ujramerheti):
#
#   --job 100598964838   ISMERT POZITIV. A #440 bukott futasa; tudjuk, mi bukott el, es az
#                        eszkoz pontosan azt adja vissza, egy sorban, a teljes uttal.
#   446                  ZOLD FUTAS. Minden job "success", nulla bukott allitas kiirva.
#   99999                NEM LETEZO PR. Megnevezi, es 1-gyel lep ki -- nem nema nulla.
#   --job 100611450485   ZOLD verify job, a TELJES keszlettel: 3133 lefutott teszt. Ezt a
#                        BUKOTT futas 1003-asaval egyutt kell olvasni: a kulonbseg nem zaj,
#                        hanem a le sem futott csomagok. Ezert irja ki a kimenet, hogy a
#                        szam a FUTASROL szol, nem a reporol.
#   --job 100501668554   ES EZ A LEGHASZNOSABB: a bukott LEPES neve "Fail the job if the
#                        database integration tests failed", ami semmit nem mond arrol, MI
#                        bukott. Az eszkoz megnevezi az allitast a naplobol. Pontosan ez az
#                        eszkoz letezesenek oka.
#
# AZ EGYKORI "AMIT NEM MERTEM" AG MOSTANTOL MERVE (2026-09-23 00:49, acrobot):
#   --job 106968479111   PIROS LEPES, NULLA BUKOTT ALLITAS. A #1010 verify jobja a
#                        "Static verification" lepesen bukott (het TS2322 tipushiba ot
#                        integracios spec fajlban), tehat a teszt-lepes el sem indult.
#                        Az eszkoz helyesen jart el: kiirta, hogy nulla bukott allitast
#                        talalt, es kimondta, hogy a bukas valoszinuleg a teszt-lepes
#                        ELOTT tortent. A tipushibak NEVET viszont nem irja ki -- azt a
#                        mentett naplobol kell kiolvasni:
#                          grep "error TS" <a kiirt naplo utja>
#                        Ez a hatara, nem hibaja: a lelet ott van a fajlban, amit lement.
set -uo pipefail
ROOT=/home/marveen/marveen
REPO="${PR_REPO:-KratoBal/acropora-os}"
. "$(dirname "${BASH_SOURCE[0]}")/lib/github-token.sh"   # github_token <owner/repo> <role> (FLEET_GITHUB_APP)
[ "$#" -ge 1 ] || { echo "HASZNALAT: ci-naplo.sh <PR-szam> | --sha <sha> | --job <id>" >&2; exit 2; }

GH_TOK="$(github_token "$REPO" olvas)" || exit 1
TOKEN="$GH_TOK" REPO="$REPO" python3 - "$@" <<'PY'
import json, os, re, subprocess, sys, datetime, tempfile, time

tok, repo = os.environ["TOKEN"], os.environ["REPO"]
API = "https://api.github.com/repos/" + repo

def api(path):
    # the header on stdin, not the argv: every agent's `ps` shows argv (P0-1)
    r = subprocess.run(
        ["curl", "-s", "-H", "@-",
         "-H", "Accept: application/vnd.github+json", API + path],
        input="Authorization: Bearer " + tok + "\n", capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return None

def naplo(job_id, cel):
    # A `-L` A LENYEG: a vegpont alairt cimre iranyit at. Nelkule 302 jon, nulla bajttal,
    # es az ugy nez ki, mintha a jogkor hianyozna.
    r = subprocess.run(
        ["curl", "-sL", "-w", "%{http_code}", "-o", cel,
         "-H", "@-",
         "-H", "Accept: application/vnd.github+json",
         API + "/actions/jobs/%s/logs" % job_id],
        input="Authorization: Bearer " + tok + "\n", capture_output=True, text=True)
    return r.stdout.strip()

ANSI = re.compile(r"\x1b\[[0-9;]*m")

# A LEFUTOTT TESZTEK SZAMA JON ELOSZOR, ES EZ A LAPUNK SORRENDJE, NEM DISZ:
# egy piros szam csak akkor jelent valamit, ha tudjuk, hany teszt futott le
# egyaltalan. Nulla lefutott teszt mellett a "nincs piros" a fordito megallasat
# meri, nem a vedelmet.
#
# A MINTAK SZAMOT KOVETELNEK. Az elso valtozatom `# fail`-re illesztett, es
# beleakadt a CI yaml egy KOMMENTJEBE ("# fail - measured on b4229a5"). Egy
# minta, ami tagabb a vilagnal, ugyanugy hamis szamot ad, mint egy hianyzo.
TAP  = re.compile(r"^# (tests|pass|fail) (\d+)$")
VITE = re.compile(r"^\s*Tests\s+(.+?)\s*$")
VITE_DB = re.compile(r"(\d+)\s+(passed|failed|skipped)")
IDO  = re.compile(r"^\S*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+")

# A ket futtatonk ket kulonbozo alakban jelenti a bukast. Mindkettot olvassuk, mert aki
# csak az egyiket nezi, a masik csomagnal vak -- ugyanaz a szabaly, mint a kalibracio.sh-ban.
MINTAK = [
    ("vitest", re.compile(r"^\s*(?:FAIL|×)\s+(.+)$")),
    ("node --test", re.compile(r"^\s*not ok \d+ - (.+)$")),
]

IDOTARTAM = re.compile(r"\s+\d+(?:\.\d+)?\s*m?s$")

def bukott_allitasok(path):
    """A bukott allitasok neve, DUPLIKATUM NELKUL.

    A vitest UGYANAZT az allitast ketszer irja ki: egyszer roviden, idotartammal
    (`× <nev> 67ms`), egyszer a teljes uttal (`FAIL <fajl> > <describe> > <nev>`).
    A masodik informativabb, ezert ha a rovid nev SZEREPEL egy hosszabb sorban,
    csak a hosszabbat tartjuk meg. Merve a #440 naplojan: ket sor helyett egy.
    """
    nyers = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for sor in f:
            tiszta = IDO.sub("", ANSI.sub("", sor)).rstrip()
            for futtato, minta in MINTAK:
                m = minta.match(tiszta)
                if m:
                    szoveg = IDOTARTAM.sub("", m.group(1).strip())
                    if szoveg and (futtato, szoveg) not in nyers:
                        nyers.append((futtato, szoveg))
    ki = []
    for futtato, szoveg in nyers:
        beagyazott = any(
            szoveg != masik and szoveg in masik for _, masik in nyers
        )
        if not beagyazott:
            ki.append((futtato, szoveg))
    return ki

def lefutott_tesztek(path):
    """(lefutott, piros) a naplobol, mindket futtatot osszegezve.

    None-t ad vissza, ha EGYETLEN osszegzo sor sincs -- az mas allapot, mint a
    nulla, es a hivo mast kezd vele.
    """
    futott = pirosak = 0
    talalt = False
    with open(path, encoding="utf-8", errors="replace") as f:
        for sor in f:
            tiszta = IDO.sub("", ANSI.sub("", sor)).rstrip()
            m = TAP.match(tiszta)
            if m:
                talalt = True
                if m.group(1) == "tests": futott += int(m.group(2))
                elif m.group(1) == "fail": pirosak += int(m.group(2))
                continue
            v = VITE.match(tiszta)
            if v and ("passed" in v.group(1) or "failed" in v.group(1)):
                talalt = True
                for szam, allapot in VITE_DB.findall(v.group(1)):
                    if allapot in ("passed", "failed"): futott += int(szam)
                    if allapot == "failed": pirosak += int(szam)
    return (futott, pirosak) if talalt else (None, 0)

argv = sys.argv[1:]

# A MERES-AGAKON A POLARITAS FORDITOTT, ES EZ AZ EGESZ ESZKOZT ERINTI (murena
# merese, 2026-09-22). A rendes CI-ben a PIROS az esemeny, ezert az alapertelmezes
# a zold jobot at is lepi -- naplot sem ment hozza. Egy `meres/**` agon viszont a
# ZOLD azt jelenti, hogy a szandekos rontas ELSULT, tehat EPPEN annak a futasnak a
# naplojat kell elolvasni, es az allitasok NEVERE van szukseg, nem a bukasokra.
#
# MIERT MOD, ES NEM MASODIK SZKRIPT: murena megirta maganak (meres-nyom.sh), es
# helyesen nem nyult az en famhoz. Ugyanazon az ejszakan ket agens KULON-KULON
# megirta ugyanazt a push-orzot is (0d4f69fb), es abbol tanultunk: ket nev
# ugyanarra a kerdesre annyit jelent, hogy a harmadik agens egyiket sem talalja meg.
#
# AMIT AZ O VALTOZATABOL JAVITOTTAM, ES MIERT:
#   - o a futasok es a jobok kozul az ELSOT vette (`r[0]`, `j[0]`). Egy shara tobb
#     futas es tobb job is eshet, es akkor a valasztas CSENDES. Itt mindegyik job
#     sorra kerul, es a szam ki is irodik.
#   - o `sort -u`-val irta ki a TAP sorokat. Az ABC-be rendez es duplikatumot vesz
#     ki, tehat epp a SORRENDET veszti el -- abbol pedig latszik, hogy a pozitiv
#     kontrollok a rontas ELOTT futottak-e le.
MERES = "--meres" in argv
if MERES:
    argv = [a for a in argv if a != "--meres"]
    # A SHA-T FEL KELL ISMERNI, KULONBEN PR-SZAMNAK NEZI. Merve a sajat
    # kalibraciomon (2026-09-22 04:55): `--meres <40 karakteres sha>` eseten az elso
    # valtozat a `/pulls/<sha>` vegpontra ment, es egy MASIK fej shajat irta ki.
    # Nem allt meg, nem is hibazott -- egy hihetoen kinezo, rossz valaszt adott.
    # A hatar 7 karakter: egy PR-szam legfeljebb hat jegyu, tehat nem utkozik.
    if argv and not argv[0].startswith("--") and re.match(r"^[0-9a-f]{7,40}$", argv[0]):
        argv = ["--sha"] + argv
if not argv:
    print("HASZNALAT: ci-naplo.sh [--meres] <PR-szam> | --sha <sha> | --job <id>",
          file=sys.stderr)
    sys.exit(2)

# A KAPU BLOKKJA ES MINDEN TAP ALLITAS-SOR. A `ok`/`not ok` egyutt kell: a
# kalibracio allitasa az, hogy MELYIK bukott el es melyik maradt zold.
KAPU_SOR = re.compile(r"(MERES-KAPU|vart nyom:|megjelent:|rendben:|FAIL:|FIGYELEM:)")
TAP_SOR = re.compile(r"^((?:not )?ok \d+ - .*)$")

def meres_nyomok(path):
    """A kapu-blokk es a TAP allitas-sorok, A NAPLO SORRENDJEBEN."""
    kapu, tap = [], []
    with open(path, encoding="utf-8", errors="replace") as f:
        for sor in f:
            tiszta = IDO.sub("", ANSI.sub("", sor)).rstrip()
            if KAPU_SOR.search(tiszta):
                kapu.append(tiszta)
            m = TAP_SOR.match(tiszta.strip())
            if m:
                tap.append(m.group(1))
    return kapu, tap

job_idk = []
if argv[0] == "--job":
    job_idk = [(argv[1], "(kozvetlenul megadva)", "?")]
    fej = None
else:
    if argv[0] == "--sha":
        fej = argv[1]
        honnan = "a megadott commit"
        # A ROVID SHA NEM HIBAT AD, HANEM NULLAT (nautilus merese, 2026-09-08 06:40,
        # visszamerve: `--sha df91135dba10` -> "NINCS FUTAS", ugyanaz a commit teljes
        # alakban -> hat job, mind zold). A `actions/runs?head_sha=` szuro TELJES negyven
        # karaktert var, es a rovid alakra ures listat ad.
        #
        # EZ ROSSZABB, MINT EGY HIBA, mert a szkript mondata ("nem indult el") KORREKT
        # egy MASIK allapotra. Aki elolvassa, azt fogja keresni, miert nem indult a CI,
        # holott lefutott es zold volt.
        #
        # ES NEM MEGALLASSAL OLDOM MEG, HANEM FELOLDASSAL. Nautilus azt javasolta, hogy
        # alljon meg, azzal az indokkal, hogy a rovid sha feloldasahoz a helyi klon
        # kellene. Ez MERHETOEN nem igy van: a `/commits/<rovid>` vegpont MAGA oldja fel
        # a prefixet (kiprobalva ugyanezen a fejen). Ket kulonbozo vegpont, ket kulonbozo
        # viselkedes ugyanarra a rovid alakra -- es epp ezert nezett ki ugy, mintha a
        # GitHub egyaltalan nem ismerne a rovid alakot.
        #
        # Ha a prefix nem letezik vagy tobbertelmu, a vegpont nem ad `sha` mezot, es
        # akkor MEGALLUNK. Talalgatott kiegeszites nincs.
        if len(fej) != 40:
            _c = api("/commits/" + fej)
            _teljes = _c.get("sha") if isinstance(_c, dict) else None
            if not _teljes or len(_teljes) != 40:
                print("FAIL: a rovid SHA (%s) nem oldhato fel ebben a repoban. "
                      "Add meg a teljes negyven karaktert." % fej, file=sys.stderr)
                sys.exit(1)
            print("    [a rovid SHA feloldva: %s -> %s]" % (fej, _teljes))
            fej = _teljes
    else:
        pr = api("/pulls/" + argv[0])
        if not isinstance(pr, dict) or "number" not in pr:
            print("FAIL: a #%s nem kerdezheto le" % argv[0], file=sys.stderr); sys.exit(1)
        fej = pr["head"]["sha"]
        honnan = "a #%s feje (%s)" % (argv[0], pr.get("state"))
    futasok = api("/actions/runs?head_sha=" + fej)
    for run in (futasok or {}).get("workflow_runs", []):
        jobs = api("/actions/runs/%s/jobs" % run["id"])
        for j in (jobs or {}).get("jobs", []):
            job_idk.append((str(j["id"]), j.get("name"), j.get("conclusion")))

# Zonaval, es NEM `%Z`-vel a naiv datetime-on: az ures sztringre fordul (lasd
# pr-allapot.sh). A time.strftime a C konyvtar zonajat olvassa.
most = time.strftime("%H:%M:%S %Z (%z)")
print("--- ci-naplo (lekerdezve %s, repo %s) ---" % (most, repo))
if fej: print("fej: %s" % fej[:12])
if not job_idk:
    print("NINCS FUTAS erre a fejre. Nem azt jelenti, hogy zold: azt, hogy nem indult el.")
    sys.exit(0)

tmp = tempfile.mkdtemp(prefix="ci-naplo-")
hibas = 0
if MERES:
    print("  [--meres mod: a ZOLD futas naplojat is lehuzom, es MINDEN TAP")
    print("   allitas-sort kiirok. Ezen az agon a zold azt jelenti, hogy a")
    print("   szandekos rontas elsult -- a bizonyitek a SOROK NEVE, nem a verdikt.]")
    print("  %d job all ezen a fejen." % len(job_idk))
for job_id, nev, verdikt in job_idk:
    if MERES:
        cel = os.path.join(tmp, "job-%s.log" % job_id)
        kod = naplo(job_id, cel)
        meret = os.path.getsize(cel) if os.path.exists(cel) else 0
        print("  %-28s %s   (naplo HTTP %s, %d bajt)"
              % (nev, verdikt or "?", kod, meret))
        # A NULLA BAJT KULON JEL: a nem kovetett atiranyitas pontosan ugy nez ki,
        # mint egy ures naplo. Ezert all itt a meret, nem csak a HTTP kod.
        if kod != "200" or meret == 0:
            print("     A NAPLO NEM JOTT MEG (a 302 nulla bajttal NEM jogkor-hiany).")
            hibas += 1
            continue
        kapu, tap = meres_nyomok(cel)
        if kapu:
            print("     === MERES-KAPU BLOKK ===")
            for sor in kapu:
                print("       %s" % sor)
        else:
            print("     A KAPU BLOKKJA NEM SZEREPEL a naploban. Amit kerestem:")
            print("       MERES-KAPU, 'vart nyom:', 'megjelent:', 'rendben:', FAIL:, FIGYELEM:")
        if tap:
            # A TELJES KESZLET NEM OLVASHATO, ES A CSONKITAS SEM INGYENES. Merve: a
            # `verify` job naploja 840 TAP sort ad, mert az egesz keszletet futtatja --
            # ott a kalibracio allitasai elveszne a listaban. A meres-agak sajat jobja
            # ellenben tucatnyi sort ad, es ott MIND kell, mert a zolden maradt pozitiv
            # kontroll ugyanannyira bizonyitek, mint az elsult piros.
            #
            # EZERT A HATAR A SOROK SZAMAN ALL, NEM A POLARITASAN, es a csonkitas KI VAN
            # MONDVA. Egy hallgatolagos `head` itt pont azt vinne el, amit meg kell nezni.
            pirosak = [s for s in tap if s.startswith("not ok")]
            if len(tap) <= 60:
                print("     === TAP ALLITAS-SOROK (a naplo sorrendjeben, %d db) ==="
                      % len(tap))
                for sor in tap:
                    print("       %s" % sor)
            else:
                print("     === TAP: %d allitas-sor, ebbol %d piros ==="
                      % (len(tap), len(pirosak)))
                # A CSONKITAS INDOKA A SOROK SZAMA, ES CSAK AZ. Az elso valtozatom azt
                # irta ide, hogy "ez a job a teljes keszletet futtatja, tehat nem
                # meres-job" -- es a sajat kalibraciom cafolta meg: a `meres` NEVU job
                # 390 sort adott. A mondat tehat egy olyan kovetkeztetest allitott, amit
                # a sorszam nem hordoz. Pontosan az a hiba, amit ez az eszkoz keres.
                print("     Tobb sor, mint amit egy kimenetben olvasni lehet, ezert CSAK")
                print("     a pirosakat irom ki. Ez NEM allitas arrol, mit futtat a job:")
                print("     a zolden maradt pozitiv kontroll ugyanannyira bizonyitek, es")
                print("     az a teljes naploban all (az utja lent).")
                for sor in pirosak:
                    print("       %s" % sor)
                if not pirosak:
                    print("       (nulla piros -- ebben a jobban egyetlen allitas sem bukott)")
        else:
            print("     NULLA TAP ALLITAS-SOR. Amit kerestem: 'ok <n> - <nev>' es")
            print("     'not ok <n> - <nev>'. Ha a job nem tesztet futtat, ez rendes.")
        print("     a teljes naplo: %s" % cel)
        continue
    if verdikt in ("success", "skipped"):
        print("  %-28s %s" % (nev, verdikt))
        continue
    cel = os.path.join(tmp, "job-%s.log" % job_id)
    kod = naplo(job_id, cel)
    print("  %-28s %s   (naplo HTTP %s)" % (nev, verdikt or "?", kod))
    if kod != "200":
        print("     A NAPLO NEM JOTT MEG. A 302 nulla bajttal NEM jogkor-hiany:")
        print("     a vegpont alairt cimre iranyit at, tehat -L kell hozza.")
        hibas += 1
        continue
    # A bukott LEPES neve kulon lekerdezes: a naplo maga nem mondja meg.
    j = api("/actions/jobs/" + job_id)
    for lepes in (j or {}).get("steps") or []:
        if lepes.get("conclusion") not in ("success", "skipped", None):
            print("     bukott lepes: %s" % lepes.get("name"))
    futott, pirosak = lefutott_tesztek(cel)
    if futott is None:
        print("     LEFUTOTT TESZTEK: a naplo egyetlen osszegzo sort sem tartalmaz.")
        print("     Ez NEM azt jelenti, hogy nulla teszt futott: azt, hogy a bukas")
        print("     valoszinuleg a teszt-lepes ELOTT tortent (lint, build, telepites).")
    else:
        print("     LEFUTOTT TESZTEK: %d   (ebbol piros: %d)" % (futott, pirosak))
        # A SZAM MELLE ODA KELL IRNI, MIT MER. Egy bukas utan a turbo a tobbi
        # csomagot EL SEM INDITJA, tehat ez a szam a futas tulajdonsaga, nem a
        # repoe. Merve: ugyanezen a repon a bukott futas ezret ad, a zold
        # haromezer folottit -- a kulonbseg a le sem futott csomagok.
        print("     (ennyi futott le EBBEN a futasban, a bukasig; egy zold futas")
        print("      ugyanezen a repon tobbet ad, mert a bukas utan a turbo")
        print("      a tobbi csomagot el sem inditja)")
    allitasok = bukott_allitasok(cel)
    if allitasok:
        print("     A BUKOTT ALLITASOK NEVE:")
        for futtato, szoveg in allitasok:
            print("       [%s] %s" % (futtato, szoveg))
    else:
        # A NULLA MELLE ODAIRJUK, MIT KERESTUNK -- kulonben ugy nez ki, mintha a naplo
        # ures lenne, holott csak a mintank nem talalt semmit.
        print("     NULLA BUKOTT ALLITAS a naploban. Amit kerestem:")
        print("       vitest:      a 'FAIL <nev>' es a '× <nev>' sorok")
        print("       node --test: a 'not ok <n> - <nev>' sorok")
        print("     Ha a lepes megis piros, akkor NEM tesztbukas volt (lint, build, telepites).")
    print("     a teljes naplo: %s" % cel)
sys.exit(1 if hibas else 0)
PY
