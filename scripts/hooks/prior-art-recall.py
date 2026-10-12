#!/usr/bin/env python3
"""UserPromptSubmit hook: what we ALREADY said about the subject of this message.

WHY THIS EXISTS, measured 2026-09-02 07:36. The owner's words, after a morning in which he
had to remind me twice that something was already decided or already built: *"lehet kozos
kereso, de ez hogy oldja meg azt a problemat, hogy en emlekszem arra mit csinaltunk ti meg
nem? Eddig tulnyomo tobbsegben en figyelmeztettelek arra, hogy valamirol mar beszeltunk,
vagy mar kesz van."*

He is right, and a search tool alone does not fix it: a search I have to remember to run is
the same shape as every rule that was written down and skipped anyway. So this runs on the
INCOMING MESSAGE, before I can answer, and puts the prior rounds in front of me whether or
not it occurred to me to look.

WHAT IT SEARCHES: six stores. Four via /api/recall, in one call per keyword -- memories
(FTS), the daily log, kanban card titles and descriptions, and CARD COMMENTS. The comments
matter most of the four: a card's title is a name, but its comments carry the decision --
what was measured, what the owner said, why a thing was dropped. Then the Discord channel
cache, and SIXTH, the header comments of our own `scripts/*.sh`.

THE SIXTH WAS ADDED 2026-09-21, and its reason is a category the other five cannot cover:
all of them hold TEXT WE WROTE ABOUT WORK, while a CAPABILITY lives in the TOOL. That day
I asked the owner for a permission that `scripts/ticket-mail.sh` had held for three days,
and whose header says so outright. This hook fired on that message, searched five stores
and found nothing relevant -- which reads exactly like "never happened". See
script_headers() for the full measurement.

Card comments were added to /api/recall on 2026-09-02 (db.ts::recallSearch). Before that
this hook made a separate /api/kanban call and could only match titles; that older shape
is gone, and so is the caveat this header used to carry about comments being uncovered.

Keywording: FTS5 joins terms with an implicit AND, and the log match is a plain LIKE, so
handing over a whole sentence reliably returns nothing -- a zero that says more about the
question than about the world. Each keyword is therefore queried on its own, and a hit that
matches several keywords ranks above one that matches a single one.

Read-only and fail-open: any error, any slow API, and it prints nothing. A recall hook that
can block a prompt would be worse than the forgetting it treats.
"""

import json
import os
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

# the calling user's own dashboard token if handed out, else the shared one,
# loudly (acrovelIQ P0-1, plan 5.2; scripts/lib/dashboard_token.py). Defensive:
# a hook run from elsewhere falls back to the shared path instead of failing.
def _dashboard_token_file(root):
    try:
        import sys as _sys
        _lib = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")
        if _lib not in _sys.path:
            _sys.path.insert(0, _lib)
        from dashboard_token import token_file
        return token_file(root)
    except Exception:
        return os.path.join(root, "store", ".dashboard-token")

INSTALL_DIR = os.environ.get("CLAUDE_PROJECT_DIR", "/home/marveen/marveen")
TOKEN_FILE = _dashboard_token_file(INSTALL_DIR)
ENV_FILE = os.path.join(INSTALL_DIR, ".env")

MIN_PROMPT_LEN = 25      # below this there is nothing to key on
MIN_WORD_LEN = 5
MAX_KEYWORDS = 6         # each costs a request; four missed a settled answer on 2026-09-02
                         # because the ranking is by LENGTH and the decisive word was short
                         # ("statusz", "base"). Six is the cheapest fix that widens the net.
MAX_HITS = 8             # the whole block stays under ~1.5k characters
STEM_LEN = 7             # Hungarian suffixes: search a prefix, not the inflected form
SNIPPET = 150
TIMEOUT = 4

