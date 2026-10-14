#!/usr/bin/env python3
# ANSWERS: Mehet-e ki ez a vita-csomag a GPT-futtatohoz, es ha igen, milyen alakban (szemelyes adat nelkul)?
"""The personal-data boundary of the GPT debate package (task t-20261014-gpt-futtato-kontener,
the multi-model plan's PR 2; nautilus's plan, point 2: the JEV provider boundary's pattern).

The same three conditions as the JEV shadow boundary (scripts/jev/shadow.py), nothing looser:
  1. the leak gate is green for THIS redactor code (store/jev-leak-gate.json: 0 leaks, the
     redaction version and the code hash of the files running now);
  2. redact() in its FULL mode: nothing is kept. The keeping mode (amounts, dates, ids, company
     names) was narrowed by Balázs to ONE task (PD-006, the missing-invoice pairing); using it
     here would be a new decision, not this script's;
  3. runtime_guard() finds nothing in the result.
Any failure is a refusal: the caller must not send, and must never fall back to the raw text.

stdin:  {"text": "<the package body>"}
stdout: {"ok": true, "text": "<redacted>", "counts": {...}, "version": "..."}
        {"ok": false, "why": "<reason, no content>"}
Exit 0 when it answered (either way); anything else is a failure the caller treats as a refusal.
"""
import json
import os
import sys

_JEV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "jev")
sys.path.insert(0, _JEV)
import redact  # noqa: E402

GATE = os.environ.get("JEV_LEAK_GATE_STATUS", "/home/marveen/marveen/store/jev-leak-gate.json")


def gate_green():
    try:
        import leak_gate
        with open(GATE, encoding="utf-8") as f:
            g = json.load(f)
        return (g.get("leaks") == 0
                and g.get("redaction_version") == redact.REDACTION_VERSION
                and g.get("code_hash") == leak_gate.code_hash())
    except Exception:
        return False


def decide(text):
    if not isinstance(text, str) or not text.strip():
        return {"ok": False, "why": "ures vagy nem szoveg"}
    if not gate_green():
        return {"ok": False, "why": "a szivargas-kapu nem zold erre a kitakaro-kodra"}
    try:
        r = redact.redact(text)
    except redact.RedactionError as e:
        return {"ok": False, "why": f"a kitakaras nem futott le: {e}"}
    problems = redact.runtime_guard(r)
    if problems:
        return {"ok": False, "why": f"a kitakaras utan is maradt: {','.join(problems)}"}
    return {"ok": True, "text": r["text"], "counts": r["counts"], "version": r["version"]}


def main():
    try:
        body = json.loads(sys.stdin.read())
        text = body.get("text") if isinstance(body, dict) else None
    except ValueError:
        text = None
    print(json.dumps(decide(text), ensure_ascii=False))


if __name__ == "__main__":
    main()
