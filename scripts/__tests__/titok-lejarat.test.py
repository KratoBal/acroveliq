"""titok_lejarat.py and fleet-secrets.py --napi (titok-lejarat-figyelo). What turns these red:
  - a secret value, or a provider's error body, reaching stdout or the state file;
  - a date not taken from where the provider says it (GitHub header, Meta debug_token,
    the recorded date), or a Google renewal not measured by a real exchange;
  - more than one message per secret and threshold, or none at 14 days, 3 days or invalid;
  - an unknown or unmeasurable secret raising an alarm instead of being counted;
  - a message the outgoing gate would stop (Hungarian without its accents, an em dash);
  - a registry rule without what its kind needs.
Run: python3 -B scripts/__tests__/titok-lejarat.test.py
"""
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPTS = os.path.dirname(_HERE)
sys.path.insert(0, _SCRIPTS)
import titok_lejarat as tl  # noqa: E402


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gate = _load("outgoing_copy_gate", os.path.join(_SCRIPTS, "hooks", "outgoing-copy-gate.py"))
REGISTRY = tl.load_registry(os.path.join(_SCRIPTS, "titok-lejarat.json"))
NOW = time.mktime(time.strptime("2026-10-16", "%Y-%m-%d")) + 3600
MARK = "TITOKERTEK"  # every fake secret carries it; it must never be printed or stored


def day(n):
    return time.strftime("%Y-%m-%d", time.localtime(NOW + n * 86400))


class FakeHttp:
    def __init__(self):
        self.calls = []
        self.github = (200, "%s 10:04:00 UTC" % day(40))
        self.meta = {}
        self.google = (200, {"access_token": "AT-" + MARK, "refresh_token": "NEWRT-" + MARK})
        self.status = 200
        self.health = 200
        self.expo = (200, {"data": {"meActor": {"__typename": "User"}}})

    def __call__(self, method, url, headers=None, body=None, timeout=15):
        self.calls.append((method, url))
        if "api.github.com" in url:
            st, h = self.github
            return st, ({"github-authentication-token-expiration": h} if h else {}), {"message": "echo " + MARK}
        if "graph.facebook.com" in url:
            tok = url.split("input_token=")[1]
            return 200, {}, {"data": self.meta.get(tok, {"is_valid": True, "expires_at": 0, "data_access_expires_at": 0})}
        if "oauth2.googleapis.com" in url:
            st, d = self.google
            return st, {}, d
        if url == "https://api.expo.dev/graphql":
            st, d = self.expo
            return st, {}, d
        if url.endswith("/api/health"):
            return self.health, {}, None
        return self.status, {}, {"error": "echo " + MARK}


class Base(unittest.TestCase):
    def setUp(self):
        self.store = tempfile.mkdtemp()
        self.http = FakeHttp()

    def tearDown(self):
        shutil.rmtree(self.store)

    def put(self, name, value=None):
        with open(os.path.join(self.store, name), "w") as f:
            f.write(value if value is not None else "%s-%s" % (name, MARK))

    def run_check(self, state=None, ann=None, names=None):
        names = names if names is not None else sorted(os.listdir(self.store))
        return tl.check(self.store, REGISTRY, ann or {}, state or {}, names, NOW, http=self.http)

    def row(self, rows, name):
        return next(r for r in rows if r["nev"] == name)


