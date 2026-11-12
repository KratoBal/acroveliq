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
  7. step 2d (card 744ceb69): a missing heavy-run lock file is not planned 0644 as the router user; a
     readable one is touched; another user's unreadable one or a symlink passes as ok, is followed, or
     stops the script; the verify step does not say MISSING for them; or the step reads another
     variable than scripts/futtat.py (FUTTAT_NEHEZ_ZAR). Kept in this file because CI runs it by name.
  8. step 2e (card 30ecba56): an agent without a git config does not get the empty helper line, the broker's
     helper and credential.useHttpPath planned; a config the step itself wrote is not reported ok (it would be
     rewritten on every start); an agent's own helper or useHttpPath is rewritten or its value printed; a
     symlinked, unreadable or unparsable .gitconfig or a missing home passes as ok, is followed, or stops the
     script, or the verify step does not say MISSING for it; outside root (the tree's copy at the dashboard's
     pre-start) the step does anything but skip quietly; or the agent list differs from step 4a's pushers; or a list
     holding only the empty line (our first write without the second) is kept instead of completed.

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
s = section(out, '4c.', '4d.')
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
s = section(out, '4c.', '4d.')
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
    s = section(out, '4c.', '4d.')
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
check('the broker is still planned', 'DRY: install /etc/sudoers.d/fleet-pane (0440) with:' in section(out, '4c.', '4d.'))
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

print('7. step 2d: the heavy-run lock file (card 744ceb69)')


