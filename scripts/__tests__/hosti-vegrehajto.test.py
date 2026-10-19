#!/usr/bin/env python3
# Guard for scripts/host/hosti-vegrehajto.py (the no-command-line plan, point C; design sheet v2, barracuda APPROVE).
# WHAT TURNS THIS RED:
#   - a step that changes anything (a tag, a build, an up) before the R was spent, or the R spent before every
#     MEASUREMENT agreed (the commit on main, the resolved compose config, the live image ids, the clone's HEAD);
#   - an R used twice, also when a second instance spends it between the measurements and the change;
#   - a project that is busy being touched (the answer is `foglalt`, the R stays open);
#   - the resolved compose config differing from the pinned hash without the file differing (an .env value);
#   - a client that goes away (a closed socket, SIGPIPE) stopping the work half way;
#   - a peer that is not the fleet UID being served, or a verb or project off the closed lists being run;
#   - a docker call carrying prune, rmi, image rm, run, exec, cp, rm, --force-recreate, --build, -V, --remove-orphans;
#   - the environment of an external call holding anything of the caller's (COMPOSE_*, DOCKER_*, SSH_AUTH_SOCK ...);
#   - a rollback that does not put the previous image live, a failed build followed by an up, a post-check that
#     does not compare the running image;
#   - the project list or the settings accepting an unknown key, the fleet's own tree, the program's own state,
#     or a project name that is the gate or the executor;
#   - the Python #33 text or date rendering drifting from the shared fixture (Node checks the same fixture).
import ast
import hashlib
import importlib.util
import io
import json
import os
import signal
import stat
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
FIXTURE = os.path.join(HERE, 'fixtures', 'approval-text.json')
PROGRAM = os.path.join(ROOT, 'scripts/host/hosti-vegrehajto.py')

spec = importlib.util.spec_from_file_location('hosti_vegrehajto', PROGRAM)
hv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hv)

fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print('  [%s] %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' (got %r, want %r)' % (got, want)))


def outcome_of(fn, *a, **k):
    """The exception class name, or 'ok'."""
    try:
        fn(*a, **k)
        return 'ok'
    except (hv.Busy, hv.Refused, hv.Failed, hv.NotYet, hv.Rejected) as e:
        return type(e).__name__


T = os.path.realpath(tempfile.mkdtemp(prefix='hosti-vegrehajto-'))
os.chmod(T, 0o755)
CONF = os.path.join(T, 'conf')
STATE = os.path.join(T, 'state')
OPT = os.path.join(T, 'opt')
for d in (CONF, STATE, os.path.join(OPT, 'levelkozvetito', 'src'), os.path.join(OPT, 'vegrehajto', 'src')):
    os.makedirs(d, mode=0o755, exist_ok=True)
os.chmod(STATE, 0o700)

ME = os.getuid()
hv.ROOT_UID = ME  # the test is not root: "root-owned" means "owned by me" here
hv.STATE = STATE
hv.CONFIG_FILE = os.path.join(CONF, 'config.json')
hv.DISCORD_TOKEN_FILE = os.path.join(CONF, 'discord-olvaso')
FILTER_COPY = os.path.join(CONF, 'naplo-szuro')
import shutil as _shutil
_shutil.copyfile(os.path.join(ROOT, 'scripts/host/naplo-szuro.py'), FILTER_COPY)
os.chmod(FILTER_COPY, 0o755)
hv.FILTER_FILE = FILTER_COPY

CHANNEL, BOT, OWNER = '1540270627926183997', '1500000000000000001', '1460000000000000001'
FLEET_UID = 12345
SHA_A = 'a' * 40
SHA_B = 'b' * 40
CFG_TEXT = b'name: levelkozvetito\nservices: {}\n'
CFG_HASH = hashlib.sha256(CFG_TEXT).hexdigest()
ID_OLD = 'sha256:' + '1' * 64
ID_NEW = 'sha256:' + '2' * 64
ID_PREV = 'sha256:' + '3' * 64
CID = 'abc123def456'


def base_config():
    return {'fleetUid': FLEET_UID, 'requesters': ['acrobot', 'murena'],
            'discord': {'channelId': CHANNEL, 'requestBotUserId': BOT, 'deciderUserIds': [OWNER], 'yes': 'igen', 'no': 'nem'},
            'projectsFile': os.path.join(CONF, 'projektek.json')}


def project(name='levelkozvetito', **over):
    p = {'nev': name, 'dir': os.path.join(OPT, name), 'composeFajl': os.path.join(OPT, name, 'compose.yaml'),
         'konfigSha256': CFG_HASH, 'composeProjekt': name, 'szolgaltatasok': [name], 'repo': 'KratoBal/acroveliq',
         'ag': 'main', 'src': os.path.join(OPT, name, 'src'), 'kep': name + ':local', 'igek': ['telepit', 'up', 'visszaallit'],
         'jovahagyasPerc': 30}
    p.update(over)
    return p


def write_json(path, obj, mode=0o644):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f)
    os.chmod(path, mode)


def write_conf(cfg=None, projects=None):
    write_json(hv.CONFIG_FILE, cfg or base_config())
    write_json(os.path.join(CONF, 'projektek.json'), projects if projects is not None else [project()])
    with open(hv.DISCORD_TOKEN_FILE, 'w') as f:
        f.write('bot-token-value\n')
    os.chmod(hv.DISCORD_TOKEN_FILE, 0o600)


