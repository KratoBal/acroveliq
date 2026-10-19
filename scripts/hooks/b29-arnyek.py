#!/usr/bin/env python3
"""PreToolUse SHADOW hook for the main agent (B29 step 2, task b29-arnyek-hook).

WHAT IT ANSWERS: had acrobot run with the fo-agens strict profile (templates/profiles/fo-agens.json,
#225) instead of --dangerously-skip-permissions, which tool calls would have asked, and which
would have been denied? The daily count of "would have asked" is what B29 step 3 drives under 1.

WHY NOT THE #219 HOOK (measured from its source, 2026-10-19): permission-approval.py runs on
PermissionRequest, which Claude Code fires only when its own engine would show a dialog. With the
bypass the engine never asks, so in shadow mode #219 would log nothing, and "no question" would be
indistinguishable from "no event". This hook runs on PreToolUse, which fires for every tool call.

AN ESTIMATE, NOT THE ENGINE: the verdict is this file's reading of the profile, not Claude Code's
decision (barracuda rejected guessing for the live #219 decision, 32016 d; here it is only a
counter, and step 4, the engine live, confirms or refutes it). The rules it applies:
  - Bash: the command is split at unquoted &&, ||, ;, | and newlines; every part must match an
    allow rule (`Bash(<prefix>:*)` = prefix match, `Bash(<exact>)` = exact match), a part matching
    a deny rule makes the call "deny"; `cd <dir>` alone is taken as allowed. A part with a shell
    expansion ($VAR, ${...}, $(...), backticks) or an output redirection to a file is "ask": the
    engine cannot read it statically (measured on the fleet: "Contains simple_expansion");
  - Read, Grep, Glob: allowed inside the agent's directories or under an allow rule, denied under
    a deny rule (gitignore-style: `**` any depth, `*` one segment);
  - Write, Edit, NotebookEdit: an allow rule is needed, a deny rule denies;
  - any other tool: allowed if its name is in the allow list, denied if in the deny list, a tool
    the engine never asks about (TodoWrite, ...) is allowed, anything else "ask".

IT NEVER BLOCKS AND NEVER ASKS: it prints nothing and exits 0 on every path, errors included; a
broken shadow must not stop the main agent. It writes one JSON line per call to
store/b29-arnyek/YYYY-MM-DD.jsonl (local day): the tool, the verdict, the reason, and for Bash only
the first two words after secret masking, the length and a sha256 prefix, never the command.
"""
import datetime
import hashlib
import importlib.util
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROFILE = os.path.join(BASE, "templates", "profiles", "fo-agens.json")
# B29_ARNYEK_DIR only moves the log (the tests write into a temporary directory, not the store)
OUT_DIR = os.environ.get("B29_ARNYEK_DIR") or os.path.join(BASE, "store", "b29-arnyek")
TZ = "Europe/Budapest"

# tools the engine runs without a permission check (no rule needed in any mode)
NO_PERMISSION_TOOLS = {"TodoWrite", "TodoRead", "ExitPlanMode", "EnterPlanMode", "BashOutput", "KillShell"}
READ_TOOLS = {"Read", "Grep", "Glob", "LS", "NotebookRead"}
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}

_RULE = re.compile(r"^([A-Za-z0-9_]+)(?:\((.*)\))?$")


def load_rules(home: str, agent_dir: str):
    with open(PROFILE, encoding="utf-8") as f:
        fs = json.load(f)["filesystem"]

    def resolve(v: str) -> str:
        return v.replace("${HOME}", home).replace("${AGENT_DIR}", agent_dir).replace("${WORKDIR}", agent_dir)

    def parse(lst):
        out = []
        for raw in lst:
            m = _RULE.match(resolve(raw))
            if m:
                out.append((m.group(1), m.group(2)))
        return out

    dirs = [resolve(d) for d in fs.get("directories", [])] + [agent_dir]
    return parse(fs.get("allow", [])), parse(fs.get("deny", [])), dirs


def glob_regex(pattern: str):
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def path_rule_matches(spec: str, path: str) -> bool:
    return bool(spec) and bool(glob_regex(spec).match(path))


def bash_rule_matches(spec: str, part: str) -> bool:
    if spec.endswith(":*"):
        prefix = spec[:-2]
        # a word boundary: Bash(sed:*) covers "sed -n ..." but not "sedx"
        return part == prefix or part.startswith(prefix + " ")
    return part == spec


