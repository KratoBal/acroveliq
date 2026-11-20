#!/usr/bin/env python3
"""ANSWERS: May this Prisma migration go to production unattended, or must a person look at it first?

Used by scripts/eles-napi-felhozas.sh (the daily production rollout, Balazs 2026-11-20). A migration
passes only if it is additive: it loses no data, renames nothing an older reader still uses, and does not
fail on a table that already has rows (a failed migration blocks every later deploy until someone runs
`prisma migrate resolve`).

    python3 -B scripts/lib/migracio_kapu.py <migration.sql>...
    exit 0: all additive, no output; exit 1: one line per finding (`<file>: <rule>: <statement>`);
    exit 2: a file is unreadable or empty.

It reads statements, not lines: comments are removed, string literals and quoted identifiers are masked
before the keywords are matched, and the text is split at `;`. What the earlier one-line grep missed or
mis-hit (2026-11-20, the five migrations of that day as the measure):
  - a keyword inside an identifier hit: "ordersTruncated" stopped the additive stripe_settlement
  - a statement over several lines was read line by line (`ALTER TABLE "X"` / `DROP "col";`)
  - `ALTER TABLE ... DROP "col"` (COLUMN is optional in Postgres) passed
  - `ADD COLUMN ... NOT NULL` without DEFAULT passed (it fails on a table with rows)
  - a DROP CONSTRAINT that is not added back passed (a lost unique or foreign key)
  - an UPDATE not at the start of a line passed
A DROP CONSTRAINT that the same file adds back under the same name (the check replaced on
2026-11-19 in service_job_event_kind_linked_check) passes.
"""
import re
import sys

FLAGS = re.I | re.S


def strip_comments(sql: str) -> str:
    """-- line comments and /* */ blocks out; quotes are respected so a '--' inside a string stays."""
    out, i, n = [], 0, len(sql)
    while i < n:
        c = sql[i]
        if c in "'\"":
            j = i + 1
            while j < n:
                if sql[j] == c:
                    if j + 1 < n and sql[j + 1] == c:  # doubled quote inside
                        j += 2
                        continue
                    break
                j += 1
            out.append(sql[i : j + 1])
            i = j + 1
        elif sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j
        elif sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            i = n if j < 0 else j + 2
            out.append(" ")
        else:
            out.append(c)
            i += 1
    return "".join(out)


def mask(sql: str) -> str:
    """Quoted identifiers to "ID" (keeping a _key suffix: a unique index's name), strings to ''."""
    # one pass, so the masked "ID_key" is not masked again to "ID"
    sql = re.sub(r'"(?:[^"]|"")*"', lambda m: '"ID_key"' if m.group(0).endswith('_key"') else '"ID"', sql)
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


def top_level_clauses(stmt: str) -> list:
    """The comma-separated clauses of one statement, commas inside parentheses kept (DECIMAL(19,4))."""
    parts, depth, cur = [], 0, []
    for ch in stmt:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return parts


# (rule name, pattern) on one masked statement
RULES = [
    ("DROP TABLE/COLUMN/TYPE/SCHEMA", r"\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA)\b"),
    ("DROP unique index", r"\bDROP\s+INDEX\b.*\"ID_key\""),
    ("RENAME", r"\bRENAME\b"),
    ("SET NOT NULL", r"\bSET\s+NOT\s+NULL\b"),
    ("ALTER COLUMN ... TYPE", r"\bALTER\s+(COLUMN\s+)?\"ID\"\s+(SET\s+DATA\s+)?TYPE\b|\bALTER\s+COLUMN\b.*\bTYPE\b"),
    ("TRUNCATE", r"\bTRUNCATE\b"),
    ("DELETE FROM", r"\bDELETE\s+FROM\b"),
    ("UPDATE", r"^\s*(WITH\b.*)?\bUPDATE\s+(ONLY\s+)?(\"ID\"|\w)"),
    # Postgres takes `ALTER TABLE t DROP col`; DROP DEFAULT / NOT NULL / CONSTRAINT / IDENTITY / EXPRESSION loosen only
    ("DROP column (no COLUMN keyword)", r"\bALTER\s+TABLE\b.*\bDROP\s+(?!(COLUMN|CONSTRAINT|DEFAULT|NOT|IDENTITY|EXPRESSION)\b)(IF\s+EXISTS\s+)?(\"ID|\w)"),
    # a dollar-quoted body (DO block, function) hides its statements from this reader: a person reads it
    ("dollar-quoted block", r"\$\w*\$"),
]


def findings(sql: str) -> list:
    clean = strip_comments(sql)
    masked = mask(clean)
    hits = []
    for stmt in masked.split(";"):
        flat = " ".join(stmt.split())
        if not flat:
            continue
        for name, pat in RULES:
            if re.search(pat, flat, FLAGS):
                hits.append((name, flat))
        if re.search(r"\bALTER\s+TABLE\b", flat, FLAGS):
            for clause in top_level_clauses(flat):
                if (
                    re.search(r"\bADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?\"ID\"", clause, FLAGS)
                    and re.search(r"\bNOT\s+NULL\b", clause, FLAGS)
                    and not re.search(r"\bDEFAULT\b|\bGENERATED\b", clause, FLAGS)
                ):
                    hits.append(("ADD COLUMN NOT NULL without DEFAULT", flat))
    # the names are masked above, so the pairing reads the unmasked text
    name = r'("(?:[^"]|"")+"|\w+)'
    dropped = re.findall(r"\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?" + name, clean, FLAGS)
    added = set(re.findall(r"\bADD\s+CONSTRAINT\s+" + name, clean, FLAGS))
    for d in dropped:
        if d not in added:
            hits.append(("DROP CONSTRAINT not added back", f"DROP CONSTRAINT {d}"))
    return hits


def main(paths: list) -> int:
    if not paths:
        print("hasznalat: migracio_kapu.py <migration.sql>...", file=sys.stderr)
        return 2
    bad = 0
    for p in paths:
        try:
            sql = open(p, encoding="utf-8").read()
        except OSError as e:
            print(f"{p}: nem olvashato: {e}", file=sys.stderr)
            return 2
        if not sql.strip():
            print(f"{p}: ures", file=sys.stderr)
            return 2
        for rule, stmt in findings(sql):
            bad += 1
            print(f"{p}: {rule}: {stmt[:160]}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
