#!/usr/bin/env python3
"""B45 guard: the ACL target state and the write check (scripts/b45-acl.py,
scripts/b45-jogellenorzo.py).

What this pins (barracuda review of the B45 plan, 2026-10-13):
  1. The target removes group/other WRITE and nothing else: a 0600 file with
     mask::--- (.claude.json, .credentials.json) gets no named entry that
     could open it to anyone.
  2. No NEW default ACL is created where none exists today (home dirs,
     session-env, default-less dirs): a default ACL makes the kernel ignore
     the umask, so a umask-077 program would hand out read.
  3. A foreign-agent-owned entry in a tree goes to the tree owner, EXCEPT a
     multi-link regular file (possibly the same inode as another tree's file).
  4. The shared session-env root gets the sticky bit and keeps group write.
  5. The checker's POSIX.1e evaluation (owner, named user & mask, group
     class, other).

Pure logic: no ACL is read or written, and no fleet user has to exist (CI has
none), so the name lookups are replaced by a fixed table.

Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import importlib.util
import os
import stat
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)


def load(name, fname):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


acl = load('b45acl', 'b45-acl.py')
chk = load('b45chk', 'b45-jogellenorzo.py')

failed = []


def check(name, ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}")
    if not ok:
        failed.append(name)


# --- a fixed user table instead of /etc/passwd -------------------------------
NAMES = {1000: 'marveen', 1003: 'agent-barracuda', 1004: 'agent-murena'}
UIDS = {v: k for k, v in NAMES.items()}
FLEET = 1001


class FakePw:
    def __init__(self, uid):
        self.pw_uid = uid


class FakePwd:
    @staticmethod
    def getpwnam(n):
        return FakePw(UIDS[n])


acl.uname = lambda uid: NAMES.get(uid, str(uid))
acl.pwd = FakePwd


def who(uid, gids):
    w = object.__new__(acl.Who)
    w.uid, w.gids = uid, set(gids)
    return w


ROUTER = who(1000, {1000, FLEET})
OWNERS = {'agent-murena': who(1004, {FLEET}), 'agent-barracuda': who(1003, {FLEET})}
UO, U, GO, G, M, O = acl.UO, acl.U, acl.GO, acl.G, acl.M, acl.O


class St:
    def __init__(self, mode, uid, gid=FLEET, nlink=1):
        self.st_mode, self.st_uid, self.st_gid, self.st_nlink = mode, uid, gid, nlink


TREE = acl.ROOT + '/agents/murena'


def ents(lst, tag):
    return [e for e in lst if e[0] == tag]


def eff_for(entries, gid, w):
    return acl.eff(entries, gid, w)


print('1. a cel csak az irast veszi el')
fleet_acl = [(UO, 0, 6), (GO, 0, 7), (G, FLEET, 7), (M, 0, 6), (O, 0, 4)]
uid, gid, flags, new, newd = acl.transform(
    TREE + '/CLAUDE.md', St(stat.S_IFREG | 0o664, 1004), fleet_acl, None, ROUTER, OWNERS)
other_agent = who(1003, {FLEET})
check('a masik agens nem irhat (fleet csoporton at)', not eff_for(new, gid, other_agent) & 2)
check('a masik agens olvashat, ahogy ma', eff_for(new, gid, other_agent) & 4 == 4)
check('a router nevesitett rw bejegyzest kap', (U, 1000, 6) in new)
check('a tulajdonos valtozatlan', uid == 1004)

secret_acl = [(UO, 0, 6), (GO, 0, 7), (G, FLEET, 7), (M, 0, 0), (O, 0, 0)]
uid, gid, flags, new, newd = acl.transform(
    TREE + '/.claude-config/.claude.json', St(stat.S_IFREG | 0o600, 1004), secret_acl, None, ROUTER, OWNERS)
check('600 + mask::--- : a routernek nincs bejegyzese', not ents(new, U))
check('600 + mask::--- : a maszk --- marad', ents(new, M) == [(M, 0, 0)])
check('600 + mask::--- : a masik agens nem olvas', eff_for(new, gid, other_agent) == 0)

plain = None   # no ACL today, mode 0640
uid, gid, flags, new, newd = acl.transform(
    TREE + '/key.env', St(stat.S_IFREG | 0o640, 1000), plain, None, ROUTER, OWNERS)
check('640 ACL nelkul: a csoport olvas, nem ir', eff_for(new, gid, other_agent) == 4)

print('2. uj default ACL sehol')
uid, gid, flags, new, newd = acl.transform(
    '/home/agent-murena/.npm', St(stat.S_IFDIR | 0o775, 1004), None, None, ROUTER, OWNERS)
check('home konyvtar: default nem keletkezik', newd is None)
check('home konyvtar: a csoport irasa elveszik', ents(new, GO) == [(GO, 0, 5)])
uid, gid, flags, new, newd = acl.transform(
    TREE + '/marveen-upstream-test', St(stat.S_IFDIR | 0o2775, 1004), None, None, ROUTER, OWNERS)
check('default nelkuli konyvtar a faban: default nem keletkezik', newd is None)
dfl = [(UO, 0, 7), (GO, 0, 7), (G, FLEET, 7), (M, 0, 7), (O, 0, 5)]
uid, gid, flags, new, newd = acl.transform(
    TREE + '/skills', St(stat.S_IFDIR | 0o2775, 1004), fleet_acl[:2] + [(G, FLEET, 7), (M, 0, 7), (O, 0, 5)],
    dfl, ROUTER, OWNERS)
check('meglevo default: a fleet irasa elveszik', (G, FLEET, 5) in newd)
check('meglevo default: a router nevesitett rwx-et kap', (U, 1000, 7) in newd)
check('meglevo default: a setgid megmarad', flags & stat.S_ISGID == stat.S_ISGID)

print('3. idegen tulajdonos es hardlink')
acl.HARDLINK_HELD.clear()
uid, *_ = acl.transform(TREE + '/skills/x/SKILL.md', St(stat.S_IFREG | 0o664, 1003), fleet_acl, None, ROUTER, OWNERS)
check('idegen agens fajlja a gazdahoz kerul', uid == 1004)
uid, gid, flags, new, newd = acl.transform(
    TREE + '/linked', St(stat.S_IFREG | 0o664, 1003, nlink=2), fleet_acl, None, ROUTER, OWNERS)
check('tobbszorosen linkelt idegen fajl: nincs chown', uid == 1003)
check('tobbszorosen linkelt idegen fajl: nincs gazda-bejegyzes', (U, 1004, 6) not in new)
check('tobbszorosen linkelt idegen fajl: listazva', acl.HARDLINK_HELD == [TREE + '/linked'])

print('4. session-env gyoker')
uid, gid, flags, new, newd = acl.transform(
    acl.SESSION_ENV, St(stat.S_IFDIR | 0o775, 1000), None, None, ROUTER, OWNERS)
check('sticky bit', flags & stat.S_ISVTX == stat.S_ISVTX)
check('a csoport tovabbra is letrehozhat', ents(new, GO) == [(GO, 0, 7)])
check('default nem keletkezik', newd is None)

print('5. az ellenorzo POSIX.1e szamitasa')
P = chk.Principal.__new__(chk.Principal)
P.uid, P.gids = 1003, {FLEET}
A = chk.ACL_USER_OBJ, chk.ACL_USER, chk.ACL_GROUP_OBJ, chk.ACL_GROUP, chk.ACL_MASK, chk.ACL_OTHER
fs = chk.FakeStat(stat.S_IFREG | 0o664, 1004, FLEET)
ro = [(A[0], 6, 0), (A[2], 5, 0), (A[3], 5, FLEET), (A[4], 7, 0), (A[5], 4, 0)]
rw = [(A[0], 6, 0), (A[2], 7, 0), (A[3], 7, FLEET), (A[4], 6, 0), (A[5], 4, 0)]
check('csoport r-x: nem ir', not chk.allowed(fs, ro, P, chk.W))
check('csoport rwx, maszk rw: ir', chk.allowed(fs, rw, P, chk.W))
masked = [(A[0], 6, 0), (A[1], 6, 1003), (A[2], 4, 0), (A[4], 4, 0), (A[5], 0, 0)]
check('nevesitett rw, maszk r: nem ir', not chk.allowed(fs, masked, P, chk.W))
check('nevesitett rw, maszk r: olvas', chk.allowed(fs, masked, P, chk.R))
owner = chk.FakeStat(stat.S_IFREG | 0o600, 1003, FLEET)
check('tulajdonos: a user:: dont, nem a maszk', chk.allowed(owner, None, P, chk.W))
nogroup = chk.FakeStat(stat.S_IFREG | 0o604, 1004, 1015)
check('csoport-egyezes nelkul az other dont', chk.allowed(nogroup, None, P, chk.R)
      and not chk.allowed(nogroup, None, P, chk.W))

print()
if failed:
    print(f'FAILED: {len(failed)}')
    sys.exit(1)
print('all pass')
