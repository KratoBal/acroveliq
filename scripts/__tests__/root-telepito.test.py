#!/usr/bin/env python3
# Guard for scripts/root/root-telepito.py (the no-command-line plan, point B). WHAT TURNS THIS RED:
#   - a file installed from anywhere but GitHub at the approved commit, or a commit not on main, or a commit whose
#     file differs from main's head (an old version must go through kerj-vissza);
#   - a target that is not on the root list, or a list that names the installer itself, its state, /etc/sudoers
#     or passwd, a sudoers file outside /etc/sudoers.d, or a plain file inside it;
#   - a target whose directory chain or the target itself somebody else could swap (symlink, writable dir);
#   - a sudoers file installed that is not in the strict grammar (alias, Defaults, include, several commands,
#     negation, a shell, an agent-writable command) or that visudo refuses; the rules missing from the line;
#   - an install without the owner's Discord "igen <code>" on EXACTLY the message #33 makes of this R (author,
#     channel, edits, text, code, expiry), or a second install on the same R;
#   - a target changed since the request installed over, or the store not durable;
#   - a restore that does not put back the stored version, or a helyreallit that installs an unapproved one;
#   - the Python #33 text or date rendering drifting from the shared fixture (Node checks the same fixture).
import grp
import importlib.util
import json
import os
import pwd
import shutil
import stat
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
FIXTURE = os.path.join(HERE, 'fixtures', 'approval-text.json')

spec = importlib.util.spec_from_file_location('root_telepito', os.path.join(ROOT, 'scripts/root/root-telepito.py'))
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)

fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' (got %r, want %r)' % (got, want)))


def refused(fn, *a, **k):
    """The exception class name, or 'ok'."""
    try:
        fn(*a, **k)
        return 'ok'
    except (rt.Refused, rt.Failed, rt.NotYet, rt.Rejected) as e:
        return type(e).__name__


ME = pwd.getpwuid(os.getuid()).pw_name
MYGROUP = grp.getgrgid(os.getgid()).gr_name
T = os.path.realpath(tempfile.mkdtemp(prefix='root-telepito-'))
while '_' in T:  # an underscore cannot be shown in the #33 line; the code refuses such a target, by design
    os.rmdir(T)
    T = os.path.realpath(tempfile.mkdtemp(prefix='root-telepito-'))
os.chmod(T, 0o755)
CONF, STORE, TGT, BIN = (os.path.join(T, d) for d in ('conf', 'store', 'tgt', 'bin'))
for d in (CONF, TGT, BIN):
    os.makedirs(d, mode=0o755)
os.makedirs(STORE, mode=0o700)
SUDOERS_D = os.path.join(TGT, 'etc', 'sudoers.d')
os.makedirs(SUDOERS_D, mode=0o755)

# the seams: everything under T, the test user standing in for root
rt.ROOT_UID = os.getuid()
rt.TRUST_FROM = T
rt.CONF_DIR = CONF
rt.CONFIG_FILE = CONF + '/config.json'
rt.LIST_FILE = CONF + '/lista.json'
rt.DISCORD_TOKEN_FILE = CONF + '/discord-olvaso'
rt.STORE = STORE
rt.LOG_FILE = STORE + '/naplo.jsonl'
rt.REQUIRE_DURABLE_STORE = False
VISUDO_LOG = os.path.join(T, 'visudo.log')
visudo = os.path.join(BIN, 'visudo')
open(visudo, 'w').write('#!/bin/sh\necho "$@" >> %s\ncase "$*" in *VISUDO-NEM*) exit 1;; esac\n'
                        '[ -n "$4" ] && grep -q VISUDO-NEM "$4" && exit 1\nexit 0\n' % VISUDO_LOG)
os.chmod(visudo, 0o755)
rt.VISUDO = visudo
rt.SUDOERS_D = SUDOERS_D
rt.SUDOERS_OWNER = (ME, MYGROUP)
rt.SUDOERS_COMMAND_DIR = BIN
os.environ['SUDO_UID'] = str(os.getuid())

