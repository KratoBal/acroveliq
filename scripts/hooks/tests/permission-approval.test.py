"""permission-approval.py (B48 pótlás). What turns these red:
  - the output carrying anything but behavior and message (an
    updatedPermissions would make a one-time "yes" a standing rule);
  - an allow from a row that is not approved FROM DISCORD, or whose text is not
    the running command letter for letter;
  - the owner's rejection and a timeout reading the same (the agent writes on
    the card what it gets);
  - a command shown shortened or altered on Discord, or a secret-shaped one sent;
  - a repeated rejected command asking again, or an approved row reused;
  - the shadow mode deciding anything.
Run: python3 -B scripts/hooks/tests/permission-approval.test.py
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.join(os.path.dirname(_HERE), "permission-approval.py")
_REPO = os.path.dirname(os.path.dirname(os.path.dirname(_HERE)))

spec = importlib.util.spec_from_file_location("permission_approval", _SCRIPT)
pa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pa)

# secret-shaped test values, put together at run time: the secret-gate scans
# the change set and must not see a token-shaped literal (its patterns stay strict)
FAKE_GH = "gh" + "p_" + "a" * 36
FAKE_BEARER = "Bea" + "rer " + "b" * 32
FAKE_DSN = "postgres" + "://fleet:" + "c" * 12 + "@db/x"
DISCORD_REF = "discord:1540270627926183997/1560000000000000001/1460000000000000001"


class Clock:
    def __init__(self):
        self.t = 1_800_000_000.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


class FakeApi:
    """The dashboard's approvals rows; `answer(row)` is how the owner decides, after `after` polls."""

    def __init__(self, answer=None, after=2, record_as=None):
        self.rows = {}
        self.posts = 0
        self.gets = 0
        self.answer = answer
        self.after = after
        self.record_as = record_as

    def call(self, method, path, body=None):
        if method == "POST" and path == "/approvals":
            self.posts += 1
            rid = "apr-%d" % self.posts
            self.rows[rid] = {
                "id": rid, "agent_id": self.record_as or body["agent_id"], "category": body["category"],
                "action_description": body["action_description"], "status": "pending",
                "resolved_by": None, "decision_ref": None,
            }
            return dict(self.rows[rid])
        if method == "GET" and path.startswith("/approvals/"):
            self.gets += 1
            row = self.rows[path.rsplit("/", 1)[1]]
            if self.answer and row["status"] == "pending" and self.gets >= self.after:
                self.answer(row)
            return dict(row)
        raise AssertionError((method, path))


def approve_discord(row):
    row.update(status="approved", resolved_by="balazs", decision_ref=DISCORD_REF)


def approve_api(row):
    row.update(status="approved", resolved_by="acrobot", decision_ref=None)


def reject_discord(row):
    row.update(status="rejected", resolved_by="balazs", decision_ref=DISCORD_REF)


CMD = "ip -4 -o addr show | grep inet > /tmp/claude-1/x_y.txt"
CWD = "/home/agent-barracuda/work"


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cache = os.path.join(self.dir, "cache.json")
        self.clock = Clock()

    def tearDown(self):
        shutil.rmtree(self.dir)

    def run_live(self, api, cmd=CMD, cwd=CWD):
        return pa.live(cmd, cwd, "barracuda", api, self.cache, now=self.clock.now, sleep=self.clock.sleep)


class OutputShape(Base):
    def test_allow_and_deny_carry_only_behavior_and_message(self):
        allow = self.run_live(FakeApi(approve_discord))
        self.assertEqual(allow, {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}})
        deny = self.run_live(FakeApi(reject_discord), cmd="rm -rf /tmp/x")
        self.assertEqual(set(deny["hookSpecificOutput"]), {"hookEventName", "decision"})
        self.assertEqual(set(deny["hookSpecificOutput"]["decision"]), {"behavior", "message"})
        self.assertEqual(deny["hookSpecificOutput"]["decision"]["behavior"], "deny")


