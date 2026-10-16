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
#   - an approval without the caller's own latest recorded APPROVE on exactly that repo#PR and task, on a
#     head that is not the reviewed one, on a closed PR or a non-main base, or not pinned to the head;
#   - a verdict recorded for a non-approver, a non-fleet repository, or with a head that is not 40 hex;
#   - the root record read or written through a symlink, or when it is not its owner's alone (0700/0600),
#     or a malformed line skipped instead of failing;
#   - the credential helper answering another host, a missing path, a store call, or a broker refusal
#     with a password, or missing the last line without a newline;
#   - pr-beolvaszt.sh reading the owner token file with the switch on.
import importlib.util, json, os, re, shutil, subprocess, sys, tempfile, types

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
    H = "021c2a7af0a92c30c3c13327b0ea5b4623da5078"
    def rec(verdict, head, actor="barracuda", pr=198, task="t-x", repo="acroveliq"):
        return {"ts": 1, "actor": actor, "owner": "KratoBal", "repo": repo, "pr": pr, "task": task,
                "verdict": verdict, "head": head}
    items = [rec("CHANGES", "d" * 40), rec("APPROVE", H), rec("APPROVE", "a" * 40, pr=1980),
             rec("APPROVE", "b" * 40, actor="nautilus"), rec("APPROVE", "e" * 40, task="t-other")]
    check("the latest verdict, by the actor, on exactly #198 in this task (not #1980, another actor or task)",
          ("APPROVE", H), ap.latest_verdict(items, "barracuda", "KratoBal", "acroveliq", 198, "t-x"))
    check("latest by the file's order: a CHANGES after an APPROVE wins, whatever its ts",
          ("CHANGES", "d" * 40), ap.latest_verdict([{**items[1], "ts": 9_999_999_999}, items[0]],
                                                   "barracuda", "KratoBal", "acroveliq", 198, "t-x"))
    check("a recorded 7-character head is not a verdict here", None,
          ap.latest_verdict([rec("APPROVE", H[:7])], "barracuda", "KratoBal", "acroveliq", 198, "t-x"))
    check("a pr given as a string is not this pr", None,
          ap.latest_verdict([{**items[1], "pr": "198"}], "barracuda", "KratoBal", "acroveliq", 198, "t-x"))
    acfg = {"owner": "KratoBal", "repos": ["acroveliq"], "approvers": ["agent-barracuda"]}
    pr_open = {"state": "open", "base": {"ref": "main"}, "head": {"sha": H}}
    posted = []
    def decide(caller="agent-barracuda", its=items, pr=pr_open, repo="acroveliq", num=198, task="t-x"):
        try:
            return ap.decide(acfg, caller, "KratoBal", repo, num, task, lambda: its, lambda o, r, n: pr,
                             lambda o, r, n, b: posted.append((o, r, n, b)))
        except ap.Refused as e:
            return "refused: " + str(e).split(":")[0]
    check("approves the reviewed head", H, decide())
    check("the review is APPROVE pinned to the head", [("APPROVE", H)], [(b["event"], b["commit_id"]) for *_, b in posted[-1:]])
    n = len(posted)
    check("not an approver", True, decide(caller="agent-nautilus").startswith("refused"))
    check("the latest verdict is CHANGES", True, decide(its=items[:2][::-1]).startswith("refused"))
    check("no verdict on this PR: refused for THAT reason", True, decide(num=199).startswith("refused: no recorded verdict"))
    check("no verdict in this task: refused for THAT reason (another task's APPROVE does not count)", True,
          decide(its=items[:2] + [rec("APPROVE", H, task="t-other")], task="t-y").startswith("refused: no recorded verdict"))
    check("an empty record (a recreated container) refuses", True, decide(its=[]).startswith("refused: no recorded verdict"))
    check("a push after the review", True, decide(pr={**pr_open, "head": {"sha": "f" * 40}}).startswith("refused"))
    check("a head that only shares the reviewed prefix", True,
          decide(pr={**pr_open, "head": {"sha": H[:7] + "0" * 33}}).startswith("refused"))
    check("a closed PR", True, decide(pr={**pr_open, "state": "closed"}).startswith("refused"))
    check("a base other than main", True, decide(pr={**pr_open, "base": {"ref": "develop"}}).startswith("refused"))
    check("not a fleet repository", True, decide(repo="other").startswith("refused"))
    check("and nothing was posted for any of them", n, len(posted))

    print("the approver: the root record file (as the test user, standing in for root)")
    me = os.getuid()
    rdir = os.path.join(T, "record")
    ap.append_record(rec("CHANGES", "d" * 40), rdir, me)
    ap.append_record(rec("APPROVE", H), rdir, me)
    check("the directory is made 0700, the file 0600",
          (0o700, 0o600), (os.stat(rdir).st_mode & 0o777, os.stat(os.path.join(rdir, "verdicts.jsonl")).st_mode & 0o777))
    got = ap.read_records(rdir, me)
    check("read back in the order written", [("CHANGES", "d" * 40), ("APPROVE", H)], [(r["verdict"], r["head"]) for r in got])
    check("no directory: no verdicts, nothing made", ([], False),
          (ap.read_records(os.path.join(T, "none"), me), os.path.exists(os.path.join(T, "none"))))
    def failed(fn):
        try:
            fn()
            return "passed"
        except ap.Failed as e:
            return "failed"
    other = me + 1
    check("a record owned by another uid: refused on read and on write", ("failed", "failed"),
          (failed(lambda: ap.read_records(rdir, other)), failed(lambda: ap.append_record(rec("APPROVE", H), rdir, other))))
    os.chmod(os.path.join(rdir, "verdicts.jsonl"), 0o640)
    check("a group-readable record: refused", ("failed", "failed"),
          (failed(lambda: ap.read_records(rdir, me)), failed(lambda: ap.append_record(rec("APPROVE", H), rdir, me))))
    os.chmod(os.path.join(rdir, "verdicts.jsonl"), 0o600)
    os.chmod(rdir, 0o750)
    check("a directory open to the group: refused", "failed", failed(lambda: ap.read_records(rdir, me)))
    os.chmod(rdir, 0o700)
    ldir = os.path.join(T, "linked")
    os.makedirs(ldir, 0o700)
    os.symlink(os.path.join(rdir, "verdicts.jsonl"), os.path.join(ldir, "verdicts.jsonl"))
    check("the file is a symlink: refused on read and on write", ("failed", "failed"),
          (failed(lambda: ap.read_records(ldir, me)), failed(lambda: ap.append_record(rec("APPROVE", H), ldir, me))))
    os.symlink(rdir, os.path.join(T, "dirlink"))
    check("the directory is a symlink: refused", "failed", failed(lambda: ap.read_records(os.path.join(T, "dirlink"), me)))
    with open(os.path.join(rdir, "verdicts.jsonl"), "a") as f:
        f.write("not json" + NL)
    check("a line that is not JSON: a failure, not a skip", "failed", failed(lambda: ap.read_records(rdir, me)))

    print("the approver: run, both verbs")
    acfg_path = os.path.join(T, "approve.json"); json.dump(acfg, open(acfg_path, "w"))
    store = []
    aenv = {"config_file": acfg_path, "log_file": os.path.join(T, "approve.log"), "caller": "agent-barracuda",
            "get_records": lambda: list(store), "append_record": store.append,
            "get_pr": lambda o, r, n: pr_open, "post_review": lambda *a: None,
            "getstat": fake_stat({acfg_path: 0o644})}
    check("run approve before any record: refused, exit 10", 10, ap.run(["approve", "KratoBal/acroveliq", "198", "t-x"], aenv)[0])
    check("run record APPROVE: exit 0", 0, ap.run(["record", "KratoBal/acroveliq", "198", "t-x", "APPROVE", H], aenv)[0])
    check("the record names the CALLER, not an argument", "barracuda", store[-1]["actor"])
    check("run approve after it: exit 0", 0, ap.run(["approve", "KratoBal/acroveliq", "198", "t-x"], aenv)[0])
    check("run record CHANGES, then approve: refused", (0, 10),
          (ap.run(["record", "KratoBal/acroveliq", "198", "t-x", "CHANGES", H], aenv)[0],
           ap.run(["approve", "KratoBal/acroveliq", "198", "t-x"], aenv)[0]))
    n = len(store)
    check("record by a non-approver: refused, nothing stored", (10, n),
          (ap.run(["record", "KratoBal/acroveliq", "198", "t-x", "APPROVE", H], {**aenv, "caller": "marveen"})[0], len(store)))
    check("record on a non-fleet repository: refused, nothing stored", (10, n),
          (ap.run(["record", "KratoBal/other", "198", "t-x", "APPROVE", H], aenv)[0], len(store)))
    for bad in (["record", "KratoBal/acroveliq", "198", "t-x", "MAYBE", H],
                ["record", "KratoBal/acroveliq", "198", "t-x", "APPROVE", H[:7]],
                ["record", "KratoBal/acroveliq", "198", "t-x", "APPROVE", H.upper()],
                ["record", "KratoBal/acroveliq", "198", "t-x", "APPROVE"],
                ["approve", "KratoBal/acroveliq", "198", "t-x", "APPROVE", H]):
        check("usage, exit 2, nothing stored: " + " ".join(bad[4:]) if len(bad) > 4 else "usage: " + bad[0],
              (2, n), (ap.run(bad, aenv)[0], len(store)))
    check("run: usage, exit 2", 2, ap.run(["approve", "KratoBal/acroveliq", "x", "t-x"], aenv)[0])
    check("run: a group-writable config, exit 10", 10, ap.run(["approve", "KratoBal/acroveliq", "198", "t-x"],
          {**aenv, "getstat": fake_stat({acfg_path: 0o664})})[0])
    def broken():
        raise ap.Failed("x")
    check("run: an unreadable record, exit 13", 13, ap.run(["approve", "KratoBal/acroveliq", "198", "t-x"],
          {**aenv, "get_records": broken})[0])

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
    # any shape of the switch line, so a changed default turns the checks below red instead of
    # crashing the lookup (calibrated 2026-10-16)
    start = re.search(r'^if \[ "\$\{FLEET_GITHUB_APP:-[a-z]+\}" (?:=|!=) [a-z]+ \]; then$', pb, re.M).start()
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
    check("switch off (the explicit rollback): the owner token, as before", "OWNER-TOKEN", switch("off"))
    check("UNSET (the default since 2026-10-16): the broker's merge token, the owner file not read",
          "APP--n /usr/local/sbin/fleet-github token KratoBal/acroveliq beolvaszt", switch(None))
finally:
    shutil.rmtree(T, ignore_errors=True)

print()
print("all pass" if fails == 0 else "FAILED: %d" % fails)
sys.exit(1 if fails else 0)
