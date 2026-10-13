#!/usr/bin/env python3
"""B45: dump the current ownership/mode/ACL state, or generate the TARGET state, in the
getfacl text format that `setfacl --restore=FILE` reads back.

  mentes  the state as it is now (the rollback file)
  cel     the state after the B45 fix: same rights as today, MINUS every write that
          reaches another agent's tree through a group (fleet, the owning group) or
          `other`. What marveen (the router) and the tree owner could write through the
          group today, they keep through a NAMED user entry. Foreign-agent-owned entries
          are handed to the tree owner. The shared session-env gets the sticky bit.

Metadata only (lstat + ACL xattrs). Symlinks are never listed: setfacl follows them.
Run as root for a complete file; as anything else the unreadable directories are listed
on stderr and the exit code is 2.

Usage:
  python3 -B b45-acl.py mentes -o mentes.acl
  python3 -B b45-acl.py cel    -o cel.acl
  python3 -B b45-acl.py parse FILE      # sanity: count entries, show the first one
"""
import argparse, grp, os, pwd, stat, struct, sys

ROOT = '/home/marveen/marveen'
SESSION_ENV = '/home/marveen/.claude/session-env'
UO, U, GO, G, M, O = 1, 2, 4, 8, 0x10, 0x20
TAGNAME = {UO: 'user', U: 'user', GO: 'group', G: 'group', M: 'mask', O: 'other'}
W = 2
HARDLINK_HELD = []
# Files that only the agent (and the router) may read: no other, no named entry,
# and no group EXCEPT the agent's own private group agent-<name>-cfg (B2-6). A
# .claude.json can carry tokens in its mcpServers env, so a `fleet` group loses all
# rights; but the router writes it as marveen:agent-<name>-cfg 0660 and the agent
# reads it through that group, so taking THAT group away would lock the agent out
# of its own config (the korall case, 2026-08-19; barracuda review of #54).
PRIVATE_NAMES = {'.claude.json', '.credentials.json'}


def uname(uid):
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def gname(gid):
    try:
        return grp.getgrgid(gid).gr_name
    except KeyError:
        return str(gid)


def quote(path):
    out = []
    for b in path.encode('utf-8', 'surrogateescape'):
        if b < 0x21 and b != 0x20 or b > 0x7e or b == 0x5c:
            out.append('\\%03o' % b)
        else:
            out.append(chr(b))
    return ''.join(out)


def perm_str(p):
    return ('r' if p & 4 else '-') + ('w' if p & 2 else '-') + ('x' if p & 1 else '-')


def xattr_acl(path, name):
    try:
        raw = os.getxattr(path, name, follow_symlinks=False)
    except OSError:
        return None
    return [struct.unpack('<HHI', raw[o:o + 8]) for o in range(4, len(raw), 8)]


def minimal(mode):
    return [(UO, 0, (mode >> 6) & 7), (GO, 0, (mode >> 3) & 7), (O, 0, mode & 7)]


class Who:
    def __init__(self, name):
        pw = pwd.getpwnam(name)
        self.uid = pw.pw_uid
        self.gids = {pw.pw_gid} | {g.gr_gid for g in grp.getgrall() if name in g.gr_mem}


def eff(entries, owner_gid, who):
    """Effective perms for a NON-owner principal (entries as (tag, id, perm))."""
    mask = next((p for t, _, p in entries if t == M), 7)
    for t, i, p in entries:
        if t == U and i == who.uid:
            return p & mask
    got, matched = 0, False
    for t, i, p in entries:
        if (t == GO and owner_gid in who.gids) or (t == G and i in who.gids):
            matched, got = True, got | (p & mask)
    if matched:
        return got
    return next((p for t, _, p in entries if t == O), 0)


def tree_owner(path):
    """agent-<name> for paths inside an agent tree or home, else None."""
    a = os.path.join(ROOT, 'agents') + '/'
    if path.startswith(a):
        return 'agent-' + path[len(a):].split('/')[0]
    if path.startswith('/home/agent-'):
        return path.split('/')[2]
    return None


