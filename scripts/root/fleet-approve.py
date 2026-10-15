#!/usr/bin/python3 -I
"""fleet-approve: the GitHub approval of a fleet PR, given only for a recorded review, run as root (D4 step 2).

Balázs chose option A (2026-10-15 12:24 UTC): the fleet's PRs are authored by the GitHub App, and the
required approval comes from barracuda through a separate machine account. The machine account's
token must not be in barracuda's shell: barracuda reads developers' diffs, which is a prompt-injection
surface (barracuda, the D4 sheet's v2 review). So the token is root-only, and this is the one thing
that uses it.

THE INSTALLED COPY RUNS, NOT THIS FILE: /usr/local/sbin/fleet-approve, root:root 0755, with
  agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-approve approve *
It reads nothing from the repository at run time: no script, no module, no config from the tree.

One verb:
  approve <owner/repo> <pr> <task_id>

It approves ONLY if all of these hold, each measured here, none taken from the caller:
  1. the caller (SUDO_UID) is on the root config's `approvers` list;
  2. the repository is a fleet repository (the config's `owner` and `repos`);
  3. the task's events (the dashboard's database, read-only) have a `verdict` by the CALLER for exactly this
     owner/repo#N, and the LATEST such verdict BY THE SERVER'S EVENT ID is APPROVE (review-ellenoriz.sh
     writes it: "APPROVE owner/repo#N pr-<packet> fej <full 40-character sha>");
  4. the PR is open, its base is main, and its head IS that verdict's sha, all 40 characters.
Then it posts an APPROVE review pinned to that head (`commit_id`), so a push after the review is not
covered: with "require approval of the most recent push" on, GitHub asks again.

WHAT THIS DOES NOT DO, and what must hold before the required approval is switched on (the D4 sheet's
step 7; barracuda, #200 review):
  - it does not judge the code: a wrong APPROVE verdict is approved;
  - it trusts that the verdict event is barracuda's. The events route accepts a verdict only with the
    task reviewer's own agent token (src/web/routes/task-usage.ts, this PR); before that is deployed,
    anyone with the shared token can write one in barracuda's name;
  - it binds the approval to the head the PACKET names, and the packet is the developer's: its README
    head line is a claim, and diff.patch is what barracuda read. A head with more in it than the diff
    would pass every check here. Closing this is a separate decision (acrobot): the verdict carrying the
    diff's hash and this script comparing it with GitHub's diff of the head, or the review packet's diff
    produced by the reviewer's tool from the head itself. Until one of them is in, step 7 waits.

Exit codes: 0 approved; 2 usage; 10 refused (nothing posted); 13 the dashboard or GitHub failed.
"""
import json
import os
import pwd
import re
import stat
import sys
import time
import urllib.error
import urllib.request

CONFIG_FILE = '/etc/fleet-github/app.json'
APPROVER_TOKEN_FILE = '/etc/fleet-github/approver-token'
# the verdicts are read from the dashboard's own database, read-only, with no token at all (acrobot 31454,
# option 1): no secret to hold or rotate, and nothing here can write. What gets into task_events is decided
# by the events route (a verdict only with the task reviewer's own token, src/web/routes/task-usage.ts).
DB_FILE = '/home/marveen/marveen/store/claudeclaw.db'
VERDICT_SQL = ("SELECT id, kind, actor, ref, at FROM task_events "
               "WHERE task_id = ? AND kind = 'verdict' ORDER BY id")
LOG_FILE = '/var/log/fleet-approve.log'
API = 'https://api.github.com'

OWNER_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$')
REPO_RX = re.compile(r'^[A-Za-z0-9._-]{1,100}$')
TASK_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
USER_RX = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
USAGE = 'usage: fleet-approve approve <owner/repo> <pr> <task_id>'


class Refused(Exception):
    pass


class Failed(Exception):
    pass


def root_file(path, getstat=os.lstat, secret=False):
    """A root-owned regular file, not a symlink, not writable by group or others; a secret also not
    readable by them."""
    try:
        st = getstat(path)
    except OSError:
        raise Refused(f'missing: {path}')
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & (0o077 if secret else 0o022):
        raise Refused(f'not a root-owned regular file with {"0600" if secret else "no group or other write"}: {path}')
    return st


