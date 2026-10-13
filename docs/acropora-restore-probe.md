# acropora-restore-probe: az OS, a Commerce és a dokumentumtár mentésének visszaállítási próbája (B8)

Feladat: `b8-visszaallitasi-proba`, kártya `ac5fedba`. Szerző: nautilus, 2026-10-13. Review: barracuda.

**Röviden:** az éles gépen (`acropora-prod-01`) heti egyszer, rootként, UGYANAZZAL a NAS-hozzáféréssel,
amivel a három mentés ír, egy nevesített automatizmus letölti a NAS-ról a legújabb OS és Commerce
dumpot, valamint a dokumentumtár tükrét. A két dumpot egy hálózat nélküli, eldobható konténerbe tölti
vissza, és összeveti az élővel (az élő oldalon csak olvasó lekérdezés fut). Utána mindent töröl, és
egyetlen JSON eredményt tesz a NAS-ra. A flotta a meglévő AcroBot fiókjával csak ezt az eredményt
olvassa. **A flotta joga nem bővül:** nincs új NAS-jog, nincs új kapu-művelet, nincs új sudo sor.

## A döntések, amikre épül

| Mi | Ki | Hol |
|---|---|---|
| A fleet kapu jogai a hiányzó OS/Commerce/docstore próbák miatt NEM bővülnek | Balázs | Token szál, 2026-10-13 16:59:45 UTC, msg 1559611614309650473 |
| A próba a flotta jogainak bővítése NÉLKÜL készül | Balázs | Token szál, 2026-10-13 17:07:37 UTC, msg 1559613596789383233 |
| Nincs rendszeres kézi rootos ellenőrzés, nevesített és korlátozott automatizmus kell, a flotta csak az eredményt olvassa | Balázs | Token szál, 2026-10-13 15:48:21 UTC, msg 1559593647257681982 |
| A próba a TÁROLT másolatot tölti vissza, nem friss dumpot | Balázs kérése, 2026-10-07 17:05 UTC | `scripts/visszaallitasi-proba.sh` fejléce |

## Mérés: mi áll a NAS-on, és mit lát belőle a flotta

acrobot mérte 2026-10-13 23:37-kor az AcroBot sftp fiókkal, csak `ls -ln`, semmi `get`
(nyers kimenet: `exchange/biztonsag/baseline/b8-zaro/nas-ls-2026-10-13.txt`).

| NAS könyvtár | Könyvtár módja, tulajdonos | Legújabb fájl | Méret | Fájl módja | A flotta (AcroBot) |
|---|---|---|---|---|---|
| `acropora-os-postgres` | `drwxrwxrwx 1026:100`, 85 fájl | `acropora-2026-10-13_03-02-47.dump` | 117 285 967 B | `-rw------- 1032:100` | listáz, a 07-26 és 08-29 közötti 40 régit olvassa (lásd lent), az újakat nem |
| `acropora-commerce-postgres` | `drwxrwxrwx 1032:100`, 24 fájl | `medusa-2026-10-13_04-07-48.dump` | 491 765 B | `-rw------- 1032:100` | listáz, nem olvas |
| `acropora-os-document-store` | `drwx------ 1032:100` | (tükör, nem dátumozott) | ismeretlen | ismeretlen | **nem is listáz** (`readdir`: Permission denied) |

A fájlnév és a formátum: mindkét adatbázis `pg_dump -Fc` (`.dump`), naponta 03:0x (OS) és 04:0x
(Commerce). A Commerce dump napok óta bájtra azonos méretű: az éles Commerce üres (emlék 2063),
ezért ott a próba a **séma** visszaállását méri (a táblák megléte), a sorszám nulla kontra nulla.

A mentő szkriptek másolata az élő fa `docs/` mappájában áll (gitben NINCS, a `docs/*` szabály
kizárja): `acropora-db-backup` (Commerce, paraméterezett), `acropora-document-store-backup` és a
hozzájuk tartozó unitok. Ezek a 2026-09-21-i állapotot mutatják, nem feltétlenül a telepítettet
(a 10-07-i `--chmod=F640` módosítás például nincs bennük). Az OS mentés szkriptje
(`/usr/local/sbin/acropora-postgres-backup`) `-rwx------ root`, a tartalma nem ismert, de a NAS
oldali eredménye a fenti. Mindhárom ugyanazt a hozzáférést használja: rsync daemon,
`rsync://acropora-backup@csupor/Acropora_Backup/...`, jelszó: `/etc/acropora-backup-rsync.secret`.

## Hol fut, ki alatt, mi a kimenet

