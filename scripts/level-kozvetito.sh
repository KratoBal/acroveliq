#!/usr/bin/env bash
# The fleet's client of the mail relay (task level-kozvetito, slice 4; level-kozvetito/README.md).
#
#   bash /home/marveen/marveen/scripts/level-kozvetito.sh <info|balazs> <verb> < body.json
#   bash /home/marveen/marveen/scripts/level-kozvetito.sh health
#
# The JSON body comes on STDIN (redirected from a file: the quote-and-dollar rule of the fleet); the answer is
# the relay's JSON on stdout, in which every piece of mail text is already inside an <untrusted> envelope.
# Exit 0: answered 200. Exit 1: `FAIL <status> <the relay's fixed reason>` on stderr, nothing on stdout.
#
#   LVK_URL         honoured ONLY for http://127.0.0.1[:port] or http://localhost[:port] (the tests); the relay is
#                   the fixed http://levelkozvetito:8788, and any other value is refused before a request
#   LVK_TOKEN_FILE  the caller's token (default store/tokens/levelkozvetito-<LVK_CALLER or acrobot>.token, 0400)
#
# The token is read from its file and goes only into the Authorization header of the one request; it is never
# printed, and it is not an argument or an environment variable.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -I "$DIR/level-kozvetito-kliens.py" "$@"
