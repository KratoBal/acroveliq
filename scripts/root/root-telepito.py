#!/usr/bin/python3 -I
"""root-telepito: installs a root-owned file of the fleet container on the owner's Discord approval, run as root.

The no-command-line plan, point B (exchange/acroveliq/parancssor-nelkul-terv-2026-10-19.md, "B részletesen",
barracuda 6-9; Balázs approved B with sudoers as a target, Eldöntendő msg 1561673315997843528). Until now every
update of a root file in the container (a broker, a sudo rule) was a root shell command on the owner's side.

THE INSTALLED COPY RUNS, NOT THIS FILE: /usr/local/sbin/root-telepito, root:root 0755, put there by
fleet-bootstrap.sh step 4d from a PINNED hash (the installer is not its own target: a new version of it comes
with a new pin, which is the owner's step). It reads nothing from the repository at run time.

THE FLOW
  1. kerj <kulcs> <commit40> <kero>
       the caller (SUDO_UID, on config.json `callers`) asks for one list entry at one commit. Root fetches the
       file from GitHub AT THAT COMMIT (the repository is public: no token), into its own staging directory,
       and hashes THE COPY (copy-then-hash). The commit must be on main, and the file at main's head must be
       byte-for-byte the same (an older main commit cannot bring back an old version: that is `kerj-vissza`).
       A sudoers entry is parsed into rules (a strict subset of the grammar) and checked with visudo -c.
       Prints the R: its id, the canonical line, the expiry.
  2. the caller puts the canonical line up as a #33 approval (scripts/root-telepito.sh does it).
  3. the owner answers on Discord, as a reply: "igen <code>".
  4. vegrehajt <R> <discord-message-id>
       root reads the request message and the replies FROM DISCORD ITSELF, with its own read-only bot token
       (the dashboard runs as marveen, so an "approved" row in its database proves nothing; the message
       author does, because Discord sets it). The whole message must be exactly what #33 makes of this R.
       Then: the R is spent (once), the current target goes to the durable store, the new file is installed.
  5. kerj-vissza <kulcs> <version> <kero>, then vegrehajt: the same, with a version from the store.

  allapot      read only: per entry, the installed hash, the approved current one, the stored versions
  helyreallit  re-installs every entry's last APPROVED version where the target differs (after a container
               recreate the image resets /usr/local/sbin and /etc); asks nothing new, installs nothing that was
               not approved. fleet-bootstrap.sh calls it.

WHAT IS ROOT'S, NOT THE CALLER'S
  /etc/root-telepito/conf/   the owner's host directory, mounted READ-ONLY: config.json, lista.json, the
                             Discord read token. A new target path comes only with a change there, which is not
                             a verb of this program.
  /var/lib/root-telepito/    root 0700, a host mount (durable): requests, staging, the version store. Without
                             the mount nothing is installed: an install that a recreate silently reverts would
                             say "done" and not be.

WHAT THIS DOES NOT DO, said aloud
  - It does not judge the file: an approved file is installed. The owner approves the canonical line; for a
    sudoers entry that line carries the parsed rules, not a PR number.
  - It trusts GitHub for the bytes at a commit and Discord for the author of a message.
  - A target the bootstrap pins (fleet-pane and others) is handed over by listing it here; fleet-bootstrap.sh
    then skips its own pin for that path (docs/root-telepito.md).

Exit codes: 0 done; 2 usage; 10 refused (nothing changed); 11 no approval yet; 12 rejected or expired;
13 GitHub, Discord or the file system failed; 14 installed, but the whole sudoers check failed and the
previous version was put back.
"""
import datetime
import fcntl
import grp
import hashlib
import json
import os
import pwd
import re
import secrets
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zoneinfo

# fixed places, one line each: tests replace them in a copy
CONF_DIR = '/etc/root-telepito/conf'
CONFIG_FILE = CONF_DIR + '/config.json'
LIST_FILE = CONF_DIR + '/lista.json'
DISCORD_TOKEN_FILE = CONF_DIR + '/discord-olvaso'
STORE = '/var/lib/root-telepito'
LOG_FILE = STORE + '/naplo.jsonl'  # in the durable store: the audit survives a recreate
SELF = '/usr/local/sbin/root-telepito'
SELF_SUDOERS = '/etc/sudoers.d/root-telepito'
VISUDO = '/usr/sbin/visudo'
SUDOERS_D = '/etc/sudoers.d'
SUDOERS_OWNER = ('root', 'root')
GITHUB_API = 'https://api.github.com'
DISCORD_API = 'https://discord.com/api/v10'
REQUIRE_DURABLE_STORE = True
ROOT_UID = 0
# the ancestor check starts here; '/' checks every directory from the root down
TRUST_FROM = '/'

