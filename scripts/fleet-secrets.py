#!/usr/bin/env python3
"""fleet-secrets -- mi a titkunk, mire kell, ki eri el, es mikor jar le.

WHY THIS EXISTS. Balázs, 2026-09-01: *"Nem szeretnek orakat eltolteni azzal hogy kulcsokat
vagy barmi ilyet keresunk. A lejaro tokenek legyenek figyelve es idoben szoljon valaki."*

Ma 29 titok-fajl all a `store/` mappaban. Hogy melyik mire kell es meddig el, sehol nem volt
leirva. Egy lejaro token nem hibauzenettel jelentkezik: egy reggel egyszeruen nem megy a
feltoltes, es akkor kezdodik a keresgeles.

**ERTEKET SOHA NEM IR KI.** Se a kimenetbe, se fajlba, se naploba. Ami itt latszik: a fajl
neve, a merete, a jogosultsaga, a celja, es a lejarat -- semmi tobb. Ezt a szkriptet ezert
biztonsagos naploba iranyitani vagy csatornara masolni.

  python3 scripts/fleet-secrets.py            # a teljes lista
  python3 scripts/fleet-secrets.py --warn     # csak ami 30 napon belul lejar vagy ismeretlen
  python3 scripts/fleet-secrets.py --matrix   # ki olvashatja: a marveen es az agens-felhasznalok x titok

EXIT 1, ha barmi 30 napon belul lejar. Igy utemezett feladatbol is hasznalhato.

A LEJARAT HAROM FELE LEHET, es a kulonbseg szamit:
  MERT      az API maga mondja meg (GitHub). Ez a legjobb: nem avul el.
  JELOLT    kezzel felirtuk a store/secrets-lejarat.json fajlba. Ez elavulhat.
  ISMERETLEN nem tudjuk. Ez NEM azt jelenti, hogy nem jar le -- csak azt, hogy vakon
             allunk. Egy ismeretlen lejarat ugyanolyan lelet, mint egy kozeli.

A --matrix MOD (Security Baseline F0-2, az M-3 jogosultsag-figyelo elofeltetele; acrobot 31236): a
marveen es minden agent-* felhasznalo minden titok-fajlra IGEN vagy NEM valaszt kap, jog nelkul
kiszamolva a tulajdonosbol, a csoportbol, a modbol es a csoporttagsagbol (pwd, grp), ugyanugy, ahogy
a kernel dont: elobb a tulajdonos, aztan a csoport, aztan mindenki, es a store/ mappa x bitje is
kell. A store/ alatt 2026-10-15-en egyetlen fajlon sem volt ACL; ha megis lesz, az a sor "ACL"
jelet kap, nem szamolt valaszt (az ACL a xattr-listabol jog nelkul latszik). A futtato sajat sorat
a valodi os.access-szel is osszeveti, es elteresnel 2-vel lep ki. Kimenet: ut, tulajdonos, csoport,
mod es a felhasznalonkenti IGEN/NEM. A fajl TARTALMAT nem nyitja meg, es halozatot sem hiv.
"""

import json
import os
import sys
import time
import urllib.request

ROOT = os.environ.get("FLEET_ROOT", "/home/marveen/marveen")
STORE = os.path.join(ROOT, "store")
ANNOT = os.path.join(STORE, "secrets-lejarat.json")

# Mire kell. Ami nincs itt, az "?" cellel jelenik meg -- nem talalgatunk celt.
PURPOSE = {
    ".dashboard-token": "a vezerlopult API-ja; minden agens ezt hasznalja",
    ".claude-oauth-token": "az agensek bejelentkezese a Claude fiokba",
    ".github-token": "feltoltes es pull request (KratoBal, finomhangolt)",
    ".github-token-commerce": "GitHub, commerce repo",
    ".coolify-token-prod": "Coolify, eles (coolify.acropora.hu)",
    ".coolify-token-ai": "Coolify, AI gep (coolify2.acropora.hu)",
    ".acropora-ai-token": "az Acropora AI API",
    ".acropora-ai-token-stage": "az Acropora AI API, teszt",
    ".unas-api-key": "UNAS webshop API",
    ".fb-page-token": "Facebook oldal",
    ".fb-user-token": "Facebook felhasznalo",
    ".fb-page-tokens.json": "Facebook oldal tokenek",
    ".expo-token": "Expo, mobil build",
    ".fal-key": "fal.ai, kepgeneralas",
    ".gdrive-access-token": "Google Drive",
    ".gdrive-refresh-token": "Google Drive, megujito",
}


