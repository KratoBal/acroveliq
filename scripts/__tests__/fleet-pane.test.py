#!/usr/bin/env python3
"""fleet-pane, the root broker into agent panes (scripts/root/fleet-pane.py; B48 (2), P1-13).

WHAT TURNS THIS RED (the plan's section 8, the parts that need no installed broker):
  N1  a key reaches a pane that shows a permission question, whatever the message says
      (`1`, `2`, empty, a space, CR, ESC, `C-c`);
  N2  a dismiss or an interrupt sends a key while a permission question is up;
  N4  a bad agent name, a pane address, an unlisted agent, an unknown verb, option or kind
      reaches tmux at all;
  N6  a key goes out after the pane turned into a dialog mid-typing or just before the Enter;
      a dialog after the Enter counts as delivered, or is not logged as suspect-accept;
  N8  an agents file not owned by root (or writable by others) is trusted;
  N9  the caller's environment reaches the agent's tmux;
  and: caller text becomes a tmux option or a key name; a control character is typed; Ctrl-C
  goes into an EMPTY box (it quits Claude Code); the log holds the text; a broker bug exits 0.

The pane is a script that follows the keys (no tmux, no agent user, no root: CI has none).
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import json
import re
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('fleet_pane', os.path.join(SCRIPTS, 'root', 'fleet-pane.py'))
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)

SEP = '─' * 80
FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
BUSY_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents'
SPINNER = '✳ Forming… (3m 7s · ↓ 6.1k tokens)'
PERMISSION = '\n'.join(['  ⎿  … tool output …', ' Bash command', '   touch /tmp/jelolo', ' Do you want to proceed?',
                        ' ❯ 1. Yes', "   2. Yes, and don't ask again", '   3. No (esc)', '', ' ↑/↓ to navigate · Esc to cancel'])
SCREENS = {
    'survey': '\n'.join(['● kesz', '', ' How is Claude doing this session? (optional)', '  1: Bad  2: Fine  3: Good  0: Dismiss', SEP, '❯ ', SEP, FOOTER]),
    'resume-summary': '\n'.join([' Context low', ' ❯ 1. Resume from summary (recommended)', '   2. Resume full session', '', ' Enter to confirm · Esc to cancel']),
    'feedback-draft': '\n'.join(['● kesz', ' ╭──────╮', ' │ Bug report drafted: x │', ' │ 1 to review · 2 to send · 0 to dismiss │', ' ╰──────╯', SEP, '❯ ', SEP, FOOTER]),
    'model-consent': '\n'.join([' Fable 5 now uses usage credits', ' ❯ 1. Continue with Fable 5', '   2. Switch to Sonnet', '', ' Enter to confirm']),
    'trust': '\n'.join([' Do you trust the files in this folder?', ' ❯ 1. Yes, proceed', '   2. No, exit', '', ' Enter to confirm · Esc to exit']),
    'bypass': '\n'.join([' WARNING: Claude Code running in Bypass Permissions mode', '   1. No, exit', ' ❯ 2. Yes, I accept', '', ' Enter to confirm · Esc to exit']),
    'theme': '\n'.join([' Choose the text style that looks best', ' ❯ 1. Dark mode', '', ' Enter to confirm']),
    'welcome': '\n'.join([' Welcome to Claude Code', ' Press Enter to continue']),
}
TEXT = ('SECURITY NOTICE -- msg 31133: 1) a teszt 2) a review; 3 fajl, 12 kalibracio, '
        '-szal -vel kotojeles toldalek, koszonom. ' + 'x' * 60)


class Pane:
    """A pane that follows the keys. `screen` overrides everything (a dialog); the triggers turn a
    dialog on after N chunks, at the Nth look, or after the Nth Enter."""

    def __init__(self, busy=False, box='', screen=None, dialog_after_chunks=None, dialog_from_look=None,
                 dialog_after_enters=None, park_enters=0, placeholder=False, ghost=False):
        self.busy, self.box, self.screen = busy, box, screen
        self.t = dict(chunks=dialog_after_chunks, look=dialog_from_look, enters=dialog_after_enters)
        self.park_enters, self.placeholder, self.ghost = park_enters, placeholder, ghost
        self.n_chunks = self.n_looks = self.n_enters = 0
        self.keys, self.calls, self.running = [], [], True

    def dialog_on(self):
        t = self.t
        return ((t['chunks'] is not None and self.n_chunks >= t['chunks']) or
                (t['look'] is not None and self.n_looks >= t['look']) or
                (t['enters'] is not None and self.n_enters >= t['enters']))

    def render(self):
        if self.screen:
            return self.screen
        if self.dialog_on():
            return PERMISSION
        box = self.box
        if self.placeholder and box:
            box = '[Pasted text #1 +%d chars]' % len(box)
        rows = [box[i:i + 76] for i in range(0, len(box), 76)] or ['']
        rows = ['❯ ' + rows[0]] + ['  ' + r for r in rows[1:]]
        if self.ghost and not self.box:
            rows = ['❯ \x1b[2mTry "refactor the parser"\x1b[0m']
        head = ['  ⎿  … tool output …', '']
        if self.busy:
            head.append(SPINNER)
        return '\n'.join(head + [SEP] + rows + [SEP, '  Opus 5 · ctx 40%', BUSY_FOOTER if self.busy else FOOTER])

    def __call__(self, cmd):
        assert cmd[:5] == [fp.RUNUSER, '-u', 'agent-proba', '--', fp.TMUX], cmd
        a = cmd[5:]
        self.calls.append(a)
        if a[0] == 'has-session':
            return (0 if self.running else 1), ''
        if a[0] == 'display-message':
            return 0, '1792000000\n'
        if a[0] == 'kill-session':
            self.running = False
            return 0, ''
        if a[0] == 'capture-pane':
            self.n_looks += 1
            return 0, self.render()
        assert a[0] == 'send-keys' and a[1:3] == ['-t', 'agent-proba'], a
        shown = self.render()
        into_dialog = fp.dialog(fp.strip_ansi(shown)) is not None
        if a[3] == '-l':
            assert len(a) == 6 and a[4] == '--', a
            # tmux 3.3a, measured 2026-10-15: an argument ending in ';' is a command separator
            m = re.match(r'^(.*?)(\\*);$', a[5], re.S)
            text = a[5] if not m else m.group(1) + (';' if m.group(2) else '')
            self.keys.append(('INTO-DIALOG:' if into_dialog else '') + 'TEXT:' + text)
            self.n_chunks += 1
            if not into_dialog:
                self.box += text
            return 0, ''
        for k in a[3:]:
            self.keys.append(('INTO-DIALOG:' if into_dialog else '') + k)
            if k == 'Enter' and not self.screen:
                self.n_enters += 1
                if self.box and self.n_enters > self.park_enters:
                    self.box, self.busy = '', True
            if k == 'C-c' and self.placeholder:
                self.box = ''
            if k == 'Delete' and not self.placeholder:
                self.box = ''
            if self.screen and k in ('0', 'Enter', 'Escape'):
                self.screen = None
        self.key_calls = getattr(self, 'key_calls', 0) + 1
        return 0, ''


class Env:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix='fleet-pane-teszt-')
        self.agents = os.path.join(self.dir, 'agents.json')
        self.log = os.path.join(self.dir, 'fleet-pane.log')
        with open(self.agents, 'w') as f:
            json.dump({'agents': {'proba': {'user': 'agent-proba', 'workdir': '/x'}, 'Rossz Nev': {'user': 'x'},
                                  'rootos': {'user': 'root'}, 'szolga': {'user': 'www-data'}}}, f)

    def run(self, pane, argv, stdin=b'', require_root=False):
        return fp.run(argv, {'agents_file': self.agents, 'log_file': self.log, 'run': pane, 'sleep': lambda s: None,
                             'caller_uid': 1000, 'require_root': require_root}, stdin)

    def log_lines(self):
        try:
            with open(self.log) as f:
                return [json.loads(l) for l in f]
        except FileNotFoundError:
            return []


FAILS = []


def check(name, got, want):
    if got != want:
        FAILS.append(name)
        print('FAIL %s\n  got:  %r\n  want: %r' % (name, got, want))
    else:
        print('ok   %s' % name)


def text_keys(p):
    return ''.join(k[5:] for k in p.keys if k.startswith('TEXT:'))


# --- N1, N2: a permission question takes no key -------------------------------------------
e = Env()
for msg in [b'1', b'2', b'', b' ', b'\r', b'\x1b', b'C-c', TEXT.encode()]:
    p = Pane(screen=PERMISSION)
    code, out = e.run(p, ['deliver', 'proba'], msg)
    check('N1 deliver %r on a permission question: no key, refused before typing' % msg[:8], (code, p.keys), (10, []))
for kind in ('survey', 'feedback-draft'):
    p = Pane(screen=SCREENS[kind])
    check('N1 deliver onto a %s dialog that keeps the idle footer: refused by name, no key' % kind,
          (e.run(p, ['deliver', 'proba'], TEXT.encode()), p.keys), ((10, kind), []))
for kind in fp.DISMISS_KINDS:
    p = Pane(screen=PERMISSION)
    check('N2 dismiss %s on a permission question: no key' % kind, (e.run(p, ['dismiss', 'proba', kind])[0], p.keys), (12, []))
p = Pane(screen=PERMISSION)
check('N2 interrupt on a permission question: no key', (e.run(p, ['interrupt', 'proba'])[0], p.keys), (12, []))
p = Pane(screen=PERMISSION + '\n' + BUSY_FOOTER)
check('N2 interrupt on a permission question during a running turn: no Escape', (e.run(p, ['interrupt', 'proba'])[0], p.keys), (12, []))
for verb in ('clear', 'submit'):
    p = Pane(screen=PERMISSION)
    check('N2 %s on a permission question: no key' % verb, (e.run(p, [verb, 'proba'])[0], p.keys), (12, []))

# --- N4: argument probes never reach tmux ---------------------------------------------------
for argv in [['deliver', '../proba'], ['deliver', 'proba;id'], ['capture', 'agent-proba:0.1'], ['send-keys', 'proba'],
             ['run-shell', 'proba'], ['capture', 'masik'], ['capture', 'Rossz Nev'], ['capture', 'rootos'], ['capture', 'szolga'], ['capture', 'proba', '-t', 'x'],
             ['capture', 'proba', '--lines', '99999'], ['capture', 'proba', '--lines', '-5'], ['dismiss', 'proba', 'login'],
             ['dismiss', 'proba', 'Enter'], ['status', 'proba', '--queued'], ['deliver'], []]:
    p = Pane()
    code, out = e.run(p, argv)
    check('N4 %r: usage refusal, no tmux call' % (argv,), (code, p.calls), (2, []))

# --- N6: the race, scripted -----------------------------------------------------------------
p = Pane(dialog_after_chunks=1)
code, out = e.run(p, ['deliver', 'proba'], TEXT.encode())
check('N6 dialog after the first chunk: typing stops, no Enter, nothing into the dialog',
      (code, out.split(':')[0], [k for k in p.keys if 'INTO-DIALOG' in k or k == 'Enter']), (11, 'dialog-while-typing', []))
chunks_n = len(fp.chunks(TEXT))
# looks: 2 readiness, one per chunk, then the one before the Enter: dialog exactly there
p = Pane(dialog_from_look=2 + chunks_n + 1)
code, out = e.run(p, ['deliver', 'proba'], TEXT.encode())
check('N6 dialog at the look before the Enter: no Enter', (code, out, 'Enter' in p.keys), (11, 'dialog-before-enter:permission-question', False))
p = Pane(dialog_after_enters=1)
code, out = e.run(p, ['deliver', 'proba'], TEXT.encode())
last = e.log_lines()[-1]
check('N6 dialog right after the Enter: not delivered, logged suspect-accept',
      (code, out, last.get('suspect-accept'), p.keys.count('Enter')), (11, 'dialog-after-enter:permission-question', 'permission-question', 1))

# --- N8: the agents file must be root's -----------------------------------------------------
p = Pane()
code, out = e.run(p, ['capture', 'proba'], require_root=True)
check('N8 an agents file the caller owns is not trusted (require_root)', (code, out, p.calls), (2, 'agents-file-not-root-owned', []))

# --- N9: the agent's tmux gets our environment, not the caller's ----------------------------
os.environ['LD_PRELOAD'] = '/tmp/x.so'
os.environ['TMUX'] = '/tmp/tmux-1000/default,1,0'
os.environ['PYTHONPATH'] = '/tmp/py'
rc, out = fp.real_run(['/usr/bin/env'])
check('N9 the child environment is exactly PATH and LANG', sorted(l.split('=')[0] for l in out.split('\n') if l), ['LANG', 'PATH'])

# --- the chunks: no piece ends in ';' (tmux would cut it), every piece after `--` -----------
SEMI = 'a' * 79 + ';;b ' + 'c' * 76 + ';' + 'd' * 79 + '\\;' + 'z' * 5 + ';'
check('no piece ends in ";" except the lone escaped one; a leading dash stays as it is',
      (all(not p.endswith(';') or p == fp.SEMICOLON for p in fp.chunks(SEMI)), fp.chunks('-x'), fp.chunks('E;'), fp.chunks(';;')),
      (True, ['-x'], ['E', '\\;'], ['\\;', '\\;']))
check('the pieces type back to the text given (semicolons, backslashes, dashes)',
      [fp.typed(fp.chunks(t)) == t for t in (TEXT, SEMI, '-' * 30 + 'x', 'F\\;', 'q;' * 90)], [True] * 5)

# --- positive: delivery ---------------------------------------------------------------------
open(e.log, 'w').close()
p = Pane()
code, out = e.run(p, ['deliver', 'proba'], TEXT.encode())
check('P deliver into an idle pane: every chunk, one Enter, landed', (code, out, text_keys(p) == TEXT, p.keys.count('Enter')), (0, 'landed', True, 1))
check('P every text key goes with -l --',
      [c[3:5] for c in p.calls if c[0] == 'send-keys' and c[3] == '-l'] == [['-l', '--']] * len(fp.chunks(TEXT)), True)
entry = e.log_lines()[-1]
check('P the log has the hash and length, not the text', (entry['decision'], entry['len'], 'TEXT' in json.dumps(entry), 'kalibracio' in json.dumps(entry)), ('ok', len(TEXT), False, False))
p = Pane()
code, out = e.run(p, ['deliver', 'proba'], SEMI.encode())
check('P a text with semicolons at piece ends and a backslash before one is typed EXACTLY (the tmux rule simulated)',
      (code, out, text_keys(p) == SEMI), (0, 'landed', True))
DASHES = 'Kotojelek: ' + '-' * 120 + ' vege'
p = Pane()
check('P a run of more than 8 dashes is typed exactly', (e.run(p, ['deliver', 'proba'], DASHES.encode())[0], text_keys(p) == DASHES), (0, True))
p = Pane(ghost=True)
check('P an empty box with a dim ghost suggestion takes a message', e.run(p, ['deliver', 'proba'], TEXT.encode())[0], 0)
p = Pane(busy=True)
check('P deliver --queued into a busy pane (Claude Code queues it)', e.run(p, ['deliver', 'proba', '--queued'], TEXT.encode()), (0, 'landed'))
p = Pane(busy=True)
check('P deliver (not queued) into a busy pane: refused, no key', (e.run(p, ['deliver', 'proba'], TEXT.encode()), p.keys), ((10, 'busy'), []))
p = Pane()
check('P deliver --queued into an idle pane: refused', e.run(p, ['deliver', 'proba', '--queued'], TEXT.encode()), (10, 'not-busy'))
p = Pane(box='valaki gepel itt valamit')
check('P a box that holds other text: refused, no key', (e.run(p, ['deliver', 'proba'], TEXT.encode()), p.keys), ((10, 'box-not-free'), []))
p = Pane(park_enters=1)
code, out = e.run(p, ['deliver', 'proba'], TEXT.encode())
check('P a swallowed Enter is retried while the box holds only our text', (code, p.keys.count('Enter')), (0, 2))
p = Pane(park_enters=99)
check('P a text that never leaves the box: parked after the retries', (e.run(p, ['deliver', 'proba'], TEXT.encode()), p.keys.count('Enter')), ((11, 'parked'), fp.SUBMIT_RETRIES + 1))
p = Pane()
e.run(p, ['deliver', 'proba'], 'Hello\x1b[31m\x03 world\nmasodik\tsor\x9b'.encode())
check('P control characters never typed; newline and tab become spaces', text_keys(p), 'Hello[31m world masodik sor')
for bad in [b'0 kezdet', b'-szal', b'  szokozzel']:
    p = Pane()
    check('P a text that would start with a digit, dash or space is refused: %r' % bad, (e.run(p, ['deliver', 'proba'], bad), p.keys), ((10, 'bad-start'), []))
p = Pane()
check('P a text over the limit is refused', e.run(p, ['deliver', 'proba'], b'A' * (fp.MAX_TEXT + 1))[0], 10)

# --- positive: dismiss, interrupt, clear, submit --------------------------------------------
want_keys = {'survey': ['0'], 'resume-summary': ['1', 'Enter'], 'feedback-draft': ['0'], 'model-consent': ['1', 'Enter'],
             'trust': ['1', 'Enter'], 'bypass': ['2', 'Enter'], 'theme': ['Enter'], 'welcome': ['Enter']}
for kind, keys in want_keys.items():
    p = Pane(screen=SCREENS[kind])
    code, _ = e.run(p, ['dismiss', 'proba', kind])
    check('P dismiss %s on its own screen: exactly %r' % (kind, keys), (code, [k.replace('INTO-DIALOG:', '') for k in p.keys]), (0, keys))
p = Pane(screen=SCREENS['trust'])
check('P the caller cannot name the kind: bypass on the trust screen sends nothing', (e.run(p, ['dismiss', 'proba', 'bypass'])[0], p.keys), (12, []))
p = Pane(screen=SCREENS['bypass'])
check('P dismiss on a login picker: never (no kind for it)', e.run(Pane(screen=' Select login method\n ❯ 1. Claude account'), ['dismiss', 'proba', 'theme'])[0], 12)
p = Pane()
check('P dismiss with no dialog: nothing', (e.run(p, ['dismiss', 'proba', 'survey'])[0], p.keys), (12, []))
p = Pane(busy=True)
check('P interrupt a running turn: Escape', (e.run(p, ['interrupt', 'proba'])[0], p.keys), (0, ['Escape']))
p = Pane()
check('P interrupt an idle pane: nothing', (e.run(p, ['interrupt', 'proba'])[0], p.keys), (12, []))
p = Pane(box='x' * 900, placeholder=True)
check('P clear a paste placeholder: Ctrl-C until it is gone', (e.run(p, ['clear', 'proba']), p.keys), ((0, 'ok'), ['C-c']))
p = Pane()
check('P clear an EMPTY box: no Ctrl-C (it would quit Claude Code)', (e.run(p, ['clear', 'proba'])[0], p.keys), (12, []))
p = Pane(box='ott maradt szoveg')
code, _ = e.run(p, ['clear', 'proba'])
check('P clear parked text: C-a then C-k/Delete rounds in ONE tmux call, no Ctrl-C',
      (code, p.keys[0], 'C-c' in p.keys, p.key_calls), (0, 'C-a', False, 1))
p = Pane(busy=True, box='sorban')
check('P clear on a busy pane: nothing', (e.run(p, ['clear', 'proba'])[0], p.keys), (12, []))
p = Pane(box='ott maradt szoveg')
check('P submit parked text: one Enter', (e.run(p, ['submit', 'proba'])[0], p.keys), (0, ['Enter']))
p = Pane()
check('P submit on an empty box: nothing', (e.run(p, ['submit', 'proba'])[0], p.keys), (12, []))

# --- positive: status, capture, stop --------------------------------------------------------
p = Pane()
check('P status running, with created', e.run(p, ['status', 'proba', '--created']), (0, '1792000000\n'))
check('P status running prints the session name (the list-sessions answer)', e.run(Pane(), ['status', 'proba']), (0, 'agent-proba\n'))
p = Pane()
e.run(p, ['capture', 'proba', '--ansi', '--lines', '2000'])
check('P capture --ansi --lines 2000: the fixed capture-pane form', p.calls[-1], ['capture-pane', '-t', 'agent-proba', '-p', '-e', '-S', '-2000'])
p = Pane()
check('P stop, then status says not running', (e.run(p, ['stop', 'proba'])[0], e.run(p, ['status', 'proba'])[0]), (0, 1))
n = len(e.log_lines())
e.run(Pane(), ['capture', 'proba'])
e.run(Pane(), ['status', 'proba'])
check('P status and capture are not logged (the watchers would flood it)', len(e.log_lines()), n)


def broken(cmd):
    raise RuntimeError('bug')


code, out = e.run(broken, ['deliver', 'proba'], TEXT.encode())
check('P a broker bug is an error exit, never 0', (code, out), (13, 'error:RuntimeError'))

# --- the shared pane samples (src/__tests__/pane-samples-shared.test.ts reads the same file) --
with open(os.path.join(HERE, 'fixtures', 'pane-samples.json'), encoding='utf-8') as f:
    SAMPLES = json.load(f)['samples']
got = []
for s in SAMPLES:
    look = {'plain': fp.strip_ansi(s['pane']), 'dimless': fp.strip_dim(s['pane'])}
    got.append((s['name'], fp.ready_refusal(look, False) is None, fp.ready_refusal(look, True) is None))
check('the broker agrees with every shared pane sample (idle, queued)', got, [(s['name'], s['idle'], s['queued']) for s in SAMPLES])

# --- the installed form -----------------------------------------------------------------------
src = open(os.path.join(SCRIPTS, 'root', 'fleet-pane.py'), encoding='utf-8').read()
check('the entry runs isolated (-I), with the fixed paths', (src.split('\n')[0], "AGENTS_FILE = '/etc/fleet-pane/agents.json'" in src,
      "TMUX = '/usr/bin/tmux'" in src, "RUNUSER = '/usr/sbin/runuser'" in src), ('#!/usr/bin/python3 -I', True, True, True))

print('\n%d FAIL' % len(FAILS) if FAILS else '\nall pass')
sys.exit(1 if FAILS else 0)
