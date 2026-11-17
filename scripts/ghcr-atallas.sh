#!/usr/bin/env bash
# ANSWERS: Hogyan all at EGY stage app a Dockerfile-epitesrol a GHCR-bol huzott kepre, hogyan all vissza a rogzitett allapotra,
# es honnan tudjuk, hogy az a kep fut, amit kuldtunk?
#
# ghcr-atallas.sh terv   <app-uuid>                      csak olvas: elteres a rogzitett allapottol + az elore es a vissza lepesek
# ghcr-atallas.sh elore  <app-uuid> <sha40> [--vegrehajt] a Docker Image tipusra allitas, telepites, mérés
# ghcr-atallas.sh vissza <app-uuid> [--vegrehajt]        a rogzitett allapot visszaallitasa, telepites, mérés
# ghcr-atallas.sh meres  <app-uuid>                      csak a /health (api) vagy a HTTP-kod (web, partner) mérése
#
# WHY (acrobot 54755, task t-20261117-ghcr-kepek, card 0529e916): the OS images are built on GitHub (acropora-os #2661) and
# Coolify only pulls them. The switch must be ONE reversible step per app, started by acrobot, stage api first.
#
# STAGE ONLY: the address is the AI machine's Coolify on the tailnet, fixed here. An app is refused unless the recorded file
# lists it under "stage" AND it has a GHCR image (api, web, partner); the game and the reefclub apps have none, and the
# production apps are another machine's.
# DRY BY DEFAULT: elore and vissza print the whole plan and send NOTHING without --vegrehajt. terv is read only always.
# THE READ TOKEN READS, THE RW TOKEN ONLY WRITES (barracuda, #354): the rw token is loaded only on the --vegrehajt branch.
#
# THE RECORDED STATE is the file exchange/ghcr/coolify-beallitas-elotte-2026-11-17.json (acrobot, 2026-11-17): every field of every
# stage app except the env VALUES (Coolify does not give them). Before any write the live app must equal it field by field
# (a drifted app is refused: the restore would restore a state that was never the one in front of us), and after every write
# the app is read back and compared again: ANY field the switch was not meant to touch that differs STOPS the script and says which.
#
# WHAT THE SWITCH WRITES (in this order; each step is read back before the next):
#   1. PATCH /applications/<uuid>: build_pack dockerimage, docker_registry_image_name ghcr.io/kratobal/<image>,
#      docker_registry_image_tag sha-<40 hex>. NEVER latest, never another registry or owner.
#   2. api only: delete the non-preview RELEASE_COMMIT_SHA env row. The image carries the commit as its default
#      (acropora-os Dockerfile ENV), and the platform value would WIN, even an empty one (release-info.util.ts), so on a pulled
#      image the variable must not exist. vissza creates it again as ${SOURCE_COMMIT}, is_build_time and is_runtime true, is_preview
#      false: the value is the one the api stage ran on (acrobot's record has no values, Coolify gives none), so it is NOT read back.
#   3. POST /deploy?uuid=<uuid>, then poll /deployments/<deployment_uuid> until finished or failed.
#   4. measure: api: GET <fqdn>/health must say imageCommit == runtimeCommit == the tag's commit and commitSourceState "match";
#      web and partner: GET <fqdn>/ must answer a 2xx or 3xx.
# AUTO-DEPLOY (acrobot 54774, measured 2026-11-17 16:0x): the stage api has is_auto_deploy_enabled false, but the stage WEB and PARTNER
# have it TRUE: a half-switched web or partner app would deploy by itself on the next push to main. So on web and partner, elore
# turns it off BEFORE the PATCH (read back), and vissza turns it back to the measured value only AFTER its deploy and measure (a
# failed deploy leaves it off). The api is checked, not changed: it must read false. The record file has no such field, so the measured
# values are constants here. WHERE IT IS READ (acrobot, 2026-11-17 16:10): the GET /applications/<uuid> answer carries it NOT at the top
# level but in the "settings" object (settings.is_auto_deploy_enabled). WHERE IT IS WRITTEN is not measured (the top-level
# is_auto_deploy_enabled is the usual Coolify PATCH field, but nobody has seen it taken): the write is read back from settings, and a
# write that does not show there STOPS the script. An app whose settings have no such field is refused (its state cannot be checked).
# vissza writes the recorded values back, re-creates the env row, deploys (a full build from git again), polls, and prints the
# /health state (the commit of the git head this time: it is printed, not compared).
#
# WHAT IT NEVER DOES: no automatic revert (a failed step stops and says "vissza"; a loop would try one lasting fault forever, as
# kirakat-telepites.sh says), no prod, no env VALUE, no secret printed, no second app in one run.
# NOT MEASURED when this was written (no token for the author, the Coolify docs are not on the quarantine allowlist): that this
# Coolify accepts build_pack dockerimage on an existing app, that it keeps the other fields, and the DELETE /envs/<uuid> route.
# The first --vegrehajt IS that measurement; every step is read back, and a rejected PATCH changes nothing.
set -uo pipefail

