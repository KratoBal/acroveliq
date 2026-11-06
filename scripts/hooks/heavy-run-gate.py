#!/usr/bin/env python3
"""PreToolUse hook (Bash): a heavy run (tsc, a full vitest, turbo/pnpm test, build, typecheck) only through futtat.

NOT WIRED: THIS SCRIPT DOES NOTHING UNTIL A PROFILE TEMPLATE REGISTERS IT. Wiring it into
templates/profiles is a permission_change (locked, level 1): acrobot lists it for Balazs (acrobot 44403,
2026-11-06). Until then no agent's command passes through it.

WHY (task flotta-memoria-or, acrobot 44384): on 2026-11-06 12:1x the fleet box ran out of memory (144 MB free,
3.4 GB swap, si/so 30-60k/s, load 100) after a `tsc` with `--max-old-space-size=3072` started OUTSIDE the futtat
lock, beside six claude sessions; 2026-10-20 four OOM kills, 2026-11-04 a freeze. The futtat lock queues heavy runs
one at a time and (since this task) caps their heap, but nothing made a run go through it.

WHAT IT DOES: it takes the call apart with the deny gate's own normaliser (scripts/hooks/deny-normalizing-gate.py:
`bash -c`, `env`, `$(...)`, `&&`, `;`, absolute paths unwrapped), and denies a simple command that is a heavy run:
  - `tsc` (any project compile; `--version`/`--help` stay allowed), also as `node .../tsc`, `npx tsc`, `pnpm exec tsc`;
  - `vitest` with no file filter (a run naming a spec file or a path stays allowed: that is not the whole suite);
  - `turbo run build|test|typecheck` (and `turbo build|test|typecheck`);
  - `pnpm|npm|yarn [run] test*|build*|typecheck*`, with pnpm's `--filter X`/`-C dir` before the script name.
A heavy run INSIDE futtat is an argument of `futtat.sh run ... --`, not a simple command of its own, so it passes.

WHAT IT DELIBERATELY DOES NOT DO (the same condition as the deny gate: a false block stops an agent): it never
denies what it could not take apart, never allows, never asks. Unreadable input, not a Bash call, an exception:
no output, exit 0, the normal permission flow decides.

NOT COVERED: a heavy run inside a script file the command names (`bash my-build.sh`), an alias, `xargs tsc`.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FUTTAT = "bash /home/marveen/marveen/scripts/futtat.sh run --projekt <projekt> --feladat <task_id> --fajta test -- <parancs>"
HEAVY_SCRIPTS = ("test", "build", "typecheck")
INFO_FLAGS = {"--version", "-v", "--help", "-h", "--showConfig"}
# pnpm/npm/yarn options before the script name that take a value
VALUE_FLAGS = {"--filter", "-F", "-C", "--dir", "--prefix", "-w", "--workspace", "--reporter"}


def _normaliser():
    spec = importlib.util.spec_from_file_location("deny_normalizing_gate", os.path.join(HERE, "deny-normalizing-gate.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _launcher_stripped(tokens):
    """`npx tsc`, `pnpm exec vitest`, `corepack pnpm test`, `node path/to/tsc` -> the tool and its arguments."""
    tokens = list(tokens)
    for _ in range(4):
        if not tokens:
            return tokens
        prog = tokens[0]
        if prog == "corepack":
            tokens = tokens[1:]
        elif prog in ("npx", "bunx"):
            rest = tokens[1:]
            while rest and rest[0].startswith("-"):
                rest = rest[2:] if rest[0] in ("-p", "--package") else rest[1:]
            tokens = rest
        elif prog in ("pnpm", "yarn") and len(tokens) > 1 and tokens[1] in ("exec", "dlx"):
            tokens = tokens[2:]
        elif prog == "node" and len(tokens) > 1:
            rest = tokens[1:]
            while rest and rest[0].startswith("-"):
                rest = rest[1:]
            if rest and os.path.basename(rest[0]) in ("tsc", "vitest", "turbo", "vitest.mjs", "tsc.js"):
                tokens = [os.path.basename(rest[0]).split(".")[0]] + rest[1:]
            else:
                return tokens
        else:
            return tokens
    return tokens


def _script_name(args):
    """The script a `pnpm|npm|yarn` call runs: `run X`, or the first plain word after the options."""
    i = 0
    while i < len(args):
        a = args[i]
        if a in VALUE_FLAGS:
            i += 2
            continue
        if a.startswith("-"):
            i += 1
            continue
        if a in ("run", "run-script"):
            return args[i + 1] if i + 1 < len(args) else None
        return a
    return None


def heavy(tokens):
    """Why this simple command is a heavy run, or None."""
    tokens = _launcher_stripped(tokens)
    if not tokens:
        return None
    prog, args = tokens[0], tokens[1:]
    if prog == "tsc":
        if args and all(a in INFO_FLAGS for a in args):
            return None
        return "tsc (a teljes projekt forditasa)"
    if prog == "vitest":
        if any(a in INFO_FLAGS for a in args):
            return None
        targeted = [a for a in args if not a.startswith("-") and a not in ("run", "watch", "related")
                    and ("/" in a or ".test." in a or ".spec." in a or a.endswith((".ts", ".tsx", ".js", ".mjs")))]
        return None if targeted else "vitest szuro nelkul (a teljes tesztsor)"
    if prog == "turbo":
        words = [a for a in args if not a.startswith("-")]
        task = words[1] if words[:1] == ["run"] and len(words) > 1 else (words[0] if words else None)
        if task and task.split(":")[0] in HEAVY_SCRIPTS:
            return f"turbo {task}"
        return None
    if prog in ("pnpm", "npm", "yarn"):
        name = _script_name(args)
        if name and name.split(":")[0] in HEAVY_SCRIPTS:
            return f"{prog} {name}"
    return None


def find_heavy(command: str):
    # the normaliser splits the call itself, and a part it cannot take apart is dropped, never denied on
    for tokens in _normaliser().normalise(command):
        why = heavy(tokens)
        if why:
            return why, " ".join(tokens)
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0
    if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
        return 0
    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not command.strip():
        return 0
    hit = find_heavy(command)
    if hit is None:
        return 0
    why, normalised = hit
    reason = (
        f"NEHEZ-FUTAS a futtat nelkul: {why} (`{normalised[:160]}`). Nehez futas csak a futtat zaran es "
        f"memoriaplafonjan at mehet, kulonben a flotta gepe kifogy a memoriabol. Igy futtasd: {FUTTAT}"
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
