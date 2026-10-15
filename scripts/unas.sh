#!/usr/bin/env bash
# ANSWERS: Mi all az elo webshop termekadataban (olvaso ag; az iras kulon uton es kulon engedellyel megy).
#
# UNAS webshop OLVASO helper (shop.acropora.hu, ShopId 47679).
#
# MIERT LETEZIK: a termekadat eddig nem volt gepileg elerheto a flottanak, es emiatt
# minden keszlet- es termekkerdes emberi korkerdes volt (2026-08-16, otleteles: harom
# agens egymastol fuggetlenul ugyanezt a hianyt nevezte meg elso helyen).
#
# =====================================================================================
# A TERMEK ALAPSTATUSZA NEGY ERTEKU, NEM KETTO. Ez itt all, es nem emlekben, mert
# 2026-09-02-ig OTSZOR kerdeztuk meg Balazstol ugyanezt, es o otodszorre szolt ra.
#
#   Statuses.Status[Type=base].Value
#     0  inaktiv
#     1  aktiv
#     2  aktiv es UJ
#     3  aktiv, de NEM VASAROLHATO
#
# Forras: az UNAS sajat API-dokumentacioja, plusz Balazs admin-kepernyokepe; eloszor
# 2026-08-17 13:21-kor merve friss dumpon, es 2026-09-02-en fuggetlenul ujramerve.
# A KET MERES EGYEZIK a ket ritka erteken (54 darab kettes, 4 darab harmas), es a masik
# ketto is egy nagysagrendben mozdult (315/314 inaktiv, 1516/1521 aktiv).
#
# MIERT KERESTE MEG OTSZOR OT KULONBOZO EMBER, es miert ITT all a valasz: a feljegyzes
# cime "termekstatuszok" volt, a kerdest viszont mindenki "publikacios allapotkent"
# teszi fel. A kereses nem talal ra, a valasz meg ott van. Nem figyelmetlenseg: a tudas
# olyan helyen lakott, ahol csak veletlenul jon elo. Itt viszont mindenki elolvassa,
# aki UNAS adathoz nyul.
#
# ES AMIT EZ A NEGY ERTEK JELENT A GYAKORLATBAN: a "hany termek lathato" es a "hany
# termek megvasarolhato" NEM ugyanaz a szam, es egyik sem az "aktiv" darabszam. Aki
# ketallasunak veszi (aktiv kontra nem aktiv), az 58 tetelt sorol rossz oldalra.
# =====================================================================================
#
# BIZTONSAG:
# - A host HARDCODED (api.unas.eu). Nem valtoztathato at exfiltracios csatornava.
# - Az altalanos hivas-utvonal (`post`) CSAK get*/check* vegpontot enged. Ez valtozatlan.
# - IRAS: 2026-08-30 ota a kulcs tud irni (Balazs kapcsolta be, egyetlen jog: setProduct),
#   es ehhez KULON utvonal van (`post_write`), amit a `set-short` es a `set-name` hasznal.
#   A CIKKSZAM SOHA NEM VALTOZIK. Balazs allando szabalya, 2026-08-31 08:40, szo szerint:
#   "Egy dolgot rogzitsunk! Cikkszamot soha nem valtoztatunk!" Egyik parancsnak sincs
#   kapcsoloja ra, es a set-name a kesz keresben vissza is meri, hogy a cikkszam valtozatlan.
#   A ketto szandekosan nincs osszekotve: aki a `get` parancson at probal irni, ugyanugy
#   elakad, mint korabban.
#   BALAZS KIKOTESE, SZO SZERINT (2026-08-30 23:04): "soha semmilyen korulmenyek kozott nem
#   irhattok onalloan csak ha en megengedem". Ezert az iras HAROM feltetelhez kotott:
#     1. `--approval "<mire hivatkozva>"` -- naploba kerul, utolag szamon kerheto
#     2. `--expect <sha256>` -- a MAI bolti szoveg lenyomata; ha kozben barmi valtozott,
#        az iras el sem indul (kulonben eszrevetlenul felulirnank mas munkajat)
#     3. nem ures es nem azonos szoveg
#   A naplo: store/unas-writes.log (soronkent egy JSON).
# - A token es az API kulcs SOSEM kerul a kimenetbe.
#
# Hasznalat:
#   unas.sh login                       -> lejarat + jogosultsagok (token nelkul)
#   unas.sh count                       -> hany termek van
#   unas.sh dump <fajl.jsonl>           -> MINDEN termek, soronkent egy JSON objektum
#   unas.sh stock <fajl.jsonl>          -> keszletadatok
#   unas.sh categories [fajl]           -> kategoriafa, JSON (fajlnev nelkul stdout-ra)
#   unas.sh orders <fajl.jsonl> [--since EEEE.HH.NN] [--force]
#                                       -> rendelesek, SZEMELYES ADAT NELKUL (lasd lentebb)
#   unas.sh newsletter-stat             -> hirlevel-lista OSSZESITVE, cimek nelkul
#   unas.sh get <endpoint> [params.xml] -> nyers hivas, csak get*/check* endpointra
#   unas.sh set-short <sku> <fajl> --approval "<szoveg>" --expect <sha256> [--field short|long]
#                                       -> a rovid leiras (Description/Short) FELULIRASA, lasd BIZTONSAG
#                                       -> `--field long`: UGYANEZ a HOSSZU leirasra
#                                          (Description/Long). Ez a kapcsolo 2026-09-04-ig
#                                          csak a kod belsejeben volt dokumentalva, itt nem,
#                                          es ezert azt jelentettem a gazdanak, hogy a hosszu
#                                          leiras irasat MEG MEG KELL IRNI. Nem kellett: mar
#                                          kesz volt. Egy nem dokumentalt kapcsolo ugyanugy
#                                          nem letezik, mint egy meg meg nem irt -- csak
#                                          dragabban, mert a masodikat legalabb nem kezdi el
#                                          senki masodszor is megirni.
#   unas.sh set-name <sku> <fajl> --approval "<szoveg>" --expect <sha256>
#                                       -> a termek NEVENEK felulirasa. A cikkszam SOHA nem
#                                          valtozik, lasd BIZTONSAG.
#
# SZEMELYES ADAT -- MIERT SZUR AZ `orders`:
# A getOrder nyers valasza tartalmazza a vevo nevet, e-mail cimet, telefonszamat, a szamlazasi
# es szallitasi cimet es az adoszamat. Ezek egy elemzeshez NEM KELLENEK, a lemezre irasuk
# viszont letrehoz egy szemelyesadat-halmazt egy olyan gepen, ahol tobb agens dolgozik, es
# ahol a fajl konnyen bekerul egy repoba. Ezert az `orders` parancs KIVAG mindent, ami
# szemelyhez kot, es csak azt tartja meg, ami a mereshez kell: datum, statusz, vegosszeg,
# fizetesi es szallitasi mod NEVE, es a tetelek (cikkszam, mennyiseg, ar).
# Ha valakinek valaha tenyleg kell a vevoadat, az legyen kulon parancs, kulon indoklassal --
# ne ennek a mellekhatasa. A `newsletter-stat` ugyanezert csak SZAMOKAT ad, egyetlen
# e-mail cimet sem ir ki.
#
# Kimenet: hiba eseten "FAIL <ok>" a stderr-en, exit 1.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export UNAS_ROOT="$ROOT"
die() { echo "FAIL $*" >&2; exit 1; }

