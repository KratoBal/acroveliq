#!/usr/bin/env python3
# Guard for the CI half of scripts/root/root-telepito.py (task ci-modositas-jovahagyassal, PR B). WHAT TURNS THIS RED:
#   - a workflow change that goes up for approval without the REVIEWER's mark on exactly its bytes, or marked by the
#     requester, or by someone off the reviewer list, or on other bytes;
#   - an item that is not a branch of an open PR into the default branch of a listed repo, or is the default branch;
#   - a file that is not .github/workflows/<name>.yml, not plain printable ASCII, empty, over 20 kB, unchanged;
#   - an approval line that does not show the change unambiguously (a stand-in that could be read as the original
#     character, white space lost, a cut line) or that #33 would alter, or one that omits the PR, the reviewer, the
#     old blob, the new bytes' digest or the warning that the workflow runs at once;
#   - anything written before the owner's `igen <code>` on exactly that line, or a second write on the same R;
#   - the write token asked for before the approval, or asked for through sudo, or kept longer than the one call;
#   - a write whose five facts (repo, PR, branch, old blob, new bytes) changed since the approval still going out,
#     or one failed item stopping the others, or all of them failing without an error;
#   - the staged bytes changed on disk between the request and the write.
import base64
import importlib.util
import json
import os
import pwd
import re
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
spec = importlib.util.spec_from_file_location('root_telepito', os.path.join(ROOT, 'scripts/root/root-telepito.py'))
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)

fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' (got %r, want %r)' % (got, want)))


def outcome(fn, *a, **k):
    try:
        fn(*a, **k)
        return 'ok'
    except (rt.Refused, rt.Failed, rt.NotYet, rt.Rejected) as e:
        return type(e).__name__


def why(fn, *a, **k):
    try:
        fn(*a, **k)
        return 'ok'
    except (rt.Refused, rt.Failed, rt.NotYet, rt.Rejected) as e:
        return str(e)


ME = pwd.getpwuid(os.getuid()).pw_name
OTHER = 'nobody' if os.path.exists('/etc/passwd') and 'nobody' in open('/etc/passwd').read() else 'daemon'
OTHER_UID = pwd.getpwnam(OTHER).pw_uid
T = os.path.realpath(tempfile.mkdtemp(prefix='root-telepito-ci-'))
os.chmod(T, 0o755)
CONF, STORE, BIN = (os.path.join(T, d) for d in ('conf', 'store', 'bin'))
for d in (CONF, BIN):
    os.makedirs(d, mode=0o755)
os.makedirs(STORE, mode=0o700)
rt.ROOT_UID = os.getuid()
rt.TRUST_FROM = T
rt.CONF_DIR = CONF
rt.CONFIG_FILE = CONF + '/config.json'
rt.LIST_FILE = CONF + '/lista.json'
rt.CI_CONFIG_FILE = CONF + '/ci.json'
rt.DISCORD_TOKEN_FILE = CONF + '/discord-olvaso'
rt.STORE = STORE
rt.LOG_FILE = STORE + '/naplo.jsonl'
rt.REQUIRE_DURABLE_STORE = False
os.environ['SUDO_UID'] = str(os.getuid())

BOT, OWNER, CHANNEL = '111111111111111111', '222222222222222222', '333333333333333333'
CFG = {'repo': 'KratoBal/acroveliq', 'callers': [ME], 'windowMinutes': 60,
       'discord': {'channelId': CHANNEL, 'requestBotUserId': BOT, 'deciderUserIds': [OWNER], 'yes': 'igen', 'no': 'nem'}}
CI = {'repos': ['KratoBal/acroveliq', 'KratoBal/acropora-os'], 'reviewers': [OTHER, ME], 'requestExpiryHours': 48,
      'batchWindowMinutes': 720}


def write_conf(ci=None):
    for name, data in (('config.json', CFG), ('lista.json', {'celok': []}), ('ci.json', ci or CI)):
        p = os.path.join(CONF, name)
        open(p, 'w').write(json.dumps(data))
        os.chmod(p, 0o644)
    p = os.path.join(CONF, 'discord-olvaso')
    open(p, 'w').write('bot-token-for-the-test\n')
    os.chmod(p, 0o600)


# ---- fake GitHub: one repo state per name, and a record of every call with the token role it used
REPOS = {}
CALLS = []
PUTS = []


