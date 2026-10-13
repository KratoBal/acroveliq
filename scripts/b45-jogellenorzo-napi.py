#!/usr/bin/env python3
"""B45 B2-4: the daily run of the write check (b45-jogellenorzo.py), as marveen.

The check exists so that a regression (an agent able to write into another agent's tree, or
the router losing a write path it needs) is reported by a MACHINE, not found by the next
audit. This wrapper turns its three-way exit code into one verdict a schedule can act on.

Why a wrapper and not the bare check: as marveen the check exits 2 every day, because it
cannot list the agents' private folders (43 of them, measured 2026-10-13 A10). Exit 2 means
"zero findings, but the zero is no proof there". If that alerted, it would alert every day,
and an alarm that always rings is the same as one that never does. So the blind spots are
compared to a RECORDED expected set: only a NEW blind spot alerts. A blind spot that
disappears does not (the check now sees more), and a folder that vanished during the walk
(ENOENT) is not a blind spot at all.

Verdict:
  RENDBEN   no finding, every positive probe green, no blind spot outside the expected set
  JELZES    a finding, a failed positive probe, a new blind spot, or the check itself failed
            (no summary, timeout, an exit code it does not define). A check that could not
            run is never reported as clean.

Output (the dashboard is where it is read):
  every run   one daily-log entry for acrobot, and one line in store/b45/jogellenorzo-napi.last
  JELZES      also one inter-agent message to acrobot
  the full check output stays in store/b45/napi/futas-<date>.txt (the last 30 are kept)

Modes:
  futtat     run now, in the foreground (a human, or a test)
  inditas    start `futtat` detached and return at once. THIS is the form for the dashboard's
             command-type schedule: the runner calls spawnSync, which blocks the dashboard's
             event loop until the command returns, and the check takes about 2.5 minutes.
  alap       record the expected blind set from a fresh run (refuses to overwrite without
             --felulir). Run it once as marveen, after reading what it lists.
  allapot    print the last verdict; exit 0 fresh RENDBEN, 1 JELZES, 3 missing/stale/unreadable

Exit codes of futtat: 0 RENDBEN, 1 JELZES, 3 the check could not be evaluated (also reported).
"""
import argparse
import datetime
import fcntl
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STALE_SECONDS = 48 * 3600
KEEP_RUNS = 30
CHECK_TIMEOUT = 30 * 60


def paths(root):
    b45 = os.path.join(root, 'store', 'b45')
    return {
        'b45': b45,
        'runs': os.path.join(b45, 'napi'),
        'last': os.path.join(b45, 'jogellenorzo-napi.last'),
        'baseline': os.path.join(b45, 'jogellenorzo-vakfolt-alap.txt'),
        'lock': os.path.join(b45, 'napi', '.lock'),
    }


def load_baseline(fname):
    """One entry per line: an exact directory, or `<dir>/**` for anything below it."""
    exact, prefixes = set(), []
    with open(fname) as fh:
        for line in fh:
            line = line.rstrip('\n')
            if not line or line.startswith('#'):
                continue
            if line.endswith('/**'):
                prefixes.append(line[:-3].rstrip('/') + '/')
            else:
                exact.add(line)
    return exact, prefixes


def expected(path, baseline):
    exact, prefixes = baseline
    return path in exact or any(path.startswith(p) for p in prefixes)


def classify(summary, baseline):
    """summary: the check's --osszegzes JSON. Returns (verdict, facts)."""
    blind = [(d, e) for d, e in summary['blind'] if e != 'No such file or directory']
    vanished = len(summary['blind']) - len(blind)
    new_blind = [(d, e) for d, e in blind if not expected(d, baseline)]
    facts = {
        'lelet': summary['findings'],
        'pozitiv': summary['positive'],
        'pozitiv_bukott': len(summary['positive_failed']),
        'vakfolt': len(blind),
        'uj_vakfolt': len(new_blind),
        'eltunt': vanished,
        'new_blind': new_blind,
        'pairs': summary['pairs'],
        'positive_failed': summary['positive_failed'],
    }
    bad = facts['lelet'] or facts['pozitiv_bukott'] or facts['uj_vakfolt']
    return ('JELZES' if bad else 'RENDBEN'), facts


