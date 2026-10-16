#!/usr/bin/env bash
# ANSWERS: Elindul-e a GitHub Actions egy repoban? (letrehoz-e egyaltalan futast a fo agra kerult commit utan)
#
# Miert letezik (2026-10-15): a KratoBal/marveen leagazas (fork), es a GitHub 2026-10-14 22:23Z-kor
# magatol kikapcsolta rajta a workflow-kat. Az API kozben "active"-ot mondott, futas viszont EGY SEM
# keletkezett, nyolc oran at senki nem vette eszre. Ez az or a HIANYT meri: a fo ag feje es a legutobbi
# futas kozti idot.
#
# A TOKEN LEJARATA (barracuda, V-GH-1 v3; acrobot 31196) CSAK A TULAJDONOSI TOKENRE SZOL, es az
# 2026-10-16 ota csak FLEET_GITHUB_APP=off mellett fut. Alapbol (a broker az alapertek, #231) a token
# repoonkent a brokertol jon (lib/github_token.py, olvas szerep), egy oraig el, a lejarata tehat nem
# figyelendo; a tulajdonosi tokent pedig Balazs visszavonja (a D4 6. lepese), es utana ez az or
# minden futasnal riasztott volna. Ami marad:
#   - a broker nem ad tokent: RIASZT a repora, a broker sajat okaval (nem csendes);
#   - a GitHub elutasitja a tokent (401, vagy 403 "Bad credentials"): RIASZT. Brokerrel ez az App
#     telepiteset vagy kulcsat jelenti, a tulajdonosi tokennel a lejaratot vagy a visszavonast;
#   - off mellett a lejarat-fejlec figyelese, valtozatlanul: LEJARAT_ELOTT_NAP nappal elotte RIASZT,
#     hianyzo fejlecnel HIBA (barracuda, #188 review).
#
# Hasznalat: ci-el-or.sh [tulajdonos/repo ...]   (alapertelmezes: KratoBal/acroveliq)
# Kimenet soronkent: OK | RIASZT | HIBA. Kilepesi kod 1, ha barmelyik RIASZT.
set -uo pipefail
ROOT=/home/marveen/marveen
[ "$#" -gt 0 ] || set -- KratoBal/acroveliq
CI_ELOR_LIB="$ROOT/scripts/lib" python3 - "$@" <<'PY'
import json, os, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.environ["CI_ELOR_LIB"])
from github_token import GithubTokenError, github_token
OWNER = os.environ.get("FLEET_GITHUB_APP", "on") == "off"  # the lib's own rule: only exactly off
LEJARAT_ELOTT_NAP = 14
expiry = []  # the expiration header of the first answer that carried one (owner token only)
answered = []  # at least one call came back: only then is a missing header a fact
rejected = []  # 401, or 403 "Bad credentials": the token itself is refused
def g(p, t):
    r = urllib.request.Request("https://api.github.com/repos/" + p,
        headers={"Authorization": "Bearer " + t, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(r, timeout=20) as resp:
        h = resp.headers.get("github-authentication-token-expiration")
        if h and not expiry:
            expiry.append(h)
        answered.append(1)
        return json.load(resp)
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
now = datetime.now(timezone.utc)
bad = 0
for repo in sys.argv[1:]:
    try:
        t = github_token(repo, "olvas")
    except GithubTokenError as e:
        bad += 1
        print(f"RIASZT {repo}: nincs olvas token, az or nem mer: {e}"); continue
    try:
        head = g(repo + "/commits/main", t)
        htime = ts(head["commit"]["committer"]["date"])
        runs = g(repo + "/actions/runs?per_page=1", t)["workflow_runs"]
    except urllib.error.HTTPError as e:
        # after the expiry every call is a 401: without this the watcher would go quiet exactly when
        # merging has stopped (barracuda, #188 review)
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        if e.code == 401 or (e.code == 403 and "Bad credentials" in body):
            rejected.append(e.code)
        print(f"HIBA {repo}: HTTP {e.code}"); continue
    except Exception as e:
        print(f"HIBA {repo}: {e}"); continue
    last = ts(runs[0]["created_at"]) if runs else None
    age = (now - htime).total_seconds() / 60
    if last is None or (last < htime and age > 60):
        bad += 1
        print(f"RIASZT {repo}: a fo ag feje {head['sha'][:8]} {age:.0f} perce all, utana EGY futas sem keletkezett "
              f"(legutobbi futas: {runs[0]['created_at'] if runs else 'nincs'}). Nezd a repo Actions lapjat a webes feluleten.")
    else:
        print(f"OK {repo}: fej {head['sha'][:8]} ({htime:%m-%d %H:%MZ}), legutobbi futas {last:%m-%d %H:%MZ}")
if rejected:
    bad += 1
    if OWNER:
        print(f"RIASZT token: a GitHub elutasitja a flotta tokenjet (HTTP {rejected[0]}): lejart vagy visszavontak. "
              "A beolvasztas es minden GitHub-hivas all: uj token kell a fiok feluleten.")
    else:
        print(f"RIASZT token: a GitHub elutasitja a broker tokenjet (HTTP {rejected[0]}): az App telepitese vagy "
              "kulcsa a gyanus (GitHub, az App oldala). A beolvasztas es minden GitHub-hivas all.")
elif not OWNER:
    pass  # a broker token lives an hour by design: its expiry header is no alarm
elif expiry:
    # "2027-01-11 10:04:05 UTC": the format GitHub sends
    try:
        until = datetime.strptime(expiry[0].replace(" UTC", ""), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        print(f"HIBA token: a lejarat-fejlec nem olvashato: {expiry[0]!r}")
    else:
        days = (until - now) / timedelta(days=1)
        if days <= LEJARAT_ELOTT_NAP:
            bad += 1
            print(f"RIASZT token: a flotta GitHub-tokenje {until:%Y-%m-%d %H:%MZ}-kor lejar ({days:.0f} nap mulva). "
                  "Lejarat utan a beolvasztas es minden GitHub-hivas leall: uj token kell a fiok feluleten.")
        else:
            print(f"OK token: lejar {until:%Y-%m-%d %H:%MZ} ({days:.0f} nap mulva)")
elif answered:
    print("HIBA token: a valaszokon nincs lejarat-fejlec (lejarat nelkuli vagy klasszikus token?)")
sys.exit(1 if bad else 0)
PY
