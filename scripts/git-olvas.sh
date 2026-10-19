#!/usr/bin/env bash
# ANSWERS: Hogyan olvas a reviewer gitbol ugy, hogy nyers git jog nelkul, es a repo
# konfigja ne futtathasson nala programot?
#
# git-olvas.sh <fa> <alparancs> [argumentumok...]
#   fa:        marveen | os | commerce        (nev, nem utvonal; a tabla lent all)
#   alparancs: show | diff | log | status | ls-tree | cat-file | merge-base | rev-parse | grep
#
# WHY (reviewer-profil, Balazs 2026-10-13 18:07 UTC, msg 1559628609390383170): barracuda's
# profile has no git right, and every review stopped on `git show <sha>:<file>`, `git -C
# <tree> status` or a safe.directory check. A raw `git` allow rule is refused: git is not
# a read-only tool. The approval came with a condition: this script must restrict the
# subcommands' ARGUMENTS and any program execution that comes from git CONFIG.
#
# HOW PROGRAM EXECUTION FROM CONFIG IS CLOSED. git runs programs named in config while it
# only reads: core.fsmonitor (status, diff), filter.<x>.clean (a dirty worktree file in
# status or diff), diff.<x>.textconv, diff.external, core.pager, pager.<cmd>, gpg.program
# (log --show-signature), core.hooksPath. The trees below are marveen-owned and an agent
# cannot write them, but /home/marveen/work/acropora-commerce already sets
# core.hookspath=.githooks, and a denylist of keys can never be complete (filter driver
# names are free text). So the repository's own config is NEVER READ:
#   - git runs on a PRIVATE git dir made per call: objects, refs, packed-refs, index,
#     shallow and info/exclude are symlinks to the tree's .git, HEAD is a copy, and the
#     config is a two-line file written here. With no filter.*, diff.* or pager.* key in
#     any config, a .gitattributes `filter=`/`diff=` line names nothing to run.
#   - the environment is emptied (env -i): no system config, global config is /dev/null,
#     no GIT_EXTERNAL_DIFF, no GIT_PAGER from the caller, no optional index locks.
#   - belt and braces on the command line: core.hooksPath=/dev/null, core.fsmonitor=false,
#     submodule recursion off; --no-ext-diff/--no-textconv forced on diff, show, log, grep.
#   - SIGNATURES: with no config at all git still runs a program, the DEFAULT `gpg` from
#     PATH, for --format=%G?/%GS/%GK/%GF/%GG/%GP on a signed commit (and every merged
#     GitHub commit is signed). /usr/bin/gpg exists on the fleet host. So gpg.program,
#     gpg.ssh.program and gpg.x509.program are /bin/false: the placeholders answer, no
#     verifier runs (barracuda, review of #69; measured with a fake gpg on PATH).
# A private git dir also skips git's ownership check (safe.directory), which only guards
# repository DISCOVERY: that is why the reviewer no longer needs to look at it.
#
# HOW THE ARGUMENTS ARE RESTRICTED. No shell ever reads them (exec with an array, globbing
# off). Refused anywhere: options that run a program, write a file, read a file outside
# the tree, or leave the tree (FORBID_LONG, matched by PREFIX too, and short bundles read
# letter by letter: both measured, see there). `diff` takes no path outside the tree
# (git would silently switch to --no-index and read any file the caller can). `cat-file`
# takes exactly one of -p/-t/-s/-e and one object.
#
# TRUST IN THE TREE. Its .git must be a real directory (not a gitfile, not a symlink),
# owned by root, marveen or the caller, and nothing under .git that git reads here may be
# group- or world-writable or a symlink: a fleet-writable ref or object would let another
# agent change what the reviewer sees. barracuda's own agents/barracuda/commerce-olvaso
# fails this (every .git entry is 664/775 marveen:fleet, measured 2026-10-13) and is also
# behind (#469 vs #550), so `commerce` is the marveen-owned work clone instead.
#
# NO WRITE. No fetch, checkout or config write: the developer or acrobot brings the fresh
# state; the reviewer reads what is on the tree, and the packet README names the head.
#
# Exit: git's own code; 2 = refused here (one line on stderr: what and why).
set -uo pipefail
set -f
umask 077

# the only trees, by name. Tests replace this one line in a copy of the script.
TREES="marveen=/home/marveen/marveen os=/home/marveen/work/acropora-os commerce=/home/marveen/work/acropora-commerce cap=/home/marveen/work/caparium-napplo"
GIT_BIN=/usr/bin/git

