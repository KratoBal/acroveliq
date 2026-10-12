#!/usr/bin/env bash
# ANSWERS: Van-e friss, visszaolvashato mentes az AI adatbazisrol a Hetzneren KIVUL (csupor NAS)?
#
# ai-db-nas-mentes.sh -- the AI database's offsite copy.
#
# WHY THIS EXISTS. Measured 2026-10-07 for the security thread: the OS and Commerce databases
# reach the NAS every night, the AI database (acropora_ai, on the stage/AI machine) did not.
# Its only copy was the daily cross-copy to the other Hetzner machine: same provider, same
# private network, so not offsite. Balazs, 2026-10-07 16:58 UTC (security thread, message_id
# 1557436959423471797): "Legyen eloszor a 4. Legyen rola mentes".
#
# HOW. The fleet already has an SFTP-only account on the NAS (see scripts/fleet-backup.sh), so
# no root and no new systemd unit is needed on either Hetzner machine:
#   1. pg_dump -Fc inside the AI Postgres container, streamed over ssh to this container
#   2. pg_restore -l on the SAME file, inside the container: a dump that does not list is not one
#   3. sftp upload to Acropora_Backup/acropora-ai/
#   4. the remote size must equal the local size (the upload exit code is not evidence)
#   5. retention: the newest $KEEP files stay on the NAS, older ones are removed
#
# USAGE
#   bash scripts/ai-db-nas-mentes.sh            # dump, verify, upload, verify, prune
#   bash scripts/ai-db-nas-mentes.sh --local    # dump and verify only, no upload
#
# EXIT 0 only if the remote file exists AND its size matches the local one.

set -uo pipefail

ROOT="${FLEET_ROOT:-/home/marveen/marveen}"
AI_HOST="${AI_DB_HOST:-fleet@100.88.199.87}"
AI_SSH_KEY="${AI_DB_SSH_KEY:-/home/marveen/.ssh/id_ed25519_acropora_monitor}"
AI_CONTAINER="${AI_DB_CONTAINER:-cpnjvtte02yakzs9vb0jffky}"
AI_DB_USER="${AI_DB_USER:-acropora_ai}"
AI_DB_NAME="${AI_DB_NAME:-acropora_ai}"
KEY="${FLEET_BACKUP_KEY:-/home/marveen/.ssh/id_ed25519_csupor_backup}"
DEST_USER="${FLEET_BACKUP_USER:-AcroBot}"
DEST_HOST="${FLEET_BACKUP_HOST:-100.98.191.44}"
DEST_DIR="${AI_BACKUP_DIR:-Acropora_Backup/acropora-ai}"
KEEP="${AI_BACKUP_KEEP:-30}"
# A positive integer or nothing: KEEP=0 or a non-number would make the prune below delete
# EVERY file, the one just uploaded included (barracuda, 2026-10-07 review).
case "$KEEP" in ""|*[!0-9]*) echo "FAIL: AI_BACKUP_KEEP nem pozitiv egesz: $KEEP" >&2; exit 2 ;; esac
[ "$KEEP" -ge 1 ] || { echo "FAIL: AI_BACKUP_KEEP legalabb 1" >&2; exit 2; }
WORK="$ROOT/store/backup-work"

STAMP=$(date +%Y-%m-%d_%H-%M-%S)
NAME="acropora-ai-$STAMP.dump"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 -i "$AI_SSH_KEY" "$AI_HOST")

mkdir -p "$WORK"

echo "== 1/5  Dump az AI adatbazisrol ($AI_CONTAINER, $AI_DB_NAME)"
if ! timeout 600 "${SSH[@]}" "docker exec $AI_CONTAINER pg_dump -Fc -U $AI_DB_USER -d $AI_DB_NAME" > "$WORK/$NAME"; then
  echo "FAIL: a pg_dump nem futott le (a kontener neve valtozhatott: docker ps a gepen)." >&2
  rm -f "$WORK/$NAME"; exit 1
fi
LOCAL=$(stat -c %s "$WORK/$NAME" 2>/dev/null || echo 0)
[ "$LOCAL" -gt 0 ] || { echo "FAIL: ures dump." >&2; rm -f "$WORK/$NAME"; exit 1; }
echo "   $NAME: $LOCAL bajt"

echo "== 2/5  Visszaolvasas (pg_restore -l ugyanarra a fajlra)"
ENTRIES=$(timeout 120 "${SSH[@]}" "docker exec -i $AI_CONTAINER pg_restore -l" < "$WORK/$NAME" 2>/dev/null | /bin/grep -c -E '^[0-9]+;')
TABLES=$(timeout 120 "${SSH[@]}" "docker exec -i $AI_CONTAINER pg_restore -l" < "$WORK/$NAME" 2>/dev/null | /bin/grep -c ' TABLE DATA ')
if [ "${ENTRIES:-0}" -eq 0 ]; then
  echo "FAIL: a dump nem olvashato vissza (0 bejegyzes)." >&2; exit 1
fi
echo "   bejegyzes: $ENTRIES, ebbol tabla-adat: $TABLES"

if [ "${1:-}" = "--local" ]; then
  echo; echo "--local: feltoltes nelkul allok meg. A fajl itt van: $WORK/$NAME"; exit 0
fi

echo "== 3/5  Feltoltes a csupor NAS-ra ($DEST_DIR)"
sftp -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" "$DEST_USER@$DEST_HOST" <<SFTP >/dev/null 2>&1
-mkdir $DEST_DIR
put $WORK/$NAME $DEST_DIR/$NAME
SFTP

echo "== 4/5  Visszameres a TAVOLI oldalon"
LISTING=$(sftp -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" "$DEST_USER@$DEST_HOST" <<SFTP 2>/dev/null
ls -l $DEST_DIR
SFTP
)
REMOTE=$(printf '%s\n' "$LISTING" | /bin/grep -F "$NAME" | /bin/tr -s ' ' | /bin/cut -d' ' -f5)
if [ "$REMOTE" != "$LOCAL" ]; then
  echo "FAIL: a meret NEM egyezik (helyi $LOCAL, tavoli ${REMOTE:-nincs ott})." >&2; exit 1
fi
echo "   tavoli meret: $REMOTE bajt"
rm -f "$WORK/$NAME"

echo "== 5/5  Megorzes: a legujabb $KEEP marad"
# Whole names only (a .bak or .part name must not yield a real file's name), and never the
# file uploaded in this run.
OLD=$(printf '%s\n' "$LISTING" | /bin/tr -s ' ' '\n' | /bin/grep -x 'acropora-ai-[0-9_-]*\.dump' | /bin/grep -v -x -F "$NAME" | sort -r | tail -n +$KEEP)
if [ -n "$OLD" ]; then
  { for f in $OLD; do echo "rm $DEST_DIR/$f"; done; } > "$WORK/ai-prune.sftp"
  if timeout 120 sftp -o BatchMode=yes -o ConnectTimeout=15 -i "$KEY" -b "$WORK/ai-prune.sftp" "$DEST_USER@$DEST_HOST" >/dev/null 2>&1; then
    echo "   torolve: $(printf '%s\n' $OLD | /bin/grep -c .) regi fajl"
  else
    echo "   FIGYELEM: a regi fajlok torlese nem sikerult (a mentes maga rendben van)"
  fi
  rm -f "$WORK/ai-prune.sftp"
else
  echo "   nincs torolnivalo"
fi

echo
echo "KESZ. $DEST_DIR/$NAME"