| | |
|---|---|
| Gép | `acropora-prod-01` (ott készül mindhárom mentés, ott van a NAS-hozzáférés, ott fut az élő adatbázis és a dokumentumtár kötete) |
| Identitás | `root`, systemd unit, ugyanaz, mint a három mentésé (`User=root`, `NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome`, `PrivateTmp`, `Nice=19`, `IOSchedulingClass=idle`) |
| NAS-hozzáférés | a meglévő `/etc/acropora-backup-rsync.secret`. **Új titok nincs.** |
| Ütemezés | vasárnap 04:40 (Budapest), a három éjszakai mentés után; a flotta vasárnap 05:30-kor olvassa (`scripts/mentes-cron.sh proba`) |
| Kimenet a gépen | `/var/lib/acropora-restore-probe/result-<dátum>.json` (az utolsó 20 marad), napló: `journalctl -u acropora-restore-probe` |
| Kimenet a NAS-on | `Acropora_Backup/acropora-restore-probe/result-<dátum>.json`, fájl 0644, könyvtár 0755; a szkript hozza létre az első futáskor, és minden futáskor újra beállítja a könyvtár jogát |
| Munkaterület | `/var/tmp/acropora-restore-probe`, a futás végén (hiba esetén is) törlődik |

**Miért nem a stage gépen:** oda a NAS-jelszót és az éles adatot is át kellene vinni. Így az éles
adat nem hagyja el azt a gépet, ahol eddig is volt, és új hozzáférés sem keletkezik.

**Miért nem a flottában:** a flotta nem olvashatja a dumpokat, és ez a döntés szerint így marad.

## Mit csinál, és mit soha

Fajtánként (`os`, `commerce`, `docstore`), egymástól függetlenül, tehát egy bukott fajta nem állítja
meg a többit:

* **os, commerce:** a NAS-listából a legújabb `.dump` (a listázott módosítási idő szerint), a kora
  legfeljebb 36 óra. Letöltés, a méret egyezzen a listázottal. Eldobható konténer
  (`acropora-restore-probe-<fajta>`) az élő konténer SAJÁT képéből (`--pull never`: semmit nem
  tölt le, és a fő verzió biztosan egyezik), `--network none`, `--memory 1g`, `--cpus 1`,
  `--pids-limit 256`. Készenlét TCP-n (`pg_isready -h 127.0.0.1`), mert az initdb alatt a belépési
  pont egy ideiglenes, csak socketen figyelő szervert futtat. `pg_restore --no-owner
  --no-privileges --exit-on-error`. Utána minden közönséges tábla PONTOS sorszáma a visszatöltött
  példányon és az élőn (az élőn `default_transaction_read_only=on`, `statement_timeout` 10 perc,
  `lock_timeout` 10 mp). A konténer és a fájl törlődik.
* **docstore:** a kötet jelölőfájlja (`.acropora-document-store`) megvan-e (különben a kötet nincs
  csatolva). A NAS-tükör letöltése ideiglenes könyvtárba. Minden élő fájlnak, ami 25 óránál régebbi,
  ott kell lennie, azonos sha256-tal (a fájlok feltöltés után sosem változnak, tehát eltérés csak
  sérült másolat lehet). Ami frissebb, az még nem kerülhetett fel, ezért nem buktat.

**Soha:** az élő adatbázisba vagy kötetbe nem ír (az élő oldalon csak csak-olvasó `psql`, illetve
`find`/`sha256sum` fut), a NAS-on lévő mentéshez nem nyúl (csak olvassa), és az eredménybe nem kerül
adat. Az eredményben csak számok, méretek, táblanevek és rögzített okok állnak; a `pg_restore` saját
hibaszövege a naplóban marad, mert egy `COPY` hiba idézi a sort. A dokumentumok nevei sem kerülnek
bele, csak a darabszám.

**A PASS feltételei** (a küszöbök az `/etc/acropora-restore-probe.env`-ben felülírhatók, de alapból
nem kell a fájl):

| Fajta | FAIL, ha |
|---|---|
| os, commerce | nincs dump; 36 óránál régebbi; üres; a letöltött méret eltér; nem fut az élő konténer; kevés a hely; a konténer nem indul vagy nem áll fel; a `pg_restore` nem 0-val tér vissza; a visszatöltött példányban nincs tábla; **egyetlen** élő tábla is hiányzik belőle (az élesen az automatikus telepítés ki van kapcsolva, tehát egy migráció a dump és a próba között döntés, nem zaj); a visszatöltött sorok összege az élő felénél kevesebb; egy legalább 1000 soros élő tábla üresen jött vissza |
| docstore | nincs jelölő; a NAS-tükör üres; kevés a hely; a letöltés elhasal; nincs ellenőrizhető élő fájl; egy régebbi élő fájl hiányzik vagy eltér |
| az egész | bármelyik fajta FAIL, VAGY az eredmény nem jutott fel a NAS-ra (a feltöltés után a méretét visszaméri): ami nem ér el a flottához, az nem eredmény |

