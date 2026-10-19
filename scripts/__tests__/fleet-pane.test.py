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
import atexit
import importlib.util
import json
import re
import os
import shutil
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

# --- start and generate (the second PR): the generated root-owned start scripts ---------------
# What turns this red: a config field outside its value set reaches the script; the profile comes
# from the config the agent writes (barracuda 31245); a refused generate still writes; a claude
# binary someone else can replace is accepted (acrobot 31242); start passes anything but one item
# of the closed launch list (N5); the caller's environment reaches claude (N9).
class Pw:
    def __init__(self, uid, home):
        self.pw_uid, self.pw_dir = uid, home


class StartEnv(Env):
    """Under $HOME, not /tmp: the ownership chain refuses a world-writable directory, sticky or not."""

    def __init__(self, profile='reviewer', config=None, values=None):
        super().__init__()
        self.dir = tempfile.mkdtemp(prefix='fleet-pane-start-teszt-', dir=os.path.expanduser('~'))
        os.chmod(self.dir, 0o755)
        atexit.register(shutil.rmtree, self.dir, True)
        self.agents = os.path.join(self.dir, 'agents.json')
        self.log = os.path.join(self.dir, 'fleet-pane.log')
        me = os.getuid()
        self.work = os.path.join(self.dir, 'agents', 'proba')
        self.home = os.path.join(self.dir, 'home')
        self.start_dir = os.path.join(self.dir, 'start')
        self.bin = os.path.join(self.dir, 'bin', 'claude')
        self.out = os.path.join(self.dir, 'claude.out')
        self.token = os.path.join(self.dir, 'token')
        for d in (self.work, self.home, self.start_dir, os.path.dirname(self.bin)):
            os.makedirs(d, mode=0o755)
        with open(self.bin, 'w') as f:
            f.write('#!/usr/bin/bash\nprintf "%%s\\n" "$PWD" "$@" > %s\n/usr/bin/env > %s.env\n' % (self.out, self.out))
        os.chmod(self.bin, 0o755)
        with open(self.token, 'w') as f:
            f.write('tok-123')
        agents = {'proba': {'user': 'agent-proba', 'workdir': self.work}}
        if profile:
            agents['proba']['profile'] = profile
        with open(self.agents, 'w') as f:
            json.dump({'agents': agents}, f)
        self.values = os.path.join(self.dir, 'start-values.json')
        v = {'claudeBin': self.bin, 'oauthTokenFile': self.token, 'tz': 'Europe/Budapest', 'gitCeiling': os.path.join(self.dir, 'agents'),
             'routerUser': 'marveen', 'models': ['claude-opus-5-5', 'claude-sonnet-5-5'],
             'profiles': {'developer-senior': 'permissive', 'reviewer': 'strict'}}
        v.update(values or {})
        with open(self.values, 'w') as f:
            json.dump(v, f)
        self.write_config(config if config is not None else {'model': 'claude-opus-5-5', 'securityProfile': profile or 'reviewer'})
        self.pw = {'marveen': Pw(me, '/home/marveen'), 'agent-proba': Pw(me, self.home)}

    def write_config(self, c):
        with open(os.path.join(self.work, 'agent-config.json'), 'w') as f:
            f.write(c if isinstance(c, str) else json.dumps(c))

    def run(self, pane, argv, stdin=b'', require_root=False):
        return fp.run(argv, {'agents_file': self.agents, 'log_file': self.log, 'run': pane, 'sleep': lambda s: None,
                             'caller_uid': 1000, 'require_root': require_root, 'values_file': self.values,
                             'start_dir': self.start_dir, 'getpw': lambda n: self.pw[n], 'trusted_uid': os.getuid()}, stdin)

    def script(self):
        try:
            with open(os.path.join(self.start_dir, 'proba')) as f:
                return f.read()
        except FileNotFoundError:
            return None


class StartPane(Pane):
    def __init__(self, running=False):
        super().__init__()
        self.running = running

    def __call__(self, cmd):
        a = cmd[5:]
        if a and a[0] == 'new-session':
            assert cmd[:5] == [fp.RUNUSER, '-u', 'agent-proba', '--', fp.TMUX], cmd
            self.calls.append(a)
            self.running = True
            return 0, ''
        return super().__call__(cmd)