# Long Hungarian words that carry no subject. Short ones are already cut by MIN_WORD_LEN.
STOPWORDS = {
    "hogyan", "amikor", "amirol", "amiről", "arrol", "arról", "ezzel", "azzal", "ezert",
    "ezért", "azert", "azért", "mindig", "minden", "valami", "valamit", "semmi", "lehet",
    "kellene", "kellett", "tudom", "tudod", "tudja", "szerintem", "szerinted", "akkor",
    "mostmar", "jelenleg", "nagyon", "eleg", "elég", "megis", "mégis", "vagyis", "tehat",
    "tehát", "csinalunk", "csinálunk", "csinalni", "csinálni", "beszeltunk", "beszéltünk",
    "problema", "probléma", "problemat", "problémát", "kerdes", "kérdés", "kerdesem",
    "please", "should", "could", "would", "there", "their", "about", "which", "where",
    "megoldja", "megoldani", "emlekszem", "emlékszem", "emlekszel", "emlékszel",
    # Added 2026-09-03 while calibrating the outgoing brake. A nonsense control sentence
    # ("kek zsiraf szonyeg tekercseles teli holdkor") still produced EIGHT hits, every one
    # of them keyed on a generic process word below. A guard that fires on those fires on
    # nearly every question I ask -- and a guard that always fires teaches its reader to
    # step over it, which is worse than no guard. These words name the ACT of asking, never
    # its subject.
    "visszajelzest", "visszajelzés", "visszajelzes", "velemenyed", "véleményed",
    "velemeny", "vélemény", "egyaltalan", "egyáltalán", "valamikor", "kerdeserol",
    "kérdéséről", "kerdesre", "kérdésre", "kerdezni", "kérdezni", "javaslat", "javaslatot",
}


# WHY THE OUTGOING PATH GOT A BRAKE, AND THE PROMPT PATH DID NOT (measured 2026-09-03 13:44).
#
# The header above says this hook never blocks, and for a PROMPT that is still right: a
# blocked prompt kills the turn. An outgoing message is a different animal. Blocking it
# costs one round and nothing else -- the text is still in my hand, and I either send it
# again or drop the question.
#
# The measurement that forced this: at 13:44 I asked Balazs for a screenshot of the UNAS
# admin orders page. This hook ran on that very message and found memory 1289, which says
# he sent those screenshots on 2026-09-02 15:54 and that I had already written up the full
# inventory. The warning printed. The message went out anyway, because additionalContext
# arrives beside the send, not before it. Seventeen minutes earlier he had written that he
# does not know what to do to make us remember -- and this was the fourth repeat that day.
#
# So the guard was doing exactly what our own rule calls the worst kind: it spoke, and the
# operation went through beside it. A guard is proven by NOTHING HAPPENING, not by a line
# of text.
#
# THE BRAKE IS DELIBERATELY NARROW, on three axes at once:
#   1. outgoing messages only (never a prompt),
#   2. only when the text actually ASKS the human for something -- a report or a decision
#      being handed back does not need re-reading,
#   3. ONE SHOT per text: the same message sent a second time goes through. This is a speed
#      bump, not a wall. If I read the hits and still want to ask, nothing stands in the way.
# Without (3) a false positive would be a wall, and a wall on outgoing messages would be
# worse than the forgetting it treats -- the same argument the header makes for prompts.
ASK_MARKERS = (
    "?", "kerek ", "kerem ", "kerdes", "kuldd", "kuldj", "hozz letre", "letrehoznal",
    "jovahagy", "dontened", "dontenod", "eldontened", "mit gondolsz", "rad var",
    "szoljal", "szolj ha", "megnezned", "atkuldened", "adnal", "tudnal",
)
SEEN_FILE = os.path.join(INSTALL_DIR, "store", "prior-art-recall-seen.txt")


def asks_something(text):
    """True when the outgoing text puts a request or a question to the reader.

    Accent-folded, because the same sentence arrives written both ways and a guard that
    only sees one spelling is a guard with a hole in it -- the exact failure this whole
    file exists to treat.
    """
    folded = strip_accents(text).lower()
    return any(m in folded for m in ASK_MARKERS)


