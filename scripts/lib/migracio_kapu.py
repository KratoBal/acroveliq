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
2026-11-19 in service_job_event_kind_linked_check) passes. It passes also when the new form is narrower and so
can fail on existing rows: that cannot be told from the text, and the rollout owner decided to let it through.

barracuda's review of #387 added what the earlier list left out:
  - ADD CONSTRAINT (UNIQUE, PRIMARY KEY, FOREIGN KEY, CHECK, EXCLUDE) and CREATE UNIQUE INDEX on a table that
    has rows can fail on them. Each stops, unless NOT VALID, or the table is created in the same file, or (for a
    UNIQUE or a FOREIGN KEY) every key column is one this file adds without a default: NULL in every existing
    row, which a unique key and a foreign key both accept. Prisma's new optional relation is that last shape.
  - DROP VIEW / MATERIALIZED VIEW / FUNCTION / PROCEDURE / TRIGGER / SEQUENCE / POLICY / EXTENSION / RULE /
    DOMAIN: no data goes, but an older reader or a row-level rule does.
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


def mask_strings(sql: str) -> str:
    """String literals to ''; identifiers stay (the table and column names are read from this)."""
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


def mask(sql: str) -> str:
    """Quoted identifiers to "ID" (keeping a _key suffix: a unique index's name), strings to ''."""
    # one pass, so the masked "ID_key" is not masked again to "ID"
    sql = re.sub(r'"(?:[^"]|"")*"', lambda m: '"ID_key"' if m.group(0).endswith('_key"') else '"ID"', sql)
    return mask_strings(sql)


NAME = r'(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)'
# a table, schema-qualified or not: the last name is the table
TABLE = rf"({NAME}(?:\s*\.\s*{NAME})?)"


def norm(name: str) -> str:
    """The name Postgres stores: a quoted one as written, an unquoted one lowercased; for a.b the b."""
    name = re.findall(NAME, name)[-1]
    return name[1:-1].replace('""', '"') if name.startswith('"') else name.lower()


def paren_list(text: str):
    """The comma-separated items of the first parenthesized list in text, or None."""
    i = text.find("(")
    if i < 0:
        return None
    depth = 0
    for j in range(i, len(text)):
        depth += text[j] == "("
        depth -= text[j] == ")"
        if depth == 0:
            return [x.strip() for x in top_level_clauses(text[i + 1 : j])]
    return None


def plain_columns(items):
    """The column names of a key list, or None if an item is an expression (it may hit any row)."""
    if items is None:
        return None
    cols = []
    for it in items:
        m = re.fullmatch(rf"({NAME})(\s+(ASC|DESC))?(\s+NULLS\s+(FIRST|LAST))?", it, FLAGS)
        if not m:
            return None
        cols.append(norm(m.group(1)))
    return cols


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
    # data goes (TABLE, COLUMN, TYPE, SCHEMA), or an older reader or a row-level rule does (VIEW, FUNCTION, POLICY...)
    (
        "DROP of a schema object",
        r"\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TRIGGER|SEQUENCE|POLICY|EXTENSION|RULE|DOMAIN)\b",
    ),
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
    # one list of statements, read twice: with the names (which table, which column) and with everything masked
    # (keywords only, so a name or a string never matches one)
    stmts = [" ".join(x.split()) for x in mask_strings(clean).split(";")]
    stmts = [x for x in stmts if x]

    # what this file creates, adds and drops, whatever the order: an index or constraint on a table that only
    # exists from this file on, or on a column this file adds with no default (NULL in every existing row), cannot
    # fail on existing rows
    created, newcols, dropped = set(), {}, set()
    for st in stmts:
        m = re.match(rf"CREATE\s+(UNLOGGED\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?{TABLE}", st, FLAGS)
        if m:
            created.add(norm(m.group(3)))
        m = re.match(rf"ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?{TABLE}\s+(.*)$", st, FLAGS)
        if m:
            t = norm(m.group(3))
            for clause in top_level_clauses(m.group(4)):
                c = re.match(
                    rf"\s*ADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(?!(CONSTRAINT|UNIQUE|PRIMARY|FOREIGN|CHECK|EXCLUDE)\b)({NAME})",
                    clause,
                    FLAGS,
                )
                if c and not re.search(r"\bDEFAULT\b|\bGENERATED\b", clause, FLAGS):
                    newcols.setdefault(t, set()).add(norm(c.group(4)))
                d = re.match(rf"\s*DROP\s+CONSTRAINT\s+(IF\s+EXISTS\s+)?({NAME})", clause, FLAGS)
                if d:
                    dropped.add((t, norm(d.group(2))))

    def harmless_on_rows(t, kind, rest):
        """True if the new UNIQUE / FOREIGN KEY / index cannot fail on the rows the table already has."""
        if t in created:
            return True
        if kind not in ("UNIQUE", "FOREIGN KEY") or re.match(r"\s*NULLS\s+NOT\s+DISTINCT", rest, FLAGS):
            return False
        cols = plain_columns(paren_list(rest))
        return bool(cols) and all(c in newcols.get(t, ()) for c in cols)

    hits, added = [], set()
    for st in stmts:
        flat = " ".join(mask(st).split())
        for name, pat in RULES:
            if re.search(pat, flat, FLAGS):
                hits.append((name, flat))
        m = re.match(rf"ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?{TABLE}\s+(.*)$", st, FLAGS)
        if m:
            t = norm(m.group(3))
            for clause in top_level_clauses(m.group(4)):
                if (
                    re.search(rf"\bADD\s+(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?(?!(CONSTRAINT|UNIQUE|PRIMARY|FOREIGN|CHECK|EXCLUDE)\b){NAME}", clause, FLAGS)
                    and re.search(r"\bNOT\s+NULL\b", clause, FLAGS)
                    and not re.search(r"\bDEFAULT\b|\bGENERATED\b", clause, FLAGS)
                ):
                    hits.append(("ADD COLUMN NOT NULL without DEFAULT", flat))
                a = re.match(
                    rf"\s*ADD\s+(CONSTRAINT\s+({NAME})\s+)?(UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|CHECK|EXCLUDE)\b(.*)$",
                    clause,
                    FLAGS,
                )
                if not a:
                    continue
                cname = norm(a.group(2)) if a.group(2) else None
                if cname:
                    added.add((t, cname))
                kind = " ".join(a.group(3).upper().split())
                if re.search(r"\bNOT\s+VALID\b", a.group(4), FLAGS):
                    continue  # existing rows are not checked
                if (t, cname) in dropped:
                    continue  # a replacement under the same name (it may narrow: see the module text)
                if not harmless_on_rows(t, kind, a.group(4)):
                    hits.append(("ADD CONSTRAINT on an existing table", " ".join(mask(clause).split())))
        u = re.match(
            rf"CREATE\s+UNIQUE\s+INDEX\s+(CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?((?!ON\b){NAME}\s+)?ON\s+(ONLY\s+)?{TABLE}\s*(USING\s+\w+\s*)?(.*)$",
            st,
            FLAGS,
        )
        if u and not harmless_on_rows(norm(u.group(5)), "UNIQUE", u.group(7)):
            hits.append(("CREATE UNIQUE INDEX on an existing table", flat))
    for t, d in sorted(dropped - added):
        hits.append(("DROP CONSTRAINT not added back", f'DROP CONSTRAINT "{d}" on "{t}"'))
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
