#!/usr/bin/env python3
# Guard for scripts/mobil-ota.sh: the fleet publishes no production OTA update (Balázs's D5 decision,
# variant A, 2026-10-15 12:24 UTC; task t-20261015-mobil-ota-eles-zar). WHAT TURNS THIS RED:
#   - `kiadas` on any branch but `preview` (production, the default; orzo-meres; a misspelt name)
#     reaching npx, the clone or the token instead of stopping with exit 5;
#   - the printed line for Balázs missing, or not pinned to eas-cli@24.8.0;
#   - `kiadas` on `preview`, or the dry run, stopped by the guard (they must go on);
#   - an `eas-cli@latest` anywhere in the script.
import os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "mobil-ota.sh")

fails = 0
def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " (got %r, want %r)" % (got, want)))

T = tempfile.mkdtemp(prefix="mobil-ota-")
try:
    stub = os.path.join(T, "bin"); os.makedirs(stub)
    marker = os.path.join(T, "npx-hivas")
    with open(os.path.join(stub, "npx"), "w") as f:
        f.write("#!/usr/bin/env bash\necho \"$@\" >> %s\nexit 0\n" % marker)
    os.chmod(os.path.join(stub, "npx"), 0o755)

    def run(args, **env):
        e = {**os.environ, "PATH": stub + ":" + os.environ["PATH"], "MOBIL_KLON": os.path.join(T, "nincs-klon"), **env}
        if os.path.exists(marker):
            os.remove(marker)
        r = subprocess.run(["bash", SCRIPT, *args], capture_output=True, text=True, env=e)
        return r.returncode, r.stdout + r.stderr, os.path.exists(marker)

    print("kiadas outside preview: exit 5, nothing runs, the line for Balázs is printed")
    for name, args, env in [
        ("the default branch (production)", ["kiadas", "javitas"], {}),
        ("production, named", ["kiadas", "javitas"], {"OTA_AG": "production"}),
        ("the unbound orzo-meres branch", ["kiadas", "javitas"], {"OTA_AG": "orzo-meres"}),
        ("a misspelt preview", ["kiadas", "javitas"], {"OTA_AG": "Preview"}),
        ("production without a message", ["kiadas"], {}),
    ]:
        rc, out, called = run(args, **env)
        check(name, (5, False, False, True, True),
              (rc, called, "NINCS KLON" in out, "npx eas-cli@24.8.0 update --branch" in out, out.startswith("MEGALLOK:")))
    rc, out, _ = run(["kiadas", "javitas"])
    check("the printed line names the branch, the environment and the message",
          True, "--branch production --environment production" in out and '--message "javitas"' in out)

    print("preview and the dry run pass the guard")
    rc, out, called = run(["kiadas", "javitas"], OTA_AG="preview")
    check("kiadas on preview goes on to the clone (no clone here: exit 1)", (1, True, False), (rc, "NINCS KLON" in out, called))
    rc, out, called = run([])
    check("the dry run goes on to the clone", (1, True, False), (rc, "NINCS KLON" in out, called))

    print("no unpinned eas-cli")
    check("no eas-cli@latest in the script", False, "eas-cli@latest" in open(SCRIPT, encoding="utf-8").read())
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