s = StartEnv()
code, out = s.run(StartPane(), ['generate', 'proba'])
q = fp.shlex.quote
WANT = ''.join([
    '#!/usr/bin/bash\n',
    '# fleet-pane generate proba: GENERATED, do not edit (B48 (2)); run by `fleet-pane start` only\n',
    'set -u\n', 'umask 022\n',
    'export GIT_CEILING_DIRECTORIES=%s\n' % q(os.path.join(s.dir, 'agents')),
    'export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin"\n',
    'export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false\n',
    'export CLAUDE_CONFIG_DIR=%s\n' % q(s.work + '/.claude-config'),
    'launch=()\n', 'case "$#:${1:-}" in\n', '  0:) ;;\n', '  1:--continue) launch=(--continue) ;;\n', '  2:--session-id)\n',
    '    [[ ${2:-} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "fleet-pane start: bad session id" >&2; exit 64; }\n',
    '    launch=(--session-id "$2") ;;\n', '  *) echo "fleet-pane start: bad arguments" >&2; exit 64 ;;\n', 'esac\n',
    '# path A (acrobot 31154): the token is read HERE, as the agent; root never reads it\n',
    'CLAUDE_CODE_OAUTH_TOKEN="$(cat %s)" || exit 65\n' % q(s.token), 'export CLAUDE_CODE_OAUTH_TOKEN\n',
    'cd %s || exit 66\n' % q(s.work),
    'exec %s "${launch[@]}" --model claude-opus-5-5 --name proba\n' % q(s.bin),
])
check('G generate a strict (reviewer) agent: the script, letter for letter; no bypass flag', (code, out.split(' ')[0], s.script()), (0, 'generated', WANT))
check('G the script is 0755 although the broker runs with umask 077, and its hash is logged',
      (oct(os.stat(os.path.join(s.start_dir, 'proba')).st_mode & 0o777) if s.script() else None, s.log_lines()[-1].get('script_sha256') == out.split(' ')[-1]),
      ('0o755', True))
s = StartEnv(profile='developer-senior')
s.run(StartPane(), ['generate', 'proba'])
check('G a permissive profile (root decides it): --dangerously-skip-permissions', '--dangerously-skip-permissions --model' in (s.script() or ''), True)

# refusals: nothing written, nothing started
TOOBIG = '{"model": "claude-opus-5-5", "x": "' + 'y' * fp.MAX_CONFIG + '"}'
REFUSALS = [
    ('a model outside the list', dict(config={'model': 'claude-opus-4-8', 'securityProfile': 'reviewer'}), 'model-not-allowed'),
    ('a model that tries to break the quoting', dict(config={'model': "claude-opus-5-5'; touch /tmp/pwn; '", 'securityProfile': 'reviewer'}), 'model-not-allowed'),
    ('no profile in the ROOT agents file', dict(profile=None, config={'model': 'claude-opus-5-5', 'securityProfile': 'reviewer'}), 'profile-not-allowed'),
    ('a root profile outside the value set', dict(profile='default'), 'profile-not-allowed'),
    ('the agent writes itself a permissive profile (barracuda 31245)', dict(config={'model': 'claude-opus-5-5', 'securityProfile': 'developer-senior'}), 'profile-mismatch'),
    ('no profile in the config either', dict(config={'model': 'claude-opus-5-5'}), 'profile-mismatch'),
    ('authMode api (a vault key root must not read)', dict(config={'model': 'claude-opus-5-5', 'securityProfile': 'reviewer', 'authMode': 'api'}), 'auth-mode-not-supported'),
    ('a claudePlan', dict(config={'model': 'claude-opus-5-5', 'securityProfile': 'reviewer', 'claudePlan': 'x'}), 'claudePlan-not-supported'),
    ('a claudeConfigDir', dict(config={'model': 'claude-opus-5-5', 'securityProfile': 'reviewer', 'claudeConfigDir': '/tmp'}), 'claudeConfigDir-not-supported'),
    ('a channel provider', dict(config={'model': 'claude-opus-5-5', 'securityProfile': 'reviewer', 'channel': 'telegram'}), 'channel-not-supported'),
    ('JSON that is not an object', dict(config='["claude-opus-5-5"]'), 'config-unreadable'),
    ('a config over 64 KiB', dict(config=TOOBIG), 'config-unreadable'),
    ('a values file with a model id outside the strict shape', dict(values={'models': ['claude-opus-5-5[1m]']}), 'values-file-invalid'),
    ('a values file with a relative claude path', dict(values={'claudeBin': 'bin/claude'}), 'values-file-invalid'),
]
for name, kw, why in REFUSALS:
    s = StartEnv(**kw)
    p = StartPane()
    check('G refused, nothing written: %s' % name, (s.run(p, ['generate', 'proba']), s.script(), p.calls), ((10, why), None, []))

