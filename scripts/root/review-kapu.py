#!/usr/bin/python3 -I
"""review-kapu: the Discord-free gate of the root programs (task discord-mentes-hosti-gombok, plan v4, barracuda APPROVE 33217).

One decision, from facts the gate measures itself on GitHub and in root's own record; nothing comes from the caller except the
repository, the commit and the paths to compare. The answer is one of
  dont       every fact holds: the caller may go on (its own checks, the R, the lists, come after)
  elutasit   a fact is missing, unreadable or false: NOTHING changes, the R stays open
  ember      the request is of a kind a review must not open (a CI path, a direct push, a fork): it goes to the owner's list
A fact that cannot be read is ALWAYS elutasit, never dont. A network error, a redirect, a 404, a 403, a short budget: elutasit.

THE FACTS (plan section 3):
  K10 the requester is not the approver (the requester name is not authenticated; this is the only thing it is used for)
  K1  the commit is on the branch (compare commit...branch: behind_by 0)
  K2  the commit is the result of exactly one merged PR of THIS repository into the branch; H = that PR's head
  K9  the PR changes nothing under .github/ or a configured CI path (a changed test's green is about the changed test)
  K3  the approver's LATEST verdict on that PR is APPROVE on exactly H, read from root's record (the container's programs) or from
      the machine account's GitHub review (the host's programs). It is read as UNCONDITIONAL: a condition is given with CHANGES
  K5  every configured check run is `success` on the commit (the latest run of that name FROM THE CI APP, `github-actions`: any GitHub App with
      checks:write can create a check run of any name, so a run of another app is ignored; running or missing: not yet)
  K4  the reviewed bytes are the installed bytes: every path (or the fenced block) has the same git id at the commit and at H
The order is the cheap and the decisive first; K4 last (it costs the most requests). A call budget bounds one decision.

NOT HERE (the consumer's own): K6 the single-use R, K7 the list entry that says `automatikus`, K8 the pause marker. This module has
`szunet_van` for K8 only as a helper.

Reads GitHub without a token (the fleet's repositories are public; measured 2026-10-19: commits/pulls, check-runs, reviews, trees and
compare answer 200 for acroveliq). A private repository answers 404: elutasit. No redirect is followed: a renamed repository answers 301
and that is elutasit too.
"""
import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

GITHUB_API = 'https://api.github.com'
SHA_RX = re.compile(r'^[0-9a-f]{40}$')
REPO_RX = re.compile(r'^[A-Za-z0-9._-]{1,100}/[A-Za-z0-9._-]{1,100}$')
PATH_RX = re.compile(r'^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$')


def good_path(path):
    """A repository path of plain name characters, with no `.` or `..` component (the character class alone lets `..` through)."""
    return bool(PATH_RX.match(path)) and all(part not in ('.', '..') for part in path.split('/'))


NAME_RX = re.compile(r'^[A-Za-z0-9._ -]{1,100}$')
# the WHOLE .github/ tree, not only workflows/: a workflow calls local composite actions under .github/actions/, and other files there
# shape the CI or the repository's rules (barracuda 33245, who asked for the same on the executor, BUILTIN_CI_PATH = ^\.github\/)
CI_ROOT = '.github/'
CI_APP = 'github-actions'
MAX_PAGES = 10
DEFAULT_BUDGET = 40


class Elutasit(Exception):
    pass


class Ember(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def real_fetch(url):
    """(status, parsed JSON or None). No redirect, no credentials. A transport error is a status 0."""
    req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                                               'User-Agent': 'review-kapu'})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or 'null')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or 'null')
        except ValueError:
            return e.code, None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return 0, None


def szunet_van(state_dir, key):
    """K8 helper: the pause marker `<state_dir>/szunet-<key>` exists (any file type: a symlink counts)."""
    return os.path.lexists(os.path.join(state_dir, 'szunet-' + key))


