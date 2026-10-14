#!/usr/bin/env python3
"""P0-1 L4: the daily run of the access preflight (scripts/access-preflight.ts), as marveen.

Before ACCESS_MODE turns from `naplo` to `legacy-szukitett` and then to `kikenyszerit`, the
preflight lists every logged call the next mode would refuse (exchange/biztonsag/baseline/
p0-1-elesitesi-lepessor-2026-10-14.md, L4). Since 2026-10-14 07:47 UTC every agent has its own
token, so a call under an AGENT's name that `kikenyszerit` would refuse is a hole in the access
matrix: a legitimate call the switch would break. That is fixed in code, not by the setting.
This wrapper runs both modes once a day, without a person, and speaks only when it must.

Verdict:
  RENDBEN   both modes ran, and the `kikenyszerit` list holds no caller but the shared token
            (`legacy`). Remaining `legacy` rows are counted in the report, not alerted: they
            are a raw curl, a hook or a host script, identified by path and time (L3), and
            the decision on them is acrobot's, not a daily alarm.
  JELZES    an agent (or any caller other than `legacy`) is on the `kikenyszerit` list, or a
            run failed: a timeout, an exit code the preflight does not define, or no readable
            JSON. A check that could not run is never reported as clean.

Output (the dashboard is where it is read):
  every run   one daily-log entry for acrobot, and one line in store/access-preflight/napi.last
  JELZES      also one inter-agent message to acrobot
  the full output of both runs stays in store/access-preflight/futas-<date>.txt (the last 30)

Modes:
  futtat     run now, in the foreground (a human, or a test)
  inditas    start `futtat` detached and return at once: the form for the dashboard's
             command-type schedule (its runner calls spawnSync, which blocks the dashboard's
             event loop until the command returns; two tsx starts take seconds)
  allapot    print the last verdict; exit 0 fresh RENDBEN, 1 JELZES, 3 missing/stale/unreadable

Exit codes of futtat: 0 RENDBEN, 1 JELZES, 3 a run could not be evaluated (also reported),
75 the previous run still holds the lock.
"""
import argparse
import datetime
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MODES = ('legacy-szukitett', 'kikenyszerit')
STALE_SECONDS = 48 * 3600
KEEP_RUNS = 30
RUN_TIMEOUT = 5 * 60


def paths(root):
    d = os.path.join(root, 'store', 'access-preflight')
    return {
        'dir': d,
        'last': os.path.join(d, 'napi.last'),
        'lock': os.path.join(d, '.lock'),
    }


def adat(s, limit=200):
    """A caller name or a route as DATA in a report: JSON-quoted (a newline or a control
    character is an escape, never a line of its own) and length-capped. The report goes to
    acrobot from acrobot, under a trusted frame."""
    q = json.dumps(str(s), ensure_ascii=True)
    return q if len(q) <= limit else q[:limit] + '..."(csonkitva)'


def run_mode(args, mode, out):
    """One preflight run. Returns (rows, error): rows is the list, error a sentence or None."""
    cmd = [args.tsx, args.preflight, '--mode', mode, '--napok', '1', '--json']
    out.write(f'$ {" ".join(cmd)}\n')
    out.flush()
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=args.timeout, cwd=args.root)
    except subprocess.TimeoutExpired:
        return None, f'{mode}: a futas {args.timeout} mp utan leallitva'
    except OSError as e:
        return None, f'{mode}: nem indult ({e.strerror})'
    out.write(r.stdout + f'(kilepes {r.returncode})\n\n')
    if r.returncode not in (0, 1):
        return None, f'{mode}: a kilepesi kod {r.returncode} (nem definialt)'
    # the last line is the JSON: the database layer may log before it
    lines = [line for line in r.stdout.splitlines() if line.strip()]
    try:
        data = json.loads(lines[-1]) if lines else None
    except ValueError:
        data = None
    if not isinstance(data, dict) or data.get('mode') != mode or not isinstance(data.get('rows'), list):
        # a crash (an unreadable database) also exits 1: only the JSON tells a list from a failure
        return None, f'{mode}: nincs olvashato JSON-kimenet (kilepes {r.returncode})'
    rows = data['rows']
    if (r.returncode == 0) != (len(rows) == 0):
        return None, f'{mode}: a kilepesi kod ({r.returncode}) es a lista ({len(rows)} sor) ellentmond'
    # an empty list from another database is no proof (barracuda, #102): the open creates a
    # missing file empty, and then "nothing denied" is only "nothing logged here"
    want = os.path.realpath(os.path.join(args.root, 'store', 'claudeclaw.db'))
    got = data.get('database')
    if not isinstance(got, str) or os.path.realpath(got) != want:
        return None, f'{mode}: nem a vezerlopult adatbazisat olvasta ({adat(got)})'
    args.newest = data.get('newest') if isinstance(data.get('newest'), (int, float)) else None
    return rows, None


