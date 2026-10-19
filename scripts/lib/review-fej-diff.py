"""review-fej-diff: the reviewed diff, made by the REVIEWER'S tool from the full head (the D4 step list E3 (b)).

Called by review-olvas.sh --fej, never by hand:
  review-fej-diff.py <api> <owner/repo> <pr> <head, 40 hex> <out dir> <packet patch>

WHY (acrobot 31441, barracuda #202 review): the guarded approver approves the head the packet's README
names, and the packet is the developer's: its README head line is a claim, and diff.patch is what the
reviewer read. A head with more in it than the diff would pass every check. So the reviewer does not
read the developer's diff: this asks GitHub for the diff OF THAT HEAD, by its full sha, and compares it
with the packet's patch file by file.

Where it comes from: GitHub's own compare (`<base>...<head>`, the diff from the merge base to the head),
anonymously for the public fleet repositories. A PRIVATE repository (PRIVATE_REPOS, today the first
customer project, KratoBal/caparium-napplo) answers 404 to an anonymous call, so for it, and only for
it, a one-hour READ token is asked from the root broker (`fleet-github token <repo> olvas`; Balázs
2026-10-19 10:49 UTC, Eldöntendő msg 1561692771733999658: barracuda reads that one repository, writes
none). The token goes into the request header only: it is never printed, logged or written. Nothing
is written outside the reviewer's own output directory. Before the diff, the PR's CURRENT head must be
the packet's head: a push after packaging is said, not reviewed silently.

Output: the head's diff in <out dir>/<owner>-<repo>-<pr>-<head>.patch (0600, the directory 0700, no
symlinks), its file list, and the comparison, line by line per file (the content, not only the counts).
On a match, and only then, a marker <...>.egyezik next to it (the diff's sha256 and the packet patch's
name); every run removes the old marker first. review-ellenoriz.sh root-records an APPROVE only with it. Exit: 0 the packet's patch is the head's diff; 1 it is not,
or GitHub could not answer (said on stdout, one reason per line); 2 bad arguments.
"""
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import urllib.error
import urllib.request

REPO_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$')
SHA_RX = re.compile(r'^[0-9a-f]{40}$')
MAX_BYTES = 50 * 1024 * 1024


class Stop(Exception):
    pass


# Private repositories: read with the broker's one-hour READ token (see the docstring). A repository
# not named here is read anonymously, as before.
PRIVATE_REPOS = frozenset({'KratoBal/caparium-napplo'})
BROKER = ('sudo', '-n', '/usr/local/sbin/fleet-github', 'token')
TOKEN_RX = re.compile(r'^[A-Za-z0-9_.-]{20,2048}$')  # GitHub's installation tokens are ~390 characters (measured 2026-10-19)