COOLIFY="http://100.88.199.87:8000"
TOKEN_FILE_RO="/home/marveen/marveen/store/.coolify-token-ai"
TOKEN_FILE_RW="/home/marveen/marveen/store/.coolify-token-ai-rw"
RECORDED="/home/marveen/marveen/exchange/ghcr/coolify-beallitas-elotte-2026-11-17.json"
JOURNAL_DIR="/home/marveen/marveen/exchange/ghcr"
POLL_SECONDS=10
DEPLOY_TIMEOUT_SECONDS=1800
HEALTH_TIMEOUT_SECONDS=180

exec python3 - "$COOLIFY" "$TOKEN_FILE_RO" "$TOKEN_FILE_RW" "$RECORDED" "$JOURNAL_DIR" "$POLL_SECONDS" "$DEPLOY_TIMEOUT_SECONDS" "$HEALTH_TIMEOUT_SECONDS" "$@" <<'PY'
import datetime, json, os, re, sys, time, urllib.error, urllib.request

coolify, token_ro_file, token_rw_file, recorded_file, journal_dir, poll_s, deploy_s, health_s, *args = sys.argv[1:]
poll_s, deploy_s, health_s = float(poll_s), float(deploy_s), float(health_s)
USAGE = ("hasznalat: ghcr-atallas.sh terv <uuid> | elore <uuid> <sha40> [--vegrehajt] | vissza <uuid> [--vegrehajt] | meres <uuid>")
vegrehajt = "--vegrehajt" in args
args = [a for a in args if a != "--vegrehajt"]
if not args:
    print(USAGE, file=sys.stderr); sys.exit(2)
mode, *rest = args
if mode not in ("terv", "elore", "vissza", "meres"):
    print(USAGE, file=sys.stderr); sys.exit(2)
need = {"terv": 1, "elore": 2, "vissza": 1, "meres": 1}[mode]
if len(rest) != need:
    print(USAGE, file=sys.stderr); sys.exit(2)
if vegrehajt and mode in ("terv", "meres"):
    print(f"MEGTAGADVA: a(z) {mode} csak olvas, nincs --vegrehajt.", file=sys.stderr); sys.exit(2)
uuid = rest[0]
sha = rest[1] if mode == "elore" else None
if not re.fullmatch(r"[a-z0-9]{8,64}", uuid):
    print(f"MEGTAGADVA: az alkalmazas-uuid alakja nem ismert: {uuid!r}", file=sys.stderr); sys.exit(2)
if sha is not None and not re.fullmatch(r"[0-9a-f]{40}", sha):
    print("MEGTAGADVA: a kep cimkeje sha-<40 kisbetus hexa> lehet, mas (latest sem) nem.", file=sys.stderr); sys.exit(2)

# THE IMAGES, BY THE RECORDED NAME (not by a uuid in the code): the game and the reefclub apps have no GHCR image.
IMAGE_BY_NAME = {
    "acropora-stage-api": "acropora-os-api",
    "acropora-staging-web": "acropora-os-web-stage",
    "acropora-staging-partner": "acropora-os-partner-stage",
}
REGISTRY = "ghcr.io/kratobal/"
RELEASE_ENV = "RELEASE_COMMIT_SHA"
RELEASE_ENV_RESTORE_VALUE = "${SOURCE_COMMIT}"
AUTO_DEPLOY_FIELD = "is_auto_deploy_enabled"  # read from app["settings"][...], written as a top-level PATCH field
# MEASURED by acrobot, Coolify app settings, 2026-11-17 16:0x: the stage apps' automatic deploy (the record file has no such field)
AUTO_DEPLOY_MEASURED = {"acropora-stage-api": False, "acropora-staging-web": True, "acropora-staging-partner": True}
# the recorded app fields compared before and after every write (everything the record has except the envs and the live status)
SKIP_FIELDS = {"envs", "status"}

