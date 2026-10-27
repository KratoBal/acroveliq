#!/usr/bin/env python3
"""PermissionRequest hook: a Bash permission prompt goes to the owner's phone
(the #33 Discord approval), not to a terminal nobody is sitting at.

WHY (B48 pótlás, Balázs 2026-10-16 10:32-10:36 UTC, Token szál): "en nem fogok
gep elott ulni mindig. ha nem veszem most eszre akkor meddig allt volna?".
barracuda stood 16 minutes on a prompt. The B48 broker (fleet-pane) refuses to
answer prompts on purpose, and acrobot must not get that key back
(b48-kezbesito-terv 4.5). So no key is pressed: this hook answers the prompt
itself, with the owner's Discord decision or with a deny that says why.

WHEN IT RUNS: Claude Code fires PermissionRequest exactly when its own engine
would show a permission dialog, so this hook does not guess what the engine
would ask (barracuda, plan review 32016 d). It is wired for strict-profile
agents only (a permissive one runs with --dangerously-skip-permissions and
never asks), matcher Bash.

TWO MODES, from store/permission-approval.json ({"mode": "eles"}); a missing
or unreadable file is "arnyek". The hook runs as the AGENT's user, so the file
must be world-readable (0644, written by root or marveen, never by an agent):
a 0600 file reads as shadow forever, silently (barracuda, #219 review):
  arnyek  decides nothing (the dialog comes as today) and tells the main agent
          what it would have asked: the first two words after secret masking,
          the length, a sha256 prefix, and what the live mode would do.
  eles    asks on Discord and answers allow or deny.

THE LIVE PATH AND ITS BINDINGS (barracuda 32016, 32022):
  - the description is the WHOLE command and its working directory, encoded so
    that #33's neutralDescription leaves it unchanged (its markdown characters
    become look-alike glyphs, a newline becomes ⏎). A command that cannot be
    shown whole (too long, a look-alike glyph already in it, other control
    whitespace) is denied with that reason, never shortened;
  - a command with anything secret-shaped (scripts/futtat.py's masker) is
    denied and nothing goes to Discord;
  - allow only if THIS hook's approval row is approved AND its description is
    letter for letter the one built from the running tool_input, AND it was
    decided by one of two parties: the owner on Discord (decision_ref
    "discord:..."), or the MAIN agent over the API (resolved_by is the id in
    store/.main-agent-id), and then only for a SUB-agent's row. Owner decision
    2026-10-27 09:17 UTC: a sub-agent's command stop is judged by the main
    agent. The server writes resolved_by from the credential (an agent token
    names its holder; the shared token and a device cannot decide a
    bash_command row at all), so a sub-agent cannot pass as the main agent in
    the body. The main agent's OWN stops stay Discord-only: nobody else judges
    its commands;
  - the deny says who decided: the owner's rejection and a timeout are two
    different texts, because the agent writes on the card what it gets;
  - the output is behavior and message only, never updatedPermissions: a "yes"
    is one-time, for this command, never a standing rule;
  - the same command and directory again within 10 minutes: a rejection or a
    timeout comes back without a new request, a pending one is waited on; an
    approved one is never reused.

WHAT THIS IS NOT: a boundary against a hostile agent. An agent that can write
its own .claude/settings.json can drop this hook or add an allow rule (B45 C,
measured by barracuda 2026-10-16). This is the honest agent's way out of a
prompt nobody would answer.

Output contract (the 2.1.301 binary's schema): print
{"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                        "decision": {"behavior": "allow" | "deny", "message": "..."}}}
or nothing (the dialog shows as today).
"""
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MODE_FILE = os.path.join(BASE, "store", "permission-approval.json")
CATEGORY = "bash_command"
APPROVAL_SECONDS = 14 * 60
POLL_SECONDS = 5
REPEAT_SECONDS = 10 * 60
# src/web/approval-discord-core.ts DESCRIPTION_MAX
DESCRIPTION_MAX = 500

