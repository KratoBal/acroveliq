#!/usr/bin/env python3
"""PreToolUse gate: auto-allow read-only shell commands that only fail today
because they contain a shell VARIABLE.

WHY THIS EXISTS (acrobot brief, 2026-09-23, kanban -- barracuda 25 stops).
barracuda's profile runs in strict mode. Claude Code's own permission engine
refuses ANY Bash command that contains a variable expansion ("Contains
simple_expansion"), REGARDLESS of what is on the allow-list, because static
analysis cannot resolve what the variable will hold at run time. barracuda's
real, daily work is exactly this shape: `/bin/grep -vP mintat "$S/a.tsv"`,
where `$S` is a location-scoped scratch path he set earlier in the same
session. The command is genuinely read-only; only the variable trips the
generic engine.

THE FIX THAT WAS REJECTED FIRST, AND WHY: switching the profile to permissive
mode (`--dangerously-skip-permissions`) also bypasses the DENY list
(src/web/profiles.ts says so), and barracuda's deny list blocks store/**
(live Coolify tokens, DB passwords, the Medusa master key) and
.channels-config/** (channel credentials). Permissive mode would open those
too. Rejected.

THE APPROACH HERE: a narrow, additive PreToolUse hook. It looks at ONLY the
Bash tool, and only ever emits an explicit "allow" decision -- never "deny".
Every command it does not confidently recognise as read-only falls straight
through with NO output, which means Claude Code's own engine decides exactly
as it does today (ask, or allow via the profile's own allow-list). A wrong
call by this gate therefore costs one extra confirmation, never a silent
bypass and never a new block.

THREE CONDITIONS, ALL REQUIRED, PER SEGMENT (contract given by acrobot):

  1. Every segment's program is on a narrow read-only allow-list, DERIVED
     AT RUNTIME from templates/profiles/researcher-reader.json's own
     `filesystem.allow` array (see `read_only_binaries_from_profile`) --
     never a hand-typed second copy. `find` and `sed` get an extra,
     command-specific safety check (see below) because their PRESENCE on
     the allow-list does not mean every invocation of them is read-only.
  2. Every ${VAR}/$VAR reference in every argument must be resolvable
     from a SIMPLE "NAME=value" assignment earlier in the SAME command
     block (barracuda's actual shape: `S=/tmp/.../scratch` on its own
     line, then the real command below it -- see
     `_pure_assignment_tokens`/`_resolve_or_flag`). If a variable cannot
     be resolved this way, the WHOLE command fails condition 2 and the
     gate does not intervene (acrobot's explicit rule, 2026-09-23: an
     unresolved variable must fall back to asking, never pass on the
     strength of whatever literal text happens to remain). Once resolved
     (or if the argument never referenced a variable at all), the text is
     checked against a literal deny-listed path fragment (store/,
     .channels-config/, .env, .ssh/, .aws/, .gnupg/), read from the SAME
     profile file's `filesystem.deny` array.
  3. No side effect or hidden execution, WITH ONE NAMED EXCEPTION (see
     below): no `sed -i` / `sed --in-place`, no command substitution
     (`$(...)`, backtick), and every `;`/`&&`/`||`/`|`/newline-joined
     segment must independently satisfy conditions 1 and 2 (a chain to
     something NOT on the list, or to an unresolvable variable, fails the
     whole command).

THE ONE EXCEPTION, ADDED 2026-09-23 (kanban daba735e, acrobot's card
8170112b investigation): output redirection (`>`, `>>`) is no longer an
automatic reject. barracuda's real, daily work writes a read-only
command's output to a scratch file in HIS OWN scratchpad before piping it
onward -- a shape condition 3's original blanket "no redirection" rule
correctly refused, because a redirect target is IN GENERAL a write
anywhere on disk. The narrowed rule: a segment with a trailing `>`/`>>`
still passes condition 3 IF, AND ONLY IF, the redirect target -- resolved
through the exact same same-block variable bindings as every other
argument (never trusted unresolved) -- is an ABSOLUTE path inside
`/tmp/claude-<the calling process's own real uid>` (see
`_own_scratchpad_prefix`). That prefix is not a convention this hook
invents: `/tmp/claude-<uid>` is the actual scratchpad root Claude Code
itself creates per agent, mode 0700, so even a bug in this gate's own
logic would still be caught by the filesystem permission bit -- another
agent's UID cannot write there regardless of what this hook decides. A
redirect to anywhere else (a second unresolved variable, a relative
path, a different agent's scratchpad, store/, anywhere) still fails the
segment exactly as before this change. `sed -i` remains blocked
unconditionally -- this exception is only for plain shell redirection,
never for a flag that rewrites its input file in place.

WHAT THIS STILL DOES NOT AND CANNOT PROVE, STATED PLAINLY: even a
same-block assignment (`S=/tmp/x`) is trusted at face value -- this gate
does not re-derive where that value itself came from, and a value that
is itself unusual (assigned from something outside the visible block) is
exactly the case condition 2 refuses to resolve. What is now closed: a
BARE `"$S/a.tsv"` with NO assignment anywhere in the block no longer
auto-allows on the strength of the literal remainder after stripping --
it now correctly falls through to ask, same as any other unverifiable
input. That is why scope is barracuda only, and why the caller (acrobot)
is asked to sign off on this specific tradeoff before it goes live -- see
the kanban card this ships with.

HOOK CONTRACT (matched against scripts/hooks/outgoing-copy-gate.py, the
PreToolUse example in this repo). CORRECTED 2026-09-23 by nautilus: an
earlier draft of this paragraph also named prior-art-recall.py as a
PreToolUse example -- it is NOT, its own docstring says UserPromptSubmit,
and its output shape is additionalContext, not a permissionDecision. The
two events take different stdin and produce different stdout, so copying
from the wrong one silently produces a hook that never decides anything.
stdin carries {"tool_name": ..., "tool_input": {...}}. To
AUTO-ALLOW, print one line of JSON to stdout:

    {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                             "permissionDecision": "allow",
                             "permissionDecisionReason": "..."}}

and exit 0. To leave the decision to the normal flow (uncertain, risky, or
not a Bash call at all), print NOTHING and exit 0 -- this is deliberately
the same "do nothing" shape as a hook that never ran, so a bug here degrades
to today's behaviour, never to a block and never to a silent bypass.
"""
import json
import os
import re
import shlex
import sys

