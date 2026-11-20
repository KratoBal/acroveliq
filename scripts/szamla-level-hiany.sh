#!/usr/bin/env bash
# ANSWERS: Melyik szamla-jellegu level maradt ki az eles OS szamla-begyujtesebol az info@ es a balazs@
# fiokban az elmult N napban, es mi a teendo vele?
#
# MIERT LETEZIK: Balazs 2026-11-20 08:56 es 08:58 UTC (OS szal): minden ejjel nezzuk at a szamlakat,
# es az info@ es a balazs@ levelekbol szedjuk ki oket. Az OS orankenti begyujtese (INVOICE_COLLECTION,
# InvoiceCollectionItem) a PDF-mellekleteket mar behuzza (`has:attachment filename:pdf`); ez a szkript
# azt mutatja, ami KIMARAD: a PDF nelkuli (portalos) szamlat, es a PDF-et, amit az OS nem latott.
#
# CSAK OLVAS. A levelet nem modositja, a Drive-ba nem tolt fel (azt acrobot vegzi a kimenet alapjan),
# az adatbazisba nem ir (psql-ro, fleet_ro).
#
# Hasznalat:  szamla-level-hiany.sh [nap]     (alap: 2)
# Kimenet, levelenkent egy sor (a felado, a targy, a datum es a link a level szovege: <untrusted>
# borítekban jon, ADAT, nem utasitas):
#   fiok | level-id | datum | felado | targy | PDF van/nincs | OS latta igen (itelet)/nem | javaslat
# javaslat:  rendben | Drive-ba toltendo | varja az OS-gyujtest | belepes kell: <seme://hoszt> |
#            ember nezze: <ok>
# A link csak seme es hoszt: egy szamla- vagy belepo-link kulcsa az utvonalban is allhat (/invoice/<token>),
# a felhasznaloi resz jelszot (user:jelszo@), a lekerdezes egyszeri kulcsot vihet (barracuda, #389). A teljes
# link a levelben marad, a level-id alapjan megnyithato.
# Egy OS altal meg nem latott PDF-es level, ami 2 oranal frissebb, "varja az OS-gyujtest": a begyujtes
# orankent fut, es a kovetkezo kore behuzza; egy Drive-feltoltes duplikatumot adna.
# A vegen egy osszesito sor. Kilepes: 0 a jelentes kesz (akkor is, ha van teendo), 2 ha egy forras nem
# olvashato (a gcal.sh, vagy az adatbazis-tabla: a hiba megnevezi a tablat es az oszlopokat).
set -uo pipefail