BOT, OWNER, CHANNEL = '111111111111111111', '222222222222222222', '333333333333333333'
CFG = {'repo': 'KratoBal/acroveliq', 'callers': [ME], 'windowMinutes': 60,
       'discord': {'channelId': CHANNEL, 'requestBotUserId': BOT, 'deciderUserIds': [OWNER], 'yes': 'igen', 'no': 'nem'}}
BROKER = os.path.join(BIN, 'fleet-pane')
for name in ('fleet-pane', 'bash', 'python3'):
    open(os.path.join(BIN, name), 'w').write('#!/bin/sh\n')
    os.chmod(os.path.join(BIN, name), 0o755)
# owned like root here, in a directory as safe as BIN: only the allow-list by place can refuse these
BIN2 = os.path.join(T, 'bin2')
os.makedirs(BIN2, mode=0o755)
for name in ('tee', 'find'):
    open(os.path.join(BIN2, name), 'w').write('#!/bin/sh\n')
    os.chmod(os.path.join(BIN2, name), 0o755)


def write_conf(entries, cfg=CFG):
    for name, data in (('config.json', cfg), ('lista.json', {'celok': entries})):
        p = os.path.join(CONF, name)
        open(p, 'w').write(json.dumps(data))
        os.chmod(p, 0o644)
    p = os.path.join(CONF, 'discord-olvaso')
    open(p, 'w').write('bot-token-for-the-test\n')
    os.chmod(p, 0o600)


def entry(key, src, dst, kind='fajl', mode='0755'):
    return {'kulcs': key, 'forras': src, 'cel': dst, 'tulaj': ME, 'csoport': MYGROUP, 'mod': mode, 'fajta': kind}


C1, C2 = 'a' * 40, 'b' * 40
FILES = {}       # (path, ref) -> bytes
ON_MAIN = {C1: True, C2: True}
CALLS = []


def fake_http(url, headers, limit=rt.MAX_FILE_BYTES):
    CALLS.append(url)
    if url.startswith(rt.GITHUB_API):
        if '/compare/' in url:
            commit = url.split('/compare/')[1].split('...')[0]
            behind = 0 if ON_MAIN.get(commit) else 3
            return json.dumps({'behind_by': behind, 'status': 'ahead' if behind == 0 else 'diverged'}).encode()
        path, ref = url.split('/contents/')[1].split('?ref=')
        if (path, ref) not in FILES:
            raise rt.Refused('nincs ilyen')
        return FILES[(path, ref)]
    if url.startswith(rt.DISCORD_API):
        if '?after=' in url:
            return json.dumps(DISCORD['later']).encode()
        return json.dumps(DISCORD['request']).encode()
    raise AssertionError('unexpected url ' + url)


rt.http_get = fake_http
DISCORD = {'request': {}, 'later': []}


def snowflake(ms):
    return str((ms - 1420070400000) << 22)


def approve(r, decision='igen', code='K7MP', author=OWNER, bot=BOT, text=None, edited=None, reply_to=None,
            reply_edited=None, shown=None, after_ms=1000):
    """Puts the Discord messages #33 would have made for R, and the owner's reply, into the fake Discord."""
    shown = shown if shown is not None else r['expiresAt'] - 120
    req_ms = r['createdAt'] * 1000 + after_ms
    req_id = snowflake(req_ms)
    content = text if text is not None else rt.approval_text(r['kero'], rt.CATEGORY, r['canonicalLine'], shown,
                                                           code, 'igen', 'nem')
    DISCORD['request'] = {'id': req_id, 'channel_id': CHANNEL, 'author': {'id': bot, 'bot': True},
                          'content': content, 'edited_timestamp': edited}
    DISCORD['later'] = [] if decision is None else [{
        'id': snowflake(req_ms + 1000), 'author': {'id': author}, 'content': f'{decision} {code}',
        'message_reference': {'message_id': reply_to or req_id}, 'edited_timestamp': reply_edited}]
    return req_id


