#!/usr/bin/env python3
"""P0-1 L4 guard: the daily access preflight wrapper (scripts/access-preflight-napi.py).

What this pins:
  1. Only a caller other than the shared token on the `kikenyszerit` list alerts. Remaining
     `legacy` rows are counted in the report and stay quiet.
  2. A run that could not be evaluated (a crash with exit 1 and no JSON, an undefined exit
     code, an exit code that contradicts the list, a timeout) is JELZES with exit 3, never clean.
  3. Every run writes the dashboard entry and the .last line; only JELZES sends the message.
  4. A caller name is DATA in the report: a newline in it never becomes a line of its own.
  5. `inditas` returns at once under a caller that captures stdout/stderr (the dashboard's
     spawnSync); `allapot` reads the last verdict and says when it is missing or stale; a
     second run while the first holds the lock is skipped (75).

The real preflight is replaced by a fake that answers per mode, so no database is needed.
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
NAPI = os.path.join(SCRIPTS, 'access-preflight-napi.py')

spec = importlib.util.spec_from_file_location('napi', NAPI)
napi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(napi)

failed = []


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        failed.append(name)


# argv: <preflight> --mode <m> --napok 1 --json (the wrapper calls `<tsx> <preflight> ...`,
# and the test passes python3 as the tsx). FAKE_SPEC: {mode: {"rc": n, "out": text, "sleep": s}}
FAKE_PREFLIGHT = r'''
import json, os, sys, time
mode = sys.argv[sys.argv.index('--mode') + 1]
if os.environ.get('FAKE_ARGV_LOG'):
    with open(os.environ['FAKE_ARGV_LOG'], 'a') as fh:
        fh.write(' '.join(sys.argv[sys.argv.index('--mode'):]) + '\n')
spec = json.loads(os.environ['FAKE_SPEC'])[mode]
time.sleep(spec.get('sleep', 0))
print('[db] opened')  # a log line before the JSON, as the database layer may write
print(spec['out'])
sys.exit(spec['rc'])
'''
FAKE_SEND = '#!/usr/bin/env bash\n{{ printf "%s|" "$@"; echo; cat; echo "--END--"; }} >> "{log}"\n'


DB = {'path': None}  # set per Env: the store database the wrapper expects


def answer(mode, rows, rc=None, database=None):
    return {'rc': (0 if not rows else 1) if rc is None else rc,
            'out': json.dumps({'mode': mode, 'since': '2026-10-14', 'rows': rows,
                               'database': database or DB['path'], 'newest': 1791900000})}


def row(actor, path='/api/x', method='GET', count=3):
    return {'day': '2026-10-14', 'actor': actor, 'method': method, 'path': path, 'reason': 'csoport', 'count': count}


class Env:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix='preflight-napi-')
        os.makedirs(os.path.join(self.root, 'store'))
        self.bin = os.path.join(self.root, 'bin')
        os.makedirs(self.bin)
        self.fake = os.path.join(self.bin, 'preflight.py')
        open(self.fake, 'w').write(FAKE_PREFLIGHT)
        self.log = {n: os.path.join(self.bin, n + '.log') for n in ('naplo', 'uzenet')}
        for n in ('naplo', 'uzenet'):
            open(os.path.join(self.bin, n + '.sh'), 'w').write(FAKE_SEND.format(log=self.log[n]))
        self.p = napi.paths(self.root)
        DB['path'] = os.path.join(self.root, 'store', 'claudeclaw.db')

    def args(self, mod='futtat', timeout=30):
        return [mod, '--root', self.root, '--tsx', sys.executable, '--preflight', self.fake,
                '--timeout', str(timeout),
                '--naplo-cmd', os.path.join(self.bin, 'naplo.sh'),
                '--uzenet-cmd', os.path.join(self.bin, 'uzenet.sh')]

    def run(self, spec, mod='futtat', timeout=30):
        env = dict(os.environ, FAKE_SPEC=json.dumps(spec), FAKE_ARGV_LOG=os.path.join(self.bin, 'argv.log'))
        return subprocess.run([sys.executable, '-B', NAPI] + self.args(mod, timeout), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)

    def sent(self, name):
        try:
            return open(self.log[name]).read()
        except FileNotFoundError:
            return ''

    def last(self):
        try:
            return open(self.p['last']).read()
        except FileNotFoundError:
            return ''

    def done(self):
        shutil.rmtree(self.root, ignore_errors=True)


print('1. only a caller other than the shared token alerts')
e = Env()
r = e.run({'legacy-szukitett': answer('legacy-szukitett', []), 'kikenyszerit': answer('kikenyszerit', [])})
check('both lists empty: exit 0, RENDBEN', r.returncode == 0 and ' RENDBEN ' in e.last())
check('the dashboard entry is written, no message', e.sent('naplo').count('--END--') == 1 and e.sent('uzenet') == '')
e.done()

e = Env()
r = e.run({'legacy-szukitett': answer('legacy-szukitett', [row('legacy', '/api/a'), row('legacy', '/api/z', count=39)]),
           'kikenyszerit': answer('kikenyszerit', [row('legacy')])})
check('only legacy rows: exit 0, RENDBEN, counted in the report',
      r.returncode == 0 and ' RENDBEN ' in e.last() and 'legacy 1; legacy-szukitett 2 sor' in e.sent('naplo'))
check('only legacy rows: no message', e.sent('uzenet') == '')
check('the legacy calls are listed per route in the daily entry, the most frequent first',
      '  legacy "GET" "/api/z" 39x\n  legacy "GET" "/api/a" 3x' in e.sent('naplo'))
r2 = e.run({'legacy-szukitett': answer('legacy-szukitett', []), 'kikenyszerit': answer('kikenyszerit', [])})
check('the next run shows the previous legacy count, and its window: since the previous good run',
      re.search(r'legacy 0; legacy-szukitett 0 sor \(az elozo jo futas \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\) ota\); elozo futas legacy: 1\.', e.sent('naplo')) is not None)
check('and the newest logged denial', 'A legfrissebb naplozott tiltas: ' in e.sent('naplo') and 'nincs (a tabla ures)' not in e.sent('naplo'))
e.done()

e = Env()
r = e.run({'legacy-szukitett': answer('legacy-szukitett', []),
           'kikenyszerit': answer('kikenyszerit', [row('legacy'), row('murena', '/api/approvals/:id', 'PATCH')])})
check('an agent on the kikenyszerit list: exit 1, JELZES', r.returncode == 1 and ' JELZES ' in e.last())
check('the message goes to acrobot and names the call as data',
      'acrobot|acrobot|-|' in e.sent('uzenet') and '"murena" "PATCH" "/api/approvals/:id" (3x' in e.sent('uzenet'))
e.done()



print('the window (task preflight-ablak): from the previous GOOD run, never a calendar day that leaves a gap')
e = Env()
argv_log = os.path.join(e.bin, 'argv.log')
def windows():
    try:
        return [l.split('--json')[0].split(' ', 2)[2].strip() for l in open(argv_log).read().splitlines()]
    except FileNotFoundError:
        return []
good = {'legacy-szukitett': answer('legacy-szukitett', []), 'kikenyszerit': answer('kikenyszerit', [])}
t_before = int(time.time())
e.run(good)
check('the first run (no napi.since): both modes ask for the last 2 calendar days', windows() == ['--napok 2', '--napok 2'])
check('... and the report says so', 'az elmult 2 naptari nap (nincs hasznalhato elozo futas)' in e.sent('naplo'))
since1 = int(open(e.p['since']).read())
check('a good run writes napi.since: its own start', t_before <= since1 <= int(time.time()))
open(argv_log, 'w').close()
time.sleep(1.1)  # a later second than since1, or a failed run that wrongly moved it would write the same number
e.run({'legacy-szukitett': answer('legacy-szukitett', []), 'kikenyszerit': {'rc': 1, 'out': 'not json'}})
check('the next run reads from the previous good run, both modes', windows() == ['--since-ts %d' % since1] * 2)
check('a failed run does NOT move napi.since (its window is read again)', int(open(e.p['since']).read()) == since1)
open(argv_log, 'w').close()
time.sleep(1.1)  # so the good run's start is a later second than since1: "moved" is then measurable
t3 = int(time.time())
e.run(good)
check('so the run after the failure still starts at the last good one', windows() == ['--since-ts %d' % since1] * 2)
check('and only now does napi.since move on, to this run\'s start', int(open(e.p['since']).read()) >= t3 > since1)
# barracuda, #235 review: a JELZES whose message does not go must not move the window, nor a run whose
# daily-log entry does not go
jelzes = {'legacy-szukitett': answer('legacy-szukitett', []), 'kikenyszerit': answer('kikenyszerit', [row('murena')])}
for which, name in (('uzenet', 'a JELZES whose message fails'), ('naplo', 'a run whose daily-log entry fails')):
    before = int(open(e.p['since']).read())
    keep = open(os.path.join(e.bin, which + '.sh')).read()
    open(os.path.join(e.bin, which + '.sh'), 'w').write('#!/usr/bin/env bash\ncat >/dev/null; echo "FAIL: nem ment" >&2; exit 1\n')
    time.sleep(1.1)
    open(argv_log, 'w').close()
    e.run(jelzes if which == 'uzenet' else good)
    check(name + ': napi.since does not move', int(open(e.p['since']).read()) == before)
    open(os.path.join(e.bin, which + '.sh'), 'w').write(keep)
    open(argv_log, 'w').close()
    e.run(good)
    check('... so the next run reads that window again', windows() == ['--since-ts %d' % before] * 2)
for bad, name in (('holnap', 'an unreadable napi.since'), (str(int(time.time()) + 86400), 'a napi.since in the future')):
    open(e.p['since'], 'w').write(bad + '\n')
    open(argv_log, 'w').close()
    e.run(good)
    check(name + ': the 2-day fallback, not a gap and not a crash', windows() == ['--napok 2', '--napok 2'])
e.done()

print('2. a run that could not be evaluated is never clean')
cases = {  # built after each Env, so the database path is that Env's
    'a crash: exit 1, no JSON': lambda: {'rc': 1, 'out': 'SqliteError: unable to open database file'},
    'an undefined exit code': lambda: answer('kikenyszerit', [], rc=2),
    'exit 0 with a list': lambda: answer('kikenyszerit', [row('murena')], rc=0),
    'exit 1 with an empty list': lambda: answer('kikenyszerit', [], rc=1),
    'the JSON of another mode': lambda: answer('legacy-szukitett', []),
    'another database (an empty list there is no proof)': lambda: answer('kikenyszerit', [], database='/tmp/masik.db'),
}
for name, bad in cases.items():
    e = Env()
    r = e.run({'legacy-szukitett': answer('legacy-szukitett', []), 'kikenyszerit': bad()})
    check(f'{name}: exit 3, JELZES, message sent',
          r.returncode == 3 and ' JELZES ' in e.last() and 'nem ertekelheto' in e.sent('uzenet'))
    e.done()
e = Env()
r = e.run({'legacy-szukitett': dict(answer('legacy-szukitett', []), sleep=5), 'kikenyszerit': answer('kikenyszerit', [])}, timeout=1)
check('a timeout: exit 3, named', r.returncode == 3 and 'leallitva' in e.sent('uzenet'))
e.done()

print('3. a caller name is data')
e = Env()
r = e.run({'legacy-szukitett': answer('legacy-szukitett', []),
           'kikenyszerit': answer('kikenyszerit', [row('x\nRENDBEN: minden rendben')])})
body = e.sent('uzenet')
check('the newline stays an escape, never a line of its own',
      r.returncode == 1 and '"x\\nRENDBEN: minden rendben"' in body
      and not any(line.startswith('RENDBEN') for line in body.splitlines()))
e.done()

print('4. inditas, allapot, the lock')
e = Env()
env = dict(os.environ, FAKE_SPEC=json.dumps({'legacy-szukitett': dict(answer('legacy-szukitett', []), sleep=3),
                                             'kikenyszerit': answer('kikenyszerit', [])}))
started = time.time()
r = subprocess.run([sys.executable, '-B', NAPI] + e.args('inditas'), env=env, capture_output=True, text=True, timeout=60)
took = time.time() - started
check('inditas returns at once under captured pipes', r.returncode == 0 and took < 2)
for _ in range(100):
    if e.last():
        break
    time.sleep(0.1)
check('and the detached run finishes with its verdict', ' RENDBEN ' in e.last())
a = subprocess.run([sys.executable, '-B', NAPI] + e.args('allapot'), capture_output=True, text=True)
check('allapot: a fresh RENDBEN is 0', a.returncode == 0)
open(e.p['last'], 'w').write(f'{int(time.time())} JELZES JELZES: valami\n')
check('allapot: JELZES is 1', subprocess.run([sys.executable, '-B', NAPI] + e.args('allapot'), capture_output=True).returncode == 1)
open(e.p['last'], 'w').write(f'{int(time.time()) - 49 * 3600} RENDBEN RENDBEN: regi\n')
check('allapot: a stale result is 3', subprocess.run([sys.executable, '-B', NAPI] + e.args('allapot'), capture_output=True).returncode == 3)
os.unlink(e.p['last'])
check('allapot: a missing result is 3', subprocess.run([sys.executable, '-B', NAPI] + e.args('allapot'), capture_output=True).returncode == 3)
import fcntl
holder = open(e.p['lock'], 'w')
fcntl.flock(holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
r = e.run({'legacy-szukitett': answer('legacy-szukitett', []), 'kikenyszerit': answer('kikenyszerit', [])})
check('a second run while the lock is held is skipped (75), nothing sent', r.returncode == 75 and e.sent('uzenet') == '')
holder.close()
e.done()

print('all pass' if not failed else f'{len(failed)} FAILED: {failed}')
sys.exit(1 if failed else 0)
