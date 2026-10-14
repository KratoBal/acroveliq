#!/bin/bash
# The ChatGPT login of the GPT runner, with a device code (Balázs approved it 2026-10-14 18:31 UTC).
# ON THE HOST, AS ROOT, INTERACTIVELY: Balázs sees the code and approves it in his browser.
# The container runs as 10002 with its own volume; the credential goes ONLY into
# gpt-futtato-codex-home (/home/gpt/.codex/auth.json). Its value is never printed here: only
# its place, mode, owner, size, and the NAMES of the files in the volume (acrobot, 30834).
set -euo pipefail
trap 'echo "STOP: a belepes a(z) $LINENO. sorban megallt ennel a parancsnal: $BASH_COMMAND" >&2' ERR
DIR="${GPT_FUTTATO_DIR:-/opt/gpt-futtato}"
cd "$DIR"

cat <<'MSG'
== ChatGPT-belepes eszkozkoddal
Elotte: a ChatGPT-fiok biztonsagi beallitasaiban az eszkozkodos belepesnek (device code)
engedelyezve kell lennie. Ha nincs, a Codex 0.159.3 ezzel az uzenettel all meg:
  "Device code login is not enabled" vagy "Error logging in with device code: ..."
A kodot es a linket csak te latod. A hitelesito adat csak a gpt-futtato-codex-home kotetbe kerul.
MSG

# the device-code flow needs no input: the output goes to the screen and into a log, so the
# error can be named afterwards. The log holds the one-time code: root-only, removed at the end
LOG=$(mktemp "$DIR/belepes.XXXXXX")
chmod 600 "$LOG"
cleanup() { rm -f "$LOG"; }
trap cleanup EXIT
rc=0
{ docker compose run --rm --entrypoint codex gpt-futtato login --device-auth 2>&1 | tee "$LOG"; } || rc=$?
if [ "$rc" != 0 ]; then
  # three causes, three different next steps (2026-10-14 20:13 UTC: a network/TLS error was
  # reported as the account setting, because the generic "Error logging in" matched first)
  if grep -q "Device code login is not enabled" "$LOG" 2>/dev/null; then
    echo "STOP: az eszkozkodos belepes nincs engedelyezve a ChatGPT-fiokban."
    echo "      Engedelyezd a fiok biztonsagi beallitasaiban, es futtasd ujra ezt a lepest."
  elif grep -qiE "error sending request|certificate|tls|dns error|connection (refused|reset)|timed out" "$LOG" 2>/dev/null; then
    echo "STOP: halozati vagy tanusitvany-hiba a konteneren belul; a ChatGPT-fiokban NINCS teendo."
    echo "      A proba TLS sora mutatja, melyik host nem ert el a rendszer-CA-val."
  else
    echo "STOP: a belepes nem sikerult (kilepes $rc); a hiba fent lathato."
  fi
  exit 1
fi

echo "== a hitelesito fajl (ertek nelkul) es a kotet fajljainak neve"
docker compose run --rm --entrypoint sh gpt-futtato -c 'stat -c "%a %u:%g %s bajt %n" /home/gpt/.codex/auth.json; echo "--- a kotet fajljai:"; find /home/gpt -type f | sort'
perm=$(docker compose run --rm --entrypoint sh gpt-futtato -c 'stat -c "%a %u" /home/gpt/.codex/auth.json' | tr -d '\r')
if [ "$perm" != "600 10002" ]; then
  echo "STOP: az auth.json joga vagy tulajdonosa nem 600 es 10002, hanem: $perm"
  exit 1
fi
echo "rendben: /home/gpt/.codex/auth.json, 600, uid 10002. Az erteket ez a lepes nem irja ki."
echo "A kovetkezo lepes: $DIR/src/gpt-runner/host/utana-meres.sh"