def die(code, text):
    print(text, file=sys.stderr); sys.exit(code)

_MISSING = object()
def auto_of(app):
    """The app's automatic deploy as the GET answer gives it: settings.is_auto_deploy_enabled, or _MISSING when the answer has none."""
    settings = app.get("settings")
    return settings.get(AUTO_DEPLOY_FIELD, _MISSING) if isinstance(settings, dict) else _MISSING

try:
    with open(recorded_file, encoding="utf-8") as f:
        recorded = json.load(f)
except (OSError, ValueError) as e:
    die(4, f"MEGALLOK: a rogzitett allapot nem olvashato ({recorded_file}): {e}")
rec = next((a for a in recorded.get("stage", []) if a.get("uuid") == uuid), None)
if rec is None:
    die(2, f"MEGTAGADVA: a(z) {uuid} nincs a rogzitett STAGE alkalmazasok kozott (az eles gep mas Coolify, mas token).")
image = IMAGE_BY_NAME.get(rec.get("name"))
if image is None:
    die(2, f"MEGTAGADVA: a(z) {rec.get('name')} nem kap GHCR-kepet (api, web, partner igen; jatek es reefclub nem).")
is_api = rec.get("name") == "acropora-stage-api"
auto_measured = AUTO_DEPLOY_MEASURED[rec["name"]]
fqdn = (rec.get("fqdn") or "").rstrip("/")