def _install_dir():
    """The marveen install root, derived from THIS FILE'S OWN location, not
    from $HOME. Same pattern as scripts/hooks/provenance-gate.py's
    _install_dir(): when this hook runs, $HOME is the CALLING AGENT's own
    home (e.g. /home/agent-barracuda), never the shared install root --
    measured directly, by running this script as a subprocess under
    agent-murena's own $HOME and finding the profile file silently
    unreadable, which is worse than a loud failure, since a "not found"
    profile makes `decide()` return None just like a genuinely unsafe
    command would, and the two look identical from the outside."""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


PROFILE_PATH_DEFAULT = os.path.join(
    _install_dir(), "templates", "profiles", "researcher-reader.json",
)

_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# find/-exec family: any of these turn a "read-only" find into a write or an
# arbitrary-command execution. Presence of ANY of these anywhere in a find
# segment disqualifies that segment, full stop.
_FIND_DANGEROUS_FLAGS = {
    "-exec", "-execdir", "-delete", "-fprintf", "-ok", "-okdir", "-fls",
}

# sed: short-option bundles can hide -i (e.g. "-ni"). Anything starting with
# exactly one "-" (not "--") that contains the letter "i" is treated as
# carrying -i, which is a conservative over-match FOR SED SPECIFICALLY (sed
# has no other short flag that uses "i"), never an under-match.
_SED_LONG_INPLACE = re.compile(r"^--in-place(=.*)?$")


def _basename(tok: str) -> str:
    return tok.rsplit("/", 1)[-1]


