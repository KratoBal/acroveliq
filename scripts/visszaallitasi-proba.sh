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
#   os, commerce, docstore                           NOT restored here: only the RESULT is read
#                    Acropora_Backup/acropora-restore-probe/result-*.json  (the newest one)
#
# WHY THE LAST THREE ARE DIFFERENT. Their files are 0600, owner acropora-backup, and the fleet's
# NAS account (AcroBot) cannot read them (measured again 2026-10-13 23:37; the document-store
# directory cannot even be listed). Balazs, 2026-10-13 17:07:37 UTC (Token thread, msg
# 1559613596789383233): the fleet's rights do NOT grow for this. So the restore runs on the
# production host under the backups' own identity (scripts/host/acropora-restore-probe.sh,
# weekly, Sunday 04:40) and the fleet reads its JSON, through scripts/visszaallitasi-proba-eredmeny.py.
# A result older than PROBA_RESULT_MAX_AGE_H (default 192, eight days) is a stopped probe.
#
# USAGE   bash scripts/visszaallitasi-proba.sh [fleet|ai|os|commerce|docstore|host|all]   (default: all)
#         host = os + commerce + docstore
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
nas_lsl() { timeout 120 sftp -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" "$NAS" <<<"ls -ln $1" 2>/dev/null | /bin/grep -v '^sftp>'; }
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
    LIVE=$(printf '%s;\n' "$Q" | sssh psql-ro "$AI_LIVE" acropora_ai tuples)
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

HOST_KINDS=""
case "$WHAT" in all|host) HOST_KINDS="os commerce docstore" ;; os|commerce|docstore) HOST_KINDS="$WHAT" ;; esac
if [ -n "$HOST_KINDS" ]; then
  echo "== host-oldali proba (eles gep): $HOST_KINDS"
  # WHO OWNS THE FOLDER decides whether its PASS means anything. Our own account (AcroBot) can
  # create folders in Acropora_Backup (it owns acrobot-fleet and acropora-ai, made by our
  # scripts' mkdir; acrobot's listing 2026-10-13 23:37), so it could also pre-create this one and
  # put a fake PASS there. The folder must be the backup account's and not writable by others.
  # Mode bits are what sftp shows; a Synology ACL is checked once by hand (step sheet, step 3).
  OWNER_UID="${PROBA_RESULT_OWNER_UID:-1032}"
  DIRLINE=$(nas_lsl Acropora_Backup | /bin/grep -E ' Acropora_Backup/acropora-restore-probe$')
  if [ -n "$DIRLINE" ] && ! printf '%s\n' "$DIRLINE" | awk -v u="$OWNER_UID" '$1 == "drwxr-xr-x" && $3 == u { f = 1 } END { exit !f }'; then
    for k in $HOST_KINDS; do fail "$k" "az eredmeny-mappa joga vagy tulajdonosa nem a varhato (drwxr-xr-x, uid $OWNER_UID): $(printf '%s' "$DIRLINE" | /bin/tr -s ' ' | cut -d' ' -f1,3,4)"; done
    HOST_KINDS=""
  fi
  F=$(nas_ls Acropora_Backup/acropora-restore-probe | /bin/grep -o 'result-[0-9_-]*\.json' | sort | tail -1)
  if [ -z "$HOST_KINDS" ]; then
    :
  elif [ -z "$F" ]; then
    for k in $HOST_KINDS; do fail "$k" "nincs eredmeny a NAS-on (Acropora_Backup/acropora-restore-probe): a host-oldali proba nem fut"; done
  else
    rm -f "$WORK/host-result.json"; nas_get "Acropora_Backup/acropora-restore-probe/$F" "$WORK/host-result.json"
    echo "   $F"
    # the installed host script must be the one in this tree: an outdated or edited copy fails
    WANT=$(sha256sum "$ROOT/scripts/host/acropora-restore-probe.sh" 2>/dev/null | cut -d' ' -f1)
    [ -n "$WANT" ] || WANT=missing
    for k in $HOST_KINDS; do
      echo "   -- $k"
      python3 "$ROOT/scripts/visszaallitasi-proba-eredmeny.py" "$WORK/host-result.json" "$k" "${PROBA_RESULT_MAX_AGE_H:-192}" "$WANT" || FAILS=$((FAILS + 1))
    done
    rm -f "$WORK/host-result.json"
  fi
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "KESZ. minden lefedett mentes visszatoltheto ($WHAT)"; else echo "FAIL. $FAILS hiba"; exit 1; fi
