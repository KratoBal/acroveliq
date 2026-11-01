#!/usr/bin/env python3
# ANSWERS: Mi marad egy szovegbol, miutan a nevek, cimek, osszegek, azonositok es titkok helyere helyorzo kerult (D-005, PD-006)?
"""Local, semantic-preserving redaction for the D-005 Jev shadow (PD-006:
P-014 + P-015).

This module is the privacy boundary: nothing may reach the TypeSafe client
unless it went through redact() first. Two layers:

  A. known entities -- exact match after normalisation (casefold, accents
     stripped, common homoglyphs folded) against a local list that never
     leaves the machine (store/jev-known-entities.json, gitignored);
  B. property-based patterns -- email, phone, IBAN, tax id, URL secrets,
     API keys, opaque identifiers, amounts, dates, addresses, and
     person-shaped capitalised word runs.

Letter classes are written out explicitly ([^\\W\\d_] with re.UNICODE)
instead of relying on ASCII \\w or \\b assumptions: on this machine grep -P
misses accented letters silently, and a redactor that inherits that habit
leaks exactly the Hungarian names it exists to hide.

Placeholders are stable within one call (<PERSON_1> twice for the same
person) so coreference survives. REDACTION_VERSION must change whenever
behaviour changes; the leak suite is bound to it.
"""
import contextlib
import hashlib
import json
import os
import re
import unicodedata

REDACTION_VERSION = "r16"

_HERE = os.path.dirname(os.path.abspath(__file__))
KNOWN_ENTITIES_PATH = os.environ.get(
    "JEV_KNOWN_ENTITIES", "/home/marveen/marveen/store/jev-known-entities.json")
PRESERVE_PATH = os.path.join(_HERE, "preserve-terms.json")
COMMON_WORDS_PATH = os.environ.get(
    "JEV_COMMON_WORDS", "/home/marveen/marveen/store/jev-common-words.txt")
GIVEN_NAMES_PATH = os.path.join(_HERE, "hu-names.txt")
EN_OPENERS_PATH = os.path.join(_HERE, "en-openers.txt")

# Latin letter lookalikes that have been seen in our own text (Cyrillic and
# Greek). Folding them lets the known-entity layer match a disguised name;
# the property layer does not need it because Cyrillic capitals are letters.
_HOMOGLYPHS = str.maketrans({
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x",
    "і": "i", "ј": "j", "т": "t", "к": "k", "м": "m", "н": "h", "в": "b",
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O",
    "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I", "Ј": "J",
    "ο": "o", "α": "a", "ε": "e", "ι": "i", "ν": "v", "ρ": "p", "τ": "t",
    "Α": "A", "Β": "B", "Ε": "E", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
    "Ο": "O", "Ρ": "P", "Τ": "T", "Χ": "X", "Υ": "Y", "Ζ": "Z", "Η": "H",
})

L = r"[^\W\d_]"          # any Unicode letter
UP = r"(?:[A-ZÁÉÍÓÖŐÚÜŰ]|[^\W\d_a-záéíóöőúüű])"  # uppercase-ish, incl. non-Latin capitals
LO = r"[^\W\d_A-ZÁÉÍÓÖŐÚÜŰ]"                        # lowercase-ish letter


def fold(s):
    """casefold + strip accents + fold homoglyphs; used only for matching."""
    s = unicodedata.normalize("NFKC", s).translate(_HOMOGLYPHS)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().casefold()


def _load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _load_given_names():
    try:
        with open(GIVEN_NAMES_PATH, encoding="utf-8") as f:
            return {fold(x) for line in f if not line.lstrip().startswith("#")
                    for x in line.split()}
    except OSError:
        return set()


PRESERVE = {fold(x) for x in _load_json(PRESERVE_PATH, [])}
GIVEN_NAMES = _load_given_names()


def _load_common():
    try:
        with open(COMMON_WORDS_PATH, encoding="utf-8") as f:
            return {w.strip() for w in f if w.strip()}
    except OSError:
        return set()


COMMON = _load_common()

# Kinds that are never allowed through in any form, whatever the caller asks.
ALWAYS_MASKED = {"SECRET", "IBAN", "TAX_ID", "BANK_ACCOUNT"}

# PD-006, NARROWED FOR ONE TASK (Balázs, 2026-10-01 04:38 UTC, Eldöntendő
# thread 1555039853165412364): the missing-invoice pairing may see business
# data, the amount, the date, the invoice number and the company name. Only
# these kinds can ever be kept; a personal kind (name, e-mail, phone, address,
# bank account, tax number) cannot be asked for, whoever asks.
KEEPABLE = frozenset({"AMOUNT", "DATE", "ID", "ORG"})
# KNOWN-ENTITY HITS THE PAIRING MAY LET THROUGH (acrobot 25519, the list is
# his): the ORG entries are customer company names, the same kind of data the
# pairing already shows as an invoice issuer. Only ORG can be allowed, and only
# with a legal form in the hit or right after it (acrobot 25525): the ORG
# digests are built from EVERY customer's display name, a private customer's
# "Kovács János" included, and that must still stop the call. A sole trader's
# (ev., e.v., egyéni vállalkozó) never passes: that is a person's name.
KNOWN_ALLOWABLE = frozenset({"ORG"})
PAIRING_KNOWN_ALLOW = frozenset({"ORG"})
_LEGAL_FORM = r"(?:kft|bt|zrt|nyrt|kkt|gmbh|ltd|llc|inc|s\.r\.o)\.?"
_FORM_IN_HIT = re.compile(r"(?i)(?<![^\W_])" + _LEGAL_FORM + r"\s*$")
_FORM_AFTER_HIT = re.compile(r"(?i)[ \t]*,?[ \t]*" + _LEGAL_FORM + r"(?![^\W_])")
_SOLE_TRADER = re.compile(r"(?i)(?<![^\W_])(?:e\.?\s?v\.?|egyéni\s+vállalkozó)(?![^\W_])")

# What the pairing task keeps. CAPS, PROPER and DOMAIN stay masked on purpose:
# an all-caps or unknown proper name may be a person, and a company only comes
# through with its legal form (ORG).
PAIRING_KEEP = frozenset({"AMOUNT", "DATE", "ID", "ORG"})
# A company name keeps its words only with one of these legal forms at its end.
# The sole trader (ev., e.v.) is NOT here: that name is a person's name.
_COMPANY_FORM_END = re.compile(r"(?i)(?:^|[\s.,])(kft|zrt|bt|kkt|nyrt|gmbh|ltd)\.?\s*$")
# What a company name may contain and still be kept whole (acrobot 25498: the
# name detector read "Parkl Digital Technologies" as a person, and every issuer
# became "<PERSON_1> Kft.", indistinguishable on the candidate list).
_NAME_KINDS_IN_COMPANY = frozenset({"PERSON", "PROPER", "CAPS"})

