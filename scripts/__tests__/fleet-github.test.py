#!/usr/bin/env python3
# Guard for the D4 step 2 fleet side: scripts/root/fleet-github.py (the token broker),
# scripts/root/fleet-approve.py (the guarded approver), scripts/git-credential-fleet-github and the
# FLEET_GITHUB_APP switch in scripts/pr-beolvaszt.sh. WHAT TURNS THIS RED:
#   - a role carrying workflows or administration, or push carrying pull-request write;
#   - a token printed for a caller, repository, owner or role the root config does not allow, or with a
#     config or key that is not root-owned (the key also not 0600), or GitHub asked at all then;
#   - a token wider than asked (an extra permission, a write for a read, another repository) passed on;
#   - the token or the key in the log;
#   - a JWT that openssl cannot verify with the App's public key, or claims outside GitHub's ten minutes;
#   - an approval without the caller's own latest APPROVE on exactly that repo#PR, on a head that is not
#     the reviewed one, on a closed PR or a non-main base, or not pinned to the head (commit_id);
#   - the credential helper answering another host, a missing path, a store call, or a broker refusal
#     with a password, or missing the last line without a newline;
#   - pr-beolvaszt.sh reading the owner token file with the switch on.
import importlib.util, json, os, shutil, subprocess, sys, tempfile, types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..", "..")
NL = chr(10)


def load(rel, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


gh = load("scripts/root/fleet-github.py", "fleet_github")
ap = load("scripts/root/fleet-approve.py", "fleet_approve")

fails = 0
def check(name, want, got):
    global fails
    ok = want == got
    fails += 0 if ok else 1
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " (got %r, want %r)" % (got, want)))


def fake_stat(modes):
    """getstat: path -> a root-owned regular file with the given mode (default 0600)."""
    def getstat(path):
        mode = modes.get(path, 0o600)
        if mode is None:
            raise OSError("missing")
        return types.SimpleNamespace(st_mode=0o100000 | mode, st_uid=modes.get(path + ":uid", 0))
    return getstat


