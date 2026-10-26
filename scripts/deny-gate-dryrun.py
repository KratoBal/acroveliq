#!/usr/bin/env python3
"""Dry run of scripts/hooks/deny-normalizing-gate.py over real agent transcripts (task
tiltott-osszetett-parancs, Balazs's condition: zero false blocks).

Usage: deny-gate-dryrun.py [--rules FILE] PATH [PATH ...]
  PATH   a transcript .jsonl, or a folder searched recursively for *.jsonl
  FILE   a settings.json (permissions.deny) or a profile template (filesystem.deny);
         default: templates/profiles/developer-senior.json

It reads every Bash tool call of the transcripts, runs the hook's own find_denied on it, and
prints the count and every call the hook WOULD have denied, tagged:
  already   the plain (un-normalised) command is denied by the same rule: the engine refuses it today too
  NEW       only the normalised form matches: a call the engine lets through and the hook would stop
A NEW line is the one to read: it is either the bypass we mean to close or a false block.
COVERAGE (acrobot 36401, 2026-10-26): a transcript this user cannot read is NOT "zero calls". The
script counts the files and folders it could not open and prints them on a COVERAGE line; when it
could read no transcript at all, or no Bash call, it stops with exit code 3 instead of reporting a 0
that looks like a clean result. A partial read exits 0 with the unreadable count in plain sight.
Read-only: it never runs a command and prints no more than 160 characters of one.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dng", os.path.join(HERE, "hooks", "deny-normalizing-gate.py"))
dng = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dng)


def load_rules(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    raw = (d.get("permissions") or {}).get("deny") or (d.get("filesystem") or {}).get("deny") or []
    home = os.environ.get("HOME", "/home/marveen")
    out = []
    for r in raw:
        r = r.replace("${HOME}", "/home/marveen")
        p = dng.parse_rule(r)
        if p:
            out.append((r, p))
    return out


UNREADABLE = []  # (path, why): files and folders that could not be opened


def transcripts(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
        elif os.path.isdir(p):
            for root, _, files in os.walk(p, onerror=lambda e: UNREADABLE.append((str(e.filename), "folder"))):
                for f in files:
                    if f.endswith(".jsonl"):
                        yield os.path.join(root, f)
        else:
            UNREADABLE.append((p, "missing"))


def bash_commands(path):
    """Yields the Bash commands of one transcript; None once if the file could not be opened."""
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        UNREADABLE.append((path, "file"))
        return
    with f:
        for line in f:
            if '"Bash"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            content = (d.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Bash":
                    cmd = (c.get("input") or {}).get("command")
                    if isinstance(cmd, str):
                        yield cmd


def literal_denied(cmd, rules):
    """what the engine sees: each simple command's own tokens, no unwrapping"""
    try:
        parts = dng.split_commands(cmd)
    except dng.Undecomposable:
        return False
    import shlex
    for part in parts:
        try:
            toks = shlex.split(part, posix=True)
        except ValueError:
            continue
        while toks and dng.ENV_ASSIGN.match(toks[0]):
            toks = toks[1:]
        if toks and any(dng.matches(r, toks) for _, r in rules):
            return True
    return False


def main(argv):
    rules_path = os.path.join(HERE, "..", "templates", "profiles", "developer-senior.json")
    args = argv[1:]
    if args[:1] == ["--rules"]:
        rules_path, args = args[1], args[2:]
    if not args:
        print(__doc__)
        return 2
    rules = load_rules(rules_path)
    total = files = readable = 0
    hits = []
    for t in transcripts(args):
        files += 1
        for cmd in bash_commands(t):
            total += 1
            hit = dng.find_denied(cmd, rules)
            if hit:
                hits.append((("already" if literal_denied(cmd, rules) else "NEW"), hit[0], cmd))
        if (t, "file") not in UNREADABLE:
            readable += 1
    print(f"rules: {len(rules)} from {os.path.normpath(rules_path)}")
    print(f"transcripts: {files}, Bash calls: {total}, the hook would deny: {len(hits)} "
          f"(NEW: {sum(1 for h in hits if h[0] == 'NEW')}, already denied today: {sum(1 for h in hits if h[0] == 'already')})")
    for tag, rule, cmd in hits:
        print(f"  [{tag}] {rule} <- {' '.join(cmd.split())[:160]}")
    print(f"COVERAGE: transcripts found {files}, read {readable}, NOT readable {len(UNREADABLE)} "
          f"(files or folders this user cannot open)")
    for path, why in UNREADABLE[:10]:
        print(f"  [unreadable {why}] {path}")
    if len(UNREADABLE) > 10:
        print(f"  ... and {len(UNREADABLE) - 10} more")
    if readable == 0 or total == 0:
        print("NO RESULT: no transcript could be read (or none held a Bash call), so the 0 above is NOT "
              "'nothing would be denied'. Run it as a user that can read the transcripts.")
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
