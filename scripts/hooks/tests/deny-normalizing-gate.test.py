import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
# The test lives one level below the hook on purpose: the hook-registration completeness lint takes
# every .py in scripts/hooks/ for a shipped hook (see readonly-command-gate.test.py).
_SCRIPT = os.path.join(os.path.dirname(_HERE), "deny-normalizing-gate.py")


def _load():
    spec = importlib.util.spec_from_file_location("deny_normalizing_gate", _SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


gate = _load()

# the deny rules of the developer-senior profile, the list measured on 2026-10-26
RULES = [(r, gate.parse_rule(r)) for r in (
    "Bash(sudo:*)", "Bash(rm -rf /home/marveen:*)", "Bash(rm -rf /:*)",
    "Bash(git push --force:*)", "Bash(git push -f:*)", "Read(/home/marveen/.ssh/**)",
) if gate.parse_rule(r)]


def denied(cmd):
    hit = gate.find_denied(cmd, RULES)
    return None if hit is None else hit[1]


class WrappersAreSeenThrough(unittest.TestCase):
    """The four shapes the engine let through on 2026-10-26, and the ones it already refused."""

    def test_plain_and_sequences(self):
        for cmd in ("git push --force -h", "true && git push --force -h", "true ; git push --force -h",
                    "echo $(git push --force -h)", "echo `git push --force -h`", "(git push --force -h)",
                    "false || git push -f origin x", "ls | git push --force -h", "{ git push --force; }",
                    "for b in a b; do git push --force origin $b; done", "if true; then git push -f; fi"):
            self.assertIsNotNone(denied(cmd), cmd)

    def test_the_measured_bypasses(self):
        for cmd in ("bash -c 'git push --force -h'", "sh -c 'git push --force -h'",
                    "git -C /some/repo push --force -h", "/usr/bin/git push --force -h",
                    "env git push --force -h", "env -i FOO=1 git push --force -h",
                    "bash -lc 'cd x && git push -f origin'", "bash -c \"sh -c 'git push --force'\"",
                    "eval 'git push --force -h'", "eval git push --force -h",
                    "git -c push.default=simple push --force", "git --no-pager -C . push -f",
                    "git --git-dir=.git push --force", "FOO=1 git push --force", "command git push -f",
                    "nohup git push --force", "timeout 5 git push --force", "nice -n 5 git push -f",
                    "bash -o pipefail -c 'git push --force'", "sudo -n true", "/usr/bin/sudo true",
                    "bash -c 'echo hi; rm -rf /'", "bash -c 'rm -rf /home/marveen'"):
            self.assertIsNotNone(denied(cmd), cmd)

    def test_the_normalised_form_is_reported(self):
        self.assertEqual(denied("git -C /x -c a=b push --force -h"), "git push --force -h")
        self.assertEqual(denied("/usr/bin/git push -f"), "git push -f")


class NothingElseIsDenied(unittest.TestCase):
    """Zero false blocks is the condition: the engine's own boundaries are kept."""

    def test_ordinary_commands(self):
        for cmd in ("git push origin main", "git push --force-with-lease origin x", "git push -u origin x",
                    "git status", "git -C /x log --oneline", "git reset --hard", "rm -rf /tmp/x",
                    "rm -rf node_modules", "rm -rf /home/marveen/marveen/agents/murena/x", "ls -la /",
                    "bash -c 'ls /'", "bash script.sh", "sh -c 'git status'", "env FOO=1 ls", "command -v sudo",
                    "echo sudo", "grep -n 'git push --force' file.md", "echo \"git push --force\"",
                    "printf '%s' 'rm -rf /'", "cat > a.txt <<'EOF'\ngit push --force\nsudo true\nEOF\nls",
                    "cat <<EOF\nrm -rf /\nEOF", "python3 -c 'import os; os.system(\"git status\")'",
                    "git commit -m 'never git push --force here'", "pnpm test && git status",
                    "sudoedit x", "echo x # git push --force"):
            self.assertIsNone(denied(cmd), cmd)

    def test_heredoc_then_a_real_command_is_still_seen(self):
        self.assertIsNotNone(denied("cat <<'EOF'\nnote\nEOF\ngit push --force"))
        self.assertIsNotNone(denied("cat <<'EOF' > f\nsudo\nEOF\nsudo true"))

    def test_undecomposable_is_never_denied(self):
        for cmd in ("git push --force 'unterminated", "echo \"$(git push --force", "echo `git push --force",
                    "bash -c 'git push --force", "x=$(", "bash -c"):
            self.assertIsNone(denied(cmd), cmd)

    def test_not_a_deny_rule_is_ignored(self):
        self.assertIsNone(gate.parse_rule("Read(/home/marveen/.ssh/**)"))
        self.assertIsNone(gate.parse_rule("ScheduleWakeup"))


class RuleShapes(unittest.TestCase):
    def test_exact_and_glob(self):
        exact = [("Bash(git push)", gate.parse_rule("Bash(git push)"))]
        self.assertIsNotNone(gate.find_denied("bash -c 'git push'", exact))
        self.assertIsNone(gate.find_denied("git push origin", exact))
        glob = [("Bash(git * push --force)", gate.parse_rule("Bash(git * push --force)"))]
        self.assertIsNotNone(gate.find_denied("git -C x push --force", glob) or gate.find_denied("git x push --force", glob))


class CliContract(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="dng-")
        os.makedirs(os.path.join(self.dir, ".claude"))
        with open(os.path.join(self.dir, ".claude", "settings.json"), "w") as f:
            json.dump({"permissions": {"deny": ["Bash(git push --force:*)", "Bash(sudo:*)"]}}, f)
        with open(os.path.join(self.dir, ".claude", "settings.local.json"), "w") as f:
            json.dump({"permissions": {"deny": ["Bash(rm -rf /:*)"]}}, f)
        os.makedirs(os.path.join(self.dir, "sub", "dir"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_hook(self, payload, raw=None, env_dir=None):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_PROJECT_DIR"}
        if env_dir:
            env["CLAUDE_PROJECT_DIR"] = env_dir
        r = subprocess.run([sys.executable, _SCRIPT], input=raw if raw is not None else json.dumps(payload),
                           capture_output=True, text=True, env=env)
        return r.returncode, r.stdout

    def bash(self, command, cwd=None, **kw):
        return self.run_hook({"tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd or self.dir}, **kw)

    def test_deny_is_a_json_decision_and_exit_zero(self):
        rc, out = self.bash("bash -c 'git push --force -h'")
        d = json.loads(out)["hookSpecificOutput"]
        self.assertEqual((rc, d["hookEventName"], d["permissionDecision"]), (0, "PreToolUse", "deny"))
        self.assertIn("git push --force -h", d["permissionDecisionReason"])

    def test_rules_come_from_both_settings_files_found_from_a_subfolder(self):
        sub = os.path.join(self.dir, "sub", "dir")
        self.assertIn("deny", self.bash("sh -c 'sudo true'", cwd=sub)[1])
        self.assertIn("deny", self.bash("bash -c 'rm -rf /'", cwd=sub)[1])  # from settings.local.json

    def test_project_dir_env_wins(self):
        rc, out = self.bash("env git push --force", cwd="/", env_dir=self.dir)
        self.assertIn("deny", out)

    def test_silent_when_it_cannot_decide(self):
        self.assertEqual(self.bash("ls -la"), (0, ""))
        self.assertEqual(self.bash("git push --force 'oops"), (0, ""))
        self.assertEqual(self.run_hook(None, raw="not json"), (0, ""))
        self.assertEqual(self.run_hook({"tool_name": "Write", "tool_input": {"command": "sudo"}}), (0, ""))
        self.assertEqual(self.run_hook({"tool_name": "Bash", "tool_input": {}}), (0, ""))
        self.assertEqual(self.bash("sudo true", cwd="/nonexistent-zzz"), (0, ""))  # no settings found: no rules

    def test_no_deny_rules_no_output(self):
        with open(os.path.join(self.dir, ".claude", "settings.json"), "w") as f:
            json.dump({"permissions": {"allow": []}}, f)
        os.unlink(os.path.join(self.dir, ".claude", "settings.local.json"))
        self.assertEqual(self.bash("sudo true"), (0, ""))

    def test_unreadable_settings_no_output(self):
        with open(os.path.join(self.dir, ".claude", "settings.json"), "w") as f:
            f.write("{broken")
        os.unlink(os.path.join(self.dir, ".claude", "settings.local.json"))
        self.assertEqual(self.bash("sudo true"), (0, ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
