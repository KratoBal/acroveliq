#!/usr/bin/env bash
# ANSWERS: Hogyan futtatok egy nagy kimenetű parancsot (teszt, build, typecheck, diff)
# úgy, hogy a kimenete ne ömöljön a kontextusba, de semmi ne vesszen el?
#
#   bash /home/marveen/marveen/scripts/futtat.sh run --feladat <kartya-id> -- pnpm test
#   bash /home/marveen/marveen/scripts/futtat.sh olvas <naplo> --sorok 120-160
#   bash /home/marveen/marveen/scripts/futtat.sh keres <naplo> 'not ok' --kontextus 5
#
# A teljes kimenet a logs/<projekt>/<feladat>/ alá kerül, titkokra és személyes
# adatra maszkolva; a kontextusba csak az összefoglaló jön. A kilépési kód a
# futtatott parancsé, tehát && láncban ugyanúgy megáll. Részletek: docs/futtat.md.
exec python3 "$(dirname "${BASH_SOURCE[0]}")/futtat.py" "$@"
