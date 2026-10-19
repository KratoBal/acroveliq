#!/usr/bin/python3 -I
"""hosti-kliens: the B8 gate's hand to the host executor's socket (docs/hosti-vegrehajto.md).

The gate's hosti-kerj, hosti-vegrehajt and hosti-allapot ops run this as the `fleet` user with a fixed first word and the
arguments the gate already checked. It writes ONE JSON line to /run/hosti-vegrehajto/sock, prints every JSON line that
comes back (the executor answers `elfogadva` at once for a vegrehajt and closes: the work does not need this client),
and turns the answer into an exit code. It decides nothing: the executor (root, behind a socket only the `fleet` uid may
use) checks everything again.

Exit: 0 ok; 10 refused or busy (`foglalt`); 11 no decision yet; 12 rejected; 13 failed; 14 the socket is not reachable.
"""
import json
import socket
import sys

SOCKET = '/run/hosti-vegrehajto/sock'
VERBS = ('kerj', 'vegrehajt', 'allapot', 'kep', 'naplo')
TIMEOUT = 180


def main(argv, path=None):
    if len(argv) < 2 or argv[1] not in VERBS:
        print('usage: hosti-kliens <kerj|vegrehajt|allapot|kep|naplo> [args...]', file=sys.stderr)
        return 2
    request = (json.dumps({'ige': argv[1], 'args': list(argv[2:])}) + '\n').encode('utf-8')
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(TIMEOUT)
    data = b''
    try:
        s.connect(path or SOCKET)
        s.sendall(request)
        s.shutdown(socket.SHUT_WR)
        # ONE reply line is the whole answer: stop at the first complete line, do not wait for the end of the connection (a
        # vegrehajt is accepted at once and the build goes on behind it; waiting for EOF would wait for the build)
        while b'\n' not in data:
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
            if len(data) > 1_000_000:
                break
    except OSError:
        # what was read before the error is still the executor's word (a timeout after a line is not "unreachable")
        if b'\n' not in data:
            print('hosti-kliens: a hosti vegrehajto nem erheto el', file=sys.stderr)
            return 14
    finally:
        s.close()
    last = {}
    for line in data.decode('utf-8', 'replace').splitlines():
        if line.strip():
            print(line)
            try:
                last = json.loads(line)
            except ValueError:
                last = {}
    if last.get('ok') is True:
        return 0
    if last.get('foglalt'):
        return 10
    if last.get('meg_nincs_dontes'):
        return 11
    if last.get('elutasitva'):
        return 12
    return 10 if last else 13


if __name__ == '__main__':
    sys.exit(main(sys.argv))
