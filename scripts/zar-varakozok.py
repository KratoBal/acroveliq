#!/usr/bin/env python3
"""ANSWERS: Ki vár a flotta nehéz-futás zárján (/tmp/flotta-nehez.lock) régebb óta, mint a küszöb, és holtpont-e?

zar-varakozok.py [--zar PATH] [--perc N]   (a tetlen-or.sh hívja; kimenet: soronként egy várakozó)

WHY (acrobot 43759, 2026-11-05): murena kétszer állt egy olyan futtat-gyereken, ami a futtat által
már tartott zárra flock-olt (14:00-17:00 és 18:2x-19:5x). A panel közben "shell still running"-ot
mutatott, és a done-idő alapján nem látszott tétlennek: a tetlen-or nem szólt. Ez a figyelő a
panelt nem nézi, hanem a kernel zártábláját.

HOGYAN: a /proc/locks-ban a várakozó sor "N: -> FLOCK ... PID MAJ:MIN:INODE" alakú (mérve
2026-11-05, két valódi flock-folyamattal). A zárfájl eszköz- és inode-száma azonosítja a sort.
A várakozás hossza a várakozó folyamat kora (a flock és a futtat a zárat az indulása után rögtön
kéri). Az ágens a folyamat felhasználója (`agent-<nev>`; a `marveen` felhasználó: acrobot).
HOLTPONT, ha a zárat tartó folyamat a várakozó őse: az soha nem engedi el.

Kimenet soronként: <agens> <pid> <perc> <tarto-pid|?> <holtpont|var>. Üres kimenet: nincs ilyen.
"""
from __future__ import annotations

import argparse
import os
import pwd
import time
from pathlib import Path

LOCKS = Path(os.environ.get("ZAR_VARAKOZOK_LOCKS", "/proc/locks"))


def lock_key(path: Path) -> str | None:
    """The `MAJ:MIN:INODE` /proc/locks names this file by, or None if it does not exist."""
    try:
        st = path.stat()
    except OSError:
        return None
    return f"{os.major(st.st_dev):02x}:{os.minor(st.st_dev):02x}:{st.st_ino}"


def holders_and_waiters(key: str) -> tuple[list[int], list[int]]:
    holders: list[int] = []
    waiters: list[int] = []
    for line in LOCKS.read_text().splitlines():
        parts = line.split()
        if key not in parts:
            continue
        waiting = len(parts) > 1 and parts[1] == "->"
        fields = parts[2:] if waiting else parts[1:]
        # FLOCK ADVISORY WRITE PID MAJ:MIN:INODE START END
        try:
            pid = int(fields[3])
        except (IndexError, ValueError):
            continue
        (waiters if waiting else holders).append(pid)
    return holders, waiters


def parent(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    # the command name is in parentheses and may hold spaces
    return int(stat.rsplit(")", 1)[1].split()[1])


def ancestors(pid: int) -> set[int]:
    seen: set[int] = set()
    current = parent(pid)
    while current and current not in seen and current > 1:
        seen.add(current)
        current = parent(current)
    return seen


def age_seconds(pid: int) -> float | None:
    try:
        start_ticks = int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
        uptime = float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None
    return uptime - start_ticks / os.sysconf("SC_CLK_TCK")


def agent_of(pid: int) -> str:
    try:
        user = pwd.getpwuid(os.stat(f"/proc/{pid}").st_uid).pw_name
    except (OSError, KeyError):
        return "?"
    if user.startswith("agent-"):
        return user[len("agent-"):]
    return "acrobot" if user == "marveen" else user


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--zar", default=os.environ.get("FUTTAT_NEHEZ_ZAR", "/tmp/flotta-nehez.lock"))
    parser.add_argument("--perc", type=float, default=20)
    args = parser.parse_args()
    key = lock_key(Path(args.zar))
    if key is None:
        return 0
    holders, waiters = holders_and_waiters(key)
    for pid in waiters:
        age = age_seconds(pid)
        if age is None or age < args.perc * 60:
            continue
        holder = holders[0] if holders else None
        deadlock = holder is not None and holder in ancestors(pid)
        print(f"{agent_of(pid)} {pid} {int(age // 60)} {holder if holder else '?'} {'holtpont' if deadlock else 'var'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
