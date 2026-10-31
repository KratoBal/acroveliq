#!/bin/bash
# The quarantine reader, file mode (P1-00f, points 2 and 7; src/karanten-olvas.ts). An outside file
# (an e-mail body, a PDF, a chat attachment) is read by a separate, restricted claude process in a
# fresh temporary folder, and only its wrapped, secret-filtered summary comes back here.
#
#   bash /home/marveen/marveen/scripts/karanten-olvas.sh <fajl>
#   bash /home/marveen/marveen/scripts/karanten-olvas.sh --url <url>   (the COMMAND downloads the page
#     through the egress gate's quarantine decision, pinned to checked public addresses; the reader
#     reads it as a file and never gets WebFetch; a large or long-lined HTML page is handed over as its
#     visible text, with its address on the first line)
#     A page that answers 403 or a Cloudflare challenge goes to Firecrawl's scrape API instead (only for a host the egress gate allows;
#     the key store/.firecrawl-key is read by the calling user; the envelope's source says karanten-url-firecrawl-403 or -kihivas).
#   exit 0: the summary, wrapped as untrusted data; 2: nothing came through (why, no content);
#   3: the summary held a secret shape, nothing came through
#
# The reader's tool list (src/karanten-olvas.ts, READER_ARGS) is a PERMISSION: widening it beyond
# Read is a permission_change, Balázs's decision.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/dist/karanten-olvas.js" "$@"