# ---------------------------------------------------------------- patterns
# Order matters: the most specific, most dangerous shapes first, so that a
# token inside a URL is taken as SECRET before the URL rule sees it.
_P = []


def _add(kind, pattern, flags=0):
    _P.append((kind, re.compile(pattern, flags | re.UNICODE)))


_NB = r"(?<![0-9A-Za-z])"   # no alnum on the left
_NA = r"(?![0-9A-Za-z])"    # no alnum on the right

# secrets: bearer values, vendor key prefixes, key=value assignments, JWTs
_add("SECRET", r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}")
_add("SECRET", r"\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abpors]|AKIA|AIza|glpat)[-_A-Za-z0-9]{10,}")
_add("SECRET", r"(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/=]{20,}(?:\s+\S+)?")
_add("SECRET", r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)")
_add("SECRET", r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
_add("SECRET", r"(?i)(?<=[?&;\s])(?:token|access_token|api[_-]?key|apikey|key|secret|password|passwd|pwd|signature|sig|auth|code|X-Amz-Signature|X-Amz-Credential)=[^\s&#]+")
_add("SECRET", r"(?i)(?<![^\W_])(?:token|api[_-]?key|secret|password|passwd|pass|pw|pwd|jelszó|jelszo|jelszava|kulcs)\s*[:=]\s*(?P<v>\S{4,})")
_add("SECRET", r"(?i)(?<![^\W_])(?:jelszó|jelszo|jelszava|password|pw|pass|pin)(?:[ \t]+[^\W\d_]+){0,4}?[ \t]*(?::|pedig|=|is|az|a)[ \t]+(?P<v>(?=\S*[\d!_#$%&*])\S{4,}?)(?=[,;.]?(?:\s|$))")
_add("SECRET", r"\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|KEY|PASS|PWD|AUTH|CREDENTIALS?)[A-Z0-9_]*\s*=\s*(?P<v>\S+)")
_add("SECRET", r"(?<=://)[^\s/@:]*:[^\s/@]+(?=@)")
_add("SECRET", r"(?i)(?<![^\W_])(?:kapukód|kapukod|ajtókód|ajtokod|riasztókód|riasztokod|kód|kod|pin|pin-kód|cvc|cvv|cvc2)\s*[:=]?\s*(?P<v>\d{3,8})(?!\d)")
_add("SECRET", r"(?i)(?<![^\W_])(?:lejárat|lejarat|exp|érvényes|ervenyes)\s*[:=]?\s*(?P<v>\d{2}/\d{2,4})")
_add("SECRET", r'"(?:api[_-]?key|token|secret|password|access_token|client_secret)"\s*:\s*(?P<v>"[^"]+")')
_add("SECRET", _NB + r"(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}" + _NA)

# URL: keep scheme, host and path; drop query and fragment entirely
_add("URL_QUERY", r"(?<=[A-Za-z0-9/._~-])[?#][^\s<>\"')\]]+")

_add("EMAIL", r"(?i)(?<![^\W_])[^\W_][\w.-]*(?:\s+pont\s+[\w-]+)*\s+(?:kukac|at|\(at\)|\[at\])\s+[\w-]+(?:\s+pont\s+[\w-]+)+")
_add("EMAIL", r"(?<![\w.@-])[\w.-]+@(?=[\s,;:)]|$)")
_add("DOMAIN", r"(?i)(?<![\w@.-])(?:[a-z0-9-]+\.)+(?:hu|com|de|at|eu|org|net|io|sk|ro|cz|uk|nl|shop|store)\b")
_add("EMAIL", r"[^\s@<>()\[\],;:\"']+@[^\s@<>()\[\],;:\"']+\.[^\W\d_]{2,}")
# r13 (nautilus, 2026-10-01): an address whose domain the PDF broke across a line
# ("szerviz.hun@atlascopco." and "com" on the next line), or a bare "user@host":
# the patterns above need a whole domain, so the local part went out readable.
# Measured on the 538 DEV letters of the letter classifier: exactly this one.
# A word character must touch the @ on both sides: "@@TAI$" and "x @ y" stay.
# r14: the host starts with a letter (a "pass@10.0.4.12" URL credential stays the SECRET
# pattern's), and no trailing dot is taken: a sentence's full stop stays outside,
# and the leftover "." of a broken domain shows nothing.
_add("EMAIL", r"(?<![\w.@-])[\w.+-]*\w@[^\W\d_][\w-]*(?:\.[\w-]+)*(?![\w@-])")

_add("IBAN", r"(?i)\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){3,7}(?:[ -]?[A-Z0-9]{1,3})?\b")
_add("BANK_ACCOUNT", _NB + r"\d{8}-\d{8}(?:-\d{8})?" + _NA)
_add("TAX_ID", _NB + r"\d{8}-\d-\d{2}" + _NA)
_add("TAX_ID", r"(?i)(?:adóazonosító(?: jel)?|adoazonosito(?: jel)?|adószám|adoszam|taj(?:\s*-?\s*(?:szám|szam))?)\s*[:#]?\s*(?P<v>\d[\d -]{7,13}\d)")

_add("PHONE", r"(?:(?<![\w+])\+|(?<![\w\d])00)\d{2}(?:[\s/().-]*\d){8,11}" + _NA)
_add("PHONE", _NB + r"06(?:[\s/().-]*\d){8,9}" + _NA)
_add("PHONE", _NB + r"(?:1|20|21|30|31|50|70)[/-]\d{3}[- ]?\d{3,4}" + _NA)
# spoken digits, alone or mixed with figures ("nullahat-harmincas, het-het-egy 04 58")
_DW = r"(?:nulla\w*|egy|kettő|ketto|két|ket|három|harom|négy|negy|öt|ot|hat|hét|het|nyolc|kilenc|tíz\w*|tiz\w*|húsz\w*|husz\w*|harminc\w*|negyven\w*|ötven\w*|otven\w*|hatvan\w*|hetven\w*|nyolcvan\w*|kilencven\w*|száz\w*|szaz\w*|\d{1,4})"
_add("PHONE", r"(?i)(?<![^\W_])(?=(?:\d{1,4}[\s,-]+)*[^\W\d_])" + _DW + r"(?:[\s,-]+" + _DW + r"){3,}(?![^\W_])")
# dictated numbers: compound Hungarian number words ("négyszáztizenkettő")
_NR = r"(?:nulla|egy|kettő|ketto|két|ket|három|harom|négy|negy|öt|ot|hat|hét|het|nyolc|kilenc|tíz|tiz|tizen|húsz|husz|huszon|harminc|negyven|ötven|otven|hatvan|hetven|nyolcvan|kilencven|száz|szaz|ezer|első|elso|máso|maso|harma|negye|ötö|oto|hato|hete|nyolca|kilence|tize|husza|harminca)"
_NUMW = r"(?:" + _NR + r"){1,6}(?:dik|edik|adik|ödik|odik|dikán|dikén|edikén|adikán|ödikén|kor|akor|ekor|órakor|as|es|ös|os|án|én|a|e|t|at|et|öt)?"
_add("PHONE", r"(?i)(?<![^\W_])" + _NUMW + r"(?:[\s,-]+" + _NUMW + r"){2,}(?![^\W_])")
_add("PHONE", r"(?<![\d)])\(\d{1,2}\)\s*\d{3}[-\s]?\d{3,4}(?!\d)")
# three or more short digit groups: card numbers, TAJ, split phone numbers
_add("ID", _NB + r"\d{2,4}(?:[ .]\d{2,4}){2,}" + _NA)

_add("ID", r"\bc[a-z0-9]{24}\b")                      # cuid record ids
# prefixed ULIDs (Medusa sc_, prod_, variant_...): the underscore defeats \b (barracuda r9 read, 2026-09-28)
_add("ID", r"(?<![\w-])[a-z]{2,12}_[0-9A-Za-z]{16,}(?![\w-])")
_add("ID", r"\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z][a-z0-9]*[a-z])[a-z0-9]{20,}\b")   # coolify-style ids
_add("ID", r"\b(?=[A-Z0-9-]*\d)[A-Z][A-Z0-9]{1,5}(?:-[A-Z0-9]{1,6}){1,4}\b")
_add("ID", r"\b[A-Z0-9]{2,4}/[A-Z0-9]{2,4}(?:/[A-Z0-9]{2,4})?\b")
# r15 (nautilus, 2026-10-15; murena's finding, 30893): an IPv4 address at the end of a sentence
# ("a 10.0.2.4. címen") went out readable: the closing (?![\d.]) refused the full stop, so the
# address did not match at all, and a sentence-final "10.0.2.4:8080." lost its port. A dot may
# follow now, only not a dot and a digit (a fifth group, "1.2.3.4.5", is still no address).
_add("ID", r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?!\d|\.\d)")
_add("ID", r"(?i)(?<![\w:])(?=[0-9a-f:]*(?:::|[a-f]))[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])")
_add("ID", r"(?<![\w-])(?=[\w-]*\d[\w-]*\d[\w-]*\d)(?=[\w-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?![\w-])")
_add("ID", r"(?<![\w-])(?=\w*\d\w*\d\w*\d)(?=\w*[A-Za-z]\w*[A-Za-z])[A-Za-z0-9]{6,}(?![\w-])")
_add("ID", r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
_add("ID", r"\b[A-Z]{1,6}-(?:19|20)\d{2}[-/]\d{1,8}\b")
_add("ID", r"\b[A-Z]{2,6}[-/]?\d{5,}\b")
_add("ID", r"\b(?:[A-Z]{1,6}-){1,3}[A-Z]*\d{3,}\b")
_add("ID", _NB + r"\d{5,}" + _NA)
_add("ID", r"(?i)\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b")
_add("ID", r"(?i)(?<![^\W\d_])(?:rendelés|rendeles|számla|szamla|ticket|hibajegy|munkalap|megrendelés|megrendeles|order|invoice|eszköz|eszkoz|asset|leltári szám|leltari szam|sorozatszám|sorozatszam|serial)(?:szám|szam)?(?:\s+száma|\s+szama)?\s*[:#]?\s*(?P<v>(?=\S*\d)[A-Za-z0-9/-]{4,})")

_add("AMOUNT", r"(?i)(?<![\w])(?:\d{1,3}(?:[ .  ]\d{3})+|\d+)(?:[.,]\d+)?(?:,-)?\s*(?:e|ezer|k|m|millió|millio|milliárd|milliard)?\.?\s*(?:Ft|HUF|forint|EUR|euró|euro|€|USD|dollár|dollar|\$)(?:-?[^\W\d_]+)?(?!\w)")
_add("AMOUNT", r"(?<![\d.,])\d{1,3}(?:\.\d{3})+(?:,\d+)?(?!\d|\.\d)")   # 22.500: Hungarian thousands
# currency-less prices (barracuda r9 read, 2026-09-28): "30 ezer", "13 800" with a (narrow) no-break space
_add("AMOUNT", r"(?i)(?<![\w.,])\d+(?:[.,]\d+)?\s*(?:ezer|millió|millio|milliárd|milliard)(?:[^\W\d_]*)(?![\w])")
_add("AMOUNT", r"(?<![\d.,])\d{1,3}(?:[\u00a0\u202f ]\d{3})+(?![\d])")
_add("AMOUNT", r"(?i)(?:€|\$|EUR|USD|HUF)\s?\d[\d ., ]*\d")

_MONTHS = r"(?:január|február|március|április|május|június|július|augusztus|szeptember|október|november|december|januar|februar|marcius|aprilis|majus|junius|julius|oktober|jan|febr|márc|marc|ápr|apr|máj|maj|jún|jun|júl|jul|aug|szept|okt|nov|dec)\.?"
_add("DATE", r"\b(?:19|20)\d{2}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2}\.?")
_add("DATE", r"(?i)\b(?:(?:19|20)\d{2}\.?\s+)?" + _MONTHS + r"\s+\d{1,2}(?:\.|-(?:[a-zé]+))?(?!\d)")
_add("DATE", r"\b\d{1,2}[./]\d{1,2}[./](?:19|20)\d{2}\b")
_add("DATE", r"(?i)(?<![^\W_])(?:\d{1,2}|" + _NUMW + r")\s*(?:óra|ora)(?:\s*(?:\d{1,2}|" + _NUMW + r")(?:\s*perc)?)?(?:-?kor|kor)?(?![^\W_])")
_add("DATE", r"(?i)(?<![^\W_])(?:" + _NR + r"){1,3}(?:kor|akor|ekor|órakor|orakor)(?![^\W_])")
_add("DATE", r"(?i)(?<![^\W_])" + _MONTHS + r"\s+(?:" + _NR + r"){1,4}(?:dik|edik|adik|ödik|odik)?(?:án|én|an|en|a|e|ától|étől|áig|éig|i)?(?![^\W_])")
_add("DATE", r"(?i)(?<![\d:.])(?:[01]?\d|2[0-3])[:.][0-5]\d(?!\.\d{1,2}\.\d)(?:[:.][0-5]\d)?(?:\s?(?:am|pm|h|óra|ora)(?![^\W_]))?(?![\d])")
_add("DATE", r"(?i)\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)?,?\s*(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s*(?:19|20)\d{2}")
_add("DATE", r"(?<![\d-])(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?![\d-])")
_add("DATE", r"(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]x")
_add("DATE", r"(?<![\d.])(?:0?[1-9]|1[0-2])\.\s?(?:0?[1-9]|[12]\d|3[01])\.(?!\d)")

_STREET = r"(?:utca|u\.|sugárút|sgt\.|sugarut|út|útja|körút|krt\.|tér|tere|köz|sor|sétány|fasor|rakpart|dűlő|lakótelep|ltp\.|park|liget|lejtő|lépcső|ut|utja|korut|ter|dulo|setany)"
_WORDSEQ = r"(?:" + UP + L + r"*\.?(?:[ -]" + UP + L + r"*\.?){0,3})"
_add("ADDRESS", r"(?:\b\d{4}\s+" + _WORDSEQ + r",?\s+)?(?:" + _WORDSEQ + r"|\d+\.)\s+" + _STREET + r"\s+\d+(?:[/-]?[A-Za-z]\b)?(?:[/-]\d+(?:[/-]?[A-Za-z]\b)?)?\.?(?:,?\s*(?:\d+\.\s*(?:em\.|emelet)|fszt\.?|[IVX]+\.\s*em\.?)(?:\s*\d+\.?)?(?:\s*ajtó)?)?")
_add("ADDRESS", r"\b\d{4}\s+" + UP + LO + r"{2,}(?:[ -]" + UP + LO + r"+)?(?=,|\s+" + UP + ")")
_add("ADDRESS", r"(?i)\bpf\.?\s*\d{1,5}\b")
_add("ADDRESS", r"(?i)\bhrsz\.?\s*:?\s*\d[\d/]*")
_add("ADDRESS", r"(?i)\d[\d/]*\s+hrsz\.?")
_add("ADDRESS", r"(?i)(?<![^\W_])(?:[^\W\d_]{3,}\s+){1,2}(?:utca|út|ut|tér|ter|körút|korut|köz|koz|sor|fasor|rakpart|sétány|setany)\s+" + _NUMW + r"(?![^\W_])")
_add("ADDRESS", r"(?i)(?<![^\W_])(?:[IVX]{1,4}/\d{1,3}|(?:fszt|fsz|földszint|foldszint|em|emelet|ajtó|ajto|lph|lépcsőház)\.?\s*\d{1,3}\.?)(?![\w/])")
_add("ADDRESS", r"(?i)(?<![^\W_])[^\W\d_]{3,}(?:\s+[^\W\d_]{3,})?\s+(?:u\.?|utca|út|ut|tér|ter|krt\.?|körút|korut|köz|koz|sor|fasor|rakpart|sétány|setany)\s+\d+(?:[/-]?[a-z])?\b")
_add("ADDRESS", r"(?i)\b(?:[IVX]{1,5}|[1-9]|1\d|2[0-3])\.\s*(?:kerület|kerulet|ker\.)")

# Person-shaped: honorific + name, or a run of 2..4 capitalised words
_HON = r"(?:dr\.|Dr\.|ifj\.|id\.|özv\.|prof\.|Prof\.|Mr\.|Mrs\.|Ms\.)"
_NAMEWORD = UP + LO + r"+(?:-" + UP + LO + r"+)?"
_add("PERSON", _HON + r"[ \t]+" + _NAMEWORD + r"(?:[ \t]+" + _NAMEWORD + r"){0,3}")
_add("PERSON", r"(?<![\w-])" + _NAMEWORD + r"(?:[ \t]+" + _NAMEWORD + r"){1,3}(?:né)?(?![\w])")
# "Hegedus, Istvan" (surname, given name) and ALL-CAPS signatures
_add("PERSON", r"(?<![\w-])" + _NAMEWORD + r",[ \t]+" + _NAMEWORD + r"(?![\w])")
_add("CAPS", r"(?<![\w-])[A-ZÁÉÍÓÖŐÚÜŰ]{2,}(?:-[A-ZÁÉÍÓÖŐÚÜŰ]{2,})?(?:[ \t]+[A-ZÁÉÍÓÖŐÚÜŰ]{2,}){1,3}(?![\w])")
# mentions and handles
_add("HANDLE", r"(?<![\w@])@[\w.-]{2,}")
_add("HANDLE", r"(?<=\s)[a-z0-9._-]+@[a-z0-9-]+(?:\.local|\.lan)?(?=\s|$)")
# company: one to four words before a company-form suffix, any case
# A number may stand only as the LAST word before the legal form ("Tisza 97
# Kft.", "B-O 2001 Kft.": the number used to break the match, and the name came
# out as "<PROPER_1> 97 Kft.", acrobot 25517). Not anywhere in the name: then
# "Kovács János 45000 FoxPost Kft." would be one ORG span, the amount would go
# with it, and the pairing's company rule would keep the person's name.
_add("ORG", r"(?i)(?<![^\W_])(?:[^\W\d_][\w&.-]*[ \t]+){0,3}[^\W\d_][\w&.-]*(?:[ \t]+\d[\w&.-]*)?[ \t]+(?:kft|bt|zrt|nyrt|kkt|ev|e\.v|gmbh|ltd|llc|inc|s\.r\.o)\.?(?=[\s,;:.!?)-]|$)")


class RedactionError(Exception):
    pass


_TOKEN = re.compile(r"[^\W_]+(?:['.][^\W_]+)*", re.UNICODE)
_KNOWN_CACHE = {}


def known_key(tokens):
    """The normalised form an entity is stored and looked up under."""
    return " ".join(tokens)


def entity_tokens(value):
    return [fold(t) for t in _TOKEN.findall(unicodedata.normalize("NFC", value))]


def _digest(salt, key):
    return hashlib.blake2b(key.encode(), key=salt, digest_size=12).hexdigest()


def write_known_file(entries, path, salt=None):
    """entries: iterable of (kind, value). Writes ONLY keyed digests: the
    file never holds a name, and the salt makes a dictionary attack against
    a copied file require the salt too (it sits next to it, 0600)."""
    salt = salt or os.urandom(16)
    table, maxlen = {}, 1
    for kind, value in entries:
        toks = entity_tokens(value)
        if not toks:
            continue
        table[_digest(salt, known_key(toks))] = kind.upper()
        maxlen = max(maxlen, len(toks))
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"format": "hashed-v1", "salt": salt.hex(), "max_tokens": min(maxlen, 6),
                   "digests": table}, f)
    os.replace(tmp, path)
    return len(table)


