#!/usr/bin/env python3
# Guard for scripts/ci-el-or.sh's token-expiry line (acrobot 31196; barracuda, V-GH-1 v3). WHAT TURNS
# THIS RED: a token expiring within 14 days without a RIASZT line and exit 1; one far off reported as
# an alarm; a missing expiry header not named; a missing header claimed when no call answered; the
# runs check (the script's first job) changing its verdict.
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
    open(os.path.join(T, "stub", "sitecustomize.py"), "w").write(STUB)
    def run(fx):
        f = os.path.join(T, "fx.json"); json.dump(fx, open(f, "w"))
        r = subprocess.run(["bash", p, "KratoBal/acroveliq"], capture_output=True, text=True,
                           env={**os.environ, "PYTHONPATH": os.path.join(T, "stub"), "CI_ELOR_FIXTURE": f})
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
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
