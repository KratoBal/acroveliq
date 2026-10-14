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
| `sshd-match` | áll-e még a kapu: pontosan egy `Match User fleet` blokk az `sshd_config`-ban; kulcs-beállítás (`AuthorizedKeysFile`, `AuthorizedKeysCommand`) a fő fájlban PONTOSAN EGY, a mi blokkunkban, a mi útvonalunkkal, és `ForceCommand` sehol; nincs másik, `fleet`-et vagy `all`-t érintő `Match`; `Include` csak a megszokott `/etc/ssh/sshd_config.d/*.conf`; az `sshd_config.d` alatt se `Match`, se kulcs-beállítás, se `ForceCommand` (az Include a fájl elején áll, ezért az ott álló megelőzné a miénket, akármilyen csoportot vagy címet nevez). A kulcsfájl `root:root 0644`, és MINDEN kulcssora kényszerített (`restrict,from=...,command=...`). Kiírja, és 1-gyel lép ki, ha bármelyik nem stimmel | mindkettő |
| `builder-prune` | `docker builder prune -f` | mindkettő |
| `image-prune-2h` | `docker image prune -a -f --filter until=2h` | csak stage |
| `psql-ro <kulcs> <adatbázis> [plain\|tuples\|tuples-pipe\|tuples-spaced-pipe]` | psql a csak olvasó `fleet_ro` szereppel (a kapu listájából, nem a hívótól), az SQL a stdin-en; backslash az SQL-ben tilos | éles: OS; stage: AI |
| `coolify-deployments <app uuid>`, `coolify-deploy-log <deployment uuid>` | a Coolify adatbázisának két rögzített olvasása (a kapu építi az SQL-t, a 24 jeles uuid az egyetlen argumentum) | stage |
| `pg-dump <kulcs> <adatbázis> <felhasználó>` | `pg_dump -Fc` a stdout-ra | éles: OS, Commerce; stage: AI |
| `pg-restore-list <kulcs>` | `pg_restore -l`, a dump a stdin-en | éles: OS, Commerce; stage: AI |
| `docstore-tar`, `docstore-count` | a dokumentum-tároló tar-ja, illetve a fájljainak száma | éles |
| `env-get` | az api konténer `MEDUSA_ADMIN_URL` és `MEDUSA_PROJECTION_SCHEDULE_ENABLED` értéke, semmi más | éles |
| `quote-templates-sync plan`, `quote-templates-sync apply` | az ajánlatsablonok és szövegrészletek JSON-ja a stdin-en; a kapuval együtt telepített, root tulajdonú program (`/usr/local/lib/fleet-gate/quote-templates-sync.mjs`) az api konténerben ellenőrzi a kép saját szerkesztő-szabályaival, és név szerint felveszi, ami hiányzik. Az `apply` ír az éles OS-be (lásd lent) | éles |
| `app-log <kulcs> [sorok]` | `docker logs --timestamps --tail <sorok> <konténer>`, a stdout és a stderr együtt; a kulcs az éles api, web vagy partner alkalmazás (a Coolify uuid-ja), a sorok száma 1 és 5000 között, alapból 500. Követés (`--follow`) és szabad `--since` nincs. A stderr első sora és a syslog-sor megnevezi az olvasott konténert (telepítés közben a régi és az új is futhat) | éles |
| `restore-probe` | eldobható `postgres:16-alpine` hálózat nélkül, memória-, CPU- és folyamat-korláttal, a dump a stdin-ről, egy rögzített számláló-lekérdezés, utána törlés; a képet a kapu nem tölti le | stage |
| `backup-db <kulcs> <adatbázis> <felhasználó>` | `~/backups/<adatbázis>/<mai dátum>.dump`, utána `pg_restore --list` szám | mindkettő |
| `backup-docstore` | `~/backups/dokumentumok/<mai dátum>.tar.gz`, a fájlszám egyezésével | éles |
| `backup-get dump <adatbázis> <dátum>`, `backup-get docstore <dátum>` | egy meglévő mentés a stdout-ra | ahol a mentés készül |
| `backup-sum dump <adatbázis> <dátum>`, `backup-sum docstore <dátum>` | ugyanannak a mentésnek a sha256-ja és mérete | ahol a mentés készül |
| `backup-put dump <adatbázis> <dátum> <sha256>`, `backup-put docstore <dátum> <sha256>` | a stdin előbb ideiglenes fájlba, és csak akkor lesz a `~/backups/tavoli/` alatti végleges másolat, ha a sha256-ja a forrásé; eltérésnél törli és hibával lép ki. Csak a mai vagy a tegnapi dátum, legfeljebb 2 GB, és csak ha a lemezen a korlát kétszerese szabad; meglévőt soha nem ír felül | a másik gép |
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
ls -la ~fleet/                               # .bashrc, .profile: kinek a tulajdona (lásd lent)
getent passwd fleet | cut -d: -f7            # /bin/bash (ezt a telepítés /bin/sh-ra váltja)
passwd -S fleet                              # a második mező: L (zárolt jelszó)
sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
                                             # passwordauthentication no, kbdinteractiveauthentication no
