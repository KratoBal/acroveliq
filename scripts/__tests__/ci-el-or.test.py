#!/usr/bin/env python3
# Guard for scripts/ci-el-or.sh's token-expiry line (acrobot 31196; barracuda, V-GH-1 v3). WHAT TURNS
# THIS RED: a token expiring within 14 days without a RIASZT line and exit 1; one far off reported as
# an alarm; a missing expiry header not named; a missing header claimed when no call answered; the
# runs check (the script's first job) changing its verdict. Those are the OWNER token's (FLEET_GITHUB_APP=off).
# With the default (the broker, 2026-10-16): the broker not asked for exactly the repository and olvas;
# a broker token's one-hour expiry reported as an alarm; a broker refusal silent or without its reason;
# a 401 on the broker's token not an alarm.
# The real script runs in a copy of the tree with a fake token; GitHub is a stub of
# urllib.request.urlopen, loaded through sitecustomize (test-only, no seam in the script).
import json, os, shutil, subprocess, sys, tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "ci-el-or.sh")

STUB = r"""
import io, json, os, urllib.request, urllib.error
FX = json.load(open(os.environ["CI_ELOR_FIXTURE"]))
class Resp(io.BytesIO):
    def __init__(self, body, headers):
        super().__init__(json.dumps(body).encode()); self.headers = headers
    def __enter__(self): return self
    def __exit__(self, *a): self.close()
class H(dict):
    def get(self, k, d=None):
        for kk, v in self.items():
            if kk.lower() == k.lower(): return v
        return d
def urlopen(req, timeout=None):
    url = req.full_url
    if FX.get("fail"):
        raise urllib.error.URLError("down")
    if FX.get("http"):
        code, body = FX["http"]
        raise urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(json.dumps({"message": body}).encode()))
    hdr = H({"github-authentication-token-expiration": FX["expiry"]} if FX.get("expiry") else {})
    if url.endswith("/commits/main"):
        return Resp({"sha": "abcdef1234567890", "commit": {"committer": {"date": FX["head"]}}}, hdr)
    if "/actions/runs" in url:
        return Resp({"workflow_runs": [{"created_at": FX["run"]}]}, hdr)
    raise AssertionError("unexpected " + url)
urllib.request.urlopen = urlopen
"""

fails = 0
def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " (got %r, want %r)" % (got, want)))

