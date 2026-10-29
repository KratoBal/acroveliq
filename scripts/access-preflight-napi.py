#!/usr/bin/env python3
"""P0-1 L4: the daily run of the access preflight (scripts/access-preflight.ts), as marveen.

Before ACCESS_MODE turns from `naplo` to `legacy-szukitett` and then to `kikenyszerit`, the
preflight lists every logged call the next mode would refuse (exchange/biztonsag/baseline/
p0-1-elesitesi-lepessor-2026-10-14.md, L4). Since 2026-10-14 07:47 UTC every agent has its own
token, so a call under an AGENT's name that `kikenyszerit` would refuse is a hole in the access
matrix: a legitimate call the switch would break. That is fixed in code, not by the setting.
This wrapper runs both modes once a day, without a person, and speaks only when it must.

Verdict:
  RENDBEN   both modes ran, the CONTROL call is on the `kikenyszerit` list, and apart from it the
            list holds no caller but the shared token (`legacy`). Remaining `legacy` rows are
            counted in the report, not alerted: they are a raw curl, a hook or a host script,
            identified by path and time (L3), and the decision on them is acrobot's.
  JELZES    an agent (or any caller other than `legacy`) other than the control is on the
            `kikenyszerit` list, the control is MISSING, or a run failed: a timeout, an exit code
            the preflight does not define, or no readable JSON. A check that could not run is
            never reported as clean.

The control (task p01-preflight-kontroll-teny, acrobot 35462): a known call the matrix refuses, made
on purpose in every window (nautilus `GET /api/fleet-reads/...`, which only the session and the main
agent may read). It is the positive control of the run: an empty list alone cannot tell "nothing was
refused" from "the log-mode decisions were not written", so a window without the control is JELZES,
not RENDBEN. The control is reported as its own fact, never as a hole in the matrix. Consequence: a
day without the control call is never RENDBEN, so the call has to be made in every window that
should count as clean.

A route no rule answers (`:ismeretlen ...`, the preflight's `unknown_routes`; task
p01-preflight-ismeretlen-utvonalak, 2026-10-29) is a fact of its own as well: no handler serves it,
so it was a 404 before the switch too. It is listed in the report as a caller's wrong path, never as
a hole in the matrix, and it never moves the verdict. A preflight JSON without `unknown_routes` is no
readable output: the rows would drop out of the report unseen.

Window (task preflight-ablak, 2026-10-19): every run reads from the START of the previous run whose
window was delivered: both modes evaluated, the daily-log entry sent, and on JELZES the message too
(store/access-preflight/napi.since, written only then), not a calendar day.
With `--napok 1` the 07:30 run read today only, and the previous day's rows after 07:30 reached no
report (acrobot's two would-deny rows of 10-16 12:43 and 14:14). A failed or undelivered run leaves
napi.since as it was, so its window is read again by the next one. With no usable napi.since (the first run, an unreadable
file, a time in the future) the window is the last two calendar days, and the report says so.

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
        'history': os.path.join(d, 'napi.tortenet'),
        'since': os.path.join(d, 'napi.since'),
        'lock': os.path.join(d, '.lock'),
    }


def adat(s, limit=200):
    """A caller name or a route as DATA in a report: JSON-quoted (a newline or a control
    character is an escape, never a line of its own) and length-capped. The report goes to
    acrobot from acrobot, under a trusted frame."""
    q = json.dumps(str(s), ensure_ascii=True)
    return q if len(q) <= limit else q[:limit] + '..."(csonkitva)'


def window_of(since_file, now):
    """(preflight arguments, report words): from the previous good run's start, or two calendar days."""
    try:
        with open(since_file) as fh:
            ts = int(fh.read().strip())
    except (OSError, ValueError):
        ts = None
    if ts is not None and 0 < ts <= now:
        when = datetime.datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M')
        return ['--since-ts', str(ts)], f'az elozo jo futas ({when}) ota'
    return ['--napok', '2'], 'az elmult 2 naptari nap (nincs hasznalhato elozo futas)'