def read_token(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except OSError as e:
        die(4, f"MEGALLOK: a token nem olvashato ({path}): {e.strerror}")
token_ro = read_token(token_ro_file)

def call(method, path, body=None, rw=False):
    data = None if body is None else json.dumps(body).encode()
    tok = read_token(token_rw_file) if rw else token_ro
    req = urllib.request.Request(coolify + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {tok}", "Accept": "application/json",
                                          **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, (e.read() or b"")[:300].decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        die(3, f"MEGALLOK: a teszt Coolify nem valaszol ({coolify}): {e}")

def journal(step, ok, detail=""):
    """One line per step, no token, no env value. A journal that cannot be written does not stop the switch, but is said."""
    line = {"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "mode": mode, "uuid": uuid,
            "image": image, "step": step, "ok": ok, "detail": str(detail)[:300]}
    try:
        with open(os.path.join(journal_dir, f"atallas-{uuid}.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
    except OSError as e:
        print(f"FIGYELEM: a naplo nem irhato ({e.strerror}); a lepes ettol meg megtortent.", file=sys.stderr)

def read_app():
    code, app = call("GET", f"/api/v1/applications/{uuid}")
    if code != 200 or not isinstance(app, dict):
        die(1, f"MEGALLOK: az alkalmazas nem olvashato (HTTP {code}): {str(app)[:200]}")
    return app

def read_envs():
    code, envs = call("GET", f"/api/v1/applications/{uuid}/envs")
    if code != 200 or not isinstance(envs, list):
        die(1, f"MEGALLOK: az env-lista nem olvashato (HTTP {code}): {str(envs)[:200]}")
    return [e for e in envs if isinstance(e, dict)]

def env_shape(envs):
    """The env rows as a sorted list of (key, preview, build time, runtime): the values are not given by Coolify, so they are never compared."""
    return sorted((e.get("key"), bool(e.get("is_preview")), bool(e.get("is_build_time")), bool(e.get("is_runtime"))) for e in envs)

REC_ENVS = env_shape(rec.get("envs") or [])

def drift(app, expected, ignore=()):
    """The recorded fields (except the envs, the live status and `ignore`) whose live value differs from `expected`."""
    out = []
    for field, want in expected.items():
        if field in SKIP_FIELDS or field in ignore:
            continue
        if app.get(field) != want:
            out.append((field, want, app.get(field)))
    return out

def show_drift(rows):
    return "\n".join(f"  {f}: rogzitett/elvart {w!r}, most {g!r}" for f, w, g in rows)

# ---- the two bodies, and what the app must look like after each
fwd_fields = {"build_pack": "dockerimage", "docker_registry_image_name": REGISTRY + image,
              "docker_registry_image_tag": f"sha-{sha}" if sha else None}
back_fields = {k: rec.get(k) for k in ("build_pack", "dockerfile_location", "base_directory", "dockerfile_target_build",
                                         "docker_registry_image_name", "docker_registry_image_tag")}
release_row = {"key": RELEASE_ENV, "value": RELEASE_ENV_RESTORE_VALUE, "is_preview": False, "is_build_time": True, "is_runtime": True}
rec_has_release = any(k == RELEASE_ENV and not p for k, p, _b, _r in REC_ENVS)

def preflight(allow_switched=False):
    """The live app against the record. Refuses a drifted app, and one that is not running (a half-deployed app is not a state to switch)."""
    app = read_app()
    rows = drift(app, rec, ignore=tuple(fwd_fields) if allow_switched else ())
    envs_ok = env_shape(read_envs()) == REC_ENVS if not allow_switched else True
    if rows or not envs_ok:
        msg = "ELTERES a rogzitett allapottol, nem nyulok hozza:\n" + show_drift(rows)
        if not envs_ok:
            msg += "\n  az env-sorok (kulcs, preview, build, runtime) nem egyeznek a rogzitettel"
        die(1, msg)
    if not allow_switched and not str(app.get("status", "")).startswith("running"):
        die(1, f"MEGALLOK: az app allapota {app.get('status')!r}, nem 'running...': felebredt telepites vagy hiba, nem kapcsolok at.")
    if auto_of(app) is _MISSING:
        die(1, f"MEGALLOK: az app valaszanak settings objektuma nem tartalmazza a(z) {AUTO_DEPLOY_FIELD} mezot: az automatikus telepites allapota nem ellenorizheto, nem kapcsolok at.")
    if not allow_switched and auto_of(app) != auto_measured:
        die(1, f"ELTERES: az automatikus telepites most {auto_of(app)!r}, a mert allapot {auto_measured!r} (acrobot, 2026-11-17): nem nyulok hozza, mert a felig atallitott app maga telepulhetne.")
    return app

def deploy_and_wait():
    code, ans = call("POST", f"/api/v1/deploy?uuid={uuid}", rw=True)
    try:
        dep = ans["deployments"][0]["deployment_uuid"]
    except Exception:
        journal("deploy-inditas", False, f"HTTP {code}: {str(ans)[:150]}")
        die(1, f"NEM INDULT EL a telepites (HTTP {code}): {str(ans)[:200]}")
    journal("deploy-inditas", True, dep)
    print(f"telepites elinditva: {dep}")
    end = time.time() + deploy_s
    status = None
    while time.time() < end:
        code, d = call("GET", f"/api/v1/deployments/{dep}")
        status = d.get("status") if isinstance(d, dict) else None
        if status in ("finished", "failed", "cancelled-by-user"):
            break
        time.sleep(poll_s)
    ok = status == "finished"
    journal("deploy-vege", ok, status)
    print(f"a telepites vege: {status}")
    if not ok:
        die(1, f"A TELEPITES NEM SIKERULT ({status}). Naplo: kirakat-telepites.sh naplo {dep}. Visszaallitas: ghcr-atallas.sh vissza {uuid} --vegrehajt"
               + (" Az automatikus telepites KIKAPCSOLVA marad, amig a vissza vegig nem fut." if mode == "vissza" and auto_measured else ""))
    return dep

def fetch(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json"}), timeout=15) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, TimeoutError, OSError):
        return None, b""

def measure(expect_sha):
    """api: /health imageCommit == runtimeCommit == expect_sha and state match (expect_sha None: only print). web, partner: a 2xx or 3xx."""
    end = time.time() + health_s
    last = "nincs valasz"
    while True:
        if is_api:
            code, raw = fetch(fqdn + "/health")
            try:
                app_h = json.loads(raw)["application"]
            except Exception:
                app_h = None
            if code == 200 and isinstance(app_h, dict):
                image_c, runtime_c, state = app_h.get("imageCommit"), app_h.get("runtimeCommit"), app_h.get("commitSourceState")
                last = f"imageCommit={image_c} runtimeCommit={runtime_c} commitSourceState={state}"
                if expect_sha is None:
                    print(f"/health: {last}"); journal("meres", True, last); return True
                if image_c == runtime_c == expect_sha and state == "match":
                    print(f"/health: {last}"); journal("meres", True, last); return True
            else:
                last = f"HTTP {code}"
        else:
            code, _ = fetch(fqdn + "/")
            last = f"HTTP {code}"
            if code is not None and 200 <= code < 400:
                print(f"{fqdn}/: {last}"); journal("meres", True, last); return True
        if time.time() >= end:
            print(f"A MERES NEM IGAZOL: {last}" + (f" (vart: {expect_sha})" if expect_sha else ""), file=sys.stderr)
            journal("meres", False, last); return False
        time.sleep(poll_s)

def patch_and_check(fields, label, ignore_after=()):
    code, ans = call("PATCH", f"/api/v1/applications/{uuid}", fields, rw=True)
    if code not in (200, 201, 202):
        journal(label, False, f"HTTP {code}: {str(ans)[:150]}")
        die(1, f"NEM IRTA AT ({label}, HTTP {code}): {str(ans)[:300]}\nA kerest a Coolify elutasitotta, az app valtozatlan.")
    app = read_app()
    rows = drift(app, {**rec, **{k: v for k, v in fields.items() if k != AUTO_DEPLOY_FIELD}}, ignore=ignore_after)
    if AUTO_DEPLOY_FIELD in fields and auto_of(app) != fields[AUTO_DEPLOY_FIELD]:
        rows.append((f"settings.{AUTO_DEPLOY_FIELD}", fields[AUTO_DEPLOY_FIELD], None if auto_of(app) is _MISSING else auto_of(app)))
    if rows:
        journal(label, False, "elteres: " + ",".join(f for f, _w, _g in rows))
        die(1, f"ELTERES a(z) {label} UTAN (a Coolify mast tarol, mint amit kuldtunk, vagy mashoz is hozzanyult):\n" + show_drift(rows)
               + f"\nA tovabbi lepeseket nem futtatom. Visszaallitas: ghcr-atallas.sh vissza {uuid} --vegrehajt")
    journal(label, True)
    print(f"{label}: kiirva es visszaolvasva")

def release_rows():
    return [e for e in read_envs() if e.get("key") == RELEASE_ENV and not e.get("is_preview")]

# ------------------------------------------------------------------ modes
if mode == "meres":
    sys.exit(0 if measure(None) else 1)

live = preflight(allow_switched=(mode == "vissza"))
print(f"alkalmazas  {rec['name']} ({uuid}), {coolify}, allapot: {live.get('status')}")
print(f"kep         {REGISTRY}{image}" + (f":sha-{sha}" if sha else ""))
if mode == "vissza":
    print("a kapcsolassal nem erintett mezok egyeznek a rogzitettel (az env sorokat a vissza lepes veti ossze a vegen)")
else:
    print("az elo allapot egyezik a rogzitettel (minden rogzitett mezo, az env-sorok kulcs/preview/build/runtime szerint; az env ERTEKEKET a Coolify nem adja)")

if mode in ("terv", "elore"):
    print("\nELORE (Docker Image tipusra):")
    if auto_measured:
        print(f"  0. PATCH /api/v1/applications/<uuid>  {json.dumps({AUTO_DEPLOY_FIELD: False})}  (az automatikus telepites BE van kapcsolva ezen az appon: a felig atallitott app maga telepulne; visszaolvasva)")
    else:
        print(f"  0. az automatikus telepites mar ki van kapcsolva ({AUTO_DEPLOY_FIELD}: false, acrobot merese): nincs lepes, az ellenorzes a futas elejen")
    print("  1. PATCH /api/v1/applications/<uuid>  " + json.dumps(fwd_fields if sha else {**fwd_fields, "docker_registry_image_tag": "sha-<a commit>"}))
    if is_api:
        print(f"  2. {RELEASE_ENV} env sor torlese (nem-preview), mert a kep hordozza a commitot, es a platform-ertek felulirna")
    print("  3. POST /api/v1/deploy?uuid=<uuid>, varakozas a /deployments/<uuid> 'finished' allapotra")
    print("  4. meres: " + ("/health: imageCommit == runtimeCommit == a cimke commitja, commitSourceState match" if is_api else "GET / : 2xx vagy 3xx"))
if mode in ("terv", "vissza"):
    print("\nVISSZA (a rogzitett allapotra):")
    print("  1. PATCH /api/v1/applications/<uuid>  " + json.dumps(back_fields))
    if is_api and rec_has_release:
        print(f"  2. {RELEASE_ENV} env sor ujra: {json.dumps({k: v for k, v in release_row.items()})} (az ERTEKET nem lehet visszaolvasni)")
    print("  3. POST /api/v1/deploy?uuid=<uuid>: teljes epites a git-bol, varakozas")
    print("  4. a /health allapota kiirva (a git fej commitja), az app rogzitett mezoi visszaolvasva")
    if auto_measured:
        print(f"  5. PATCH /api/v1/applications/<uuid>  {json.dumps({AUTO_DEPLOY_FIELD: True})}  (a mert ertek, a deploy es a meres UTAN, visszaolvasva; elobb nem, hogy ne induljon masodik telepites)")
if mode == "terv" or not vegrehajt:
    print("\nSZARAZ FUTAS: semmi nem ment ki." + ("" if mode == "terv" else " Iraskor: --vegrehajt"))
    sys.exit(0)

journal("kezdet", True, "vegrehajt")
if mode == "elore":
    if auto_measured:
        patch_and_check({AUTO_DEPLOY_FIELD: False}, "auto-telepites-ki")
    patch_and_check(fwd_fields, "atallitas")
    if is_api:
        rows = release_rows()
        if rows:
            row_uuid = rows[0].get("uuid")
            if not row_uuid:
                journal("env-torles", False, "a sornak nincs uuid-ja")
                die(1, f"MEGALLOK: a {RELEASE_ENV} sornak nincs uuid-ja a valaszban, nem tudom torolni.\nVisszaallitas: ghcr-atallas.sh vissza {uuid} --vegrehajt")
            code, ans = call("DELETE", f"/api/v1/applications/{uuid}/envs/{row_uuid}", rw=True)
            if code not in (200, 204) or release_rows():
                journal("env-torles", False, f"HTTP {code}")
                die(1, f"NEM TORLODOTT a {RELEASE_ENV} (HTTP {code}): {str(ans)[:200]}\nVisszaallitas: ghcr-atallas.sh vissza {uuid} --vegrehajt")
            journal("env-torles", True)
            print(f"{RELEASE_ENV}: torolve es visszaolvasva (nincs nem-preview sor)")
        else:
            print(f"{RELEASE_ENV}: nincs nem-preview sor, nincs mit torolni")
    deploy_and_wait()
    ok = measure(sha)
    print("ELORE KESZ." if ok else f"A mérés nem igazolt: visszaallitas: ghcr-atallas.sh vissza {uuid} --vegrehajt")
    sys.exit(0 if ok else 1)

# vissza
patch_and_check(back_fields, "visszaallitas")
if is_api and rec_has_release and not release_rows():
    code, ans = call("POST", f"/api/v1/applications/{uuid}/envs", release_row, rw=True)
    if code not in (200, 201) or not release_rows():
        journal("env-ujra", False, f"HTTP {code}")
        die(1, f"NEM LETT UJRA a {RELEASE_ENV} (HTTP {code}): {str(ans)[:200]}")
    journal("env-ujra", True)
    print(f"{RELEASE_ENV}: ujra letrehozva (az erteket a Coolify nem adja vissza, nem ellenorizheto)")
if env_shape(read_envs()) != REC_ENVS:
    journal("env-visszaolvasas", False)
    die(1, "ELTERES: az env-sorok a visszaallitas utan nem egyeznek a rogzitettel (kulcs, preview, build, runtime).")
journal("env-visszaolvasas", True)
print("env-sorok: egyeznek a rogzitettel")
deploy_and_wait()
ok = measure(None)
if auto_measured:
    patch_and_check({AUTO_DEPLOY_FIELD: True}, "auto-telepites-vissza")
print("VISSZA KESZ: a rogzitett mezok visszaolvasva, a telepites lefutott." if ok else "A /health nem valaszolt: nezd meg kezzel.")
sys.exit(0 if ok else 1)
PY
