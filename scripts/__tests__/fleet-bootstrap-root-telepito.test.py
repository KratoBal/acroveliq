#!/usr/bin/env python3
"""fleet-bootstrap.sh step 4d (the root installer) and its handover with step 4c (docs/root-telepito.md).

WHAT TURNS THIS RED:
  1. the pinned sha256 in the bootstrap differs from scripts/root/root-telepito.py: an installer change must
     carry its new pin in the same PR (the installer is not its own target);
  2. without the /etc/root-telepito/conf mount the step plans an install (a sudo rule nobody asked for);
  3. with the mount and the pinned source, a dry run does not plan the script, its five exact rules and the
     helyreallit run;
  4. a changed source or a symlink is planned for install anyway, or the step stops the script before 4b;
  5. a fleet-pane target the installer's list names is still installed from the pin by step 4c (the pinned
     copy would overwrite an approved newer one at every recreate), or one it does not name is skipped;
  6. the generated rules do not parse (checked with visudo -c -f where visudo exists).

Everything runs with --dry-run and a fake FLEET_ROOT; the mounts are temp directories (the bootstrap honours
ROOT_TELEPITO_CONF_DRYRUN, FLEET_PANE_CONF_DRYRUN and FLEET_BLANKET_DRYRUN in dry runs only).
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import hashlib
import json
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
SRC = os.path.join(SCRIPTS, 'root', 'root-telepito.py')
FP_SRC = os.path.join(SCRIPTS, 'root', 'fleet-pane.py')
FAILS = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  -- {detail}'))
    if not ok:
        FAILS.append(name)


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def fake_root(alter=False, link=False):
    root = tempfile.mkdtemp(prefix='fleet-root-')
    os.makedirs(os.path.join(root, 'scripts', 'root'))
    os.makedirs(os.path.join(root, 'store'))
    shutil.copyfile(FP_SRC, os.path.join(root, 'scripts', 'root', 'fleet-pane.py'))
    dst = os.path.join(root, 'scripts', 'root', 'root-telepito.py')
    if link:
        os.symlink(SRC, dst)
    else:
        shutil.copyfile(SRC, dst)
        if alter:
            with open(dst, 'a', encoding='utf-8') as f:
                f.write('\n# changed\n')
    return root


def run(root, rt_conf=None, fp_conf=None, blanket=None):
    env = dict(os.environ, FLEET_ROOT=root)
    none = os.path.join(root, 'no-such-mount')
    env['ROOT_TELEPITO_CONF_DRYRUN'] = rt_conf or none
    env['FLEET_PANE_CONF_DRYRUN'] = fp_conf or none
    env['FLEET_D4_MOUNT_DRYRUN'] = none
    if blanket is not None:
        env['FLEET_BLANKET_DRYRUN'] = blanket
    r = subprocess.run(['bash', BOOT, '--dry-run'], env=env, capture_output=True, text=True, timeout=120)
    return r.stdout, r.stderr


def section(out, start, end):
    m = re.search(rf'== {re.escape(start)}.*?(?=\n== {re.escape(end)})', out, re.S)
    return m.group(0) if m else ''


def rt_conf_with(targets):
    d = tempfile.mkdtemp(prefix='rt-conf-')
    with open(os.path.join(d, 'lista.json'), 'w') as f:
        json.dump({'celok': [{'kulcs': 'k%d' % i, 'cel': t} for i, t in enumerate(targets)]}, f)
    return d


RULES = ['marveen ALL=(root) NOPASSWD: /usr/local/sbin/root-telepito kerj *',
         'marveen ALL=(root) NOPASSWD: /usr/local/sbin/root-telepito kerj-vissza *',
         'marveen ALL=(root) NOPASSWD: /usr/local/sbin/root-telepito vegrehajt *',
         'marveen ALL=(root) NOPASSWD: /usr/local/sbin/root-telepito allapot',
         'marveen ALL=(root) NOPASSWD: /usr/local/sbin/root-telepito helyreallit']

print('1. the pin matches the file')
pins = re.findall(r'^RT_PIN=([0-9a-f]{64})$', TEXT, re.M)
check('one pin in the bootstrap', len(pins) == 1, str(pins))
check('pin == scripts/root/root-telepito.py', bool(pins) and pins[0] == sha(SRC), f'file {sha(SRC)}, pin {pins}')

root = fake_root()
blanket = os.path.join(root, 'blanket')
open(blanket, 'w').close()

print('2. without the mount nothing is planned')
out, err = run(root, blanket=blanket)
s = section(out, '4d.', '4b.')
check('step 4d ran', bool(s), out[-400:])
check('says not deployed', 'is not mounted, the installer is not deployed here' in s, s)
check('plans nothing', 'DRY:' not in s, s)
check('step 4b still runs', '== 4b.' in out)

print('3. with the mount and the pinned source: the script, five exact rules, helyreallit')
conf = rt_conf_with([])
out, err = run(root, rt_conf=conf, blanket=blanket)
s = section(out, '4d.', '4b.')
check('source recognised as pinned', 'ok: scripts/root/root-telepito.py is the pinned version' in s, s)
check('plans the script', re.search(r'DRY: (sudo -n )?install -o root -g root -m 0755 \S+ /usr/local/sbin/root-telepito$', s, re.M) is not None
      or 'ok: /usr/local/sbin/root-telepito is the pinned version' in s, s)
rules = [line[len('DRY:   '):] for line in s.splitlines() if line.startswith('DRY:   ')]
check('exactly the five rules', [r for r in rules if not r.startswith('#')] == RULES, rules)
check('plans helyreallit', 'DRY: /usr/local/sbin/root-telepito helyreallit' in s, s)
check('step 4b still runs', '== 4b.' in out)

print('4. a changed source or a symlink is not planned')
for kind, kw in (('changed', {'alter': True}), ('symlink', {'link': True})):
    bad = fake_root(**kw)
    out, err = run(bad, rt_conf=conf, blanket=blanket)
    s = section(out, '4d.', '4b.')
    check(f'{kind}: says so on stderr', ('MISMATCH: scripts/root/root-telepito.py' in err) if kind == 'changed'
          else ('is a symlink; not reading or installing it' in err), err[-600:])
    check(f'{kind}: not installed', 'NOT INSTALLED: the installer is deployed' in err and 'DRY:' not in s, s)
    check(f'{kind}: step 4b still runs', '== 4b.' in out)
    check(f'{kind}: step 7 counts it', 'ROOT-TELEPITO: step 4d reported a problem above' in err, err[-400:])
    shutil.rmtree(bad)

print('5. one owner per target: what the list names, 4c leaves alone')
fp_conf = tempfile.mkdtemp(prefix='fleet-pane-conf-')
handed = rt_conf_with(['/usr/local/sbin/fleet-pane', '/etc/sudoers.d/fleet-pane'])
out, err = run(root, rt_conf=handed, fp_conf=fp_conf, blanket=blanket)
s = section(out, '4c.', '4d.')
check('the broker is skipped as root-telepito\'s', "skip: /usr/local/sbin/fleet-pane is root-telepito's" in s, s)
check('its sudo rule is skipped as root-telepito\'s', "skip: /etc/sudoers.d/fleet-pane is root-telepito's" in s, s)
check('no pinned install of either is planned', 'DRY: install /etc/sudoers.d/fleet-pane' not in s
      and not re.search(r'install -o root -g root -m 0755 \S+ /usr/local/sbin/fleet-pane$', s, re.M), s)
out, err = run(root, rt_conf=conf, fp_conf=fp_conf, blanket=blanket)
s = section(out, '4c.', '4d.')
check('a list that does not name it: 4c keeps it', "root-telepito's" not in s, s)

print('6. the generated rules parse')
visudo = shutil.which('visudo') or ('/usr/sbin/visudo' if os.path.exists('/usr/sbin/visudo') else None)
if visudo:
    with tempfile.NamedTemporaryFile('w', suffix='.sudoers', delete=False) as f:
        f.write('\n'.join(RULES) + '\n')
    r = subprocess.run([visudo, '-c', '-f', f.name], capture_output=True, text=True)
    check('visudo -c -f accepts them', r.returncode == 0 and 'parsed OK' in (r.stdout + r.stderr), r.stdout + r.stderr)
    os.unlink(f.name)
else:
    print('skip visudo is not installed here')

for d in (root, conf, fp_conf, handed):
    shutil.rmtree(d)
print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
