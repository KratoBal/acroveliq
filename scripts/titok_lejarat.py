"""titok_lejarat -- when each secret expires, measured where the provider says it, and ONE
message when it gets close (titok-lejarat-figyelo, Balazs 2026-10-16 10:55 UTC: "baromira
szeretnek eljutni oda, hogy a vegere erunk es nem kell ezzel tovabb foglalkozni").

Called by `fleet-secrets.py --napi`, run once a day by the main agent's heartbeat (the marveen
user: it is the one that can read the secrets). No agent runs it.

THE VALUE NEVER LEAVES. Not to stdout, not to the state file, not to a log, not to argv: every
measurement is a Python urllib call with the secret in a header or a body (barracuda 32058),
each on its provider's own fixed host. A provider's error body is never printed (a Google or
Meta error can echo a token): only the HTTP status and a fixed reason word.

WHERE THE DATE COMES FROM, by kind (scripts/titok-lejarat.json, no values in it):
  github      the github-authentication-token-expiration header; 401 means invalid
  meta        graph.facebook.com debug_token, the token inspecting itself: the earlier of
              expires_at and data_access_expires_at (0 = none); is_valid false means invalid
  meta-json   the same for every token in the fb-insights.sh vault; the earliest counts
  google      one refresh exchange with the token's own client: 200 means the renewal WORKS
              (the brief's point 2), invalid_grant means it is dead. No date exists. Two things
              the code does not see (barracuda 32058): a client in "Testing" publishing state
              loses its refresh tokens after 7 days whatever the use, and that reads here as a
              weekly invalid_grant, a property of the client, not the token; and a response
              that brings a new refresh_token is neither stored nor printed (the old one lives on)
  coolify     GET /api/v1/version with the token: 200 valid, 401 invalid; a 403 is told apart
              by /api/health WITHOUT a token (403 there too: the host is closed to the fleet,
              as coolify2 since B20b); an unreachable host is no alarm
  expo        the GraphQL meActor, as eas-keret.sh asks: 200 with an actor valid, 401 invalid
  (coolify and expo: a date recorded when the key was made, in store/secrets-lejarat.json,
  is carried with the measured validity)
  rogzitett   the date written in store/secrets-lejarat.json when the secret was made
  host:       the same file, for the host's secrets the fleet cannot read; the host's
              install or rotation sheet writes the date as its last step (barracuda 32058)
  nem-jar-le, rovid-eletu, mentes, nem-titok: no date by nature, the reason is in the registry
  ismeretlen  not known: counted, never an alarm. The count is the list Balazs wants at zero.

THE MESSAGE: per secret ONE at 14 days, ONE at 3 days, ONE when a measurement says invalid;
the sent thresholds live in store/secrets-lejarat-allapot.json (names, dates, words: no
value). A renewed secret (a new date) starts over. The text is printed in a KULDENDO block,
and the heartbeat posts it to the Eldontendo thread as it is.
"""
import datetime
import fnmatch
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

WARN_DAYS = (14, 3)


def load_registry(path):
    with open(path) as f:
        return json.load(f)


def rule_for(name, registry):
    for r in registry.get("szabalyok", []):
        if fnmatch.fnmatchcase(name, r["minta"]):
            return r
    return None


def days_until(datestr, now):
    """Calendar days from today to the expiry date. Not seconds over 86400: that floors a day
    off whenever the hour of now is later than midnight, and a DST change hides it in one zone
    and shows it in another (measured: 40 here, 39 in the UTC CI, the same input)."""
    try:
        exp = datetime.date.fromisoformat(datestr[:10])
        return (exp - datetime.date.fromtimestamp(now)).days
    except Exception:
        return None


