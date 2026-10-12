# futtat: strukturált parancsfuttató

Az acrovelIQ token-brief 2. pontja (2026-10-12). A nagy kimenetű parancsok (teszt, build,
typecheck, diff, nagy keresés) kimenete ne ömöljön a kontextusba, de semmi ne vesszen el.

## Futtatás

```bash
bash /home/marveen/marveen/scripts/futtat.sh run --feladat <kartya-id> -- pnpm test
bash /home/marveen/marveen/scripts/futtat.sh run --projekt acropora --feladat <kartya-id> --fajta typecheck --kontextus 10 -- pnpm typecheck
```

- **A teljes kimenet** a `logs/<projekt>/<feladat>/<időbélyeg>-<fajta>.log` fájlba kerül.
  A titkok és a személyes adatok még az írás előtt maszkolódnak.
- **A kontextusba az összefoglaló jön:**
  - kilépési kód, időtartam, fajta, sorok száma;
  - fajta szerinti kivonat:
    - teszt: a bukott tesztek neve és az első hibájuk, valamint az összesítő sorok;
    - typecheck és build: a hibák helye (`fájl:sor:oszlop TSxxxx üzenet`);
    - diff: fájlonként a `+/-`, és az összesen;
  - **hibánál mindig az első hibasor és az előtte álló N sor** (`--kontextus`, alapból 10);
  - mindig a napló útvonala, a kihagyott sorok száma és a cserék száma.
- **A kilépési kód a futtatott parancsé**, tehát egy `&&` lánc ugyanúgy megáll. Kivétel, ha a parancs el sem
  indult: `2` rossz hívásnál, `3` hiányzó vagy olvashatatlan lenyomat-listánál.
- **A fajta** a parancsból adódik (`test`, `typecheck`, `build`, `diff`, `kereses`, `egyeb`);
  `--fajta`-val felülírható.
- **Az összefoglaló** a napló mellett `.summary.json`-ként is megmarad.

## Célzott visszaolvasás

```bash
bash /home/marveen/marveen/scripts/futtat.sh olvas <naplo> --sorok 120-160
bash /home/marveen/marveen/scripts/futtat.sh keres <naplo> 'not ok' --kontextus 5
```

A keresés a fejlécet (a parancs sorát) kihagyja, a sorszámok a naplóéval egyeznek.

## Titok-szűrés és személyes adat

A szűrés sorrendben három lépés:

1. **Ismert titkok, egyirányú lenyomattal.** A `store/secret-hashes.txt` fájl sha256-okat
   tartalmaz. A futtató a kimenet minden legalább 8 karakteres szavát (és annak `=`, `:`, `@`
   menti darabjait) lenyomatolja, és ami a listán van, azt `[TITOK]`-ra cseréli. Magát a titkot
   a futtató nem tárolja.

   ```bash
   bash /home/marveen/marveen/scripts/futtat.sh lenyomat-hozzaad < titkok.txt   # soronként egy érték, csak a lenyomat íródik
   ```

   Egy meglévő lista csoportja és csoport-bitjei a hozzáadáskor nem változnak, a világ-bitjei
   viszont lekerülnek (egy kézzel 0644-re hagyott lista így 0640 lesz). Egy új lista rögtön a
   végső móddal jön létre: a projekt csoportjával 0640, nélküle 0600.

   **A lista kötelező.** Ha hiányzik vagy nem olvasható, a futtató nem fut csökkentett
   védelemmel: nem futtatja a parancsot, nem ír naplót, és `3`-as kóddal, egyértelmű
   üzenettel áll meg. Egy üres lista lista, azzal fut. Ha egy ágenst most vettek fel a
   `logs-<projekt>` csoportba, a tagság a következő indulásától él, addig a futtató megáll.
   Kikapcsolni csak a `FUTTAT_LENYOMAT_NEM_KOTELEZO=1` környezeti változóval lehet (tesztekhez);
   ilyenkor a kimenet, a napló fejléce és az összefoglaló is kiírja, hogy ki van kapcsolva.

2. **Titok-alakú minták:**
   - GitHub-, Slack-, OpenAI- és Anthropic-tokenek, AWS-kulcs, JWT;
   - privát kulcs blokk;
   - `Bearer` utáni token;
   - a kapcsolati karakterlánc `felhasználó:jelszó` része;
   - `password=`, `secret=`, `token=`, `api_key=` értéke.
3. **Személyes adat:** e-mail, telefonszám, adószám, IBAN.

A csere csak a talált szakaszt érinti, a sor többi része marad: egy maszkolt e-mail egy
tesztnévben nem rontja el a kivonatot. A napló fejlécében a cserék száma áll (`cserek=N`).

## Hozzáférés és megőrzés

- **Csoport:** projektenként külön, `logs-<projekt>` (például `logs-acropora`), **nem a `fleet`**.
  A mappák 2750-es, a fájlok 0640-es jogot kapnak.
- **Ha a csoport nincs meg**, a futtató a tulajdonosra szűkít (0700/0600), és ezt kiírja: így
  szigorúbb lesz, soha nem lazább. **A csoportot telepítéskor létre kell hozni.**
- **Megőrzés:** a naplók 30 nap után törlődnek. Minden futás után takarít a saját projektjében,
  és kézzel is futtatható: `futtat.sh takarit`. Az összefoglalók megmaradnak.