s = StartEnv()
os.makedirs(os.path.join(s.work, '.claude', 'channels', 'telegram'))
with open(os.path.join(s.work, '.claude', 'channels', 'telegram', '.env'), 'w') as f:
    f.write('TELEGRAM_BOT_TOKEN=x\n')
check('G a channel token file with content: refused (stat only)', (s.run(StartPane(), ['generate', 'proba']), s.script()), ((10, 'channel-not-supported'), None))
s = StartEnv()
cfgp = os.path.join(s.work, 'agent-config.json')
real = os.path.join(s.dir, 'real-config.json')
os.rename(cfgp, real)
os.symlink(real, cfgp)
check('G a symlinked config: refused, not followed', (s.run(StartPane(), ['generate', 'proba']), s.script()), ((10, 'config-unreadable'), None))
s = StartEnv()
os.remove(cfgp := os.path.join(s.work, 'agent-config.json'))
os.mkfifo(cfgp)
check('G a FIFO config: refused at once (no hang)', (s.run(StartPane(), ['generate', 'proba']), s.script()), ((10, 'config-unreadable'), None))

# the claude binary: root's, nobody else can replace it, no symlink (acrobot 31242, barracuda 31245)
s = StartEnv()
os.chmod(s.bin, 0o775)
check('G a group-writable claude binary: refused', (s.run(StartPane(), ['generate', 'proba']), s.script()), ((10, 'claude-bin-writable-by-others'), None))
s = StartEnv()
os.chmod(s.bin, 0o757)
check('G a claude binary writable by others only: refused', s.run(StartPane(), ['generate', 'proba']), (10, 'claude-bin-writable-by-others'))
s = StartEnv()
os.chmod(os.path.dirname(s.bin), 0o777)
check('G a claude binary in an other-writable directory: refused', s.run(StartPane(), ['generate', 'proba']), (10, 'claude-bin-writable-by-others'))
s = StartEnv()
link = os.path.join(os.path.dirname(s.bin), 'claude-link')
os.symlink(s.bin, link)
with open(s.values) as f:
    vv = json.load(f)
vv['claudeBin'] = link
with open(s.values, 'w') as f:
    json.dump(vv, f)
check('G a claude path through a symlink: refused', s.run(StartPane(), ['generate', 'proba']), (10, 'claude-bin-symlink'))
s = StartEnv()
code, _ = fp.run(['generate', 'proba'], {'agents_file': s.agents, 'log_file': s.log, 'run': StartPane(), 'values_file': s.values,
                                         'start_dir': s.start_dir, 'getpw': lambda n: s.pw[n], 'require_root': False})
check('G with the production owner (root), a claude binary the test user owns is refused', (code, s.script()), (10, None))

# the name and the router's read clones
s = StartEnv(config={'model': 'claude-opus-5-5', 'securityProfile': 'reviewer', 'displayName': 'Medúsa 2'})
s.run(StartPane(), ['generate', 'proba'])
check('G a displayName in the pattern becomes --name', (s.script() or '').rstrip().endswith("--name 'Medúsa 2'"), True)
for bad in ['-x', 'a$(id)', "a'b", 'x' * 41, '2nd', 'a\nb']:
    s = StartEnv(config={'model': 'claude-opus-5-5', 'securityProfile': 'reviewer', 'displayName': bad})
    s.run(StartPane(), ['generate', 'proba'])
    check('G a displayName outside the pattern falls back to the agent name: %r' % bad, (s.script() or '').rstrip().endswith('--name proba'), True)
s = StartEnv()
for d in ('olvaso', 'szokozos nev', 'linkelt-cel'):
    os.makedirs(os.path.join(s.work, d, '.git'))
os.symlink(os.path.join(s.work, 'linkelt-cel'), os.path.join(s.work, 'linkelt'))
os.makedirs(os.path.join(s.work, 'nincs-git'))
s.run(StartPane(), ['generate', 'proba'])
gitline = [l for l in (s.script() or '').split('\n') if l.startswith('export GIT_CONFIG_COUNT')]
check('G read clones: a real dir with .git qualifies; a symlink, an odd name, a dir without .git do not',
      gitline, ['export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=%s GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1=%s'
                % (q(os.path.join(s.work, 'linkelt-cel')), q(os.path.join(s.work, 'olvaso')))])