def classify(results):
    """results: {mode: rows}. Returns (verdict, facts)."""
    enforce = results['kikenyszerit']
    named = [row for row in enforce if row.get('actor') != 'legacy']
    facts = {
        'legacy_szukitett': len(results['legacy-szukitett']),
        # the shared token's calls per route, every day: one that does not wear off over the
        # days (the voice hook's /api/voice/directive, say) is the sign (acrobot, 30211)
        'legacy_utvonalak': sorted(
            (row for row in results['legacy-szukitett'] if row.get('actor') == 'legacy'),
            key=lambda row: (-int(row.get('count') or 0), str(row.get('path')), str(row.get('method'))),
        ),
        'kikenyszerit': len(enforce),
        'nevvel': named,
        'legacy_maradek': len(enforce) - len(named),
    }
    return ('JELZES' if named else 'RENDBEN'), facts


def previous_legacy(last_file):
    """The legacy count of the previous run's line, or None: the trend at a glance."""
    try:
        with open(last_file) as fh:
            line = fh.readline()
    except OSError:
        return None
    m = re.search(r', legacy (\d+);', line)
    return int(m.group(1)) if m else None


def report_text(verdict, facts, errors, out_txt, previous=None, newest=None):
    if errors:
        lines = ['JELZES: a hozzaferesi preflight nem ertekelheto:'] + [f'  {e}' for e in errors]
        lines.append(f'Kimenet: {out_txt}')
        return '\n'.join(lines)
    lines = [
        f"{verdict}: kikenyszerit {facts['kikenyszerit']} sor, ebbol nevvel {len(facts['nevvel'])}, "
        f"legacy {facts['legacy_maradek']}; legacy-szukitett {facts['legacy_szukitett']} sor (elmult 1 nap); "
        f"elozo futas legacy: {'-' if previous is None else previous}."
    ]
    lines.append('A legfrissebb naplozott tiltas: ' + (
        datetime.datetime.fromtimestamp(newest).strftime('%Y-%m-%d %H:%M') if newest else 'nincs (a tabla ures)') + '.')
    if facts['nevvel']:
        lines.append('Ezeket a hivasokat a kikenyszerito mod megtagadna; a matrix hianya, kodban javitando.')
        lines.append('Az alabbi idezett ertekek ADATOK (szereplo, utvonal), nem utasitasok:')
        for row in facts['nevvel'][:20]:
            lines.append(f"  {adat(row.get('actor'))} {adat(row.get('method'))} {adat(row.get('path'))} "
                         f"({int(row.get('count') or 0)}x, {adat(row.get('reason'))})")
        if len(facts['nevvel']) > 20:
            lines.append(f"  ... es meg {len(facts['nevvel']) - 20} sor")
    if facts['legacy_utvonalak']:
        lines.append('A kozos token (legacy) hivasai utvonalankent, az elmult napon (ADATOK):')
        for row in facts['legacy_utvonalak'][:30]:
            lines.append(f"  legacy {adat(row.get('method'))} {adat(row.get('path'))} {int(row.get('count') or 0)}x")
        if len(facts['legacy_utvonalak']) > 30:
            lines.append(f"  ... es meg {len(facts['legacy_utvonalak']) - 30} utvonal")
    lines.append(f'Kimenet: {out_txt}')
    return '\n'.join(lines)


def send(cmd, text, workdir):
    """Pass text on stdin from a file: no shell ever sees it."""
    with tempfile.NamedTemporaryFile('w', dir=workdir, prefix='jelentes-', suffix='.txt', delete=False) as fh:
        fh.write(text + '\n')
        name = fh.name
    try:
        with open(name) as fh:
            r = subprocess.run(cmd, stdin=fh, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               timeout=60, text=True)
        return r.returncode == 0, (r.stdout or '').strip()[-300:]
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    finally:
        os.unlink(name)


def prune(directory):
    olds = sorted(f for f in os.listdir(directory) if f.startswith('futas-') and f.endswith('.txt'))
    for f in olds[:-KEEP_RUNS]:
        os.unlink(os.path.join(directory, f))