def _http(method, url, headers=None, body=None, timeout=15):
    """(status, headers, parsed JSON or None). Never raises; never returns a body as text."""
    if isinstance(body, dict):
        data = urllib.parse.urlencode(body).encode()
    elif isinstance(body, str):
        data = body.encode()  # a JSON body, already serialised by the caller
    else:
        data = None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            st, hd = r.status, r.headers
    except urllib.error.HTTPError as e:
        raw, st, hd = e.read(), e.code, e.headers
    except Exception:
        return 0, {}, None
    try:
        return st, hd, json.loads(raw.decode() or "null")
    except Exception:
        return st, hd, None


def _read(store, name):
    with open(os.path.join(store, name)) as f:
        return f.read().strip()


# Each measure returns {"eredmeny": OK|ERVENYTELEN|NEM_MERT, "lejarat": "YYYY-MM-DD"|None, "ok": word}

def measure_github(token, http):
    st, hd, _ = http("GET", "https://api.github.com/rate_limit",
                     {"Authorization": "Bearer " + token, "User-Agent": "acroveliq-titok-lejarat"})
    if st == 401:  # a 403 is a rate limit or a scope, not a dead token
        return {"eredmeny": "ERVENYTELEN", "lejarat": None, "ok": "github 401"}
    if st != 200:
        return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "github %d" % st}
    v = (hd.get("github-authentication-token-expiration") if hd else None) or ""
    return {"eredmeny": "OK", "lejarat": v.split()[0] if v else None,
            "ok": "github fejlec" if v else "github: nincs lejarati fejlec"}


def _meta_one(token, http):
    st, _, d = http("GET", "https://graph.facebook.com/debug_token?" + urllib.parse.urlencode({"input_token": token}),
                    {"Authorization": "Bearer " + token})
    if st != 200 or not isinstance(d, dict) or not isinstance(d.get("data"), dict):
        return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "meta %d" % st}
    data = d["data"]
    if not data.get("is_valid"):
        return {"eredmeny": "ERVENYTELEN", "lejarat": None, "ok": "meta is_valid=false"}
    stamps = [int(data.get(k) or 0) for k in ("expires_at", "data_access_expires_at")]
    stamps = [s for s in stamps if s > 0]
    exp = time.strftime("%Y-%m-%d", time.gmtime(min(stamps))) if stamps else None
    return {"eredmeny": "OK", "lejarat": exp, "ok": "meta debug_token"}


def measure_meta(token, http):
    return _meta_one(token, http)


def measure_meta_json(raw, http):
    try:
        vault = json.loads(raw)
        tokens = [v["token"] for v in vault.values() if isinstance(v, dict) and v.get("token")]
    except Exception:
        return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "a vault nem olvashato JSON"}
    if not tokens:
        return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "a vault ures"}
    results = [_meta_one(t, http) for t in tokens]
    if any(r["eredmeny"] == "ERVENYTELEN" for r in results):
        return {"eredmeny": "ERVENYTELEN", "lejarat": None, "ok": "meta: egy oldal-token ervenytelen"}
    dates = sorted(r["lejarat"] for r in results if r["lejarat"])
    bad = sum(r["eredmeny"] != "OK" for r in results)
    return {"eredmeny": "OK" if not bad else "NEM_MERT", "lejarat": dates[0] if dates else None,
            "ok": "meta debug_token, %d token" % len(tokens) + (", %d nem mert" % bad if bad else "")}


GOOGLE_CLIENTS = {
    "yt": (".yt-client-id", ".yt-client-secret"),
    "ticket-mail": (".ticket-mail-client-id", ".ticket-mail-client-secret"),
}


