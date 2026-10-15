#!/usr/bin/env bash
# ANSWERS: Elindul-e a GitHub Actions egy repoban? (letrehoz-e egyaltalan futast a fo agra kerult commit utan)
#
# Miert letezik (2026-10-15): a KratoBal/marveen leagazas (fork), es a GitHub 2026-10-14 22:23Z-kor
# magatol kikapcsolta rajta a workflow-kat. Az API kozben "active"-ot mondott, futas viszont EGY SEM
# keletkezett, nyolc oran at senki nem vette eszre. Ez az or a HIANYT meri: a fo ag feje es a legutobbi
# futas kozti idot.
#
# A TOKEN LEJARATA (barracuda, V-GH-1 v3; acrobot 31196): a flotta tokenje fine-grained, es lejar
# (2027-01-11 10:04 UTC). Lejarat utan a beolvasztas, ez az or es minden GitHub-hivas leall. A GitHub
# minden valaszon kuldi a `github-authentication-token-expiration` fejlecet; ez az or azt olvassa, es
# LEJARAT_ELOTT_NAP nappal elotte RIASZT sort ad. Ha a fejlec hianyzik (egy lejarat nelkuli vagy
# klasszikus token), HIBA sort ad: az nem surgos, de lathato legyen. Ha a GitHub magat a tokent
# utasitja el (401, vagy 403 "Bad credentials": lejart vagy visszavontak), az RIASZT: kulonben a lejarat
# UTAN hallgatna el az or, pont amikor a beolvasztas mar all (barracuda, #188 review).
#
# Hasznalat: ci-el-or.sh [tulajdonos/repo ...]   (alapertelmezes: KratoBal/acroveliq)
# Kimenet soronkent: OK | RIASZT | HIBA. Kilepesi kod 1, ha barmelyik RIASZT.
set -uo pipefail
ROOT=/home/marveen/marveen
TOKEN_FILE="$ROOT/store/.github-token"
[ -r "$TOKEN_FILE" ] || { echo "HIBA: nincs github token: $TOKEN_FILE"; exit 2; }
[ "$#" -gt 0 ] || set -- KratoBal/acroveliq
TOKEN="$(cat "$TOKEN_FILE")" python3 - "$@" <<'PY'
import json, os, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
t = os.environ["TOKEN"]
LEJARAT_ELOTT_NAP = 14
expiry = []  # the expiration header of the first answer that carried one
answered = []  # at least one call came back: only then is a missing header a fact
rejected = []  # 401, or 403 "Bad credentials": the token itself is expired or revoked
def g(p):
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
        head = g(repo + "/commits/main")
        htime = ts(head["commit"]["committer"]["date"])
        runs = g(repo + "/actions/runs?per_page=1")["workflow_runs"]
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
# "2027-01-11 10:04:05 UTC": the format GitHub sends
if rejected:
    bad += 1
    print(f"RIASZT token: a GitHub elutasitja a flotta tokenjet (HTTP {rejected[0]}): lejart vagy visszavontak. "
          "A beolvasztas es minden GitHub-hivas all: uj token kell a fiok feluleten.")
elif expiry:
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
