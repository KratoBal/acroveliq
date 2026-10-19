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
# stdin and goes to the container's own program (or to a root-owned program
# installed with the gate, quote-templates-sync), never to a shell.
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
SSHD_CONFIG=/etc/ssh/sshd_config
SSHD_CONFIG_D=/etc/ssh/sshd_config.d
KEYFILE=/etc/ssh/authorized_keys/fleet
KEYFILE_EXPECT="root:root:644"
# the fleet user's home from the account database, not from the environment
BACKUP_ROOT="$(getent passwd "$(id -un)" | cut -d: -f6)/backups"
BACKUP_MAX_BYTES=$((2 * 1024 * 1024 * 1024))
HOST="$(hostname -s 2>/dev/null || echo unknown)"
SQL_MAX_BYTES=1048576
# quote-templates-sync: the program is root's, installed with the gate; the
# caller sends only its data (docs/fleet-gate.md)
QUOTE_SYNC_PROG=/usr/local/lib/fleet-gate/quote-templates-sync.mjs
QUOTE_SYNC_OWNER="root:root"
QUOTE_SYNC_MAX_BYTES=262144
# fleet-ro-grant (the no-command-line plan, point A; docs/fleet-gate.md "fleet_ro jogok gombbal"):
# the list comes from GitHub at the commit the caller names, never from the caller
CURL=/usr/bin/curl
GH_RAW=https://raw.githubusercontent.com/KratoBal/acroveliq
GH_API=https://api.github.com/repos/KratoBal/acroveliq
GRANT_DOC=docs/fleet-gate.md
GRANT_ROLE=fleet_ro_grantor
GRANT_TO=fleet_ro
GRANT_STATE_DIR="$(getent passwd "$(id -un)" | cut -d: -f6)/fleet-ro-grant"
GRANT_SZUKIT_MAX=40
GRANT_TODAY=""   # empty: today in Europe/Budapest (a test sets it)

# Tests only. The authorized_keys line runs the gate with no arguments and an
# SSH client cannot add any, so this is reachable only from a shell on the host.
TEST_ENV=""
if [ "${1:-}" = "--test-env" ] && [ -n "${2:-}" ]; then
  # shellcheck disable=SC1090
  . "$2"
  TEST_ENV=1
  shift 2
fi
# WHICH KEY RAN THE GATE: the authorized_keys line of the executor's key runs
# `fleet-gate vegrehajto`; the agents' key line runs it with no argument. Only
# the executor's key may apply a fleet_ro grant (fleet-ro-grant alkalmaz), and
# only after Balázs's approval, which the executor checks (docs/fleet-gate.md).
KEY_ROLE=flotta
case "${1:-}" in
  "") ;;
  vegrehajto) KEY_ROLE=vegrehajto ;;
  *) KEY_ROLE=ismeretlen ;;