deny() { echo "git-olvas: elutasitva: $*" >&2; exit 2; }
usage() {
  echo "usage: git-olvas.sh <marveen|os|commerce|cap> <show|diff|log|status|ls-tree|cat-file|merge-base|rev-parse|grep> [argumentumok]" >&2
  exit 2
}

[ "$#" -ge 2 ] || usage
NAME="$1"; SUB="$2"; shift 2
[ "$#" -le 64 ] || deny "legfeljebb 64 argumentum"

TREE=""
for t in $TREES; do
  [ "${t%%=*}" = "$NAME" ] && TREE="${t#*=}"
done
[ -n "$TREE" ] || deny "ismeretlen fa: '$NAME' (lehet: marveen, os, commerce, cap)"

case "$SUB" in
  show|diff|log|status|ls-tree|cat-file|merge-base|rev-parse|grep) ;;
  *) deny "a(z) '$SUB' alparancs nem olvaso, vagy nincs a listan" ;;
esac

# ---- the arguments ----------------------------------------------------------------
# Long options git must never see from the caller: they run a program, write a file,
# read a file from a caller-given path, or reach outside the tree (another repo, an
# untracked or ignored file, a submodule with its own config).
FORBID_LONG="--git-dir --work-tree --namespace --exec --exec-path --upload-pack --receive-pack
--ext-diff --textconv --show-signature --open-files-in-pager --help --html --man --web --info
--output --output-directory --no-index --untracked --no-exclude-standard --orderfile --file
--pathspec-from-file --attr-source --recurse-submodules --submodule --config-env --super-prefix"
# PREFIXES COUNT. Measured 2026-10-13 on git 2.39.5: grep, status and ls-tree take an
# unambiguous abbreviation (`grep --open-files` ran the pager, `grep --untr` and
# `grep --no-ind` worked), diff and log do not. So a long option is refused when it is a
# forbidden name OR the start of one: `--open-files`, `--no-ind`, `--o` all go. The cost
# is a refused abbreviation of a harmless option (`--o` for `--oneline`): spell it out.
long_forbidden() {
  local name="${1%%=*}" f
  for f in $FORBID_LONG; do
    [ "$name" = "$f" ] && return 0
    [ "${#name}" -ge 3 ] && [ "${f#"$name"}" != "$f" ] && return 0
  done
  return 1
}
# Short options BUNDLE (measured: `log -pO/x` read /x as the orderfile). A bundle is
# read letter by letter: a forbidden letter refuses, a letter that takes a value ends the
# bundle (the rest is its value, as git reads it). -O<file> is the orderfile in diff,
# show and log, and the pager in grep; -f<file> is grep's pattern file.
short_forbidden() {
  local tok="${1#-}" forbid="" value="" i ch
  case "$SUB" in
    diff|show|log) forbid="O"; value="UMCBlSGLnXI" ;;
    grep) forbid="Of"; value="eABCm" ;;
    *) return 1 ;;
  esac
  for (( i = 0; i < ${#tok}; i++ )); do
    ch="${tok:i:1}"
    case "$forbid" in *"$ch"*) return 0 ;; esac
    case "$value" in *"$ch"*) return 1 ;; esac
  done
  return 1
}
# a path that leaves the tree: absolute, home-relative, or with a '..' segment
outside_path() {
  case "$1" in
    /*|~*|..|../*|*/..|*/../*) return 0 ;;
  esac
  return 1
}

PAT_NEXT=0; SEEN_E=0; SEEN_DDASH=0; POS=0
for a in "$@"; do
  # grep: the value after -e, and the first positional when no -e came, is a PATTERN
  # ("/api/messages" is a fine pattern, not a path)
  if [ "$PAT_NEXT" = 1 ]; then PAT_NEXT=0; continue; fi
  if [ "$SEEN_DDASH" = 0 ]; then
    case "$a" in
      --) SEEN_DDASH=1; continue ;;
      --*) long_forbidden "$a" && deny "'$a' (programot futtat, fajlt ir vagy olvas a hivo utjarol, vagy kilep a fabol)"
           case "$a" in --regexp) [ "$SUB" = grep ] && { PAT_NEXT=1; SEEN_E=1; } ;; --regexp=*) SEEN_E=1 ;; esac
           continue ;;
      -?*) short_forbidden "$a" && deny "'$a' (-O vagy -f: programot futtat vagy fajlt olvas a hivo utjarol)"
           if [ "$SUB" = grep ]; then
             case "$a" in -e) PAT_NEXT=1; SEEN_E=1 ;; -e*) SEEN_E=1 ;; esac
           fi
           continue ;;
    esac
    if [ "$SUB" = grep ]; then
      POS=$((POS + 1))
      if [ "$SEEN_E" = 0 ] && [ "$POS" = 1 ]; then continue; fi
    fi
  fi
  # a positional: a revision or a path (after --, everything is a path)
  if [ "$SUB" = diff ] && outside_path "$a"; then
    deny "'$a' (diff: fan kivuli ut, a git --no-index modba valtana)"
  fi
  if [ "$SEEN_DDASH" = 1 ] && outside_path "$a"; then
    deny "'$a' (fan kivuli ut)"
  fi
done
[ "$PAT_NEXT" = 0 ] || deny "grep: a -e utan hianyzik a minta"

if [ "$SUB" = cat-file ]; then
  [ "$#" -eq 2 ] || deny "cat-file: pontosan ket argumentum kell: <-p|-t|-s|-e> <objektum>"
  case "$1" in -p|-t|-s|-e) ;; *) deny "cat-file: csak -p, -t, -s, -e" ;; esac
  case "$2" in -*) deny "cat-file: az objektum nem kezdodhet kotojellel" ;; esac
fi

# ---- the tree ---------------------------------------------------------------------
GD_REAL="$TREE/.git"
[ -d "$TREE" ] || deny "a fa nem letezik: $TREE"
[ -d "$GD_REAL" ] && [ ! -L "$GD_REAL" ] || deny "$GD_REAL nem valodi konyvtar (gitfile vagy symlink)"
ME="$(id -un)"
owner_ok() {
  local o
  o="$(stat -c %U "$1")" || return 1
  [ "$o" = root ] || [ "$o" = marveen ] || [ "$o" = "$ME" ]
}
writable_by_others() { [ $(( 0$(stat -c %a "$1") & 022 )) -ne 0 ]; }
owner_ok "$GD_REAL" || deny "$GD_REAL tulajdonosa $(stat -c %U "$GD_REAL"): csak root, marveen vagy a hivo fajat olvasom"
writable_by_others "$GD_REAL" && deny "$GD_REAL csoport vagy mas altal irhato"
[ -e "$GD_REAL/objects/info/alternates" ] && deny "$GD_REAL/objects/info/alternates letezik: objektumok masik tarbol"
LINKS=""
for e in objects refs packed-refs index shallow HEAD info/exclude; do
  p="$GD_REAL/$e"
  [ -e "$p" ] || [ -L "$p" ] || continue
  [ -L "$p" ] && deny "$p symlink"
  owner_ok "$p" || deny "$p tulajdonosa $(stat -c %U "$p")"
  writable_by_others "$p" && deny "$p csoport vagy mas altal irhato"
  LINKS="$LINKS $e"
done
for e in objects refs; do
  [ -d "$GD_REAL/$e" ] || deny "$GD_REAL/$e hianyzik"
  bad="$(find "$GD_REAL/$e" \( -perm /022 -o -type l \) -print -quit 2>/dev/null)"
  [ -z "$bad" ] || deny "$bad csoport vagy mas altal irhato, vagy symlink"
done
[ -f "$GD_REAL/HEAD" ] || deny "$GD_REAL/HEAD hianyzik"

# ---- the private git dir ----------------------------------------------------------
G="$(mktemp -d "${TMPDIR:-/tmp}/git-olvas.XXXXXX")" || deny "nem tudok ideiglenes konyvtarat letrehozni"
trap 'rm -rf "$G"' EXIT
mkdir "$G/info"
for e in $LINKS; do
  case "$e" in
    HEAD) cp "$GD_REAL/HEAD" "$G/HEAD" ;;
    *) ln -s "$GD_REAL/$e" "$G/$e" ;;
  esac
done
printf '[core]\n\trepositoryformatversion = 0\n\tbare = false\n' > "$G/config"

case "$SUB" in
  diff|show|log) FORCED=(--no-ext-diff --no-textconv) ;;
  grep) FORCED=(--no-textconv) ;;
  status) FORCED=(--ignore-submodules=all) ;;
  *) FORCED=() ;;
esac

cd "$TREE" || deny "nem tudok a fara lepni: $TREE"
# not exec: the trap must remove the private git dir afterwards
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$G" \
  GIT_DIR="$G" GIT_WORK_TREE="$TREE" \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 \
  GIT_PAGER=cat PAGER=cat GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 \
  "$GIT_BIN" --no-pager \
    -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.pager=cat \
    -c gpg.program=/bin/false -c gpg.ssh.program=/bin/false -c gpg.x509.program=/bin/false \
    -c submodule.recurse=false -c diff.ignoreSubmodules=all \
    "$SUB" "${FORCED[@]}" "$@"
