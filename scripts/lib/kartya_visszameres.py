"""A kanban card's re-measurement against the main branch (T6.5 PR2, card b3d8174e).

A card's `basis` says what its claim rests on: one reference per line, `repo:path` or `repo:path#name`
(`repo` an alias or `owner/repo`). The check asks the GitHub contents API for each file on `main`:

  the file is not there                  DIVERGED  (the claim rests on something that no longer exists)
  the file is there, the `#name` is not  DIVERGED  (the function or constant it names is gone from that file)
  everything the card names is there     OK
  it could not be looked at              UNKNOWN   (network, token, rate limit, a malformed reference, or no
                                                    machine-readable line at all)

DIVERGED wins over UNKNOWN: one reference that is certainly gone is a divergence whatever else could not be
checked. UNKNOWN is never OK: a check that could not look must not read as a check that passed.

What this does NOT measure, and says so: a free-text line (a query, a sentence such as "the button is
disabled") is not checked by a machine. A card whose basis has only such lines is UNKNOWN, with that reason.
The `#name` test is a whole-word search of the file, not a parse: it finds a name that is only in a comment,
and it cannot tell two functions of the same name apart. It catches the obvious case (the file or the name is gone).

Pure functions plus a thin fetcher, so the rules are tested without a network."""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ALIASES = {
    'os': 'KratoBal/acropora-os',
    'commerce': 'KratoBal/acropora-commerce',
    'cap': 'KratoBal/caparium-napplo',
    'caparium': 'KratoBal/caparium-napplo',
    'ai': 'KratoBal/acropora-ai-agent',
    'marveen': 'KratoBal/acroveliq',
    'acroveliq': 'KratoBal/acroveliq',
}
OWNER_REPO = r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}'
REF_RX = re.compile(rf'^(?P<repo>{OWNER_REPO}|[a-z][a-z0-9-]*):(?P<path>[^\s#:][^\s#]*)(?:#(?P<name>[A-Za-z_$][\w$.-]*))?$')
BRANCH = 'main'
NOTE_MAX = 480


def parse_basis(text):
    """-> (refs, free_lines, invalid). refs: [(alias_as_written, repo, path, name|None)]; free_lines are the lines
    that are not a reference at all (kept so the result can say a machine did not check them); invalid are
    reference-shaped lines that cannot be checked (an unsafe path)."""
    refs, free, invalid = [], [], []
    for raw in (text or '').splitlines():
        line = raw.strip()
        if not line:
            continue
        m = REF_RX.match(line)
        if not m:
            free.append(line)
            continue
        alias = m.group('repo')
        repo = alias if '/' in alias else ALIASES.get(alias)
        if repo is None:
            free.append(line)
            continue
        path = m.group('path')
        if path.startswith('/') or '..' in path.split('/'):
            invalid.append(line)
            continue
        refs.append((alias, repo, path, m.group('name')))
    return refs, free, invalid


def name_in(body, name):
    return re.search(r'(?<![\w$])' + re.escape(name) + r'(?![\w$])', body) is not None


def check_ref(ref, fetch):
    """-> (result, note) for one reference. fetch(repo, path) -> (status, text); status None = could not look."""
    alias, repo, path, name = ref
    status, body = fetch(repo, path)
    shown = f'{alias}:{path}'
    if status == 404:
        return 'DIVERGED', f'{shown} nincs a {BRANCH} ágon'
    if status != 200 or body is None:
        return 'UNKNOWN', f'{shown}: nem sikerült megnézni (HTTP {status if status is not None else "?"})'
    if name and not name_in(body, name):
        return 'DIVERGED', f'{shown}: a(z) {name} nincs a fájlban'
    return 'OK', ''


def measure(basis_text, fetch):
    """-> None when the card has no basis at all, else (result, note)."""
    refs, free, invalid = parse_basis(basis_text)
    if not refs and not free and not invalid:
        return None
    diverged, unknown = [], []
    for ref in refs:
        result, note = check_ref(ref, fetch)
        if result == 'DIVERGED':
            diverged.append(note)
        elif result == 'UNKNOWN':
            unknown.append(note)
    unknown += [f'nem ellenőrizhető hivatkozás: {line}' for line in invalid]
    if diverged:
        result, parts = 'DIVERGED', diverged
    elif unknown:
        result, parts = 'UNKNOWN', unknown
    elif not refs:
        result, parts = 'UNKNOWN', ['nincs gépi sor: csak szabad szöveg, azt gép nem méri']
    else:
        result, parts = 'OK', [f'{len(refs)} hivatkozás igaz a {BRANCH} ágon']
    if free and result != 'DIVERGED' and refs:
        parts = parts + [f'{len(free)} szabad szöveges sort gép nem mért']
    note = '; '.join(parts)
    return result, note if len(note) <= NOTE_MAX else note[: NOTE_MAX - 1] + '…'


def github_fetcher(token_for, api_base='https://api.github.com', timeout=20):
    """A fetch(repo, path) over the contents API, the raw media type, one token per repository (the broker's token
    covers exactly one). Any failure to look, including a refused token, is status None: UNKNOWN, never a guess."""
    tokens = {}

    def fetch(repo, path):
        if repo not in tokens:
            try:
                tokens[repo] = token_for(repo)
            except Exception:  # the broker said no: say we could not look
                tokens[repo] = None
        token = tokens[repo]
        if not token:
            return None, None
        url = f'{api_base}/repos/{repo}/contents/{urllib.parse.quote(path)}?ref={BRANCH}'
        req = urllib.request.Request(url, headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.github.raw',
            'X-GitHub-Api-Version': '2022-11-28',
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            return None, None

    return fetch


def main(argv=None, stdin=None, stdout=None):
    """stdin: the card's basis text. stdout: ONE JSON line {"result", "note"}, or {"result": null} when the card
    has no basis. The exit code is 0 for every outcome the caller reads from the JSON."""
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    from github_token import github_token  # noqa: E402

    owner_file = os.environ.get('KARTYA_VISSZAMERES_TOKEN_FILE')  # only read when FLEET_GITHUB_APP=off (the rollback)
    api_base = os.environ.get('KARTYA_VISSZAMERES_GITHUB_API', 'https://api.github.com')
    fetch = github_fetcher(lambda repo: github_token(repo, 'olvas', owner_file), api_base)
    outcome = measure(stdin.read(), fetch)
    stdout.write(json.dumps({'result': None} if outcome is None else {'result': outcome[0], 'note': outcome[1]}) + '\n')
    return 0