class Sources(Base):
    def test_github_date_from_the_header_and_401_is_invalid(self):
        self.put(".github-token")
        rows, msgs, _ = self.run_check()
        r = self.row(rows, ".github-token")
        self.assertEqual((r["eredmeny"], r["lejarat"], r["nap"]), ("OK", day(40), 40))
        self.assertEqual(msgs, [])
        self.http.github = (401, None)
        rows, msgs, _ = self.run_check()
        self.assertEqual(self.row(rows, ".github-token")["eredmeny"], "ERVENYTELEN")
        self.assertEqual(len(msgs), 1)
        self.assertIn("Érvénytelen titok: .github-token", msgs[0])

    def test_meta_takes_the_earlier_of_the_two_expiries_and_the_vault_its_earliest(self):
        t1, t2 = "P1" + MARK, "P2" + MARK
        self.put(".fb-page-tokens.json", json.dumps({"1": {"name": "a", "token": t1}, "2": {"name": "b", "token": t2}}))
        stamp = lambda n: int(NOW + n * 86400)
        self.http.meta = {t1: {"is_valid": True, "expires_at": 0, "data_access_expires_at": stamp(80)},
                          t2: {"is_valid": True, "expires_at": stamp(50), "data_access_expires_at": stamp(90)}}
        rows, _, _ = self.run_check()
        self.assertEqual(self.row(rows, ".fb-page-tokens.json")["lejarat"], time.strftime("%Y-%m-%d", time.gmtime(stamp(50))))
        self.http.meta[t2] = {"is_valid": False}
        rows, msgs, _ = self.run_check()
        self.assertEqual(self.row(rows, ".fb-page-tokens.json")["eredmeny"], "ERVENYTELEN")
        self.assertEqual(len(msgs), 1)

    def test_google_measures_the_renewal_and_drops_what_it_gets(self):
        for f in (".yt-client-id", ".yt-client-secret", ".gdrive-refresh-token"):
            self.put(f)
        rows, msgs, state = self.run_check()
        r = self.row(rows, ".gdrive-refresh-token")
        self.assertEqual((r["eredmeny"], r["lejarat"]), ("OK", None))
        self.assertIn(("POST", "https://oauth2.googleapis.com/token"), self.http.calls)
        self.assertNotIn(MARK, json.dumps(rows) + json.dumps(state))
        self.http.google = (400, {"error": "invalid_grant", "error_description": "echo " + MARK})
        rows, msgs, _ = self.run_check()
        self.assertEqual(self.row(rows, ".gdrive-refresh-token")["eredmeny"], "ERVENYTELEN")
        self.assertEqual(len(msgs), 1)
        # an unreadable client is not measured and raises nothing
        os.remove(os.path.join(self.store, ".yt-client-secret"))
        rows, msgs, _ = self.run_check(names=[".gdrive-refresh-token"])
        self.assertEqual(self.row(rows, ".gdrive-refresh-token")["eredmeny"], "NEM_MERT")
        self.assertEqual(msgs, [])

    def test_coolify_and_expo_are_classified_401_invalid_unreachable_quiet(self):
        self.put(".coolify-token-prod")
        self.put(".expo-token")
        rows, msgs, _ = self.run_check()
        self.assertEqual({self.row(rows, n)["eredmeny"] for n in (".coolify-token-prod", ".expo-token")}, {"OK"})
        self.assertIn(("GET", "http://10.0.1.1:8000/api/v1/version"), self.http.calls)
        self.assertIn(("POST", "https://api.expo.dev/graphql"), self.http.calls)
        self.http.status = 0
        self.http.expo = (200, {"data": {"meActor": None}})  # what Expo answers without a valid identity
        rows, msgs, _ = self.run_check()
        self.assertEqual(self.row(rows, ".coolify-token-prod")["eredmeny"], "NEM_MERT")
        self.assertEqual(self.row(rows, ".expo-token")["eredmeny"], "NEM_MERT")
        self.assertEqual(msgs, [])
        self.http.status = 401
        self.http.expo = (401, {"errors": [{"code": "AUTHENTICATION_ERROR"}]})
        rows, msgs, _ = self.run_check()
        self.assertEqual(len(msgs), 2)

    def test_a_coolify_403_says_whether_the_host_or_the_key_refused(self):
        self.put(".coolify-token-ai")
        self.http.status, self.http.health = 403, 403
        rows, msgs, _ = self.run_check()
        self.assertIn("a hoszt a flottabol zarva", self.row(rows, ".coolify-token-ai")["ok"])
        self.http.health = 200
        rows, msgs, _ = self.run_check()
        self.assertIn("jogkor?", self.row(rows, ".coolify-token-ai")["ok"])
        self.assertEqual(msgs, [])

    def test_a_measured_key_carries_its_recorded_date(self):
        self.put(".coolify-token-prod")
        rows, msgs, _ = self.run_check(ann={".coolify-token-prod": day(365)})
        r = self.row(rows, ".coolify-token-prod")
        self.assertEqual((r["eredmeny"], r["lejarat"]), ("OK", day(365)))
        self.assertIn("rogzitett datum", r["ok"])

    def test_recorded_dates_and_host_keys_and_kinds_without_a_call(self):
        self.put(".claude-oauth-token")
        self.put(".dashboard-token")
        self.put(".gdrive-access-token")
        rows, _, _ = self.run_check(ann={".claude-oauth-token": day(200), "host:fleet-github": day(300)})
        self.assertEqual(self.row(rows, ".claude-oauth-token")["lejarat"], day(200))
        self.assertEqual(self.row(rows, "host:fleet-github")["lejarat"], day(300))
        self.assertEqual(self.row(rows, "host:vegrehajto/coolify-ai-deploy")["eredmeny"], "ISMERETLEN")
        self.assertEqual(self.row(rows, "host:vegrehajto/discord-olvaso")["eredmeny"], "NEM-JAR-LE")
        self.assertEqual(self.row(rows, ".dashboard-token")["eredmeny"], "NEM-JAR-LE")
        self.assertEqual(self.row(rows, ".gdrive-access-token")["eredmeny"], "ROVID-ELETU")
        self.assertEqual(self.http.calls, [])

    def test_an_unregistered_secret_is_counted_never_an_alarm(self):
        self.put(".uj-titok-key")
        rows, msgs, _ = self.run_check(names=[".uj-titok-key"])
        self.assertEqual(self.row(rows, ".uj-titok-key")["eredmeny"], "ISMERETLEN")
        self.assertEqual(msgs, [])
        self.assertIn("ISMERETLEN 5", tl.summary_line(rows))  # it, and the four host keys without a date (the Discord bot does not expire)


