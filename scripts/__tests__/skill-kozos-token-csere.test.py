#!/usr/bin/env python3
"""scripts/skill-kozos-token-csere.py: the shared-token header leaves the skills' command lines only.

WHAT TURNS THIS RED: a dry run that writes; a command line (curl, or a continued line) left with the
shared-token header; a prose mention rewritten; a remaining mention not listed as MARAD; a written
file that loses its mode; a symlinked SKILL.md followed.
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), 'skill-kozos-token-csere.py')
FAILS = []
OLD = '-H "Authorization: Bearer $(cat store/.dashboard-token)"'
NEW = '-H @<(bash /home/marveen/marveen/scripts/dashboard-fejlec.sh)'


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  -- {detail}'))
    if not ok:
        FAILS.append(name)


def run(root, *args):
    r = subprocess.run([sys.executable, '-I', SCRIPT, '--gyoker', root, *args], capture_output=True, text=True, timeout=30)
    return r.returncode, r.stdout


root = tempfile.mkdtemp(prefix='skillcsere-')
os.makedirs(os.path.join(root, 'proba'))
skill = os.path.join(root, 'proba', 'SKILL.md')
body = '\n'.join([
    'curl -s ' + OLD + ' http://localhost:3420/api/agents',
    'curl -s -X POST \\',
    '  ' + OLD + ' \\',
    '  http://localhost:3420/api/kanban',
    'A `' + OLD + '` alak ures tokent ad, ha a fajl nem olvashato.',
    '',
])
open(skill, 'w').write(body)
os.chmod(skill, 0o640)
other = tempfile.mkdtemp(prefix='skillcsere-cel-')
open(os.path.join(other, 'SKILL.md'), 'w').write('curl ' + OLD + '\n')
os.makedirs(os.path.join(root, 'link'))
os.symlink(os.path.join(other, 'SKILL.md'), os.path.join(root, 'link', 'SKILL.md'))

rc, out = run(root)
check('dry run: exit 0, counts the two command lines', rc == 0 and 'proba: 2 csere' in out, out)
check('dry run writes nothing', open(skill).read() == body)
check('dry run lists the prose line as MARAD', 'MARAD 5:' in out, out)
check('a symlinked SKILL.md is not read', 'link:' not in out, out)

rc, out = run(root, '--ir')
after = open(skill).read().split('\n')
check('the curl line is replaced', after[0] == 'curl -s ' + NEW + ' http://localhost:3420/api/agents', after[0])
check('the continued line is replaced', after[2] == '  ' + NEW + ' \\', after[2])
check('the prose line is untouched', after[4] == body.split('\n')[4], after[4])
check('the mode is kept', oct(os.stat(skill).st_mode & 0o777) == '0o640', oct(os.stat(skill).st_mode))
check('the symlink target is untouched', open(os.path.join(other, 'SKILL.md')).read() == 'curl ' + OLD + '\n')
rc, out = run(root)
check('a second dry run: nothing left to replace, the prose still MARAD', 'proba: 0 csere' in out and 'MARAD 5:' in out, out)

shutil.rmtree(root)
shutil.rmtree(other)
print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
