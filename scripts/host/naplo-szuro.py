#!/usr/bin/python3 -I
"""naplo-szuro: the secret filter every log that leaves the host goes through (the no-command-line plan, point G; design
sheet v1, barracuda APPROVE and its three PR points).

  stdin: a container's log (stdout AND stderr, merged by the caller)   stdout: the same, with the secret shapes replaced

The gate's `app-log` and the host executor's `naplo` pipe `docker logs ... 2>&1` and `docker compose logs` through this BEFORE
anything is sent to the fleet. It is a list of KNOWN SHAPES, not a certificate: a secret of a shape not listed passes. The
second layer is the quarantine reader on the fleet's side (scripts/naplo-olvas.sh), which summarises the text inside an
<untrusted> envelope with its own secret check and a length limit.

WHAT IT REPLACES (a match becomes `[TITOK]`; the line stays, so the log still reads):
  - the value of an Authorization or Proxy-Authorization header, `Bearer <token>`, `Basic <token>`;
  - credentials in a URL (`scheme://user:password@host`), so also postgres://, redis://, amqp:// connection strings;
  - `name=value`, `name: value` and JSON `"name": "value"` (also the ESCAPED form `\\"name\\":\\"value\\"` of a JSON object
    inside a JSON string, as pino and others write it) where the name holds KEY, SECRET, TOKEN, PASSWORD, PASSWD, PASS,
    CREDENTIAL, DSN, COOKIE, SESSION, AUTH or SIGNATURE;
  - well known token prefixes: ghp_ gho_ ghu_ ghs_ ghr_, github_pat_, xox[abprs]-, sk-, sk_live_ pk_live_ rk_live_ and the _test
    forms, AKIA, AIza, a JWT (eyJ..eyJ..);
  - a PEM private-key block: the BEGIN line, and everything after it up to its END line (to the end of the input if there is none);
  - any run of 32 or more hex digits or base64-like characters.
THE EXEMPTIONS, and the holes they leave, said aloud: a UUID (8-4-4-4-12) and a 40-digit LOWER-case hex word (a git commit sha) are
kept, and so is each SHORT part of a path, because a log without commit ids, request ids and paths is of no use. A run that
starts with `/` is read as a path and cut at its `/`s: every part is judged on its own, so `/app/node_modules/pino/lib` stays
(every part is short) and `/password-reset/<a long token>` becomes `/password-reset/[TITOK]` (barracuda, point G review 2). A
`/`-led run that holds a `+` or an `=` is not a path but base64 and goes whole.
**Holes: several services issue API keys that are exactly 40 hex digits, and one of those with no name in front of it passes (with
a name it is caught by the name rule); a base64 value that starts with `/` and has `/`s inside it so that every part is under 32
characters passes too (about one random base64 value in sixty-four starts with `/`, and then it must also split that way).**
They are not made narrower here: the quarantine reader is the second layer.

FAIL CLOSED: output is written only when the whole input was filtered. An error, an input over the limit, anything unexpected:
exit 3, nothing on stdout. A line is cut at 16 KiB BEFORE any pattern runs (the cost of the patterns must not depend on how long an outsider's line is), and at
2000 characters after (`[...]`), the output at 256 KiB (a last line says so). The name pattern is bounded (64 characters before and
after the keyword): an unbounded prefix made a long run of name characters cost the square of its length. The last
line of the output is `# szurve: <N> elem` (how many replacements it made), so a reader sees whether there was anything.

Exit: 0 filtered; 3 failed (nothing on stdout). Python 3, stdlib only.
"""
import re
import sys

REPL = '[TITOK]'
MAX_INPUT = 4 * 1024 * 1024
MAX_OUTPUT = 256 * 1024
MAX_LINE = 2000
PRE_CUT = 16 * 1024

_Q = r'(?:\\+["\']|["\'])'  # a quote, plain or escaped any number of times (a JSON object inside a JSON string)
_NAME = r'[A-Za-z0-9_.-]{0,64}(?:key|secret|token|passw(?:or)?d|passwd|pass|credential|dsn|cookie|session|auth|signature)[A-Za-z0-9_.-]{0,64}'

