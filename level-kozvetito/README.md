# The mail relay (task level-kozvetito)

A service that gives the fleet **named** operations on the info@ and balazs@ mailboxes and no arbitrary Gmail
call. Plan: `exchange-out/level-kozvetito-terv-v2-2026-10-19.md` (barracuda APPROVE). Code: `src/level-kozvetito/`.
It runs in its own container (slice 3) and nothing in the fleet reaches Google's keys but it.

## The verbs (a closed list; anything else answers 404, whoever asks)

| account | verb | input | what comes back |
|---|---|---|---|
| both | `lista` | `q` (<= 200 chars), `max` (1-50) | per mail: id, date, from, subject in `<untrusted>` envelopes; an **excluded** sender: id, date, domain only |
| both | `olvas` | `id` | the body in an envelope with codes and token-links taken out; the attachments by number; an excluded sender: nothing of the text |
| both | `csatolmany` | `id`, `n` | the file written under the quarantine folder; the **relative path** only. An excluded sender: 403 |
| info@ | `naptar` | `tol`, `ig` (ISO times, <= 31 days) | the events, title/place/description in `<untrusted source="gcal">` envelopes |
| balazs@ | `cimke-letrehoz` | `nev`: one of the five | creates the label if missing |
| balazs@ | `cimkez` | `id`, `cimke`: one of the five | puts that label on the message |
| balazs@ | `archival` | `id` | takes INBOX off a mail that **already carries `Acrobot/Hírlevél`** (read from Gmail now), at most `archivePerDay` a Budapest day |
| balazs@ | `inbox-vissza` | `id` | puts INBOX back on a mail **this relay archived** in the last 7 days |

The five labels: `Acrobot/Számla`, `Acrobot/Beszállító`, `Acrobot/Ügyfél`, `Acrobot/Hírlevél`, `Acrobot/Tennivaló`.
**Sending mail is not a verb, for either account** (acrobot 32521: info@ sending nowhere for now). The info@ token
still carries `gmail.send` from its 2026-08-21 consent; the code never calls it, and the source test below keeps it so.

## What is guaranteed, and by what

- **Who may call:** a bearer token per caller, checked as a hash in constant time. The network alone would let every
  agent of the fleet in. The log names the caller; an unknown one is `ismeretlen`, never the token.
- **What may be written:** `gmail.modify` also allows *sending* in Balázs's name. The protection is the code:
  `modify.ts` is the only file that names a write endpoint (`/modify` of one message, `/labels`), the transport posts
  only to the shapes `modify.ts` hands it, and a request names only `INBOX` or one of the five labels (so never
  TRASH). `src/__tests__/level-kozvetito-forras.test.ts` reads the source and turns red on a send, trash, delete,
  import, insert, settings, batchModify or watch endpoint, a PUT/PATCH/DELETE, a send/compose scope, a trash/spam/sent
  label word, or a second `removeLabelIds`.
- **What leaves toward a model:** every mail text inside an `<untrusted>` envelope; an excluded sender's (account
  security, banks) text, subject and attachments not at all; elsewhere standalone 4-8 digit numbers (per account, only
  near a code word), token-carrying links and key-like strings taken out. The caller cannot switch it off.
- **What is logged:** caller, account, verb, mail id, result. Never a mail's text, a subject, a sender or a search.

## Known limits

- Redaction narrows what a mail can hold; it does not make it safe. A code written in words, or a secret under an
  innocent sender, gets through. The default also takes short invoice numbers (`083906`) as codes; `near-code-word`
  exists for the info@ invoice reading if the two-path comparison shows the price is too high.
- The reader of this output is still a model. The archive is therefore narrowed in the relay (a label that must
  already be there, a daily cap, an undo), not left to the caller.
- A real call to Google has not been made by this code yet; the fake used in the tests follows `scripts/gcal.sh`.

## Conditions the installation sheet (slice 3) must state

- **`quarantineDir` is the relay user's own, mode 750, and read-only for the fleet** (barracuda, #247 review). The
  relay checks each folder level (`lstat`) and opens the file with `O_NOFOLLOW`, but between a check and the next
  step an agent who could write the folder could swap a directory for a link. If the fleet cannot write there, the
  gap is closed. The fleet's quarantine reader gets read access (group), nothing more.
- An attachment file is readable by whoever reads that folder, so the folder gets an age limit.
- The config file is root-owned and read-only inside the container; the secrets are compose secrets.
