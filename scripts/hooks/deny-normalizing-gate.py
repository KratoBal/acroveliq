#!/usr/bin/env python3
"""PreToolUse hook (Bash): enforce the agent's OWN Bash deny rules on the NORMALISED command.

WHY (task tiltott-osszetett-parancs, kanban 2935ed32, murena's measurement 2026-10-26, Claude Code
2.1.310): the permission engine matches a Bash deny rule such as `Bash(git push --force:*)` against
the literal command prefix of each `;`, `&&` and `$(...)` part. Measured with the harmless
`git push --force -h`: alone, after `&&`, after `;`, inside `$(...)` and behind `env` the call was
refused; behind `bash -c '...'`, `sh -c '...'`, `git -C <path> push --force -h` and
`/usr/bin/git push --force -h` the git ran. A deny rule that a wrapper walks around is the same
as no rule, and no PreToolUse hook closed the gap (readonly-command-gate.py only ever allows).

WHAT IT DOES: for each simple command in the call it unwraps `bash|sh|dash|zsh|ksh -c STRING`,
`eval`, `env [opts] [NAME=v] cmd`, `command`, `exec`, `nohup`, `time`, `nice`, `timeout`, leading
`NAME=value` assignments and `$(...)` / backtick / `( ... )` bodies, drops git's global options
(`-C <path>`, `-c <k=v>`, `--git-dir`, `--work-tree`, `--no-pager`, ...), reduces the program to its
basename, and compares the result with the agent's Bash deny rules. A match is a DENY.

WHAT IT DELIBERATELY DOES NOT DO (Balazs's condition, 2026-10-26, "hamis tiltas megallitja az
agenst"): it never denies something it could not take apart. An unterminated quote, an
unreadable settings file, no deny rules, a payload that is not a Bash call, an exception: no output,
exit 0, and the normal permission flow decides exactly as before. It never allows, never asks, and
only ever denies a command that the engine's own rule would have denied in its plain form.

HOW A RULE MATCHES (measured 2026-10-26, same engine): `Bash(PREFIX:*)` matches on whole-token
boundaries: `rm -rf /` does NOT match `rm -rf /tmp/x`, and `git push --force` does NOT match
`git push --force-with-lease`. A rule without `:*` is an exact token match; a rule with another `*`
is a glob on the normalised command text.

NOT COVERED (stated, not hidden): `xargs git push --force`, a script file that holds the command,
`git push origin +branch` (a force by refspec, no deny rule names it), `sudo` reached through a
variable, an alias. The deny rule list is the only source: this hook adds NO new prohibitions.
"""
import fnmatch
import json
import os
import re
import shlex
import sys

MAX_DEPTH = 6
SHELLS = {"bash", "sh", "dash", "zsh", "ksh"}
# words that may open a simple command inside a compound one: `do git push ...`, `! cmd`, `{ cmd`
LEADING_KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "coproc"}
GIT_GLOBAL_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
                       "--exec-path", "--attr-source"}
ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")


class Undecomposable(Exception):
    """The text could not be taken apart: the caller must NOT deny on it."""