def transform(path, st, acc, dfl, router, owners):
    """Return (uid, gid, flags, access, default) for the target state."""
    mode = st.st_mode
    owner_name = tree_owner(path)
    in_agent_tree = path.startswith(os.path.join(ROOT, 'agents') + '/')
    uid = st.st_uid
    # A regular file with more than one link may be the SAME inode as a file in another tree
    # (a hardlink made while the trees were still fleet-writable). Handing it to this tree's
    # owner would hand over the other tree's file, so such files keep their owner and get no
    # owner entry; they are listed in HARDLINK_HELD for a manual decision.
    multi = stat.S_ISREG(mode) and st.st_nlink > 1 and uname(st.st_uid) != owner_name
    if multi and owner_name:
        HARDLINK_HELD.append(path)
    if owner_name and not multi and uname(uid).startswith('agent-') and uname(uid) != owner_name:
        uid = pwd.getpwnam(owner_name).pw_uid           # foreign agent -> tree owner
    old = acc if acc is not None else minimal(mode)
    if stat.S_ISREG(mode) and os.path.basename(path) in PRIVATE_NAMES and owner_name:
        own_group = gname(st.st_gid) == owner_name + '-cfg'
        g = ((mode >> 3) & 7) if own_group else 0
        priv = [(UO, 0, (mode >> 6) & 7), (GO, 0, g), (O, 0, 0)]
        if acc is not None:
            priv.append((M, 0, g))
        return uid, st.st_gid, mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX), priv, None
    new = []
    for t, i, p in old:
        if t in (GO, G, O):
            p &= ~W
        if t == U and uname(i).startswith('agent-') and uname(i) != owner_name:
            p &= ~W
        new.append((t, i, p))
    if in_agent_tree:
        extra = []
        if uid != router.uid:
            pr = eff(old, st.st_gid, router)
            if pr:
                extra.append((U, router.uid, pr))
        ow = owners.get(owner_name)
        if ow and uid != ow.uid and not multi:
            po = eff(old, st.st_gid, ow)
            if po:
                extra.append((U, ow.uid, po))
        new = [e for e in new if not (e[0] == U and e[1] in {x[1] for x in extra})] + extra
    if any(t in (U, G) for t, _, _ in new) and not any(t == M for t, _, _ in new):
        new.append((M, 0, (mode >> 3) & 7))             # old group bits = old mask
    flags = mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX)
    newd = None
    if stat.S_ISDIR(mode):
        if path == SESSION_ENV:
            flags |= stat.S_ISVTX
            new = [(t, i, (p | W) if t == GO else p) for t, i, p in new]  # agents create here
            newd = dfl          # no NEW default anywhere: it would override the umask (see below)
        elif dfl is not None:
            fake_mode_gid = st.st_gid
            newd = []
            for t, i, p in dfl:
                if t in (GO, G, O):
                    p &= ~W
                newd.append((t, i, p))
            if in_agent_tree:
                for who in (router, owners.get(owner_name)):
                    if who is None:
                        continue
                    pw = eff(dfl, fake_mode_gid, who)
                    if pw:
                        newd = [e for e in newd if not (e[0] == U and e[1] == who.uid)]
                        newd.append((U, who.uid, pw))
        # A directory WITHOUT a default ACL today stays without one. A default ACL makes the
        # kernel ignore the umask, so a program that relies on umask 077 and creates 0666 would
        # hand out read (barracuda review, 2026-10-13, blocker 1). New files there are governed
        # by the umask, which is why B2-5 (agent umask 022) is part of the A window.
    return uid, st.st_gid, flags, new, newd


