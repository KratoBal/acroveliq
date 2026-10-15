#!/usr/bin/env python3
# Guard for scripts/lib/github-token.sh and scripts/lib/github_token.py, the owner token's retirement,
# PR 1 (docs/fleet-github.md). WHAT TURNS THIS RED:
#   - the switch off not giving the owner token file's content, or an empty or missing file passing as a token;
#   - the switch on not asking the broker for exactly `token <owner/repo> <role>`, or a broker refusal or an
#     empty answer passing as a token (an empty Authorization header is a silent unauthenticated call);
#   - a malformed repository or an unknown role reaching the broker;
#   - a fleet script reading store/.github-token directly, outside the known list below (a new reader would
#     break at the owner token's revocation without anyone knowing).
import importlib.util, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..")
NL = chr(10)
fails = 0


def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " (got %r, want %r)" % (got, want)))


T = tempfile.mkdtemp(prefix="github-token-")
try:
    owner = os.path.join(T, "owner-token"); open(owner, "w").write("OWNER-TOKEN" + NL)
    calls = os.path.join(T, "calls")
    broker = os.path.join(T, "broker")
    open(broker, "w").write(NL.join([
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> ' + calls,
        'case "$2" in KratoBal/refused) exit 10 ;; KratoBal/empty) exit 0 ;; esac',
        'printf "APP-%s-%s" "$2" "$3"', ""]))
    os.chmod(broker, 0o755)

    print("the bash helper")
    src = open(os.path.join(SCRIPTS, "lib", "github-token.sh")).read()
    for line in ("GITHUB_OWNER_TOKEN_FILE=/home/marveen/marveen/store/.github-token", "GITHUB_TOKEN_BROKER=/usr/local/sbin/fleet-github", 'GITHUB_TOKEN_SUDO="sudo -n"'):
        assert src.count(line) == 1, line
    lib = os.path.join(T, "github-token.sh")
    open(lib, "w").write(src.replace("GITHUB_OWNER_TOKEN_FILE=/home/marveen/marveen/store/.github-token", "GITHUB_OWNER_TOKEN_FILE=" + owner)
                         .replace("GITHUB_TOKEN_BROKER=/usr/local/sbin/fleet-github", "GITHUB_TOKEN_BROKER=" + broker)
                         .replace('GITHUB_TOKEN_SUDO="sudo -n"', 'GITHUB_TOKEN_SUDO=""'))

    def sh(repo, role, switch=None):
        env = {k: v for k, v in os.environ.items() if k != "FLEET_GITHUB_APP"}
        if switch:
            env["FLEET_GITHUB_APP"] = switch
        r = subprocess.run(["bash", "-c", '. "$0"; github_token "$1" "$2"', lib, repo, role], capture_output=True, text=True, env=env)
        return r.returncode, r.stdout

    def ncalls():
        return len(open(calls).read().splitlines()) if os.path.exists(calls) else 0

    check("off: the owner token file", (0, "OWNER-TOKEN" + NL), sh("KratoBal/acroveliq", "olvas"))
    check("off: the broker is not asked", 0, ncalls())
    check("on: the broker, for exactly the repository and the role", (0, "APP-KratoBal/acroveliq-push" + NL), sh("KratoBal/acroveliq", "push", "on"))
    check("on: the broker's argv", "token KratoBal/acroveliq push", open(calls).read().splitlines()[-1])
    check("on: a refusal is non-zero and prints nothing", (1, ""), sh("KratoBal/refused", "olvas", "on"))
    check("on: an empty answer is not a token", (1, ""), sh("KratoBal/empty", "olvas", "on"))
    n = ncalls()
    check("a malformed repository: 2", 2, sh("acroveliq", "olvas", "on")[0])
    check("an unknown role: 2", 2, sh("KratoBal/acroveliq", "admin", "on")[0])
    check("and the broker was not asked for either", n, ncalls())
    open(owner, "w").write("")
    check("off: an empty owner file is not a token", (1, ""), sh("KratoBal/acroveliq", "olvas"))
    os.remove(owner)
    check("off: a missing owner file is not a token", (1, ""), sh("KratoBal/acroveliq", "olvas"))
    open(owner, "w").write("OWNER-TOKEN" + NL)

    print("the python helper")
    spec = importlib.util.spec_from_file_location("github_token", os.path.join(SCRIPTS, "lib", "github_token.py"))
    gt = importlib.util.module_from_spec(spec); spec.loader.exec_module(gt)
    gt.BROKER, gt.SUDO, gt.OWNER_TOKEN_FILE = broker, [], owner

    def py(repo, role, switch=None):
        if switch:
            os.environ["FLEET_GITHUB_APP"] = switch
        else:
            os.environ.pop("FLEET_GITHUB_APP", None)
        try:
            return gt.github_token(repo, role)
        except gt.GithubTokenError:
            return "ERROR"
        finally:
            os.environ.pop("FLEET_GITHUB_APP", None)

    check("off: the owner token file", "OWNER-TOKEN", py("KratoBal/acroveliq", "olvas"))
    check("on: the broker", "APP-KratoBal/acroveliq-olvas", py("KratoBal/acroveliq", "olvas", "on"))
    check("on: a refusal raises", "ERROR", py("KratoBal/refused", "olvas", "on"))
    check("on: an empty answer raises", "ERROR", py("KratoBal/empty", "olvas", "on"))
    check("a malformed repository raises", "ERROR", py("acroveliq", "olvas", "on"))

    print("who still names the owner token file")
    known = {
        "lib/github-token.sh", "lib/github_token.py",   # the helpers: the switch-off branch
        "ci-el-or.sh",                                   # watches the owner token's expiry; retires with it
        "pr-beolvaszt.sh",                               # its own switch (D4 step 2), the off branch
        "git-auth.sh",                                   # the off branch; on, plain git and the credential helper
        "github-pr-monitor.sh",                          # the off branch's fallback
    }
    found = set()
    for root, dirs, files in os.walk(SCRIPTS):
        dirs[:] = [d for d in dirs if d not in ("__tests__", "__pycache__", "root")]
        for f in files:
            if not (f.endswith(".sh") or f.endswith(".py") or f.endswith(".mjs")):
                continue
            path = os.path.join(root, f)
            code = [l for l in open(path, encoding="utf-8", errors="replace").read().splitlines() if not l.lstrip().startswith("#")]
            if any("store/.github-token" in l for l in code):
                found.add(os.path.relpath(path, SCRIPTS))
    check("no reader outside the known list (a new direct reader is red)", [], sorted(found - known))
    check("and every known entry still reads it (a stale list hides nothing)", [], sorted(known - found))
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
