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

Verbs (argv[1]); the agent must be listed in the root-owned /etc/fleet-pane/conf/agents.json:
  status <agent> [--created]          running? (exit 0 yes, 1 no); prints the session name, or with
                                      --created its #{session_created}
  capture <agent> [--ansi] [--lines N] the pane text (N <= 2000 lines of history)
  stop <agent>                        kill-session
  deliver <agent> [--queued]          the text on STDIN, typed and submitted, see deliver()
  dismiss <agent> <kind>              one known dialog, matched HERE, with its fixed keys
  interrupt <agent>                   Escape, only while a turn runs and no dialog is up
  clear <agent>                       empty a parked input box (no dialog, not busy)
  submit <agent>                      Enter on a parked input box (no dialog, not busy)
  generate <agent>                    rewrite /etc/fleet-pane/start/<agent> from the root files and
                                      ONLY the allowed, value-set-checked fields of the agent's config
  start <agent> [--continue | --session-id UUID]
                                      new-session running that script and nothing else; the caller
                                      gives only one item of the closed launch list (nautilus 31151)

WHAT THIS DOES NOT DO, said aloud:
  - no verb answers a permission question: every key is preceded by a fresh look at the pane,
    and a permission question, a menu, or an unknown screen refuses;
  - the look before the Enter and the Enter are a few milliseconds apart: a dialog that appears
    exactly there takes the Enter (plan 4.3, barracuda agreed). After the Enter the pane is
    looked at again and a dialog then is logged as `suspect-accept`;
  - it does not know who sent the text (plan 4.4: the message store is `marveen`'s);
  - the pane rules here are a conservative copy of src/pane-state.ts: when unsure, it refuses.
    A refusal is "not now": the router keeps the message and tries again.

Exit codes: 0 done; 1 not running (status); 2 usage; 10 refused before any key (nothing typed,
nothing written, nothing started); 11 typed but not landed; 12 nothing to do (the dialog or state
was not there; start: already running); 13 tmux failed.
"""
import hashlib
import json
import os
import pwd
import re
import shlex
import stat
import subprocess
import sys
import time

AGENTS_FILE = '/etc/fleet-pane/conf/agents.json'
VALUES_FILE = '/etc/fleet-pane/conf/start-values.json'
START_DIR = '/etc/fleet-pane/start'
LOG_FILE = '/var/log/fleet-pane.log'
RUNUSER = '/usr/sbin/runuser'
TMUX = '/usr/bin/tmux'
# the agent's tmux gets this and nothing from the caller (sudo's env_reset, and we pass our own)
CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}

NAME_RX = re.compile(r'^[a-z][a-z0-9-]{1,30}$')
# an agent user only: a mistyped install must not name root or a service account (barracuda, #182)
USER_RX = re.compile(r'^agent-[a-z][a-z0-9-]{1,30}$')
PATH_RX = re.compile(r'^(?:/[A-Za-z0-9._-]+)+$')
MAX_TEXT = 32000
MAX_LINES = 2000
CHUNK = 80
SUBMIT_RETRIES = 3
# Typing pace (task broker-beillesztes-helyorzo, 2026-10-19). Measured on the live pane (acrobot 33100): the Claude TUI folds a
# run of quickly arriving pieces into a `[Pasted text #N]` stub and shows the rest verbatim beside it, and the box can still LOOK
# EMPTY for a moment after the last piece (the TUI gathers fast input until a gap). Hence: a pause between pieces longer than that
# gap, the previous piece's echo awaited before the next goes, the box awaited to settle before it is judged, and a pause before
# the Enter. The thresholds themselves are NOT measured on the real TUI (see docs/fleet-pane.md).
PIECE_PAUSE = 0.12
ECHO_POLL = 0.04
SETTLE_POLL = 0.15
SETTLE_MAX_POLLS = 14
PRE_ENTER_PAUSE = 0.15
ECHO_TAIL = 16
STUB_MIN_RUN = 8
ECHO_WAIT = 0.6
# the broker's own deadline for one deliver, from the worst case (two passes, the slower pause, the longer echo wait); the router's
# is 30 s longer (src/web/fleet-pane.ts), and a test ties the two numbers together
DELIVER_BASE = 40.0
DELIVER_PER_PIECE = 2.2
PACE_FILE = '/etc/fleet-pane/conf/deliver-pace.json'

# --- the pane rules (a conservative copy of src/pane-state.ts) -----------------------------
IDLE_FOOTER_RX = re.compile(
    r'(?:[A-Za-z][\w-]* ){1,3}on(?: \(shift\+tab to cycle\)| · [^\n]*?(?:ctrl\+t|↓ to manage|← for agents))'
    r'|[⏵⏸]+ (?:[A-Za-z][\w-]* ){1,3}on · [^\n]*…[ \t]*(?=\n|$)'
    # a tail that ends in the shell or monitor count (2026-10-17, card 06e0f4ab)
    r'|[⏵⏸]+ (?:[A-Za-z][\w-]* ){1,3}on · [^\n]*\b\d+ (?:shells?|monitors?)[ \t]*(?=\n|$)'
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
STUB_RX = re.compile(r'\[Pasted text[^\]\n]*\]')   # the stub, however it is numbered (measured shape: `[Pasted text #1]`)
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


def without_box(pane):
    """The pane with the live input box's rows taken out (its separators stay), or the pane itself when the box cannot be located.

    WHY (card 06e0f4ab, measured by replaying `parked_ok` on a pane whose box holds a long message): what stands in the box is
    whatever was typed or pasted there, and a message of ours that QUOTES a busy marker ("... · esc to interrupt", "(12s · ↓ 3k tokens)")
    made `busy()` true for as long as it stood in the box. The broker then answered `not-idle` to the very `submit` that was to send it,
    and the router read that as "a turn is running". The real busy signs are outside the box: the spinner line above its top separator,
    and `esc to interrupt` in the footer below its lower one. The LAST footer line is the anchor (a message may quote a footer line
    higher up); when no footer or no separator is found, nothing is taken out and the old reading stands."""
    lines = pane.split('\n')
    footer = next((i for i in range(len(lines) - 1, -1, -1) if IDLE_FOOTER_RX.search(lines[i])), -1)
    if footer < 0:
        return pane
    bottom = next((i for i in range(footer - 1, -1, -1) if BOX_SEP_RX.search(lines[i])), -1)
    if bottom <= 0:
        return pane
    top = next((i for i in range(bottom - 1, -1, -1) if BOX_SEP_RX.search(lines[i])), -1)
    return '\n'.join(lines[:top + 1] + lines[bottom:])


def busy(pane):
    live = without_box(pane)
    return any(rx.search(tail(live, LIVE_LINES)) for rx in BUSY_RXS) or bool(ESC_TO_INTERRUPT_RX.search(tail(live, FOOTER_LINES)))


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


def nospace(s):
    return re.sub(r'\s+', '', s)


def box_state(plain, text):
    """What the live input box holds, against the text WE typed: ('empty'|'ours'|'stub-ours'|'other', longest verbatim run).

    ours:      every visible row is a piece of our text (box_holds_only).
    stub-ours: a `[Pasted text ...]` stub is there, and whatever stands beside it is a piece of our text (the TUI folded a run of
               our pieces into the stub: measured shape `...b[Pasted text #1]` and `[Pasted text #2]tta tortenetkent...`).
               The verbatim run is returned: a stub with NO verbatim run is indistinguishable from somebody else's paste.
    other:     anything else (the box holds something that is not, or not only, our text)."""
    rows = box_rows(plain)
    if rows is None:
        return 'other', 0
    pieces = [collapse(re.sub(r'^\s*❯', '', r)) for r in rows]
    pieces = [p for p in pieces if p]
    if not pieces:
        return 'empty', 0
    whole = collapse(text)
    if any(STUB_RX.search(p) for p in pieces):
        runs = []
        for p in pieces:
            runs.extend(x.strip() for x in STUB_RX.split(p))
        runs = [x for x in runs if x]
        if all(x in whole for x in runs):
            return 'stub-ours', max([len(x) for x in runs] or [0])
        return 'other', 0
    return ('ours', max(len(p) for p in pieces)) if box_holds_only(plain, text) else ('other', 0)


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


SEMICOLON = '\\;'


def chunks(line):
    """CHUNK-sized literal pieces, each sent after `--` (so a leading '-' is text, not a flag).

    Measured on tmux 3.3a, 2026-10-15 (barracuda's #182 note): an argument that ENDS in ';' is a
    command separator. Without a backslash the last ';' is dropped (`E;` types `E`); with
    backslashes right before it, they are dropped and the ';' stays (`A\\;` and `B\\\\;` type `A;`
    and `B;`); a lone `\\;` types `;`; a ';' or a backslash inside an argument is typed as is. So
    no piece ends in ';': trailing semicolons go as their own `\\;` pieces."""
    out = []
    for i in range(0, len(line), CHUNK):
        c = line[i:i + CHUNK]
        body = c.rstrip(';')
        if body:
            out.append(body)
        out.extend([SEMICOLON] * (len(c) - len(body)))
    return out


def typed_text(piece):
    return ';' if piece == SEMICOLON else piece


def typed(pieces):
    """What tmux types for these pieces (the inverse of chunks)."""
    return ''.join(';' if p == SEMICOLON else p for p in pieces)


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
        self.clock = cfg.get('clock', time.monotonic)
        self.vt = 0.0

    def nap(self, secs):
        self.vt += secs
        self.sleep(secs)

    def mark(self):
        return self.vt, self.clock()

    def since(self, m):
        # the longer of the slept time and the wall time: a test that sleeps nothing still advances, a slow tmux still counts
        return max(self.vt - m[0], self.clock() - m[1])

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
            self.nap(0.15)
        if kind == 'feedback-draft':
            # "0" closed the draft; the offer to turn drafting off is answered Esc (keep)
            self.nap(0.3)
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

    def clear(self, expect=None):
        look = self.look()
        why = self.parked_ok(look)
        if why:
            raise Refused(12, why)
        if expect is not None:
            # content gate (barracuda, #264 review): only a box that holds OUR text, or our text folded around a stub with a verbatim
            # run of it beside the stub, is emptied; a stub with nothing of ours beside it is indistinguishable from someone's paste
            st, run = box_state(look['plain'], expect)
            if not (st == 'ours' or (st == 'stub-ours' and run >= STUB_MIN_RUN)):
                raise Refused(12, 'not-ours')
        if STUB_RX.search('\n'.join(box_rows(look['plain']))):
            # Ctrl-C empties a placeholder; on an EMPTY box it would start the exit (a second one quits the session). So before
            # EVERY press a STABLE look (two identical looks in a row) that still shows the stub; an empty stable look ends it, and
            # an unstable one never gets a press (barracuda, plan review 33104)
            for _ in range(3):
                look, stable = self.stable_look()
                if not stable or self.parked_ok(look) or not STUB_RX.search('\n'.join(box_rows(look['plain']) or [])):
                    break
                self.key('C-c')
                self.nap(0.45)
        else:
            rows = len([r for r in box_rows(look['plain']) if r.strip().lstrip('❯').strip()])
            # fixed key names, so ONE tmux call (up to 481 keys), not a process per key (barracuda, #182)
            self.tmux('send-keys', '-t', self.session, 'C-a', *(['C-k', 'Delete'] * min(240, max(12, rows * 4))))
            self.nap(0.1)
        return (0, 'ok') if box_free(self.stable_look()[0]) else (11, 'not-empty')

    def stable_look(self):
        """(look, stable): stable when two looks in a row show the same dialog and the same box rows."""
        prev = None
        look = self.look()
        for _ in range(SETTLE_MAX_POLLS):
            rows = box_rows(look['plain'])
            sig = (dialog(look['plain']), None if rows is None else '\n'.join(rows))
            if sig == prev:
                return look, True
            prev = sig
            self.nap(SETTLE_POLL)
            look = self.look()
        return look, False

    def submit(self, expect=None):
        look = self.look()
        why = self.parked_ok(look)
        if why:
            raise Refused(12, why)
        if expect is not None:
            # content gate: an Enter only on a box that holds exactly our text; a stub is not submitted by an Enter (it only unfolds)
            st, _ = box_state(look['plain'], expect)
            if st != 'ours':
                raise Refused(12, 'placeholder' if st == 'stub-ours' else 'not-ours')
        self.key('Enter')
        return 0, 'ok'

    def echo_ok(self, look, typed):
        """The tail of what we typed so far is the tail of the box (the TUI drew it)."""
        tail = nospace(typed)[-ECHO_TAIL:]
        rows = box_rows(look['plain'])
        return bool(tail) and rows is not None and nospace(''.join(rows)).endswith(tail)

    def box_is_prefix_of(self, look, typed):
        """The box holds exactly a (possibly empty) beginning of what this call typed, whitespace aside: the only box a failed
        deliver may empty on its own authority. Anything else in it (an earlier draft, someone's paste) stays."""
        rows = box_rows(look['plain'])
        if rows is None:
            return False
        have = nospace(''.join(re.sub(r'^\s*❯', '', r) for r in rows))
        return nospace(typed).startswith(have)

    def type_pieces(self, line, pause, echo_wait, over):
        """Type the pieces, the next one only after the previous one is drawn. (text typed so far, 'ok' | 'stub' | 'no-echo' | 'timeout').

        'stub': the TUI folded something into a `[Pasted text #N]` stub: stop typing, the caller recovers. 'no-echo': the piece was
        not drawn within the wait: stop too (a blind continuation is what coalesces). echo_wait 0 is the old tempo: no echo awaited.
        The echo is the last ECHO_TAIL non-space characters typed so far against the box with every whitespace gone on BOTH sides
        (a wrap, the continuation indent and the pad are not part of the text)."""
        typed = ''
        for c in chunks(line):
            if over():
                return typed, 'timeout'
            self.tmux('send-keys', '-t', self.session, '-l', '--', c)
            typed += typed_text(c)
            self.nap(pause)
            if echo_wait <= 0:
                continue
            m = self.mark()
            while True:
                look = self.look()
                d = dialog(look['plain'])
                if d:
                    raise Refused(11, 'dialog-while-typing:' + d)
                rows = box_rows(look['plain'])
                if rows is not None and any(STUB_RX.search(r) for r in rows):
                    return typed, 'stub'
                if self.echo_ok(look, typed):
                    break
                if self.since(m) >= echo_wait:
                    return typed, 'no-echo'
                self.nap(ECHO_POLL)
        return typed, 'ok'

    def settle(self, line):
        """Look until the box is the same in two looks in a row and not empty: the TUI may still be gathering fast input and
        draw it late (measured: the box looked EMPTY right after the last piece). (look, state, verbatim run, complete)."""
        prev = None
        look, st, run = None, 'empty', 0
        for _ in range(SETTLE_MAX_POLLS):
            look = self.look()
            d = dialog(look['plain'])
            if d:
                raise Refused(11, 'dialog-before-enter:' + d)
            st, run = box_state(look['plain'], line)
            sig = (st, '\n'.join(box_rows(look['plain']) or []))
            complete = st != 'ours' or self.echo_ok(look, line)
            if st != 'empty' and sig == prev and complete:
                return look, st, run, True
            prev = sig
            self.nap(SETTLE_POLL)
        return look, st, run, st != 'ours' or self.echo_ok(look, line)

    def clear_typed(self):
        """Empty a box this very call typed into (so its origin is known); True when the box is empty afterwards."""
        try:
            code, _ = self.clear()
        except Refused as r:
            return r.code == 12 and r.reason == 'box-empty'
        return code == 0

    def drop_typed(self, typed, look=None):
        """Empty the box after a failed typing, but ONLY when it holds a beginning of what this call typed."""
        look = look or self.look()
        if self.box_is_prefix_of(look, typed) and not box_free(look):
            if not self.clear_typed():
                raise Refused(11, 'placeholder-stuck')

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
        self.nap(0.25)
        second = ready_refusal(self.look(), queued)
        if second:
            raise Refused(10, second + '@confirm')
        pace = load_pace(self.cfg.get('pace_file', PACE_FILE), self.cfg.get('trusted_uid', 0))
        start = self.mark()
        limit = DELIVER_BASE + DELIVER_PER_PIECE * len(chunks(line))
        over = lambda: self.since(start) > limit
        # Two passes at most: the second is slower (twice the pause and the echo wait). A stub on the second pass leaves the box
        # EMPTY and refuses.
        for attempt in range(2):
            typed, how = self.type_pieces(line, pace['piece'] * (1 if attempt == 0 else 2), pace['echo'] * (1 if attempt == 0 else 2), over)
            if how == 'timeout':
                self.drop_typed(typed)
                raise Refused(11, 'deliver-timeout')
            look, st, run, complete = self.settle(line)
            if st == 'ours' and how == 'ok' and complete:
                break
            if st == 'empty':
                raise Refused(11, 'no-echo')
            if st == 'stub-ours':
                # a stub of OUR OWN pieces: this call typed into a box looked at twice and empty, so the origin is known
                if not self.clear_typed():
                    raise Refused(11, 'placeholder-stuck')
                if attempt == 1 or over():
                    raise Refused(11, 'placeholder-cleared' if attempt == 1 else 'deliver-timeout')
                continue
            if st == 'ours':
                # only a part of our text is drawn (the typing stopped early, or the end is not drawn): never an Enter on a part
                self.drop_typed(typed, look)
                raise Refused(11, 'no-echo')
            raise Refused(11, 'not-in-box')
        self.nap(PRE_ENTER_PAUSE)
        before = self.look()
        d = dialog(before['plain'])
        if d:
            raise Refused(11, 'dialog-before-enter:' + d)
        if over():
            self.drop_typed(line, before)
            raise Refused(11, 'deliver-timeout')
        if box_state(before['plain'], line)[0] == 'stub-ours':
            # the TUI folded our text AFTER the settle (a late fold): it is ours (this call typed into a box seen empty), so empty it
            # now rather than leave a stub parked for a takeover to puzzle over
            if not self.clear_typed():
                raise Refused(11, 'placeholder-stuck')
            raise Refused(11, 'placeholder-cleared')
        if not box_holds_only(before['plain'], line):
            raise Refused(11, 'placeholder' if PASTE_RX.search(before['plain']) else 'not-in-box')
        for attempt in range(SUBMIT_RETRIES + 1):
            self.key('Enter')
            self.nap(0.4)
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


# --- start: the generated root-owned start scripts (plan 4.2; the second PR) ------------------
# The router used to build the launch as a shell string and hand it to `tmux new-session`: whoever
# runs as `marveen` could start ANY command as the agent. Now `generate` writes a script from the
# root files and a few value-set-checked fields of the agent's config, and `start` runs that script
# with one item of a closed launch list. Plan doc: review-csomagok/doc-t-20261015-b48-fleet-pane.
SESSION_ID_RX = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
MODEL_RX = re.compile(r'^[a-z0-9][a-z0-9.-]{0,63}$')
PROFILE_RX = re.compile(r'^[a-z][a-z0-9-]{0,40}$')
TZ_RX = re.compile(r'^[A-Za-z_]+(?:/[A-Za-z0-9_+-]+){0,2}$')
LOGIN_RX = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
# a letter first, then letters, digits, space, dot, underscore, dash; 40 at most (`--name`, one argv)
DISPLAY_RX = re.compile(r'^[^\W\d_][\w .-]{0,39}$')
CLONE_RX = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$')
CHANNELS = ('telegram', 'slack', 'discord', 'googlechat', 'teams')
AUTH_MODES = (None, 'shared', 'oauth')
MAX_CONFIG = 64 * 1024
# the pane is started this wide (src/web/agent-process.ts AGENT_PANE_SIZE: the idle footer is cut at 80)
PANE_SIZE = ['-x', '200', '-y', '24']
ENV_BIN = '/usr/bin/env'
BASH = '/usr/bin/bash'


def clean_path(p):
    return isinstance(p, str) and bool(PATH_RX.match(p)) and not any(c in ('.', '..') for c in p.split('/'))


def trusted_file(path, trusted_uid):
    """None when `path` and every directory above it are the trusted owner's (root in production) and
    nobody else can write any of them; else the reason. No symlink anywhere: the installer copies real
    files. No exception for a sticky world-writable directory either: others could still create a
    name in it (barracuda, plan review 31252)."""
    if not clean_path(path):
        return 'bad-path'
    parts = path.split('/')[1:]
    cur = ''
    for i, part in enumerate(parts):
        cur += '/' + part
        try:
            st = os.lstat(cur)
        except OSError:
            return 'missing'
        if stat.S_ISLNK(st.st_mode):
            return 'symlink'
        if st.st_uid not in (0, trusted_uid):
            return 'not-root-owned'
        if i == len(parts) - 1 and not stat.S_ISREG(st.st_mode):
            return 'not-a-file'
        if st.st_mode & 0o022:
            return 'writable-by-others'
    return None


def load_pace(path, trusted_uid):
    """The root-owned typing pace: {'piece': pause between pieces, 'echo': echo wait} in seconds. Missing, untrusted or out of range
    means the built-in values (never a refusal): the file is only the owner's way to slow the typing down or, with echoWait 0 and a
    short piecePause, back to the old tempo without a new broker version."""
    pace = {'piece': PIECE_PAUSE, 'echo': ECHO_WAIT}
    if not path or trusted_file(path, trusted_uid):
        return pace
    try:
        with open(path, 'rb') as f:
            v = json.loads(f.read(2048).decode('utf-8'))
    except (OSError, ValueError):
        return pace
    ok = (isinstance(v, dict) and all(isinstance(v.get(k), (int, float)) and not isinstance(v.get(k), bool)
                                      for k in ('echoWait', 'piecePause'))
          and 0 <= v['echoWait'] <= 2 and 0.01 <= v['piecePause'] <= 1)
    if ok:
        pace = {'piece': float(v['piecePause']), 'echo': float(v['echoWait'])}
    return pace


def check_root_dirs(path, trusted_uid):
    """The same rule for the directories above `path` only (the file itself may not exist yet)."""
    head = os.path.dirname(path)
    if head == '/':
        return None
    st = os.lstat(head)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid not in (0, trusted_uid) or st.st_mode & 0o022:
        return 'start-dir-not-root-owned'
    return check_root_dirs(head, trusted_uid) if os.path.dirname(head) != head else None


def load_values(path, require_root):
    """The root-owned value sets: every field checked here, a bad file refuses every generate."""
    st = os.stat(path)
    if require_root and (st.st_uid != 0 or st.st_mode & 0o022):
        raise Refused(10, 'values-file-not-root-owned')
    with open(path, encoding='utf-8') as f:
        v = json.load(f)
    ok = (isinstance(v, dict) and all(clean_path(v.get(k)) for k in ('claudeBin', 'oauthTokenFile', 'gitCeiling'))
          and isinstance(v.get('tz'), str) and TZ_RX.match(v['tz']) and isinstance(v.get('routerUser'), str)
          and LOGIN_RX.match(v['routerUser']) and isinstance(v.get('models'), list)
          and all(isinstance(m, str) and MODEL_RX.match(m) for m in v['models']) and isinstance(v.get('profiles'), dict)
          and all(PROFILE_RX.match(k) and m in ('strict', 'permissive') for k, m in v['profiles'].items()))
    if not ok:
        raise Refused(10, 'values-file-invalid')
    return v


DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def open_workdir(workdir):
    """The agent's dir as a directory fd, opened from / one element at a time, each with O_NOFOLLOW:
    a symlink anywhere on the way refuses. The reads below go relative to this fd, so swapping a
    parent (agents/ and agents/<name> are marveen's) for a symlink later moves nothing: root reads
    the dir it checked (barracuda, #191 review 31282)."""
    if not clean_path(workdir):
        raise Refused(10, 'no-workdir')
    fd = os.open('/', DIR_FLAGS)
    try:
        for part in workdir.split('/')[1:]:
            try:
                nxt = os.open(part, DIR_FLAGS, dir_fd=fd)
            except OSError:
                raise Refused(10, 'workdir-unsafe')
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def read_config(wfd, name):
    """The agent's config, read as root from a tree `marveen` writes: relative to the checked
    workdir fd, no symlink, no FIFO, 64 KiB at most. Errors name the reason only, never the content."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=wfd)
    except OSError:
        raise Refused(10, 'config-unreadable')
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_CONFIG:
            raise Refused(10, 'config-unreadable')
        data = os.read(fd, MAX_CONFIG + 1)
    finally:
        os.close(fd)
    try:
        c = json.loads(data.decode('utf-8'))
    except ValueError:
        raise Refused(10, 'config-unreadable')
    if not isinstance(c, dict):
        raise Refused(10, 'config-unreadable')
    return c


def channel_env_present(wfd):
    """A channel token file with content (stat only: root never reads a secret). Walked from the
    workdir fd without following a link: a `.claude`, `channels` or provider dir that is a symlink
    or not a dir counts as present, so the agent is refused rather than its token path guessed."""
    for p in CHANNELS:
        fds = []
        try:
            cur = wfd
            for part in ('.claude', 'channels', p):
                try:
                    cur = os.open(part, DIR_FLAGS, dir_fd=cur)
                except FileNotFoundError:
                    cur = None
                    break
                except OSError:
                    return True
                fds.append(cur)
            if cur is None:
                continue
            try:
                st = os.stat('.env', dir_fd=cur, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_size > 0:
                return True
        finally:
            for fd in fds:
                os.close(fd)
    return False


def router_clones(wfd, workdir, router_uid):
    """The router-owned read clones directly in the agent's dir (src/web/agent-process.ts
    agentGitEnv), listed and stat-ed relative to the checked workdir fd; `workdir` only names them."""
    try:
        names = sorted(os.listdir(wfd))
    except OSError:
        return []
    out = []
    for n in names:
        if not CLONE_RX.match(n):
            continue
        try:
            d = os.stat(n, dir_fd=wfd, follow_symlinks=False)
            if not stat.S_ISDIR(d.st_mode):
                continue
            cfd = os.open(n, DIR_FLAGS, dir_fd=wfd)
        except OSError:
            continue
        try:
            g = os.stat('.git', dir_fd=cfd, follow_symlinks=False)
        except OSError:
            continue
        finally:
            os.close(cfd)
        if stat.S_ISDIR(g.st_mode) and d.st_uid == router_uid and g.st_uid == router_uid:
            out.append(os.path.join(workdir, n))
    return out


def start_script(agent, a, v, c, clones):
    """The script text. Every value here is from a root file or matched a value set above."""
    q = shlex.quote
    skip = '--dangerously-skip-permissions ' if v['profiles'][c['profile']] == 'permissive' else ''
    git = 'export GIT_CEILING_DIRECTORIES=%s\n' % q(v['gitCeiling'])
    if clones:
        git += 'export GIT_CONFIG_COUNT=%d' % len(clones)
        for i, p in enumerate(clones):
            git += ' GIT_CONFIG_KEY_%d=safe.directory GIT_CONFIG_VALUE_%d=%s' % (i, i, q(p))
        git += '\n'
    return ''.join([
        '#!/usr/bin/bash\n',
        '# fleet-pane generate %s: GENERATED, do not edit (B48 (2)); run by `fleet-pane start` only\n' % agent,
        'set -u\n',
        'umask 022\n',
        git,
        # the agent's own bun last: hooks and git pick from PATH (barracuda, plan review 31245)
        'export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.bun/bin"\n',
        'export DISABLE_AUTOUPDATER=1 CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false\n',
        'export CLAUDE_CONFIG_DIR=%s\n' % q(a['workdir'] + '/.claude-config'),
        'launch=()\n',
        'case "$#:${1:-}" in\n',
        '  0:) ;;\n',
        '  1:--continue) launch=(--continue) ;;\n',
        '  2:--session-id)\n',
        '    [[ ${2:-} =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "fleet-pane start: bad session id" >&2; exit 64; }\n',
        '    launch=(--session-id "$2") ;;\n',
        '  *) echo "fleet-pane start: bad arguments" >&2; exit 64 ;;\n',
        'esac\n',
        '# path A (acrobot 31154): the token is read HERE, as the agent; root never reads it\n',
        'CLAUDE_CODE_OAUTH_TOKEN="$(cat %s)" || exit 65\n' % q(v['oauthTokenFile']),
        'export CLAUDE_CODE_OAUTH_TOKEN\n',
        'cd %s || exit 66\n' % q(a['workdir']),
        'exec %s "${launch[@]}" %s--model %s --name %s\n' % (q(v['claudeBin']), skip, q(c['model']), q(c['name'])),
    ])


def generate(cfg, agent):
    a = cfg['agents'][agent]
    v = load_values(cfg['values_file'], cfg.get('require_root', True))
    trusted = cfg.get('trusted_uid', 0)
    why = trusted_file(v['claudeBin'], trusted)
    if why:
        # acrobot 31242: the binary the script execs must be root's, or there is no start at all
        raise Refused(10, 'claude-bin-' + why)
    if not a['workdir']:
        raise Refused(10, 'no-workdir')
    profile = a['profile']
    if profile is None or profile not in v['profiles']:
        raise Refused(10, 'profile-not-allowed')
    wfd = open_workdir(a['workdir'])
    try:
        return generate_in(cfg, agent, a, v, trusted, profile, wfd)
    finally:
        os.close(wfd)


def generate_in(cfg, agent, a, v, trusted, profile, wfd):
    raw = read_config(wfd, 'agent-config.json')
    model, auth = raw.get('model'), raw.get('authMode')
    if not isinstance(model, str) or model not in v['models']:
        raise Refused(10, 'model-not-allowed')
    # the config's profile is only compared: the router writes settings.json from it, so a config
    # that differs from root's choice would launch one profile's mode with another's lists
    if raw.get('securityProfile') != profile:
        raise Refused(10, 'profile-mismatch')
    if auth not in AUTH_MODES:
        raise Refused(10, 'auth-mode-not-supported')
    for field in ('claudePlan', 'claudeConfigDir'):
        if raw.get(field):
            raise Refused(10, field + '-not-supported')
    if raw.get('channel') or raw.get('channelProvider') or channel_env_present(wfd):
        raise Refused(10, 'channel-not-supported')
    name = raw.get('displayName')
    name = name if isinstance(name, str) and DISPLAY_RX.match(name) else agent
    router_uid = cfg['getpw'](v['routerUser']).pw_uid
    text = start_script(agent, a, v, {'model': model, 'profile': profile, 'name': name},
                        router_clones(wfd, a['workdir'], router_uid))
    target = os.path.join(cfg['start_dir'], agent)
    why = check_root_dirs(target, trusted)
    if why:
        raise Refused(10, why)
    tmp = os.path.join(cfg['start_dir'], '.%s.tmp.%d' % (agent, os.getpid()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        os.write(fd, text.encode('utf-8'))
        # the broker runs with umask 077; the agent reads the script, so its mode is set here
        os.fchmod(fd, 0o755)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, target)
    digest = hashlib.sha256(text.encode('utf-8')).hexdigest()
    cfg['log_extra'] = {'script_sha256': digest, 'model': model, 'profile': profile}
    return 0, 'generated ' + digest


def start(cfg, b, launch):
    """new-session running the generated script, through a clean env, with no shell in between
    (tmux 3.3a runs a multi-argument command directly; measured 2026-10-15)."""
    a = cfg['agents'][b.agent]
    rc, _ = b.tmux('has-session', '-t', b.session, check=False)
    if rc == 0:
        raise Refused(12, 'running')
    script = os.path.join(cfg['start_dir'], b.agent)
    why = trusted_file(script, cfg.get('trusted_uid', 0))
    if why:
        raise Refused(10, 'script-' + why)
    if not os.lstat(script).st_mode & 0o004:
        raise Refused(10, 'script-not-readable')
    v = load_values(cfg['values_file'], cfg.get('require_root', True))
    home = cfg['getpw'](a['user']).pw_dir
    if not clean_path(home):
        raise Refused(10, 'bad-home')
    env = ['HOME=' + home, 'USER=' + a['user'], 'LOGNAME=' + a['user'], 'SHELL=/bin/bash', 'LANG=C.UTF-8',
           'LC_ALL=C.UTF-8', 'TZ=' + v['tz'], 'TERM=tmux-256color']
    b.tmux('new-session', '-d', '-s', b.session, *PANE_SIZE, ENV_BIN, '-i', *env, BASH, '--noprofile', '--norc', script, *launch)
    cfg['log_extra'] = {'launch': launch[0] if launch else 'fresh'}
    return 0, 'started'


# --- entry ----------------------------------------------------------------------------------
VERBS = ('status', 'capture', 'stop', 'deliver', 'dismiss', 'interrupt', 'clear', 'submit', 'generate', 'start')
USAGE = 'usage: fleet-pane %s <agent> [...]' % '|'.join(VERBS)
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
            agents[name] = {'user': a['user'],
                            'workdir': a['workdir'] if clean_path(a.get('workdir')) else None,
                            # the agent's permission profile is decided HERE, by root, not in the
                            # config the agent and `marveen` can write (barracuda, plan review 31245)
                            'profile': a['profile'] if isinstance(a.get('profile'), str) and PROFILE_RX.match(a['profile']) else None}
    return agents


def parse(argv):
    if len(argv) < 2 or argv[0] not in VERBS:
        raise Refused(2, 'unknown-verb')
    verb, agent, rest = argv[0], argv[1], argv[2:]
    if not NAME_RX.match(agent):
        raise Refused(2, 'bad-agent')
    opts = {}
    allowed = {'status': {'--created'}, 'capture': {'--ansi', '--lines'}, 'deliver': {'--queued'}, 'submit': {'--expect'}, 'clear': {'--expect'}, 'dismiss': set()}.get(verb, set())
    i = 0
    if verb == 'dismiss':
        if len(rest) != 1 or rest[0] not in DISMISS_KINDS:
            raise Refused(2, 'bad-kind')
        return verb, agent, {'kind': rest[0]}
    if verb == 'start':
        # the closed launch list (nautilus 31151): nothing | --continue | --session-id <lowercase uuid>
        if rest == [] or rest == ['--continue']:
            return verb, agent, {'launch': rest}
        if len(rest) == 2 and rest[0] == '--session-id' and SESSION_ID_RX.match(rest[1]):
            return verb, agent, {'launch': rest}
        raise Refused(2, 'bad-option')
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
        elif verb in ('clear', 'submit'):
            expect = None
            if opts.get('expect'):
                # the text we expect the box to hold comes on stdin; nothing is pressed or cleared unless the box holds it
                expect = clean_text(stdin_bytes.decode('utf-8', errors='replace'))
                if not expect.strip() or len(expect) > MAX_TEXT:
                    raise Refused(2, 'bad-expect')
            code, out = b.clear(expect) if verb == 'clear' else b.submit(expect)
        elif verb == 'generate':
            code, out = generate(b.cfg, agent)
        elif verb == 'start':
            code, out = start(b.cfg, b, opts['launch'])
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
    # stdin only where the text comes from it: a manual `submit` or `clear` (the emergency hand form) must not wait for an EOF that never
    # comes (barracuda, #265 review)
    wants_text = verb == 'deliver' or (verb in ('submit', 'clear') and '--expect' in sys.argv[2:])
    data = sys.stdin.buffer.read(MAX_TEXT * 4 + 1) if wants_text else b''
    code, out = run(sys.argv[1:], {'agents_file': AGENTS_FILE, 'log_file': LOG_FILE, 'run': real_run,
                                   'values_file': VALUES_FILE, 'pace_file': PACE_FILE, 'start_dir': START_DIR, 'getpw': pwd.getpwnam,
                                   'caller_uid': int(uid) if uid and uid.isdigit() else os.getuid()}, data)
    if out:
        sys.stdout.write(out if out.endswith('\n') or verb == 'capture' else out + '\n')
    if code == 2:
        sys.stderr.write(USAGE + '\n')
    sys.exit(code)