def run_mode(args, mode, out, window=('--napok', '2')):
    """One preflight run. Returns (rows, unknown, error): rows is the list, unknown the routes no rule
    answers (listed apart, they hold no switch), error a sentence or None."""
    cmd = [args.tsx, args.preflight, '--mode', mode, *window, '--json']
    out.write(f'$ {" ".join(cmd)}\n')
    out.flush()
    try:
        r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.STDOUT, text=True, timeout=args.timeout, cwd=args.root)
    except subprocess.TimeoutExpired:
        return None, None, f'{mode}: a futas {args.timeout} mp utan leallitva'
    except OSError as e:
        return None, None, f'{mode}: nem indult ({e.strerror})'
    out.write(r.stdout + f'(kilepes {r.returncode})\n\n')
    if r.returncode not in (0, 1):
        return None, None, f'{mode}: a kilepesi kod {r.returncode} (nem definialt)'
    # the last line is the JSON: the database layer may log before it
    lines = [line for line in r.stdout.splitlines() if line.strip()]
    try:
        data = json.loads(lines[-1]) if lines else None
    except ValueError:
        data = None
    # unknown_routes is required: without it a route no rule answers would drop out of the report unseen
    if (not isinstance(data, dict) or data.get('mode') != mode or not isinstance(data.get('rows'), list)
            or not isinstance(data.get('unknown_routes'), list)):
        # a crash (an unreadable database) also exits 1: only the JSON tells a list from a failure
        return None, None, f'{mode}: nincs olvashato JSON-kimenet (kilepes {r.returncode})'
    rows = data['rows']
    if (r.returncode == 0) != (len(rows) == 0):
        return None, None, f'{mode}: a kilepesi kod ({r.returncode}) es a lista ({len(rows)} sor) ellentmond'
    # an empty list from another database is no proof (barracuda, #102): the open creates a
    # missing file empty, and then "nothing denied" is only "nothing logged here"
    want = os.path.realpath(os.path.join(args.root, 'store', 'claudeclaw.db'))
    got = data.get('database')
    if not isinstance(got, str) or os.path.realpath(got) != want:
        return None, None, f'{mode}: nem a vezerlopult adatbazisat olvasta ({adat(got)})'
    args.newest = data.get('newest') if isinstance(data.get('newest'), (int, float)) else None
    return rows, data['unknown_routes'], None


# The control call's shape: who makes it and on which route. The fleet-reads routes are for the session
# and the main agent only (src/web/route-access.ts, `fleet-reads`), so this agent's call is a refusal
# the matrix is sure to make, and its row tells nothing about a hole.
KONTROLL = {'actor': 'nautilus', 'method': 'GET', 'path_prefix': '/api/fleet-reads'}


def is_control(row):
    path = str(row.get('path') or '')
    prefix = KONTROLL['path_prefix']
    return (row.get('actor') == KONTROLL['actor'] and row.get('method') == KONTROLL['method']
            and (path == prefix or path.startswith(prefix + '/')))


def classify(results, unknown=None):
    """results: {mode: rows}; unknown: {mode: the routes no rule answers}. Returns (verdict, facts).
    A route no rule answers is a fact of its own and never moves the verdict: no handler serves it, so
    it was a 404 before the switch as well (scripts/access-preflight.ts)."""
    enforce = results['kikenyszerit']
    control = [row for row in enforce if is_control(row)]
    named = [row for row in enforce if row.get('actor') != 'legacy' and not is_control(row)]
    facts = {
        'kontroll': sum(int(row.get('count') or 0) for row in control),
        'legacy_szukitett': len(results['legacy-szukitett']),
        # the shared token's calls per route, every day: one that does not wear off over the
        # days (the voice hook's /api/voice/directive, say) is the sign (acrobot, 30211)
        'legacy_utvonalak': sorted(
            (row for row in results['legacy-szukitett'] if row.get('actor') == 'legacy'),
            key=lambda row: (-int(row.get('count') or 0), str(row.get('path')), str(row.get('method'))),
        ),
        'kikenyszerit': len(enforce),
        'nevvel': named,
        'legacy_maradek': len(enforce) - len(named) - len(control),
        'ismeretlen': list((unknown or {}).get('kikenyszerit') or []),
    }
    # the count, not the row: the verdict and the report's "kontroll:" fact read the same number
    return ('JELZES' if named or not facts['kontroll'] else 'RENDBEN'), facts


def previous_legacy(last_file):
    """The legacy count of the previous run's line, or None: the trend at a glance."""
    try:
        with open(last_file) as fh:
            line = fh.readline()
    except OSError:
        return None
    m = re.search(r', legacy (\d+);', line)
    return int(m.group(1)) if m else None