def read_only_binaries_from_profile(profile: dict) -> set:
    """The set of program names/paths this gate treats as read-only,
    derived from the given profile's filesystem.allow list -- not a second,
    hand-typed copy (acrobot's explicit condition A). The hook passes
    researcher-reader.json (PROFILE_PATH_DEFAULT) for EVERY agent, not the
    calling agent's own profile (card 31a2e450). Only entries of the
    exact shape `Bash(<prog>:*)` are taken, and only for a fixed set of
    known-read-only coreutils; the profile also allow-lists specific
    scripts (jsonl.sh, unas.sh, ...) that this gate deliberately does NOT
    grant, because their internals are not visible to a static command-line
    check (unas.sh itself has a documented write path, `post_write`).
    """
    KNOWN_READ_ONLY = {
        "ls", "cat", "grep", "head", "tail", "wc", "sort", "uniq", "cut",
        "sed", "stat", "file", "md5sum", "tr", "nl", "pwd", "echo", "date",
        "df", "ps", "find",
    }
    out = set()
    for rule in profile.get("filesystem", {}).get("allow", []):
        m = re.match(r"^Bash\(([^:]+):\*\)$", rule)
        if not m:
            continue
        prog = m.group(1).strip()
        # "sed -n" and "find ${AGENT_DIR}" etc: take the leading program
        # token, drop the rest (per-command scoping is enforced separately,
        # not derived from this string).
        prog_tok = prog.split()[0]
        if _basename(prog_tok) in KNOWN_READ_ONLY:
            out.add(prog_tok)
            out.add(_basename(prog_tok))
    return out


def deny_fragments_from_profile(profile: dict) -> list:
    """The path-SEGMENT names (not full absolute paths) that must not
    appear anywhere in any argument. Taken from filesystem.deny -- the SAME
    file the profile itself is built from, so a change there is not a
    second place to edit. Only Read()/Write()/Edit() path rules are used;
    Bash(...) deny rules (sudo, rm, git push, curl -X POST, sed -i) are
    enforced by the syntax checks below, not by path matching.

    DELIBERATELY NOT anchored to the resolved ${HOME} absolute prefix. The
    real threat is "an argument reaches into store/ or .channels-config/ AT
    ALL", from whatever base a variable happens to expand to -- acrobot's
    own test cases use `<barmi>/store/...` (ANY prefix). Anchoring to
    "/home/marveen/marveen/store/" would miss "/whatever/store/x" and
    "$S/store/x" alike, which is exactly the gap a variable-tolerant check
    must not have. Matching is done on PATH-SEGMENT boundaries (see
    `_matches_deny_fragment`), not a raw substring, so "restore/x" does not
    false-positive on "store".
    """
    out = []
    for rule in profile.get("filesystem", {}).get("deny", []):
        m = re.match(r"^(?:Read|Write|Edit)\((.+)\)$", rule)
        if not m:
            continue
        pattern = m.group(1).replace("${HOME}", "")
        # Drop leading globs/slashes and trailing globs, keep the last
        # meaningful path segment: ".channels-config/**" -> ".channels-config",
        # "store/**" -> "store", "**/.env" -> ".env", ".env" -> ".env".
        stem = re.sub(r"^\*+/?", "", pattern)
        stem = re.sub(r"/?\*+$", "", stem)
        stem = stem.strip("/")
        segment = stem.rsplit("/", 1)[-1] if stem else ""
        if segment:
            out.append(segment)
    return out


def _matches_deny_fragment(token: str, fragment: str) -> bool:
    """True if `fragment` appears in `token` as a full path segment
    (bounded by "/" or the ends of the string), not merely as a substring
    -- so "store" catches "/x/store/y" and "store/y" but not "restore/y"."""
    return re.search(
        r"(^|/)" + re.escape(fragment) + r"(/|$)", token
    ) is not None


def _new_segment_buf():
    return {"cmd": [], "redirect": None, "target": []}


