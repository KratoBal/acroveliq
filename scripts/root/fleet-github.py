#!/usr/bin/python3 -I
"""fleet-github: the fleet's GitHub tokens, one hour, one repository, one role, run as root (D4 step 2).

The fleet worked with ONE owner token (Balázs's account, every repository, until 2027-01-11): any
process that could read it could merge as him, and could approve as him, which is why a required
approval could not bind (the D4 step 2 sheet, agents/nautilus/biztonsag/d4-2-lepcso-github-app-2026-10-15.md,
barracuda APPROVE; Balázs chose option A at 2026-10-15 12:24 UTC). The replacement is a GitHub App,
and this broker is the only thing that holds its private key.

THE INSTALLED COPY RUNS, NOT THIS FILE: /usr/local/sbin/fleet-github, root:root 0755, with one sudo
line per caller, for example
  agent-nautilus ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token *
The repository is writable by `marveen`; running it from here would hand the key to whoever edits it.
Installing it, the key and the sudo lines are Balázs's steps (the sheet, section 5).

One verb:
  token <owner/repo> <role>   prints a fresh installation token on stdout, nothing else

Roles (the token's permissions; GitHub narrows the token to exactly these and to the one repository):
  olvas      read: metadata, contents, pull requests, checks, statuses, actions
  push       contents write (a branch push; note: on GitHub a merge is ALSO contents write, so this
             role can merge an approved, green PR: the roles differ here and in the log, not on GitHub)
  pr         pull requests write, contents read (open a PR, comment)
  beolvaszt  contents write, pull requests and checks read (the merge)
No role carries workflows, administration, secrets or webhooks. A workflow-file change needs a
separate, human-approved verb (the sheet, section 3), which this first version does not have.

Who may ask for what: the root-owned /etc/fleet-github/app.json, `callers`: an OS user, a repository
name (or "*"), the roles. The caller is the sudo caller (SUDO_UID), never an argument.

WHAT THIS DOES NOT DO, said aloud: it does not know why the caller wants the token, and a push token
can write any unprotected branch of its repository for its hour. What protects `main` (and every
branch something deploys from) is the ruleset with an empty bypass list, not this broker.

Exit codes: 0 printed a token; 2 usage; 10 refused (caller, repository, role, or the root files);
13 GitHub refused or answered something unexpected.
"""
import base64
import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

CONFIG_FILE = '/etc/fleet-github/app.json'
KEY_FILE = '/etc/fleet-github/app-key.pem'
LOG_FILE = '/var/log/fleet-github.log'
OPENSSL = '/usr/bin/openssl'
API = 'https://api.github.com'

ROLE_PERMISSIONS = {
    'olvas': {'metadata': 'read', 'contents': 'read', 'pull_requests': 'read', 'checks': 'read',
              'statuses': 'read', 'actions': 'read'},
    'push': {'metadata': 'read', 'contents': 'write'},
    'pr': {'metadata': 'read', 'contents': 'read', 'pull_requests': 'write'},
    'beolvaszt': {'metadata': 'read', 'contents': 'write', 'pull_requests': 'read', 'checks': 'read',
                  'statuses': 'read'},
}
NEVER = ('workflows', 'administration', 'secrets', 'repository_hooks', 'organization_administration')

OWNER_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}$')
REPO_RX = re.compile(r'^[A-Za-z0-9._-]{1,100}$')
USER_RX = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
USAGE = 'usage: fleet-github token <owner/repo> <olvas|push|pr|beolvaszt>'


class Refused(Exception):
    """Exit 10: nothing was asked of GitHub."""


class GitHubError(Exception):
    """Exit 13."""


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def root_file(path, getstat=os.lstat, secret=False):
    """A root-owned regular file, not a symlink, not writable by group or others; a secret (the
    private key) also not readable by them."""
    try:
        st = getstat(path)
    except OSError:
        raise Refused(f'missing: {path}')
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & (0o077 if secret else 0o022):
        raise Refused(f'not a root-owned regular file with {"0600" if secret else "no group or other write"}: {path}')
    return st


def load_config(path, getstat=os.lstat):
    root_file(path, getstat)
    try:
        cfg = json.load(open(path, encoding='utf-8'))
    except (OSError, ValueError) as e:
        raise Refused(f'unreadable config: {e.__class__.__name__}')
    for k in ('app_id', 'installation_id', 'owner', 'repos', 'callers'):
        if k not in cfg:
            raise Refused(f'config lacks {k}')
    if not OWNER_RX.match(str(cfg['owner'])) or not str(cfg['installation_id']).isdigit():
        raise Refused('config owner or installation_id malformed')
    if not isinstance(cfg['repos'], list) or not all(isinstance(r, str) and REPO_RX.match(r) for r in cfg['repos']):
        raise Refused('config repos malformed')
    return cfg


def allowed(cfg, caller, repo, role):
    """True if the config lets this OS user have this role on this repository."""
    rules = cfg['callers'].get(caller)
    if not isinstance(rules, dict):
        return False
    roles = rules.get(repo, rules.get('*', []))
    return isinstance(roles, list) and role in roles


