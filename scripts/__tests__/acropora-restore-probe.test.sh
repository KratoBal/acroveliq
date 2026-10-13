#!/usr/bin/env bash
# scripts/host/acropora-restore-probe.sh (B8, the OS/Commerce/docstore restore probe) and the
# fleet's reader of its result, scripts/visszaallitasi-proba-eredmeny.py. Real bash, real rsync
# and sha256sum; docker is a stub that logs every call, the NAS is a local directory behind an
# rsync stub that rewrites the rsync:// address. WHAT TURNS THIS RED:
#   - a good world does not PASS, or its result does not reach the NAS (0644), or the fleet's
#     reader does not accept it;
#   - anything but a read-only psql reaches a LIVE container (a restore, a run, a write);
#   - a probe container or the work directory survives the run, a failed one included, or a
#     leftover from an earlier run is not swept;
#   - a failed restore, a stale dump, an empty or partial restore, a missing table, a damaged or
#     missing document, a missing volume marker, a stopped live container still PASSes;
#   - a document newer than the grace (not yet mirrored) fails the run;
#   - a PASS whose result did not reach the NAS exits 0;
#   - a second run does not stop at the lock, or a bad PROBE_WORK is accepted;
#   - the reader accepts a stale result, a PASS contradicted by its numbers, or broken JSON.
set -uo pipefail
cd "$(dirname "$0")/../.."
PROBE="$PWD/scripts/host/acropora-restore-probe.sh"
READER="$PWD/scripts/visszaallitasi-proba-eredmeny.py"
REAL_RSYNC=$(command -v rsync) || { echo "rsync kell a teszthez"; exit 1; }
ROOT=$(mktemp -d)
trap 'chmod -R u+w "$ROOT" 2>/dev/null; rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "not ok - $1"; }
check() { if eval "$2"; then ok; else bad "$1"; fi; }

OS_LIVE=iwm34jaqp9xmwb72qkrqkwhy-163020
COM_LIVE=xdfswedgxuehokvymhjotpfs

# world <dir>: a fresh NAS, live side, stubs and environment; sets W
world() {
  W=$(mktemp -d "$ROOT/w-XXXX")
  local nas="$W/nas/Acropora_Backup"
  mkdir -p "$nas/acropora-os-postgres" "$nas/acropora-commerce-postgres" "$nas/acropora-os-document-store" \
    "$W/bin" "$W/containers" "$W/counts" "$W/state" "$W/tmp" "$W/vol/_data/a"
  printf 'OSDUMP' > "$nas/acropora-os-postgres/acropora-2026-10-01_03-02-00.dump"
  touch -d '9 days ago' "$nas/acropora-os-postgres/acropora-2026-10-01_03-02-00.dump"
  printf 'OSDUMP-NEW' > "$nas/acropora-os-postgres/acropora-2026-10-13_03-02-47.dump"
  touch -d '2 hours ago' "$nas/acropora-os-postgres/acropora-2026-10-13_03-02-47.dump"
  printf 'MEDUSA' > "$nas/acropora-commerce-postgres/medusa-2026-10-13_04-07-48.dump"
  touch -d '1 hour ago' "$nas/acropora-commerce-postgres/medusa-2026-10-13_04-07-48.dump"
  # the live document store: two old files, one new (not mirrored yet), the marker
  local v="$W/vol/_data"
  : > "$v/.acropora-document-store"; printf 'egy' > "$v/a/1.pdf"; printf 'ketto' > "$v/2.pdf"
  touch -d '3 days ago' "$v/.acropora-document-store" "$v/a/1.pdf" "$v/2.pdf"
  "$REAL_RSYNC" -rt "$v/" "$nas/acropora-os-document-store/"
  printf 'uj' > "$v/3.pdf"
  printf 'public.User|5000\npublic.Asset|20\n_prisma.m|3\n' > "$W/counts/live-os"
  printf 'public.User|4990\npublic.Asset|20\n_prisma.m|3\n' > "$W/counts/restored-os"
  printf 'public.region|1\npublic.product|0\n' > "$W/counts/live-commerce"
  printf 'public.region|1\npublic.product|0\n' > "$W/counts/restored-commerce"
  printf '%s\n' "$OS_LIVE" "$COM_LIVE" coolify-db > "$W/live"
  echo secret > "$W/secret"

  cat > "$W/bin/rsync" <<EOF
#!/bin/bash
echo "rsync \$*" >> "$W/calls.log"
case "\$*" in *--list-only*acropora-restore-probe/result-*) [ -n "\${FAKE_UPLOAD_LIST_EMPTY:-}" ] && exit 0 ;; esac
args=()
for a in "\$@"; do
  case "\$a" in --password-file=*) ;; rsync://acropora-backup@csupor/Acropora_Backup*) args+=("$nas\${a#rsync://acropora-backup@csupor/Acropora_Backup}") ;; *) args+=("\$a") ;; esac
