# fleet-gate: a flotta SSH-kulcsa csak megnevezett műveleteket futtathat (B8)

A `fleet` felhasználó mindkét gépen (`acropora-prod-01`, `acropora-ai-stage-01`) a `docker`
csoportban van, és a Docker rootos. A flotta kulcsával ezért ma bármi futtatható, például
`docker run -v /:/host`, ami root a gépen. A kapu (`scripts/host/fleet-gate.sh`) ezt zárja le:
az `authorized_keys` a kulcsra kényszeríti, és a kulcs onnantól csak a lenti, név szerint
felsorolt műveleteket éri el, rögzített argumentumokkal. Minden más elutasítás (kilépési kód 2,
egy sor a syslogba `fleet-gate` címkével).

A telepítés **Balázs keze**, rootként. Semmi nem települ automatikusan.

**A sorrend (Balázs, 2026-10-12 11:40 UTC):** előbb a TESZT gép (`acropora-ai-stage-01`), és csak
akkor az éles, ha a próba-sor (lent) minden sora zöld rajta.

## A műveletek

| Művelet | Mit futtat | Gép |
|---|---|---|
| `ps` | `docker ps --format '{{.Names}}\|{{.Image}}\|{{.Status}}'` | mindkettő |
| `system-df`, `system-df --format` | `docker system df` (a táblázat, vagy `Type\|Size\|Reclaimable`) | mindkettő |
| `df`, `df -P` | `df -h` (vagy `-P`) `/ /var/lib/docker` | mindkettő |
| `uptime`, `reboot-required`, `apt-check` | olvasás (`apt-check --human-readable`) | mindkettő |
| `builder-prune` | `docker builder prune -f` | mindkettő |
| `image-prune-2h` | `docker image prune -a -f --filter until=2h` | csak stage |
| `psql-ro <kulcs> <adatbázis> <felhasználó> [plain\|tuples\|tuples-pipe\|tuples-spaced-pipe]` | psql, az SQL a stdin-en, `default_transaction_read_only=on` alapértékkel; backslash az SQL-ben tilos | éles: OS; stage: AI, coolify-db |
| `pg-dump <kulcs> <adatbázis> <felhasználó>` | `pg_dump -Fc` a stdout-ra | éles: OS, Commerce; stage: AI |
| `pg-restore-list <kulcs>` | `pg_restore -l`, a dump a stdin-en | éles: OS, Commerce; stage: AI |
| `docstore-tar`, `docstore-count` | a dokumentum-tároló tar-ja, illetve a fájljainak száma | éles |
| `env-get` | az api konténer `MEDUSA_ADMIN_URL` és `MEDUSA_PROJECTION_SCHEDULE_ENABLED` értéke, semmi más | éles |
| `restore-probe` | eldobható `postgres:16-alpine`, a dump a stdin-ről, egy rögzített számláló-lekérdezés, utána törlés | stage |
| `backup-db <kulcs> <adatbázis> <felhasználó>` | `~/backups/<adatbázis>/<mai dátum>.dump`, utána `pg_restore --list` szám | mindkettő |
| `backup-docstore` | `~/backups/dokumentumok/<mai dátum>.tar.gz`, a fájlszám egyezésével | éles |
| `backup-get dump <adatbázis> <dátum>`, `backup-get docstore <dátum>` | egy meglévő mentés a stdout-ra | ahol a mentés készül |
| `backup-put dump <adatbázis> <dátum>`, `backup-put docstore <dátum>` | a stdin a `~/backups/tavoli/` alá, meglévőt soha nem ír felül | a másik gép |
| `backup-prune` | a dumpok 14, a dokumentum-csomagok 7 nap után törlődnek | mindkettő |

A konténert a kapu a neve **elejéből** oldja fel (a Coolify az alkalmazás uuid-jával kezdi), a
futók közül, így egy újratelepítés után is megtalálja.

## Telepítés előtt: ellenőrzés a gépen (rootként)

Ezek azt mutatják meg, hogy a kulcs az egyetlen út a `fleet` felhasználóhoz (acrobot mérte
2026-10-12 13:4x-kor mindkét gépen, ez a várt eredmény):

```bash
hostname -s                                  # acropora-ai-stage-01, illetve acropora-prod-01
wc -l ~fleet/.ssh/authorized_keys            # 1
grep -c 'command=' ~fleet/.ssh/authorized_keys   # 0 (még nincs kényszer)
ls -la ~fleet/.ssh                           # csak authorized_keys (az élesen known_hosts is)
passwd -S fleet                              # a második mező: L (zárolt jelszó)
sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
                                             # passwordauthentication no, kbdinteractiveauthentication no
sudo -l -U fleet                             # éles: nincs; teszt: jelszót kér (a jelszó zárolt)
```

