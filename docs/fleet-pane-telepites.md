# fleet-pane: telepítési lap (B48 (2))

Mit vált ki: `marveen ALL=(agent-*) NOPASSWD: /usr/bin/tmux` (a `/etc/sudoers.d/fleet-tmux` hat tmux-sora),
ami minden ágens felhasználójaként teljes shellt ad. Helyette egy root közvetítő, zárt igékkel
(`docs/fleet-pane.md`). Terv: `exchange/biztonsag/baseline/b48-kezbesito-terv-2026-10-13.md` (barracuda APPROVE).
Feladat: `b48-kozvetito-megvalositas`.

**Minden lépés Balázsé, és mindegyik külön jóváhagyás** (Security Baseline: éles módosítás csak így). A sorrend a
terv 7. pontja: a stage-flottán előbb, élesen csak utána. A parancsok a hostról futnak.

## 0. Ami a lépések előtt kész (a flotta dolga, nem a tiéd)

- A közvetítő, a router átállása és a tesztek a fő ágon: #182, #185, #191, #195, és ez a PR (a bootstrap 4c lépése,
  a négy shell-eszköz, ez a lap).
- **A konténer-újrateremtés nem veszti el** (ez a PR): a root-fájlok a hostról jönnek, csak olvasható mounttal, és a
  `fleet-bootstrap.sh` 4c lépése a boot útján visszarakja a közvetítőt (rögzített lenyomattal), a `start` könyvtárat és
  a sudo-sort. A tmux-sor visszavonását egy jelölő-fájl mondja meg ugyanabban a mountban: amíg ott van, a bootstrap a
  tmux-sort **nem** írja vissza, és a 7. lépése hibát jelez, ha mégis él.

## 1. A hosti könyvtár (a root-fájlok helye)

Ami benne van, az root-é, és a konténerben csak olvasható: a `marveen` nem írhatja, és egy újrateremtés nem viszi el.

