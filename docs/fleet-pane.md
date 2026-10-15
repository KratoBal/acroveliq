# fleet-pane: the root broker into agent panes (B48 (2))

Plan: `exchange/biztonsag/baseline/b48-kezbesito-terv-2026-10-13.md` (42879c96, barracuda APPROVE).
Task: `t-20261015-b48-fleet-pane` (acrobot 31133). This page is the first PR: the broker and the
router's switch. **Nothing here is installed by the PR**, and the switch defaults to off.

## Why

`marveen ALL=(agent-*) NOPASSWD: /usr/bin/tmux` gives anything running as `marveen` a full shell
as every agent user (`tmux new-session <command>`, `run-shell`), and with it the agents' tokens.
The broker replaces it with one root command that takes a closed list of verbs and looks at the
pane before every key it sends.

## What is in this PR

| Part | Where |
|---|---|
| the broker (verbs: status, capture, stop, deliver, dismiss, interrupt, clear, submit) | `scripts/root/fleet-pane.py` |
| its tests (the plan's section 8 parts that need no installed broker) | `scripts/__tests__/fleet-pane.test.py` (CI: `test.yml`) |
| the agents list format | `scripts/root/fleet-pane-agents.example.json` |
| the router's side: tmux shapes to verbs, typing through the broker, the switch | `src/web/fleet-pane.ts`, `src/web/agent-process.ts` |
| the switch | `FLEET_PANE_BROKER=on` (default `off`) |

Not in this PR: `start` (the generated root-owned start scripts, the session-id with nautilus).
With the switch on, `new-session` still goes down the old line, so **the tmux sudo line cannot be
removed before the second PR**.

Two verbs beyond the plan's list, each with its own look: `clear` (the router empties a parked
box today with `C-a`/`C-k`/`Delete`, or `C-c` on a paste placeholder; the broker never sends
`C-c` to an empty box, it would quit Claude Code) and `submit` (the stuck-input watcher's Enter,
only on a parked box with no dialog and no running turn).

## Known limits with the switch on

- The text comes from the router on stdin (plan 4.4's simpler option): the broker guarantees what
  is typed and when, not who sent it (that is P0-1 and B52).
- A text whose first character is not a letter or `[` is refused (`bad-start`): the first key is
  never a digit. Today this hits `/login` (routes/agents.ts) and the `/name` identity commands;
  both stop with a log line until the second PR.
- The dashboard terminal's `/keys` has no verb: refused (the plan's D6 decides who may type there).
- A delivery into a pane that is not idle is refused, not sent best-effort (plan 4.3 #7); the
  router keeps the message. The scheduler's `forceSend` and the wake-ups try the queued path once.
- The race between the look before the Enter and the Enter is not closed (plan 4.3); a dialog seen
  right after the Enter is logged as `suspect-accept`.

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

## Installing (Balázs's steps, on the stage fleet first, each separately approved)

```
cd /opt/marveen-docker && docker compose exec -u root marveen sh -c '
  install -o root -g root -m 0755 /home/marveen/marveen/scripts/root/fleet-pane.py /usr/local/sbin/fleet-pane &&
  install -d -o root -g root -m 0755 /etc/fleet-pane &&
  install -o root -g root -m 0644 <the reviewed agents.json> /etc/fleet-pane/agents.json &&
  install -o root -g root -m 0640 /dev/null /var/log/fleet-pane.log &&
  echo "marveen ALL=(root) NOPASSWD: /usr/local/sbin/fleet-pane" > /etc/sudoers.d/fleet-pane &&
  chmod 0440 /etc/sudoers.d/fleet-pane && visudo -c'
```

Then `FLEET_PANE_BROKER=on` and a dashboard restart. The old tmux line stays next to it (plan 7).
Back: `FLEET_PANE_BROKER=off` and a dashboard restart (seconds); the files can stay.

## Still to measure after installing (plan section 8)

N3 (after the second PR: no tmux line in `sudo -l`), N5 (start), N6 live, N7 (`/keys`), N8 (the
installed files not writable as `marveen`, the sha256 equal to the repo's), and P1-P4 (delivered
with the log's hash, every verb on every agent, first start, 24 hours against the 24 before).
