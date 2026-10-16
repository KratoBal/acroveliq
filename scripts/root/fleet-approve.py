#!/usr/bin/python3 -I
"""fleet-approve: the GitHub approval of a fleet PR, given only for a recorded review, run as root (D4 step 2).

Balázs chose option A (2026-10-15 12:24 UTC): the fleet's PRs are authored by the GitHub App, and the
required approval comes from barracuda through a separate machine account. The machine account's
token must not be in barracuda's shell: barracuda reads developers' diffs, which is a prompt-injection
surface (barracuda, the D4 sheet's v2 review). So the token is root-only, and this is the one thing
that uses it.

THE INSTALLED COPY RUNS, NOT THIS FILE: /usr/local/sbin/fleet-approve, root:root 0755, with
  agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-approve approve *
  agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-approve record *
It reads nothing from the repository at run time: no script, no module, no config from the tree.

Two verbs:
  record <owner/repo> <pr> <task_id> <APPROVE|CHANGES> <head, 40 hex>
  approve <owner/repo> <pr> <task_id>

WHY A ROOT RECORD (the D4 step list E3 (a), acrobot 31484): until 2026-10-16 the approver read the
verdicts from the dashboard's database. That file is 0600 marveen, so every process running as marveen
(the main agent, which also reads outside text, and the dashboard) could write a verdict row in
barracuda's name around the events route (barracuda, #202 review). Now review-ellenoriz.sh, after the
dashboard verdict, also calls `record` through sudo; the caller is SUDO_UID, measured here, and the line
goes to a root-owned, append-only file (/var/lib/fleet-approve/verdicts.jsonl, root 0600 in a root 0700
directory). `approve` reads only that file. The dashboard's verdict stays the timeline's record; it no
longer decides an approval. So root no longer reads the dashboard's database at all.

`record` stores what the caller says, for the caller's own name only:
  1. the caller is on the root config's `approvers` list;
  2. the repository is a fleet repository (the config's `owner` and `repos`);
  3. the verdict is APPROVE or CHANGES and the head is a full 40-character sha.
It does not ask whether the task asked for a review or whether the head is the PR's: review-ellenoriz.sh
checks the first, and `approve` checks the second at approval time.

`approve` approves ONLY if all of these hold, each measured here, none taken from the caller:
  1. the caller (SUDO_UID) is on the root config's `approvers` list;
  2. the repository is a fleet repository;
  3. the root record has a verdict BY THE CALLER for exactly this owner/repo#N and task, and the LATEST
     such line (the file's order: root appends, under a lock) is APPROVE;
  4. the PR is open, its base is main, and its head IS that verdict's sha, all 40 characters.
Then it posts an APPROVE review pinned to that head (`commit_id`), so a push after the review is not
covered: with "require approval of the most recent push" on, GitHub asks again.

WHAT THIS DOES NOT DO:
  - it does not judge the code: a wrong APPROVE verdict is approved;
  - the record is worth what the agent-barracuda identity is worth. Anything that can act as
    agent-barracuda can record (today: the router's sudo tmux rule into barracuda's panes, which B48
    replaces with the fleet-pane broker);
  - the record lives in the container's file system, so a container recreate empties it: approvals
    then refuse ("no verdict") until barracuda records again. Closed, not open;
  - it binds the approval to the head the PACKET names, and the packet is the developer's: its README
    head line is a claim, and diff.patch is what barracuda read. DECIDED (acrobot 31441, the step list
    E3 (b)): the review packet's diff is produced by the reviewer's tool from the full head itself (a
    separate change); until it is in, step 11 waits.

Exit codes: 0 approved or recorded; 2 usage; 10 refused (nothing posted, nothing recorded); 13 the record
file or GitHub failed.
"""
import fcntl
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
# the verdicts: root's own append-only record (see "WHY A ROOT RECORD" above), not the dashboard's database
RECORD_DIR = '/var/lib/fleet-approve'
RECORD_FILE = RECORD_DIR + '/verdicts.jsonl'
LOG_FILE = '/var/log/fleet-approve.log'
API = 'https://api.github.com'

