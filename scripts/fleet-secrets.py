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
jelet kap, nem szamolt valaszt (az ACL a xattr-listabol jog nelkul latszik); ha a lista nem olvashato,
"?" jelet. Minden os-konyvtar x bitje szamit, nem csak a store/-e. A futtato sajat sorat
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
    """True with an ACL, False without, None when the xattr list cannot be read: an ACL can ADD a
    right, so an unreadable list is not "no ACL" (barracuda, #190 review)."""
    try:
        return any(a.startswith("system.posix_acl") for a in os.listxattr(path))
    except OSError:
        return None


def dir_chain(path):
    """Every directory from / down to `path`: a read needs the x bit on each of them."""
    out = []
    p = os.path.abspath(path)
    while True:
        out.append(p)
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    return list(reversed(out))


def matrix_rows():
    """(users, rows, mismatch): rows are {file, owner, group, mode, readers: {user: IGEN|nem|ACL|?}}.
    The one computation behind --matrix and the permission-change watcher (titok-jog-figyelo.py)."""
    import pwd
    users = fleet_users()
    # every ancestor counts, not only store/ (barracuda, #190 review): /home or the project root
    # closed to a user closes every file under it
    chain = [(os.stat(d), has_acl(d)) for d in dir_chain(STORE)]
    dir_acl = [a for _, a in chain]

    def dirs_ok(uid, gids):
        return all(can(st.st_mode, st.st_uid, st.st_gid, uid, gids, EXEC) for st, _ in chain)
    me = os.getuid()
    my_gids = set(os.getgroups()) | {os.getgid()}
    mismatch = []
    rows = []
    for fn in secret_names():
        p = os.path.join(STORE, fn)
        st = os.stat(p)
        try:
            owner = pwd.getpwuid(st.st_uid).pw_name
        except KeyError:
            owner = str(st.st_uid)
        acls = dir_acl + [has_acl(p)]
        acl = "ACL" if any(a is True for a in acls) else ("?" if any(a is None for a in acls) else None)
        readers = {}
        for name, uid, gids in users:
            if acl:
                readers[name] = acl
                continue
            ok = dirs_ok(uid, gids) and can(st.st_mode, st.st_uid, st.st_gid, uid, gids, READ)
            readers[name] = "IGEN" if ok else "nem"
        # the runner's own answer, whether or not it is a fleet user (a CI runner is not): the same
        # computation against the real os.access, so the calibration holds everywhere
        if not acl:
            mine = dirs_ok(me, my_gids) and can(st.st_mode, st.st_uid, st.st_gid, me, my_gids, READ)
            if mine != os.access(p, os.R_OK):
                mismatch.append(fn)
        rows.append({"file": fn, "owner": owner, "group": group_of(p), "mode": oct(st.st_mode)[-3:], "readers": readers})
    return [u[0] for u in users], rows, mismatch


def matrix():
    import pwd
    names, rows, mismatch = matrix_rows()
    me = os.getuid()
    if "--json" in sys.argv:
        print(json.dumps({"users": names, "rows": rows, "mismatch": mismatch}, ensure_ascii=False))
        return 2 if mismatch else 0
    print("%-38s %-10s %-16s %-4s %s" % ("FAJL", "TULAJDONOS", "CSOPORT", "MOD", "  ".join(n.replace("agent-", "") for n in names)))
    widths = [max(4, len(n.replace("agent-", ""))) for n in names]
    for r in rows:
        cells = [r["readers"][n] for n in names]
        print("%-38s %-10s %-16s %-4s %s" % (r["file"], r["owner"], r["group"], r["mode"],
                                            "  ".join(c.ljust(w) for c, w in zip(cells, widths))))
    print()
    print("A tartalmat egyik sem nyitja meg. Szamolva a tulajdonosbol, a csoportbol es a modbol.")
    if mismatch:
        print("ELTERES a futtato sajat soran (szamolt kontra os.access): %s" % ", ".join(mismatch))
        return 2
    print("A futtato (%s) szamolt valasza minden fajlon egyezik az os.access-szel." % pwd.getpwuid(me).pw_name)
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
