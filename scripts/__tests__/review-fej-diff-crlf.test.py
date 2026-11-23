#!/usr/bin/env python3
"""review-fej-diff on a CRLF file: the packet's patch is read byte for byte, as the head's diff is.

barracuda 47502 (commerce #744, google-pay-mark.svg): the packet and the head's diff were the same
bytes, and --fej still said ELTER (MAS TARTALOM). The packet was opened in text mode, which turns
\\r\\n into \\n, while the head's diff was decoded from bytes and kept the \\r.

run() against a stub GitHub whose compare diff has CRLF content lines:
1. the packet with the same bytes -> EGYEZIK (exit 0);
2. the packet with LF where the head has CRLF -> ELTER, MAS TARTALOM (exit 1): the fix reads the
   packet as it is, it does not normalise the line ends away;
3. a lone \\r inside a line, the same on both sides -> EGYEZIK (a text-mode read split it in two).
Run: python3 -I scripts/__tests__/review-fej-diff-crlf.test.py
"""
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'lib', 'review-fej-diff.py')

fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  (want {want!r}, got {got!r})'))


HEAD = 'a' * 40


def svg(eol):
    return (b'diff --git a/mark.svg b/mark.svg\nnew file mode 100644\n'
            b'index 0000000..5789a29\n--- /dev/null\n+++ b/mark.svg\n@@ -0,0 +1,3 @@\n'
            + b''.join(b'+' + x + eol for x in (b'<svg>', b'<path d="M0 0"/>', b'</svg>')))


LONE_CR = (b'diff --git a/n.txt b/n.txt\n--- a/n.txt\n+++ b/n.txt\n@@ -1 +1 @@\n'
           b'-a\n+a\rb\n')

state = {'head_diff': svg(b'\r\n')}


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        accept = self.headers.get('Accept', '')
        if '/pulls/' in self.path:
            body = json.dumps({'head': {'sha': HEAD}, 'base': {'ref': 'main'}}).encode()
        elif '/compare/' in self.path and 'diff' in accept:
            body = state['head_diff']
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.end_headers(); self.wfile.write(body)


srv = http.server.HTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
api = f'http://127.0.0.1:{srv.server_port}'
tmp = tempfile.mkdtemp()


def run(packet_bytes):
    p = os.path.join(tmp, 'packet.patch')
    with open(p, 'wb') as f:
        f.write(packet_bytes)
    r = subprocess.run([sys.executable, '-I', SCRIPT, api, 'KratoBal/acroveliq', '7', HEAD, os.path.join(tmp, 'out'), p],
                       capture_output=True, text=True, timeout=60, env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
    return r.returncode, r.stdout + r.stderr


code, out = run(svg(b'\r\n'))
check('run: a CRLF file, the packet with the same bytes -> EGYEZIK (exit 0)', (0, True), (code, 'EGYEZIK' in out))
code, out = run(svg(b'\n'))
check('run: an LF packet for a CRLF head -> ELTER, MAS TARTALOM (exit 1)', (1, True, True),
      (code, 'ELTER' in out, 'MAS TARTALOM: mark.svg' in out))
state['head_diff'] = LONE_CR
code, out = run(LONE_CR)
check('run: a lone \\r inside a line, the same on both sides -> EGYEZIK', (0, True), (code, 'EGYEZIK' in out))
srv.shutdown()

print('all pass' if not fails else f'{fails} FAIL')
sys.exit(1 if fails else 0)
