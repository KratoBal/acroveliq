#!/bin/bash
# fleet-gate: the only thing the fleet's SSH key may run on an Acropora host
# (security register B8). Installed root-owned as /usr/local/sbin/fleet-gate
# and forced on the key in ~fleet/.ssh/authorized_keys:
#
#   command="/usr/local/sbin/fleet-gate",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... fleet
#
# The fleet user is in the docker group, and a rootful Docker is root on the
# host (`docker run -v /:/host`). With this line the key reaches only the
# operations below, by name, with fixed arguments. Everything else is refused:
# exit 2, one line to stderr, one line to syslog (tag fleet-gate).
#
# THE INPUT IS NEVER INTERPRETED BY A SHELL. SSH_ORIGINAL_COMMAND may hold only
# letters, digits, space, dot, underscore, colon and hyphen; it is split on
# spaces with globbing off, the first word picks the operation, and every other
# word is checked against a fixed list or pattern. Data (SQL, a dump) comes on
# stdin and goes to the container's own program, never to a shell.
#
# Install, verify and roll back: docs/fleet-gate.md.
set -uo pipefail
set -f
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077

DOCKER=/usr/bin/docker
LOGGER=/usr/bin/logger
DF=/bin/df
UPTIME=/usr/bin/uptime
APT_CHECK=/usr/lib/update-notifier/apt-check
REBOOT_FILE=/var/run/reboot-required
# the fleet user's home from the account database, not from the environment
BACKUP_ROOT="$(getent passwd "$(id -un)" | cut -d: -f6)/backups"
BACKUP_MAX_BYTES=$((2 * 1024 * 1024 * 1024))
HOST="$(hostname -s 2>/dev/null || echo unknown)"
SQL_MAX_BYTES=1048576

# Tests only. The authorized_keys line runs the gate with no arguments and an
# SSH client cannot add any, so this is reachable only from a shell on the host.
TEST_ENV=""
if [ "${1:-}" = "--test-env" ] && [ -n "${2:-}" ]; then
  # shellcheck disable=SC1090
  . "$2"
  TEST_ENV=1
fi

# ---- the hosts ----------------------------------------------------------------
# Which operation lives on which host, and the only containers, databases and
# users each may touch. A container is named by a KEY: the start of its name
# (Coolify names an app's containers <app uuid>-<suffix>, and the suffix
# changes with a deployment). A target is key:database:user. An empty value
# leaves the operation refused on that host.
OPS=""
PSQL_TARGETS=""
DUMP_TARGETS=""
RESTORE_LIST_KEYS=""
DOCSTORE_KEY=""
ENV_GET_KEY=""
ENV_GET_NAMES=""
BACKUP_GET=""     # what this host may hand out: dump:<db> or docstore
BACKUP_PUT=""  # what this host may store from the other one
host_config() {
  case "$HOST" in
    acropora-prod-01)
      OPS="ps system-df df uptime reboot-required apt-check builder-prune psql-ro pg-dump pg-restore-list docstore-tar docstore-count env-get backup-db backup-docstore backup-get backup-put backup-prune"
      PSQL_TARGETS="iwm34jaqp9xmwb72qkrqkwhy:acropora:acropora"
      DUMP_TARGETS="iwm34jaqp9xmwb72qkrqkwhy:acropora:acropora xdfswedgxuehokvymhjotpfs:medusa:postgres"
      RESTORE_LIST_KEYS="iwm34jaqp9xmwb72qkrqkwhy xdfswedgxuehokvymhjotpfs"
      DOCSTORE_KEY="t9gxx94ecwekwruxngps5i6v"
      ENV_GET_KEY="t9gxx94ecwekwruxngps5i6v"
      ENV_GET_NAMES="MEDUSA_ADMIN_URL MEDUSA_PROJECTION_SCHEDULE_ENABLED"
      BACKUP_GET="dump:acropora dump:medusa docstore"
      BACKUP_PUT="dump:acropora_ai"
      ;;
    acropora-ai-stage-01)
      OPS="ps system-df df uptime reboot-required apt-check builder-prune image-prune-2h psql-ro pg-dump pg-restore-list restore-probe backup-db backup-get backup-put backup-prune coolify-deployments coolify-deploy-log"
      # NOT coolify-db: who writes the Coolify database decides what Coolify
      # deploys, with which mounts; that is root on the host (barracuda, #28).
      # Its two reads are named operations with the SQL built here.
      PSQL_TARGETS="cpnjvtte02yakzs9vb0jffky:acropora_ai:acropora_ai"
      DUMP_TARGETS="cpnjvtte02yakzs9vb0jffky:acropora_ai:acropora_ai"
      RESTORE_LIST_KEYS="cpnjvtte02yakzs9vb0jffky"
      BACKUP_GET="dump:acropora_ai"
      BACKUP_PUT="dump:acropora dump:medusa docstore"
      ;;
  esac
}
# a test may replace the host table, and only a test (barracuda, #28)
[ -n "$TEST_ENV" ] && [ "$(type -t host_config_override)" = "function" ] && host_config() { host_config_override; }
host_config

