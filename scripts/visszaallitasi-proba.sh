#!/usr/bin/env bash
# ANSWERS: Vissza lehet-e TENYLEG tolteni a NAS-on allo mentest, es mi van benne (a heti visszaallitasi proba)?
#
# visszaallitasi-proba.sh -- restore the NEWEST backup FROM THE NAS COPY, check it, throw it away.
#
# WHY (Balazs, 2026-10-07 17:05 UTC, security thread: "Tudunk olyat hogy idonkent lefut egy proba
# visszallitas?"). Until today no backup had ever been restored, apart from one partial load on
# 2026-08-29. A dump that was never loaded is a hope, not a backup.
#
# THE RULE THAT MAKES THIS A TEST: the file is DOWNLOADED FROM THE NAS, never re-dumped. A fresh
# dump proves the database works; only the stored copy proves the backup works.
#
# WHAT IT COVERS TODAY
#   fleet  Acropora_Backup/acrobot-fleet/*.db.gz     sqlite integrity_check + row counts vs live
#   ai     Acropora_Backup/acropora-ai/*.dump        pg_restore into a throwaway postgres:16
#                                                    container on the stage machine, row counts
#                                                    vs the live AI database, then removed
# NOT YET: the OS, Commerce and document-store dumps. They are mode 0600, owner acropora-backup;
# the fleet's NAS account (AcroBot) can list them but not read them (measured 2026-10-07 19:05).
# A read grant on the NAS was asked from Balazs the same minute. When it exists, add an "os"
# section on the "ai" pattern (the OS dump is ~110 MB, the stage disk has room).
#
# USAGE   bash scripts/visszaallitasi-proba.sh [fleet|ai|all]     (default: all)
# EXIT 0 only if every covered backup restored and passed its checks.

set -uo pipefail
ROOT=/home/marveen/marveen
KEY=/home/marveen/.ssh/id_ed25519_csupor_backup
NAS=AcroBot@100.98.191.44
STAGE=fleet@100.88.199.87
STAGE_KEY=/home/marveen/.ssh/id_ed25519_acropora_monitor
AI_LIVE=cpnjvtte02yakzs9vb0jffky
WORK="$ROOT/store/backup-work/proba"
WHAT="${1:-all}"
FAILS=0
mkdir -p "$WORK"