class FakeRunner:
    """The docker, compose and git of the host, as a state machine; every call is recorded with its argument list."""

    def __init__(self):
        self.calls = []
        self.images = {'levelkozvetito:local': ID_OLD}
        self.running = ID_OLD
        self.head = None
        self.dirty = b''
        self.config_text = CFG_TEXT
        self.build_rc = 0
        self.up_rc = 0
        self.up_effect = True
        self.git_checkout_rc = 0
        self.hooks = []  # callables run before the call is answered: (argv) -> None
        self.logs_rc = 0
        self.logs_out = b''
        self.logs_err = b''

    def run(self, argv, cwd=None, timeout=120):
        self.calls.append(list(argv))
        for h in self.hooks:
            h(argv)
        a = argv
        if a[0] == hv.DOCKER:
            if a[1:3] == ['image', 'inspect']:
                ref = a[-1]
                found = self.images.get(ref)
                if found and hv.IMAGE_FORMAT in a:
                    return 0, f'{found}|2026-10-19T10:00:00Z\n'.encode(), b''
                return (0, (found + '\n').encode(), b'') if found else (1, b'', b'no such image')
            if a[1] == 'tag':
                src = self.images.get(a[2], a[2] if a[2].startswith('sha256:') else None)
                if src is None:
                    return 1, b'', b'no such image'
                self.images[a[3]] = src
                return 0, b'', b''
            if a[1] == 'compose':
                rest = a[a.index('-f') + 2:]
                if rest[0] == 'config':
                    return 0, self.config_text, b''
                if rest[0] == 'build':
                    if self.build_rc == 0:
                        self.images['levelkozvetito:local'] = ID_NEW
                    return self.build_rc, b'building ...', b''
                if rest[0] == 'up':
                    if self.up_rc == 0 and self.up_effect:
                        self.running = self.images['levelkozvetito:local']
                    return self.up_rc, b'', b''
                if rest[0] == 'ps':
                    return 0, (CID + '\n').encode(), b''
                if rest[0] == 'logs':
                    return self.logs_rc, self.logs_out, self.logs_err
            if a[1] == 'inspect':
                if hv.CONTAINER_FORMAT in a:
                    return 0, f'/levelkozvetito-1|levelkozvetito:local|{self.running}|2026-10-19T10:00:00Z|2026-10-19T10:05:00Z|running|0|-\n'.encode(), b''
                return 0, f'{self.running} true\n'.encode(), b''
        if a[0] == hv.GIT:
            rest = a[a.index('-C') + 2:]
            while rest and rest[0] == '-c':
                rest = rest[2:]
            if rest[0] == 'fetch':
                return 0, b'', b''
            if rest[0] == 'checkout':
                if self.git_checkout_rc == 0:
                    self.head = rest[-1]
                return self.git_checkout_rc, b'', b''
            if rest[0] == 'rev-parse':
                return (0, (self.head + '\n').encode(), b'') if self.head else (128, b'', b'')
            if rest[0] == 'status':
                return 0, self.dirty, b''
        return 127, b'', b'unexpected command'

    def mutating(self):
        out = []
        for c in self.calls:
            if c[0] == hv.DOCKER and c[1] == 'tag':
                out.append('tag')
            elif c[0] == hv.DOCKER and c[1] == 'compose' and c[c.index('-f') + 2] in ('build', 'up'):
                out.append(c[c.index('-f') + 2])
        return out


FAKE = FakeRunner()
hv.RUNNER = FAKE
GITHUB_OK = {'behind_by': 0, 'status': 'ahead'}
GITHUB = {'compare': dict(GITHUB_OK)}
MESSAGES = {'request': None, 'later': []}


def fake_http(url, headers, limit=1_000_000):
    if '/compare/' in url:
        return json.dumps(GITHUB['compare']).encode()
    if url.startswith(hv.DISCORD_API):
        if '?after=' in url:
            return json.dumps(MESSAGES['later']).encode()
        return json.dumps(MESSAGES['request']).encode()
    raise hv.Failed('unexpected url')


hv.HTTP = fake_http


def fresh():
    """A clean world: state empty, the fake docker as after a normal install, the config and list written."""
    global FAKE
    for sub in ('keresek', 'locks'):
        d = os.path.join(STATE, sub)
        if os.path.isdir(d):
            for n in os.listdir(d):
                os.remove(os.path.join(d, n))
    log = os.path.join(STATE, 'audit.log')
    if os.path.exists(log):
        os.remove(log)
    FAKE = FakeRunner()
    hv.RUNNER = FAKE
    GITHUB['compare'] = dict(GITHUB_OK)
    write_conf()


def snowflake_at(ms):
    return str(((ms - 1420070400000) << 22) | 1)


def put_up_and_answer(r, answer='igen'):
    """What #33 and the owner do: the request message with the R's line, then the owner's reply."""
    code = 'K7QZ'
    shown = r['expiresAt'] - 60
    created_ms = r['createdAt'] * 1000
    req = {'id': snowflake_at(created_ms + 5000), 'channel_id': CHANNEL, 'author': {'id': BOT, 'bot': True},
           'edited_timestamp': None,
           'content': hv.approval_text(r['kero'], hv.CATEGORY, r['canonicalLine'], shown, code, 'igen', 'nem')}
    later = []
    if answer:
        later.append({'id': snowflake_at(created_ms + 10000), 'channel_id': CHANNEL, 'author': {'id': OWNER},
                      'content': f'{answer} {code}', 'message_reference': {'message_id': req['id']}, 'edited_timestamp': None})
    MESSAGES['request'], MESSAGES['later'] = req, later
    return req['id'], created_ms + 20000


def ask(ige='telepit', commit=SHA_A, projekt='levelkozvetito', kero='murena', now=None):
    return hv.cmd_kerj([projekt, ige, commit, kero], now=now or 1_800_000_000)


def go(rid, answer='igen', accepted=None, now_ms=None):
    r = hv.load_r(rid)
    msg, at = put_up_and_answer(r, answer)
    return hv.cmd_vegrehajt([rid, msg], now_ms=now_ms if now_ms is not None else at, accepted=accepted)


