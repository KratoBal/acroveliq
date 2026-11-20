-- A fajta-mező egyezés megkötése ÚJ ÁGAT kap: WORKSHEET_LINKED és WORKSHEET_UNLINKED (kártya 5b366f5d).
--
-- A `ServiceJobEvent_kind_fields_agree` ZÁRT felsorolás (lásd 20260922150000): minden `kind`, amit egy migráció nem vett fel, a
-- megkötésen elbukik. A két új fajta enum-értéke a 20261119150000 migrációban jött létre; a megkötés ÚJ MIGRÁCIÓBAN bővül, és ez nem
-- stílus: a Postgres egy frissen hozzáadott enum-értéket ugyanabban a tranzakcióban nem használhat (55P04), a megkötés szövege pedig
-- használja. Ugyanaz a csapda, mint 2026-09-21-én (`NOTIFICATION_SENT`) és a `FIELDS_EDITED`-nél: az enum-bővítés egy sor, és semmi
-- nem kényszeríti ki a visszanézést egy MÁSIK migrációban álló felsorolásra. Ezt a CI első futása fogta meg (az integrációs spec
-- hozzákapcsolása a naplósoron bukott), helyben nem lehetett volna: nincs Postgres, a kalibráció dupla ellen ment.
--
-- A MUNKALAP-FAJTÁKNÁL A `worksheetId` NULL LEHET (barracuda, #2753): a `ServiceJobEvent.worksheetId` idegen kulcsa `ON DELETE SET NULL`
-- (20260902170000: ami megtörtént, megtörtént, egy törölt munkalap nem viszi magával a jegy naplóját), a Postgres pedig a CHECK-et a
-- hivatkozási művelet által módosított sorra IS lefuttatja. A korábbi alak (`worksheetId IS NOT NULL` a munkalap-fajtákon) ezért egy
-- munkalap TÖRLÉSÉT buktatta volna, amelyhez naplósor tartozik: a törlés tranzakciója elhasal. Ez a mainen ma is áll a
-- WORKSHEET_DETACHED sorral (egy lapról levett, szám nélküli piszkozat törlése), és ugyanez a javítás zárja. A napló a törlés után is megmarad
-- `worksheetId` nélkül: a sor jegyzete a munkalap számát és tárgyát őrzi (a hivatkozásnál `linkEventNote`).
--
-- AMIT EZ ELENGED, ÉS KIMONDVA: a megkötés a beszúrásnál már nem követeli meg, hogy egy munkalap-esemény munkalapot nevezzen meg, mert
-- egy CHECK nem tudja megkülönböztetni a beszúrást a `SET NULL`-tól. A beszúrás oldalán ezt az alkalmazás tartja (a hivatkozás és a levétel
-- mindig a munkalap azonosítójával ír), és a védőteszt (`service-job-event-kind-check-guard`) a négy munkalap-fajtánál a NULL engedését
-- elvárja, hogy egy visszaszigorítás ne maradjon észrevétlen.
--
-- A hivatkozás naplósora `toStatus IS NULL`: a jegy állapota nem változik tőle.
--
-- CSERE, NEM BŐVÍTÉS (az alkalmazott migrációt nem szerkesztjük): DROP + ADD. A meglévő sorokon nem bukhat el: az új feltétel a régi
-- ágaknál csak ENGEDÉKENYEBB (a munkalap-ágról elmarad a `worksheetId IS NOT NULL`), és egy új fajtapárral bővül (tágítás, nem szűkítés).
ALTER TABLE "ServiceJobEvent"
  DROP CONSTRAINT "ServiceJobEvent_kind_fields_agree";

ALTER TABLE "ServiceJobEvent"
  ADD CONSTRAINT "ServiceJobEvent_kind_fields_agree" CHECK (
    ("kind" = 'STATUS_CHANGE' AND "toStatus" IS NOT NULL AND "worksheetId" IS NULL)
    OR ("kind" IN ('WORKSHEET_ATTACHED', 'WORKSHEET_DETACHED', 'WORKSHEET_LINKED', 'WORKSHEET_UNLINKED') AND "toStatus" IS NULL)
    OR ("kind" IN ('FIELDS_EDITED', 'NOTIFICATION_SENT') AND "toStatus" IS NULL AND "worksheetId" IS NULL)
  );
