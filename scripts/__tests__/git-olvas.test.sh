#!/usr/bin/env bash
# Guard for scripts/git-olvas.sh (reviewer-profil, Balazs 2026-10-13 18:07 UTC):
#   1. a repo whose OWN config names programs (fsmonitor, a clean filter, a textconv
#      driver, a pager, a hooks path) runs none of them through the script, on a dirty
#      worktree. The positive control first runs plain git on the same repo and expects
#      every trap that git reaches on that path to fire, so a zero below is a measurement,
#      not an empty world;
#   2. the refused subcommands, options (whole, abbreviated, bundled) and paths stop
#      with exit 2 and leave nothing behind;
#   3. a tree another user could write, a gitfile and an alternates file are refused.
# The tree table is one line in the script; this test replaces it in a COPY, so the
# real script takes no path from its caller at all.
#
# Run: bash scripts/__tests__/git-olvas.test.sh   Exit 0 = all pass.
set -u
umask 022
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../git-olvas.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
check() {  # name, expected, actual
  if [ "$2" = "$3" ]; then echo "  [PASS] $1"; else echo "  [FAIL] $1 (got '$3', want '$2')"; fails=$((fails + 1)); fi
}
M="$T/markers"; mkdir "$M"
markers() { ls -A "$M" | tr '\n' ' ' | sed 's/ $//'; }

# ---- a booby-trapped repo -------------------------------------------------------------
R="$T/trap"
git init -q "$R"
git -C "$R" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
printf 'hello\n' > "$R/a.txt"
printf '*.txt filter=evil diff=evil\n' > "$R/.gitattributes"
git -C "$R" add a.txt .gitattributes
git -C "$R" -c user.name=t -c user.email=t@t commit -q -m files
printf '#!/bin/sh\ntouch %s/fsmonitor\nexit 1\n' "$M" > "$T/fsm.sh"; chmod 755 "$T/fsm.sh"
git -C "$R" config core.fsmonitor "$T/fsm.sh"
git -C "$R" config filter.evil.clean "touch $M/filter; cat"
git -C "$R" config diff.evil.textconv "touch $M/textconv; cat"
git -C "$R" config core.pager "touch $M/pager; cat"
mkdir "$R/hooks-evil"
git -C "$R" config core.hooksPath "$R/hooks-evil"
printf 'changed\n' >> "$R/a.txt"
touch -d '2001-01-01' "$R/a.txt"   # stat differs from the index: git must re-read it