def extract_block(text, marker):
    """The body of the ONE fenced block ```<marker> ... ``` in `text`, or None when there is none or more than one."""
    found = re.findall(r'^```%s[ \t]*\n(.*?)^```[ \t]*$' % re.escape(marker), text, re.S | re.M)
    return found[0] if len(found) == 1 else None


class ReviewKapu:
    def __init__(self, cfg, fetch=None):
        self.cfg = cfg
        self.fetch = fetch or real_fetch
        self.budget = int(cfg.get('max_hivas', DEFAULT_BUDGET))
        self.calls = 0
        self.tenyek = {}

    # --- GitHub -----------------------------------------------------------------------------------
    def get(self, repo, path, what, ok=(200,), soft=()):
        """(status, body). `soft` statuses are returned to the caller; anything else outside `ok` is elutasit."""
        if self.calls >= self.budget:
            raise Elutasit('keret')
        self.calls += 1
        status, body = self.fetch('%s/repos/%s/%s' % (GITHUB_API, repo, path))
        if status in ok or status in soft:
            return status, body
        raise Elutasit('github-nem-olvashato:%s:%s' % (what, status))

    def pages(self, repo, path, what):
        out = []
        for page in range(1, MAX_PAGES + 1):
            sep = '&' if '?' in path else '?'
            _, body = self.get(repo, '%s%sper_page=100&page=%d' % (path, sep, page), what)
            if not isinstance(body, list):
                raise Elutasit('github-forma:%s' % what)
            out.extend(body)
            if len(body) < 100:
                return out
        raise Elutasit('tul-sok:%s' % what)

    def path_id(self, repo, ref, path):
        """('tree'|'blob', git id) of `path` at `ref`, or None when it does not exist. A directory is read with the colon form of the
        trees endpoint (404: absent, 422: it is a file), a file with the contents endpoint."""
        if not good_path(path):
            raise Elutasit('rossz-ut:%s' % path)
        status, body = self.get(repo, 'git/trees/%s:%s' % (ref, path), 'tree', soft=(404, 422))
        if status == 200:
            if not isinstance(body, dict) or not isinstance(body.get('sha'), str) or not SHA_RX.match(body['sha']):
                raise Elutasit('github-forma:tree')
            return 'tree', body['sha']
        if status == 404:
            return None
        status, body = self.get(repo, 'contents/%s?ref=%s' % (urllib.parse.quote(path), ref), 'contents', soft=(404,))
        if status == 404:
            return None
        if not isinstance(body, dict) or body.get('type') != 'file' or not isinstance(body.get('sha'), str):
            raise Elutasit('github-forma:contents')
        return 'blob', body['sha']

    def file_text(self, repo, ref, path):
        if not good_path(path):
            raise Elutasit('rossz-ut:%s' % path)
        _, body = self.get(repo, 'contents/%s?ref=%s' % (urllib.parse.quote(path), ref), 'contents')
        if not isinstance(body, dict) or body.get('type') != 'file' or body.get('encoding') != 'base64':
            raise Elutasit('github-forma:contents')
        try:
            return base64.b64decode(body.get('content', '')).decode('utf-8')
        except (ValueError, UnicodeDecodeError):
            raise Elutasit('github-forma:szoveg')

    # --- the facts --------------------------------------------------------------------------------
    def k1_on_branch(self, repo, commit):
        branch = self.cfg.get('branch', 'main')
        _, body = self.get(repo, 'compare/%s...%s' % (commit, branch), 'compare')
        if not isinstance(body, dict) or body.get('behind_by') != 0 or body.get('status') not in ('identical', 'ahead'):
            raise Elutasit('nincs-a-fagon')
        self.tenyek['k1'] = body.get('status')

    def k2_merged_pr(self, repo, commit):
        branch = self.cfg.get('branch', 'main')
        _, body = self.get(repo, 'commits/%s/pulls' % commit, 'pulls')
        if not isinstance(body, list):
            raise Elutasit('github-forma:pulls')
        merged = [p for p in body if isinstance(p, dict) and p.get('merged_at') and p.get('merge_commit_sha') == commit
                  and isinstance(p.get('base'), dict) and p['base'].get('ref') == branch]
        if not merged:
            raise Ember('nem-pr-beolvasztas')
        if len(merged) > 1:
            raise Elutasit('tobb-pr')
        pr = merged[0]
        head = pr.get('head') if isinstance(pr.get('head'), dict) else {}
        h = head.get('sha')
        if not isinstance(h, str) or not SHA_RX.match(h) or not isinstance(pr.get('number'), int):
            raise Elutasit('github-forma:pr')
        head_repo = head.get('repo') if isinstance(head.get('repo'), dict) else {}
        if head_repo.get('full_name') != repo:
            raise Ember('fork-pr')
        self.tenyek.update(pr=pr['number'], fej=h)
        return pr['number'], h

    def k9_ci_paths(self, repo, pr):
        prefixes = [CI_ROOT] + [p for p in self.cfg.get('ci_utak', []) if isinstance(p, str)]
        for f in self.pages(repo, 'pulls/%d/files' % pr, 'files'):
            if not isinstance(f, dict):
                raise Elutasit('github-forma:files')
            for name in (f.get('filename'), f.get('previous_filename')):
                if isinstance(name, str) and any(name == p or name.startswith(p if p.endswith('/') else p + '/') for p in prefixes):
                    raise Ember('ci-utvonal:%s' % name)

    def k3_verdict(self, repo, pr, head):
        source = self.cfg.get('forras')
        approver = self.cfg.get('jovahagyo')
        if not approver or source not in ('rekord', 'github'):
            raise Elutasit('rossz-beallitas')
        if source == 'rekord':
            verdict = self._record_verdict(repo, pr, approver)
        else:
            verdict = self._review_verdict(repo, pr)
        if verdict is None:
            raise Elutasit('nincs-itelet')
        state, sha = verdict
        if state != 'APPROVE':
            raise Elutasit('az-utolso-itelet-nem-approve')
        if sha != head:
            raise Elutasit('az-itelet-mas-fejre-szol')
        self.tenyek['itelet'] = source

    def _record_verdict(self, repo, pr, approver):
        """The approver's latest line for exactly this repository and PR, by the file's order (root appends under a lock).
        The task label is NOT matched: a later CHANGES under another task of the same PR still counts."""
        owner, name = repo.split('/', 1)
        try:
            with open(self.cfg.get('rekord_fajl', ''), encoding='utf-8') as f:
                lines = f.read().splitlines()
        except OSError:
            raise Elutasit('rekord-nem-olvashato')
        found = None
        for n, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except ValueError:
                raise Elutasit('rekord-serult:%d' % n)
            if not isinstance(r, dict):
                raise Elutasit('rekord-serult:%d' % n)
            if (r.get('actor'), r.get('owner'), r.get('repo'), r.get('pr')) != (approver, owner, name, pr):
                continue
            if r.get('verdict') in ('APPROVE', 'CHANGES') and isinstance(r.get('head'), str) and SHA_RX.match(r['head']):
                found = (r['verdict'], r['head'])
        return found

    def _review_verdict(self, repo, pr):
        login = self.cfg.get('gepi_login')
        if not isinstance(login, str) or not login:
            raise Elutasit('rossz-beallitas')
        found = None
        for r in self.pages(repo, 'pulls/%d/reviews' % pr, 'reviews'):
            if not isinstance(r, dict) or not isinstance(r.get('user'), dict) or r['user'].get('login') != login:
                continue
            state = r.get('state')
            if state == 'APPROVED' and isinstance(r.get('commit_id'), str):
                found = ('APPROVE', r['commit_id'])
            elif state in ('CHANGES_REQUESTED', 'DISMISSED'):
                found = ('CHANGES', r.get('commit_id') if isinstance(r.get('commit_id'), str) else '')
        return found

    def k5_ci(self, repo, commit):
        names = self.cfg.get('checks') or []
        if not names or not all(isinstance(n, str) and NAME_RX.match(n) for n in names):
            raise Elutasit('rossz-beallitas')
        runs = []
        for page in range(1, MAX_PAGES + 1):
            _, body = self.get(repo, 'commits/%s/check-runs?per_page=100&page=%d' % (commit, page), 'check-runs')
            part = body.get('check_runs') if isinstance(body, dict) else None
            if not isinstance(part, list):
                raise Elutasit('github-forma:check-runs')
            runs.extend(part)
            if len(part) < 100:
                break
        else:
            raise Elutasit('tul-sok:check-runs')
        result = {}
        for name in names:
            same = [r for r in runs if isinstance(r, dict) and r.get('name') == name and isinstance(r.get('id'), int)
                    and isinstance(r.get('app'), dict) and r['app'].get('slug') == self.cfg.get('ci_app', CI_APP)]
            if not same:
                raise Elutasit('ci-hianyzik:%s' % name)
            latest = max(same, key=lambda r: r['id'])
            if latest.get('status') != 'completed':
                raise Elutasit('ci-folyamatban:%s' % name)
            if latest.get('conclusion') != 'success':
                raise Elutasit('ci-bukott:%s' % name)
            result[name] = 'success'
        self.tenyek['ci'] = result

    def k4_bytes(self, repo, commit, head, rule):
        paths = rule.get('utak') or []
        block = rule.get('blokk')
        if not paths and not block:
            raise Elutasit('nincs-mit-osszevetni')
        ids = {}
        for path in paths:
            at_commit = self.path_id(repo, commit, path)
            at_head = self.path_id(repo, head, path)
            if at_commit is None or at_head is None:
                raise Elutasit('bajt-hianyzik:%s' % path)
            if at_commit != at_head:
                raise Elutasit('bajt-elter:%s' % path)
            ids[path] = at_commit[1][:12]
        if block:
            path, marker = block.get('ut'), block.get('jelolo')
            if not isinstance(path, str) or not isinstance(marker, str):
                raise Elutasit('rossz-beallitas')
            a = extract_block(self.file_text(repo, commit, path), marker)
            b = extract_block(self.file_text(repo, head, path), marker)
            if a is None or b is None:
                raise Elutasit('blokk-hianyzik:%s' % path)
            if a != b:
                raise Elutasit('bajt-elter:%s' % path)
            ids[path + '#' + marker] = 'blokk'
        self.tenyek['bajt'] = ids

    # --- the decision -----------------------------------------------------------------------------
    def donto(self, repo, commit, kero, rule):
        """The decision for `commit` of `repo`: {'dontes': 'dont'|'elutasit'|'ember', 'ok': str, 'tenyek': {...}, 'hivas': n}."""
        self.tenyek = {}
        try:
            if repo not in self.cfg.get('repok', []) or not REPO_RX.match(repo):
                raise Elutasit('nem-flotta-repo')
            if not isinstance(commit, str) or not SHA_RX.match(commit):
                raise Elutasit('rossz-commit')
            if not self.cfg.get('jovahagyo'):
                raise Elutasit('rossz-beallitas')
            if not isinstance(kero, str) or not kero or kero == self.cfg.get('jovahagyo'):
                raise Elutasit('a-kero-a-jovahagyo')
            self.k1_on_branch(repo, commit)
            pr, head = self.k2_merged_pr(repo, commit)
            self.k9_ci_paths(repo, pr)
            self.k3_verdict(repo, pr, head)
            self.k5_ci(repo, commit)
            self.k4_bytes(repo, commit, head, rule if isinstance(rule, dict) else {})
        except Elutasit as e:
            return self._answer('elutasit', str(e))
        except Ember as e:
            return self._answer('ember', str(e))
        except Exception as e:  # a gate bug must never read as a pass
            return self._answer('elutasit', 'hiba:%s' % e.__class__.__name__)
        return self._answer('dont', 'minden-teny-igaz')

    def _answer(self, result, why):
        return {'dontes': result, 'ok': why, 'tenyek': dict(self.tenyek), 'hivas': self.calls}