# --------------------------------------------------------------------------------------------
# splitting a command text into simple commands (quote aware, heredoc aware)
# --------------------------------------------------------------------------------------------
def split_commands(text: str, depth: int = 0):
    """Return the list of simple-command strings in `text`, with the bodies of `$(...)`, backticks
    and `( ... )` added as further commands. Raises Undecomposable on an unterminated quote or
    substitution."""
    if depth > MAX_DEPTH:
        raise Undecomposable("too deep")
    out, cur = [], []
    i, n = 0, len(text)
    q = None
    pending_heredocs = []  # delimiter words waiting for the next newline

    def flush():
        s = "".join(cur).strip()
        cur.clear()
        if s:
            out.append(s)

    def read_group(start: int, open_ch: str, close_ch: str):
        """text[start] is just after the opener; return (body, index after the closer)."""
        depth_ = 1
        j = start
        qq = None
        while j < n:
            c = text[j]
            if qq:
                if c == "\\" and qq == '"' and j + 1 < n:
                    j += 2
                    continue
                if c == qq:
                    qq = None
            elif c in ("'", '"'):
                qq = c
            elif c == "\\" and j + 1 < n:
                j += 2
                continue
            elif c == open_ch and open_ch != close_ch:
                depth_ += 1
            elif c == close_ch:
                depth_ -= 1
                if depth_ == 0:
                    return text[start:j], j + 1
            j += 1
        raise Undecomposable("unterminated " + open_ch)

    while i < n:
        c = text[i]
        if q == "'":
            cur.append(c)
            if c == "'":
                q = None
            i += 1
            continue
        if q == '"':
            if c == "\\" and i + 1 < n:
                cur.append(text[i:i + 2])
                i += 2
                continue
            if c == '"':
                q = None
                cur.append(c)
                i += 1
                continue
            if c == "$" and text.startswith("$(", i):
                body, j = read_group(i + 2, "(", ")")
                out.extend(split_commands(body, depth + 1))
                cur.append("X")
                i = j
                continue
            if c == "`":
                j = text.find("`", i + 1)
                if j < 0:
                    raise Undecomposable("unterminated backtick")
                out.extend(split_commands(text[i + 1:j], depth + 1))
                cur.append("X")
                i = j + 1
                continue
            cur.append(c)
            i += 1
            continue
        # unquoted
        if c == "\\" and i + 1 < n:
            cur.append(text[i:i + 2])
            i += 2
            continue
        if c in ("'", '"'):
            q = c
            cur.append(c)
            i += 1
            continue
        if c == "$" and text.startswith("$(", i):
            body, j = read_group(i + 2, "(", ")")
            out.extend(split_commands(body, depth + 1))
            cur.append("X")
            i = j
            continue
        if c == "`":
            j = text.find("`", i + 1)
            if j < 0:
                raise Undecomposable("unterminated backtick")
            out.extend(split_commands(text[i + 1:j], depth + 1))
            cur.append("X")
            i = j + 1
            continue
        if c == "<" and text.startswith("<<", i) and not text.startswith("<<<", i):
            m = re.match(r"<<-?\s*(?:'([^']*)'|\"([^\"]*)\"|([A-Za-z_][A-Za-z0-9_]*))", text[i:])
            if m:
                pending_heredocs.append(m.group(1) or m.group(2) or m.group(3))
                cur.append(m.group(0))
                i += len(m.group(0))
                continue
        if c == "\n":
            flush()
            i += 1
            if pending_heredocs:
                # the body is data, not commands: skip up to the delimiter line (an unterminated
                # heredoc swallows the rest, which can only make the hook deny LESS)
                for delim in pending_heredocs:
                    while i < n:
                        j = text.find("\n", i)
                        line = text[i:n if j < 0 else j]
                        i = n if j < 0 else j + 1
                        if line.strip() == delim:
                            break
                pending_heredocs = []
            continue
        if c in (";", "(", ")") or (c in ("&", "|")):
            flush()
            if c in ("&", "|") and i + 1 < n and text[i + 1] == c:
                i += 2
            else:
                i += 1
            continue
        cur.append(c)
        i += 1
    if q is not None:
        raise Undecomposable("unterminated quote")
    flush()
    return out


# --------------------------------------------------------------------------------------------
# normalising one simple command into a token list (a command may expand to several)
# --------------------------------------------------------------------------------------------
def normalise(cmd: str, depth: int = 0):
    """Return a list of normalised token lists for one command text (usually one; a `bash -c` body
    can hold several). A part that cannot be tokenised is dropped (never denied on)."""
    if depth > MAX_DEPTH:
        return []
    results = []
    try:
        parts = split_commands(cmd, depth)
    except Undecomposable:
        return []
    for part in parts:
        try:
            tokens = shlex.split(part, posix=True)
        except ValueError:
            continue
        results.extend(_unwrap(tokens, depth))
    return results


def _basename(tok: str) -> str:
    return tok.rsplit("/", 1)[-1]


def _unwrap(tokens, depth):
    guard = 0
    while tokens and guard < 20:
        guard += 1
        while tokens and (ENV_ASSIGN.match(tokens[0]) or tokens[0] in LEADING_KEYWORDS):
            tokens = tokens[1:]
        if not tokens:
            return []
        prog = _basename(tokens[0])
        rest = tokens[1:]
        if prog == "env":
            i = 0
            while i < len(rest):
                t = rest[i]
                if t == "--":
                    i += 1
                    break
                if t in ("-u", "--unset", "-C", "--chdir"):
                    i += 2
                elif t in ("-S", "--split-string") and i + 1 < len(rest):
                    return normalise(rest[i + 1] + " " + " ".join(rest[i + 2:]), depth + 1)
                elif t.startswith("-") or ENV_ASSIGN.match(t):
                    i += 1
                else:
                    break
            tokens = rest[i:]
            continue
        if prog in ("command", "builtin", "exec", "nohup", "setsid"):
            i = 0
            while i < len(rest) and rest[i].startswith("-"):
                if prog == "command" and rest[i] in ("-v", "-V"):
                    return []  # describes, does not run
                i += 1
            tokens = rest[i:]
            continue
        if prog == "time":
            tokens = rest
            continue
        if prog == "nice":
            i = 0
            while i < len(rest) and rest[i].startswith("-"):
                i += 2 if rest[i] == "-n" else 1
            tokens = rest[i:]
            continue
        if prog == "timeout":
            i = 0
            while i < len(rest) and rest[i].startswith("-"):
                i += 2 if rest[i] in ("-k", "-s", "--kill-after", "--signal") else 1
            tokens = rest[i + 1:]  # skip the DURATION
            continue
        if prog in SHELLS:
            i = 0
            has_c = False
            while i < len(rest) and rest[i].startswith(("-", "+")) and rest[i] != "--":
                if rest[i] in ("-o", "+o", "-O", "+O"):
                    i += 2  # an option NAME follows, it is not the command string
                    continue
                if rest[i].startswith("-") and not rest[i].startswith("--") and "c" in rest[i][1:]:
                    has_c = True
                i += 1
                if has_c:
                    break
            if has_c and i < len(rest):
                return normalise(rest[i], depth + 1)
            return [_finish(tokens)]  # a shell running a script file: nothing to look into
        if prog == "eval":
            return normalise(" ".join(rest), depth + 1)
        return [_finish(tokens)]
    return []