# ---- refusal and logging ------------------------------------------------------
log() { "$LOGGER" -t fleet-gate -- "$*" >/dev/null 2>&1 || true; }
deny() {
  log "deny host=$HOST reason=$1"
  echo "fleet-gate: elutasítva: $1" >&2
  exit 2
}
allow() { log "allow host=$HOST op=$*"; }

# ---- the input ----------------------------------------------------------------
CMD="${SSH_ORIGINAL_COMMAND-}"
[ -n "$CMD" ] || deny "nincs parancs (interaktív belépés nincs)"
[ "${#CMD}" -le 200 ] || deny "túl hosszú parancs"
case "$CMD" in
  *[!A-Za-z0-9\ ._:-]*) deny "nem engedett karakter a parancsban" ;;
esac
read -r -a W <<< "$CMD"
[ "${#W[@]}" -ge 1 ] || deny "nincs parancs"
OP="${W[0]}"
NARGS=$(( ${#W[@]} - 1 ))

case " $OPS " in
  *" $OP "*) ;;
  *) deny "a(z) '$OP' művelet ezen a gépen nem engedett" ;;
esac

# a key or a key:db:user triple from a fixed list
in_targets() {
  local want="$1" list="$2" t
  for t in $list; do [ "$t" = "$want" ] && return 0; done
  return 1
}
# the running container a key names: the first whose name is the key or starts
# with it; refused when there is none
resolve() {
  local key="$1" name
  for name in $("$DOCKER" ps --format '{{.Names}}'); do
    case "$name" in "$key"|"$key"-*) echo "$name"; return 0 ;; esac
  done
  deny "'$OP': nincs futó konténer ehhez: $key"
}
args() { [ "$NARGS" -eq "$1" ] || deny "'$OP': $1 argumentum kell, $NARGS jött"; }

