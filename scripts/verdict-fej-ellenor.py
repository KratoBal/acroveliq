#!/usr/bin/env python3
"""Does the task's LATEST barracuda verdict on this PR approve the PR's live head? (card 31e495e0)

The merger's gate before a merge (pr-beolvaszt.sh): the GitHub APPROVED state alone is not enough. On #194 the review's
commit_id stood on the new head while the verdict on the timeline was for the old one (barracuda 40282, 40290): the
review follows the head, the verdict does not. So the verdict itself is read: the task's timeline, its verdict events by
barracuda that name this repo#PR, the latest one (by time, then id), its word and its head (`... fej <40 hex>`).

  verdict-fej-ellenor.py --task <task_id> --repo <owner/name> --pr <N> --head <40 hex>

Exit 0: the latest verdict is APPROVE and its head is the PR's head, letter for letter (40 hex: a short head names no
one commit). Exit 1: no such verdict, the latest is CHANGES, its head is another or not 40 hex; both heads are printed.
Exit 3: the timeline could not be read (not a verdict on anything). Exit 2: a wrong call.
"""
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

REVIEWERS = {'barracuda'}
REPO_RE = re.compile(r'^(?!.*\.\.)[\w.-]+/[\w.-]+$', re.ASCII)
# the fleet repo is KratoBal/acroveliq since 2026-10-15; verdicts written before name KratoBal/marveen
REPO_ALIASES = {'kratobal/marveen': 'kratobal/acroveliq'}
# review-ellenoriz.sh writes "<APPROVE|CHANGES> <owner/repo>#<N> pr-<packet>[ fej <hex>]"
VERDICT_RE = re.compile(r'^(APPROVE|CHANGES)\s+((?!\S*\.\.)[\w.-]+/[\w.-]+)#(\d+)(?:\s+pr-\S+)?(?:\s+fej\s+([0-9a-f]+))?\s*$', re.ASCII)


def canonical(repo):
    r = repo.lower()
    return REPO_ALIASES.get(r, r)


def fail(msg, code):
    print(f'verdict-fej-ellenor: {msg}', file=sys.stderr)
    sys.exit(code)


def parse(argv):
    a = {}
    i = 0
    while i < len(argv):
        if argv[i] not in ('--task', '--repo', '--pr', '--head') or i + 1 >= len(argv):
            fail(f'ismeretlen vagy ertek nelkuli kapcsolo: {argv[i]}', 2)
        a[argv[i][2:]] = argv[i + 1]
        i += 2
    for k in ('task', 'repo', 'pr', 'head'):
        if k not in a:
            fail('hasznalat: verdict-fej-ellenor.py --task <task_id> --repo <owner/name> --pr <N> --head <40 hex>', 2)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', a['task'], re.ASCII):
        fail(f'a --task nem feladat-azonosito: {a["task"]}', 2)
    if not REPO_RE.match(a['repo']):
        fail(f'a --repo nem owner/name: {a["repo"]}', 2)
    if not re.fullmatch(r'[1-9][0-9]{0,6}', a['pr'], re.ASCII):
        fail(f'a --pr nem PR-szam: {a["pr"]}', 2)
    if not re.fullmatch(r'[0-9a-f]{40}', a['head'], re.ASCII):
        fail(f'a --head nem 40 jegyu fej: {a["head"]}', 2)
    return a['task'], a['repo'], int(a['pr']), a['head']


def latest_verdict(items, repo, pr):
    """The latest barracuda verdict event naming repo#pr: (word, head or '', ref), or None."""
    found = []
    for i in items:
        if not isinstance(i, dict) or i.get('source') != 'event' or i.get('kind') != 'verdict' or i.get('actor') not in REVIEWERS:
            continue
        m = VERDICT_RE.match(i.get('ref') or '')
        if not m or canonical(m.group(2)) != canonical(repo) or int(m.group(3)) != pr:
            continue
        found.append(((i.get('at') or 0, i.get('id') or 0), m.group(1), m.group(4) or '', i.get('ref')))
    if not found:
        return None
    found.sort(key=lambda f: f[0])
    _, word, head, ref = found[-1]
    return word, head, ref


def main(argv):
    task, repo, pr, head = parse(argv)
    base = f'http://localhost:{os.environ.get("MARVEEN_WEB_PORT", "3420")}/api'
    try:
        token = read_token(ROOT)
        req = urllib.request.Request(f'{base}/tasks/{urllib.parse.quote(task, safe="")}/timeline', headers={'Authorization': f'Bearer {token}'})
        with urllib.request.urlopen(req, timeout=15) as r:
            items = json.load(r).get('items')
    except (urllib.error.URLError, OSError, ValueError, AttributeError) as e:
        fail(f'a(z) {task} idovonala nem olvashato: {e}', 3)
    if not isinstance(items, list):
        fail(f'a(z) {task} idovonala nem listat adott', 3)

    got = latest_verdict(items, repo, pr)
    pr_fej = f'a PR fej:      {head}'
    if got is None:
        print(f'nincs verdict: a(z) {task} idovonalan barracuda nem itelt a {repo}#{pr}-rol')
        print(pr_fej)
        return 1
    word, vhead, ref = got
    print(f'a verdict:     {ref}')
    print(f'a verdict fej: {vhead or "(nincs)"}')
    print(pr_fej)
    if word != 'APPROVE':
        print(f'a legutolso verdict {word}: a fej nincs jovahagyva')
        return 1
    if len(vhead) != 40:
        print('a verdict feje nem 40 jegyu: nem nevez meg egy commitot, a PR fejevel nem vetheto ossze')
        return 1
    if vhead != head:
        print('a verdict MASIK fejre szol: a PR feje azota valtozott, vagy a verdict regi korre szol')
        return 1
    print('rendben: a legutolso verdict APPROVE, es a PR mostani fejere szol')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