def measure_google(refresh, client, store, http):
    try:
        cid_file, sec_file = GOOGLE_CLIENTS[client]
        cid, sec = _read(store, cid_file), _read(store, sec_file)
    except Exception:
        return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "a kliens nem olvashato"}
    st, _, d = http("POST", "https://oauth2.googleapis.com/token", {"Content-Type": "application/x-www-form-urlencoded"},
                    {"client_id": cid, "client_secret": sec, "refresh_token": refresh, "grant_type": "refresh_token"})
    # the access token in the answer, and a new refresh_token if one came, are dropped here
    err = d.get("error") if isinstance(d, dict) else None
    if st == 200 and isinstance(d, dict) and d.get("access_token"):
        return {"eredmeny": "OK", "lejarat": None, "ok": "google megujitas el"}
    if err == "invalid_grant":
        return {"eredmeny": "ERVENYTELEN", "lejarat": None, "ok": "google invalid_grant"}
    return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "google %d %s" % (st, err if err in ("invalid_client", "unauthorized_client") else "")}


def measure_coolify(base, token, http):
    base = base.rstrip("/")
    st, _, _ = http("GET", base + "/api/v1/version", {"Authorization": "Bearer " + token})
    if st == 200:
        return {"eredmeny": "OK", "lejarat": None, "ok": "coolify 200"}
    if st == 401:
        return {"eredmeny": "ERVENYTELEN", "lejarat": None, "ok": "coolify 401"}
    if st == 403:
        # the key's right or the host's gate? the health path without any token tells them apart
        # (measured 2026-10-16: coolify2 answers 403 to it too, the host is closed to the fleet)
        hst, _, _ = http("GET", base + "/api/health", {})
        if hst == 403:
            return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "coolify 403: a hoszt a flottabol zarva, token nelkul is 403"}
        return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "coolify 403 a kulcsra (a hoszt elerheto): jogkor?"}
    return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "coolify %s" % (st or "nem erheto el")}