echo 'positive control: plain git on the trapped repo fires the traps'
git -C "$R" status --short >/dev/null 2>&1
git -C "$R" diff >/dev/null 2>&1
git -C "$R" log -p -1 >/dev/null 2>&1
# the pager runs only on a terminal: script(1) gives git one
script -qec "git -C '$R' log -1" /dev/null >/dev/null 2>&1
check 'fsmonitor, filter, textconv and pager all fired' 'filter fsmonitor pager textconv' "$(markers)"
rm -f "$M"/*

# ---- the script copy, with test trees ------------------------------------------------
S="$T/git-olvas.sh"
GW="$T/gw"; git init -q "$GW"; git -C "$GW" -c user.name=t -c user.email=t@t commit -q --allow-empty -m i
chmod g+w "$GW/.git/refs"
GF="$T/gitfile"; mkdir "$GF"; printf 'gitdir: %s/.git\n' "$R" > "$GF/.git"
AL="$T/alt"; git init -q "$AL"; git -C "$AL" -c user.name=t -c user.email=t@t commit -q --allow-empty -m i
printf '%s/.git/objects\n' "$R" > "$AL/.git/objects/info/alternates"
# a signed commit, and a fake gpg first on the copy's PATH that leaves a marker: the
# %G? placeholders verify the signature, and with no gpg.program git runs `gpg` from
# PATH (barracuda, review of #69). The fake stands in for /usr/bin/gpg, which exists on
# the fleet host; a %G? output is no measure (with no key a real gpg runs and says E).
FAKE="$T/fakebin"; mkdir "$FAKE"
for g in gpg gpgsm ssh-keygen; do printf '#!/bin/sh\ntouch %s/%s\nexit 1\n' "$M" "$g" > "$FAKE/$g"; chmod 755 "$FAKE/$g"; done
SIGNED="$(printf 'tree %s\nparent %s\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\nsigned\n' \
  "$(git -C "$R" rev-parse HEAD^{tree})" "$(git -C "$R" rev-parse HEAD)" | git -C "$R" hash-object -t commit -w --stdin)"
echo 'positive control: plain git verifies the signature with gpg from PATH'
PATH="$FAKE:$PATH" git -C "$R" log -1 --format=%G? "$SIGNED" >/dev/null 2>&1
check 'the fake gpg ran' 'gpg' "$(markers)"
rm -f "$M"/*
sed -e "s|^TREES=.*|TREES=\"t=$R gw=$GW gf=$GF al=$AL\"|" -e "s|env -i PATH=/usr/bin:/bin |env -i PATH=$FAKE:/usr/bin:/bin |" "$SRC" > "$S"
check 'the copy has the test tree table' 1 "$(grep -c "^TREES=\"t=$R " "$S")"
check '... and the fake gpg first on its PATH' 1 "$(grep -c "env -i PATH=$FAKE:" "$S")"
mkdir "$T/tmp"
run() { TMPDIR="$T/tmp" bash "$S" "$@" >"$T/out" 2>"$T/err"; echo $?; }

echo 'the trapped repo through the script: nothing runs'
check 'status -> 0' 0 "$(run t status --short)"
check '... and it sees the dirty file' ' M a.txt' "$(cat "$T/out")"
check 'diff -> 0' 0 "$(run t diff)"
check 'log -p -> 0' 0 "$(run t log -p -1)"
check 'show -> 0' 0 "$(run t show HEAD:a.txt)"
check 'grep -> 0' 0 "$(run t grep -n hello)"
TMPDIR="$T/tmp" script -qec "bash '$S' t log -1" /dev/null >/dev/null 2>&1
check 'log on a terminal (where the pager would run) -> 0' 0 "$?"
# (%GT is left out: git 2.39.5 aborts on it, exit 134, with or without the script)
for f in '%G?' '%GS' '%GK' '%GF' '%GG' '%GP'; do
  check "log --format=$f on a signed commit -> 0" 0 "$(run t log -1 "--format=$f" "$SIGNED")"
done
check 'show --pretty=format:%G? -> 0' 0 "$(run t show -s "--pretty=format:%G?" "$SIGNED")"
check 'no trap fired, gpg included' '' "$(markers)"
check 'the private git dir is removed after every call' '' "$(ls -A "$T/tmp")"

echo 'refused subcommands'
for sub in push fetch pull checkout config commit reset clean gc fsck submodule; do
  check "$sub -> 2" 2 "$(run t "$sub")"
done

echo 'refused options: whole, abbreviated, bundled'
check 'diff --ext-diff' 2 "$(run t diff --ext-diff)"
check 'diff --textconv' 2 "$(run t diff --textconv)"
check 'log --show-signature' 2 "$(run t log --show-signature)"
check 'log --output=<file>' 2 "$(run t log "--output=$T/written")"
check '... and the file was not written' no "$([ -e "$T/written" ] && echo yes || echo no)"
check 'log --outp=<file> (prefix)' 2 "$(run t log "--outp=$T/written")"
check 'grep --open-files-in-pager' 2 "$(run t grep --open-files-in-pager hello)"
check 'grep --open-files (prefix, git accepts it)' 2 "$(run t grep --open-files hello)"
check 'grep -nO (bundled pager)' 2 "$(run t grep -nO hello)"
check 'grep -f <file>' 2 "$(run t grep -f "$T/fsm.sh")"
check 'grep -nf<file> (bundled)' 2 "$(run t grep "-nf$T/fsm.sh")"
check 'grep --no-index' 2 "$(run t grep --no-index hello)"
check 'grep --no-ind (prefix, git accepts it)' 2 "$(run t grep --no-ind hello)"
check 'grep --untracked' 2 "$(run t grep --untracked hello)"
check 'grep --recurse-submodules' 2 "$(run t grep --recurse-submodules hello)"
check 'log -pO<file> (bundled orderfile)' 2 "$(run t log -pO/etc/hostname)"
check 'diff -O<file>' 2 "$(run t diff -O/etc/hostname)"
check 'log --help (man or a browser)' 2 "$(run t log --help)"
check 'diff --git-dir=<dir>' 2 "$(run t diff "--git-dir=$GW/.git")"
check 'cat-file --batch' 2 "$(run t cat-file --batch)"
check 'cat-file --filters HEAD:a.txt' 2 "$(run t cat-file --filters HEAD:a.txt)"
check 'cat-file -p with no object' 2 "$(run t cat-file -p)"

echo 'refused paths'
check 'diff with an absolute path (implicit --no-index)' 2 "$(run t diff /etc/hostname a.txt)"
check 'diff with a ../ path' 2 "$(run t diff ../x a.txt)"
check 'log -- /abs' 2 "$(run t log -- /etc/hostname)"
check 'show -- a/../../x' 2 "$(run t show HEAD -- a/../../x)"

echo 'what stays allowed'
check 'grep -e with a pattern that looks like an option' 1 "$(run t grep -e --output)"
check 'grep with a pattern that looks like a path' 1 "$(run t grep /api/x)"
check 'grep -c (count)' 0 "$(run t grep -c hello HEAD)"
check 'log -C (copy detection)' 0 "$(run t log -C -1 --stat)"
check 'log origin..HEAD style range' 0 "$(run t log --oneline HEAD~1..HEAD)"
check 'cat-file -p HEAD' 0 "$(run t cat-file -p HEAD)"
check 'rev-parse HEAD' 0 "$(run t rev-parse HEAD)"
check 'ls-tree HEAD' 0 "$(run t ls-tree HEAD)"
check 'merge-base HEAD HEAD~1' 0 "$(run t merge-base HEAD HEAD~1)"
check 'no trap fired in this section either' '' "$(markers)"

echo 'trees'
check 'unknown tree name' 2 "$(run nincs log)"
check 'a .git/refs other users can write' 2 "$(run gw log)"
check 'a gitfile instead of a .git directory' 2 "$(run gf log)"
check 'objects/info/alternates' 2 "$(run al log)"
check 'too few arguments' 2 "$(run t)"

echo
[ "$fails" = 0 ] && { echo 'all pass'; exit 0; }
echo "FAILED: $fails"; exit 1