sudo -l -U fleet                             # éles: nincs; teszt: jelszót kér (a jelszó zárolt)
grep -n '^Match' /etc/ssh/sshd_config        # a meglévő Match blokkok (a telepítés a fájl végére tesz egyet)
ls -ld ~fleet ~fleet/.ssh                    # fleet:fleet 0750 és 0700: ezért megy a kulcs a home-on kívülre
tailscale debug prefs | grep -i runssh       # élesen ma: "RunSSH": true (lásd a Tailscale SSH pontot)
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

**1. A csak olvasó adatbázis-szerep** (Balázs, 12:23 UTC; a kapu `psql-ro` művelete ezzel
csatlakozik, ezért a kapu ELŐTT kell létrehozni). Gépenként és adatbázisonként egyszer, a
konténerben a saját superuserével:

| Gép | Konténer (a név eleje) | Adatbázis | Superuser |
|---|---|---|---|
| `acropora-prod-01` | `iwm34jaqp9xmwb72qkrqkwhy` | `acropora` | `acropora` |
| `acropora-ai-stage-01` | `cpnjvtte02yakzs9vb0jffky` | `acropora_ai` | `acropora_ai` |

```bash
cd /root
C=$(docker ps --format '{{.Names}}' | grep '^iwm34jaqp9xmwb72qkrqkwhy' | head -1)   # a stage-en: ^cpnjvtte02yakzs9vb0jffky
docker exec "$C" psql -U acropora -d acropora -Atc 'show server_version'           # 15 alatt lásd a következő sort
# 15 ALATT a public sémán a CREATE joga mindenkié: a fleet_ro a read-only alapérték kikapcsolása
# után táblát vagy függvényt hozhatna létre (barracuda, #30). Ilyenkor előbb ez az egy sor:
#   docker exec "$C" psql -U acropora -d acropora -c 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;'
# Az alkalmazás saját felhasználóját nem érinti (tulajdonos vagy superuser). 15-től ez az alapállapot.
# SZŰK, táblánkénti és oszloponkénti jog (Balázs, 2026-10-13 13:04:44 UTC): a pg_read_all_data
# NEM használható. ELŐTTE (csak olvas): se PUBLIC által futtatható SECURITY DEFINER függvény, se
# PUBLIC által olvasható tábla vagy nézet ne legyen, mert azokon át a szerep a listán kívül olvasna,
# és ezt a lenti column_privileges-számlálás nem látja (barracuda, a lépéslap v8). Várt: nincs sor;
# ha van: állj meg.
docker exec -i "$C" psql -U acropora -d acropora -At <<'SQL'
select 'secdef', n.nspname || '.' || p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema') and has_function_privilege('public', p.oid, 'execute');
select 'public-tabla', n.nspname || '.' || c.relname from pg_class c
 join pg_namespace n on n.oid = c.relnamespace
 where n.nspname not in ('pg_catalog', 'information_schema') and c.relkind in ('r','v','m','f','p')
   and (has_table_privilege('public', c.oid, 'select') or has_any_column_privilege('public', c.oid, 'select'));
SQL
# Egy tranzakcióban (-1): egy elírt név az egészet visszagördíti.
docker exec -i "$C" psql -U acropora -d acropora -v ON_ERROR_STOP=1 -1 <<'SQL'
CREATE ROLE fleet_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE fleet_ro SET default_transaction_read_only = on;
ALTER ROLE fleet_ro SET statement_timeout = '60s';
ALTER ROLE fleet_ro SET idle_in_transaction_session_timeout = '60s';
GRANT USAGE ON SCHEMA public TO fleet_ro;
GRANT SELECT ("documentNumber", source, cancelled) ON "ExternalBillingDocument" TO fleet_ro;
GRANT SELECT ("firstName", "lastName", "displayName", nickname, email) ON "User" TO fleet_ro;
GRANT SELECT ("displayName", "companyName", email) ON "Customer" TO fleet_ro;
GRANT SELECT (name, line1, line2) ON "CustomerAddress" TO fleet_ro;
GRANT SELECT (name, "contactPersonName", email, "contactPersonEmail") ON "Supplier" TO fleet_ro;
GRANT SELECT ("contactPersonName", "organizationalUnitName") ON "Contract" TO fleet_ro;
GRANT SELECT ("signerName") ON "WorksheetVersionSignature" TO fleet_ro;
GRANT SELECT (exposure, resolution, status, "latencyMs", "respondedModel", "errorCode", "createdAt") ON "DecisionRun" TO fleet_ro;
GRANT SELECT (migration_name, started_at, finished_at, rolled_back_at, applied_steps_count) ON _prisma_migrations TO fleet_ro;
SQL
# a stage-en (acropora_ai, superuser acropora_ai) a GRANT sorok helyett csak a három számlálásé:
#   GRANT SELECT (id) ON conversations, messages, answer_ratings TO fleet_ro;
docker exec -i "$C" psql -U fleet_ro -d acropora -At <<'SQL'
select current_user, pg_has_role(current_user, 'pg_execute_server_program', 'member');
SQL
                                             # fleet_ro|f
docker exec "$C" psql -U acropora -d acropora -Atc "select count(*) from information_schema.column_privileges where grantee = 'fleet_ro'"
                                             # éles 33, stage 3
```

