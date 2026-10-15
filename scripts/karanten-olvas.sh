#!/bin/bash
# The quarantine reader, file mode (P1-00f, points 2 and 7; src/karanten-olvas.ts). An outside file
# (an e-mail body, a PDF, a chat attachment) is read by a separate, restricted claude process in a
# fresh temporary folder, and only its wrapped, secret-filtered summary comes back here.
#
#   bash /home/marveen/marveen/scripts/karanten-olvas.sh <fajl>
#   exit 0: the summary, wrapped as untrusted data; 2: nothing came through (why, no content);
#   3: the summary held a secret shape, nothing came through
#
# The reader's tool list (src/karanten-olvas.ts, READER_ARGS) is a PERMISSION: widening it beyond
# Read is a permission_change, Balázs's decision.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/dist/karanten-olvas.js" "$@"
