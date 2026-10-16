#!/usr/bin/env bash
# ANSWERS: Hany commit var kint az eles rendszereken, es mi fut rajtuk eppen most.
#
# MIERT EZ AZ ESZKOZ LETEZIK, merve 2026-09-02 reggel: az eles commerce tizenharom orat es
# HET commitot csuszott, es nem azert, mert igy dontottunk, hanem mert senki nem mert. Az
# eles telepitest kezzel inditjuk (szandekosan), a teszt gep magatol telepul -- tehat az
# eles MINDIG lemarad, es a lemaradas merete csak akkor derul ki, ha valaki megkerdezi.
#
# AMIT A MERES HASZNAL, ES AMIT NEM:
#   a futo commitot a szolgaltatas SAJAT /health valasza mondja meg (application.commit),
#   nem a Coolify. A Coolify git_commit_sha mezoje 'HEAD', az a KONFIGURACIO (mindig a friss
#   foag), nem az, ami fut; a deployments vegpontja pedig alkalmazas-azonositoval
#   'Deployment not found' hibat ad, tehat arra alkalmatlan.
#
#   Az ertek build-idoben sul be a kepbe (apps/api/Dockerfile RELEASE_COMMIT_SHA), tehat egy
#   ujrainditas nem hamisitja meg, es .git nelkul is helyes.
#
# A HATARA: a commerce /health valasza ma csak "OK", commit nelkul. Amig ott nincs ugyanilyen
# mezo, a commerce sorat ez a szkript nem tudja kitolteni, es ezt KI IS IRJA -- nem nullat
# mond ra.
#
# A MASODIK HATARA, ES EZ SULYOSABB: a /health commit-ja JELEN LEHET, ES MEGIS ELAVULT.
# A build-idoben besult ertek akkor hazudik, ha a KEP epult ujra ugy, hogy a valtozo nem
# frissult -- a hianyzo mezo latszik, ez nem. (Ez a hatar elvi: 2026-09-07 este azt hittuk,
# hogy mert esetunk is van ra, de az allitas megdolt. A helyes olvasat ott az volt, hogy a
# vegpont IGAZAT mondott, es az eles peldany REGI, mert kezzel telepitjuk. Aki peldat keres,
# ne ezt idezze: nincs meg megmert esetunk.)
#
# AMIT TENNI KELL, MIELOTT EGY LEMARADAS-SZAMOT KIMONDASZ: probald ki a szammal EGY olyan
# dolgot, amit a jelentett commit NEM MAGYARAZ (egy azota keletkezett vegpont vagy mezo).
# Ha az el, akkor nem a rendszer van lemaradva, hanem a jelentes. FIGYELEM: ehhez a probahoz
# ERVENYES KULCS kell. Kulcs nelkul minden /store ut 400-at ad, a kontroll is, es az a futas
# semmit nem bizonyit -- 2026-09-07 este pontosan ezen csusztunk el.
#
# ES A HARMADIK HATARA, AMI A MASIK KETTONEL GYAKORIBB (murena merese, 2026-09-08): HAROM
# EGYEZO ZOLD LEHET EGY MERES HAROMSZOR. Aznap harom ellenorzes futott ugyanarra a commitra
# (letezik-e a repoban, ose-e a fo agnak, melyik PR zarja), mind a harom zold lett, es MIND
# A HAROM ugyanazt a tulajdonsagot merte: hogy a commit BENT VAN A TORTENETBEN. Egyik sem
# mondott semmit arrol, hogy FUT-E. Harom egyezo zold megerositesnek olvasodik, holott a
# fuggetlenseguket senki nem merte meg. Mielott tobb zoldre hivatkozol, mondd meg, melyik
# MELYIK kerdesre valaszol -- ha ugyanarra, akkor egy valaszod van, nem harom.
#
#   bash /home/marveen/marveen/scripts/eles-lemaradas.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$(dirname "${BASH_SOURCE[0]}")/lib/github-token.sh"   # github_token <owner/repo> <role> (FLEET_GITHUB_APP)
GH_TOK="$(github_token KratoBal/acropora-os olvas)" || exit 1

GH_TOK="$GH_TOK" python3 - <<'PYEOF'
import json, os, subprocess, urllib.error, urllib.request

REPO = "KratoBal/acropora-os"
TOK = os.environ.pop("GH_TOK", "").strip()

# name, health url  (a commerce szandekosan itt all, hogy a hianya LATSZODJON)
TARGETS = [
    ("acropora-os API (eles)", "https://api.acropora.hu/health"),
    ("acropora-os API (teszt)", "https://api-staging.acropora.hu/health"),
    ("commerce (eles)", "https://commerce.acropora.hu/health"),
]


def health(url):
    try:
        out = subprocess.run(["curl", "-s", "-m", "12", url], capture_output=True, text=True).stdout
        d = json.loads(out)
        return (d.get("application") or {}).get("commit")
    except Exception:
        return None


def compare(base, head="main"):
    req = urllib.request.Request(
        "https://api.github.com/repos/%s/compare/%s...%s" % (REPO, base, head),
        headers={"Authorization": "Bearer " + TOK, "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, ValueError, OSError) as e:
        return {"__err": str(e)}


print("MI FUT, ES MENNYI VAR KINT (a szolgaltatas sajat /health valasza alapjan)")
print()
for name, url in TARGETS:
    sha = health(url)
    if not sha:
        print("  %-26s a /health nem mond commitot -- NEM TUDJUK, mi fut rajta" % name)
        continue
    cmp = compare(sha)
    if "__err" in cmp:
        print("  %-26s %s | az osszevetes nem ment: %s" % (name, sha[:8], cmp["__err"]))
        continue
    ahead = cmp.get("ahead_by", 0)
    behind = cmp.get("behind_by", 0)
    if ahead == 0 and behind == 0:
        print("  %-26s %s | NAPRAKESZ" % (name, sha[:8]))
        continue
    print("  %-26s %s | %d commit var kint" % (name, sha[:8], ahead))
    for c in (cmp.get("commits") or [])[-5:]:
        msg = (c.get("commit", {}).get("message") or "").splitlines()[0]
        # A GitHub UTC-ben ad datumot. Nem szamolom at: egy atszamolt ido, aminek nem
        # latszik a zonaja, rosszabb, mint egy megjelolt UTC ertek (a zonafajl mar
        # hazudott egyszer ezen a gepen, 2026-08-20).
        when = (c.get("commit", {}).get("committer") or {}).get("date", "")[:16].replace("T", " ")
        print("      %s  %s UTC  %s" % (c["sha"][:8], when, msg[:70]))
    if ahead > 5:
        print("      (csak az utolso ot latszik a %d-bol)" % ahead)
print()
print("A telepites inditasa (eles, KEZI, es csak Balazs engedelyevel), a vegrehajton at (P0-3):")
print("  bash scripts/vegrehajto.sh kerj <agens> prod <alkalmazas> <sha40>")
print("  (a coolify.acropora.hu a B20 ota kivulrol zart, a Coolify API-t kozvetlenul nem hivjuk)")
PYEOF
