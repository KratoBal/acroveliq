"""The <untrusted> envelope of the fleet's Python scripts: one field of external text (a mail's
subject, a calendar title, a meeting title) on ONE line, as data. Used by gcal.sh and fireflies.sh;
the same tag names and shape as src/prompt-safety.ts (SECURITY_TAG_NAMES, SECURITY_TAG_RX).

1. Every C0 and C1 control (CR, LF, VT, FF, the separators U+001C..U+001E, ESC of an ANSI code,
   U+0085, a tab) and the two Unicode separators become a space: the listings are line- and
   tab-based, splitlines() and many displays break a line on more than CR and LF, and the output
   may reach a terminal (barracuda, #170 review).
2. THEN the security tags: a control the pattern's \\s does not cover (U+0001, ESC) inside a tag hid
   it from the replacement, and its space then made it one (barracuda, #173). Any case, any spacing
   ("< / Trusted-Peer"), and the closing ">" optional: an unclosed tag, or one cut by a length
   limit, would take the envelope's own closing tag and read as an open block (barracuda, #315).
   A ">" before the next "<" takes the whole tag; without one only the opening part goes, the
   rest of the field stays (the same pattern as src/prompt-safety.ts).
3. The replacement is random per run: a sender cannot pre-write it.
"""
import re
import secrets

SECURITY_TAG = re.compile(r"<\s*/?\s*(untrusted|trusted-peer|scheduled-task)\b(?:[^<>]*>)?", re.I)
STRIPPED = "[[SECURITY_TAG_REMOVED_%s]]" % secrets.token_hex(4)
# the two separators as escapes, never as the characters: an editor or a copy can turn those into
# spaces without a trace, and the line-break guard would go with them (barracuda on #316)
_CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+")


def untrusted(text, source):
    t = _CONTROLS.sub(" ", str(text))
    t = SECURITY_TAG.sub(STRIPPED, t)
    return '<untrusted source="%s">%s</untrusted>' % (source, t)