def _load_known():
    """Layer A table: {"digests": {digest: KIND}, "salt", "max_tokens"}.
    A missing file is allowed (layer B still runs); an unreadable or
    wrong-format file is not -- fail closed."""
    if not os.path.exists(KNOWN_ENTITIES_PATH):
        return None
    st = os.stat(KNOWN_ENTITIES_PATH)
    ck = (KNOWN_ENTITIES_PATH, st.st_mtime_ns, st.st_size)
    if ck in _KNOWN_CACHE:
        return _KNOWN_CACHE[ck]
    data = _load_json(KNOWN_ENTITIES_PATH, None)
    if not isinstance(data, dict) or data.get("format") != "hashed-v1":
        raise RedactionError("known-entity file unreadable")
    try:
        k = (bytes.fromhex(data["salt"]), dict(data["digests"]), int(data.get("max_tokens", 4)))
    except (KeyError, ValueError, TypeError):
        raise RedactionError("known-entity file unreadable")
    _KNOWN_CACHE.clear()
    _KNOWN_CACHE[ck] = k
    return k


def _known_spans(text, known):
    """Windows of 1..max_tokens tokens, the last one also tried without a
    Hungarian case ending, looked up by digest."""
    salt, table, maxn = known
    toks = [(m.start(), m.end(), fold(m.group(0))) for m in _TOKEN.finditer(text)]
    # also the dot-free pieces, so a name inside "lap-allatkert.docx" is seen
    toks += [(m.start(), m.end(), fold(m.group(0))) for m in re.finditer(r"[^\W_]+", text)
             if "." in text[max(0, m.start() - 1):m.end() + 1]]
    toks.sort()
    out = []
    for i in range(len(toks)):
        for n in range(1, maxn + 1):
            if i + n > len(toks):
                break
            words = [t[2] for t in toks[i:i + n]]
            last = words[-1]
            variants = {last}
            for suf in _SUFFIXES_F:
                if last.endswith(suf) and len(last) - len(suf) >= 2:
                    variants.add(last[: -len(suf)])
            # assimilated -val/-vel: allatkerttel, kovaccsal
            if len(last) >= 6 and last[-2:] in ("al", "el") and last[-3] == last[-4]:
                variants.add(last[:-3])
            for v in variants:
                kind = table.get(_digest(salt, known_key(words[:-1] + [v])))
                if kind:
                    out.append((toks[i][0], toks[i + n - 1][1], kind))
                    break
    return out