esac

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
QUOTE_SYNC_KEY=""
APP_LOG_KEYS=""
GRANT_TARGETS=""   # fleet-ro-grant: key:database
BACKUP_GET=""     # what this host may hand out: dump:<db> or docstore
BACKUP_PUT=""  # what this host may store from the other one
host_config() {
  case "$HOST" in
    acropora-prod-01)
      OPS="ps system-df df uptime reboot-required apt-check sshd-match builder-prune psql-ro pg-dump pg-restore-list docstore-tar docstore-count env-get backup-db backup-docstore backup-get backup-sum backup-put backup-prune quote-templates-sync app-log fleet-ro-grant"
      # fleet-ro-grant: the fleet_ro grants of the OS database, through fleet_ro_grantor
      GRANT_TARGETS="iwm34jaqp9xmwb72qkrqkwhy:acropora"
      # psql-ro connects as fleet_ro, a read-only role with per-table, per-column
      # SELECT grants only (#63; no pg_read_all_data, no superuser):
      # docs/fleet-gate.md, "Telepítés, gépenként"
      PSQL_TARGETS="iwm34jaqp9xmwb72qkrqkwhy:acropora:fleet_ro"
      DUMP_TARGETS="iwm34jaqp9xmwb72qkrqkwhy:acropora:acropora xdfswedgxuehokvymhjotpfs:medusa:postgres"
      RESTORE_LIST_KEYS="iwm34jaqp9xmwb72qkrqkwhy xdfswedgxuehokvymhjotpfs"
      DOCSTORE_KEY="t9gxx94ecwekwruxngps5i6v"
      ENV_GET_KEY="t9gxx94ecwekwruxngps5i6v"
      ENV_GET_NAMES="MEDUSA_ADMIN_URL MEDUSA_PROJECTION_SCHEDULE_ENABLED"
      QUOTE_SYNC_KEY="t9gxx94ecwekwruxngps5i6v"
      # app-log: api, web, partner (the Coolify app uuids, scripts/eles-verziok.sh)
      APP_LOG_KEYS="t9gxx94ecwekwruxngps5i6v dnt6jzza68wnuamvi93whn28 iknrqjk9xeyydc5fibrk5tbp"
      BACKUP_GET="dump:acropora dump:medusa docstore"
      BACKUP_PUT="dump:acropora_ai"
      ;;
    acropora-ai-stage-01)
      OPS="ps system-df df uptime reboot-required apt-check sshd-match builder-prune image-prune-2h psql-ro pg-dump pg-restore-list restore-probe backup-db backup-get backup-sum backup-put backup-prune coolify-deployments coolify-deploy-log"
      # NOT coolify-db: who writes the Coolify database decides what Coolify
      # deploys, with which mounts; that is root on the host (barracuda, #28).
      # Its two reads are named operations with the SQL built here.
      # the stage OS database (a copy of real data) too, for reading product data: the same
      # fleet_ro, its own per-column grants in that cluster (docs/fleet-gate.md, "1b")
      PSQL_TARGETS="cpnjvtte02yakzs9vb0jffky:acropora_ai:fleet_ro dbpcyjbsbl2gfwtpn1ppw4vc:acropora_staging:fleet_ro"
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
[ "$KEY_ROLE" != ismeretlen ] || deny "ismeretlen kulcs-szerep a kényszerített parancsban"

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

