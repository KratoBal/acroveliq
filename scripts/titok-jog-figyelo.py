#!/usr/bin/env python3
# ANSWERS: Valtozott-e ma, ki olvashatja a titkainkat? (Security Baseline M-3, a jogosultsag-valtozas figyelo)
"""The permission-change watcher (Security Baseline M-3, on the F0-2 matrix; acrobot 31244).

Once a day the scheduled task runs this. It computes the uid x secret readability matrix
(fleet-secrets.py, matrix_rows: owner, group, mode and group membership, no privileges, no file
opened) and compares it with the PREVIOUS run's, kept in STATE. It reports only a CHANGE:

  UJ FAJL        a secret file that was not there
  ELTUNT FAJL    one that is gone
  MOD            its mode changed (for example 600 -> 640)
  TULAJDONOS     its owner changed
  CSOPORT        its group changed
  UJ OLVASO      a user who could not read it now can          (the change that matters most)
  ELVESZETT      a user who could read it no longer can
  UJ FELHASZNALO a fleet user that was not there, with what it reads
  ACL            a cell whose ACL state changed: "ACL" (an ACL is set, the file is not computed) or
                 "?" (the ACL state could not be read); see fleet-secrets.py

No change: no output, exit 0 (the scheduled task stays silent). A change: one line each, exit 1.
The very first run, with no STATE yet, records the baseline silently: what stands today (the two
findings of 2026-10-15 included) does not alert every day. After every run the STATE is the new
matrix, so a change alerts once.

The runner's own row disagreeing with os.access means the computation cannot be trusted, and an
unreadable STATE means there is nothing to compare with: in both cases the watcher says so and exits
2 without touching STATE (a fresh baseline there would swallow the very change it is for).

Nothing here reads a secret's content or calls the network. STATE holds only what the output shows
(file names, owner, group, mode, the per-user answers), written atomically with mode 0600.
"""
import importlib.util
import json
import os
import sys

ROOT = os.environ.get("FLEET_ROOT", "/home/marveen/marveen")
STATE = os.environ.get("TITOK_JOG_STATE", os.path.join(ROOT, "store", "titok-jog-allapot.json"))
HERE = os.path.dirname(os.path.abspath(__file__))


def load_matrix():
    spec = importlib.util.spec_from_file_location("fleet_secrets", os.path.join(HERE, "fleet-secrets.py"))
    fs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fs)
    return fs.matrix_rows()


def diff(old, new):
    """The changes from the old state to the new one, as text lines (no content, names only)."""
    out = []
    old_rows = {r["file"]: r for r in old["rows"]}
    new_rows = {r["file"]: r for r in new["rows"]}
    old_users, new_users = set(old["users"]), set(new["users"])
    for u in sorted(new_users - old_users):
        reads = sorted(f for f, r in new_rows.items() if r["readers"].get(u) == "IGEN")
        out.append(f"UJ FELHASZNALO {u}: olvas {len(reads)} titkot" + (f" ({', '.join(reads)})" if reads else ""))
    for f in sorted(new_rows.keys() - old_rows.keys()):
        r = new_rows[f]
        readers = sorted(u for u, v in r["readers"].items() if v == "IGEN")
        out.append(f"UJ FAJL {f}: {r['owner']} {r['group']} {r['mode']}, olvassa: {', '.join(readers) or 'senki'}")
    for f in sorted(old_rows.keys() - new_rows.keys()):
        out.append(f"ELTUNT FAJL {f}")
    for f in sorted(new_rows.keys() & old_rows.keys()):
        o, n = old_rows[f], new_rows[f]
        for key, label in (("mode", "MOD"), ("owner", "TULAJDONOS"), ("group", "CSOPORT")):
            if o[key] != n[key]:
                out.append(f"{label} {f}: {o[key]} helyett {n[key]}")
        for u in sorted(old_users & new_users):
            a, b = o["readers"].get(u), n["readers"].get(u)
            if a == b:
                continue
            if "ACL" in (a, b) or "?" in (a, b):
                out.append(f"ACL {f}: {u} {a} helyett {b}")
            elif b == "IGEN":
                out.append(f"UJ OLVASO {f}: {u}")
            else:
                out.append(f"ELVESZETT {f}: {u} mar nem olvassa")
    return out


def write_state(state):
    tmp = STATE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)  # a leftover tmp keeps its old mode through O_TRUNC
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def main():
    users, rows, mismatch = load_matrix()
    if mismatch:
        print(f"HIBA: a szamolt matrix a futtato sajat soran elter az os.access-tol ({', '.join(mismatch)}); "
              "a valtozast nem merem, az allapot nem frissul.")
        return 2
    new = {"users": users, "rows": rows}
    if not os.path.exists(STATE):
        write_state(new)
        return 0
    try:
        with open(STATE, encoding="utf-8") as f:
            old = json.load(f)
        old["users"], old["rows"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        # not a silent new baseline: that would swallow exactly the change this watcher is for
        print(f"HIBA: az elozo allapot ({STATE}) nem olvashato ({type(e).__name__}); "
              "a valtozast nem merem, az allapot nem frissul.")
        return 2
    changes = diff(old, new)
    write_state(new)
    for line in changes:
        print(line)
    return 1 if changes else 0


if __name__ == "__main__":
    sys.exit(main())