def parse(argv):
    if len(argv) != 3 or argv[0] != 'token':
        raise ValueError(USAGE)
    full, role = argv[1], argv[2]
    owner, _, repo = full.partition('/')
    if not OWNER_RX.match(owner) or not REPO_RX.match(repo) or role not in ROLE_PERMISSIONS:
        raise ValueError(USAGE)
    return owner, repo, role


def jwt(app_id, sign, now=None):
    """The App's JWT: RS256, issued a minute in the past (clock drift), valid nine minutes (GitHub's
    maximum is ten)."""
    now = int(time.time() if now is None else now)
    header = b64url(json.dumps({'alg': 'RS256', 'typ': 'JWT'}, separators=(',', ':')).encode())
    payload = b64url(json.dumps({'iat': now - 60, 'exp': now + 540, 'iss': str(app_id)}, separators=(',', ':')).encode())
    signing_input = f'{header}.{payload}'.encode('ascii')
    return f'{header}.{payload}.{b64url(sign(signing_input))}'


def openssl_sign(key_file):
    def sign(data):
        r = subprocess.run([OPENSSL, 'dgst', '-sha256', '-sign', key_file], input=data, capture_output=True,
                           env={'PATH': '/usr/bin:/bin'})
        if r.returncode != 0 or not r.stdout:
            # stderr names a file problem, never key material; keep only its first line
            raise Refused('signing failed: ' + (r.stderr.decode(errors='replace').splitlines() or [''])[0][:160])
        return r.stdout
    return sign


def real_post(url, token, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={
        'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'fleet-github'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise GitHubError(f'no answer: {e.__class__.__name__}')


def issue(cfg, owner, repo, role, sign, post):
    """Asks GitHub for the token and checks that the answer is exactly what was asked: the one
    repository and no permission beyond the role's."""
    want = ROLE_PERMISSIONS[role]
    code, data = post(f"{API}/app/installations/{cfg['installation_id']}/access_tokens", jwt(cfg['app_id'], sign),
                      {'repositories': [repo], 'permissions': want})
    if code != 201 or not isinstance(data, dict) or not data.get('token'):
        raise GitHubError(f'HTTP {code}: {str(data.get("message", ""))[:160] if isinstance(data, dict) else ""}')
    got = data.get('permissions') or {}
    extra = {k: v for k, v in got.items() if want.get(k) is None or (want[k] == 'read' and v != 'read')}
    repos = [r.get('name') for r in data.get('repositories') or [] if isinstance(r, dict)]
    if extra or repos != [repo]:
        raise GitHubError(f'the token is wider than asked: permissions {sorted(extra)}, repositories {repos}')
    return data['token'], data.get('expires_at', '')


def log(path, entry):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except OSError:
        pass  # a log that cannot be written does not stop a token; the journal has the sudo line


def run(argv, env):
    """(exit code, stdout text). env: config_file, key_file, log_file, caller, sign (optional), post."""
    entry = {'ts': int(time.time()), 'caller': env['caller'], 'argv': argv[:3]}
    try:
        owner, repo, role = parse(argv)
    except ValueError as e:
        log(env['log_file'], {**entry, 'result': 'usage'})
        return 2, str(e)
    try:
        if not USER_RX.match(env['caller'] or ''):
            raise Refused('unknown caller')
        cfg = load_config(env['config_file'], env.get('getstat', os.lstat))
        if owner != cfg['owner'] or repo not in cfg['repos']:
            raise Refused(f'not a fleet repository: {owner}/{repo}')
        if not allowed(cfg, env['caller'], repo, role):
            raise Refused(f'{env["caller"]} may not have {role} on {repo}')
        root_file(env['key_file'], env.get('getstat', os.lstat), secret=True)
        sign = env.get('sign') or openssl_sign(env['key_file'])
        token, expires = issue(cfg, owner, repo, role, sign, env['post'])
    except Refused as e:
        log(env['log_file'], {**entry, 'result': 'refused', 'why': str(e)})
        return 10, f'fleet-github: refused: {e}'
    except GitHubError as e:
        log(env['log_file'], {**entry, 'result': 'github', 'why': str(e)})
        return 13, f'fleet-github: GitHub: {e}'
    # the log names the token by a short digest only, so two log lines can be matched to one token
    log(env['log_file'], {**entry, 'result': 'ok', 'expires_at': expires,
                          'token_sha256_8': hashlib.sha256(token.encode()).hexdigest()[:8]})
    return 0, token


def caller_name():
    uid = os.environ.get('SUDO_UID')
    try:
        return pwd.getpwuid(int(uid) if uid and uid.isdigit() else os.getuid()).pw_name
    except KeyError:
        return ''


if __name__ == '__main__':
    os.umask(0o077)
    code, out = run(sys.argv[1:], {'config_file': CONFIG_FILE, 'key_file': KEY_FILE, 'log_file': LOG_FILE,
                                   'caller': caller_name(), 'post': real_post})
    (sys.stdout if code == 0 else sys.stderr).write(out + '\n')
    sys.exit(code)