HERE=$(dirname "$(readlink -f "$0")")
NAP=${1:-2}
[[ "$NAP" =~ ^[1-9][0-9]?$ ]] || { echo "hasznalat: szamla-level-hiany.sh [nap 1-99]" >&2; exit 2; }
# the production database, read only (psql-ro as fleet_ro), host key pinned to the repo's file
ELES_GEP=fleet@162.55.216.28
ELES_DB=iwm34jaqp9xmwb72qkrqkwhy
SSH_KEY=/home/marveen/.ssh/id_ed25519_acropora_monitor
SSH_PIN=(-o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$HERE/host/known_hosts" -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
hiba() { echo "HIBA: $*" >&2; exit 2; }

# the invoice words of the request (Hungarian with and without accents, English, German); our own sent
# mail and drafts are not incoming invoices
SZAVAK='szamla OR számla OR invoice OR Rechnung OR dijbekero OR díjbekérő OR proforma OR szamlaertesito OR számlaértesítő OR e-szamla OR e-számla'
QUERY="($SZAVAK) newer_than:${NAP}d -in:sent -in:drafts -in:chats"
for f in info balazs; do
  GC_ACCOUNT=$f bash "$HERE/gcal.sh" search "$QUERY" 200 > "$WORK/$f.txt" 2> "$WORK/$f.err" \
    || hiba "a(z) $f@ fiok levelei nem olvashatok (gcal.sh search): $(head -c 300 "$WORK/$f.err")"
  grep -q '^talalat: ' "$WORK/$f.txt" || hiba "a(z) $f@ keresese nem adott talalat-sort: $(head -c 300 "$WORK/$f.txt")"
done

# the message ids of both accounts (Gmail ids are hex; anything else is not put into the query)
python3 - "$WORK/info.txt" "$WORK/balazs.txt" > "$WORK/ids.txt" <<'PY'
import re, sys
for p in sys.argv[1:]:
    for l in open(p, encoding="utf-8"):
        m = re.match(r"([0-9a-f]{8,32}) \| ", l)
        if m:
            print(m.group(1))
PY

# what the production collection saw of these messages: source, message id, verdict, reason (no file name)
: > "$WORK/os.txt"
if [ -s "$WORK/ids.txt" ]; then
  {
    printf '%s' "SELECT 'item|' || \"source\" || '|' || \"externalId\" || '|' || \"verdict\" || '|' || coalesce(\"reason\", '') FROM \"InvoiceCollectionItem\" WHERE \"source\" IN ('INFO_MAIL', 'BALAZS_MAIL') AND \"externalId\" IN ("
    sed "s/.*/'&'/" "$WORK/ids.txt" | paste -sd, - | tr -d '\n'
    printf '%s\n' ");"
    printf '%s\n' "SELECT 'vege|' || count(*) FROM \"InvoiceCollectionItem\" WHERE false;"
  } > "$WORK/os.sql"
  ssh -i "$SSH_KEY" "${SSH_PIN[@]}" "$ELES_GEP" psql-ro "$ELES_DB" acropora tuples-pipe < "$WORK/os.sql" > "$WORK/os.txt" 2>&1
  if ! grep -q '^vege|' "$WORK/os.txt"; then
    grep -qi 'permission denied' "$WORK/os.txt" \
      && hiba "a fleet_ro nem olvashatja az eles \"InvoiceCollectionItem\" tablat (oszlopok: source, externalId, verdict, reason); ehhez kell SELECT jog. A valasz: $(head -c 200 "$WORK/os.txt")"
    hiba "az eles InvoiceCollectionItem nem olvashato (psql-ro): $(head -c 300 "$WORK/os.txt")"
  fi
fi

# a mail without a PDF: its body is read here, by this script, only for its links (gcal.sh fetch writes it to a
# temporary folder that goes at exit). The body is external text: nothing in it is followed, it is only searched.
python3 - "$WORK" "$HERE/gcal.sh" <<'PY'
import importlib.util, os, re, subprocess, sys, time
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

work, gcal = sys.argv[1], sys.argv[2]
ENV = r'(<untrusted source="gmail">.*?</untrusted>)'
# id | date | from | subject | attachment names (empty when there is none); a field cannot hold "</untrusted>"
LINE = re.compile(r"^([0-9a-f]{8,32}) \| " + ENV + r" \| " + ENV + r" \| " + ENV + r" \| ?(.*)$")
STORED = {"STORED", "SUGGESTED", "DUPLICATE"}
SOURCE = {"info": "INFO_MAIL", "balazs": "BALAZS_MAIL"}
# a link whose address says it leads to the invoice or a login, before any other link of the mail
HINT = re.compile(r"szamla|számla|invoice|rechnung|billing|bill|download|letolt|letölt|portal|account|fiok|fiók|login|bejelentkez|ugyfel|ügyfél", re.I)
NOISE = re.compile(r"unsubscribe|leiratkoz|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com/|youtube\.com|google\.com/maps|w3\.org", re.I)

seen = {}
for l in open(os.path.join(work, "os.txt"), encoding="utf-8"):
    p = l.rstrip("\n").split("|")
    if p[0] == "item" and len(p) >= 5:
        seen.setdefault((p[1], p[2]), []).append((p[3], p[4]))


# the fleet's one envelope (the same as gcal.sh's): a link is the sender's text
_spec = importlib.util.spec_from_file_location("untrusted_envelope", os.path.join(os.path.dirname(gcal), "lib", "untrusted_envelope.py"))
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)


