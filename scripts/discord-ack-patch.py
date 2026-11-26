#!/usr/bin/env python3
"""ANSWERS: Does the Discord channel plugin answer by itself when acrobot stays silent for 10 seconds?

discord-ack-patch.py [--check] [server.ts path]

WHY (Balazs 2026-11-17 08:23:31 UTC, Acropora OS thread, msg 1572165276030476320): "ha ir nektek valaki
akkor h 10 masodpercen belul nem tudjatok a valaszt megadni akkor kotelezoen irjatok, hogy Megkaptam,
dolgozom rajta!". The same day he wrote "Hahooo" for hours in several threads while the main session was
busy in the foreground or the host was frozen. A rule the language model has to remember cannot answer
while the model is busy, so the answer comes from the plugin process itself, with no model turn.

WHAT IT DOES: patches the official plugin's server.ts in place (idempotent, marker DISCORD_ACK_PATCH):
  - an allowlisted inbound message starts a timer for its channel (one per channel; later messages in the
    same channel do not restart it);
  - ANY message the bot itself posts in that channel (a reply, an edit does not count) cancels the timer;
  - when the timer fires, the bot posts DISCORD_ACK_TEXT (default "Megkaptam, dolgozom rajta!").
  Env: DISCORD_ACK_MS (default 10000, 0 = off), DISCORD_ACK_TEXT.
The plugin cache is overwritten by a plugin update, so --check exits 1 when the marker is missing; the
channels start runs this script before it launches the session.
The patch takes effect when the channel session restarts (the plugin is a child process of it).
"""
import sys
from pathlib import Path

DEFAULT = Path.home() / ".claude/plugins/cache/claude-plugins-official/discord/0.0.4/server.ts"
MARK = "DISCORD_ACK_PATCH"

HELPER = """
// DISCORD_ACK_PATCH (marveen scripts/discord-ack-patch.py): auto-ack when the session is silent.
const ACK_MS = Number(process.env.DISCORD_ACK_MS ?? '10000')
const ACK_TEXT = process.env.DISCORD_ACK_TEXT ?? 'Megkaptam, dolgozom rajta!'
const ackTimers = new Map<string, ReturnType<typeof setTimeout>>()
function armAck(msg: Message): void {
  if (!(ACK_MS > 0)) return
  const chat = msg.channelId
  if (ackTimers.has(chat)) return
  ackTimers.set(chat, setTimeout(() => {
    ackTimers.delete(chat)
    const ch = msg.channel
    if ('send' in ch) {
      void (ch as any).send({ content: ACK_TEXT }).catch((e: unknown) =>
        process.stderr.write(`discord channel: auto-ack failed: ${e}\\n`))
    }
  }, ACK_MS))
}
function clearAck(chat: string): void {
  const t = ackTimers.get(chat)
  if (t) { clearTimeout(t); ackTimers.delete(chat) }
}
"""

OLD_LISTENER = """client.on('messageCreate', msg => {
  if (msg.author.bot) return"""
NEW_LISTENER = """client.on('messageCreate', msg => {
  if (client.user && msg.author.id === client.user.id) clearAck(msg.channelId)
  if (msg.author.bot) return"""

OLD_NOTIFY = """  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,"""
NEW_NOTIFY = """  armAck(msg)
  mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content,"""


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "--check"]
    check = "--check" in sys.argv[1:]
    path = Path(args[0]) if args else DEFAULT
    src = path.read_text(encoding="utf-8")
    if MARK in src:
        print(f"OK patched: {path}")
        return 0
    if check:
        print(f"MISSING: {path} has no {MARK}")
        return 1
    for old in (OLD_LISTENER, OLD_NOTIFY):
        if src.count(old) != 1:
            print(f"FAIL: anchor not found exactly once in {path} (plugin changed?):\n{old}")
            return 2
    src = src.replace(OLD_LISTENER, HELPER + "\n" + NEW_LISTENER, 1)
    src = src.replace(OLD_NOTIFY, NEW_NOTIFY, 1)
    path.with_suffix(".ts.orig").write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    path.write_text(src, encoding="utf-8")
    print(f"PATCHED: {path} (backup .ts.orig); restart the channel session to load it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
