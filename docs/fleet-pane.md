# fleet-pane: the root broker into agent panes (B48 (2))

Plan: `exchange/biztonsag/baseline/b48-kezbesito-terv-2026-10-13.md` (42879c96, barracuda APPROVE).
Task: `t-20261015-b48-fleet-pane` (acrobot 31133). First PR (#182, #185): the broker and the
router's switch. Second PR: the `generate` and `start` verbs, plan v2 in
`review-csomagok/doc-t-20261015-b48-fleet-pane` (barracuda APPROVE, 31245/31252). **Nothing here is
installed by a PR**, and the switch defaults to off.

## Why

`marveen ALL=(agent-*) NOPASSWD: /usr/bin/tmux` gives anything running as `marveen` a full shell
as every agent user (`tmux new-session <command>`, `run-shell`), and with it the agents' tokens.
The broker replaces it with one root command that takes a closed list of verbs and looks at the
pane before every key it sends.

## What is in it

| Part | Where |
|---|---|
| the broker (verbs: status, capture, stop, deliver, dismiss, interrupt, clear, submit, generate, start) | `scripts/root/fleet-pane.py` |
| its tests (the plan's section 8 parts that need no installed broker) | `scripts/__tests__/fleet-pane.test.py` (CI: `test.yml`) |
| the agents list format (user, workdir, **profile**) | `scripts/root/fleet-pane-agents.example.json` |
| the start value sets | `scripts/root/fleet-pane-start-values.example.json` |
| the router's side: tmux shapes to verbs, typing and starting through the broker, the switch | `src/web/fleet-pane.ts`, `src/web/agent-process.ts` |
| the switch | `FLEET_PANE_BROKER=on` (default `off`) |

With the switch on, nothing the router sends to an agent under its own user goes down the old
line: a `new-session` has no verb and is refused, a start is `generate` + `start`.

## Starting an agent (the second PR)

The router used to build the launch as a shell string for `tmux new-session`, so whoever runs as
`marveen` could start any command as the agent. Now:

- **`generate <agent>`** rewrites `/etc/fleet-pane/start/<agent>` (`root:root 0755`, atomic) from
  the root agents file (user, workdir, **profile**), the root value sets
  (`/etc/fleet-pane/conf/start-values.json`) and only two fields of the agent's config: `model` (must be
  on the list) and `displayName` (a pattern, else the agent's name; it becomes `--name`). The
  config's `securityProfile` is only compared: a difference refuses (`profile-mismatch`), because
  the agent can write its own config (barracuda measured it) and the router writes the
  `settings.json` lists from it. `authMode: api`, `claudePlan`, `claudeConfigDir` and any channel
  refuse; nothing falls back silently. The config is read with `O_NOFOLLOW`, regular files only,
  64 KiB at most, and a refusal names the reason, never the content.
- **The workdir chain.** `agents/` and `agents/<name>` are `marveen`'s, so root opens the workdir
  from `/` one element at a time, each without following a link (`workdir-unsafe` on a symlink),
  and reads the config, the channel token files (stat only) and the read clones relative to that
  directory fd. A parent swapped for a symlink after the check moves nothing; a `.claude`,
  `channels` or provider dir that is a symlink counts as a channel and refuses (barracuda, #191
  review 31282).
- **The claude binary** the script runs must be root's, with every directory above it, none
  writable by others and no symlink on the way (`claude-bin-...`); otherwise there is no start
  (acrobot 31242, barracuda 31245). Today's `~marveen/.local/share/claude/versions/...` is
  `marveen`'s, so the install copies the pinned version to `/etc/fleet-pane/conf/claude/<version>/claude`.
- **`start <agent> [--continue | --session-id <uuid>]`** runs that script, nothing else, with one
  item of the closed launch list (nautilus 31151), through `env -i` (HOME, USER, LOGNAME, SHELL,
  LANG, LC_ALL, TZ, TERM only), and without a shell between tmux and bash (tmux 3.3a runs a
  multi-argument command directly; measured). The script checks its arguments again (`exit 64`),
  reads the OAuth token itself as the agent (path A, acrobot 31154: root never reads it), and
  `exec`s claude with `--model` and `--name`; `--dangerously-skip-permissions` only for a
  `permissive` profile in the value sets.
- The router calls `generate` before every start (so a model change on the list needs no root
  step; a profile change does), and types no `/name` into a broker-started agent. `/login` is never
  automated.

What the agent's environment loses against the old line: `TMUX`, `TMUX_PANE`, `HOSTNAME`, `MAIL`,
`SUDO_*`. The settings' `env` (`DATABASE_URL` and the like) comes from `settings.json` as before.
Whether Claude Code draws its footer the same without `TMUX` is P2/P3's live measurement.

Two verbs beyond the plan's list, each with its own look: `clear` (the router empties a parked
box today with `C-a`/`C-k`/`Delete`, or `C-c` on a paste placeholder; the broker never sends
`C-c` to an empty box, it would quit Claude Code) and `submit` (the stuck-input watcher's Enter,
only on a parked box with no dialog and no running turn).

## Known limits with the switch on

- The text comes from the router on stdin (plan 4.4's simpler option): the broker guarantees what
  is typed and when, not who sent it (that is P0-1 and B52).
- A text whose first character is not a letter or `[` is refused (`bad-start`): the first key is
  never a digit. Today this hits `/login` (routes/agents.ts), which stays a human step; `/name`
  is the start script's `--name` since the second PR.
- A start refuses an agent with a channel, an API-key or another endpoint's model, a Claude plan or
  its own config dir: none of the six agents has one today (measured 2026-10-15). Each needs its
  own reviewed extension, not a fallback.
- The dashboard terminal's `/keys` has no verb: refused (the plan's D6 decides who may type there).
- A delivery into a pane that is not idle is refused, not sent best-effort (plan 4.3 #7); the
  router keeps the message. The scheduler's `forceSend` and the wake-ups try the queued path once.
- The race between the look before the Enter and the Enter is not closed (plan 4.3); a dialog seen
  right after the Enter is logged as `suspect-accept`.

## Typing pace and the content gates (task `broker-beillesztes-helyorzo`, 2026-10-19)

**The finding** (acrobot, live pane capture): the Claude TUI folds pieces that arrive quickly one after the other into a
`[Pasted text #N]` stub (no line count) and shows the first piece, or the tail of the message, verbatim beside it. A plain Enter on
a stub only unfolds it. The same quick typing is the probable cause of `not-in-box`: a look 30 ms after the last piece can see an
EMPTY box, because the TUI gathers fast input until a gap. Ten idle-path deliveries not-landed since 10-16, and the double
delivery of 32993 and 33086, came from here.

**What `deliver` does now** (`scripts/root/fleet-pane.py`):

- a pause between pieces (0.12 s, `PIECE_PAUSE`) and the next piece only after the previous one is DRAWN: the last 16 non-space
  characters typed so far must be the tail of the box, with every whitespace dropped on both sides (a wrap, the continuation indent
  and the pad are not text). The wait is time based (0.6 s, `ECHO_WAIT`); no echo means stop typing, not a blind continuation;
- a stub seen while typing stops the typing; the box is emptied (`clear`, with the stable-look rule below) and the text typed once
  more, slower (twice the pause and the wait). A stub again: the box is emptied and the answer is `placeholder-cleared`;
- before the Enter, the box must be the SAME in two looks in a row and not empty (`settle`), then a pause, then a last look: a late
  fold at that point is emptied too (`placeholder-cleared`), never left parked;
- the broker's own deadline is `DELIVER_BASE + DELIVER_PER_PIECE x pieces` (40 s + 2.2 s each): at the deadline the typing stops,
  the typed beginning is emptied, `deliver-timeout`. The router waits 30 s longer (`deliverTimeoutMs`, a test reads both numbers from
  this file), so the broker answers first and the box is never left half typed by a killed run;
- a failed deliver empties the box ONLY when the box holds exactly a beginning of what this call typed (whitespace aside).
  Anything else in it (an earlier draft, somebody's paste) stays and the answer is `not-in-box`.

**Ctrl-C and the stub.** Ctrl-C empties a stub, but on an EMPTY box it starts the exit and a second one quits the session. So every
Ctrl-C is preceded by a STABLE look (two identical looks) that still shows the stub; an empty stable look ends the loop; at most
three presses. Limit: a TUI that keeps showing the stub for more than about 0.6 s after the Ctrl-C and then empties it would get a
second press on an empty box. The model assumes the redraw is faster (measured only as "not a problem so far").

**`submit --expect` and `clear --expect`** (the expected text on stdin): the Enter goes only on a box that holds exactly that text
(`not-ours` or `placeholder` otherwise, nothing pressed); the clear empties a box that holds that text, or that text folded around a
stub with a verbatim run of at least 8 characters beside it (a bare stub is indistinguishable from somebody's paste: `not-ours`).
Without `--expect` the verbs behave as before. An older broker answers `bad-option` (exit 2); the router's parked takeover then falls
back to the plain verbs once, because the old `parked` already meant "the box holds ONLY our text".

**The router** (`src/web/parked-takeover.ts`, `agent-process.ts`): `parked` takes `submit --expect` (at most 3, a settle between); a
box that is not exactly ours or a stub gets the content-gated `clear --expect`; `no-echo`, `placeholder-cleared` and `deliver-timeout`
mean the broker emptied it itself. A text a slow TUI draws LATER than the broker waited sits in the box unseen; the next deliver of
the same message gets `box-not-free`, and the router first tries `clear --expect` with that very message: ours is emptied and the
message typed once more, anything else is left alone.

**The pace file** `/etc/fleet-pane/conf/deliver-pace.json`: `{"echoWait": 0..2, "piecePause": 0.01..1}` seconds. The directory is the
owner's host mount (read only in the container, see `FP_CONF` in `scripts/fleet-bootstrap.sh`), so the file SURVIVES a container
recreation and the bootstrap never writes it. Missing, not root-owned, group or world writable, a symlink, or out of range: the
built-in values (never a refusal). `{"echoWait": 0, "piecePause": 0.03}` is the old tempo: that is the rollback if the new pace
misbehaves on the real TUI, without a new broker version.

**The model is NOT MEASURED on the real TUI.** `scripts/__tests__/fleet-pane.test.py` (class `Tui`) is a model of the capture above:
pieces closer than 0.10 s are gathered and fold past 700 characters, an Enter on a stub unfolds, Ctrl-C on an empty box exits, the
redraw after a Ctrl-C takes 0.3 s. Its numbers are the live capture's, its timing is an assumption. First live measurement, after the
install and before other traffic: one 2000+ character message to a spare agent, then read the broker log (`/var/log/fleet-pane.log`,
root) for the reason and count the Ctrl-C presses. Known non-red calibration: the in-typing stub return only saves the echo wait (the
echo check alone also stops the typing).

## Two tmux facts the typing depends on (measured on tmux 3.3a, 2026-10-15)

- An argument that ENDS in `;` is a command separator: `E;` types `E`, `A\;` types `A;`, a lone
  `\;` types `;`. So no piece the broker sends ends in `;`: trailing semicolons go as their own
  `\;` pieces. A `;` or a backslash inside a piece is typed as is.
- `send-keys -l -- <piece>` takes `--` as the end of options, so a piece starting with `-` is text.

Re-measure both when tmux is upgraded; `scripts/__tests__/fleet-pane.test.py` simulates the first.

## The pane rules exist twice

The broker carries a Python copy of `src/pane-state.ts` (its gate must not be code `marveen` can
write). `scripts/__tests__/fixtures/pane-samples.json` holds panes with the expected answer (may a
message be typed into it idle, or queued into a running turn), and BOTH sides are tested against
every row: `src/__tests__/pane-samples-shared.test.ts` and `scripts/__tests__/fleet-pane.test.py`.
A pane-state change that moves an answer turns red there; the Python copy follows in the same PR.

## Installing

The step list, in Hungarian for the owner: `docs/fleet-pane-telepites.md` (what goes into sudoers, what is removed, how
to go back, what to measure). In short: the root files (`agents.json`, `start-values.json`, the pinned claude binary and,
once the tmux line is retired, the `no-tmux-line` marker) live in a host directory mounted read-only at
`/etc/fleet-pane/conf`; `scripts/fleet-bootstrap.sh` step 4c installs the pinned broker, `/etc/fleet-pane/start` and
`/etc/sudoers.d/fleet-pane` on every boot where that mount is, so a container recreate keeps the broker, and step 4 stops
writing the tmux line once the marker is there. A broker change carries its new `FP_PIN` in the same PR
(`scripts/__tests__/fleet-bootstrap-fleet-pane.test.py` is red until it does).

The shell tools that reach agent panes (`agent-pane.sh`, `feladat-keret-or.sh`, `fleet-doctor.py`,
`agent-to-own-user.sh`) read the switch the router's way (`scripts/lib/fleet_pane_switch.py`) and take the broker when it
is on.

The B48 class is not closed by the start verb alone: the router still writes the agent's
`settings.json` (hooks) and the agent its own config (plan 2.3, B45).