[ -f "$ROOT/store/.unas-api-key" ] || die "nincs API kulcs: store/.unas-api-key"

cmd="${1:-}"; shift || true
case "$cmd" in
  login|count|dump|stock|categories|orders|newsletter-stat|get|set-short|set-name) ;;
  *) die "ismeretlen parancs: '${cmd}' -- login | count | dump | stock | categories | orders | newsletter-stat | get | set-short | set-name" ;;
esac

UNAS_CMD="$cmd" python3 - "$@" <<'PYEOF'
import hashlib, json, os, re, sys, time, urllib.request
import xml.etree.ElementTree as ET

ROOT = os.environ["UNAS_ROOT"]
CMD = os.environ["UNAS_CMD"]
STORE = os.path.join(ROOT, "store")
HOST = "https://api.unas.eu/shop/"
PAGE = 500


def die(m):
    print("FAIL " + m, file=sys.stderr)
    raise SystemExit(1)


def post_write(endpoint, xml, token, approval, timeout=180):
    """A KIZAROLAGOS iras-utvonal. Kulon fuggveny, hogy a `post()` olvaso maradjon.

    Balazs dontese 2026-08-30 23:04: "soha semmilyen korulmenyek kozott nem irhattok
    onalloan csak ha en megengedem". Ezert az iras nem attol lesz lehetseges, hogy a kulcs
    tud irni, hanem attol, hogy a hivo MEGNEVEZI az engedelyt -- es a megnevezes naploba
    kerul, tehat utolag szamon kerheto, ki mire hivatkozva irt.
    """
    if endpoint != "setProduct":
        die("iras csak a setProduct vegponton mehet, ez nem az: " + endpoint)
    if not approval or len(approval.strip()) < 10:
        die("iras engedely megnevezese nelkul nem indithato (--approval)")
    h = {"Content-Type": "application/xml; charset=utf-8", "Authorization": "Bearer " + token}
    req = urllib.request.Request(HOST + endpoint, data=xml.encode("utf-8"), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        die("%s %s: %s" % (endpoint, e.code, e.read().decode("utf-8", "replace")[:300]))
    except Exception as e:
        die("%s halozati hiba: %s" % (endpoint, e))


def post(endpoint, xml, token=None, timeout=180):
    if not (endpoint.startswith("get") or endpoint.startswith("check") or endpoint == "login"):
        die("csak olvaso vegpont hivhato, ez nem az: " + endpoint)
    h = {"Content-Type": "application/xml; charset=utf-8"}
    if token:
        h["Authorization"] = "Bearer " + token
    req = urllib.request.Request(HOST + endpoint, data=xml.encode("utf-8"), headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        die("%s %s: %s" % (endpoint, e.code, e.read().decode("utf-8", "replace")[:300]))
    except Exception as e:
        die("%s halozati hiba: %s" % (endpoint, e))


def login(fresh=False):
    """Token cache-elve a lejarat elott 120 masodpercig. A tokent sosem irjuk ki.

    A `fresh=True` KIHAGYJA a gyorsitotarat. Miert kell: a gyorsitotar a TOKENNEL egyutt a
    JOGOSULTSAG LISTAT is orzi, az viszont a bolt adminjaban barmikor valtozhat, es akkor a
    ket adat kora elvalik. Merve 2026-08-30 23:07: Balazs bekapcsolta a setProduct jogot, a
    `unas.sh login` pedig harom perccel korabbi gyorsitotarbol valaszolt, es azt irta ki, hogy
    "IRASI JOG: nincs". Ez a fajta hiba a legrosszabb alaku: nem hibauzenet, hanem egy magabiztos
    NEM, amit a hivo tenynek olvas -- majdnem azt jelentettem a gazdanak, hogy nem tortent meg,
    amit o megtett. A tokent tovabbra is gyorsitotarazzuk minden ADATLEKERO parancsnal (az a
    hivasok szamat fogja vissza), a jogosultsag KIIRASA viszont mindig friss bejelentkezesbol jon.
    """
    cache = os.path.join(STORE, ".unas-token")
    if not fresh:
        try:
            d = json.load(open(cache))
            if d.get("expire", 0) > time.time() + 120:
                return d["token"], d
        except Exception:
            pass
    key = open(os.path.join(STORE, ".unas-api-key")).read().strip()
    body = '<?xml version="1.0" encoding="UTF-8" ?><Params><ApiKey>%s</ApiKey></Params>' % key
    root = ET.fromstring(post("login", body, timeout=45))
    tok = root.findtext("Token")
    if not tok:
        die("a login nem adott tokent (lejart vagy visszavont kulcs?)")
    info = {"token": tok,
            "expire": int(root.findtext("ExpireTime") or 0),
            "expire_h": root.findtext("Expire"),
            "shop": root.findtext("ShopId"),
            "perms": [p.text for p in root.iter("Permission")]}
    # A gyorsitotar irasa NEM ALLITHATJA MEG a hivast. Merve 2026-08-30 23:1x: a fajlt
    # torolni kellett egy meres kedveert, es az ujra letrehozott fajl a torlo felhasznalo
    # csoportjat kapta (marveen), nem a `sec-unas` csoportot. Attol a pillanattol a masik
    # felhasznalo alatt futo agens (polip) mar nem tudta megnyitni irasra, es egy kezeletlen
    # PermissionError az EGESZ parancsot elvitte volna -- pedig a token a kezeben volt, a
    # munka elvegezheto lett volna. A gyorsitotar gyorsit, nem feltetel.
    try:
        with open(cache, "w") as f:
            json.dump(info, f)
    except OSError:
        pass
    # 0660, not 0600, and the chmod may fail -- deliberately, both of them.
    # The cache is written by whoever calls login(), and since 2026-08-20 that is
    # no longer only marveen: polip runs as its own OS user and reaches the token
    # through the `sec-unas` group. 0600 would lock the group out of the very file
    # its membership exists for, and a chmod by a non-owner raises EPERM even when
    # the write itself succeeded -- which turned a working `unas.sh login` into
    # exit 1 for polip (measured, and found by polip). The mode stays inside the
    # same group: nobody gains access who did not already have it.
    try:
        os.chmod(cache, 0o660)
    except OSError:
        pass
    return tok, info


def x2d(el):
    """XML reszfa -> dict. Ismetlodo gyerek -> lista. Sosem dob el adatot."""
    kids = list(el)
    if not kids:
        return (el.text or "").strip()
    out = {}
    for k in kids:
        v = x2d(k)
        if k.tag in out:
            if not isinstance(out[k.tag], list):
                out[k.tag] = [out[k.tag]]
            out[k.tag].append(v)
        else:
            out[k.tag] = v
    return out


def paged(token, endpoint, item_tag, params_extra=""):
    """Lapozva kikeri az osszes tetelt. A UNAS LimitStart/LimitNum parost hasznal.

    A LimitStart 1-ALAPU, nem eltolas. Ez merve lett 2026-08-16: nulla kezdettel az
    elso ket lap ATFEDETT egyetlen tetellel (a 778843825 azonosito ketszer jott vissza,
    pontosan az 500-as hataron), mert a 0 es az 1 kezdet ugyanazt jelenti. Csak az ELSO
    hataron latszik, a kesobbieken nem -- vagyis egy felszines proba nem mutatja meg.
    """
    start, seen = 1, 0
    while True:
        body = ('<?xml version="1.0" encoding="UTF-8" ?><Params>'
                '<LimitStart>%d</LimitStart><LimitNum>%d</LimitNum>%s</Params>'
                % (start, PAGE, params_extra))
        root = ET.fromstring(post(endpoint, body, token))
        items = list(root.iter(item_tag))
        if not items:
            return seen
        for it in items:
            yield x2d(it)
            seen += 1
        if len(items) < PAGE:
            return seen
        start += PAGE


a = sys.argv[1:]

if CMD == "login":
    # Mindig friss: a jogosultsag lista a bolt adminjaban valtozik, a gyorsitotar nem tud rola.
    _, info = login(fresh=True)
    print("shop=%s lejarat=%s" % (info["shop"], info["expire_h"]))
    print("jogosultsagok (%d): %s" % (len(info["perms"]), " ".join(info["perms"])))
    write = [p for p in info["perms"] if not (p.startswith("get") or p.startswith("check"))]
    print("IRASI JOG: " + (", ".join(write) if write else "nincs -- a kulcs csak olvasni tud"))

elif CMD == "count":
    # A State ELHAGYHATO, es a hianya NEM ugyanaz, mint a "live".
    #
    # MERVE 2026-09-04 (barracuda lelete): a mi lehivasunk State NELKUL ment, es het
    # napon at BETURE 1893-at adott. Az OS szinkronja viszont KET kort fut, EXPLICIT
    # allapottal ("live" es "deleted"), es nalunk 1894 termek all. A ket szam ezert nem
    # egymas ellenorzese, hanem KET KULONBOZO KERDES valasza -- es az allapot nelkuli
    # alak egy MEG NEM NEVEZETT alapertelmezes, nem "az osszes termek".
    #
    # Ezert lehet mostantol allapotot adni:  unas.sh count live
    # Az allapot nelkuli alak valtozatlanul mukodik, hogy a regi szamok osszevethetok
    # maradjanak -- de aki szamot ir le, irja oda, MELYIK alakkal merte.
    tok, _ = login()
    state = (a[0] if a else "").strip()
    extra = "<ContentType>minimal</ContentType>"
    if state:
        extra = "<State>%s</State>%s" % (state, extra)
    n = 0
    for _ in paged(tok, "getProduct", "Product", extra):
        n += 1
    print("%d  (State=%s)" % (n, state if state else "nincs megadva"))

elif CMD in ("dump", "stock"):
    if not a:
        die("hasznalat: unas.sh %s <kimeneti fajl.jsonl> [--force]" % CMD)
    # NEM IRUNK FELUL NEMAN. 2026-08-16 ejjel pontosan ez tortent: ujratoltottem a
    # dumpot ugyanarra a nevre, mikozben polip epp abbol dolgozott. A ket meres kozti
    # kulonbseg ugy nezett ki, mintha a boltban tortent volna valtozas. Egy meres, ami
    # nem reprodukalhato, rosszabb mint a hianyzo meres, mert ugy nez ki mint adat.
    force = "--force" in a[1:]
    target = a[0]
    if os.path.exists(target) and not force:
        stamp = time.strftime("%Y-%m-%d-%H%M", time.localtime(os.path.getmtime(target)))
        root, ext = os.path.splitext(target)
        die("mar letezik es nem irom felul: %s\n"
            "       A meglevo fajl %s-os. Vagy adj uj nevet (javaslat: %s-%s%s),\n"
            "       vagy ha tenyleg le akarod cserelni: --force" % (target, stamp, root, stamp, ext))
    tok, _ = login()
    # A getStock is <Product> elemeket ad vissza (Id, Sku, Stocks/Stock/Qty). Elsore a
    # <Stock> tagre iteraltam, es akkor a kimenetbol HIANYZOTT AZ AZONOSITO: csak a
    # mennyiseg jott, termekhez rendelni nem lehetett. polip vette eszre 2026-08-16.
    # Mellekhatas volt az is, hogy a sorszam (1898) nem egyezett a termekszammal, mert
    # egy termekhez tobb Stock sor is tartozhat.
    endpoint, tag, extra = (("getProduct", "Product", "<ContentType>full</ContentType>")
                            if CMD == "dump" else ("getStock", "Product", ""))
    n = 0
    with open(a[0], "w") as f:
        for item in paged(tok, endpoint, tag, extra):
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
            n += 1
    print("%d sor -> %s" % (n, a[0]))

elif CMD == "categories":
    tok, _ = login()
    body = '<?xml version="1.0" encoding="UTF-8" ?><Params></Params>'
    root = ET.fromstring(post("getCategory", body, tok))
    cats = [x2d(c) for c in root.iter("Category")]
    if a:
        # A kategoriafa nagy, es stdout-ra ontve hasznalhatatlan. polip kerese, 2026-08-16.
        with open(a[0], "w", encoding="utf-8") as f:
            if a[0].endswith(".jsonl"):
                for c in cats:
                    f.write(json.dumps(c, ensure_ascii=False) + "\n")
            else:
                json.dump(cats, f, ensure_ascii=False, indent=1)
                f.write("\n")
        print("%d kategoria -> %s" % (len(cats), a[0]))
    else:
        print(json.dumps(cats, ensure_ascii=False, indent=1))

elif CMD == "orders":
    if not a:
        die("hasznalat: unas.sh orders <kimeneti fajl.jsonl> [--since EEEE.HH.NN] [--force]")
    target = a[0]
    force = "--force" in a[1:]
    since = None
    for i, v in enumerate(a):
        if v == "--since":
            if i + 1 >= len(a):
                die("a --since utan datum kell, EEEE.HH.NN alakban (pl. 2026.01.01)")
            since = a[i + 1]
    if since and not re.match(r"^\d{4}\.\d{2}\.\d{2}$", since):
        die("a --since alakja EEEE.HH.NN legyen (pl. 2026.01.01), ez nem az: " + since)
    if os.path.exists(target) and not force:
        stamp = time.strftime("%Y-%m-%d-%H%M", time.localtime(os.path.getmtime(target)))
        r_, e_ = os.path.splitext(target)
        die("mar letezik es nem irom felul: %s (%s-os). Adj uj nevet vagy --force." % (target, stamp))

    # A megtartott mezok LISTAJA, nem a kihagyottake. Igy ha a UNAS holnap uj mezot ad
    # vissza, az NEM kerul be automatikusan -- egy uj szemelyes mezo nem szivarog at azzal,
    # hogy valaki elfelejtette bovíteni a tiltolistat.
    # "Referer" added 2026-08-21: it is the ONLY field in a UNAS order that says
    # where the buyer arrived from, and without it a Facebook campaign can never
    # be checked against our own orders -- only against Meta's self-reported
    # attribution, which we measured to claim 77% of a month's revenue for a
    # single campaign. It is domain-level ("l.facebook.com", "google.hu"), holds
    # no query string and no campaign id, and in a 50-order sample half the rows
    # were empty. That is enough while exactly ONE campaign runs, and not enough
    # for two. It is not personal data: no name, no address, no email.
    KEEP = ("Key", "Id", "Date", "DateMod", "Currency", "Status", "StatusType",
            "SumPriceGross", "SumPriceNet", "Seen", "Lang", "Referer")
    ITEM_KEEP = ("Id", "Sku", "Name", "Unit", "Quantity", "PriceNet", "PriceGross", "Vat")

    def clean(o):
        out = {k: o[k] for k in KEEP if k in o}
        for blk in ("Shipping", "Payment"):
            b = o.get(blk)
            if isinstance(b, dict) and b.get("Name"):
                out[blk] = b["Name"]          # csak a MOD neve, semmi cim
        inv = o.get("Invoice")
        if isinstance(inv, dict) and inv.get("Status"):
            out["InvoiceStatus"] = inv["Status"]
        # A VEVO AZONOSITOJA, ES CSAK AZ. Balazs kerte 2026-09-07-en, mert enelkul
        # nem merheto, hany meglevo rendelesnel oldhato fel egyaltalan a vasarlo --
        # a rendeles es a vasarlo osszekotese (PR 581) EZEN a mezon all.
        # A `Customer` blokk NEVET, E-MAIL CIMET, TELEFONT es CIMET is tartalmaz,
        # ezert nem a blokkot vesszuk at, hanem egyetlen kulcsot belole. Ugyanaz a
        # minta, mint a Shipping/Payment eseteben: a blokkbol csak az, ami a
        # mereshez kell.
        # AMI EZZEL LEMEZRE KERUL: egy alneves azonosito, ami a UNAS-ban EGY vevore
        # mutat. Nev nelkul nem azonosit szemelyt, de OSSZEKAPCSOLHATO -- ezert ha
        # egy elemzeshez nem kell, ne ezt a parancsot hasznald.
        cust = o.get("Customer")
        if isinstance(cust, dict) and cust.get("Id"):
            out["CustomerId"] = cust["Id"]
        # A VEVOCSOPORT NEVE, es csak a neve (barracuda 26770, 2026-10-06): a kuszob
        # alatti ingyenes szallitas oka a vevocsoport lehet, es enelkul nem merheto.
        # Csoportnev, nem szemelyes adat; a Customer blokk tobbi resze tovabbra sem jon at.
        grp = cust.get("Group") if isinstance(cust, dict) else None
        if isinstance(grp, dict) and grp.get("Name"):
            out["CustomerGroup"] = grp["Name"]
        items = (o.get("Items") or {}).get("Item")
        if isinstance(items, dict):
            items = [items]
        if isinstance(items, list):
            out["Items"] = [{k: it[k] for k in ITEM_KEEP if isinstance(it, dict) and k in it}
                            for it in items]
        return out

    tok, _ = login()
    extra = ("<DateStart>%s</DateStart>" % since) if since else ""
    n = 0
    with open(target, "w", encoding="utf-8") as f:
        for o in paged(tok, "getOrder", "Order", extra):
            f.write(json.dumps(clean(o), ensure_ascii=False) + "\n")
            n += 1
    print("%d rendeles -> %s%s" % (n, target, (" (%s ota)" % since) if since else ""))
    print("szemelyes adat NINCS a fajlban: nev, e-mail, telefon, cim es adoszam kimaradt.")

elif CMD == "newsletter-stat":
    # Szandekosan NEM ir fajlt es NEM ad ki egyetlen e-mail cimet sem. A kerdes, amire
    # valaszol ('milyen szegmensek vannak'), szamokkal megvalaszolhato.
    tok, _ = login()
    from collections import Counter
    total = 0
    by_type, by_auth, by_lang, by_year = Counter(), Counter(), Counter(), Counter()
    for s in paged(tok, "getNewsletter", "Subscriber", ""):
        total += 1
        by_type[s.get("Type") or "?"] += 1
        by_auth[s.get("Authorized") or "?"] += 1
        by_lang[s.get("Lang") or "?"] += 1
        try:
            by_year[time.strftime("%Y", time.localtime(int(s.get("Time") or 0)))] += 1
        except Exception:
            by_year["?"] += 1
    print("hirlevel-feliratkozo osszesen: %d" % total)
    print("\ntipus szerint:")
    for k, v in by_type.most_common():
        print("  %-12s %5d" % (k, v))
    print("\nmegerositve (Authorized):")
    for k, v in by_auth.most_common():
        print("  %-12s %5d" % (k, v))
    print("\nnyelv szerint:")
    for k, v in by_lang.most_common():
        print("  %-12s %5d" % (k, v))
    print("\nfeliratkozas eve szerint:")
    for k in sorted(by_year):
        print("  %-12s %5d" % (k, by_year[k]))
    print("\nEgyetlen e-mail cim sem hagyta el ezt a parancsot.")

elif CMD == "set-short":
    # unas.sh set-short <sku> <uj-szoveg-fajl> --approval "<mire hivatkozva>" --expect <sha256>
    #                  [--field short|long]
    #
    # A `--field long` ugyanezt a HOSSZU leiras mezore vegzi. Miert egy parancs a ketto:
    # az orzok (engedely, lenyomat, ures es azonos szoveg) szo szerint azonosak, es ket
    # kulon masolatban elobb-utobb az egyik lemarad egy javitasrol.
    #
    # Harom orzo, es mindharom KULON tud megallitani:
    #   1. engedely megnevezese kotelezo (post_write)
    #   2. az `--expect` a MAI ertekre vonatkozo sha256: ha a bolti szoveg kozben barmit
    #      valtozott, az iras NEM indul el. Enelkul egy masik szerkeszto munkajat irnank felul,
    #      es errol soha nem tudnank meg semmit.
    #   3. az uj szoveg nem lehet ures, es nem lehet azonos a maival (ures iras is iras)
    if len(a) < 2:
        die("hasznalat: unas.sh set-short <sku> <fajl> --approval \"<szoveg>\" --expect <sha256>")
    sku, path = a[0], a[1]
    approval, expect, field = "", "", "short"
    rest = a[2:]
    for i, v in enumerate(rest):
        if v == "--field" and i + 1 < len(rest):
            field = rest[i + 1].lower()
    if field not in ("short", "long"):
        die("--field csak short vagy long lehet: " + field)
    FLD = "Short" if field == "short" else "Long"
    FLAG = FLD + "IsHtml"
    for i, v in enumerate(rest):
        if v == "--approval" and i + 1 < len(rest):
            approval = rest[i + 1]
        if v == "--expect" and i + 1 < len(rest):
            expect = rest[i + 1]
    if not expect:
        die("--expect kotelezo: a MAI szoveg sha256 osszege, kulonben mas munkajat is felulirhatnank")
    new = open(path, encoding="utf-8").read()
    if not new.strip():
        die("ures szoveget nem irunk ki (ez is iras)")

    tok, _ = login()
    body = ('<?xml version="1.0" encoding="UTF-8" ?><Params><Sku>%s</Sku>'
            '<ContentType>full</ContentType></Params>' % sku)
    cur_root = ET.fromstring(post("getProduct", body, tok))
    prods = list(cur_root.iter("Product"))
    if len(prods) != 1:
        die("a getProduct nem pontosan egy termeket adott vissza (%d), iras nem indul" % len(prods))
    cur_el = prods[0].find("Description/" + FLD)
    cur = cur_el.text if cur_el is not None and cur_el.text else ""
    cur_sha = hashlib.sha256(cur.encode("utf-8")).hexdigest()
    if cur_sha != expect:
        die("a bolti szoveg MA MAS, mint amibol a javitas keszult (%s helyett %s) -- iras nem indul"
            % (expect[:12], cur_sha[:12]))
    # A jelzo-helyreallitas MIATT nem eleg a szoveget nezni: ha a ShortIsHtml romlott el, a
    # javitas eppen az, hogy a szoveg VALTOZATLAN marad, es csak a jelzo all vissza.
    cur_is_html_el = prods[0].find("Description/" + FLAG)
    cur_is_html = (cur_is_html_el.text or "1") if cur_is_html_el is not None else "1"
    want_is_html = cur_is_html
    for i, v in enumerate(rest):
        if v == "--is-html" and i + 1 < len(rest):
            want_is_html = rest[i + 1]
    if cur == new and want_is_html == cur_is_html:
        die("az uj szoveg azonos a maival es a jelzo sem valtozik, nincs mit irni")

    # A ShortIsHtml JELZOT EGYUTT KELL KULDENI A SZOVEGGEL, KULONBEN A BOLT NULLARA ALLITJA.
    # Merve 2026-08-30 23:21, elesben, az elso irasnal: csak a Short mezot kuldtem, mire a
    # ShortIsHtml 1-rol 0-ra valtott. A szoveg ettol nem tort el (a bolt tovabbra is HTML-kent
    # jelenitette meg), de bekapcsolt a sortores-atalakitas: minden korabbi sorvegbol <br />
    # lett, tehat a bekezdesek koze es a felsorolas ele latszo ures sorok kerultek. Vagyis egy
    # olyan mezo valtozott meg, amit nem is kuldtem -- a keres HIANYA is iras.
    is_html_el = prods[0].find("Description/" + FLAG)
    is_html = (is_html_el.text or "1") if is_html_el is not None else "1"
    for i, v in enumerate(rest):          # --is-html: csak helyreallitasra, ha a jelzo mar elromlott
        if v == "--is-html" and i + 1 < len(rest):
            is_html = rest[i + 1]
    payload = ('<?xml version="1.0" encoding="UTF-8" ?><Products><Product>'
               '<Action>modify</Action><Sku>%s</Sku><Description><%s><![CDATA[%s]]></%s>'
               '<%s>%s</%s></Description></Product></Products>'
               % (sku, FLD, new, FLD, FLAG, is_html, FLAG))
    if "]]>" in new:
        die("a szoveg CDATA lezarast tartalmaz, igy nem kuldheto biztonsagosan")
    resp = post_write("setProduct", payload, tok, approval)

    logline = json.dumps({"ts": int(time.time()), "sku": sku, "field": field, "approval": approval,
                          "before_len": len(cur), "after_len": len(new),
                          "before_sha": cur_sha[:16],
                          "after_sha": hashlib.sha256(new.encode("utf-8")).hexdigest()[:16]},
                         ensure_ascii=False)
    try:
        with open(os.path.join(STORE, "unas-writes.log"), "a", encoding="utf-8") as f:
            f.write(logline + "\n")
    except OSError:
        print("FIGYELEM: a naplo nem irhato, de az iras megtortent", file=sys.stderr)
    print(resp.strip()[:400])
    print("NAPLO: " + logline)

elif CMD == "set-name":
    # unas.sh set-name <sku> <fajl> --approval "<mire hivatkozva>" --expect <sha256>
    #
    # MIERT KULON PARANCS, ES NEM A set-short EGY KAPCSOLOJA: a set-short a Description
    # blokkot irja, ez a termek NEVET. A ketto mas mezocsalad, mas a kockazata (a nev a
    # listaoldalon es a keresoben is latszik), es a Balazs-fele cikkszam-szabaly CSAK erre
    # a parancsra vonatkozik. Egy kozos parancs osszemosna a kettot.
    #
    # BALAZS ALLANDO SZABALYA, 2026-08-31 08:40, Discord, Eldontendo szal, szo szerint:
    #   "Egy dolgot rogzitsunk! Cikkszamot soha nem valtoztatunk!"
    # Ezert a Sku itt KIZAROLAG AZONOSITO. Nincs kapcsolo az atirasara, a payloadba a
    # hivaskor megadott ertek kerul, es a keres elkuldese ELOTT vissza is merjuk, hogy a
    # payloadban pontosan egy <Sku> all, pontosan azzal az ertekkel. Ez nem udvariassagi
    # ellenorzes: egy elirt cikkszam eseten a setProduct UJ TERMEKET hozna letre.
    #
    # Negy orzo, es mind kulon tud megallitani:
    #   1. engedely megnevezese kotelezo (post_write)
    #   2. --expect: a MAI nev sha256 osszege. Ha kozben barki hozzanyult, az iras nem indul.
    #   3. az uj nev nem lehet ures es nem lehet azonos a maival
    #   4. a nev EGY SOR, nincs benne HTML jelolo, es legfeljebb 255 karakter
    if len(a) < 2:
        die("hasznalat: unas.sh set-name <sku> <fajl> --approval \"<szoveg>\" --expect <sha256>")
    sku, path = a[0], a[1]
    approval, expect = "", ""
    rest = a[2:]
    for i, v in enumerate(rest):
        if v == "--approval" and i + 1 < len(rest):
            approval = rest[i + 1]
        if v == "--expect" and i + 1 < len(rest):
            expect = rest[i + 1]
    if not expect:
        die("--expect kotelezo: a MAI nev sha256 osszege, kulonben mas munkajat is felulirhatnank")
    new = open(path, encoding="utf-8").read().strip("\n")
    if not new.strip():
        die("ures nevet nem irunk ki (ez is iras)")
    if "\n" in new or "\r" in new:
        die("a termeknev egy sor. Tobb sort kaptam, iras nem indul")
    if "<" in new or ">" in new:
        die("a termeknevben nem lehet HTML jelolo, iras nem indul")
    if len(new) > 255:
        die("a termeknev tul hosszu (%d karakter, a hatar 255), iras nem indul" % len(new))

    tok, _ = login()
    body = ('<?xml version="1.0" encoding="UTF-8" ?><Params><Sku>%s</Sku>'
            '<ContentType>full</ContentType></Params>' % sku)
    cur_root = ET.fromstring(post("getProduct", body, tok))
    prods = list(cur_root.iter("Product"))
    if len(prods) != 1:
        die("a getProduct nem pontosan egy termeket adott vissza (%d), iras nem indul" % len(prods))
    # A LEKERT termek cikkszamat is visszaolvassuk, nem csak azt hisszuk, amit kertunk.
    cur_sku_el = prods[0].find("Sku")
    cur_sku = cur_sku_el.text if cur_sku_el is not None and cur_sku_el.text else ""
    if cur_sku != sku:
        die("a bolt mas cikkszamu termeket adott vissza (%r a kert %r helyett), iras nem indul"
            % (cur_sku, sku))
    cur_el = prods[0].find("Name")
    cur = cur_el.text if cur_el is not None and cur_el.text else ""
    cur_sha = hashlib.sha256(cur.encode("utf-8")).hexdigest()
    if cur_sha != expect:
        die("a bolti nev MA MAS, mint amibol a javitas keszult (%s helyett %s) -- iras nem indul"
            % (expect[:12], cur_sha[:12]))
    if cur == new:
        die("az uj nev azonos a maival, nincs mit irni")

    payload = ('<?xml version="1.0" encoding="UTF-8" ?><Products><Product>'
               '<Action>modify</Action><Sku>%s</Sku><Name><![CDATA[%s]]></Name>'
               '</Product></Products>' % (sku, new))
    if "]]>" in new:
        die("a nev CDATA lezarast tartalmaz, igy nem kuldheto biztonsagosan")
    # A CIKKSZAM-ORZO VISSZAMERESE. Nem elhagyhato: ez az egyetlen pont, ahol a kesz keres
    # es Balazs szabalya osszevetheto. Ha a payload barmiert mas cikkszamot vinne, itt all meg.
    if payload.count("<Sku>") != 1 or ("<Sku>%s</Sku>" % sku) not in payload:
        die("a keresben nem pontosan egy, valtozatlan cikkszam all -- iras nem indul")
    resp = post_write("setProduct", payload, tok, approval)

    logline = json.dumps({"ts": int(time.time()), "sku": sku, "field": "name", "approval": approval,
                          "before_len": len(cur), "after_len": len(new),
                          "before": cur, "after": new,
                          "before_sha": cur_sha[:16],
                          "after_sha": hashlib.sha256(new.encode("utf-8")).hexdigest()[:16]},
                         ensure_ascii=False)
    try:
        with open(os.path.join(STORE, "unas-writes.log"), "a", encoding="utf-8") as f:
            f.write(logline + "\n")
    except OSError:
        print("FIGYELEM: a naplo nem irhato, de az iras megtortent", file=sys.stderr)
    print(resp.strip()[:400])
    print("NAPLO: " + logline)

elif CMD == "get":
    if not a:
        die("hasznalat: unas.sh get <endpoint> [params.xml]")
    tok, _ = login()
    body = open(a[1]).read() if len(a) > 1 else '<?xml version="1.0" encoding="UTF-8" ?><Params></Params>'
    print(post(a[0], body, tok))
PYEOF