# the workdir chain (barracuda, #191 review 31282): agents/ and agents/<name> are marveen's, so a
# symlink anywhere on the way would point root's reads elsewhere. Every element is opened without
# following a link, and the reads go relative to the checked dir fd.
s = StartEnv()
elsewhere = os.path.join(s.dir, 'masik-agents')
os.rename(os.path.join(s.dir, 'agents'), elsewhere)
os.symlink(elsewhere, os.path.join(s.dir, 'agents'))
p = StartPane()
check('W a symlinked parent of the workdir: refused, nothing written', (s.run(p, ['generate', 'proba']), s.script(), p.calls),
      ((10, 'workdir-unsafe'), None, []))
s = StartEnv()
real = s.work + '-valodi'
os.rename(s.work, real)
os.symlink(real, s.work)
check('W a workdir that is itself a symlink: refused', (s.run(StartPane(), ['generate', 'proba']), s.script()), ((10, 'workdir-unsafe'), None))
s = StartEnv()
os.makedirs(os.path.join(s.dir, 'mashol', 'channels', 'telegram'))
os.symlink(os.path.join(s.dir, 'mashol'), os.path.join(s.work, '.claude'))
check('W a .claude that is a symlink: counted as a channel, refused (not followed, not guessed)',
      (s.run(StartPane(), ['generate', 'proba']), s.script()), ((10, 'channel-not-supported'), None))
s = StartEnv()
os.makedirs(os.path.join(s.work, '.claude', 'channels', 'slack'))
check('W an empty channels dir without a token file: not a channel', s.run(StartPane(), ['generate', 'proba'])[0], 0)
# the swap itself: after the check, the parent is replaced by a symlink to a tree with another
# config; a read through the fd still sees the checked dir
s = StartEnv()
wfd = fp.open_workdir(s.work)
try:
    other = os.path.join(s.dir, 'csere', 'proba')
    os.makedirs(other)
    with open(os.path.join(other, 'agent-config.json'), 'w') as f:
        json.dump({'model': 'claude-sonnet-5-5', 'securityProfile': 'reviewer'}, f)
    os.rename(os.path.join(s.dir, 'agents'), os.path.join(s.dir, 'regi-agents'))
    os.symlink(os.path.join(s.dir, 'csere'), os.path.join(s.dir, 'agents'))
    check('W a parent swapped for a symlink after the check: the read stays in the checked dir',
          fp.read_config(wfd, 'agent-config.json').get('model'), 'claude-opus-5-5')
finally:
    os.close(wfd)

# start: the closed launch list (N5), the checks before the new-session
s = StartEnv()
s.run(StartPane(), ['generate', 'proba'])
UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
for argv in [['start', 'proba', '--continue', '--session-id', UUID], ['start', 'proba', '--session-id', UUID.upper()],
             ['start', 'proba', '--session-id'], ['start', 'proba', '--continue;id'], ['start', 'proba', '-c'],
             ['start', 'proba', '--model', 'claude-opus-5-5'], ['start', 'proba', '--', 'bash'], ['start', 'proba', '--continue', 'x'],
             ['generate', 'proba', '--model', 'x']]:
    p = StartPane()
    check('N5 %r: usage refusal, no tmux call' % (argv[2:],), (s.run(p, argv)[0], p.calls), (2, []))
p = StartPane(running=True)
check('S start on a running session: nothing (the router stops first)', (s.run(p, ['start', 'proba']), [c[0] for c in p.calls]), ((12, 'running'), ['has-session']))
s2 = StartEnv()
p = StartPane()
check('S start without a generated script: refused, no new-session', (s2.run(p, ['start', 'proba']), [c[0] for c in p.calls]), ((10, 'script-missing'), ['has-session']))
os.chmod(os.path.join(s.start_dir, 'proba'), 0o775)
p = StartPane()
check('S a group-writable start script: refused', (s.run(p, ['start', 'proba'])[1], [c[0] for c in p.calls]), ('script-writable-by-others', ['has-session']))
os.chmod(os.path.join(s.start_dir, 'proba'), 0o755)
LAUNCHES = {'fresh': [], 'continue': ['--continue'], 'session-id': ['--session-id', UUID]}
script = os.path.join(s.start_dir, 'proba')
PREFIX = ['new-session', '-d', '-s', 'agent-proba', '-x', '200', '-y', '24', '/usr/bin/env', '-i', 'HOME=' + s.home, 'USER=agent-proba',
          'LOGNAME=agent-proba', 'SHELL=/bin/bash', 'LANG=C.UTF-8', 'LC_ALL=C.UTF-8', 'TZ=Europe/Budapest', 'TERM=tmux-256color',
          '/usr/bin/bash', '--noprofile', '--norc', script]