def read_secret(path, getstat=os.lstat):
    root_file(path, getstat, secret=True)
    value = open(path, encoding='utf-8').read().strip()
    if not value or any(c.isspace() for c in value):
        raise Refused(f'malformed: {path}')
    return value


def parse(argv):
    if len(argv) != 4 or argv[0] != 'approve':
        raise ValueError(USAGE)
    owner, _, repo = argv[1].partition('/')
    if not OWNER_RX.match(owner) or not REPO_RX.match(repo) or not argv[2].isdigit() or not TASK_RX.match(argv[3]):
        raise ValueError(USAGE)
    return owner, repo, int(argv[2]), argv[3]


def latest_verdict(items, actor, owner, repo, pr):
    """(verdict, sha) of the actor's latest verdict on exactly owner/repo#pr, or None.

    LATEST BY THE SERVER'S EVENT ID, not by `at` (barracuda, #200): `at` comes from the request
    body, so a future-dated forged APPROVE would outrank a real, later CHANGES. The id is the
    row's insertion order. And the head must be the FULL 40-character sha: a 7-character prefix
    is 28 bits, and a commit with the same prefix and other content is minutes of work."""
    rx = re.compile(rf'^(APPROVE|CHANGES) {re.escape(owner)}/{re.escape(repo)}#{pr} pr-\S+ fej ([0-9a-f]{{40}})$')
    found = []
    for i in items:
        if i.get('source') != 'event' or i.get('kind') != 'verdict' or i.get('actor') != actor:
            continue
        if not isinstance(i.get('id'), int):
            continue
        m = rx.match((i.get('ref') or '').strip())
        if m:
            found.append((i['id'], m.group(1), m.group(2)))
    if not found:
        return None
    _, verdict, sha = max(found, key=lambda f: f[0])
    return verdict, sha


def read_verdicts(task, db_file, drop=True):
    """The task's verdict events, read-only, as timeline items.

    As root it reads in a child that has first become the database file's owner: in WAL mode even a
    read-only connection may create the -shm side file, and a root-owned -shm would lock the dashboard
    out of its own database. The connection is mode=ro, and the WAL is read (not immutable=1, which would
    miss the verdicts not yet checkpointed)."""
    import sqlite3

    def query():
        con = sqlite3.connect(f'file:{db_file}?mode=ro', uri=True, timeout=5)
        try:
            rows = con.execute(VERDICT_SQL, (task,)).fetchall()
        finally:
            con.close()
        return [{'source': 'event', 'id': r[0], 'kind': r[1], 'actor': r[2], 'ref': r[3], 'at': r[4]} for r in rows]

    if not drop or os.geteuid() != 0:
        return query()
    st = os.stat(db_file)
    if st.st_uid == 0:
        raise Failed('the database is owned by root: refusing to read it as root')
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(r)
        code, out = 0, b''
        try:
            os.setgroups([])
            os.setgid(st.st_gid)
            os.setuid(st.st_uid)
            out = json.dumps(query()).encode()
        except Exception as e:  # the parent says it; the child only reports
            code, out = 1, json.dumps({'error': f'{e.__class__.__name__}'}).encode()
        with os.fdopen(w, 'wb') as f:
            f.write(out)
        os._exit(code)
    os.close(w)
    with os.fdopen(r, 'rb') as f:
        data = f.read()
    _, status = os.waitpid(pid, 0)
    parsed = json.loads(data.decode() or '{}')
    if status != 0 or not isinstance(parsed, list):
        raise Failed(f'reading the verdicts failed: {parsed.get("error") if isinstance(parsed, dict) else "?"}')
    return parsed


