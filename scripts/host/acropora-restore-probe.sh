#!/bin/bash
# acropora-restore-probe -- the weekly restore test of the OS, Commerce and document-store
# backups, on acropora-prod-01, under the backups' OWN identity (security register B8).
#
# WHY HERE AND NOT IN THE FLEET (Balazs, 2026-10-13 16:59:45 and 17:07:37 UTC, Token thread,
# msg 1559611614309650473 and 1559613596789383233): the fleet's rights do NOT grow for this,
# neither a NAS read grant nor a new gate operation. The three backups are written by root on
# this machine with one NAS credential (/etc/acropora-backup-rsync.secret, rsync daemon user
# acropora-backup); the files are 0600 on the NAS, and the fleet's own NAS account (AcroBot)
# cannot read them (measured 2026-10-13 23:37). So the probe runs where the backup runs, as the
# same identity, and leaves ONE result file the fleet can read with what it already has.
#
# THE RULE THAT MAKES THIS A TEST (the same as scripts/visszaallitasi-proba.sh): the copy is
# DOWNLOADED FROM THE NAS, never re-dumped. A fresh dump proves the database works; only the
# stored copy proves the backup works.
#
# WHAT IT DOES, per kind
#   os, commerce  the newest *.dump from the NAS -> a throwaway container (the live container's
#                 own image, no network, memory/CPU/pids limits, never pulls) -> pg_restore
#                 --exit-on-error -> exact row counts of every table, there and on the live
#                 database (read-only transaction) -> the container and the file are removed
#   docstore      the NAS mirror -> a temporary directory -> every live file older than
#                 PROBE_DOCSTORE_GRACE_H must be there with the same sha256 -> removed
# WHAT IT NEVER DOES: write to a live database or volume (the live side only gets a
# read-only psql and a find/sha256sum), touch the backups on the NAS (it only reads them),
# or put data into the result (counts, sizes, table names and fixed reasons only; the
# restore's own error text stays in the journal, because a COPY error quotes the row).
#
# OUTPUT: $PROBE_STATE/result-<stamp>.json, uploaded to Acropora_Backup/$PROBE_RESULT_DIR/
# (0644), where the fleet's scripts/visszaallitasi-proba.sh reads it.
# EXIT: 0 only if every kind passed AND the result reached the NAS. 75: another run holds the lock.
#
# USAGE   acropora-restore-probe [os] [commerce] [docstore]      (default: all three)
# INSTALL /usr/local/sbin/acropora-restore-probe (root:root 0750) with
#         acropora-restore-probe.service and .timer from this directory; the step sheet is
#         exchange/biztonsag/baseline/b8-visszaallitasi-proba-terv-2026-10-14.md.
set -uo pipefail
umask 077