OWNER_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$')
REPO_RX = re.compile(r'^[A-Za-z0-9._-]{1,100}$')
TASK_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')
USER_RX = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
SHA_RX = re.compile(r'^[0-9a-f]{40}$')
VERDICTS = ('APPROVE', 'CHANGES')
USAGE = ('usage: fleet-approve approve <owner/repo> <pr> <task_id>\n'
         '       fleet-approve record <owner/repo> <pr> <task_id> <APPROVE|CHANGES> <40-hex head>')


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
    """(verb, owner, repo, pr, task, verdict, head); verdict and head are None for approve."""
    if len(argv) == 4 and argv[0] == 'approve':
        verdict = head = None
    elif len(argv) == 6 and argv[0] == 'record':
        verdict, head = argv[4], argv[5]
        if verdict not in VERDICTS or not SHA_RX.match(head):
            raise ValueError(USAGE)
    else:
        raise ValueError(USAGE)
    owner, _, repo = argv[1].partition('/')
    if not OWNER_RX.match(owner) or not REPO_RX.match(repo) or not argv[2].isdigit() or not TASK_RX.match(argv[3]):
        raise ValueError(USAGE)
    return argv[0], owner, repo, int(argv[2]), argv[3], verdict, head


def _owned_fd(fd, path, uid, want_dir=False):
    """The open descriptor is the owner's (root), the right kind, and closed to group and others."""
    st = os.fstat(fd)
    kind = stat.S_ISDIR(st.st_mode) if want_dir else stat.S_ISREG(st.st_mode)
    if not kind or st.st_uid != uid or st.st_mode & 0o077:
        raise Failed(f'not a {"directory" if want_dir else "file"} owned by uid {uid} with mode 0{"700" if want_dir else "600"}: {path}')


