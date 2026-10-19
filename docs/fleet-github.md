# fleet-github: a flotta GitHub-tokenjei egy App-ból, a tulajdonosi token helyett (D4 2. lépcső)

Terv: `agents/nautilus/biztonsag/d4-2-lepcso-github-app-2026-10-15.md` (barracuda APPROVE, v2 + két mondat). Döntés: Balázs,
2026-10-15 12:24 UTC, **A változat** (GitHub App a szerző és a beolvasztó, a kötelező jóváhagyást barracuda adja egy gépi
fiókkal). Feladat: `t-20261015-d4-app-flotta` (acrobot 31402). **Ebben a PR-ban semmi nincs telepítve**, és a kapcsoló
alapból ki van kapcsolva.

**2026-10-16 óta az alapérték a BRÓKER** (acrobot 32199, a 10. lépés lelete; feladat `b25-e3`). A `FLEET_GITHUB_APP`
nélkül, vagy bármely `off`-tól eltérő értékkel a szkriptek, a `git-auth.sh`, a `pr-beolvaszt.sh`, a `github-pr-monitor.sh`
és a vezérlőpult is a brókertől kér tokent. A tulajdonosi tokent csak a pontosan `FLEET_GITHUB_APP=off` adja: ez a kifejezett
visszaállítás. **Miért:** a szkriptek a kapcsolót a saját folyamatuk környezetéből olvasták, az ügynök-munkamenetekben pedig nem
volt benne, tehát a `.env`-be írt `on` csak a vezérlőpultot állította volna át. Egy kapcsoló, amit kézzel kell minden folyamatba
eljuttatni, az üzemeltetési követelmény ellen van. **Bróker-hiba esetén nincs csendes visszaesés a tokenfájlra:** az ok (a bróker
stderr-je) a hibaüzenetben áll, és a művelet megáll. **A marveen felhasználó nem pushol** (a szerepei: olvas, pr, beolvaszt;
acrobot 32207): a beolvasztás API-n megy, az élő fára cherry-pick kerül, PR-t az API nyit. A régi `KratoBal/marveen` nevet a
vezérlőpult `acroveliq`-re fordítja; a `KratoBal/Acrobot` repóra a bróker nem ad tokent, ott a mérés „nem mérhető”.

## Mi van benne

| Rész | Hol | Mit csinál |
|---|---|---|
| a token-kiadó bróker | `scripts/root/fleet-github.py` (telepítve: `/usr/local/sbin/fleet-github`) | egyetlen ige: `token <owner/repo> <szerep>`; egyórás, egy repóra és a szerep jogaira szűkített telepítési tokent ad. A privát kulcsot csak ez olvassa. Ki mit kérhet: a root-tulajdonú `/etc/fleet-github/app.json` |
| a szerepek | ugyanott | `olvas` (minden csak olvasás), `push` (tartalom írás), `pr` (PR írás), `beolvaszt` (tartalom írás, PR és ellenőrzés olvasás). Workflows, administration, secrets egyikben sincs. **Egyetlen kivétel, a `ci` szerep** (tartalom és workflows írás; 2026-10-19, Balázs a GitHub App-nak megadta a Workflows jogot): **ügynök nem kérheti**. A bróker minden sudo-n át érkező hívót elutasít rá, az `app.json` tartalmától függetlenül; csak maga a root hívhatja, a `root-telepito` napi CI-jóváhagyásának végrehajtása közben (`docs/root-telepito.md`), és a token sosem hagyja el a root folyamatát |
| az őrzött jóváhagyó | `scripts/root/fleet-approve.py` (telepítve: `/usr/local/sbin/fleet-approve`) | `record <owner/repo> <pr> <task_id> <APPROVE\|CHANGES> <fej>`: a hívó (barracuda) verdiktjét egy root tulajdonú, csak hozzáfűzhető fájlba írja (`/var/lib/fleet-approve/verdicts.jsonl`, root 0600), a hívó nevét a SUDO_UID-ból veszi. `approve <owner/repo> <pr> <task_id>`: csak akkor hagy jóvá, ha ebben a fájlban a hívó legutolsó verdiktje erre a PR-ra és feladatra APPROVE, és a PR feje az átnézett fej; a jóváhagyás a fejhez kötött (`commit_id`). A gépi fiók tokenje csak rootnak olvasható |
| a git credential helper | `scripts/git-credential-fleet-github` | az ügynök gitje ezen át kap `push` tokent pontosan arra a repóra |
| a beolvasztó kapcsolója | `scripts/pr-beolvaszt.sh` | alapból (2026-10-16 óta) a token a brókertől jön (`beolvaszt`); `FLEET_GITHUB_APP=off`: a régi út |
| a minta-konfiguráció | `scripts/root/fleet-github-app.example.json` | a hívók és szerepeik, a jóváhagyók |
| a tesztek | `scripts/__tests__/fleet-github.test.py` (CI: `test.yml`) | 53 ellenőrzés, kalibrálva 13 szándékos rontással |

