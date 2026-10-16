# fleet-github: a flotta GitHub-tokenjei egy App-ból, a tulajdonosi token helyett (D4 2. lépcső)

Terv: `agents/nautilus/biztonsag/d4-2-lepcso-github-app-2026-10-15.md` (barracuda APPROVE, v2 + két mondat). Döntés: Balázs,
2026-10-15 12:24 UTC, **A változat** (GitHub App a szerző és a beolvasztó, a kötelező jóváhagyást barracuda adja egy gépi
fiókkal). Feladat: `t-20261015-d4-app-flotta` (acrobot 31402). **Ebben a PR-ban semmi nincs telepítve**, és a kapcsoló
alapból ki van kapcsolva.

## Mi van benne

| Rész | Hol | Mit csinál |
|---|---|---|
| a token-kiadó bróker | `scripts/root/fleet-github.py` (telepítve: `/usr/local/sbin/fleet-github`) | egyetlen ige: `token <owner/repo> <szerep>`; egyórás, egy repóra és a szerep jogaira szűkített telepítési tokent ad. A privát kulcsot csak ez olvassa. Ki mit kérhet: a root-tulajdonú `/etc/fleet-github/app.json` |
| a szerepek | ugyanott | `olvas` (minden csak olvasás), `push` (tartalom írás), `pr` (PR írás), `beolvaszt` (tartalom írás, PR és ellenőrzés olvasás). Workflows, administration, secrets egyikben sincs |
| az őrzött jóváhagyó | `scripts/root/fleet-approve.py` (telepítve: `/usr/local/sbin/fleet-approve`) | `record <owner/repo> <pr> <task_id> <APPROVE\|CHANGES> <fej>`: a hívó (barracuda) verdiktjét egy root tulajdonú, csak hozzáfűzhető fájlba írja (`/var/lib/fleet-approve/verdicts.jsonl`, root 0600), a hívó nevét a SUDO_UID-ból veszi. `approve <owner/repo> <pr> <task_id>`: csak akkor hagy jóvá, ha ebben a fájlban a hívó legutolsó verdiktje erre a PR-ra és feladatra APPROVE, és a PR feje az átnézett fej; a jóváhagyás a fejhez kötött (`commit_id`). A gépi fiók tokenje csak rootnak olvasható |
| a git credential helper | `scripts/git-credential-fleet-github` | az ügynök gitje ezen át kap `push` tokent pontosan arra a repóra |
| a beolvasztó kapcsolója | `scripts/pr-beolvaszt.sh` | `FLEET_GITHUB_APP=on`: a token a brókertől jön (`beolvaszt`); kikapcsolva a régi út |
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
  `fleet-secrets.py` (ez csak a fájl jogát nézi, nem olvassa);
- ügynökök saját szkriptjei (például murena `pr-body.sh`, `push-ha-nyitva.sh`, `pr-base.sh`, `ci-allapot.sh`; barracuda
  `hasonlo-kulcs-orzo.sh`; a PR-nyitók).

Ezek átállása **külön PR-ok**, ebben a sorrendben: (1) egy közös `token <repo> <szerep>` hívás a flotta-szkriptekbe, az
olvasóknak `olvas` szereppel; (2) a vezérlőpult három helye; (3) az ügynökök saját szkriptjei, gazdánként. Amíg ez nincs kész,
a 6. lépés nem indulhat; a lap visszaállítása addig a régi út.

**Az (1) állapota:** a flotta-szkriptek a `scripts/lib/github-token.sh` (és a Pythonban a `scripts/lib/github_token.py`)
`github_token <owner/repo> <szerep>` hívásán át olvasnak: a kapcsolóval a bróker egyórás, egy repóra szóló tokenje, nélküle
a régi fájl. Ahol egy szkript több repót kérdez (`mar-megvan.sh`, `hasonlo-kulcs-orzo.sh`), repónként kér. A
`git-auth.sh` a kapcsolóval sima `git`-et futtat, a tokent a credential helper adja. A `scripts/__tests__/github-token.test.py`
egy őrrel méri, hogy ezen kívül egyetlen szkript sem olvassa közvetlenül a tulajdonosi tokent. Két szándékos kivétel:
- a `ci-el-or.sh` a tulajdonosi token lejáratát figyeli: a tokennel együtt nyugdíjba megy (a 6. lépés után a bróker naplója
  és az App kulcsa a figyelendő);
- a `github-pr-monitor.sh` kapcsoló nélkül egy **vault-másolatot** is olvas (`github-github_token`): ez is a 6. lépés
  keresési listájára tartozik, a fájl, a git hitelesítő tárolók és a klónok címei mellé.

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
   ```
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
- **A csomag és a fej kötése: ELDÖNTVE (acrobot, 31441): (b), a review-csomag diffjét a reviewer eszköze állítja elő a teljes fejből; amíg ez nincs bent, a 7. lépés vár.** A jóváhagyó azt a fejet hagyja jóvá, amit a csomag README-je
  megnevez, a README-t viszont a fejlesztő írja, barracuda pedig a `diff.patch`-et olvassa. Egy fej, amiben több áll, mint a
  diffben, ma átmenne. A választott alak a (b): a reviewer nem a fejlesztő állítását olvassa, hanem a fejből előállított diffet.
  **Az eszköz (a lépéslista E3 (b), feladat `b25-e3`):** `review-olvas.sh --fej <csomag>`.
  - Kiolvassa a csomag legutolsó, 40 jegyű fejét és a PR-t (a csomag nevéből).
  - A GitHubtól névtelenül megkérdezi, hogy a PR mai feje még ez-e. A flotta négy repója nyilvános, token nincs.
  - A diffet a GitHub compare-jéből veszi, PONTOSAN annak a fejnek a sha-jára (`<alap>...<fej>`).
  - A diffet a reviewer saját `~/.review-fej/` mappájába írja (0700/0600), és fájlonként összeveti a csomag
    legutolsó patch-ével.
  - Eltérésnél (a fejben több vagy más áll, vagy push jött a csomagolás után) kilépés 1, és megnevezi a fájlokat.
  - **A kötés:** a `review-ellenoriz.sh` egy APPROVE-ot csak akkor ír a root rekordba, ha ez a fájl PONTOSAN az átnézett
    fejre megvan (a hívó sajátja, nem symlink). Ha hiányzik, kilépés 1, és az idővonal verdiktje áll. A CHANGES-hez
    nem kell, az csak lezár.

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

- **A 6. lépés előtt:** a `FLEET_GITHUB_APP` kapcsoló kikapcsolva (az alapérték) a régi utat adja; a sudo sorok és a két
  telepített szkript maradhat, kényszer nélkül senki nem hívja; az ügynökök `credential.helper` beállítása visszaírható a
  régire (`git config --global --unset credential.helper`, utána a régi helper).
- **A 6. lépés után:** új fine-grained token Balázstól, és a rulesetek jóváhagyás-száma vissza 0-ra, a böngészőből (a
  flottának ekkor nincs adminisztrációs joga).
- **Vészhelyzetben:** az App telepítésének eltávolítása azonnal megállít minden flotta-írást a GitHubon.
- **Kulcs-kompromittálódásnál:** új kulcs előállítása, utána a régi törlése; a kiadott tokenek egy órán belül lejárnak.