def fmt(path, uid, gid, flags, acc, dfl):
    order = {UO: 0, U: 1, GO: 2, G: 3, M: 4, O: 5}

    def lines(entries, prefix):
        out = []
        for t, i, p in sorted(entries, key=lambda e: (order[e[0]], e[1])):
            q = uname(i) if t == U else gname(i) if t == G else ''
            out.append(f'{prefix}{TAGNAME[t]}:{q}:{perm_str(p)}')
        return out
    out = [f'# file: {quote(path)}', f'# owner: {uname(uid)}', f'# group: {gname(gid)}']
    if flags:
        out.append('# flags: ' + ('s' if flags & stat.S_ISUID else '-') +
                   ('s' if flags & stat.S_ISGID else '-') + ('t' if flags & stat.S_ISVTX else '-'))
    out += lines(acc, '')
    if dfl:
        out += lines(dfl, 'default:')
    return '\n'.join(out) + '\n\n'


def roots():
    r = [os.path.join(ROOT, 'agents', n) for n in sorted(os.listdir(os.path.join(ROOT, 'agents')))]
    r += sorted('/home/' + n for n in os.listdir('/home') if n.startswith('agent-'))
    r.append(SESSION_ENV)
    return [p for p in r if os.path.isdir(p)]


def walk(top, blind):
    yield top
    stack = [top]
    while stack:
        d = stack.pop()
        try:
            names = sorted(os.listdir(d))
        except OSError as e:
            blind.append((d, e.strerror))
            continue
        for n in names:
            p = os.path.join(d, n)
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode):
                continue
            yield p
            if stat.S_ISDIR(st.st_mode):
                stack.append(p)


def parse(fname):
    n, first = 0, []
    with open(fname) as fh:
        for line in fh:
            if line.startswith('# file:'):
                n += 1
            if n == 1:
                first.append(line.rstrip('\n'))
    print(f'bejegyzes: {n}')
    print('\n'.join(first))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['mentes', 'cel', 'parse'])
    ap.add_argument('file', nargs='?')
    ap.add_argument('-o', '--out')
    ap.add_argument('--gyoker', action='append', default=[],
                    help='walk these roots instead of the fleet trees (for the throwaway restore test)')
    a = ap.parse_args()
    if a.mode == 'parse':
        parse(a.file)
        return
    router = Who('marveen')
    owners = {p.pw_name: Who(p.pw_name) for p in pwd.getpwall() if p.pw_name.startswith('agent-')}
    blind, count, changed = [], 0, 0
    old_umask = os.umask(0o077)
    try:
        out = open(a.out, 'x') if a.out else sys.stdout
    finally:
        os.umask(old_umask)
    with out:
        for top in (a.gyoker or roots()):
            for p in walk(top, blind):
                try:
                    st = os.lstat(p)
                except OSError:
                    continue
                acc = xattr_acl(p, 'system.posix_acl_access')
                dfl = xattr_acl(p, 'system.posix_acl_default') if stat.S_ISDIR(st.st_mode) else None
                cur_acc = [(t, i, pm) for t, pm, i in acc] if acc else minimal(st.st_mode)
                cur_dfl = [(t, i, pm) for t, pm, i in dfl] if dfl else None
                flags = st.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX)
                if a.mode == 'mentes':
                    out.write(fmt(p, st.st_uid, st.st_gid, flags, cur_acc, cur_dfl))
                else:
                    t = transform(p, st, cur_acc if acc else None, cur_dfl, router, owners)
                    norm = lambda e: sorted(e) if e else e
                    if (t[0], t[1], t[2], norm(t[3]), norm(t[4])) != \
                            (st.st_uid, st.st_gid, flags, norm(cur_acc), norm(cur_dfl)):
                        changed += 1
                    out.write(fmt(p, *t))
                count += 1
    print(f'{a.mode}: {count} bejegyzes' + (f', ebbol {changed} valtozik' if a.mode == 'cel' else ''),
          file=sys.stderr)
    if HARDLINK_HELD:
        print(f'HARDLINK, idegen tulajdonos, nem kap chownt: {len(HARDLINK_HELD)}', file=sys.stderr)
        for h in HARDLINK_HELD[:20]:
            print(f'  {h}', file=sys.stderr)
    for d, e in blind[:20]:
        print(f'VAKFOLT {e}: {d}', file=sys.stderr)
    if blind:
        print(f'VAKFOLT osszesen: {len(blind)} (rootkent futtasd)', file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