# what #33's neutralDescription would change, and the look-alike it is shown as
_GLYPHS = {
    "`": "ˋ",   # MODIFIER LETTER GRAVE ACCENT
    ">": "›",   # SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
    "#": "♯",   # MUSIC SHARP SIGN
    "*": "∗",   # ASTERISK OPERATOR
    "_": "＿",   # FULLWIDTH LOW LINE
    "~": "∼",   # TILDE OPERATOR
    "|": "¦",   # BROKEN BAR
    "\n": "⏎",  # RETURN SYMBOL
    "\t": "⇥",  # RIGHTWARDS ARROW TO BAR
}
_EXTRA_SPACE = "␣"  # OPEN BOX: the second and later space of a run
# what each look-alike stands for, said in words: on a phone a redirect or a
# pipe glyph reads as an ordinary letter, and those decide what is approved
_LEGEND = {
    _GLYPHS[">"]: "atiranyitas", _GLYPHS["|"]: "cso", _GLYPHS["_"]: "alahuzas",
    _GLYPHS["*"]: "csillag", _GLYPHS["#"]: "kettoskereszt", _GLYPHS["~"]: "hullam",
    _GLYPHS["`"]: "backtick", _GLYPHS["\n"]: "uj sor", _GLYPHS["\t"]: "tab",
    _EXTRA_SPACE: "tobblet szokoz",
}


def encode(text: str):
    """The text as #33 can show it unchanged, or (None, reason)."""
    used = set(_GLYPHS.values()) | {_EXTRA_SPACE}
    if any(ch in used for ch in text):
        return None, "a parancsban mar szerepel egy megjelenito-jel, amit a Discord-keres hasznal"
    out = []
    prev_space = False
    for ch in text:
        if ch == " ":
            out.append(_EXTRA_SPACE if prev_space else " ")
            prev_space = True
            continue
        prev_space = False
        if ch in _GLYPHS:
            out.append(_GLYPHS[ch])
        elif ch.isspace() or (ord(ch) < 32):
            return None, "a parancsban vezerlo- vagy szokatlan szokoz-karakter van"
        else:
            out.append(ch)
    s = "".join(out)
    if s != s.strip():
        return None, "a parancs szokozzel kezdodik vagy vegzodik"
    return s, None


def neutral_description(text: str) -> str:
    """src/web/approval-discord-core.ts neutralDescription, the same rules."""
    flat = re.sub(r"\s+", " ", re.sub(r"[`>#*_~|]", " ", text)).strip()
    cut = flat[:DESCRIPTION_MAX] + "..." if len(flat) > DESCRIPTION_MAX else flat
    return "> " + cut


def description(command: str, cwd: str):
    """The approval text: working directory and the whole command, or (None, reason)."""
    c, why = encode(command)
    if c is None:
        return None, why
    d, why = encode(cwd or "?")
    if d is None:
        return None, "a munkakonyvtar: " + why
    text = "PARANCS cwd=%s :: %s" % (d, c)
    used = [g for g in _LEGEND if g in text]
    if used:
        text += " [jelek: %s]" % ", ".join("%s %s" % (g, _LEGEND[g]) for g in used)
    if len(text) > DESCRIPTION_MAX:
        return None, "a parancs tul hosszu a Discord-kereshez (%d > %d jel), bontsd fel" % (len(text), DESCRIPTION_MAX)
    if neutral_description(text) != "> " + text:
        return None, "a parancs nem mutathato meg valtozatlanul a Discord-keresben, bontsd fel"
    return text, None


