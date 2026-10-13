#!/usr/bin/env bash
# ANSWERS: Milyen nyitott pull requestek vannak egy repoban (alapertelmezes acropora-os; PR_REPO-val mas).
# Regenerate docs/PR-ALLAS.md -- the shared, machine-readable list of open pull
# requests for the acropora-os repo.
#
# WHY THIS EXISTS (measured 2026-08-27): `gh` is not installed and the GitHub
# MCP call answers "Requires authentication", so an agent that pushes a branch
# has no convenient way to check whether a PR was opened for it. That asymmetry
# cost most of one afternoon: an agent reported the same "two of my branches
# have no PR" state four times in a row, each report already answered by a
# message sitting undelivered in its queue, because a busy agent's inbox only
# drains on an idle pane.
#
# NARROWED 2026-09-02, and the correction matters more than the tool. This
# header used to say the fleet's agents "cannot see GitHub". Too broad, and
# nautilus measured it: with store/.github-token the REST API is open to an
# agent for READS **and WRITES** -- he created pull request 370 that way and got
# HTTP 201 back. The real limit is narrower and of a different KIND: there is no
# `gh` COMMAND (a missing tool, which only installing fixes), while the
# token-backed HTTP path stays open beside it.
#
# Why the distinction is not pedantry: "we cannot see GitHub" reads as a
# permission wall, and a permission wall is something you ask someone to lift.
# An agent who believes it will wait instead of measuring -- and the thing it
# would have waited for already works. A limit written down without its KIND
# outlives the condition that created it, and everyone after inherits it.
#
# A queue delivers once, late, and in order. A file can be read at any moment,
# by anyone, as many times as needed -- so the state lives in the file and the
# messages stop carrying it.
#
# The page carries its own expiry condition instead of a timestamp (nautilus's
# suggestion, same day): a reader compares `origin/main` against the head
# printed here. A timestamp tells you when it was written, which is not the
# question -- the question is whether anything has changed since, and the repo
# itself can answer that.
set -uo pipefail
ROOT=/home/marveen/marveen
# PR_REPO honoured, like pr-allapot.sh. MEASURED 2026-09-08 07:28: this script
# hardcoded acropora-os and IGNORED PR_REPO, so `PR_REPO=KratoBal/acropora-commerce
# pr-allas.sh` answered "0 nyitott PR" while five stood open in commerce. A silent
# false zero, and I reported it twice as evidence before noticing. The repo name is
# now printed in the output and in the file title, so the answer says what it is
# about.
REPO="${PR_REPO:-KratoBal/acropora-os}"
REPO_FORRAS="${PR_REPO:+PR_REPO}"; REPO_FORRAS="${REPO_FORRAS:-ALAPERTELMEZES}"
if [ "$REPO" = "KratoBal/acropora-os" ]; then
  OUT="$ROOT/docs/PR-ALLAS.md"
else
  OUT="$ROOT/docs/PR-ALLAS-${REPO##*/}.md"
fi
TOKEN_FILE="$ROOT/store/.github-token"
[ -r "$TOKEN_FILE" ] || { echo "FAIL: no github token at $TOKEN_FILE" >&2; exit 1; }

TOKEN="$(cat "$TOKEN_FILE")" REPO="$REPO" REPO_FORRAS="$REPO_FORRAS" python3 - "$OUT" <<'PY'
import json, os, subprocess, sys
out_path = sys.argv[1]
tok, repo = os.environ["TOKEN"], os.environ["REPO"]
repo_forras = os.environ.get("REPO_FORRAS", "ALAPERTELMEZES")

def api(path):
    # the header on stdin, not the argv: every agent's `ps` shows argv (P0-1)
    r = subprocess.run(
        ["curl", "-s", "-H", "@-",
         "https://api.github.com/repos/" + repo + path],
        input="Authorization: Bearer " + tok + "\n", capture_output=True, text=True)
    return json.loads(r.stdout)

main = api("/commits/main")
prs = api("/pulls?state=open&per_page=50")
if not isinstance(prs, list):
    print("FAIL: unexpected API answer", file=sys.stderr); sys.exit(1)

lines = [
    "# Nyitott pull requestek -- gepi allas", "",
    "REPO: `%s`  (a repo forrasa: %s)" % (repo, repo_forras), "",
    "Ezt a lapot ACROBOT irja, minden PR-muvelet utan.", "",
    "KINEK SZOL, ES KINEK NEM (merve 2026-09-09 18:33. Mind az ot sub-agenst megkerdeztem;",
    "NEGY valaszolt. Barracuda es korall valasza meg nem erkezett meg -- a lenti lista tehat",
    "NEM teljes, es ha az o valaszuk mast mond, ez a szakasz bovul.)",
    "A korabbi fejlec azt allitotta, hogy a flotta agensei NEM latjak a GitHubot. EZ MA MAR",
    "NEM IGAZ, es negy kulonbozo valasz jott ugyanarra a kerdesre:", "",
    "    murena, nautilus   a REST hivas MEGY (HTTP 200). Nekik a SAJAT lekerdezesuk a",
    "                       frissebb -- ez a lap nekik TARTALEK, nem forras.",
    "    picasso            a store/ mappa SZERKEZETILEG kivul van a hatokoren, tehat a",
    "                       token-fajlhoz nem jut el. A hivas el sem indul.",
    "    polip              a token-fajl olvasasa FAJLRENDSZER-szinten megtagadva. A hivas",
    "                       elindul, URES tokennel, es 401-et ad -- ami UGY nez ki, mintha",
    "                       a GitHub utasitana el a tokent. NEM az.", "",
    "Ezert marad ez a lap: akinek a token nem elerheto, ez az EGYETLEN utja annak, hogy",
    "lassa, mi all nyitva. Aki eleri a GitHubot, annak a sajat lekerdezese elozze meg ezt.", "",
    "Ha egy agad NEM szerepel itt es nem is beolvadt, akkor NINCS hozza PR -- szolj.", "",
    "## Meddig ervenyes ez a lap", "",
    "Nincs benne idobelyeg, es ez SZANDEKOS: egy idopont nem mondja meg, elavult-e a tartalom.",
    "Ehelyett a lap a SAJAT lejarati feltetelet hordozza. Futtasd ezt:", "",
    "    git -C <a klonod> rev-parse --short origin/main", "",
    "Ha ugyanazt adja, mint a lenti sor, a lap FRISS. Ha MAST, akkor a fo ag azota mozdult,",
    "es a lap egy korabbi allapotot mutat -- olyankor szolj, es ujrafuttatom.", "",
    "A lap POZITIV iranyban bizonyit: ha az agad ITT VAN, akkor van hozza PR. Negativ iranyban",
    "csak JELEZ: ha nincs itt, az lehet, hogy csak meg nem irtam ki.", "",
    "main feje: `%s` -- %s" % (main["sha"][:8], main["commit"]["message"].splitlines()[0]), "",
    "| PR | ag | fej | allapot |", "|---|---|---|---|",
]
for p in sorted(prs, key=lambda x: x["number"]):
    lines.append("| #%d | `%s` | `%s` | %s |" % (
        p["number"], p["head"]["ref"], p["head"]["sha"][:8],
        "piszkozat" if p["draft"] else "nyitva"))
open(out_path, "w").write("\n".join(lines) + "\n")
print("OK %s -- repo %s (%s): %d nyitott PR" % (out_path, repo, repo_forras, len(prs)))
PY
