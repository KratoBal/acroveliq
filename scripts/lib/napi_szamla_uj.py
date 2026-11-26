"""What is new in the daily invoice check since yesterday (acrobot 55376, task t-20261118-napi-szamla-mi-uj).

The check's raw file (store/napi-szamla-ellenorzes/<day>.txt) holds one `key|count|list` row per question. acrobot counted every
morning by hand which items of a list were new since the day before; this does it from the two raw files, and the summary carries
only the new items, while the raw file keeps the whole list.

A LIST IS COMPARED ONLY IN ITS FULL FORM. The query (exchange/havi-elszamolas/napi-ellenorzes.sql) used to cut a list at 8 or 12 items
with a " (+N további)" tail and join it with ", ", but an item itself holds a comma ("AHUW263207959 (Alza.hu Kft., 10-26)"), so such a
list cannot be split back into items. The full form joins with SEP, which no item holds. A day whose list is in the old form, or cut,
is said to be not comparable; nothing is guessed from it.
"""
import re

SEP = " ¦ "
CUT_TAIL = re.compile(r" \(\+\d+ további\)$")
MAX_SHOWN = 10

# the rows with a list (the query's own keys), and how the summary names them
LABELS = {
    "ki_pdf_nelkul": "kimenő PDF nélkül",
    "be_pdf_nincs_egyezes": "bejövő, nincs egyező PDF",
    "be_hianyos_osszeg": "hiányos összeg",
    "atnezesre_var": "átnézésre vár",
    # The raw row is every debit without a MANUAL pairing: bank fees and cash withdrawals the OS already files as
    # "nem kér számlát" are in it too (2026-11-26: two KP.FELVÉT/-BEFIZ. DÍJA rows read as missing invoices). The
    # label says so; the OS's own verdict is the terheles-parositas file, not this list.
    "terheles_szamla_nelkul": "kézi párosítás nélküli banki terhelés (az OS besorolása nélkül, bankdíj is lehet)",
}


def parse(text):
    """{key: (count, list field)} from a raw file's text; a line that is not `key|count|...` is skipped."""
    rows = {}
    for line in text.splitlines():
        parts = line.split("|", 2)
        if len(parts) == 3 and parts[1].strip().isdigit():
            rows[parts[0]] = (int(parts[1]), parts[2])
    return rows


def items_of(count, field):
    """The list's items, or None when the field cannot be split for sure (the old ", " form with more than one item, or cut)."""
    if field == "":
        return [] if count == 0 else None
    if SEP in field:
        return field.split(SEP)
    if CUT_TAIL.search(field):
        return None
    # one item in either form: nothing to split
    return [field] if count == 1 else None


def new_since(today_text, yesterday_text):
    """The summary's lines: the new items per list, and a word on every list that could not be compared."""
    today = parse(today_text)
    if yesterday_text is None:
        return ["• Új a tegnapihoz képest: a tegnapi nyers fájl nincs meg, nem vethető össze"]
    yesterday = parse(yesterday_text)
    found, notes = [], []
    for key, label in LABELS.items():
        if key not in today:
            continue
        now = items_of(*today[key])
        if now is None:
            notes.append(f"{label}: a mai lista nem teljes alakú")
            continue
        before = items_of(*yesterday[key]) if key in yesterday else []
        if before is None:
            notes.append(f"{label}: a tegnapi lista régi vagy vágott alakú")
            continue
        seen = set(before)
        new = [i for i in now if i not in seen]
        if new:
            shown = ", ".join(new[:MAX_SHOWN]) + (f" (+{len(new) - MAX_SHOWN} további)" if len(new) > MAX_SHOWN else "")
            found.append(f"{label}: {shown}")
    lines = [f"• Új a tegnapihoz képest: {'; '.join(found) if found else 'nincs'}"]
    if notes:
        lines.append(f"• Nem vethető össze: {'; '.join(notes)}")
    return lines