class Description(unittest.TestCase):
    def test_the_whole_command_survives_neutral_description(self):
        for cmd in (CMD, "a  b", "cat <<'EOF' > /tmp/x\nhello # *bold* ~x~ `y`\nEOF", "a\tb"):
            with self.subTest(cmd=cmd):
                text, why = pa.description(cmd, CWD)
                self.assertIsNone(why)
                self.assertEqual(pa.neutral_description(text), "> " + text)
                # every character of the command is still there, as itself or its glyph
                back = text.split(" :: ", 1)[1].split(" [jelek: ", 1)[0]
                for k, v in pa._GLYPHS.items():
                    back = back.replace(v, k)
                self.assertEqual(back.replace(pa._EXTRA_SPACE, " "), cmd)

    def test_the_look_alikes_used_are_named_in_words(self):
        text, _ = pa.description("cat a | grep b > c", CWD)
        self.assertTrue(text.endswith(" [jelek: \u203a atiranyitas, \u00a6 cso]"), text)
        plain, _ = pa.description("ls -la", CWD)
        self.assertNotIn("[jelek:", plain)

    def test_what_cannot_be_shown_whole_is_refused(self):
        for cmd in ("x" * 600, "echo ¦", "a\rb", "echo ␣", " leading", "a b"):
            with self.subTest(cmd=cmd[:20]):
                text, why = pa.description(cmd, CWD)
                self.assertIsNone(text)
                self.assertTrue(why)


class Live(Base):
    def test_a_discord_yes_allows_once(self):
        api = FakeApi(approve_discord)
        out = self.run_live(api)
        self.assertEqual(out["hookSpecificOutput"]["decision"]["behavior"], "allow")
        self.assertEqual(api.posts, 1)
        row = api.rows["apr-1"]
        self.assertEqual(row["category"], "bash_command")
        self.assertIn(":: " + pa.encode(CMD)[0] + " [jelek: ", row["action_description"])
        # an approved row is never reused: the same command asks again
        self.run_live(api)
        self.assertEqual(api.posts, 2)

    def test_a_yes_not_given_on_discord_does_not_allow(self):
        out = self.run_live(FakeApi(approve_api))
        d = out["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")
        self.assertIn("nem Discordon", d["message"])

    def test_a_rejection_names_the_decider_and_is_not_asked_again(self):
        api = FakeApi(reject_discord)
        d = self.run_live(api)["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")
        self.assertIn("elutasitva, dontott: balazs (Discord)", d["message"])
        again = self.run_live(api)["hookSpecificOutput"]["decision"]
        self.assertEqual(again["behavior"], "deny")
        self.assertIn("mar elbiraltak (rejected)", again["message"])
        self.assertEqual(api.posts, 1)
        # after the window, a new request
        self.clock.t += pa.REPEAT_SECONDS + 1
        self.run_live(api)
        self.assertEqual(api.posts, 2)

    def test_no_answer_is_a_timeout_and_says_it_is_not_a_human_decision(self):
        api = FakeApi(None)
        d = self.run_live(api)["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")
        self.assertIn("NEM emberi dontes", d["message"])
        self.assertNotIn("elutasitva", d["message"])
        self.assertLessEqual(self.clock.t - 1_800_000_000.0, pa.APPROVAL_SECONDS + 2 * pa.POLL_SECONDS)

    def test_a_row_the_dashboard_expired_reads_as_a_timeout_not_a_rejection(self):
        def expire(row):
            row.update(status="timeout", resolved_by=None, decision_ref=None)
        api = FakeApi(expire)
        d = self.run_live(api)["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")
        self.assertIn("NEM emberi dontes", d["message"])
        self.assertNotIn("elutasitva", d["message"])
        again = self.run_live(api)["hookSpecificOutput"]["decision"]
        self.assertIn("mar elbiraltak (timeout)", again["message"])
        self.assertEqual(api.posts, 1)

    def test_a_row_describing_something_else_does_not_allow(self):
        def swap(row):
            approve_discord(row)
            row["action_description"] = row["action_description"] + " ; rm -rf /"
        d = self.run_live(FakeApi(swap))["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")

    def test_a_row_recorded_for_another_agent_is_not_waited_on(self):
        api = FakeApi(approve_discord, record_as="acrobot")
        d = self.run_live(api)["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")
        self.assertEqual(api.gets, 0)

    def test_a_pending_request_is_waited_on_not_asked_twice(self):
        first = FakeApi(None)
        self.run_live(first)  # times out locally, but suppose the row is still pending server-side
        first.rows["apr-1"]["status"] = "pending"
        with open(self.cache) as f:
            cache = json.load(f)
        for v in cache.values():
            v["outcome"] = "pending"
            v["at"] = self.clock.t
        with open(self.cache, "w") as f:
            json.dump(cache, f)
        first.answer = approve_discord
        first.gets = 0
        out = self.run_live(first)
        self.assertEqual(out["hookSpecificOutput"]["decision"]["behavior"], "allow")
        self.assertEqual(first.posts, 1)

    def test_a_cached_id_pointing_at_another_agents_row_is_not_waited_on(self):
        # another agent's pending row with the very same text, planted in this agent's cache
        api = FakeApi(approve_discord)
        text, _ = pa.description(CMD, CWD)
        api.rows["apr-x"] = {"id": "apr-x", "agent_id": "murena", "category": "bash_command",
                             "action_description": text, "status": "pending",
                             "resolved_by": None, "decision_ref": None}
        import hashlib
        with open(self.cache, "w") as f:
            json.dump({hashlib.sha256(text.encode()).hexdigest(): {"id": "apr-x", "at": self.clock.t, "outcome": "pending"}}, f)
        out = self.run_live(api)
        self.assertEqual(out["hookSpecificOutput"]["decision"]["behavior"], "allow")
        self.assertEqual(api.posts, 1)  # its own new row, not murena's
        self.assertEqual(api.rows["apr-x"]["status"], "pending")

    def test_a_row_of_another_agent_never_allows(self):
        row = {"id": "a", "agent_id": "murena", "category": "bash_command", "action_description": "t",
               "status": "approved", "resolved_by": "balazs", "decision_ref": DISCORD_REF}
        d = pa._verdict(row, "t", "barracuda")["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")
        self.assertIn("nem ennek az agensnek", d["message"])
        self.assertEqual(pa._verdict(dict(row, agent_id="barracuda"), "t", "barracuda")["hookSpecificOutput"]["decision"]["behavior"], "allow")

    def test_a_secret_shaped_command_is_denied_and_nothing_is_sent(self):
        api = FakeApi(approve_discord)
        for cmd in ("curl -H 'Authorization: %s' https://x" % FAKE_BEARER,
                    "GITHUB_TOKEN=%s git push" % FAKE_GH,
                    "psql %s" % FAKE_DSN):
            with self.subTest(cmd=cmd[:30]):
                d = self.run_live(api, cmd=cmd)["hookSpecificOutput"]["decision"]
                self.assertEqual(d["behavior"], "deny")
                self.assertIn("titoknak", d["message"])
        self.assertEqual(api.posts, 0)

    def test_a_command_that_cannot_be_shown_is_denied_without_a_request(self):
        api = FakeApi(approve_discord)
        d = self.run_live(api, cmd="x" * 600)["hookSpecificOutput"]["decision"]
        self.assertEqual(d["behavior"], "deny")
        self.assertIn("bontsd fel", d["message"])
        self.assertEqual(api.posts, 0)


