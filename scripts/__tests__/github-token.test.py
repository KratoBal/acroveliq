#!/usr/bin/env python3
# Guard for scripts/lib/github-token.sh and scripts/lib/github_token.py, the owner token's retirement,
# PR 1 (docs/fleet-github.md). WHAT TURNS THIS RED:
#   - the switch off not giving the owner token file's content, or an empty or missing file passing as a token;
#   - the switch on not asking the broker for exactly `token <owner/repo> <role>`, or a broker refusal or an
#     empty answer passing as a token (an empty Authorization header is a silent unauthenticated call);
#   - a malformed repository or an unknown role reaching the broker;
#   - a fleet script reading store/.github-token directly, outside the known list below (a new reader would
#     break at the owner token's revocation without anyone knowing);
#   - git-auth.sh with the switch on: a read (fetch, pull, ls-remote, clone) going out without the broker's
#     olvas token for exactly the remote's repository, the header not scoped to https://github.com/, a
#     push carrying a read header (it would push with the read token), a broker refusal falling back to
#     an anonymous fetch, or a remote that is not a GitHub repository reaching the broker.
import importlib.util, os, re, shutil, subprocess, sys, tempfile

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

    check("off: the owner token file", (0, "OWNER-TOKEN" + NL), sh("KratoBal/acroveliq", "olvas", "off"))
    check("off: the broker is not asked", 0, ncalls())
    check("UNSET (the default since 2026-10-16): the broker, not the owner file", (0, "APP-KratoBal/acroveliq-olvas" + NL), sh("KratoBal/acroveliq", "olvas"))
    check("any value but off (a typo, 'yes', an empty string): the broker", [(0, "APP-KratoBal/acroveliq-olvas" + NL)] * 3,
          [sh("KratoBal/acroveliq", "olvas", v) for v in ("Off", "yes", " ")])
    check("on: the broker, for exactly the repository and the role", (0, "APP-KratoBal/acroveliq-push" + NL), sh("KratoBal/acroveliq", "push", "on"))
    check("on: the broker's argv", "token KratoBal/acroveliq push", open(calls).read().splitlines()[-1])
    check("on: a refusal is non-zero and prints nothing", (1, ""), sh("KratoBal/refused", "olvas", "on"))
    check("on: an empty answer is not a token", (1, ""), sh("KratoBal/empty", "olvas", "on"))
    n = ncalls()
    check("a malformed repository: 2", 2, sh("acroveliq", "olvas", "on")[0])
    check("an unknown role: 2", 2, sh("KratoBal/acroveliq", "admin", "on")[0])
    check("and the broker was not asked for either", n, ncalls())
    open(owner, "w").write("")
    check("off: an empty owner file is not a token", (1, ""), sh("KratoBal/acroveliq", "olvas", "off"))
    os.remove(owner)
    check("off: a missing owner file is not a token", (1, ""), sh("KratoBal/acroveliq", "olvas", "off"))
    check("the default with a broker refusal: non-zero, never the owner file", (1, ""), sh("KratoBal/refused", "olvas"))
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

    check("off: the owner token file", "OWNER-TOKEN", py("KratoBal/acroveliq", "olvas", "off"))
    check("UNSET (the default): the broker", "APP-KratoBal/acroveliq-olvas", py("KratoBal/acroveliq", "olvas"))
    check("the default with a broker refusal: raises, never the owner file", "ERROR", py("KratoBal/refused", "olvas"))
    check("on: the broker", "APP-KratoBal/acroveliq-olvas", py("KratoBal/acroveliq", "olvas", "on"))
    check("on: a refusal raises", "ERROR", py("KratoBal/refused", "olvas", "on"))
    check("on: an empty answer raises", "ERROR", py("KratoBal/empty", "olvas", "on"))
    check("a malformed repository raises", "ERROR", py("acroveliq", "olvas", "on"))

    print("git-auth.sh with the switch on (the D4 step list step 10)")
    gdir = os.path.join(T, "ga", "scripts"); os.makedirs(os.path.join(gdir, "lib"))
    shutil.copy(lib, os.path.join(gdir, "lib", "github-token.sh"))
    ga_src = open(os.path.join(SCRIPTS, "git-auth.sh")).read()
    ga_src = ga_src.replace('TOKEN_FILE="/home/marveen/marveen/store/.github-token"', 'TOKEN_FILE="' + owner + '"')
    open(os.path.join(gdir, "git-auth.sh"), "w").write(ga_src)
    fakebin = os.path.join(T, "ga", "bin"); os.makedirs(fakebin)
    seen = os.path.join(T, "ga", "seen")
    open(os.path.join(fakebin, "git"), "w").write(NL.join([
        "#!/bin/bash",
        'ALL="$*"',
        'if [ "$1" = -C ]; then shift 2; fi',
        'if [ "$1 $2" = "remote get-url" ]; then case "$3" in origin) echo https://github.com/KratoBal/acroveliq.git ;; up) echo https://github.com/KratoBal/acropora-os ;; gl) echo https://gitlab.com/x/y.git ;; *) exit 2 ;; esac; exit 0; fi',
        'printf "args=%s|count=%s|key=%s|value=%s\\n" "$ALL" "${GIT_CONFIG_COUNT:-}" "${GIT_CONFIG_KEY_0:-}" "${GIT_CONFIG_VALUE_0:-}" >> ' + seen,
        ""]))
    os.chmod(os.path.join(fakebin, "git"), 0o755)
    import base64
    def ga(*args, switch="on"):
        if os.path.exists(seen):
            os.unlink(seen)
        n0 = ncalls()
        env = {k: v for k, v in os.environ.items() if k != "FLEET_GITHUB_APP"}
        env["PATH"] = fakebin + ":" + env["PATH"]
        if switch:
            env["FLEET_GITHUB_APP"] = switch
        r = subprocess.run(["bash", os.path.join(gdir, "git-auth.sh")] + list(args), capture_output=True, text=True, env=env)
        got = open(seen).read().strip() if os.path.exists(seen) else ""
        asked = open(calls).read().splitlines()[n0:] if os.path.exists(calls) else []
        return r.returncode, got, asked, r.stderr
    def basic(repo):
        return "Authorization: Basic " + base64.b64encode(("x-access-token:APP-%s-olvas" % repo).encode()).decode()
    rc, got, asked, _ = ga("-C", "/x", "fetch", "origin")
    check("on: fetch asks the broker for olvas on exactly the remote's repository", ["token KratoBal/acroveliq olvas"], asked)
    check("on: ... and git gets that token as the Basic header, scoped to https://github.com/",
          (0, "args=-C /x fetch origin|count=1|key=http.https://github.com/.extraHeader|value=" + basic("KratoBal/acroveliq")), (rc, got))
    rc, got, asked, _ = ga("pull", "--ff-only", "up", "main")
    check("on: pull past an option, another remote name: that remote's repository", (["token KratoBal/acropora-os olvas"], 0), (asked, rc))
    rc, got, asked, _ = ga("ls-remote")
    check("on: no remote named: origin", ["token KratoBal/acroveliq olvas"], asked)
    rc, got, asked, _ = ga("clone", "https://github.com/KratoBal/acropora-ai-agent.git", "/tmp/x")
    check("on: clone of a GitHub URL: that repository", ["token KratoBal/acropora-ai-agent olvas"], asked)
    rc, got, asked, _ = ga("-C", "/x", "push", "origin", "HEAD")
    check("on: a push gets NO header and asks nothing here (the credential helper gives the push token)",
          (0, [], "args=-C /x push origin HEAD|count=|key=|value="), (rc, asked, got))
    rc, got, asked, err = ga("fetch", "gl")
    check("on: a remote that is not GitHub: stop, the broker not asked, git not run", (1, [], ""), (rc, asked, got))
    rc, got, asked, err = ga("clone", "/some/local/path")
    check("on: a clone that is not a GitHub URL: stop", (1, [], ""), (rc, asked, got))
    open(os.path.join(fakebin, "remote-refused"), "w").close()
    src_git = open(os.path.join(fakebin, "git")).read()
    open(os.path.join(fakebin, "git"), "w").write(src_git.replace("origin) echo https://github.com/KratoBal/acroveliq.git", "origin) echo https://github.com/KratoBal/refused.git"))
    rc, got, asked, err = ga("fetch", "origin")
    check("on: the broker refuses: stop, NO anonymous fetch", (1, "", True), (rc, got, "nem fetch-elek nevtelenul" in err))
    open(os.path.join(fakebin, "git"), "w").write(src_git)
    rc, got, asked, _ = ga("fetch", "origin", switch=None)
    check("UNSET (the default since 2026-10-16): a fetch asks the broker, like on", (0, ["token KratoBal/acroveliq olvas"]), (rc, asked))
    rc, got, asked, _ = ga("fetch", "origin", switch="off")
    check("off: the owner token file, as before, for any command", (0, [], "value=" + "Authorization: Basic " + base64.b64encode(b"x-access-token:OWNER-TOKEN").decode()),
          (rc, asked, got[got.index("value="):] if "value=" in got else got))

    print("who still names the owner token file")
    known = {
        "lib/github-token.sh", "lib/github_token.py",   # the helpers: the switch-off branch
        "ci-el-or.sh",                                   # watches the owner token's expiry; retires with it
        "pr-beolvaszt.sh",                               # its own switch (D4 step 2), the off branch
        "git-auth.sh",                                   # the off branch; on, the broker (reads) or the credential helper (push)
        "github-pr-monitor.sh",                          # the off branch's fallback
        "fleet-secrets.py",                              # reads it for the expiry header; retires with it
    }
    # THE FILE NAME, NOT THE LITERAL PATH (2026-10-15): matching "store/.github-token" let
    # fleet-secrets.py through, which opens os.path.join(STORE, ".github-token"). The name with a
    # word boundary after it catches a joined path too, and leaves .github-token-commerce out (a
    # different token, outside this guard).
    owner_name = re.compile(r"\.github-token(?![-\w])")
    found = set()
    for root, dirs, files in os.walk(SCRIPTS):
        dirs[:] = [d for d in dirs if d not in ("__tests__", "__pycache__", "root")]
        for f in files:
            if not (f.endswith(".sh") or f.endswith(".py") or f.endswith(".mjs")):
                continue
            path = os.path.join(root, f)
            code = [l for l in open(path, encoding="utf-8", errors="replace").read().splitlines() if not l.lstrip().startswith("#")]
            if any(owner_name.search(l) for l in code):
                found.add(os.path.relpath(path, SCRIPTS))
    check("no reader outside the known list (a new direct reader is red)", [], sorted(found - known))
    check("and every known entry still reads it (a stale list hides nothing)", [], sorted(known - found))
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
