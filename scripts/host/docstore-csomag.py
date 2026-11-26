#!/usr/bin/python3 -I
"""docstore-csomag: the document store's daily backup, a FULL one a week and a DIFFERENCE on the other days (card 976dd43f;
Balázs 2026-09-18: past 1 GB the backup is incremental; the daily full package was 980.5 MB on 2026-11-26, growing ~2 MB a day).

    docstore-csomag full <archive.tar.gz> <list>
    docstore-csomag diff <archive.tar.gz> <list> <base list> <base date>

stdin: the store as `tar -C /data -cf - document-store` writes it (the gate's `backup-docstore`, the same stream as before).

    full   every file goes into the archive
    diff   only the files that are new or whose content differs from the base list (the week's full): not chained, so a
           restore is the full plus ONE difference

The list is the day's WHOLE store, one line a file: `<sha256> <size> <path>`, after a header line (`# teljes` or
`# kulonbseg <base date>`). A file the day's list does not name was deleted: the restore (`docstore-visszaallit`) removes it.
Content, not time, decides what changed (a document can be written over under the same name): a file whose bytes are the same
is not packed again, whatever its mtime.

Both outputs are written under a temporary name and renamed when complete: a stopped run leaves no file a later day would take
for a whole one. stdout: `<files in the archive> <files in the list>`. Any member that is not a regular file or a directory, an
absolute path, a `..`, or a newline in a name stops the run (exit 1): nothing of that sort is in a document store.
"""
import hashlib
import io
import os
import sys
import tarfile


def fail(message: str) -> None:
    print(f"docstore-csomag: {message}", file=sys.stderr)
    sys.exit(1)


def read_list(path: str) -> dict[str, str]:
    """A list file as {path: sha256}; the header line is skipped."""
    out: dict[str, str] = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("#"):
                continue
            digest, _size, name = line.rstrip("\n").split(" ", 2)
            out[name] = digest
    return out


def safe_name(name: str) -> str:
    if name.startswith("/") or "\n" in name or ".." in name.split("/"):
        fail(f"tiltott nev az archivumban: {name!r}")
    return name


def main(argv: list[str]) -> None:
    if len(argv) == 3 and argv[0] == "full":
        kind, archive, listing = argv
        base: dict[str, str] | None = None
        header = "# teljes\n"
    elif len(argv) == 5 and argv[0] == "diff":
        kind, archive, listing, base_list, base_date = argv
        base = read_list(base_list)
        header = f"# kulonbseg {base_date}\n"
    else:
        fail("hasznalat: full <archivum> <lista> | diff <archivum> <lista> <alap-lista> <alap-datum>")
        return
    archive_part = f"{archive}.part"
    listing_part = f"{listing}.part"
    packed = 0
    listed = 0
    done = False
    try:
        with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as source, tarfile.open(
            archive_part, mode="w:gz", compresslevel=1
        ) as target, open(listing_part, "w", encoding="utf-8") as lines:
            lines.write(header)
            for member in source:
                name = safe_name(member.name)
                if member.isdir():
                    continue
                if not member.isreg():
                    fail(f"nem fajl es nem mappa az archivumban: {name!r}")
                data = source.extractfile(member).read()
                digest = hashlib.sha256(data).hexdigest()
                lines.write(f"{digest} {len(data)} {name}\n")
                listed += 1
                if base is None or base.get(name) != digest:
                    member.size = len(data)
                    target.addfile(member, fileobj=io.BytesIO(data))
                    packed += 1
        done = True
    except (tarfile.TarError, OSError, ValueError) as error:
        fail(f"a csomag nem keszult el ({type(error).__name__}: {error})")
    finally:
        # a run that stopped (an error, or a refused member) leaves no part file behind
        if not done:
            for leftover in (archive_part, listing_part):
                if os.path.exists(leftover):
                    os.remove(leftover)
    os.replace(archive_part, archive)
    os.replace(listing_part, listing)
    print(f"{packed} {listed}")


if __name__ == "__main__":
    main(sys.argv[1:])
