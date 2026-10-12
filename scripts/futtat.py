#!/usr/bin/env python3
"""futtat: structured command runner (acrovelIQ token brief, item 2, 2026-10-12).

A big-output command (test, build, typecheck, diff, a large search) should not
pour into the agent's context, and nothing may be lost. So:

  - the FULL output goes to logs/<project>/<task>/<timestamp>-<kind>.log,
    masked for secrets and personal data BEFORE it is written;
  - the context gets a SUMMARY: exit code, duration, a kind-specific excerpt
    (failed tests and their first error; error locations; diff statistics),
    and always the log path and the number of lines left out. On a failure the
    first error line and the N lines before it are always in.

Subcommands:
  futtat.py run --projekt P --feladat T [--fajta K] [--kontextus N] -- CMD...
  futtat.py olvas LOG --sorok A-B          a line range of a log
  futtat.py keres LOG REGEX [--kontextus N] matches with context
  futtat.py lenyomat-hozzaad               secret VALUES on stdin -> their sha256 to the hash list
  futtat.py takarit [--napok 30]           delete logs older than N days (summaries stay)

Masking, in order:
  1. known secret values, by a ONE-WAY hash list (FUTTAT_SECRET_HASHES): the
     runner never stores a secret, it hashes candidate tokens of the output and
     replaces the ones whose hash is on the list;
  2. secret-shaped patterns (tokens, keys, connection-string passwords);
  3. personal data (e-mail, phone, Hungarian tax number, IBAN).
The log header carries the number of replacements.

Access: the project's own group (logs-<project>), not `fleet`: directories
2750, files 0640. If the group does not exist, the runner falls back to
owner-only (0700/0600) and says so: stricter, never looser.
"""

from __future__ import annotations

import argparse
import bisect
import grp
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOG_ROOT = Path(os.environ.get("FUTTAT_LOG_ROOT", REPO / "logs"))
HASH_LIST = Path(os.environ.get("FUTTAT_SECRET_HASHES", REPO / "store" / "secret-hashes.txt"))
RETENTION_DAYS = 30
# The hash list is required (Balázs, 2026-10-12): a run without it would hide
# only the shapes the patterns know. Only this variable, set to exactly "1",
# lets a run go on without it, and the run says so (tests).
HASH_LIST_OPTIONAL_ENV = "FUTTAT_LENYOMAT_NEM_KOTELEZO"
HASH_LIST_STOP_CODE = 3
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")

# ---- masking ---------------------------------------------------------------

# A candidate secret: a run of token characters, at least 8 long. Within a run,
# every stretch that starts and ends at a delimiter boundary (=, :, @, /) and is
# at least 8 long is hashed too (barracuda, #17): a secret may itself contain a
# delimiter (a Telegram bot token, `123456:ABC...`), end in base64 padding
# (`KEY=abc==`), or be glued into a path (`/bot<TOKEN>/sendMessage`).
CANDIDATE = re.compile(r"[A-Za-z0-9_\-.+/=:@~]{8,}")
DELIMITERS = "=:@/"
MIN_SECRET = 8
# A run longer than this (a minified bundle line, a data: URI) is only split at
# delimiter boundaries, not windowed per length: millions of hashes otherwise
WINDOW_LIMIT = 4096
# a hash without a length is looked for in stretches up to this long
UNSIZED_MAX = 512

