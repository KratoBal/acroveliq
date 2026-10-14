#!/usr/bin/env python3
# ANSWERS: Melyik feladathoz tartozik ez a PR, ha a beolvaszto nem kapott --task-ot?
#
# feladat-pr-szerint.py --repo <owner/name> --pr <N>
#
# MIERT LETEZIK (merge-task-auto, acrobot atadasa 77): a pr-beolvaszt.sh csak --task
# mellett irja a `merged` esemenyt. 2026-10-14 00:0x-kor a #94 beolvasztasa --task nelkul
# ment, az esemeny elmaradt, es kezzel kellett potolni (549). A feladatot viszont a
# feladat SAJAT esemenyei mar megnevezik: a #78 ota a `review_requested` es a `verdict`
# ref-je `<owner>/<repo>#<N> fej <sha>` alaku.
#
# A KERESES: a /api/tasks lista, es feladatonkent a /timeline; csak a `review_requested`
# es a `verdict` esemeny ref-je szamit, es abban a `<owner>/<repo>#<N>` pontosan (a repo
# kis- es nagybetu nelkul, a szam utan nem allhat szamjegy: a #9 nem a #97). Szerveroldali
# szuro nincs, es nem is kell: merve 2026-10-14, 95 feladat idovonala 0,2 s alatt jon le,
# a dashboard telepitese nelkul.
#
# KIMENET ES KILEPES, mert a hivo ebbol dont, es nem talalgat:
#   0  pontosan EGY feladat: az azonositoja a stdout-on, egyedul
#   3  TOBB feladat nevezi meg: a listajuk a stderr-en, a stdout ures
#   4  EGY SEM: egy sor a stderr-en, a stdout ures
#   1  a keresest nem tudtam elvegezni (a dashboard nem valaszolt, rossz valasz)
#   2  rossz argumentum
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'lib'))
from dashboard_token import read_token  # noqa: E402

REPO_RE = re.compile(r'^(?!.*\.\.)[\w.-]+/[\w.-]+$')
KINDS = ('review_requested', 'verdict')


def fail(msg, code):
    print(f'feladat-pr-szerint: {msg}', file=sys.stderr)
    sys.exit(code)


def parse(argv):
    a = {}
    i = 0
    while i < len(argv):
        if argv[i] not in ('--repo', '--pr') or i + 1 >= len(argv):
            fail(f'ismeretlen vagy ertek nelkuli kapcsolo: {argv[i]}', 2)
        a[argv[i][2:]] = argv[i + 1]
        i += 2
    if 'repo' not in a or 'pr' not in a:
        fail('hasznalat: feladat-pr-szerint.py --repo <owner/name> --pr <N>', 2)
    if not REPO_RE.match(a['repo']):
        fail(f'a --repo nem owner/name: {a["repo"]}', 2)
    if not re.fullmatch(r'[1-9][0-9]{0,6}', a['pr']):
        fail(f'a --pr nem PR-szam: {a["pr"]}', 2)
    return a['repo'], a['pr']


def names(ref, repo, pr):
    """Does this ref name repo#pr, exactly?"""
    pat = re.compile(r'(?<![\w.-])' + re.escape(repo) + '#' + pr + r'(?!\d)', re.IGNORECASE)
    return bool(pat.search(ref or ''))


def main(argv):
    repo, pr = parse(argv)
    base = f'http://localhost:{os.environ.get("MARVEEN_WEB_PORT", "3420")}/api'
    token = read_token(ROOT)

    def get(path):
        req = urllib.request.Request(base + path, headers={'Authorization': f'Bearer {token}'})
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)

    try:
        tasks = get('/tasks')
        if not isinstance(tasks, list):
            fail('a /api/tasks nem listat adott', 1)
        found = []
        for t in tasks:
            tid = t.get('id') if isinstance(t, dict) else None
            if not isinstance(tid, str) or not tid:
                fail('a /api/tasks egyik sorabol hianyzik az id', 1)
            items = get(f'/tasks/{urllib.parse.quote(tid, safe="")}/timeline').get('items')
            if not isinstance(items, list):
                fail(f'a {tid} idovonala nem listat adott', 1)
            if any(i.get('source') == 'event' and i.get('kind') in KINDS and names(i.get('ref'), repo, pr) for i in items):
                found.append(tid)
    except (urllib.error.URLError, OSError, ValueError, AttributeError) as e:
        fail(f'a keresest nem tudtam elvegezni: {e}', 1)

    if len(found) == 1:
        print(found[0])
        return 0
    if found:
        print(f'feladat-pr-szerint: {len(found)} feladat nevezi meg a {repo}#{pr}-t, nem valasztok: {", ".join(found)}', file=sys.stderr)
        return 3
    print(f'feladat-pr-szerint: egy feladat review_requested vagy verdict esemenye sem nevezi meg a {repo}#{pr}-t', file=sys.stderr)
    return 4


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
