#!/usr/bin/python3 -I
"""hosti-vegrehajto: a root program on the HOST that runs a closed list of docker steps on the owner's Discord approval.

The no-command-line plan, point C (exchange/acroveliq/parancssor-nelkul-terv-2026-10-19.md; Balázs approved C,
Eldöntendő 2026-10-19 09:33:17 UTC, message 1561673586391916645). The design sheet and barracuda's APPROVE (v2) are
exchange/.../parancssor-c-hosti-vegrehajto-terv-2026-10-19.md; docs/hosti-vegrehajto.md is the operating sheet.

WHAT IT IS. A systemd socket-activated unit (hosti-vegrehajto.socket / hosti-vegrehajto@.service, root): one process
per connection, no daemon, no network port, no docker.sock in any container. The fleet reaches it only through the B8
gate's three ops (hosti-kerj, hosti-vegrehajt, hosti-allapot), which run as the `fleet` user. The decision is by UID, not
group: SO_PEERCRED must name the `fleet` uid from the settings.

THE VERBS (a closed list; a project and a verb must also be on the root-owned project list):
  telepit <projekt> <commit40>  the project's clone is set to the commit, the image is built, the project is brought up
  up <projekt>                  `docker compose up -d` with the image that is there
  visszaallit <projekt>         the previous image (`elozo`) becomes the live one, `up -d`
  allapot [R]                   read only
Read verbs (image inspect, logs) and the proxy are separate slices. It NEVER runs prune, rmi, image rm, run, exec, cp,
rm, a volume or a system command, and it does not edit a compose file.

THE FLOW
  1. kerj <projekt> <ige> <commit|-> <kero>   measured, then an R and its canonical line (a #33 approval, category
     hosti_vegrehajt; the line is at most 500 characters)
  2. the owner answers on Discord: "igen <code>"
  3. vegrehajt <R> <discord-message-id>   root reads the request message and the replies FROM DISCORD ITSELF with its own
     read-only bot token; the whole message must be exactly what #33 makes of this R. Every MEASUREMENT comes before the R
     is spent (a refusal leaves it open), every CHANGE after. The reply `elfogadva` goes back at once, the connection is
     closed, and the work runs on regardless of it (a closed socket is not a reason to stop half way).

LOCKS, always in this order: the project's lock (non-blocking: a busy project answers `foglalt` and the R stays open),
then the R lock for the open -> used change. Two vegrehajt on one R cannot both read `open`.

THE CONFIG HASH. The project list pins the sha256 of the RESOLVED compose configuration (`docker compose config`, a clean
environment): the .env, env_file, include and extends are inside it, so a value can not change under an unchanged compose
file. The output is hashed, never printed or logged (it may carry secrets). `lenyomat <projekt>` (root, not on the socket)
prints the current hash for the owner to put in the list.

THE ENVIRONMENT of every external call is built here: a fixed PATH, HOME and DOCKER_CONFIG inside the state directory,
LANG=C. No COMPOSE_* or DOCKER_* variable, and nothing from the gate's environment, passes.
"""
import datetime
import fcntl
import hashlib
import json
import os
import re
import signal
import socket
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo

STATE = '/var/lib/hosti-vegrehajto'
CONFIG_FILE = '/etc/hosti-vegrehajto/config.json'
DISCORD_TOKEN_FILE = '/etc/hosti-vegrehajto/discord-olvaso'
ROOT_UID = 0
DOCKER = '/usr/bin/docker'
GIT = '/usr/bin/git'
GITHUB_API = 'https://api.github.com'
DISCORD_API = 'https://discord.com/api/v10'
ENV_PATH = '/usr/sbin:/usr/bin:/sbin:/bin'

CATEGORY = 'hosti_vegrehajt'
CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
CODE_LENGTH = 4
DESCRIPTION_MAX = 500
MAX_REQUEST_BYTES = 4096
VERBS = ('telepit', 'up', 'visszaallit')
R_RX = re.compile(r'^[0-9a-f]{8}$')
SHA_RX = re.compile(r'^[0-9a-f]{40}$')
SHA256_RX = re.compile(r'^[0-9a-f]{64}$')
NAME_RX = re.compile(r'^[a-z][a-z0-9-]{0,30}$')
SERVICE_RX = re.compile(r'^[a-z][a-z0-9-]{0,40}$')
AGENT_RX = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
REPO_RX = re.compile(r'^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$')
BRANCH_RX = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$')
IMAGE_RX = re.compile(r'^[a-z0-9][a-z0-9._/-]{0,100}:[A-Za-z0-9][A-Za-z0-9._-]{0,60}$')
SNOWFLAKE_RX = re.compile(r'^[0-9]{15,22}$')
ABS_RX = re.compile(r'^/[A-Za-z0-9._/-]+$')
# never a project, whatever the list says: the fleet's own container tree (the fleet may write it), this program's own
# state and settings, the gate, and the host executor's own clone
NEVER_UNDER = ('/opt/marveen-docker', '/var/lib/hosti-vegrehajto', '/etc/hosti-vegrehajto', '/usr/local/sbin',
               '/usr/local/lib/fleet-gate', '/opt/hosti-vegrehajto')