def now_ms(r):
    return r['createdAt'] * 1000 + 5000


def kerj(key, commit):
    return rt.cmd_kerj([key, commit, 'murena'])


def run(r, msg, at=None):
    return rt.cmd_vegrehajt([r['r'], msg], now_ms=at if at is not None else now_ms(rt.load_r(r['r'])))


try:
    print('the shared #33 fixture (Node checks the same file in approval-text-fixture.test.ts)')
    fx = json.load(open(FIXTURE, encoding='utf-8'))
    for case in fx['expiry']:
        check('expiry %d' % case['t'], case['text'], rt.format_expiry(case['t']))
    for case in fx['text']:
        check('approval text: ' + case['description'][:40], case['want'],
              rt.approval_text(case['agent_id'], case['category'], case['description'], case['timeout_at'],
                               case['code'], 'igen', 'nem'))
    check('neutral description', fx['neutral']['want'], rt.neutral_description(fx['neutral']['in']))

    print('the list')
    fp = os.path.join(TGT, 'usr-local-sbin-fleet-pane')
    sud = os.path.join(SUDOERS_D, 'fleet-pane')
    good = [entry('fleet-pane', 'scripts/root/fleet-pane.py', fp),
            entry('fleet-pane-sudoers', 'templates/sudoers/fleet-pane', sud, 'sudoers', '0440')]
    write_conf(good)
    rt.TRUST_FROM = T
    check('a good list loads', ['fleet-pane', 'fleet-pane-sudoers'], sorted(rt.load_list()))
    bad_cases = {
        'the installer itself': entry('x', 'a/b', rt.SELF),
        'its sudo rule': entry('x', 'a/b', rt.SELF_SUDOERS, 'sudoers', '0440'),
        'its own state': entry('x', 'a/b', '/var/lib/root-telepito/tar/x'),
        '/etc/sudoers': entry('x', 'a/b', '/etc/sudoers'),
        '/etc/shadow': entry('x', 'a/b', '/etc/shadow'),
        'a dotted sudoers name': entry('x', 'a/b', SUDOERS_D + '/a.b', 'sudoers', '0440'),
        'a sudoers kind outside sudoers.d': entry('x', 'a/b', '/usr/local/sbin/x', 'sudoers', '0440'),
        'a plain file inside sudoers.d': entry('x', 'a/b', SUDOERS_D + '/x'),
        'a plain file inside the real sudoers.d': entry('x', 'a/b', '/etc/sudoers.d/x'),
        'a relative target': entry('x', 'a/b', 'usr/x'),
        'a non-normal target': entry('x', 'a/b', '/usr/../etc/x'),
        'a source with ..': entry('x', '../b', '/usr/x'),
        'a mode outside the set': entry('x', 'a/b', '/usr/x', mode='4755'),
        'an underscore #33 would blank out': entry('x', 'a/b', '/usr/local/sbin/fleet_pane'),
    }
    for name, e in bad_cases.items():
        check('refused: ' + name, 'Refused', refused(rt.check_entry, e))
    write_conf(good + [entry('fleet-pane2', 'x/y', fp)])
    check('refused: two entries on one target', 'Refused', refused(rt.load_list))
    write_conf(good)
    os.chmod(rt.LIST_FILE, 0o666)
    check('refused: a list others can write', 'Refused', refused(rt.load_list))
    os.chmod(rt.LIST_FILE, 0o644)

    print('kerj: the source is GitHub at the approved commit, on main, equal to main')
    v1, v2 = b'#!/bin/sh\necho v1\n', b'#!/bin/sh\necho v2\n'
    FILES[('scripts/root/fleet-pane.py', C1)] = v1
    FILES[('scripts/root/fleet-pane.py', 'main')] = v1
    check('a key not on the list', 'Refused', refused(kerj, 'nincs-ilyen', C1))
    ON_MAIN['c' * 40] = False
    FILES[('scripts/root/fleet-pane.py', 'c' * 40)] = v1
    check('a commit not on main', 'Refused', refused(kerj, 'fleet-pane', 'c' * 40))
    FILES[('scripts/root/fleet-pane.py', C2)] = v2
    check('a commit whose file differs from main', 'Refused', refused(kerj, 'fleet-pane', C2))
    r1 = kerj('fleet-pane', C1)
    rec = rt.load_r(r1['r'])
    check('the staged copy is root\'s (0600 in the 0700 store)', 0o600, stat.S_IMODE(os.stat(rec['staged']).st_mode))
    check('the line names key, target, commit, hash and first install', True,
          all(x in r1['canonicalLine'] for x in ('fleet-pane', fp, C1[:12], rt.sha256(v1)[:16], 'ELSO TELEPITES')))
    check('the line survives #33 unchanged', '> ' + r1['canonicalLine'], rt.neutral_description(r1['canonicalLine']))

    print('vegrehajt: only the owner\'s answer on exactly this message')
    msg = approve(rec, decision=None)
    check('no answer yet', 'NotYet', refused(run, r1, msg))
    for name, kw in {
        'another author': {'author': '999999999999999999'},
        'a "nem"': {'decision': 'nem'},
        'not a reply': {'reply_to': '123456789012345678'},
    }.items():
        msg = approve(rec, **kw)
        check('not installed: ' + name, False, refused(run, r1, msg) == 'ok')
    for name, kw in {
        'the request posted by somebody else': {'bot': '999999999999999999'},
        'the request edited': {'edited': '2026-10-19T10:00:00Z'},
        'the request text with one line changed': {'text': rt.approval_text('murena', rt.CATEGORY,
                                                                           r1['canonicalLine'] + ' X',
                                                                           rec['expiresAt'] - 120, 'K7MP', 'igen', 'nem')},
        'an expiry later than the R': {'shown': rec['expiresAt'] + 600},
        'the owner\'s reply edited': {'reply_edited': '2026-10-19T10:00:00Z'},
        'a request older than the R': {'after_ms': -5000},
    }.items():
        msg = approve(rec, **kw)
        check('refused: ' + name, 'Refused', refused(run, r1, msg))
    check('nothing installed by any of these', False, os.path.exists(fp))
    msg = approve(rec)
    check('after the R expired', 'Rejected', refused(run, r1, msg, rec['expiresAt'] * 1000 + 1))
    out = run(r1, msg)
    check('installed', 'telepitve', out['status'])
    check('the target is v1, with the list\'s mode', (v1, 0o755), (open(fp, 'rb').read(), stat.S_IMODE(os.stat(fp).st_mode)))
    # the target put back to what it was at the request, so only the single-use rule can refuse
    saved = open(fp, 'rb').read()
    os.unlink(fp)
    check('the same R a second time, even with the target back as it was', 'Refused', refused(run, r1, msg))
    check('and nothing was installed by it', False, os.path.exists(fp))
    open(fp, 'wb').write(saved)
    os.chmod(fp, 0o755)

    print('a target somebody else could swap')
    FILES[('scripts/root/fleet-pane.py', C2)] = v2
    FILES[('scripts/root/fleet-pane.py', 'main')] = v2
    os.chmod(TGT, 0o777)
    check('a target directory others can write', 'Refused', refused(kerj, 'fleet-pane', C2))
    os.chmod(TGT, 0o755)
    r2 = kerj('fleet-pane', C2)
    rec2 = rt.load_r(r2['r'])
    check('the line says it replaces v1', True, ('CSERE, most ' + rt.sha256(v1)[:16]) in r2['canonicalLine'])
    os.chmod(TGT, 0o777)
    check('a target directory that became writable after the request', 'Refused', refused(run, r2, approve(rec2)))
    check('the R is not spent by that refusal', 'nyitott', rt.load_r(r2['r'])['status'])
    os.chmod(TGT, 0o755)
    open(fp, 'wb').write(b'changed by hand\n')
    check('a target changed since the request', 'Refused', refused(run, r2, approve(rec2)))
    open(fp, 'wb').write(v1)
    os.chmod(fp, 0o755)
    out = run(r2, approve(rec2))
    check('v2 installed', v2, open(fp, 'rb').read())

    print('kerj-vissza: back to a stored version')
    versions = rt.versions('fleet-pane')
    v1_name = [v for v in versions if v.endswith(rt.sha256(v1)[:16])]
    check('v1 is in the store', True, bool(v1_name))
    rb = rt.cmd_kerj_vissza(['fleet-pane', v1_name[0], 'murena'])
    check('the line says VISSZAALLITAS', True, 'VISSZAALLITAS' in rb['canonicalLine'])
    out = run(rb, approve(rt.load_r(rb['r'])))
    check('v1 is back', v1, open(fp, 'rb').read())
    check('a version that is not in the store', 'Refused',
          refused(rt.cmd_kerj_vissza, ['fleet-pane', '20260101T000000Z-' + '0' * 16, 'murena']))

    print('helyreallit: the last approved version, nothing else')
    os.unlink(fp)
    check('after a recreate the approved version comes back', {'helyreallitva': ['fleet-pane']}, rt.cmd_helyreallit([]))
    check('it is v1 (the last approved)', v1, open(fp, 'rb').read())
    check('a second run changes nothing', {'helyreallitva': []}, rt.cmd_helyreallit([]))

    print('sudoers: only parsed rules, and visudo must accept')
    def sudoers_kerj(text, commit):
        FILES[('templates/sudoers/fleet-pane', commit)] = text.encode()
        FILES[('templates/sudoers/fleet-pane', 'main')] = text.encode()
        ON_MAIN[commit] = True
        return refused(kerj, 'fleet-pane-sudoers', commit)
    n = [0]
    def commit():
        n[0] += 1
        return '%040x' % n[0]
    for name, text in {
        'an alias': 'Cmnd_Alias X = %s\n' % BROKER,
        'Defaults': 'Defaults !requiretty\n',
        'an include': '#includedir /tmp\n',
        'two commands on a line': '%s ALL=(root) NOPASSWD: %s, %s\n' % (ME, BROKER, BROKER),
        'a negation': '%s ALL=(root) NOPASSWD: !%s\n' % (ME, BROKER),
        'a shell': '%s ALL=(root) NOPASSWD: /bin/sh\n' % ME,
        # owned like root here, in a safe directory: only the escalation list can refuse it
        'a file named like a shell': '%s ALL=(root) NOPASSWD: %s/bash\n' % (ME, BIN),
        'a file named like an interpreter': '%s ALL=(root) NOPASSWD: %s/python3 -c *\n' % (ME, BIN),
        'the installer itself': '%s ALL=(root) NOPASSWD: %s kerj *\n' % (ME, rt.SELF),
        'a command nobody owns safely': '%s ALL=(root) NOPASSWD: %s/nincs\n' % (ME, BIN),
        'an unknown user': 'nincsilyenfelhasznalo ALL=(root) NOPASSWD: %s\n' % BROKER,
        'visudo refuses it': '# VISUDO-NEM\n%s ALL=(root) NOPASSWD: %s\n' % (ME, BROKER),
        'no rule at all': '# csak megjegyzes\n',
        # barracuda, #242 review B: a command outside the brokers' directory is refused by place
        'tee outside the brokers directory': '%s ALL=(root) NOPASSWD: %s/tee /etc/sudoers.d/x\n' % (ME, BIN2),
        'find outside the brokers directory': '%s ALL=(root) NOPASSWD: %s/find *\n' % (ME, BIN2),
        'the real /usr/bin/tee': '%s ALL=(root) NOPASSWD: /usr/bin/tee *\n' % ME,
        'the real /usr/bin/find': '%s ALL=(root) NOPASSWD: /usr/bin/find\n' % ME,
    }.items():
        check('refused: ' + name, 'Refused', sudoers_kerj(text, commit()))
    os.chmod(BIN, 0o777)
    check('refused: a command in a directory others can write', 'Refused',
          sudoers_kerj('%s ALL=(root) NOPASSWD: %s status\n' % (ME, BROKER), commit()))
    os.chmod(BIN, 0o755)
    c = commit()
    text = '# fleet-pane\n%s ALL=(root) NOPASSWD: %s send *\n' % (ME, BROKER)
    FILES[('templates/sudoers/fleet-pane', c)] = text.encode()
    FILES[('templates/sudoers/fleet-pane', 'main')] = text.encode()
    ON_MAIN[c] = True
    rs = kerj('fleet-pane-sudoers', c)
    check('the line carries the parsed rule, the wildcard in words', True,
          ('SZABALYOK: %s futtathatja root jogon, jelszo nelkul: %s send [barmi]' % (ME, BROKER)) in rs['canonicalLine'])
    out = run(rs, approve(rt.load_r(rs['r'])))
    check('installed 0440', 0o440, stat.S_IMODE(os.stat(sud).st_mode))

    print('a command with no arguments is ANY arguments for sudo, and the line says so (barracuda #242 A)')
    for words, text in (('[barmilyen argumentummal]', '%s ALL=(root) NOPASSWD: %s\n' % (ME, BROKER)),
                        ('(argumentum nelkul)', '%s ALL=(root) NOPASSWD: %s ""\n' % (ME, BROKER))):
        c = commit()
        FILES[('templates/sudoers/fleet-pane', c)] = text.encode()
        FILES[('templates/sudoers/fleet-pane', 'main')] = text.encode()
        ON_MAIN[c] = True
        line = kerj('fleet-pane-sudoers', c)['canonicalLine']
        check('the line says ' + words, True, line.endswith('jelszo nelkul: %s %s' % (BROKER, words)))
    check('visudo checked the staged copy, the file before the rename and the whole configuration', True,
          sum(1 for line in open(VISUDO_LOG) if line.strip()) >= 3)

    print('the approval line: up to 1500 characters for this category, no more')
    def sudoers_line_length(count):
        text = ''.join('%s ALL=(root) NOPASSWD: %s send arg%d\n' % (ME, BROKER, i) for i in range(count))
        c = commit()
        FILES[('templates/sudoers/fleet-pane', c)] = text.encode()
        FILES[('templates/sudoers/fleet-pane', 'main')] = text.encode()
        ON_MAIN[c] = True
        try:
            return len(kerj('fleet-pane-sudoers', c)['canonicalLine'])
        except rt.Refused as e:
            return 'refused:' + str(e)[:40]
    mid = sudoers_line_length(8)
    check('a line between 500 and 1500 characters is accepted (the category\'s own limit)', True,
          isinstance(mid, int) and 500 < mid <= 1500)
    over = sudoers_line_length(30)
    check('a line over 1500 characters is refused, not cut', True, isinstance(over, str) and over.startswith('refused:'))

    print('the durable store')
    rt.REQUIRE_DURABLE_STORE = True
    check('refused when the store is not a mount', 'Refused', refused(kerj, 'fleet-pane', C2))
    rt.REQUIRE_DURABLE_STORE = False

    print('callers')
    write_conf(good, dict(CFG, callers=['valaki-mas']))
    check('a caller not on the list', 'Refused', refused(kerj, 'fleet-pane', C1))
    write_conf(good)

    print('no redirect is followed (the Discord token must not leave discord.com)')
    check('the opener has no redirect handler that follows', True,
          any(isinstance(h, rt._NoRedirect) for h in rt._OPENER.handlers))
finally:
    shutil.rmtree(T, ignore_errors=True)

print('all pass' if fails == 0 else '%d FAILED' % fails)
raise SystemExit(1 if fails else 0)