def _load_masker():
    spec = importlib.util.spec_from_file_location("futtat_masker", os.path.join(BASE, "scripts", "futtat.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        hashes = mod.load_hashes()
    except Exception:
        hashes = {}  # the hash list is not this agent's to read: the patterns still run
    return mod.Masker(hashes)


def secret_shaped(text: str) -> bool:
    masker = _load_masker()
    for line in text.splitlines() or [text]:
        masker.line(line)
    return masker.count > 0


def output(behavior: str, message: str = None) -> dict:
    decision = {"behavior": behavior}
    if message:
        decision["message"] = message
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}


def deny(message: str) -> dict:
    return output("deny", "JOVAHAGYASI KAPU: " + message)


class Api:
    """The dashboard, with the calling agent's own token."""

    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def call(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode() or "null")


def _cache_path() -> str:
    return os.path.join(os.path.expanduser("~"), ".cache", "permission-approval.json")


def _cache_read(path: str) -> dict:
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _cache_write(path: str, cache: dict, now: float) -> None:
    keep = {k: v for k, v in cache.items() if isinstance(v, dict) and now - v.get("at", 0) < REPEAT_SECONDS}
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(keep, f)
        os.replace(tmp, path)
    except OSError:
        pass  # a lost cache costs one more request, never a wrong decision


def main_agent_id() -> str:
    try:
        with open(os.path.join(BASE, "store", ".main-agent-id")) as f:
            return f.read().strip() or "acrobot"
    except Exception:
        return "acrobot"


def _decider(row: dict, main_agent: str) -> str:
    """Who decided, in words the agent writes on its card: the owner, the main agent, or someone who does not count."""
    who = row.get("resolved_by")
    if str(row.get("decision_ref") or "").startswith("discord:"):
        return "%s (Discord, a gazda)" % who
    if who == main_agent:
        return "%s (a fo agens, NEM a gazda)" % who
    return "%s (nem Discord, nem a fo agens)" % who


def _verdict(row: dict, text: str, agent: str, main_agent: str = None):
    """allow/deny for a decided row, None while it is pending."""
    main_agent = main_agent or main_agent_id()
    # the row must be THIS agent's, on every path: a cached id is the agent's own
    # writable file, and could point at another agent's row with the same text
    # (barracuda, #219 review 1)
    if row.get("agent_id") != agent:
        return deny("a jovahagyas sora nem ennek az agensnek szol, nem futtatom")
    status = row.get("status")
    if status == "pending":
        return None
    if row.get("action_description") != text or row.get("category") != CATEGORY:
        return deny("a jovahagyas sora nem ezt a parancsot irja le, nem futtatom")
    on_discord = str(row.get("decision_ref") or "").startswith("discord:")
    by_main_agent = row.get("resolved_by") == main_agent and agent != main_agent
    if status == "approved":
        if not (on_discord or by_main_agent):
            return deny("a jovahagyas nem a gazda Discord-valaszabol es nem a fo agenstol (%s) szuletett (dontott: %s); a sub-agens parancsat a fo agens vagy a gazda donti el" % (main_agent, row.get("resolved_by")))
        return output("allow")
    if status == "rejected":
        return deny("elutasitva, dontott: %s. Jelentsd a kartyan pontosan igy, ne probald ujra ugyanigy." % _decider(row, main_agent))
    if status == "timeout":
        return deny("nem jott valasz %d percen belul (a fo agens sem dontott). Senki nem utasitotta el, ez NEM emberi dontes: jelentsd, hogy a parancs jovahagyasra var." % (APPROVAL_SECONDS // 60))
    return deny("ismeretlen jovahagyasi allapot: %s" % status)


def live(command: str, cwd: str, agent: str, api: Api, cache_path: str,
         now=time.time, sleep=time.sleep, main_agent: str = None) -> dict:
    text, why = description(command, cwd)
    if text is None:
        return deny(why)
    if secret_shaped(command) or secret_shaped(cwd or ""):
        return deny("a parancsban titoknak vagy szemelyes adatnak latszo resz van, nem kuldom Discordra. Bontsd fel, vagy a titkot fajlbol olvasd.")
    key = hashlib.sha256(text.encode()).hexdigest()
    cache = _cache_read(cache_path)
    hit = cache.get(key)
    row = None
    if isinstance(hit, dict) and now() - hit.get("at", 0) < REPEAT_SECONDS:
        if hit.get("outcome") in ("rejected", "timeout"):
            return deny("ugyanezt %d percen belul mar elbiraltak (%s), uj kerest nem kuldok. Jelentsd." % (REPEAT_SECONDS // 60, hit["outcome"]))
        if hit.get("id"):
            try:
                old = api.call("GET", "/approvals/%s" % hit["id"])
                if (isinstance(old, dict) and old.get("status") == "pending" and old.get("action_description") == text
                        and old.get("agent_id") == agent):
                    row = old  # wait on the pending one; an approved one is never reused
            except Exception:
                row = None
    if row is None:
        try:
            row = api.call("POST", "/approvals", {
                "agent_id": agent, "category": CATEGORY, "action_description": text,
                "timeout_seconds": APPROVAL_SECONDS,
            })
        except Exception as e:
            return deny("a jovahagyasi ut nem erheto el (%s). Jelentsd." % type(e).__name__)
        if not isinstance(row, dict) or row.get("action_description") != text or row.get("agent_id") != agent:
            return deny("a dashboard mast rogzitett, mint amit kertem; nem varok ra")
        cache[key] = {"id": row.get("id"), "at": now(), "outcome": "pending"}
        _cache_write(cache_path, cache, now())
    deadline = now() + APPROVAL_SECONDS + POLL_SECONDS
    while True:
        verdict = _verdict(row, text, agent, main_agent)
        if verdict is not None:
            outcome = row.get("status")
            cache[key] = {"id": row.get("id"), "at": now(), "outcome": outcome}
            _cache_write(cache_path, cache, now())
            return verdict
        if now() >= deadline:
            cache[key] = {"id": row.get("id"), "at": now(), "outcome": "timeout"}
            _cache_write(cache_path, cache, now())
            return deny("nem jott valasz %d percen belul. Ez NEM emberi dontes: jelentsd, hogy a parancs jovahagyasra var." % (APPROVAL_SECONDS // 60))
        sleep(POLL_SECONDS)
        try:
            row = api.call("GET", "/approvals/%s" % row.get("id"))
        except Exception:
            continue  # one lost poll is not a decision


def shadow_note(command: str, cwd: str, agent: str) -> str:
    """What the main agent is told in shadow mode: never the whole command."""
    if secret_shaped(command):
        head = "[titok-minta, nem irom ki]"
        would = "deny: titok-minta"
    else:
        head = " ".join(command.split()[:2])[:60]
        text, why = description(command, cwd)
        would = "a fo agens biralja (APPROVAL_REQUEST), a gazdahoz nem megy" if text else "deny: " + why
    return (
        "[ARNYEK] permission-approval: %s engedelyt kerne. eleje='%s' hossz=%d sha=%s cwd=%s. Elesben: %s."
        % (agent, head, len(command), hashlib.sha256(command.encode()).hexdigest()[:8], cwd, would)
    )


def mode() -> str:
    try:
        with open(MODE_FILE) as f:
            return "eles" if json.load(f).get("mode") == "eles" else "arnyek"
    except Exception:
        return "arnyek"


def whoami():
    """(agent, token file) as scripts/lib/dashboard-token.sh decides them."""
    out = subprocess.run(
        ["bash", "-c", '. "$1/scripts/lib/dashboard-token.sh"; dashboard_token_agent "$1" "$(id -un)"; dashboard_token_file "$1"', "_", BASE],
        capture_output=True, text=True, timeout=10,
    ).stdout.split("\n")
    return (out[0].strip(), out[1].strip()) if len(out) > 1 else ("", "")


def main() -> int:
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    if event.get("hook_event_name") != "PermissionRequest" or event.get("tool_name") != "Bash":
        return 0
    command = str((event.get("tool_input") or {}).get("command") or "")
    cwd = str(event.get("cwd") or "")
    if not command.strip():
        return 0
    agent, token_file = whoami()
    if mode() != "eles":
        try:
            main_agent = main_agent_id()
            subprocess.run(
                ["bash", os.path.join(BASE, "scripts", "agent-msg.sh"), agent or "ismeretlen", main_agent, "-"],
                input=shadow_note(command, cwd, agent or "?"), capture_output=True, text=True, timeout=20,
            )
        except Exception:
            pass
        return 0
    if not agent or not token_file.endswith(os.path.join("tokens", agent + ".token")):
        result = deny("az agens sajat dashboard-tokenje nem olvashato, igy nem kerhetek jovahagyast. Jelentsd.")
    else:
        try:
            with open(token_file) as f:
                token = f.read().strip()
            port = os.environ.get("MARVEEN_WEB_PORT", "3420")
            result = live(command, cwd, agent, Api("http://localhost:%s/api" % port, token), _cache_path())
        except Exception as e:
            result = deny("a jovahagyasi kapu hibara futott (%s). Jelentsd." % type(e).__name__)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