def run_lock(lock):
    """A dry run with the lock path in a temp dir (FUTTAT_NEHEZ_ZAR): the real /tmp/flotta-nehez.lock is never touched.
    stderr in the stdout stream, in order: the NOT SET lines go to stderr and must land inside their step."""
    lroot = fake_root()
    env = dict(os.environ, FLEET_ROOT=lroot, FUTTAT_NEHEZ_ZAR=lock)
    for k in ('FLEET_PANE_CONF_DRYRUN', 'FLEET_BLANKET_DRYRUN', 'FLEET_D4_MOUNT_DRYRUN'):
        env.pop(k, None)
    env['FLEET_PANE_CONF_DRYRUN'] = os.path.join(lroot, 'no-such-mount')
    env['FLEET_D4_MOUNT_DRYRUN'] = os.path.join(lroot, 'no-such-mount')
    r = subprocess.run(['bash', BOOT, '--dry-run'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       text=True, timeout=120)
    shutil.rmtree(lroot)
    return r.stdout


def step_2d(text):
    m = re.search(r'== 2d\..*?(?=\n== 2e\.)', text, re.S)
    return m.group(0) if m else ''


ltmp = tempfile.mkdtemp(prefix='heavy-lock-')

missing = os.path.join(ltmp, 'missing.lock')
lout = run_lock(missing)
sec = step_2d(lout)
check('2d missing lock: the step is there', bool(sec), lout[-400:])
check('2d missing lock: planned with mode 0644', f'DRY: install -m 0644 /dev/null {missing}' in sec, sec)
check('2d missing lock: nothing created in a dry run', not os.path.exists(missing))
check('2d missing lock: the verify step does not complain', f'MISSING: the heavy-run lock {missing}' not in lout, lout[-600:])

readable = os.path.join(ltmp, 'readable.lock')
open(readable, 'w').close()
os.chmod(readable, 0o644)
sec = step_2d(run_lock(readable))
check('2d readable lock: reported ok', f'ok: {readable}' in sec, sec)
check('2d readable lock: no change planned', 'DRY:' not in sec, sec)

closed = os.path.join(ltmp, 'closed.lock')
open(closed, 'w').close()
os.chmod(closed, 0o600)
lout = run_lock(closed)
sec = step_2d(lout)
if subprocess.run(['id', '-un'], capture_output=True, text=True).stdout.strip() == 'marveen':
    check('2d closed lock owned by the router: chmod 0644 planned', f'DRY: chmod 0644 {closed}' in sec, sec)
else:
    check('2d closed lock of another user: NOT SET with the reason', 'NOT SET' in sec and 'cannot open it' in sec, sec)
    check('2d closed lock of another user: the verify step says MISSING', f'MISSING: the heavy-run lock {closed}' in lout, lout[-600:])

target = os.path.join(ltmp, 'target')
open(target, 'w').close()
os.chmod(target, 0o600)
link = os.path.join(ltmp, 'link.lock')
os.symlink(target, link)
lout = run_lock(link)
sec = step_2d(lout)
check('2d symlink: named, not followed', 'is a symlink' in sec and 'DRY: chmod' not in sec and 'DRY: install' not in sec, sec)
check('2d symlink: the script goes on past the step', '== 3.' in lout, lout[-400:])
check('2d symlink: the target keeps its mode', (os.stat(target).st_mode & 0o777) == 0o600)
check('2d symlink: the verify step says MISSING', f'MISSING: the heavy-run lock {link}' in lout, lout[-600:])

futtat = open(os.path.join(SCRIPTS, 'futtat.py'), encoding='utf-8').read()
check('2d the same variable as futtat.py',
      'FUTTAT_NEHEZ_ZAR' in futtat and '${FUTTAT_NEHEZ_ZAR:-/tmp/flotta-nehez.lock}' in TEXT)
shutil.rmtree(ltmp)

print('8. step 2e: the pushing agents\' git credential helper (card 30ecba56)')
HELPER_LINE = re.compile(r'^GIT_AGENTS="([a-z ]+)"$', re.M)


def run_git(homes, hook=True):
    """A dry run with the agents' homes in a temp dir (FLEET_GIT_HOME_DRYRUN), stderr in order with stdout. One fake
    root for the whole section: the helper path is under it, and the second run must see the first run's path."""
    env = dict(os.environ, FLEET_ROOT=groot)
    for k in ('FLEET_PANE_CONF_DRYRUN', 'FLEET_BLANKET_DRYRUN', 'FLEET_D4_MOUNT_DRYRUN', 'FLEET_GIT_HOME_DRYRUN'):
        env.pop(k, None)
    env['FLEET_PANE_CONF_DRYRUN'] = os.path.join(groot, 'no-such-mount')
    env['FLEET_D4_MOUNT_DRYRUN'] = os.path.join(groot, 'no-such-mount')
    if hook:
        env['FLEET_GIT_HOME_DRYRUN'] = homes
    r = subprocess.run(['bash', BOOT, '--dry-run'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       text=True, timeout=120)
    return r.stdout, os.path.join(groot, 'scripts', 'git-credential-fleet-github')


def step_2e(text):
    m = re.search(r'== 2e\..*?(?=\n== 3\.)', text, re.S)
    return m.group(0) if m else ''


def agent_lines(sec, user):
    return '\n'.join(l for l in sec.splitlines() if f'{user} ' in l or f'/{user}/' in l or l.endswith(f'/{user}'))


def git_set(path, *args):
    subprocess.run(['git', 'config', '--file', path, *args], check=True)


groot = fake_root()
gtmp = tempfile.mkdtemp(prefix='git-homes-')
for u in ('agent-nautilus', 'agent-murena'):
    os.makedirs(os.path.join(gtmp, u))
nau = os.path.join(gtmp, 'agent-nautilus', '.gitconfig')
mur = os.path.join(gtmp, 'agent-murena', '.gitconfig')

gout, helper = run_git(gtmp)
sec = step_2e(gout)
n = agent_lines(sec, 'agent-nautilus')
check('2e no config: the step is there', bool(sec), gout[-400:])
check('2e no config: the empty helper line is planned', f"DRY: as_agent agent-nautilus git config --file {nau} --add credential.helper " + '\n' in n + '\n', n)
check('2e no config: then the broker helper', f'DRY: as_agent agent-nautilus git config --file {nau} --add credential.helper {helper}' in n, n)
check('2e no config: the empty line comes first',
      n.find('--add credential.helper \n') != -1 and n.find('--add credential.helper \n') < n.find(f'--add credential.helper {helper}'), n)
check('2e no config: useHttpPath true is planned', f'DRY: as_agent agent-nautilus git config --file {nau} credential.useHttpPath true' in n, n)
check('2e no config: both pushing agents', 'DRY: as_agent agent-murena git config' in sec, sec)
check('2e no config: nothing written in a dry run', not os.path.exists(nau) and not os.path.exists(mur))
check('2e no config: the verify step does not complain', 'MISSING: an agent\'s git credential helper' not in gout, gout[-600:])

# what the step writes, written with git itself the same way, must read back as ok (or every start rewrites it)
git_set(nau, '--add', 'credential.helper', '')
git_set(nau, '--add', 'credential.helper', helper)
git_set(nau, 'credential.useHttpPath', 'true')
# murena: an own helper and an own useHttpPath; their values must not be printed
git_set(mur, '--add', 'credential.helper', 'store --file /x/titok-helyett')
git_set(mur, 'credential.useHttpPath', 'false')
gout, helper2 = run_git(gtmp)
check('2e the same helper path in both runs', helper2 == helper)
sec = step_2e(gout)
n = agent_lines(sec, 'agent-nautilus')
m = agent_lines(sec, 'agent-murena')
check('2e our config: ok, nothing planned', 'ok: agent-nautilus credential.helper' in n and 'ok: agent-nautilus credential.useHttpPath' in n
      and 'DRY:' not in n, n)
check('2e own helper: kept and counted', 'kept: agent-murena has 1 credential.helper line(s) of its own' in m, m)
check('2e own useHttpPath: kept', 'kept: agent-murena credential.useHttpPath is false' in m, m)
check('2e own settings: nothing planned for that agent', 'DRY:' not in m, m)
check('2e own helper: its value is not printed', 'titok-helyett' not in gout, sec)
check('2e own settings: not a failure', 'MISSING: an agent\'s git credential helper' not in gout, gout[-600:])

# murena's file a symlink, nautilus's unreadable (as a non-root test; root reads everything, so it is skipped there)
os.unlink(mur)
target = os.path.join(gtmp, 'target')
open(target, 'w').close()
os.symlink(target, mur)
os.chmod(nau, 0o000)
gout, _ = run_git(gtmp)
sec = step_2e(gout)
check('2e symlink: named, not followed', 'NOT SET: ' + mur + ' is a symlink' in sec and 'DRY: as_agent agent-murena' not in sec, sec)
check('2e symlink: the target is untouched', os.path.getsize(target) == 0)
if os.geteuid() != 0:
    check('2e unreadable: named, nothing written over it', f'NOT SET: {nau} cannot be read' in sec and 'DRY: as_agent agent-nautilus' not in sec, sec)
check('2e problems: the script goes on past the step', '== 3.' in gout, gout[-400:])
check('2e problems: the verify step says MISSING', 'MISSING: an agent\'s git credential helper, see step 2e above' in gout, gout[-600:])
os.chmod(nau, 0o644)

# only the empty line, our first write without the second: completed, not kept as an own setting (barracuda, #357)
with open(nau, 'w') as f:
    f.write('')
git_set(nau, '--add', 'credential.helper', '')
os.unlink(mur)
os.makedirs(os.path.join(gtmp, 'agent-murena'), exist_ok=True)
gout, _ = run_git(gtmp)
n = agent_lines(step_2e(gout), 'agent-nautilus')
check('2e half written: the broker helper is planned after the empty line',
      f'DRY: as_agent agent-nautilus git config --file {nau} --add credential.helper {helper}' in n and 'kept:' not in n, n)
check('2e half written: no second empty line', '--add credential.helper \n' not in n + '\n', n)

# a file git cannot parse must not read as "no helper"
with open(nau, 'w') as f:
    f.write('[credential\n\thelper = x\n')
shutil.rmtree(os.path.join(gtmp, 'agent-murena'))
gout, _ = run_git(gtmp)
sec = step_2e(gout)
check('2e unparsable: named, nothing written over it', 'NOT SET: ' + nau + ' does not parse' in sec and 'DRY: as_agent agent-nautilus' not in sec, sec)
check('2e missing home: named', 'NOT SET: agent-murena has no home directory' in sec, sec)

# the tree's copy, not root and without the test hook: one skip line, no MISSING
gout, _ = run_git(gtmp, hook=False)
sec = step_2e(gout)
if os.geteuid() != 0:
    check('2e not root: skips quietly', 'skip: not root' in sec and 'NOT SET' not in sec and 'DRY:' not in sec, sec)
    check('2e not root: no MISSING in verify', 'MISSING: an agent\'s git credential helper' not in gout, gout[-600:])

# the agents are the ones step 4a lets ask the broker for a token on any repo
listed = HELPER_LINE.findall(TEXT)
pushers = sorted(re.findall(r'echo "agent-([a-z]+) ALL=\(root\) NOPASSWD: \$D4_SBIN/fleet-github token \*"', TEXT))
check('2e one agent list', len(listed) == 1, str(listed))
check('2e the list is step 4a\'s pushers', bool(listed) and sorted(listed[0].split()) == pushers, f'{listed} vs {pushers}')
shutil.rmtree(gtmp)
shutil.rmtree(groot)

shutil.rmtree(root)
shutil.rmtree(conf)
print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
