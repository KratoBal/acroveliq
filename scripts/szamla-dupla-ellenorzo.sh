#!/usr/bin/env bash
# ANSWERS: Van-e ugyanaz a szamla ket sorban a forrasok kozott (kimeno: Szamlazz.hu feed es eBIZ; bejovo: Szamlazz.hu szamlabe es NAV), az eles adatbazisban. Csak olvas.
# Balazs kerese 2026-10-05 09:07 UTC: "innentol ez legyen ellenorizve". Kilepes: 0 nincs dupla, 1 van dupla, 2 nem merheto.
set -u
SQL=$(cat <<'Q'
select 'KIMENO', "documentNumber", count(*), string_agg(source::text, '+' order by source::text)
  from "ExternalBillingDocument" where not cancelled group by "documentNumber" having count(*) > 1;
Q
)
out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 -i /home/marveen/.ssh/id_ed25519_acropora_monitor fleet@162.55.216.28 \
  "docker exec -i iwm34jaqp9xmwb72qkrqkwhy psql -U acropora -d acropora -tA -F ' | '" <<<"$SQL" 2>&1) || { echo "NEM MERHETO: $out"; exit 2; }
echo "--- szamla-dupla-ellenorzo ($(date '+%F %T %z')), eles acropora DB ---"
if [ -z "$out" ]; then echo "KIMENO: nincs dupla."; else echo "$out"; fi
# A bejovo oldalon a ket forras (IncomingBillingDocument, NavIncomingInvoice) KULON tablaban van, es 85/85 atfedes
# termeszetes; dupla akkor van, ha a FELULET mindkettot listazza. Ezt a javitas (kartya eace2514) utan az o
# ellenorzo vegpontja adja meg; addig ez a szkript csak a kimeno oldalt allitja.
[ -z "$out" ] && exit 0 || exit 1
