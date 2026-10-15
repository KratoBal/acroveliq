#!/usr/bin/python3 -I
"""fleet-pane: the router's ONE way into an agent's tmux pane, run as root (B48 (2), P1-13).

Replaces the sudoers line `marveen ALL=(agent-*) NOPASSWD: /usr/bin/tmux`, which gives the
router (and anything running as `marveen`) a full shell as every agent user (`tmux new-session
<command>`, `run-shell`). This broker takes a CLOSED list of verbs and never turns caller text
into a tmux command or option. Plan: exchange/biztonsag/baseline/b48-kezbesito-terv-2026-10-13.md
(42879c96, barracuda APPROVE); first PR: acrobot 31133.

THE INSTALLED COPY RUNS, NOT THIS FILE: /usr/local/sbin/fleet-pane, root:root 0755, with
  marveen ALL=(root) NOPASSWD: /usr/local/sbin/fleet-pane
The repo is writable by `marveen`; running it from here would put us back where we started.
Installing it, the sudoers line, and removing the tmux line are Balázs's steps, separately approved.

Verbs (argv[1]); the agent must be listed in the root-owned /etc/fleet-pane/agents.json:
  status <agent> [--created]          running? (exit 0 yes, 1 no); prints the session name, or with
                                      --created its #{session_created}
  capture <agent> [--ansi] [--lines N] the pane text (N <= 2000 lines of history)
  stop <agent>                        kill-session
  deliver <agent> [--queued]          the text on STDIN, typed and submitted, see deliver()
  dismiss <agent> <kind>              one known dialog, matched HERE, with its fixed keys
  interrupt <agent>                   Escape, only while a turn runs and no dialog is up
  clear <agent>                       empty a parked input box (no dialog, not busy)
  submit <agent>                      Enter on a parked input box (no dialog, not busy)
`start` is the second PR (generated root-owned start scripts; the session-id with nautilus).

WHAT THIS DOES NOT DO, said aloud:
  - no verb answers a permission question: every key is preceded by a fresh look at the pane,
    and a permission question, a menu, or an unknown screen refuses;
  - the look before the Enter and the Enter are a few milliseconds apart: a dialog that appears
    exactly there takes the Enter (plan 4.3, barracuda agreed). After the Enter the pane is
    looked at again and a dialog then is logged as `suspect-accept`;
  - it does not know who sent the text (plan 4.4: the message store is `marveen`'s);
  - the pane rules here are a conservative copy of src/pane-state.ts: when unsure, it refuses.
    A refusal is "not now": the router keeps the message and tries again.

Exit codes: 0 done; 1 not running (status); 2 usage; 10 refused before any key (nothing typed);
11 typed but not landed; 12 nothing to do (the dialog or state was not there); 13 tmux failed.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

AGENTS_FILE = '/etc/fleet-pane/agents.json'
LOG_FILE = '/var/log/fleet-pane.log'
RUNUSER = '/usr/sbin/runuser'
TMUX = '/usr/bin/tmux'
# the agent's tmux gets this and nothing from the caller (sudo's env_reset, and we pass our own)
CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}

NAME_RX = re.compile(r'^[a-z][a-z0-9-]{1,30}$')
USER_RX = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
MAX_TEXT = 32000
MAX_LINES = 2000
CHUNK = 80
MAX_SLIDE = 8
SUBMIT_RETRIES = 3

# --- the pane rules (a conservative copy of src/pane-state.ts) -----------------------------
IDLE_FOOTER_RX = re.compile(
    r'(?:[A-Za-z][\w-]* ){1,3}on(?: \(shift\+tab to cycle\)| · [^\n]*?(?:ctrl\+t|↓ to manage|← for agents))'
    r'|[⏵⏸]+ (?:[A-Za-z][\w-]* ){1,3}on · [^\n]*…[ \t]*(?=\n|$)'
    r'|\? for shortcuts')
BUSY_RXS = [
    re.compile(r'\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·\s*↓\s*\d'),
    re.compile(r'\b(?:Combobulating|Beaming|Thinking|Pondering|Reticulating|Configuring|Noodling|Ruminating|'
               r'Percolating|Cogitating|Deliberating|Contemplating|Musing|Brewing|Synthesizing|Distilling|'
               r'Refining|Simmering|Crafting|Formulating|Consulting|Unfurling|Unspooling|Unraveling)…'
               r'\s*\(\s*(?:\d+h\s*)?(?:\d+m\s*)?\d+s\s*·\s*↓'),
]
ESC_TO_INTERRUPT_RX = re.compile(r'\besc to interrupt\b')
FOOTER_LINES = 5
LIVE_LINES = 12
MENU_LINES = 8
PERMISSION_RX = re.compile(r'Do you want to|requires approval')
MENU_NAV_RX = re.compile(r'(?:↑/↓|↑↓)\s+to\s+(?:navigate|select|choose)')
MENU_ESC_RX = re.compile(r'\besc to (?:cancel|exit|close|go back|quit)\b', re.I)
BOX_SEP_RX = re.compile(r'^─{10,}')
QUEUE_HINT_RX = re.compile(r'Press up to edit queued messages')
PASTE_RX = re.compile(r'\[Pasted text\s*#\s*\d')
BYPASS_RX = re.compile(r'bypass permissions on')
SURVEY_RX = re.compile(r'How is Claude doing this session')
RESUME_RX = re.compile(r'Resume from summary')
CONFIRM_RX = re.compile(r'Enter to confirm')
CONSENT_TITLE_RX = re.compile(r'(?:now uses|runs on|requires) usage credits')
CONSENT_CONTINUE_RX = re.compile(r'1\.\s*Continue with ')
FEEDBACK_OPTIONS_RX = re.compile(r'^[^\S\n]*│.*?\d+ to review\b.*?\d+ to send\b.*?\d+ to dismiss\b')
FEEDBACK_OPTOUT_RX = re.compile(r'Turn off Claude-drafted feedback')
PROMPT_RX = re.compile(r'^[^\S\n]*❯')
FIRST_RUN = [('trust', re.compile(r'Do you trust the files in this folder\?')),
             ('bypass', re.compile(r'Bypass Permissions mode')),
             ('login', re.compile(r'Select login method')),
             ('theme', re.compile(r'Choose the text style')),
             ('welcome', re.compile(r'Welcome to Claude Code'))]


def tail(pane, n):
    return '\n'.join(pane.split('\n')[-n:])


def strip_ansi(s):
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b[^\[]', '', s)


def strip_dim(s):
    """The pane without the characters drawn dim (SGR 2): the ghost suggestion in an empty box."""
    out, dim, i, n = [], False, 0, len(s)
    while i < n:
        if s[i] == '\x1b':
            if i + 1 >= n or s[i + 1] != '[':
                i += 2
                continue
            j = i + 2
            while j < n and not ('@' <= s[j] <= '~'):
                j += 1
            if j < n and s[j] == 'm':
                codes = s[i + 2:j].split(';') if s[i + 2:j] else ['']
                k = 0
                while k < len(codes):
                    c = codes[k]
                    if c in ('38', '48'):
                        mode = codes[k + 1] if k + 1 < len(codes) else ''
                        k += 3 if mode == '5' else 5 if mode == '2' else 1
                        continue
                    if c == '2':
                        dim = True
                    elif c in ('0', '22', ''):
                        dim = False
                    k += 1
            i = j + 1
            continue
        if not dim:
            out.append(s[i])
        i += 1
    return ''.join(out)


def busy(pane):
    return any(rx.search(tail(pane, LIVE_LINES)) for rx in BUSY_RXS) or bool(ESC_TO_INTERRUPT_RX.search(tail(pane, FOOTER_LINES)))


def feedback_draft(pane):
    lines = pane.split('\n')
    if busy(pane):
        return False
    start = max(0, len(lines) - LIVE_LINES)
    at = next((i for i in range(len(lines) - 1, start - 1, -1) if FEEDBACK_OPTIONS_RX.search(lines[i])), -1)
    return at >= 0 and any(PROMPT_RX.search(lines[i]) for i in range(at + 1, len(lines)))


def model_consent(pane):
    return (not busy(pane) and not IDLE_FOOTER_RX.search(pane) and bool(CONSENT_TITLE_RX.search(pane))
            and bool(CONSENT_CONTINUE_RX.search(pane)) and bool(CONFIRM_RX.search(tail(pane, FOOTER_LINES))))


def first_run(pane):
    if busy(pane) or IDLE_FOOTER_RX.search(pane):
        return None
    for kind, rx in FIRST_RUN:
        if rx.search(pane) and not (kind == 'welcome' and '❯' in pane):
            return kind
    return None


def dialog(pane):
    """A screen a keystroke would answer, by name; None when there is none."""
    if not pane or not pane.strip():
        return 'no-capture'
    if feedback_draft(pane):
        return 'feedback-draft'
    if FEEDBACK_OPTOUT_RX.search(tail(pane, LIVE_LINES)):
        return 'feedback-optout'
    if model_consent(pane):
        return 'model-consent'
    if PERMISSION_RX.search(tail(pane, LIVE_LINES)):
        return 'permission-question'
    # the known dialogs before the generic menu: they carry an "Esc to ..." line too
    fr = first_run(pane)
    if fr:
        return 'first-run-' + fr
    if RESUME_RX.search(tail(pane, LIVE_LINES)) and CONFIRM_RX.search(tail(pane, FOOTER_LINES)):
        return 'resume-summary'
    if SURVEY_RX.search(tail(pane, LIVE_LINES)):
        return 'survey'
    if MENU_NAV_RX.search(tail(pane, MENU_LINES)) or MENU_ESC_RX.search(tail(pane, MENU_LINES)):
        return 'menu'
    return None


def box_rows(pane):
    """The live input box's rows, bottom-anchored (its lower separator above the footer)."""
    lines = pane.split('\n')
    footer = next((i for i, l in enumerate(lines) if IDLE_FOOTER_RX.search(l)), -1)
    if footer < 0:
        return None
    bottom = next((i for i in range(footer - 1, -1, -1) if BOX_SEP_RX.search(lines[i])), -1)
    if bottom <= 0:
        return None
    top = next((i for i in range(bottom - 1, -1, -1) if BOX_SEP_RX.search(lines[i])), -1)
    return lines[top + 1:bottom]