def _finalize_segment(buf) -> dict:
    """Turns a scanning buffer into the segment dict `_segment_is_readonly`
    consumes: {"text": <command text>, "redirect": None | {"append": bool,
    "target": <raw target text, quotes intact>}}."""
    redirect = None
    if buf["redirect"] is not None:
        redirect = {"append": buf["redirect"], "target": "".join(buf["target"])}
    return {"text": "".join(buf["cmd"]), "redirect": redirect}


def _split_top_level(cmd: str):
    """Quote-aware split on top-level ; && || |, AND a hard reject if a
    forbidden metacharacter ($( or backtick) appears outside single quotes.
    Double quotes do NOT protect $(...) or backticks from the real shell,
    so they are scanned too -- only single-quoted text is truly inert.

    `>`/`>>` no longer force an outright reject (see the module docstring's
    "ONE EXCEPTION", 2026-09-23): once seen, unquoted, everything up to the
    next top-level separator (or end of command) is captured as that
    segment's REDIRECT TARGET, not as ordinary command text -- so it can be
    resolved and checked against the caller's own scratchpad separately in
    `_segment_is_readonly`, instead of disqualifying the segment outright.
    A SECOND unquoted `>` while already capturing a target (`cmd > a > b`)
    is still a hard reject: one redirect per segment is all this hook
    reasons about.

    Returns (segments, forbidden) where forbidden is True if scanning must
    stop and the whole command must be treated as unsafe. `segments` is a
    list of dicts, see `_finalize_segment`.
    """
    segments = []
    buf = _new_segment_buf()
    i, n = 0, len(cmd)
    q = None  # None | "'" | '"'
    while i < n:
        ch = cmd[i]
        dest = buf["target"] if buf["redirect"] is not None else buf["cmd"]
        if q:
            if ch == "\\" and q == '"' and i + 1 < n:
                dest.append(cmd[i:i + 2])
                i += 2
                continue
            if ch == q:
                q = None
            dest.append(ch)
            i += 1
            continue
        if ch == "'":
            q = ch
            dest.append(ch)
            i += 1
            continue
        if ch == '"':
            q = ch
            dest.append(ch)
            i += 1
            continue
        if ch == "\\" and i + 1 < n:
            dest.append(cmd[i:i + 2])
            i += 2
            continue
        # forbidden metacharacters, unquoted
        if ch == "`":
            return None, True
        if ch == "$" and i + 1 < n and cmd[i + 1] == "(":
            return None, True
        if ch == ">":
            if buf["redirect"] is not None:
                # a second redirect on the same segment: too clever, refuse.
                return None, True
            append = i + 1 < n and cmd[i + 1] == ">"
            buf["redirect"] = append
            i += 2 if append else 1
            continue
        # segment separators. A bare newline is shell-equivalent to ";"
        # (sequential execution) -- acrobot's real barracuda example is a
        # variable assignment on its own line followed by the command that
        # uses it, so a newline must split into segments, not reject
        # outright. Each resulting segment is still independently checked.
        if ch == "|" and i + 1 < n and cmd[i + 1] == "|":
            segments.append(_finalize_segment(buf)); buf = _new_segment_buf(); i += 2; continue
        if ch == "&" and i + 1 < n and cmd[i + 1] == "&":
            segments.append(_finalize_segment(buf)); buf = _new_segment_buf(); i += 2; continue
        if ch in ("|", ";", "\n"):
            segments.append(_finalize_segment(buf)); buf = _new_segment_buf(); i += 1; continue
        if ch == "&":
            # background execution (single &): not a read shape either.
            return None, True
        dest.append(ch)
        i += 1
    if q is not None:
        # unterminated quote -- cannot reason about it, refuse to auto-allow
        return None, True
    segments.append(_finalize_segment(buf))
    return segments, False


def _sed_has_inplace(tokens) -> bool:
    for t in tokens:
        if _SED_LONG_INPLACE.match(t):
            return True
        if t.startswith("-") and not t.startswith("--") and "i" in t[1:]:
            return True
    return False


def _find_has_danger(tokens) -> bool:
    return any(t in _FIND_DANGEROUS_FLAGS for t in tokens)