def run_check(args, out_txt):
    """Run the check, its stdout to out_txt. Returns (rc, summary-or-None, error-or-None)."""
    fd, summ = tempfile.mkstemp(prefix='osszegzes-', suffix='.json', dir=os.path.dirname(out_txt))
    os.close(fd)
    cmd = [sys.executable, '-I', '-B', args.ellenorzo, '--root', args.root, '--osszegzes', summ]
    try:
        with open(out_txt, 'w') as out:
            try:
                rc = subprocess.run(cmd, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                    timeout=args.timeout).returncode
            except subprocess.TimeoutExpired:
                return None, None, f'a futas {args.timeout} mp utan leallitva'
        if rc not in (0, 1, 2):
            return rc, None, f'az ellenorzo kilepesi kodja {rc} (nem definialt)'
        try:
            with open(summ) as fh:
                summary = json.load(fh)
        except (OSError, ValueError) as e:
            return rc, None, f'nincs olvashato osszegzes ({e.__class__.__name__})'
        return rc, summary, None
    finally:
        try:
            os.unlink(summ)
        except OSError:
            pass


def report_text(verdict, facts, err, rc, out_txt):
    if err:
        lines = [f'JELZES: az ellenorzes nem ertekelheto: {err}.', f'Kimenet: {out_txt}']
        return '\n'.join(lines)
    head = (f"{verdict}: lelet {facts['lelet']}, pozitiv proba {facts['pozitiv']} "
            f"(bukott {facts['pozitiv_bukott']}), vakfolt {facts['vakfolt']} "
            f"(uj {facts['uj_vakfolt']}), eltunt kozben {facts['eltunt']}, ellenorzo rc={rc}.")
    lines = [head]
    for cat, att, vic, n in facts['pairs'][:10]:
        lines.append(f'  lelet: {cat} {att} -> {vic}: {n}')
    for who, p, want, _ in facts['positive_failed'][:10]:
        lines.append(f'  pozitiv proba bukott: {who} {want} {p}')
    for d, e in facts['new_blind'][:10]:
        lines.append(f'  uj vakfolt: {d} ({e})')
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


def prune(runs_dir):
    olds = sorted(f for f in os.listdir(runs_dir) if f.startswith('futas-') and f.endswith('.txt'))
    for f in olds[:-KEEP_RUNS]:
        os.unlink(os.path.join(runs_dir, f))


def futtat(args):
    p = paths(args.root)
    os.makedirs(p['runs'], mode=0o700, exist_ok=True)
    lock = open(p['lock'], 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('b45-jogellenorzo-napi: az elozo futas meg tart, kihagyva', file=sys.stderr)
        return 75
    now = time.time()
    stamp = datetime.datetime.fromtimestamp(now).strftime('%Y-%m-%d-%H%M%S')
    out_txt = os.path.join(p['runs'], f'futas-{stamp}.txt')
    rc, summary, err = run_check(args, out_txt)
    facts = None
    if err is None:
        try:
            baseline = load_baseline(p['baseline'])
        except OSError:
            err = f"nincs rogzitett vart vakfolt-halmaz ({p['baseline']}); futtasd: alap"
    if err is None:
        verdict, facts = classify(summary, baseline)
    else:
        verdict = 'JELZES'
    text = report_text(verdict, facts, err, rc, out_txt)
    # .last: epoch first, so the bootstrap line can read it with `read` and nothing else.
    first = text.splitlines()[0]
    with open(p['last'] + '.tmp', 'w') as fh:
        fh.write(f'{int(now)} {verdict} {first}\n')
    os.replace(p['last'] + '.tmp', p['last'])
    prune(p['runs'])
    print(text)

    ok, resp = send(['bash', args.naplo_cmd, 'acrobot', 'B45 jogellenorzo (napi)', '-'], text, p['runs'])
    if not ok:
        print(f'FAIL: a naplo-bejegyzes nem ment el: {resp}', file=sys.stderr)
    if verdict == 'JELZES':
        msg = '[B45-JELZES] A napi jogellenorzes jelez.\n' + text
        ok2, resp2 = send(['bash', args.uzenet_cmd, 'acrobot', 'acrobot', '-'], msg, p['runs'])
        if not ok2:
            print(f'FAIL: az uzenet nem ment el: {resp2}', file=sys.stderr)
    if err:
        return 3
    return 1 if verdict == 'JELZES' else 0


def inditas(args):
    p = paths(args.root)
    os.makedirs(p['runs'], mode=0o700, exist_ok=True)
    log = open(os.path.join(p['runs'], 'hatter.log'), 'a')
    cmd = [sys.executable, '-I', '-B', os.path.abspath(__file__), 'futtat', '--root', args.root,
           '--ellenorzo', args.ellenorzo, '--timeout', str(args.timeout),
           '--naplo-cmd', args.naplo_cmd, '--uzenet-cmd', args.uzenet_cmd]
    # Own session and no inherited stdio: the caller's pipes close now, so a spawnSync caller
    # returns now, not when the check ends.
    child = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True, close_fds=True)
    print(f'b45-jogellenorzo-napi: elinditva a hatterben, pid {child.pid}')
    return 0