def annotations():
    try:
        with open(ANNOT) as f:
            return json.load(f)
    except Exception:
        return {}


def github_expiry():
    """MERT lejarat: a GitHub maga mondja meg egy fejlecben."""
    try:
        tok = open(os.path.join(STORE, ".github-token")).read().strip()
        r = urllib.request.Request("https://api.github.com/user",
                                   headers={"Authorization": "Bearer " + tok, "User-Agent": "acrobot"})
        h = urllib.request.urlopen(r, timeout=10).headers
        v = h.get("github-authentication-token-expiration")
        return v.split()[0] if v else None
    except Exception:
        return None


def group_of(path):
    try:
        import grp
        return grp.getgrgid(os.stat(path).st_gid).gr_name
    except Exception:
        return "?"


def days_until(datestr):
    try:
        t = time.mktime(time.strptime(datestr, "%Y-%m-%d"))
        return int((t - time.time()) / 86400)
    except Exception:
        return None


def secret_names():
    """The store's secret files, by the one filter both modes use (the comment below)."""
    out = []
    for fn in sorted(os.listdir(STORE)):
        p = os.path.join(STORE, fn)
        if not os.path.isfile(p) or not fn.startswith("."):
            continue
        # A KULCSSZO-LISTA CSENDBEN HAGY KI, ES 2026-09-07-ig ki is hagyott: a
        # .fleet-ro-password egyik szot sem tartalmazta, tehat a leltar SOHA nem
        # latta -- pedig az eles adatbazis olvaso szerepenek jelszava. Egy
        # titok-leltar hibaja NEM szimmetrikus: a folosleges sor zaj, a hianyzo sor
        # hamis biztonsag. Ezert a lista bovult, es ezert all itt ez a megjegyzes:
        # ha uj titok kerul a mappaba olyan neven, ami egyik szot sem tartalmazza,
        # EZ A SOR VALTOZIK, nem a fajl neve.
        if not any(k in fn for k in ("token", "key", "env", "secret", "cred",
                                     "password", "passwd", "passphrase", "auth")):
            continue
        out.append(fn)
    return out


def can(mode, file_uid, file_gid, uid, gids, bits):
    """The kernel's order: the owner class alone if the uid owns it, else the group class if one
    of its groups owns it, else the others. `bits` is (owner, group, other) for read or execute."""
    if uid == 0:
        return True
    if uid == file_uid:
        return bool(mode & bits[0])
    if file_gid in gids:
        return bool(mode & bits[1])
    return bool(mode & bits[2])


READ = (0o400, 0o040, 0o004)
EXEC = (0o100, 0o010, 0o001)


def fleet_users():
    """(name, uid, gids) for marveen and every agent-* user: the primary group and every group
    that lists the user."""
    import grp
    import pwd
    users = []
    for pw in sorted(pwd.getpwall(), key=lambda p: (p.pw_name != "marveen", p.pw_name)):
        if pw.pw_name != "marveen" and not pw.pw_name.startswith("agent-"):
            continue
        gids = {pw.pw_gid} | {g.gr_gid for g in grp.getgrall() if pw.pw_name in g.gr_mem}
        users.append((pw.pw_name, pw.pw_uid, gids))
    return users


def has_acl(path):
    try:
        return any(a.startswith("system.posix_acl") for a in os.listxattr(path))
    except OSError:
        return False


