#!/usr/bin/env python3
"""review-kapu, the Discord-free gate (scripts/root/review-kapu.py; task discord-mentes-hosti-gombok, plan v4).

WHAT TURNS THIS RED:
  a fact that is missing, unreadable or false and still gives `dont` (every K below has its own break: K1 not on the branch, K2 no
  merged PR / two PRs / a fork, K9 a workflow or CI path in the PR (also by rename, also on page 2), K3 an APPROVE for another head, an
  older APPROVE under a later CHANGES, another approver or PR, a corrupt record, a dismissed or other user's review, K5 a missing,
  running, failed or only-older-green run, K4 a differing blob, tree or fenced block, a missing path, K10 the requester is the approver);
  an error of any kind (transport, 301, 403, 404, a budget, a bug in the gate) that reads as a pass;
  a redirect followed; the answer for a complete, true request not being `dont` (the positive control).

THE GITHUB IN THIS TEST IS A FAKE built from the shapes measured on 2026-10-19 (acroveliq, no token): compare (`ahead`, behind_by 0),
commits/{sha}/pulls, check-runs (job names), reviews, git/trees/{ref}:{path} (200 for a directory, 422 for a file, 404 absent) and
contents. NOT MEASURED against the real server under load; the first real run is the measurement.
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import base64
import http.server
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('review_kapu', os.path.join(SCRIPTS, 'root', 'review-kapu.py'))
rk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rk)

FAILS = []


def check(name, got, want):
    if got != want:
        FAILS.append(name)
        print('FAIL %s\n  got:  %r\n  want: %r' % (name, got, want))
    else:
        print('ok   %s' % name)


REPO = 'KratoBal/acroveliq'
C = 'c' * 40            # the commit on main (the squash)
H = 'a1' * 20           # the PR's head, the reviewed one
PR = 265
FILE = 'scripts/root/fleet-pane.py'
DIR = 'level-kozvetito'
DOC = 'docs/fleet-gate.md'
MARK = 'fleet-ro-grant'
BLOCK = 'ExternalBillingDocument documentNumber,source,cancelled tartos B8\n'


def doc(block=BLOCK, extra=''):
    return 'x\n```%s\n%s```\n%s' % (MARK, block, extra)


def b64(s):
    return base64.b64encode(s.encode()).decode()


class World:
    """A fake GitHub: exact routes (path after /repos/<repo>/), anything else 404. Counts the calls."""

    def __init__(self):
        self.calls = []
        self.routes = {}
        self.set('compare/%s...main' % C, 200, {'status': 'ahead', 'behind_by': 0, 'ahead_by': 1})
        self.set('commits/%s/pulls' % C, 200, [self.pr()])
        self.set('pulls/%d/files?per_page=100&page=1' % PR, 200, [{'filename': 'docs/fleet-pane.md'}, {'filename': FILE}])
        self.set('pulls/%d/reviews?per_page=100&page=1' % PR, 200, [self.review('APPROVED', H)])
        self.set('commits/%s/check-runs?per_page=100&page=1' % C, 200, {'check_runs': [self.run('test', 11), self.run('scan', 12)]})
        for ref in (C, H):
            self.tree(ref, DIR, 'd1' * 20)
            self.file(ref, FILE, 'f1' * 20)
            self.file(ref, DOC, 'e1' * 20, text=doc())

    def set(self, path, status, body):
        self.routes[path] = (status, body)

    @staticmethod
    def pr(**kw):
        d = {'number': PR, 'merged_at': '2026-10-19T19:00:00Z', 'merge_commit_sha': C, 'base': {'ref': 'main'},
             'head': {'sha': H, 'repo': {'full_name': REPO}}}
        d.update(kw)
        return d

    @staticmethod
    def review(state, commit, login='flotta-bot-acro'):
        return {'user': {'login': login}, 'state': state, 'commit_id': commit}

    @staticmethod
    def run(name, id_, status='completed', conclusion='success'):
        return {'name': name, 'id': id_, 'status': status, 'conclusion': conclusion}

    def tree(self, ref, path, sha):
        self.set('git/trees/%s:%s' % (ref, path), 200, {'sha': sha, 'tree': []})

    def file(self, ref, path, sha, text=None):
        self.set('git/trees/%s:%s' % (ref, path), 422, {'message': 'Invalid object requested.'})
        body = {'type': 'file', 'sha': sha, 'encoding': 'base64', 'content': b64(text if text is not None else 'x')}
        self.set('contents/%s?ref=%s' % (path, ref), 200, body)

    def fetch(self, url):
        prefix = '%s/repos/%s/' % (rk.GITHUB_API, REPO)
        assert url.startswith(prefix), url
        path = url[len(prefix):]
        self.calls.append(path)
        return self.routes.get(path, (404, None))


def gate(world=None, record=None, **cfg):
    w = world or World()
    base = {'repok': [REPO], 'branch': 'main', 'checks': ['test', 'scan'], 'jovahagyo': 'barracuda', 'forras': 'github',
            'gepi_login': 'flotta-bot-acro', 'ci_utak': ['scripts/ci']}
    base.update(cfg)
    if record is not None:
        base.update(forras='rekord', rekord_fajl=record)
    return w, rk.ReviewKapu(base, fetch=w.fetch)


RULE = {'utak': [FILE, DIR], 'blokk': {'ut': DOC, 'jelolo': MARK}}


def run(w=None, record=None, kero='murena', rule=RULE, repo=REPO, commit=C, **cfg):
    w, g = gate(w, record, **cfg)
    return w, g.donto(repo, commit, kero, rule)


def verdict(**kw):
    w, d = run(**kw)
    return d['dontes'], d['ok']


TMP = tempfile.mkdtemp(prefix='review-kapu-teszt-')


def record_file(lines):
    path = os.path.join(TMP, 'verdicts-%d.jsonl' % len(os.listdir(TMP)))
    with open(path, 'w') as f:
        f.write('\n'.join(l if isinstance(l, str) else json.dumps(l) for l in lines) + '\n')
    return path


def rec(verdict_, head=H, actor='barracuda', repo='acroveliq', pr=PR, task='t1'):
    return {'ts': 'x', 'actor': actor, 'owner': 'KratoBal', 'repo': repo, 'pr': pr, 'task': task, 'verdict': verdict_, 'head': head}


# --- POSITIVE CONTROL ------------------------------------------------------------------------------
w, d = run()
check('P a complete, true request: dont, every fact named', (d['dontes'], d['ok'], sorted(d['tenyek'])), ('dont', 'minden-teny-igaz', ['bajt', 'ci', 'fej', 'itelet', 'k1', 'pr']))
check('P the facts carry the PR, the head, the source of the verdict and the CI names',
      (d['tenyek']['pr'], d['tenyek']['fej'], d['tenyek']['itelet'], d['tenyek']['ci']), (PR, H, 'github', {'test': 'success', 'scan': 'success'}))
check('P the same request on the record source: dont', verdict(record=record_file([rec('APPROVE')])), ('dont', 'minden-teny-igaz'))
check('P a decision stays within its budget', w.calls.__len__() <= 40, True)

# --- inputs and K10 --------------------------------------------------------------------------------
w, d = run(kero='barracuda')
check('K10 the requester is the approver: elutasit, no request at all', (d['dontes'], d['ok'], w.calls), ('elutasit', 'a-kero-a-jovahagyo', []))
check('K10 an empty requester: elutasit', verdict(kero='')[0], 'elutasit')
check('input a repository outside the list: elutasit', verdict(repo='KratoBal/mas')[0:2], ('elutasit', 'nem-flotta-repo'))
check('input a short commit: elutasit', verdict(commit='c3689042'), ('elutasit', 'rossz-commit'))
w, d = run(jovahagyo='')
check('input a missing approver setting: elutasit before any request', (d['dontes'], d['ok'], w.calls), ('elutasit', 'rossz-beallitas', []))

# --- K1 ---------------------------------------------------------------------------------------------
for name, status, body, want in (
    ('behind_by 2', 200, {'status': 'diverged', 'behind_by': 2, 'ahead_by': 1}, 'nincs-a-fagon'),
    ('status diverged with behind_by 0', 200, {'status': 'diverged', 'behind_by': 0}, 'nincs-a-fagon'),
    ('a 404', 404, None, 'github-nem-olvashato:compare:404'),
    ('a 301 (renamed repository)', 301, None, 'github-nem-olvashato:compare:301'),
    ('a 403', 403, {'message': 'rate limit'}, 'github-nem-olvashato:compare:403'),
    ('a transport error (status 0)', 0, None, 'github-nem-olvashato:compare:0'),
    ('a body of the wrong shape', 200, ['x'], 'nincs-a-fagon'),
):
    w = World()
    w.set('compare/%s...main' % C, status, body)
    check('K1 %s: elutasit' % name, verdict(w=w), ('elutasit', want))
w = World()
w.set('compare/%s...main' % C, 200, {'status': 'identical', 'behind_by': 0})
check('K1 identical (the commit IS the head): dont', verdict(w=w)[0], 'dont')

# --- K2 ---------------------------------------------------------------------------------------------
for name, body, want in (
    ('no PR at all (a direct push)', [], ('ember', 'nem-pr-beolvasztas')),
    ('the PR is not merged', [World.pr(merged_at=None)], ('ember', 'nem-pr-beolvasztas')),
    ('the merge commit is another', [World.pr(merge_commit_sha='b' * 40)], ('ember', 'nem-pr-beolvasztas')),
    ('the base is not main', [World.pr(base={'ref': 'develop'})], ('ember', 'nem-pr-beolvasztas')),
    ('two merged PRs for the commit', [World.pr(), World.pr(number=266)], ('elutasit', 'tobb-pr')),
    ('a fork PR', [World.pr(head={'sha': H, 'repo': {'full_name': 'someone/acroveliq'}})], ('ember', 'fork-pr')),
    ('a PR whose head repo is gone (null)', [World.pr(head={'sha': H, 'repo': None})], ('ember', 'fork-pr')),
    ('a head that is not 40 hex', [World.pr(head={'sha': 'abc', 'repo': {'full_name': REPO}})], ('elutasit', 'github-forma:pr')),
    ('a body that is not a list', {'message': 'x'}, ('elutasit', 'github-forma:pulls')),
):
    w = World()
    w.set('commits/%s/pulls' % C, 200, body)
    check('K2 %s' % name, verdict(w=w), want)
w = World()
w.set('commits/%s/pulls' % C, 200, [World.pr(number=7, merged_at=None), World.pr()])
check('K2 an unmerged PR next to the merged one does not count: dont', verdict(w=w)[0], 'dont')
w = World()
w.set('commits/%s/pulls' % C, 422, {'message': 'No commit found'})
check('K2 an unknown commit (422): elutasit', verdict(w=w), ('elutasit', 'github-nem-olvashato:pulls:422'))

# --- K9 ---------------------------------------------------------------------------------------------
for name, files, want in (
    ('a workflow file', [{'filename': '.github/workflows/test.yml'}], ('ember', 'ci-utvonal:.github/workflows/test.yml')),
    ('a workflow moved OUT by a rename', [{'filename': 'docs/x.yml', 'previous_filename': '.github/workflows/test.yml'}], ('ember', 'ci-utvonal:.github/workflows/test.yml')),
    ('a configured CI path (a directory)', [{'filename': 'scripts/ci/run.sh'}], ('ember', 'ci-utvonal:scripts/ci/run.sh')),
    ('a configured CI path (the directory name itself)', [{'filename': 'scripts/ci'}], ('ember', 'ci-utvonal:scripts/ci')),
):
    w = World()
    w.set('pulls/%d/files?per_page=100&page=1' % PR, 200, files)
    check('K9 %s: ember' % name, verdict(w=w), want)
w = World()
w.set('pulls/%d/files?per_page=100&page=1' % PR, 200, [{'filename': 'scripts/cinema.py'}, {'filename': '.github/workflows-notes.md'}])
check('K9 a name that only STARTS like a CI path is not one: dont', verdict(w=w)[0], 'dont')
w = World()
w.set('pulls/%d/files?per_page=100&page=1' % PR, 200, [{'filename': 'a/%d' % i} for i in range(100)])
w.set('pulls/%d/files?per_page=100&page=2' % PR, 200, [{'filename': '.github/workflows/x.yml'}])
check('K9 a workflow on the SECOND page is found', verdict(w=w), ('ember', 'ci-utvonal:.github/workflows/x.yml'))
w = World()
for page in range(1, 11):
    w.set('pulls/%d/files?per_page=100&page=%d' % (PR, page), 200, [{'filename': 'a/%d-%d' % (page, i)} for i in range(100)])
check('K9 more than 1000 files: elutasit (the list cannot be complete)', verdict(w=w), ('elutasit', 'tul-sok:files'))
w = World()
w.set('pulls/%d/files?per_page=100&page=1' % PR, 404, None)
check('K9 the file list unreadable: elutasit', verdict(w=w)[0], 'elutasit')

# --- K3, the record source -------------------------------------------------------------------------
def rv(lines, **kw):
    return verdict(record=record_file(lines), **kw)


check('K3r no verdict line for the PR: elutasit', rv([rec('APPROVE', pr=1)]), ('elutasit', 'nincs-itelet'))
check('K3r the latest verdict is CHANGES: elutasit', rv([rec('APPROVE'), rec('CHANGES')]), ('elutasit', 'az-utolso-itelet-nem-approve'))
check('K3r an APPROVE AFTER a CHANGES is the latest: dont', rv([rec('CHANGES'), rec('APPROVE')])[0], 'dont')
check('K3r the CHANGES under ANOTHER task of the same PR still counts', rv([rec('APPROVE', task='a'), rec('CHANGES', task='b')]), ('elutasit', 'az-utolso-itelet-nem-approve'))
check('K3r an APPROVE on another head: elutasit', rv([rec('APPROVE', head='9' * 40)]), ('elutasit', 'az-itelet-mas-fejre-szol'))
check('K3r the approve is by another actor: elutasit', rv([rec('APPROVE', actor='murena')]), ('elutasit', 'nincs-itelet'))
check('K3r the approve is for another repository: elutasit', rv([rec('APPROVE', repo='acropora-os')]), ('elutasit', 'nincs-itelet'))
check('K3r a head that is not 40 hex is ignored: elutasit', rv([rec('APPROVE', head='a1b2c3d')]), ('elutasit', 'nincs-itelet'))
check('K3r a corrupt line: elutasit, never skipped', rv([rec('APPROVE'), '{nem json']), ('elutasit', 'rekord-serult:2'))
check('K3r a line that is not an object: elutasit', rv(['[1,2]']), ('elutasit', 'rekord-serult:1'))
check('K3r an unreadable record file: elutasit', verdict(record='/nincs/ilyen/fajl'), ('elutasit', 'rekord-nem-olvashato'))
check('K3r the PR number must be the same type (a string is not it)', rv([rec('APPROVE', pr=str(PR))]), ('elutasit', 'nincs-itelet'))

# --- K3, the GitHub-review source ------------------------------------------------------------------
def gv(reviews):
    w = World()
    w.set('pulls/%d/reviews?per_page=100&page=1' % PR, 200, reviews)
    return verdict(w=w)


R = World.review
check('K3g no review at all (measured on #265: the list is empty today): elutasit', gv([]), ('elutasit', 'nincs-itelet'))
check('K3g an APPROVED by another user: elutasit', gv([R('APPROVED', H, login='valaki')]), ('elutasit', 'nincs-itelet'))
check('K3g the machine account APPROVED on an older commit: elutasit', gv([R('APPROVED', '9' * 40)]), ('elutasit', 'az-itelet-mas-fejre-szol'))
check('K3g APPROVED then DISMISSED: elutasit', gv([R('APPROVED', H), R('DISMISSED', H)]), ('elutasit', 'az-utolso-itelet-nem-approve'))
check('K3g APPROVED then CHANGES_REQUESTED: elutasit', gv([R('APPROVED', H), R('CHANGES_REQUESTED', H)]), ('elutasit', 'az-utolso-itelet-nem-approve'))
check('K3g CHANGES_REQUESTED then APPROVED: dont', gv([R('CHANGES_REQUESTED', H), R('APPROVED', H)])[0], 'dont')
check('K3g a later COMMENTED does not take the approval away: dont', gv([R('APPROVED', H), R('COMMENTED', H)])[0], 'dont')
check('K3g a malformed review entry is skipped, the valid one decides', gv(['x', R('APPROVED', H)])[0], 'dont')
w = World()
w.set('pulls/%d/reviews?per_page=100&page=1' % PR, 403, {'message': 'x'})
check('K3g the review list unreadable: elutasit', verdict(w=w)[0], 'elutasit')
check('K3 an unknown source setting: elutasit', verdict(forras='discord'), ('elutasit', 'rossz-beallitas'))

# --- K5 ---------------------------------------------------------------------------------------------
def cv(runs, **kw):
    w = World()
    w.set('commits/%s/check-runs?per_page=100&page=1' % C, 200, {'check_runs': runs})
    return verdict(w=w, **kw)


Rn = World.run
check('K5 a configured name has no run: elutasit', cv([Rn('test', 1)]), ('elutasit', 'ci-hianyzik:scan'))
check('K5 a run still going: elutasit, named as in progress', cv([Rn('test', 1), Rn('scan', 2, status='in_progress', conclusion=None)]), ('elutasit', 'ci-folyamatban:scan'))
check('K5 a failed run: elutasit', cv([Rn('test', 1), Rn('scan', 2, conclusion='failure')]), ('elutasit', 'ci-bukott:scan'))
check('K5 skipped or cancelled is not success: elutasit', cv([Rn('test', 1, conclusion='skipped'), Rn('scan', 2)]), ('elutasit', 'ci-bukott:test'))
check('K5 an older failure under a NEWER success (a re-run): dont', cv([Rn('test', 1, conclusion='failure'), Rn('test', 5), Rn('scan', 2)])[0], 'dont')
check('K5 an older success under a NEWER failure: elutasit', cv([Rn('test', 7, conclusion='failure'), Rn('test', 5), Rn('scan', 2)]), ('elutasit', 'ci-bukott:test'))
check('K5 a name that only contains the configured one does not count', cv([Rn('test-extra', 1), Rn('scan', 2)]), ('elutasit', 'ci-hianyzik:test'))
check('K5 no configured names: elutasit', verdict(checks=[]), ('elutasit', 'rossz-beallitas'))
check('K5 a bad name in the setting: elutasit', verdict(checks=['te;st']), ('elutasit', 'rossz-beallitas'))
check('K5 a body of the wrong shape: elutasit', cv('x')[0], 'elutasit')
w = World()
w.set('commits/%s/check-runs?per_page=100&page=1' % C, 404, None)
check('K5 the check runs unreadable: elutasit', verdict(w=w)[0], 'elutasit')

# --- K4 ---------------------------------------------------------------------------------------------
w = World()
w.file(H, FILE, '0f' * 20)
check('K4 a blob that differs between the commit and the head: elutasit', verdict(w=w), ('elutasit', 'bajt-elter:' + FILE))
w = World()
w.tree(H, DIR, '0d' * 20)
check('K4 a directory whose tree differs: elutasit', verdict(w=w), ('elutasit', 'bajt-elter:' + DIR))
w = World()
w.set('git/trees/%s:%s' % (H, DIR), 404, None)
check('K4 a path missing at the head: elutasit', verdict(w=w), ('elutasit', 'bajt-hianyzik:' + DIR))
w = World()
w.set('git/trees/%s:%s' % (C, DIR), 404, None)
check('K4 a path missing at the commit: elutasit', verdict(w=w), ('elutasit', 'bajt-hianyzik:' + DIR))
w = World()
w.set('contents/%s?ref=%s' % (FILE, C), 404, None)
check('K4 a file whose contents answer 404 after the tree said 422: elutasit', verdict(w=w), ('elutasit', 'bajt-hianyzik:' + FILE))
w = World()
w.file(H, DOC, 'e1' * 20, text=doc(block=BLOCK + 'Customer displayName,companyName,email 2026-11-17 uj\n'))
check('K4 a fenced block that differs: elutasit', verdict(w=w), ('elutasit', 'bajt-elter:' + DOC))
w = World()
w.file(H, DOC, 'e1' * 20, text=doc(extra='```%s\nmas\n```\n' % MARK))
check('K4 two blocks at the head: elutasit', verdict(w=w), ('elutasit', 'blokk-hianyzik:' + DOC))
w = World()
w.file(C, DOC, 'e1' * 20, text='nincs blokk')
check('K4 no block at the commit: elutasit', verdict(w=w), ('elutasit', 'blokk-hianyzik:' + DOC))
check('K4 neither paths nor a block to compare: elutasit', verdict(rule={}), ('elutasit', 'nincs-mit-osszevetni'))
check('K4 a rule that is not an object: elutasit', verdict(rule=None), ('elutasit', 'nincs-mit-osszevetni'))
for bad in ('../etc/passwd', '/abs', 'a b', 'a//b', ''):
    check('K4 a bad path %r: elutasit' % bad, verdict(rule={'utak': [bad]})[0], 'elutasit')
w = World()
w.file(C, DOC, 'e1' * 20, text='\xe9\xff')
w.routes['contents/%s?ref=%s' % (DOC, C)] = (200, {'type': 'file', 'sha': 'x', 'encoding': 'base64', 'content': base64.b64encode(b'\xff\xfe').decode()})
check('K4 a block file that is not UTF-8: elutasit', verdict(w=w), ('elutasit', 'github-forma:szoveg'))
check('K4 only a block rule (no paths): dont', verdict(rule={'blokk': {'ut': DOC, 'jelolo': MARK}})[0], 'dont')
check('K4 only paths (no block): dont', verdict(rule={'utak': [FILE]})[0], 'dont')

# --- order, budget, errors -------------------------------------------------------------------------
w = World()
w.set('compare/%s...main' % C, 404, None)
w.set('commits/%s/check-runs?per_page=100&page=1' % C, 404, None)
check('order K1 fails first even when K5 would fail too (and nothing later is asked)', (verdict(w=w)[1], len(w.calls)), ('github-nem-olvashato:compare:404', 1))
w, g = gate(max_hivas=3)
d = g.donto(REPO, C, 'murena', RULE)
check('budget a budget of 3 calls: elutasit keret, no call beyond it', (d['dontes'], d['ok'], len(w.calls)), ('elutasit', 'keret', 3))


class Boom(World):
    def fetch(self, url):
        raise RuntimeError('boom')


w = Boom()
check('error a bug inside a fetch never reads as a pass', verdict(w=w), ('elutasit', 'hiba:RuntimeError'))
w = World()
check('no side effect: a refusal does not touch anything (the same fake answers the same again)', (verdict(w=w), verdict(w=w)), ((('dont', 'minden-teny-igaz')), ('dont', 'minden-teny-igaz')))

# --- helpers ---------------------------------------------------------------------------------------
check('K8 helper: a pause marker (also a dangling symlink) is seen, a missing one is not',
      (rk.szunet_van(TMP, 'proba'), (open(os.path.join(TMP, 'szunet-proba'), 'w').close(), rk.szunet_van(TMP, 'proba'))[1],
       (os.symlink('/nincs', os.path.join(TMP, 'szunet-lanc')), rk.szunet_van(TMP, 'lanc'))[1]), (False, True, True))
check('block one block', rk.extract_block('a\n```x\nb\n```\n', 'x'), 'b\n')
check('block no block', rk.extract_block('a\n```y\nb\n```\n', 'x'), None)
check('block two blocks', rk.extract_block('```x\n1\n```\n```x\n2\n```\n', 'x'), None)
check('block a marker that only starts like it is not it', rk.extract_block('```xy\nb\n```\n', 'x'), None)

# --- the real fetch: no redirect, no credentials ---------------------------------------------------
hits = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        hits.append((self.path, self.headers.get('Authorization')))
        if self.path == '/moved':
            self.send_response(301)
            self.send_header('Location', '/target')
            self.end_headers()
        elif self.path == '/json':
            body = b'{"a": 1}'
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == '/bad':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'not json')
        else:
            self.send_response(404)
            self.end_headers()


srv = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = 'http://127.0.0.1:%d' % srv.server_address[1]
check('real_fetch a 301 is returned, NOT followed (the target is never asked)', (rk.real_fetch(base + '/moved')[0], [h[0] for h in hits]), (301, ['/moved']))
check('real_fetch a JSON answer is parsed', rk.real_fetch(base + '/json'), (200, {'a': 1}))
check('real_fetch a body that is not JSON is a status 200 with no data... treated as a transport fault', rk.real_fetch(base + '/bad')[0], 0)
check('real_fetch a 404 is a status', rk.real_fetch(base + '/x')[0], 404)
check('real_fetch no credentials are sent', {h[1] for h in hits}, {None})
srv.shutdown()
check('real_fetch a closed port is status 0', rk.real_fetch(base + '/json')[0], 0)

shutil.rmtree(TMP, True)
print('\n%d FAIL' % len(FAILS) if FAILS else '\nall pass')
sys.exit(1 if FAILS else 0)