NEVER_NAMES = ('marveen', 'marveen-docker', 'hosti-vegrehajto', 'fleet-gate')
STEP_TIMEOUT = {'build': 3000, 'up': 600}


class Refused(Exception):
    """A refusal with a fixed text; nothing was changed, and the R (if there is one) is still open."""


class Failed(Exception):
    pass


class NotYet(Exception):
    pass


class Rejected(Exception):
    pass


class Busy(Refused):
    pass


# ---------------------------------------------------------------- files, config, the project list

def root_file(path, secret=False):
    """A root-owned regular file, not a symlink, not writable by group or others; a secret also not readable."""
    try:
        st = os.lstat(path)
    except OSError:
        raise Refused(f'hianyzik: {path}')
    if not stat.S_ISREG(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & (0o077 if secret else 0o022):
        raise Refused(f'nem root-tulajdonu, csak root altal irhato sima fajl: {path}')
    return st


def write_private(path, data):
    fd = os.open(path + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path + '.tmp', path)
    dfd = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def state_dir(*parts):
    path = os.path.join(STATE, *parts)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def log(event):
    """The audit trail: append-only, root 0600; ids, shas, steps and exit codes, never an output or a value."""
    event = dict(event, at=int(time.time()))
    state_dir()
    fd = os.open(os.path.join(STATE, 'audit.log'), os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a', encoding='utf-8') as f:
        f.write(json.dumps(event, ensure_ascii=False) + '\n')


def _strict(obj, keys, path):
    if not isinstance(obj, dict):
        raise Refused(f'{path}: objektum kell')
    for k in obj:
        if k not in keys:
            raise Refused(f'{path}.{k}: ismeretlen kulcs')
    for k in keys:
        if k not in obj:
            raise Refused(f'{path}.{k}: hianyzik')
    return obj


def _text(v, path, rx):
    if not isinstance(v, str) or not rx.match(v):
        raise Refused(f'{path}: hibas alak')
    return v


def load_config():
    root_file(CONFIG_FILE)
    try:
        raw = json.load(open(CONFIG_FILE, encoding='utf-8'))
    except (OSError, ValueError):
        raise Refused(f'olvashatatlan beallitas: {CONFIG_FILE}')
    top = _strict(raw, ('fleetUid', 'requesters', 'discord', 'projectsFile'), 'config')
    d = _strict(top['discord'], ('channelId', 'requestBotUserId', 'deciderUserIds', 'yes', 'no'), 'config.discord')
    uid = top['fleetUid']
    if not isinstance(uid, int) or isinstance(uid, bool) or uid < 1 or uid > 4_000_000_000:
        raise Refused('config.fleetUid: ervenyes, nem root uid kell')
    requesters = top['requesters']
    if not isinstance(requesters, list) or not requesters:
        raise Refused('config.requesters: nem ures lista kell')
    for i, a in enumerate(requesters):
        _text(a, f'config.requesters[{i}]', AGENT_RX)
    deciders = d['deciderUserIds']
    if not isinstance(deciders, list) or not deciders:
        raise Refused('config.discord.deciderUserIds: nem ures lista kell')
    for i, u in enumerate(deciders):
        _text(u, f'config.discord.deciderUserIds[{i}]', SNOWFLAKE_RX)
    _text(d['channelId'], 'config.discord.channelId', SNOWFLAKE_RX)
    _text(d['requestBotUserId'], 'config.discord.requestBotUserId', SNOWFLAKE_RX)
    if d['requestBotUserId'] in deciders:
        raise Refused('config.discord.deciderUserIds: nem lehet benne a keres-bot')
    for k in ('yes', 'no'):
        _text(d[k], f'config.discord.{k}', re.compile(r'^[a-záéíóöőúüű]{1,16}$'))
    if d['yes'] == d['no']:
        raise Refused('config.discord.no: kulonbozzon a yes-tol')
    if not isinstance(top['projectsFile'], str) or not ABS_RX.match(top['projectsFile']) or '..' in top['projectsFile'].split('/'):
        raise Refused('config.projectsFile: abszolut ut kell, .. nelkul')
    return {'fleetUid': uid, 'requesters': list(requesters), 'channelId': d['channelId'],
            'requestBotUserId': d['requestBotUserId'], 'deciderUserIds': list(deciders), 'yes': d['yes'],
            'no': d['no'], 'projectsFile': top['projectsFile']}


def _abs(v, path):
    if not isinstance(v, str) or not ABS_RX.match(v) or '..' in v.split('/'):
        raise Refused(f'{path}: abszolut ut kell, .. nelkul')
    for bad in NEVER_UNDER:
        if v == bad or v.startswith(bad + '/'):
            raise Refused(f'{path}: ez az ut soha nem projekt ({bad})')
    return v


def load_projects(cfg):
    """The root-owned project list, parsed strictly: an unknown key, a missing field or a value out of range refuses."""
    root_file(cfg['projectsFile'])
    try:
        raw = json.load(open(cfg['projectsFile'], encoding='utf-8'))
    except (OSError, ValueError):
        raise Refused(f"olvashatatlan projektlista: {cfg['projectsFile']}")
    if not isinstance(raw, list) or not raw:
        raise Refused('projektlista: nem ures lista kell')
    keys = ('nev', 'dir', 'composeFajl', 'konfigSha256', 'composeProjekt', 'szolgaltatasok', 'repo', 'ag', 'src', 'kep',
            'igek', 'jovahagyasPerc')
    out, seen = {}, set()
    for i, e in enumerate(raw):
        p = f'projektek[{i}]'
        e = _strict(e, keys, p)
        name = _text(e['nev'], f'{p}.nev', NAME_RX)
        if name in NEVER_NAMES:
            raise Refused(f'{p}.nev: ez a nev soha nem projekt')
        if name in seen:
            raise Refused(f'{p}.nev: ketszer szerepel')
        seen.add(name)
        compose = _abs(e['composeFajl'], f'{p}.composeFajl')
        directory = _abs(e['dir'], f'{p}.dir')
        if not compose.startswith(directory + '/'):
            raise Refused(f'{p}.composeFajl: a projekt konyvtaraban kell lennie')
        services = e['szolgaltatasok']
        if not isinstance(services, list) or not services:
            raise Refused(f'{p}.szolgaltatasok: nem ures lista kell')
        for j, s in enumerate(services):
            _text(s, f'{p}.szolgaltatasok[{j}]', SERVICE_RX)
        verbs = e['igek']
        if not isinstance(verbs, list) or not verbs or any(v not in VERBS for v in verbs):
            raise Refused(f'{p}.igek: a zart listabol kell valasztani ({", ".join(VERBS)})')
        minutes = e['jovahagyasPerc']
        if not isinstance(minutes, int) or isinstance(minutes, bool) or not 1 <= minutes <= 30:
            raise Refused(f'{p}.jovahagyasPerc: egesz szam 1..30')
        out[name] = {'nev': name, 'dir': directory, 'composeFajl': compose,
                     'konfigSha256': _text(e['konfigSha256'], f'{p}.konfigSha256', SHA256_RX),
                     'composeProjekt': _text(e['composeProjekt'], f'{p}.composeProjekt', NAME_RX),
                     'szolgaltatasok': list(services), 'repo': _text(e['repo'], f'{p}.repo', REPO_RX),
                     'ag': _text(e['ag'], f'{p}.ag', BRANCH_RX), 'src': _abs(e['src'], f'{p}.src'),
                     'kep': _text(e['kep'], f'{p}.kep', IMAGE_RX), 'igek': list(verbs), 'jovahagyasPerc': minutes}
    return out


# ---------------------------------------------------------------- the outside: processes, HTTP

def clean_env():
    """What every external call gets: nothing from the caller, and nothing the gate's environment holds."""
    home = os.path.join(STATE, 'home')
    return {'PATH': ENV_PATH, 'HOME': home, 'LANG': 'C', 'DOCKER_CONFIG': os.path.join(STATE, 'docker-config'),
            'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_OPTIONAL_LOCKS': '0', 'GIT_PAGER': 'cat', 'PAGER': 'cat'}


class SubprocessRunner:
    """Runs one command as an argument list, no shell, a clean environment; returns (exit code, stdout, stderr)."""

    def run(self, argv, cwd=None, timeout=120):
        for d in ('home', 'docker-config'):
            state_dir(d)
        try:
            p = subprocess.run(argv, cwd=cwd, env=clean_env(), stdin=subprocess.DEVNULL, capture_output=True,
                               timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            return 124, b'', b'timeout'
        except OSError:
            return 127, b'', b'did not run'
        return p.returncode, p.stdout, p.stderr


RUNNER = SubprocessRunner()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib carries the Authorization header across a redirect (barracuda, #241). The Discord bot token must
    never leave discord.com, so no redirect is followed at all."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http_get(url, headers, limit=1_000_000):
    req = urllib.request.Request(url, headers=dict(headers, **{'User-Agent': 'hosti-vegrehajto'}))
    try:
        with _OPENER.open(req, timeout=30) as r:
            body = r.read(limit + 1)
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise Failed(f'atiranyitas (HTTP {e.code}), nem kovetem')
        if e.code == 404:
            raise Refused('nincs ilyen (HTTP 404)')
        raise Failed(f'HTTP {e.code}')
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise Failed(f'halozati hiba ({e.__class__.__name__})')
    if len(body) > limit:
        raise Refused('tul nagy valasz')
    return body


HTTP = http_get


def commit_on_main(project, commit):
    """GitHub's compare: the commit is an ancestor of (or is) the branch head."""
    body = HTTP(f"{GITHUB_API}/repos/{project['repo']}/compare/{commit}...{project['ag']}",
                {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        cmp = json.loads(body.decode('utf-8'))
    except ValueError:
        raise Failed('a GitHub valasza nem JSON')
    if cmp.get('behind_by') != 0 or cmp.get('status') not in ('ahead', 'identical'):
        raise Refused(f"a {commit[:12]} commit nincs a {project['ag']} agon")


# ---------------------------------------------------------------- the docker and git commands (argument lists only)

def compose_argv(project, *rest):
    return [DOCKER, 'compose', '-p', project['composeProjekt'], '-f', project['composeFajl'], *rest]


def git_argv(project, *rest):
    """The clone is root's, but a hook path or a filter could come from its config: the same protection as
    scripts/git-olvas.sh (no hooks, no fsmonitor, no external diff, no pager, no signature programs)."""
    return [GIT, '--no-pager', '-C', project['src'], '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
            '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'gpg.program=/bin/false', '-c', 'submodule.recurse=false',
            '-c', 'protocol.ext.allow=never', *rest]


def run_ok(argv, cwd=None, timeout=120):
    rc, out, _ = RUNNER.run(argv, cwd=cwd, timeout=timeout)
    return rc, out


def config_hash(project):
    """The sha256 of the RESOLVED compose configuration; the output itself is neither kept nor shown."""
    rc, out, _ = RUNNER.run(compose_argv(project, 'config'), cwd=project['dir'], timeout=120)
    if rc != 0 or not out:
        raise Refused('a compose konfig nem oldhato fel')
    return hashlib.sha256(out).hexdigest()


def image_id(ref):
    """The full image id of a reference, or None."""
    rc, out, _ = RUNNER.run([DOCKER, 'image', 'inspect', '--format', '{{.Id}}', ref], timeout=60)
    text = out.decode('utf-8', 'replace').strip()
    if rc != 0 or not re.match(r'^sha256:[0-9a-f]{64}$', text):
        return None
    return text


def short(full):
    return full.split(':', 1)[1][:12] if full else 'nincs'


def previous_ref(project):
    return project['kep'].rsplit(':', 1)[0] + ':elozo'


# ---------------------------------------------------------------- locks

class Locked:
    """flock on a file under STATE/locks; non-blocking ones refuse with Busy."""

    def __init__(self, name, blocking):
        self.path = os.path.join(state_dir('locks'), name)
        self.blocking = blocking
        self.fd = None

    def __enter__(self):
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | (0 if self.blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            os.close(self.fd)
            self.fd = None
            raise Busy('foglalt: ezen a projekten mar fut egy muvelet')
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


# ---------------------------------------------------------------- the #33 text (tied to the shared fixture)

def description_max(category):
    """approval-discord-core.ts descriptionMaxFor: the category as the message prints it (this one has no extra room)."""
    return DESCRIPTION_MAX


def neutral_description(text, limit=DESCRIPTION_MAX):
    flat = re.sub(r'\s+', ' ', re.sub(r'[`>#*_~|]', ' ', text)).strip()
    cut = flat[:limit] + '...' if len(flat) > limit else flat
    return '> ' + cut


def format_expiry(timeout_at):
    d = datetime.datetime.fromtimestamp(timeout_at, zoneinfo.ZoneInfo('Europe/Budapest'))
    return f'{d.year}. {d.month:02d}. {d.day:02d}. {d.hour}:{d.minute:02d}:{d.second:02d}'


def approval_text(agent_id, category, description, timeout_at, code, yes, no):
    return '\n'.join([
        f'**JÓVÁHAGYÁS KELL, kód: {code}**',
        f'Erre az üzenetre válaszolva: `{yes} {code}` vagy `{no} {code}` (csak ez a két alak dönt). '
        f'Lejárat: {format_expiry(timeout_at)}',
        f"Kérő: {agent_id} | {re.sub(r'[^A-Za-z0-9_.-]', '', category)}",
        neutral_description(description, description_max(category)),
    ])


def parse_decision(text, yes, no):
    parts = text.strip().split()
    if len(parts) != 2:
        return None
    word, code = parts[0].lower(), parts[1].upper()
    if len(code) != CODE_LENGTH or any(c not in CODE_ALPHABET for c in code):
        return None
    if word == yes:
        return ('approved', code)
    if word == no:
        return ('rejected', code)
    return None


def snowflake_ms(snowflake):
    return (int(snowflake) >> 22) + 1420070400000


def find_displayed_expiry(text, from_sec, to_sec):
    m = re.search(r':(\d{2})$', text)
    if not m or int(m.group(1)) > 59:
        return None
    s = int(m.group(1))
    t = to_sec - ((to_sec - s) % 60)
    while t >= from_sec:
        if format_expiry(t) == text:
            return t
        t -= 60
    return None


def verify_approval(r, request, later, cfg, now_ms):
    """The deploy executor's verifyDiscordApproval, for one R. Returns the deciding message id, or raises
    Refused / NotYet / Rejected."""
    if request.get('channel_id') not in (None, cfg['channelId']):
        raise Refused('a keres uzenete mas csatornaban van')
    if (request.get('author') or {}).get('id') != cfg['requestBotUserId']:
        raise Refused('a keres uzenetet nem a keres-bot irta')
    if request.get('edited_timestamp'):
        raise Refused('a keres uzenetet szerkesztettek')
    posted = snowflake_ms(request['id'])
    if posted <= r['createdAt'] * 1000:
        raise Refused('a keres uzenete regebbi, mint az R')
    if posted >= r['expiresAt'] * 1000:
        raise Refused('a keres uzenete az R lejarata utan jott')
    lines = (request.get('content') or '').split('\n')
    if len(lines) != 4:
        raise Refused('a keres uzenete nem pontosan negy sor')
    m = re.match(r'^\*\*JÓVÁHAGYÁS KELL, kód: ([A-Z0-9]{4})\*\*$', lines[0])
    if not m or not parse_decision(f"{cfg['yes']} {m.group(1)}", cfg['yes'], cfg['no']):
        raise Refused('a keres uzeneteben nincs ervenyes kod')
    code = m.group(1)
    tail = re.search(r' Lejárat: (.+)$', lines[1])
    shown = find_displayed_expiry(tail.group(1), r['createdAt'], r['expiresAt']) if tail else None
    if shown is None:
        raise Refused('a keres lejarata nincs az R ablakan belul')
    expected = approval_text(r['kero'], CATEGORY, r['canonicalLine'], shown, code, cfg['yes'], cfg['no'])
    if request['content'] != expected:
        raise Refused('a keres uzenetenek szovege elter attol, amit ebbol az R-bol a #33 kiirna')
    replies = [x for x in later if (x.get('message_reference') or {}).get('message_id') == request['id']
               and (x.get('author') or {}).get('id') in cfg['deciderUserIds']]
    if any(x.get('edited_timestamp') for x in replies):
        raise Refused('egy dontesi valaszt szerkesztettek')
    if shown <= now_ms // 1000:
        raise Rejected('a keres lejart')
    for x in sorted(later, key=lambda x: int(x['id'])):
        author = x.get('author') or {}
        if author.get('bot') or author.get('id') not in cfg['deciderUserIds']:
            continue
        decision = parse_decision(x.get('content') or '', cfg['yes'], cfg['no'])
        if not decision or (x.get('message_reference') or {}).get('message_id') != request['id']:
            continue
        if decision[1] != code or snowflake_ms(x['id']) <= r['createdAt'] * 1000:
            continue
        if decision[0] != 'approved':
            raise Rejected('a gazda elutasitotta')
        if snowflake_ms(x['id']) > min(shown, r['expiresAt']) * 1000:
            raise Rejected('a dontes a lejarat utan jott')
        return x['id']
    raise NotYet('meg nincs dontes')


def discord_messages(cfg, message_id):
    root_file(DISCORD_TOKEN_FILE, secret=True)
    token = open(DISCORD_TOKEN_FILE, encoding='utf-8').read().strip()
    if not token or any(c.isspace() for c in token):
        raise Refused('hibas Discord-token fajl')
    headers = {'Authorization': f'Bot {token}'}
    base = f"{DISCORD_API}/channels/{cfg['channelId']}/messages"
    try:
        request = json.loads(HTTP(f'{base}/{message_id}', headers).decode('utf-8'))
        later, after = [], message_id
        for _ in range(5):
            page = json.loads(HTTP(f'{base}?after={after}&limit=100', headers).decode('utf-8'))
            later.extend(page)
            if len(page) < 100:
                break
            after = max(page, key=lambda x: int(x['id']))['id']
    except ValueError:
        raise Failed('a Discord valasza nem JSON')
    return request, later


# ---------------------------------------------------------------- requests (R)

def r_path(rid):
    return os.path.join(state_dir('keresek'), rid + '.json')


def load_r(rid):
    if not isinstance(rid, str) or not R_RX.match(rid):
        raise Refused('hibas R azonosito')
    try:
        return json.loads(open(r_path(rid), encoding='utf-8').read())
    except (OSError, ValueError):
        raise Refused(f'nincs ilyen R: {rid}')


def save_r(r):
    write_private(r_path(r['id']), json.dumps(r, ensure_ascii=False).encode('utf-8'))


def canonical(r):
    what = {'telepit': r['commit'] or '', 'up': 'jelenlegi', 'visszaallit': 'elozo'}[r['ige']]
    line = f"HOSTI R={r['id']} / {r['projekt']} / {r['ige']} / {what} / elo {r['elo']} / elozo {r['elozo']}"
    # the line must survive #33's neutralisation unchanged, or the owner would read something else than root compares
    if neutral_description(line) != '> ' + line:
        raise Refused('a kanonikus sor nem semleges')
    return line


def new_r_id():
    while True:
        rid = os.urandom(4).hex()
        if not os.path.exists(r_path(rid)):
            return rid


def cmd_kerj(args, now=None):
    """kerj <projekt> <ige> <commit|-> <kero>: measured, then an R. Changes nothing but the R file."""
    if len(args) != 4:
        raise Refused('hasznalat: kerj <projekt> <ige> <commit|-> <kero>')
    projekt, ige, commit, kero = args
    cfg = load_config()
    projects = load_projects(cfg)
    p = projects.get(projekt)
    if p is None:
        raise Refused('a projekt nincs a listan')
    if ige not in VERBS or ige not in p['igek']:
        raise Refused('az ige nincs engedelyezve ennel a projektnel')
    if kero not in cfg['requesters']:
        raise Refused('a kero nincs a beallitas listajan')
    if ige == 'telepit':
        if not SHA_RX.match(commit):
            raise Refused('a commit 40 jegyu kisbetus sha kell')
        commit_on_main(p, commit)
    elif commit != '-':
        raise Refused('ennek az igenek nincs commitja: -')
    else:
        commit = ''
    elo, elozo = image_id(p['kep']), image_id(previous_ref(p))
    if ige == 'visszaallit' and elozo is None:
        raise Refused('nincs elozo kep, nincs mire visszaallitani')
    if ige in ('up', 'visszaallit') and elo is None:
        raise Refused('nincs elo kep')
    created = int(now if now is not None else time.time())
    rid = new_r_id()
    r = {'id': rid, 'projekt': projekt, 'ige': ige, 'commit': commit, 'elo': short(elo), 'elozo': short(elozo),
         'kero': kero, 'createdAt': created, 'expiresAt': created + p['jovahagyasPerc'] * 60, 'status': 'open',
         'outcome': None, 'lepes': []}
    r['canonicalLine'] = canonical(r)
    save_r(r)
    log({'esemeny': 'kerj', 'r': rid, 'projekt': projekt, 'ige': ige, 'commit': commit, 'elo': r['elo'], 'elozo': r['elozo']})
    return {'r': rid, 'canonicalLine': r['canonicalLine'], 'expiresAt': r['expiresAt']}


# ---------------------------------------------------------------- the work

def step(r, name, argv, cwd=None, timeout=120, expect_zero=True):
    """One docker or git step: run, record its exit code in the R, stop the sequence on a failure."""
    rc, out, _ = RUNNER.run(argv, cwd=cwd, timeout=timeout)
    r['lepes'].append({'nev': name, 'rc': rc, 'at': int(time.time())})
    save_r(r)
    log({'esemeny': 'lepes', 'r': r['id'], 'lepes': name, 'rc': rc})
    if expect_zero and rc != 0:
        raise Failed(name)
    return out


def tag(r, ref_from, ref_to, name):
    step(r, name, [DOCKER, 'tag', ref_from, ref_to])


def finish(r, outcome):
    r['outcome'] = outcome
    save_r(r)
    log({'esemeny': outcome, 'r': r['id']})
    return outcome


def postcheck(project, want_full):
    """Every service of the project runs, on the image that should be live."""
    for svc in project['szolgaltatasok']:
        rc, out, _ = RUNNER.run(compose_argv(project, 'ps', '-q', svc), cwd=project['dir'], timeout=60)
        ids = [x for x in out.decode('utf-8', 'replace').split() if re.match(r'^[0-9a-f]{12,64}$', x)]
        if rc != 0 or not ids:
            return False
        for cid in ids:
            rc, out, _ = RUNNER.run([DOCKER, 'inspect', '--format', '{{.Image}} {{.State.Running}}', cid], timeout=60)
            if rc != 0 or out.decode('utf-8', 'replace').split() != [want_full, 'true']:
                return False
    return True


def work(r, project):
    """The changes, in order. Called after the R was spent; it does not depend on any client being connected."""
    try:
        if r['ige'] == 'telepit':
            live = image_id(project['kep'])
            if live is not None:
                tag(r, live, previous_ref(project), 'elozo-cimke')
            step(r, 'build', compose_argv(project, 'build'), cwd=project['dir'], timeout=STEP_TIMEOUT['build'])
        elif r['ige'] == 'visszaallit':
            live, before = image_id(project['kep']), image_id(previous_ref(project))
            if live is None or before is None:
                raise Failed('kepek')
            tag(r, before, project['kep'], 'elozo-elo')
            tag(r, live, previous_ref(project), 'elo-elozo')
        step(r, 'up', compose_argv(project, 'up', '-d', *project['szolgaltatasok']), cwd=project['dir'], timeout=STEP_TIMEOUT['up'])
    except Failed as e:
        return finish(r, 'epites_hiba' if str(e) == 'build' else 'indulas_hiba')
    want = image_id(project['kep'])
    if want is None or not postcheck(project, want):
        return finish(r, 'utomeres_eltero')
    return finish(r, 'kesz_igazolt')


def measure_before_spending(r, project, cfg):
    """Everything that can be measured without changing anything; a refusal leaves the R open."""
    if config_hash(project) != project['konfigSha256']:
        raise Refused('a feloldott compose konfig lenyomata elter a listabelitol')
    if r['ige'] == 'telepit':
        commit_on_main(project, r['commit'])
        rc, _ = run_ok(git_argv(project, 'fetch', 'origin'), timeout=300)
        if rc != 0:
            raise Failed('git fetch')
        rc, _ = run_ok(git_argv(project, 'checkout', '--detach', r['commit']), timeout=120)
        if rc != 0:
            raise Refused('a commit nem allithato be a klonban')
        rc, head = run_ok(git_argv(project, 'rev-parse', 'HEAD'))
        if rc != 0 or head.decode('utf-8', 'replace').strip() != r['commit']:
            raise Refused('a klon HEAD-je nem a jovahagyott commit')
        rc, dirty = run_ok(git_argv(project, 'status', '--porcelain'))
        if rc != 0 or dirty.strip():
            raise Refused('a klon fája nem tiszta')
    if short(image_id(project['kep'])) != r['elo']:
        raise Refused('az elo kep megvaltozott a jovahagyas ota')
    if r['ige'] == 'visszaallit' and short(image_id(previous_ref(project))) != r['elozo']:
        raise Refused('az elozo kep megvaltozott a jovahagyas ota')


def cmd_vegrehajt(args, now_ms=None, accepted=None):
    """vegrehajt <R> <discord-message-id>. `accepted(dict)` is called as soon as the R is spent: the caller's reply
    goes back before the work, and the work runs on whatever happens to the caller."""
    if len(args) != 2 or not SNOWFLAKE_RX.match(args[1]):
        raise Refused('hasznalat: vegrehajt <R> <discord-uzenet-id>')
    cfg = load_config()
    projects = load_projects(cfg)
    r = load_r(args[0])
    project = projects.get(r['projekt'])
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    if project is None or r['ige'] not in project['igek']:
        raise Refused('a projekt vagy az ige mar nincs a listan')
    if r['status'] != 'open':
        raise Refused('az R mar felhasznalt')
    if now_ms >= r['expiresAt'] * 1000:
        raise Refused('az R lejart')
    request, later = discord_messages(cfg, args[1])
    decision = verify_approval(r, request, later, cfg, now_ms)
    with Locked(f"project-{r['projekt']}.lock", blocking=False):
        measure_before_spending(r, project, cfg)
        # the open -> used change under the R lock: two vegrehajt on one R cannot both read `open`
        with Locked('r.lock', blocking=True):
            fresh = load_r(r['id'])
            if fresh['status'] != 'open':
                raise Refused('az R mar felhasznalt')
            fresh['status'] = 'used'
            fresh['outcome'] = 'folyamatban'
            fresh['usedAt'] = now_ms // 1000
            fresh['approval'] = {'requestMessageId': args[1], 'decisionMessageId': decision}
            save_r(fresh)
        r = fresh
        log({'esemeny': 'jovahagyva', 'r': r['id'], 'projekt': r['projekt'], 'ige': r['ige'], 'request': args[1], 'dontes': decision})
        if accepted is not None:
            accepted({'r': r['id'], 'allapot': 'elfogadva'})
        outcome = work(r, project)
    return {'r': r['id'], 'outcome': outcome}


def mark_interrupted(r, projects):
    """An R still `folyamatban` whose project lock nobody holds was cut off (the unit was stopped, the machine lost power):
    its outcome becomes `megszakadt(<last step>)`. There is no process to say it, so the next look says it. The program does not
    continue by itself: a new R (up or visszaallit) is the way on."""
    if r.get('outcome') != 'folyamatban' or r['projekt'] not in projects:
        return r
    try:
        with Locked(f"project-{r['projekt']}.lock", blocking=False):
            with Locked('r.lock', blocking=True):
                fresh = load_r(r['id'])
                if fresh.get('outcome') == 'folyamatban':
                    last = fresh['lepes'][-1]['nev'] if fresh['lepes'] else 'elejen'
                    fresh['outcome'] = f'megszakadt({last})'
                    save_r(fresh)
                    log({'esemeny': 'megszakadt', 'r': fresh['id'], 'lepes': last})
                return fresh
    except Busy:
        return r


def cmd_allapot(args):
    cfg = load_config()
    projects = load_projects(cfg)
    if len(args) == 1:
        r = load_r(args[0])
        r = mark_interrupted(r, projects)
        return {'r': r['id'], 'projekt': r['projekt'], 'ige': r['ige'], 'status': r['status'], 'outcome': r['outcome'],
                'lepes': [{'nev': s['nev'], 'rc': s['rc']} for s in r['lepes']], 'canonicalLine': r['canonicalLine'],
                'expiresAt': r['expiresAt']}
    if args:
        raise Refused('hasznalat: allapot [R]')
    out = {}
    for name, p in sorted(projects.items()):
        rc, head = run_ok(git_argv(p, 'rev-parse', 'HEAD'))
        out[name] = {'head': head.decode('utf-8', 'replace').strip() if rc == 0 else None,
                     'elo': short(image_id(p['kep'])), 'elozo': short(image_id(previous_ref(p))), 'igek': p['igek']}
    return {'projektek': out}


def cmd_lenyomat(args):
    """Root only, not on the socket: prints the resolved-config hash for the owner to put in the project list."""
    if len(args) != 1:
        raise Refused('hasznalat: lenyomat <projekt>')
    if os.geteuid() != ROOT_UID:
        raise Refused('csak rootkent')
    projects = load_projects(load_config())
    if args[0] not in projects:
        raise Refused('a projekt nincs a listan')
    return {'projekt': args[0], 'konfigSha256': config_hash(projects[args[0]])}


# ---------------------------------------------------------------- the socket instance

def peer_uid(sock):
    pid, uid, gid = struct.unpack('3i', sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))
    return uid


def read_request(stream):
    line = stream.readline(MAX_REQUEST_BYTES + 1)
    if len(line) > MAX_REQUEST_BYTES:
        raise Refused('tul nagy kerés')
    try:
        req = json.loads(line.decode('utf-8'))
    except ValueError:
        raise Refused('a kerés nem JSON')
    if not isinstance(req, dict) or set(req) - {'ige', 'args'} or not isinstance(req.get('args', []), list) \
            or any(not isinstance(a, str) or len(a) > 200 for a in req.get('args', [])):
        raise Refused('a kerés alakja hibas')
    return req


SOCKET_OPS = {'kerj': cmd_kerj, 'vegrehajt': cmd_vegrehajt, 'allapot': cmd_allapot}


def writer(sock_out):
    """Writes one JSON line to the client; a closed socket (EPIPE) is no reason to stop anything."""
    def write(obj):
        try:
            sock_out.write((json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8'))
            sock_out.flush()
        except (BrokenPipeError, OSError):
            pass
    return write


def serve(stdin=None, stdout=None, uid_of_peer=None):
    """One connection (systemd passes the socket as stdin and stdout): the peer's uid, one request, the answer; for a
    vegrehajt the answer `elfogadva` goes at once and the connection is closed, and the work goes on in this process."""
    signal.signal(signal.SIGPIPE, signal.SIG_IGN)
    stdin = stdin or sys.stdin.buffer
    stdout = stdout or sys.stdout.buffer
    write = writer(stdout)
    try:
        cfg = load_config()
        uid = uid_of_peer() if uid_of_peer else peer_uid(socket.socket(fileno=os.dup(0)))
        # by UID, not by group: the socket's 0660 root:fleet only allows the open
        if uid != cfg['fleetUid']:
            log({'esemeny': 'elutasitva', 'ok': 'idegen-uid', 'uid': uid})
            write({'ok': False, 'hiba': 'idegen uid'})
            return 1
        req = read_request(stdin)
        op = req.get('ige')
        if op not in SOCKET_OPS:
            write({'ok': False, 'hiba': 'ismeretlen ige'})
            return 1
        args = req.get('args', [])
        if op == 'vegrehajt':
            def accepted(obj):
                write(dict(obj, ok=True))
                # the client may go: the work does not need it
                try:
                    stdout.close()
                except OSError:
                    pass

            result = cmd_vegrehajt(args, accepted=accepted)
            log({'esemeny': 'vege', 'r': result['r'], 'outcome': result['outcome']})
            return 0
        write(dict(SOCKET_OPS[op](args), ok=True))
        return 0
    except Busy as e:
        write({'ok': False, 'hiba': str(e), 'foglalt': True})
        return 10
    except Refused as e:
        write({'ok': False, 'hiba': str(e)})
        return 10
    except NotYet as e:
        write({'ok': False, 'hiba': str(e), 'meg_nincs_dontes': True})
        return 11
    except Rejected as e:
        write({'ok': False, 'hiba': str(e), 'elutasitva': True})
        return 12
    except Failed as e:
        write({'ok': False, 'hiba': str(e)})
        return 13


USAGE = ('usage: hosti-vegrehajto serve                     (the systemd socket instance)\n'
         '       hosti-vegrehajto lenyomat <projekt>        (root only: the resolved-config hash for the list)\n'
         '       hosti-vegrehajto kerj <projekt> <ige> <commit|-> <kero>\n'
         '       hosti-vegrehajto vegrehajt <R> <discord-uzenet-id>\n'
         '       hosti-vegrehajto allapot [R]')


def main(argv):
    if len(argv) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    cmd, args = argv[1], argv[2:]
    if cmd == 'serve':
        return serve()
    if os.geteuid() != ROOT_UID:
        print('hosti-vegrehajto: csak rootkent', file=sys.stderr)
        return 10
    ops = {'kerj': cmd_kerj, 'vegrehajt': cmd_vegrehajt, 'allapot': cmd_allapot, 'lenyomat': cmd_lenyomat}
    if cmd not in ops:
        print(USAGE, file=sys.stderr)
        return 2
    try:
        print(json.dumps(ops[cmd](args), ensure_ascii=False))
        return 0
    except Busy as e:
        print(f'hosti-vegrehajto: {e}', file=sys.stderr)
        return 10
    except Refused as e:
        print(f'hosti-vegrehajto: {e}', file=sys.stderr)
        return 10
    except NotYet as e:
        print(f'hosti-vegrehajto: {e}', file=sys.stderr)
        return 11
    except Rejected as e:
        print(f'hosti-vegrehajto: {e}', file=sys.stderr)
        return 12
    except Failed as e:
        print(f'hosti-vegrehajto: {e}', file=sys.stderr)
        return 13


if __name__ == '__main__':
    sys.exit(main(sys.argv))