done
exec "$REAL_RSYNC" "\${args[@]}"
EOF
  cat > "$W/bin/docker" <<EOF
#!/bin/bash
echo "docker \$*" >> "$W/calls.log"
case "\$1" in
  ps) if [ "\${2:-}" = -a ]; then ls -1 "$W/containers"; cat "$W/live"; else cat "$W/live"; fi ;;
  info) echo "$W/tmp" ;;
  inspect) echo postgres:16-alpine ;;
  run) shift; name=""; while [ \$# -gt 0 ]; do [ "\$1" = --name ] && name="\$2"; shift; done
       [ -n "\${FAKE_RUN_FAIL:-}" ] && exit 1
       # like docker: a name still taken (a leftover of a killed run) refuses the run
       [ -e "$W/containers/\$name" ] && { echo "Conflict. The container name is already in use" >&2; exit 125; }
       touch "$W/containers/\$name"; echo id ;;
  rm) for a in "\$@"; do rm -f "$W/containers/\$a"; done ;;
  exec)
    shift; [ "\$1" = -i ] && shift
    [ "\$1" = -e ] && shift 2
    c="\$1"; shift
    case "\$c" in
      acropora-restore-probe-*)
        kind="\${c#acropora-restore-probe-}"
        case "\$1" in
          pg_isready) exit 0 ;;
          pg_restore) cat > "$W/restore-input-\$kind"
            if [ "\${FAKE_RESTORE_FAIL:-}" = "\$kind" ]; then echo "pg_restore: error: could not execute query: ERROR: x" >&2; exit 1; fi ;;
          psql) cat > /dev/null; cat "$W/counts/restored-\$kind" ;;
        esac ;;
      "$OS_LIVE") cat > /dev/null; cat "$W/counts/live-os" ;;
      "$COM_LIVE") cat > /dev/null; cat "$W/counts/live-commerce" ;;
      *) exit 1 ;;
    esac ;;
esac
EOF
  chmod +x "$W/bin/rsync" "$W/bin/docker"
}

run_probe() {  # extra env as NAME=value before the kinds, e.g. run_probe FAKE_RESTORE_FAIL=os os
  local envs=()
  while [ $# -gt 0 ] && [[ "$1" == *=* ]]; do envs+=("$1"); shift; done
  env PROBE_DOCKER="$W/bin/docker" PROBE_RSYNC="$W/bin/rsync" PROBE_PASSWORD_FILE="$W/secret" \
    PROBE_WORK="$W/tmp/acropora-restore-probe" PROBE_STATE="$W/state" \
    PROBE_DOCSTORE_SOURCE="$W/vol/_data" "${envs[@]}" bash "$PROBE" "$@" > "$W/out.txt" 2>&1
  RC=$?
  RESULT=$(ls -1 "$W"/state/result-*.json 2>/dev/null | tail -1)
}
jget() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1]));
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$RESULT" "$1"; }