class Thresholds(Base):
    def test_one_message_at_14_one_at_3_and_a_renewal_starts_over(self):
        self.put(".github-token")
        self.http.github = (200, "%s 10:04:00 UTC" % day(13))
        _, msgs, state = self.run_check()
        self.assertEqual(len(msgs), 1)
        self.assertIn("(13 nap múlva)", msgs[0])
        _, msgs, state = self.run_check(state)
        self.assertEqual(msgs, [])
        self.http.github = (200, "%s 10:04:00 UTC" % day(13))
        global NOW
        _, msgs, state = tl.check(self.store, REGISTRY, {}, state, [".github-token"], NOW + 10 * 86400, http=self.http)
        self.assertEqual(len(msgs), 1)  # 3 days now: the second and last
        _, msgs, state = tl.check(self.store, REGISTRY, {}, state, [".github-token"], NOW + 11 * 86400, http=self.http)
        self.assertEqual(msgs, [])
        # renewed: a new date, the thresholds start again
        self.http.github = (200, "%s 10:04:00 UTC" % day(25))
        _, msgs, state = tl.check(self.store, REGISTRY, {}, state, [".github-token"], NOW + 12 * 86400, http=self.http)
        self.assertEqual(len(msgs), 1)


class Messages(unittest.TestCase):
    def test_every_possible_message_passes_the_outgoing_gate(self):
        for rule in REGISTRY["szabalyok"] + [dict(h, fajta="rogzitett") for h in REGISTRY["host"]]:
            if "megujitas" not in rule:
                continue
            name = rule.get("minta", rule.get("kulcs"))
            for m, d, due in (({"lejarat": "2026-10-30", "ok": "github fejlec"}, 14, "14"),
                              ({"lejarat": "2026-10-10", "ok": "github fejlec"}, -6, "3"),
                              ({"lejarat": None, "ok": "google invalid_grant"}, None, "ervenytelen")):
                text = tl._message(name, rule, m, d, due)
                with self.subTest(name=name, due=due):
                    self.assertEqual(gate.audit(text), [])
                    self.assertNotIn("--", text)

    def test_the_registry_rules_carry_what_their_kind_needs(self):
        kinds = {"github", "meta", "meta-json", "google", "coolify", "expo", "rogzitett",
                 "nem-jar-le", "rovid-eletu", "mentes", "nem-titok", "ismeretlen"}
        for r in REGISTRY["szabalyok"]:
            with self.subTest(minta=r["minta"]):
                self.assertIn(r["fajta"], kinds)
                if r["fajta"] in ("github", "meta", "meta-json", "google", "coolify", "expo", "rogzitett"):
                    self.assertTrue(r.get("megujitas"))
                    self.assertTrue(r.get("cel"))
                if r["fajta"] == "google":
                    self.assertIn(r["kliens"], tl.GOOGLE_CLIENTS)
                if r["fajta"] == "coolify":
                    self.assertTrue(r["url"].startswith(("http://10.0.1.1:", "https://coolify")))
                if r["fajta"] in ("nem-jar-le", "rovid-eletu", "mentes", "nem-titok"):
                    self.assertTrue(r.get("indok"))


class Napi(unittest.TestCase):
    """fleet-secrets.py --napi end to end, on a temporary store, with the fake http."""

    def test_no_value_in_stdout_or_state_and_the_state_is_0600(self):
        root = tempfile.mkdtemp()
        try:
            store = os.path.join(root, "store")
            os.makedirs(store)
            for f in (".github-token", ".dashboard-token", ".yt-client-id", ".yt-client-secret", ".gsc-refresh-token"):
                with open(os.path.join(store, f), "w") as fh:
                    fh.write(f + MARK)
            with open(os.path.join(store, ".main-agent-id"), "w") as fh:
                fh.write("acrobot")
            fs = _load("fleet_secrets", os.path.join(_SCRIPTS, "fleet-secrets.py"))
            fs.ROOT, fs.STORE = root, store
            fs.ANNOT = os.path.join(store, "secrets-lejarat.json")
            fs.STATE = os.path.join(store, "secrets-lejarat-allapot.json")
            fake = FakeHttp()
            fake.github = (200, "%s 10:04:00 UTC" % time.strftime("%Y-%m-%d", time.localtime(time.time() + 5 * 86400)))
            fake.google = (400, {"error": "invalid_grant", "error_description": "echo " + MARK})
            real = tl._http
            tl._http = fake
            try:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    self.assertEqual(fs.napi(False), 0)
            finally:
                tl._http = real
            out = buf.getvalue()
            with open(fs.STATE) as fh:
                state_text = fh.read()
            self.assertNotIn(MARK, out + state_text)
            self.assertEqual(stat.S_IMODE(os.stat(fs.STATE).st_mode), 0o600)
            self.assertIn("TITOK-LEJARAT:", out)
            self.assertIn("KULDENDO (az Eldontendo szalba", out)
            self.assertIn("Lejáró titok: .github-token", out)
            self.assertIn("Érvénytelen titok: .gsc-refresh-token", out)
            # the second run the same day sends nothing new
            tl._http = fake
            try:
                buf = io.StringIO()
                with redirect_stdout(buf):
                    fs.napi(False)
            finally:
                tl._http = real
            self.assertNotIn("KULDENDO", buf.getvalue())
        finally:
            shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
