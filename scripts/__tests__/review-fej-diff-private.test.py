#!/usr/bin/env python3
"""review-fej-diff on a PRIVATE repository: the broker's read token, in the header only.

A stub GitHub on 127.0.0.1 answers the private repo only with the right Bearer token (404 otherwise,
as GitHub does), and the public repo without one. A stub broker (REVIEW_FEJ_BROKER, honoured only
against 127.0.0.1) prints the token. Checked: the private repo is read with the token and reaches
EGYEZIK; the token is in no output and no file; a public repo asks no token; a broker refusal stops
the run without a marker; and the real-GitHub path ignores the test helper.
Run: python3 -I scripts/__tests__/review-fej-diff-private.test.py
"""
import http.server
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'lib', 'review-fej-diff.py')
TOKEN = 'ghs_' + 'T' * 36
HEAD = 'a' * 40
DIFF = b'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1,2 @@\n a\n+b\n'
seen_auth = []


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        auth = self.headers.get('Authorization')
        seen_auth.append((self.path, auth))
        private = '/KratoBal/caparium-napplo/' in self.path
        if private and auth != f'Bearer {TOKEN}':
            self.send_response(404); self.end_headers(); self.wfile.write(b'{"message":"Not Found"}'); return
        if '/pulls/' in self.path:
            body = ('{"head":{"sha":"%s"},"base":{"ref":"main"}}' % HEAD).encode()
        else:
            body = DIFF
        self.send_response(200); self.end_headers(); self.wfile.write(body)


fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  (want {want!r}, got {got!r})'))


def run(api, repo, out, patch, broker):
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'REVIEW_FEJ_BROKER': broker}
    r = subprocess.run([sys.executable, '-I', SCRIPT, api, repo, '7', HEAD, out, patch],
                       capture_output=True, text=True, env=env, timeout=60)
    return r.returncode, r.stdout + r.stderr


srv = http.server.HTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
API = f'http://127.0.0.1:{srv.server_address[1]}'

with tempfile.TemporaryDirectory() as t:
    patch = os.path.join(t, 'diff.patch')
    open(patch, 'wb').write(DIFF)
    good = os.path.join(t, 'broker-ok.sh')
    open(good, 'w').write(f'#!/bin/sh\n[ "$1" = KratoBal/caparium-napplo ] && [ "$2" = olvas ] && echo {TOKEN}\n')
    bad = os.path.join(t, 'broker-no.sh')
    open(bad, 'w').write('#!/bin/sh\necho "refused: agent-x may not have olvas" >&2\nexit 10\n')
    os.chmod(good, 0o755); os.chmod(bad, 0o755)

    out = os.path.join(t, 'o1')
    code, text = run(API, 'KratoBal/caparium-napplo', out, patch, good)
    check('private repo with the broker token -> 0', 0, code)
    check('... EGYEZIK', True, 'EGYEZIK' in text)
    check('... both calls carried the token', 2, sum(1 for p, a in seen_auth if 'caparium' in p and a == f'Bearer {TOKEN}'))
    leaked = TOKEN in text or any(TOKEN.encode() in open(os.path.join(out, f), 'rb').read() for f in os.listdir(out))
    check('... the token is in no output and no file', False, leaked)

    seen_auth.clear()
    code, text = run(API, 'KratoBal/acroveliq', os.path.join(t, 'o2'), patch, good)
    check('public repo -> 0', 0, code)
    check('... asked with no token', [None, None], [a for _, a in seen_auth])

    out3 = os.path.join(t, 'o3')
    code, text = run(API, 'KratoBal/caparium-napplo', out3, patch, bad)
    check('broker refusal -> 1', 1, code)
    check('... says the broker refused', True, 'broker nem adott olvaso tokent' in text)
    check('... no match marker', [], [f for f in os.listdir(out3) if f.endswith('.egyezik')] if os.path.isdir(out3) else [])

    spec = importlib.util.spec_from_file_location('rfd', SCRIPT)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    calls = []
    real = m.subprocess.run
    m.subprocess.run = lambda cmd, **kw: calls.append(cmd) or real(['false'], **kw)
    os.environ['REVIEW_FEJ_BROKER'] = good
    try:
        m.broker_token('KratoBal/caparium-napplo', 'https://api.github.com')
    except m.Stop:
        pass
    check('against the real GitHub the test helper is ignored: the root broker is asked',
          ['sudo', '-n', '/usr/local/sbin/fleet-github', 'token', 'KratoBal/caparium-napplo', 'olvas'], calls[0] if calls else None)

srv.shutdown()
print('all pass' if not fails else f'{fails} FAIL')
sys.exit(1 if fails else 0)