# (label, pattern[, replacement]); without a replacement the match becomes [LABEL]
SECRET_PATTERNS: list[tuple] = [
    ("TITOK", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b")),
    ("TITOK", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{40,}\b")),
    ("TITOK", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}\b")),
    # Stripe: an underscore after the prefix, not a dash (barracuda, #17)
    ("TITOK", re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9]{16,}\b")),
    ("TITOK", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("TITOK", re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b")),
    ("TITOK", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("TITOK", re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")),
    ("TITOK", re.compile(r"(?i)\b((?:bearer|basic) )[A-Za-z0-9_\-.=+/]{16,}"), r"\1[TITOK]"),
    # the credentials of a connection string: scheme://USER:PASSWORD@host
    ("TITOK", re.compile(r"(?<=://)[^\s/:@]+:[^\s/@]+(?=@)")),
    # KEY=value, KEY: value, "KEY": "value" where the key names a secret, also as
    # the end of an environment-variable name (DB_PASSWORD, API_TOKEN; barracuda, #17)
    ("TITOK", re.compile(r"(?i)\b([A-Z0-9_]*(?:password|passwd|secret|token|api_?key)[\"']?\s*[=:]\s*[\"']?)[^\s'\"&,]{6,}"), r"\1[TITOK]"),
]

PERSONAL_PATTERNS: list[tuple] = [
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b")),
    ("ADOSZAM", re.compile(r"\b\d{8}-\d-\d{2}\b")),
    # [ /-]: a space, a slash or a hyphen (not the range from space to slash)
    ("TELEFON", re.compile(r"(?<![\w.])(?:\+36|06)[ /-]?(?:1|[2-9]\d)[ /-]?\d{3}[ /-]?\d{3,4}\b")),
]


class HashListUnreadable(Exception):
    """The hash list exists but cannot be read: the known-value layer is OFF."""


class HashListMissing(Exception):
    """There is no hash list, and the caller needs one."""


def load_hashes(path: Path = HASH_LIST, missing_ok: bool = True) -> dict[int | None, set[str]]:
    """The hash list: `<sha256> <length>` per line. The length lets a secret
    be found anywhere inside a run, also glued to other text
    (`/bot<TOKEN>/...`); a line without a length is matched only at delimiter
    boundaries (bucket None)."""
    buckets: dict[int | None, set[str]] = {}
    try:
        text = path.read_text()
    except FileNotFoundError:
        if missing_ok:
            return buckets  # adding the first hash: there is no list yet
        raise HashListMissing(str(path)) from None
    except OSError as error:
        # readable or not is not the same as empty (barracuda, #17): an agent
        # that cannot read the list must be told its first layer is off
        raise HashListUnreadable(str(error)) from error
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0].startswith("#"):
            continue
        length = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
        buckets.setdefault(length, set()).add(parts[0])
    return buckets


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


PEM_BEGIN = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
PEM_END = re.compile(r"-----END [A-Z0-9 ]*PRIVATE KEY-----")


class Masker:
    """Masks one line at a time and counts what it replaced. A private key spans
    lines, so from its BEGIN line to its END line every line is masked
    (barracuda, #17: a single-text pattern never matched a real key)."""

    def __init__(self, hashes: dict[int | None, set[str]]):
        self.unsized = hashes.get(None, set())
        self.sized = {length: digests for length, digests in hashes.items() if length is not None}
        self.count = 0
        self.in_key = False

    def _known(self, line: str) -> str:
        if not self.unsized and not self.sized:
            return line

        def replace(match: re.Match[str]) -> str:
            token = match.group(0)
            found: list[tuple[int, int]] = []
            # a known length: every window of that length, anywhere in the run
            for length, digests in (self.sized.items() if len(token) <= WINDOW_LIMIT else ()):
                for a in range(0, len(token) - length + 1):
                    if sha(token[a : a + length]) in digests:
                        found.append((a, a + length))
            # no length known, or a run too long to window: delimiter boundaries,
            # but never every start with every end (barracuda, #17: quadratic on a
            # long base64 run). A known length pairs a start only with the end
            # exactly that far; a length-less hash only with ends within UNSIZED_MAX.
            long_run = len(token) > WINDOW_LIMIT
            if self.unsized or (long_run and self.sized):
                starts = [0] + [i + 1 for i, c in enumerate(token) if c in DELIMITERS]
                ends = [i for i, c in enumerate(token) if c in DELIMITERS] + [len(token)]
                end_set = set(ends)
                if long_run:
                    for length, digests in self.sized.items():
                        found += [(a, a + length) for a in starts if a + length in end_set and sha(token[a : a + length]) in digests]
                # a length-less (legacy) hash only in runs within the limit: on a
                # dense long run even a 512 cap is ~10 million hashes. lenyomat-hozzaad
                # always records the length, so such lines are only old ones.
                if self.unsized and not long_run:
                    for a in starts:
                        for b in ends[bisect.bisect_left(ends, a + MIN_SECRET) : bisect.bisect_right(ends, a + UNSIZED_MAX)]:
                            if sha(token[a:b]) in self.unsized:
                                found.append((a, b))
            spans = sorted(found, key=lambda span: span[0] - span[1])  # the longest first
            taken: list[tuple[int, int]] = []
            for a, b in spans:
                if all(b <= x or a >= y for x, y in taken):
                    taken.append((a, b))
            if not taken:
                return token
            self.count += len(taken)
            out, last = [], 0
            for a, b in sorted(taken):
                out += [token[last:a], "[TITOK]"]
                last = b
            return "".join(out + [token[last:]])

        return CANDIDATE.sub(replace, line)

    def _patterns(self, line: str, patterns: list[tuple]) -> str:
        for label, pattern, *replacement in patterns:
            line, n = pattern.subn(replacement[0] if replacement else f"[{label}]", line)
            self.count += n
        return line

    def line(self, line: str) -> str:
        if self.in_key or PEM_BEGIN.search(line):
            self.in_key = not PEM_END.search(line)
            self.count += 1
            return "[TITOK]"
        line = self._known(line)
        line = self._patterns(line, SECRET_PATTERNS)
        return self._patterns(line, PERSONAL_PATTERNS)


# ---- excerpts --------------------------------------------------------------

# A turbo or pnpm workspace prefix: "@acropora/api:test: " in front of a line.
PREFIX = re.compile(r"^(?:\S+:[\w-]+: )")
ERROR_LINE = re.compile(r"(?:\berror\b|\bError\b|\bFAIL\b|^not ok\b|\bnot ok \d|ERR!|AssertionError|✗|×)")


def strip(line: str) -> str:
    return PREFIX.sub("", line, count=1)


def infer_kind(cmd: list[str]) -> str:
    text = " ".join(cmd)
    if re.search(r"\bgit (?:diff|show)\b", text):
        return "diff"
    if re.search(r"\b(?:typecheck|tsc)\b", text):
        return "typecheck"
    if re.search(r"\bbuild\b", text):
        return "build"
    if re.search(r"\b(?:test|vitest|jest)\b|node --test", text):
        return "test"
    if re.search(r"\b(?:grep|rg|find)\b", text):
        return "kereses"
    return "egyeb"


def excerpt_test(lines: list[str]) -> list[str]:
    """Failed tests by name, each with its first error line."""
    out: list[str] = []
    seen: set[str] = set()
    for index, raw in enumerate(lines):
        line = strip(raw).strip()
        name = None
        m = re.match(r"^(?:#\s*)?not ok \d+ - (.+)$", line)  # node:test TAP, nested or not
        if m:
            name = m.group(1)
        m = re.match(r"^FAIL\s+(.+?)$", line)  # vitest / jest
        if m and ">" in m.group(1):
            name = m.group(1)
        if name is None or name in seen:
            continue
        seen.add(name)
        first_error = ""
        following = lines[index + 1 : index + 40]
        for offset, follow in enumerate(following):
            text = strip(follow).strip()
            if re.search(r"(?:Error|error:|expected|Expected|AssertionError|actual)", text) and "location:" not in text:
                # node:test writes `error: |-` and the message on the next lines
                if re.match(r"^error:\s*[|>][-+]?$", text):
                    text = next((strip(l).strip() for l in following[offset + 1 :] if strip(l).strip()), text)
                first_error = text
                break
        out.append(f"BUKOTT: {name}" + (f"\n    {first_error}" if first_error else ""))
    totals = [strip(l).strip() for l in lines if re.search(r"(?:^# (?:tests|pass|fail) \d+|Tests\s+\d|Test Files\s+\d|Tasks:\s+\d)", strip(l))]
    return out + totals[-6:]


TS_LOCATION = re.compile(r"^(\S+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+)):?\s*(?:-\s*)?error\s+(TS\d+):\s*(.*)$")


def excerpt_compile(lines: list[str]) -> list[str]:
    """Error locations: file:line:col TSxxxx message (tsc, both formats), and build failures."""
    out: list[str] = []
    for raw in lines:
        line = strip(raw).strip()
        m = TS_LOCATION.match(line)
        if m:
            row = m.group(2) or m.group(4)
            col = m.group(3) or m.group(5)
            out.append(f"{m.group(1)}:{row}:{col} {m.group(6)} {m.group(7)}")
        elif re.search(r"(?:Type error:|Failed to compile|Module not found|Build error occurred|Failed:\s+\S)", line):
            out.append(line)
    totals = [strip(l).strip() for l in lines if re.search(r"Tasks:\s+\d|Found \d+ errors?", strip(l))]
    return out + totals[-3:]


def excerpt_diff(lines: list[str]) -> list[str]:
    """Per-file +/- counts from the diff text itself, and a total."""
    files: dict[str, list[int]] = {}
    current = None
    for line in lines:
        m = re.match(r"^diff --git a/(.+?) b/(.+)$", line)
        if m:
            current = m.group(2)
            files[current] = [0, 0]
            continue
        if current is None or line.startswith(("+++", "---")):
            continue
        if line.startswith("+"):
            files[current][0] += 1
        elif line.startswith("-"):
            files[current][1] += 1
    out = [f"{path}: +{add} -{rem}" for path, (add, rem) in files.items()]
    total_add = sum(v[0] for v in files.values())
    total_rem = sum(v[1] for v in files.values())
    out.append(f"{len(files)} fájl, +{total_add} -{total_rem}")
    return out


def first_error(lines: list[str], before: int) -> list[str]:
    for index, raw in enumerate(lines):
        if ERROR_LINE.search(strip(raw)):
            start = max(0, index - before)
            return [f"{n + 1}: {lines[n]}" for n in range(start, index + 1)]
    return []


def summarize(kind: str, lines: list[str], code: int, context: int, max_lines: int = 40) -> list[str]:
    if kind == "test":
        body = excerpt_test(lines)
    elif kind in ("typecheck", "build"):
        body = excerpt_compile(lines)
    elif kind == "diff":
        body = excerpt_diff(lines)
    else:
        body = [f"{n + 1}: {l}" for n, l in enumerate(lines)][-10:]
    body = body[:max_lines]
    if code != 0:
        error = first_error(lines, context)
        if error:
            body = body + ["első hiba (és ami előtte állt):"] + error
    return body


# ---- files, permissions, retention ----------------------------------------

def group_name(project: str) -> str:
    # FUTTAT_GROUP: an install (or a test) whose group is named differently
    return os.environ.get("FUTTAT_GROUP") or f"logs-{project}"


def project_group(project: str) -> int | None:
    try:
        return grp.getgrnam(group_name(project)).gr_gid
    except KeyError:
        return None


def ensure_dir(project_dir: Path, task_dir: Path, gid: int | None) -> None:
    """The project and the task directory get the project's group; the shared
    log root is left alone, because every project's agents create under it."""
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    for part in (project_dir, task_dir):
        try:
            part.mkdir(exist_ok=True)
        except PermissionError:
            sys.exit(f"FAIL: {part} nem hozható létre (jog). A {group_name(project_dir.name)} csoport tagja vagy?")
        try:
            if gid is not None:
                os.chown(part, -1, gid)
                # 2770: several agents of a project (different OS users) create
                # their task directories here (barracuda, #17); setgid keeps the group
                os.chmod(part, 0o2770)
            else:
                os.chmod(part, 0o700)
        except PermissionError:
            pass  # created by another agent of the project: its owner set it


def protect_file(path: Path, gid: int | None) -> bool:
    """0640 with the project group; 0600 without it, or when the group cannot
    be set (the agent is not a member). Answers whether the group was set."""
    if gid is not None:
        try:
            os.chown(path, -1, gid)
            os.chmod(path, 0o640)
            return True
        except PermissionError:
            pass
    os.chmod(path, 0o600)
    return False


def prune(root: Path, days: int, now: float) -> int:
    """Deletes logs older than `days`; the summaries (.summary.json) stay."""
    removed = 0
    if not root.exists():
        return 0
    for log in root.rglob("*.log"):
        try:
            if now - log.stat().st_mtime > days * 86400:
                log.unlink()
                removed += 1
        except OSError:
            pass
    return removed


# ---- commands ----------------------------------------------------------------

def cmd_run(args: argparse.Namespace) -> int:
    for label, value in (("--projekt", args.projekt), ("--feladat", args.feladat)):
        if not SAFE_NAME.match(value):
            print(f"FAIL: {label} csak betű, szám, pont, kötőjel és aláhúzás lehet: {value!r}", file=sys.stderr)
            return 2
    command = args.cmd[1:] if args.cmd and args.cmd[0] == "--" else args.cmd
    if not command:
        print("FAIL: nincs parancs (futtat.py run --projekt P --feladat T -- PARANCS ...)", file=sys.stderr)
        return 2
    # Before anything is written or run: a required list that is missing or
    # unreadable stops the run, with no log (Balázs, 2026-10-12).
    optional = os.environ.get(HASH_LIST_OPTIONAL_ENV) == "1"
    warnings: list[str] = []
    try:
        hashes = load_hashes(missing_ok=False)
    except (HashListMissing, HashListUnreadable) as error:
        what = "hiányzik" if isinstance(error, HashListMissing) else "nem olvasható"
        if not optional:
            hint = (
                f" Ha most kerültél a {group_name(args.projekt)} csoportba, a tagság a következő indulástól él."
                if isinstance(error, HashListUnreadable)
                else ""
            )
            print(
                f"FAIL: a lenyomat-lista {what} ({error}). A futtató nem fut csökkentett védelemmel: "
                f"nem futtatta a parancsot, és nem írt naplót.{hint}",
                file=sys.stderr,
            )
            return HASH_LIST_STOP_CODE
        hashes = {}
        warnings.append(f"a lenyomat-lista {what} ({error}), csak a minták szűrtek")
    if optional:
        warnings.insert(0, f"a lenyomat-lista kötelezősége kikapcsolva ({HASH_LIST_OPTIONAL_ENV}=1)")
    hash_warning = "; ".join(warnings)

    kind = args.fajta or infer_kind(command)
    gid = project_group(args.projekt)
    directory = LOG_ROOT / args.projekt / args.feladat
    ensure_dir(LOG_ROOT / args.projekt, directory, gid)
    # milliseconds: two runs of one task in the same second must not overwrite
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%S") + f"{now.microsecond // 1000:03d}Z"
    log_path = directory / f"{stamp}-{kind}.log"

    masker = Masker(hashes)
    started = time.monotonic()
    lines: list[str] = []
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    assert process.stdout is not None
    for raw in process.stdout:
        lines.append(masker.line(raw.rstrip("\n")))
    code = process.wait()
    duration = time.monotonic() - started

    header = [
        f"# futtat: {' '.join(masker.line(part) for part in command)}",
        f"# fajta={kind} kilepes={code} ido={duration:.1f}s sorok={len(lines)} cserek={masker.count}",
    ] + ([f"# figyelem: {hash_warning}"] if hash_warning else [])
    log_path.write_text("\n".join(header + lines) + "\n")
    grouped = protect_file(log_path, gid)

    body = summarize(kind, lines, code, args.kontextus)
    shown = sum(1 for line in body if not line.startswith("első hiba"))
    summary = {
        "kilepes": code,
        "ido_mp": round(duration, 1),
        "fajta": kind,
        "naplo": str(log_path),
        "sorok": len(lines),
        "kihagyott_sorok": max(0, len(lines) - shown),
        "cserek": masker.count,
        "figyelmeztetes": hash_warning or None,
        "kivonat": body,
    }
    summary_path = log_path.with_suffix(".summary.json")
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    protect_file(summary_path, gid)
    prune(LOG_ROOT / args.projekt, RETENTION_DAYS, time.time())

    print(f"kilépés {code} · {duration:.1f} s · {kind} · {len(lines)} sor")
    for line in body:
        print(line)
    print(f"napló: {log_path} ({summary['kihagyott_sorok']} sor kihagyva; cserék: {masker.count})")
    if hash_warning:
        print(f"figyelem: {hash_warning}")
    if gid is None:
        print(f"figyelem: nincs {group_name(args.projekt)} csoport, a napló csak a tulajdonosé (0600)")
    elif not grouped:
        print(f"figyelem: a {group_name(args.projekt)} csoport nem állítható be (nem vagy tagja?), a napló csak a tulajdonosé (0600)")
    return code


def read_lines(path: str) -> list[str]:
    return Path(path).read_text().splitlines()


def cmd_olvas(args: argparse.Namespace) -> int:
    m = re.match(r"^(\d+)-(\d+)$", args.sorok)
    if not m:
        print("FAIL: --sorok A-B alakban", file=sys.stderr)
        return 2
    start, end = int(m.group(1)), int(m.group(2))
    lines = read_lines(args.naplo)
    for number in range(max(1, start), min(end, len(lines)) + 1):
        print(f"{number}: {lines[number - 1]}")
    return 0


def cmd_keres(args: argparse.Namespace) -> int:
    pattern = re.compile(args.minta)
    lines = read_lines(args.naplo)
    # the two header lines repeat the command: a search for a word of the
    # command would always "find" it there; line numbers stay the same
    body_start = sum(1 for line in lines[:3] if line.startswith(("# futtat:", "# fajta=", "# figyelem:")))
    hits = [i for i, line in enumerate(lines) if i >= body_start and pattern.search(line)]
    shown: set[int] = set()
    for i in hits[: args.max]:
        for n in range(max(0, i - args.kontextus), min(len(lines), i + args.kontextus + 1)):
            if n not in shown:
                shown.add(n)
                print(f"{n + 1}{':' if n == i else '-'} {lines[n]}")
        print("--")
    print(f"{len(hits)} találat" + (f", az első {args.max} látszik" if len(hits) > args.max else ""))
    return 0 if hits else 1


def cmd_lenyomat(args: argparse.Namespace) -> int:
    values = [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]
    short = [v for v in values if len(v) < 8]
    if short:
        print(f"FAIL: {len(short)} érték 8 karakternél rövidebb, ezt a kimenetben nem lehet biztonságosan keresni", file=sys.stderr)
        return 2
    try:
        known = load_hashes()
    except HashListUnreadable as error:
        print(f"FAIL: a lenyomat-lista nem olvasható: {error}", file=sys.stderr)
        return 1
    new = [v for v in values if sha(v) not in known.get(len(v), set()) | known.get(None, set())]
    HASH_LIST.parent.mkdir(parents=True, exist_ok=True)
    existed = HASH_LIST.exists()
    # A NEW list is created with its final mode at once (no umask window):
    # 0640 with the project group, else 0600. An EXISTING list keeps its group
    # and group bits (acrobot, live run 2026-10-12): the deployment sets 0640
    # with logs-acropora so the agents can read it, and a chmod here undid that.
    gid = None if existed else project_group("acropora")
    fd = os.open(HASH_LIST, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640 if gid is not None else 0o600)
    with os.fdopen(fd, "a") as handle:
        for value in new:
            handle.write(f"{sha(value)} {len(value)}\n")
    if not existed:
        protect_file(HASH_LIST, gid)
    else:
        # ... but never stays readable by others (barracuda, acrobot 28644): a
        # list left at 0644 by hand loses its world bits, group bits untouched
        mode = HASH_LIST.stat().st_mode & 0o777
        if mode & 0o007:
            try:
                os.chmod(HASH_LIST, mode & ~0o007)
            except OSError as error:
                print(f"figyelem: a lenyomat-lista mások számára olvasható ({oct(mode)}), és nem szűkíthető: {error}", file=sys.stderr)
    print(f"{len(new)} új lenyomat ({len(values) - len(new)} már szerepelt)")
    return 0


def cmd_takarit(args: argparse.Namespace) -> int:
    print(f"{prune(LOG_ROOT, args.napok, time.time())} napló törölve")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="futtat")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--projekt", default="acropora")
    run.add_argument("--feladat", required=True)
    run.add_argument("--fajta", choices=["test", "build", "typecheck", "diff", "kereses", "egyeb"])
    run.add_argument("--kontextus", type=int, default=10)
    run.add_argument("cmd", nargs=argparse.REMAINDER)
    olvas = sub.add_parser("olvas")
    olvas.add_argument("naplo")
    olvas.add_argument("--sorok", required=True)
    keres = sub.add_parser("keres")
    keres.add_argument("naplo")
    keres.add_argument("minta")
    keres.add_argument("--kontextus", type=int, default=3)
    keres.add_argument("--max", type=int, default=20)
    sub.add_parser("lenyomat-hozzaad")
    takarit = sub.add_parser("takarit")
    takarit.add_argument("--napok", type=int, default=RETENTION_DAYS)
    args = parser.parse_args(argv)
    return {
        "run": cmd_run,
        "olvas": cmd_olvas,
        "keres": cmd_keres,
        "lenyomat-hozzaad": cmd_lenyomat,
        "takarit": cmd_takarit,
    }[args.command](args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
