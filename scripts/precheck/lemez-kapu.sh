#!/usr/bin/env bash
# ANSWERS: Kell-e felebreszteni a lemez-takaritast egy gepen (van-e mit takaritani vagy jelezni)?
#
# lemez-kapu.sh stage|eles
#
# Scheduler preCheck (card fde4acc2, task t-20261114-lemez-kapu; D-004 Balazs 2026-09-28 12:52 UTC is the model for
# SKIP: no model round when nothing is there to do). One script for BOTH cleanup schedules (stage-lemez-takaritas,
# eles-lemez-takaritas) instead of a stage-only gate and two unconditional rounds. SKIP only when EVERY signal is
# under its threshold; any other case wakes the agent with the measurement as a prefix, including an unreachable host
# (ssh failure exits non-zero and the runner fails open).
#
# WHAT THE MEASUREMENT OF 2026-11-14 18:49 (exchange/lemez-kapu-meres-2026-11-14.txt) CHANGED, and why the thresholds
# are what they are:
#  - The old gate looked at the Build Cache only (and a disk under 80 percent). The stage disk was NOT emptied by the
#    cache alone: 00:27 image-prune 10.46 GB (builder 0 B); 06:28 image-prune 9.80 GB; 12:25 about 33 GB of which the
#    builder-prune 7.2 GB. Images stood at 34.99 GB, 19.71 GB reclaimable (56 percent). A disk that fills with IMAGES
#    never woke a Build-Cache-only gate below 80 percent. So the stage gate also reads the Images RECLAIMABLE.
#  - On the PROD host every round of the unconditional 6-hour cleanup measured builder-prune 0 B and a Docker disk of
#    31 percent before and after (Build Cache 0 B). Its Images reclaimable (3.1 GB) never moves, so prod does NOT read
#    the images: only the cache and the disk. That is the SKIP that saves four model rounds a day.
#  - `docker buildx du` is not a fleet-gate operation (refused on the stage host, measured 18:49), so the cache number
#    stays the `docker system df` Build Cache RECLAIMABLE column. Today it reads 40.57 GB of 45.06 GB, so it is a true
#    number now; the 35 MB of 2026-09-23 was the state of shared records at that moment, not a constant. If the
#    column ever sticks at "private" again, the disk percentage still wakes the round at 80.
#
# THRESHOLDS (change them HERE, with the measurement that justifies it):
#   disk            >= 80 percent of the fuller disk (the two disks of both hosts: / and /var/lib/docker)
#   Build Cache     >= 2 GB reclaimable (both hosts)
#   Images          >= 10 GB reclaimable (stage only)
#
# The runner kills this after 10 s, so the ssh timeouts stay under that (fleet-gate B8: two operations, 4 s each).
set -uo pipefail

case "${1:-}" in
  stage) HOST=fleet@100.88.199.87; IMAGES_GB=10 ;;
  eles)  HOST=fleet@162.55.216.28; IMAGES_GB=0 ;;
  *) echo "usage: lemez-kapu.sh stage|eles" >&2; exit 2 ;;
esac
DISK_PCT=80
CACHE_GB=2

gate() { timeout 4 ssh -o BatchMode=yes -o ConnectTimeout=3 -i /home/marveen/.ssh/id_ed25519_acropora_monitor "$HOST" "$@"; }
# (df's header line has no "%", so the parser below skips it)
m=$(gate df -P && gate system-df --format) || exit 1
printf '%s\n' "$m" | WHICH="$1" DISK_PCT="$DISK_PCT" CACHE_GB="$CACHE_GB" IMAGES_GB="$IMAGES_GB" python3 -c '
import os, re, sys
lines = sys.stdin.read().splitlines()
units = {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
def size(v):
    m = re.match(r"\s*([\d.]+)\s*([kKMGT]?B)", v)
    if not m: raise SystemExit(1)
    return float(m.group(1)) * units[m.group(2)]
disks = []
cache = images = None
for l in lines:
    if l.startswith("Build Cache|"): cache = size(l.split("|")[2])
    elif l.startswith("Images|"): images = size(l.split("|")[2])
    elif "%" in l and not "|" in l: disks.append(int(re.search(r"(\d+)%", l).group(1)))
if not disks or cache is None: raise SystemExit(1)
disk = max(disks)
need_images = float(os.environ["IMAGES_GB"]) > 0
if need_images and images is None: raise SystemExit(1)
reasons = []
if disk >= int(os.environ["DISK_PCT"]): reasons.append("lemez %d%% >= %s%%" % (disk, os.environ["DISK_PCT"]))
if cache >= float(os.environ["CACHE_GB"]) * 1e9: reasons.append("Build Cache visszanyerheto %.2f GB >= %s GB" % (cache / 1e9, os.environ["CACHE_GB"]))
if need_images and images >= float(os.environ["IMAGES_GB"]) * 1e9: reasons.append("Kepek visszanyerheto %.2f GB >= %s GB" % (images / 1e9, os.environ["IMAGES_GB"]))
if not reasons: print("SKIP")
else:
    print("[preCheck meres, %s] lemez %d%% (gyoker es Docker-lemez kozul a telebb: %s), Build Cache visszanyerheto %.2f GB%s: %s" % (
        os.environ["WHICH"], disk, "/".join(map(str, disks)), cache / 1e9,
        (", Kepek visszanyerheto %.2f GB" % (images / 1e9)) if need_images else "", "; ".join(reasons)))
'
