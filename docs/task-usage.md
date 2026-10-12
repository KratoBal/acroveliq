# Feladatonkénti tokenmérés

Az acrovelIQ token-brief 1. pontja (2026-10-12). Egy feladat teljes erőforrás-igénye
(input, kimenet, cache-olvasás, cache-írás, hívásszám, időtartam) lekérdezhető. A
bontás: feladat, projekt, ágens, munkamenet, és kapacitás-fajta (munka, ellenőrzés,
javítás, adminisztráció, ismételt munka).

## Az elv: semmit nem írunk a hívásra

A hívás a `token_usage` sora, ahogy a gyűjtő írta. Hogy melyik feladaté, és milyen
kapacitás volt, azt a lekérdezés **az eseményekből vezeti le**. Egy rossz szabály így
később javítható, és minden régi feladat újraszámolódik. Ezért a hívás és a feladat
összerendelése függvény, nem tábla.

## A táblák

- `tasks`: azonosító (a kanban kártya id-je, vagy egy kísérleti változat saját id-je),
  projekt (alapérték `acropora`), típus, szülő feladat, változat, brief-hivatkozás.
- `task_events`: `assigned`, `started`, `review_requested`, `verdict`, `fix_started`,
  `done`, `merged`, szereplővel és idővel (másodperc). A kártya gazdájának saját
  kanban-mozgása is esemény: az `in_progress` indulás, a `done` kész.
- `task_sessions`: egy munkamenet egy feladaté (a V3 eset). Egy munkamenet két
  feladathoz nem kerülhet.

## A hozzárendelés

1. **Munkamenet szerint:** a feladathoz rendelt munkamenet minden hívása a feladaté.
2. **Időablak szerint:** az ágens hívása, ha pontosan EGY feladat ablakába esik.
   - munka: a szereplő `started` vagy `fix_started` eseményétől a saját következő
     `review_requested` eseményéig, vagy a feladat `done` vagy `merged` eseményéig,
     akárki írja (a beolvasztást jellemzően acrobot írja);
   - ellenőrzés: egy `review_requested`-től az azt megválaszoló `verdict`-ig, a
     `verdict` szereplőjére;
   - adminisztráció: a szereplő `assigned` eseményétől a feladat `merged` vagy `done`
     eseményéig.
   Az ablak vége kizáró. A le nem zárt ablak a lekérdezés pillanatáig tart.
3. **Átfedés:** ha egy hívás két feladat ablakába is esik, egyikhez sem rendelődik.
   Nem találgatunk. Az érvénytelenség **kapacitás-fajtánként** jár (acrobot döntése,
   2026-10-12, 28588):
   - **munka:** a fejlesztő egyszerre egy feladaton dolgozik, nála az átfedés valódi
     hiba. A feladat **érvénytelen**, és a lekérdezés megnevezi az átfedő hívásokat.
   - **adminisztráció és ellenőrzés:** az ablakaik rendszeresen átfednek (egyszerre
     kiadott feladatok, sorban álló review-k). Az ilyen hívás **osztatlan** marad,
     egyik feladathoz sem könyvelődik, és a feladat bontása külön sorban mutatja
     („admin: nem rendelhető, N hívás az átfedő ablakban”). A feladat érvényes marad.

A kapacitás-fajta: az ellenőrzés és az adminisztráció az ablakából jön. A munkás
hívása az első `fix_started` után javítás, előtte munka. Ha egy korábbi feladatnak
ugyanaz a briefje, a munka és a javítás ismételt munka. A kísérlet változatai (közös
szülő) szándékosan ugyanazt a briefet kapják: a szülő és a testvér nem teszi ismételtté.

## Az események írásának két szokása

- Az `assigned` szereplője a **kiadó** (acrobot), ne a munkás. A munkás nevén álló
  `assigned` admin-ablakot nyitna nála a sorban álló feladatain, és amíg egy másikon
  dolgozik, az munka-átfedés: a feladata érvénytelen lenne.
- A kísérlet szülője az **eredeti feladat** legyen. Ha a szülő egy külön „próba”
  feladat, és az eredeti ugyanazzal a briefjel korábban rögzítve van, mindhárom
  változat „ismételt munka” lesz (egyformán, tehát az összevetést nem torzítja, csak
  a címkét).

## Használat

```bash
bash scripts/fleet-api.sh task-new <task_id> [projekt] [szulo] [valtozat] [brief]
bash scripts/fleet-api.sh task-event <task_id> <fajta> <szereplo> [ido] [hivatkozas]
bash scripts/fleet-api.sh task-session <task_id> <agens> <session_id>
bash scripts/fleet-api.sh task-usage <task_id> [variants]
```

Az idő másodperc vagy ISO (`2026-10-12T07:03:00Z`); hiányában a mostani. A
`task-usage` 3-as kóddal lép ki, ha a feladat érvénytelen (átfedő ablak). A
`variants` a feladat gyerekeit (a kísérlet V1/V2/V3 változatait) mellé teszi.

Végpontok: `POST /api/tasks`, `POST /api/tasks/<task>/events`,
`POST /api/tasks/<task>/sessions`, `GET /api/tasks/<task>/usage[?variants=1]`.
