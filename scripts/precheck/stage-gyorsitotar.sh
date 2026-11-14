#!/usr/bin/env bash
# ANSWERS: Kell-e felebreszteni a stage-gyorsitotar-orjarat heartbeatet (van-e mit takaritani vagy jelezni a teszt gepen)?
#
# A thin wrapper since card fde4acc2 (task t-20261114-lemez-kapu): the decision lives in lemez-kapu.sh, which gates BOTH
# cleanup schedules (stage and prod). This file stays only because the (disabled) stage-gyorsitotar-orjarat task still
# names it as its preCheck; it answers exactly like `lemez-kapu.sh stage`.
exec bash "$(dirname "$0")/lemez-kapu.sh" stage
