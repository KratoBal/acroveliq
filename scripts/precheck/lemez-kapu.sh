#!/usr/bin/env bash
# ANSWERS: Kell-e felebreszteni az ELES gep lemez-takaritasat (van-e mit takaritani vagy jelezni)?
#
# lemez-kapu.sh eles
#
# Scheduler preCheck of `eles-lemez-takaritas` (card fde4acc2, task t-20261114-lemez-kapu; D-004 Balazs 2026-09-28
# 12:52 UTC is the model for SKIP: no model round when nothing is there to do). SKIP only when EVERY signal is under its
# threshold; any other case wakes the agent with the measurement as a prefix, including an unreachable host (ssh
# failure exits non-zero and the runner fails open).
#
# WHY ONLY THE PROD MACHINE: the test machine's cleanup (`stage-lemez-takaritas`) stays UNCONDITIONAL, every round,
# with no threshold. Balazs, 2026-11-04 18:42/18:45 UTC (main channel, msg 1567610781254811670), word for word: "azert
# mert van hely naponta ketszer torold ami nem kell. nem kell megvarni amig felmegy 80%-ra". So `stage` is refused
# here (exit 2): a gate in front of that cleanup would override the owner. The old, separate gate of the DISABLED
# `stage-gyorsitotar-orjarat` is scripts/precheck/stage-gyorsitotar.sh, unchanged.
#
# WHY A GATE ON PROD: measured 2026-11-14 (exchange/lemez-kapu-meres-2026-11-14.txt), every round of the prod cleanup
# (`50 */6 * * *`) was builder-prune 0 B, the Docker disk 31 percent before and after, Build Cache 0 B: four full
# model-context re-reads a day for nothing. The prod images are NOT a signal (3.1 GB reclaimable, never moves; image
# pruning on prod stays forbidden).
#
# `docker buildx du` is not a fleet-gate operation (refused on the stage host, measured 18:49), so the cache number is
# the `docker system df` Build Cache RECLAIMABLE column (a true number on the stage today: 40.57 GB of 45.06 GB; the 35 MB
# of 2026-09-23 was a momentary state of shared records). If the column ever sticks on the private part, the 80 percent
# disk term still wakes the round.
#
# THRESHOLDS (change them HERE, with the measurement that justifies it):
#   disk            >= 80 percent of the fuller disk (the two disks of the host: / and /var/lib/docker)
#   Build Cache     >= 2 GB reclaimable
#
# The runner kills this after 10 s, so the ssh timeouts stay under that (fleet-gate B8: two operations, 4 s each).
set -uo pipefail

case "${1:-}" in
  eles)  HOST=fleet@162.55.216.28 ;;
  stage) echo "lemez-kapu.sh: the stage cleanup is unconditional (Balazs 2026-11-04, msg 1567610781254811670): no gate in front of it" >&2; exit 2 ;;
  *) echo "usage: lemez-kapu.sh eles" >&2; exit 2 ;;
esac
DISK_PCT=80
CACHE_GB=2

gate() { timeout 4 ssh -o BatchMode=yes -o ConnectTimeout=3 -i /home/marveen/.ssh/id_ed25519_acropora_monitor "$HOST" "$@"; }
# (df's header line has no "%", so the parser below skips it)
m=$(gate df -P && gate system-df --format) || exit 1
printf '%s\n' "$m" | WHICH="$1" DISK_PCT="$DISK_PCT" CACHE_GB="$CACHE_GB" python3 -c '
import os, re, sys
lines = sys.stdin.read().splitlines()
units = {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
def size(v):
    m = re.match(r"\s*([\d.]+)\s*([kKMGT]?B)", v)
    if not m: raise SystemExit(1)
    return float(m.group(1)) * units[m.group(2)]
disks = []
cache = None
for l in lines:
    if l.startswith("Build Cache|"): cache = size(l.split("|")[2])
    elif "%" in l and not "|" in l: disks.append(int(re.search(r"(\d+)%", l).group(1)))
if not disks or cache is None: raise SystemExit(1)
disk = max(disks)
reasons = []
if disk >= int(os.environ["DISK_PCT"]): reasons.append("lemez %d%% >= %s%%" % (disk, os.environ["DISK_PCT"]))
if cache >= float(os.environ["CACHE_GB"]) * 1e9: reasons.append("Build Cache visszanyerheto %.2f GB >= %s GB" % (cache / 1e9, os.environ["CACHE_GB"]))
if not reasons: print("SKIP")
else:
    print("[preCheck meres, %s] lemez %d%% (gyoker es Docker-lemez kozul a telebb: %s), Build Cache visszanyerheto %.2f GB: %s" % (
        os.environ["WHICH"], disk, "/".join(map(str, disks)), cache / 1e9, "; ".join(reasons)))
'