T = tempfile.mkdtemp(prefix="fleet-github-")
try:
    print("the broker: roles")
    check("no role carries workflows, administration, secrets or webhooks", [],
          [(r, k) for r, p in gh.ROLE_PERMISSIONS.items() for k in p if k in gh.NEVER])
    check("push cannot write pull requests", None, gh.ROLE_PERMISSIONS["push"].get("pull_requests"))
    check("olvas is read only", {"read"}, set(gh.ROLE_PERMISSIONS["olvas"].values()))
    for bad in (["token", "KratoBal/acroveliq"], ["token", "KratoBal/acroveliq", "admin"], ["token", "acroveliq", "push"],
                ["tok", "KratoBal/acroveliq", "push"], ["token", "KratoBal/a;b", "push"]):
        try:
            gh.parse(bad); got = "parsed"
        except ValueError:
            got = "usage"
        check("usage: %s" % " ".join(bad), "usage", got)

    print("the broker: the JWT")
    key, pub = os.path.join(T, "app-key.pem"), os.path.join(T, "app-pub.pem")
    subprocess.run(["openssl", "genrsa", "-out", key, "2048"], check=True, capture_output=True)
    subprocess.run(["openssl", "rsa", "-in", key, "-pubout", "-out", pub], check=True, capture_output=True)
    token = gh.jwt("4242", gh.openssl_sign(key), now=1_800_000_000)
    head, payload, sig = token.split(".")
    import base64
    dec = lambda s: base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    check("claims: iat a minute back, exp nine minutes on, iss the app id",
          {"iat": 1_800_000_000 - 60, "exp": 1_800_000_000 + 540, "iss": "4242"}, json.loads(dec(payload)))
    check("header RS256", {"alg": "RS256", "typ": "JWT"}, json.loads(dec(head)))
    open(os.path.join(T, "sig"), "wb").write(dec(sig))
    v = subprocess.run(["openssl", "dgst", "-sha256", "-verify", pub, "-signature", os.path.join(T, "sig")],
                       input=("%s.%s" % (head, payload)).encode(), capture_output=True)
    check("openssl verifies the signature with the public key", 0, v.returncode)

    print("the broker: run")
    cfg_path, log_path = os.path.join(T, "app.json"), os.path.join(T, "fleet-github.log")
    json.dump({"app_id": "4242", "installation_id": 77, "owner": "KratoBal", "repos": ["acroveliq", "acropora-os"],
               "callers": {"agent-nautilus": {"acroveliq": ["push", "pr", "olvas"]}, "marveen": {"*": ["beolvaszt", "olvas"]}}},
              open(cfg_path, "w"))
    calls = []
    def post_ok(perm_override=None, repos_override=None):
        def post(url, jwt_token, body):
            calls.append((url, body))
            perms = perm_override if perm_override is not None else body["permissions"]
            return 201, {"token": "ghs_SECRET_TOKEN_VALUE", "expires_at": "2026-10-15T13:00:00Z", "permissions": perms,
                         "repositories": [{"name": r} for r in (repos_override or body["repositories"])]}
        return post
    def env(caller, post, modes=None):
        return {"config_file": cfg_path, "key_file": key, "log_file": log_path, "caller": caller, "post": post,
                "sign": lambda b: b"sig", "getstat": fake_stat(modes or {})}
    code, out = gh.run(["token", "KratoBal/acroveliq", "push"], env("agent-nautilus", post_ok()))
    check("an allowed push: exit 0, the token alone on stdout", (0, "ghs_SECRET_TOKEN_VALUE"), (code, out))
    check("asked for exactly the one repository and the role's permissions",
          ("https://api.github.com/app/installations/77/access_tokens", {"repositories": ["acroveliq"], "permissions": gh.ROLE_PERMISSIONS["push"]}),
          calls[-1])
    code, _ = gh.run(["token", "KratoBal/acropora-os", "beolvaszt"], env("marveen", post_ok()))
    check("the merger through the '*' rule", 0, code)
    n = len(calls)
    for argv, caller, modes, why in [
        (["token", "KratoBal/acroveliq", "beolvaszt"], "agent-nautilus", {}, "a role not granted"),
        (["token", "KratoBal/acropora-os", "push"], "agent-nautilus", {}, "a repository not granted"),
        (["token", "KratoBal/acroveliq", "push"], "agent-barracuda", {}, "a caller not listed"),
        (["token", "Other/acroveliq", "push"], "agent-nautilus", {}, "another owner"),
        (["token", "KratoBal/secret-repo", "olvas"], "marveen", {}, "a repository not in the fleet list"),
        (["token", "KratoBal/acroveliq", "push"], "agent-nautilus", {cfg_path: 0o664}, "a group-writable config"),
        (["token", "KratoBal/acroveliq", "push"], "agent-nautilus", {cfg_path + ":uid": 1000}, "a config not owned by root"),
        (["token", "KratoBal/acroveliq", "push"], "agent-nautilus", {key: 0o640}, "a key readable by its group"),
        (["token", "KratoBal/acroveliq", "push"], "agent-nautilus", {key: None}, "no key"),
    ]:
        code, out = gh.run(argv, env(caller, post_ok(), modes))
        check("refused (%s): exit 10" % why, 10, code)
    check("and GitHub was not asked for any of them", n, len(calls))
    code, _ = gh.run(["token", "KratoBal/acroveliq", "push"], env("agent-nautilus", post_ok({"contents": "write", "metadata": "read", "pull_requests": "write"})))
    check("a token with an extra permission: exit 13, not printed", 13, code)
    code, _ = gh.run(["token", "KratoBal/acroveliq", "olvas"], env("agent-nautilus", post_ok({**gh.ROLE_PERMISSIONS["olvas"], "contents": "write"})))
    check("a write where a read was asked: exit 13", 13, code)
    code, _ = gh.run(["token", "KratoBal/acroveliq", "push"], env("agent-nautilus", post_ok(repos_override=["acroveliq", "acropora-os"])))
    check("a token for more repositories: exit 13", 13, code)
    code, _ = gh.run(["token", "KratoBal/acroveliq", "push"], env("agent-nautilus", lambda u, j, b: (422, {"message": "permissions not granted"})))
    check("GitHub refusing: exit 13", 13, code)
    logged = open(log_path).read()
    check("the log never holds the token or the key", (False, False), ("ghs_SECRET_TOKEN_VALUE" in logged, "PRIVATE KEY" in logged))
    check("the log names an issued token by a short digest", True, '"token_sha256_8"' in logged)

    print("the approver")
    items = [
        {"source": "event", "kind": "verdict", "actor": "barracuda", "ref": "CHANGES KratoBal/acroveliq#198 pr-marveen198 fej d075898", "at": 10},
        {"source": "event", "kind": "verdict", "actor": "barracuda", "ref": "APPROVE KratoBal/acroveliq#198 pr-marveen198 fej 021c2a7", "at": 20},
        {"source": "event", "kind": "verdict", "actor": "barracuda", "ref": "APPROVE KratoBal/acroveliq#1980 pr-marveen1980 fej aaaaaaa", "at": 30},
        {"source": "event", "kind": "verdict", "actor": "nautilus", "ref": "APPROVE KratoBal/acroveliq#198 pr-marveen198 fej bbbbbbb", "at": 40},
    ]
    check("the latest verdict, by the actor, on exactly #198 (not #1980, not another actor)",
          ("APPROVE", "021c2a7"), ap.latest_verdict(items, "barracuda", "KratoBal", "acroveliq", 198))
    acfg = {"owner": "KratoBal", "repos": ["acroveliq"], "approvers": ["agent-barracuda"]}
    pr_open = {"state": "open", "base": {"ref": "main"}, "head": {"sha": "021c2a7af0a92c30c3c13327b0ea5b4623da5078"}}
    posted = []
    def decide(caller="agent-barracuda", its=items, pr=pr_open, repo="acroveliq", num=198):
        try:
            return ap.decide(acfg, caller, "KratoBal", repo, num, "t-x", lambda t: its, lambda o, r, n: pr,
                             lambda o, r, n, b: posted.append((o, r, n, b)))
        except ap.Refused as e:
            return "refused: " + str(e).split(":")[0]
    check("approves the reviewed head", "021c2a7af0a92c30c3c13327b0ea5b4623da5078", decide())
    check("the review is APPROVE pinned to the head", ("APPROVE", "021c2a7af0a92c30c3c13327b0ea5b4623da5078"),
          (posted[-1][3]["event"], posted[-1][3]["commit_id"]))
    n = len(posted)
    check("not an approver", True, decide(caller="agent-nautilus").startswith("refused"))
    check("the latest verdict is CHANGES", True, decide(its=items[:1]).startswith("refused"))
    check("no verdict on this PR", True, decide(num=199).startswith("refused"))
    check("a push after the review", True, decide(pr={**pr_open, "head": {"sha": "f" * 40}}).startswith("refused"))
    check("a closed PR", True, decide(pr={**pr_open, "state": "closed"}).startswith("refused"))
    check("a base other than main", True, decide(pr={**pr_open, "base": {"ref": "develop"}}).startswith("refused"))
    check("not a fleet repository", True, decide(repo="other").startswith("refused"))
    check("and nothing was posted for any of them", n, len(posted))
    acfg_path = os.path.join(T, "approve.json"); json.dump(acfg, open(acfg_path, "w"))
    aenv = {"config_file": acfg_path, "log_file": os.path.join(T, "approve.log"), "caller": "agent-barracuda",
            "get_timeline": lambda t: items, "get_pr": lambda o, r, n: pr_open, "post_review": lambda *a: None,
            "getstat": fake_stat({acfg_path: 0o644})}
    check("run: approved, exit 0", 0, ap.run(["approve", "KratoBal/acroveliq", "198", "t-x"], aenv)[0])
    check("run: usage, exit 2", 2, ap.run(["approve", "KratoBal/acroveliq", "x", "t-x"], aenv)[0])
    check("run: a group-writable config, exit 10", 10, ap.run(["approve", "KratoBal/acroveliq", "198", "t-x"],
          {**aenv, "getstat": fake_stat({acfg_path: 0o664})})[0])

    print("the credential helper")
    helper = os.path.join(T, "git-credential-fleet-github")
    fake_broker = os.path.join(T, "broker")
    open(fake_broker, "w").write(NL.join(["#!/bin/sh", 'if [ "$2" = KratoBal/refused ]; then exit 10; fi',
                                          'printf "TOKEN-%s-%s-%s" "$1" "$2" "$3"', ""]))
    os.chmod(fake_broker, 0o755)
    src = open(os.path.join(ROOT, "scripts", "git-credential-fleet-github")).read()
    assert src.count("BROKER=/usr/local/sbin/fleet-github") == 1 and src.count('SUDO="sudo -n"') == 1
    open(helper, "w").write(src.replace("BROKER=/usr/local/sbin/fleet-github", "BROKER=" + fake_broker).replace('SUDO="sudo -n"', 'SUDO=""'))
    os.chmod(helper, 0o755)
    def cred(text, verb="get"):
        r = subprocess.run(["bash", helper, verb], input=text, capture_output=True, text=True)
        return r.returncode, r.stdout, r.stderr
    q = NL.join(["protocol=https", "host=github.com", "path=KratoBal/acroveliq.git", "", ""])
    check("a GitHub repository: x-access-token and the push token for exactly it",
          (0, "username=x-access-token" + NL + "password=TOKEN-token-KratoBal/acroveliq-push" + NL), cred(q)[:2])
    no_final_newline = "protocol=https" + NL + "host=github.com" + NL + "path=KratoBal/acroveliq"
    check("the last line without a newline is still read", "password=TOKEN-token-KratoBal/acroveliq-push",
          (cred(no_final_newline)[1].splitlines() + ["", ""])[1])
    rc, out, err = cred(NL.join(["protocol=https", "host=github.com", "", ""]))
    check("no path: nothing for git, a hint on stderr", ("", True), (out, "useHttpPath" in err))
    check("another host: nothing", "", cred(q.replace("github.com", "gitlab.com"))[1])
    check("plain http: nothing", "", cred(q.replace("https", "http"))[1])
    check("a store call: nothing", "", cred(q, "store")[1])
    rc, out, err = cred(q.replace("acroveliq", "refused"))
    check("a broker refusal: no password, said on stderr, exit 0", (0, "", True), (rc, out, "no token" in err))

    print("pr-beolvaszt.sh: the switch")
    pb = open(os.path.join(ROOT, "scripts", "pr-beolvaszt.sh")).read()
    start = pb.index('if [ "${FLEET_GITHUB_APP:-off}" = on ]; then')
    end = pb.index(NL + "fi" + NL, start) + len(NL + "fi" + NL)
    block = pb[start:end]
    tokfile = os.path.join(T, "owner-token"); open(tokfile, "w").write("OWNER-TOKEN")
    assert block.count("/home/marveen/marveen/store/.github-token") == 1
    block = block.replace("/home/marveen/marveen/store/.github-token", tokfile)
    bindir = os.path.join(T, "bin"); os.makedirs(bindir)
    open(os.path.join(bindir, "sudo"), "w").write(NL.join(["#!/bin/sh", 'echo "APP-$@"', ""]))
    os.chmod(os.path.join(bindir, "sudo"), 0o755)
    def switch(value):
        script = 'REPO=KratoBal/acroveliq' + NL + block + 'printf "%s" "$TOK"' + NL
        e = {**os.environ, "PATH": bindir + ":" + os.environ["PATH"]}
        if value is not None:
            e["FLEET_GITHUB_APP"] = value
        else:
            e.pop("FLEET_GITHUB_APP", None)
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=e).stdout
    check("switch on: the broker's merge token, the owner file not read",
          "APP--n /usr/local/sbin/fleet-github token KratoBal/acroveliq beolvaszt", switch("on"))
    check("switch off (the default): the owner token, as before", "OWNER-TOKEN", switch(None))
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
