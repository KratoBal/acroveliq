#!/usr/bin/env python3
"""B45 regression check: can an agent write (or replace) a file that drives ANOTHER agent?

Metadata only: lstat, listdir and the POSIX ACL xattrs. No file is opened, nothing is
written, so it is safe to run as any fleet user (agent or marveen) at any time.

For every agent OS user (agent-*) it computes, from mode bits + ACL + group membership,
whether that user can write each entry of every OTHER agent's tree (and of the router's
own control files). A writable directory counts too: it allows rename/replace of anything
inside it (directory swap).

Exit codes: 0 = no finding and no blind spot, 1 = finding, 2 = no finding but blind spots
(something could not be listed, so "zero" is not proof).

Usage:
  python3 -B b45-jogellenorzo.py [--root /home/marveen/marveen] [--max-examples 5]
                                 [--dropzone PATH ...] [--json OUT] [--osszegzes OUT]

--osszegzes writes counts, the failed positive probes and the blind list only. --json carries
every finding, which before the B45 fix was five million rows: the daily run
(b45-jogellenorzo-napi.py) must not fill the disk on the very day it has something to say.
"""
import argparse, grp, json, os, pwd, stat, struct, sys

ACL_USER_OBJ, ACL_USER, ACL_GROUP_OBJ, ACL_GROUP, ACL_MASK, ACL_OTHER = 1, 2, 4, 8, 0x10, 0x20
R, W, X = 4, 2, 1


def read_acl(path):
    try:
        raw = os.getxattr(path, 'system.posix_acl_access', follow_symlinks=False)
    except OSError:
        return None
    out = []
    for off in range(4, len(raw), 8):
        out.append(struct.unpack('<HHI', raw[off:off + 8]))
    return out


class FakeStat:
    def __init__(self, mode, uid, gid):
        self.st_mode, self.st_uid, self.st_gid = mode, uid, gid


def _unquote(s):
    out, i, b = bytearray(), 0, s.encode()
    while i < len(b):
        if b[i] == 0x5c and i + 3 < len(b) + 0 and all(0x30 <= c <= 0x37 for c in b[i + 1:i + 4]):
            out.append(int(b[i + 1:i + 4], 8)); i += 4
        else:
            out.append(b[i]); i += 1
    return out.decode('utf-8', 'surrogateescape')


def load_overlay(fname):
    """getfacl text -> {path: (perm_and_flag_bits, uid, gid, acl-or-None)} (access ACL only)."""
    tags = {'user': (ACL_USER_OBJ, ACL_USER), 'group': (ACL_GROUP_OBJ, ACL_GROUP)}
    pv = lambda s: (4 if s[0] == 'r' else 0) | (2 if s[1] == 'w' else 0) | (1 if s[2] == 'x' else 0)
    intern, out, cur = {}, {}, None

    def flush():
        if cur is None:
            return
        path, uid, gid, flags, ents = cur
        get = lambda t: next((p for tg, p, _ in ents if tg == t), 0)
        named = any(tg in (ACL_USER, ACL_GROUP) for tg, _, _ in ents)
        g = get(ACL_MASK) if named else get(ACL_GROUP_OBJ)
        mode = flags | get(ACL_USER_OBJ) << 6 | g << 3 | get(ACL_OTHER)
        acl = tuple(sorted(ents)) if named else None
        out[path] = (mode, uid, gid, intern.setdefault(acl, acl))
    with open(fname) as fh:
        for line in fh:
            line = line.rstrip('\n')
            if line.startswith('# file: '):
                flush(); cur = [_unquote(line[8:]), 0, 0, 0, []]
            elif line.startswith('# owner: '):
                n = line[9:]; cur[1] = int(n) if n.isdigit() else pwd.getpwnam(n).pw_uid
            elif line.startswith('# group: '):
                n = line[9:]; cur[2] = int(n) if n.isdigit() else grp.getgrnam(n).gr_gid
            elif line.startswith('# flags: '):
                f = line[9:]
                cur[3] = (stat.S_ISUID if f[0] == 's' else 0) | (stat.S_ISGID if f[1] == 's' else 0) | \
                         (stat.S_ISVTX if f[2] == 't' else 0)
            elif line and not line.startswith('default:') and not line.startswith('#'):
                tag, q, p = line.split(':')
                if tag == 'mask':
                    cur[4].append((ACL_MASK, pv(p), 0))
                elif tag == 'other':
                    cur[4].append((ACL_OTHER, pv(p), 0))
                elif not q:
                    cur[4].append((tags[tag][0], pv(p), 0))
                else:
                    i = int(q) if q.isdigit() else (pwd.getpwnam(q).pw_uid if tag == 'user' else grp.getgrnam(q).gr_gid)
                    cur[4].append((tags[tag][1], pv(p), i))
        flush()
    return out