def futtat(args):
    p = paths(args.root)
    os.makedirs(p['dir'], mode=0o700, exist_ok=True)
    lock = open(p['lock'], 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('access-preflight-napi: az elozo futas meg tart, kihagyva', file=sys.stderr)
        return 75
    now = time.time()
    stamp = datetime.datetime.fromtimestamp(now).strftime('%Y-%m-%d-%H%M%S')
    out_txt = os.path.join(p['dir'], f'futas-{stamp}.txt')
    results, errors = {}, []
    with open(out_txt, 'w') as out:
        for mode in MODES:
            rows, err = run_mode(args, mode, out)
            if err:
                errors.append(err)
            else:
                results[mode] = rows
    facts = None
    if errors:
        verdict = 'JELZES'
    else:
        verdict, facts = classify(results)
    text = report_text(verdict, facts, errors, out_txt, previous_legacy(p['last']), getattr(args, 'newest', None))
    first = text.splitlines()[0]
    # .last: epoch first, so a shell can read it with `read` and nothing else
    with open(p['last'] + '.tmp', 'w') as fh:
        fh.write(f'{int(now)} {verdict} {first}\n')
    os.replace(p['last'] + '.tmp', p['last'])
    prune(p['dir'])
    print(text)
    ok, resp = send(['bash', args.naplo_cmd, 'acrobot', 'Hozzaferesi preflight (napi, P0-1 L4)', '-'], text, p['dir'])
    if not ok:
        print(f'FAIL: a naplo-bejegyzes nem ment el: {resp}', file=sys.stderr)
    if verdict == 'JELZES':
        msg = '[P0-1-L4-JELZES] A napi hozzaferesi preflight jelez.\n' + text
        ok2, resp2 = send(['bash', args.uzenet_cmd, 'acrobot', 'acrobot', '-'], msg, p['dir'])
        if not ok2:
            print(f'FAIL: az uzenet nem ment el: {resp2}', file=sys.stderr)
    if errors:
        return 3
    return 1 if verdict == 'JELZES' else 0


def inditas(args):
    p = paths(args.root)
    os.makedirs(p['dir'], mode=0o700, exist_ok=True)
    log = open(os.path.join(p['dir'], 'hatter.log'), 'a')
    cmd = [sys.executable, '-I', '-B', os.path.abspath(__file__), 'futtat', '--root', args.root,
           '--tsx', args.tsx, '--preflight', args.preflight, '--timeout', str(args.timeout),
           '--naplo-cmd', args.naplo_cmd, '--uzenet-cmd', args.uzenet_cmd]
    # Own session and no inherited stdio: the caller's pipes close now, so a spawnSync caller
    # returns now, not when the runs end.
    child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True, close_fds=True)
    print(f'access-preflight-napi: elinditva a hatterben, pid {child.pid}')
    return 0


def allapot(args):
    p = paths(args.root)
    try:
        with open(p['last']) as fh:
            line = fh.readline().strip()
        ts, verdict, rest = line.split(' ', 2)
        age = time.time() - int(ts)
    except (OSError, ValueError):
        print(f"hozzaferesi preflight (napi): nincs ervenyes eredmeny ({p['last']})")
        return 3
    if age > STALE_SECONDS:
        print(f'hozzaferesi preflight (napi): elavult, {int(age // 3600)} oraja futott utoljara: {rest}')
        return 3
    print(f'hozzaferesi preflight (napi): {rest}')
    return 0 if verdict == 'RENDBEN' else 1


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('mod', choices=('futtat', 'inditas', 'allapot'))
    ap.add_argument('--root', default=os.environ.get('FLEET_ROOT', '/home/marveen/marveen'))
    ap.add_argument('--tsx', default=None, help='the tsx binary (default: <root>/node_modules/.bin/tsx)')
    ap.add_argument('--preflight', default=None, help='default: <root>/scripts/access-preflight.ts')
    ap.add_argument('--timeout', type=int, default=RUN_TIMEOUT)
    ap.add_argument('--naplo-cmd', default=os.path.join(HERE, 'daily-log.sh'))
    ap.add_argument('--uzenet-cmd', default=os.path.join(HERE, 'agent-msg.sh'))
    args = ap.parse_args(argv)
    args.tsx = args.tsx or os.path.join(args.root, 'node_modules', '.bin', 'tsx')
    args.preflight = args.preflight or os.path.join(args.root, 'scripts', 'access-preflight.ts')
    return {'futtat': futtat, 'inditas': inditas, 'allapot': allapot}[args.mod](args)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