def _folded_index(text):
    """Folded text plus a map from folded offsets back to original offsets.
    Folding can change length (NFKD, ligatures), so it goes char by char."""
    folded, back = [], []
    for i, ch in enumerate(text):
        f = fold(ch) if not ch.isspace() else " "
        for c in f:
            folded.append(c)
            back.append(i)
    back.append(len(text))
    return "".join(folded), back


@contextlib.contextmanager
def preserving(terms):
    """Within the block the given words count as preserved, like
    preserve-terms.json. For a task whose own vocabulary would otherwise be
    masked as a name: the letter classifier's document words ("Invoice",
    "Rechnung", "Proforma") are capitalised and not in the Hungarian common
    words, so r12 masked them as PROPER or PERSON, and the classifier saw
    "<PROPER_3> | e-Számla" instead of "Invoice | e-Számla" (measured
    2026-10-01, nautilus: 10 of 10 "Invoice" and all "Proforma" masked on 40
    DEV letters). The always-masked kinds (email, phone, IBAN, tax id) are
    patterns, not words, so a preserved word never unmasks them; the runtime
    guard does not read this set."""
    global PRESERVE
    base = PRESERVE
    PRESERVE = base | {fold(t) for t in terms}
    try:
        yield
    finally:
        PRESERVE = base


