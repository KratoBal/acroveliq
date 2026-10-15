"""github_token(repo, role): the Python twin of scripts/lib/github-token.sh (the owner token's retirement,
PR 1, docs/fleet-github.md). FLEET_GITHUB_APP=on asks the root broker for a one-hour token for the one
repository and role; off (the default) reads the owner token file, as before. Raises GithubTokenError
instead of returning an empty token."""
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
    if os.environ.get('FLEET_GITHUB_APP', 'off') == 'on':
        r = subprocess.run(SUDO + [BROKER, 'token', repo, role], capture_output=True, text=True)
        tok = r.stdout.strip()
        if r.returncode != 0 or not tok:
            raise GithubTokenError(f'the broker gave no {role} token for {repo}')
        return tok
    path = owner_file or OWNER_TOKEN_FILE
    try:
        tok = open(path, encoding='utf-8').read().strip()
    except OSError as e:
        raise GithubTokenError(f'the owner token is not readable: {path} ({e.__class__.__name__})')
    if not tok:
        raise GithubTokenError('the owner token file is empty')
    return tok