try:
    print('the shared #33 fixture (Node checks the same file in approval-text-fixture.test.ts)')
    fx = json.load(open(FIXTURE, encoding='utf-8'))
    for case in fx['expiry']:
        check('expiry %d' % case['t'], case['text'], hv.format_expiry(case['t']))
    for case in fx['text']:
        # this category has no extra room (the root installer's has 1500 and its own copy)
        if case['category'] == 'root_telepites':
            continue
        check('approval text: ' + case['description'][:40], case['want'],
              hv.approval_text(case['agent_id'], case['category'], case['description'], case['timeout_at'], case['code'], 'igen', 'nem'))
    check('neutral description', fx['neutral']['want'], hv.neutral_description(fx['neutral']['in']))

    print('the settings and the project list are strict')
    fresh()
    check('a good config and list load', ['levelkozvetito'], sorted(hv.load_projects(hv.load_config())))
    bad_cfg = {
        'an unknown top key': lambda c: c.update(extra=1),
        'fleetUid 0 (root)': lambda c: c.update(fleetUid=0),
        'fleetUid as a string': lambda c: c.update(fleetUid='1000'),
        'no requesters': lambda c: c.update(requesters=[]),
        'a requester with a slash': lambda c: c.update(requesters=['a/b']),
        'the request bot among the deciders': lambda c: c['discord'].update(deciderUserIds=[BOT]),
        'yes equal to no': lambda c: c['discord'].update(no='igen'),
        'a relative projects file': lambda c: c.update(projectsFile='projektek.json'),
        'a projects file with ..': lambda c: c.update(projectsFile='/etc/../tmp/p.json'),
    }
    for name, change in bad_cfg.items():
        c = base_config()
        change(c)
        write_conf(cfg=c)
        check('config refuses ' + name, 'Refused', outcome_of(hv.load_config))
    bad_proj = {
        'an unknown key': lambda p: p.update(extra=1),
        'a missing key': lambda p: p.pop('kep'),
        'the fleet tree': lambda p: p.update(dir='/opt/marveen-docker/x', composeFajl='/opt/marveen-docker/x/c.yaml'),
        'the program state': lambda p: p.update(src='/var/lib/hosti-vegrehajto/src'),
        'the gate directory': lambda p: p.update(src='/usr/local/lib/fleet-gate/src'),
        'a compose file outside the directory': lambda p: p.update(composeFajl=os.path.join(OPT, 'masik', 'compose.yaml')),
        'a verb outside the closed list': lambda p: p.update(igek=['telepit', 'prune']),
        'no verbs': lambda p: p.update(igek=[]),
        'an approval window of 31 minutes': lambda p: p.update(jovahagyasPerc=31),
        'a hash that is not sha256': lambda p: p.update(konfigSha256='abc'),
        'an image reference without a tag': lambda p: p.update(kep='levelkozvetito'),
        'a service with a space': lambda p: p.update(szolgaltatasok=['a b']),
        'the gate as a project name': lambda p: p.update(nev='fleet-gate'),
        'the fleet container as a project name': lambda p: p.update(nev='marveen-docker'),
        'the executor itself as a project name': lambda p: p.update(nev='hosti-vegrehajto'),
        'a path with ..': lambda p: p.update(src=os.path.join(OPT, 'levelkozvetito', '..', 'x')),
    }
    for name, change in bad_proj.items():
        p = project()
        change(p)
        write_conf(projects=[p])
        check('project list refuses ' + name, 'Refused', outcome_of(lambda: hv.load_projects(hv.load_config())))
    write_conf(projects=[project(), project()])
    check('a project twice', 'Refused', outcome_of(lambda: hv.load_projects(hv.load_config())))
    write_conf()
    os.chmod(hv.CONFIG_FILE, 0o666)
    check('a settings file others can write is refused', 'Refused', outcome_of(hv.load_config))
    os.chmod(hv.CONFIG_FILE, 0o644)

    print('kerj: measured, then an R; nothing else changes')
    fresh()
    out = ask()
    r = hv.load_r(out['r'])
    check('the R is open, with the live image ids and no steps', ['open', hv.short(ID_OLD), 'nincs', []],
          [r['status'], r['elo'], r['elozo'], r['lepes']])
    check('the line has the project, verb, commit and ids',
          f"HOSTI R={out['r']} / levelkozvetito / telepit / {SHA_A} / elo {'1' * 12} / elozo nincs", out['canonicalLine'])
    check('the line survives the #33 neutraliser unchanged', '> ' + out['canonicalLine'], hv.neutral_description(out['canonicalLine']))
    check('the window is the project\'s', r['createdAt'] + 30 * 60, out['expiresAt'])
    check('kerj changes nothing (no tag, build or up)', [], FAKE.mutating())
    check('a project off the list', 'Refused', outcome_of(ask, projekt='masik'))
    check('a verb the project does not allow', 'Refused',
          outcome_of(lambda: (write_conf(projects=[project(igek=['up'])]), ask())[1]))
    write_conf()
    check('a requester off the list', 'Refused', outcome_of(ask, kero='nautilus'))
    check('a short commit', 'Refused', outcome_of(ask, commit='abc123'))
    GITHUB['compare'] = {'behind_by': 3, 'status': 'diverged'}
    check('a commit that is not on main', 'Refused', outcome_of(ask))
    GITHUB['compare'] = dict(GITHUB_OK)
    check('up with a commit', 'Refused', outcome_of(ask, ige='up', commit=SHA_A))
    check('up without a commit', 'ok', outcome_of(ask, ige='up', commit='-'))
    check('a rollback with no previous image', 'Refused', outcome_of(ask, ige='visszaallit', commit='-'))
    up_r = hv.load_r(ask(ige='up', commit='-')['r'])
    check('the up line says jelenlegi', True, ' / up / jelenlegi / ' in up_r['canonicalLine'])

    print('vegrehajt: the whole path of a telepit')
    fresh()
    out = ask()
    order = []
    FAKE.hooks.append(lambda argv: order.append('mut') if (argv[0] == hv.DOCKER and argv[1] in ('tag',) or (len(argv) > 5 and argv[1] == 'compose' and argv[argv.index('-f') + 2] in ('build', 'up'))) else None)
    state_at_first_mutation = []
    FAKE.hooks.append(lambda argv: state_at_first_mutation.append(hv.load_r(out['r'])['status']) if (argv[0] == hv.DOCKER and argv[1] == 'tag') else None)
    accepted_at = []
    res = go(out['r'], accepted=lambda obj: accepted_at.append(len(FAKE.mutating())))
    r = hv.load_r(out['r'])
    check('the outcome is kesz_igazolt', 'kesz_igazolt', res['outcome'])
    check('the R is used', 'used', r['status'])
    check('the reply (elfogadva) went BEFORE the first change', [0], accepted_at)
    check('the R was already used when the first change ran', 'used', state_at_first_mutation[0])
    check('the changes, in order: the previous tag, build, up', ['tag', 'build', 'up'], FAKE.mutating())
    check('the previous label holds the old image', ID_OLD, FAKE.images['levelkozvetito:elozo'])
    check('the live label holds the new image', ID_NEW, FAKE.images['levelkozvetito:local'])
    check('the clone is at the approved commit', SHA_A, FAKE.head)
    steps = [s['nev'] for s in r['lepes']]
    check('every step is in the R, with its exit code', ['elozo-cimke', 'build', 'up'], steps)
    flat = [' '.join(c) for c in FAKE.calls]
    for bad in ('prune', 'rmi', 'image rm', ' run ', ' exec ', ' cp ', ' rm ', '--force-recreate', '--build', ' -V', '--remove-orphans',
                'volume', 'system'):
        check('no call carries ' + bad.strip(), [], [c for c in flat if bad in c])
    check('up names the project\'s services and nothing else', [hv.DOCKER, 'compose', '-p', 'levelkozvetito', '-f',
                                                               project()['composeFajl'], 'up', '-d', 'levelkozvetito'],
          [c for c in FAKE.calls if 'up' in c and c[1] == 'compose'][0])
    check('the git calls are protected like git-olvas.sh', True,
          all(('core.hooksPath=/dev/null' in c and 'core.fsmonitor=false' in c and 'diff.external=' in c) for c in FAKE.calls if c[0] == hv.GIT))
    audit = open(os.path.join(STATE, 'audit.log'), encoding='utf-8').read()
    check('the audit trail has no output of a command', False, 'building ...' in audit)

    print('vegrehajt: nothing changes without the owner, twice, or when a measurement disagrees')
    fresh()
    out = ask()
    check('no decision yet', 'NotYet', outcome_of(go, out['r'], None))
    check('the R stays open', 'open', hv.load_r(out['r'])['status'])
    check('nothing changed', [], FAKE.mutating())
    check('the owner said no', 'Rejected', outcome_of(go, out['r'], 'nem'))
    check('still nothing changed', [], FAKE.mutating())
    r = hv.load_r(out['r'])
    msg, at = put_up_and_answer(r, 'igen')
    MESSAGES['request']['content'] = MESSAGES['request']['content'].replace('telepit', 'up')
    check('a request text that differs from the R', 'Refused', outcome_of(hv.cmd_vegrehajt, [out['r'], msg], now_ms=at))
    msg, at = put_up_and_answer(r, 'igen')
    check('the approved R runs', 'ok', outcome_of(hv.cmd_vegrehajt, [out['r'], msg], now_ms=at))
    check('a second vegrehajt on the same R', 'Refused', outcome_of(hv.cmd_vegrehajt, [out['r'], msg], now_ms=at))
    check('exactly one build', 1, sum(1 for c in FAKE.calls if 'build' in c))
    check('an expired R', 'Refused', outcome_of(lambda: (fresh(), go(ask(now=1_800_000_000)['r'], now_ms=1_800_000_000_000 + 31 * 60_000))[1]))

    fresh()
    out = ask()
    FAKE.config_text = b'name: levelkozvetito\nservices: {x: 1}\n'
    check('the resolved config differs from the pinned hash (the compose file itself unchanged)', 'Refused', outcome_of(go, out['r']))
    check('the R is open and nothing changed', ['open', []], [hv.load_r(out['r'])['status'], FAKE.mutating()])
    FAKE.config_text = CFG_TEXT
    GITHUB['compare'] = {'behind_by': 1, 'status': 'diverged'}
    check('the commit left main since the request', 'Refused', outcome_of(go, out['r']))
    GITHUB['compare'] = dict(GITHUB_OK)
    FAKE.images['levelkozvetito:local'] = ID_PREV
    check('the live image changed since the request', 'Refused', outcome_of(go, out['r']))
    check('the R is still open', 'open', hv.load_r(out['r'])['status'])
    FAKE.images['levelkozvetito:local'] = ID_OLD
    FAKE.dirty = b' M Dockerfile\n'
    check('a dirty clone', 'Refused', outcome_of(go, out['r']))
    FAKE.dirty = b''
    FAKE.git_checkout_rc = 1
    check('a commit that cannot be checked out', 'Refused', outcome_of(go, out['r']))
    check('nothing was ever tagged, built or started', [], FAKE.mutating())

    print('locks: a busy project, and the open -> used race')
    fresh()
    out = ask()
    with hv.Locked('project-levelkozvetito.lock', blocking=False):
        check('a busy project answers foglalt', 'Busy', outcome_of(go, out['r']))
    check('the R stays open and nothing changed', ['open', []], [hv.load_r(out['r'])['status'], FAKE.mutating()])
    check('and the retry runs', 'ok', outcome_of(go, out['r']))
    fresh()
    out = ask()
    original = hv.measure_before_spending

    def second_instance_wins(r, project_, cfg):
        original(r, project_, cfg)
        stolen = hv.load_r(r['id'])
        stolen['status'] = 'used'  # another instance got through between the measurements and the change
        hv.save_r(stolen)

    hv.measure_before_spending = second_instance_wins
    check('a second instance spent the R meanwhile: this one refuses', 'Refused', outcome_of(go, out['r']))
    hv.measure_before_spending = original
    check('and made no change', [], FAKE.mutating())
    # the R lock really excludes: a thread holding it makes the spend wait
    fresh()
    out = ask()
    held, released = threading.Event(), threading.Event()
    spent_while_held = []

    def holder():
        with hv.Locked('r.lock', blocking=True):
            held.set()
            released.wait(5)

    t = threading.Thread(target=holder)
    t.start()
    held.wait(5)
    worker = threading.Thread(target=lambda: go(out['r']))
    worker.start()
    worker.join(0.5)
    spent_while_held.append(hv.load_r(out['r'])['status'])
    released.set()
    worker.join(10)
    t.join(10)
    check('while another holds the R lock the R is not spent; afterwards it runs', ['open', 'used'],
          [spent_while_held[0], hv.load_r(out['r'])['status']])

    print('a client that goes away does not stop the work')
    fresh()
    out = ask()
    r = hv.load_r(out['r'])
    msg, at = put_up_and_answer(r, 'igen')
    request = (json.dumps({'ige': 'vegrehajt', 'args': [out['r'], msg]}) + '\n').encode()

    class DeadClient(io.RawIOBase):
        def writable(self):
            return True

        def write(self, b):
            raise BrokenPipeError()

        def flush(self):
            raise BrokenPipeError()

    real_now = hv.time.time
    hv.time.time = lambda: at / 1000
    try:
        try:
            code = hv.serve(stdin=io.BytesIO(request), stdout=DeadClient(), uid_of_peer=lambda: FLEET_UID)
        except Exception as e:  # a write error that escapes serve is a failed check, not a crashed guard
            code = 'escaped: %s' % e.__class__.__name__
    finally:
        hv.time.time = real_now
    r = hv.load_r(out['r'])
    check('the work ran to the end although every write failed (EPIPE)', ['kesz_igazolt', ['tag', 'build', 'up']], [r['outcome'], FAKE.mutating()])
    check('serve returned success', 0, code)
    check('SIGPIPE is ignored', signal.SIG_IGN, signal.getsignal(signal.SIGPIPE))

    print('the socket instance')
    fresh()
    out_buf = io.BytesIO()

    class Capture(io.RawIOBase):
        def writable(self):
            return True

        def write(self, b):
            out_buf.write(bytes(b))
            return len(b)

    def serve_one(obj, uid=FLEET_UID):
        out_buf.seek(0)
        out_buf.truncate()
        line = (json.dumps(obj) + '\n').encode()
        code = hv.serve(stdin=io.BytesIO(line), stdout=Capture(), uid_of_peer=lambda: uid)
        text = out_buf.getvalue().decode()
        return code, (json.loads(text.splitlines()[0]) if text.strip() else None)

    code, reply = serve_one({'ige': 'kerj', 'args': ['levelkozvetito', 'up', '-', 'murena']})
    check('the fleet uid is served', [0, True], [code, reply and reply.get('ok')])
    code, reply = serve_one({'ige': 'kerj', 'args': ['levelkozvetito', 'up', '-', 'murena']}, uid=FLEET_UID + 1)
    check('another uid (the group is not asked) is refused', [1, False, 'idegen uid'], [code, (reply or {}).get('ok'), (reply or {}).get('hiba')])
    code, reply = serve_one({'ige': 'kerj', 'args': ['levelkozvetito', 'up', '-', 'murena']}, uid=0)
    check('not even root\'s uid is the fleet\'s', 1, code)
    check('the refused peers asked for nothing: one R only', 1, len(os.listdir(os.path.join(STATE, 'keresek'))))
    for op in ('lenyomat', 'serve', 'telepit', 'prune'):
        code, reply = serve_one({'ige': op, 'args': []})
        check('the socket does not know ' + op, [1, False], [code, reply['ok']])
    code, reply = serve_one({'ige': 'allapot', 'args': []})
    check('allapot answers', True, 'levelkozvetito' in reply['projektek'])
    check('a request with another key is refused', 10, serve_one({'ige': 'allapot', 'args': [], 'x': 1})[0])
    check('a request with a non-string argument is refused', 10, serve_one({'ige': 'kerj', 'args': [1]})[0])
    big = hv.serve(stdin=io.BytesIO(b'{"ige":"allapot","args":["' + b'a' * 5000 + b'"]}\n'), stdout=Capture(), uid_of_peer=lambda: FLEET_UID)
    check('a request over the size limit is refused', 10, big)
    check('the socket verb list is exactly kerj, vegrehajt, allapot, kep, naplo', ['allapot', 'kep', 'kerj', 'naplo', 'vegrehajt'], sorted(hv.SOCKET_OPS))

    print('kep and naplo: read only, fixed fields, and nothing leaves unfiltered (point G)')
    fresh()
    FAKE.images['levelkozvetito:elozo'] = ID_PREV
    k = hv.cmd_kep(['levelkozvetito'])
    check('kep: the image, the previous image and the service container, as fixed fields',
          [{'id': '1' * 12, 'letrehozva': '2026-10-19T10:00:00Z'}, {'id': '3' * 12, 'letrehozva': '2026-10-19T10:00:00Z'}],
          [k['kep'], k['elozo']])
    c = k['szolgaltatasok'][0]['konteneres'][0]
    check('kep: the container fields', ['levelkozvetito-1', 'levelkozvetito:local', '1' * 12, 'running', '0', '-'],
          [c['nev'], c['kep'], c['kepId'], c['allapot'], c['ujrainditas'], c['egeszseg']])
    inspect_templates = [x for call in FAKE.calls for x in call if '{{' in x]
    for forbidden in ('Env', 'Mounts', '.Cmd', 'Entrypoint', 'Labels', 'HostConfig', 'Args'):
        check('kep: no docker template names ' + forbidden, [], [t for t in inspect_templates if forbidden in t])
    check('kep: it changed nothing', [], FAKE.mutating())
    check('kep: a project off the list', 'Refused', outcome_of(hv.cmd_kep, ['masik']))
    check('kep: the wrong number of arguments', 'Refused', outcome_of(hv.cmd_kep, []))

    fresh()
    secret = 'S3cr3tValueAbc12345'
    FAKE.logs_out = f'2026-10-19T10:00:00Z start ok\n2026-10-19T10:00:01Z password={secret} seen\n'.encode()
    FAKE.logs_err = f'2026-10-19T10:00:02Z Error: connect postgres://app:{secret}@db/x failed\n{{"msg":"{{\\"token\\":\\"{secret}\\"}}"}}\n'.encode()
    n = hv.cmd_naplo(['levelkozvetito'])
    check('naplo: the secret is on neither stream of the container, in the reply', False, secret in json.dumps(n))
    check('naplo: stdout lines stay, and the replacements are counted', [True, True, 3], ['start ok' in n['naplo'], '[TITOK]' in n['naplo'], n['szurve']])
    check('naplo: a header names the service', True, n['naplo'].startswith('# szolgaltatas: levelkozvetito\n'))
    audit = open(os.path.join(STATE, 'audit.log'), encoding='utf-8').read()
    check('naplo: the audit has the counts and no log content', [True, False], ['"esemeny": "naplo"' in audit and '"szurve": 3' in audit, 'start ok' in audit or secret in audit])
    logs_calls = [c for c in FAKE.calls if 'logs' in c]
    check('naplo: the compose call is fixed: no follow, no since, the tail and the service', [hv.DOCKER, 'compose', '-p', 'levelkozvetito', '-f', project()['composeFajl'], 'logs', '--no-color', '--timestamps', '--tail', '200', 'levelkozvetito'], logs_calls[0])
    check('naplo: a given number of lines', '50', [c for c in (hv.cmd_naplo(['levelkozvetito', '50']), ) if c][0] and [c for c in FAKE.calls if 'logs' in c][-1][-2])
    for bad in ('0', '1001', '-5', 'abc', '10.5', '01', '99999'):
        check('naplo: the lines value %r is refused' % bad, 'Refused', outcome_of(hv.cmd_naplo, ['levelkozvetito', bad]))
    check('naplo: a project off the list', 'Refused', outcome_of(hv.cmd_naplo, ['masik']))
    check('naplo: a service whose logs cannot be read refuses (no partial reply)', 'Refused', outcome_of(lambda: (setattr(FAKE, 'logs_rc', 1), hv.cmd_naplo(['levelkozvetito']))[1]))
    FAKE.logs_rc = 0
    real_filter = hv.FILTER_FILE
    hv.FILTER_FILE = os.path.join(CONF, 'nincs-szuro')
    check('naplo: NO filter file, NO log', 'Refused', outcome_of(hv.cmd_naplo, ['levelkozvetito']))
    broken = os.path.join(CONF, 'torott-szuro')
    with open(broken, 'w') as f:
        f.write('def filter_text(text):\n    raise RuntimeError("boom")\n')
    os.chmod(broken, 0o755)
    hv.FILTER_FILE = broken
    try:
        reply = hv.cmd_naplo(['levelkozvetito'])
        outcome = 'released: ' + json.dumps(reply)[:60]
    except hv.Refused:
        outcome = 'Refused'
    check('naplo: a filter that fails releases NOTHING (no raw log)', 'Refused', outcome)
    # a WORKING filter in a file others can write: loading it would succeed, so only the owner check refuses it
    writable = os.path.join(CONF, 'irhato-szuro')
    _shutil.copyfile(FILTER_COPY, writable)
    os.chmod(writable, 0o777)
    hv.FILTER_FILE = writable
    check('naplo: a filter file others can write is not loaded', 'Refused', outcome_of(hv.cmd_naplo, ['levelkozvetito']))
    hv.FILTER_FILE = real_filter
    FAKE.logs_out = b'x ' * 400000
    big = hv.cmd_naplo(['levelkozvetito'])
    check('naplo: the reply stays under the limit the client can read', True, len(json.dumps(big)) < 1_000_000)
    code, reply = serve_one({'ige': 'naplo', 'args': ['levelkozvetito', '5']})
    check('kep and naplo are socket verbs, answered like the others', [0, True], [code, reply['ok']])
    code, reply = serve_one({'ige': 'kep', 'args': ['levelkozvetito']})
    check('kep over the socket', [0, True], [code, reply['ok']])

    print('visszaallit, and the failures of the work')
    fresh()
    FAKE.images['levelkozvetito:elozo'] = ID_PREV
    out = ask(ige='visszaallit', commit='-')
    check('the rollback line names the previous image', True, f"elozo / elo {'1' * 12} / elozo {'3' * 12}" in out['canonicalLine'])
    res = go(out['r'])
    check('the rollback ends verified', 'kesz_igazolt', res['outcome'])
    check('the live label holds the previous image', ID_PREV, FAKE.images['levelkozvetito:local'])
    check('the previous label holds the replaced image', ID_OLD, FAKE.images['levelkozvetito:elozo'])
    check('the container runs the previous image', ID_PREV, FAKE.running)
    check('only tags and one up (no build, no clone change)', ['tag', 'tag', 'up'], FAKE.mutating())
    check('a rollback whose previous image moved is refused', 'Refused',
          outcome_of(lambda: (fresh(), FAKE.images.update({'levelkozvetito:elozo': ID_PREV}), ask_r := ask(ige='visszaallit', commit='-'),
                              FAKE.images.update({'levelkozvetito:elozo': ID_NEW}), go(ask_r['r']))[-1]))

    fresh()
    FAKE.build_rc = 1
    out = ask()
    res = go(out['r'])
    check('a failed build: epites_hiba, the R spent, and NO up', ['epites_hiba', 'used', ['tag', 'build']], [res['outcome'], hv.load_r(out['r'])['status'], FAKE.mutating()])
    fresh()
    FAKE.up_rc = 1
    out = ask()
    check('a failed up: indulas_hiba', 'indulas_hiba', go(out['r'])['outcome'])
    fresh()
    FAKE.up_effect = False  # up answers 0 but the container still runs the old image
    out = ask()
    check('an up that leaves the old image running is not verified', 'utomeres_eltero', go(out['r'])['outcome'])

    print('an interrupted run says so at the next look; the program does not continue by itself')
    fresh()
    out = ask()
    r = hv.load_r(out['r'])
    r.update(status='used', outcome='folyamatban', lepes=[{'nev': 'build', 'rc': 0, 'at': 1}])
    hv.save_r(r)
    check('allapot names the last step', 'megszakadt(build)', hv.cmd_allapot([out['r']])['outcome'])
    check('and it stays so', 'megszakadt(build)', hv.load_r(out['r'])['outcome'])
    fresh()
    out = ask()
    r = hv.load_r(out['r'])
    r.update(status='used', outcome='folyamatban', lepes=[])
    hv.save_r(r)
    with hv.Locked('project-levelkozvetito.lock', blocking=False):
        check('a run that holds its project lock is not called interrupted', 'folyamatban', hv.cmd_allapot([out['r']])['outcome'])

    print('the environment of an external call is built here')
    os.environ.update({'COMPOSE_FILE': '/x', 'DOCKER_HOST': 'tcp://x', 'SSH_AUTH_SOCK': '/y', 'COMPOSE_PROJECT_NAME': 'z',
                       'DOCKER_CONFIG': '/evil', 'GIT_DIR': '/evil', 'HOME': '/evil'})
    env = hv.clean_env()
    check('only the fixed variables', ['DOCKER_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS', 'GIT_PAGER',
                                       'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'PAGER', 'PATH'], sorted(env))
    check('the docker config is the program\'s own empty directory', os.path.join(STATE, 'docker-config'), env['DOCKER_CONFIG'])
    real = hv.SubprocessRunner()
    rc, out_b, _ = real.run(['/usr/bin/env'])
    seen = out_b.decode().split('\n')
    check('a real child gets none of the caller\'s variables', [], [l for l in seen if l.startswith(('COMPOSE_', 'SSH_AUTH_SOCK', 'GIT_DIR=', 'DOCKER_HOST'))])
    check('a real child gets the fixed ones', [True, True], ['HOME=' + os.path.join(STATE, 'home') in seen, 'LANG=C' in seen])
    rc, _, err = real.run([os.path.join(T, 'nincs-ilyen-program')])
    check('a program that does not exist is exit 127, not a crash', 127, rc)

    print('lenyomat prints the resolved-config hash and is not a socket verb')
    fresh()
    check('the hash', {'projekt': 'levelkozvetito', 'konfigSha256': CFG_HASH}, hv.cmd_lenyomat(['levelkozvetito']))
    check('a project off the list', 'Refused', outcome_of(hv.cmd_lenyomat, ['masik']))
    real_root = hv.ROOT_UID
    hv.ROOT_UID = 0 if os.geteuid() != 0 else 1
    check('not as a non-root user', 'Refused', outcome_of(hv.cmd_lenyomat, ['levelkozvetito']))
    hv.ROOT_UID = real_root

    print('the source of the program')
    tree = ast.parse(open(PROGRAM, encoding='utf-8').read())
    strings = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            strings.add(node.value)
    doc_nodes = {id(n.body[0].value) for n in ast.walk(tree) if isinstance(n, (ast.Module, ast.FunctionDef, ast.ClassDef))
                 and n.body and isinstance(n.body[0], ast.Expr) and isinstance(n.body[0].value, ast.Constant)}
    literal_words = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in doc_nodes:
            literal_words.add(node.value)
    for word in ('prune', 'rmi', 'rm', 'run', 'exec', 'cp', 'system', 'volume', '--force-recreate', '--build', '-V', '--remove-orphans', 'down', 'kill', 'stop'):
        check('no string in the code says ' + word, False, word in literal_words)
    names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
    check('no shell, no os.system, no Popen', [], sorted(names & {'system', 'Popen', 'popen', 'spawn', 'execv', 'execvp'}))
    src = open(PROGRAM, encoding='utf-8').read()
    check('subprocess.run is called with shell absent and an argument list', False, 'shell=True' in src)
    check('the mode of the files it creates is private', True, "0o600" in src and "mode=0o700" in src)
    print('the gate client (scripts/host/hosti-kliens.py)')
    cspec = importlib.util.spec_from_file_location('hosti_kliens', os.path.join(ROOT, 'scripts/host/hosti-kliens.py'))
    kl = importlib.util.module_from_spec(cspec)
    cspec.loader.exec_module(kl)
    import socket as _socket
    sockpath = os.path.join(T, 'sock')

    def fake_server(replies, seen):
        srv = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        srv.bind(sockpath)
        srv.listen(1)

        def serve_once():
            conn, _ = srv.accept()
            data = b''
            while not data.endswith(b'\n'):
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            seen.append(json.loads(data.decode()))
            for line in replies:
                conn.sendall((json.dumps(line) + '\n').encode())
            conn.close()
            srv.close()
            os.unlink(sockpath)

        th = threading.Thread(target=serve_once)
        th.start()
        return th

    def client(argv, replies):
        seen = []
        th = fake_server(replies, seen)
        buf = io.StringIO()
        real_out, sys.stdout = sys.stdout, buf
        try:
            code = kl.main(['hosti-kliens'] + argv, path=sockpath)
        finally:
            sys.stdout = real_out
        th.join(5)
        return code, seen, buf.getvalue()

    code, seen, out = client(['kerj', 'levelkozvetito', 'up', '-', 'murena'], [{'ok': True, 'r': 'deadbeef'}])
    check('the client sends ONE json line with the verb and the arguments, and exits 0 on ok', [0, [{'ige': 'kerj', 'args': ['levelkozvetito', 'up', '-', 'murena']}]], [code, seen])
    check('the answer is printed as it came', True, '"deadbeef"' in out)
    check('busy is 10', 10, client(['allapot'], [{'ok': False, 'hiba': 'foglalt', 'foglalt': True}])[0])
    check('no decision yet is 11', 11, client(['allapot'], [{'ok': False, 'meg_nincs_dontes': True}])[0])
    check('rejected is 12', 12, client(['allapot'], [{'ok': False, 'elutasitva': True}])[0])
    check('a refusal is 10', 10, client(['allapot'], [{'ok': False, 'hiba': 'x'}])[0])
    check('an accepted vegrehajt then a closed connection is ok (the executor answers at once and works on)', 0,
          client(['vegrehajt', 'deadbeef', '1559919876543210987'], [{'ok': True, 'allapot': 'elfogadva'}])[0])
    check('a socket that is not there is 14', 14, kl.main(['hosti-kliens', 'allapot'], path=os.path.join(T, 'nincs-sock')))
    check('a verb off the list is usage, not a connection', 2, kl.main(['hosti-kliens', 'lenyomat'], path=os.path.join(T, 'nincs-sock')))
    print('the connection CLOSES at the acceptance, and the client returns then (barracuda, #256)')
    srvpath = os.path.join(T, 'srv.sock')

    def real_serve_thread(served):
        srv = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        srv.bind(srvpath)
        srv.listen(1)

        def run_server():
            conn, _ = srv.accept()
            try:
                served['code'] = hv.serve(stdin=conn.makefile('rb'), stdout=conn.makefile('wb'),
                                          uid_of_peer=lambda: FLEET_UID, conn=conn)
            finally:
                srv.close()
                os.unlink(srvpath)

        th = threading.Thread(target=run_server)
        th.start()
        return th

    fresh()
    out = ask()
    r = hv.load_r(out['r'])
    msg, at = put_up_and_answer(r, 'igen')
    FAKE.hooks.append(lambda argv: time.sleep(3) if (argv[0] == hv.DOCKER and argv[1] == 'compose' and argv[argv.index('-f') + 2] == 'build') else None)
    served = {}
    real_now = hv.time.time
    hv.time.time = lambda: at / 1000
    try:
        th = real_serve_thread(served)
        buf = io.StringIO()
        real_out, sys.stdout = sys.stdout, buf
        started = time.monotonic()
        try:
            code = kl.main(['hosti-kliens', 'vegrehajt', out['r'], msg], path=srvpath)
        finally:
            sys.stdout = real_out
        elapsed = time.monotonic() - started
        mutating_when_client_returned = list(FAKE.mutating())
        th.join(30)
    finally:
        hv.time.time = real_now
    check('the client returns 0 with the accepted line, long before the 3 s build ends', [0, True, True],
          [code, 'elfogadva' in buf.getvalue(), elapsed < 1.5])
    check('the build had not finished when the client was already gone', True, 'up' not in mutating_when_client_returned)
    check('the work ran to the end after the client left', ['kesz_igazolt', ['tag', 'build', 'up'], 0],
          [hv.load_r(out['r'])['outcome'], FAKE.mutating(), served.get('code')])

    print('the client stops at the first reply line, and keeps what it read')
    held = {}

    def line_then_hold(reply, hold_seconds):
        srv = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
        srv.bind(srvpath)
        srv.listen(1)

        def run_server():
            conn, _ = srv.accept()
            conn.recv(4096)
            if reply is not None:
                conn.sendall((json.dumps(reply) + '\n').encode())
            time.sleep(hold_seconds)
            conn.close()
            srv.close()
            os.unlink(srvpath)

        th = threading.Thread(target=run_server)
        th.start()
        return th

    th = line_then_hold({'ok': True, 'allapot': 'elfogadva'}, 2)
    started = time.monotonic()
    real_out, sys.stdout = sys.stdout, io.StringIO()
    try:
        code = kl.main(['hosti-kliens', 'vegrehajt', 'deadbeef', '1559919876543210987'], path=srvpath)
    finally:
        sys.stdout = real_out
    check('a server that sends the line and holds the connection open does not hold the client', [0, True], [code, time.monotonic() - started < 1.0])
    th.join(10)
    real_timeout = kl.TIMEOUT
    kl.TIMEOUT = 0.5
    th = line_then_hold(None, 1.5)
    real_out, sys.stdout = sys.stdout, io.StringIO()
    try:
        code = kl.main(['hosti-kliens', 'allapot'], path=srvpath)
    finally:
        sys.stdout = real_out
        kl.TIMEOUT = real_timeout
    check('no line at all before the timeout is unreachable (14)', 14, code)
    th.join(10)
finally:
    import shutil
    shutil.rmtree(T, ignore_errors=True)

print()
print('%d failed' % fails)
sys.exit(1 if fails else 0)
