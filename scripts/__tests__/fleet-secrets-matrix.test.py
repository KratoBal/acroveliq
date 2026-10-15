#!/usr/bin/env python3
# Guard for scripts/fleet-secrets.py --matrix (Security Baseline F0-2; acrobot 31236). WHAT TURNS THIS RED:
#   - the read decision not following the kernel's order (owner class alone, then group, then others),
#     or ignoring the directory's x bit;
#   - a file with an ACL getting a computed answer instead of "ACL";
#   - the runner's own computed row disagreeing with os.access, without exit 2;
#   - the matrix mode opening a secret file's content or calling the network;
#   - the matrix covering another file set than the inventory's own filter.
import importlib.util, io, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "fleet-secrets.py")
spec = importlib.util.spec_from_file_location("fs", SCRIPT)
fs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fs)

fails = 0
def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " (got %r, want %r)" % (got, want)))

R, X = fs.READ, fs.EXEC
print("the kernel's order")
check("owner with r reads", True, fs.can(0o600, 10, 20, 10, {20}, R))
check("owner WITHOUT r is denied even if the group has r", False, fs.can(0o060, 10, 20, 10, {20}, R))
check("a group member reads 640", True, fs.can(0o640, 10, 20, 11, {20}, R))
check("a non-member does not read 640", False, fs.can(0o640, 10, 20, 11, {21}, R))
check("others read 644", True, fs.can(0o644, 10, 20, 11, {21}, R))
check("a group member WITHOUT group r is denied even if others have r", False, fs.can(0o604, 10, 20, 11, {20}, R))
check("root reads anything", True, fs.can(0o000, 10, 20, 0, {0}, R))
check("the directory x bit for others", False, fs.can(0o750, 10, 20, 11, {21}, X))

T = tempfile.mkdtemp(prefix="fleet-secrets-")
try:
    store = os.path.join(T, "store"); os.makedirs(store)
    files = {".a-token": 0o600, ".b-key": 0o640, ".c-secret": 0o644, ".d-password": 0o000, "not-a-secret": 0o644, ".notes": 0o644}
    for name, mode in files.items():
        p = os.path.join(store, name)
        open(p, "w").write("TITOK-ERTEK-%s\n" % name)
        os.chmod(p, mode)
    stub = os.path.join(T, "stub"); os.makedirs(stub)
    open(os.path.join(stub, "sitecustomize.py"), "w").write(
        "import urllib.request, builtins\n"
        "def no(*a, **k): raise AssertionError('network called')\n"
        "urllib.request.urlopen = no\n")
    env = {**os.environ, "FLEET_ROOT": T, "PYTHONPATH": stub}
    r = subprocess.run([sys.executable, SCRIPT, "--matrix"], capture_output=True, text=True, env=env)
    out = r.stdout
    print("on a scratch store, run for real")
    check("exit 0, the runner's row matches os.access", 0, r.returncode)
    check("no secret value printed", False, "TITOK-ERTEK" in out + r.stderr)
    check("no network (a stubbed urlopen would raise)", False, "network called" in r.stderr)
    listed = [l.split()[0] for l in out.splitlines() if l.startswith(".")]
    fs.STORE = store
    check("the same file set as the inventory's filter", fs.secret_names(), listed)
    check("the filter keeps the four secret names", [".a-token", ".b-key", ".c-secret", ".d-password"], listed)
    me = __import__("pwd").getpwuid(os.getuid()).pw_name.replace("agent-", "")
    header = [l for l in out.splitlines() if l.startswith("FAJL")][0].split()
    col = header.index(me) - 4 if me in header else None
    row = {l.split()[0]: l.split()[4:] for l in out.splitlines() if l.startswith(".")}
    if col is not None:
        check("my own column: 600, 640 and 644 IGEN, 000 nem", ["IGEN", "IGEN", "IGEN", "nem"],
              [row[f][col] for f in [".a-token", ".b-key", ".c-secret", ".d-password"]])
    else:
        print("  [SKIP] the runner is not a fleet user; the calibration line above still holds")

    # the in-process cases below use their own users, not the host's: a CI runner has no marveen or
    # agent-* user, and the matrix would have no column to check (the #190 CI run)
    import pwd as _pwd
    me_name = _pwd.getpwuid(os.getuid()).pw_name
    fs.fleet_users = lambda: [(me_name, os.getuid(), set(os.getgroups()) | {os.getgid()}), ("kulso", 2 ** 31 - 7, {2 ** 31 - 7})]
    col = 0
    print("the store directory's x bit counts")
    os.chmod(store, 0o700)
    try:
        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf
        try:
            fs.matrix()
        finally:
            sys.stdout = old
    finally:
        os.chmod(store, 0o755)
    c_line = [l for l in buf.getvalue().splitlines() if l.startswith(".c-secret")][0].split()[4:]
    others = [c for i, c in enumerate(c_line) if i != col]
    check("a 644 file in a 700 store: the outsider nem, the owner IGEN", (["nem"], "IGEN"), (others, c_line[col]))

    print("an ACL is not computed")
    orig = os.listxattr
    os.listxattr = lambda p: ["system.posix_acl_access"] if p.endswith(".b-key") else []
    try:
        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf
        try:
            fs.matrix()
        finally:
            sys.stdout = old
    finally:
        os.listxattr = orig
    acl_line = [l for l in buf.getvalue().splitlines() if l.startswith(".b-key")][0]
    check("the file with an ACL shows ACL for every user, not IGEN or nem", True,
          "ACL" in acl_line and "IGEN" not in acl_line and " nem" not in acl_line)

    print("an unreadable xattr list is ?, not a computed answer")
    orig = os.listxattr
    def raising(p):
        if p.endswith(".a-token"):
            raise PermissionError("no")
        return []
    os.listxattr = raising
    try:
        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf
        try:
            fs.matrix()
        finally:
            sys.stdout = old
    finally:
        os.listxattr = orig
    q_line = [l for l in buf.getvalue().splitlines() if l.startswith(".a-token")][0].split()[4:]
    check("the file whose xattr list cannot be read shows ? for every user", True, bool(q_line) and all(c == "?" for c in q_line))

    print("every ancestor directory counts, not only store/")
    os.chmod(T, 0o700)
    try:
        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf
        try:
            fs.matrix()
        finally:
            sys.stdout = old
    finally:
        os.chmod(T, 0o755)
    c_line = [l for l in buf.getvalue().splitlines() if l.startswith(".c-secret")][0].split()[4:]
    check("a 644 file in a 755 store under a 700 parent: the outsider nem", "nem", c_line[1])

    print("a mismatch with os.access is exit 2")
    orig_access = os.access
    os.access = lambda p, m: False
    try:
        buf = io.StringIO(); old = sys.stdout; sys.stdout = buf
        try:
            rc = fs.matrix()
        finally:
            sys.stdout = old
    finally:
        os.access = orig_access
    check("a computed IGEN that os.access denies: exit 2 and the file named", (2, True), (rc, "ELTERES" in buf.getvalue()))
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