Ki mit olvas ezzel, és mi nem fér bele: a B8 lépéslap (változat 9) 1.4 szakasza. Ha egy flotta-hívó
`permission denied`-et kap, az nem biztonsági hiba, hanem a lista szűk: a bővítés döntés, nem javítás.

A szerepnek **nincs jelszava, és nem is kap**: a kapu `docker exec`-kel, a konténeren BELÜL, a
helyi socketen csatlakozik, és a hivatalos Postgres-kép a helyi socketet engedi. Ha a fenti
utolsó sor jelszót kér, a konténer `pg_hba.conf`-ja más: akkor állj meg és szólj, a jelszó
semmiképp ne kerüljön a kapuba. A Coolify adatbázisához nem kell szerep: oda a kapu csak két
rögzített SQL-t visz.

**2. A kapu és a kulcs.** A kulcs-kényszer a `fleet` home-ján KÍVÜL áll (barracuda és acrobot,
2026-10-12): a `/home/fleet` ma `fleet:fleet 0750`, a `~/.ssh` `fleet:fleet 0700`, vagyis a `fleet`
a saját `.ssh`-ját át tudná nevezni, és vele a kényszert is. Az sshd ezért a `fleet`
kulcsait a `/etc/ssh/authorized_keys/fleet`-ből olvassa, ami root tulajdonú.

Előbb mérd meg, honnan jön a flotta forgalma erre a gépre (a `from=` ezt a címet engedi csak):

```bash
cd /root && journalctl -u ssh --since -24h | grep 'Accepted publickey for fleet' | awk '{print $11}' | sort | uniq -c
```

Utána (a `FORRAS` a mért cím vagy címek, vesszővel):

```bash
cd /root
FORRAS='<a mért cím>'
install -o root -g root -m 0755 /tmp/fleet-gate.sh /usr/local/sbin/fleet-gate
sha256sum /usr/local/sbin/fleet-gate         # egyezzen a repóbeli fájléval (a flotta megadja)
KULCS=$(grep -E '^ssh-ed25519 ' ~fleet/.ssh/authorized_keys)
install -d -o root -g root -m 0755 /etc/ssh/authorized_keys
printf 'restrict,from="%s",command="/usr/local/sbin/fleet-gate" %s\n' "$FORRAS" "$KULCS" > /etc/ssh/authorized_keys/fleet
chown root:root /etc/ssh/authorized_keys/fleet && chmod 0644 /etc/ssh/authorized_keys/fleet
cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.pre-b8
printf '\nMatch User fleet\n    AuthorizedKeysFile /etc/ssh/authorized_keys/%%u\n' >> /etc/ssh/sshd_config
sshd -t && systemctl reload ssh
usermod -s /bin/sh fleet
```