def broker_token(repo, api):
    """The broker's READ token for a private repo, or Stop. A test (an api on 127.0.0.1 only) may name
    its own helper in REVIEW_FEJ_BROKER; against the real GitHub the root broker is the only source."""
    cmd = list(BROKER)
    if api.startswith('http://127.0.0.1:') and os.environ.get('REVIEW_FEJ_BROKER'):
        cmd = [os.environ['REVIEW_FEJ_BROKER']]
    try:
        r = subprocess.run(cmd + [repo, 'olvas'], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Stop(f'a broker nem adott olvaso tokent ({repo}): {e.__class__.__name__}')
    tok = r.stdout.strip()
    if r.returncode != 0 or not TOKEN_RX.match(tok):
        # the broker's own refusal text names no secret; the token itself is never echoed
        raise Stop(f'a broker nem adott olvaso tokent ({repo}): kilepes {r.returncode}, {r.stderr.strip()[:200]}')
    return tok


def get(url, accept, token=None):
    headers = {'Accept': accept, 'User-Agent': 'review-fej-diff', 'X-GitHub-Api-Version': '2022-11-28'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise Stop(f'GitHub HTTP {e.code} for {url.split("/repos/", 1)[-1]}')
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise Stop(f'GitHub did not answer: {e.__class__.__name__}')
    if len(body) > MAX_BYTES:
        raise Stop('the diff is over 50 MB: not read')
    return body


MODE_PREFIXES = ('new file mode ', 'deleted file mode ', 'old mode ', 'new mode ')


def parse_diff(text):
    """{path: {'stats': (added, removed) or (None, None), 'changes': [...], 'modes': [...], 'binary': bool}}.

    The CONTENT is what is compared (barracuda, #229 review: counts alone let a head with another line
    of the same count through): per file, every changed line in order ('+...', '-...' and the
    '\\ No newline' marker), and the mode lines (an executable bit is a change too). Only inside hunks
    (after an @@ line), so a removed '--' line counts and the ---/+++ headers do not.

    AND WHERE: each changed line carries its line number IN THE HEAD FILE (the @@ +c value, counted
    on through the hunk). The same lines in the same order at another place in the file are another
    change (barracuda, #229 review v2: a guard moved into another function). The head side refers to
    the head file in both diffs, so another merge base does not move it; the base side (-a) would, and
    is not compared. The index line names blobs, not changes, and is not compared either."""
    out, cur, in_hunk, at = {}, None, False, 0
    for line in text.split('\n'):
        if line.startswith('diff --git '):
            m = re.match(r'^diff --git a/(.*) b/(.*)$', line)
            path = m.group(2) if m else line[len('diff --git '):]
            cur = out[path] = {'stats': (0, 0), 'changes': [], 'modes': [], 'binary': False}
            in_hunk = False
        elif cur is None:
            continue
        elif line.startswith('@@'):
            m = re.match(r'^@@ -[0-9]+(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@', line)
            if not m:
                raise Stop(f'egy hunk-fejlec nem olvashato: {line[:80]!r}')
            in_hunk, at = True, int(m.group(1))
        elif not in_hunk:
            if line.startswith('Binary files ') or line == 'GIT binary patch':
                cur['binary'] = True
                cur['stats'] = (None, None)
            elif line.startswith(MODE_PREFIXES):
                cur['modes'].append(line)
        elif line[:1] in ('+', '-', '\\'):
            cur['changes'].append((at, line))
            a, d = cur['stats']
            if line[:1] == '+':
                cur['stats'] = (a + 1, d)
                at += 1
            elif line[:1] == '-':
                cur['stats'] = (a, d + 1)
        elif line[:1] == ' ':
            at += 1
    return out


def ensure_private_dir(out_dir):
    try:
        os.mkdir(out_dir, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(out_dir)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Stop(f'the output directory is not mine alone (0700, not a symlink): {out_dir}')


def write_private(out_dir, name, data):
    path = os.path.join(out_dir, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    return path


def compare(head, packet):
    """Lines saying where the packet's patch is not the head's diff; empty when it is."""
    out = []
    for p in sorted(set(head) - set(packet)):
        out.append(f'CSAK A FEJBEN: {p} {head[p]["stats"]}')
    for p in sorted(set(packet) - set(head)):
        out.append(f'CSAK A CSOMAGBAN: {p} {packet[p]["stats"]}')
    for p in sorted(set(head) & set(packet)):
        h, k = head[p], packet[p]
        if h['binary'] or k['binary']:
            out.append(f'BINARIS: {p}: a tartalma szovegkent nem vetheto ossze')
        elif h['modes'] != k['modes']:
            out.append(f'MAS MOD: {p} fej {h["modes"]}, csomag {k["modes"]}')
        elif h['changes'] != k['changes']:
            i = next((n for n, (x, y) in enumerate(zip(h['changes'], k['changes'])) if x != y),
                     min(len(h['changes']), len(k['changes'])))
            where = h['changes'][i][0] if i < len(h['changes']) else '-'
            out.append(f'MAS TARTALOM: {p} (fej {h["stats"]}, csomag {k["stats"]}; az elso elteres a(z) {i + 1}. valtozott sor, a fej {where}. soranal)')
    return out


def run(argv):
    if len(argv) != 6:
        raise ValueError('usage: review-fej-diff.py <api> <owner/repo> <pr> <head> <out dir> <packet patch>')
    api, repo, pr, head, out_dir, patch = argv
    if not REPO_RX.match(repo) or not pr.isdigit() or not SHA_RX.match(head) or not api.startswith(('https://', 'http://127.0.0.1:')):
        raise ValueError(f'bad arguments: {repo} {pr} {head}')
    base_name = f'{repo.replace("/", "-")}-{pr}-{head}'
    # the match marker goes FIRST: whatever happens below, an earlier EGYEZIK for this head does not
    # outlive a run that did not end in one (review-ellenoriz.sh root-records an APPROVE only with it)
    ensure_private_dir(out_dir)
    marker = os.path.join(out_dir, base_name + '.egyezik')
    try:
        os.unlink(marker)
    except FileNotFoundError:
        pass
    lines = []
    token = broker_token(repo, api) if repo in PRIVATE_REPOS else None
    p = json.loads(get(f'{api}/repos/{repo}/pulls/{pr}', 'application/vnd.github+json', token).decode() or '{}')
    now = (p.get('head') or {}).get('sha') or ''
    base = (p.get('base') or {}).get('ref') or ''
    if now != head:
        raise Stop(f'a PR mai feje {now or "?"}, a csomage {head}: a csomagolas utan push jott, ez a csomag elavult')
    if not re.match(r'^[A-Za-z0-9._/-]{1,200}$', base):
        raise Stop(f'a PR alapja nem olvashato: {base!r}')
    diff = get(f'{api}/repos/{repo}/compare/{base}...{head}', 'application/vnd.github.diff', token)
    path = write_private(out_dir, base_name + '.patch', diff)
    hs = parse_diff(diff.decode('utf-8', 'replace'))
    lines.append(f'== a fejbol eloallitott diff (GitHub compare {base}...{head}): {path}')
    for f, v in sorted(hs.items()):
        a, d = v['stats']
        lines.append(f'   bin   {f}' if a is None else f'   +{a:<5} -{d:<5} {f}')
    lines.append(f'   osszesen: {len(hs)} fajl')
    try:
        st = os.lstat(patch)
    except OSError:
        raise Stop(f'a csomag patch-e nincs meg: {patch}')
    if not stat.S_ISREG(st.st_mode):
        raise Stop(f'a csomag patch-e symlink vagy nem fajl: {patch}')
    ps = parse_diff(open(patch, encoding='utf-8', errors='replace').read())
    diffs = compare(hs, ps)
    if diffs:
        lines.append(f'ELTER: a csomag {os.path.basename(patch)} NEM a fej diffje ({len(diffs)} elteres). A fejbol eloallitottat olvasd:')
        lines += ['   ' + d for d in diffs]
        return 1, lines
    digest = hashlib.sha256(diff).hexdigest()
    write_private(out_dir, base_name + '.egyezik', f'{digest}  {os.path.basename(patch)}\n'.encode())
    lines.append(f'EGYEZIK: a csomag {os.path.basename(patch)} sorrol sorra a fej diffje ({len(hs)} fajl); jelolo: {marker}')
    return 0, lines


if __name__ == '__main__':
    os.umask(0o077)
    try:
        code, lines = run(sys.argv[1:])
    except ValueError as e:
        print(f'FAIL: {e}')
        sys.exit(2)
    except (Stop, OSError) as e:
        print(f'FAIL: {e}')
        sys.exit(1)
    print('\n'.join(lines))
    sys.exit(code)
