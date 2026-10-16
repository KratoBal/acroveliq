"""github_token(repo, role): the Python twin of scripts/lib/github-token.sh (the owner token's retirement,
PR 1, docs/fleet-github.md). By default (unset, or anything but off) it asks the root broker for a
one-hour token for the one repository and role; FLEET_GITHUB_APP=off reads the owner token file (the
explicit rollback; the default is the broker since 2026-10-16, acrobot 32199). Raises GithubTokenError,
with the broker's own reason, instead of returning an empty token or falling back to the owner token."""
import os
import re
import subprocess

OWNER_TOKEN_FILE = '/home/marveen/marveen/store/.github-token'
BROKER = '/usr/local/sbin/fleet-github'
SUDO = ['sudo', '-n']
ROLES = ('olvas', 'push', 'pr', 'beolvaszt')
REPO_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$')


class GithubTokenError(Exception):
    pass


def github_token(repo, role, owner_file=None):
    if not REPO_RX.match(repo or '') or role not in ROLES:
        raise GithubTokenError(f'bad repo or role: {repo} {role}')
    if os.environ.get('FLEET_GITHUB_APP', 'on') != 'off':
        r = subprocess.run(SUDO + [BROKER, 'token', repo, role], capture_output=True, text=True)
        tok = r.stdout.strip()
        if r.returncode != 0 or not tok:
            why = (r.stderr or '').strip()[:200] or f'exit {r.returncode}'
            raise GithubTokenError(f'the broker gave no {role} token for {repo}: {why}')
        return tok
    path = owner_file or OWNER_TOKEN_FILE
    try:
        tok = open(path, encoding='utf-8').read().strip()
    except OSError as e:
        raise GithubTokenError(f'the owner token is not readable: {path} ({e.__class__.__name__})')
    if not tok:
        raise GithubTokenError('the owner token file is empty')
    return tok
