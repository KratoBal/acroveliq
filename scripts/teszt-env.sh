#!/usr/bin/env bash
# ANSWERS: Hogyan allit be a flotta egy NEM TITKOS env-kulcsot a teszt gep Coolify-jaban, ellenorizhetoen?
#
# teszt-env.sh <alkalmazas-uuid> <KULCS> <ertek> [--vegrehajt]
#
# WHY (card 8f35a038, second slice; acrobot 46571, 2026-11-11): the fleet reaches the test machine's Coolify on the
# tailnet with its rw token (#353), but setting a test env value still meant asking someone by hand.
#
# ONLY THE TEST MACHINE: the address is fixed here (http://100.88.199.87:8000), not taken from the environment.
# DRY BY DEFAULT: it prints the application's name, the key's present state (absent, or present with its value) and
# what it would write; nothing goes out. --vegrehajt writes: PATCH for an existing key, POST for a new one, on
# /api/v1/applications/<uuid>/envs, then reads back and prints the new state.
# MEASURED BY ACROBOT (2026-11-11 08:3x, the test Medusa's envs, rw token): the answer carries NO value field, only
# the key and its meta, so the state is "present" or "absent", and a written value cannot be read back; and every key
# stands twice, is_preview false and true. The write goes to the non-preview row only, and the output says so.
# REFUSED (exit 2, nothing sent): a key not ^[A-Z][A-Z0-9_]*$, a secret-shaped key name (see TITOK below; a secret
# is not the fleet's to set and not to print), a multi-line value. It starts NO deploy: the value takes effect on the
# next deploy of the application, and the output says so.
set -uo pipefail

COOLIFY="http://100.88.199.87:8000"
TOKEN_FILE="/home/marveen/marveen/store/.coolify-token-ai-rw"

exec python3 - "$COOLIFY" "$TOKEN_FILE" "$@" <<'PY'
import json, re, sys, urllib.error, urllib.request

coolify, token_file, *args = sys.argv[1:]
USAGE = "hasznalat: teszt-env.sh <alkalmazas-uuid> <KULCS> <ertek> [--vegrehajt]"
vegrehajt = "--vegrehajt" in args
args = [a for a in args if a != "--vegrehajt"]
if len(args) != 3:
    print(USAGE, file=sys.stderr); sys.exit(2)
uuid, key, value = args

# a secret-shaped name: a part of the key (split on _) or a known secret-carrying name
TITOK = re.compile(r"(^|_)(SECRET|TOKEN|KEY|PASSWORD|PASS|PASSWD|PRIVATE|CREDENTIALS?|AUTH|DSN|APIKEY)(_|$)|^(GMAIL_|SMTP_)|^(DATABASE_URL|REDIS_URL)$")
if not re.fullmatch(r"[a-z0-9]{8,64}", uuid):
    print(f"MEGTAGADVA: az alkalmazas-uuid alakja nem ismert: {uuid!r}", file=sys.stderr); sys.exit(2)
if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
    print(f"MEGTAGADVA: a kulcs nem NAGYBETUS_ALAK: {key!r}", file=sys.stderr); sys.exit(2)
if TITOK.search(key):
    print(f"MEGTAGADVA: a(z) {key} titok-alaku kulcsnev; titkot a flotta nem allit es nem ir ki.", file=sys.stderr); sys.exit(2)
if "\n" in value or "\r" in value:
    print("MEGTAGADVA: az ertek tobbsoros.", file=sys.stderr); sys.exit(2)

try:
    with open(token_file, encoding="utf-8") as f:
        token = f.read().strip()
except OSError as e:
    print(f"MEGALLOK: a token nem olvashato ({token_file}): {e.strerror}", file=sys.stderr); sys.exit(4)

def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(coolify + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                                          **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, (e.read() or b"")[:300].decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(f"MEGALLOK: a teszt Coolify nem valaszol ({coolify}): {e}", file=sys.stderr); sys.exit(3)

def state():
    code, envs = call("GET", f"/api/v1/applications/{uuid}/envs")
    if code != 200 or not isinstance(envs, list):
        print(f"MEGALLOK: az env-lista nem olvashato (HTTP {code}): {str(envs)[:200]}", file=sys.stderr); sys.exit(1)
    rows = [e for e in envs if isinstance(e, dict) and e.get("key") == key and not e.get("is_preview")]
    return rows[0] if rows else None

def show(row):
    if row is None:
        return "nincs"
    v = row.get("value")
    return f"van, ertek: {v!r}" if v is not None else "van (az erteket a Coolify nem adja)"

code, app = call("GET", f"/api/v1/applications/{uuid}")
if code != 200 or not isinstance(app, dict):
    print(f"MEGALLOK: az alkalmazas nem olvashato (HTTP {code}): {str(app)[:200]}", file=sys.stderr); sys.exit(1)
before = state()
print(f"alkalmazas  {app.get('name') or '?'} ({uuid}), {coolify}")
print(f"{key}  most: {show(before)}")
print(f"{key}  uj:   {value!r} ({'atiras' if before else 'uj kulcs'}; a nem-preview sor, a preview sor nem valtozik)")
if not vegrehajt:
    print("SZARAZ FUTAS: semmi nem ment ki. Iraskor: --vegrehajt")
    sys.exit(0)

body = {"key": key, "value": value, "is_preview": False}
code, answer = call("PATCH" if before else "POST", f"/api/v1/applications/{uuid}/envs", body)
if code not in (200, 201):
    print(f"NEM IRTA AT (HTTP {code}): {str(answer)[:200]}", file=sys.stderr); sys.exit(1)
after = state()
print(f"{key}  utana: {show(after)}")
if after is None:
    print("ELTERES: a kulcs iras utan sincs a nem-preview sorok kozott.", file=sys.stderr); sys.exit(1)
if after.get("value") is None:
    print("  Az erteket a Coolify nem adja vissza, tehat a tartalma innen nem ellenorizheto, csak a kulcs megleted.")
elif after.get("value") != value:
    print("ELTERES: a visszaolvasott ertek nem az, amit irtunk.", file=sys.stderr); sys.exit(1)
print("A valtozas a kovetkezo telepiteskor el: telepitest ez a parancs nem indit.")
PY
