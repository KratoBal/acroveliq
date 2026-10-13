#!/usr/bin/env python3
# ANSWERS: Mit mondott a host-oldali visszaallitasi proba (OS, Commerce, docstore), es eleg friss-e?
#
# visszaallitasi-proba-eredmeny.py <result.json> <os|commerce|docstore> [max_age_h]
#
# The OS, Commerce and document-store backups are 0600 on the NAS and the fleet does not get
# to read them (Balazs, 2026-10-13 17:07:37 UTC, Token thread: the fleet's rights do not grow).
# scripts/host/acropora-restore-probe.sh restores them on the production host under the
# backups' own identity and leaves one JSON per run on the NAS; this reads ONE kind of it.
#
# A PASS is not taken on its word: the numbers next to it must say the same (a restore with
# no tables, or a mirror where nothing was checked, is a FAIL whatever the status says).
# EXIT 0 only if the result is fresh, well-formed, PASS, and its numbers agree.
import json
import sys
from datetime import datetime, timezone

DB_KEYS = ("file", "age_h", "restore_rc", "tables_restored", "tables_live", "tables_missing",
           "rows_restored", "rows_live")
DOCSTORE_KEYS = ("remote_files", "live_files", "checked", "missing_or_differing")


def check(doc, kind, max_age_h, now):
    """Returns (summary lines, list of problems)."""
    if doc.get("probe") != "acropora-restore-probe" or doc.get("version") != 1:
        return [], ["ismeretlen eredmeny-formatum"]
    bad, lines = [], []
    try:
        finished = datetime.strptime(doc["finished"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (KeyError, TypeError, ValueError):
        return [], ["nincs ertelmezheto 'finished' idopont"]
    age = int((now - finished).total_seconds() // 3600)
    lines.append("eredmeny: %s, %d oras, host %s" % (doc["finished"], age, doc.get("host", "?")))
    if age > max_age_h:
        bad.append("az eredmeny %d oras (hatar %d): a host-oldali proba leallhatott" % (age, max_age_h))
    sec = doc.get("kinds", {}).get(kind)
    if not isinstance(sec, dict):
        return lines, bad + ["nincs '%s' szakasz az eredmenyben" % kind]
    want = DOCSTORE_KEYS if kind == "docstore" else DB_KEYS
    missing = [k for k in want if k not in sec]
    if missing:
        return lines, bad + ["hianyzo mezok: %s" % ",".join(missing)]
    if kind == "docstore":
        lines.append("NAS %d fajl, elo %d, ellenorizve %d, elter/hianyzik %d"
                     % (sec["remote_files"], sec["live_files"], sec["checked"], sec["missing_or_differing"]))
        if sec["checked"] <= 0 or sec["missing_or_differing"] != 0:
            bad.append("a szamok nem PASS-t mondanak")
    else:
        lines.append("%s, %d oras; visszatoltve %d tabla / %d sor, elo %d tabla / %d sor, hianyzo tabla %d"
                     % (sec["file"], sec["age_h"], sec["tables_restored"], sec["rows_restored"],
                        sec["tables_live"], sec["rows_live"], sec["tables_missing"]))
        if (sec["restore_rc"] != 0 or sec["tables_restored"] <= 0 or sec["tables_missing"] != 0
                or (sec["rows_live"] > 0 and sec["rows_restored"] <= 0)):
            bad.append("a szamok nem PASS-t mondanak")
    if sec.get("status") != "PASS":
        bad.append("status %s: %s" % (sec.get("status"), sec.get("reason", "")))
    return lines, bad


def main(argv):
    if len(argv) not in (3, 4) or argv[2] not in ("os", "commerce", "docstore"):
        print("usage: visszaallitasi-proba-eredmeny.py <result.json> <os|commerce|docstore> [max_age_h]", file=sys.stderr)
        return 2
    max_age_h = int(argv[3]) if len(argv) == 4 else 192
    try:
        with open(argv[1], encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        print("FAIL[%s]: az eredmeny nem olvashato: %s" % (argv[2], e.__class__.__name__))
        return 1
    try:
        lines, bad = check(doc, argv[2], max_age_h, datetime.now(timezone.utc))
    except (TypeError, AttributeError):
        lines, bad = [], ["hibas mezotipus az eredmenyben"]
    for line in lines:
        print("   " + line)
    if bad:
        print("FAIL[%s]: %s" % (argv[2], "; ".join(bad)))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
