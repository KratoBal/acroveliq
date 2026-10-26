#!/usr/bin/env python3
# Guard for scripts/deny-gate-dryrun.py (acrobot 36401, 2026-10-26). WHAT TURNS THIS RED: a transcript
# the user cannot read counted as "zero calls" (a false clean result), no COVERAGE line, a run that read
# nothing exiting 0, or a readable transcript's NEW denial going missing.
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "deny-gate-dryrun.py")
fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " (got %r, want %r)" % (got, want)))


def transcript(path, commands):
    with open(path, "w") as f:
        for c in commands:
            f.write(json.dumps({"message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": c}}]}}) + "\n")


def run(*paths):
    r = subprocess.run([sys.executable, "-B", SCRIPT, *paths], capture_output=True, text=True)
    return r.returncode, r.stdout


T = tempfile.mkdtemp(prefix="dryrun-")
try:
    good = os.path.join(T, "good.jsonl")
    transcript(good, ["ls -la", "bash -c 'git push --force -h'", "git push --force -h"])
    rc, out = run(good)
    check("a readable transcript: exit 0, the NEW and the already-denied counted", (0, True, True),
          (rc, "NEW: 1, already denied today: 1" in out, "read 1, NOT readable 0" in out))

    empty = os.path.join(T, "nobash.jsonl")
    open(empty, "w").write(json.dumps({"message": {"content": [{"type": "text", "text": "hi"}]}}) + "\n")
    rc, out = run(empty)
    check("readable but holding no Bash call: NOT a result, exit 3", (3, True), (rc, "NO RESULT" in out))

    rc, out = run(os.path.join(T, "missing"))
    check("a path that does not exist: exit 3, named on the COVERAGE line", (3, True),
          (rc, "[unreadable missing]" in out))

    if os.geteuid() != 0:
        locked = os.path.join(T, "locked.jsonl")
        transcript(locked, ["bash -c 'sudo true'"])
        os.chmod(locked, 0)
        rc, out = run(locked)
        check("only an unreadable transcript: exit 3, never a quiet 0", (3, True, True),
              (rc, "NO RESULT" in out, "NOT readable 1" in out))
        rc, out = run(good, locked)
        check("one readable and one not: exit 0, but the unreadable one is in plain sight", (0, True, True),
              (rc, "read 1, NOT readable 1" in out, "[unreadable file] " + locked in out))
        d = os.path.join(T, "dir")
        os.makedirs(os.path.join(d, "sealed"))
        transcript(os.path.join(d, "ok.jsonl"), ["env sudo true"])
        os.chmod(os.path.join(d, "sealed"), 0)
        rc, out = run(d)
        check("an unreadable FOLDER is counted too", (0, True), (rc, "NOT readable 1" in out))
        os.chmod(os.path.join(d, "sealed"), 0o700)
        os.chmod(locked, 0o600)
    else:
        print("  [SKIP] running as root: the unreadable-file cases cannot be built")
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