SENT = {}
for kind, launch in LAUNCHES.items():
    p = StartPane()
    code, out = s.run(p, ['start', 'proba', *launch])
    SENT[kind] = p.calls[-1][8:]
    check('N5 start %s: the fixed new-session form, and from the caller only the launch item, last' % kind,
          (code, out, p.calls[-1]), (0, 'started', PREFIX + launch))
    check('S start %s is logged with its launch kind' % kind, s.log_lines()[-1].get('launch'), launch[0] if launch else 'fresh')

# the generated script, run for real (no tmux): claude gets exactly the template argv and env (N5, N9)
os.environ['BASH_ENV'] = os.path.join(s.dir, 'pwn.sh')
with open(os.environ['BASH_ENV'], 'w') as f:
    f.write('touch %s\n' % os.path.join(s.dir, 'PWNED'))
for kind, launch in LAUNCHES.items():
    if os.path.exists(s.out):
        os.remove(s.out)
    # the broker's OWN argv after the tmux part, not this file's PREFIX: a broker that drops env -i must turn this red
    r = subprocess.run(SENT[kind], capture_output=True, timeout=20)
    argv = open(s.out).read().split('\n')[:-1] if os.path.exists(s.out) else None
    envs = dict(l.split('=', 1) for l in open(s.out + '.env').read().split('\n') if '=' in l) if argv else {}
    check('N5 the script runs claude (%s) in the workdir with exactly the template argv' % kind,
          (r.returncode, argv), (0, [s.work] + launch + ['--model', 'claude-opus-5-5', '--name', 'proba']))
    check('N9 claude (%s) sees no caller variable; the token read as the agent; the config dir set' % kind,
          ([k for k in ('LD_PRELOAD', 'PYTHONPATH', 'TMUX', 'BASH_ENV') if k in envs], envs.get('CLAUDE_CODE_OAUTH_TOKEN'),
           envs.get('CLAUDE_CONFIG_DIR'), envs.get('HOME'), os.path.exists(os.path.join(s.dir, 'PWNED'))),
          ([], 'tok-123', s.work + '/.claude-config', s.home, False))
for bad in (['--continue;id'], ['$(id)'], ['--session-id', UUID.upper()], ['--session-id', UUID, 'x'], ['--continue', '--session-id', UUID], ['-c']):
    if os.path.exists(s.out):
        os.remove(s.out)
    r = subprocess.run(PREFIX[8:] + bad, capture_output=True, timeout=20)
    check('N5 the script itself refuses %r: exit 64, claude never runs' % (bad,), (r.returncode, os.path.exists(s.out)), (64, False))
del os.environ['BASH_ENV']

# the example files the installer copies are what the loaders accept (a stale example is a broken install)
ex_values = fp.load_values(os.path.join(SCRIPTS, 'root', 'fleet-pane-start-values.example.json'), False)
ex_agents = fp.load_agents(os.path.join(SCRIPTS, 'root', 'fleet-pane-agents.example.json'), False)
check('the example values and agents load, every example agent has a workdir and a profile from the value set',
      (sorted(ex_values['profiles']), all(a['workdir'] and a['profile'] in ex_values['profiles'] for a in ex_agents.values())),
      (['designer', 'developer-senior', 'marketer', 'researcher-reader', 'reviewer'], True))

# --- the installed form -----------------------------------------------------------------------
src = open(os.path.join(SCRIPTS, 'root', 'fleet-pane.py'), encoding='utf-8').read()
check('the entry runs isolated (-I), with the fixed paths', (src.split('\n')[0], "AGENTS_FILE = '/etc/fleet-pane/conf/agents.json'" in src,
      "TMUX = '/usr/bin/tmux'" in src, "RUNUSER = '/usr/sbin/runuser'" in src), ('#!/usr/bin/python3 -I', True, True, True))