def already_warned(text):
    """One shot per message. Returns True if this exact text was stopped once already.

    Keyed on a hash of the text, not on time: re-sending the SAME message is the signal
    that I read the hits and decided anyway. A different message is a different decision
    and earns its own stop.
    """
    import hashlib
    key = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:32]
    try:
        with open(SEEN_FILE, "r", encoding="utf-8") as fh:
            if key in fh.read():
                return True
    except OSError:
        pass
    try:
        with open(SEEN_FILE, "a", encoding="utf-8") as fh:
            fh.write(key + "\n")
    except OSError:
        # Cannot record it, so cannot promise the second attempt gets through. Letting the
        # message go is the safe side: a wall we cannot open is worse than a missed stop.
        return True
    return False


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def env_value(key, fallback):
    try:
        with open(ENV_FILE, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'") or fallback
    except OSError:
        pass
    return fallback


def api_base():
    return "http://127.0.0.1:%s" % env_value("WEB_PORT", "3420")


def agent_id():
    return env_value("SERVICE_ID", env_value("MAIN_AGENT_ID", "acrobot"))


def token():
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError:
        return ""


def get(url, tok):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, ValueError, OSError):
        return None


def keywords(prompt):
    """The longest distinct content words, longest first: length is a cheap proxy for rarity."""
    words = re.findall(r"[\wÀ-ſ]+", prompt.lower(), flags=re.UNICODE)
    seen, out = set(), []
    for w in words:
        if len(w) < MIN_WORD_LEN or w.isdigit():
            continue
        if w in STOPWORDS or strip_accents(w) in STOPWORDS:
            continue
        base = strip_accents(w)
        if base in seen:
            continue
        seen.add(base)
        out.append(w)
    out.sort(key=len, reverse=True)
    return out[:MAX_KEYWORDS]


def headline(text):
    for line in (text or "").splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            parts = line.split(" -- ", 1)
            if len(parts) == 2 and len(parts[0]) <= 5 and ":" in parts[0]:
                return parts[1].strip()
            return line
    return ""


# ---------------------------------------------------------------------------
# THE FIFTH STORE: THE CHANNEL ITSELF.
#
# Measured 2026-09-03, twice in ninety minutes. I asked the owner to decide two things he had
# already decided (the long-description field; the separate image store). Both times I searched
# the four stores below, found nothing, and reported "it is nowhere recorded". Both times HE
# found the answer in ONE MINUTE, by scrolling the Discord thread -- and in the second case what
# he found was MY OWN reply saying "felvéve" (recorded), for a recording that never happened.
#
# The four stores are all places where I write things down AFTERWARDS. The channel is where the
# decision is SPOKEN, and it is the only store that does not depend on me remembering to fill it.
# That is exactly why it belongs here and not in a tool I have to remember to run: this hook's
# own header says a search you must remember to run is the same shape as a rule that was written
# down and skipped anyway. The tool (scripts/szal-keres.sh) exists since 12:30 that day, and by
# 13:05 I had already assigned work against a decided question without running it.
#
# Cost control: ONE fetch per thread per TEN MINUTES, cached on disk, so a burst of prompts pays
# for it once. Keyword matching happens in memory afterwards, so extra keywords are free here.
# Fail-open like everything else: no token, no network, bad JSON -> no channel rows, no output.
CHANNEL_CACHE = os.path.join(INSTALL_DIR, "store", ".recall-channel-cache.json")
CHANNEL_TTL = 600
CHANNEL_TIMEOUT = 4
# The threads where decisions actually land. Not all of them: each costs a request, and these
# three carry the owner's decisions. If a decision moves to another thread regularly, add it.
CHANNELS = [
    ("1538522302277353505", "fo csatorna"),
    ("1540270627926183997", "eldontendo"),
    ("1542865300565790850", "migracio"),
]