def _open_record_dir(record_dir, uid, create):
    """The record directory, opened without following a symlink; made 0700 if missing and asked to."""
    if create:
        try:
            os.mkdir(record_dir, 0o700)
        except FileExistsError:
            pass
        except OSError as e:
            raise Failed(f'cannot make {record_dir}: {e.__class__.__name__}')
    try:
        fd = os.open(record_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise Failed(f'cannot open {record_dir} (a symlink?): {e.__class__.__name__}')
    try:
        _owned_fd(fd, record_dir, uid, want_dir=True)
    except Failed:
        os.close(fd)
        raise
    return fd


def append_record(entry, record_dir=RECORD_DIR, uid=0):
    """One JSON line, appended under an exclusive lock, to a file that only its owner can read or write."""
    dfd = _open_record_dir(record_dir, uid, create=True)
    try:
        fd = os.open('verdicts.jsonl', os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
    except OSError as e:
        os.close(dfd)
        raise Failed(f'cannot open the record (a symlink?): {e.__class__.__name__}')
    os.close(dfd)
    try:
        _owned_fd(fd, record_dir + '/verdicts.jsonl', uid)
        fcntl.flock(fd, fcntl.LOCK_EX)
        data = (json.dumps(entry, ensure_ascii=False, sort_keys=True) + '\n').encode()
        if os.write(fd, data) != len(data):
            raise Failed('a short write to the record')
        os.fsync(fd)
    finally:
        os.close(fd)


def read_records(record_dir=RECORD_DIR, uid=0):
    """Every recorded verdict, in the file's order. No directory or no file: no verdicts (a fresh or
    recreated container). A line that does not parse is a failure, not a skip: the file is root's alone."""
    dfd = _open_record_dir(record_dir, uid, create=False)
    if dfd is None:
        return []
    try:
        fd = os.open('verdicts.jsonl', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise Failed(f'cannot open the record (a symlink?): {e.__class__.__name__}')
    finally:
        os.close(dfd)
    try:
        _owned_fd(fd, record_dir + '/verdicts.jsonl', uid)
        fcntl.flock(fd, fcntl.LOCK_SH)
        with os.fdopen(fd, 'r', encoding='utf-8', closefd=False) as f:
            text = f.read()
    finally:
        os.close(fd)
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        try:
            r = json.loads(line)
        except ValueError:
            raise Failed(f'the record line {n} is not JSON')
        if not isinstance(r, dict):
            raise Failed(f'the record line {n} is not an object')
        out.append(r)
    return out


def latest_verdict(records, actor, owner, repo, pr, task):
    """(verdict, sha) of the actor's latest recorded verdict on exactly owner/repo#pr in this task, or None.

    LATEST BY THE FILE'S ORDER: root appends under a lock, so the order is the order of the calls; no
    caller-given time is read. The head must be the full 40-character sha (a 7-character prefix is 28 bits)."""
    found = None
    for r in records:
        if (r.get('actor'), r.get('owner'), r.get('repo'), r.get('pr'), r.get('task')) != (actor, owner, repo, pr, task):
            continue
        if r.get('verdict') in VERDICTS and isinstance(r.get('head'), str) and SHA_RX.match(r['head']):
            found = (r['verdict'], r['head'])
    return found


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


def allowed(cfg, caller, owner, repo):
    """The approver's name without agent-, after the two checks every verb shares."""
    if caller not in cfg.get('approvers', []):
        raise Refused(f'{caller} is not an approver')
    if owner != cfg.get('owner') or repo not in cfg.get('repos', []):
        raise Refused(f'not a fleet repository: {owner}/{repo}')
    return caller[len('agent-'):] if caller.startswith('agent-') else caller


def record(cfg, caller, owner, repo, pr, task, verdict, head, append, now):
    actor = allowed(cfg, caller, owner, repo)
    append({'ts': now, 'actor': actor, 'owner': owner, 'repo': repo, 'pr': pr, 'task': task,
            'verdict': verdict, 'head': head})
    return head


def decide(cfg, caller, owner, repo, pr, task, get_records, get_pr, post_review):
    actor = allowed(cfg, caller, owner, repo)
    v = latest_verdict(get_records(), actor, owner, repo, pr, task)
    if v is None:
        raise Refused(f'no recorded verdict by {actor} on {owner}/{repo}#{pr} in task {task}')
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
    entry = {'ts': int(time.time()), 'caller': env['caller'], 'argv': argv[:6]}
    try:
        verb, owner, repo, pr, task, verdict, head = parse(argv)
    except ValueError as e:
        log(env['log_file'], {**entry, 'result': 'usage'})
        return 2, str(e)
    try:
        if not USER_RX.match(env['caller'] or ''):
            raise Refused('unknown caller')
        getstat = env.get('getstat', os.lstat)
        root_file(env['config_file'], getstat)
        cfg = json.load(open(env['config_file'], encoding='utf-8'))
        if verb == 'record':
            record(cfg, env['caller'], owner, repo, pr, task, verdict, head, env['append_record'], entry['ts'])
        else:
            head = decide(cfg, env['caller'], owner, repo, pr, task, env['get_records'], env['get_pr'], env['post_review'])
    except Refused as e:
        log(env['log_file'], {**entry, 'result': 'refused', 'why': str(e)})
        return 10, f'fleet-approve: refused: {e}'
    except (Failed, ValueError, OSError) as e:
        log(env['log_file'], {**entry, 'result': 'failed', 'why': f'{e.__class__.__name__}: {e}'[:200]})
        return 13, f'fleet-approve: failed: {e}'
    if verb == 'record':
        log(env['log_file'], {**entry, 'result': 'recorded', 'verdict': verdict, 'head': head})
        return 0, f'recorded {verdict} {owner}/{repo}#{pr} at {head}, task {task}'
    log(env['log_file'], {**entry, 'result': 'approved', 'head': head})
    return 0, f'approved {owner}/{repo}#{pr} at {head}'


def real_env():
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
            'get_records': read_records, 'append_record': append_record,
            'get_pr': get_pr, 'post_review': post_review}


if __name__ == '__main__':
    os.umask(0o077)
    code, out = run(sys.argv[1:], real_env())
    (sys.stdout if code == 0 else sys.stderr).write(out + '\n')
    sys.exit(code)
