#!/usr/bin/env python3
# ANSWERS: Mely nevek, cimek, cegek allnak a sajat adatbazisunkban, lenyomatkent (a kitakaro A retegehez)? Nevet nem ir ki es nem ment.
"""Builds store/jev-known-entities.json for layer A of redact.py.

Reads the Acropora OS production database through the prod host (read
only, one SELECT), keeps the rows in memory only, and writes keyed
digests. No name, address or email reaches the disk, a log, or stdout:
the output is counts per kind. Same rule as vevo-osszesito.py.

Which container: the one the API actually uses (memory: two postgres
containers answer to the same name; the stale one is our compose sibling).

Usage: python3 build_known.py            (writes the file)
       python3 build_known.py --dry-run  (counts only)
"""
import os
import re
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import redact  # noqa: E402

HOST = "fleet@162.55.216.28"
KEY = os.path.expanduser("~/.ssh/id_ed25519_acropora_monitor")
CONTAINER = "iwm34jaqp9xmwb72qkrqkwhy"

# kind <TAB> value. Cities and postal codes are left out on purpose: layer B
# handles postal codes, and a town name alone identifies no one.
SQL = r"""
select 'PERSON', trim(coalesce("firstName",'') || ' ' || coalesce("lastName",'')) from "User"
union all select 'PERSON', trim(coalesce("lastName",'') || ' ' || coalesce("firstName",'')) from "User"
union all select 'PERSON', "displayName" from "User"
union all select 'PERSON', "nickname" from "User"
union all select 'EMAIL', "email" from "User"
union all select 'ORG', "displayName" from "Customer"
union all select 'ORG', "companyName" from "Customer"
union all select 'EMAIL', "email" from "Customer"
union all select 'ADDRESS', "name" from "CustomerAddress"
union all select 'ADDRESS', "line1" from "CustomerAddress"
union all select 'ADDRESS', "line2" from "CustomerAddress"
union all select 'ORG', "name" from "Supplier"
union all select 'PERSON', "contactPersonName" from "Supplier"
union all select 'EMAIL', "email" from "Supplier"
union all select 'EMAIL', "contactPersonEmail" from "Supplier"
union all select 'PERSON', "contactPersonName" from "Contract"
union all select 'ORG', "organizationalUnitName" from "Contract"
union all select 'PERSON', "signerName" from "WorksheetVersionSignature"
"""


def fetch():
    # fleet-gate (B8): read-only psql, SQL on stdin, unaligned tuples with "|"
    cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-i", KEY, HOST,
           "psql-ro", CONTAINER, "acropora", "tuples-pipe"]
    r = subprocess.run(cmd, input=SQL.encode(), capture_output=True, timeout=120)
    if r.returncode != 0:
        # stderr can quote the query, never row data; still print only the first line
        sys.stderr.write("FAIL psql: " + r.stderr.decode(errors="replace").splitlines()[0][:200] + "\n")
        sys.exit(1)
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        kind, _, value = line.partition("|")
        yield kind, value


_FORM = re.compile(r"(?i)[\s,]+(?:kft|bt|zrt|nyrt|kkt|ev|e\.v|gmbh|ltd|llc|inc|s\.r\.o)\.?$")


def aliases(kind, value):
    """Organisations are named in chat by fragments: the acronym in
    brackets, an all-caps word, the name without its company form. nautilus
    found FANK, INNONEST and TROPUS unmasked on 2026-09-28 because only the
    full registered name was a digest."""
    if kind != "ORG" or not value:
        return []
    out = []
    bare = _FORM.sub("", value).strip()
    if bare and bare != value:
        out.append(bare)
    out += re.findall(r"\(([^)]{2,40})\)", value)
    out += [w for w in re.findall(r"\b[A-ZÁÉÍÓÖŐÚÜŰ]{3,}\b", value)
            if redact.fold(w) not in redact.PRESERVE and redact.fold(w) not in redact.COMMON]
    return [("ORG", x) for x in out]


def admit(kind, value):
    toks = redact.entity_tokens(value or "")
    if not toks:
        return False
    if len(toks) == 1:
        # one word masks that word everywhere: only for names of places and
        # organisations, never short, never a preserved term or a common opener
        t = toks[0]
        if kind == "PERSON" or len(t) < 5 or t in redact.PRESERVE or t in redact._OPENERS:
            return False
    if redact.known_key(toks) in redact.PRESERVE:
        return False
    return True


# Fleet-level identities that are not rows in the OS database: the owner's
# account handle appears in every repository URL we write.
EXTRA = [("HANDLE", "KratoBal"),
         # partners named in chat by a nickname no database row carries
         ("ORG", "FANK"), ("ORG", "Állatkert"), ("ORG", "Fővárosi Állatkert"),
         # third-party businesses nautilus and barracuda found by name, 2026-09-28
         ("ORG", "INNONEST"), ("ORG", "TROPUS"),
         # competitor named in a memory, barracuda r9 read 2026-09-28
         ("ORG", "Korallgarazs"), ("ORG", "Korallgarázs")]


def main():
    rows = list(fetch())
    kept, counts = [], {}
    rows = rows + [al for kind, value in rows for al in aliases(kind, value)]
    for kind, value in rows:
        if admit(kind, value):
            kept.append((kind, value))
            counts[kind] = counts.get(kind, 0) + 1
    kept.extend(EXTRA)
    counts["HANDLE"] = len(EXTRA)
    print(f"rows {len(rows)}, admitted {len(kept)}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    if "--dry-run" not in sys.argv:
        n = redact.write_known_file(kept, redact.KNOWN_ENTITIES_PATH)
        print(f"wrote {n} digests to {redact.KNOWN_ENTITIES_PATH}")


if __name__ == "__main__":
    main()