CATEGORY = 'root_telepites'
CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
CODE_LENGTH = 4
DESCRIPTION_MAX = 500
MAX_FILE_BYTES = 1_000_000
R_RX = re.compile(r'^[0-9a-f]{8}$')
KEY_RX = re.compile(r'^[a-z0-9][a-z0-9-]{0,40}$')
SHA_RX = re.compile(r'^[0-9a-f]{40}$')
AGENT_RX = re.compile(r'^[a-z0-9][a-z0-9_-]{0,31}$')
USER_RX = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')
SNOWFLAKE_RX = re.compile(r'^[0-9]{15,22}$')
VERSION_RX = re.compile(r'^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$')
SOURCE_RX = re.compile(r'^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$')
MODES = {'0755', '0750', '0700', '0644', '0640', '0600', '0440', '0400'}
KINDS = ('fajl', 'sudoers')
# never a target, whatever the list says: the installer itself, its sudo rule, its own state, and the
# files that define who is root (a list mistake must not reach them)
NEVER_TARGETS = (SELF, SELF_SUDOERS, '/etc/sudoers', '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow')
NEVER_UNDER = ('/etc/root-telepito', STORE)
# A SUDO RULE MAY NAME ONLY A COMMAND IN THIS DIRECTORY (barracuda, #242 review B): the fleet's own,
# root-owned brokers live here, put there by this installer or by the bootstrap. A list of forbidden names
# cannot close: tee, cp, dd, find -exec, sed w, git, docker, systemctl and dozens more hand out root as
# surely as a shell. So the rule is an allow-list by place; the names below are only a second guard.
SUDOERS_COMMAND_DIR = '/usr/local/sbin'
# a sudo rule that hands out one of these hands out root: refused, not shown (the second guard)
ESCALATING_COMMANDS = {'sh', 'bash', 'dash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish', 'su', 'sudo', 'env', 'python',
                       'python3', 'perl', 'ruby', 'node', 'lua', 'php', 'vi', 'vim', 'nano', 'less', 'more',
                       'visudo', 'sudoedit', 'root-telepito'}
SUDOERS_RULE_RX = re.compile(
    r'^(?P<user>[a-z_][a-z0-9_-]{0,31}) ALL=\((?P<runas>[a-z_][a-z0-9_-]{0,31})\) NOPASSWD: '
    r'(?P<cmd>/[A-Za-z0-9._/-]+)(?P<args>( [A-Za-z0-9._/@:+*-]+)*| "")$')
USAGE = ('usage: root-telepito kerj <kulcs> <commit40> <kero>\n'
         '       root-telepito kerj-vissza <kulcs> <verzio> <kero>\n'
         '       root-telepito vegrehajt <R> <discord-uzenet-id>\n'
         '       root-telepito allapot\n'
         '       root-telepito helyreallit')


class Refused(Exception):
    pass


class Failed(Exception):
    pass


class NotYet(Exception):
    pass


class Rejected(Exception):
    pass


# ---------------------------------------------------------------- root files and paths