nas_ls() { timeout 120 sftp -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" "$NAS" <<<"ls -1 $1" 2>/dev/null | /bin/grep -v '^sftp>'; }
nas_get() { timeout 900 sftp -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" "$NAS" <<<"get $1 $2" >/dev/null 2>&1; }
sssh() { timeout "${T:-300}" ssh -o BatchMode=yes -o ConnectTimeout=10 -i "$STAGE_KEY" "$STAGE" "$@"; }
fail() { echo "FAIL[$1]: $2"; FAILS=$((FAILS + 1)); }
# A backup older than this is a stopped backup, even if it restores fine.
MAX_AGE_H="${PROBA_MAX_AGE_H:-36}"
age_ok() {  # $1 label, $2 file name with YYYY-MM-DD_HH-MM-SS
  local ts; ts=$(printf '%s' "$2" | /bin/grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}_[0-9]\{2\}-[0-9]\{2\}' | head -1)
  local e; e=$(date -d "$(printf '%s' "${ts%_*} ${ts#*_}" | sed 's/-\([0-9][0-9]\)$/:\1/')" +%s 2>/dev/null || echo 0)
  local h=$(( ($(date +%s) - e) / 3600 ))
  echo "   kor: $h ora"
  [ "$e" -gt 0 ] && [ "$h" -le "$MAX_AGE_H" ] || fail "$1" "a legujabb mentes $h oras (hatar $MAX_AGE_H): a mentes leallhatott"
}
# The throwaway container is the fleet-gate's (B8): its restore-probe starts it,
# sweeps earlier leftovers and removes it on any exit, on the stage host.

if [ "$WHAT" = all ] || [ "$WHAT" = fleet ]; then
  echo "== flotta"
  F=$(nas_ls Acropora_Backup/acrobot-fleet | /bin/grep -o 'acrobot-fleet-[0-9_-]*\.db\.gz' | sort | tail -1)
  if [ -z "$F" ]; then fail fleet "nincs fajl a NAS-on"; else
    age_ok fleet "$F"
    rm -f "$WORK/fleet.db.gz" "$WORK/fleet.db"
    nas_get "Acropora_Backup/acrobot-fleet/$F" "$WORK/fleet.db.gz"
    if ! gunzip -c "$WORK/fleet.db.gz" > "$WORK/fleet.db" 2>/dev/null; then fail fleet "$F nem bonthato ki"; else
      python3 - "$WORK/fleet.db" "$ROOT/store/claudeclaw.db" "$F" <<'PY' || FAILS=$((FAILS + 1))
import sqlite3, sys
bak, live, name = sys.argv[1:4]
b = sqlite3.connect("file:%s?mode=ro" % bak, uri=True)
ok = b.execute("pragma integrity_check").fetchone()[0]
tables = [r[0] for r in b.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
l = sqlite3.connect("file:%s?mode=ro" % live, uri=True)
bad = []
for t in ("memories", "kanban_cards", "agent_messages", "daily_logs"):
    if t not in tables: continue
    nb = b.execute('select count(*) from "%s"' % t).fetchone()[0]
    nl = l.execute('select count(*) from "%s"' % t).fetchone()[0]
    print("   %-14s mentes %7d   elo %7d" % (t, nb, nl))
    if nb == 0 or nb > nl: bad.append(t)
print("   %s: integrity %s, %d tabla" % (name, ok, len(tables)))
if ok != "ok" or len(tables) < 10 or bad:
    print("FAIL[fleet]: integrity=%s tablak=%d gyanus=%s" % (ok, len(tables), bad)); sys.exit(1)
PY
    fi
    rm -f "$WORK/fleet.db.gz" "$WORK/fleet.db"
  fi
fi

if [ "$WHAT" = all ] || [ "$WHAT" = ai ]; then
  echo "== AI adatbazis"
  F=$(nas_ls Acropora_Backup/acropora-ai | /bin/grep -o 'acropora-ai-[0-9_-]*\.dump' | sort | tail -1)
  if [ -z "$F" ]; then fail ai "nincs fajl a NAS-on"; else
    age_ok ai "$F"
    rm -f "$WORK/ai.dump"; nas_get "Acropora_Backup/acropora-ai/$F" "$WORK/ai.dump"
    # EXACT counts, not pg_stat n_live_tup: the statistics are estimates, and on 2026-10-07 the
    # live database reported 6 messages where count(*) gave hundreds (never analyzed). The
    # restore-probe runs this same query on the restored copy (the query is fixed in the gate).
    Q="select 'conversations='||(select count(*) from conversations)||' messages='||(select count(*) from messages)||' answer_ratings='||(select count(*) from answer_ratings)"
    if ! GOT=$(T=900 sssh restore-probe < "$WORK/ai.dump" 2> "$WORK/ai-restore.err"); then
      fail ai "a visszatoltes hibaval tert vissza: $(head -c 300 "$WORK/ai-restore.err")"
    fi
    LIVE=$(printf '%s;\n' "$Q" | sssh psql-ro "$AI_LIVE" acropora_ai acropora_ai tuples)
    echo "   $F"; echo "   visszatoltve: $GOT"; echo "   elo:          $LIVE"
    # Every count must be a positive number and not above the live one; an empty or schema-only
    # restore prints "conversations=0 ..." which is not an empty string (barracuda's review).
    python3 - "$GOT" "$LIVE" <<'PY' || FAILS=$((FAILS + 1))
import sys
def p(s): return dict(kv.split("=") for kv in s.split()) if s.strip() else {}
g, l = p(sys.argv[1]), p(sys.argv[2])
bad = [k for k in ("conversations", "messages", "answer_ratings") if not g.get(k, "").isdigit() or not l.get(k, "").isdigit() or int(g[k]) > int(l[k])]
if not l or bad or int(g.get("messages", "0") or 0) == 0 or int(g.get("conversations", "0") or 0) == 0:  # answer_ratings may legitimately be 0
    print("FAIL[ai]: visszatoltve=%s elo=%s gyanus=%s" % (g, l, bad)); sys.exit(1)
PY
    rm -f "$WORK/ai.dump"
  fi
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "KESZ. minden lefedett mentes visszatoltheto ($WHAT)"; else echo "FAIL. $FAILS hiba"; exit 1; fi
