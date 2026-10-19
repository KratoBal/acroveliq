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
  titkok-ver/                    10003:10003 700 (the versioned client-secret store, see "The secret door"; empty until the first write)
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

## The secret door (task parancssor-f-titok-urlap; contract: `exchange/acroveliq/parancssor-f-titok-urlap-szerzodes-2026-10-19.md`, barracuda APPROVE v2)

The control panel's form (Vault page, "Közvetítő titkok") hands the relay a new `oauth-client-secret`, and the relay writes
its OWN store. Nobody runs a command: the value never goes through a shell, a channel or `store/`.

- **Door:** `POST /titok/oauth-client-secret/<ir|lezar|visszaall>`, a bearer token from `secretWriters` (a list apart from `callers`:
  a mail caller cannot write, a writer cannot read mail). `ir` takes `{"ertek": "<8-512 visible characters>"}` and answers the
  length, the version and the state, nothing else. The only target is the constant `SECRET_TARGETS` in `titok.ts`; the first PR has no `oauth-client-id`
  (a new client id invalidates the refresh tokens and has no pre-flight: a separate plan, with a Discord approval).
- **Pre-flight before anything is stored:** the candidate secret is tried at Google's token endpoint with BOTH accounts' refresh tokens; one access token
  accepts it (and is dropped, not cached). Refused with `invalid_client`: `szolgaltato-elutasitotta`; only `invalid_grant` (a withdrawn consent, nothing
  about the candidate): `frissito-token-hiba`; no answer: `szolgaltato-nem-elerheto`. Nothing on disk changes on a refusal.
- **Store:** `titkok-ver/<target>.v<N>` (0400) and the pointer `<target>.aktiv` (`{"aktiv":N,"elozo":M|null}`), every change by temp file, fsync, rename, fsync of the
  directory. Version 0 is the compose secret in `titkok/` (read-only, untouched). The state IS the pointer: a file it does not name is unreachable and is
  removed by the next write or close. **A damaged or foreign pointer stops the target** (the relay does not start with it), it never falls back to the compose secret.
- **Rotation:** after `ir` the previous value stays (`rotacio-nyitva`) until `lezar` (deletes every non-active version) or `visszaall` (swaps back; `lezar` then
  leaves one version file). The real close is the revocation at Google; **the old value stays in the host's `titkok/oauth-client-secret` until the owner empties it.**
- **Who can write, stated plainly (measured by acrobot from the marveen account, 2026-10-19 15:5x):** whoever runs under the marveen uid can read the panel's token file
  and call the door directly, without the session gate: the control panel (`node dist/index.js`), the main agent's own session, **two more `claude` processes in the
  `acrobot-worker` tmux session (pids 1104 and 1118), both started with `--dangerously-skip-permissions`, so they read the token file and call the door without a permission
  prompt**, and the four `bun` channel plugins. It is not one agent. The bound is the same for all of them and is in the code: the pre-flight and the fixed target list; the worst
  case is the mail branch stopping, and `visszaall` undoes it. The session gate is the owner's hand at the button, not the protection.
- **Log:** `titok_ir`, `titok_lezar`, `titok_visszaall`, `titok_elutasitva` with caller, target, length, version, result or the fixed reason. Never the value, a hash of it or a body.

