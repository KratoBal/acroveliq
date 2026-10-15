# Figma ↔ kód térkép (AcrovelIQ)

Ez a dokumentum az AcrovelIQ vezérlőpult és projektirányítópult Figma-terveit köti a tényleges implementációhoz.

- **Figma = vizuális / UX source of truth**
- **GitHub = implementációs source of truth**
- Figma file: [AcrovelIQ — Vezérlőpult V1 · UI koncepció](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O)
- Acropora OS counterpart: [KratoBal/acropora-os · docs/FIGMA-MAP.md](https://github.com/KratoBal/acropora-os/blob/main/docs/FIGMA-MAP.md) (ugyanez az alak)
- A Figma-tokent a fejlesztő ágensek nem olvassák: az exportot (PNG, `nodes.json`, szöveg-kivonat) acrobot készíti az `exchange/acroveliq/figma-vezerlopult-v<n>/` alá.

## Útvonal-alapok

| App               | Route base                                                        | Component base |
| ----------------- | ----------------------------------------------------------------- | -------------- |
| `web` (AcrovelIQ) | `web/index.html`, az `acroveliqPage` oldal nézetei (`data-aq-view`) | `web/app.js`   |

Jelölések:

- `acroveliq/<nézet>`: az AcrovelIQ oldal egy nézete; a `<nézet>` a `web/index.html` egy `data-aq-view` értéke. Az adatlapok (ügynök, feladat) a nézetükön belül nyílnak, külön útvonaluk nincs.
- Component area: a `web/app.js` megjelenítő függvénye (például `aqRenderTasks`). A validator megnézi, hogy `function <név>(` vagy `async function <név>(` alakban létezik-e.
- `nincs`: a design vagy az implementáció még nem létezik; ne találjunk ki hozzá útvonalat.
- `—`: nincs külön stabil route- vagy component-area mapping.
- Több hivatkozás egy cellában `<br>` jellel van elválasztva; a validator mindet külön ellenőrzi.

## Karbantartási szabály

Ha egy PR egy itt feltérképezett UI-területet módosít, ugyanabban a PR-ben frissítse az érintett sor **Utoljára egyeztetve** mezőjét dátummal és azzal a commit SHA-val, amely ellen a Figma ↔ kód megfelelést ellenőrizték. Új képernyő = új sor; egy megvalósított `nincs` sor ugyanabban a PR-ben kapja meg az útvonalát és a függvényét.

Szándékos design-eltérést a **Megjegyzés** mezőben kell dokumentálni. Kézzel karbantartott `implemented / partial / approved` státuszokat nem használunk.

A validator: a repó gyökeréből `node scripts/figma-map-check.mjs` (a CI-ben is fut).

## AcrovelIQ vezérlőpult (a meglévő nyolc)

A Figma-terv és a megvalósítás összevetése: `exchange/acroveliq/1-figma-kontra-megvalositas-2026-10-15.md` (murena). A fő eltérés nem a kinézet, hanem az adat: a Figma mintaadattal rajzolt, a megvalósítás csak mért adatot mutat, és ahol nincs, ezt mondja.

| Figma Page / Section                 | Node                                                                         | App   | Route pattern         | Component area                        | Utoljára egyeztetve   | Megjegyzés                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------- | ----- | --------------------- | ------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vezérlőpult · Áttekintés             | [2:2](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=2-2)       | `web` | `acroveliq/overview`  | `aqRenderOverview`                    | 2026-10-15 · 5349de5  | A navigáció a megvalósításban felső fülsor (Áttekintés, Ágensek, Feladatok, Elakadások, Döntéseim), a Figmában bal oldali menü hét ponttal. A „Heti kvóta” és a „Döntést igényel” kártya nincs az áttekintőn.                     |
| AI-csapat                            | [5:2](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=5-2)       | `web` | `acroveliq/agents`    | `aqRenderAgents`                      | 2026-10-15 · 5349de5  | Szerepkör-adat nincs; a megvalósítás az élő panel-állapotot mutatja.                                                                                                                                                          |
| Ügynökadatlap                        | [5:112](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=5-112)   | `web` | `acroveliq/agents`    | `aqRenderAgentDetail`                 | 2026-10-15 · 5349de5  | Az Ágensek nézeten belül nyílik.                                                                                                                                                                                              |
| Feladatkezelés                       | [7:2](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=7-2)       | `web` | `acroveliq/tasks`     | `aqRenderTasks`                       | 2026-10-15 · 5349de5  | A Task Core feladatai; az „Új feladat” űrlap és a feladatkezelő gombok Balázs két döntése (2026-10-14) óta írnak.                                                                                                             |
| Jóváhagyási központ (Döntéseim)      | [7:118](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=7-118)   | `web` | `acroveliq/decisions` | `aqRenderDecisions`                   | 2026-10-15 · 5349de5  | Másképp: élő döntési sorok, három gombbal (Jóváhagyom, Elutasítom, Megbeszélést kérek).                                                                                                                                      |
| Feladat · részletes idővonal         | [9:2](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=9-2)       | `web` | `acroveliq/tasks`     | `aqRenderTaskDetail`                  | 2026-10-15 · 5349de5  | A Feladatok nézeten belül nyílik. Az elakadások külön nézete (`acroveliq/stalls`, `aqRenderStalls`) a Figmában nem szerepel.                                                                                                   |
| Token és teljesítmény · elemzés      | [9:103](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=9-103)   | `web` | nincs                 | nincs                                 | —                     | A Mérések nézet az AcrovelIQ felületen nincs meg.                                                                                                                                                                             |
| UX navigáció és adatbekötési térkép  | [11:2](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=11-2)     | `web` | —                     | —                                     | —                     | Nem képernyő: a navigáció és az adatbekötés térképe.                                                                                                                                                                          |

## Projektirányítópult (12 új képernyő)

Balázs elfogadta 2026-10-15 14:50:14 UTC-kor (Acroveliq szál, message_id 1560303799518629989; szó szerint: `exchange/acroveliq/balazs-figma-elfogadas-atadas-2026-10-15.md`). Követelmények: `exchange/acroveliq/2-projekt-iranyitopult-tervlap-2026-10-15.md` (v5); az F-szám a tervlap 9. szakaszáé, a szelet (S) a 6. szakaszé. A fejlesztési terv és a lefedettség: `agents/murena/exchange/projekt-iranyitopult-atadas-terv-2026-10-15.md`. **Megvalósítás még nincs**: a fejlesztés Balázs szavára indul, a konszolidáció lezárása után. A Figma minden képernyőn „TERVEZET · MINTAADAT” jelölésű: a megvalósítás valódi adatot és üres állapotot mutat.

| Figma Page / Section                       | Node                                                                         | App   | Route pattern | Component area | Utoljára egyeztetve | Megjegyzés                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------- | ----- | ------------- | -------------- | ------------------- | ------------------------------------------------------------- |
| F1 · Projektek                             | [75:2](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-2)     | `web` | nincs         | nincs          | —                   | S1. K-01, K-04, K-25.                                         |
| F2 · Új projekt                            | [75:71](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-71)   | `web` | nincs         | nincs          | —                   | S1 (az anyag-mező S2). K-01, K-02, K-06, K-07, K-40.          |
| F3 · Ügyfelek és ügyféladatlap             | [75:126](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-126) | `web` | nincs         | nincs          | —                   | S7. K-39, K-40, 2a/2, 2a/6.                                   |
| F4 · Összekapcsolás az OS-partnerrel       | [75:188](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-188) | `web` | nincs         | nincs          | —                   | S7 kézi kapcsolással; a jelöltkeresés S9 (D7). 2a/1-8, K-41, K-42. |
| F5 · Projekt · Áttekintés                  | [75:235](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-235) | `web` | nincs         | nincs          | —                   | S1 (váz), S5, S7, S8 töltik. K-26.                            |
| F6 · Projekt · Ügyfél és üzlet             | [75:305](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-305) | `web` | nincs         | nincs          | —                   | S7; az OS-hivatkozások S9. K-43..K-47, K-53.                  |
| F7 · Pénzügyi áttekintés                   | [75:373](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-373) | `web` | nincs         | nincs          | —                   | S8; az OS-ből jelölésű sor S9. K-49..K-52.                    |
| F8 · Projekt · Anyagok                     | [75:445](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-445) | `web` | nincs         | nincs          | —                   | S2 (D1, D2). K-07..K-11, K-19, K-34..K-36.                    |
| F9 · Projekt · Tervezés                    | [75:514](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-514) | `web` | nincs         | nincs          | —                   | S7 (mérföldkövek), S3 (Figma-hivatkozás). K-18, K-46, K-48.   |
| F10 · Projekt · Fejlesztés                 | [75:572](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-572) | `web` | nincs         | nincs          | —                   | S3 (repó), S5 (fogyasztás); a feladatok a Task Core-ból. K-14..K-16, K-27, K-31. |
| F11 · Projekt · Környezetek                | [75:636](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-636) | `web` | nincs         | nincs          | —                   | S4 (D4). K-21..K-23.                                          |
| F12 · Projekt · Átadás                     | [75:699](https://www.figma.com/design/5CDsCHorFoJkC5HLBrz31O?node-id=75-699) | `web` | nincs         | nincs          | —                   | S5 (lezárás), S7 (átadási tételek). K-30, K-48.               |