def _is_preserved(span_text):
    f = fold(span_text)
    if f in PRESERVE:
        return True
    words = f.split()
    return bool(words) and all(w in PRESERVE for w in words)


def _sentence_initial(text, start):
    j = start - 1
    while j >= 0 and text[j] in " \t\"'„(“":
        j -= 1
    return j < 0 or text[j] in ".!?:\n•-*>"


def _find_spans(text, known):
    spans = []   # (start, end, kind)
    # layer A: known entities from our own records, compared by digest
    if known:
        spans.extend(_known_spans(text, known))
    # layer B: property patterns
    for kind, rx in _P:
        for m in rx.finditer(text):
            s, e = (m.start("v"), m.end("v")) if "v" in rx.groupindex else (m.start(), m.end())
            if e <= s:
                continue
            if kind == "DOMAIN":
                # our own hosts and preserved products stay; any other host
                # names a business, and a partner's name must not travel
                host = fold(text[s:e])
                if host.endswith("acropora.hu") or host.split(".")[0] in PRESERVE \
                        or host in ("github.com", "discord.com", "typesafe.ai", "api.typesafe.ai"):
                    continue
                spans.append((s, e, "DOMAIN"))
                continue
            if kind == "CAPS":
                # an all-caps run is emphasis ("SAJAT HIBA") unless one of its
                # words is a listed name or not an ordinary word in our texts
                words = [fold(w) for w in text[s:e].split()]
                if any(_is_name(w) for w in words) or (COMMON and any(
                        w not in COMMON and _stem(w) not in COMMON and w not in PRESERVE
                        and w not in _LABELS for w in words)):
                    spans.append((s, e, "PERSON"))
                continue
            if kind == "HANDLE" and _is_preserved(text[s:e].lstrip("@").split("@")[0]):
                continue
            if kind == "PERSON":
                span = _person_span(text, s, e)
                if span:
                    spans.append((span[0], span[1], kind))
                continue
            spans.append((s, e, kind))
    # single capitalised words. A listed name (given name or common surname,
    # inflected or not) is a PERSON anywhere. Any other capitalised word
    # INSIDE a sentence is a proper noun in Hungarian orthography (person,
    # place, company); unless it is a preserved domain term, it is masked as
    # PROPER. This is the property rule; the list only sharpens the label.
    proper_stems = set()
    initial = []
    for m in re.finditer(r"(?<![\w-])" + UP + L + r"+(?:-" + UP + L + r"+)?(?![\w])", text):
        w = m.group(0)
        if _is_preserved(w):
            continue
        base = fold(w)
        if not any(c.islower() for c in w):
            # ALL-CAPS single word: a listed name, inflected or not (BALAZSNAL),
            # or a long word our texts never use in lower case (a company)
            if len(base) >= 3 and _is_name(base):
                spans.append((m.start(), m.end(), "PERSON"))
            elif len(base) >= 6 and COMMON and base not in COMMON and _stem(base) not in COMMON \
                    and base not in _LABELS:
                spans.append((m.start(), m.end(), "PROPER"))
            continue
        if _is_name(base):
            spans.append((m.start(), m.end(), "PERSON"))
        elif _ET_AL.match(text, m.end()):
            # "Still et al.", "An et al.": an author's surname, whatever word lists it is on
            spans.append((m.start(), m.end(), "PROPER"))
            proper_stems.add(_stem(base))
        elif base in _FIGURE_REFS and _FIGURE_NUMBER.match(text, m.end()):
            # "(Fig. 4c)", "Table 2", "Figure S3": a reference into the paper, not a name; only
            # with the number after it, so a bare capitalised word before a number still masks
            continue
        elif not _sentence_initial(text, m.start()):
            if base not in _OPENERS:
                spans.append((m.start(), m.end(), "PROPER"))
                proper_stems.add(_stem(base))
        elif base not in _OPENERS and base not in EN_OPENERS:
            # EN_OPENERS: an English abstract's sentence opener ("Increased", "However") is not
            # in our Hungarian common words, and was masked as a proper noun
            initial.append(m)
    # a sentence-initial capitalised word is masked when (a) it is addressed or
    # labelled ("Mohácsi, nézd", "Kerekes: a lámpa"), (b) the same stem shows
    # up as a proper noun elsewhere ("Dobozi ma ... de Dobozinak"), or (c) it
    # has the -i/-y surname shape of an unlisted family name.
    starts = {sp[0] for sp in spans if sp[2] in ("PERSON", "PROPER")}
    for m in initial:
        w, base = m.group(0), fold(m.group(0))
        nxt = text[m.end():m.end() + 1]
        after = re.match(r"[ \t]+([^\W\d_][\w']*)", text[m.end():])
        if after and _is_name(base) is False and (m.end() + after.start(1)) in starts \
                and not _is_preserved(w):
            spans.append((m.start(), m.end(), "PROPER"))
            continue
        if COMMON and base not in COMMON and _stem(base) not in COMMON \
                and base not in _LABELS and base not in _COMMON_I:
            # not an ordinary word in our own texts: a proper noun
            spans.append((m.start(), m.end(), "PROPER"))
            continue
        if nxt in (",", ":") and base not in _LABELS \
                or _stem(base) in proper_stems \
                or (len(base) >= 5 and base[-1] in "iy" and base not in _COMMON_I):
            spans.append((m.start(), m.end(), "PROPER"))
    # names inside identifiers: Kovacs_Peter_szamla.pdf, hegedus.bodnar
    for m in re.finditer(r"[^\W\d_]{2,}(?:[_.][^\W\d_]{2,})+", text):
        parts = list(re.finditer(r"[^\W\d_]+", m.group(0)))
        if any(_is_name(fold(p.group(0))) for p in parts) or (
                "." in m.group(0) and re.search(r"(?:facebook|instagram|linkedin|tiktok)\.com/$",
                                                text[max(0, m.start() - 30):m.start()])):
            for p in parts:
                if not _is_preserved(p.group(0)) and fold(p.group(0)) not in ("pdf", "jpg", "png", "docx", "xlsx", "txt", "com", "hu", "www"):
                    spans.append((m.start() + p.start(), m.start() + p.end(), "PERSON"))
    # lowercase names from the list (chat style: "a kovacs peternel"), except
    # names that are also ordinary words and would wreck the sentence
    for m in re.finditer(r"(?<![^\W_])" + LO + r"{3,}(?![^\W_])", text):
        base = fold(m.group(0))
        if base in _OPENERS:
            continue
        if base in _AMBIGUOUS or _stem(base) in _AMBIGUOUS:
            # an everyday word that is also a surname counts only next to
            # another name: "a kovacs peternel" yes, "a kovacs szerint" no
            nb = re.findall(r"[^\W\d_]+", text[m.end():m.end() + 30])[:1] + \
                re.findall(r"[^\W\d_]+", text[max(0, m.start() - 30):m.start()])[-1:]
            prev = re.findall(r"[^\W\d_]+", text[max(0, m.start() - 30):m.start()])[-1:]
            if any(_is_name(fold(x)) and fold(x) not in _AMBIGUOUS for x in nb) \
                    or any(fold(x) in _NAME_CUES for x in prev):
                spans.append((m.start(), m.end(), "PERSON"))
            continue
        if _is_name(base):
            spans.append((m.start(), m.end(), "PERSON"))
    return spans