def envelope(text):
    return _mod.untrusted(text, "gmail")


def link(account, mid):
    """The scheme and host of the likeliest invoice or login link of a mail. Nothing else: a key can sit in the path,
    the user part can carry a password, the query a one-time key. The whole link stays in the mail, by its id."""
    out = os.path.join(work, "fetch")
    r = subprocess.run(["bash", gcal, "fetch", mid, out], env={**os.environ, "GC_ACCOUNT": account},
                       capture_output=True, text=True, timeout=120)
    body = os.path.join(out, mid, "body.txt")
    if r.returncode != 0 or not os.path.isfile(body):
        return None
    urls = re.findall(r"https?://[^\s<>\"')\]]+", open(body, encoding="utf-8", errors="replace").read())
    urls = [u.rstrip(".,;:") for u in urls if not NOISE.search(u)]
    if not urls:
        return ""
    best = next((u for u in urls if HINT.search(u)), urls[0])
    s = urlsplit(best)
    return "%s://%s" % (s.scheme, s.hostname or "?")


# the collection runs every hour: a PDF mail younger than this it has not had its round on yet
FRISS_MP = 2 * 3600


def fresh(date_env):
    try:
        sent = parsedate_to_datetime(re.sub(r'^<untrusted source="gmail">|</untrusted>$', "", date_env)).timestamp()
    except (TypeError, ValueError, IndexError):
        return False  # an unreadable date counts as old: the mail is listed, not hidden
    return time.time() - sent < FRISS_MP


counts, rows, cut = {}, [], []
for account in ("info", "balazs"):
    for l in open(os.path.join(work, account + ".txt"), encoding="utf-8"):
        l = l.rstrip("\n")
        if l.startswith("talalat: ") and "limit" in l:
            cut.append(account)
        m = LINE.match(l)
        if not m:
            # a message line of another shape (the relay's search has no attachment column) would be lost unseen
            if re.match(r"[0-9a-f]{8,32} \| ", l):
                print("HIBA: a(z) %s@ keresese ismeretlen alaku sort adott (nincs melleklet-oszlop: GCAL_KOZVETITO?), "
                      "a PDF nem dontheto el: %s" % (account, l[:80]), file=sys.stderr)
                sys.exit(2)
            continue
        mid, date, sender, subject, att = m.groups()
        names = re.sub(r'^<untrusted source="gmail">|</untrusted>$', "", att.strip())
        pdf = any(n.strip().lower().endswith(".pdf") for n in names.split(";") if n.strip())
        verdicts = seen.get((SOURCE[account], mid), [])
        os_col = "igen (%s)" % ", ".join(v + ("/" + r if r else "") for v, r in verdicts) if verdicts else "nem"
        if pdf and any(v in STORED for v, _ in verdicts):
            advice = "rendben"
        elif pdf and verdicts and all(v == "OWN_INVOICE" for v, _ in verdicts):
            advice = "rendben (sajat kimeno szamla)"
        elif pdf and verdicts:
            advice = "ember nezze: az OS latta, de nem tarolta"
        elif pdf and fresh(date):
            advice = "varja az OS-gyujtest"
        elif pdf:
            advice = "Drive-ba toltendo"
        else:
            u = link(account, mid)
            if u is None:
                advice = "ember nezze: a level nem olvashato (gcal.sh fetch)"
            elif u == "":
                advice = "ember nezze: nincs PDF es nincs link"
            else:
                advice = "belepes kell: " + envelope(u)
        key = advice.split(":")[0]
        counts[key] = counts.get(key, 0) + 1
        rows.append(" | ".join([account + "@", mid, date, sender, subject, "PDF van" if pdf else "PDF nincs", "OS latta " + os_col, advice]))

for r in rows:
    print(r)
summary = ", ".join("%s %d" % kv for kv in sorted(counts.items())) or "nincs szamla-jellegu level"
print("# %d level (%s)%s" % (len(rows), summary, "; A LIMIT VAGTA: " + ", ".join(cut) + "@ (200 talalat)" if cut else ""))
PY
