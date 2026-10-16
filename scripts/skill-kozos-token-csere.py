#!/usr/bin/env python3
# ANSWERS: Mely skillek hivjak meg a vezerlopultot a KOZOS tokennel, es mire cserelem a hivas alakjat?
#
#   python3 -I scripts/skill-kozos-token-csere.py                 # dry run: what it would change, per file
#   python3 -I scripts/skill-kozos-token-csere.py --ir            # write (the main agent; global skills
#                                                                 # are a fleet-level change)
#   python3 -I scripts/skill-kozos-token-csere.py --gyoker DIR    # another skills root (tests)
#
# P0-1, task p0-1-harom-javitas: a skill whose curl reads store/.dashboard-token always shows the
# SHARED token, so every call it makes is `legacy` in the access log and stops working once the
# shared token is narrowed. The replacement presents the CALLING user's own token through a file
# descriptor: `-H @<(bash /home/marveen/marveen/scripts/dashboard-fejlec.sh)`.
#
# Only the exact header forms below are replaced, and only on a command line (curl on it, or a
# continued line); any other mention of the file (prose, a test guard that checks the file exists)
# is listed as LEFT (MARAD), with its line, for a human to judge. A file
# is written only if every replacement in it is one of the known forms, and atomically.
import os
import re
import sys
import tempfile

HEADER = '-H @<(bash /home/marveen/marveen/scripts/dashboard-fejlec.sh)'
FORMS = [
    '-H "Authorization: Bearer $(cat store/.dashboard-token)"',
    '-H "Authorization: Bearer $(cat /home/marveen/marveen/store/.dashboard-token)"',
    '-H "Authorization: Bearer $(cat <install>/store/.dashboard-token)"',
]


def scan(root):
    out = []
    for name in sorted(os.listdir(root)):
        # a symlinked skill DIRECTORY is not followed either (barracuda, #223): its target may be
        # another tree (an agent's own), and writing there is not this script's change
        if os.path.islink(os.path.join(root, name)):
            continue
        p = os.path.join(root, name, 'SKILL.md')
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        text = open(p, encoding='utf-8').read()
        if '.dashboard-token' not in text:
            continue
        lines = text.split('\n')
        n = 0
        for idx, line in enumerate(lines):
            # a command line only (curl on it, or a continued line): the same form in prose
            # describes it, and replacing it there would change what the sentence says
            if 'curl' not in line and not line.rstrip().endswith('\\'):
                continue
            for form in FORMS:
                k = line.count(form)
                if k:
                    repl = HEADER if '<install>' not in form else '-H @<(bash <install>/scripts/dashboard-fejlec.sh)'
                    line = line.replace(form, repl)
                    n += k
            lines[idx] = line
        new = '\n'.join(lines)
        left = [(i + 1, l.strip()[:140]) for i, l in enumerate(new.split('\n')) if '.dashboard-token' in l]
        out.append((p, text, new, n, left))
    return out


def write_atomic(path, text):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.skill-csere-')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)


def main(argv):
    # the main agent's global skills (marveen's home), whoever runs it
    root = '/home/marveen/.claude/skills'
    write = False
    i = 0
    while i < len(argv):
        if argv[i] == '--ir':
            write = True
        elif argv[i] == '--gyoker' and i + 1 < len(argv):
            root = argv[i + 1]
            i += 1
        else:
            print('hasznalat: skill-kozos-token-csere.py [--ir] [--gyoker DIR]', file=sys.stderr)
            return 2
        i += 1
    rows = scan(root)
    total = 0
    for p, old, new, n, left in rows:
        total += n
        print(f'{os.path.basename(os.path.dirname(p))}: {n} csere' + (' (irva)' if write and n else ''))
        for ln, l in left:
            print(f'    MARAD {ln}: {l}')
        if write and n:
            write_atomic(p, new)
    print(f'osszesen {total} csere {len(rows)} skillben' + ('' if write else ' (dry run, semmi nem irodott)'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
