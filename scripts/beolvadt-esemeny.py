#!/usr/bin/env python3
# ANSWERS: Hogyan kerul a beolvasztas a feladat idovonalara ugy, hogy a done-or el is higgye?
#
# beolvadt-esemeny.py --task <id> --repo <owner/name> --pr <N> --head <sha> --base <ag>
#                     --put-code <HTTP> [--put-body-file <fajl>] [--szereplo <agens>] [--nez]
#
# TC-Lite L4. A pr-beolvaszt.sh hivja a beolvaszto PUT UTAN, a valasszal egyutt. Egy
# `merged` esemenyt ir a feladatra, data-val: {repo, pr, head_sha, merge_sha}, de CSAK ha
#   1. a PUT 200-at adott, es a valaszban 40 jegyu `sha` all (a beolvasztas commitja),
#   2. a GitHub szerint ez a commit a cel-agon van (compare <merge_sha>...<ag>: identical
#      vagy ahead, es a feloldott bazis betura a merge_sha).
# Minden mas esetben (nem-200, hianyzo sha, nincs az agon, a GitHub nem valaszol) NEM ir
# semmit, es kimondja, miert. A done-or (task-usage.ts doneGuard) ugyanezt a ket dolgot
# meri ujra; itt azert merjuk elore, hogy hamis sor ne is keletkezzen.
#
# --nez: kiirja a megirando esemenyt (parancs es data), de nem kuldi.
#
# A GitHub API cime tesztekhez atallithato (GITHUB_API_URL), de csak api.github.com vagy
# helyi cim lehet: a kulcs maskulonben egy idegen gepre menne.
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

TASK_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
REPO_RE = re.compile(r'^(?!.*\.\.)[\w.-]+/[\w.-]+$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
BRANCH_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$')
AGENT_RE = re.compile(r'^[a-z][a-z0-9_-]{0,63}$')
HERE = os.path.dirname(os.path.abspath(__file__))


def fail(msg, code=1):
    print(f'NEM IROK ESEMENYT: {msg}')
    sys.exit(code)


def parse(argv):
    a = {'nez': False, 'szereplo': 'acrobot', 'put_body_file': None}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k == '--nez':
            a['nez'] = True
            i += 1
            continue
        if k not in ('--task', '--repo', '--pr', '--head', '--base', '--put-code', '--put-body-file', '--szereplo') or i + 1 >= len(argv):
            fail(f'ismeretlen vagy ertek nelkuli kapcsolo: {k}', 2)
        a[k[2:].replace('-', '_')] = argv[i + 1]
        i += 2
    for need in ('task', 'repo', 'pr', 'head', 'base', 'put_code'):
        if need not in a:
            fail(f'hianyzik: --{need.replace("_", "-")}', 2)
    if not TASK_RE.match(a['task']):
        fail(f'a --task nem feladat-azonosito: {a["task"]}', 2)
    if not REPO_RE.match(a['repo']):
        fail(f'a --repo nem owner/name: {a["repo"]}', 2)
    if not a['pr'].isdigit() or int(a['pr']) <= 0:
        fail(f'a --pr nem szam: {a["pr"]}', 2)
    if not SHA_RE.match(a['head']):
        fail(f'a --head nem 40 jegyu sha: {a["head"]}', 2)
    if not BRANCH_RE.match(a['base']):
        fail(f'a --base nem agnev: {a["base"]}', 2)
    if not AGENT_RE.match(a['szereplo']):
        fail(f'a --szereplo nem agensnev: {a["szereplo"]}', 2)
    return a


def api_base():
    base = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
    host = urllib.parse.urlsplit(base).hostname or ''
    if base != 'https://api.github.com' and host not in ('127.0.0.1', 'localhost'):
        fail(f'a GITHUB_API_URL csak api.github.com vagy helyi cim lehet, ez all benne: {base}', 2)
    return base


def on_branch(repo, sha, branch):
    """(True, '') when sha is part of branch; (False, reason) otherwise."""
    # an explicit GITHUB_TOKEN_FILE (the tests) wins; otherwise lib/github_token.py: the owner token file
    # with FLEET_GITHUB_APP off, the broker's read token for this repository with it on
    tok_file = os.environ.get('GITHUB_TOKEN_FILE')
    try:
        if tok_file:
            tok = open(tok_file, encoding='utf-8').read().strip()
        else:
            sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
            from github_token import GithubTokenError, github_token
            try:
                tok = github_token(repo, 'olvas')
            except GithubTokenError:
                return False, 'a GitHub kulcs nem olvashato'
    except OSError:
        return False, 'a GitHub kulcs nem olvashato'
    url = f'{api_base()}/repos/{repo}/compare/{sha}...{urllib.parse.quote(branch, safe="")}'
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {tok}',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        return False, f'a GitHub compare {e.code}-et adott'
    except (urllib.error.URLError, OSError, ValueError) as e:
        return False, f'a GitHub compare nem valaszolt ({type(e).__name__})'
    status = body.get('status')
    base_sha = (body.get('base_commit') or {}).get('sha')
    if base_sha != sha:
        return False, 'a GitHub mas commitot oldott fel'
    if status not in ('identical', 'ahead'):
        return False, f'a beolvasztas commitja nincs a(z) {branch} agon (compare: {status})'
    return True, ''


def main(argv):
    a = parse(argv)
    pr = int(a['pr'])
    if a['nez']:
        data = {'repo': a['repo'], 'pr': pr, 'head_sha': a['head'], 'merge_sha': '<a beolvaszto PUT valaszabol>'}
        print('CSAK NEZEM (--nez): a beolvasztas utan ez az esemeny menne, ha a merge sha a(z) '
              f'{a["base"]} agon van:')
        print(f'   fleet-api.sh task-event {a["task"]} merged {a["szereplo"]} "" {a["repo"]}#{pr} --data - <<< {json.dumps(data)}')
        return 0
    if a['put_code'] != '200':
        fail(f'a beolvaszto PUT {a["put_code"]}-et adott, nem 200-at')
    raw = ''
    if a['put_body_file']:
        try:
            raw = open(a['put_body_file'], encoding='utf-8').read()
        except OSError:
            raw = ''
    try:
        merge_sha = json.loads(raw).get('sha')
    except (ValueError, AttributeError):
        merge_sha = None
    if not isinstance(merge_sha, str) or not SHA_RE.match(merge_sha):
        fail('a PUT valaszaban nincs 40 jegyu merge sha')
    ok, why = on_branch(a['repo'], merge_sha, a['base'])
    if not ok:
        fail(why)
    data = {'repo': a['repo'], 'pr': pr, 'head_sha': a['head'], 'merge_sha': merge_sha}
    r = subprocess.run(
        ['bash', os.path.join(HERE, 'fleet-api.sh'), 'task-event', a['task'], 'merged', a['szereplo'], '', f'{a["repo"]}#{pr}', '--data', '-'],
        input=json.dumps(data), capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f'NEM SIKERULT AZ ESEMENY: {(r.stdout + r.stderr).strip()[:300]}')
        return 1
    print(f'   feladat {a["task"]}: merged esemeny irva ({a["repo"]}#{pr}, merge {merge_sha[:12]}, a {a["base"]} agon merve)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