def rows_free(rows):
    return rows is not None and all(re.match(r'^\s*❯?\s*$', r) for r in rows if not QUEUE_HINT_RX.search(r))


def box_free(look):
    return rows_free(box_rows(look['plain'])) or rows_free(box_rows(look['dimless']))


def collapse(s):
    return re.sub(r'\s+', ' ', s).strip()


def box_holds_only(plain, text):
    """Every visible box row is a piece of OUR text, and one is long enough to be evidence."""
    rows = box_rows(plain)
    if rows is None:
        return False
    whole = collapse(text)
    pieces = [collapse(re.sub(r'^\s*❯', '', r)) for r in rows]
    pieces = [p for p in pieces if p]
    return bool(pieces) and any(len(p) >= 16 for p in pieces) and all(p in whole for p in pieces)


def ready_refusal(look, queued):
    """Why the pane may NOT take a message now, or None."""
    plain = look['plain']
    d = dialog(plain)
    if d:
        return d
    if not IDLE_FOOTER_RX.search(plain):
        return 'no-footer'
    if box_rows(plain) is None:
        return 'no-box'
    if PASTE_RX.search('\n'.join(box_rows(plain))):
        return 'placeholder'
    if queued:
        if not busy(plain):
            return 'not-busy'
        if not BYPASS_RX.search(tail(plain, FOOTER_LINES)):
            return 'not-bypass'
    elif busy(plain):
        return 'busy'
    return None if box_free(look) else 'box-not-free'