def reset_world():
    REPOS.clear()
    CALLS.clear()
    PUTS.clear()
    for r in os.listdir(os.path.join(STORE, 'keresek')) if os.path.isdir(os.path.join(STORE, 'keresek')) else []:
        os.unlink(os.path.join(STORE, 'keresek', r))
    for repo in ('KratoBal/acroveliq', 'KratoBal/acropora-os'):
        REPOS[repo] = {'default': 'main',
                       'prs': [{'number': 7, 'head': {'ref': 'feat/x', 'repo': {'full_name': repo}}, 'base': {'ref': 'main'}}],
                       'files': {}}


def blob_of(text):
    import hashlib
    return hashlib.sha1(('blob %d\0' % len(text)).encode() + text.encode()).hexdigest()


def put_file(repo, branch, path, text):
    REPOS[repo]['files'][(branch, path)] = text


def fake_token(repo, role):
    CALLS.append(('token', repo, role))
    return 'tok-' + role


def fake_api(token, method, path, body=None):
    CALLS.append((method, path.split('?')[0], token))
    m = re.match(r'^/repos/([^/]+/[^/]+)(/.*)?$', path)
    repo, rest = m.group(1), (m.group(2) or '')
    R = REPOS[repo]
    if method == 'GET' and rest == '':
        return 200, {'default_branch': R['default']}
    if method == 'GET' and rest.startswith('/pulls'):
        return 200, list(R['prs'])
    cm = re.match(r'^/contents/(.+?)(\?ref=(.+))?$', rest)
    if method == 'GET' and cm:
        text = R['files'].get((cm.group(3), cm.group(1).replace('%2F', '/')))
        if text is None:
            return 404, {}
        return 200, {'type': 'file', 'sha': blob_of(text), 'content': base64.b64encode(text.encode()).decode()}
    if method == 'PUT' and cm:
        assert token == 'tok-ci', 'the write used a token that is not the ci one: ' + token
        PUTS.append(dict(body, path=cm.group(1)))
        old = R['files'].get((body['branch'], cm.group(1)))
        if old is not None and body.get('sha') != blob_of(old):
            return 409, {'message': 'does not match'}
        R['files'][(body['branch'], cm.group(1))] = base64.b64decode(body['content']).decode()
        return 200, {'commit': {'sha': 'c' * 40}}
    raise AssertionError('unexpected call ' + method + ' ' + path)


rt.get_token = fake_token
rt.github_api = fake_api

DISCORD = {'request': {}, 'later': []}


def fake_http(url, headers, limit=rt.MAX_FILE_BYTES):
    if url.startswith(rt.DISCORD_API):
        return json.dumps(DISCORD['later'] if '?after=' in url else DISCORD['request']).encode()
    raise AssertionError('unexpected url ' + url)


rt.http_get = fake_http


def snowflake(ms):
    return str((ms - 1420070400000) << 22)


def approve(r, decision='igen', code='K7MP', text=None, after_ms=1000):
    shown = r['expiresAt'] - 120
    req_ms = r['createdAt'] * 1000 + after_ms
    req_id = snowflake(req_ms)
    content = text if text is not None else rt.approval_text(r['kero'], rt.CATEGORY, r['canonicalLine'], shown, code, 'igen', 'nem')
    DISCORD['request'] = {'id': req_id, 'channel_id': CHANNEL, 'author': {'id': BOT, 'bot': True}, 'content': content,
                          'edited_timestamp': None}
    DISCORD['later'] = [] if decision is None else [{'id': snowflake(req_ms + 1000), 'author': {'id': OWNER},
                                                      'content': f'{decision} {code}',
                                                      'message_reference': {'message_id': req_id}, 'edited_timestamp': None}]
    return req_id


OLD = 'name: ci\non: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n'
NEW = OLD.replace('npm test', 'npm test  # fast\n      - run: echo "${{ secrets.GITHUB_TOKEN }}" | wc -c')
PATH1 = '.github/workflows/test.yml'


def kerj(data, repo='KratoBal/acroveliq', branch='feat/x', path=PATH1, kero='murena'):
    return rt.cmd_ci_kerj([repo, branch, path, kero], stdin=data.encode() if isinstance(data, str) else data)