def split_compound(cmd: str):
    """The parts of a command at unquoted &&, ||, ;, | and newlines; None if the quotes do not close."""
    parts, cur, quote, i = [], [], None, 0
    while i < len(cmd):
        ch = cmd[i]
        if quote:
            cur.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < len(cmd):
                cur.append(cmd[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            cur.append(ch)
        elif cmd.startswith("&&", i) or cmd.startswith("||", i):
            parts.append("".join(cur))
            cur = []
            i += 2
            continue
        elif ch in (";", "|", "\n"):
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    if quote:
        return None
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


_EXPANSION = re.compile(r"\$\(|\$\{|\$[A-Za-z_]|`")
# a redirection to a file (not to /dev/null, not fd duplication like 2>&1)
_REDIRECT = re.compile(r"(?<![0-9&])>>?\s*(?!&|/dev/null)\S|[0-9]>>?\s*(?!&|/dev/null)[^\s&]")


def unquoted(part: str) -> str:
    """The part with single-quoted text removed (no expansion happens inside single quotes)."""
    return re.sub(r"'[^']*'", "''", part)


SECRET_WORDS = "[titok-minta]"


def words(part: str) -> str:
    """The first two words of a command part for the log (review of #254): only this function lets
    command text out, and it drops everything after an `=` (NAME=value: the name stays, the value
    never), so a variable assignment or an option value cannot carry a secret into the log or the
    OLVASO summary. A secret-shaped command loses even these words in record()."""
    out = []
    for w in part.split()[:2]:
        out.append(w.split("=", 1)[0] + "=…" if "=" in w else w)
    return " ".join(out)[:60]


def bash_verdict(cmd: str, allow, deny):
    parts = split_compound(cmd)
    if parts is None:
        return "ask", "nem bonthato (nyitott idezojel)"
    worst, why = "allow", ""
    for part in parts:
        if any(t == "Bash" and spec and bash_rule_matches(spec, part) for t, spec in deny):
            return "deny", "tiltott: " + words(part)
        if re.match(r"^cd(\s|$)", part):
            continue
        bare = unquoted(part)
        if _EXPANSION.search(bare):
            worst, why = "ask", "kifejtes a parancsban"
            continue
        if _REDIRECT.search(bare):
            worst, why = "ask", "atiranyitas fajlba"
            continue
        if not any(t == "Bash" and spec and bash_rule_matches(spec, part) for t, spec in allow):
            worst, why = "ask", "nincs szabaly: " + words(part)
    return worst, why


def path_verdict(tool: str, path: str, allow, deny, dirs):
    if not path:
        return "allow", ""
    for t, spec in deny:
        if (t == tool or (t == "Read" and tool in READ_TOOLS)) and spec and path_rule_matches(spec, path):
            return "deny", "tiltott ut"
    if tool in READ_TOOLS and any(path == d or path.startswith(d.rstrip("/") + "/") for d in dirs):
        return "allow", ""
    for t, spec in allow:
        if (t == tool or (t == "Edit" and tool in WRITE_TOOLS) or (t == "Read" and tool in READ_TOOLS)) and spec and path_rule_matches(spec, path):
            return "allow", ""
    return "ask", "nincs szabaly erre az utra"


def verdict(tool: str, tin: dict, cwd: str, allow, deny, dirs):
    if tool == "Bash":
        return bash_verdict(str(tin.get("command", "")), allow, deny)
    if tool in READ_TOOLS or tool in WRITE_TOOLS:
        p = tin.get("file_path") or tin.get("notebook_path") or tin.get("path") or (cwd if tool in READ_TOOLS else "")
        return path_verdict(tool, os.path.normpath(p) if p else "", allow, deny, dirs)
    if any(t == tool and spec is None for t, spec in deny):
        return "deny", "tiltott eszkoz"
    if tool in NO_PERMISSION_TOOLS or any(t == tool and spec is None for t, spec in allow):
        return "allow", ""
    return "ask", "nincs szabaly erre az eszkozre"


def _secret_shaped(text: str) -> bool:
    try:
        spec = importlib.util.spec_from_file_location("futtat_masker", os.path.join(BASE, "scripts", "futtat.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        try:
            hashes = mod.load_hashes()
        except Exception:
            hashes = {}
        masker = mod.Masker(hashes)
        for line in text.splitlines() or [text]:
            masker.line(line)
        return masker.count > 0
    except Exception:
        return True  # cannot check: say nothing about the command


def record(tool: str, tin: dict, v: str, why: str, now: datetime.datetime) -> dict:
    rec = {"ts": now.isoformat(timespec="seconds"), "tool": tool, "verdict": v}
    if tool == "Bash":
        cmd = str(tin.get("command", ""))
        secret = _secret_shaped(cmd)
        rec["head"] = SECRET_WORDS if secret else words(cmd)
        # the reason may quote command words ("tiltott: ...", "nincs szabaly: ..."): the same rule
        if secret and ": " in why:
            why = why.split(": ", 1)[0] + ": " + SECRET_WORDS
    if why:
        rec["reason"] = why
    if tool == "Bash":
        rec["len"] = len(cmd)
        rec["sha"] = hashlib.sha256(cmd.encode()).hexdigest()[:8]
    return rec


def local_now() -> datetime.datetime:
    try:
        from zoneinfo import ZoneInfo

        return datetime.datetime.now(ZoneInfo(TZ))
    except Exception:
        return datetime.datetime.now().astimezone()


def main() -> None:
    event = json.load(sys.stdin)
    tool = str(event.get("tool_name", ""))
    tin = event.get("tool_input") or {}
    cwd = str(event.get("cwd") or os.getcwd())
    home = os.path.expanduser("~")
    allow, deny, dirs = load_rules(home, BASE)
    v, why = verdict(tool, tin if isinstance(tin, dict) else {}, cwd, allow, deny, dirs)
    now = local_now()
    os.makedirs(OUT_DIR, exist_ok=True)
    line = json.dumps(record(tool, tin if isinstance(tin, dict) else {}, v, why, now), ensure_ascii=False) + "\n"
    fd = os.open(os.path.join(OUT_DIR, now.strftime("%Y-%m-%d") + ".jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # a broken shadow never stops the main agent
    sys.exit(0)