class Principal:
    def __init__(self, name):
        pw = pwd.getpwnam(name)
        self.name, self.uid = name, pw.pw_uid
        self.gids = {pw.pw_gid} | {g.gr_gid for g in grp.getgrall() if name in g.gr_mem}


def allowed(st, acl, who, want):
    """POSIX.1e access check (root and capabilities ignored)."""
    mode = st.st_mode
    if who.uid == st.st_uid:
        return (mode >> 6) & want == want
    if acl is None:
        if st.st_gid in who.gids:
            return (mode >> 3) & want == want
        return mode & want == want
    mask = 7
    for tag, perm, _ in acl:
        if tag == ACL_MASK:
            mask = perm
    for tag, perm, qid in acl:
        if tag == ACL_USER and qid == who.uid:
            return perm & mask & want == want
    matched, grant = False, False
    for tag, perm, qid in acl:
        if (tag == ACL_GROUP_OBJ and st.st_gid in who.gids) or (tag == ACL_GROUP and qid in who.gids):
            matched = True
            if perm & mask & want == want:
                grant = True
    if matched:
        return grant
    for tag, perm, _ in acl:
        if tag == ACL_OTHER:
            return perm & want == want
    return False


class Checker:
    def __init__(self, args):
        self.args = args
        self.root = args.root
        self.cache = {}
        self.blind = []
        self.findings = []      # (category, attacker, victim, path, why)
        self.positive = []      # (who, path, want, ok)
        self.overlay = load_overlay(args.feltetelezett) if args.feltetelezett else {}

    def meta(self, path):
        if path not in self.cache:
            try:
                st = os.lstat(path)
                acl = read_acl(path)
                if path in self.overlay:
                    mode, uid, gid, acl = self.overlay[path]
                    st = FakeStat(stat.S_IFMT(st.st_mode) | mode, uid, gid)
                self.cache[path] = (st, acl)
            except OSError as e:
                self.cache[path] = (None, e.strerror)
        return self.cache[path]

    def reachable(self, path, who):
        d = os.path.dirname(path)
        while d and d != '/':
            st, acl = self.meta(d)
            if st is None or not allowed(st, acl, who, X):
                return False
            d = os.path.dirname(d)
        return True

    def can(self, path, who, want):
        st, acl = self.meta(path)
        if st is None or stat.S_ISLNK(st.st_mode):
            return False
        return self.reachable(path, who) and allowed(st, acl, who, want)

    def walk(self, top, depth=None):
        """Yield every entry under top (top included), symlinks not followed."""
        st, _ = self.meta(top)
        if st is None:
            return
        yield top
        if not stat.S_ISDIR(st.st_mode):
            return
        stack = [(top, 0)]
        while stack:
            d, lvl = stack.pop()
            if depth is not None and lvl >= depth:
                continue
            try:
                names = os.listdir(d)
            except OSError as e:
                self.blind.append((d, e.strerror))
                continue
            for n in names:
                p = os.path.join(d, n)
                yield p
                s, _ = self.meta(p)
                if s is not None and stat.S_ISDIR(s.st_mode):
                    stack.append((p, lvl + 1))

    def in_dropzone(self, path):
        return any(path == z or path.startswith(z.rstrip('/') + '/') for z in self.args.dropzone)

    def scan_tree(self, victim, top, attackers, category, depth=None, follow_links=True):
        for p in self.walk(top, depth):
            if self.in_dropzone(p):
                continue
            st, _ = self.meta(p)
            if st is None:
                continue
            if stat.S_ISLNK(st.st_mode):
                if follow_links:
                    self.check_link(victim, p, attackers, category)
                continue
            sticky_dir = stat.S_ISDIR(st.st_mode) and st.st_mode & stat.S_ISVTX
            for a in attackers:
                if sticky_dir:
                    break
                if category.startswith('router') and st.st_uid == a.uid:
                    continue    # the agent's own entry in a shared dir (e.g. its session-env dir)
                if self.can(p, a, W | (X if stat.S_ISDIR(st.st_mode) else 0)):
                    why = 'konyvtar irhato (csere/atnevezes)' if stat.S_ISDIR(st.st_mode) else 'fajl irhato'
                    self.findings.append((category, a.name, victim, p, why))

    def check_link(self, victim, link, attackers, category):
        try:
            target = os.path.realpath(link)
        except OSError:
            return
        own = os.path.join(self.root, 'agents', victim) if victim != 'acrobot' else None
        if own and (target == own or target.startswith(own + '/')):
            return
        st, _ = self.meta(target)
        if st is None or (stat.S_ISDIR(st.st_mode) and st.st_mode & stat.S_ISVTX):
            return          # a shared sticky dir: creating is intended, swapping is not possible
        for a in attackers:
            w = W | (X if stat.S_ISDIR(st.st_mode) else 0)
            if self.can(target, a, w):
                self.findings.append((category + '/symlink-cel', a.name, victim, f'{link} -> {target}',
                                      'a symlink celja irhato'))

    def ancestors(self, victim, path, attackers):
        d = os.path.dirname(path)
        while d and d != '/':
            st, acl = self.meta(d)
            if st is not None:
                for a in attackers:
                    if allowed(st, acl, a, W | X) and not (st.st_mode & stat.S_ISVTX):
                        self.findings.append(('os-konyvtar', a.name, victim, d, 'szulo irhato, sticky nelkul'))
            d = os.path.dirname(d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='/home/marveen/marveen')
    ap.add_argument('--max-examples', type=int, default=5)
    ap.add_argument('--dropzone', action='append', default=[],
                    help='path where cross-agent writes are intended (not a finding)')
    ap.add_argument('--backup', action='append', default=[],
                    help='file or dir that no agent may read (default: the B47 list)')
    ap.add_argument('--json')
    ap.add_argument('--osszegzes', help='compact JSON: counts, failed positive probes, blind list')
    ap.add_argument('--feltetelezett', help='what-if: getfacl-format target state (b45-acl.py cel)')
    args = ap.parse_args()
    root = args.root
    if not args.backup:
        args.backup = [os.path.join(root, p) for p in (
            'exchange/commerce-stage-2026-08-29.dump',
            'store/torles-mentes',
            'store/backup-work',
            'store/backup-proba-hibajegyek-2026-09-28.jsonl')]
    c = Checker(args)
    agent_users = sorted(p.pw_name for p in pwd.getpwall() if p.pw_name.startswith('agent-'))
    principals = {n: Principal(n) for n in agent_users}
    router = Principal('marveen')
    victims = sorted(n for n in os.listdir(os.path.join(root, 'agents'))
                     if os.path.isdir(os.path.join(root, 'agents', n)))

    # 1. every agent tree, every OTHER agent as attacker
    for v in victims:
        attackers = [p for n, p in principals.items() if n != 'agent-' + v]
        top = os.path.join(root, 'agents', v)
        c.ancestors(v, top, attackers)
        c.scan_tree(v, top, attackers, 'agens-mappa')
        home = '/home/agent-' + v
        if os.path.isdir(home):
            c.scan_tree(v, home, attackers, 'agens-home', depth=6, follow_links=False)

    # 2. the router's own control files: no agent may write them
    everyone = list(principals.values())
    for rel, depth in (('CLAUDE.md', 0), ('.claude', None), ('scripts', None), ('templates', None),
                       ('dist', None), ('store', 0)):
        c.scan_tree('acrobot', os.path.join(root, rel), everyone, 'router', depth)
    c.ancestors('acrobot', os.path.join(root, 'CLAUDE.md'), everyone)
    for rel in ('settings.json', 'hooks', 'skills', 'agents', 'session-env', 'shell-snapshots',
                'file-history', 'plugins'):
        c.scan_tree('acrobot', os.path.join('/home/marveen/.claude', rel), everyone, 'router-claude', depth=1)

    # 3. positive checks: the owner and the router keep their write paths
    for v in victims:
        own = principals.get('agent-' + v)
        base = os.path.join(root, 'agents', v)
        if own:
            for rel in ('', 'CLAUDE.md', 'skills', '.claude-config',
                        '.claude-config/projects'):
                p = os.path.join(base, rel) if rel else base
                if os.path.lexists(p):
                    c.positive.append((own.name, p, 'w', c.can(p, own, W)))
        for rel in ('', '.claude', '.claude/settings.json', '.claude-config',
                    '.claude-config/settings.json', 'agent-config.json', 'CLAUDE.md'):
            p = os.path.join(base, rel) if rel else base
            if os.path.lexists(p):
                c.positive.append(('marveen', p, 'w', c.can(p, router, W)))

    for a in everyone:
        se = '/home/marveen/.claude/session-env'
        if os.path.isdir(se):
            c.positive.append((a.name, se, 'w', c.can(se, a, W | X)))

    # 4. backups: no agent may read them
    for b in args.backup:
        for p in c.walk(b):
            st, _ = c.meta(p)
            if st is None or not stat.S_ISREG(st.st_mode):
                continue
            for a in everyone:
                if c.can(p, a, R):
                    c.findings.append(('mentes-olvashato', a.name, '-', p, 'olvashato'))
            if st.st_uid != 0:
                c.positive.append(('marveen', p, 'r', c.can(p, router, R)))

    pos_fail = [x for x in c.positive if not x[3]]
    by = {}
    for f in c.findings:
        by.setdefault((f[0], f[1], f[2]), []).append(f)
    print(f'B45 jogellenorzo: futtato={pwd.getpwuid(os.getuid()).pw_name} '
          f'agensek={len(principals)} aldozat-fak={len(victims)}')
    print(f'LELET osszesen: {len(c.findings)}  (kategoria/tamado/aldozat parok: {len(by)})')
    for (cat, att, vic), items in sorted(by.items()):
        print(f'  {cat:22s} {att:16s} -> {vic:10s} {len(items):6d}')
        for f in items[:args.max_examples]:
            print(f'      {f[4]}: {f[3]}')
    print(f'POZITIV probak: {len(c.positive)}, bukott: {len(pos_fail)}')
    for who, p, want, ok in pos_fail:
        print(f'  NEM IRHATO, pedig kell: {who} -> {p}')
    print(f'VAKFOLT (nem listazhato konyvtar): {len(c.blind)}')
    for d, e in c.blind[:args.max_examples]:
        print(f'  {e}: {d}')
    if args.json:
        with open(args.json, 'w') as fh:
            json.dump({'findings': c.findings, 'positive': c.positive, 'blind': c.blind}, fh)
    if args.osszegzes:
        with open(args.osszegzes, 'w') as fh:
            json.dump({'findings': len(c.findings),
                       'pairs': [[cat, att, vic, len(items)] for (cat, att, vic), items in sorted(by.items())],
                       'positive': len(c.positive), 'positive_failed': pos_fail,
                       'blind': c.blind}, fh)
    if c.findings or pos_fail:
        sys.exit(1)
    sys.exit(2 if c.blind else 0)


if __name__ == '__main__':
    main()