def discord_token():
    path = os.path.expanduser("~/.claude/channels/discord/.env")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("DISCORD_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def channel_rows():
    """[(label, author, ts, text)] from the decision threads, cached on disk for CHANNEL_TTL."""
    try:
        st = os.stat(CHANNEL_CACHE)
        if (os.times()[4] if False else __import__("time").time()) - st.st_mtime < CHANNEL_TTL:
            with open(CHANNEL_CACHE, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except (OSError, ValueError):
        pass
    tok = discord_token()
    if not tok:
        return []
    rows = []
    for chan, label in CHANNELS:
        url = "https://discord.com/api/v10/channels/%s/messages?limit=100" % chan
        # A USER-AGENT KOTELEZO. Merve 2026-09-03: ugyanaz a keres User-Agent NELKUL
        # HTTP 403, VELE 200. A curl magatol kuld egyet, az urllib nem -- ezert mukodott a
        # kezi proba (scripts/szal-keres.sh) es hasalt el csendben ez a hook az elso
        # valtozataban, ugyanazzal a tokennel. Egy 403 itt NEM jogosultsag-kerdes.
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": "Bot " + tok,
                "User-Agent": "AcroporaRecall (https://acropora.hu, 1.0)",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=CHANNEL_TIMEOUT) as r:
                batch = json.loads(r.read().decode("utf-8", "replace"))
        except (urllib.error.URLError, ValueError, OSError):
            continue
        if not isinstance(batch, list):
            continue
        for m in batch:
            text = (m.get("content") or "").replace("\n", " ")
            if not text.strip():
                continue
            rows.append([
                label,
                (m.get("author") or {}).get("username", "?"),
                (m.get("timestamp") or "")[:16].replace("T", " "),
                text,
                # P-017: the ids, so a candidate can be fetched again later
                # (GET /channels/<chan>/messages/<id>) -- the cache only ever
                # holds the last 100 per channel.
                chan,
                str(m.get("id") or ""),
            ])
    try:
        with open(CHANNEL_CACHE, "w", encoding="utf-8") as fh:
            json.dump(rows, fh)
    except OSError:
        pass
    return rows


def script_headers():
    """[(path, answers_line, folded_header)] for our own scripts -- the SIXTH store.

    WHY THIS EXISTS, measured 2026-09-21 13:31. I asked the owner to grant a Google
    permission for `ticket@acropora.hu`. His answer: *"egyutt allitottuk be a
    jogosultsagait a mult heten... vicc hogy most is ugy mondasz ki valamit, hogy nem
    nezel utana"*. He was right. `scripts/ticket-mail.sh` had been bound three days
    earlier at his own request, and its header states in as many words that the
    `gmail.send` scope was included ON PURPOSE so a second consent round would not be
    needed.

    THIS HOOK FIRED ON THAT MESSAGE and returned eight hits, none of them relevant --
    because every store it searched holds TEXT I WROTE ABOUT WORK: memory, daily log,
    card, comment, channel. A CAPABILITY lives in none of them. It lives in the tool,
    and the tool describes itself. So the more thoroughly we build something, the less
    likely the guard against re-asking is to find it.

    A confident answer from the wrong corpus reads exactly like "nothing on record",
    which reads exactly like "never happened". That is why this is a store and not a
    note telling me to remember to grep.

    SCOPE: the leading comment block of `scripts/*.sh` (the first 60 lines). That is
    where `# ANSWERS:` and the rationale live -- 117 scripts, ~3.5k comment lines in
    total, read once per invocation. Bodies are deliberately NOT searched: a variable
    name matching a keyword is noise, a header sentence is the claim.
    """
    out = []
    folder = os.path.join(INSTALL_DIR, "scripts")
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".sh"))
    except OSError:
        return out
    for name in names:
        try:
            with open(os.path.join(folder, name), encoding="utf-8", errors="replace") as fh:
                head = [next(fh, "") for _ in range(60)]
        except OSError:
            continue
        lines = [l.rstrip("\n") for l in head if l.startswith("#") and not l.startswith("#!")]
        if not lines:
            continue
        answers = ""
        for l in lines:
            if l.startswith("# ANSWERS:"):
                answers = l[len("# ANSWERS:"):].strip()
                break
        if not answers:
            answers = lines[0].lstrip("# ").strip()
        body = strip_accents(" ".join(l.lstrip("# ").strip() for l in lines)).lower()
        out.append(("scripts/%s" % name, answers, body))
    return out


_REF_TOKEN = re.compile(r"^[A-Za-z0-9_.:-]{1,40}$")
# P-017 (blind human labels, 2026-10-05): id(row) -> the stable reference of
# that hit, filled by collect(). A side table, so the row keeps its 4-element
# shape at every unpacking site. The shadow log gets it through `local`.
CANDIDATE_REFS = {}


def _ref(kind, ref=None, **extra):
    """Store kind plus ids, and only code-like tokens: an id that does not fit
    the pattern is dropped, never passed on as text."""
    out = {"ref_kind": kind}
    for k, v in (("ref", ref),) + tuple(extra.items()):
        v = "" if v is None else str(v)
        if _REF_TOKEN.match(v):
            out[k] = v
    return out


