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
   - munka: a szereplő `started` vagy `fix_started` eseményétől a következő
     `review_requested`, `done` vagy `merged` eseményéig;
   - ellenőrzés: egy `review_requested`-től az azt megválaszoló `verdict`-ig, a
     `verdict` szereplőjére;
   - adminisztráció: a szereplő `assigned` eseményétől a feladat `merged` vagy `done`
     eseményéig.
   Az ablak vége kizáró. A le nem zárt ablak a lekérdezés pillanatáig tart.
3. **Átfedés:** ha egy hívás két feladat ablakába is esik, egyikhez sem rendelődik.
   Mindkét feladat **érvénytelen**, és a lekérdezés megnevezi az átfedő hívásokat.
   Nem találgatunk.

A kapacitás-fajta: az ellenőrzés és az adminisztráció az ablakából jön. A munkás
hívása az első `fix_started` után javítás, előtte munka. Ha egy korábbi feladatnak
ugyanaz a briefje, a munka és a javítás ismételt munka.

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
