#!/usr/bin/env python3
"""fleet-bootstrap.sh step 4c and the retired tmux line (B48 (2), docs/fleet-pane.md).

WHAT TURNS THIS RED:
  1. the pinned sha256 in the bootstrap differs from scripts/root/fleet-pane.py: a broker change
     must carry its new pin in the same PR, or every later recreate refuses to install it;
  2. without the /etc/fleet-pane/conf mount the step plans an install (a sudo rule nobody asked for);
  3. with the mount and the pinned source, a dry run does not plan the broker, its start directory
     and its one rule;
  4. a source that is not the pinned version, or a symlink, is planned for install anyway, or the
     step stops the script before step 4b;
  5. with the owner's no-tmux-line marker, step 4 still builds a tmux line; without it, it builds
     none (the old line must stay until the owner retires it);
  6. the generated rule does not parse (checked with visudo -c -f where visudo exists).

Everything runs with --dry-run and a fake FLEET_ROOT: no root, no sudo rule, no install. The mount
is a temp directory (FLEET_PANE_CONF_DRYRUN), and step 4 is entered through a stand-in blanket file
(FLEET_BLANKET_DRYRUN); the bootstrap honours both in dry runs only.
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
SRC = os.path.join(SCRIPTS, 'root', 'fleet-pane.py')
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
    dst = os.path.join(root, 'scripts', 'root', 'fleet-pane.py')
    if link:
        os.symlink(SRC, dst)
    else:
        shutil.copyfile(SRC, dst)
        if alter:
            with open(dst, 'a', encoding='utf-8') as f:
                f.write('\n# changed\n')
    return root


def run(root, conf=None, blanket=None):
    env = dict(os.environ, FLEET_ROOT=root)
    for k in ('FLEET_PANE_CONF_DRYRUN', 'FLEET_BLANKET_DRYRUN', 'FLEET_D4_MOUNT_DRYRUN'):
        env.pop(k, None)
    env['FLEET_PANE_CONF_DRYRUN'] = conf if conf is not None else os.path.join(root, 'no-such-mount')
    env['FLEET_D4_MOUNT_DRYRUN'] = os.path.join(root, 'no-such-mount')
    if blanket is not None:
        env['FLEET_BLANKET_DRYRUN'] = blanket
    r = subprocess.run(['bash', BOOT, '--dry-run'], env=env, capture_output=True, text=True, timeout=120)
    return r.stdout, r.stderr


def section(out, start, end):
    m = re.search(rf'== {re.escape(start)}.*?(?=\n== {re.escape(end)})', out, re.S)
    return m.group(0) if m else ''


TMUX_RULE = re.compile(r'^queued: marveen ALL=\(agent-[a-z]+\) NOPASSWD: /usr/bin/tmux$', re.M)

print('1. the pin matches the file')
pins = re.findall(r'^FP_PIN=([0-9a-f]{64})$', TEXT, re.M)
check('one pin in the bootstrap', len(pins) == 1, str(pins))
check('pin == scripts/root/fleet-pane.py', bool(pins) and pins[0] == sha(SRC), f'file {sha(SRC)}, pin {pins}')

root = fake_root()
blanket = os.path.join(root, 'blanket')
open(blanket, 'w').close()

print('2. without the mount nothing is planned, and the tmux line stays')
out, err = run(root, blanket=blanket)
s = section(out, '4c.', '4b.')
check('step 4c ran', bool(s), out[-400:])
check('says not deployed', 'is not mounted, the broker is not deployed here' in s, s)
check('plans no install', 'DRY:' not in s, s)
check('step 4b still runs', '== 4b.' in out)
s4 = section(out, '4.', '4a.')
check('step 4 builds the tmux lines', len(TMUX_RULE.findall(s4)) >= 6, s4[-600:])
check('step 4 does not say retired', 'retired:' not in s4, s4)

print('3. with the mount and the pinned source: broker, start dir and the rule are planned')
conf = tempfile.mkdtemp(prefix='fleet-pane-conf-')
out, err = run(root, conf=conf, blanket=blanket)
s = section(out, '4c.', '4b.')
check('source recognised as pinned', 'ok: scripts/root/fleet-pane.py is the pinned version' in s, s)
# Where the broker is already installed (a deployed container), 'ok: ... pinned' is the right answer.
check('plans the broker', re.search(r'DRY: (sudo -n )?install -o root -g root -m 0755 \S+ /usr/local/sbin/fleet-pane$', s, re.M) is not None
      or 'ok: /usr/local/sbin/fleet-pane is the pinned version' in s, s)
check('plans the start dir', re.search(r'DRY: (sudo -n )?install -d -o root -g root -m 0755 /etc/fleet-pane /etc/fleet-pane/start$', s, re.M) is not None
      or 'ok: /etc/fleet-pane/start' in s, s)
check('plans the sudoers file', 'DRY: install /etc/sudoers.d/fleet-pane (0440) with:' in s, s)
rules = [line[len('DRY:   '):] for line in s.splitlines() if line.startswith('DRY:   ')]
check('exactly the one rule of the plan (4.1)', [r for r in rules if not r.startswith('#')] == ['marveen ALL=(root) NOPASSWD: /usr/local/sbin/fleet-pane'], rules)
check('step 4b still runs', '== 4b.' in out)
s4 = section(out, '4.', '4a.')
check('mounted but not retired: the tmux lines stay', len(TMUX_RULE.findall(s4)) >= 6, s4[-600:])

print('4. a changed source or a symlink is not planned')
for kind, kw in (('changed', {'alter': True}), ('symlink', {'link': True})):
    bad = fake_root(**kw)
    out, err = run(bad, conf=conf, blanket=blanket)
    s = section(out, '4c.', '4b.')
    check(f'{kind}: says so on stderr', ('MISMATCH: scripts/root/fleet-pane.py' in err) if kind == 'changed'
          else ('is a symlink; not reading or installing it' in err), err[-600:])
    check(f'{kind}: not installed', 'NOT INSTALLED: the broker is deployed' in err and '/usr/local/sbin/fleet-pane' not in s, s)
    check(f'{kind}: step 4b still runs', '== 4b.' in out)
    check(f'{kind}: step 7 counts it', 'FLEET-PANE: step 4c reported a problem above' in err, err[-400:])
    shutil.rmtree(bad)

print('5. the owner retires the tmux line')
open(os.path.join(conf, 'no-tmux-line'), 'w').close()
out, err = run(root, conf=conf, blanket=blanket)
s4 = section(out, '4.', '4a.')
check('step 4 says retired', 'retired: the tmux line' in s4, s4)
check('step 4 builds no tmux line', not TMUX_RULE.findall(s4), TMUX_RULE.findall(s4))
check('the other rules are still built', 'queued: token-read check rule for agent-murena' in s4, s4[-600:])
check('the broker is still planned', 'DRY: install /etc/sudoers.d/fleet-pane (0440) with:' in section(out, '4c.', '4b.'))
out, err = run(root, conf=os.path.join(root, 'no-such-mount'), blanket=blanket)
# A dry run stands a directory in for the mount, so this only shows that the marker is looked for
# INSIDE the conf directory; that a real run asks mountpoint -q is read from the script, not run.
check('no conf directory: nothing is retired', 'retired:' not in section(out, '4.', '4a.'))

print('6. the generated rule parses')
visudo = shutil.which('visudo') or ('/usr/sbin/visudo' if os.path.exists('/usr/sbin/visudo') else None)
if visudo:
    with tempfile.NamedTemporaryFile('w', suffix='.sudoers', delete=False) as f:
        f.write('\n'.join(rules) + '\n')
    r = subprocess.run([visudo, '-c', '-f', f.name], capture_output=True, text=True)
    check('visudo -c -f accepts it', r.returncode == 0 and 'parsed OK' in (r.stdout + r.stderr), r.stdout + r.stderr)
    os.unlink(f.name)
else:
    print('skip visudo is not installed here')

shutil.rmtree(root)
shutil.rmtree(conf)
print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