# ---- the operations -----------------------------------------------------------
case "$OP" in
  ps)
    args 0; allow ps
    exec "$DOCKER" ps --format '{{.Names}}|{{.Image}}|{{.Status}}'
    ;;
  system-df)
    if [ "$NARGS" -eq 0 ]; then allow system-df; exec "$DOCKER" system df; fi
    [ "$NARGS" -eq 1 ] && [ "${W[1]}" = "--format" ] || deny "'system-df': csak --format lehet"
    allow system-df --format
    exec "$DOCKER" system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}'
    ;;
  df)
    if [ "$NARGS" -eq 0 ]; then allow df; exec "$DF" -h / /var/lib/docker; fi
    [ "$NARGS" -eq 1 ] && [ "${W[1]}" = "-P" ] || deny "'df': csak -P lehet"
    allow df -P
    exec "$DF" -P / /var/lib/docker
    ;;
  uptime)
    args 0; allow uptime
    exec "$UPTIME"
    ;;
  reboot-required)
    args 0; allow reboot-required
    if [ -e "$REBOOT_FILE" ]; then
      echo "IGEN"
      [ -r "$REBOOT_FILE.pkgs" ] && cat "$REBOOT_FILE.pkgs"
    else
      echo "NEM"
    fi
    exit 0
    ;;
  apt-check)
    args 0; allow apt-check
    exec "$APT_CHECK" --human-readable
    ;;
  builder-prune)
    args 0; allow builder-prune
    exec "$DOCKER" builder prune -f
    ;;
  image-prune-2h)
    args 0; allow image-prune-2h
    exec "$DOCKER" image prune -a -f --filter until=2h
    ;;
  psql-ro)
    # psql-ro <container> <db> <user> [plain|tuples|tuples-pipe|tuples-spaced-pipe], SQL on stdin
    [ "$NARGS" -eq 3 ] || [ "$NARGS" -eq 4 ] || deny "'psql-ro': <konténer> <adatbázis> <felhasználó> [formátum]"
    in_targets "${W[1]}:${W[2]}:${W[3]}" "$PSQL_TARGETS" || deny "'psql-ro': ez a konténer, adatbázis és felhasználó nincs a listán"
    FLAGS=()
    case "${W[4]:-plain}" in
      plain) ;;
      tuples) FLAGS=(-tA) ;;
      tuples-pipe) FLAGS=(-tA -F '|') ;;
      tuples-spaced-pipe) FLAGS=(-tA -F ' | ') ;;
      *) deny "'psql-ro': ismeretlen formátum" ;;
    esac
    SQL="$(head -c $((SQL_MAX_BYTES + 1)))"
    [ "${#SQL}" -le "$SQL_MAX_BYTES" ] || deny "'psql-ro': túl hosszú SQL"
    # a backslash starts a psql meta-command (\! runs a shell in the container)
    case "$SQL" in *\\*) deny "'psql-ro': backslash az SQL-ben (psql meta-parancs)" ;; esac
    C="$(resolve "${W[1]}")" || exit 2
    allow psql-ro "${W[1]}" "${W[2]}" "${W[3]}"
    printf '%s\n' "$SQL" | exec "$DOCKER" exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on' "$C" \
      psql -X -q -v ON_ERROR_STOP=1 -U "${W[3]}" -d "${W[2]}" "${FLAGS[@]}"
    ;;
  pg-dump)
    args 3
    in_targets "${W[1]}:${W[2]}:${W[3]}" "$DUMP_TARGETS" || deny "'pg-dump': ez a konténer, adatbázis és felhasználó nincs a listán"
    C="$(resolve "${W[1]}")" || exit 2
    allow pg-dump "${W[1]}" "${W[2]}" "${W[3]}"
    exec "$DOCKER" exec "$C" pg_dump -Fc -U "${W[3]}" -d "${W[2]}"
    ;;
  pg-restore-list)
    args 1
    in_targets "${W[1]}" "$RESTORE_LIST_KEYS" || deny "'pg-restore-list': ez a konténer nincs a listán"
    C="$(resolve "${W[1]}")" || exit 2
    allow pg-restore-list "${W[1]}"
    exec "$DOCKER" exec -i "$C" pg_restore -l
    ;;
  docstore-tar)
    args 0
    C="$(resolve "$DOCSTORE_KEY")" || exit 2
    allow docstore-tar
    exec "$DOCKER" exec "$C" tar -C /data -cf - document-store
    ;;
  docstore-count)
    # the number of files in the document store (no shell in the container)
    args 0
    C="$(resolve "$DOCSTORE_KEY")" || exit 2
    allow docstore-count
    "$DOCKER" exec "$C" find /data/document-store -type f | wc -l
    ;;
  restore-probe)
    # restore-probe: an AI dump on stdin goes into a throwaway postgres:16,
    # one fixed count query runs on it, the container is removed in any case.
    args 0; allow restore-probe
    for old in $("$DOCKER" ps -a --format '{{.Names}}'); do
      case "$old" in restore-proba-ai-*) "$DOCKER" rm -f "$old" >/dev/null 2>&1 || true ;; esac
    done
    C="restore-proba-ai-$(date +%s)-$$"
    trap '"$DOCKER" rm -f "$C" >/dev/null 2>&1 || true' EXIT
    # the dump is the caller's: it may run any SQL as superuser during the
    # restore, so the container gets no network and fixed limits, and the
    # image must already be on the host (barracuda, #28)
    "$DOCKER" run -d --name "$C" --network none --memory 1g --cpus 1 --pids-limit 256 --pull never -e POSTGRES_PASSWORD=proba -e POSTGRES_USER=acropora_ai -e POSTGRES_DB=acropora_ai postgres:16-alpine >/dev/null \
      || { echo "fleet-gate: a próba-konténer nem indult" >&2; exit 1; }
    ready=""
    for _ in $(seq 1 30); do
      if "$DOCKER" exec "$C" pg_isready -U acropora_ai -q; then ready=1; break; fi
      sleep 2
    done
    [ -n "$ready" ] || { echo "fleet-gate: a próba-adatbázis nem állt fel" >&2; exit 1; }
    "$DOCKER" exec -i "$C" pg_restore --no-owner --no-privileges -U acropora_ai -d acropora_ai || { echo "fleet-gate: a pg_restore hibával tért vissza" >&2; exit 1; }
    "$DOCKER" exec "$C" psql -X -U acropora_ai -d acropora_ai -Atc \
      "select 'conversations='||(select count(*) from conversations)||' messages='||(select count(*) from messages)||' answer_ratings='||(select count(*) from answer_ratings)"
    ;;
  env-get)
    # env-get: the values of a fixed few variables of one fixed container,
    # nothing else (heti-frissites-atnezes reads two MEDUSA_ settings)
    args 0
    C="$(resolve "$ENV_GET_KEY")" || exit 2
    allow env-get
    "$DOCKER" exec "$C" env | while IFS= read -r line; do
      for want in $ENV_GET_NAMES; do
        case "$line" in "$want"=*) printf '%s\n' "$line" ;; esac
      done
    done
    ;;
  coolify-deployments|coolify-deploy-log)
    # coolify-deployments <app uuid>: the app's last five deployments
    # coolify-deploy-log <deployment uuid>: one deployment's log (JSON)
    # The SQL is fixed here; the one argument is a 24-character uuid.
    args 1
    case "${W[1]}" in
      [a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]) ;;
      *) deny "'$OP': a uuid 24 kisbetű vagy számjegy" ;;
    esac
    C="$(resolve coolify-db)" || exit 2
    allow "$OP" "${W[1]}"
    if [ "$OP" = coolify-deployments ]; then
      exec "$DOCKER" exec -e 'PGOPTIONS=-c default_transaction_read_only=on' "$C" psql -X -q -U coolify -d coolify -tA -F '|' -c \
        "select deployment_uuid, status, case when is_api then 'kezi' else 'webhook' end, created_at, finished_at from application_deployment_queues where application_id = (select id::text from applications where uuid='${W[1]}') order by created_at desc limit 5"
    fi
    exec "$DOCKER" exec -e 'PGOPTIONS=-c default_transaction_read_only=on' "$C" psql -X -q -U coolify -d coolify -tA -c \
      "select logs from application_deployment_queues where deployment_uuid='${W[1]}'"
    ;;
  # ---- the daily backup (napi-adatbazis-mentes) ------------------------------
  # Everything under $BACKUP_ROOT, at fixed places: <db>/<date>.dump,
  # dokumentumok/<date>.tar.gz, and tavoli/... for the other host's copy.
  backup-db)
    # backup-db <key> <db> <user>: pg_dump to <db>/<today>.dump, then the TOC
    # count from pg_restore --list; prints "<db> <bytes> <toc>", fails on 0
    args 3
    in_targets "${W[1]}:${W[2]}:${W[3]}" "$DUMP_TARGETS" || deny "'backup-db': ez a konténer, adatbázis és felhasználó nincs a listán"
    C="$(resolve "${W[1]}")" || exit 2
    allow backup-db "${W[1]}" "${W[2]}" "${W[3]}"
    dir="$BACKUP_ROOT/${W[2]}"; file="$dir/$(date +%F).dump"
    mkdir -p "$dir" || exit 1
    "$DOCKER" exec "$C" pg_dump -U "${W[3]}" -d "${W[2]}" -Fc > "$file" || { echo "fleet-gate: a pg_dump hibával tért vissza" >&2; exit 1; }
    toc=$("$DOCKER" exec -i "$C" pg_restore --list < "$file" | grep -c '^')
    echo "${W[2]} $(stat -c %s "$file") $toc"
    [ "$toc" -gt 0 ] || exit 1
    ;;
  backup-docstore)
    # the document store to dokumentumok/<today>.tar.gz; prints
    # "dokumentumok <bytes> <files in the archive> <files in the store>", fails on a mismatch
    args 0
    C="$(resolve "$DOCSTORE_KEY")" || exit 2
    allow backup-docstore
    dir="$BACKUP_ROOT/dokumentumok"; file="$dir/$(date +%F).tar.gz"
    mkdir -p "$dir" || exit 1
    "$DOCKER" exec "$C" tar -C /data -cf - document-store | gzip -1 > "$file" || { echo "fleet-gate: a tar hibával tért vissza" >&2; exit 1; }
    packed=$(tar -tzf "$file" | grep -vc '/$')
    stored=$("$DOCKER" exec "$C" find /data/document-store -type f | wc -l)
    echo "dokumentumok $(stat -c %s "$file") $packed $stored"
    [ "$packed" -eq "$stored" ] || exit 1
    ;;
  backup-get|backup-put)
    # backup-get dump <db> <date> | backup-get docstore <date>: the file to stdout
    # backup-put (same arguments): stdin to tavoli/..., the other host's copy
    case "$NARGS:${W[1]:-}" in
      3:dump) what="dump:${W[2]}"; date="${W[3]}"; rel="${W[2]}/${W[3]}.dump" ;;
      2:docstore) what="docstore"; date="${W[2]}"; rel="dokumentumok/${W[2]}.tar.gz" ;;
      *) deny "'$OP': dump <adatbázis> <dátum> vagy docstore <dátum>" ;;
    esac
    case "$date" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) deny "'$OP': a dátum ÉÉÉÉ-HH-NN alakú" ;; esac
    if [ "$OP" = backup-get ]; then
      in_targets "$what" "$BACKUP_GET" || deny "'backup-get': ez a mentés ezen a gépen nem olvasható"
      [ -f "$BACKUP_ROOT/$rel" ] || deny "'backup-get': nincs ilyen mentés"
      allow backup-get "$what" "$date"
      exec cat "$BACKUP_ROOT/$rel"
    fi
    in_targets "$what" "$BACKUP_PUT" || deny "'backup-put': ez a mentés ezen a gépen nem fogadható"
    # only today's or yesterday's copy: a stolen key cannot fill the disk with
    # dated files the retention would keep (barracuda, #28)
    [ "$date" = "$(date +%F)" ] || [ "$date" = "$(date -d yesterday +%F)" ] || deny "'backup-put': csak a mai vagy a tegnapi mentés fogadható"
    mkdir -p "$BACKUP_ROOT" || exit 1
    free_kb=$(df -Pk "$BACKUP_ROOT" | awk 'NR == 2 { print $4 }')
    [ "${free_kb:-0}" -ge $((2 * BACKUP_MAX_BYTES / 1024)) ] || deny "'backup-put': kevés a szabad hely (kell: a korlát kétszerese)"
    allow backup-put "$what" "$date"
    file="$BACKUP_ROOT/tavoli/$rel"
    # never over an existing copy: a second put of the same day is a mistake to see
    [ ! -e "$file" ] || deny "'backup-put': ez a távoli mentés már létezik"
    mkdir -p "$(dirname "$file")" || exit 1
    part="$(mktemp "$file.part.XXXXXX")" || exit 1
    head -c "$BACKUP_MAX_BYTES" > "$part" && mv -n "$part" "$file" && [ ! -e "$part" ] || { rm -f "$part"; echo "fleet-gate: a távoli mentés nem íródott ki" >&2; exit 1; }
    echo "$what $(stat -c %s "$file")"
    ;;
  backup-prune)
    # the retention: dumps 14 days, the document store 7, here and in tavoli/
    args 0; allow backup-prune
    [ -d "$BACKUP_ROOT" ] || exit 0
    find "$BACKUP_ROOT" -name '*.dump' -mtime +14 -print -delete
    find "$BACKUP_ROOT" -path '*/dokumentumok/*' -name '*.tar.gz' -mtime +7 -print -delete
    ;;
  *)
    deny "ismeretlen művelet"
    ;;
esac
