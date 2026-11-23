#!/usr/bin/env python3
"""ANSWERS: A NAS-rol visszatoltott AI-mentes teljes-e, es olyan friss-e, mint az elo adatbazis volt a mentes pillanataban?

visszaallitasi-proba-ai.py "<visszatoltve>" "<elo>" <fajlnev> -- the AI branch of scripts/visszaallitasi-proba.sh.

The two lines are "conversations=N messages=N answer_ratings=N newest=E": the restored copy's from the fleet-gate's
restore-probe (newest = its newest message, epoch seconds), the live one's from psql-ro (newest = the newest live message AT
the dump's time). The checks, each one a FAIL line:
  counts     every count a number, none above live, conversations and messages not zero (answer_ratings may be)
  freshness  (card f7d08f28) the restored newest must reach the live newest at the dump's time, within FRESH_SLACK_S.
             Measured against live, as on the fleet branch: a quiet AI has an old newest message in a good dump too.

UNTIL THE HOST GATE IS REINSTALLED its restore-probe prints no newest=. Then the freshness is NOT measured, and the line says so
every week (no FAIL): the counts still are. A FAIL on freshness is first a question of the zone (`date +%z`: an empty zone file
once made glibc read local times as UTC, which moves the dump's time later and lets later live rows in), then of a row written
afterwards with an older created_at (an import, a restore). Exit 0 when every measured check passes, 1 otherwise.
"""
import sys

FRESH_SLACK_S = 600


def parse(line):
    return dict(kv.split("=", 1) for kv in line.split() if "=" in kv) if line.strip() else {}


def main(got, live, name):
    g, l = parse(got), parse(live)
    fails = []
    bad = [k for k in ("conversations", "messages", "answer_ratings")
           if not g.get(k, "").isdigit() or not l.get(k, "").isdigit() or int(g[k]) > int(l[k])]
    if not l or bad or int(g.get("messages", "0") or 0) == 0 or int(g.get("conversations", "0") or 0) == 0:
        fails.append("visszatoltve=%s elo=%s gyanus=%s" % (got.strip(), live.strip(), bad))
    if "newest" not in g:
        print("   frissesseg: NEM MERT, a hosti kapu restore-probe-ja meg nem adja a newest mezot (hosti ujratelepitesre var)")
    elif l.get("newest", "none") == "none":
        print("   frissesseg: az elo adatbazisban nincs uzenet a mentes idejeig, nincs mihez merni")
    else:
        restored, at_time = g["newest"], l["newest"]
        print("   frissesseg: visszatoltve legfrissebb %s, elo a mentes idejeig %s (%s)" % (restored, at_time, name))
        if not at_time.isdigit():
            fails.append("az elo legfrissebb uzenet nem szam: %s" % at_time)
        elif not restored.isdigit() or int(restored) < int(at_time) - FRESH_SLACK_S:
            fails.append("a visszatoltott mentes legfrissebb uzenete (%s) regebbi, mint amit az elo a mentes idejeig tartalmazott (%s)" % (restored, at_time))
    for f in fails:
        print("FAIL[ai]: %s" % f)
    return 1 if fails else 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print('usage: visszaallitasi-proba-ai.py "<visszatoltve>" "<elo>" <fajlnev>', file=sys.stderr)
        sys.exit(2)
    sys.exit(main(*sys.argv[1:4]))
