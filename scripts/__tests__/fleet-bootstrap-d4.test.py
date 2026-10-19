#!/usr/bin/env python3
"""fleet-bootstrap.sh step 4a: the D4 broker's two root scripts and sudo rule come back after a
container recreate (acrobot 31595, the D4 step list E2).

WHAT TURNS THIS RED:
  1. a pinned sha256 in the bootstrap differs from scripts/root/<file>: a change to either root
     script must carry its new pin in the same PR, or every later recreate refuses to install it;
  2. without the /etc/fleet-github mount the step plans an install (a sudo rule nobody asked for);
  3. with the mount and the pinned sources, a dry run does not plan both scripts and the rule;
  4. a source that is not the pinned version, or a symlink, is planned for install anyway;
  5. the generated sudoers content does not parse (checked with visudo -c -f where visudo exists);
  6. the step stops the script before step 4b (the blanket line removal must always run).

Everything runs with --dry-run and a fake FLEET_ROOT: no root, no sudo rule, no install.
The mount is pointed at a temp directory with FLEET_D4_MOUNT_DRYRUN, which the bootstrap honours
in dry runs only.
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
BOOT = os.path.join(SCRIPTS, 'fleet-bootstrap.sh')
TEXT = open(BOOT, encoding='utf-8').read()
FAILS = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  -- {detail}'))
    if not ok:
        FAILS.append(name)


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def fake_root(alter=None, link=None):
    root = tempfile.mkdtemp(prefix='fleet-root-')
    os.makedirs(os.path.join(root, 'scripts', 'root'))
    os.makedirs(os.path.join(root, 'store'))
    for name in ('fleet-github.py', 'fleet-approve.py'):
        dst = os.path.join(root, 'scripts', 'root', name)
        if name == link:
            os.symlink(os.path.join(SCRIPTS, 'root', name), dst)
            continue
        shutil.copyfile(os.path.join(SCRIPTS, 'root', name), dst)
        if name == alter:
            with open(dst, 'a', encoding='utf-8') as f:
                f.write('\n# changed\n')
    return root


def run(root, mount=None):
    env = dict(os.environ, FLEET_ROOT=root)
    env.pop('FLEET_D4_MOUNT_DRYRUN', None)
    if mount is not None:
        env['FLEET_D4_MOUNT_DRYRUN'] = mount
    r = subprocess.run(['bash', BOOT, '--dry-run'], env=env, capture_output=True, text=True, timeout=120)
    return r.stdout, r.stderr


def step4a(out):
    m = re.search(r'== 4a\..*?(?=\n== 4b\.)', out, re.S)
    return m.group(0) if m else ''


print('1. the pins match the files')
pins = dict((src, want) for src, _dst, want in re.findall(r'\b(fleet-[a-z]+\.py):([a-z-]+):([0-9a-f]{64})', TEXT))
check('two pins in the bootstrap', set(pins) == {'fleet-github.py', 'fleet-approve.py'}, str(pins))
for name, want in pins.items():
    check(f'{name} pin == file', sha(os.path.join(SCRIPTS, 'root', name)) == want,
          f'file {sha(os.path.join(SCRIPTS, "root", name))}, pin {want}')

print('2. without the mount nothing is planned')
root = fake_root()
out, err = run(root, mount=os.path.join(root, 'no-such-mount'))
s = step4a(out)
check('step 4a ran', bool(s), out[-400:])
check('says not deployed', 'is not mounted, D4 is not deployed here' in s, s)
check('plans no install', 'install' not in s.replace('nothing installed', ''), s)
check('step 4b still runs', '== 4b.' in out)

print('3. with the mount and pinned sources: both scripts and the rule are planned')
mount = tempfile.mkdtemp(prefix='fleet-d4-mount-')
out, err = run(root, mount=mount)
s = step4a(out)
for name in ('fleet-github.py', 'fleet-approve.py'):
    check(f'{name} recognised as pinned', f'ok: scripts/root/{name} is the pinned version' in s, s)
for dst in ('fleet-github', 'fleet-approve'):
    check(f'plans {dst}', re.search(rf'DRY: (sudo -n )?install -o root -g root -m 0755 \S+ /usr/local/sbin/{dst}', s) is not None, s)
check('plans the sudoers file', 'DRY: install /etc/sudoers.d/fleet-github (0440) with:' in s, s)
rules = [line[len('DRY:   '):] for line in s.splitlines() if line.startswith('DRY:   ')]
expected = [
    'marveen ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token *',
    'agent-nautilus ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token *',
    'agent-murena ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token *',
    'agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-approve approve *',
    'agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-approve record *',
    'agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token KratoBal/caparium-napplo olvas',
]
check('the six rules, as docs/fleet-github.md step 8', [r for r in rules if not r.startswith('#')] == expected, rules)
check('step 4b still runs', '== 4b.' in out)

print('4. a changed source or a symlink is not planned')
for kind, kw in (('changed', {'alter': 'fleet-github.py'}), ('symlink', {'link': 'fleet-github.py'})):
    bad = fake_root(**kw)
    out, err = run(bad, mount=mount)
    s = step4a(out)
    check(f'{kind}: says so on stderr', ('MISMATCH: scripts/root/fleet-github.py' in err) if kind == 'changed'
          else ('is a symlink; not reading or installing it' in err), err[-600:])
    check(f'{kind}: not installed', 'NOT INSTALLED: D4 is deployed' in err and '/usr/local/sbin/fleet-github' not in s, s)
    check(f'{kind}: step 4b still runs', '== 4b.' in out)
    check(f'{kind}: step 7 counts it', 'D4: step 4a reported a problem above' in err, err[-400:])
    shutil.rmtree(bad)

print('5. the generated rules parse')
visudo = shutil.which('visudo') or ('/usr/sbin/visudo' if os.path.exists('/usr/sbin/visudo') else None)
if visudo:
    with tempfile.NamedTemporaryFile('w', suffix='.sudoers', delete=False) as f:
        f.write('\n'.join(rules) + '\n')
    r = subprocess.run([visudo, '-c', '-f', f.name], capture_output=True, text=True)
    check('visudo -c -f accepts them', r.returncode == 0 and 'parsed OK' in (r.stdout + r.stderr), r.stdout + r.stderr)
    os.unlink(f.name)
else:
    print('skip visudo is not installed here')

shutil.rmtree(root)
shutil.rmtree(mount)
print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