def _is_name(base):
    if base in GIVEN_NAMES or _strip_suffix(base) in GIVEN_NAMES:
        return True
    # diminutives: Zsoltika, Pistike, Katika(nak)
    for b in (base, _stem(base)):
        for dim in ("ka", "ke", "ika", "ike", "cska", "cske"):
            if b.endswith(dim) and (b[: -len(dim)] in GIVEN_NAMES or b[: -len(dim)] + "i" in GIVEN_NAMES):
                return True
    return False


def _stem(base):
    for suf in _SUFFIXES:
        f = fold(suf)
        if base.endswith(f) and len(base) - len(f) >= 3:
            return base[: -len(f)]
    return base


# A word right after these is a name even when it is also an everyday word.
_NAME_CUES = {fold(w) for w in """csengő csengo kaputelefon név nev címzett cimzett ügyfél ugyfel tulajdonos
kapcsolattartó kapcsolattarto úr ur úrnak asszony hölgy holgy kolléga kollega""".split()}


# Label words that may open a line with a colon or comma without being a name.
_LABELS = {fold(w) for w in """cím cim tel telefon email e-mail mobil fax megjegyzés megjegyzes fontos
kérdés kerdes válasz valasz ügyfél ugyfel tárgy targy helyszín helyszin szállítás szallitas link összeg
osszeg dátum datum határidő hatarido státusz statusz állapot allapot eredmény eredmeny hiba teendő teendo
szia sziasztok helló hello igen nem oké oke ok persze rendben figyelj nézd nezd szóval szoval tehát tehat
megrendelő megrendelo címzett cimzett feladó felado számla szamla rendelés rendeles bankszámla bankszamla
adószám adoszam iban wifi jelszó jelszo kód kod név nev postacím postacim utalás utalas letöltés letoltes
közlemény kozlemeny székhely szekhely feladó küldve kuldve tárgy targy tisztelettel üdvözlettel udvozlettel
munkavállaló munkavallalo cégjegyzékszám cegjegyzekszam from sent to subject cc bcc date re fw fwd mobil vezetékes vezetekes whatsapp viber skype""".split()}

