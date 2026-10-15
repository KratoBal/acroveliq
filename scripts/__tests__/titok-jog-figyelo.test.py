#!/usr/bin/env python3
# Guard for scripts/titok-jog-figyelo.py, the permission-change watcher (Security Baseline M-3;
# acrobot 31244). WHAT TURNS THIS RED:
#   - a change in the matrix (new or gone file, mode, owner, group, a new or lost reader, a new fleet
#     user, an ACL or "?" cell) not reported, or reported with another wording than the literal lines here;
#   - an unchanged matrix not silent (output, or an exit other than 0);
#   - a missing state recording a silent baseline (barracuda, #193) instead of HIBA and exit 2 with
#     nothing written; a baseline taken any way but --alap; a --alap over a state not printing what
#     it absorbs; an unknown argument writing anything;
#   - a change alerting twice (the state not moved on after a run);
#   - a mismatch with os.access, or an unreadable state, touching the state or exiting other than 2;
#   - the state not 0600, a secret's content in the output or the state, or a network call.
import importlib.util, io, json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..")
WATCHER = os.path.join(SCRIPTS, "titok-jog-figyelo.py")
NL = chr(10)

fails = 0
def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " (got %r, want %r)" % (got, want)))

def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

w = load(WATCHER, "watcher")

def row(f, mode="600", owner="marveen", group="marveen", **readers):
    return {"file": f, "owner": owner, "group": group, "mode": mode, "readers": readers}

print("the diff, on literal states")
base = {"users": ["marveen", "agent-x"], "rows": [
    row(".a-token", marveen="IGEN", **{"agent-x": "nem"}),
    row(".b-key", "640", group="sec", marveen="IGEN", **{"agent-x": "IGEN"}),
    row(".c-old", marveen="IGEN", **{"agent-x": "nem"}),
    row(".d-acl", marveen="IGEN", **{"agent-x": "nem"}),
]}
check("no change: no line", [], w.diff(base, json.loads(json.dumps(base))))
new = {"users": ["marveen", "agent-x", "agent-y"], "rows": [
    row(".a-token", "644", marveen="IGEN", **{"agent-x": "IGEN", "agent-y": "IGEN"}),
    row(".b-key", "640", owner="agent-x", group="fleet", marveen="IGEN", **{"agent-x": "nem", "agent-y": "nem"}),
    row(".d-acl", marveen="?", **{"agent-x": "ACL", "agent-y": "ACL"}),
    row(".e-new", "640", group="sec", marveen="IGEN", **{"agent-x": "nem", "agent-y": "IGEN"}),
]}
check("every kind of change, in this order and wording", [
    "UJ FELHASZNALO agent-y: olvas 2 titkot (.a-token, .e-new)",
    "UJ FAJL .e-new: marveen sec 640, olvassa: agent-y, marveen",
    "ELTUNT FAJL .c-old",
    "MOD .a-token: 600 helyett 644",
    "UJ OLVASO .a-token: agent-x",
    "TULAJDONOS .b-key: marveen helyett agent-x",
    "CSOPORT .b-key: sec helyett fleet",
    "ELVESZETT .b-key: agent-x mar nem olvassa",
    "ACL .d-acl: agent-x nem helyett ACL",
    "ACL .d-acl: marveen IGEN helyett ?",
], w.diff(base, new))