Ha a `hostname -s` mást ad, a kapu azon a gépen mindent elutasít: előbb szólj.

## Telepítés, gépenként (előbb `acropora-ai-stage-01`)

A fájl a PR beolvadása és a flotta frissítése után az éles gépen itt áll:
`/opt/marveen-docker/data/marveen/scripts/host/fleet-gate.sh`. Vidd át a célgép `/tmp`-jébe
azon az úton, amin rootként szoktál, például a saját gépedről:

```bash
cd /tmp && scp root@162.55.216.28:/opt/marveen-docker/data/marveen/scripts/host/fleet-gate.sh ./fleet-gate.sh
cd /tmp && scp ./fleet-gate.sh root@<a cél gép>:/tmp/fleet-gate.sh
```

A célgépen, rootként:

```bash
cd /root
sha256sum /tmp/fleet-gate.sh                 # egyezzen a repóbeli fájléval (a flotta megadja)
install -o root -g root -m 0755 /tmp/fleet-gate.sh /usr/local/sbin/fleet-gate
cp -p ~fleet/.ssh/authorized_keys ~fleet/.ssh/authorized_keys.pre-b8
sed -i 's#^ssh-ed25519 #command="/usr/local/sbin/fleet-gate",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 #' ~fleet/.ssh/authorized_keys
grep -c '^command="/usr/local/sbin/fleet-gate"' ~fleet/.ssh/authorized_keys   # 1
chown root:root ~fleet/.ssh/authorized_keys && chmod 0644 ~fleet/.ssh/authorized_keys
```

Az utolsó sor nem kötelező, de ajánlott: így a `fleet` felhasználó maga sem tudja átírni a
kulcs-kényszert, ha valaha mégis futtatna valamit. Az sshd elfogad root tulajdonú
`authorized_keys`-t.

A `fleet` **marad a docker csoportban**: a kapu a nevében fut, és neki el kell érnie a Dockert.
A kulcson át vezető utat a kényszer zárja le.

## Lezárási mérés (a flotta konténeréből, a telepítés után)

```bash
cd /home/marveen/marveen && K=/home/marveen/.ssh/id_ed25519_acropora_monitor
ssh -i $K fleet@100.88.199.87 'docker info'; echo "kilépés: $?"     # elutasítva, kilépés: 2
ssh -i $K fleet@100.88.199.87 bash; echo "kilépés: $?"              # elutasítva, kilépés: 2
ssh -i $K fleet@100.88.199.87; echo "kilépés: $?"                   # elutasítva (nincs interaktív belépés)
ssh -i $K fleet@100.88.199.87 ps                                    # a konténerlista
```

A gépen: `journalctl -t fleet-gate -n 20` mutatja az `allow` és `deny` sorokat.

## Próba-sor: ezeknek kell zöldnek lenniük a kapun át

A teszt gépen előbb a stage-sorok, az élesítés után az éles sorok.

| Mi | Gép | Parancs (a flotta konténeréből) | Várt kimenet |
|---|---|---|---|
| lemez-állapot | mindkettő | `cd /home/marveen/marveen && bash scripts/lemez-allapot.sh` | mindkét gépnél `df` sorok, `---DOCKER---`, a `docker system df` táblázat; nincs „NEM ERHETO EL” |
| a stage takarítás előszűrője | stage | `cd /home/marveen/marveen && bash scripts/precheck/stage-gyorsitotar.sh; echo $?` | `SKIP` vagy egy `[preCheck meres]` sor, kilépés 0 |
| az AI mentés a NAS-ra | stage | `cd /home/marveen/marveen && bash scripts/ai-db-nas-mentes.sh --local` | „bejegyzes: N” (N > 0), kilépés 0 |
| a visszaállítási próba | stage | `cd /home/marveen/marveen && bash scripts/visszaallitasi-proba.sh ai` | „visszatoltve: conversations=… messages=…”, „KESZ.” |
| a kirakat telepítési állapota | stage | `cd /home/marveen/marveen && bash scripts/kirakat-telepites.sh allapot` | az utolsó öt telepítés táblázata |
| az éles verziók | éles | `cd /home/marveen/marveen && bash scripts/eles-verziok.sh` | az alkalmazások sora, nincs „FAIL” |
| a számla-dupla ellenőrzés | éles | `cd /home/marveen/marveen && bash scripts/szamla-dupla-ellenorzo.sh; echo $?` | „KIMENO: nincs dupla.” (0) vagy a duplák (1), de nem „NEM MERHETO” (2) |
| a JEV ismert-szó lista | éles | `cd /home/marveen/marveen && python3 scripts/jev/build_known.py` | lefut, nincs „FAIL psql” |
| a napi mentés | mindkettő | az ütemezett `napi-adatbazis-mentes` egy kézi futtatása | három `backup-db` sor (`<db> <bájt> <toc>`, toc > 0), egy `backup-docstore` sor egyező fájlszámmal, a kereszt-másolás `backup-get` és `backup-put` párjai |
| a heti frissítés-átnézés | mindkettő | az ütemezett `heti-frissites-atnezes` egy kézi futtatása | `apt-check` és `reboot-required` kimenet; élesen az `env-get` két sora |
| az éles lemez-takarítás | éles | az ütemezett `eles-lemez-takaritas` egy kézi futtatása | `df`, `system-df`, `builder-prune` kimenete |
| a JEV heti pilot | éles | az ütemezett `jev-pilot-heti` egy kézi futtatása | a lekérdezés eredménye `psql-ro`-n át |