# Sentence-initial words ending in -i/-y that are ordinary Hungarian.
_COMMON_I = {fold(w) for w in """mindenki valaki senki bárki barki akárki akarki semmi valami bármi barmi
tegnapi holnapi mai reggeli esti délutáni delutani heti havi napi régi regi új uj utolsó utolso
jövő heti következő kovetkezo előző elozo korábbi korabbi mostani akkori tavalyi idei szombati vasárnapi
hétfői hetfoi keddi szerdai csütörtöki csutortoki pénteki penteki budapesti szegedi debreceni
tengeri édesvízi edesvizi magyari angoli nagyi anyuci apuci ami ahol aki""".split()}

# Listed names that are also everyday words; matched only when capitalised.
_AMBIGUOUS = {fold(w) for w in """nagy kis kiss fekete fehér feher szabó szabo kovács kovacs magyar török torok
király kiraly pap papp katona simon antal virág virag sándor sandor balázs balazs pál pal vörös voros
lengyel orosz jakab boros hegyi somogyi soós soos deák deak halász halasz vass fazekas
takács takacs juhász juhasz molnár molnar farkas varga lukács lukacs biró biro kelemen gál gal
""".split()}


# A reference into a paper: the word, an optional dot, then a number ("Fig. 4c", "Table 2",
# "Figure S3", "Eq. (5)"). Without the number the word is judged like any other.
_FIGURE_REFS = {"fig", "figs", "figure", "figures", "table", "tables", "tab", "eq", "eqs", "equation"}
_FIGURE_NUMBER = re.compile(r"\.?[ \t]?\(?S?\d")
# A capitalised word before this is an author's surname ("Still et al.").
_ET_AL = re.compile(r"[ \t]+et\.?[ \t]+al(?![^\W_])")


# Capitalised only because they open a sentence. Stripped from the FRONT of
# a person-shaped run; everything else in the run stays masked. The safe
# direction is over-masking: a surname at sentence start ("Kovács Péter
# írta") must not survive because "Kovács" is not a given name.
_OPENERS = {fold(w) for w in """a az egy ez ezt ezek azt azok ma tegnap holnap most ha de és es
mert hogy mikor amikor igen nem van volt lesz kérem kerem kérlek kerlek szia helló hello
jó jo rendben köszi koszi köszönöm koszonom ugye tehát tehat viszont szerintem szerinted
tudod látod lasd lásd holnapután reggel este délután delutan hétfőn kedden szerdán
csütörtökön pénteken szombaton vasárnap múlt mult jövő jovo itt ott innen onnan
nálunk nalunk nekem neked neki nekünk nektek nekik mi ti ők ok én en te ő o""".split()}


def _person_span(text, s, e):
    """Decide what part of a capitalised run is a person. Returns (s, e) or
    None. Preserved domain terms (product, project, agent names) are kept;
    a sentence-opening function word is trimmed; the rest is masked."""
    frag = text[s:e]
    if frag[:1].islower() or frag.split()[0].rstrip(".") in ("dr", "Dr", "ifj", "id", "özv", "prof", "Prof", "Mr", "Mrs", "Ms"):
        return (s, e)
    words = list(re.finditer(r"\S+", frag))
    while words and (fold(words[0].group(0)) in _OPENERS
                     or (words[0].group(0).endswith(",") and fold(words[0].group(0)[:-1]) in EN_OPENERS)):
        # an English opener only with its comma ("However, Kovács Péter"): without one it may be a
        # family name standing first ("Do Thi Lan", "So Yeon"), and the run masks whole (barracuda,
        # #337 review). Inside a sentence the single-word pass still masks it as a proper noun
        words.pop(0)
    while words and _is_preserved(words[0].group(0)):
        words.pop(0)
    while words and _is_preserved(words[-1].group(0)):
        words.pop()
    if not words:
        return None
    if len(words) == 1:
        # one word left: the given-name pass decides, not this rule
        return None
    return (s + words[0].start(), s + words[-1].end())


# Hungarian inflection: "Péternek", "Annától", "Kovácséknál". Only used to
# decide whether a single capitalised word is a given name, never to trim.
_SUFFIXES = sorted("""nak nek val vel ban ben ba be ból ből ról ről ra re ról tól től hoz hez höz
nál nél ig ért ként kor ot et öt at t on en ön n é ék éknál éknek éké nál ét ja je a e i
né nét néhez nével nének nénél nétől néről""".split(),
                   key=len, reverse=True)


_SUFFIXES_F = sorted({fold(x) for x in _SUFFIXES} | {"t", "val", "vel", "nak", "nek", "tol", "tol", "rol", "nal", "nel", "hoz", "hez"}, key=len, reverse=True)


_DOUBLED = {"ccs": "cs", "ssz": "sz", "zzs": "zs", "tty": "ty", "ggy": "gy", "lly": "ly", "nny": "ny"}


def _strip_suffix(w, depth=0):
    # assimilated comitative: péterrel, gáborral, tamással, kovaccsal
    if len(w) >= 6 and w[-2:] in ("al", "el"):
        stem = w[:-2]
        for dbl, one in _DOUBLED.items():
            if stem.endswith(dbl):
                cand = stem[: -len(dbl)] + one
                if cand in GIVEN_NAMES:
                    return cand
        if stem[-1] == stem[-2] and stem[:-1] in GIVEN_NAMES:
            return stem[:-1]
    # family plural plus a case ending: kovacsekhoz, kovacsektol
    if depth == 0:
        for fam in ("ekhez", "ekhoz", "ektol", "ekkel", "ekkal", "eknel", "eknek", "ekre", "ekrol",
                    "ekbol", "ekben", "ekig", "eket", "eke", "ek"):
            if w.endswith(fam) and len(w) - len(fam) >= 3:
                cand = w[: -len(fam)]
                if cand in GIVEN_NAMES:
                    return cand
    for suf in _SUFFIXES:
        s = fold(suf)
        if w.endswith(s) and len(w) - len(s) >= 3:
            cand = w[: -len(s)]
            if cand in GIVEN_NAMES:
                return cand
            # Péter -> Pétert / Anna -> Annát (lengthened final vowel)
            if cand + "a" in GIVEN_NAMES:
                return cand + "a"
            if cand + "e" in GIVEN_NAMES:
                return cand + "e"
    return w


def _load_en_openers():
    """en-openers.txt, minus every word the name list knows (a name never passes as an opener)."""
    try:
        with open(EN_OPENERS_PATH, encoding="utf-8") as f:
            words = {fold(x) for line in f if not line.lstrip().startswith("#") for x in line.split()}
    except OSError:
        return frozenset()
    return frozenset(w for w in words if not _is_name(w) and w not in _AMBIGUOUS)