**Amit szándékosan nem tud:** a GitHubon a beolvasztás is tartalom-írás, ezért egy `push` token egy jóváhagyott, zöld PR-t
be tudna olvasztani; a különbség a két szerep közt csak a brókerben és a naplóban van. A `main` és minden telepítést indító
ág védelme a ruleset (üres megkerülő listával), nem ez a bróker. Munkafolyamat-fájlt érintő PR-hoz nincs szerep: annak útja
a lap 3. pontja szerint egy későbbi, emberi jóváhagyáshoz kötött ige, addig Balázs keze.

## A 6. lépés (a tulajdonosi token visszavonása) ELŐFELTÉTELE: minden olvasója a brókeren át

A tulajdonosi tokent ma sokan olvassák (mérve 2026-10-15, a fő ágon és az élő fában). A visszavonás pillanatától mind elhasal,
köztük **a vezérlőpult maga**:

- a vezérlőpult forrása: `src/web/routes/task-handoffs.ts`, `src/web/routes/task-usage.ts`, `src/gpt-package.ts`;
- flotta-szkriptek: `pr-allapot.sh`, `pr-allas.sh`, `pr-body-mirror.sh`, `github-pr-monitor.sh`, `ci-naplo.sh`, `ci-el-or.sh`,
  `mar-megvan.sh`, `eles-lemaradas.sh`, `review-csomag.sh`, `beolvadt-esemeny.py`, `git-auth.sh`, `hasonlo-kulcs-orzo.sh`,
  `fleet-secrets.py` (a fájl jogát nézi, ÉS a lejárati fejléchez olvassa is: lásd lent, a harmadik kivétel);
- ügynökök saját szkriptjei (például murena `pr-body.sh`, `push-ha-nyitva.sh`, `pr-base.sh`, `ci-allapot.sh`; barracuda
  `hasonlo-kulcs-orzo.sh`; a PR-nyitók).

Ezek átállása **külön PR-ok**, ebben a sorrendben: (1) egy közös `token <repo> <szerep>` hívás a flotta-szkriptekbe, az
olvasóknak `olvas` szereppel; (2) a vezérlőpult három helye; (3) az ügynökök saját szkriptjei, gazdánként. Amíg ez nincs kész,
a 6. lépés nem indulhat; a lap visszaállítása addig a régi út.