# ---- configuration (the .service may override from /etc/acropora-restore-probe.env) ----
PASSWORD_FILE="${PROBE_PASSWORD_FILE:-/etc/acropora-backup-rsync.secret}"
NAS="${PROBE_NAS:-rsync://acropora-backup@csupor/Acropora_Backup}"
RESULT_DIR="${PROBE_RESULT_DIR:-acropora-restore-probe}"
WORK="${PROBE_WORK:-/var/tmp/acropora-restore-probe}"
STATE="${PROBE_STATE:-/var/lib/acropora-restore-probe}"
DOCKER="${PROBE_DOCKER:-/usr/bin/docker}"
RSYNC="${PROBE_RSYNC:-/usr/bin/rsync}"
# <kind>: NAS directory, live container key (exact name or "<key>-<suffix>"), database, user.
# Measured: the gate's DUMP_TARGETS (scripts/host/fleet-gate.sh) and the backup units (a copy
# in the live tree's docs/, not in git).
OS_SPEC="${PROBE_OS:-acropora-os-postgres iwm34jaqp9xmwb72qkrqkwhy acropora acropora}"
COMMERCE_SPEC="${PROBE_COMMERCE:-acropora-commerce-postgres xdfswedgxuehokvymhjotpfs medusa postgres}"
DOCSTORE_DIR="${PROBE_DOCSTORE_DIR:-acropora-os-document-store}"
DOCSTORE_VOLUME="${PROBE_DOCSTORE_VOLUME:-t9gxx94ecwekwruxngps5i6v-acropora-api-document-store}"
DOCSTORE_SOURCE="${PROBE_DOCSTORE_SOURCE:-/var/lib/docker/volumes/$DOCSTORE_VOLUME/_data}"
# A backup older than this is a stopped backup, even if it restores fine (the fleet's limit).
MAX_AGE_H="${PROBE_MAX_AGE_H:-36}"
# The mirror runs daily; a live file older than this must already be on the NAS.
DOCSTORE_GRACE_H="${PROBE_DOCSTORE_GRACE_H:-25}"
# Tables in the live database that the restored copy lacks. Production auto-deploy is off, so
# a migration between the 03:0x dump and this run is a decision, not noise: 0.
MAX_MISSING_TABLES="${PROBE_MAX_MISSING_TABLES:-0}"
# The restored total may be below the live one by the day's growth, not by half.
MIN_ROW_PCT="${PROBE_MIN_ROW_PCT:-50}"
# A live table at least this big must not come back empty.
BIG_TABLE_ROWS="${PROBE_BIG_TABLE_ROWS:-1000}"
MEMORY="${PROBE_MEMORY:-1g}"
# Free space wanted for a restore: this many times the dump size, plus 1 GiB.
SPACE_FACTOR="${PROBE_SPACE_FACTOR:-6}"

for n in MAX_AGE_H DOCSTORE_GRACE_H MAX_MISSING_TABLES MIN_ROW_PCT BIG_TABLE_ROWS SPACE_FACTOR; do
  case "${!n}" in ""|*[!0-9]*) echo "FAIL: $n nem nemnegativ egesz: ${!n}" >&2; exit 2 ;; esac