# ---- 1. a good world --------------------------------------------------------------------
world
touch "$W/containers/acropora-restore-probe-os"   # a leftover of a killed run
run_probe
check "jo vilag: exit 0 ($RC)" '[ "$RC" -eq 0 ]'
check "jo vilag: PASS" '[ "$(jget status)" = PASS ]'
for k in os commerce docstore; do check "jo vilag: $k PASS" '[ "$(jget kinds.$k.status)" = PASS ]'; done
check "os: a LEGUJABB dump toltodott vissza" '[ "$(cat "$W/restore-input-os")" = OSDUMP-NEW ]'
check "os szamok" '[ "$(jget kinds.os.tables_restored)" = 3 ] && [ "$(jget kinds.os.rows_live)" = 5023 ]'
check "docstore: a friss (meg nem tukrozott) fajl nem buktat, a ket regi ellenorizve" '[ "$(jget kinds.docstore.checked)" = 3 ] && [ "$(jget kinds.docstore.missing_or_differing)" = 0 ]'
UP="$W/nas/Acropora_Backup/acropora-restore-probe/$(basename "$RESULT")"
check "az eredmeny a NAS-on, azonos tartalommal" 'cmp -s "$RESULT" "$UP"'
check "az eredmeny 0644 a NAS-on" '[ "$(stat -c %a "$UP")" = 644 ]'
check "a mappa 0755 a NAS-on" '[ "$(stat -c %a "$(dirname "$UP")")" = 755 ]'
check "nem maradt proba-kontener (a korabbi maradek is eltunt)" '[ -z "$(ls -A "$W/containers")" ]'
check "nem maradt munkakonyvtar" '[ ! -e "$W/tmp/acropora-restore-probe" ]'
check "elo kontenerre CSAK csak-olvaso psql ment" '! grep -E "docker exec .*($OS_LIVE|$COM_LIVE)" "$W/calls.log" | grep -v -q "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=600000 -c lock_timeout=10000 [^ ]* psql "'
check "elo kontenerre volt psql (a szamlalas futott)" 'grep -q "docker exec -i -e PGOPTIONS=.* $OS_LIVE psql" "$W/calls.log"'
check "proba-kontener halozat nelkul, kep letoltese nelkul" 'grep "docker run" "$W/calls.log" | grep -q -- "--network none .*--pull never"'
check "nincs adat az eredmenyben (a dump tartalma nem szerepel)" '! grep -q OSDUMP "$RESULT"'
for k in os commerce docstore; do
  check "olvaso: $k elfogadva" 'python3 "$READER" "$UP" '"$k"' > /dev/null'
done

# ---- 2. failed restore ----------------------------------------------------------------
world; run_probe FAKE_RESTORE_FAIL=os os commerce
check "bukott restore: exit 1" '[ "$RC" -eq 1 ]'
check "bukott restore: os FAIL, commerce PASS" '[ "$(jget kinds.os.status)" = FAIL ] && [ "$(jget kinds.commerce.status)" = PASS ]'
check "bukott restore: a hibaszoveg NEM kerul az eredmenybe" '! grep -q "could not execute" "$RESULT"'
check "bukott restore: a kontener torolve" '[ -z "$(ls -A "$W/containers")" ]'
check "olvaso: bukott os elutasitva" '! python3 "$READER" "$RESULT" os > /dev/null'

# ---- 3. stale dump ------------------------------------------------------------------
world; touch -d '3 days ago' "$W/nas/Acropora_Backup/acropora-commerce-postgres/"*.dump
run_probe commerce
check "regi dump: FAIL" '[ "$RC" -eq 1 ] && jget kinds.commerce.reason | grep -q "oras"'
check "regi dump: vissza sem toltotte" '[ ! -e "$W/restore-input-commerce" ]'

# ---- 4. empty restore, and a missing table --------------------------------------------
world; printf 'public.User|0\npublic.Asset|0\n_prisma.m|0\n' > "$W/counts/restored-os"; run_probe os
check "ures restore: FAIL, a nagy tabla megnevezve" '[ "$RC" -eq 1 ] && [ "$(jget kinds.os.big_tables_empty)" = public.User ]'
world; : > "$W/counts/restored-os"; run_probe os
check "nulla tablas restore (ures szamlalas): FAIL, nem az elo sorait szamolja" '[ "$RC" -eq 1 ] && [ "$(jget kinds.os.tables_restored)" = 0 ] && [ "$(jget kinds.os.tables_missing)" = 3 ]'
world; printf 'public.User|4990\n_prisma.m|3\n' > "$W/counts/restored-os"; run_probe os
check "hianyzo tabla: FAIL" '[ "$RC" -eq 1 ] && [ "$(jget kinds.os.tables_missing)" = 1 ]'
world; printf 'public.User|1000\npublic.Asset|20\n_prisma.m|3\n' > "$W/counts/restored-os"; run_probe os
check "a sorok fele alatt: FAIL" '[ "$RC" -eq 1 ] && jget kinds.os.reason | grep -q "hatar 50"'
check "ures commerce (0 sor a termektablaban) PASS-t ad, ha a sema egyezik" 'world; run_probe commerce; [ "$RC" -eq 0 ]'