_VAR_REF = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")
_SIMPLE_ASSIGNMENT_VALUE = re.compile(r"^[^$`]*$")  # no nested variable, no substitution


def _pure_assignment_tokens(tokens):
    """If EVERY token in a segment is a NAME=value assignment, return the
    list of (name, value) pairs; otherwise None. A segment like this is a
    shell variable-definition statement on its own, not a command."""
    if not tokens or not all(_ENV_ASSIGN.match(t) for t in tokens):
        return None
    pairs = []
    for t in tokens:
        name, value = t.split("=", 1)
        pairs.append((name, value))
    return pairs


def _resolve_or_flag(token: str, bindings: dict):
    """Substitutes every ${VAR}/$VAR reference using `bindings` (name ->
    resolved string). Returns (resolved_text, ok). ok is False the moment
    ANY variable reference in the token is NOT a known, simply-assigned
    binding from EARLIER in the same command block -- per acrobot's rule,
    an unresolved variable must make the gate fall back to asking, not
    silently pass on the strength of whatever literal text remains after
    stripping it out.
    """
    ok = True

    def repl(m):
        nonlocal ok
        name = m.group(1) or m.group(2)
        if name not in bindings:
            ok = False
            return ""
        return bindings[name]

    resolved = _VAR_REF.sub(repl, token)
    return resolved, ok


def _own_scratchpad_prefix() -> str:
    """The scratchpad root Claude Code itself creates for the process this
    hook is running under -- `/tmp/claude-<uid>` -- derived from the REAL
    uid of the calling process, never from an argument or a profile field.
    When this script eventually runs as a PreToolUse hook for barracuda, the
    hook process inherits barracuda's own uid (same reasoning as
    `_install_dir()`'s $HOME note above), so `os.getuid()` here is
    barracuda's, not murena's. This is also why the prefix is trustworthy
    even if this gate's own logic had a bug: the directory is mode 0700, so
    a different agent's uid cannot write there regardless of what this hook
    decides."""
    return f"/tmp/claude-{os.getuid()}"


def _is_own_scratchpad_target(resolved: str) -> bool:
    """True if `resolved` is an ABSOLUTE path bounded inside the caller's
    own `/tmp/claude-<uid>` root -- bounded, so `/tmp/claude-10034/x` (a
    DIFFERENT uid that merely starts with the same digits) does not
    false-positive on uid 1003, mirroring `_matches_deny_fragment`'s own
    segment-boundary discipline. A relative target (no leading "/") is
    never trusted: without a known cwd this hook cannot say where it
    actually lands, so it is treated as outside the scratchpad.

    NORMALISED FIRST, DELIBERATELY: a naive prefix check on the raw text
    would pass `/tmp/claude-1004/../claude-1003/x` (textually starts with
    the right prefix) even though it actually lands in a DIFFERENT agent's
    scratchpad once the shell resolves `..` -- `os.path.normpath` collapses
    that before the boundary check runs, closing exactly that escape."""
    if not resolved.startswith("/"):
        return False
    normalised = os.path.normpath(resolved)
    prefix = _own_scratchpad_prefix()
    if normalised == prefix:
        return True
    return normalised.startswith(prefix + "/")