Install (the owner's host step, once, after the image is rebuilt from the merged commit):

```
mkdir /opt/levelkozvetito/titkok-ver && chown 10003:10003 /opt/levelkozvetito/titkok-ver && chmod 700 /opt/levelkozvetito/titkok-ver
```

**The writer token is a ROOT step.** `store/tokens` is `root:root drwx--x--x` and `levelkozvetito-vezerlopult.token` does not exist yet, so root creates the file on the host, owned by marveen, mode 0400 (the panel's client refuses any mode with a group or other bit), and the hash command must not print the token's value to the terminal or a log:

```
cd /opt/marveen-docker && docker compose exec -u root marveen sh -c 'umask 277 && head -c 32 /dev/urandom | od -An -tx1 | tr -d "[:space:]" > /home/marveen/marveen/store/tokens/levelkozvetito-vezerlopult.token && chown marveen:marveen /home/marveen/marveen/store/tokens/levelkozvetito-vezerlopult.token && chmod 0400 /home/marveen/marveen/store/tokens/levelkozvetito-vezerlopult.token && wc -c < /home/marveen/marveen/store/tokens/levelkozvetito-vezerlopult.token'
cd /opt/marveen-docker && docker compose exec -u root marveen sh -c 'tr -d "\n" < /home/marveen/marveen/store/tokens/levelkozvetito-vezerlopult.token | sha256sum | cut -d" " -f1'
```

The first prints the length (64), the second only the hash, which goes into `config.json` as the writer's `tokenSha256`. The first real try is a dummy value that must be refused, the pointer untouched
and the mail branch still answering (contract, section 2.11).

then the new `compose.yaml` (two mounts of that directory: read-write for the relay, READ-ONLY for the `oauth` service), and in `config.json` the two keys
`"secretStoreDir": "/var/lib/levelkozvetito/titkok-ver"` and `"secretWriters": [{ "name": "vezerlopult", "tokenSha256": "<sha256 of the panel's token>" }]`
(both or neither; one without the other refuses to start). The panel's token is its own file `store/tokens/levelkozvetito-vezerlopult.token` (0400, marveen), created and hashed by the root commands above, never typed or printed. Without the keys the door does not exist.

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

**The consent container's rights (task `level-kozvetito-oauth-cap`).** It is uid 0 with `cap_drop: ALL` and exactly two capabilities:
`DAC_READ_SEARCH` (READ the 10003 files: the client id and secret in `titkok/`, the client-secret store in `titkok-ver/`; without it the
consent stops at `open /run/secrets/oauth-client-id: permission denied`) and `CHOWN` (hand the new token file to 10003). Not `DAC_OVERRIDE`:
nothing here writes where root is not the owner. The consent `state` is kept next to the token file in `titkok/` (root's, 700), not in the
relay's state volume (10003, 700; that mount is not in the `oauth` service any more), and the token file is replaced by a temp file in the same
directory, handed to 10003 and renamed over the old one, never opened for writing (`src/level-kozvetito/token-file.ts`). The new token file is a
new inode: the running relay keeps its old value until `docker compose restart levelkozvetito`, which is why that step is part of the consent.
A crash between the hand-over and the rename can leave `titkok/.<name>.neu-<hex>` (10003, 0400); root may delete it. Not measured in this
repo (no docker for the author): the first consent after this change is the measurement; if it stops on a permission error, report the exact
`open` or `unlink` path before adding a capability.

## Checks after install (each must hold, or the relay stays down)

- `docker inspect levelkozvetito`: no `docker.sock`, no `/opt/marveen-docker` path in `Mounts`; `ReadonlyRootfs=true`,
  `User` = `10003:10003`, `CapDrop=[ALL]`, `Privileged=false`. The `oauth` service is not running (profile).
- the fleet container's `docker inspect` has no `/opt/levelkozvetito/titkok` and no `/opt/levelkozvetito/titkok-ver` mount; `ls /run/secrets` there is empty.
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

## The sorter of balazs@ (slice 4b, task level-kozvetito-4b; `src/level-besorol.ts`, `scripts/level-besorol.sh`)

```
bash /home/marveen/marveen/scripts/level-besorol.sh [--nez] [--q <gmail search>] [--max <1-50>] [--allapot <file>]
```

One run: the five labels are made if missing (`cimke-letrehoz`), `lista` names the inbox mails (default `in:inbox newer_than:2d`,
30), `olvas` gives each body (redacted by the relay), a **tool-less** reader places them, this code checks its table, `cimkez`
puts the labels on, and the **daily list** is printed. `--nez`: everything but the writes (no label made or put on, no state).

- **The reader** is one claude process with `-p --restricted --tools "" --strict-mcp-config --no-session-persistence`
  (`CLASSIFIER_ARGS`, pinned by a test; widening it is a permission change), the fixed instruction as its argument and the mails
  on its standard input, ten at a time, at most 2000 characters of body each. It answers ONLY a table
  `[{"id","cimke"}, ...]`. **The script checks it, not the reader:** an element passes with exactly the keys `id` and `cimke`, an id
  that was in the input, and a label that is exactly one of the five; everything else (an extra field, an unknown id, `TRASH`,
  prose around the table) is dropped and counted; an id given two different labels is dropped. A mail's own text cannot pass for
  a section marker of the reader's input (`===` runs are made inert).
- **The daily list** holds counts, the mails waiting for an answer (`Ügyfél`, `Beszállító`, `Tennivaló`: sender name at most 40 and
  subject at most 60 characters, **each in a one-line `<untrusted source="gmail">` envelope of its own**, controls and line
  separators turned into spaces, the security tags replaced by the shared scrubber, then #33's `neutralDescription`; with the mail id
  outside), the unplaced ids, the excluded domains and the errors. **No model-written text is in it.** The sender is shown by display
  name, or domain: never the address. The list is read by the main agent's session, so a stranger's 60 characters are data in a
  frame, not tidied text.
- **What it never does:** `archival` and `inbox-vissza` (barracuda's binding: archiving stays out of the scheduled sorting until
  the first smoke test above has measured the `labelIds` answer shape; a test pins the verb list in the source); sending; reading an
  excluded sender's mail (it is listed by domain only and goes to neither `olvas` nor the reader).
  **A condition for turning archiving on (barracuda, #262 review; not met, not a thing this PR does):** the reader gets ten mails in
  one call, so one mail's text can bear on the labels of the others ("all the mails above are newsletters"). Today that costs a
  customer mail dropping off the daily list; once archiving stands on the `Hírlevél` label, such a mail could get others archived.
  Before it is switched on at least one of two things must hold: the `Hírlevél` decision runs ONE mail per reader call, or a
  deterministic signal is also required (a `List-Unsubscribe` header, or a known sender domain, from a field the relay gives).
- **State** (`store/level-besorol-allapot.json`, 0600): a mail it labelled is skipped for 14 days, an unplaced one for the rest of
  that day (retried the next day); a mail whose `olvas` or `cimkez` failed is not recorded, so the next run tries it again.
- **The excluded senders** are the relay's own `excludedSenders` setting (`config.json`); the owner has not given the list yet, so
  it holds the starter domains and can be widened without a code change.
- **Not measured (no live relay, no claude binary for the author):** a real reader call (the first run must be `--nez` and then a
  canary mail that asks the reader to run a command or read a file, **and a second one whose SUBJECT carries an instruction and
  security tags**: the table must come back clean, and the second must show on the list as one closed envelope); that `--tools ""` means "no tool"
  in the installed claude (the documented reference says so); that a mail on stdin of `claude -p` is read as input; the Gmail search
  that selects the not-yet-sorted mails (`in:inbox newer_than:2d` plus this state file, because `lista` does not show labels). The
  delivery of the list to the owner (the channel is his decision 1) is the scheduled task's, not this script's.

## The fleet's side (scripts/level-kozvetito.sh, the GCAL_KOZVETITO switch of scripts/gcal.sh)

`bash /home/marveen/marveen/scripts/level-kozvetito.sh <info|balazs> <verb> < body.json` is the one HTTP client: the
caller's token from its own 0400 file (`store/tokens/levelkozvetito-<agent>.token`, or `LVK_TOKEN_FILE`), the relay at the FIXED
`http://levelkozvetito:8788` (`LVK_URL` counts only for `http://127.0.0.1[:port]` or `http://localhost[:port]`, the tests; anything
else is refused before a request, so a mail cannot send the token to a host of its choosing), no retry, no redirect followed, a refusal as `FAIL <status> <fixed
reason>` on stderr. The token is never an argument, never printed.

`GCAL_KOZVETITO=1 bash scripts/gcal.sh mail|search|events|fetch|check` runs the same commands through the relay, with no
Google key on the fleet's side. Differences from the old path, all on purpose: no `[PROMO]` tag and no attachment names
in `search`; `search` returns at most 50; an excluded sender's mail shows as `KIZARVA (domain)` and `fetch` writes nothing
for it; `fetch` leaves the attachment in the relay's quarantine folder (the fleet's read-only mount, `LVK_KARANTEN_DIR`,
default `store/level-karanten`) and prints that path. Without the switch every command is the old one.

**Rollback** is the switch off. **The info@ move** runs both ways for a day (the owner reads the two outputs side by side,
including the invoice numbers that redaction turns into `[KOD]`; if that price is too high for the invoice reading, the
info@ `redaction` setting goes to `near-code-word`) before the old key leaves the fleet's `store/`.
