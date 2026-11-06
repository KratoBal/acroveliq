#!/usr/bin/env python3
"""ANSWERS: Fogy-e a flotta gepenek memoriaja, es ha igen, melyik TETLEN agenst lehet leallitani, amig helyre nem all?

memoria-or.py   (cronbol percenkent, marveen-kent, a tetlen-or mellett; nem LLM)

WHY (task flotta-memoria-or, acrobot 44384; Balazs 2026-11-06 12:14 UTC: "Ez azert eleg ilyeszto... es egyre
gyakrabban fordul elo"): 12:1x a gep kifogyott a memoriabol (144 MB szabad, 3,4 GB swap, si/so 30-60k/s, load 100),
egy futtaton kivul inditott 3 GB-os tsc hat claude munkamenet mellett. 2026-10-20 negy OOM-gyilkossag, 11-04 fagyas.
A futtat zarja csak sorba allit, a memoriat nem vedi.

WHAT IT DOES, one step per run (a step changes the memory, the next run measures again):
  PRESSURE = MemAvailable < 1 GB, or the swap-in rate above 2500 pages/s on two runs in a row (sustained).
    Under pressure it stops ONE idle agent, lowest priority first (korall, polip, picasso, barracuda, murena,
    nautilus; never acrobot), through the dashboard (POST /api/agents/<name>/stop, acrobot's token: the access
    matrix's agent-lifecycle group already grants the main agent this). IDLE is what the panel says: the idle footer
    and no busy marker (a turn, a token counter, a still-running shell). A panel without the footer is a modal (a
    permission prompt): never stopped. An agent it cannot reach is skipped.
  RECOVERED = MemAvailable > 2.5 GB, continuously for 10 minutes. Then it starts back ONE agent IT stopped per run
    (POST /start, not fresh: the agent continues its conversation), the highest priority first, and only those.
Every stop and start is recorded in store/memoria-or.state and goes to acrobot's daily log as one line (not a
message: a message would wake a language-model turn under memory pressure). Idempotent: an agent already stopped
by it is not stopped again; one it did not stop is never started.
MEMORIA_OR_DRY_RUN=on: it measures and says what it would do, and touches neither an agent nor the state's list.

The test hands in a fake tree and a fake /proc (MEMORIA_OR_ROOT, MEMORIA_OR_MEMINFO, MEMORIA_OR_VMSTAT,
MEMORIA_OR_NOW, MEMORIA_OR_CURL); in production all are empty.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

ROOT = os.environ.get("MEMORIA_OR_ROOT") or "/home/marveen/marveen"
MEMINFO = os.environ.get("MEMORIA_OR_MEMINFO") or "/proc/meminfo"
VMSTAT = os.environ.get("MEMORIA_OR_VMSTAT") or "/proc/vmstat"
CURL = os.environ.get("MEMORIA_OR_CURL") or "curl"
API = os.environ.get("MEMORIA_OR_API") or "http://localhost:3420"
STATE = os.path.join(ROOT, "store", "memoria-or.state")
TOKEN = os.path.join(ROOT, "store", "tokens", "acrobot.token")
DRY_RUN = (os.environ.get("MEMORIA_OR_DRY_RUN") or "").strip().lower() == "on"

LOW_KB = 1024 * 1024  # 1 GB
HIGH_KB = 2560 * 1024  # 2.5 GB
RECOVER_SECONDS = 600
SWAPIN_PAGES_PER_S = 2500  # about 10 MB/s with 4 kB pages; 12:1x showed 30-60k kB/s
# lowest priority first; acrobot is never on it
PRIORITY = ["korall", "polip", "picasso", "barracuda", "murena", "nautilus"]

BUSY = re.compile(r"esc to interrupt|\(\d+s (·|\.)|still running")
IDLE_FOOTER = ("bypass permissions on", "? for shortcuts")


def now() -> int:
    value = os.environ.get("MEMORIA_OR_NOW")
    return int(value) if value else int(time.time())


def read_kv(path: str, sep: str) -> dict[str, int]:
    out: dict[str, int] = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            key, _, rest = line.partition(sep)
            parts = rest.split()
            if parts and parts[0].isdigit():
                out[key.strip()] = int(parts[0])
    return out


def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as fh:
            state = json.load(fh)
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, sort_keys=True)
    os.replace(tmp, STATE)


def pane_state(agent: str) -> str:
    """idle | busy | modal | unreachable, from the agent's panel as agent-pane.sh reads it."""
    result = subprocess.run(["bash", os.path.join(ROOT, "scripts", "agent-pane.sh"), agent],
                            capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return "unreachable"
    pane = "\n".join(result.stdout.splitlines()[-25:])
    if not pane.strip():
        return "unreachable"
    if BUSY.search(pane):
        return "busy"
    if any(footer in pane for footer in IDLE_FOOTER):
        return "idle"
    return "modal"


def lifecycle(agent: str, action: str) -> bool:
    """POST /api/agents/<agent>/<action> with acrobot's token; True on a 2xx. The token goes in a header file
    descriptor (curl -H @-), never on a command line."""
    try:
        with open(TOKEN, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError:
        print(f"FAIL: no readable token ({TOKEN})")
        return False
    result = subprocess.run(
        [CURL, "-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "-H", "@-",
         "-H", "Content-Type: application/json", "--data", "{}", f"{API}/api/agents/{agent}/{action}"],
        input=f"Authorization: Bearer {token}\n", capture_output=True, text=True, timeout=60)
    code = result.stdout.strip()
    ok = result.returncode == 0 and code.startswith("2")
    if not ok:
        print(f"FAIL: {action} {agent} answered HTTP {code or '-'} (curl {result.returncode})")
    return ok


def daily_line(text: str) -> None:
    subprocess.run(["bash", os.path.join(ROOT, "scripts", "daily-log.sh"), "acrobot", "Memoria-or", text],
                   capture_output=True, text=True, timeout=60)


def main() -> int:
    t = now()
    mem = read_kv(MEMINFO, ":")
    available = mem.get("MemAvailable")
    if available is None:
        print("FAIL: no MemAvailable in", MEMINFO)
        return 1
    swapin = read_kv(VMSTAT, " ").get("pswpin")
    state = load_state()
    stopped: list[str] = [a for a in state.get("stopped", []) if a in PRIORITY]

    rate = None
    hot = 0
    last = state.get("swap")
    if swapin is not None and isinstance(last, dict) and t > last.get("t", t):
        rate = (swapin - last.get("pswpin", swapin)) / (t - last["t"])
        hot = last.get("hot", 0) + 1 if rate > SWAPIN_PAGES_PER_S else 0
    if swapin is not None:
        state["swap"] = {"pswpin": swapin, "t": t, "hot": hot}

    mb = available // 1024
    measured = f"MemAvailable {mb} MB" + (f", swap-in {rate:.0f} lap/s" if rate is not None else "")
    pressure = available < LOW_KB or hot >= 2
    action = None

    if pressure:
        state.pop("high_since", None)
        for agent in PRIORITY:
            if agent in stopped:
                continue
            where = pane_state(agent)
            if where != "idle":
                continue
            action = ("stop", agent)
            break
        if action is None:
            print(f"{measured}: nyomas, de nincs tetlen agens, amit le lehetne allitani")
    elif available > HIGH_KB:
        since = state.get("high_since")
        if not isinstance(since, int):
            state["high_since"] = t
        elif t - since >= RECOVER_SECONDS and stopped:
            action = ("start", next(a for a in reversed(PRIORITY) if a in stopped))
    else:
        state.pop("high_since", None)

    if action:
        verb, agent = action
        if DRY_RUN:
            print(f"{measured}: DRY RUN, {verb} {agent} lenne")
        elif lifecycle(agent, verb):
            if verb == "stop":
                stopped.append(agent)
                line = f"{measured}: leallitottam a tetlen {agent} agenst (leallitva: {', '.join(stopped)})"
            else:
                stopped.remove(agent)
                line = f"{measured} 10 perce: visszainditottam {agent} agenst (folytatja; meg leallitva: {', '.join(stopped) or 'senki'})"
            print(line)
            daily_line(line)
        elif verb == "start" and pane_state(agent) != "unreachable":
            # somebody started it in the meantime: it is not ours to start any more, and must not block the others
            stopped.remove(agent)
            print(f"{agent} mar fut (nem en inditottam), lekerult a listamrol")
    # a dry run leaves the list as it was
    state["stopped"] = state.get("stopped", []) if DRY_RUN else stopped
    save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
