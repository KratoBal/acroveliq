#!/usr/bin/env python3
"""review-fej-diff on a binary file: the FULL blob ids decide, not the (absent) lines.

barracuda, cap32 (2026-10-20): a PR adding a font always ended in ELTER ("BINARIS: ... nem vetheto
ossze") although the packet and the head patch were sha256-identical, so its APPROVE never reached the
root record. And barracuda 33479 / acrobot 33480: an abbreviated blob id is a prefix, cheap to collide
for a binary file, so only full, 40 hex ids on both sides and an exact match are accepted.

1. compare(): abbreviated ids -> BINARIS; 40 hex equal -> no difference; one digit off -> BINARIS;
   binary on one side only, a missing index line, another mode -> still a difference.
2. run() against a stub GitHub: the head's diff has the ABBREVIATED index line (as GitHub's compare
   diff does), the full ids come from the compare JSON (new blob) and the contents API at the merge
   base (old blob); a --full-index packet with the same ids -> EGYEZIK; a packet one digit off -> ELTER.
Run: python3 -I scripts/__tests__/review-fej-diff-binary.test.py
"""
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, '..', 'lib', 'review-fej-diff.py')
spec = importlib.util.spec_from_file_location('rfd', SCRIPT)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  (want {want!r}, got {got!r})'))


Z = '0' * 40
NEW = '5789a29d6552ed8c7939190ba8899d748da7ea4b'
OLD = '1111111111111111111111111111111111111111'
OFF = NEW[:-1] + ('c' if NEW[-1] != 'c' else 'd')  # one digit off


def binary(index, mode='new file mode 100644', path='f.ttf'):
    head = f'diff --git a/{path} b/{path}\n' + (mode + '\n' if mode else '')
    head += (f'index {index}\n' if index else '')
    return head + f'Binary files /dev/null and b/{path} differ\n'


TEXT = 'diff --git a/f.ttf b/f.ttf\n--- a/f.ttf\n+++ b/f.ttf\n@@ -1 +1 @@\n-a\n+b\n'


def diff(a, b):
    return m.compare(m.parse_diff(a), m.parse_diff(b))


def first(a, b):
    d = diff(a, b)
    return d[0].split(':')[0] if d else 'NONE'


# 1. compare()
check('40 hex, equal on both sides -> no difference', [], diff(binary(f'{Z}..{NEW}'), binary(f'{Z}..{NEW}')))
check('abbreviated ids, equal -> BINARIS (a prefix proves nothing)', 'BINARIS', first(binary('0000000..5789a29'), binary('0000000..5789a29')))
check('abbreviated on one side, full on the other -> BINARIS', 'BINARIS', first(binary('0000000..5789a29'), binary(f'{Z}..{NEW}')))
check('40 hex, one digit off (new blob) -> BINARIS', 'BINARIS', first(binary(f'{Z}..{OFF}'), binary(f'{Z}..{NEW}')))
check('40 hex, another old blob -> BINARIS', 'BINARIS', first(binary(f'{OLD}..{NEW}'), binary(f'{Z}..{NEW}')))
check('no index line -> BINARIS', 'BINARIS', first(binary(None), binary(f'{Z}..{NEW}')))
check('binary on one side only -> BINARIS', 'BINARIS', first(binary(f'{Z}..{NEW}'), TEXT))
check('40 hex equal, another mode -> MAS MOD', 'MAS MOD', first(binary(f'{Z}..{NEW}'), binary(f'{Z}..{NEW}', 'new file mode 100755')))
check('the index line with a mode suffix is read too', (OLD, NEW), m.parse_diff(binary(f'{OLD}..{NEW} 100644', None))['f.ttf']['blobs'])

# 2. run() against a stub GitHub
HEAD = 'a' * 40
MB = 'b' * 40
X_HEAD = 'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n'
# the head's diff as GitHub's compare diff gives it: ABBREVIATED index lines
state = {
    'json_files': [{'filename': 'assets/f.ttf', 'status': 'added', 'sha': NEW}],
    'head_diff': binary('0000000..5789a29', path='assets/f.ttf') + X_HEAD,
}


class Stub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        accept = self.headers.get('Accept', '')
        if '/pulls/' in self.path:
            body = json.dumps({'head': {'sha': HEAD}, 'base': {'ref': 'main'}}).encode()
        elif '/compare/' in self.path and 'diff' in accept:
            body = state['head_diff'].encode()
        elif '/compare/' in self.path:
            body = json.dumps({'merge_base_commit': {'sha': MB}, 'files': state['json_files']}).encode()
        elif '/contents/' in self.path and f'ref={MB}' in self.path:
            body = json.dumps({'sha': OLD}).encode()
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.end_headers(); self.wfile.write(body)


srv = http.server.HTTPServer(('127.0.0.1', 0), Stub)
threading.Thread(target=srv.serve_forever, daemon=True).start()
api = f'http://127.0.0.1:{srv.server_port}'
tmp = tempfile.mkdtemp()


def run(packet_text):
    p = os.path.join(tmp, 'packet.patch')
    open(p, 'w').write(packet_text)
    r = subprocess.run([sys.executable, '-I', SCRIPT, api, 'KratoBal/acroveliq', '7', HEAD, os.path.join(tmp, 'out'), p],
                       capture_output=True, text=True, timeout=60, env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
    return r.returncode, r.stdout + r.stderr


TEXT_X = 'diff --git a/x.txt b/x.txt\nindex 1234567890123456789012345678901234567890..abcdefabcdefabcdefabcdefabcdefabcdefabcd 100644\n--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-a\n+b\n'
code, out = run(binary(f'{Z}..{NEW}', path='assets/f.ttf') + TEXT_X)
check('run: an added font, --full-index packet with the same full ids -> EGYEZIK (exit 0)', (0, True), (code, 'EGYEZIK' in out))
code, out = run(binary(f'{Z}..{OFF}', path='assets/f.ttf') + TEXT_X)
check('run: the packet one digit off -> ELTER, BINARIS (exit 1)', (1, True, True), (code, 'ELTER' in out, 'BINARIS: assets/f.ttf' in out))
code, out = run(binary('0000000..5789a29', path='assets/f.ttf') + TEXT_X)
check('run: an old, abbreviated packet -> ELTER, BINARIS', (1, True), (code, 'BINARIS: assets/f.ttf' in out))
# a MODIFIED binary: the old blob comes from the contents API at the merge base
state['json_files'] = [{'filename': 'assets/f.ttf', 'status': 'modified', 'sha': NEW}]
state['head_diff'] = binary('1111111..5789a29', mode=None, path='assets/f.ttf') + X_HEAD
code, out = run(binary(f'{OLD}..{NEW}', mode=None, path='assets/f.ttf') + TEXT_X)
check('run: a modified font, old blob from the merge base -> EGYEZIK', (0, True), (code, 'EGYEZIK' in out))
code, out = run(binary(f'{Z}..{NEW}', mode=None, path='assets/f.ttf') + TEXT_X)
check('run: a modified font, the packet with another old blob -> BINARIS', (1, True), (code, 'BINARIS: assets/f.ttf' in out))
srv.shutdown()

print('all pass' if not fails else f'{fails} FAIL')
sys.exit(1 if fails else 0)
