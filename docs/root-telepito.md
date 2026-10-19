# root-telepito: root files of the fleet container on the owner's Discord approval

The no-command-line plan, point B (`exchange/acroveliq/parancssor-nelkul-terv-2026-10-19.md`, "B részletesen",
barracuda 6-9). Balázs approved B, with sudoers as a possible target (Eldöntendő, message 1561673315997843528).
Until now every update of a root file in the container (a broker, a sudo rule, a file under `/etc`) was a root
shell command on the owner's side. With this, it is a Discord reply.

Code: `scripts/root/root-telepito.py` (root), `scripts/root-telepito.sh` (the fleet's side), `scripts/__tests__/root-telepito-ci.test.py` (the CI half),
`scripts/fleet-bootstrap.sh` step 4d. Tests: `scripts/__tests__/root-telepito.test.py`,
`scripts/__tests__/fleet-bootstrap-root-telepito.test.py`, `src/__tests__/approval-text-fixture.test.ts`.

## The contract

| | |
|---|---|
| **Source** | the GitHub commit named in the approval, never the fleet's tree. Root fetches the file at that commit (the repository is public: no token) into its own staging directory, hashes **that copy**, and installs **that copy** (copy-then-hash). The commit must be on `main`, and the file at main's head must be the same bytes: an older main commit cannot bring back an old version. |
| **Targets** | only the entries of a fixed, root-owned list (`lista.json`, no glob), from the owner's host directory, mounted **read-only**. A new target comes only with a change there, which is not a verb of the installer. Never a target, whatever the list says: the installer itself, its sudo rule, its own state, `/etc/sudoers`, `/etc/passwd`, `/etc/shadow`, `/etc/group`, `/etc/gshadow`. Every directory above a target must be root's and not writable by others; a target that is a symlink is refused. |
| **Sudoers** | only in `/etc/sudoers.d/<name without a dot>`, `root:root 0440`, and only in a strict subset of the grammar: `user ALL=(runas) NOPASSWD: /command [arguments]` per line, comments, blank lines. Aliases, `Defaults`, includes, several commands on a line, negation, continuation: refused. **The command must sit directly in `/usr/local/sbin`**, where the fleet's own root-owned brokers live (put there by this installer or the bootstrap), and be root's, in root-owned directories. This is an allow-list by place, because a list of forbidden names cannot close (`tee`, `cp`, `dd`, `find -exec`, `sed w`, `git`, `docker`, `systemctl` and many more hand out root as surely as a shell; barracuda, #242 review); the names of shells, interpreters, `sudo`, `su`, editors and the installer are refused as a second guard. `visudo -c` checks the staged copy, the file before the rename, and the whole configuration after it; if the last fails, the previous state is put back. **The approval line carries the parsed rules** (who, as whom, which command, which arguments; `*` is written as `[barmi]`), not a PR number. A command with no arguments is, for sudo, the command with ANY arguments, and the line says `[barmilyen argumentummal]`; only `""` means none, and then the line says `(argumentum nelkul)`. |
| **Approval** | the canonical line goes up as a #33 approval (category `root_telepites`). Root reads the request message and the replies **from Discord itself**, with its own read-only bot token: the message must be in the configured channel, from the dashboard's bot, unedited, posted inside the R's window, and its **whole text** must be exactly what #33 makes of this R; the first decision on it must be the owner's `igen <code>`, as a reply, unedited, before the expiry. The dashboard's "approved" row is not trusted (it runs as `marveen`). Once spent, an R does not run again. |
| **Restore** | every replaced version stays in the durable store (`/var/lib/root-telepito/tar/<key>/`, root 0700). `kerj-vissza <key> <version>` is the same approval flow, its line says `VISSZAALLITAS`. |
| **The installer is not its own target** | it comes from the bootstrap's pinned hash (step 4d), like the fleet-pane broker (4c): a new version of it is a new pin, which reaches the container with the owner's next bootstrap run. |
| **After a container recreate** | the image resets `/usr/local/sbin` and `/etc`. Step 4d runs `helyreallit`: every entry's last **approved** version goes back where the target differs. It installs nothing that was not approved. |
| **One owner per target** | a path the list names is the installer's. Step 4c (the fleet-pane broker's pin) then skips that path, or every recreate would put the old pinned copy back over an approved newer one. |

What it does not do, said aloud:
- it does not judge the file: an approved file is installed, and a wrong approval installs a wrong file;
- it trusts GitHub for the bytes at a commit and Discord for the author of a message;
- the approval line must survive #33's neutralisation unchanged, so a path with `_`, `*`, `#`, `>`, `|`, `~` or a
  backtick cannot be a target (the list refuses it at load), and the line is at most 500 characters;
- the caller list (`callers`) says who may ask; the owner's reply is what decides.

## The flow (the fleet's side)

```
bash /home/marveen/marveen/scripts/root-telepito.sh kerj <agent> <kulcs> <commit40>
  -> R=<r> approval=<id> lejar=<epoch>, and the canonical line the owner will read
(the owner answers on Discord: igen <code>)
bash /home/marveen/marveen/scripts/root-telepito.sh vegrehajt <R> <approval_id>
bash /home/marveen/marveen/scripts/root-telepito.sh allapot
```

`<agent>` must be the owner of the dashboard token the script uses: #33 shows the token's owner as the
requester, and root compares the whole message.

Exit codes of the root program: 0 done; 2 usage; 10 refused (nothing changed); 11 no decision yet; 12 rejected
or expired; 13 GitHub, Discord or the file system failed; 14 the whole sudoers check failed after the install and
the previous version was put back.

## Balázs egyszeri lépései (a hoston, rootként; a flotta egyiket sem futtatja)

Előfeltétel: ez a PR beolvadt, és a hoston a flotta fája a main-en áll.

**1. A beállítás és a lista a hoston** (csak olvasható mount lesz belőle):

```
cd /opt/marveen-docker
sudo install -d -o root -g root -m 0755 root-telepito
sudo install -d -o root -g root -m 0700 root-telepito-tar
```

A `root-telepito/config.json` (root 0644, titok nincs benne):

```json
{
  "repo": "KratoBal/acroveliq",
  "callers": ["marveen"],
  "windowMinutes": 60,
  "discord": {
    "channelId": "<a jóváhagyási csatorna id-je>",
    "requestBotUserId": "<a dashboard botjának user id-je>",
    "deciderUserIds": ["<Balázs Discord user id-je>"],
    "yes": "igen",
    "no": "nem"
  }
}
```

Ugyanazok az értékek, mint a végrehajtó `config.json`-jában (`deploy-executor/README.md`).

A `root-telepito/lista.json` (root 0644), az első cél a fleet-pane közvetítő:

```json
{
  "celok": [
    {"kulcs": "fleet-pane", "forras": "scripts/root/fleet-pane.py", "cel": "/usr/local/sbin/fleet-pane",
     "tulaj": "root", "csoport": "root", "mod": "0755", "fajta": "fajl"}
  ]
}
```

A `root-telepito/discord-olvaso` (root **0600**): egy csak olvasó bot tokenje a jóváhagyási csatornára (a
végrehajtó `titkok/discord-olvaso` tokenje is lehet, vagy egy külön bot).

**2. A két mount** a `docker-compose.yml` `marveen` szolgáltatásának `volumes` listájába:

```
      - ./root-telepito:/etc/root-telepito/conf:ro
      - ./root-telepito-tar:/var/lib/root-telepito
```

```
cd /opt/marveen-docker
docker compose up -d
```

A bootstrap (`ensure-native-modules.sh` hívja indításkor) a mountot látva telepíti a
`/usr/local/sbin/root-telepito`-t (csak ha a lenyomata a bootstrapba rögzített érték), a
`/etc/sudoers.d/root-telepito`-t (öt pontos sor a `marveen` felhasználónak), és lefuttatja a `helyreallit`-ot.
A `fleet-pane` ettől kezdve a root-telepítőé: a 4c lépés nem írja felül a rögzített példánnyal.

**3. Ellenőrzés:**

```
cd /opt/marveen-docker
docker compose exec -u marveen marveen bash /home/marveen/marveen/scripts/fleet-bootstrap.sh --dry-run
docker compose exec -u marveen marveen sudo -n /usr/local/sbin/root-telepito allapot
```

A 4d szakaszban `ok: /usr/local/sbin/root-telepito is the pinned version`; az `allapot` kiírja a `fleet-pane`
telepített lenyomatát. Ha a `/var/lib/root-telepito` nem mount, a bootstrap ezt `NOTE`-ként jelzi, és a
telepítő minden telepítést elutasít.

Innentől egy fleet-pane frissítés: a flotta kéri (`root-telepito.sh kerj`), Balázs a Discordon válaszol
(`igen <kód>`), a flotta végrehajtja.

## CI changes (task `ci-modositas-jovahagyassal`, PR B)

An agent cannot push a workflow file: the fleet's GitHub App token has no `workflows` right on purpose
(`docs/fleet-github.md`, the `ci` role is refused for anything that arrives through sudo). So a workflow change goes
through this installer, in four steps, and the owner decides **once a day**, on ONE message that shows every item.

```
bash /home/marveen/marveen/scripts/root-telepito.sh ci-kerj <agent> <owner/repo> <branch> .github/workflows/<name>.yml <file>
  -> the item (8 hex), the sha256 of the bytes ROOT keeps, the PR it belongs to
the reviewer reads exactly those bytes (the review packet's README names the sha256) and marks them:
bash /home/marveen/marveen/scripts/root-telepito.sh ci-athnezve <item> <sha256>
once a day (a scheduled task of the main agent, suggestion 17:30):
bash /home/marveen/marveen/scripts/root-telepito.sh ci-nap <agent>      -> ONE R, put up as a #33 approval
(the owner answers on Discord: igen <code>)
bash /home/marveen/marveen/scripts/root-telepito.sh vegrehajt <R> <approval_id>   -> root writes each approved file
```

| | |
|---|---|
| **What may be asked** | a repository on the root-owned `ci.json` list; a path exactly `.github/workflows/<name>.yml` or `.yaml`; a branch that is **not** the default branch and is the head of exactly **one open PR from the same repository into the default branch**; at most 20 kB; a change (not the file as it already is). The bytes come on STDIN, never from a commit: the agent cannot push the file, and root keeps its own copy (copy-then-hash). |
| **The reviewer's mark** | a pushed workflow **runs at once, on the PR's event, with the repository's secrets**. So review after the run is too late. `ci-athnezve <item> <sha256>` is the reviewer saying "I read exactly these bytes": root takes WHO from sudo (never an argument), requires him on `ci.json` `reviewers`, refuses the requester (by name and by OS user), and refuses a digest that is not the one of the bytes it keeps. It is logged (who, item, digest, when). **`ci-nap` takes only marked items**, and a new `ci-kerj` for the same repo, branch and file supersedes the waiting one, mark included. |
| **The line the owner reads** | repository, **PR number**, branch, file, the requester, the reviewer, the old file's blob (8 hex), the new bytes' digest (8 hex), the number of added and removed lines, and **the changed lines only** (`<line number>+/-(<indent>)<text>`, a line break shown as `¶`), plus the sentence "az agra irva a workflow AZONNAL lefut, a repo titkaival". The reviewer reads the whole file; the owner approves the change. |
| **Why the line looks odd** | #33 turns `` ` > # * _ ~ | `` into spaces and folds white space, and a workflow is full of them (`run: |`, `GITHUB_TOKEN`, comments). So the line writes them as fixed visible stand-ins (the legend is in the line itself), writes a run of spaces as `‹n›`, and **every SHOWN line must be plain printable ASCII**: no stand-in can then occur in the original, and what the owner reads maps back to exactly one text (a test turns the line back into the lines). A changed line with an accent, a tab or a carriage return is refused; an unchanged line is not shown and may be anything. |
| **Nothing is cut** | all items go up in one line of at most 1500 characters (the `root_telepites` limit). An item that cannot fit alone is refused at the request, with "split it". Items that do not fit **today** wait for the next batch, oldest first. There is no "truncated diff". |
| **The write** | after the owner's `igen <code>` on exactly that line (the same Discord read-back as everything here), per item root checks the **five facts** again (repository, the same PR number from the same repository into the default branch, the branch, the old blob, the digest of the bytes it holds), then asks the broker for a `ci` token **at that moment** (`fleet-github token <repo> ci`, in an environment with no `SUDO_*`, which is how the broker knows root is not a sudo caller) and writes the approved bytes to the branch with the contents API, conditional on the old blob, with a fixed commit message. If a fact changed, **that item does not go**; the others do; the answer lists every item. If none went, it is an error. The token lives in root's process for that one call. |
| **Who may ask** | the router user (`ci-kerj`, `ci-nap`), the reviewer (`ci-athnezve`, only with an 8-hex id and a 64-hex digest, in the sudo rule and again in root). An unanswered batch ends at `batchWindowMinutes`; its items go back to the queue; an item ends after `requestExpiryHours`. |

Owner's host steps (once, as root; the fleet runs none of them):

1. `/etc/root-telepito/conf/ci.json` (root 0644), next to `config.json`:
   `{"repos": ["KratoBal/acroveliq", "KratoBal/acropora-os"], "reviewers": ["agent-barracuda"], "requestExpiryHours": 48, "batchWindowMinutes": 720}`
2. `/etc/fleet-github/app.json`: a caller `root` with `olvas` on those repositories. Root reads the PR and the file with an `olvas` token; the `ci` role needs no entry (it is code, not configuration, and is refused to every sudo caller).
3. The next bootstrap run installs the new installer (the pin) and the three sudo lines.

What this does not do, said aloud: it does not judge the file; the reviewer's mark and the owner's reply do. It cannot see what the written workflow does on its first run; that is why the mark comes first. A GitHub App installation token cannot be tied to one write, which is why root does the writing itself.
