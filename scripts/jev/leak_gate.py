#!/usr/bin/env python3
# ANSWERS: Atmegy-e a jelenlegi kitakaro a rogzitett magyar szivargas-keszleten (0 szivargas = a Jev shadow kivitel engedelyezheto)?
"""Hard gate for the D-005 shadow export (ACD-011 point 2).

Runs redact() over every case of the fixed suite and checks, after folding
(case, accents, homoglyphs), that no leak string survives. 'keep' strings
are reported as the semantic cost, not gated.

On 0 leaks it writes store/jev-leak-gate.json with the redaction version,
the suite version and a hash of the redactor's own files. The provider
boundary (shadow.py) refuses to call out unless that file matches the code
that is running now, so an edited redactor is closed until re-tested.

Usage: python3 leak_gate.py [--verbose]
Exit 0 only when every case passes.
"""
import hashlib
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import redact  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "gpt-csomag"))
import hatar  # noqa: E402

SUITE = os.path.join(_HERE, "leak-suite.json")
STATUS = os.environ.get("JEV_LEAK_GATE_STATUS", "/home/marveen/marveen/store/jev-leak-gate.json")
# offline.py builds the texts of the offline measurement and hands them to the
# same boundary; a change there must also close the gate until re-tested.
# The GPT package's boundary (gpt-csomag/hatar.py) decides what the redactor sees: it swaps the
# debate's participants for preserved tokens. A change there must close the gate too (barracuda,
# #181 review; acrobot 31140), and the suite runs through that path as well (run(keep_names=...)).
CODE_FILES = ["redact.py", "shadow.py", "offline.py", "hu-names.txt", "preserve-terms.json", "leak-suite.json",
              "leak-suite-pairing.json", "../gpt-csomag/hatar.py"]
# The pairing mode (redact.PAIRING_KEEP) keeps business data, so it has its own
# suite: the gate is green only if BOTH runs leak nothing.
PAIRING_SUITE = os.path.join(_HERE, "leak-suite-pairing.json")
OPTIONAL_FILES = [redact.COMMON_WORDS_PATH]


def code_hash():
    h = hashlib.sha256()
    for f in CODE_FILES:
        with open(os.path.join(_HERE, f), "rb") as fh:
            h.update(f.encode() + b"\0" + fh.read() + b"\0")
    for f in OPTIONAL_FILES:
        try:
            with open(f, "rb") as fh:
                h.update(os.path.basename(f).encode() + b"\0" + fh.read() + b"\0")
        except OSError:
            h.update(os.path.basename(f).encode() + b"\0absent\0")
    return h.hexdigest()


def _expand(x):
    """Fixture secrets are stored broken ("gh@@p_...") so the repository's
    secret gate does not see a token shape; the redactor sees the real one."""
    if isinstance(x, str):
        return x.replace("@@", "")
    if isinstance(x, list):
        return [_expand(i) for i in x]
    if isinstance(x, dict):
        return {k: _expand(v) for k, v in x.items()}
    return x


def load_suite(path=SUITE):
    with open(path, encoding="utf-8") as f:
        return _expand(json.load(f))


def run(verbose=False, path=SUITE, keep_kinds=(), keep_names=()):
    suite = load_suite(path)
    leaks, kept, keep_total, errors = [], 0, 0, []
    for c in suite["cases"]:
        try:
            if keep_names:
                # the GPT package's path: the participants kept, everything else as in full mode
                r, restore = hatar.redact_keeping(c["text"], keep_names)
                out = hatar.restore_names(r["text"], restore)
            else:
                out = redact.redact(c["text"], keep_kinds=keep_kinds)["text"]
        except redact.RedactionError as e:
            errors.append((c["id"], str(e)))
            continue
        fo = redact.fold(out)
        for s in c.get("leak", []):
            if redact.fold(s) in fo:
                leaks.append((c["id"], s, out))
        for s in c.get("keep", []):
            keep_total += 1
            if redact.fold(s) in fo:
                kept += 1
            elif verbose:
                print(f"  lost-keep {c['id']}: {s!r} -> {out}")
        if verbose:
            print(f"{c['id']:36} {out}")
    return suite, leaks, errors, kept, keep_total


def main():
    verbose = "--verbose" in sys.argv
    suite, leaks, errors, kept, keep_total = run(verbose)
    n = len(suite["cases"])
    print(f"redaction {redact.REDACTION_VERSION}, suite {suite['suite_version']}: "
          f"{n} cases, {len(leaks)} leaks, {len(errors)} errors, keep {kept}/{keep_total}")
    for cid, s, out in leaks:
        print(f"  LEAK {cid}: {s!r} survived -> {out}")
    for cid, e in errors:
        print(f"  ERROR {cid}: {e}")
    psuite, pleaks, perrors, pkept, pkeep_total = run(verbose, PAIRING_SUITE, redact.PAIRING_KEEP)
    print(f"pairing mode {sorted(redact.PAIRING_KEEP)}, suite {psuite['suite_version']}: "
          f"{len(psuite['cases'])} cases, {len(pleaks)} leaks, {len(perrors)} errors, keep {pkept}/{pkeep_total}")
    for cid, s, out in pleaks:
        print(f"  LEAK {cid}: {s!r} survived -> {out}")
    for cid, e in perrors:
        print(f"  ERROR {cid}: {e}")
    gsuite, gleaks, gerrors, gkept, gkeep_total = run(verbose, SUITE, keep_names=hatar.PARTICIPANTS)
    print(f"participants kept {list(hatar.PARTICIPANTS)}, suite {gsuite['suite_version']}: "
          f"{len(gsuite['cases'])} cases, {len(gleaks)} leaks, {len(gerrors)} errors, keep {gkept}/{gkeep_total}")
    for cid, s, out in gleaks:
        print(f"  LEAK {cid}: {s!r} survived -> {out}")
    for cid, e in gerrors:
        print(f"  ERROR {cid}: {e}")
    ok = not leaks and not errors and not pleaks and not perrors and not gleaks and not gerrors
    if ok:
        os.makedirs(os.path.dirname(STATUS), exist_ok=True)
        tmp = STATUS + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"redaction_version": redact.REDACTION_VERSION,
                       "suite_version": suite["suite_version"], "code_hash": code_hash(),
                       "cases": n, "leaks": 0, "keep": [kept, keep_total],
                       "pairing": {"suite_version": psuite["suite_version"],
                                   "cases": len(psuite["cases"]), "leaks": 0,
                                   "keep": [pkept, pkeep_total]},
                       "participants": {"names": list(hatar.PARTICIPANTS), "cases": len(gsuite["cases"]),
                                        "leaks": 0, "keep": [gkept, gkeep_total]},
                       "passed_at": int(time.time())}, f)
        os.replace(tmp, STATUS)
    elif os.path.exists(STATUS):
        os.remove(STATUS)  # a red run revokes an older green
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
