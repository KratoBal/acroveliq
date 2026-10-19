# root-telepito: root files of the fleet container on the owner's Discord approval

The no-command-line plan, point B (`exchange/acroveliq/parancssor-nelkul-terv-2026-10-19.md`, "B részletesen",
barracuda 6-9). Balázs approved B, with sudoers as a possible target (Eldöntendő, message 1561673315997843528).
Until now every update of a root file in the container (a broker, a sudo rule, a file under `/etc`) was a root
shell command on the owner's side. With this, it is a Discord reply.

Code: `scripts/root/root-telepito.py` (root), `scripts/root-telepito.sh` (the fleet's side),
`scripts/fleet-bootstrap.sh` step 4d. Tests: `scripts/__tests__/root-telepito.test.py`,
`scripts/__tests__/fleet-bootstrap-root-telepito.test.py`, `src/__tests__/approval-text-fixture.test.ts`.

## The contract

| | |
|---|---|
| **Source** | the GitHub commit named in the approval, never the fleet's tree. Root fetches the file at that commit (the repository is public: no token) into its own staging directory, hashes **that copy**, and installs **that copy** (copy-then-hash). The commit must be on `main`, and the file at main's head must be the same bytes: an older main commit cannot bring back an old version. |
| **Targets** | only the entries of a fixed, root-owned list (`lista.json`, no glob), from the owner's host directory, mounted **read-only**. A new target comes only with a change there, which is not a verb of the installer. Never a target, whatever the list says: the installer itself, its sudo rule, its own state, `/etc/sudoers`, `/etc/passwd`, `/etc/shadow`, `/etc/group`, `/etc/gshadow`. Every directory above a target must be root's and not writable by others; a target that is a symlink is refused. |
| **Sudoers** | only in `/etc/sudoers.d/<name without a dot>`, `root:root 0440`, and only in a strict subset of the grammar: `user ALL=(runas) NOPASSWD: /command [arguments]` per line, comments, blank lines. Aliases, `Defaults`, includes, several commands on a line, negation, continuation: refused. The command must exist, be root's, sit in root-owned directories, and not be a shell, an interpreter, `sudo`, `su`, an editor or the installer. `visudo -c` checks the staged copy, the file before the rename, and the whole configuration after it; if the last fails, the previous state is put back. **The approval line carries the parsed rules** (who, as whom, which command, which arguments; `*` is written as `[barmi]`), not a PR number. |
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
