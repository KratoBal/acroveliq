"""review-fej-diff: the reviewed diff, made by the REVIEWER'S tool from the full head (the D4 step list E3 (b)).

Called by review-olvas.sh --fej, never by hand:
  review-fej-diff.py <api> <owner/repo> <pr> <head, 40 hex> <out dir> <packet patch>

WHY (acrobot 31441, barracuda #202 review): the guarded approver approves the head the packet's README
names, and the packet is the developer's: its README head line is a claim, and diff.patch is what the
reviewer read. A head with more in it than the diff would pass every check. So the reviewer does not
read the developer's diff: this asks GitHub for the diff OF THAT HEAD, by its full sha, and compares it
with the packet's patch file by file.

Where it comes from: GitHub's own compare (`<base>...<head>`, the diff from the merge base to the head),
anonymously. The four fleet repositories are public; no token is held or asked for here, and nothing
is written outside the reviewer's own output directory. Before the diff, the PR's CURRENT head must be
the packet's head: a push after packaging is said, not reviewed silently.

Output: the head's diff in <out dir>/<owner>-<repo>-<pr>-<head>.patch (0600, the directory 0700, no
symlinks), its file list, and the comparison. Exit: 0 the packet's patch is the head's diff; 1 it is not,
or GitHub could not answer (said on stdout, one reason per line); 2 bad arguments.
"""
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.request

REPO_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$')
SHA_RX = re.compile(r'^[0-9a-f]{40}$')
MAX_BYTES = 50 * 1024 * 1024


class Stop(Exception):
    pass


def get(url, accept):
    req = urllib.request.Request(url, headers={'Accept': accept, 'User-Agent': 'review-fej-diff',
                                               'X-GitHub-Api-Version': '2022-11-28'})
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


def file_stats(text):
    """{path: (added, removed)} of a unified git diff; a binary file is (None, None).

    Counts only inside hunks (after an @@ line), so a removed line that starts with '--' or an added
    one that starts with '++' is counted, and the ---/+++ headers are not."""
    out, path, in_hunk = {}, None, False
    for line in text.split('\n'):
        if line.startswith('diff --git '):
            m = re.match(r'^diff --git a/(.*) b/(.*)$', line)
            path = m.group(2) if m else line[len('diff --git '):]
            out[path] = (0, 0)
            in_hunk = False
        elif path is None:
            continue
        elif line.startswith('@@'):
            in_hunk = True
        elif not in_hunk:
            if line.startswith('Binary files ') or line == 'GIT binary patch':
                out[path] = (None, None)
        elif line.startswith('+'):
            a, d = out[path]
            out[path] = (a + 1, d)
        elif line.startswith('-'):
            a, d = out[path]
            out[path] = (a, d + 1)
    return out


def write_private(out_dir, name, data):
    try:
        os.mkdir(out_dir, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(out_dir)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Stop(f'the output directory is not mine alone (0700, not a symlink): {out_dir}')
    path = os.path.join(out_dir, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
    return path


def compare(head, packet):
    """Lines saying where the packet's patch is not the head's diff; empty when it is."""
    out = []
    for p in sorted(set(head) - set(packet)):
        out.append(f'CSAK A FEJBEN: {p} {head[p]}')
    for p in sorted(set(packet) - set(head)):
        out.append(f'CSAK A CSOMAGBAN: {p} {packet[p]}')
    for p in sorted(set(head) & set(packet)):
        if head[p] != packet[p]:
            out.append(f'MAS SZAMOK: {p} fej {head[p]}, csomag {packet[p]}')
    return out


def run(argv):
    if len(argv) != 6:
        raise ValueError('usage: review-fej-diff.py <api> <owner/repo> <pr> <head> <out dir> <packet patch>')
    api, repo, pr, head, out_dir, patch = argv
    if not REPO_RX.match(repo) or not pr.isdigit() or not SHA_RX.match(head) or not api.startswith(('https://', 'http://127.0.0.1:')):
        raise ValueError(f'bad arguments: {repo} {pr} {head}')
    lines = []
    p = json.loads(get(f'{api}/repos/{repo}/pulls/{pr}', 'application/vnd.github+json').decode() or '{}')
    now = (p.get('head') or {}).get('sha') or ''
    base = (p.get('base') or {}).get('ref') or ''
    if now != head:
        raise Stop(f'a PR mai feje {now or "?"}, a csomage {head}: a csomagolas utan push jott, ez a csomag elavult')
    if not re.match(r'^[A-Za-z0-9._/-]{1,200}$', base):
        raise Stop(f'a PR alapja nem olvashato: {base!r}')
    diff = get(f'{api}/repos/{repo}/compare/{base}...{head}', 'application/vnd.github.diff')
    name = f'{repo.replace("/", "-")}-{pr}-{head}.patch'
    path = write_private(out_dir, name, diff)
    hs = file_stats(diff.decode('utf-8', 'replace'))
    lines.append(f'== a fejbol eloallitott diff (GitHub compare {base}...{head}): {path}')
    for f, (a, d) in sorted(hs.items()):
        lines.append(f'   bin   {f}' if a is None else f'   +{a:<5} -{d:<5} {f}')
    lines.append(f'   osszesen: {len(hs)} fajl')
    try:
        st = os.lstat(patch)
    except OSError:
        raise Stop(f'a csomag patch-e nincs meg: {patch}')
    if not stat.S_ISREG(st.st_mode):
        raise Stop(f'a csomag patch-e symlink vagy nem fajl: {patch}')
    ps = file_stats(open(patch, encoding='utf-8', errors='replace').read())
    diffs = compare(hs, ps)
    if diffs:
        lines.append(f'ELTER: a csomag {os.path.basename(patch)} NEM a fej diffje ({len(diffs)} elteres). A fejbol eloallitottat olvasd:')
        lines += ['   ' + d for d in diffs]
        return 1, lines
    lines.append(f'EGYEZIK: a csomag {os.path.basename(patch)} fajlonkent a fej diffje ({len(hs)} fajl)')
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