def http(method, url, token, body=None, auth='Bearer'):
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(), headers={
        'Authorization': f'{auth} {token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'fleet-approve', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or '{}')
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise Failed(f'no answer from {url.split("/")[2]}: {e.__class__.__name__}')


def decide(cfg, caller, owner, repo, pr, task, get_timeline, get_pr, post_review):
    if caller not in cfg.get('approvers', []):
        raise Refused(f'{caller} is not an approver')
    if owner != cfg.get('owner') or repo not in cfg.get('repos', []):
        raise Refused(f'not a fleet repository: {owner}/{repo}')
    actor = caller[len('agent-'):] if caller.startswith('agent-') else caller
    v = latest_verdict(get_timeline(task), actor, owner, repo, pr)
    if v is None:
        raise Refused(f'no verdict by {actor} on {owner}/{repo}#{pr} in task {task}')
    verdict, sha = v
    if verdict != 'APPROVE':
        raise Refused(f'the latest verdict by {actor} is {verdict}')
    p = get_pr(owner, repo, pr)
    head = ((p.get('head') or {}).get('sha') or '')
    if p.get('state') != 'open' or (p.get('base') or {}).get('ref') != 'main':
        raise Refused(f'the PR is {p.get("state")}, base {(p.get("base") or {}).get("ref")}')
    if head != sha:
        raise Refused(f'the reviewed head {sha} is not the PR head {head[:12]}: a push came after the review')
    post_review(owner, repo, pr, {'commit_id': head, 'event': 'APPROVE',
                                  'body': f'fleet-approve: {actor} APPROVE on {sha}, task {task}'})
    return head


def log(path, entry):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except OSError:
        pass


def run(argv, env):
    entry = {'ts': int(time.time()), 'caller': env['caller'], 'argv': argv[:4]}
    try:
        owner, repo, pr, task = parse(argv)
    except ValueError as e:
        log(env['log_file'], {**entry, 'result': 'usage'})
        return 2, str(e)
    try:
        if not USER_RX.match(env['caller'] or ''):
            raise Refused('unknown caller')
        getstat = env.get('getstat', os.lstat)
        root_file(env['config_file'], getstat)
        cfg = json.load(open(env['config_file'], encoding='utf-8'))
        head = decide(cfg, env['caller'], owner, repo, pr, task, env['get_timeline'], env['get_pr'], env['post_review'])
    except Refused as e:
        log(env['log_file'], {**entry, 'result': 'refused', 'why': str(e)})
        return 10, f'fleet-approve: refused: {e}'
    except (Failed, ValueError, OSError) as e:
        log(env['log_file'], {**entry, 'result': 'failed', 'why': f'{e.__class__.__name__}: {e}'[:200]})
        return 13, f'fleet-approve: failed: {e}'
    log(env['log_file'], {**entry, 'result': 'approved', 'head': head})
    return 0, f'approved {owner}/{repo}#{pr} at {head}'


def real_env():
    def timeline(task):
        return read_verdicts(task, DB_FILE)

    def get_pr(owner, repo, pr):
        code, d = http('GET', f'{API}/repos/{owner}/{repo}/pulls/{pr}', read_secret(APPROVER_TOKEN_FILE))
        if code != 200:
            raise Failed(f'GitHub PR HTTP {code}')
        return d

    def post_review(owner, repo, pr, body):
        code, d = http('POST', f'{API}/repos/{owner}/{repo}/pulls/{pr}/reviews', read_secret(APPROVER_TOKEN_FILE), body)
        if code != 200 or d.get('state') != 'APPROVED':
            raise Failed(f'GitHub review HTTP {code}: {str(d.get("message", ""))[:160]}')

    uid = os.environ.get('SUDO_UID')
    try:
        caller = pwd.getpwuid(int(uid) if uid and uid.isdigit() else os.getuid()).pw_name
    except KeyError:
        caller = ''
    return {'config_file': CONFIG_FILE, 'log_file': LOG_FILE, 'caller': caller,
            'get_timeline': timeline, 'get_pr': get_pr, 'post_review': post_review}


if __name__ == '__main__':
    os.umask(0o077)
    code, out = run(sys.argv[1:], real_env())
    (sys.stdout if code == 0 else sys.stderr).write(out + '\n')
    sys.exit(code)
