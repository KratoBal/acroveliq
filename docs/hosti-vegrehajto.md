# hosti-vegrehajto: a closed list of docker steps on the host, on the owner's Discord approval

The no-command-line plan, point C (`exchange/acroveliq/parancssor-nelkul-terv-2026-10-19.md`). Balázs approved C
(Eldöntendő, 2026-10-19 09:33:17 UTC, message 1561673586391916645). The design sheet and barracuda's APPROVE (v2) are
`exchange/acroveliq/parancssor-c-hosti-vegrehajto-terv-2026-10-19.md`. Until now every update of a host service (the mail relay, the
deploy executor) was a root command on the owner's side: fetch the reviewed commit, check it, `docker compose build`, `up -d`.
With this it is a Discord reply.

Code: `scripts/host/hosti-vegrehajto.py` (root, Python 3), `scripts/host/hosti-kliens.py` (the gate's hand to the socket),
`scripts/host/hosti-vegrehajto.socket` and `scripts/host/hosti-vegrehajto@.service`, the gate's three ops in
`scripts/host/fleet-gate.sh`, `scripts/hosti-vegrehajto.sh` (the fleet's side). Tests: `scripts/__tests__/hosti-vegrehajto.test.py`
(run by `npm test` through `src/__tests__/hosti-vegrehajto-py.test.ts`), `src/__tests__/hosti-vegrehajto-kliens.test.ts`, and the
`hosti-*` block of `src/__tests__/fleet-gate.test.ts`.

## The contract

| | |
|---|---|
| **Form** | a systemd socket-activated root unit: one process per connection, no resident daemon, no network port, no `docker.sock` in any container. The socket is `/run/hosti-vegrehajto/sock`, `0660 root:fleet`; the program decides by the peer's **UID** (SO_PEERCRED must be the `fleet` uid of the settings), never by the group. That directory is mounted into **no** container (the install check measures it). |
| **The only door** | the B8 gate's three ops `hosti-kerj`, `hosti-vegrehajt`, `hosti-allapot`, which run as the `fleet` user and hand their shape-checked words to a root-installed client. No new SSH key, no new port. The program checks everything again; it does not trust the gate. |
| **Verbs** | `telepit <projekt> <commit>` (the clone is set to the commit, the image is built, the project is brought up), `up <projekt>` (`docker compose up -d` with the image that is there), `visszaallit <projekt>` (the previous image becomes the live one), `allapot [R]` (read only). A project and a verb must also be on the root-owned project list. Image inspect, logs and the proxy are separate slices. |
| **Approval** | the same chain as the root installer and the deploy executor: a #33 approval, category `hosti_vegrehajt`, the canonical line as the whole description; the program reads the request message and the replies **from Discord itself** with its own read-only bot token, and the whole message must be exactly what #33 makes of this R (author, channel, edits, text, code, expiry). One use: the R is spent, durably, **before the first docker call**. |
| **The canonical line** | `HOSTI R=<id> / <projekt> / <ige> / <commit 40 \| jelenlegi \| elozo> / elo <image id 12> / elozo <image id 12>`. It survives #33's neutraliser unchanged (no `_`, `*`, `~`, `|`, `>`, `#`, backtick), and the execution measures the same ids again. |
| **Measure, then change** | every MEASUREMENT comes before the R is spent, every CHANGE after: the project is on the list, the verb is allowed, the project lock is free, the resolved config hash matches, the commit is on the branch (GitHub `compare`), the clone is checked out, `HEAD` is the commit and the tree is clean, the live image id is the approved one. A refusal leaves the R open. **The one exception is the clone's setup** (`git fetch`, `checkout --detach`): it changes the clone's work tree before the R is spent, but that tree is only the build's source and never touches the live container. |
| **Locks** | always in this order: the project's lock (`flock`, non-blocking: a busy project answers `foglalt` and the R stays open), then the R lock for the `open` to `used` change, so two `vegrehajt` on one R cannot both read `open`. |
| **The config hash** | the project list pins the sha256 of the **resolved** compose configuration (`docker compose config`, a clean environment): the `.env`, `env_file`, `include` and `extends` are inside it, so a value cannot change under an unchanged compose file. The output is hashed, never printed or logged (it may hold secrets). A Docker or Compose upgrade can change the output's shape: the consequence is a refusal, not a silent run, and the cure is the same step: `hosti-vegrehajto lenyomat <projekt>` (root, not on the socket) prints the current hash for the list. |
| **The environment** | built in the program for every external call: a fixed `PATH`, `HOME` and `DOCKER_CONFIG` inside the state directory (an empty docker config: no credential helper), `LANG=C`, and fixed git variables. No `COMPOSE_*` or `DOCKER_*` variable and nothing from the gate's environment passes. The git calls carry the protection of `scripts/git-olvas.sh` (no hooks, no fsmonitor, no external diff, no pager). |
| **The client may go** | `vegrehajt` answers `elfogadva` at once after the R is spent, closes the connection, and the work goes on in the same process, whatever happens to the client (SIGPIPE and EPIPE are ignored). The unit is `Type=simple`, `KillMode=control-group`, `RuntimeMaxSec=3600`, `Restart=no`. The result is `allapot <R>`. A run cut off (the unit stopped, power lost) shows as `megszakadt(<step>)` at the next look; the program never continues by itself: a new R (`up` or `visszaallit`) is the way on. |
| **Restore** | before each `telepit` the live image gets the label `<image>:elozo` (one label). `visszaallit` swaps the two labels and brings the project up; its line says so and shows both ids. The program **never** runs prune, rmi or image rm: an older image that lost its label is untagged, not deleted, and its id is in the audit log, so it can be brought back by hand. |
| **Audit** | `/var/lib/hosti-vegrehajto/audit.log` (append-only, root 0600): R, project, verb, commit, the image ids, the Discord message ids, every step's exit code. Never an output, a value or the resolved config. |

What it does not do, said aloud:
- **the requester's name is not authenticated:** `kero` comes from the caller, so any fleet key can write any name that is on the `requesters` list, and the owner reads it as `Kérő:` in the approval text (the same as at the deploy executor); the owner's own answer on Discord is what decides;
- it does not judge the commit: an approved Dockerfile builds as written, as root, on the host's Docker (the protection is the review and the approval);
- it trusts GitHub for the bytes at a commit and Discord for the author of a message;
- it runs no verb off the list and no project off the list; no `docker run`, `exec`, `cp`, `rm`, `system`, `volume`, `--force-recreate`, `--build`, `-V` or `--remove-orphans`; no privileged or host-network build;
- it never edits a compose file or an env file;
- the excluded, named: the fleet's container and the `/opt/marveen-docker` tree (the fleet can write it, and its recreation ends our own session), the host executor itself and the gate (they update through their own pinned install, not through their own verb);
- it never runs on its own: only an approved R starts a step.

## The flow (the fleet's side)

```
bash /home/marveen/marveen/scripts/hosti-vegrehajto.sh kerj <agent> <projekt> <telepit|up|visszaallit> <commit40|->
  -> R=<r> approval=<id> lejar=<epoch>, and the canonical line the owner will read
(the owner answers on Discord: igen <code>)
bash /home/marveen/marveen/scripts/hosti-vegrehajto.sh vegrehajt <R> <approval_id>
  -> R=<r> allapot=elfogadva   (the work goes on without this call)
bash /home/marveen/marveen/scripts/hosti-vegrehajto.sh allapot <R>
  -> outcome: kesz_igazolt | epites_hiba | indulas_hiba | utomeres_eltero | megszakadt(<step>) | folyamatban
```

Exit codes of the program (and so of the client): 0 done; 10 refused or busy; 11 no decision yet; 12 rejected or expired; 13 failed;
14 the socket is not reachable.

## Balázs egyszeri lépései (a hoston, rootként; a flotta egyiket sem futtatja)

**1. Mérés:** `python3 -V` (a program Python 3; ha nincs, a tervlap módosul), és `id fleet` (a `fleet` uid-ja a beállításba kerül).

**2. A forrás és a telepítés** (a reviewolt commitról, ellenőrizve):

```
git clone https://github.com/KratoBal/acroveliq.git /opt/hosti-vegrehajto/src
git -C /opt/hosti-vegrehajto/src fetch origin
git -C /opt/hosti-vegrehajto/src checkout --detach <a beolvadt commit 40 jegye>
test "$(git -C /opt/hosti-vegrehajto/src rev-parse HEAD)" = "<ugyanaz a 40 jegy>" && test -z "$(git -C /opt/hosti-vegrehajto/src status --porcelain)"
cd /opt/hosti-vegrehajto/src && echo '72d0bcc4762b7278846c4328afa0c7e5515e549992a28f91b19bf54fffc20b12  scripts/host/hosti-vegrehajto.py' | sha256sum -c
echo '24d691ea6a72dd6de12299949e3f122952f87aca74961af9b413c9b3ac3fcb6a  scripts/host/hosti-kliens.py' | sha256sum -c
echo 'bd799c10cabc0c619a13476af4e808c0fc37c3492264c6c9cb8046675c2fe664  scripts/host/hosti-vegrehajto.socket' | sha256sum -c
echo 'b2f1f4e8cf3dc883dc31837db35b7d41eab207ce04881d7d29ee67eac82d13ec  scripts/host/hosti-vegrehajto@.service' | sha256sum -c
install -o root -g root -m 0755 scripts/host/hosti-vegrehajto.py /usr/local/sbin/hosti-vegrehajto
install -d -o root -g root -m 0755 /usr/local/lib/fleet-gate
install -o root -g root -m 0755 scripts/host/hosti-kliens.py /usr/local/lib/fleet-gate/hosti-kliens
install -o root -g root -m 0644 scripts/host/hosti-vegrehajto.socket /etc/systemd/system/hosti-vegrehajto.socket
install -o root -g root -m 0644 'scripts/host/hosti-vegrehajto@.service' /etc/systemd/system/hosti-vegrehajto@.service
install -d -o root -g root -m 0700 /var/lib/hosti-vegrehajto /etc/hosti-vegrehajto
```

**Új projekt a listán egységmódosítást is kér:** a `hosti-vegrehajto@.service` `ReadWritePaths` sora a projektek `src` könyvtárát név szerint sorolja (ma `levelkozvetito`, `vegrehajto`), egy új projekt `src`-je nélküle `EROFS`-sel bukna; a sort a lista bővítésével együtt kell bővíteni (és újra `daemon-reload`).

A `src/` klón root-tulajdonú, és a `fleet-gate`, a program és a klón NEM projektek a listán.

**3. A beállítás és a projektlista** (root 0644, a flotta nem írja), és a bot token (root 0400, egy KÜLÖN, csak olvasó bot, a végrehajtó mintájára):

```
/etc/hosti-vegrehajto/config.json
{ "fleetUid": <az `id fleet` uid-ja>,
  "requesters": ["acrobot", "murena", "nautilus"],
  "discord": { "channelId": "<az Eldöntendő csatorna>", "requestBotUserId": "<a #33 kérő bot>", "deciderUserIds": ["<Balázs>"], "yes": "igen", "no": "nem" },
  "projectsFile": "/etc/hosti-vegrehajto/projektek.json" }
/etc/hosti-vegrehajto/projektek.json   (egy elem projektenként; az első bejegyzések: levelkozvetito és vegrehajto)
[ { "nev": "levelkozvetito", "dir": "/opt/levelkozvetito", "composeFajl": "/opt/levelkozvetito/compose.yaml",
    "konfigSha256": "<a 4. lépés kimenete>", "composeProjekt": "levelkozvetito", "szolgaltatasok": ["levelkozvetito"],
    "repo": "KratoBal/acroveliq", "ag": "main", "src": "/opt/levelkozvetito/src", "kep": "levelkozvetito:local",
    "igek": ["telepit", "up", "visszaallit"], "jovahagyasPerc": 30 } ]
/etc/hosti-vegrehajto/discord-olvaso   (root 0400: a bot tokenje, egy sor)
```

**4. A lenyomat:** projektenként `/usr/local/sbin/hosti-vegrehajto lenyomat <projekt>` (rootként; csak a hash-t írja ki, a feloldott konfigot nem), az érték a lista `konfigSha256` mezőjébe kerül. Egy Docker/Compose frissítés után, vagy ha a compose fájl, a `.env` vagy az `env_file` szándékosan változik, ugyanez a lépés.

**5. A bekapcsolás:** `systemctl daemon-reload && systemctl enable --now hosti-vegrehajto.socket`.

**6. Ellenőrzések (mindnek igaznak kell lennie, különben a kapu nincs nyitva):**
- `stat -c '%a %U:%G' /run/hosti-vegrehajto/sock` kiírja: `660 root:fleet`;
- a `/run/hosti-vegrehajto` egyetlen konténer `Mounts` listájában sincs: `docker ps -q | xargs -r docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' | grep -c hosti-vegrehajto` kiírja: `0` (a flotta konténerében sem);
- a fleet felhasználó a kapun át éri el: `hosti-allapot` válaszol (lásd a 8. lépést); egy másik felhasználó a socketet nem nyithatja meg, és a `fleet` csoport egy másik tagja sem kap választ (a program az uid-t nézi);
- `docker inspect` a konténerekre: a `docker.sock` egyiknek sincs csatolva (a B8 alap változatlan).

**7. A kapu frissítése** a `docs/fleet-gate.md` "Telepítés" szerint (az új `fleet-gate.sh` sha256-ja ott áll), a `hosti-kliens` a 2. lépésben már a helyén van.

**8. Az első próba:** `ssh fleet@<host> hosti-allapot` (csak olvas), és csak utána az első gomb egy `up levelkozvetito`-ra (nincs commit-változás, a legkisebb kockázat): `bash scripts/hosti-vegrehajto.sh kerj <agent> levelkozvetito up -`.

## Unmeasured, and the EROFS note

Not measurable in the development container: a real docker, compose, systemd socket activation, the host's python3, the `fleet` uid, a real
Discord answer. The program's logic and its command runner are measured against fakes; the first real run is the first real measurement.
`ProtectSystem=strict` leaves the file system read-only except `ReadWritePaths`: if a first real run fails with **EROFS**, the cause is a
missing path in the unit (the clones' whole directories, `.git` included; what `docker compose` writes under the program's own `HOME`, which is
inside the state directory; the docker socket), not a bug in the program. Add the path to the unit and run again.