def root_file(path, secret=False):
    """A root-owned regular file, not a symlink, not writable by group or others; a secret also not readable."""
    try:
        st = os.lstat(path)
    except OSError:
        raise Refused(f'hianyzik: {path}')
    if not stat.S_ISREG(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & (0o077 if secret else 0o022):
        raise Refused(f'nem root-tulajdonu, csak root altal irhato sima fajl: {path}')
    return st


def safe_ancestors(path):
    """Every directory above `path` is a real directory, root's, and not writable by group or others: otherwise
    someone could swap a component for a symlink between the check and the write."""
    base = TRUST_FROM.rstrip('/')
    if not path.startswith(base + '/'):
        raise Refused(f'a cel nincs a megbizhato fa alatt: {path}')
    current = base
    for part in path[len(base) + 1:].split('/')[:-1]:
        current += '/' + part
        try:
            st = os.lstat(current)
        except OSError:
            raise Refused(f'a cel konyvtara hianyzik: {current}')
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & 0o022:
            raise Refused(f'a cel utjan nem root-tulajdonu vagy masnak irhato konyvtar: {current}')


def read_target(path):
    """The installed bytes, or None if there is no file. A symlink or a non-regular file is refused."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(st.st_mode):
        raise Refused(f'a cel nem sima fajl: {path}')
    with open(path, 'rb') as f:
        return f.read(MAX_FILE_BYTES + 1)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def store_dir(*parts):
    path = os.path.join(STORE, *parts)
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def write_private(path, data):
    fd = os.open(path + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(path + '.tmp', path)


def log(event):
    event = dict(event, at=int(time.time()))
    fd = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a', encoding='utf-8') as f:
        f.write(json.dumps(event, ensure_ascii=False) + '\n')


# ---------------------------------------------------------------- config and the fixed list

def load_config():
    root_file(CONFIG_FILE)
    try:
        cfg = json.load(open(CONFIG_FILE, encoding='utf-8'))
        repo = cfg['repo']
        d = cfg['discord']
        out = {
            'repo': repo,
            'callers': list(cfg['callers']),
            'windowMinutes': int(cfg.get('windowMinutes', 60)),
            'channelId': d['channelId'], 'requestBotUserId': d['requestBotUserId'],
            'deciderUserIds': list(d['deciderUserIds']), 'yes': d.get('yes', 'igen'), 'no': d.get('no', 'nem'),
        }
    except (OSError, ValueError, KeyError, TypeError):
        raise Refused(f'olvashatatlan beallitas: {CONFIG_FILE}')
    if not re.match(r'^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$', out['repo']):
        raise Refused('a beallitas repo mezoje hibas')
    if not all(isinstance(u, str) and USER_RX.match(u) for u in out['callers']):
        raise Refused('a beallitas callers mezoje hibas')
    ids = [out['channelId'], out['requestBotUserId'], *out['deciderUserIds']]
    if not out['deciderUserIds'] or not all(isinstance(i, str) and SNOWFLAKE_RX.match(i) for i in ids):
        raise Refused('a beallitas discord azonositoi hibasak')
    if not 5 <= out['windowMinutes'] <= 24 * 60:
        raise Refused('a beallitas windowMinutes erteke 5 es 1440 kozott legyen')
    if not re.match(r'^[a-z]{2,10}$', out['yes']) or not re.match(r'^[a-z]{2,10}$', out['no']) or out['yes'] == out['no']:
        raise Refused('a beallitas igen/nem szava hibas')
    return out


def check_entry(e):
    """One list entry, or Refused naming the key. Every field is checked here, not at use."""
    if not isinstance(e, dict) or set(e) != {'kulcs', 'forras', 'cel', 'tulaj', 'csoport', 'mod', 'fajta'}:
        raise Refused('a lista egy eleme nem a hét mezot hordozza (kulcs forras cel tulaj csoport mod fajta)')
    key = e['kulcs']
    if not isinstance(key, str) or not KEY_RX.match(key):
        raise Refused(f'hibas kulcs a listan: {key!r}')
    src, dst = e['forras'], e['cel']
    if not isinstance(src, str) or not SOURCE_RX.match(src) or any(p in ('.', '..') for p in src.split('/')):
        raise Refused(f'{key}: hibas forras ut')
    if not isinstance(dst, str) or not dst.startswith('/') or os.path.normpath(dst) != dst or not SOURCE_RX.match(dst[1:]):
        raise Refused(f'{key}: a cel abszolut, normalizalt ut legyen')
    if re.search(r'[`>#*_~|]', src + dst):
        # #33 turns these into spaces in the line the owner reads: such a path could never be shown as it is
        raise Refused(f'{key}: a forras vagy a cel olyan karaktert tartalmaz, amit a jovahagyas szovege nem mutatna meg')
    if dst in NEVER_TARGETS or any(dst == d or dst.startswith(d + '/') for d in NEVER_UNDER):
        raise Refused(f'{key}: a cel ({dst}) soha nem lehet a telepito celja (onmaga, a sajat allapota vagy a root-ot meghatarozo fajlok)')
    if e['mod'] not in MODES:
        raise Refused(f'{key}: nem engedett mod {e["mod"]!r}')
    if e['fajta'] not in KINDS:
        raise Refused(f'{key}: ismeretlen fajta {e["fajta"]!r}')
    try:
        pwd.getpwnam(e['tulaj'])
        grp.getgrnam(e['csoport'])
    except (KeyError, TypeError):
        raise Refused(f'{key}: ismeretlen tulajdonos vagy csoport')
    in_sudoers_d = dst.startswith(SUDOERS_D + '/') or dst.startswith('/etc/sudoers.d/')
    if e['fajta'] == 'sudoers':
        if not re.match(r'^[a-z0-9-]+$', os.path.basename(dst)) or os.path.dirname(dst) != SUDOERS_D:
            raise Refused(f'{key}: sudoers cel csak /etc/sudoers.d/<pont nelkuli nev> lehet')
        if (e['tulaj'], e['csoport'], e['mod']) != (*SUDOERS_OWNER, '0440'):
            raise Refused(f'{key}: sudoers cel root:root 0440 legyen')
    elif in_sudoers_d:
        raise Refused(f'{key}: /etc/sudoers.d ala csak sudoers fajta mehet (ertelmezett szabalyokkal)')
    return e


def load_list():
    root_file(LIST_FILE)
    try:
        entries = json.load(open(LIST_FILE, encoding='utf-8'))['celok']
    except (OSError, ValueError, KeyError, TypeError):
        raise Refused(f'olvashatatlan lista: {LIST_FILE}')
    if not isinstance(entries, list):
        raise Refused('a lista celok mezoje nem tomb')
    out = {}
    targets = set()
    for e in entries:
        check_entry(e)
        if e['kulcs'] in out or e['cel'] in targets:
            raise Refused(f'ketszer szereplo kulcs vagy cel a listan: {e["kulcs"]}')
        out[e['kulcs']] = e
        targets.add(e['cel'])
    return out


def caller(cfg):
    """The sudo caller's user name, which must be on `callers`. An argument never names the caller."""
    uid = os.environ.get('SUDO_UID')
    if os.geteuid() != ROOT_UID:
        raise Refused('rootkent kell futnia (sudo)')
    if uid is None:
        return 'root'
    try:
        name = pwd.getpwuid(int(uid)).pw_name
    except (KeyError, ValueError):
        raise Refused('ismeretlen hivo')
    if name not in cfg['callers']:
        raise Refused(f'{name} nincs a hivok kozott')
    return name


# ---------------------------------------------------------------- sudoers: the parsed rules the owner sees

def parse_sudoers(text):
    """The rules of a sudoers file, from a strict subset of the grammar: one `user ALL=(runas) NOPASSWD: /cmd
    [args]` per line, comments and blank lines. Anything else (aliases, Defaults, includes, several commands on
    a line, negation, continuation) is refused, so what the owner reads IS the whole meaning of the file."""
    rules = []
    for n, line in enumerate(text.split('\n'), 1):
        s = line.strip()
        if not s:
            continue
        if s.startswith('#'):
            if re.match(r'^#\s*include', s):
                raise Refused(f'sudoers {n}. sor: include iranyelv nem lehet benne')
            continue
        if s.startswith('@'):
            raise Refused(f'sudoers {n}. sor: @ iranyelv nem lehet benne')
        if line != s or '  ' in s:
            raise Refused(f'sudoers {n}. sor: a szabaly egy szokozzel tagolt, behuzas nelkuli sor legyen')
        m = SUDOERS_RULE_RX.match(s)
        if not m:
            raise Refused(f'sudoers {n}. sor: nem az ertelmezheto alak (felhasznalo ALL=(kinek) NOPASSWD: /parancs [argumentumok])')
        user, runas, cmd = m['user'], m['runas'], m['cmd']
        # sudo reads a command with no arguments as ANY arguments, and "" as none (barracuda, #242 review A):
        # the rule keeps which of the two it is, so the line the owner reads can say it
        args = m['args'].split()
        if args == ['""']:
            args = None
        for who in (user, runas):
            try:
                pwd.getpwnam(who)
            except KeyError:
                raise Refused(f'sudoers {n}. sor: nincs ilyen felhasznalo: {who}')
        if os.path.normpath(cmd) != cmd or os.path.dirname(cmd) != SUDOERS_COMMAND_DIR:
            raise Refused(f'sudoers {n}. sor: a parancs ({cmd}) nem a {SUDOERS_COMMAND_DIR} alatt all; sudo-szabaly '
                          'csak a flotta sajat, root-tulajdonu kozvetitoire szolhat')
        if os.path.basename(cmd) in ESCALATING_COMMANDS or cmd.startswith(SELF):
            raise Refused(f'sudoers {n}. sor: a parancs ({cmd}) root-ot adna, nem telepitheto')
        if os.path.normpath(cmd) != cmd:
            raise Refused(f'sudoers {n}. sor: a parancs utja nem normalizalt')
        # the command must be root's: a rule for a file somebody else can write is root for that somebody
        root_file(cmd)
        safe_ancestors(cmd)
        rules.append({'user': user, 'runas': runas, 'cmd': cmd, 'args': args})
    if not rules:
        raise Refused('a sudoers fajlban nincs szabaly')
    return rules


def rule_text(rule):
    # words, not an arrow: #33 blanks out '>' in the line the owner reads
    head = f"{rule['user']} futtathatja {rule['runas']} jogon, jelszo nelkul: {rule['cmd']}"
    if rule['args'] is None:
        return head + ' (argumentum nelkul)'
    if not rule['args']:
        # what sudo does with a bare command, said in the line: it is not "exactly this command"
        return head + ' [barmilyen argumentummal]'
    return head + ' ' + ' '.join('[barmi]' if a == '*' else a for a in rule['args'])


def visudo_check(path):
    r = subprocess.run([VISUDO, '-c', '-q', '-f', path], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    return r.returncode == 0


def visudo_check_all():
    r = subprocess.run([VISUDO, '-c', '-q'], capture_output=True, text=True, stdin=subprocess.DEVNULL)
    return r.returncode == 0


# ---------------------------------------------------------------- GitHub (public repository, no token)

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib carries the Authorization header across a redirect, to whatever host it points (barracuda, #241
    review). The Discord bot token must never leave discord.com, so no redirect is followed at all."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http_get(url, headers, limit=MAX_FILE_BYTES):
    req = urllib.request.Request(url, headers=dict(headers, **{'User-Agent': 'root-telepito'}))
    try:
        with _OPENER.open(req, timeout=30) as r:
            body = r.read(limit + 1)
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise Failed(f'atiranyitas (HTTP {e.code}), nem kovetem: {url}')
        if e.code == 404:
            raise Refused(f'nincs ilyen: {url}')
        raise Failed(f'HTTP {e.code}: {url}')
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise Failed(f'halozati hiba ({e.__class__.__name__}): {url}')
    if len(body) > limit:
        raise Refused(f'tul nagy valasz: {url}')
    return body


def github_json(cfg, path):
    body = http_get(f"{GITHUB_API}/repos/{cfg['repo']}/{path}",
                    {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        return json.loads(body.decode('utf-8'))
    except ValueError:
        raise Failed('a GitHub valasza nem JSON')


def github_raw(cfg, source, ref):
    return http_get(f"{GITHUB_API}/repos/{cfg['repo']}/contents/{urllib.parse.quote(source)}?ref={ref}",
                    {'Accept': 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28'})


def source_at_commit(cfg, entry, commit):
    """The file's bytes at `commit`, only if the commit is on main and main's head has the same bytes."""
    cmp = github_json(cfg, f'compare/{commit}...main')
    if cmp.get('behind_by') != 0 or cmp.get('status') not in ('ahead', 'identical'):
        raise Refused(f'a {commit[:12]} commit nincs a main agon')
    data = github_raw(cfg, entry['forras'], commit)
    head = github_raw(cfg, entry['forras'], 'main')
    if data != head:
        raise Refused(f"{entry['forras']}: a main mai fejen mas a tartalma, mint a {commit[:12]} commitban "
                      '(regi valtozat csak kerj-vissza-val, a tarbol)')
    return data


# ---------------------------------------------------------------- the #33 text, letter for letter

def neutral_description(text):
    """approval-discord-core.ts neutralDescription, in Python (tied by the shared fixture)."""
    flat = re.sub(r'\s+', ' ', re.sub(r'[`>#*_~|]', ' ', text)).strip()
    cut = flat[:DESCRIPTION_MAX] + '...' if len(flat) > DESCRIPTION_MAX else flat
    return '> ' + cut


def format_expiry(timeout_at):
    """approval-discord-core.ts formatApprovalExpiry (hu-HU, Europe/Budapest): month and day two digits, the
    hour not padded. Tied to Node's rendering by the shared fixture."""
    d = datetime.datetime.fromtimestamp(timeout_at, zoneinfo.ZoneInfo('Europe/Budapest'))
    return f'{d.year}. {d.month:02d}. {d.day:02d}. {d.hour}:{d.minute:02d}:{d.second:02d}'


def approval_text(agent_id, category, description, timeout_at, code, yes, no):
    """approval-discord-core.ts buildDiscordApprovalText with requireReply, in Python."""
    return '\n'.join([
        f'**JÓVÁHAGYÁS KELL, kód: {code}**',
        f'Erre az üzenetre válaszolva: `{yes} {code}` vagy `{no} {code}` (csak ez a két alak dönt). '
        f'Lejárat: {format_expiry(timeout_at)}',
        f"Kérő: {agent_id} | {re.sub(r'[^A-Za-z0-9_.-]', '', category)}",
        neutral_description(description),
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
    """The executor's verifyDiscordApproval (src/deploy-executor/verify-approval.ts), for one R. Returns the
    deciding message id, or raises Refused / NotYet / Rejected."""
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
    now = now_ms // 1000
    if shown <= now:
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
        raise Refused(f'hibas Discord-token: {DISCORD_TOKEN_FILE}')
    headers = {'Authorization': f'Bot {token}'}
    base = f"{DISCORD_API}/channels/{cfg['channelId']}/messages"
    try:
        request = json.loads(http_get(f'{base}/{message_id}', headers).decode('utf-8'))
        later, after = [], message_id
        for _ in range(5):
            page = json.loads(http_get(f'{base}?after={after}&limit=100', headers).decode('utf-8'))
            later.extend(page)
            if len(page) < 100:
                break
            after = max(page, key=lambda x: int(x['id']))['id']
    except ValueError:
        raise Failed('a Discord valasza nem JSON')
    return request, later


# ---------------------------------------------------------------- requests (R) and the version store

def load_r(rid):
    if not R_RX.match(rid):
        raise Refused('hibas R azonosito')
    path = os.path.join(STORE, 'keresek', rid + '.json')
    try:
        return json.loads(open(path, encoding='utf-8').read())
    except (OSError, ValueError):
        raise Refused(f'nincs ilyen R: {rid}')


def save_r(r):
    write_private(os.path.join(STORE, 'keresek', r['id'] + '.json'), json.dumps(r, ensure_ascii=False).encode('utf-8'))


def versions(key):
    d = os.path.join(STORE, 'tar', key)
    try:
        return sorted(n for n in os.listdir(d) if VERSION_RX.match(n))
    except FileNotFoundError:
        return []


def store_version(key, data):
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    name = f'{stamp}-{sha256(data)[:16]}'
    write_private(os.path.join(store_dir('tar', key), name), data)
    return name


def current_of(key):
    try:
        return json.loads(open(os.path.join(STORE, 'tar', key, 'aktualis.json'), encoding='utf-8').read())
    except (OSError, ValueError):
        return None


def require_durable_store():
    if REQUIRE_DURABLE_STORE and not os.path.ismount(STORE):
        raise Refused(f'{STORE} nem host-mount: egy telepites a kovetkezo kontener-ujrateremteskor csendben '
                      'visszaallna, ezert nem telepitek')
    st = os.lstat(STORE)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != ROOT_UID or st.st_mode & 0o077:
        raise Refused(f'{STORE} nem root 0700 konyvtar')


def canonical(r):
    head = f"ROOT-TELEPITO R={r['id']} / "
    if r['mode'] == 'telepit':
        body = (f"{r['kulcs']} / {r['cel']} / commit {r['commit'][:12]} / sha256 {r['sha'][:16]} / "
                + (f"CSERE, most {r['prev'][:16]}" if r['prev'] else 'ELSO TELEPITES'))
    else:
        body = (f"VISSZAALLITAS / {r['kulcs']} / {r['cel']} / {r['verzio']} / sha256 {r['sha'][:16]} / "
                + (f"most {r['prev'][:16]}" if r['prev'] else 'most nincs fajl'))
    if r.get('rules'):
        body += ' / SZABALYOK: ' + '; '.join(rule_text(x) for x in r['rules'])
    line = head + body
    if neutral_description(line) != "> " + line:
        raise Refused('a jovahagyasi sor nem irhato ki valtozatlanul (#33 semlegesitese vagy hossza): '
                      'jeloles- vagy alahuzas-karakter van a celban vagy a szabalyban, vagy tul hosszu')
    return line


def prepare(cfg, entry, data, mode, kero, extra):
    if len(data) > MAX_FILE_BYTES:
        raise Refused('a fajl tul nagy')
    safe_ancestors(entry['cel'])
    current = read_target(entry['cel'])
    prev = sha256(current) if current is not None else ''
    if prev == sha256(data):
        raise Refused('a cel mar pontosan ez a valtozat: nincs mit telepiteni')
    rid = secrets.token_hex(4)
    staged = os.path.join(store_dir('staging'), rid)
    write_private(staged, data)
    try:
        # copy-then-hash: what is hashed, parsed and later installed is root's copy, read back
        data = open(staged, 'rb').read()
        rules = None
        if entry['fajta'] == 'sudoers':
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                raise Refused('a sudoers fajl nem UTF-8')
            rules = parse_sudoers(text)
            os.chmod(staged, 0o440)  # visudo also judges the mode of the file it checks
            if not visudo_check(staged):
                raise Refused('a visudo -c elutasitotta a sudoers fajlt')
        now = int(time.time())
        r = dict(extra, id=rid, mode=mode, kulcs=entry['kulcs'], cel=entry['cel'], entry=entry, sha=sha256(data),
                 prev=prev, staged=staged, rules=rules, kero=kero, createdAt=now,
                 expiresAt=now + cfg['windowMinutes'] * 60, status='nyitott')
        r['canonicalLine'] = canonical(r)
    except BaseException:
        os.unlink(staged)
        raise
    store_dir('keresek')
    save_r(r)
    log({'event': 'kerj', 'r': rid, 'kulcs': entry['kulcs'], 'mode': mode, 'sha': r['sha'], 'by': kero})
    return r


# ---------------------------------------------------------------- the install itself

def install_bytes(entry, data):
    """Writes `data` to the target atomically with the list's owner and mode. For sudoers the new file is
    checked alone before the rename and the whole configuration after it."""
    dst = entry['cel']
    safe_ancestors(dst)
    d, base = os.path.dirname(dst), os.path.basename(dst)
    tmp = os.path.join(d, f'.{base}.root-telepito')  # a dot: sudo's includedir ignores it
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chown(tmp, pwd.getpwnam(entry['tulaj']).pw_uid, grp.getgrnam(entry['csoport']).gr_gid)
        os.chmod(tmp, int(entry['mod'], 8))
        if entry['fajta'] == 'sudoers' and not visudo_check(tmp):
            raise Refused('a visudo -c elutasitotta a telepitendo sudoers fajlt')
        os.replace(tmp, dst)
    finally:
        if os.path.lexists(tmp):
            os.unlink(tmp)


def apply(r, data):
    entry = r['entry']
    before = read_target(entry['cel'])
    if before is not None:
        store_version(entry['kulcs'], before)
    install_bytes(entry, data)
    if entry['fajta'] == 'sudoers' and not visudo_check_all():
        # put the previous state back: a broken sudo configuration is a locked fleet
        if before is None:
            os.unlink(entry['cel'])
        else:
            install_bytes(entry, before)
        raise Failed('a teljes sudoers-ellenorzes elbukott; az elozo allapot visszaallitva')
    name = store_version(entry['kulcs'], data)
    write_private(os.path.join(STORE, 'tar', entry['kulcs'], 'aktualis.json'),
                  json.dumps({'verzio': name, 'sha': sha256(data), 'r': r['id'], 'at': int(time.time())}).encode())


def locked():
    fd = os.open(os.path.join(STORE, '.lock'), os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


# ---------------------------------------------------------------- verbs

def cmd_kerj(args):
    if len(args) != 3:
        raise Refused(USAGE)
    key, commit, kero = args
    if not KEY_RX.match(key) or not SHA_RX.match(commit) or not AGENT_RX.match(kero):
        raise Refused(USAGE)
    cfg = load_config()
    who = caller(cfg)
    require_durable_store()
    entries = load_list()
    if key not in entries:
        raise Refused(f'nincs ilyen kulcs a listan: {key}')
    entry = entries[key]
    data = source_at_commit(cfg, entry, commit)
    r = prepare(cfg, entry, data, 'telepit', kero, {'commit': commit, 'caller': who})
    return {'r': r['id'], 'canonicalLine': r['canonicalLine'], 'expiresAt': r['expiresAt'], 'category': CATEGORY}


def cmd_kerj_vissza(args):
    if len(args) != 3:
        raise Refused(USAGE)
    key, version, kero = args
    if not KEY_RX.match(key) or not VERSION_RX.match(version) or not AGENT_RX.match(kero):
        raise Refused(USAGE)
    cfg = load_config()
    who = caller(cfg)
    require_durable_store()
    entries = load_list()
    if key not in entries:
        raise Refused(f'nincs ilyen kulcs a listan: {key}')
    if version not in versions(key):
        raise Refused(f'nincs ilyen valtozat a tarban: {key} {version}')
    data = open(os.path.join(STORE, 'tar', key, version), 'rb').read()
    if sha256(data)[:16] != version[-16:]:
        raise Refused('a tarolt valtozat lenyomata nem egyezik a nevevel')
    r = prepare(cfg, entries[key], data, 'visszaallit', kero, {'verzio': version, 'caller': who})
    return {'r': r['id'], 'canonicalLine': r['canonicalLine'], 'expiresAt': r['expiresAt'], 'category': CATEGORY}


def cmd_vegrehajt(args, now_ms=None):
    if len(args) != 2 or not R_RX.match(args[0]) or not SNOWFLAKE_RX.match(args[1]):
        raise Refused(USAGE)
    rid, message_id = args
    cfg = load_config()
    who = caller(cfg)
    require_durable_store()
    fd = locked()
    try:
        r = load_r(rid)
        if r['status'] != 'nyitott':
            raise Refused(f'az R mar nem nyitott ({r["status"]}): egy jovahagyas egyszer fut')
        now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        if now_ms >= r['expiresAt'] * 1000:
            raise Rejected('az R lejart')
        entries = load_list()
        if entries.get(r['kulcs']) != r['entry']:
            raise Refused('a lista eleme megvaltozott az R ota')
        data = open(r['staged'], 'rb').read()
        if sha256(data) != r['sha']:
            raise Refused('a tarolt masolat lenyomata elter az R-etol')
        # the target's path checked BEFORE the R is spent: a directory that became writable since the request
        # refuses here, with the approval still usable once it is fixed
        safe_ancestors(r['cel'])
        current = read_target(r['cel'])
        if (sha256(current) if current is not None else '') != r['prev']:
            raise Refused('a cel azota megvaltozott; uj kerest kell inditani')
        request, later = discord_messages(cfg, message_id)
        decision = verify_approval(r, request, later, cfg, now_ms)
        r['status'] = 'elhasznalt'
        r['decision'] = decision
        r['usedBy'] = who
        save_r(r)
        log({'event': 'vegrehajt', 'r': rid, 'kulcs': r['kulcs'], 'decision': decision, 'by': who})
        try:
            apply(r, data)
        except Failed as e:
            r['status'] = 'visszaallitva'
            save_r(r)
            log({'event': 'visszaallitva', 'r': rid, 'reason': str(e)})
            raise
        except Refused as e:
            # the R is spent (the safe direction), and the log must say that nothing was installed with it
            # (barracuda, #242 review note)
            r['status'] = 'elhasznalt, nem telepult'
            save_r(r)
            log({'event': 'nem-telepult', 'r': rid, 'reason': str(e)})
            raise
        r['status'] = 'telepitve'
        save_r(r)
        log({'event': 'telepitve', 'r': rid, 'kulcs': r['kulcs'], 'sha': r['sha']})
        return {'r': rid, 'status': 'telepitve', 'cel': r['cel'], 'sha': r['sha']}
    finally:
        os.close(fd)


def cmd_allapot(args):
    if args:
        raise Refused(USAGE)
    cfg = load_config()
    caller(cfg)
    out = []
    for key, e in load_list().items():
        current = read_target(e['cel'])
        approved = current_of(key)
        out.append({'kulcs': key, 'cel': e['cel'], 'fajta': e['fajta'],
                    'telepitett': sha256(current) if current is not None else None,
                    'jovahagyott': approved['sha'] if approved else None,
                    'valtozatok': versions(key)})
    return {'celok': out}


def cmd_helyreallit(args):
    """Re-installs each entry's last approved version where the target differs. Nothing new: only what an
    approval already installed, verified against the hash recorded at that install."""
    if args:
        raise Refused(USAGE)
    cfg = load_config()
    caller(cfg)
    require_durable_store()
    fd = locked()
    done = []
    try:
        for key, e in load_list().items():
            approved = current_of(key)
            if not approved:
                continue
            path = os.path.join(STORE, 'tar', key, approved['verzio'])
            data = open(path, 'rb').read()
            if sha256(data) != approved['sha']:
                raise Refused(f'{key}: a tarolt jovahagyott valtozat lenyomata elter')
            current = read_target(e['cel'])
            if current is not None and sha256(current) == approved['sha']:
                continue
            install_bytes(e, data)
            if e['fajta'] == 'sudoers' and not visudo_check_all():
                os.unlink(e['cel'])
                raise Failed(f'{key}: a helyreallitott sudoers a teljes ellenorzesen elbukott; eltavolitva')
            log({'event': 'helyreallit', 'kulcs': key, 'sha': approved['sha']})
            done.append(key)
    finally:
        os.close(fd)
    return {'helyreallitva': done}


VERBS = {'kerj': cmd_kerj, 'kerj-vissza': cmd_kerj_vissza, 'vegrehajt': cmd_vegrehajt, 'allapot': cmd_allapot,
         'helyreallit': cmd_helyreallit}


def main(argv):
    if not argv or argv[0] not in VERBS:
        print(USAGE, file=sys.stderr)
        return 2
    try:
        print(json.dumps(VERBS[argv[0]](argv[1:]), ensure_ascii=False))
        return 0
    except Refused as e:
        print(f'ELUTASITVA: {e}', file=sys.stderr)
        return 2 if str(e) == USAGE else 10
    except NotYet as e:
        print(f'MEG NINCS: {e}', file=sys.stderr)
        return 11
    except Rejected as e:
        print(f'NEM: {e}', file=sys.stderr)
        return 12
    except Failed as e:
        print(f'HIBA: {e}', file=sys.stderr)
        return 14 if 'visszaallitva' in str(e) or 'eltavolitva' in str(e) else 13


if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(main(sys.argv[1:]))