EN_OPENERS = _load_en_openers()


_COUNCIL = re.compile(r"\b(?:PD|ACD|CH|[PDQCA])-\d{3}\b")


def _preserved_ranges(text):
    ftext, back = _folded_index(text)
    out = [(m.start(), m.end()) for m in _COUNCIL.finditer(text)]
    for term in PRESERVE:
        if " " not in term:
            continue
        for m in re.finditer(r"(?<![^\W_])" + re.escape(term) + r"(?![^\W_])", ftext):
            out.append((back[m.start()], back[m.end() - 1] + 1))
    return out


def _merge(spans):
    """Overlaps resolve to the widest span; on equal width, the more
    sensitive kind (ALWAYS_MASKED first) wins."""
    rank = {k: i for i, k in enumerate(["SECRET", "IBAN", "BANK_ACCOUNT", "TAX_ID", "EMAIL",
                                        "PHONE", "URL_QUERY", "ADDRESS", "PERSON", "HANDLE", "ORG", "DOMAIN", "PROPER",
                                        "ID", "AMOUNT", "DATE"])}
    spans = sorted(spans, key=lambda x: (x[0], -(x[1] - x[0]), rank.get(x[2], 99)))
    out = []
    for s, e, k in spans:
        if out and s < out[-1][1]:
            ps, pe, pk = out[-1]
            if e > pe:
                # extend; keep the more sensitive kind
                k2 = pk if rank.get(pk, 99) <= rank.get(k, 99) else k
                out[-1] = (ps, e, k2)
            continue
        out.append((s, e, k))
    return out


def redact(text, *, keep_dates=False, keep_kinds=()):
    """Returns {"text", "version", "counts"}. Raises RedactionError on any
    internal failure: the caller must then drop the item, never fall back
    to the raw text.

    keep_kinds: kinds left in the text (a subset of KEEPABLE, else an error).
    A personal span masks either way: no keepable kind outranks a personal
    one in _merge. Dropping the kept spans BEFORE the merge only keeps more of
    the business text around it: "Kovács Péter Kft." becomes "<PERSON_1> Kft."
    instead of one wider placeholder."""
    if not isinstance(text, str):
        raise RedactionError("input is not text")
    keep_kinds = frozenset(keep_kinds)
    if not keep_kinds <= KEEPABLE:
        raise RedactionError("keep_kinds outside the keepable set")
    try:
        text = unicodedata.normalize("NFC", text)
        known = _load_known()
        spans = _find_spans(text, known)
        keep = _preserved_ranges(text)
        if keep:
            spans = [sp for sp in spans if (sp[2] not in ("PERSON", "PROPER", "ID")
                                            or not any(sp[0] < e and s < sp[1] for s, e in keep))]
        if keep_dates:
            spans = [s for s in spans if s[2] != "DATE"]
        if "ORG" in keep_kinds:
            # A name-like span inside a company name with a real legal form is
            # the company's name, not a person's: it stays. Every other kind
            # inside it (e-mail, phone, bank account, tax number) still masks.
            companies = [(s, e) for s, e, k in spans
                         if k == "ORG" and _COMPANY_FORM_END.search(text[s:e])]
            spans = [sp for sp in spans
                     if not (sp[2] in _NAME_KINDS_IN_COMPANY
                             and any(cs <= sp[0] and sp[1] <= ce for cs, ce in companies))]
        if keep_kinds:
            spans = [s for s in spans if s[2] not in keep_kinds]
        spans = _merge(spans)
        mapping, counts, out, pos = {}, {}, [], 0
        for s, e, kind in spans:
            out.append(text[pos:s])
            if kind == "URL_QUERY":
                out.append("")
                counts[kind] = counts.get(kind, 0) + 1
            else:
                f = fold(text[s:e])
                key = (kind, _strip_suffix(f) if kind in ("PERSON", "PROPER") else f)
                if key not in mapping:
                    counts[kind] = counts.get(kind, 0) + 1
                    mapping[key] = f"<{kind}_{counts[kind]}>"
                out.append(mapping[key])
            pos = e
        out.append(text[pos:])
        return {"text": "".join(out), "version": REDACTION_VERSION, "counts": counts}
    except RedactionError:
        raise
    except Exception as e:  # any bug in here is a boundary failure
        raise RedactionError(f"redaction failed: {type(e).__name__}") from None


def runtime_guard(redacted, *, allow_known_kinds=()):
    """Last net right before the provider call (ACD-011 point 4). Returns a
    list of problem kinds; empty means pass. It re-runs only the
    always-masked patterns and the raw known-entity scan: a second full
    redaction would just agree with the first one.

    allow_known_kinds: known-entity kinds that do not stop the call (a subset of
    KNOWN_ALLOWABLE, else every hit stops it). An allowed ORG hit still stops
    it without a legal form in the hit or right after it, and as a sole
    trader's name."""
    allow = frozenset(allow_known_kinds)
    if not allow <= KNOWN_ALLOWABLE:
        return ["allow_known_kinds"]
    problems = []
    if not isinstance(redacted, dict) or redacted.get("version") != REDACTION_VERSION:
        return ["version"]
    t = redacted.get("text")
    if not isinstance(t, str):
        return ["text"]
    for kind, rx in _P:
        if kind in ALWAYS_MASKED or kind in ("EMAIL", "PHONE"):
            if rx.search(t):
                problems.append(kind)
    known = _load_known()
    if known:
        spans = _known_spans(t, known)

        def formed(s, e):
            return bool(_FORM_IN_HIT.search(t[s:e]) or _FORM_AFTER_HIT.match(t, e))

        for s, e, kind in spans:
            # r12 (acrobot 25567): a bare ORG hit passes when it is the start of a
            # longer allowed ORG hit that reaches a legal form. build_known's caps
            # alias makes "HANNA" out of "HANNA Instruments Service Kft.", and on
            # the candidate line no legal form follows the bare word.
            # (The longer hit is itself in spans, so its own sole-trader check runs.)
            inside = any(k2 in allow and s2 == s and e2 > e and formed(s2, e2)
                         for s2, e2, k2 in spans)
            allowed = (kind in allow and (formed(s, e) or inside)
                       and not _SOLE_TRADER.search(t[s:e + 24]))
            if not allowed:
                problems.append("KNOWN_ENTITY")
                break
    return sorted(set(problems))


if __name__ == "__main__":
    import sys
    r = redact(sys.stdin.read())
    print(json.dumps(r, ensure_ascii=False, indent=1))
