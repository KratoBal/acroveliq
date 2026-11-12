#!/usr/bin/env python3
"""fleet-bootstrap.sh step 2d: the futtat heavy-run lock file exists at install time (card 744ceb69).

WHAT TURNS THIS RED:
  1. a missing lock file is not planned for creation (0644, as the router user): the first heavy run
     would create it with ITS user's umask, and a 0600 file locks every other agent out of the lock;
  2. a lock file the others can read is touched anyway, or not reported as ok;
  3. a lock file the others cannot read and the router does not own is passed as ok, or the verify step
     does not say MISSING (the others would run without the lock, silently);
  4. a symlink at the lock path is followed, or it stops the script (this runs at the dashboard's
     pre-start: a file somebody put in /tmp must not keep the dashboard down);
  5. the step does not read the same variable as scripts/futtat.py (FUTTAT_NEHEZ_ZAR).

Everything runs with --dry-run and a fake FLEET_ROOT; the lock path is a temp file through
FUTTAT_NEHEZ_ZAR, so the real /tmp/flotta-nehez.lock is never touched.
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
BOOT = os.path.join(SCRIPTS, 'fleet-bootstrap.sh')
FAILS = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  -- {detail}'))
    if not ok:
        FAILS.append(name)


def fake_root():
    root = tempfile.mkdtemp(prefix='fleet-root-')
    os.makedirs(os.path.join(root, 'scripts'))
    os.makedirs(os.path.join(root, 'store'))
    return root


def run(lock):
    root = fake_root()
    env = dict(os.environ, FLEET_ROOT=root, FUTTAT_NEHEZ_ZAR=lock)
    for k in ('FLEET_PANE_CONF_DRYRUN', 'FLEET_BLANKET_DRYRUN', 'FLEET_D4_MOUNT_DRYRUN'):
        env.pop(k, None)
    env['FLEET_PANE_CONF_DRYRUN'] = os.path.join(root, 'no-such-mount')
    env['FLEET_D4_MOUNT_DRYRUN'] = os.path.join(root, 'no-such-mount')
    # stderr in the stdout stream, in order: the NOT SET lines go to stderr and must land inside their step
    r = subprocess.run(['bash', BOOT, '--dry-run'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       text=True, timeout=120)
    return r.stdout, r.returncode


def step_2d(out):
    m = re.search(r'== 2d\..*?(?=\n== 3\.)', out, re.S)
    return m.group(0) if m else ''


tmp = tempfile.mkdtemp(prefix='heavy-lock-')

# 1. missing: planned as the router user would make it, 0644
missing = os.path.join(tmp, 'missing.lock')
out, _ = run(missing)
sec = step_2d(out)
check('missing lock: the step is there', bool(sec), out[-400:])
check('missing lock: planned with mode 0644', f'DRY: install -m 0644 /dev/null {missing}' in sec, sec)
check('missing lock: nothing created in a dry run', not os.path.exists(missing))
check('missing lock: the verify step does not complain', f'MISSING: the heavy-run lock {missing}' not in out, out[-600:])

# 2. readable by the others: ok, untouched
readable = os.path.join(tmp, 'readable.lock')
open(readable, 'w').close()
os.chmod(readable, 0o644)
out, _ = run(readable)
sec = step_2d(out)
check('readable lock: reported ok', f'ok: {readable}' in sec, sec)
check('readable lock: no change planned', 'DRY:' not in sec, sec)

# 3. not readable by the others and not the router's: named, and the verify step says MISSING
closed = os.path.join(tmp, 'closed.lock')
open(closed, 'w').close()
os.chmod(closed, 0o600)
out, _ = run(closed)
sec = step_2d(out)
router_owns = subprocess.run(['id', '-un'], capture_output=True, text=True).stdout.strip() == 'marveen'
if router_owns:
    check('closed lock owned by the router: chmod 0644 planned', f'DRY: chmod 0644 {closed}' in sec, sec)
else:
    check('closed lock of another user: NOT SET with the reason', 'NOT SET' in sec and 'cannot open it' in sec, sec)
    check('closed lock of another user: the verify step says MISSING', f'MISSING: the heavy-run lock {closed}' in out, out[-600:])

# 4. a symlink: not followed, the script goes on to step 3, the verify step says MISSING
target = os.path.join(tmp, 'target')
open(target, 'w').close()
os.chmod(target, 0o600)
link = os.path.join(tmp, 'link.lock')
os.symlink(target, link)
out, _ = run(link)
sec = step_2d(out)
check('symlink: named, not followed', 'is a symlink' in sec and 'DRY: chmod' not in sec and 'DRY: install' not in sec, sec)
check('symlink: the script goes on past the step', '== 3.' in out, out[-400:])
check('symlink: the target keeps its mode', (os.stat(target).st_mode & 0o777) == 0o600)
check('symlink: the verify step says MISSING', f'MISSING: the heavy-run lock {link}' in out, out[-600:])

# 5. the same variable as futtat.py
futtat = open(os.path.join(SCRIPTS, 'futtat.py'), encoding='utf-8').read()
boot = open(BOOT, encoding='utf-8').read()
check('the same variable as futtat.py', 'FUTTAT_NEHEZ_ZAR' in futtat and '${FUTTAT_NEHEZ_ZAR:-/tmp/flotta-nehez.lock}' in boot)

print(f'\n{"FAIL" if FAILS else "OK"}: {len(FAILS)} failed')
sys.exit(1 if FAILS else 0)