def _finish(tokens):
    prog = _basename(tokens[0])
    rest = tokens[1:]
    if prog == "git":
        i = 0
        while i < len(rest) and rest[i].startswith("-") and rest[i] != "--":
            t = rest[i]
            if t in GIT_GLOBAL_WITH_ARG:
                i += 2
            else:
                i += 1  # --git-dir=x, --no-pager, -p, --bare, ...
        rest = rest[i:]
    return [prog] + rest


# --------------------------------------------------------------------------------------------
# deny rules
# --------------------------------------------------------------------------------------------
def parse_rule(rule: str):
    """`Bash(git push --force:*)` -> ("prefix", [tokens]); `Bash(x y)` -> ("exact", [tokens]);
    `Bash(a * b)` -> ("glob", text). Anything that is not a Bash rule -> None."""
    m = re.fullmatch(r"Bash\((.*)\)", rule.strip(), re.S)
    if not m:
        return None
    body = m.group(1)
    try:
        if body.endswith(":*"):
            return ("prefix", shlex.split(body[:-2], posix=True))
        if "*" in body:
            return ("glob", body)
        return ("exact", shlex.split(body, posix=True))
    except ValueError:
        return None


def matches(rule, tokens) -> bool:
    kind, spec = rule
    if kind == "prefix":
        return bool(spec) and tokens[:len(spec)] == spec
    if kind == "exact":
        return bool(spec) and tokens == spec
    return fnmatch.fnmatchcase(" ".join(tokens), spec)


def load_deny_rules(payload: dict):
    """The agent's own Bash deny rules: settings.json and settings.local.json of the nearest
    `.claude` directory (CLAUDE_PROJECT_DIR first, then the call's cwd and its parents)."""
    starts = []
    env_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if env_dir:
        starts.append(env_dir)
    cwd = payload.get("cwd")
    if isinstance(cwd, str) and cwd:
        starts.append(cwd)
    for start in starts:
        d = os.path.abspath(start)
        for _ in range(8):
            settings = os.path.join(d, ".claude", "settings.json")
            if os.path.isfile(settings):
                rules = []
                for name in ("settings.json", "settings.local.json"):
                    p = os.path.join(d, ".claude", name)
                    try:
                        with open(p, encoding="utf-8") as f:
                            deny = (json.load(f).get("permissions") or {}).get("deny") or []
                    except (OSError, ValueError):
                        continue
                    for r in deny:
                        if isinstance(r, str):
                            parsed = parse_rule(r)
                            if parsed:
                                rules.append((r, parsed))
                return rules
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
    return []


def find_denied(command: str, rules):
    """The (rule text, normalised command) of the first deny match, or None."""
    for tokens in normalise(command):
        if not tokens:
            continue
        for text, rule in rules:
            if matches(rule, tokens):
                return text, " ".join(tokens)
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if payload.get("tool_name") != "Bash":
        return 0
    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not command.strip():
        return 0
    rules = load_deny_rules(payload)
    if not rules:
        return 0
    hit = find_denied(command, rules)
    if hit is None:
        return 0
    rule_text, normalised = hit
    reason = (
        f"DENY-SZABALY (normalizalt alak): a parancs kibontva `{normalised[:200]}`, ez a profil "
        f"`{rule_text}` szabalyara illeszkedik. A burkolo (bash -c, env, git -C, abszolut ut) "
        "nem kerulheti meg a tiltast."
    )
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # any failure degrades to "do not intervene": a false block stops an agent
        sys.exit(0)