Az ütemezett feladatok promptjait acrobot írja át a beolvadás után (a régi alak a kapu után
elutasítást kap). A megfeleltetés:

| Régi alak a gépen | Új alak |
|---|---|
| `docker exec <c> pg_dump ... > ~/backups/<db>/<dátum>.dump` és a `pg_restore --list` ellenőrzés | `backup-db <kulcs> <db> <user>` |
| `docker exec $c tar ... \| gzip -1 > ~/backups/dokumentumok/...` és a `find ... \| wc -l` ellenőrzés | `backup-docstore` |
| a kereszt-másolás | `ssh <forrás> backup-get dump <db> <dátum> \| ssh <cél> backup-put dump <db> <dátum>` (a dokumentumoknál `docstore <dátum>`) |
| `find ~/backups -name '*.dump' -mtime +14 -delete` | `backup-prune` (a dokumentum-csomagokat 7 nap után) |
| `apt-check --human-readable \| head -4`, `reboot-required` | `apt-check`, `reboot-required` (a `head` a konténerben) |
| `docker ps --filter name=proxy ...`, `docker ps --format "{{.Image}}" \| sort -u` | `ps`, a szűrés a konténerben |
| `docker exec $C env \| grep -E "^MEDUSA_(...)="` | `env-get` |
| `docker exec -i iwm34... psql -U acropora -d acropora -tA` | `psql-ro iwm34jaqp9xmwb72qkrqkwhy acropora acropora tuples` |

## Ami a kapu után NEM megy (szándékosan)

- **A `staging-eles-adattal` skill élő adatot töltene a stage-re** (`pg_restore` írással). Ez
  pont a B7 (valódi ügyféladat a stage-en); a nyilvántartás szerint az anonimizálási lánc után
  jön vissza, más úton.
- **A `tailnet-atallas-meres.sh`**: egyszeri mérés volt, több soros shell az éles gépen.
- Interaktív belépés `fleet`-ként, és minden, ami nincs a fenti táblában.

## Korlátok, amiket tudni kell

- **A `psql-ro` olvasása alapérték, nem zár.** A `PGOPTIONS` beállítja a
  `default_transaction_read_only=on` értéket, így egy sima író utasítás hibát ad. De a
  felhasználók (`acropora`, `acropora_ai`, `coolify`) valószínűleg superuserek a saját
  adatbázisukban, és egy session ezt az alapértéket vissza tudja kapcsolni. A valódi zár egy
  csak olvasó adatbázis-szerep (`GRANT SELECT`), ami külön döntés. A kapu annyit tesz meg,
  amennyit szövegből lehet: a backslash tiltásával kizárja a psql meta-parancsait (a `\!` shellt
  adna a konténerben).
- **A `psql-ro` a konténeren belül fut**, nem a gépen: a legrosszabb eset az adatbázis, nem a gép.
- **A `fleet` a docker csoportban marad.** Ha valaha új belépési út nyílik a `fleet`
  felhasználóhoz (jelszó, második kulcs), az megkerüli a kaput: a fenti ellenőrzést érdemes
  időnként újrafuttatni.

## Visszaállítás (rootként, a gépen)

```bash
cd /root
cp -p ~fleet/.ssh/authorized_keys.pre-b8 ~fleet/.ssh/authorized_keys
chown fleet:fleet ~fleet/.ssh/authorized_keys && chmod 0600 ~fleet/.ssh/authorized_keys
```

A `/usr/local/sbin/fleet-gate` maradhat: kényszer nélkül senki nem hívja.