def matrix():
    import pwd
    users = fleet_users()
    dst = os.stat(STORE)
    dir_acl = has_acl(STORE)
    me = os.getuid()
    mismatch = []
    print("%-38s %-10s %-16s %-4s %s" % ("FAJL", "TULAJDONOS", "CSOPORT", "MOD", "  ".join(u[0].replace("agent-", "") for u in users)))
    for fn in secret_names():
        p = os.path.join(STORE, fn)
        st = os.stat(p)
        try:
            owner = pwd.getpwuid(st.st_uid).pw_name
        except KeyError:
            owner = str(st.st_uid)
        acl = dir_acl or has_acl(p)
        cells = []
        for name, uid, gids in users:
            if acl:
                cells.append("ACL")
                continue
            ok = can(dst.st_mode, dst.st_uid, dst.st_gid, uid, gids, EXEC) and can(st.st_mode, st.st_uid, st.st_gid, uid, gids, READ)
            cells.append("IGEN" if ok else "nem")
            if uid == me and ok != os.access(p, os.R_OK):
                mismatch.append(fn)
        widths = [max(4, len(u[0].replace("agent-", ""))) for u in users]
        print("%-38s %-10s %-16s %-4s %s" % (fn, owner, group_of(p), oct(st.st_mode)[-3:],
                                            "  ".join(c.ljust(w) for c, w in zip(cells, widths))))
    print()
    print("A tartalmat egyik sem nyitja meg. Szamolva a tulajdonosbol, a csoportbol es a modbol.")
    if mismatch:
        print("ELTERES a futtato sajat soran (szamolt kontra os.access): %s" % ", ".join(mismatch))
        return 2
    print("A futtato sajat sora egyezik az os.access-szel (%s)." % pwd.getpwuid(me).pw_name)
    return 0


def main():
    if "--matrix" in sys.argv:
        return matrix()
    warn_only = "--warn" in sys.argv
    ann = annotations()
    gh = github_expiry()

    rows = []
    for fn in secret_names():
        p = os.path.join(STORE, fn)
        st = os.stat(p)
        exp, src = None, "ISMERETLEN"
        if fn == ".github-token" and gh:
            exp, src = gh, "MERT"
        elif fn in ann:
            exp, src = ann[fn], "JELOLT"
        d = days_until(exp) if exp else None
        rows.append({
            "fn": fn, "mode": oct(st.st_mode)[-3:], "grp": group_of(p),
            "size": st.st_size, "purpose": PURPOSE.get(fn, "?"),
            "exp": exp, "src": src, "days": d,
        })

    soon = [r for r in rows if r["days"] is not None and r["days"] <= 30]
    unknown = [r for r in rows if r["exp"] is None]

    if not warn_only:
        print("%-32s %-5s %-18s %-10s %-12s %s" % ("FAJL", "MOD", "CSOPORT", "LEJARAT", "FORRAS", "MIRE KELL"))
        print("-" * 118)
        for r in rows:
            e = r["exp"] or "-"
            if r["days"] is not None:
                e = "%s (%d nap)" % (r["exp"], r["days"])
            print("%-32s %-5s %-18s %-10s %-12s %s" % (
                r["fn"], r["mode"], r["grp"], e, r["src"], r["purpose"]))
        print()
        print("ERTEKET EGYIK SEM MUTAT. %d titok-fajl." % len(rows))
        print()

    if soon:
        print("HAMAROSAN LEJAR:")
        for r in soon:
            print("  %-32s %s, %d nap mulva -- %s" % (r["fn"], r["exp"], r["days"], r["purpose"]))
        print()
    if unknown:
        print("ISMERETLEN LEJARAT (%d). Ez nem azt jelenti, hogy nem jar le:" % len(unknown))
        for r in unknown[:40]:
            print("  %-32s %s" % (r["fn"], r["purpose"]))
        print()
        print("Amelyiknek van ismert lejarata, azt ird be ide, hogy figyelni tudjuk:")
        print("  %s   ->  {\"fajlnev\": \"EEEE-HH-NN\"}" % ANNOT)
        print()

    return 1 if soon else 0


if __name__ == "__main__":
    sys.exit(main())
