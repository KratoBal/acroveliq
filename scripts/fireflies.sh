#!/usr/bin/env bash
# ANSWERS: Milyen uj megbeszeles-leirat van Balazs Fireflies fiokjaban, es hol all a fajlja?
#
# Read-only client for the Fireflies GraphQL API (Balazs, 2026-10-20, "Balazs sajat dolgai" thread,
# memory 2421). The key is store/.fireflies-api-key (600), read at call time, never printed.
#
#   fireflies.sh check            the key works: prints OK or FAIL with the HTTP code
#   fireflies.sh new              transcripts not seen yet: one line each "<id>\t<date>\t<title>",
#                                 and each is saved to store/fireflies/<id>.json; the seen list is
#                                 store/fireflies/seen.txt (an id is added only after its file is saved)
#   fireflies.sh fetch <id>       save one transcript to store/fireflies/<id>.json, print the path
#   fireflies.sh parts <id>       split the saved transcript into ~20 KB text parts under
#                                 store/fireflies/parts-<id>/, one path per line. The quarantine
#                                 reader takes in only about the first quarter of a 2-hour meeting's
#                                 JSON (measured 2026-10-20: 188 KB file, the summary stopped early),
#                                 so a long meeting is read part by part, never as the whole file.
#
# The saved JSON is EXTERNAL content (what was said in a meeting): open it only through
# scripts/karanten-olvas.sh, never with cat. Titles in the "new" output are external text too: the
# invitation sets them, so each comes in an <untrusted source="fireflies"> envelope on its own line
# part, like gcal.sh's (P1-00f; barracuda on #314).
set -uo pipefail
# FIREFLIES_ROOT: the tests' own tree (a stub key, a stub curl); the live tree when unset
ROOT="${FIREFLIES_ROOT:-/home/marveen/marveen}"
KEY="$ROOT/store/.fireflies-api-key"
DIR="$ROOT/store/fireflies"
API=https://api.fireflies.ai/graphql
umask 077
mkdir -p "$DIR"; touch "$DIR/seen.txt"

gql() {  # $1 = JSON body file; prints the response body, exit 1 on a non-200
  local out code
  out="$(mktemp "$DIR/.resp.XXXXXX")"
  code="$(curl -s -o "$out" -w '%{http_code}' --max-time 60 -X POST "$API" \
    -H 'Content-Type: application/json' -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$KEY")") \
    --data-binary @"$1")"
  if [ "$code" != 200 ]; then echo "FAIL: HTTP $code" >&2; rm -f "$out"; return 1; fi
  cat "$out"; rm -f "$out"
}

body() {  # $1 = GraphQL query, $2 = variables JSON (optional); writes a temp body file, prints its path
  local f; f="$(mktemp "$DIR/.req.XXXXXX")"
  python3 -I -c 'import json,sys; json.dump({"query":sys.argv[1],"variables":json.loads(sys.argv[2])},open(sys.argv[3],"w"))' "$1" "${2:-{\}}" "$f"
  echo "$f"
}

fetch() {
  local id="$1" b
  case "$id" in *[!A-Za-z0-9_-]*|"") echo "FAIL: bad id" >&2; return 2;; esac
  b="$(body 'query T($id:String!){ transcript(id:$id){ id title date duration participants organizer_email summary { overview action_items keywords shorthand_bullet } sentences { speaker_name text start_time } } }' "{\"id\":\"$id\"}")"
  gql "$b" > "$DIR/$id.json.tmp" || { rm -f "$b" "$DIR/$id.json.tmp"; return 1; }
  rm -f "$b"; mv "$DIR/$id.json.tmp" "$DIR/$id.json"; echo "$DIR/$id.json"
}

case "${1:-}" in
  check)
    b="$(body '{ user { user_id } }')"
    if gql "$b" >/dev/null; then echo OK; else echo FAIL; fi; rm -f "$b" ;;
  new)
    b="$(body '{ transcripts(limit: 20) { id title date } }')"
    resp="$(gql "$b")" || { rm -f "$b"; exit 1; }; rm -f "$b"
    printf '%s' "$resp" | python3 -I -c '
import json,sys,datetime
# the envelope gcal.sh uses too (scripts/lib/untrusted_envelope.py): controls first (a tab would
# split this tab-separated line), then any security tag, closed or not, by a per-run marker
# loaded from its file, not through sys.path (barracuda on #316)
import importlib.util as ilu
spec=ilu.spec_from_file_location("untrusted_envelope",sys.argv[2]+"/untrusted_envelope.py")
mod=ilu.module_from_spec(spec); spec.loader.exec_module(mod); untrusted=mod.untrusted
seen=set(l.strip() for l in open(sys.argv[1]))
d=json.load(sys.stdin)
for t in (d.get("data") or {}).get("transcripts") or []:
    if t["id"] in seen: continue
    dt=datetime.datetime.fromtimestamp((t.get("date") or 0)/1000).strftime("%Y-%m-%d %H:%M")
    print(t["id"]+"\t"+dt+"\t"+untrusted((t.get("title") or "")[:120],"fireflies"))' "$DIR/seen.txt" "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib" > "$DIR/.new.txt" || exit 1
    while IFS=$'\t' read -r id dt title; do
      [ -n "$id" ] || continue
      fetch "$id" >/dev/null && echo "$id" >> "$DIR/seen.txt" && printf '%s\t%s\t%s\n' "$id" "$dt" "$title"
    done < "$DIR/.new.txt"
    rm -f "$DIR/.new.txt" ;;
  fetch) fetch "${2:-}" ;;
  parts)
    id="${2:-}"
    case "$id" in *[!A-Za-z0-9_-]*|"") echo "FAIL: bad id" >&2; exit 2;; esac
    [ -f "$DIR/$id.json" ] || { echo "FAIL: no file, run fetch first" >&2; exit 1; }
    python3 -I -c '
import json,os,sys
src,out=sys.argv[1],sys.argv[2]
d=json.load(open(src))["data"]; d=d.get("transcript",d)
lines=["[%03dp] %s: %s"%(int((x.get("start_time") or 0)//60),x.get("speaker_name") or "?",x.get("text") or "") for x in d.get("sentences") or []]
os.makedirs(out,exist_ok=True)
for f in os.listdir(out): os.remove(os.path.join(out,f))
chunks,cur,n=[],[],0
for l in lines:
    if n+len(l)>20000 and cur: chunks.append(cur); cur,n=[],0
    cur.append(l); n+=len(l)+1
if cur: chunks.append(cur)
for i,c in enumerate(chunks,1):
    p=os.path.join(out,"part%d.txt"%i); open(p,"w").write("\n".join(c)); print(p)
last=(d.get("sentences") or [{}])[-1].get("start_time") or 0
print("%d sentences, %d min, %d parts"%(len(lines),last//60,len(chunks)),file=sys.stderr)' "$DIR/$id.json" "$DIR/parts-$id" ;;
  *) echo "HASZNALAT: fireflies.sh check|new|fetch <id>|parts <id>" >&2; exit 2 ;;
esac