# ---- 5. document store ----------------------------------------------------------------
world; printf 'mas' > "$W/nas/Acropora_Backup/acropora-os-document-store/2.pdf"; run_probe docstore
check "serult dokumentum: FAIL" '[ "$RC" -eq 1 ] && [ "$(jget kinds.docstore.missing_or_differing)" = 1 ]'
world; rm "$W/nas/Acropora_Backup/acropora-os-document-store/a/1.pdf"; run_probe docstore
check "hianyzo regi dokumentum: FAIL" '[ "$RC" -eq 1 ] && [ "$(jget kinds.docstore.missing_or_differing)" = 1 ]'
check "a dokumentum neve nem kerul az eredmenybe" '! grep -q "1.pdf" "$RESULT"'
world; rm "$W/vol/_data/.acropora-document-store"; run_probe docstore
check "nincs jelolo: FAIL" '[ "$RC" -eq 1 ] && jget kinds.docstore.reason | grep -q jelolo'

# ---- 6. live container down, upload failing, lock, bad work dir ------------------------
world; grep -v "$OS_LIVE" "$W/live" > "$W/live.n"; mv "$W/live.n" "$W/live"; run_probe os
check "nem fut az elo: FAIL, proba-kontener sem indult" '[ "$RC" -eq 1 ] && ! grep -q "docker run" "$W/calls.log"'
world; chmod 555 "$W/nas/Acropora_Backup"; run_probe commerce; chmod 755 "$W/nas/Acropora_Backup"
check "PASS, de az eredmeny nem jutott fel: exit 1" '[ "$RC" -eq 1 ] && grep -q "feltoltese elhasalt" "$W/out.txt"'
world; run_probe FAKE_UPLOAD_LIST_EMPTY=1 commerce
check "a feltoltott eredmeny nem latszik a NAS-on: exit 1" '[ "$RC" -eq 1 ] && grep -q "merete elter" "$W/out.txt"'
world; exec 8>"$W/state/lock"; flock -n 8; run_probe os; exec 8>&-
check "fogott zar: exit 75" '[ "$RC" -eq 75 ]'
world; run_probe PROBE_WORK=/ os
check "rossz PROBE_WORK: exit 2" '[ "$RC" -eq 2 ]'

world; mkdir -m 700 "$W/nas/Acropora_Backup/acropora-restore-probe"; touch "$W/nas/Acropora_Backup/acropora-restore-probe/result-2026-10-04_04-40-00.json"; run_probe commerce
check "meglevo 0700 mappa 0755 lesz, a regi eredmeny megmarad" '[ "$(stat -c %a "$W/nas/Acropora_Backup/acropora-restore-probe")" = 755 ] && [ -e "$W/nas/Acropora_Backup/acropora-restore-probe/result-2026-10-04_04-40-00.json" ]'

# ---- 7. the reader alone --------------------------------------------------------------
R="$ROOT/r.json"
mk() { python3 - "$R" "$1" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
f = (datetime.now(timezone.utc) - timedelta(hours=int(sys.argv[2]))).strftime("%Y-%m-%dT%H:%M:%SZ")
os_ = {"status": "PASS", "file": "a.dump", "age_h": 2, "restore_rc": 0, "tables_restored": 3, "tables_live": 3,
       "tables_missing": 0, "rows_restored": 10, "rows_live": 10}
json.dump({"probe": "acropora-restore-probe", "version": 1, "host": "h", "finished": f, "status": "PASS",
           "kinds": {"os": os_}}, open(sys.argv[1], "w"))
PY
}
mk 10; check "olvaso: friss PASS elfogadva" 'python3 "$READER" "$R" os > /dev/null'
mk 240; check "olvaso: 10 napos eredmeny elutasitva" '! python3 "$READER" "$R" os > /dev/null'
check "olvaso: a hatar parameterezheto" 'python3 "$READER" "$R" os 300 > /dev/null'
mk 1; python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["kinds"]["os"]["tables_restored"]=0; json.dump(d,open(sys.argv[1],"w"))' "$R"
check "olvaso: PASS nulla tablaval elutasitva" '! python3 "$READER" "$R" os > /dev/null'
mk 1; python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["kinds"]["os"]["tables_missing"]=1; json.dump(d,open(sys.argv[1],"w"))' "$R"
check "olvaso: PASS hianyzo tablaval elutasitva" '! python3 "$READER" "$R" os > /dev/null'
check "olvaso: hianyzo szakasz elutasitva" 'mk 1; ! python3 "$READER" "$R" docstore > /dev/null'
printf '{"probe": "acropora-restore-probe", "version": 1, "fin' > "$R"
check "olvaso: csonka JSON elutasitva" '! python3 "$READER" "$R" os > /dev/null'
printf '[1]' > "$R"
check "olvaso: nem objektum elutasitva" '! python3 "$READER" "$R" os > /dev/null'

echo "# pass $PASS"
echo "# fail $FAIL"
[ "$FAIL" -eq 0 ]
