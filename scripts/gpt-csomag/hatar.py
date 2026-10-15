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

ONE NARROW EXCEPTION (acrobot 31072): the debate's own participants keep their names. In the
first live debate the owner's name was masked too, and GPT called him <PERSON_1> in the thread.
The caller names them in `keep` (at most MAX_KEEP single capitalised words, letters only, else
a refusal): every inflected form of such a name ("Balázsnak", "Balázzsal", the unaccented
"Balazs" too) is swapped for a random token the redactor is told to preserve
(redact.preserving), and swapped back after the runtime guard. Every other name masks as
before. A kept name standing next to another capitalised word that is not itself kept
("Kovács Balázs", "Kovács, Balázs", the two on adjacent lines: another person who shares the
first name) is left alone, so
the redactor masks the pair whole, as before; measured without this, "Kovács Balázs" went out as
"<PERSON_1> Balázs". The cost is the safe one: at the start of a sentence ("Ma Balázs ...") the
owner is masked once. Not the redactor's code: the leak gate's code hash does not change.

stdin:  {"text": "<the package body>", "keep": ["Balázs", "Acrobot", "GPT"]}
stdout: {"ok": true, "text": "<redacted>", "counts": {...}, "version": "..."}
        {"ok": false, "why": "<reason, no content>"}
Exit 0 when it answered (either way); anything else is a failure the caller treats as a refusal.
"""
import json
import os
import re
import secrets
import string
import sys
import unicodedata

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


MAX_KEEP = 5
# The debate's participants, the list src/gpt-package.ts sends (PARTICIPANT_NAMES; a test keeps the
# two equal). The leak gate runs its suite through redact_keeping() with these too, so the keeping
# path is measured, not only the full one (barracuda, #181 review; acrobot 31140).
PARTICIPANTS = ("Balázs", "Acrobot", "GPT")
_KEEP_WORD = re.compile(r"^[A-ZÁÉÍÓÖŐÚÜŰ][A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]{1,30}$")
# a Hungarian final consonant written with more letters doubles its first one before an
# inflection ("Balázs" + "val" -> "Balázzsal"); longest first
_DIGRAPHS = ("dzs", "zs", "sz", "cs", "gy", "ly", "ny", "ty", "dz")


def _plain(word):
    return "".join(c for c in unicodedata.normalize("NFD", word) if not unicodedata.combining(c))


def _stem_pattern(word):
    for d in _DIGRAPHS:
        if word.lower().endswith(d) and len(word) > len(d):
            head, tail = word[:-len(d)], word[-len(d):]
            return re.escape(head) + "(?:" + re.escape(tail[0]) + ")?" + re.escape(tail)
    return re.escape(word)


def protect(text, keep):
    """The kept names, inflected or not, swapped for random letter tokens: (text, {token: original})."""
    variants = sorted({v for w in keep for v in (w, _plain(w))}, key=len, reverse=True)
    rx = re.compile(r"(?<![\w-])(?:" + "|".join(_stem_pattern(v) for v in variants) + r")\w*")
    tokens = {}

    def neighbour_is_other_name(m):
        # a space, a tab, a comma ("Kovács, Balázs" in a list) or one line break between them
        before = re.search(r"([^\W\d_][\w-]*)[ \t,]*\n?[ \t]*$", text[:m.start()])
        after = re.match(r"[ \t,]*\n?[ \t]*([^\W\d_][\w-]*)", text[m.end():])
        for n in ([before.group(1)] if before else []) + ([after.group(1)] if after else []):
            if n[0].isupper() and not rx.fullmatch(n):
                return True
        return False

    def swap(m):
        if neighbour_is_other_name(m):
            return m.group(0)
        if m.group(0) not in tokens:
            tokens[m.group(0)] = "Kivetel" + "".join(secrets.choice(string.ascii_lowercase) for _ in range(12))
        return tokens[m.group(0)]

    return rx.sub(swap, text), {t: o for o, t in tokens.items()}


def redact_keeping(text, keep):
    """redact() with the kept names swapped out and preserved: (the result, {token: original}).
    Raises redact.RedactionError like redact(). The leak gate calls this too."""
    restore = {}
    if keep:
        text, restore = protect(text, keep)
    with redact.preserving(restore.keys()):
        return redact.redact(text), restore


def restore_names(text, restore):
    for token, original in restore.items():
        text = text.replace(token, original)
    return text


def decide(text, keep=()):
    if not isinstance(text, str) or not text.strip():
        return {"ok": False, "why": "ures vagy nem szoveg"}
    if (not isinstance(keep, (list, tuple)) or len(keep) > MAX_KEEP
            or not all(isinstance(w, str) and _KEEP_WORD.match(w) for w in keep)):
        return {"ok": False, "why": "a megtartando nevek listaja nem megengedett alaku"}
    if not gate_green():
        return {"ok": False, "why": "a szivargas-kapu nem zold erre a kitakaro-kodra"}
    try:
        r, restore = redact_keeping(text, keep)
    except redact.RedactionError as e:
        return {"ok": False, "why": f"a kitakaras nem futott le: {e}"}
    problems = redact.runtime_guard(r)
    if problems:
        return {"ok": False, "why": f"a kitakaras utan is maradt: {','.join(problems)}"}
    return {"ok": True, "text": restore_names(r["text"], restore), "counts": r["counts"], "version": r["version"]}


def main():
    try:
        body = json.loads(sys.stdin.read())
        text = body.get("text") if isinstance(body, dict) else None
        keep = body.get("keep", []) if isinstance(body, dict) else []
    except ValueError:
        text, keep = None, []
    print(json.dumps(decide(text, keep), ensure_ascii=False))


if __name__ == "__main__":
    main()