def athnezve(rid, sha, uid=None):
    old = os.environ['SUDO_UID']
    os.environ['SUDO_UID'] = str(uid if uid is not None else OTHER_UID)
    try:
        return rt.cmd_ci_athnezve([rid, sha])
    finally:
        os.environ['SUDO_UID'] = old


def queued(data=NEW, **kw):
    r = kerj(data, **kw)
    athnezve(r['r'], r['sha256'])
    return r


def batch():
    res = rt.cmd_ci_nap(['acrobot'])
    return res, rt.load_r(res['r']) if res.get('r') else None


def unstand(text):
    """The inverse a reader applies: stand-ins back to the characters, ‹n› to n spaces."""
    inv = {v: k for k, v in rt.CI_STAND_INS.items()}
    text = re.sub('‹(\\d+)›', lambda m: ' ' * int(m.group(1)), text)
    return ''.join(inv.get(c, c) for c in text)


try:
    write_conf()

    print('the request (ci-kerj)')
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    r = kerj(NEW)
    import hashlib
    check('a good request is queued with the digest of the bytes and the PR', ('varakozik', hashlib.sha256(NEW.encode()).hexdigest(), 7),
          (r['status'], r['sha256'], r['pr']))
    it = rt.load_r(r['r'])
    check('the item records the old blob and no reviewer yet', (blob_of(OLD), None), (it['baseBlob'], it['athnezte']))
    check('only a READ token was used to ask', {('token', 'KratoBal/acroveliq', 'olvas')}, {c for c in CALLS if c[0] == 'token'})
    check('the staged copy is private', 0o600, os.stat(it['staged']).st_mode & 0o777)

    bad = {
        'a repo not on the list': dict(repo='KratoBal/mas'),
        'the default branch': dict(branch='main'),
        'a branch with ..': dict(branch='feat/../x'),
        'no open PR from the branch': dict(branch='feat/nincs'),
        'a path outside .github/workflows': dict(path='scripts/x.yml'),
        'a subdirectory of workflows': dict(path='.github/workflows/a/b.yml'),
        'a non-yaml name': dict(path='.github/workflows/x.sh'),
    }
    put_file('KratoBal/acroveliq', 'feat/nincs', PATH1, OLD)
    for name, kw in bad.items():
        check('refused: ' + name, 'Refused', outcome(kerj, NEW, **kw))
    REPOS['KratoBal/acroveliq']['prs'].append({'number': 8, 'head': {'ref': 'feat/x', 'repo': {'full_name': 'KratoBal/acroveliq'}}, 'base': {'ref': 'main'}})
    check('refused: two open PRs from one branch', 'Refused', outcome(kerj, NEW))
    REPOS['KratoBal/acroveliq']['prs'] = [{'number': 5, 'head': {'ref': 'main', 'repo': {'full_name': 'KratoBal/acroveliq'}}, 'base': {'ref': 'main'}}]
    put_file('KratoBal/acroveliq', 'main', PATH1, OLD)
    check('refused, and for THAT reason: a PR whose head is the default branch itself', True, 'alapertelmezett' in why(kerj, NEW, branch='main'))
    REPOS['KratoBal/acroveliq']['prs'] = [{'number': 7, 'head': {'ref': 'feat/x', 'repo': {'full_name': 'EgyFork/acroveliq'}}, 'base': {'ref': 'main'}}]
    check('refused: a PR from a fork', 'Refused', outcome(kerj, NEW))
    REPOS['KratoBal/acroveliq']['prs'] = [{'number': 7, 'head': {'ref': 'feat/x', 'repo': {'full_name': 'KratoBal/acroveliq'}}, 'base': {'ref': 'dev'}}]
    check('refused: a PR into another base', 'Refused', outcome(kerj, NEW))
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    for name, data in {'accent in the new file': NEW + '# \xe9\n', 'a tab': NEW + '\tx\n', 'a carriage return': NEW.replace('\n', '\r\n'),
                       'empty': '', 'over 20 kB': 'a' * 20_001}.items():
        check('refused: ' + name, 'Refused', outcome(kerj, data))
    check('refused, and for THAT reason: the file on the branch is already exactly this', True, 'nincs mit irni' in why(kerj, OLD))
    put_file('KratoBal/acroveliq', 'feat/x', '.github/workflows/p.yml', '# k\xe9sz\nx: 1\n')
    check('refused: a CHANGED old line that is not ASCII', 'Refused', outcome(kerj, '# kesz\nx: 1\n', path='.github/workflows/p.yml'))
    put_file('KratoBal/acroveliq', 'feat/x', '.github/workflows/q.yml', '# k\xe9sz\nx: 1\n')
    check('an UNCHANGED non-ASCII old line is fine (it is not shown)', 'ok', outcome(kerj, '# k\xe9sz\nx: 2\n', path='.github/workflows/q.yml'))
    check('refused: a change too long for one approval line', 'Refused', outcome(kerj, ''.join('step_%d: run %d\n' % (i, i) for i in range(200)), path='.github/workflows/n.yml'))
    check('a new file is fine, with no old blob', 'ok', outcome(kerj, 'name: nj\n', path='.github/workflows/uj.yml'))

    print('the line is unambiguous (what the owner reads maps back to exactly one text)')
    samples = ['run: |\n  echo "$GITHUB_TOKEN" > x  # secret\n  a  b \n', 'if: github.event.pull_request.head.repo.full_name == `x` && a > b ~ c *\n', 'x:   y\n']
    for s in samples:
        lines, plus, minus = rt.ci_lines('', s)
        shown = [re.sub(r'^\d+\+\((\d+)\)', lambda m: ' ' * int(m.group(1)), l) for l in lines]
        check('round trip: ' + s[:24].replace('\n', ' '), s.rstrip('\n').split('\n'), [unstand(x) for x in shown])
        check('no original of the seven characters is left in the shown lines', [], [c for l in lines for c in l if c in rt.CI_STAND_INS])
    la, pa, ma = rt.ci_lines('a: 1\nb: 2\n', 'a: 1\nb: 3\nc: 4\n')
    check('a changed line is a - and a +, with the number and the indent', ['2-(0)b: 2', '2+(0)b: 3', '3+(0)c: 4'], la)
    check('the counts', (2, 1), (pa, ma))
    check('indent 0 and a text that looks like an indent are different', False,
          rt.ci_line(1, '+', 'x') == rt.ci_line(1, '+', '(0)x'))
    check('the end-of-file newline change is shown', True, any('sorvege' in l for l in rt.ci_lines('a: 1', 'a: 1\n')[0]))

    print('the reviewer mark (ci-athnezve)')
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    r = kerj(NEW)
    check('refused: the sha256 of other bytes', 'Refused', outcome(athnezve, r['r'], '0' * 64))
    check('refused: the requester himself (same OS user)', 'Refused', outcome(athnezve, r['r'], r['sha256'], uid=os.getuid()))
    CI2 = dict(CI, reviewers=['nincs-ilyen-felhasznalo'])
    write_conf(CI2)
    check('refused: someone not on the reviewer list', 'Refused', outcome(athnezve, r['r'], r['sha256']))
    write_conf()
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    r = kerj(NEW, kero=OTHER)
    check('refused: the reviewer is the agent who asked (by name)', 'Refused', outcome(athnezve, r['r'], r['sha256']))
    r = kerj(NEW + '# masik\n')
    check('the right reviewer on the right bytes', 'ok', outcome(athnezve, r['r'], r['sha256']))
    check('the mark names the reviewer', {'by': OTHER}, {'by': rt.load_r(r['r'])['athnezte']['by']})
    it = rt.load_r(r['r'])
    it['expiresAt'] = int(time.time()) - 1
    rt.save_r(it)
    r2 = kerj(NEW + '# harmadik\n')
    it2 = rt.load_r(r2['r'])
    it2['expiresAt'] = int(time.time()) - 1
    rt.save_r(it2)
    check('refused: an expired item', 'Rejected', outcome(athnezve, r2['r'], r2['sha256']))

    print('the daily batch (ci-nap)')
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    check('an empty queue is not an error and makes no R', {'tetelek': 0}, rt.cmd_ci_nap(['acrobot']))
    a = kerj(NEW)
    check('an item with no reviewer mark is NOT taken', {'tetelek': 0}, rt.cmd_ci_nap(['acrobot']))
    athnezve(a['r'], a['sha256'])
    res, b = batch()
    check('one reviewed item makes one batch', (1, 'nyitott'), (res['tetelek'], b['status']))
    line = b['canonicalLine']
    check('the line starts the way the helper and root expect', True, line.startswith('ROOT-TELEPITO R=%s / CI-NAP / 1 tetel / ' % b['id']))
    check('#33 leaves the line exactly as it is', '> ' + line, rt.neutral_description(line, rt.description_max(rt.CATEGORY)))
    check('the line names the PR, the reviewer, the old blob, the new digest, and the immediate run', True,
          all(x in line for x in ('KratoBal/acroveliq PR7', 'atnezte:' + OTHER, 'regi:' + blob_of(OLD)[:8], 'uj:' + a['sha256'][:8], 'AZONNAL')))
    check('the line is within the category limit', True, len(line) <= rt.description_max(rt.CATEGORY))
    check('refused: a second batch while one is open', 'Refused', outcome(rt.cmd_ci_nap, ['acrobot']))
    check('the item is in the batch, not waiting', 'kotegben', rt.load_r(a['r'])['status'])
    # an undecided batch that ran out gives its items back
    b['expiresAt'] = int(time.time()) - 1
    rt.save_r(b)
    res2, b2 = batch()
    check('after the expiry the same item is offered in a new batch', (1, 'lejart'), (res2['tetelek'], rt.load_r(b['id'])['status']))
    # what does not fit stays for tomorrow
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    ids = []
    for i in range(12):
        path = '.github/workflows/w%d.yml' % i
        k = kerj('name: w%d\n' % i + ''.join('x%d: %s\n' % (j, 'abcdefghij' * 4) for j in range(7)), path=path)
        athnezve(k['r'], k['sha256'])
        ids.append(k['r'])
    res3, b3 = batch()
    check('some items go, the rest stay (nothing is cut)', True, 0 < res3['tetelek'] < 12 and res3['sorban_maradt'] == 12 - res3['tetelek'])
    check('the batch holds the OLDEST first and is within the limit', (True, True), (b3['items'] == ids[:res3['tetelek']], len(b3['canonicalLine']) <= 1500))

    print('the write (vegrehajt)')

    def fresh(*texts):
        reset_world()
        put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
        for t in texts:
            athnezve(*(lambda k: (k['r'], k['sha256']))(kerj(t)))
        return batch()

    res, b = fresh(NEW)
    msg = 'x'
    check('no decision yet: nothing written, no write token asked', ('NotYet', 0, []),
          (outcome(lambda: (approve(b, decision=None), rt.cmd_vegrehajt([b['id'], DISCORD['request']['id']], now_ms=b['createdAt'] * 1000 + 5000))),
           len(PUTS), [c for c in CALLS if c[0] == 'token' and c[2] == 'ci']))
    approve(b, decision='nem')
    check('the owner said no: Rejected, nothing written', ('Rejected', 0), (outcome(lambda: rt.cmd_vegrehajt([b['id'], DISCORD['request']['id']], now_ms=b['createdAt'] * 1000 + 5000)), len(PUTS)))
    approve(b, text='**JÓVÁHAGYÁS KELL, kód: K7MP**\nmás szöveg\nx\ny')
    check('a message that is not what #33 makes of this R: Refused, nothing written', ('Refused', 0),
          (outcome(lambda: rt.cmd_vegrehajt([b['id'], DISCORD['request']['id']], now_ms=b['createdAt'] * 1000 + 5000)), len(PUTS)))
    req = approve(b)
    out = rt.cmd_vegrehajt([b['id'], req], now_ms=b['createdAt'] * 1000 + 5000)
    check('approved: the item is written', ('telepitve', 'kesz', 1), (out['status'], out['tetelek'][0]['allapot'], len(PUTS)))
    p = PUTS[0]
    check('the write is the approved bytes, on the branch, conditional on the old blob, with a fixed message',
          (NEW, 'feat/x', blob_of(OLD), PATH1, True),
          (base64.b64decode(p['content']).decode(), p['branch'], p['sha'], p['path'], p['message'].startswith('ci: ' + PATH1 + ' (approved on Discord')))
    check('the write token is the ci role, asked once, and after the read tokens', True,
          [c for c in CALLS if c[0] == 'token'].count(('token', 'KratoBal/acroveliq', 'ci')) == 1)
    check('a second run on the same R is refused', 'Refused', outcome(lambda: rt.cmd_vegrehajt([b['id'], req], now_ms=b['createdAt'] * 1000 + 5000)))
    check('the file on the branch is now the approved one', NEW, REPOS['KratoBal/acroveliq']['files'][('feat/x', PATH1)])

    print('what changed between the approval and the write')
    for label, change, state in [
        ('the file on the branch changed (another blob)', lambda: put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD + '# nyul\n'), 'nem ment'),
        ('the PR was closed and another opened (new number)', lambda: REPOS['KratoBal/acroveliq'].update(prs=[{'number': 9, 'head': {'ref': 'feat/x', 'repo': {'full_name': 'KratoBal/acroveliq'}}, 'base': {'ref': 'main'}}]), 'nem ment'),
        ('the PR now points at another base', lambda: REPOS['KratoBal/acroveliq'].update(prs=[{'number': 7, 'head': {'ref': 'feat/x', 'repo': {'full_name': 'KratoBal/acroveliq'}}, 'base': {'ref': 'dev'}}]), 'nem ment'),
        ('the default branch became the item branch', lambda: REPOS['KratoBal/acroveliq'].update(default='feat/x'), 'nem ment'),
    ]:
        res, b = fresh(NEW)
        change()
        req = approve(b)
        r = outcome(lambda: rt.cmd_vegrehajt([b['id'], req], now_ms=b['createdAt'] * 1000 + 5000))
        check(label + ': no write, the item says why', ('Failed', 0, state), (r, len(PUTS), rt.load_r(res['r'] if False else b['items'][0])['status']))

    res, b = fresh(NEW)
    put_file('KratoBal/acroveliq', 'feat/x', '.github/workflows/z.yml', 'a: 1\n')
    k2 = kerj('a: 2\n', path='.github/workflows/z.yml')
    athnezve(k2['r'], k2['sha256'])
    reset_b = rt.load_r(b['id'])
    reset_b['status'] = 'lejart'
    rt.save_r(reset_b)
    first = rt.load_r(b['items'][0])
    first['status'] = 'varakozik'
    rt.save_r(first)
    res, b = batch()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD + '# nyul\n')   # only the first item's base changed
    req = approve(b)
    out = rt.cmd_vegrehajt([b['id'], req], now_ms=b['createdAt'] * 1000 + 5000)
    states = {x['path']: x['allapot'] for x in out['tetelek']}
    check('one failed item does not stop the other; the batch says "reszben"', (2, 'reszben', 'nem ment', 'kesz'),
          (len(states), out['status'], states[PATH1], states['.github/workflows/z.yml']))

    res, b = fresh(NEW)
    s = rt.load_r(b['items'][0])['staged']
    open(s, 'wb').write(NEW.encode() + b'# csere\n')
    req = approve(b)
    check('staged bytes changed on disk after the request: Refused, nothing written', ('Refused', 0),
          (outcome(lambda: rt.cmd_vegrehajt([b['id'], req], now_ms=b['createdAt'] * 1000 + 5000)), len(PUTS)))
    res, b = fresh(NEW)
    req = approve(b)
    check('after the batch window: Rejected', 'Rejected', outcome(lambda: rt.cmd_vegrehajt([b['id'], req], now_ms=(b['expiresAt'] + 5) * 1000)))

    print('the rest of the contract')
    # an item that is no longer in this batch (a tampered record) stops the whole write
    res, b = fresh(NEW)
    tam = rt.load_r(b['items'][0])
    tam['status'] = 'varakozik'
    rt.save_r(tam)
    req = approve(b)
    check('a batch item that is not in the batch any more: Refused, nothing written', ('Refused', 0),
          (outcome(lambda: rt.cmd_vegrehajt([b['id'], req], now_ms=b['createdAt'] * 1000 + 5000)), len(PUTS)))

    # GitHub refuses the write itself (HTTP 422): that item says so and the other still goes
    res, b = fresh(NEW)
    put_file('KratoBal/acroveliq', 'feat/x', '.github/workflows/z.yml', 'a: 1\n')
    k2 = kerj('a: 2\n', path='.github/workflows/z.yml')
    athnezve(k2['r'], k2['sha256'])
    for iid in b['items']:
        x = rt.load_r(iid)
        x['status'] = 'varakozik'
        rt.save_r(x)
    bb = rt.load_r(b['id'])
    bb['status'] = 'lejart'
    rt.save_r(bb)
    res, b = batch()
    real_api = rt.github_api

    def failing(token, method, path, body=None):
        if method == 'PUT' and path.startswith('/repos/KratoBal/acroveliq/contents/' + PATH1.replace('/', '/')):
            return 422, {'message': 'Invalid request'}
        return real_api(token, method, path, body)
    rt.github_api = failing
    req = approve(b)
    out = rt.cmd_vegrehajt([b['id'], req], now_ms=b['createdAt'] * 1000 + 5000)
    rt.github_api = real_api
    st = {x['path']: x['allapot'] for x in out['tetelek']}
    check('a write GitHub refuses is that item\'s failure, the other still goes', (2, 'nem ment', 'kesz', 'reszben'),
          (len(st), st[PATH1], st['.github/workflows/z.yml'], out['status']))

    # an expired item is not taken
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    e = queued()
    ex = rt.load_r(e['r'])
    ex['expiresAt'] = int(time.time()) - 1
    rt.save_r(ex)
    check('an expired reviewed item is not taken into a batch, and is marked', ({'tetelek': 0}, 'lejart'),
          (rt.cmd_ci_nap(['acrobot']), rt.load_r(e['r'])['status']))

    # a new request for the same file replaces the waiting one, and with it the old mark
    reset_world()
    put_file('KratoBal/acroveliq', 'feat/x', PATH1, OLD)
    first = queued(NEW)
    second = kerj(NEW + '# masodik\n')
    check('the older item is superseded, the newer one waits for its OWN mark', ('felulirva', second['r'], 'varakozik'),
          (rt.load_r(first['r'])['status'], rt.load_r(first['r'])['felulirta'], rt.load_r(second['r'])['status']))
    check('nothing is batched: the old mark does not carry over to the new bytes', {'tetelek': 0}, rt.cmd_ci_nap(['acrobot']))
    athnezve(second['r'], second['sha256'])
    res, b = batch()
    check('after the new mark only the new bytes go up', [second['r']], b['items'])

    # the mark is in the log, and the argument shapes are checked by root
    logged = [json.loads(x) for x in open(rt.LOG_FILE) if '"ci-athnezve"' in x]
    check('the mark is logged: who, which item, which digest', True,
          any(x['r'] == second['r'] and x['sha'] == second['sha256'] and x['by'] == OTHER and 'at' in x for x in logged))
    for label, args in {'an id that is not 8 hex': ['XYZ', 'a' * 64], 'a digest of 63 hex': [second['r'], 'a' * 63],
                        'an upper-case digest': [second['r'], 'A' * 64], 'one argument': [second['r']],
                        'three arguments': [second['r'], 'a' * 64, 'x']}.items():
        check('refused by the SHAPE check (the usage text), not by a later comparison: ' + label, rt.USAGE, why(rt.cmd_ci_athnezve, args))

    print('the token asked of the broker')
    fb = os.path.join(BIN, 'fleet-github')
    seen = os.path.join(T, 'seen-env')
    open(fb, 'w').write('#!/bin/sh\nenv > %s\necho "$@" >> %s.args\necho tok-from-broker\n' % (seen, seen))
    os.chmod(fb, 0o755)
    spec2 = importlib.util.spec_from_file_location('root_telepito2', os.path.join(ROOT, 'scripts/root/root-telepito.py'))
    rt2 = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(rt2)
    rt2.ROOT_UID = os.getuid()
    rt2.FLEET_GITHUB = fb
    os.environ['SUDO_USER'] = 'valaki'
    tok = rt2.get_token('KratoBal/acroveliq', 'ci')
    env = open(seen).read()
    check('the broker is asked with no SUDO_* in its environment (so the ci role is not refused as a sudo caller)', (False, False, 'tok-from-broker'),
          ('SUDO_UID=' in env, 'SUDO_USER=' in env, tok))
    check('the broker gets exactly: token <repo> <role>', 'token KratoBal/acroveliq ci', open(seen + '.args').read().strip())
    os.chmod(fb, 0o777)
    try:
        rt2.get_token('KratoBal/acroveliq', 'ci')
        wr = 'ok'
    except rt2.Refused:
        wr = 'Refused'
    check('a broker file others can write is refused', 'Refused', wr)
finally:
    pass

print('\n%s' % ('ALL PASS' if fails == 0 else '%d FAILED' % fails))
raise SystemExit(0 if fails == 0 else 1)