def measure_expo(token, http):
    """The GraphQL meActor, as eas-keret.sh talks to Expo (measured 2026-10-16: an invalid
    token is 401 AUTHENTICATION_ERROR; no token is 200 with meActor null)."""
    st, _, d = http("POST", "https://api.expo.dev/graphql",
                    {"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                    json.dumps({"query": "{ meActor { __typename } }"}))
    if st == 401:
        return {"eredmeny": "ERVENYTELEN", "lejarat": None, "ok": "expo 401"}
    actor = ((d or {}).get("data") or {}).get("meActor") if isinstance(d, dict) else None
    if st == 200 and actor:
        return {"eredmeny": "OK", "lejarat": None, "ok": "expo meActor"}
    return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "expo %s, nincs meActor" % st}


def measure(name, rule, store, annotations, http):
    kind = rule["fajta"] if rule else "ismeretlen"
    if kind in ("nem-jar-le", "rovid-eletu", "mentes", "nem-titok"):
        return {"eredmeny": kind.upper(), "lejarat": None, "ok": rule.get("indok", "")}
    if kind == "rogzitett":
        exp = annotations.get(name)
        return {"eredmeny": "OK" if exp else "ISMERETLEN", "lejarat": exp,
                "ok": "rogzitett datum" if exp else "nincs rogzitett datum a secrets-lejarat.json-ban"}
    if kind == "ismeretlen":
        return {"eredmeny": "ISMERETLEN", "lejarat": None, "ok": "nincs a nyilvantartasban" if not rule else "a forras nem ismert"}
    try:
        raw = _read(store, name)
    except Exception:
        return {"eredmeny": "NEM_MERT", "lejarat": None, "ok": "a fajl nem olvashato"}
    if kind == "github":
        return measure_github(raw, http)
    if kind == "meta":
        return measure_meta(raw, http)
    if kind == "meta-json":
        return measure_meta_json(raw, http)
    if kind == "google":
        return measure_google(raw, rule.get("kliens", "yt"), store, http)
    if kind in ("coolify", "expo"):
        m = measure_coolify(rule["url"], raw, http) if kind == "coolify" else measure_expo(raw, http)
        # validity is measured; the date, if one was set when the key was made, is the recorded one
        if annotations.get(name):
            m["lejarat"] = annotations[name]
            m["ok"] += ", rogzitett datum"
        return m
    return {"eredmeny": "ISMERETLEN", "lejarat": None, "ok": "ismeretlen fajta: %s" % kind}


def candidates(store, registry, base_names):
    """The secret-named files (fleet-secrets.py's own filter) plus every dotfile the registry names."""
    names = set(base_names)
    for fn in os.listdir(store):
        p = os.path.join(store, fn)
        if fn.startswith(".") and os.path.isfile(p) and rule_for(fn, registry):
            names.add(fn)
    return sorted(names)


def check(store, registry, annotations, state, base_names, now, http=None):
    """Measure everything; returns (rows, messages, new_state). Pure but for http and the reads."""
    http = http or _http
    rows, messages, new_state = [], [], {}
    entries = [(n, rule_for(n, registry)) for n in candidates(store, registry, base_names)]
    for h in registry.get("host", []):
        entries.append((h["kulcs"], dict(h, fajta=h.get("fajta", "rogzitett"))))
    for name, rule in entries:
        m = measure(name, rule, store, annotations, http)
        d = days_until(m["lejarat"], now) if m["lejarat"] else None
        rows.append(dict(m, nev=name, nap=d, fajta=(rule or {}).get("fajta", "ismeretlen"),
                         cel=(rule or {}).get("cel", "?")))
        prev = state.get(name, {})
        sent = list(prev.get("kuldve", [])) if prev.get("lejarat") == m["lejarat"] else []
        due = None
        if m["eredmeny"] == "ERVENYTELEN":
            due = "ervenytelen"
        elif d is not None:
            for limit in sorted(WARN_DAYS):
                if d <= limit:
                    due = str(limit)
                    break
        if due and due not in sent:
            messages.append(_message(name, rule or {}, m, d, due))
            sent.append(due)
        if m["eredmeny"] == "OK" and due is None:
            sent = [s for s in sent if s != "ervenytelen"]  # a repaired secret may warn again
        new_state[name] = {"lejarat": m["lejarat"], "eredmeny": m["eredmeny"], "kuldve": sent,
                           "mert": time.strftime("%Y-%m-%d", time.gmtime(now))}
    return rows, messages, new_state


def _message(name, rule, m, d, due):
    """The text that goes to the Eldontendo thread as it is: accented Hungarian, because the
    outgoing gate stops Hungarian without its accents."""
    what = rule.get("cel", "?")
    how = rule.get("megujitas", "a megújítás módja nincs a nyilvántartásban")
    if due == "ervenytelen":
        head = "Érvénytelen titok: %s (%s). A mérés: %s." % (name, what, m["ok"])
    elif d is not None and d < 0:
        head = "Lejárt titok: %s, %s. Mire kell: %s." % (name, m["lejarat"], what)
    else:
        head = "Lejáró titok: %s, %s (%d nap múlva). Mire kell: %s." % (name, m["lejarat"], d, what)
    return head + " Megújítás: " + how + ". Az értéket ne írd csatornára."


def summary_line(rows):
    unknown = sum(r["eredmeny"] in ("ISMERETLEN",) for r in rows)
    not_measured = sum(r["eredmeny"] == "NEM_MERT" for r in rows)
    invalid = sum(r["eredmeny"] == "ERVENYTELEN" for r in rows)
    return "TITOK-LEJARAT: %d titok, ISMERETLEN %d, NEM MERT %d, ERVENYTELEN %d" % (len(rows), unknown, not_measured, invalid)


def table(rows):
    out = ["%-38s %-11s %-12s %-15s %s" % ("NEV", "FAJTA", "EREDMENY", "LEJARAT", "MERES")]
    for r in rows:
        exp = "-" if not r["lejarat"] else ("%s (%dn)" % (r["lejarat"], r["nap"]) if r["nap"] is not None else r["lejarat"])
        out.append("%-38s %-11s %-12s %-15s %s" % (r["nev"][:38], r["fajta"], r["eredmeny"], exp, r["ok"]))
    return "\n".join(out)
