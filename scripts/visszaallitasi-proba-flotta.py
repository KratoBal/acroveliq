#!/usr/bin/env python3
"""ANSWERS: A NAS-rol visszatoltott flotta-mentes ep-e, teljes-e, es olyan friss-e, mint az elo adatbazis volt a mentes pillanataban?

visszaallitasi-proba-flotta.py <mentes.db> <elo.db> <fajlnev> -- the fleet branch of scripts/visszaallitasi-proba.sh.

The checks, each one a FAIL line of its own:
  integrity    sqlite integrity_check is "ok", and the backup has at least ten tables
  tables       the four tables the fleet lives on are all there (a missing one used to be skipped in silence)
  counts       each of them has rows, and no more than the live database (a backup cannot be ahead of it)
  freshness    (card 1c3b73dc, acrobot 59582, 59585) the file's NAME carries its time, but nothing proved its CONTENT: a backup
               named last night and holding last week's data passed every check above. For agent_messages and memories, the
               backup's newest created_at must reach the newest row the live database had AT the file's time (within
               FRESH_SLACK_S). Measured against the live database, not against the clock: a quiet fleet (the 2026-11-21..23
               credit stop, no message for two days) has an old newest row in a good backup too, and a fixed "newer than 24 h"
               would have called that a failure.

The file name's time is the backup's local time (fleet-backup.sh: date +%Y-%m-%d_%H-%M-%S, taken before the snapshot), read
here in the same local zone. created_at is epoch seconds (src/db.ts: Math.floor(Date.now() / 1000)); a value in milliseconds
is read as such. Exit 0 when every check passes, 1 otherwise.

A FAIL ON FRESHNESS, the order to look (barracuda on #396; both err towards a false FAIL, never a false pass): first the zone,
`date +%z` (2026-08-20..21 the Budapest zone file was empty and glibc read local times as UTC: the file's time moves one or two
hours later, live rows written after the backup count as "before it", and an active fleet fails); then a row written afterwards
with an older created_at (an import, a restore, a hand fix), which live holds and the backup cannot.
"""
import re
import sqlite3
import sys
import time

REQUIRED = ("memories", "kanban_cards", "agent_messages", "daily_logs")
FRESH = ("agent_messages", "memories")
FRESH_SLACK_S = 600


def seconds(value):
    """created_at as epoch seconds; a millisecond value (13 digits) is divided down."""
    if value is None:
        return None
    v = float(value)
    return v / 1000 if v > 1e12 else v


def file_time(name):
    m = re.search(r"(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})", name)
    if not m:
        return None
    return time.mktime(time.strptime("%s %s:%s:%s" % m.groups(), "%Y-%m-%d %H:%M:%S"))


def main(bak, live, name):
    b = sqlite3.connect("file:%s?mode=ro" % bak, uri=True)
    l = sqlite3.connect("file:%s?mode=ro" % live, uri=True)
    fails = []
    ok = b.execute("pragma integrity_check").fetchone()[0]
    tables = [r[0] for r in b.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
    print("   %s: integrity %s, %d tabla" % (name, ok, len(tables)))
    if ok != "ok" or len(tables) < 10:
        fails.append("integrity=%s tablak=%d" % (ok, len(tables)))
    missing = [t for t in REQUIRED if t not in tables]
    if missing:
        fails.append("hianyzo tabla: %s" % ", ".join(missing))
    for t in REQUIRED:
        if t in missing:
            continue
        nb = b.execute('select count(*) from "%s"' % t).fetchone()[0]
        nl = l.execute('select count(*) from "%s"' % t).fetchone()[0]
        print("   %-14s mentes %7d   elo %7d" % (t, nb, nl))
        if nb == 0 or nb > nl:
            fails.append("%s sorszama gyanus (mentes %d, elo %d)" % (t, nb, nl))
    at = file_time(name)
    if at is None:
        fails.append("a fajlnevbol nem olvashato ki az ido: %s" % name)
    else:
        for t in FRESH:
            if t in missing:
                continue
            newest_b = seconds(b.execute('select max(created_at) from "%s"' % t).fetchone()[0])
            # the newest live row at the file's time, a millisecond value read as such
            before = seconds(l.execute(
                'select max(created_at) from "%s" where (case when created_at > 1e12 then created_at / 1000.0 else created_at end) <= ?' % t,
                (at,)).fetchone()[0])
            show = lambda s: "nincs" if s is None else time.strftime("%Y-%m-%d %H:%M", time.localtime(s))
            print("   %-14s legfrissebb: mentes %s, elo a mentes idejeig %s" % (t, show(newest_b), show(before)))
            if before is not None and (newest_b is None or newest_b < before - FRESH_SLACK_S):
                fails.append("%s: a mentes legfrissebb sora (%s) regebbi, mint amit az elo a mentes idejeig tartalmazott (%s)" % (t, show(newest_b), show(before)))
    for f in fails:
        print("FAIL[fleet]: %s" % f)
    return 1 if fails else 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: visszaallitasi-proba-flotta.py <mentes.db> <elo.db> <fajlnev>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(*sys.argv[1:4]))
