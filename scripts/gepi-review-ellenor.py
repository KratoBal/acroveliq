#!/usr/bin/env python3
# ANSWERS: Van-e a jovahagyott fejen GitHub-review a flotta PR-jan, mielott a beolvaszto olvaszt?
#
# gepi-review-ellenor.py --repo <owner/name> --pr <N> --head <40 jegyu sha>
#
# b25-gepi-review. A review-ellenoriz.sh APPROVE eseten a root rekord UTAN meghivja a
# `fleet-approve approve`-ot, ami a gepi fiokkal egy GitHub-reviewt tesz a PR-re, a fejhez
# kotve (commit_id). A ruleset "Required approvals" szama ezt a reviewt szamolja, tehat a
# beolvaszto azt nezi, amit a GitHub: van-e ezen A FEJEN egy APPROVED review, es nem all-e
# mellette egy CHANGES_REQUESTED. A pr-beolvaszt.sh hivja, a beolvaszto PUT elott.
#
# Egy review annyit er, amennyi a SAJAT ALLAPOTA: egy felhasznalo LEGUTOBBI dontő reviewje
# szamit (APPROVED, CHANGES_REQUESTED vagy DISMISSED; a COMMENTED nem valtoztat semmit, ahogy a
# GitHubon sem). Egy APPROVED egy REGI fejen nem fedi a mait: a push utan a review nem szol az
# uj kodrol, ezt kulon kimondja.
#
# Hatokor: CSAK a flotta repoi (FLOTTA_REPOK, egyezzen a fleet-approve konfigjanak `repos`
# listajaval). A tobbi repora nincs gepi review, ott a kapu nem vonatkozik: 0, kimondva.
#
# Kilepes: 0 van review a fejen (vagy a repo nem flotta repo), 1 NINCS (az okkal), 3 nem
# tudtam megkerdezni (a GitHub nem valaszolt, a kulcs nem olvashato): ez NEM "nincs review".
#
# A GitHub API cime tesztekhez atallithato (GITHUB_API_URL), de csak api.github.com vagy helyi
# cim lehet: a kulcs maskulonben egy idegen gepre menne. Az explicit GITHUB_TOKEN_FILE (a
# tesztek) elsobbseget elvez; maskulonben lib/github_token.py az `olvas` szereppel.
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

FLOTTA_REPOK = ('KratoBal/acroveliq', 'KratoBal/marveen')
REPO_RE = re.compile(r'^(?!.*\.\.)[\w.-]+/[\w.-]+$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
PER_PAGE = 100
MAX_PAGES = 10
DECIDING = ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED')


def say(code, msg):
    print(msg)
    sys.exit(code)


def parse(argv):
    a = {}
    i = 0
    while i < len(argv):
        k = argv[i]
        if k not in ('--repo', '--pr', '--head') or i + 1 >= len(argv):
            say(2, f'ismeretlen vagy ertek nelkuli kapcsolo: {k}')
        a[k[2:]] = argv[i + 1]
        i += 2
    for need in ('repo', 'pr', 'head'):
        if need not in a:
            say(2, f'hianyzik: --{need}')
    if not REPO_RE.match(a['repo']):
        say(2, f'a --repo nem owner/name: {a["repo"]}')
    if not a['pr'].isdigit() or int(a['pr']) <= 0:
        say(2, f'a --pr nem szam: {a["pr"]}')
    if not SHA_RE.match(a['head']):
        say(2, f'a --head nem 40 jegyu sha: {a["head"]}')
    return a


def api_base():
    base = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
    host = urllib.parse.urlsplit(base).hostname or ''
    if base != 'https://api.github.com' and host not in ('127.0.0.1', 'localhost'):
        say(2, f'a GITHUB_API_URL csak api.github.com vagy helyi cim lehet, ez all benne: {base}')
    return base


def token(repo):
    tok_file = os.environ.get('GITHUB_TOKEN_FILE')
    if tok_file:
        try:
            return open(tok_file, encoding='utf-8').read().strip()
        except OSError:
            say(3, 'NEM TUDOM MEGKERDEZNI: a GitHub kulcs nem olvashato')
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))
    from github_token import GithubTokenError, github_token
    try:
        return github_token(repo, 'olvas')
    except GithubTokenError as e:
        say(3, f'NEM TUDOM MEGKERDEZNI: a GitHub kulcs nem olvashato: {e}')


def reviews(repo, pr, tok):
    """Every review of the PR, in GitHub's order (oldest first); exit 3 when GitHub does not answer."""
    out = []
    for page in range(1, MAX_PAGES + 1):
        url = f'{api_base()}/repos/{repo}/pulls/{pr}/reviews?per_page={PER_PAGE}&page={page}'
        req = urllib.request.Request(url, headers={
            'Authorization': f'Bearer {tok}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.load(r)
        except urllib.error.HTTPError as e:
            say(3, f'NEM TUDOM MEGKERDEZNI: a GitHub reviews {e.code}-et adott')
        except (urllib.error.URLError, OSError, ValueError) as e:
            say(3, f'NEM TUDOM MEGKERDEZNI: a GitHub reviews nem valaszolt ({type(e).__name__})')
        if not isinstance(body, list):
            say(3, 'NEM TUDOM MEGKERDEZNI: a GitHub reviews valasza nem lista')
        out += [r for r in body if isinstance(r, dict)]
        if len(body) < PER_PAGE:
            return out
    say(3, f'NEM TUDOM MEGKERDEZNI: a PR-nek tobb mint {PER_PAGE * MAX_PAGES} reviewja van')


def judge(rows, head):
    """(ok, text). The latest deciding review of each user counts."""
    latest = {}
    for r in rows:
        state = r.get('state')
        if state not in DECIDING:
            continue
        user = (r.get('user') or {}).get('login') or '?'
        latest[user] = (state, r.get('commit_id') or '')
    approved_here = sorted(u for u, (s, c) in latest.items() if s == 'APPROVED' and c == head)
    changes = sorted(u for u, (s, _c) in latest.items() if s == 'CHANGES_REQUESTED')
    approved_old = sorted((u, c) for u, (s, c) in latest.items() if s == 'APPROVED' and c != head)
    if changes:
        return False, 'NINCS GEPI REVIEW A FEJEN: valaki CHANGES_REQUESTED allapotban van: ' + ', '.join(changes)
    if approved_here:
        return True, 'gepi review rendben: APPROVED a ' + head[:12] + ' fejen (' + ', '.join(approved_here) + ')'
    if approved_old:
        u, c = approved_old[0]
        return False, (f'NINCS GEPI REVIEW A FEJEN: {u} APPROVED reviewja a(z) {c[:12]} fejre szol, a PR feje {head[:12]}: '
                       'a push utan a review nem fedi az uj kodot')
    return False, 'NINCS GEPI REVIEW A FEJEN: a PR-on nincs APPROVED review'


def main(argv):
    a = parse(argv)
    if a['repo'] not in FLOTTA_REPOK:
        say(0, f'gepi review: a(z) {a["repo"]} nem flotta repo, ott nincs gepi review, a kapu nem vonatkozik ra')
    rows = reviews(a['repo'], a['pr'], token(a['repo']))
    ok, text = judge(rows, a['head'])
    say(0 if ok else 1, text)


if __name__ == '__main__':
    main(sys.argv[1:])
