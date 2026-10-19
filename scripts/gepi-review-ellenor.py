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
# EGY HELYEN AL A LISTA: scripts/gepi-review.json (a `owner` es a `repos` ugyanazzal az alakkal, mint a
# fleet-approve konfigja, az /etc/fleet-github/app.json; a `reviewers` a gepi jovahagyo fiok(ok) GitHub
# loginja). A kapu CSAK ezeknek a loginoknak az APPROVED-jet szamolja: a ruleset minden irasi jogu felhasznalo
# jovahagyasat szamolja, a kapu ertelme viszont az, hogy a fejen barracuda atnezese alljon. Egy idegen login
# APPROVED-je a fejen NEM eleg (barracuda, #258 review 2. pont). URES `reviewers` listan a kapu nem tudhatja,
# melyik APPROVED a gepi fioke: ezt kimondja, es kiirja, kik tettek APPROVED-et (az elso valos meres ebbol
# tolti ki a listat). A fleet-approve konfigja root-tulajdonu mappaban all (agens nem olvassa), ezert a
# ket lista nem azonos fajl: a `--osszevet <app.json>` mod root-tol futtatva osszeveti oket (a telepitesi lepes),
# es a tesztek a konfig repo-beli mintajat (scripts/root/fleet-github-app.example.json) vetik ossze.
#
# Hatokor: CSAK a flotta repoi (a konfig `repos` listaja); a tobbi repora nincs gepi review, ott a kapu nem
# vonatkozik: 0, kimondva.
#
# Kilepes: 0 van review a fejen (vagy a repo nem flotta repo), 1 NINCS (az okkal), 3 nem
# tudtam megkerdezni (a GitHub nem valaszolt, a kulcs vagy a lista nem olvashato): ez NEM "nincs review".
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

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, 'gepi-review.json')
REPO_RE = re.compile(r'^(?!.*\.\.)[\w.-]+/[\w.-]+$')
SHA_RE = re.compile(r'^[0-9a-f]{40}$')
PER_PAGE = 100
MAX_PAGES = 10
DECIDING = ('APPROVED', 'CHANGES_REQUESTED', 'DISMISSED')


def say(code, msg):
    print(msg)
    sys.exit(code)


def load_config(path=CONFIG):
    """(owner, [owner/repo ...], [reviewer login, lower case]) from the one list; exit 3 if it cannot be read."""
    try:
        cfg = json.load(open(path, encoding='utf-8'))
        owner = cfg['owner']
        # a string would iterate as characters: the lists must be lists of strings
        if not (isinstance(owner, str) and isinstance(cfg['repos'], list) and isinstance(cfg['reviewers'], list)
                and all(isinstance(x, str) for x in cfg['repos'] + cfg['reviewers'])):
            raise ValueError('shape')
        repos = [f'{owner}/{r}' for r in cfg['repos']]
        reviewers = [x.lower() for x in cfg['reviewers']]
        if not all(REPO_RE.match(r) for r in repos):
            raise ValueError('shape')
        return owner, repos, reviewers
    except (OSError, ValueError, KeyError, TypeError):
        say(3, f'NEM TUDOM MEGKERDEZNI: a {os.path.basename(path)} nem olvashato vagy hibas alaku')


def compare(app_json):
    """--osszevet <fleet-approve config>: do the owner and the repos agree? exit 0 or 1; the install step."""
    owner, repos, _ = load_config()
    try:
        cfg = json.load(open(app_json, encoding='utf-8'))
        theirs = sorted(f'{cfg["owner"]}/{r}' for r in cfg['repos'])
    except (OSError, ValueError, KeyError, TypeError):
        say(3, f'NEM TUDOM MEGKERDEZNI: a(z) {app_json} nem olvashato vagy hibas alaku')
    ours = sorted(repos)
    if theirs == ours:
        say(0, f'osszevetve: a fleet-approve konfigja es a gepi review lista egyezik ({len(ours)} repo)')
    say(1, 'ELTER a fleet-approve konfigjatol: csak a konfigban: ' + (', '.join(sorted(set(theirs) - set(ours))) or '-')
        + '; csak a gepi review listaban: ' + (', '.join(sorted(set(ours) - set(theirs))) or '-'))


def parse(argv):
    if len(argv) == 2 and argv[0] == '--osszevet':
        compare(argv[1])
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


def judge(rows, head, reviewers):
    """(ok, text). The latest deciding review of each user counts; only the listed reviewers' APPROVED approves."""
    latest = {}
    for r in rows:
        state = r.get('state')
        if state not in DECIDING:
            continue
        user = (r.get('user') or {}).get('login') or '?'
        latest[user] = (state, r.get('commit_id') or '')
    mine = {u: v for u, v in latest.items() if u.lower() in reviewers}
    changes = sorted(u for u, (s, _c) in latest.items() if s == 'CHANGES_REQUESTED')
    approved_here = sorted(u for u, (s, c) in mine.items() if s == 'APPROVED' and c == head)
    approved_old = sorted((u, c) for u, (s, c) in mine.items() if s == 'APPROVED' and c != head)
    strangers = sorted(u for u, (s, c) in latest.items() if u.lower() not in reviewers and s == 'APPROVED' and c == head)
    if changes:
        return False, 'NINCS GEPI REVIEW A FEJEN: valaki CHANGES_REQUESTED allapotban van: ' + ', '.join(changes)
    if approved_here:
        return True, 'gepi review rendben: APPROVED a ' + head[:12] + ' fejen (' + ', '.join(approved_here) + ')'
    if approved_old:
        u, c = approved_old[0]
        return False, (f'NINCS GEPI REVIEW A FEJEN: {u} APPROVED reviewja a(z) {c[:12]} fejre szol, a PR feje {head[:12]}: '
                       'a push utan a review nem fedi az uj kodot')
    if not reviewers:
        return False, ('NEM ELLENORIZHETO: a gepi jovahagyok listaja ures (scripts/gepi-review.json, reviewers), nem tudom, '
                       'melyik APPROVED a gepi fioke; a fejen APPROVED: ' + (', '.join(strangers) or 'senki'))
    if strangers:
        return False, ('NINCS GEPI REVIEW A FEJEN: a fejen csak nem jovahagyo login APPROVED-je all (' + ', '.join(strangers)
                       + '); a gepi jovahagyok: ' + ', '.join(reviewers))
    return False, 'NINCS GEPI REVIEW A FEJEN: a PR-on nincs a gepi jovahagyotol APPROVED review'


def main(argv):
    a = parse(argv)
    _owner, repos, reviewers = load_config()
    if a['repo'] not in repos:
        say(0, f'gepi review: a(z) {a["repo"]} nem flotta repo, ott nincs gepi review, a kapu nem vonatkozik ra')
    rows = reviews(a['repo'], a['pr'], token(a['repo']))
    ok, text = judge(rows, a['head'], reviewers)
    say(0 if ok else 1, text)


if __name__ == '__main__':
    main(sys.argv[1:])