**A claude bináris NEM a konténerből jön** (barracuda, #210 review). A konténerbeli példány a `marveen` írható
könyvtárában áll, tehát a `marveen` választaná ki, mit indít a közvetítő ágens-felhasználóként, és a B48 éppen ezt
zárja ki. A bináris a hoston, a hivatalos telepítővel jön (a repó is ezt használja verzióra rögzítve:
`install-linux.sh`), egy ideiglenes HOME-ba, a saját felhasználóddal (nem rootként):

```bash
cd /opt/marveen-docker
T="$(mktemp -d)"
HOME="$T" bash -c 'curl -fsSL https://claude.ai/install.sh | bash -s 2.1.301'
ls -l "$T/.local/share/claude/versions/2.1.301" || echo "ALLJ MEG: a telepito nem ide tett binarist, ne menj tovabb"
```

**Összevetés, és eltérésnél nem megyünk tovább:** a hivatalos letöltés lenyomata egyezzen a konténerben ma futó
példányéval. Két független forrás: ha egyeznek, a konténerbeli példány sem volt átírva, és a flotta ugyanazt a verziót
kapja, amin ma fut. Ha eltérnek, **itt megállsz**, és semmi nem kerül a `fleet-pane` könyvtárba: vagy a konténerbeli
példány változott meg, vagy a verzió más, és mindkettőt előbb meg kell érteni.

```bash
cd /opt/marveen-docker
sha256sum "$T/.local/share/claude/versions/2.1.301"
docker compose exec marveen sha256sum /home/marveen/.local/share/claude/versions/2.1.301
```

Ha a két szám betűre egyezik, a hivatalos letöltés kerül a helyére (a másolás `sudo`-val, mert a cél root-é):

```bash
cd /opt/marveen-docker
sudo install -d -o root -g root -m 0755 fleet-pane fleet-pane/claude fleet-pane/claude/2.1.301
sudo install -o root -g root -m 0755 "$T/.local/share/claude/versions/2.1.301" fleet-pane/claude/2.1.301/claude
sha256sum fleet-pane/claude/2.1.301/claude
rm -rf "$T"
```

Az utolsó `sha256sum` ugyanaz a szám, mint a két előző. A verzió a mai (mérve 2026-10-16: a legújabb a `versions`
alatt `2.1.301`); a pontos számot a `docker compose exec marveen readlink -f /home/marveen/.local/bin/claude` adja. A
claude frissítése ezentúl ugyanez a root-lépés: új `claude/<verzió>/` könyvtár ugyanígy, és a `start-values.json`
`claudeBin` sora. Hogy a telepítő maga ellenőriz-e lenyomatot, azt nem mértem (a flotta nem éri el a claude.ai-t); az
összevetés ezért nem a telepítőre bízza.

A két JSON a `scripts/root/*.example.json` alakjában, a mai hat ágenssel (mérve az `agent-config.json`
fájlokból 2026-10-16: mindegyik saját felhasználó alatt fut, egyiknek sincs channel-je). Megírod őket a saját
könyvtáradban, és root 0644-gyel teszed a helyükre:

```bash
cd /opt/marveen-docker
sudo install -o root -g root -m 0644 ~/agents.json fleet-pane/agents.json
sudo install -o root -g root -m 0644 ~/start-values.json fleet-pane/start-values.json
```

`fleet-pane/agents.json`:

```json
{
  "agents": {
    "barracuda": { "user": "agent-barracuda", "workdir": "/home/marveen/marveen/agents/barracuda", "profile": "reviewer" },
    "korall":    { "user": "agent-korall",    "workdir": "/home/marveen/marveen/agents/korall",    "profile": "marketer" },
    "murena":    { "user": "agent-murena",    "workdir": "/home/marveen/marveen/agents/murena",    "profile": "developer-senior" },
    "nautilus":  { "user": "agent-nautilus",  "workdir": "/home/marveen/marveen/agents/nautilus",  "profile": "developer-senior" },
    "picasso":   { "user": "agent-picasso",   "workdir": "/home/marveen/marveen/agents/picasso",   "profile": "designer" },
    "polip":     { "user": "agent-polip",     "workdir": "/home/marveen/marveen/agents/polip",     "profile": "researcher-reader" }
  }
}
```

`fleet-pane/start-values.json`: a `scripts/root/fleet-pane-start-values.example.json`, egy eltéréssel:
`"claudeBin": "/etc/fleet-pane/conf/claude/2.1.301/claude"`. A `profiles` lista a `templates/profiles/*.json`
módjait követi (a `developer-senior` permissive, a többi öt használt profil strict).

**Ez a te döntésed, és a fájlban rögzül:** melyik profil fut `--dangerously-skip-permissions` kapcsolóval. Ma a router
a sablon módjából számolja, a közvetítő után ebből a fájlból, amit a `marveen` nem írhat.

## 2. A mount, és vele a telepítés

A `docker-compose.yml` `marveen` szolgáltatásának `volumes` listájába egy sor:

```yaml
      - ./fleet-pane:/etc/fleet-pane/conf:ro
```

Utána:

```bash
cd /opt/marveen-docker
docker compose up -d
```

**Ez újrateremti a konténert, vagyis a teljes flotta újraindul.** A boot útján a `fleet-bootstrap.sh` (a fő ág
példánya, `ensure-native-modules.sh` hívja) a mountot látva telepíti a `/usr/local/sbin/fleet-pane`-t (csak ha a
lenyomata a bootstrapba rögzített érték), létrehozza a `/etc/fleet-pane/start`-ot (root 0755), és felveszi a
`/etc/sudoers.d/fleet-pane`-t, egyetlen sorral:

```
marveen ALL=(root) NOPASSWD: /usr/local/sbin/fleet-pane
```

Argumentum-szűrés szándékosan nincs a sorban: a közvetítő maga szűr (terv 4.1). **A tmux-sor ekkor még ott marad**
(terv 7.1), és a kapcsoló még ki van kapcsolva: a router a régi úton megy.

Ellenőrzés:

```bash
cd /opt/marveen-docker
docker compose exec -u marveen marveen bash /home/marveen/marveen/scripts/fleet-bootstrap.sh --dry-run
```

A 4c szakaszban `ok: /usr/local/sbin/fleet-pane is the pinned version` és `ok: /etc/fleet-pane/start` (a száraz
futás a 7. lépés közvetítő-ellenőrzését kihagyja; azt a boot-futás végzi, a dashboard naplójában). Utána egy ágensen
a közvetítő maga: `docker compose exec -u marveen marveen sudo -n /usr/local/sbin/fleet-pane status murena` (kiírja
az `agent-murena` nevet, kilépési kód 0).

## 3. A kapcsoló

```bash
cd /opt/marveen-docker
docker compose exec -u marveen marveen sh -c 'printf "\nFLEET_PANE_BROKER=on\n" >> /home/marveen/marveen/.env'
docker compose exec marveen supervisorctl restart dashboard
```

Innen a router és a négy shell-eszköz (`agent-pane.sh`, `feladat-keret-or.sh`, `fleet-doctor.py`,
`agent-to-own-user.sh`) a közvetítőn megy; a kapcsolót mindegyik ugyanúgy olvassa (`scripts/lib/fleet_pane_switch.py`).
**24 óra mérés** (terv 7.2), a 6. pont P4 sora szerint.

Vissza: a sor törlése a `.env`-ből (vagy `off`), és `supervisorctl restart dashboard`. Másodpercek.

## 4. Mi törlődik: a tmux-sor

Csak ha a 3. pont 24 órája rendben volt, és a 6. pont N- és P-sorai zöldek.

**Előbb a mentés, a hostra** (a konténer `/root`-ja egy újrateremtéssel elveszne):

```bash
cd /opt/marveen-docker
sudo docker compose cp marveen:/etc/sudoers.d/fleet-tmux ./fleet-tmux.elotte-b48
sudo cat ./fleet-tmux.elotte-b48
```

A kiírt fájlban hat `NOPASSWD: /usr/bin/tmux` sor áll (egy ágensenként), mellettük a token-olvasás próbája és az
`is-paired.sh` sorai. Utána a döntés rögzítése (a jelölő a mountban: a `marveen` nem veheti vissza, és egy
újrateremtés sem írja vissza a sort), és a sor törlése most:

```bash
cd /opt/marveen-docker
sudo touch fleet-pane/no-tmux-line
docker compose exec -u root marveen sh -c '
  f=/etc/sudoers.d/fleet-tmux; u=/etc/sudoers.d/.fleet-tmux.uj
  grep -vF "NOPASSWD: /usr/bin/tmux" "$f" > "$u" || { echo "ALLJ MEG: a grep nem adott sort"; rm -f "$u"; exit 1; }
  regi=$(wc -l < "$f"); uj=$(wc -l < "$u"); tm=$(grep -cF "NOPASSWD: /usr/bin/tmux" "$f")
  if [ "$tm" -ne 6 ] || [ "$uj" -ne $((regi - 6)) ] || [ "$uj" -lt 1 ]; then
    echo "ALLJ MEG: regi $regi sor, tmux $tm, uj $uj sor (vart: tmux 6, uj = regi - 6, legalabb 1)"; rm -f "$u"; exit 1
  fi
  diff "$f" "$u"
  visudo -c -f "$u" && install -o root -g root -m 0440 "$u" "$f"; rm -f "$u"'
```

A parancs csak akkor írja át a fájlt, ha pontosan a hat tmux-sor esik ki, és a többi sor megmarad (barracuda: egy
üres kimenet a `visudo -c`-n átmenne, és az `install` a token-próba és az `is-paired.sh` sorait is elvinné). A
`diff` a telepítés előtt kiírja, mi esik ki: csak `<` kezdetű tmux-sorok lehetnek benne. Ha az ágensek száma közben
változott, a 6 helyett a mentésben számolt tmux-sorok száma áll. A ponttal kezdődő ideiglenes nevet a sudo nem olvassa
be (a `sudoers.d` a pontot tartalmazó neveket kihagyja).

**Egy határ, amit a konténer belülről nem lát** (barracuda): a visszavonást egyedül a mountban álló jelölő hordozza. Ha
egyszer a `docker-compose.yml`-ból kimarad a mount sora, a következő újrateremtés után a bootstrap a tmux-sort
**csendben visszaírja**, és a 7. lépése zöldet mond (mert a mount nélkül nem tudja, hogy a sor vissza volt vonva). Ezt
a 6. pont N10 sora fogja meg.

## 5. Visszaállítás

| Hol tartunk | Vissza | Idő |
|---|---|---|
| 2. után (telepítve, kapcsoló ki) | semmi nem kell; a fájlok maradhatnak, vagy a mount sorát kivenni és `docker compose up -d` | - |
| 3. után (kapcsoló be, tmux-sor él) | `FLEET_PANE_BROKER` ki, `supervisorctl restart dashboard` | másodpercek |
| 4. után (tmux-sor törölve) | a lenti három parancs, utána a kapcsoló ki és a dashboard újraindítása | egy perc |

```bash
cd /opt/marveen-docker
sudo rm -f fleet-pane/no-tmux-line
sudo docker compose cp ./fleet-tmux.elotte-b48 marveen:/etc/sudoers.d/.fleet-tmux.vissza
docker compose exec -u root marveen sh -c 'visudo -c -f /etc/sudoers.d/.fleet-tmux.vissza && install -o root -g root -m 0440 /etc/sudoers.d/.fleet-tmux.vissza /etc/sudoers.d/fleet-tmux; rm -f /etc/sudoers.d/.fleet-tmux.vissza'
```

A jelölő törlése nélkül a következő újrateremtés a visszatett sort újra elhagyná.

## 6. Mit kell mérni utána (terv 8. szakasz)

Amit a flotta tud mérni (a 2. pont után, a `marveen`-ként vagy ágensként, írás nélkül):

| # | Mérés | Mikor |
|---|---|---|
| N8 | `/usr/local/sbin/fleet-pane`, `/etc/fleet-pane/start` és a benne lévő szkriptek, `/etc/fleet-pane/conf` és minden fájlja, `/var/log/fleet-pane.log`: `test -w` hamis a `marveen`-ként; a telepített közvetítő `sha256`-ja a fő ág `scripts/root/fleet-pane.py`-jé | 2. után |
| N9 | a közvetítő gyerekfolyamatainak környezete üres (a `start` csak a felsorolt nyolc változót adja) | 3. után, egy indításon |
| P2 | `status`, `capture`, `stop`, `start` mind a hat ágensen | 3. után |
| P1 | egy üzenet `delivered`, és a közvetítő naplójának `sha256`-ja a tárolt üzenetéé | 3. után |
| P3 | friss indítás: a láblécet tétlennek olvassa, a D-csoport párbeszédei kezelve | 3. után |
| N5 | az ágens futó folyamata a sablon szerinti `claude` (`ps` az ágens felhasználójára) | 3. után |
| P4 | 24 óra: kézbesített, elutasított, újrapróbált üzenetek, indítások, beragadások, az előző 24 órával összevetve | 3. után |
| N3 | `sudo -n -l` a `marveen`-ként: nincs `tmux` sor; a bootstrap 7. lépése `ok: no tmux line for agent-...` | 4. után |
| N10 | egy újrateremtés után (a következő, ami amúgy is jön): N3 és N8 ugyanúgy, és a 7. lépés zöld. **Ha itt az N3 piros (a `marveen` újra futtathat tmux-ot ágensként), az a mount elvesztését jelenti** (a 4. pont határa): a `docker-compose.yml` mount sorát kell visszatenni, nem a sudoers-t javítani | 4. után |

A naplót (`/var/log/fleet-pane.log`, root 0600) csak root olvassa: a P1 és a P4 számait te adod ki, vagy egy
olvasó csoportot döntesz el hozzá. A napló a konténer fájlrendszerében van, tehát egy újrateremtés elviszi.

Ami élő kísérlet, és a stage-flottán megy előbb: N6 (verseny: egy háttérparancs a `deliver` közben fejeződik be;
a közvetítő naplójában `suspect-accept` sor kell, ha a lábléc az Enter után párbeszédet mutat), és a kalibráció a 8.
szakasz szerint (a régi úton a jelölő-fájl LÉTREJÖN, különben a negatív próbák zöldje semmit nem mond). Az N6 és a
kalibráció a tmux-sorral még élő állapotban (3. után, 4. előtt) mehet.

## 7. Amitől a B48 még nem zárul le

A közvetítő a tmux-sort váltja ki. A B48 osztálya (egy munkamenet felső határa egy másik ágens munkamenete) még két úton
nyitva marad, és mind a kettő külön tétel:

1. **A `/keys` végpont** (a vezérlőpult terminálja). A közvetítőben nincs rá ige, tehát a kapcsoló bekapcsolása után
   elutasít (N7). Hogy ki gépelhet ágens-panelbe és min keresztül, az a terv D6 döntése (6.1-6.2): ma a
   `store/terminal-input.json` `enabled: true`, és a közös tokennel hívható.
2. **B45 C pontja:** az ágens ne módosíthassa a saját biztonsági konfigurációját (`settings.json`, `agent-config.json`),
   és a B45 2.3: az ágensek egymás `settings.local.json`-ját, `CLAUDE.md`-jét és skilljeit is írják (`fleet` csoport).
   A közvetítő a `securityProfile`-t már csak összeveti a root listával (eltérésnél nem indít), de a `settings.json`
   engedélylistáit és hookjait továbbra is a router írja.

A B48 akkor zárható, ha ez a lap 4. pontja lement, és a fenti kettő is lezárult.

## Új ágens hozzáadása (a tmux-sor törlése után)

Az `agent-to-own-user.sh` a jelölő mellett nem ír tmux-sort, hanem szól, hogy az ágensnek a hosti `agents.json`-ban kell
lennie. Tehát: a `fleet-pane/agents.json` új sora (név, felhasználó, munkakönyvtár, profil) a hoston, root-lépésként; a
mount élő, a fájl azonnal látszik. Utána mehet a szkript.