# --- the TUI model (task broker-beillesztes-helyorzo, 2026-10-19) ------------------------------------
# WHAT TURNS THIS RED:
#   T1  a long message (2000 chars) typed at the broker's pace lands in ONE Enter, no stub, no Ctrl-C;
#   T2  the OLD tempo (echoWait 0, piecePause 0.03) is refused, the box left EMPTY, no Enter pressed (positive control: the
#       model does reproduce the measured folding, so T1 is not green by accident);
#   T4/T5  a TUI that draws late: the broker refuses `no-echo` and never presses Enter on a part; text that appears only
#       after the wait is emptiable by `clear --expect` (the router's net), never by the broker's own authority beyond a prefix;
#   T6-T8  `clear --expect` / `submit --expect` act ONLY on a box that holds our text; a stub with nothing of ours beside it,
#       or another text, is refused and no key is sent;
#   T7  Ctrl-C goes only after a STABLE look that still shows the stub: an empty stable look ends the loop (a second Ctrl-C on an
#       empty box starts the exit: `exit_presses` stays 0);
#   T9  the broker's own deadline: the typing stops, the typed beginning is emptied, `deliver-timeout`;
#   T10 the pace file: only a trusted, in-range file changes the tempo;
#   T13 somebody else's draft in the box is never emptied by a failed deliver (`not-in-box`, no Ctrl-C, no Delete, no Enter).
# THE MODEL IS NOT MEASURED ON THE REAL TUI (the claude binary is not available to the author). Its parameters come from the
# live pane capture in acrobot 33100: pieces closer than GAP are gathered and, past FOLD_AT chars, the first piece stays verbatim
# and the rest folds into `[Pasted text #N]`; an Enter on a stub only unfolds it; Ctrl-C on an empty box starts the exit.
class Tui(Pane):
    GAP = 0.10
    FOLD_AT = 700

    def __init__(self, late=0.0, redraw_delay=0.3, intrude=None, **kw):
        super().__init__(**kw)
        self.intrude = intrude
        self.T = 0.0
        self.buf, self.burst, self.last, self.stub_content = '', [], None, ''
        self.late, self.redraw_delay = late, redraw_delay
        self.shown, self.queue = '', []
        self.exit_presses, self.submitted, self.stubs = 0, [], 0

    def preset(self, text):
        self.buf = self.shown = text

    def advance(self, secs):
        self.T += secs

    def real(self):
        return self.buf + ''.join(self.burst)

    def flush(self, force=False):
        if self.burst and (force or self.T - self.last >= self.GAP):
            if len(self.burst) >= 2 and sum(len(x) for x in self.burst) > self.FOLD_AT:
                self.stubs += 1
                self.buf += self.burst[0] + '[Pasted text #%d]' % self.stubs
                self.stub_content += ''.join(self.burst[1:])
            else:
                self.buf += ''.join(self.burst)
            self.burst = []
            self.queue.append((((self.T if force else self.last + self.GAP)) + self.late, self.buf))

    def visible(self):
        self.flush()
        for due, txt in sorted(self.queue, key=lambda q: q[0]):
            if due <= self.T:
                self.shown = txt
        self.queue = [q for q in self.queue if q[0] > self.T]
        return self.shown

    def on_text(self, text):
        if self.intrude:
            # somebody else's text lands in the box just before our first piece
            self.buf, self.shown, self.intrude = self.intrude, self.intrude, None
        if self.burst and self.T - self.last >= self.GAP:
            self.flush()
        self.burst.append(text)
        self.last = self.T

    def on_key(self, k):
        if k == 'C-c':
            if not self.real():
                self.exit_presses += 1
            else:
                self.buf, self.burst, self.stub_content = '', [], ''
                self.queue = [(self.T + self.redraw_delay, '')]
        elif k == 'Enter':
            self.flush(force=True)
            if '[Pasted text' in self.buf:
                self.buf = re.sub(r'\[Pasted text #\d+\]', lambda m: self.stub_content, self.buf, count=1)
                self.stub_content, self.queue, self.shown = '', [], self.buf
            elif self.buf:
                self.submitted.append(self.buf)
                self.buf, self.shown, self.queue, self.busy = '', '', [], True
        elif k in ('C-k', 'Delete') and '[Pasted text' not in self.real():
            self.buf, self.burst = '', []
            self.queue = [(self.T, '')]

    def __call__(self, cmd):
        a = cmd[5:]
        if a[0] == 'capture-pane':
            self.calls.append(a)
            self.n_looks += 1
            self.box = self.visible()
            return 0, self.render()
        if a[0] == 'send-keys':
            self.calls.append(a)
            if a[3] == '-l':
                m = re.match(r'^(.*?)(\\*);$', a[5], re.S)
                text = a[5] if not m else m.group(1) + (';' if m.group(2) else '')
                self.keys.append('TEXT:' + text)
                self.on_text(text)
                return 0, ''
            for k in a[3:]:
                self.keys.append(k)
                self.on_key(k)
            return 0, ''
        return super().__call__(cmd)


TENV = Env()
PDIR = tempfile.mkdtemp(prefix='fleet-pane-pace-teszt-', dir=os.path.expanduser('~'))
os.chmod(PDIR, 0o755)
atexit.register(shutil.rmtree, PDIR, True)


def pace_file(name, content, mode=0o644):
    path = os.path.join(PDIR, name)
    with open(path, 'w') as f:
        f.write(content if isinstance(content, str) else json.dumps(content))
    os.chmod(path, mode)
    return path


