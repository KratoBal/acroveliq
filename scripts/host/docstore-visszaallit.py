#!/usr/bin/python3 -I
"""docstore-visszaallit: the document store as it was on one day, from its backup (card 976dd43f). A backup is worth what can be
read back from it: this is the reading, and it checks every file.

    docstore-visszaallit <backup dir> <date> <empty target dir>

<backup dir> is a `dokumentumok` directory as the gate's `backup-docstore` fills it (`~/backups/dokumentumok`, or the other
host's copy `~/backups/tavoli/dokumentumok`). The day's list (`<date>.lista`) names the archives:

    # teljes                 <date>.full.tar.gz
    # kulonbseg <base>       <base>.full.tar.gz, then <date>.diff.tar.gz over it

Then every file the list does not name is removed (a document deleted after the full), and every file the list names must be
there with its size and sha256. stdout: `visszaallitva <files> fajl, torolve <n>, elter 0`. Exit 1 on any missing or differing
file, a missing archive, or a name that would leave the target directory.

A day from before the change has only `<date>.tar.gz` and no list: it is unpacked as it is, and the output says that nothing
was checked against a list.
"""
import hashlib
import os
import re
import sys
import tarfile


DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def fail(message: str) -> None:
    print(f"docstore-visszaallit: {message}", file=sys.stderr)
    sys.exit(1)


def unpack(archive: str, target: str) -> int:
    """Regular files only, never outside the target; a later archive writes over an earlier one's file."""
    if not os.path.isfile(archive):
        fail(f"hianyzik: {archive}")
    count = 0
    with tarfile.open(archive, mode="r:gz") as source:
        for member in source:
            name = member.name
            if name.startswith("/") or ".." in name.split("/") or "\n" in name:
                fail(f"tiltott nev az archivumban: {name!r}")
            if member.isdir():
                continue
            if not member.isreg():
                fail(f"nem fajl es nem mappa az archivumban: {name!r}")
            path = os.path.join(target, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with source.extractfile(member) as data, open(path, "wb") as out:
                out.write(data.read())
            count += 1
    return count


def main(argv: list[str]) -> None:
    if len(argv) != 3:
        fail("hasznalat: <mentes-mappa> <datum> <ures cel-mappa>")
    backups, day, target = argv
    if os.path.exists(target) and os.listdir(target):
        fail(f"a cel-mappa nem ures: {target}")
    os.makedirs(target, exist_ok=True)
    listing = os.path.join(backups, f"{day}.lista")

    if not os.path.isfile(listing):
        legacy = os.path.join(backups, f"{day}.tar.gz")
        if not os.path.isfile(legacy):
            fail(f"nincs ilyen napi mentes: {day}")
        n = unpack(legacy, target)
        print(f"visszaallitva {n} fajl (regi teljes csomag, lista nelkul: tartalom-ellenorzes nem volt)")
        return

    with open(listing, encoding="utf-8") as handle:
        header = handle.readline().rstrip("\n").split(" ")
        wanted: dict[str, tuple[str, int]] = {}
        for line in handle:
            digest, size, name = line.rstrip("\n").split(" ", 2)
            wanted[name] = (digest, int(size))
    if header == ["#", "teljes"]:
        archives = [os.path.join(backups, f"{day}.full.tar.gz")]
    # the base is a day, nothing else: its name becomes a path (barracuda on #415, a hand-written or broken list)
    elif len(header) == 3 and header[:2] == ["#", "kulonbseg"] and DAY.fullmatch(header[2]):
        archives = [os.path.join(backups, f"{header[2]}.full.tar.gz"), os.path.join(backups, f"{day}.diff.tar.gz")]
    else:
        fail(f"ismeretlen lista-fejlec: {' '.join(header)!r}")
        return
    for archive in archives:
        unpack(archive, target)

    removed = 0
    for folder, _dirs, files in os.walk(target):
        for file in files:
            rel = os.path.relpath(os.path.join(folder, file), target)
            if rel not in wanted:
                os.remove(os.path.join(target, rel))
                removed += 1
    differing = []
    for name, (digest, size) in wanted.items():
        path = os.path.join(target, name)
        if not os.path.isfile(path):
            differing.append(f"hianyzik: {name}")
            continue
        with open(path, "rb") as handle:
            data = handle.read()
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            differing.append(f"elter: {name}")
    if differing:
        for line in differing[:20]:
            print(line, file=sys.stderr)
        fail(f"{len(differing)} fajl hianyzik vagy elter a listatol")
    print(f"visszaallitva {len(wanted)} fajl, torolve {removed}, elter 0")


if __name__ == "__main__":
    main(sys.argv[1:])