def _segment_is_readonly(segment: dict, safe_bins: set, deny_fragments: list,
                          bindings: dict):
    """Returns True/False for one already-split segment (the dict shape
    `_finalize_segment` produces: {"text": ..., "redirect": None |
    {"append": bool, "target": <raw text>}}). A PURE assignment segment
    (e.g. "S=/tmp/x") is not a command: it updates `bindings` (in place,
    visible to later segments, matching real shell order) and counts as
    read-only on its own -- a redirect attached to a pure-assignment
    segment (a shape nobody's real command has, e.g. "S=/tmp/x > out") is
    refused outright rather than guessed at. Raises ValueError on anything
    shlex cannot tokenise (unterminated quote inside the segment, etc.) --
    caller treats that as "not readonly".
    """
    redirect = segment["redirect"]
    tokens = shlex.split(segment["text"], posix=True)
    if not tokens:
        return redirect is None  # an empty segment (e.g. from "a;;b") is a no-op
    pairs = _pure_assignment_tokens(tokens)
    if pairs is not None:
        if redirect is not None:
            return False
        for name, value in pairs:
            if _SIMPLE_ASSIGNMENT_VALUE.match(value):
                bindings[name] = value
            # else: leave unbound -- a later reference to it will correctly
            # fail resolution rather than pick up a half-resolved guess.
        return True
    while tokens and _ENV_ASSIGN.match(tokens[0]):
        tokens = tokens[1:]
    if not tokens:
        return False
    prog, prog_ok = _resolve_or_flag(tokens[0], bindings)
    if not prog_ok:
        return False
    prog_name = _basename(prog)
    if prog not in safe_bins and prog_name not in safe_bins:
        return False
    rest = tokens[1:]
    if prog_name == "sed" and _sed_has_inplace(rest):
        return False
    if prog_name == "find" and _find_has_danger(rest):
        return False
    for tok in rest:
        resolved, ok = _resolve_or_flag(tok, bindings)
        if not ok:
            return False
        for frag in deny_fragments:
            if frag and _matches_deny_fragment(resolved, frag):
                return False
    if redirect is not None:
        target_tokens = shlex.split(redirect["target"], posix=True)
        if len(target_tokens) != 1:
            # no target, or an ambiguous multi-token target: refuse.
            return False
        target_resolved, target_ok = _resolve_or_flag(target_tokens[0], bindings)
        if not target_ok:
            return False
        for frag in deny_fragments:
            if frag and _matches_deny_fragment(target_resolved, frag):
                return False
        if not _is_own_scratchpad_target(target_resolved):
            return False
    return True


def is_readonly_command(cmd: str, safe_bins: set, deny_fragments: list) -> bool:
    if not cmd or not cmd.strip():
        return False
    segments, forbidden = _split_top_level(cmd)
    if forbidden or segments is None:
        return False
    if not segments:
        return False
    bindings: dict = {}
    try:
        for seg in segments:
            if not seg["text"].strip() and seg["redirect"] is None:
                continue
            if not _segment_is_readonly(seg, safe_bins, deny_fragments, bindings):
                return False
        return True
    except ValueError:
        return False


def load_profile(path: str = PROFILE_PATH_DEFAULT):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def decide(tool_name: str, tool_input: dict, profile_path: str = PROFILE_PATH_DEFAULT):
    """Returns an "allow" reason string, or None (do not intervene)."""
    if tool_name != "Bash":
        return None
    cmd = str(tool_input.get("command") or "")
    if not cmd.strip():
        return None
    try:
        profile = load_profile(profile_path)
    except Exception:
        return None  # missing/unreadable profile: never auto-allow
    safe_bins = read_only_binaries_from_profile(profile)
    deny_fragments = deny_fragments_from_profile(profile)
    if not safe_bins or not deny_fragments:
        return None  # empty derived lists look like a broken profile read
    if is_readonly_command(cmd, safe_bins, deny_fragments):
        return (
            "OLVASO PARANCS KAPU: automatikusan engedve. Minden tag a "
            "profil sajat olvaso-listajan all, nincs behelyettesites vagy "
            "helyben-iras, minden valtozo-hivatkozas feloldva a blokk "
            "sajat NEV=ertek hozzarendeleseibol, a feloldott szoveg egyik "
            "argumentumban sem tartalmaz tiltott utvonal-toredeket, es ha "
            "van atiranyitas, annak feloldott celja a hivo SAJAT "
            "scratchpadjeben (/tmp/claude-<uid>) all."
        )
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    tool = str(payload.get("tool_name") or "")
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        return 0
    reason = decide(tool, tool_input)
    if reason is None:
        return 0
    sys.stdout.write(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": reason,
        }
    }, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Any unexpected failure must degrade to "do not intervene", never
        # to a block and never to a silent allow.
        sys.exit(0)
