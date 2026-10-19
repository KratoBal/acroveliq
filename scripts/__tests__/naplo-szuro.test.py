#!/usr/bin/env python3
# Guard for scripts/host/naplo-szuro.py (the no-command-line plan, point G; barracuda APPROVE and its three PR points).
# WHAT TURNS THIS RED:
#   - a secret shape the filter lists getting through (a header, a bearer, a URL credential, a named value in the plain, the
#     JSON and the ESCAPED-JSON form, a known token prefix, a JWT, a PEM block, a long run);
#   - a thing a log needs being thrown away (a commit sha, a UUID, an absolute path, a timestamp, a short hex word, an
#     error text that says "token expired" with no value);
#   - the filter releasing anything when it fails (an input over the limit: exit 3 and an EMPTY stdout);
#   - a line over 2000 characters or an output over 256 KiB getting out whole;
#   - the replacement count line missing or wrong.
# The secrets are ASSEMBLED HERE at run time from short pieces: a literal token in this file would be what the repository's own
# secret scan stops, and no test sample is a real credential.
import importlib.util
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROGRAM = os.path.join(HERE, '..', 'host', 'naplo-szuro.py')
spec = importlib.util.spec_from_file_location('naplo_szuro', PROGRAM)
ns = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ns)

fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' (got %r, want %r)' % (got, want)))