# ---- fleet-ro-grant: the list, its checks and the SQL built here ----------------
# THE BLOCKED COLUMNS (the plan's "A részletesen"): a credential column is never
# granted, whatever the list says. Two guards on the gate's side, a name pattern
# and a fixed table.column list; the third is fleet_ro_grantor itself, which holds
# no grant option on them (its install step, docs/fleet-gate.md).
GRANT_BLOCKED_COLUMNS="User.passwordHash User.signatureCodeHash Session.tokenHash ServiceToken.tokenHash DeviceToken.token QuoteAcceptanceLink.tokenHash Asset.qrToken UnasConnectionSetting.encryptedApiKey UnasConnectionSetting.encryptionIv UnasConnectionSetting.authenticationTag NavConnectionSetting.encryptedCredentials NavConnectionSetting.encryptionIv NavConnectionSetting.authenticationTag SzamlazzConnectionSetting.encryptedAgentKey SzamlazzConnectionSetting.agentKeyEncryptionIv SzamlazzConnectionSetting.agentKeyAuthenticationTag SzamlazzConnectionSetting.encryptedFinancialApiKey SzamlazzConnectionSetting.financialApiKeyEncryptionIv SzamlazzConnectionSetting.financialApiKeyAuthenticationTag MedusaConnectionSetting.encryptedApiKey MedusaConnectionSetting.encryptionIv MedusaConnectionSetting.authenticationTag"
grant_blocked() {
  local l="${2,,}"
  case "$l" in
    *password*|*passwd*|*secret*|*token*|*encrypt*|*credential*|*apikey*|*api_key*|*privatekey*|*private_key*|*authenticationtag*|*signaturecode*) return 0 ;;
  esac
  in_targets "$1.$2" "$GRANT_BLOCKED_COLUMNS"
}
# THE LASTING BASE (acrobot, 32384): `tartos` (no expiry) is allowed only for the
# B8 base grants, the columns of the production install step in
# docs/fleet-gate.md. Every other line carries a date; there is no default.
GRANT_BASE_COLUMNS="ExternalBillingDocument.documentNumber ExternalBillingDocument.source ExternalBillingDocument.cancelled User.firstName User.lastName User.displayName User.nickname User.email Customer.displayName Customer.companyName Customer.email CustomerAddress.name CustomerAddress.line1 CustomerAddress.line2 Supplier.name Supplier.contactPersonName Supplier.email Supplier.contactPersonEmail Contract.contactPersonName Contract.organizationalUnitName WorksheetVersionSignature.signerName DecisionRun.exposure DecisionRun.resolution DecisionRun.status DecisionRun.latencyMs DecisionRun.respondedModel DecisionRun.errorCode DecisionRun.createdAt _prisma_migrations.migration_name _prisma_migrations.started_at _prisma_migrations.finished_at _prisma_migrations.rolled_back_at _prisma_migrations.applied_steps_count"
# a date is alive through its whole day in Europe/Budapest (barracuda): expired
# when today there is later than it
grant_today() { if [ -n "$GRANT_TODAY" ]; then echo "$GRANT_TODAY"; else TZ=Europe/Budapest date +%F; fi; }
GRANT_ID_RX='^[A-Za-z_][A-Za-z0-9_]{0,62}$'
# the list block on stdin -> one "table column expiry" line per column; any error
# refuses the whole list (the line is named)
grant_parse() {
  local n=0 rows=0 line t cols exp reason c seen=" "
  local -a cs
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [ "$n" -le 500 ] || deny "'fleet-ro-grant': a lista hosszabb 500 sornál"
    case "$line" in ''|'#'*) continue ;; esac
    read -r t cols exp reason <<< "$line"
    [[ "$t" =~ $GRANT_ID_RX ]] || deny "'fleet-ro-grant': a(z) $n. sor táblaneve nem azonosító"
    [ -n "${reason:-}" ] || deny "'fleet-ro-grant': a(z) $n. sorból hiányzik a lejárat vagy az indok"
    if [ "$exp" != tartos ]; then
      [[ "$exp" =~ ^20[0-9][0-9]-[01][0-9]-[0-3][0-9]$ ]] && [ "$(date -d "$exp" +%F 2>/dev/null)" = "$exp" ] \
        || deny "'fleet-ro-grant': a(z) $n. sor lejárata nem dátum (ÉÉÉÉ-HH-NN) és nem tartos"
    fi
    IFS=',' read -r -a cs <<< "$cols"
    [ "${#cs[@]}" -ge 1 ] && [ "${#cs[@]}" -le 64 ] || deny "'fleet-ro-grant': a(z) $n. sor oszloplistája üres vagy túl hosszú"
    for c in "${cs[@]}"; do
      [[ "$c" =~ $GRANT_ID_RX ]] || deny "'fleet-ro-grant': a(z) $n. sor egyik oszlopneve nem azonosító"
      grant_blocked "$t" "$c" && deny "'fleet-ro-grant': a(z) $n. sor tiltott (hitelesítő) oszlopot kér: $t.$c"
      if [ "$exp" = tartos ] && ! in_targets "$t.$c" "$GRANT_BASE_COLUMNS"; then
        deny "'fleet-ro-grant': a(z) $n. sor tartos, de $t.$c nem az alaplista oszlopa"
      fi
      case "$seen" in *" $t.$c "*) deny "'fleet-ro-grant': $t.$c kétszer szerepel" ;; esac
      seen="$seen$t.$c "
      rows=$((rows + 1))
      printf '%s %s %s\n' "$t" "$c" "$exp"
    done
  done
  [ "$rows" -le 2000 ] || deny "'fleet-ro-grant': több mint 2000 oszlop"
}
# the list at a commit: only a commit on main (a branch of this public repository
# is not a reviewed list), fetched anonymously; exactly one fleet-ro-grant block
grant_fetch() {
  local sha="$1" cmp doc blocks
  cmp="$("$CURL" -fsS --max-time 20 --max-filesize 4194304 -H 'Accept: application/vnd.github+json' "$GH_API/compare/$sha...main?per_page=1")" \
    || deny "'fleet-ro-grant': a commit nem ellenőrizhető a GitHubon"
  printf '%s' "$cmp" | grep -Eq '"behind_by": *0[,}]' || deny "'fleet-ro-grant': a commit nincs a main ágon"
  doc="$("$CURL" -fsS --max-time 20 --max-filesize 1048576 "$GH_RAW/$sha/$GRANT_DOC")" \
    || deny "'fleet-ro-grant': a lista nem tölthető le ($GRANT_DOC a commiton)"
  blocks="$(printf '%s\n' "$doc" | grep -c '^```fleet-ro-grant[[:space:]]*$')"
  [ "$blocks" = 1 ] || deny "'fleet-ro-grant': a dokumentumban nem pontosan egy fleet-ro-grant blokk áll ($blocks)"
  printf '%s\n' "$doc" | awk '/^```fleet-ro-grant[[:space:]]*$/ {f = 1; next} f && /^```/ {exit} f'
}
# the SQL: built here from validated identifiers (no quote can be in one), the
# grantee and the role fixed. $1: terv|alkalmaz (sync to the wanted pairs on stdin)
# or szukit (revoke exactly the pairs on stdin, where the grantor holds them).
grant_sql() {
  local mode="$1" t c values="" first=1
  while read -r t c; do
    [ -n "$t" ] || continue
    [ "$first" = 1 ] && first=0 || values="$values, "
    values="$values('$t', '$c')"
  done
  # the wanted pairs as a VALUES list inside each query: no temporary table, so the role needs no
  # TEMP right and the run writes nothing but the grants
  local pairs="(SELECT NULL::text AS t, NULL::text AS c WHERE false)"
  [ -n "$values" ] && pairs="(VALUES $values)"
  local held="EXISTS (SELECT 1 FROM information_schema.column_privileges p WHERE p.grantee = '$GRANT_TO' AND p.grantor = current_user AND p.privilege_type = 'SELECT' AND p.table_schema = 'public' AND p.table_name = r.t AND p.column_name = r.c)"
  printf '%s\n' "BEGIN;" "SET LOCAL lock_timeout = '5s';" "SET LOCAL statement_timeout = '60s';"
  printf '%s\n' 'DO $fleetro$' 'DECLARE r record;' 'BEGIN'
  if [ "$mode" = szukit ]; then
    printf '%s\n' "  FOR r IN SELECT w.t, w.c FROM $pairs AS w(t, c) ORDER BY 1, 2 LOOP" \
      "    IF $held THEN" \
      "      RAISE NOTICE 'REVOKE SELECT (%) ON % FROM $GRANT_TO', quote_ident(r.c), quote_ident(r.t);" \
      "      EXECUTE format('REVOKE SELECT (%I) ON %I FROM $GRANT_TO', r.c, r.t);" \
      "    END IF;" "  END LOOP;"
  else
    printf '%s\n' "  FOR r IN SELECT p.table_name AS t, p.column_name AS c FROM information_schema.column_privileges p" \
      "      WHERE p.grantee = '$GRANT_TO' AND p.grantor = current_user AND p.privilege_type = 'SELECT' AND p.table_schema = 'public'" \
      "        AND NOT EXISTS (SELECT 1 FROM $pairs AS w(t, c) WHERE w.t = p.table_name AND w.c = p.column_name)" \
      "      ORDER BY 1, 2 LOOP" \
      "    RAISE NOTICE 'REVOKE SELECT (%) ON % FROM $GRANT_TO', quote_ident(r.c), quote_ident(r.t);" \
      "    EXECUTE format('REVOKE SELECT (%I) ON %I FROM $GRANT_TO', r.c, r.t);" \
      "  END LOOP;" \
      "  FOR r IN SELECT w.t, w.c FROM $pairs AS w(t, c) ORDER BY 1, 2 LOOP" \
      "    IF NOT $held THEN" \
      "      RAISE NOTICE 'GRANT SELECT (%) ON % TO $GRANT_TO', quote_ident(r.c), quote_ident(r.t);" \
      "      EXECUTE format('GRANT SELECT (%I) ON %I TO $GRANT_TO', r.c, r.t);" \
      "      -- a GRANT the role holds no grant option for only WARNS; that is a stop here" \
      "      IF NOT $held THEN RAISE EXCEPTION 'nem adhato: %.% (a $GRANT_ROLE nem birtokolja)', r.t, r.c; END IF;" \
      "    END IF;" "  END LOOP;"
  fi
  printf '%s\n' 'END' '$fleetro$;'
  if [ "$mode" = terv ]; then echo "ROLLBACK;"; else echo "COMMIT;"; fi
}
grant_psql() {
  "$DOCKER" exec -i "$1" psql -X -q -v ON_ERROR_STOP=1 -U "$GRANT_ROLE" -d "$2"
}

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
  sshd-match)
    # sshd-match: does the gate still stand? The Match block that points sshd at
    # the root-owned key file, that file's owner and mode, and the forced
    # command on its key line. A package update replacing sshd_config would take
    # the Match block and the gate with it, silently (barracuda, #30). EVERY key
    # line must be forced: a second, plain line would be a way around. And sshd
    # takes the FIRST value of a keyword: a Match block in sshd_config.d (the
    # Include stands at the top of the main file) or an earlier Match covering
    # fleet or all would win over ours at the end (barracuda, #31). Reads only;
    # all these files are world-readable. Exit 1 when anything is off. The full
    # proof stays `sshd -T -C user=fleet,...` at install time.
    args 0; allow sshd-match
    match=$(grep -cE '^Match[[:space:]]+User[[:space:]]+fleet[[:space:]]*$' "$SSHD_CONFIG" 2>/dev/null || true)
    # another Match line in the main file that names fleet or all
    others=$(grep -iE '^[[:space:]]*Match[[:space:]]' "$SSHD_CONFIG" 2>/dev/null \
      | grep -vE '^Match[[:space:]]+User[[:space:]]+fleet[[:space:]]*$' \
      | grep -ciE '[[:space:],!*](fleet|all)([[:space:],]|$)' || true)
    # the whole rule for the main file: exactly ONE authorized-keys setting, and
    # it is ours, inside our block. A `Match Group docker` or `Match Address`
    # block with its own key setting would win over ours whatever it names
    # (barracuda, #31)
    keyopts=$(grep -ciE '^[[:space:]]*(AuthorizedKeysFile|AuthorizedKeysCommand)[[:space:]]' "$SSHD_CONFIG" 2>/dev/null || true)
    ours=$(awk '/^Match[[:space:]]+User[[:space:]]+fleet[[:space:]]*$/ { m = 1; next }
                /^[[:space:]]*Match[[:space:]]/ { m = 0 }
                m && tolower($1) == "authorizedkeysfile" && $2 == "/etc/ssh/authorized_keys/%u" && NF == 2 { c++ }
                END { print c + 0 }' "$SSHD_CONFIG" 2>/dev/null || echo 0)
    # no ForceCommand anywhere in the main file: our constraint is the key
    # line's command=, and a ForceCommand would override or replace it (acrobot 28820)
    forcecmds=$(grep -ciE '^[[:space:]]*ForceCommand[[:space:]]' "$SSHD_CONFIG" 2>/dev/null || true)
    # the only Include may be the usual one: another path would bring settings
    # this check does not read (barracuda, #31)
    includes=$(grep -iE '^[[:space:]]*Include[[:space:]]' "$SSHD_CONFIG" 2>/dev/null \
      | grep -cvE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf[[:space:]]*$' || true)
    # any Match, authorized-keys or ForceCommand setting in the included files
    dropins=0
    if [ -d "$SSHD_CONFIG_D" ]; then
      dropins=$(find "$SSHD_CONFIG_D" -maxdepth 1 -type f -name '*.conf' -exec cat {} + 2>/dev/null \
        | grep -ciE '^[[:space:]]*(Match|AuthorizedKeysFile|AuthorizedKeysCommand|ForceCommand)[[:space:]]' || true)
    fi
    if [ -f "$KEYFILE" ]; then
      keyfile="$(stat -c '%U:%G:%a' "$KEYFILE")"
      # the agents' line runs the gate bare; the executor's line names its role, and only that
      # one word (fleet-ro-grant alkalmaz is the executor's alone): any other command is unforced
      forced=$(grep -cE '^restrict,from="[^"]*",command="/usr/local/sbin/fleet-gate( vegrehajto)?" ' "$KEYFILE" || true)
      keys=$(grep -cvE '^[[:space:]]*(#|$)' "$KEYFILE" || true)
    else
      keyfile="nincs"
      forced=0
      keys=0
    fi
    echo "match=${match:-0} others=${others:-0} keyopts=${keyopts:-0} ours=${ours:-0} forcecmds=${forcecmds:-0} includes=${includes:-0} dropins=${dropins:-0} keyfile=$keyfile keys=${keys:-0} forced=${forced:-0}"
    [ "${match:-0}" = 1 ] && [ "${others:-0}" = 0 ] && [ "${keyopts:-0}" = 1 ] && [ "${ours:-0}" = 1 ] && [ "${forcecmds:-0}" = 0 ] && [ "${includes:-0}" = 0 ] && [ "${dropins:-0}" = 0 ] \
      && [ "$keyfile" = "$KEYFILE_EXPECT" ] && [ "${keys:-0}" -ge 1 ] && [ "${forced:-0}" = "${keys:-0}" ] || exit 1
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
    # psql-ro <key> <db> [plain|tuples|tuples-pipe|tuples-spaced-pipe], SQL on stdin.
    # The database user is NOT the caller's: it is the read-only role the host
    # table names for this key and database (Balázs, 12:23 UTC: the read-only
    # default alone is not enough; a superuser session could turn it off, and
    # COPY ... TO PROGRAM would be a shell in the container).
    [ "$NARGS" -eq 2 ] || [ "$NARGS" -eq 3 ] || deny "'psql-ro': <kulcs> <adatbázis> [formátum]"
    ROLE=""
    for t in $PSQL_TARGETS; do
      case "$t" in "${W[1]}:${W[2]}:"*) ROLE="${t##*:}" ;; esac
    done
    [ -n "$ROLE" ] || deny "'psql-ro': ez a konténer és adatbázis nincs a listán"
    FLAGS=()
    case "${W[3]:-plain}" in
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
    allow psql-ro "${W[1]}" "${W[2]}" "$ROLE"
    printf '%s\n' "$SQL" | exec "$DOCKER" exec -i -e 'PGOPTIONS=-c default_transaction_read_only=on' "$C" \
      psql -X -q -v ON_ERROR_STOP=1 -U "$ROLE" -d "${W[2]}" "${FLAGS[@]}"
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
    # ask over TCP: the image's initdb runs a temporary server on the socket
    # only, which answers ready and then stops before the real one starts
    ready=""
    for _ in $(seq 1 30); do
      if "$DOCKER" exec "$C" pg_isready -h 127.0.0.1 -U acropora_ai -q; then ready=1; break; fi
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
  quote-templates-sync)
    # quote-templates-sync plan|apply, the templates and snippets as JSON on
    # stdin: the quote templates from the test system to this one, without a
    # root step (Balázs, 2026-10-14: the B8 gate stopped the old way). The
    # program is a root-owned file installed with the gate and goes to node as
    # its -e argument; stdin is data only, so the caller cannot run code in the
    # API container. The program checks the data with the image's own editor
    # rules, adds what is missing, replaces only untouched seed text, and never
    # deletes or touches an edited row (scripts/host/quote-templates-sync.mjs).
    args 1
    case "${W[1]}" in
      plan) apply=0 ;;
      apply) apply=1 ;;
      *) deny "'quote-templates-sync': plan vagy apply" ;;
    esac
    # the program and its directory: regular, not a link, root's, written by
    # no one else; anything else is a way to put code into the container
    for f in "$QUOTE_SYNC_PROG" "$(dirname "$QUOTE_SYNC_PROG")"; do
      [ ! -L "$f" ] && [ -e "$f" ] || deny "'quote-templates-sync': a program nincs telepítve ($f)"
      case "$(stat -c '%U:%G %a' "$f")" in
        "$QUOTE_SYNC_OWNER "[0-7][0145][0145]) ;;
        *) deny "'quote-templates-sync': a program vagy a mappája nem root tulajdonú, vagy más is írhatja ($f)" ;;
      esac
    done
    [ -f "$QUOTE_SYNC_PROG" ] || deny "'quote-templates-sync': a program nem szabályos fájl"
    PROG="$(cat "$QUOTE_SYNC_PROG")"
    # the input goes through a file, byte for byte: a $(...) would drop the closing
    # newlines and any NUL, and the program's sha256 would no longer be the
    # caller's `sha256sum <file>` (barracuda, #97)
    DATA="$(mktemp)" || exit 1
    trap 'rm -f "$DATA"' EXIT
    head -c $((QUOTE_SYNC_MAX_BYTES + 1)) > "$DATA"
    size="$(stat -c %s "$DATA")"
    [ "$size" -gt 0 ] || deny "'quote-templates-sync': üres bemenet (a sablonok JSON-ja a stdin-en)"
    [ "$size" -le "$QUOTE_SYNC_MAX_BYTES" ] || deny "'quote-templates-sync': túl nagy bemenet"
    C="$(resolve "$QUOTE_SYNC_KEY")" || exit 2
    allow quote-templates-sync "${W[1]}"
    # not exec: the trap must still remove the file after docker returns
    "$DOCKER" exec -i -w /app -e "APPLY=$apply" "$C" node --input-type=module -e "$PROG" < "$DATA"
    exit $?
    ;;
  app-log)
    # app-log <key> [lines]: the last lines of one production app's log, with
    # timestamps, stdout and stderr together (Balázs, 2026-10-14 06:53 UTC: the
    # Coolify API's log endpoint needs read:sensitive, which also hands out the
    # environment's VALUES, so the fleet does not get it). No follow, no free
    # --since: a fixed number of lines, 500 by default, at most 5000.
    [ "$NARGS" -eq 1 ] || [ "$NARGS" -eq 2 ] || deny "'app-log': <kulcs> [sorok]"
    in_targets "${W[1]}" "$APP_LOG_KEYS" || deny "'app-log': ez az alkalmazás nincs a listán"
    lines="${W[2]:-500}"
    case "$lines" in
      [1-9]|[1-9][0-9]|[1-9][0-9][0-9]|[1-9][0-9][0-9][0-9]) ;;
      *) deny "'app-log': a sorok száma 1 és 5000 közötti egész" ;;
    esac
    [ "$lines" -le 5000 ] || deny "'app-log': a sorok száma 1 és 5000 közötti egész"
    C="$(resolve "${W[1]}")" || exit 2
    # which container: during a deployment the old and the new one both run, and
    # the question is often which of them speaks (barracuda, #99). On stderr, so
    # the log itself stays the container's alone.
    allow app-log "${W[1]}" "$lines" "$C"
    echo "fleet-gate: app-log konténer: $C" >&2
    exec "$DOCKER" logs --timestamps --tail "$lines" "$C" 2>&1
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
  backup-get|backup-sum|backup-put)
    # backup-get dump <db> <date> | backup-get docstore <date>: the file to stdout
    # backup-sum (same arguments): "<sha256> <bytes>" of that file
    # backup-put dump <db> <date> <sha256> | backup-put docstore <date> <sha256>:
    #   stdin to tavoli/..., the other host's copy, kept only if its sha256 is
    #   the source's: a get that died halfway must not become the day's copy
    #   (barracuda, #28)
    extra=0; [ "$OP" = backup-put ] && extra=1
    case "$((NARGS - extra)):${W[1]:-}" in
      3:dump) what="dump:${W[2]}"; date="${W[3]}"; rel="${W[2]}/${W[3]}.dump" ;;
      2:docstore) what="docstore"; date="${W[2]}"; rel="dokumentumok/${W[2]}.tar.gz" ;;
      *) deny "'$OP': dump <adatbázis> <dátum> vagy docstore <dátum>$([ "$extra" = 1 ] && echo ' <sha256>')" ;;
    esac
    case "$date" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) deny "'$OP': a dátum ÉÉÉÉ-HH-NN alakú" ;; esac
    if [ "$OP" != backup-put ]; then
      in_targets "$what" "$BACKUP_GET" || deny "'$OP': ez a mentés ezen a gépen nem olvasható"
      [ -f "$BACKUP_ROOT/$rel" ] || deny "'$OP': nincs ilyen mentés"
      allow "$OP" "$what" "$date"
      [ "$OP" = backup-get ] && exec cat "$BACKUP_ROOT/$rel"
      echo "$(sha256sum < "$BACKUP_ROOT/$rel" | cut -d' ' -f1) $(stat -c %s "$BACKUP_ROOT/$rel")"
      exit 0
    fi
    want="${W[$NARGS]}"
    case "$want" in *[!0-9a-f]*|"") deny "'backup-put': a várt sha256 64 kisbetűs hexa jel" ;; esac
    [ "${#want}" -eq 64 ] || deny "'backup-put': a várt sha256 64 kisbetűs hexa jel"
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
    head -c "$BACKUP_MAX_BYTES" > "$part" || { rm -f "$part"; echo "fleet-gate: a távoli mentés nem íródott ki" >&2; exit 1; }
    got="$(sha256sum < "$part" | cut -d' ' -f1)"
    [ "$got" = "$want" ] || { rm -f "$part"; echo "fleet-gate: a kapott másolat sha256-ja nem a forrásé (csonka vagy sérült), eldobva" >&2; exit 1; }
    mv -n "$part" "$file" && [ ! -e "$part" ] || { rm -f "$part"; echo "fleet-gate: a távoli mentés nem íródott ki" >&2; exit 1; }
    echo "$what $(stat -c %s "$file")"
    ;;
  backup-prune)
    # the retention: dumps 14 days, the document store 7, here and in tavoli/
    args 0; allow backup-prune
    [ -d "$BACKUP_ROOT" ] || exit 0
    find "$BACKUP_ROOT" -name '*.dump' -mtime +14 -print -delete
    find "$BACKUP_ROOT" -path '*/dokumentumok/*' -name '*.tar.gz' -mtime +7 -print -delete
    ;;
  fleet-ro-grant)
    # fleet-ro-grant <key> <database> <commit> terv|alkalmaz   (the list from GitHub at the commit)
    # fleet-ro-grant <key> <database> szukit                   (the last applied list, its expired lines)
    # docs/fleet-gate.md, "fleet_ro jogok gombbal". No SQL and no list from the caller.
    [ "$NARGS" -ge 3 ] || deny "'fleet-ro-grant': kulcs, adatbázis és mód kell"
    in_targets "${W[1]}:${W[2]}" "$GRANT_TARGETS" || deny "'fleet-ro-grant': ez a konténer és adatbázis nincs a listán"
    STATE="$GRANT_STATE_DIR/alkalmazott-${W[1]}-${W[2]}.txt"
    TODAY="$(grant_today)"
    if [ "${W[3]}" = szukit ]; then
      args 3
      # (acrobot, barracuda) only lines of the LAST APPLIED list, only the expired ones: a
      # missing or empty list never takes everything; what was dropped from the list is
      # revoked by alkalmaz, with an approval. The file is written by this gate alone (the
      # keys have no shell), in the fleet user's home: the gate does not run as root.
      if [ ! -f "$STATE" ]; then allow fleet-ro-grant "${W[1]}" "${W[2]}" szukit nincs-alkalmazott-lista; echo "fleet-ro-grant szukit: nincs alkalmazott lista, nincs mit visszavenni"; exit 0; fi
      GONE="$(grep -v '^#' "$STATE" | while read -r t c exp; do
        [[ "$t" =~ $GRANT_ID_RX && "$c" =~ $GRANT_ID_RX ]] || continue
        [ "$exp" != tartos ] && [[ "$exp" < "$TODAY" ]] && printf '%s %s\n' "$t" "$c"
      done)"
      N="$(printf '%s' "$GONE" | grep -c . || true)"
      [ "$N" -le "$GRANT_SZUKIT_MAX" ] || deny "'fleet-ro-grant szukit': $N lejárt oszlop egy futásra (a határ $GRANT_SZUKIT_MAX): emberi döntés kell"
      if [ "$N" -eq 0 ]; then allow fleet-ro-grant "${W[1]}" "${W[2]}" szukit 0; echo "fleet-ro-grant szukit: nincs lejárt sor ($TODAY)"; exit 0; fi
      C="$(resolve "${W[1]}")" || exit 2
      allow fleet-ro-grant "${W[1]}" "${W[2]}" szukit "$N"
      printf '%s\n' "$GONE" | grant_sql szukit | grant_psql "$C" "${W[2]}"
      exit $?
    fi
    args 4
    [[ "${W[3]}" =~ ^[0-9a-f]{40}$ ]] || deny "'fleet-ro-grant': a commit 40 hexa jegy"
    case "${W[4]}" in
      terv) ;;
      alkalmaz) [ "$KEY_ROLE" = vegrehajto ] || deny "'fleet-ro-grant alkalmaz': csak a végrehajtó kulcsával (Balázs jóváhagyása után)" ;;
      *) deny "'fleet-ro-grant': a mód terv, alkalmaz vagy szukit" ;;
    esac
    LIST="$(grant_fetch "${W[3]}")" || exit 2
    PARSED="$(printf '%s\n' "$LIST" | grant_parse)" || exit 2
    WANT="$(printf '%s\n' "$PARSED" | while read -r t c exp; do
      [ -n "$t" ] || continue
      { [ "$exp" = tartos ] || ! [[ "$exp" < "$TODAY" ]]; } && printf '%s %s\n' "$t" "$c"
    done)"
    LIST_SHA="$(printf '%s\n' "$LIST" | sha256sum | cut -d' ' -f1)"
    C="$(resolve "${W[1]}")" || exit 2
    allow fleet-ro-grant "${W[1]}" "${W[2]}" "${W[3]}" "${W[4]}" "list-sha256=$LIST_SHA" "key=$KEY_ROLE"
    echo "fleet-ro-grant ${W[4]}: commit ${W[3]}, lista sha256 $LIST_SHA, ma $TODAY (Europe/Budapest)"
    printf '%s\n' "$WANT" | grant_sql "${W[4]}" | grant_psql "$C" "${W[2]}"
    RC=$?
    if [ "$RC" -eq 0 ] && [ "${W[4]}" = alkalmaz ]; then
      mkdir -p -m 700 "$GRANT_STATE_DIR" && { printf '# commit %s, %s\n' "${W[3]}" "$TODAY"; printf '%s\n' "$PARSED"; } > "$STATE.tmp" \
        && mv -f "$STATE.tmp" "$STATE" || { echo "fleet-gate: az alkalmazott lista nem íródott ki (a szukit a régit látja)" >&2; exit 1; }
    fi
    exit "$RC"
    ;;
  *)
    deny "ismeretlen művelet"
    ;;
esac