def tui_run(pane, argv, stdin=b'', pace=None):
    cfg = {'agents_file': TENV.agents, 'log_file': TENV.log, 'run': pane, 'sleep': pane.advance, 'caller_uid': 1000,
           'require_root': False}
    if pace:
        cfg.update(pace_file=pace, trusted_uid=os.getuid())
    return fp.run(argv, cfg, stdin)


def tui_state(p):
    return (p.submitted, p.real(), p.exit_presses)


LONG = ('Az elso sor a teszt uzenet, nem vegleges. ' * 60)[:2000]
OLD_PACE = pace_file('old.json', {'echoWait': 0, 'piecePause': 0.03})

p = Tui()
check('T1 a 2000 char message at the default pace: one Enter, the whole text, no stub, no Ctrl-C',
      (tui_run(p, ['deliver', 'proba'], LONG.encode()), p.submitted == [LONG], p.stubs, p.exit_presses, 'C-c' in p.keys),
      ((0, 'landed'), True, 0, 0, False))

p = Tui()
check('T2 the OLD tempo folds into a stub: refused placeholder-cleared, box EMPTY, no Enter, no exit',
      (tui_run(p, ['deliver', 'proba'], LONG.encode(), OLD_PACE), tui_state(p), p.stubs >= 2), ((11, 'placeholder-cleared'), ([], '', 0), True))

p = Tui()
check('T3 a short message at the old tempo is not folded (no more than the fold limit): lands',
      (tui_run(p, ['deliver', 'proba'], TEXT.encode(), OLD_PACE), p.submitted == [TEXT], p.stubs), ((0, 'landed'), True, 0))

p = Tui()
check('T4 an echo wait shorter than the gather gap: refused no-echo, the typed beginning emptied, no Enter',
      (tui_run(p, ['deliver', 'proba'], LONG.encode(), pace_file('short.json', {'echoWait': 0.05, 'piecePause': 0.01})),
       tui_state(p)), ((11, 'no-echo'), ([], '', 0)))

p = Tui(late=5.0)
code = tui_run(p, ['deliver', 'proba'], LONG.encode())
text_left = p.real()
p.advance(10)
check('T5 a TUI that draws 5 s late: refused no-echo, no Enter; our text is in the box UNSEEN, and `clear --expect` empties it',
      (code, p.submitted, text_left.startswith(LONG[:80]), tui_run(p, ['clear', 'proba', '--expect'], LONG.encode()), p.real(), p.exit_presses),
      ((11, 'no-echo'), [], True, (0, 'ok'), '', 0))

p = Tui(redraw_delay=0.3)
p.preset(LONG[:80] + '[Pasted text #1]')
p.stub_content = LONG[80:]
check('T6 clear --expect on a stub with a verbatim run of OUR text: one Ctrl-C, empty, no exit',
      (tui_run(p, ['clear', 'proba', '--expect'], LONG.encode()), p.keys.count('C-c'), tui_state(p)), ((0, 'ok'), 1, ([], '', 0)))
p = Tui()
p.preset(LONG[:80] + '[Pasted text #1]')
check('T6b clear --expect with another expected text: refused not-ours, no key at all',
      (tui_run(p, ['clear', 'proba', '--expect'], b'Teljesen mas szoveg, amit nem mi irtunk be.'), p.keys), ((12, 'not-ours'), []))
p = Tui()
p.preset('[Pasted text #1]')
check('T6c clear --expect on a bare stub (nothing of ours beside it): refused not-ours, no key',
      (tui_run(p, ['clear', 'proba', '--expect'], LONG.encode()), p.keys), ((12, 'not-ours'), []))

p = Tui(redraw_delay=0.3)
p.preset(LONG[:80] + '[Pasted text #1]')
tui_run(p, ['clear', 'proba'])
check('T7 the stub vanishes 0.3 s after the Ctrl-C: ONE Ctrl-C, never a second on the empty box',
      (p.keys.count('C-c'), p.exit_presses, p.real()), (1, 0, ''))
p = Tui(redraw_delay=0.55)
p.preset(LONG[:80] + '[Pasted text #1]')
tui_run(p, ['clear', 'proba'])
check('T7c the stub still shows at the first look after the Ctrl-C and is gone at the next: the looks differ, so NO second Ctrl-C',
      (p.keys.count('C-c'), p.exit_presses, p.real()), (1, 0, ''))
p = Tui()
check('T7b clear on an empty box: refused box-empty, no Ctrl-C', (tui_run(p, ['clear', 'proba']), p.keys), ((12, 'box-empty'), []))