A `Match` blokk a fájl VÉGÉRE kerül, és nem egy `sshd_config.d` alatti fájlba: az `Include` a fő
fájl elején áll, és egy oda tett `Match` a fő fájl utána következő beállításait is elnyelné. A
`restrict` minden továbbítást, pty-t és `~/.ssh/rc`-t tilt; a `from=` csak a mért címről enged
belépni ezzel a kulccsal.

**Ellenőrzés a betöltött beállításon** (a `FORRAS` egyik címével):

```bash
cd /root && sshd -T -C user=fleet,host=x,addr=<a mért cím> | grep -iE 'forcecommand|authorizedkeysfile|authorizedkeyscommand |permituserenvironment'
                                             # authorizedkeysfile /etc/ssh/authorized_keys/%u
                                             # authorizedkeyscommand none
                                             # forcecommand none
                                             # permituserenvironment no
```

A `forcecommand none` helyes: a kényszer a kulcssorban áll (`command=`), nem az sshd-ben. Az
`authorizedkeyscommand none` azért kell, mert egy beállított `AuthorizedKeysCommand` a fájl
MELLETT is adna kulcsot (barracuda, #30).

**Ami a kaput csendben elviheti: az `sshd_config` cseréje.** Egy csomagfrissítés, ami felülírja a
fájlt, a `Match` blokkal együtt a kaput is viszi, és onnantól a `~fleet/.ssh/authorized_keys`
régi, kényszer nélküli sora él újra (az a visszaállítás alapja, ezért marad a helyén). Ezt a kapu
`sshd-match` művelete root nélkül méri (mindkét fájl mindenki számára olvasható), és a heti
frissítés-átnézés a kapun át hívja (barracuda, #30):

```bash
cd /home/marveen/marveen && ssh -i /home/marveen/.ssh/id_ed25519_acropora_monitor fleet@162.55.216.28 sshd-match; echo $?
                                             # match=1 others=0 keyopts=1 ours=1 forcecmds=0 includes=0 dropins=0 keyfile=root:root:644 keys=1 forced=1, kilépés: 0
```

Amíg a `Match` blokk hiányzik, ez a hívás a régi, kényszer nélküli kulccsal megy át, tehát a
kapu nem fut: a kimenet ilyenkor nem `match=...`, hanem a régi parancs-értelmezés hibája. Mindkét
eset riasztás: a heti átnézés csak a `match=1 ... ` sort és a 0-s kilépést fogadja el.

A teszt gépen ezen felül (a `restore-probe` nem tölt le képet):

```bash
cd /root && docker pull postgres:16-alpine
```

**Miért a `/bin/sh`** (barracuda, #28): a `bash` Debianon a nem interaktív ssh-parancs előtt is
beolvassa a `~/.bashrc`-t, vagyis egy írható `.bashrc` a kapu ELŐTT futna. A `/bin/sh` (dash) egy
`-c` parancsnál nem olvas indító fájlt. A kapu maga `bash` alatt fut, a saját első sora szerint.

**Az éles gép Tailscale SSH-ja.** Az élesen a Tailscale SSH be van kapcsolva (`RunSSH true`). A
tailnet szabálya ma csak a `group:admin`-nak enged belépést a `tag:prod` gépekre, „check”
megerősítéssel, tehát a flotta nem éri el (acrobot mérte, 2026-10-12). Ez a kapun KÍVÜLI út a
gépre: ha nem használod, kapcsold ki:

```bash
cd /root && tailscale set --ssh=false && tailscale debug prefs | grep -i runssh   # "RunSSH": false
```

A `fleet` **marad a docker csoportban**: a kapu a nevében fut, és neki el kell érnie a Dockert.
A kulcson át vezető utat a kényszer zárja le.

## Az ajánlatsablon-művelet (`quote-templates-sync`, csak éles)

**Miért van** (Balázs, 2026-10-14 06:01 UTC: „eddig at tudtuk vinni, most miert nem”): a kapu óta a
flotta nem futtathat `docker exec`-et az élesen, tehát a teszten elkészült ajánlatsablonokat
csak rootként lehetett volna átvinni. Ez a művelet ugyanazt végzi, név szerint, root nélkül.

**Mit kap és mit futtat.** A hívó CSAK ADATOT ad: a sablonok és a szövegrészletek JSON-ját a
stdin-en (legfeljebb 256 KiB). A program nem a hívóé: a kapuval együtt telepített, root tulajdonú
fájl, amit a kapu a node `-e` argumentumaként ad át az api konténerben
(`docker exec -i -w /app -e APPLY=0|1 <api> node --input-type=module -e <program>`). A kapu
futtatás előtt ellenőrzi, hogy a fájl és a mappája root tulajdonú, szabályos (nem link), és más
nem írhatja; különben elutasít. A program az adatot a KÉP SAJÁT szabályaival ellenőrzi (a
`dist/quotes` alatti `templateBody`, `textInput`, `richTextInput`, `snippetMilestones`: ugyanazok,
amiket a sablonszerkesztő és a seed CLI használ), és az első hibánál az egész bemenetet
elutasítja, mielőtt az adatbázishoz nyúlna (kilépés 3).

**Mit írhat, és mit nem.** Felvesz egy sablont vagy szövegrészletet, aminek a neve még nincs meg.
Egy meglévő sablonnak CSAK a blokkjait cseréli, és csak akkor, ha azok betű szerint még a seed
alapszöveget tartalmazzák; az alapszöveget a kép `DEFAULT_QUOTE_TEMPLATES`-e adja, nem a hívó.
Kézzel szerkesztett sorhoz, több azonos nevű sorhoz, archivált sorhoz nem nyúl, nem töröl, és a
két táblán kívül csak az audit naplóba ír (`quote_template.created`, `quote_template.updated`,
`quote_snippet.created`, `userId` nélkül, `metadata.source = fleet-gate quote-templates-sync`).
Egy tranzakció. A cserélendő sablont a tranzakción belül `FOR UPDATE`-tel olvassa újra, ugyanazzal
a zárral, amit a sablonszerkesztő is kér: egy közben mentett kézi szerkesztés vagy megvárja, vagy
látszik, és akkor semmi nem íródik (barracuda, #97). A felvételeknél nincs ilyen zár (a névre nincs
egyedi index): ha valaki ugyanabban a pillanatban kézzel felvesz egy azonos nevű sablont, kettő
lehet belőle. Az `apply` után a terv újra lefut, és a duplikált sablonneveket kiírja, tehát ez
látszik. A kimenet első sora a bemenet sha256-ja (`BEMENET sha256: ...`, ugyanaz, mint a hívó
oldalán a `sha256sum <fájl>`: a kapu a bemenetet fájlon át, bájtra azonosan adja tovább), és minden audit sor `metadata.inputSha256`-ban hordozza: az írás
ahhoz a fájlhoz köthető, amire Balázs igent mondott.

**Az `apply` írás az éles adatbázisba:** a futtatása ugyanúgy Balázs esetenkénti szavára megy, a
kapu ezt nem váltja ki. A `plan` csak olvas. A flotta hívója:

```bash
cd /home/marveen/marveen && bash scripts/arajanlat-sablon-elesre.sh plan <sablonok.json>
cd /home/marveen/marveen && bash scripts/arajanlat-sablon-elesre.sh apply <sablonok.json>
```

**Ha a kép átrendezi a `dist/quotes` fájljait**, a program importja hibával áll meg, és nem ír:
akkor a programot kell az új helyekhez igazítani.

**Telepítés az éles gépen (rootként), a kapu újratelepítésével együtt.** A két fájl a PR
beolvadása és a flotta frissítése után itt áll: `/opt/marveen-docker/data/marveen/scripts/host/`.
Vidd át mindkettőt a gép `/tmp`-jébe úgy, mint a kaput (fent), utána:

Előbb a program útjának szülőmappái: a kapu csak a fájlt és a saját mappáját nézi, és Debianon a
`/usr/local` lehet `root:staff 2775`, ahol a `staff` tagja átnevezhetné a mappát (barracuda, #97):

```bash
cd /root && stat -c '%n %U:%G %a' /usr /usr/local /usr/local/lib
                                             # mindhárom: root:root 755. Ha nem: előbb ott kell rendet tenni, szólj.
```

Utána a két fájl:

```bash
cd /root
install -o root -g root -m 0755 /tmp/fleet-gate.sh /usr/local/sbin/fleet-gate
install -d -o root -g root -m 0755 /usr/local/lib/fleet-gate
install -o root -g root -m 0644 /tmp/quote-templates-sync.mjs /usr/local/lib/fleet-gate/quote-templates-sync.mjs
echo '186390d77a6c8546a2d7fb0f720ea4846ee65f5b3b4f71807a4137e38fe021ce  /usr/local/sbin/fleet-gate' | sha256sum -c
echo 'd958d5a4050ebbf52610ca70f3574a3e572bf349751fbd7b011411a68a322834  /usr/local/lib/fleet-gate/quote-templates-sync.mjs' | sha256sum -c
                                             # mindkettő: OK. Ha nem: állj meg, és szólj.
```

A két lenyomat a repó fájljaié; a teszt (`GATE-INSTALL-SHA`) piros, ha valamelyik fájl úgy
változik, hogy ez a két sor nem követi.

Próba a flotta konténeréből (csak olvas):

```bash
cd /home/marveen/marveen && printf '{"templates":[],"snippets":[]}' > /tmp/ures-sablonok.json && bash scripts/arajanlat-sablon-elesre.sh plan /tmp/ures-sablonok.json
                                             # ELOTTE: N sablon, M reszlet / 0 irast vegeznek (probafutas ...)
```

## A köztes állapot: a kapu a stage gépen már áll, az élesen még nem

A hívó szkriptek a #28 óta a kapu nyelvén beszélnek (`ssh fleet@<gép> ps`). A flotta élő fája
(`/home/marveen/marveen`) ezt a változatot csak akkor kapja meg, amikor a kapu MINDKÉT gépen áll,
és az ütemezett feladatokat is akkor írja át acrobot. A két telepítés között tehát:

- **A stage gépre szóló régi hívók az élő fából elutasítást kapnak:** a stage takarítás előszűrője
  (`precheck/stage-gyorsitotar.sh`), az AI mentés a NAS-ra (`ai-db-nas-mentes.sh`), a
  visszaállítási próba (`visszaallitasi-proba.sh`), a kirakat telepítési állapota
  (`kirakat-telepites.sh`), és a napi mentés AI-része a kereszt-másolással együtt.
- **Az éles gépre szóló hívók az élő fából még mennek, de CSAK az 1. és a 3. lépés között.** Az éles
  kapu után (3. lépés) az élő fa régi alakja ott is elutasítást kap: **a 3. lépéstől az 5.-ig az élő
  fából semmi nem megy át**, ezért a 4. és az 5. lépés közvetlenül utána jöjjön.
- **A `lemez-allapot.sh` mindkét gépre szól:** az élő fa régi alakja a stage-en bukik. A
  checkoutból futtatva az ÉLES részét az új nyelven hívja, amit az éles gép a kapu előtt nem
  ért: a `ps` vagy a `df` ott sima Unix-parancsként LEFUT, és mást ír ki, mint amit a szkript vár
  (például folyamatlistát a konténerlista helyett). Ez félrevezető kimenet, nem elutasítás. **Az
  ablak alatt a checkoutból futtatott `lemez-allapot.sh` éles része nem mérvadó, csak a
  stage-része.**

**Az ablak rövid legyen: a két telepítést lehetőleg egy ülésben végezd.** A sorrend:

1. A kapu a stage gépen (a fenti lépések).
2. A stage próba-sorai egy **külön checkoutból**, a #28 állapotán (lent).
3. A kapu az éles gépen.
4. Az éles próba-sorai ugyanabból a checkoutból.
5. acrobot frissíti az élő fát és átírja az ütemezett feladatokat; utána a teljes próba-sor az
   élő fából fut, és a checkout törölhető.

A checkout (a flotta konténerében, a #28 beolvadása után a `main` tartalmazza):

```bash
cd /home/marveen/marveen && git fetch origin main && git worktree add /home/marveen/fleet-gate-proba origin/main
cd /home/marveen/fleet-gate-proba && bash scripts/lemez-allapot.sh
cd /home/marveen/fleet-gate-proba && bash scripts/visszaallitasi-proba.sh ai
```

A szkriptek a kulcsot, a `store/`-t és a munkamappát abszolút úton érik el, tehát a checkoutból
ugyanúgy futnak, mint az élő fából.

**Ha az ablak nem fér egy ülésbe**, a CSAK a stage-re szóló ütemezett feladatokat (a stage
takarítás előszűrőjét viselő feladat, a heti visszaállítási próba) az ablakra érdemes kikapcsolni,
és az 5. lépésben visszakapcsolni: az élő fából futva elbuknak, és az előszűrő hibánál „fail
open”, vagyis minden futáskor egy hibaüzenettel felkelti az ágenst (barracuda, #29). **A napi
mentés maradjon bekapcsolva:** az éles adatbázisok (OS, Commerce, dokumentumok) mentése a 3.
lépésig az élő fából is megy, és csak az AI-része bukik, amit a fenti kézi futtatás pótol. Egy
mentés nélküli ablak rosszabb, mint egy hibaüzenet. A napi mentés AI-részét az ablak alatt a fenti megfeleltetés
új alakjaival, kézzel kell futtatni ugyanebből a checkoutból, ha az ablak egy napnál hosszabb.

Ha kész (5. lépés után):

```bash
cd /home/marveen/marveen && git worktree remove /home/marveen/fleet-gate-proba
```

## Lezárási mérés (a flotta konténeréből, a telepítés után)

```bash
cd /home/marveen/marveen && K=/home/marveen/.ssh/id_ed25519_acropora_monitor
ssh -i $K fleet@100.88.199.87 'docker info'; echo "kilépés: $?"     # elutasítva, kilépés: 2
ssh -i $K fleet@100.88.199.87 bash; echo "kilépés: $?"              # elutasítva, kilépés: 2
ssh -i $K fleet@100.88.199.87; echo "kilépés: $?"                   # elutasítva (nincs interaktív belépés)
ssh -i $K fleet@100.88.199.87 ps                                    # a konténerlista
```

A gépen: `journalctl -t fleet-gate -n 20` mutatja az `allow` és `deny` sorokat.

**A csak olvasó szerep mérése a kapun át** (az élesen; a stage-en `100.88.199.87`,
`cpnjvtte02yakzs9vb0jffky acropora_ai`, és a `"User"` helyett `conversations`):

```bash
cd /home/marveen/marveen && K=/home/marveen/.ssh/id_ed25519_acropora_monitor && G="ssh -i $K fleet@162.55.216.28 psql-ro iwm34jaqp9xmwb72qkrqkwhy acropora tuples"
printf 'select count(*) from "User";\n' | $G                              # egy szám
printf 'create table b8_proba (i int);\n' | $G                            # ERROR: permission denied for schema public
printf 'set default_transaction_read_only = off;\nupdate "User" set "displayName" = "displayName" where false;\n' | $G
                                                                          # ERROR: permission denied for table User
printf "copy (select 1) to program 'id';\n" | $G                          # ERROR: ... must be superuser or ... pg_execute_server_program
```

A második és a harmadik sor a lényeg: az írás nem a `default_transaction_read_only` miatt bukik
el (azt a harmadik sor kikapcsolja), hanem a jog hiánya miatt. A repó tesztje valódi Postgrest
nem ér el, ezért ez a mérés a telepítés része.

## Próba-sor: ezeknek kell zöldnek lenniük a kapun át

A teszt gépen előbb a stage-sorok, az élesítés után az éles sorok. A két telepítés között (lásd a köztes állapotot) a parancsok a checkoutból futnak: a `cd /home/marveen/marveen` helyett `cd /home/marveen/fleet-gate-proba`.

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
| a kereszt-másolás | `h=$(ssh <forrás> backup-sum dump <db> <dátum> \| cut -d' ' -f1)`, utána `ssh <forrás> backup-get dump <db> <dátum> \| ssh <cél> backup-put dump <db> <dátum> "$h"` (a dokumentumoknál `docstore <dátum>`). Egy félúton elhalt másolat így nem lesz végleges, és az ismételt futás a jót még aznap fel tudja tenni |
| `find ~/backups -name '*.dump' -mtime +14 -delete` | `backup-prune` (a dokumentum-csomagokat 7 nap után) |
| `apt-check --human-readable \| head -4`, `reboot-required` | `apt-check`, `reboot-required` (a `head` a konténerben), és új: `sshd-match` (áll-e még a kapu; a 0-s kilépést és a `match=1` sort kell látni) |
| `docker ps --filter name=proxy ...`, `docker ps --format "{{.Image}}" \| sort -u` | `ps`, a szűrés a konténerben |
| `docker exec $C env \| grep -E "^MEDUSA_(...)="` | `env-get` |
| `docker exec -i iwm34... psql -U acropora -d acropora -tA` | `psql-ro iwm34jaqp9xmwb72qkrqkwhy acropora tuples` |

## Ami a kapu után NEM megy (szándékosan)

- **A `staging-eles-adattal` skill élő adatot töltene a stage-re** (`pg_restore` írással). Ez
  pont a B7 (valódi ügyféladat a stage-en); a nyilvántartás szerint az anonimizálási lánc után
  jön vissza, más úton.
- **A `tailnet-atallas-meres.sh`**: egyszeri mérés volt, több soros shell az éles gépen.
- Interaktív belépés `fleet`-ként, és minden, ami nincs a fenti táblában.

## Korlátok, amiket tudni kell

- **Az `app-log` a naplót adja, szűrés nélkül** (Balázs, 2026-10-14 06:53 UTC). A Coolify API
  napló-végpontja `read:sensitive` jogot kér, ami a környezeti változók ÉRTÉKÉT is kiadja; ezt a
  flotta nem kapja meg, ezért megy a napló a kapun. Amit egy alkalmazás a naplójába ír (egy
  kiírt kulcs, egy vevő adata), az a flotta kulcsának tulajdonosa számára látszik: a napló
  olvasási kitettség, ugyanúgy, mint a `coolify-deploy-log`. Mielőtt egy naplórészlet jelentésbe
  vagy üzenetbe kerül, nézd meg, mit ír (a kulcs-visszafejtési hibáknál különösen). Telepítése a kapu újratelepítése:
  a `quote-templates-sync` szakasz telepítési lépése (a `stat` sor, az `install`, a két
  `sha256sum -c` sor) ezt is viszi.

- **A `psql-ro` a `fleet_ro` szereppel csatlakozik** (Balázs, 12:23 UTC): táblánkénti és
  oszloponkénti `SELECT` (Balázs, 2026-10-13 13:04:44 UTC), se superuser, se `pg_execute_server_program`. Írni nem tud, és a `COPY ... TO PROGRAM` sem ad neki
  shellt. A szerepet a kapu listája adja, a hívó nem választhat másikat. A `PGOPTIONS` és a
  backslash-tilalom (a psql `\!` meta-parancsa) ezen felül marad.
- **Amit a szerep NEM zár: a mentési utat.** A `fleet_ro` csak a flotta lekérdezéseinek oszlopait
  látja (a jelszó-hasheket, a tárolt titkokat és a listán kívüli táblákat nem, AMÍG nincs `PUBLIC`
  által olvasható tábla vagy nézet és futtatható `SECURITY DEFINER` függvény: ezt a telepítés előtti
  ellenőrzés méri, és egy későbbi migráció újra behozhatja), de a `pg-dump` és a
  `backup-get` a teljes adatbázist adja a flottának. A szűkítés tehát a kézi és a véletlen olvasás
  ellen véd, egy kompromittált munkamenet ellen nem; a titkosított mentés külön feladat. A lista
  személyes adatot is tartalmaz (a JEV névszűrőjéhez), de csak azt, ami ahhoz kell.
- **A `psql-ro` a DB-konténeren belül marad**, nem jut a gépre: a legrosszabb eset az adatbázis és
  a konténere. **Ezért nincs a listán a Coolify adatbázisa** (barracuda, #28): aki abba írhat, az
  dönti el, mit és milyen csatolással telepít a Coolify, vagyis root a gépen. A két olvasása
  ezért rögzített SQL-lel, név szerint megy. A `coolify-deploy-log` egy telepítés TELJES naplóját
  adja, és egy build-napló kiírhat környezeti változót vagy build-argumentumot: ez olvasási
  kitettség, a kirakat telepítésének követéséhez kell.
- **A `fleet` a docker csoportban marad.** Ha valaha új belépési út nyílik a `fleet`
  felhasználóhoz (jelszó, második kulcs), az megkerüli a kaput: a fenti ellenőrzést érdemes
  időnként újrafuttatni.

## Visszaállítás (rootként, a gépen)

```bash
cd /root
cp -p /etc/ssh/sshd_config.pre-b8 /etc/ssh/sshd_config && sshd -t && systemctl reload ssh
```

Ezzel az sshd újra a `~fleet/.ssh/authorized_keys`-t olvassa, amiben a kulcs kényszer nélkül
áll (a telepítés nem nyúlt hozzá). A `/etc/ssh/authorized_keys/fleet` maradhat, azt az sshd ilyenkor
nem olvassa. A `/bin/sh` login shell is maradhat (ha mégis: `usermod -s /bin/bash fleet`). A
`fleet_ro` szerep is maradhat; ha el kell vinni, a konténerben, egy tranzakcióban:
`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fleet_ro; REVOKE USAGE ON SCHEMA public FROM fleet_ro; DROP ROLE fleet_ro;`
(oszlopjog mellett a puszta `DROP ROLE` elbukik).

A `/usr/local/sbin/fleet-gate` maradhat: kényszer nélkül senki nem hívja.