now = datetime.now(timezone.utc)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
gh = lambda d: d.strftime("%Y-%m-%d %H:%M:%S UTC")
T = tempfile.mkdtemp(prefix="ci-el-or-")
try:
    os.makedirs(os.path.join(T, "scripts")); os.makedirs(os.path.join(T, "store")); os.makedirs(os.path.join(T, "stub"))
    shutil.copy(SCRIPT, os.path.join(T, "scripts", "ci-el-or.sh"))
    # the script reads ROOT from a fixed path; point it at the copy
    p = os.path.join(T, "scripts", "ci-el-or.sh")
    s = open(p).read().replace("ROOT=/home/marveen/marveen", "ROOT=" + T)
    open(p, "w").write(s)
    open(os.path.join(T, "store", ".github-token"), "w").write("teszt\n")
    # the token library the script loads from ROOT/scripts/lib: a copy, its owner file the test one, the
    # broker a fake (no real token is minted where the real broker is installed)
    os.makedirs(os.path.join(T, "scripts", "lib"))
    calls = os.path.join(T, "broker-calls")
    fake = os.path.join(T, "broker")
    open(fake, "w").write("#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + calls + "\n"
                          "case \"$2\" in KratoBal/refused) echo 'fleet-github: refused: not a fleet repository' >&2; exit 10 ;; esac\n"
                          "printf 'ghs_FAKE'\n")
    os.chmod(fake, 0o755)
    lib = open(os.path.join(HERE, "..", "lib", "github_token.py")).read()
    for a, b in (("OWNER_TOKEN_FILE = '/home/marveen/marveen/store/.github-token'", "OWNER_TOKEN_FILE = " + repr(os.path.join(T, "store", ".github-token"))),
                 ("BROKER = '/usr/local/sbin/fleet-github'", "BROKER = " + repr(fake)), ("SUDO = ['sudo', '-n']", "SUDO = []")):
        assert lib.count(a) == 1, a
        lib = lib.replace(a, b)
    open(os.path.join(T, "scripts", "lib", "github_token.py"), "w").write(lib)
    open(os.path.join(T, "stub", "sitecustomize.py"), "w").write(STUB)
    def run(fx, switch="off", repo="KratoBal/acroveliq"):
        f = os.path.join(T, "fx.json"); json.dump(fx, open(f, "w"))
        env = {k: v for k, v in os.environ.items() if k != "FLEET_GITHUB_APP"}
        if switch is not None:
            env["FLEET_GITHUB_APP"] = switch
        r = subprocess.run(["bash", p, repo], capture_output=True, text=True,
                           env={**env, "PYTHONPATH": os.path.join(T, "stub"), "CI_ELOR_FIXTURE": f})
        return r.returncode, r.stdout.splitlines()
    healthy = {"head": iso(now - timedelta(hours=2)), "run": iso(now - timedelta(hours=1))}

    print("the runs check is unchanged")
    check("the copy points at the test tree", 1, s.count("ROOT=" + T))
    rc, out = run({**healthy, "expiry": gh(now + timedelta(days=100))})
    check("a healthy repo: OK line", True, any(l.startswith("OK KratoBal/acroveliq") for l in out))

    print("the token expiry")
    check("far off (100 days): OK token line, exit 0", (0, True), (rc, any(l.startswith("OK token: lejar ") for l in out)))
    rc, out = run({**healthy, "expiry": gh(now + timedelta(days=10))})
    check("within 14 days (10): RIASZT token line, exit 1", (1, True), (rc, any(l.startswith("RIASZT token:") and "10 nap" in l for l in out)))
    rc, out = run({**healthy, "expiry": gh(now + timedelta(days=14, hours=-1))})
    check("on the edge (just under 14 days): RIASZT", 1, rc)
    rc, out = run({**healthy, "expiry": gh(now + timedelta(days=15))})
    check("just over (15 days): no alarm", 0, rc)
    rc, out = run({**healthy, "expiry": gh(now - timedelta(days=1))})
    check("already expired: RIASZT", (1, True), (rc, any(l.startswith("RIASZT token:") for l in out)))
    rc, out = run(healthy)
    check("no expiry header: a HIBA token line, not an alarm", (0, True), (rc, any(l.startswith("HIBA token: a valaszokon nincs lejarat-fejlec") for l in out)))
    rc, out = run({**healthy, "expiry": "holnap"})
    check("an unreadable header: HIBA token line", True, any(l.startswith("HIBA token: a lejarat-fejlec nem olvashato") for l in out))
    rc, out = run({**healthy, "http": [401, "Bad credentials"]})
    check("an expired or revoked token (401): RIASZT token line, exit 1", (1, True), (rc, any(l.startswith("RIASZT token: a GitHub elutasitja") for l in out)))
    rc, out = run({**healthy, "http": [403, "Bad credentials"]})
    check("403 Bad credentials: the same", (1, True), (rc, any(l.startswith("RIASZT token: a GitHub elutasitja") for l in out)))
    rc, out = run({**healthy, "http": [403, "Resource not accessible by personal access token"]})
    check("another 403 (a missing permission) is no token alarm", (0, False), (rc, any(l.startswith("RIASZT token") for l in out)))
    rc, out = run({**healthy, "fail": True})
    check("no call answered: no token line at all (the repo HIBA says enough)", [], [l for l in out if " token" in l.split(":")[0]])

    print("the default: the broker (2026-10-16)")
    if os.path.exists(calls):
        os.unlink(calls)
    rc, out = run({**healthy, "expiry": gh(now + timedelta(hours=1))}, switch=None)
    check("unset: the broker asked for exactly the repository and olvas", ["token KratoBal/acroveliq olvas"], open(calls).read().splitlines())
    check("... the runs check as before, and a one-hour expiry is no alarm (no token line), exit 0",
          (0, True, []), (rc, any(l.startswith("OK KratoBal/acroveliq") for l in out), [l for l in out if " token" in l.split(":")[0]]))
    rc, out = run(healthy, switch=None, repo="KratoBal/refused")
    check("a broker refusal: RIASZT for the repository with the broker's reason, exit 1",
          (1, True), (rc, any(l.startswith("RIASZT KratoBal/refused: nincs olvas token") and "not a fleet repository" in l for l in out)))
    rc, out = run({**healthy, "http": [401, "Bad credentials"]}, switch=None)
    check("a 401 on the broker's token: RIASZT token naming the App, exit 1",
          (1, True), (rc, any(l.startswith("RIASZT token: a GitHub elutasitja a broker tokenjet") for l in out)))
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