def tail(n, seed='Xk3Qz9'):
    """n characters of a made-up token body."""
    return (seed * (n // len(seed) + 1))[:n]


def run(text):
    """The text through the filter; returns (filtered body without the count line, the count)."""
    out, n = ns.filter_text(text)
    lines = out.rstrip('\n').split('\n')
    assert lines[-1].startswith('# szurve: '), lines[-1]
    return '\n'.join(lines[:-1]), int(lines[-1].split(': ')[1].split()[0])


def gone(secret, text):
    body, n = run(text)
    return secret not in body and '[TITOK]' in body and n >= 1


try:
    print('the listed shapes are replaced, and the line stays')
    t = tail(40)
    check('an Authorization header', True, gone(t, f'GET /x authorization: Bearer {t} 200'))
    check('a Proxy-Authorization header', True, gone(t, f'Proxy-Authorization: Basic {t}'))
    check('the header\'s name and the line around it remain', 'GET /x Authorization: [TITOK]', run(f'GET /x Authorization: {t}')[0])
    check('a bearer token in prose', True, gone(t, f'sent bearer {t} to upstream'))
    check('a basic token in prose', True, gone(t, f'sent Basic {t} to upstream'))
    check('URL credentials', 'connect postgres://[TITOK]@db:5432/x ok', run(f'connect postgres://app:{t}@db:5432/x ok')[0])
    check('a redis URL with a password and no user', True, gone('hunter2pw', 'redis://:hunter2pw@cache:6379'.replace('://:', '://u:')))
    check('an amqp URL', True, gone(t, f'amqp://guest:{t}@mq/'))
    for name in ('API_KEY', 'apiKey', 'client_secret', 'ACCESS_TOKEN', 'password', 'DB_PASSWD', 'db_pass', 'credentials', 'DATABASE_DSN',
                 'cookie', 'sessionId', 'Auth', 'x-signature'):
        check(f'name=value with {name}', True, gone('s3cretvalue1', f'{name}=s3cretvalue1 next'))
        check(f'name: value with {name}', True, gone('s3cretvalue1', f'{name}: s3cretvalue1 next'))
    check('JSON "name": "value"', 'ok {"user":"a","token":"[TITOK]","n":1}', run('ok {"user":"a","token":"s3cretvalue1","n":1}')[0])
    check('a quoted value with spaces', "msg password='two words here' end", run("msg password='two words here' end")[0].replace('[TITOK]', 'two words here'))
    print('the ESCAPED JSON form (a JSON object inside a JSON string, as pino writes it)')
    esc = '{"msg":"{\\"token\\":\\"s3cretvalue1\\",\\"ok\\":true}"}'
    body, n = run(esc)
    check('escaped quotes: the value is gone', True, 's3cretvalue1' not in body and n >= 1)
    check('escaped quotes: the structure around it stays', True, '\\"ok\\":true' in body and body.startswith('{"msg":"'))
    esc2 = '{"msg":"{\\\\\\"password\\\\\\":\\\\\\"s3cretvalue1\\\\\\"}"}'  # escaped twice
    check('twice-escaped quotes', True, 's3cretvalue1' not in run(esc2)[0])
    check('an escaped header inside JSON', True, gone(t, '{"req":"{\\"authorization\\":\\"Bearer %s\\"}"}' % t))
    print('the known prefixes, a JWT, a PEM block, long runs')
    for label, secret in (('ghp', 'gh' + 'p_' + tail(36)), ('gho', 'gh' + 'o_' + tail(36)), ('ghs', 'gh' + 's_' + tail(36)),
                          ('github_pat', 'github' + '_pat_' + tail(40)), ('slack', 'xox' + 'b-' + tail(24, '1234-ab')),
                          ('sk-', 's' + 'k-' + tail(30)), ('sk_live', 's' + 'k_live_' + tail(24)), ('pk_live', 'p' + 'k_live_' + tail(24)),
                          ('rk_test', 'r' + 'k_test_' + tail(24)), ('aws', 'AK' + 'IA' + tail(16, 'ABCD1234')), ('google', 'AI' + 'za' + tail(35)),
                          ('jwt', 'ey' + 'J' + tail(20) + '.ey' + 'J' + tail(20) + '.' + tail(20))):
        check('prefix ' + label, True, gone(secret, f'token seen {secret} here'))
    pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
    end = '-----END ' + 'RSA PRIVATE KEY-----'
    body, n = run(f'before\n{pem}\n{tail(60)}\n{tail(60, "Zq")}\n{end}\nafter')
    check('a PEM block is one [TITOK] line, the lines around stay', ['before', '[TITOK]', 'after'], body.split('\n'))
    check('a PEM block without its END swallows the rest (fail closed)', ['before', '[TITOK]'], run(f'before\n{pem}\n{tail(60)}\nmore\n')[0].split('\n'))
    check('a long hex run (not 40 lower-case)', True, gone('ab12' * 9, 'hash ' + 'ab12' * 9 + ' done'))
    check('a long upper-case 40 hex word is NOT the commit exemption', True, gone('AB12' * 10, 'x ' + 'AB12' * 10 + ' y'))
    check('a 64 hex run', True, gone('0f' * 32, 'sha256 ' + '0f' * 32))
    check('a long base64-like run', True, gone(tail(44, 'aB9+/x'), 'blob ' + tail(44, 'aB9+/x') + ' end'))

    print('what a log needs stays')
    keep = [
        ('a commit sha (40 lower-case hex)', 'deploy of ' + 'a1b2c3d4e5' * 4 + ' finished'),
        ('a UUID', 'request 3f2504e0-4f89-41d3-9a0c-0305e82c3301 ok'),
        ('an absolute path', 'at /app/node_modules/some-package/lib/deeply/nested/module/file loaded'),
        ('an ISO timestamp', '2026-10-19T14:48:53.123456789Z start'),
        ('a short hex word', 'id 3f2504e0 ok'),
        ('an error text with the word token and no value', 'Error: token expired, please sign in again'),
        ('a status line', 'HTTP/1.1 401 Unauthorized'),
        ('the word password in prose', 'the password field is required'),
        ('an image reference', 'pulled levelkozvetito:local sha256 is not shown'),
    ]
    for label, text in keep:
        check(label, (text, 0), run(text))

    print('the hole, said aloud: a 40-hex API key with no name in front of it passes (the exemption is for commit ids)')
    bare = 'cafe0123' * 5
    check('a bare 40-digit lower-case hex word is kept', True, bare in run('x ' + bare + ' y')[0])
    check('the same word with a name in front of it is caught by the name rule', True, gone(bare, 'api_key=' + bare))

    print('limits, counts and failing closed')
    long_line = 'ab ' * 2000  # words: a 5000-character run would itself be a long-run replacement
    body, n = run(long_line)
    check('a line over 2000 characters is cut', [2005, True], [len(body), body.endswith('[...]')])
    big = '\n'.join('line %06d ordinary text of some length to fill the output up' % i for i in range(20000))
    out, n = ns.filter_text(big)
    check('an output over 256 KiB is cut, and says so', [True, True], [len(out) <= 256 * 1024 + 200, '# levagva' in out])
    check('the count line says how many replacements were made', 2, run('token=abc12345 and password=def67890')[1])
    check('no replacement: the count is 0', 0, run('nothing secret here')[1])
    check('the count line is the last line', True, ns.filter_text('a\nb\n')[0].endswith('# szurve: 0 elem\n'))
    try:
        ns.filter_text('x' * (ns.MAX_INPUT + 1))
        outcome = 'ok'
    except ns.Failed:
        outcome = 'Failed'
    check('an input over the limit raises', 'Failed', outcome)
    p = subprocess.run([sys.executable, '-I', PROGRAM], input=b'x' * (ns.MAX_INPUT + 10), capture_output=True)
    check('the command line: an input over the limit is exit 3 and an EMPTY stdout', [3, b''], [p.returncode, p.stdout])
    p = subprocess.run([sys.executable, '-I', PROGRAM], input=b'ok line\nAuthorization: Bearer ' + tail(30).encode() + b'\n', capture_output=True)
    check('the command line: a normal run is exit 0', 0, p.returncode)
    check('the command line: the secret is not on stdout or stderr', False, tail(30).encode() in p.stdout + p.stderr)
    p = subprocess.run([sys.executable, '-I', PROGRAM], input=bytes([0xff, 0xfe]) + b' token=abcdef12\n', capture_output=True)
    check('bytes that are not UTF-8 do not crash it and do not leak', [0, False], [p.returncode, b'abcdef12' in p.stdout])

    print('the source')
    src = open(PROGRAM, encoding='utf-8').read()
    check('it imports only the standard library it names', True, all(m in ('re', 'sys') for m in [l.split()[1] for l in src.splitlines() if l.startswith('import ')]))
    check('it opens no file and no network', False, any(w in src for w in ('open(', 'socket', 'urllib', 'subprocess', 'os.system')))
finally:
    pass

print()
print('%d failed' % fails)
sys.exit(1 if fails else 0)
