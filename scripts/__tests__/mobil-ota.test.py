#!/usr/bin/env python3
# Guard for scripts/mobil-ota.sh: the fleet publishes OTA updates to `preview` and, since 2026-10-21
# 12:44 UTC, to `production` too (Balázs raised the Expo robot to Release Manager; before it, his D5
# decision of 2026-10-15 kept production his). WHAT TURNS THIS RED:
#   - `kiadas` on any other branch (orzo-meres; a misspelt name) reaching npx, the clone or the token
#     instead of stopping with exit 5;
#   - the printed line for Balázs missing, or not pinned to eas-cli@24.8.0;
#   - `kiadas` on `preview` or `production`, or the dry run, stopped by the guard (they must go on);
#   - an `eas-cli@latest` anywhere in the script;
#   - the caller's text reaching the printed line raw (barracuda, #199): a branch or environment
#     outside the name pattern must print no command at all, the message must come back as ONE
#     shell word, letter for letter;
#   - `kiadas` on preview with any environment but preview going on (the pair rule);
#   - the platform selector (card a9054f30): an unknown OTA_PLATFORM going on, the chosen platform missing from
#     the printed line, the dry-run command or the publishing call, or the other platform's fingerprint computed.
import os, shlex, shutil, subprocess, sys, tempfile

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

    print("kiadas outside preview and production: exit 5, nothing runs, the line for Balázs is printed")
    for name, args, env in [
        ("the unbound orzo-meres branch", ["kiadas", "javitas"], {"OTA_AG": "orzo-meres"}),
        ("a misspelt preview", ["kiadas", "javitas"], {"OTA_AG": "Preview"}),
        ("a misspelt production", ["kiadas", "javitas"], {"OTA_AG": "Production"}),
        ("orzo-meres without a message", ["kiadas"], {"OTA_AG": "orzo-meres"}),
    ]:
        rc, out, called = run(args, **env)
        check(name, (5, False, False, True, True),
              (rc, called, "NINCS KLON" in out, "npx eas-cli@24.8.0 update --branch" in out, out.startswith("MEGALLOK:")))
    rc, out, _ = run(["kiadas", "javitas"], OTA_AG="orzo-meres")
    check("the printed line names the branch, the environment and the message",
          True, "--branch orzo-meres --environment orzo-meres" in out and "--message 'javitas'" in out)
    for name, env in [("preview with the production environment", {"OTA_AG": "preview", "OTA_VALTOZAT": "production"}),
                      ("production with the preview environment", {"OTA_AG": "production", "OTA_VALTOZAT": "preview"})]:
        rc, out, called = run(["kiadas", "javitas"], **env)
        check("the pair rule: %s stops" % name, (5, False, False), (rc, called, "NINCS KLON" in out))

    print("the caller's text never reaches the printed line raw (barracuda, #199)")
    for name, env in [("a branch with && and a pipe", {"OTA_AG": "production && curl x | sh"}),
                      ("a branch with a semicolon", {"OTA_AG": "production;id"}),
                      ("an environment with $(...)", {"OTA_VALTOZAT": "production$(id)"}),
                      ("a branch with a newline", {"OTA_AG": "production\nid"}),
                      ("a branch that starts with a dash (a new switch in the line)", {"OTA_AG": "--non-interactive"})]:
        for mode in (["kiadas", "javitas"], []):
            rc, out, called = run(mode, **env)
            check("%s (%s): exit 5, no command printed, nothing runs" % (name, mode[0] if mode else "szaraz"),
                  (5, False, False, False), (rc, "eas-cli@" in out, called, "NINCS KLON" in out))
    nasty = "proba\" ; touch /tmp/pwn ; echo \"$(id)` x\\ 'y"
    rc, out, _ = run(["kiadas", nasty], OTA_AG="orzo-meres")
    line = [l for l in out.splitlines() if l.strip().startswith("--message ")]
    check("a message with quotes, $(...) and a backtick comes back as one shell word, letter for letter",
          [["--message", nasty]], [shlex.split(l) for l in line])

    print("preview, production and the dry run pass the guard")
    rc, out, called = run(["kiadas", "javitas"], OTA_AG="preview")
    # it passes the pair rule, so its environment defaulted to preview (production would stop it, see above)
    check("kiadas on preview goes on to the clone (no clone here: exit 1): its environment is preview",
          (1, True, False), (rc, "NINCS KLON" in out, called))
    for name, args, env in [("the default branch (production)", ["kiadas", "javitas"], {}),
                            ("production, named", ["kiadas", "javitas"], {"OTA_AG": "production"}),
                            ("production without a message", ["kiadas"], {})]:
        rc, out, called = run(args, **env)
        check("kiadas on %s goes on to the clone (no clone here: exit 1)" % name, (1, True, False), (rc, "NINCS KLON" in out, called))
    rc, out, called = run([])
    check("the dry run goes on to the clone", (1, True, False), (rc, "NINCS KLON" in out, called))

    print("the platform selector (card a9054f30): all | ios | android, nothing else")
    for name, args in [("szaraz", []), ("kiadas", ["kiadas", "javitas"])]:
        rc, out, called = run(args, OTA_PLATFORM="mindketto")
        check("an unknown platform (%s): exit 2 before the clone, nothing runs" % name,
              (2, False, False), (rc, called, "NINCS KLON" in out))
    rc, out, called = run(["kiadas", "javitas"], OTA_AG="orzo-meres", OTA_PLATFORM="android")
    check("the printed line for Balázs names the platform",
          True, "--branch orzo-meres --environment orzo-meres --platform android" in out)

    # a clone the script accepts: its head is origin/main, the tree is clean, apps/mobile exists
    klon = os.path.join(T, "klon")
    os.makedirs(os.path.join(klon, "apps", "mobile"))
    g = lambda *a: subprocess.run(["git", "-C", klon, *a], check=True, capture_output=True)
    g("init", "-q"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x")
    g("update-ref", "refs/remotes/origin/main", "HEAD")

    def dry(platform=None):
        env = {"MOBIL_KLON": klon}
        if platform is not None:
            env["OTA_PLATFORM"] = platform
        rc, out, _ = run([], **env)
        calls = open(marker).read().splitlines() if os.path.exists(marker) else []
        return rc, out, calls

    rc, out, calls = dry("ios")
    check("dry run, ios: exit 0, the command names --platform ios",
          (0, True), (rc, "--branch production --environment production --platform ios" in out))
    check("dry run, ios: only the ios fingerprint is computed",
          [["--platform", "ios"]], [c.split()[-2:] for c in calls])
    check("dry run, ios: no android line", False, "  android   " in out)
    rc, out, calls = dry("android")
    check("dry run, android: only the android fingerprint, and the android line",
          ([["--platform", "android"]], True, False),
          ([c.split()[-2:] for c in calls], "  android   " in out, "  ios       " in out))
    rc, out, calls = dry()
    check("dry run, default: --platform all, both fingerprints (today's behaviour), and the OOM hint",
          (0, True, [["--platform", "ios"], ["--platform", "android"]], True),
          (rc, "--platform all" in out, [c.split()[-2:] for c in calls], "OTA_PLATFORM=ios, majd OTA_PLATFORM=android" in out))

    # the publishing call itself needs the Expo token, which the test cannot read: its shape is read from the source
    forras = open(SCRIPT, encoding="utf-8").read()
    hivas = forras[forras.index("npx --yes eas-cli@24.8.0 update \\\n  --branch"):]
    hivas = hivas[: hivas.index("--non-interactive")]
    check("the publishing call passes --platform \"$PLATFORM\"", True, '--platform "$PLATFORM"' in hivas)

    print("no unpinned eas-cli")
    check("no eas-cli@latest in the script", False, "eas-cli@latest" in open(SCRIPT, encoding="utf-8").read())
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
