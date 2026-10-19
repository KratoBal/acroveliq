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

## Install on a host (the owner, as root; nothing here is run by the fleet)

```
/opt/levelkozvetito/             root:root 755
  compose.yaml                   copy of level-kozvetito/compose.yaml, root 644
  .env                           root 644, one line: LEVELKOZVETITO_NODE_IMAGE=node:22-bookworm-slim@sha256:<digest>
  config.json                    from config.example.json, root 644 (no secret in it; the callers' token hashes, the excluded senders)
  src/                           git clone of KratoBal/acroveliq at the reviewed commit, root-owned
  karanten/                      10003:<gid of the fleet's quarantine reader> 2750 (setgid: files inherit the group)
  titkok/                        root:root 700
    oauth-client-id              10003:10003 400
    oauth-client-secret          10003:10003 400
    info-refresh-token           written by the consent command below (10003:10003 400)
    balazs-refresh-token         the same
```

Uid 10003 is the relay's (10001 is the deploy executor, 10002 the GPT runner); check `getent passwd 10003` is empty
on the host. The two refresh-token files must exist before `up` (compose mounts a file secret as it finds it): create
them empty, root 600, then the consent command fills them.

**The source in `src/` is the reviewed GitHub commit, checked, not "a clone".** Three lines, and the build starts only
if all hold (the same point #210, B1 and B8 failed on):

```
git -C /opt/levelkozvetito/src fetch origin
git -C /opt/levelkozvetito/src checkout --detach <the 40 hex digits of the merged commit on main>
test "$(git -C /opt/levelkozvetito/src rev-parse HEAD)" = "<the same 40 digits>" && test -z "$(git -C /opt/levelkozvetito/src status --porcelain)"
```

The tree is root's, so what is built is exactly the reviewed tree.

A caller's token is its own 0400 file; `config.json` holds only the sha256 of it (`printf %s "$(cat tokenfile)" | sha256sum`).

```
cd /opt/levelkozvetito && docker compose build && docker compose up -d
docker network connect levelkozvetito-hivas <the fleet container's name>
```

**The `karanten/` directory is the relay's own and read-only for the fleet** (barracuda, #247 review): mount the same
host directory READ-ONLY into the fleet container for the quarantine reader (that change waits for a planned
re-creation of the fleet container). Files older than 24 hours are removed by the relay's host cron (a line in the
install, not code here).

## Consent (Balázs's click, once per account; an agent cannot do it)

The scope is fixed in code per account (`src/level-kozvetito/oauth.ts`): balazs@ `gmail.modify`; info@ mail and
calendar READ only, no `gmail.send`. The old info@ token (2026-08-21) carries send; the relay never uses it, and
re-consenting with the narrower scope removes the power altogether. Do both.

```
cd /opt/levelkozvetito && docker compose --profile oauth run --rm oauth url balazs
```

The address it prints goes to Balázs. He opens it, signs in as that mailbox, accepts, and the browser lands on a page
that does not load (`http://localhost:8765/?state=...&code=...`). He copies the whole address bar into a file:

```
cd /opt/levelkozvetito && docker compose --profile oauth run --rm -T oauth code balazs - < pasted-address.txt
```

The command checks the `state` it issued, exchanges the code, and refuses a grant that is not EXACTLY the account's
scope set; the token is written to `titkok/balazs-refresh-token` and never printed. Then `docker compose restart levelkozvetito`.
Delete `pasted-address.txt` (the code is single-use, but the habit is cheap).

## Checks after install (each must hold, or the relay stays down)

- `docker inspect levelkozvetito`: no `docker.sock`, no `/opt/marveen-docker` path in `Mounts`; `ReadonlyRootfs=true`,
  `User` = `10003:10003`, `CapDrop=[ALL]`, `Privileged=false`. The `oauth` service is not running (profile).
- the fleet container's `docker inspect` has no `/opt/levelkozvetito/titkok` mount; `ls /run/secrets` there is empty.
- `docker compose logs levelkozvetito` shows `"event":"listening"`.
- from the fleet container: `curl -s http://levelkozvetito:8788/healthz` answers; a call with no or a wrong token answers 403.
- the log (`/var/lib/levelkozvetito/naplo.jsonl`) names the caller and the verb and carries no subject, sender or text.

## First smoke test, and what stays OFF until it is done

**`archival` stays out of the scheduled sorting until the first smoke test has measured the answer shape.** The relay's
`archival` reads `labelIds` from a `format=minimal` Gmail answer; that is the documented shape but no real call has
measured it yet (plan v2, "Mérés és határ"). The smoke test, with the owner present, on balazs@:

1. `lista` with `max` 3: the answer comes back in envelopes.
2. `cimke-letrehoz` for `Acrobot/Hírlevél`, then `cimkez` on ONE mail the owner names, then look at it in Gmail.
3. `archival` on that same mail: it archives (INBOX gone, label stays); `inbox-vissza` brings it back.
4. `archival` on a mail without the label: 403 `archival-szukitett`.

Only after step 3 and 4 are seen does the sorting task (slice 4) include `archival`. Until then it runs `lista`, `olvas`
and `cimkez` only.