class Shadow(unittest.TestCase):
    def test_the_note_never_carries_the_whole_command_or_a_secret(self):
        note = pa.shadow_note("git push origin feat/x --force-with-lease", CWD, "barracuda")
        self.assertIn("eleje='git push'", note)
        self.assertNotIn("force", note)
        self.assertIn("Discord-kerdes", note)
        secret = pa.shadow_note("echo " + FAKE_GH, CWD, "barracuda")
        self.assertNotIn(FAKE_GH[:4], secret)
        self.assertIn("titok-minta", secret)

    def test_main_in_shadow_mode_prints_nothing(self):
        # a deployment copy without a mode file: shadow is the default
        d = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(d, "scripts", "hooks"))
            os.makedirs(os.path.join(d, "store"))
            shutil.copy(_SCRIPT, os.path.join(d, "scripts", "hooks", "permission-approval.py"))
            shutil.copy(os.path.join(_REPO, "scripts", "futtat.py"), os.path.join(d, "scripts", "futtat.py"))
            event = {"hook_event_name": "PermissionRequest", "tool_name": "Bash",
                     "tool_input": {"command": "rm -rf /tmp/x"}, "cwd": CWD}
            out = subprocess.run([sys.executable, "-B", os.path.join(d, "scripts", "hooks", "permission-approval.py")],
                                 input=json.dumps(event), capture_output=True, text=True, timeout=60)
            self.assertEqual(out.returncode, 0)
            self.assertEqual(out.stdout, "")
            # a non-Bash prompt is never touched, in either mode
            with open(os.path.join(d, "store", "permission-approval.json"), "w") as f:
                json.dump({"mode": "eles"}, f)
            event["tool_name"] = "Write"
            out = subprocess.run([sys.executable, "-B", os.path.join(d, "scripts", "hooks", "permission-approval.py")],
                                 input=json.dumps(event), capture_output=True, text=True, timeout=60)
            self.assertEqual(out.stdout, "")
            # live mode without the agent's own token: a deny that says so, never a silent pass
            event["tool_name"] = "Bash"
            out = subprocess.run([sys.executable, "-B", os.path.join(d, "scripts", "hooks", "permission-approval.py")],
                                 input=json.dumps(event), capture_output=True, text=True, timeout=60)
            d_out = json.loads(out.stdout)["hookSpecificOutput"]["decision"]
            self.assertEqual(d_out["behavior"], "deny")
            self.assertIn("tokenje", d_out["message"])
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()