# an Authorization header: the rest of the value up to a quote that closes it, or the end of the line
HEADER = re.compile(r'(?i)((?:proxy-)?authorization' + _Q + r'?\s*[:=]\s*' + _Q + r'?)([^"\'\\\n]+)')
SCHEME = re.compile(r'(?i)\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}')
URL_CREDS = re.compile(r'(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:"\'\\]+:[^\s/@"\'\\]+@')
NAMED_QUOTED = re.compile(r'(?i)(' + _NAME + r')(' + _Q + r')?(\s*[:=]\s*)(' + _Q + r')(.*?)(' + _Q + r')')
NAMED_BARE = re.compile(r'(?i)(' + _NAME + r')(' + _Q + r')?(\s*[:=]\s*)(?!' + _Q + r')(?!\[TITOK\])([^\s,;&}\]"\'\\]+)')
PREFIXES = re.compile(
    r'\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk-[A-Za-z0-9_-]{16,}'
    r'|\b[spr]k_(?:live|test)_[A-Za-z0-9]{10,}|\bAKIA[0-9A-Z]{16}|\bAIza[0-9A-Za-z_-]{30,}'
    r'|\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*'
)
PEM_BEGIN = re.compile(r'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----')
PEM_END = re.compile(r'-----END [A-Z0-9 ]*PRIVATE KEY-----')
LONG = re.compile(r'(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])')
UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
SHA40 = re.compile(r'^[0-9a-f]{40}$')


class Failed(Exception):
    pass


def _long_part(part, counter):
    """One run or one part of a path: kept if short, a UUID or a commit sha; otherwise replaced."""
    if len(part) < 32 or UUID.match(part) or SHA40.match(part):
        return part
    counter[0] += 1
    return REPL


def _long_run(m, counter):
    run = m.group(0)
    # a run led by `/` is a path unless it holds a character only base64 has: cut at the `/`s, judge each part on its own
    if run.startswith('/') and '+' not in run and '=' not in run:
        return '/'.join(_long_part(part, counter) for part in run.split('/'))
    if UUID.match(run) or SHA40.match(run):
        return run
    counter[0] += 1
    return REPL


def filter_line(line, counter):
    """One line, every shape; `counter[0]` counts the replacements."""
    def sub(rx, repl, text):
        out, n = rx.subn(repl, text)
        counter[0] += n
        return out

    line = sub(HEADER, lambda m: m.group(1) + REPL, line)
    line = sub(SCHEME, lambda m: m.group(1) + m.group(2) + REPL, line)
    line = sub(URL_CREDS, lambda m: m.group(1) + REPL + '@', line)
    line = sub(NAMED_QUOTED, lambda m: m.group(1) + (m.group(2) or '') + m.group(3) + m.group(4) + REPL + m.group(6), line)
    line = sub(NAMED_BARE, lambda m: m.group(1) + (m.group(2) or '') + m.group(3) + REPL, line)
    line = sub(PREFIXES, REPL, line)
    line = LONG.sub(lambda m: _long_run(m, counter), line)
    return line


def filter_text(text):
    """The whole log. Returns (filtered text, number of replacements). Raises Failed rather than returning anything partial."""
    if len(text) > MAX_INPUT:
        raise Failed('input over the limit')
    counter = [0]
    out, size, in_pem = [], 0, False
    truncated = False
    for raw in text.split('\n'):
        if in_pem:
            if PEM_END.search(raw):
                in_pem = False
            continue
        if PEM_BEGIN.search(raw):
            counter[0] += 1
            out_line = PEM_BEGIN.split(raw)[0] + REPL
            in_pem = not PEM_END.search(raw)
        else:
            if len(raw) > PRE_CUT:
                raw = raw[:PRE_CUT] + '[...]'
            out_line = filter_line(raw, counter)
        if len(out_line) > MAX_LINE:
            out_line = out_line[:MAX_LINE] + '[...]'
        size += len(out_line) + 1
        if size > MAX_OUTPUT:
            truncated = True
            break
        out.append(out_line)
    while out and out[-1] == '':
        out.pop()
    if truncated:
        out.append('# levagva: a kimenet elerte a 256 KiB-ot')
    out.append(f'# szurve: {counter[0]} elem')
    return '\n'.join(out) + '\n', counter[0]


def main():
    try:
        data = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise Failed('input over the limit')
        text, _ = filter_text(data.decode('utf-8', 'replace'))
    except Exception as e:  # anything at all: nothing goes out
        print(f'naplo-szuro: {e.__class__.__name__}: a naplot nem adom ki', file=sys.stderr)
        return 3
    sys.stdout.write(text)
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