def collect(words, tok, agent):
    """key -> [score, label, text, order]. Score counts how many keywords found the same row."""
    hits = {}
    order = [0]
    CANDIDATE_REFS.clear()

    def bump(key, label, text, ref=None):
        row = hits.get(key)
        if row:
            row[0] += 1
        else:
            order[0] += 1
            hits[key] = [1, label, text, order[0]]
            if ref is not None:
                CANDIDATE_REFS[id(hits[key])] = ref

    for w in words:
        # HUNGARIAN SUFFIXES BREAK A DICTIONARY-FORM SEARCH, and the search side is where it
        # has to be fixed. The FTS match is a prefix (`token*`), so "menuponthoz*" never
        # reaches "menupont" -- the very word the reader meant. Measured 2026-09-02 on this
        # hook's own output: three of four keywords were suffixed forms that could not match.
        # Truncating to a stem-length prefix costs some precision and buys the match; the
        # multi-keyword ranking above filters the noise that comes back.
        # (Same family as nautilus's find that day: /galéria/ missed "galériából", because the
        # suffix rewrites the stem's last vowel too.)
        stem = w[:STEM_LEN] if len(w) > STEM_LEN else w
        q = urllib.parse.urlencode({"q": stem, "agent": agent, "limit": "5"})
        data = get("%s/api/recall?%s" % (api_base(), q), tok)
        if not isinstance(data, dict):
            continue
        for m in (data.get("memories") or [])[:5]:
            day = (m.get("created_label") or "")[:10]
            bump(
                "m%s" % m.get("id"),
                "emlek %s / %s / %s" % (m.get("id"), m.get("category") or "?", day),
                (m.get("content") or "").replace("\n", " "),
                _ref("emlek", m.get("id")),
            )
        for l in (data.get("logs") or [])[:5]:
            bump("l%s" % l.get("id"), "naplo %s" % (l.get("date") or "?"), headline(l.get("content")),
                 _ref("naplo", l.get("id")))
        for c in (data.get("cards") or [])[:5]:
            bump(
                "k%s" % c.get("id"),
                "kartya %s / %s" % (str(c.get("id"))[:8], c.get("status") or "?"),
                c.get("title") or "",
                _ref("kartya", c.get("id")),
            )
        for c in (data.get("comments") or [])[:5]:
            # The card's title is carried into the label: a comment without its card
            # is a sentence with no address, and the point here is recognition.
            bump(
                "c%s" % c.get("id"),
                "komment %s / %s" % (str(c.get("card_id"))[:8], (c.get("card_title") or "")[:40]),
                (c.get("content") or "").replace("\n", " "),
                _ref("komment", c.get("id"), ref_card=c.get("card_id")),
            )

    # THE CHANNEL, matched in memory against the same stems. Folded (accent- and case-blind),
    # because the owner writes without accents about half the time and the store does not.
    rows = channel_rows()
    if rows:
        for w in words:
            stem = strip_accents(w[:STEM_LEN] if len(w) > STEM_LEN else w).lower()
            if len(stem) < 4:
                continue
            for i, row in enumerate(rows):
                label, who, ts, text = row[:4]
                # an older 4-column cache (before P-017) carries no ids until it expires
                ids = row[4:6] if len(row) >= 6 else (None, None)
                if stem in strip_accents(text).lower():
                    bump("d%d" % i, "csatorna %s / %s / %s" % (label, who, ts), text,
                         _ref("csatorna", ids[1], ref_chat=ids[0]))

    # OUR OWN SCRIPTS -- see script_headers() for the measured case that added this store.
    # Matched on the same folded stems as the channel, for the same reason.
    for path, answers, body in script_headers():
        for w in words:
            stem = strip_accents(w[:STEM_LEN] if len(w) > STEM_LEN else w).lower()
            if len(stem) < 4:
                continue
            if stem in body:
                bump("s%s" % path, "eszkoz %s" % path, answers, _ref("eszkoz", os.path.basename(path)))
    return hits