def alap(args):
    p = paths(args.root)
    if os.path.exists(p['baseline']) and not args.felulir:
        print(f"mar letezik: {p['baseline']} (--felulir, ha tenyleg ujra kell rogziteni)", file=sys.stderr)
        return 2
    os.makedirs(p['runs'], mode=0o700, exist_ok=True)
    out_txt = os.path.join(p['runs'], 'alap-futas.txt')
    rc, summary, err = run_check(args, out_txt)
    if err:
        print(f'az ellenorzes nem ertekelheto: {err}', file=sys.stderr)
        return 3
    blind = sorted({d for d, e in summary['blind'] if e != 'No such file or directory'})
    with open(p['baseline'] + '.tmp', 'w') as fh:
        fh.write(f'# B45 jogellenorzo, vart vakfoltok (futtato: {os.getuid()}), '
                 f'{datetime.datetime.now().isoformat(timespec="seconds")}\n')
        fh.write(f"# a rogziteskor: lelet {summary['findings']}, "
                 f"pozitiv bukott {len(summary['positive_failed'])}\n")
        for d in blind:
            fh.write(d + '\n')
    os.replace(p['baseline'] + '.tmp', p['baseline'])
    print(f"rogzitve: {len(blind)} vakfolt -> {p['baseline']}")
    print(f"a rogziteskor: lelet {summary['findings']}, pozitiv bukott {len(summary['positive_failed'])}")
    return 0


def allapot(args):
    p = paths(args.root)
    try:
        with open(p['last']) as fh:
            line = fh.readline().strip()
        ts, verdict, rest = line.split(' ', 2)
        age = time.time() - int(ts)
    except (OSError, ValueError):
        print(f"B45 napi jogellenorzes: nincs ervenyes eredmeny ({p['last']})")
        return 3
    print(f'B45 napi jogellenorzes, {int(age // 3600)} oraja: {rest}')
    if verdict == 'JELZES':
        return 1
    return 3 if age > STALE_SECONDS or verdict != 'RENDBEN' else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mod', choices=('futtat', 'inditas', 'alap', 'allapot'))
    ap.add_argument('--root', default=os.environ.get('FLEET_ROOT', '/home/marveen/marveen'))
    ap.add_argument('--ellenorzo', default=os.path.join(HERE, 'b45-jogellenorzo.py'))
    ap.add_argument('--timeout', type=int, default=CHECK_TIMEOUT)
    ap.add_argument('--naplo-cmd', default=os.path.join(HERE, 'daily-log.sh'))
    ap.add_argument('--uzenet-cmd', default=os.path.join(HERE, 'agent-msg.sh'))
    ap.add_argument('--felulir', action='store_true')
    args = ap.parse_args()
    sys.exit({'futtat': futtat, 'inditas': inditas, 'alap': alap, 'allapot': allapot}[args.mod](args))


if __name__ == '__main__':
    main()