T = tempfile.mkdtemp(prefix="titok-jog-")
try:
    os.chmod(T, 0o755)
    store = os.path.join(T, "store"); os.makedirs(store); os.chmod(store, 0o755)
    state = os.path.join(T, "allapot.json")
    def put(name, mode):
        p = os.path.join(store, name)
        open(p, "w").write("TITOK-ERTEK-%s%s" % (name, NL))
        os.chmod(p, mode)
    for name, mode in {".a-token": 0o600, ".b-key": 0o640, ".c-secret": 0o644}.items():
        put(name, mode)
    stub = os.path.join(T, "stub"); os.makedirs(stub)
    open(os.path.join(stub, "sitecustomize.py"), "w").write(NL.join([
        "import urllib.request, socket",
        "def no(*a, **k): raise AssertionError('network called')",
        "urllib.request.urlopen = no",
        "socket.create_connection = no", ""]))
    env = {**os.environ, "FLEET_ROOT": T, "TITOK_JOG_STATE": state, "PYTHONPATH": stub}
    seen = []
    def run(*args):
        r = subprocess.run([sys.executable, "-B", WATCHER, *args], capture_output=True, text=True, env=env)
        seen.append(r.stdout + r.stderr)
        return r.returncode, r.stdout.strip()

    print("a real run on a scratch store")
    rc, out = run()
    check("no state: HIBA, exit 2, no state file written (not a silent baseline)", (2, True, False),
          (rc, out.startswith("HIBA: nincs elozo allapot"), os.path.exists(state)))
    rc, out = run("--alapp")
    check("an unknown argument: usage, exit 2, nothing written", (2, True, False),
          (rc, out.startswith("HASZNALAT:"), os.path.exists(state)))
    rc, out = run("--alap")
    check("--alap records the baseline and says so, exit 0", (0, True, 1),
          (rc, out.startswith("ALAP felveve: 3 titok, "), len(out.splitlines())))
    check("the state is 0600", "600", oct(os.stat(state).st_mode)[-3:])
    check("an unchanged matrix: silent, exit 0", (0, ""), run())
    os.chmod(os.path.join(store, ".a-token"), 0o644)
    rc, out = run()
    lines = out.splitlines()
    # the host's own fleet users may add UJ OLVASO lines for the same file (a CI runner has none);
    # the reader lines themselves are checked below, with injected users
    check("a mode change: exit 1, the MOD line first, nothing about another file", (1, "MOD .a-token: 600 helyett 644", True),
          (rc, lines[0] if lines else "", all(l.startswith("UJ OLVASO .a-token: ") for l in lines[1:])))
    check("the same change does not alert twice", (0, ""), run())
    put(".e-token", 0o600)
    os.remove(os.path.join(store, ".c-secret"))
    rc, out = run()
    check("a new and a gone file", (1, [".e-token", "ELTUNT FAJL .c-secret"]),
          (rc, [out.splitlines()[0].split(":")[0].replace("UJ FAJL ", ""), out.splitlines()[1]]))
    check("no secret content in any output", False, any("TITOK-ERTEK" in s for s in seen))
    check("no secret content in the state", False, "TITOK-ERTEK" in open(state).read())
    check("no network (a stubbed urlopen would raise)", False, any("network called" in s for s in seen))

    print("an unreadable state is exit 2, and the state is not replaced")
    open(state, "w").write("{nem json")
    rc, out = run()
    check("exit 2, a HIBA line, the state as it was", (2, True, "{nem json"),
          (rc, out.startswith("HIBA:"), open(state).read()))
    rc, out = run("--alap")
    check("--alap over an unreadable state: overwritten, and it says so", (0, True),
          (rc, out.endswith("ALAPBA: az elozo allapot nem volt olvashato (JSONDecodeError), felulirva")))
    os.remove(state)
    rc, out = run()
    check("a removed state is exit 2 again, not a new baseline", (2, False), (rc, os.path.exists(state)))
    run("--alap")

    # the cases below use their own users, not the host's: a CI runner has no fleet users
    print("a new reader, with injected users")
    import pwd as _pwd
    me = _pwd.getpwuid(os.getuid()).pw_name
    users = lambda: [(me, os.getuid(), set(os.getgroups()) | {os.getgid()}), ("kulso", 2 ** 31 - 7, {2 ** 31 - 7})]
    os.environ["FLEET_ROOT"] = T
    w.STATE = state
    real_load = w.load_matrix
    def injected():
        fs = load(os.path.join(SCRIPTS, "fleet-secrets.py"), "fleet_secrets_t")
        fs.fleet_users = users
        return fs.matrix_rows()
    w.load_matrix = injected
    def main_quiet(argv=None):
        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf
        try:
            rc = w.main(argv or [])
        finally:
            sys.stdout = old
        return rc, buf.getvalue().strip()
    try:
        os.remove(state)
        rc, out = main_quiet(["--alap"])
        check("baseline with the injected users (--alap)", (0, True), (rc, out.startswith("ALAP felveve:")))
        os.chmod(os.path.join(store, ".b-key"), 0o644)
        check("640 to 644: the outsider is a new reader", (1, "MOD .b-key: 640 helyett 644" + NL + "UJ OLVASO .b-key: kulso"),
              main_quiet())
        os.chmod(os.path.join(store, ".b-key"), 0o640)
        check("and back: the reader is lost", (1, "MOD .b-key: 644 helyett 640" + NL + "ELVESZETT .b-key: kulso mar nem olvassa"),
              main_quiet())

        os.chmod(os.path.join(store, ".b-key"), 0o644)
        check("--alap over a readable state: the absorbed change is printed, not swallowed", (0, ["ALAPBA: MOD .b-key: 640 helyett 644", "ALAPBA: UJ OLVASO .b-key: kulso"]),
              (lambda r: (r[0], r[1].splitlines()[1:]))(main_quiet(["--alap"])))
        check("and after it the same matrix is silent", (0, ""), main_quiet())
        os.chmod(os.path.join(store, ".b-key"), 0o640)
        main_quiet()

        print("a mismatch with os.access is exit 2, and the state is not touched")
        before = open(state, "rb").read()
        os.chmod(os.path.join(store, ".b-key"), 0o644)
        orig_access = os.access
        os.access = lambda p, m: False
        try:
            rc, out = main_quiet()
        finally:
            os.access = orig_access
        check("exit 2, a HIBA line, the state byte for byte", (2, True, before),
              (rc, out.startswith("HIBA:"), open(state, "rb").read()))
    finally:
        w.load_matrix = real_load
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