def clean_text(text):
    """One line: newlines and tabs to spaces, every other control character (C0, DEL, C1) out."""
    text = re.sub(r'[\r\n\t]', ' ', text)
    return re.sub(r'[\x00-\x1f\x7f-\x9f]', '', text)


def chunks(line):
    """CHUNK-sized literal pieces; a piece never starts with '-' (tmux would read a flag)."""
    out, i = [], 0
    while i < len(line):
        end, slide = min(i + CHUNK, len(line)), 0
        while end < len(line) and line[end] == '-' and slide < MAX_SLIDE:
            end, slide = end + 1, slide + 1
        c = line[i:end]
        out.append(' ' + c if c.startswith('-') else c)
        i = end
    return out


# --- the broker -----------------------------------------------------------------------------
class Refused(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code, self.reason = code, reason


class Broker:
    def __init__(self, cfg, agent):
        self.cfg, self.agent = cfg, agent
        self.user = cfg['agents'][agent]['user']
        self.session = 'agent-' + agent
        self.sleep = cfg.get('sleep', time.sleep)

    def tmux(self, *args, check=True):
        r = self.cfg['run']([RUNUSER, '-u', self.user, '--', TMUX, *args])
        if check and r[0] != 0:
            raise Refused(13, 'tmux-failed')
        return r

    def look(self):
        rc, out = self.tmux('capture-pane', '-t', self.session, '-e', '-p', check=False)
        out = out if rc == 0 else ''
        return {'plain': strip_ansi(out), 'dimless': strip_dim(out)}

    def key(self, name):
        self.tmux('send-keys', '-t', self.session, name)

    # status / capture / stop
    def status(self, created):
        rc, _ = self.tmux('has-session', '-t', self.session, check=False)
        if rc != 0:
            return 1, ''
        if not created:
            # the session name, so the router's `list-sessions -F #{session_name}` reads the same
            return 0, self.session + '\n'
        _, out = self.tmux('display-message', '-p', '-t', self.session, '#{session_created}')
        return 0, out

    def capture(self, ansi, lines):
        args = ['capture-pane', '-t', self.session, '-p'] + (['-e'] if ansi else []) + (['-S', '-%d' % lines] if lines else [])
        _, out = self.tmux(*args)
        return 0, out

    def stop(self):
        self.tmux('kill-session', '-t', self.session)
        return 0, ''

    # keys behind a look
    def interrupt(self):
        p = self.look()['plain']
        if dialog(p) or not ESC_TO_INTERRUPT_RX.search(tail(p, FOOTER_LINES)):
            raise Refused(12, 'not-interruptible')
        self.key('Escape')
        return 0, 'ok'

    def dismiss(self, kind):
        """The router's own dialog answers (plan 4.5); the kind is MATCHED here, not trusted."""
        plain = self.look()['plain']
        found = dialog(plain)
        want = {'survey': 'survey', 'resume-summary': 'resume-summary', 'feedback-draft': 'feedback-draft',
                'model-consent': 'model-consent', 'trust': 'first-run-trust', 'bypass': 'first-run-bypass',
                'theme': 'first-run-theme', 'welcome': 'first-run-welcome'}[kind]
        if found != want:
            raise Refused(12, 'not-present:%s' % (found or 'none'))
        keys = {'survey': ['0'], 'resume-summary': ['1', 'Enter'], 'feedback-draft': ['0'],
                'model-consent': ['1', 'Enter'], 'trust': ['1', 'Enter'], 'bypass': ['2', 'Enter'],
                'theme': ['Enter'], 'welcome': ['Enter']}[kind]
        for i, k in enumerate(keys):
            # before every key after the first: the same dialog still there
            if i and dialog(self.look()['plain']) != want:
                raise Refused(11, 'dialog-changed')
            self.key(k)
            self.sleep(0.15)
        if kind == 'feedback-draft':
            # "0" closed the draft; the offer to turn drafting off is answered Esc (keep)
            self.sleep(0.3)
            if dialog(self.look()['plain']) == 'feedback-optout':
                self.key('Escape')
        return 0, 'ok'

    def parked_ok(self, look):
        p = look['plain']
        if dialog(p):
            return 'dialog:' + dialog(p)
        if busy(p) or not IDLE_FOOTER_RX.search(p) or box_rows(p) is None:
            return 'not-idle'
        if box_free(look):
            return 'box-empty'
        return None

    def clear(self):
        look = self.look()
        why = self.parked_ok(look)
        if why:
            raise Refused(12, why)
        if PASTE_RX.search('\n'.join(box_rows(look['plain']))):
            # Ctrl-C empties a placeholder; on an EMPTY box it would quit: look before each press
            for _ in range(3):
                self.key('C-c')
                self.sleep(0.45)
                look = self.look()
                if self.parked_ok(look) or not PASTE_RX.search('\n'.join(box_rows(look['plain']) or [])):
                    break
        else:
            rows = len([r for r in box_rows(look['plain']) if r.strip().lstrip('❯').strip()])
            for k in ['C-a'] + ['C-k', 'Delete'] * min(240, max(12, rows * 4)):
                self.key(k)
            self.sleep(0.1)
        return (0, 'ok') if box_free(self.look()) else (11, 'not-empty')

    def submit(self):
        look = self.look()
        why = self.parked_ok(look)
        if why:
            raise Refused(12, why)
        self.key('Enter')
        return 0, 'ok'

    def deliver(self, text, queued):
        line = clean_text(text)
        if not line.strip():
            raise Refused(10, 'empty')
        if len(line) > MAX_TEXT:
            raise Refused(10, 'too-long')
        # the first key is never a digit, a space or a key name: a letter or the envelope's '['
        if not re.match(r'[A-Za-z\[]', line):
            raise Refused(10, 'bad-start')
        first = ready_refusal(self.look(), queued)
        if first:
            raise Refused(10, first)
        self.sleep(0.25)
        second = ready_refusal(self.look(), queued)
        if second:
            raise Refused(10, second + '@confirm')
        for c in chunks(line):
            d = dialog(self.look()['plain'])
            if d:
                raise Refused(11, 'dialog-while-typing:' + d)
            self.tmux('send-keys', '-t', self.session, '-l', c)
            self.sleep(0.03)
        before = self.look()
        d = dialog(before['plain'])
        if d:
            raise Refused(11, 'dialog-before-enter:' + d)
        if not box_holds_only(before['plain'], line):
            raise Refused(11, 'placeholder' if PASTE_RX.search(before['plain']) else 'not-in-box')
        for attempt in range(SUBMIT_RETRIES + 1):
            self.key('Enter')
            self.sleep(0.4)
            after = self.look()
            d = dialog(after['plain'])
            if d:
                # the Enter may have answered a dialog that appeared after the look (plan 4.3 #8)
                self.cfg['log_extra'] = {'suspect-accept': d}
                raise Refused(11, 'dialog-after-enter:' + d)
            if box_free(after) or busy(after['plain']) and not box_holds_only(after['plain'], line):
                return 0, 'landed'
            if not box_holds_only(after['plain'], line):
                raise Refused(11, 'box-changed')
        raise Refused(11, 'parked')


# --- entry ----------------------------------------------------------------------------------
USAGE = 'usage: fleet-pane status|capture|stop|deliver|dismiss|interrupt|clear|submit <agent> [...]'
DISMISS_KINDS = ('survey', 'resume-summary', 'feedback-draft', 'model-consent', 'trust', 'bypass', 'theme', 'welcome')


def load_agents(path, require_root):
    st = os.stat(path)
    if require_root and (st.st_uid != 0 or st.st_mode & 0o022):
        raise Refused(2, 'agents-file-not-root-owned')
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    agents = {}
    for name, a in (data.get('agents') or {}).items():
        if NAME_RX.match(name) and isinstance(a, dict) and USER_RX.match(str(a.get('user', ''))):
            agents[name] = {'user': a['user']}
    return agents


def parse(argv):
    if len(argv) < 2 or argv[0] not in ('status', 'capture', 'stop', 'deliver', 'dismiss', 'interrupt', 'clear', 'submit'):
        raise Refused(2, 'unknown-verb')
    verb, agent, rest = argv[0], argv[1], argv[2:]
    if not NAME_RX.match(agent):
        raise Refused(2, 'bad-agent')
    opts = {}
    allowed = {'status': {'--created'}, 'capture': {'--ansi', '--lines'}, 'deliver': {'--queued'}, 'dismiss': set()}.get(verb, set())
    i = 0
    if verb == 'dismiss':
        if len(rest) != 1 or rest[0] not in DISMISS_KINDS:
            raise Refused(2, 'bad-kind')
        return verb, agent, {'kind': rest[0]}
    while i < len(rest):
        a = rest[i]
        if a not in allowed:
            raise Refused(2, 'bad-option')
        if a == '--lines':
            if i + 1 >= len(rest) or not re.fullmatch(r'[1-9][0-9]{0,3}', rest[i + 1]) or int(rest[i + 1]) > MAX_LINES:
                raise Refused(2, 'bad-lines')
            opts['lines'] = int(rest[i + 1])
            i += 2
            continue
        opts[a.lstrip('-')] = True
        i += 1
    return verb, agent, opts


def run(argv, cfg, stdin_bytes=b''):
    """(exit code, stdout text). Everything the caller gives is in argv and stdin; cfg is ours."""
    entry = {'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'uid': cfg.get('caller_uid'),
             'verb': argv[0] if argv else None, 'agent': argv[1] if len(argv) > 1 else None}
    try:
        verb, agent, opts = parse(argv)
        agents = load_agents(cfg['agents_file'], cfg.get('require_root', True))
        if agent not in agents:
            raise Refused(2, 'agent-not-listed')
        b = Broker(dict(cfg, agents=agents), agent)
        if verb == 'status':
            code, out = b.status(opts.get('created', False))
        elif verb == 'capture':
            code, out = b.capture(opts.get('ansi', False), opts.get('lines'))
        elif verb == 'stop':
            code, out = b.stop()
        elif verb == 'interrupt':
            code, out = b.interrupt()
        elif verb == 'dismiss':
            code, out = b.dismiss(opts['kind'])
            entry['kind'] = opts['kind']
        elif verb == 'clear':
            code, out = b.clear()
        elif verb == 'submit':
            code, out = b.submit()
        else:
            if len(stdin_bytes) > MAX_TEXT * 4:
                raise Refused(10, 'too-long')
            text = stdin_bytes.decode('utf-8', errors='replace')
            entry['sha256'] = hashlib.sha256(text.encode('utf-8')).hexdigest()
            entry['len'] = len(text)
            code, out = b.deliver(text, opts.get('queued', False))
        entry.update(decision='ok' if code == 0 else 'refused', reason=None if code == 0 else out)
        if 'log_extra' in b.cfg:
            entry.update(b.cfg['log_extra'])
    except Refused as r:
        code, out = r.code, r.reason
        entry.update(decision='refused', reason=r.reason)
        if 'b' in locals() and 'log_extra' in b.cfg:
            entry.update(b.cfg['log_extra'])
    except Exception as e:  # a broker bug must not look like success
        code, out = 13, 'error:' + type(e).__name__
        entry.update(decision='error', reason=out)
    if entry['verb'] not in ('status', 'capture'):
        try:
            with open(cfg['log_file'], 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry, ensure_ascii=False) + '\n')
        except OSError:
            pass
    return code, out


def real_run(cmd):
    r = subprocess.run(cmd, env=CHILD_ENV, stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
    return r.returncode, r.stdout.decode('utf-8', errors='replace')


if __name__ == '__main__':
    os.umask(0o077)
    uid = os.environ.get('SUDO_UID')
    verb = sys.argv[1] if len(sys.argv) > 1 else ''
    data = sys.stdin.buffer.read(MAX_TEXT * 4 + 1) if verb == 'deliver' else b''
    code, out = run(sys.argv[1:], {'agents_file': AGENTS_FILE, 'log_file': LOG_FILE, 'run': real_run,
                                   'caller_uid': int(uid) if uid and uid.isdigit() else os.getuid()}, data)
    if out:
        sys.stdout.write(out if out.endswith('\n') or verb == 'capture' else out + '\n')
    if code == 2:
        sys.stderr.write(USAGE + '\n')
    sys.exit(code)