**A flotta oldala** (`scripts/visszaallitasi-proba.sh host`, és az `all` is): a NAS-on a legújabb
`result-*.json`, és fajtánként a `scripts/visszaallitasi-proba-eredmeny.py`. FAIL, ha nincs
eredmény, ha 192 óránál (nyolc nap) régebbi, ha a formátum ismeretlen, ha a státusz nem PASS, vagy
ha a PASS mellett álló számok mást mondanak (nulla tábla, hiányzó tábla, nem nulla `restore_rc`,
nulla ellenőrzött dokumentum). Egy PASS-t tehát nem fogad el a szavára.

## Kockázat

* **Terhelés az éles gépen:** egy 117 MB-os dump visszatöltése egy CPU-n, 1 GB memóriával, `nice
  19` és üresjárati I/O mellett, vasárnap hajnalban. A visszatöltött példány a dump többszöröse
  lehet a lemezen, ezért a szkript előtte méri a szabad helyet (a dump hatszorosa plusz 1 GB a
  Docker gyökerén), és ha nincs, nem kezd bele.
* **A dump tetszőleges SQL-t futtathat superuserként a visszatöltés alatt:** ezért nincs hálózata
  a konténernek, és korlátok közt fut. Ugyanez a minta, mint a kapu `restore-probe` műveleténél
  (barracuda, #28).
* **A jelszófájl:** ugyanaz, amit a három mentés már ma is olvas, ugyanazon a gépen, ugyanazzal az
  identitással. Új titok vagy új olvasó nem keletkezik.

## Két lelet a mérésből (nem ennek a PR-nek a része, Balázs döntése)

1. **40 régi OS dump világ-olvasható a NAS-on** (`-rwxrwxrwx`, 2026-07-26 és 2026-08-29 között),
   tehát a flotta AcroBot fiókja ma is olvashat jelszó-hasheket tartalmazó éles mentést. Az
   `acropora-os-postgres` és az `acropora-commerce-postgres` KÖNYVTÁR pedig `drwxrwxrwx`: a flotta
   fiókja ezekben törölhet vagy felülírhat mentést. Javaslat: a régi fájlok `chmod 600`, a két
   könyvtár 0750 (a Synology felületén vagy rootként a NAS-on).
2. **A 2026-10-07-i `--chmod=F640` nem hat** (az OS dumpok 10-07 után is 0600-ak), és a valószínű
   ok helyben mérve: `-p` nélkül az rsync `--chmod`-ja nem érvényesül, ha a fogadó oldal umaskja
   szigorúbb (helyi rsync 3.2.7, umask 077: `-t --chmod=F644` → 600, `-tp --chmod=F644` → 644).
   A NAS daemon umaskját nem mértem. Ez most éppen jól jön: a döntés szerint a flotta ne olvassa a
   dumpokat. Ha egyszer mégis kellene, a `-p` hiányzik, nem a `--chmod`.

## Telepítés (Balázs root lépése az éles gépen)

**0. Előmérés, csak olvas.** Várt kimenet a sorok mellett; ha bármelyik eltér, állj meg, és küldd el.

```bash
cd /root
ls -l /etc/acropora-backup-rsync.secret                       # létezik, root, 600
systemctl list-timers 'acropora-*' --all | grep -c backup     # 3 (OS, Commerce, docstore)
docker ps --format '{{.Names}} {{.Image}}' | grep -E '^(iwm34jaqp9xmwb72qkrqkwhy|xdfswedgxuehokvymhjotpfs)'   # két sor
df -h /var/tmp /var/lib/docker                                # legalább 2 GB szabad mindkettőn
du -sh /var/lib/docker/volumes/t9gxx94ecwekwruxngps5i6v-acropora-api-document-store/_data   # ennyi + 1 GB kell /var/tmp-n
which rsync flock sha256sum                                   # mindhárom megvan
```

**1. A fájlok átvitele.** A PR beolvadása és a flotta frissítése után a három fájl az éles gépen
itt áll: `/opt/marveen-docker/data/marveen/scripts/host/acropora-restore-probe{.sh,.service,.timer}`.
Mivel ez ugyanaz a gép, nem kell `scp`:

```bash
cd /opt/marveen-docker/data/marveen/scripts/host
sha256sum acropora-restore-probe.sh                           # egyezzen a PR-ben megadottal (a flotta megadja)
install -o root -g root -m 0750 acropora-restore-probe.sh /usr/local/sbin/acropora-restore-probe
install -o root -g root -m 0644 acropora-restore-probe.service acropora-restore-probe.timer /etc/systemd/system/
systemctl daemon-reload
```

**2. Az első futás kézzel** (a NAS-on ekkor jön létre az `acropora-restore-probe` könyvtár, 0755-tel):

```bash
cd /root && systemctl start acropora-restore-probe.service; systemctl status acropora-restore-probe.service --no-pager | head -5
cd /root && journalctl -u acropora-restore-probe --since -3h --no-pager | tail -40
```

Várt: a napló végén `PASS[os]`, `PASS[commerce]`, `PASS[docstore]` és `KESZ. minden proba PASS`,
a `status` sorban `status=0/SUCCESS`. Ha `FAIL[...]` sor van, az oka ugyanabban a sorban áll; a
naplót küldd el, a timert ilyenkor még ne kapcsold be.

**3. A visszamérés a flottából** (ezt acrobot futtatja, nem kell rootként):

```bash
cd /home/marveen/marveen && bash scripts/visszaallitasi-proba.sh host
```

Várt: mindhárom fajtára egy `eredmeny:` és egy szám-sor, a végén `KESZ.`. Ez egyben azt is
bizonyítja, hogy az AcroBot fiók a könyvtárat listázni, a fájlt olvasni tudja. Ha itt `nincs
eredmeny a NAS-on` jön, de a 2. lépés PASS volt, akkor a Synology a könyvtárra a 0755-öt nem
engedi: a DSM felületén az `acropora-restore-probe` mappára az AcroBot felhasználónak olvasási jog
kell (csak erre a mappára).

**4. A heti ütemezés bekapcsolása**, csak ha a 2. és a 3. zöld:

```bash
cd /root && systemctl enable --now acropora-restore-probe.timer && systemctl list-timers acropora-restore-probe.timer --no-pager
```

Várt: a következő futás vasárnap 04:40 körül.

**Visszaállítás** (bármikor, adatvesztés nélkül; a NAS-on csak az eredményfájlok maradnak):

```bash
cd /root && systemctl disable --now acropora-restore-probe.timer
cd /root && rm -f /etc/systemd/system/acropora-restore-probe.service /etc/systemd/system/acropora-restore-probe.timer /usr/local/sbin/acropora-restore-probe && systemctl daemon-reload
cd /root && docker ps -a --format '{{.Names}}' | grep '^acropora-restore-probe-' | xargs -r docker rm -f -v; rm -rf /var/tmp/acropora-restore-probe
```

## Ami a beolvadás és a telepítés között történik

A flotta `visszaallitasi-proba.sh all` ezentúl a host-oldali eredményt is olvassa. Amíg a 2. lépés
nem futott, a vasárnapi próba ezért `FAIL[os]`, `FAIL[commerce]`, `FAIL[docstore]` sort ad,
„a host-oldali proba nem fut” okkal. Ez szándékos: a hiány valódi, és a B8 lezárása épp ezen áll.
Ha a riasztás a telepítésig zavar, a `mentes-cron.sh proba` sora ideiglenesen `fleet` és `ai`
argumentummal is hívható, de ezt acrobot döntse el.

## Ellenőrzés a PR-ben

`bash scripts/__tests__/acropora-restore-probe.test.sh` (a CI-ben is fut): valódi bash, rsync és
sha256sum, a `docker` egy naplózó csonk, a NAS egy helyi könyvtár. Lefedi a jó világot, a bukott
visszatöltést, a régi dumpot, az üres és a részleges visszatöltést, a hiányzó táblát, a sérült és a
hiányzó dokumentumot, a hiányzó jelölőt, a nem futó élő konténert, a fel nem jutott eredményt, a
zárat, a rossz munkakönyvtárat, és az olvasót. Kalibrálva: a fő őrzők egyenkénti kikapcsolása
(csak-olvasó `PGOPTIONS`, kezdeti söprés, záró takarítás, korhatár, a dokumentumtár türelmi ideje,
a feltöltés `-p` kapcsolója, a hiányzó tábla, a feltöltés visszamérése, az olvasó korhatára és
hiányzó-tábla ága) mindegyik pirosat ad.

**Amit a teszt NEM bizonyít:** a valódi `pg_restore` és `psql` viselkedését (a `\gexec`-es számlálást,
az `--exit-on-error` hatását a valódi dumpokon), a Synology daemon jogkezelését, és a futásidőt az
éles gépen. Ezeket a 2. és a 3. lépés méri.