done
# rm -rf runs on $WORK: only ever on a directory of this name, never on / or a typo.
case "$WORK" in /*/acropora-restore-probe) ;; *) echo "FAIL: PROBE_WORK alakja: $WORK" >&2; exit 2 ;; esac
case "$STATE" in /*) ;; *) echo "FAIL: PROBE_STATE nem abszolut: $STATE" >&2; exit 2 ;; esac
# /var/tmp is world-writable: under systemd PrivateTmp isolates it, but a run started by hand
# would follow a planted symlink with root's writes (barracuda, #92). Neither may be a link.
for d in "$WORK" "$STATE"; do
  [ ! -L "$d" ] || { echo "FAIL: symlink, nem futok: $d" >&2; exit 2; }
done

KINDS=("$@")
[ "${#KINDS[@]}" -gt 0 ] || KINDS=(os commerce docstore)
for k in "${KINDS[@]}"; do
  case "$k" in os|commerce|docstore) ;; *) echo "usage: acropora-restore-probe [os] [commerce] [docstore]" >&2; exit 2 ;; esac
done

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
# Strings that go into the JSON: fixed reasons, file and table names. Anything outside this
# set becomes '?', so a name can never break the JSON or smuggle text into it.
jstr() { printf '"%s"' "$(printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9 _.:,;/=<>()+-' '?')"; }
free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 + 0 }'; }

mkdir -p "$STATE" || exit 1
exec 9>"$STATE/lock"
flock -n 9 || { log "MEG FUT az elozo proba, kihagyva"; exit 75; }

[ -r "$PASSWORD_FILE" ] || { log "FAIL: nincs olvashato jelszo-fajl: $PASSWORD_FILE"; exit 1; }
RS=("$RSYNC" "--password-file=$PASSWORD_FILE")

probe_containers() { "$DOCKER" ps -a --format '{{.Names}}' 2>/dev/null | grep '^acropora-restore-probe-' || true; }
cleanup() {
  for c in $(probe_containers); do "$DOCKER" rm -f -v "$c" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT
# A run killed mid-way (reboot, OOM) leaves its container; the next run sweeps it first.
cleanup
# not -p: if anything stands at $WORK after the sweep, someone put it there; stop
mkdir -m 0700 "$WORK" || { log "FAIL: a munkakonyvtar nem hozhato letre tisztan: $WORK"; exit 1; }

STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STAMP=$(date +%Y-%m-%d_%H-%M-%S)
OVERALL=PASS
SECTIONS=()

# resolve <key>: the running container named <key> or <key>-<suffix> (as the gate does)
resolve() {
  local name
  for name in $("$DOCKER" ps --format '{{.Names}}'); do
    case "$name" in "$1"|"$1"-*) echo "$name"; return 0 ;; esac
  done
  return 1
}

# Exact counts of every ordinary table, one "schema.table|n" line each. Exact, not
# pg_stat n_live_tup: the statistics are estimates (see scripts/visszaallitasi-proba.sh).
COUNT_SQL="select format('select %L || ''|'' || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
order by 1
\\gexec"

probe_db() {  # <kind> <nas dir> <container key> <db> <user>
  local kind="$1" dir="$2" key="$3" db="$4" user="$5"
  local reasons=() file="" bytes=0 mtime="" age_h=-1 rc=-1 errs=0
  local nr=0 nl=0 rt=0 lt=0 miss=0 empty=""
  log "== $kind ($dir)"
  # newest by the listed mtime: rsync -t keeps the time the dump was written
  local line
  line=$("${RS[@]}" --list-only "$NAS/$dir/" 2>"$WORK/$kind.list.err" | awk '$1 ~ /^-/ && $NF ~ /\.dump$/' | sort -k3,4 | tail -1)
  if [ -z "$line" ]; then
    reasons+=("nincs .dump a NAS-on")
  else
    file=$(printf '%s\n' "$line" | awk '{ print $NF }')
    bytes=$(printf '%s\n' "$line" | awk '{ gsub(/[,.]/, "", $2); print $2 + 0 }')
    mtime=$(printf '%s\n' "$line" | awk '{ print $3 " " $4 }')
    local e; e=$(date -d "$mtime" +%s 2>/dev/null || echo 0)
    [ "$e" -gt 0 ] && age_h=$(( ($(date +%s) - e) / 3600 ))
    log "   $file, $bytes bajt, $mtime ($age_h ora)"
    case "$file" in *[!A-Za-z0-9_.-]*) reasons+=("a fajlnev alakja ismeretlen") ;; esac
    [ "$age_h" -ge 0 ] && [ "$age_h" -le "$MAX_AGE_H" ] || reasons+=("a legujabb mentes $age_h oras (hatar $MAX_AGE_H)")
    [ "$bytes" -gt 0 ] || reasons+=("ures dump")
  fi
  local live=""
  live=$(resolve "$key") || reasons+=("nem fut az elo kontener: $key")

  if [ "${#reasons[@]}" -eq 0 ]; then
    local root need
    root=$("$DOCKER" info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
    need=$(( bytes / 1024 * SPACE_FACTOR + 1048576 ))
    [ "$(free_kb "$WORK")" -ge $(( bytes / 1024 + 1048576 )) ] || reasons+=("keves hely: $WORK")
    [ "$(free_kb "$root")" -ge "$need" ] || reasons+=("keves hely: $root")
  fi
  if [ "${#reasons[@]}" -eq 0 ]; then
    if ! "${RS[@]}" -t "$NAS/$dir/$file" "$WORK/$kind.dump" 2>"$WORK/$kind.get.err"; then
      reasons+=("a letoltes elhasalt")
    elif [ "$(stat -c %s "$WORK/$kind.dump")" != "$bytes" ]; then
      reasons+=("a letoltott meret elter a listazottol")
    fi
  fi
  if [ "${#reasons[@]}" -eq 0 ]; then
    local image c="acropora-restore-probe-$kind"
    image=$("$DOCKER" inspect -f '{{.Config.Image}}' "$live")
    # The dump may run any SQL as superuser while it loads: no network, fixed limits, and the
    # live container's own image, already on the host (--pull never), so the major version
    # matches and nothing is fetched.
    # Capabilities: only what the postgres entrypoint needs to chown its data directory and
    # drop to the postgres user (barracuda, #92); gosu switches user by syscall, so
    # no-new-privileges does not stop it.
    if ! "$DOCKER" run -d --name "$c" --label acropora.restore-probe=1 --network none \
         --memory "$MEMORY" --cpus 1 --pids-limit 256 --pull never \
         --security-opt no-new-privileges --cap-drop ALL \
         --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER \
         -e POSTGRES_PASSWORD="probe-$RANDOM$RANDOM" -e POSTGRES_USER="$user" -e POSTGRES_DB="$db" \
         "$image" >/dev/null; then
      reasons+=("a proba-kontener nem indult")
    else
      # Over TCP on purpose: during initdb the entrypoint runs a temporary server on the socket
      # only, and a socket check would let the restore start against that one.
      local ready=""
      for _ in $(seq 1 60); do
        if "$DOCKER" exec "$c" pg_isready -h 127.0.0.1 -U "$user" -q; then ready=1; break; fi
        sleep 2
      done
      if [ -z "$ready" ]; then
        reasons+=("a proba-adatbazis nem allt fel")
      else
        # From a FILE in the container, not stdin: on a non-seekable input pg_restore can only
        # take the archive in order, and an out-of-order entry would fail as "non-seekable"
        # instead of measuring the backup (barracuda, #92).
        if ! "$DOCKER" cp "$WORK/$kind.dump" "$c:/tmp/restore.dump" 2>"$WORK/$kind.restore.err"; then
          rc=125
        else
          "$DOCKER" exec "$c" pg_restore --no-owner --no-privileges --exit-on-error -U "$user" -d "$db" \
            /tmp/restore.dump 2>>"$WORK/$kind.restore.err"
          rc=$?
        fi
        errs=$(grep -c 'error' "$WORK/$kind.restore.err")
        if [ "$rc" -ne 0 ]; then
          reasons+=("a pg_restore hibaval tert vissza (rc $rc)")
          log "   pg_restore hiba, az elso sorok (csak a naploba):"; head -5 "$WORK/$kind.restore.err"
        else
          printf '%s\n' "$COUNT_SQL" | "$DOCKER" exec -i "$c" psql -X -q -At -v ON_ERROR_STOP=1 -U "$user" -d "$db" \
            > "$WORK/$kind.restored" 2>"$WORK/$kind.count.err" || reasons+=("a szamlalas a visszatoltott peldanyon elhasalt")
          # the live side: read-only transaction, bounded, nothing else ever runs there
          printf '%s\n' "$COUNT_SQL" | "$DOCKER" exec -i \
            -e 'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=600000 -c lock_timeout=10000' \
            "$live" psql -X -q -At -v ON_ERROR_STOP=1 -U "$user" -d "$db" \
            > "$WORK/$kind.live" 2>"$WORK/$kind.livecount.err" || reasons+=("a szamlalas az elo adatbazison elhasalt")
        fi
      fi
      "$DOCKER" rm -f -v "$c" >/dev/null 2>&1 || true
    fi
    rm -f "$WORK/$kind.dump"
  fi
  if [ "${#reasons[@]}" -eq 0 ]; then
    # FILENAME, not NR == FNR: with an EMPTY restored list (no tables came back) NR == FNR would
    # hold for the live file's lines too, and the live tables would be counted as restored.
    read -r nr nl rt lt miss empty < <(awk -F'|' -v big="$BIG_TABLE_ROWS" '
      FILENAME == ARGV[1] { r[$1] = $2; nr++; rt += $2; next }
      { nl++; lt += $2
        if (!($1 in r)) miss++
        else if ($2 + 0 >= big && r[$1] + 0 == 0) { empty = empty sep $1; sep = "," } }
      END { printf "%d %d %d %d %d %s\n", nr, nl, rt, lt, miss, empty }' "$WORK/$kind.restored" "$WORK/$kind.live")
    log "   visszatoltve: $nr tabla, $rt sor;  elo: $nl tabla, $lt sor;  hianyzo tabla: $miss"
    [ "$nr" -gt 0 ] || reasons+=("a visszatoltott peldanyban nincs tabla")
    [ "$miss" -le "$MAX_MISSING_TABLES" ] || reasons+=("$miss elo tabla hianyzik a mentesbol")
    if [ "$lt" -gt 0 ] && [ $(( rt * 100 )) -lt $(( lt * MIN_ROW_PCT )) ]; then
      reasons+=("a visszatoltott sorok szama $rt, az elo $lt (hatar $MIN_ROW_PCT%)")
    fi
    [ -z "$empty" ] || reasons+=("ures a visszatoltott peldanyban: $empty")
  fi

  local status=PASS reason=""
  if [ "${#reasons[@]}" -gt 0 ]; then
    status=FAIL; OVERALL=FAIL
    reason=$(printf '%s; ' "${reasons[@]}"); reason="${reason%; }"
    log "   FAIL[$kind]: $reason"
  else
    log "   PASS[$kind]"
  fi
  SECTIONS+=("$(printf '"%s": {"status": "%s", "file": %s, "file_bytes": %d, "file_mtime": %s, "age_h": %d, "restore_rc": %d, "restore_error_lines": %d, "tables_restored": %d, "tables_live": %d, "tables_missing": %d, "rows_restored": %d, "rows_live": %d, "big_tables_empty": %s, "reason": %s}' \
    "$kind" "$status" "$(jstr "$file")" "$bytes" "$(jstr "$mtime")" "$age_h" "$rc" "${errs:-0}" \
    "$nr" "$nl" "$miss" "$rt" "$lt" "$(jstr "$empty")" "$(jstr "$reason")")")
}

probe_docstore() {
  local reasons=() remote_files=0 remote_bytes=0 live_files=0 checked=0 bad=0
  log "== docstore ($DOCSTORE_DIR)"
  # The marker lives ON the volume: without it the path is an empty directory, not the store
  # (the same guard as acropora-document-store-backup).
  [ -e "$DOCSTORE_SOURCE/.acropora-document-store" ] || reasons+=("a jelolo hianyzik, a kotet nincs csatolva")
  if [ "${#reasons[@]}" -eq 0 ]; then
    read -r remote_files remote_bytes < <("${RS[@]}" -r --list-only "$NAS/$DOCSTORE_DIR/" 2>"$WORK/docstore.list.err" \
      | awk '$1 ~ /^-/ { gsub(/[,.]/, "", $2); n++; b += $2 } END { printf "%d %d\n", n, b }')
    log "   NAS: $remote_files fajl, $remote_bytes bajt"
    [ "$remote_files" -gt 0 ] || reasons+=("a NAS tukor ures vagy nem listazhato")
    [ "$(free_kb "$WORK")" -ge $(( remote_bytes / 1024 + 1048576 )) ] || reasons+=("keves hely: $WORK")
  fi
  if [ "${#reasons[@]}" -eq 0 ]; then
    mkdir -p "$WORK/docstore"
    if ! "${RS[@]}" -rt "$NAS/$DOCSTORE_DIR/" "$WORK/docstore/" 2>"$WORK/docstore.get.err"; then
      reasons+=("a letoltes elhasalt")
    else
      local cut; cut=$(( $(date +%s) - DOCSTORE_GRACE_H * 3600 ))
      live_files=$(cd "$DOCSTORE_SOURCE" && find . -type f | wc -l)
      # Every live file older than the grace must be on the NAS, byte for byte. Files never
      # change after upload, so a differing sum can only be a damaged copy.
      ( cd "$DOCSTORE_SOURCE" && find . -type f ! -newermt "@$cut" -print0 | sort -z | xargs -0 -r sha256sum ) > "$WORK/docstore.sha"
      checked=$(grep -c '' "$WORK/docstore.sha")
      bad=$(cd "$WORK/docstore" && sha256sum -c --quiet "$WORK/docstore.sha" 2>/dev/null | grep -c ': FAILED')
      log "   elo: $live_files fajl, ebbol ellenorizve (regebbi $DOCSTORE_GRACE_H oranal): $checked, elter vagy hianyzik: $bad"
      [ "$checked" -gt 0 ] || reasons+=("nincs ellenorizheto elo fajl")
      [ "$bad" -eq 0 ] || reasons+=("$bad fajl hianyzik vagy elter a NAS tukorben")
    fi
    rm -rf "$WORK/docstore"
  fi
  local status=PASS reason=""
  if [ "${#reasons[@]}" -gt 0 ]; then
    status=FAIL; OVERALL=FAIL
    reason=$(printf '%s; ' "${reasons[@]}"); reason="${reason%; }"
    log "   FAIL[docstore]: $reason"
  else
    log "   PASS[docstore]"
  fi
  SECTIONS+=("$(printf '"docstore": {"status": "%s", "remote_files": %d, "remote_bytes": %d, "live_files": %d, "checked": %d, "missing_or_differing": %d, "reason": %s}' \
    "$status" "$remote_files" "$remote_bytes" "$live_files" "$checked" "$bad" "$(jstr "$reason")")")
}

for k in "${KINDS[@]}"; do
  case "$k" in
    os)       read -r a b c d <<<"$OS_SPEC";       probe_db os "$a" "$b" "$c" "$d" ;;
    commerce) read -r a b c d <<<"$COMMERCE_SPEC"; probe_db commerce "$a" "$b" "$c" "$d" ;;
    docstore) probe_docstore ;;
  esac
done

RESULT="$STATE/result-$STAMP.json"
{
  printf '{"probe": "acropora-restore-probe", "version": 1, "host": %s, "started": "%s", "finished": "%s", "script_sha256": "%s", "status": "%s", "kinds": {' \
    "$(jstr "$(hostname)")" "$STARTED" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(sha256sum "$0" | cut -d' ' -f1)" "$OVERALL"
  sep=""
  for s in "${SECTIONS[@]}"; do printf '%s%s' "$sep" "$s"; sep=", "; done
  printf '}}\n'
} > "$RESULT"
chmod 0644 "$RESULT"
# keep the newest 20 locally
ls -1 "$STATE"/result-*.json 2>/dev/null | sort | head -n -20 | xargs -r rm -f

# The result is the only thing the fleet sees, so a result that did not arrive is a failure.
log "== eredmeny: $OVERALL -> $NAS/$RESULT_DIR/$(basename "$RESULT")"
# -p is what makes --chmod stick: without it the receiver's umask decides, and a restrictive one
# leaves 0600 (measured 2026-10-13 with a local rsync 3.2.7: -t --chmod=F644 under umask 077 gave
# 600, -tp gave 644). The three backups upload with -rt --chmod and no -p.
# The DIRECTORY is sent too (a one-file copy of it, no --delete), so its D755 is set on every
# run as well: the fleet's account must be able to list it, not only read the file.
mkdir -p "$WORK/upload" && cp -p "$RESULT" "$WORK/upload/"
if ! "${RS[@]}" -rtp --chmod=D755,F644 "$WORK/upload/" "$NAS/$RESULT_DIR/" 2>"$WORK/upload.err"; then
  log "FAIL: az eredmeny feltoltese elhasalt: $(head -c 300 "$WORK/upload.err")"; exit 1
fi
REMOTE=$("${RS[@]}" --list-only "$NAS/$RESULT_DIR/$(basename "$RESULT")" 2>/dev/null | awk '{ gsub(/[,.]/, "", $2); print $2 + 0 }')
[ "$REMOTE" = "$(stat -c %s "$RESULT")" ] || { log "FAIL: a feltoltott eredmeny merete elter (${REMOTE:-nincs ott})"; exit 1; }
[ "$OVERALL" = PASS ] || exit 1
log "KESZ. minden proba PASS"