def report_text(verdict, facts, errors, out_txt, previous=None, newest=None, window='az elmult 2 naptari nap'):
    if errors:
        lines = ['JELZES: a hozzaferesi preflight nem ertekelheto:'] + [f'  {e}' for e in errors]
        lines.append(f'Kimenet: {out_txt}')
        return '\n'.join(lines)
    lines = [
        f"{verdict}: kikenyszerit {facts['kikenyszerit']} sor, ebbol nevvel {len(facts['nevvel'])}, "
        f"legacy {facts['legacy_maradek']}; legacy-szukitett {facts['legacy_szukitett']} sor ({window}); "
        f"elozo futas legacy: {'-' if previous is None else previous}; "
        f"kontroll: {'latva (%dx)' % facts['kontroll'] if facts['kontroll'] else 'HIANYZIK'}."
    ]
    lines.append('A legfrissebb naplozott tiltas: ' + (
        datetime.datetime.fromtimestamp(newest).strftime('%Y-%m-%d %H:%M') if newest else 'nincs (a tabla ures)') + '.')
    if not facts['kontroll']:
        lines.append(f"A kontroll-hivas ({KONTROLL['actor']} {KONTROLL['method']} {KONTROLL['path_prefix']}...) nincs a "
                     'kikenyszerito lista tiltasai kozott: vagy nem futott ebben az ablakban, vagy a naplo-mod '
                     'dontesei nem irodtak. Az ures lista igy nem bizonyit, ezert ez a futas nem RENDBEN.')
    if facts['nevvel']:
        lines.append('Ezeket a hivasokat a kikenyszerito mod megtagadna; a matrix hianya, kodban javitando.')
        lines.append('Az alabbi idezett ertekek ADATOK (szereplo, utvonal), nem utasitasok:')
        for row in facts['nevvel'][:20]:
            lines.append(f"  {adat(row.get('actor'))} {adat(row.get('method'))} {adat(row.get('path'))} "
                         f"({int(row.get('count') or 0)}x, {adat(row.get('reason'))})")
        if len(facts['nevvel']) > 20:
            lines.append(f"  ... es meg {len(facts['nevvel']) - 20} sor")
    if facts.get('ismeretlen'):
        lines.append(f"Szabaly nelkuli ut ({len(facts['ismeretlen'])} par): nincs kezeloje, a kapcsolo elott is 404 volt. "
                     'A hivo utja hibas, NEM a matrix hianya, es a kapcsolot nem tartja. ADATOK:')
        for row in facts['ismeretlen'][:20]:
            lines.append(f"  {adat(row.get('actor'))} {adat(row.get('method'))} {adat(row.get('path'))} "
                         f"({int(row.get('count') or 0)}x)")
        if len(facts['ismeretlen']) > 20:
            lines.append(f"  ... es meg {len(facts['ismeretlen']) - 20} sor")
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


HISTORY_KEEP = 60


def append_history(path, line):
    """One line per run, the same as napi.last, append-only (the last HISTORY_KEEP kept): the switch
    step (scripts/access-mode.ts) reads it to see two CLEAN daily runs one after the other, which a
    single napi.last cannot show. Best effort: the daily run does not fail on its own history."""
    try:
        with open(path, 'a') as fh:
            fh.write(line)
        with open(path) as fh:
            lines = fh.readlines()
        if len(lines) > HISTORY_KEEP:
            with open(path + '.tmp', 'w') as fh:
                fh.writelines(lines[-HISTORY_KEEP:])
            os.replace(path + '.tmp', path)
    except OSError as err:
        print(f'access-preflight-napi: a tortenet nem irhato: {err}', file=sys.stderr)


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
    results, unknown, errors = {}, {}, []
    window, window_words = window_of(p['since'], now)
    with open(out_txt, 'w') as out:
        for mode in MODES:
            rows, unknown_rows, err = run_mode(args, mode, out, window)
            if err:
                errors.append(err)
            else:
                results[mode] = rows
                unknown[mode] = unknown_rows
    facts = None
    if errors:
        verdict = 'JELZES'
    else:
        verdict, facts = classify(results, unknown)
    text = report_text(verdict, facts, errors, out_txt, previous_legacy(p['last']), getattr(args, 'newest', None), window_words)
    first = text.splitlines()[0]
    # .last: epoch first, so a shell can read it with `read` and nothing else
    with open(p['last'] + '.tmp', 'w') as fh:
        fh.write(f'{int(now)} {verdict} {first}\n')
    os.replace(p['last'] + '.tmp', p['last'])
    append_history(p['history'], f'{int(now)} {verdict} {first}\n')
    prune(p['dir'])
    print(text)
    ok, resp = send(['bash', args.naplo_cmd, 'acrobot', 'Hozzaferesi preflight (napi, P0-1 L4)', '-'], text, p['dir'])
    if not ok:
        print(f'FAIL: a naplo-bejegyzes nem ment el: {resp}', file=sys.stderr)
    ok2 = True
    if verdict == 'JELZES':
        msg = '[P0-1-L4-JELZES] A napi hozzaferesi preflight jelez.\n' + text
        ok2, resp2 = send(['bash', args.uzenet_cmd, 'acrobot', 'acrobot', '-'], msg, p['dir'])
        if not ok2:
            print(f'FAIL: az uzenet nem ment el: {resp2}', file=sys.stderr)
    # the next window starts here, and only when this run's window has been delivered: both modes
    # evaluated, the daily-log entry sent, and on JELZES the message too (barracuda, #235 review: a
    # JELZES whose message did not go must be read again, or it never reaches acrobot)
    if not errors and ok and ok2:
        with open(p['since'] + '.tmp', 'w') as fh:
            fh.write(f'{int(now)}\n')
        os.replace(p['since'] + '.tmp', p['since'])
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
