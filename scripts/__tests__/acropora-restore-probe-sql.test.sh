#!/usr/bin/env bash
# The counting SQL of scripts/host/acropora-restore-probe.sh against a REAL postgres (the CI
# starts one; see .github/workflows/test.yml). The other test stubs docker and psql, so it cannot
# tell whether the \gexec query counts the right tables, quotes a mixed-case name, or runs at all
# in a read-only transaction. WHAT TURNS THIS RED:
#   - a table is missing from the output, a view or a catalog table is in it, a count is wrong;
#   - "User" (mixed case, as Prisma names them) is not quoted and errors out;
#   - the query does not run under default_transaction_read_only=on (the live side runs it so);
#   - the positive control: a write under the same PGOPTIONS goes through.
# NOT a skip when psql is missing: it fails, so a runner without postgres shows up red.
set -uo pipefail
cd "$(dirname "$0")/../.."
command -v psql >/dev/null || { echo "not ok - nincs psql: ez a teszt valodi postgrest ker"; exit 1; }
DB="${PROBE_SQL_TEST_DB:-probe_sql}"
eval "$(sed -n '/^COUNT_SQL="/,/gexec"$/p' scripts/host/acropora-restore-probe.sh)"
[ -n "${COUNT_SQL:-}" ] || { echo "not ok - a COUNT_SQL nem olvashato ki a szkriptbol"; exit 1; }
PASS=0; FAIL=0
check() { if eval "$2"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "not ok - $1"; fi; }
P=(psql -X -q -At -v ON_ERROR_STOP=1 -d "$DB")
"${P[@]}" <<'SQL' || { echo "not ok - a fixtura nem all fel"; exit 1; }
drop schema if exists other cascade;
drop table if exists public."User", public.b cascade;
drop view if exists public.v;
create table public."User" (id int); insert into public."User" values (1), (2);
create table public.b (id int);
create schema other; create table other.c (id int); insert into other.c values (7);
create view public.v as select * from public."User";
SQL
OUT=$(printf '%s\n' "$COUNT_SQL" | PGOPTIONS='-c default_transaction_read_only=on' "${P[@]}" 2>&1); RC=$?
check "a szamlalas lefut csak-olvaso tranzakcioban (rc $RC: $OUT)" '[ "$RC" -eq 0 ]'
# order-free: "order by 1" follows the database collation, the probe's awk does not care
check "pontos kimenet" '[ "$(printf "%s\n" "$OUT" | LC_ALL=C sort)" = "$(printf "other.c|1\npublic.User|2\npublic.b|0")" ]'
WRC=0; printf 'insert into public.b values (1);\n' | PGOPTIONS='-c default_transaction_read_only=on' "${P[@]}" >/dev/null 2>&1 || WRC=$?
check "pozitiv kontroll: iras ugyanigy elutasitva" '[ "$WRC" -ne 0 ]'
echo "# pass $PASS"; echo "# fail $FAIL"
[ "$FAIL" -eq 0 ]