p = Tui()
p.preset(TEXT)
check('T8 submit --expect on our text: one Enter, submitted', (tui_run(p, ['submit', 'proba', '--expect'], TEXT.encode()), p.submitted), ((0, 'ok'), [TEXT]))
p = Tui()
p.preset(TEXT[:60] + '[Pasted text #1]')
check('T8b submit --expect on a stub of our text: refused placeholder, no Enter', (tui_run(p, ['submit', 'proba', '--expect'], TEXT.encode()), p.keys), ((12, 'placeholder'), []))
p = Tui()
p.preset('valaki mas piszkozata')
check('T8c submit --expect on another text: refused not-ours, no Enter', (tui_run(p, ['submit', 'proba', '--expect'], TEXT.encode()), p.keys), ((12, 'not-ours'), []))
p = Tui()
p.preset(TEXT)
check('T8d submit without --expect keeps the old behaviour (Enter)', (tui_run(p, ['submit', 'proba']), p.submitted), ((0, 'ok'), [TEXT]))
p = Tui()
check('T8e an empty --expect text is a bad option value', tui_run(p, ['submit', 'proba', '--expect'], b'  '), (2, 'bad-expect'))

saved = (fp.DELIVER_BASE, fp.DELIVER_PER_PIECE)
fp.DELIVER_BASE, fp.DELIVER_PER_PIECE = 0.3, 0.0
try:
    p = Tui()
    res = tui_run(p, ['deliver', 'proba'], LONG.encode())
finally:
    fp.DELIVER_BASE, fp.DELIVER_PER_PIECE = saved
check('T9 the broker deadline: typing stops, the typed beginning is emptied, deliver-timeout, no Enter',
      (res, tui_state(p), len([k for k in p.keys if k.startswith('TEXT:')]) < 25), ((11, 'deliver-timeout'), ([], '', 0), True))

PD = fp.load_pace
check('T10 no pace file: the built-in values', PD(os.path.join(PDIR, 'nincs.json'), os.getuid()), {'piece': fp.PIECE_PAUSE, 'echo': fp.ECHO_WAIT})
check('T10 a valid trusted file: its values', PD(pace_file('ok.json', {'echoWait': 1.5, 'piecePause': 0.2}), os.getuid()), {'piece': 0.2, 'echo': 1.5})
for name, content, mode in (('hi.json', {'echoWait': 3, 'piecePause': 0.1}, 0o644), ('lo.json', {'echoWait': 0.5, 'piecePause': 0}, 0o644),
                            ('neg.json', {'echoWait': -1, 'piecePause': 0.1}, 0o644), ('bool.json', {'echoWait': True, 'piecePause': 0.1}, 0o644),
                            ('str.json', {'echoWait': '1', 'piecePause': 0.1}, 0o644), ('half.json', {'echoWait': 1}, 0o644),
                            ('junk.json', 'nem json', 0o644), ('list.json', [1, 2], 0o644),
                            ('gw.json', {'echoWait': 1.5, 'piecePause': 0.2}, 0o664)):
    check('T10 %s: the built-in values' % name, PD(pace_file(name, content, mode), os.getuid()), {'piece': fp.PIECE_PAUSE, 'echo': fp.ECHO_WAIT})
os.symlink(os.path.join(PDIR, 'ok.json'), os.path.join(PDIR, 'link.json'))
check('T10 a symlink: the built-in values', PD(os.path.join(PDIR, 'link.json'), os.getuid()), {'piece': fp.PIECE_PAUSE, 'echo': fp.ECHO_WAIT})

p = Tui()
p.preset('valaki mas piszkozata ')
res = tui_run(p, ['deliver', 'proba'], TEXT.encode())
check('T13a a draft already in the box: refused box-not-free, no key at all', (res, p.keys), ((10, 'box-not-free'), []))
p = Tui(intrude='valaki mas piszkozata ')
res = tui_run(p, ['deliver', 'proba'], TEXT.encode())
check('T13 somebody else\'s draft lands mid-typing: not-in-box, nothing emptied (no Ctrl-C, no Delete, no Enter)',
      (res, [k for k in p.keys if k in ('C-c', 'C-k', 'Delete', 'Enter')], p.real().startswith('valaki mas piszkozata ')), ((11, 'not-in-box'), [], True))

check('T14 the deadline constants: broker 40 s + 2.2 s per piece', (fp.DELIVER_BASE, fp.DELIVER_PER_PIECE), (40.0, 2.2))

print('\n%d FAIL' % len(FAILS) if FAILS else '\nall pass')
sys.exit(1 if FAILS else 0)