**Az (1) állapota:** a flotta-szkriptek a `scripts/lib/github-token.sh` (és a Pythonban a `scripts/lib/github_token.py`)
`github_token <owner/repo> <szerep>` hívásán át olvasnak: a kapcsolóval a bróker egyórás, egy repóra szóló tokenje, nélküle
a régi fájl. Ahol egy szkript több repót kérdez (`mar-megvan.sh`, `hasonlo-kulcs-orzo.sh`), repónként kér. A
`git-auth.sh` a kapcsolóval olvasásnál (fetch, pull, ls-remote, clone) a bróker `olvas` tokenjét teszi fejlécbe, pontosan a
remote repójára, és csak a `https://github.com/` felé (a 10. lépés lelete, 2026-10-16: enélkül a marveen felhasználó
fetch-e névtelen volt, és a git a helpert csak 401-re kérdezi). Ha a bróker nem ad tokent, megáll, nem fetch-el névtelenül.
Minden más (push) sima `git`, a tokent a credential helper adja. A `scripts/__tests__/github-token.test.py`
egy őrrel méri, hogy ezen kívül egyetlen szkript sem olvassa közvetlenül a tulajdonosi tokent. Az őr a fájl NEVÉRE illeszt
(`.github-token`, utána nem kötőjel és nem betű), nem a szó szerinti `store/.github-token` útra: az utóbbi 2026-10-15-ig
átengedte a `fleet-secrets.py`-t, ami `os.path.join(STORE, ".github-token")` alakban nyitja meg. Szándékos kivételek:
- a `ci-el-or.sh` 2026-10-16 óta (#231 után, b25-e3) NEM kivétel: az Actions-ellenőrzés tokenjét repónként a brókertől kéri
  (`lib/github_token.py`), a bróker elutasítása RIASZT a bróker saját okával, a bróker tokenjére jövő 401 RIASZT (az App
  telepítése vagy kulcsa). A tulajdonosi token lejáratát csak `FLEET_GITHUB_APP=off` mellett figyeli: a bróker tokenje egy
  óráig él, az nem riasztás. Enélkül a visszavonás után minden ütemezett futás riasztott volna;
- a `github-pr-monitor.sh` csak `FLEET_GITHUB_APP=off` mellett olvas egy **vault-másolatot** (`github-github_token`): a
  visszavonás után halott titok, törlendő. Alapból a bróker tokenjével fut, és ha az nem ad tokent, MEGÁLL (kilépés 1), nem
  fut névtelenül tovább (barracuda #231 review, acrobot 32218);
- a `fleet-secrets.py` a titok-leltárban a tulajdonosi token lejáratát kérdezi le a GitHubtól (`github_expiry`), és csak a
  `store`-ban létező fájlokat listázza: a visszavonás és a 401-mérés után a fájl törlésével kiesik, nem riaszt.

**A (3) állapota (mérve 2026-10-15, nautilus):** az ügynökök saját szkriptjei NINCSENEK gitben (`agents/*/scripts`), tehát
ez a lépés nem PR, hanem gazdánkénti helyi átírás. nautilus hat GitHub-olvasó szkriptje (mérve) és murena tíz szkriptje (murena közlése, 31634) egy
`gh_token <repo> <szerep>` burkolón át a `github_token`-t hívja; a nautilus `token-jogkor` a tulajdonosi token jogkörét
méri, a tokennel együtt megy nyugdíjba. barracuda egyetlen találata (`hasonlo-kulcs-orzo.sh`) barracuda
mérése szerint (31626) egy régi, halott másolat, a profilja a fájlt nem is olvashatja.

**A 6. lépés keresési listája (mérve 2026-10-15, fájlnevek, érték nélkül).** A visszavonás előtt mindegyik sort
ellenőrizni kell; ami nem került a brókerre, az a 401-gyel csendben eltörik:

- **A klónok repó-szintű credential helperei** (a 9. lépés tárgya; amíg az App nincs meg, NEM törölhetők, mert ma ezeken
  megy a push): `agents/nautilus/{acropora-os,ai-agent,marveen-repo,marveen-work}`, `agents/murena/{acropora-os,
  acropora-commerce}` a tulajdonosi fájlt adják; az `agents/nautilus/commerce-work` a `.github-token-commerce`-t. A
  `/home/marveen/work/*` klónok és a `marveen` globális git-konfigja: egyik sem ad credential helpert (acrobot mérése a
  `marveen` felhasználóval, 31698).
  Tokenes klón-cím (userinfo a `github.com` előtt) a 14 olvasható klónban nincs (egy klón konfigja nem olvasható).
- **A második token, a `.github-token-commerce`**: két olvasója van (a fenti klón és a `fleet-secrets.py` leltára).
  Ugyanazt az utat járja, mint a tulajdonosi token: a 9. lépésben vált át, külön döntés nem kell hozzá (acrobot 31690).
- **Skillek, amelyek a fájl olvasását írják elő** (szöveg, nem kód; a token visszavonása után rossz utat tanítanak): a
  globális `agens-agabol-pull-request`, `ios-testflight-bekotes`, `agent-report-review`, `agens-jogosultsag-megadasa`,
  `deploy-ellenorzo-lista`, és a projekt-szintű `council-dontes-rogzitese`. Az átírásuk a 9. lépés része, a
  `FLEET_GITHUB_APP` bekapcsolásakor; előtte nem, mert addig a fájl az élő forrás, és egy brókerre tanító skill rossz utat
  mutatna (acrobot 31690).
- **Hookok:** a `/home/marveen/.claude/hooks` és a `/home/marveen/.claude/settings.json` nem nevezi meg a tokent.
- **A `marveen` felhasználóval mérve (acrobot, 31690):** az ütemezett feladatok közül egy nevezi meg a tokent
  (`pr-993-figyeles`), az KIKAPCSOLT (`enabled: false`), és törlésre jelölt, nem átírandó; a projekt
  `.claude/settings*.json` fájljai: 0 találat; a `store/tokens` alatt nincs git vagy gh nevű token; a hookok: 0 találat.
- **Nem mérve, szándékosan:** a `.env` fájlok (általános kiolvasásuk tilos); a vault-másolatot (`github-github_token`) a
  fenti második kivétel nevezi meg.


**A (2) állapota:** a vezérlőpult két GitHub-olvasása (az átadó rekord kód-állapot ellenőrzése, `task-handoff.ts`, és a
`done` őr beolvadás-ellenőrzése, `task-usage.ts`) a `src/github-token.ts` `githubToken(repo, szerep)` hívásán át olvas,
`olvas` szereppel, repónként; a bróker tokenjét 45 percig tartja (a token egy óráig él). Token nélkül mindkét ellenőrzés
„nem mérhető", soha nem egyezés. A kapcsoló ugyanaz a `FLEET_GITHUB_APP`, a folyamat környezetéből vagy a `.env`-ből, és
a vezérlőpult **induláskor** olvassa: a bekapcsolás után `supervisorctl restart dashboard` kell. A brókert a vezérlőpult
felhasználója hívja `sudo -n`-nel, tehát a 8. lépés sudo sorai közül annak a felhasználónak a sora kell; a 10. lépés
mérése erre is kiterjed (egy átadó rekord `?verify=1` olvasása után a bróker naplójában `olvas` sor). A harmadik hely, a
`gpt-package.ts`, nem olvasó: a tulajdonosi token ÉRTÉKÉT tartja távol a GPT-csomagoktól, és ha a fájl nincs meg, nincs mit
összevetni; a bróker tokenjeit a `ghs_` alakra illeszkedő titok-minta fogja meg. A `src/__tests__/github-token.test.ts`
őre méri, hogy a vezérlőpult forrásában ezen a kettőn kívül senki nem nevezi meg a fájlt.

## Balázs lépései, sorrendben

A parancsok a gazdagépről, a konténeren kívülről futnak (`cd` és `docker compose exec`).

1. **Az App létrehozása** a GitHub fiókod alatt (Settings, Developer settings, GitHub Apps): név, webhook kikapcsolva,
   „Only on this account”. Jogok (Repository permissions): Contents: Read and write; Pull requests: Read and write; Checks:
   Read; Commit statuses: Read; Actions: Read; Metadata: Read. Más jog ne legyen.
2. **Telepítés** a négy repóra („Only select repositories”): `acroveliq`, `acropora-os`, `acropora-commerce`,
   `acropora-ai-agent`. Az App azonosítója (App ID) az App oldalán, a telepítés azonosítója (installation id) a telepítés
   oldalának címében áll: mindkettő kell az `app.json`-ba.
3. **A privát kulcs** előállítása (letöltődik a gépedre), és átadása root tulajdonba:

   ```bash
   cd /opt/marveen-docker
   docker compose exec -u root marveen install -d -m 700 -o root -g root /etc/fleet-github
   docker compose cp ./app-key.pem marveen:/etc/fleet-github/app-key.pem
   docker compose exec -u root marveen sh -c 'chown root:root /etc/fleet-github/app-key.pem && chmod 600 /etc/fleet-github/app-key.pem'
   ```
   Utána a letöltött fájl törlése a saját gépedről.
4. **A gépi fiók** (barracuda jóváhagyója): új GitHub-fiók, 2FA, meghívás közreműködőnek CSAK a négy repóra (írási joggal,
   különben a jóváhagyása nem számít). A tokenje: mivel közreműködőként más személyes repójára fine-grained token nem adható
   ki [K, a lap 6. pontja; mérendő], klasszikus token `repo` hatókörrel, és ezért fontos, hogy a fiók csak ezen a négy repón
   legyen közreműködő. Átadás: `/etc/fleet-github/approver-token`, root 0600 (mint a 3. lépés, a fájlnévvel).
5. **(Nincs teendő.)** A jóváhagyó a verdikteket a saját root rekordjából olvassa (a `review-ellenoriz.sh` írja bele a
   `record` igével, lásd lent az E3 (a) pontot), token nélkül: nincs titok, amit át kellene adni vagy forgatni. A
   vezérlőpult adatbázisát nem olvassa.
6. **A konfiguráció:** a `scripts/root/fleet-github-app.example.json` alapján `/etc/fleet-github/app.json`, a két
   azonosítóval, root 0644.
7. **A két root szkript telepítése** a fő ágról, és összevetés a fő ággal:

   ```bash
   cd /opt/marveen-docker
   docker compose exec -u root marveen install -o root -g root -m 0755 /home/marveen/marveen/scripts/root/fleet-github.py /usr/local/sbin/fleet-github
   docker compose exec -u root marveen install -o root -g root -m 0755 /home/marveen/marveen/scripts/root/fleet-approve.py /usr/local/sbin/fleet-approve
   docker compose exec -u root marveen sha256sum /usr/local/sbin/fleet-github /usr/local/sbin/fleet-approve
   ```
8. **A sudo sorok** (`/etc/sudoers.d/fleet-github`, root 0440, utána `visudo -c`):

   ```
   marveen ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token *
   agent-nautilus ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token *
   agent-murena ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token *
   agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-approve approve *
   agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-approve record *
   agent-barracuda ALL=(root) NOPASSWD: /usr/local/sbin/fleet-github token KratoBal/caparium-napplo olvas
   ```

   Az utolsó sor (2026-10-19, Balázs, Eldöntendő msg 1561692771733999658): a privát ügyfél-repón a reviewer saját
   fej-diffje (`scripts/lib/review-fej-diff.py`) csak olvasó, egyórás tokennel. Hozzá az `app.json` `callers`
   részébe: `"agent-barracuda": {"caparium-napplo": ["olvas"]}`.
9. **Az ügynökök gitje** (ügynökönként, a saját felhasználójával). A git a következő helperre lép, ha egy nem ad
   jelszót, tehát egy megmaradt régi helper (rendszer-, globális vagy repó-szinten; a mai klónokban repó-szinten áll, és a
   tulajdonosi tokent adja) csendben a régi tokennel pusholna, és a 10. lépés mérése zöld maradna (barracuda, #200).
   Ezért: előbb egy üres sor, ami a listát nullázza, utána a mi helperünk, és minden klónban a repó-szintű régi helper
   törlése:

   ```bash
   cd /opt/marveen-docker
   docker compose exec -u agent-nautilus marveen git config --global --unset-all credential.helper
   docker compose exec -u agent-nautilus marveen git config --global --add credential.helper ''
   docker compose exec -u agent-nautilus marveen git config --global --add credential.helper /home/marveen/marveen/scripts/git-credential-fleet-github
   docker compose exec -u agent-nautilus marveen git config --global credential.useHttpPath true
   # minden klónban, amit az ügynök használ (példa egy klónra):
   docker compose exec -u agent-nautilus marveen git -C /home/marveen/marveen/agents/nautilus/marveen-repo config --local --unset-all credential.helper
   # az ellenőrzés: pontosan két sor, az üres és a mienk, más forrásból semmi
   docker compose exec -u agent-nautilus marveen git -C /home/marveen/marveen/agents/nautilus/marveen-repo config --show-origin --get-all credential.helper
   ```
10. **A mért új út** egy próba-PR-on, mindegyik külön (a lap 5. lépése): push; PR nyitása; beolvasztás jóváhagyással;
    elutasított beolvasztás jóváhagyás nélkül; egy App-jóváhagyás kísérlete (nem számíthat); a workflow-PR útja; a
    visszaállító kapcsoló. **A bizonyíték minden lépésnél a bróker naplósora** (`/var/log/fleet-github.log`: `result ok`,
    a token lenyomata, időben a művelethez illesztve), és a jóváhagyásnál a `/var/log/fleet-approve.log` sora, nem a
    művelet sikere: egy régi tokennel lefutott push ugyanúgy sikeres. **A jóváhagyó rootként futó ágát is itt kell
    mérni** (a tesztek nem rootként futnak): egy próba-verdikt után a `/var/lib/fleet-approve` root 0700, a
    `verdicts.jsonl` root 0600, és az utolsó sora a próba verdiktje; a `fleet-approve.log`-ban egy `recorded` és egy
    `approved` sor.
11. Utána a lap 6. lépése (a tulajdonosi token kivezetése a fenti előfeltétellel, a 401 méréssel) és 7. lépése (a rulesetek:
    jóváhagyás 1, a legutóbbi push jóváhagyása, a régi jóváhagyások elvetése).

## A 7. lépés (a kötelező jóváhagyás) előfeltételei, a jóváhagyó oldaláról (barracuda, #200)

- **A verdikt csak a reviewer saját tokenjével írható** (ez a PR: `src/web/routes/task-usage.ts`). A telepítése ELŐTT
  bárki, akinél a közös token van, írhatna verdiktet barracuda nevében. Telepítés előtt mérendő, hogy barracuda
  `review-ellenoriz.sh`-ja a saját ügynök-tokenjével ír (a `scripts/lib/dashboard-token.sh` közös tokenre esésnél egy
  „using the shared token” sort ír a stderr-re); ha nem, a verdiktjei 403-at kapnának.
- **A verdikt a teljes, 40 karakteres fejet hordozza** (ez a PR: `review-ellenoriz.sh` nem rövidít), és a jóváhagyó csak
  ilyet fogad el; a régi, 7 karakteres verdiktekre nem hagy jóvá.
- **A verdikt root tulajdonú helyre is (ELDÖNTVE, acrobot 31484; a lépéslista E3 (a), feladat `b25-e3`: KÉSZ a kódban,
  telepítésre vár).** A jóváhagyó eddig a `task_events` táblának hitt, a `store/claudeclaw.db` viszont 0600 marveen:
  minden marveen-ként futó folyamat, a főágens és a vezérlőpult is, közvetlenül beírhatott egy verdikt-sort barracuda
  nevében, a route-ot megkerülve (barracuda, #202). Most a `review-ellenoriz.sh` az idővonal verdiktje után
  `sudo -n fleet-approve record`-dal a root rekordba is ír (a szereplő a SUDO_UID, nem argumentum), és az `approve` csak
  onnan olvas. Ahol a jóváhagyó nincs telepítve (CI), vagy a sudo még nem engedi a `record` igét (az élő fa frissítése a
  bootstrap nélkül nem írja be az új sort), ezt kiírja és kihagyja: az `approve` ilyenkor elutasít. Ahol a `record`
  engedélyezett, a nem 40 jegyű fej és a sikertelen rekord kilépés 1. **Amit nem old meg:** a rekord annyit ér, amennyit az agent-barracuda identitás (ma a
  router `sudo tmux` sora barracuda paneljeibe, amit a B48 vált ki); és a rekord a konténer fájlrendszerében él, tehát egy
  újrateremtés kiüríti: utána minden jóváhagyás „no recorded verdict” alakban elutasít, amíg barracuda újra nem rögzít.
  Zárva marad, nem nyitva. **A telepítése jogosultság-változás:** barracuda új sudo-sort kap (`fleet-approve record *`),
  amit a bootstrap 4a lépése magától ír, amint az élő fa ezt a változatot hordozza.
- **A GitHub-review és a beolvasztó kapuja (feladat `b25-gepi-review`, barracuda (b) útja).** A `review-ellenoriz.sh` egy
  APPROVE-nál a root rekord UTÁN a `sudo -n fleet-approve approve`-ot is futtatja (sudo-sor és profil nem változik:
  ugyanaz a sor, mint a `record`-é, a szkript hívja, nem barracuda). Ha az elbukik, az idővonal és a root rekord marad,
  a szkript 1-gyel lép ki, és megmondja, hogy a GitHub-review hiányzik és miért. A 13-as (a GitHub nem válaszolt) után
  a kiírt újrapróba-sor a szkript **csak-GitHub alakja**, nem a sudo-sor (azt a reviewer profilja megtagadja):
  `review-ellenoriz.sh --csak-github-review <csomag> <task_id>`; ez a verdikt eseményt nem írja újra, és csak akkor fut,
  ha az idővonalon a hívó LEGUTOBBI ítélete erre a PR-ra pontosan ez az APPROVE ugyanerre a fejre (a root rekordot,
  amit csak a jóváhagyó olvas, a jóváhagyó maga ellenőrzi: kilépés 10, ha nincs rá rögzített APPROVE, vagy a PR feje
  elmozdult). A `pr-beolvaszt.sh` a PUT előtt a `gepi-review-ellenor.py`-nal megkérdezi a GitHubot, van-e a fejen
  APPROVED review **a jóváhagyók listájáról** (egy idegen login APPROVED-je nem elég, pedig a ruleset minden írási jogú felhasználóét számolná). Egy
  lista van: `scripts/gepi-review.json` (`owner`, `repos` a `fleet-approve` konfigjának alakjával, és `reviewers`, a gépi
  fiók GitHub-loginja). **Az élő konfig (`/etc/fleet-github/app.json`) root-mappában áll, agens és CI nem olvassa**, ezért
  két ellenőrzés van: a teszt a konfig repo-beli mintájához (`scripts/root/fleet-github-app.example.json`) vet, és a
  telepítő lépés egy mondat, rootként: `python3 scripts/gepi-review-ellenor.py --osszevet /etc/fleet-github/app.json`
  (0: egyezik; 1: eltér, megnevezi mindkét oldal többletét). **A `reviewers` ma ÜRES:** a gépi fiók loginja nincs a
  repóban; amíg üres, a kapu „nem ellenőrizhető”-t mond és kiírja, kik tettek APPROVED-et, az első valós mérés ebből
  tölti ki. A beolvasztó módja egy sor (`GEPI_REVIEW_KENYSZERIT=0`, napló mód); a ruleset bekapcsolásával egy lépésben 1.
- **A `fleet-approve` kilépési kódjai a GitHub-review-nál (feladat `flotta-or-es-infra-javitas`, barracuda első valós mérése, 2026-10-19 18:34).** A 13 egy `failed` (időtúllépés, 5xx, rate limit: újrapróbálható). **A 14: a GitHub magát a jóváhagyó TOKENJÉT utasította el** (HTTP 401, vagy 403, ami nem rate limit, például „Resource not accessible by personal access token”): a tokennek nincs meg a Pull requests: write joga a repón, és újrapróba nem segít. A `review-ellenoriz.sh` ilyenkor NEM ír újrapróba-sort, hanem azt, hogy Balázs lépése kell (a gépi fiók tokenjén a Pull requests: write jog a flotta repóin; klasszikus token `repo` hatókörrel); a javítás után a `--csak-github-review` alak ugyanarra a csomagra újra futtatható. **A telepítése root-lépés:** a `fleet-approve.py` változott, tehát a bootstrap rögzített lenyomata is (ugyanebben a PR-ban), és az élő `/usr/local/sbin/fleet-approve` addig a régi, a 13-as kóddal; telepítés: lásd a 7. lépés `install` sorát, vagy a konténer-újrateremtés 4a lépését.
- **A csomag és a fej kötése: ELDÖNTVE (acrobot, 31441): (b), a review-csomag diffjét a reviewer eszköze állítja elő a teljes fejből; amíg ez nincs bent, a 7. lépés vár.** A jóváhagyó azt a fejet hagyja jóvá, amit a csomag README-je
  megnevez, a README-t viszont a fejlesztő írja, barracuda pedig a `diff.patch`-et olvassa. Egy fej, amiben több áll, mint a
  diffben, ma átmenne. A választott alak a (b): a reviewer nem a fejlesztő állítását olvassa, hanem a fejből előállított diffet.
  **Az eszköz (a lépéslista E3 (b), feladat `b25-e3`):** `review-olvas.sh --fej <csomag>`.
  - Kiolvassa a csomag legutolsó, 40 jegyű fejét és a PR-t (a csomag nevéből).
  - A GitHubtól névtelenül megkérdezi, hogy a PR mai feje még ez-e. A flotta négy repója nyilvános, token nincs.
  - A diffet a GitHub compare-jéből veszi, PONTOSAN annak a fejnek a sha-jára (`<alap>...<fej>`).
  - A diffet a reviewer saját `~/.review-fej/` mappájába írja (0700/0600), és fájlonként, SORRÓL SORRA összeveti a
    csomag legutolsó patch-ével: a változott sorokat a FEJ-fájlbeli sorszámukkal együtt (a @@ +c értékéből; egy másik
    helyre tett, egyébként azonos sor eltérés), és a mód-sorokat, nem csak a számokat (barracuda, #229 review v1, v2). A
    bináris fájl szövegként nem vethető össze, ezért eltérésnek számít.
  - Eltérésnél (a fejben több vagy más áll, vagy push jött a csomagolás után) kilépés 1, és megnevezi a fájlokat.
  - **A kötés:** teljes egyezésnél, és csak akkor, egy `<...>.egyezik` jelölő is keletkezik; minden futás először
    törli a régit. A `review-ellenoriz.sh` egy APPROVE-ot csak akkor ír a root rekordba, ha ez a jelölő PONTOSAN az
    átnézett fejre megvan (a hívó sajátja, nem symlink). Ha hiányzik, kilépés 1, és az idővonal verdiktje áll; eltérésnél
    a fejlesztőtől új csomag kell. A CHANGES-hez nem kell, az csak lezár.

## Konténer-újrateremtés után (fleet-bootstrap.sh 4a)

A `docker compose up -d` a képből teremti újra a konténert: a `/usr/local/sbin` és a `/etc/sudoers.d` gyári állapotba
áll. Ezért a `scripts/fleet-bootstrap.sh` 4a lépése (a boot útján, a `run-dashboard.sh` előtt fut) visszaállítja a 7. és a
8. lépés eredményét, ember nélkül:

- **csak ahol a D4 telepítve van**, vagyis a `/etc/fleet-github` áll (a hostról, csak olvasható bind mounttal); enélkül
  semmit nem telepít, mert egy magától megjelenő sudo-sor jogosultság-változás volna;
- a két szkriptet a `scripts/root/` alól, **egy másolatot hash-el és telepít** (nem a fájlt név szerint), és csak ha a
  lenyomata a bootstrapba rögzített érték; eltérésnél és symlinknél nem telepít, hanem a 7. lépésben hibát jelez;
- a sudo-sort a bootstrap maga építi (a 8. lépés öt sora), `visudo -c -f` után, és csak ha a meglévőtől eltér;
- **soha nem áll meg**: utána jön a teljes NOPASSWD sor törlése (4b), aminek mindig le kell futnia.

A kulcs, a jóváhagyó tokenje és az `app.json` nem a bootstrapé: a hosti könyvtárból a mounttal jönnek. **Ha a
`fleet-github.py` vagy a `fleet-approve.py` változik, ugyanabban a PR-ban a bootstrap rögzített lenyomata is**: a
`scripts/__tests__/fleet-bootstrap-d4.test.py` addig piros. A rögzítés nem a router ellen véd (a boot útján az amúgy is
root-egyenértékű a NOPASSWD sorral), hanem az ellen, hogy egy át nem nézett vagy félig frissített fa root-kód legyen.

## Visszaállítás

- **A 6. lépés előtt:** a `FLEET_GITHUB_APP=off` a régi utat adja (az alapérték 2026-10-16 óta a bróker); a sudo sorok és a két
  telepített szkript maradhat, kényszer nélkül senki nem hívja; az ügynökök `credential.helper` beállítása visszaírható a
  régire (`git config --global --unset credential.helper`, utána a régi helper).
- **A 6. lépés után:** új fine-grained token Balázstól, és a rulesetek jóváhagyás-száma vissza 0-ra, a böngészőből (a
  flottának ekkor nincs adminisztrációs joga).
- **Vészhelyzetben:** az App telepítésének eltávolítása azonnal megállít minden flotta-írást a GitHubon.
- **Kulcs-kompromittálódásnál:** új kulcs előállítása, utána a régi törlése; a kiadott tokenek egy órán belül lejárnak.

## The `root` caller (CI changes, PR B of `ci-modositas-jovahagyassal`)

`root-telepito` (root, not through sudo) asks this broker for two roles during a CI change: `olvas`, to read the PR and the
workflow file when a change is requested and again right before it is written, and `ci`, at the moment of the write only.
`ci` needs no `app.json` entry (it is code: root only, no `SUDO_*`). `olvas` does: add a caller `root` with `olvas` on the
repositories of `ci.json` (`docs/root-telepito.md`, "CI changes", owner's step 2). Nothing else changes for other callers.