# The same envelope ledger-capture.py reads: the ledger stores each inbound
# channel message under (chat_id, message_id), so that pair finds the text again.
_CHANNEL_RX = re.compile(
    r'<channel\s+source="plugin:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+"([^>]*)>(.*?)</channel>', re.DOTALL)
_PEER_RX = re.compile(r"msg_id:(\d{1,20})")
_PEER_BODY_RX = re.compile(r'<(?:trusted-peer|untrusted)\s+source="[^"]*">(.*?)</(?:trusted-peer|untrusted)>', re.DOTALL)


def _attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def query_ref(payload, outgoing):
    """P-017: where the QUERY can be found again, without its text.
      reply    outgoing: the reply tool's chat_id; the message id does not exist
               yet, so the ledger's outbound row is found by the keyed query_hash
               (shadow.py hashes the exact tool_input text, which the ledger stores)
      channel  inbound channel message: (q_chat, q_msg) as in conversation_log;
               the LAST envelope, the newest message of the turn
      peer     inter-agent message: q_msg is its msg_id in /api/messages
      other    none of these (terminal prompt, notification): hash only"""
    if outgoing:
        ti = payload.get("tool_input") or {}
        return _ref("reply", None, q_chat=ti.get("chat_id") if isinstance(ti, dict) else None), \
            (str(ti.get("text")) if isinstance(ti, dict) and ti.get("text") is not None else None)
    prompt = payload.get("prompt") or ""
    envs = list(_CHANNEL_RX.finditer(prompt))
    if envs:
        attrs = envs[-1].group(1)
        return _ref("channel", None, q_chat=_attr(attrs, "chat_id"), q_msg=_attr(attrs, "message_id"),
                    q_count=len(envs)), None
    peer = _PEER_RX.search(prompt)
    if peer and "trusted-peer" in prompt:
        return _ref("peer", None, q_msg=peer.group(1)), None
    # P-017: a class token, never text, so later "other" rows can be split by source
    head = prompt.lstrip()[:40]
    cls = ("stop_hook" if head.startswith("Stop hook") else "task_notif" if "task-notification" in prompt[:200]
           else "wakeup" if head.startswith(("PD-", "[Heartbeat", "SCHEDULED")) else "terminal")
    return _ref("other", q_class=cls), None


def _jev_shadow(prompt, rows, ranked, outgoing, payload=None):
    """D-005 HIDDEN shadow (PD-006, 2026-09-28): ask Jev, on the side, whether
    each candidate is relevant to the prompt. One query plus ONE candidate per
    job, never the conversation. Everything happens in a detached child that
    redacts first and refuses to call out unless the kill switch is on and the
    leak gate is green; this function only hands over and returns. It changes
    nothing that is shown or decided here, and any failure is swallowed."""
    try:
        sys.path.insert(0, os.path.join(INSTALL_DIR, "scripts", "jev"))
        import shadow
        shown = {id(r) for r in rows}
        # the shown rows plus up to three that ranked below the cut, so the
        # comparison covers both sides of our own choice
        cands = list(rows) + [r for r in ranked if id(r) not in shown][:3]
        # P-016 (ACD-013, 2026-09-28): ONE provider call per message with every
        # candidate, not one per hit; per-hit fan-out made up to 11 concurrent
        # calls and the slow tail. Each candidate still gets its own verdict.
        # P-017: every row carries WHERE its candidate and its query live
        # (store ids, message ids -- never text), so the blind two-reader
        # sample on 2026-10-05 can fetch both again. q_kind replaces the
        # generic ref_kind key for the query side.
        qref, exact = query_ref(payload or {}, outgoing)
        qref = {("q_kind" if k == "ref_kind" else k): v for k, v in qref.items()}
        shadow.submit_batch(prompt, [
            {"candidate": text or "",
             "local": dict({"score": score, "store": label.split()[0], "rank": rank,
                            "shown": id(r) in shown, "direction": "out" if outgoing else "in"},
                           **{k: v for k, v in CANDIDATE_REFS.get(id(r), {}).items() if k != "ref_kind"},
                           **qref)}
            for rank, r in enumerate(cands)
            for score, label, text, _ in [r]], query_exact=exact)
    except Exception:  # noqa: BLE001 -- a measurement must never touch the hook
        pass


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    # TWO ENTRY POINTS, and the second one is where the real gap was.
    #
    # UserPromptSubmit only sees a prompt that OPENS a turn. A channel message that lands
    # while I am already working reaches the model another way and never passes through a
    # hook -- measured 2026-09-02 09:52: Balázs wrote, the trace log stayed empty. On a busy
    # morning that is most of his messages, which is exactly the case this hook was built for.
    #
    # PreToolUse on the reply tools closes the other half: before a message goes OUT to him,
    # search on what I am about to say. That is the moment the old rule targets -- do not ask
    # something we already settled. It never blocks; it prints, and the text still goes.
    prompt = (payload.get("prompt") or "").strip()
    outgoing = False
    if not prompt:
        ti = payload.get("tool_input") or {}
        if isinstance(ti, dict):
            prompt = str(ti.get("text") or "").strip()
            outgoing = bool(prompt)
    if len(prompt) < MIN_PROMPT_LEN:
        return 0
    # Wake-up prompts carry no subject of their own: the real content arrives from another
    # hook further down. Measured 2026-09-02 07:42, first live firing -- an inbox wake-up
    # keyed on "messages, pending, wakeup, inbox" and pulled five rows about the message
    # queue itself. Recall on those words costs tokens and answers nothing.
    # The inbox nudge ("[Inbox] Ha fent uj bejovo blokk van...", src/web/inbox-nudge-watcher.ts)
    # is the same case: its own words, not the message, which inbox-drain.py adds as context.
    # Measured 2026-09-28 by nautilus: these rows fed the D-005 shadow a pair that never
    # happened (nudge words as the query, candidates recalled on "bejovo, blokk, dolgozd").
    # Same gap, nautilus 2026-09-28: a background-task notice arrives as "[SYSTEM NOTIFICATION
    # - NOT USER INPUT] <task-notification>...", which does not contain "[SYSTEM:"; a Stop hook
    # echo arrives as "Stop hook feedback:". Both carry no subject of their own.
    if any(m in prompt for m in ("inbox-wakeup", "[SYSTEM:", "scheduled-task", "[SYSTEM NOTIFICATION",
                                 "<task-notification>")) \
            or prompt.startswith(("[Inbox]", "Stop hook feedback:")):
        return 0

    # KEY ON THE MESSAGE, NOT ON ITS ENVELOPE (nautilus, 2026-09-28). A channel message
    # arrives wrapped in <channel source=... chat_id=... message_id=... user=...>, and
    # keywords() picked those attribute names: every inbound Discord message recalled on
    # "message_id, channel, discord, chat_id", a 13-word question lost 4 of its 6 keyword
    # slots to them, and the D-005 shadow logged pairs keyed on the envelope. Use the inner
    # text only; a reply too short to key on ("Mehet", "2") gets no recall at all.
    if not outgoing:
        inner = [m.group(2).strip() for m in _CHANNEL_RX.finditer(prompt)]
        # The same for an agent message (nautilus, 2026-09-28): the "[Uzenet @x-tol -- trusted
        # team member, msg_id:N]" wrapper and the "--- a kuldes mert ideje ..." footer took the
        # keyword slots ("acrobot, trusted, szkript, uzenet, member, msg_id").
        if not inner:
            inner = [re.split(r"\n\s*--- a kuldes mert ideje", m.group(1), maxsplit=1)[0].strip()
                     for m in _PEER_BODY_RX.finditer(prompt)]
        if inner:
            prompt = "\n".join(t for t in inner if t)
            if len(prompt) < MIN_PROMPT_LEN:
                return 0

    tok = token()
    if not tok:
        return 0
    words = keywords(prompt)
    if not words:
        return 0

    hits = collect(words, tok, agent_id())
    if not hits:
        return 0

    # A row found by only ONE keyword is mostly noise once a multi-keyword hit exists.
    # Measured on a real message: the word "acropora" alone dragged in three unrelated
    # memories, while the card that actually answered the question matched two keywords.
    ranked = sorted(hits.values(), key=lambda r: (-r[0], r[3]))
    multi = [r for r in ranked if r[0] > 1]
    single = [r for r in ranked if r[0] == 1]
    rows = (multi + single[:3]) if multi else single[:4]
    rows = rows[:MAX_HITS]

    # A ONE-LINE TRACE, so "the hook runs" is measurable and not a belief.
    # Why it earns its keep: this hook only sees prompts that OPEN a turn. A channel
    # message that lands mid-turn reaches the model another way and never passes through
    # here -- so on a busy morning it can be silent for hours while looking installed.
    # The log makes that visible: no line means it did not run, not that it found nothing.
    if outgoing:
        out = [
            "MIELOTT EZ AZ UZENET KIMEGY: errol mar volt szo (visszakereses a KULDENDO szoveg",
            "kulcsszavaira: %s). Ha barmelyik talalat ugyanarrol szol," % ", ".join(words),
            "olvasd el, mielott kerdezel -- egy mar eldontott kerdes ujra feltevese ket helyen",
            "kerul: egy korodbe es az o idejebe. HAT tarolot nez: emlek, naplo, kartya, komment, csatorna, es a SAJAT SZKRIPTJEINK fejlecei.",
            "",
        ]
    else:
        out = [
            "ERROL MAR VOLT SZO (automatikus visszakereses a most erkezett uzenet kulcsszavaira:",
            "%s). A talalat NEM azt jelenti, hogy idetartozik -- de ha igen, OLVASD EL," % ", ".join(words),
            "mielott valaszolsz vagy kerdezel. HAT tarolot nez: emlek, naplo, kartya, komment, csatorna, es a SAJAT SZKRIPTJEINK fejlecei.",
            "",
        ]
    for score, label, text, _ in rows:
        mark = "!" if score > 1 else " "
        out.append("%s [%s] %s" % (mark, label, (text or "")[:SNIPPET]))
    out.append("")
    text = "\n".join(out) + "\n"
    strong = any(score > 1 for score, _, _, _ in rows)
    brake = bool(outgoing and strong and asks_something(prompt) and not already_warned(prompt))
    _jev_shadow(prompt, rows, ranked, outgoing, payload)
    # Columns 4-6 added 2026-09-28 (D-005 baseline): the characters actually put
    # into context, the direction, and whether the brake fired. The first three
    # columns keep their old meaning, so older readers of this file still work.
    try:
        with open(os.path.join(INSTALL_DIR, "store", "prior-art-recall.log"), "a",
                  encoding="utf-8") as fh:
            fh.write("%s\t%s\t%d\t%d\t%s\t%d\n" % (
                __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                ",".join(words), len(rows), len(text),
                "out" if outgoing else "in", 1 if brake else 0))
    except OSError:
        pass
    if outgoing:
        # A PreToolUse hook's plain stdout does NOT reach the model -- measured 2026-09-02
        # 09:57: the trace log proved the hook ran on two outgoing messages, and neither
        # printed a single line into my turn. A hook that runs and cannot be read is exactly
        # the "green light that proves nothing" we collect: it looks installed and defends
        # nothing. The structured form is what gets through.
        # The brake. See the ASK_MARKERS comment above for why it is this narrow and why
        # it lets the second attempt through.
        # THE THIRD CONDITION, and calibration is what put it here. A nonsense control
        # sentence still drew eight hits after the stopword pass -- but every one of them
        # matched a SINGLE keyword (score 1, no "!"), while the real 13:44 failure had all
        # eight marked. One shared word is coincidence; two is a subject. Stopping on
        # score-1 noise would make this brake fire on nearly every question, and a brake
        # that always fires is one everybody learns to step over.
        if brake:
            sys.stdout.write(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": (
                        "MEGALLITVA EGYSZER, MERT EZ AZ UZENET KER VALAMIT, ES A TEMAJARA "
                        "VAN MAR TALALAT.\n\n" + text +
                        "\nOlvasd el a talalatokat. Ha valamelyik mar megvalaszolja, amit "
                        "kerdezni akartal, ird at az uzenetet. Ha nem, kuldd el UGYANEZT a "
                        "szoveget megegyszer: masodszorra atmegy, es nem kell semmit "
                        "megkerulnod."
                    ),
                }
            }, ensure_ascii=False) + "\n")
            return 0
        sys.stdout.write(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": text,
            }
        }, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # fail-open: a recall hook must never block a prompt
