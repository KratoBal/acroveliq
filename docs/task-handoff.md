# Strukturált feladatátadás

Az acrovelIQ token-brief 3. pontja (2026-10-12). Egy lezárt vagy félbehagyott feladat
után **új munkamenet** induljon, és ne vesszen el döntés, tilalom vagy műszaki állapot.
Az átadás egy rekord a feladatnál, nem a beszélgetésben és nem az `exchange/` mappában.

## A rekord

JSON, minden mező kötelező. A lista lehet üres (egy feladatnak lehet, hogy tényleg
nincs tilalma), de ki kell mondani, nem kihagyni.

```json
{
  "task": { "id": "<a kanban kártya id-je>", "goal": "<egy mondat>", "brief": "<a brief helye>" },
  "status": "done | in_progress | blocked | abandoned",
  "decisions": [{ "what": "...", "who": "...", "where": "<üzenet- vagy komment-azonosító>" }],
  "prohibitions": [{ "what": "...", "source": "<ki mondta, hol>" }],
  "code": { "repo": "KratoBal/acropora-os", "branch": "...", "head": "<sha>", "pr": 1660, "merged": true },
  "files": ["..."],
  "next_step": "<egy mondat>",
  "open_questions": [],
  "project": "acropora"
}
```

- A `code` `null`, ha a feladat nem nyúlt kódhoz.
- A `project` elhagyható; alapértéke `acropora`.

## Írás, a feladat végén

```bash
bash /home/marveen/marveen/scripts/fleet-api.sh handoff-write <task_id> <agens> - < atadas.json
```

- A rekord **fájlból, átirányítással** megy, mert idézőjel, backtick és dollárjel biztosan
  van benne.
- Hiányzó kötelező mezőnél a parancs **megtagad**, és az összes hiányzó mezőt kiírja.
- Minden írás új sor; az olvasás a legutolsót adja.

## Olvasás, egy új munkamenet ELSŐ lépése

```bash
bash /home/marveen/marveen/scripts/fleet-api.sh handoff-read <task_id>
```

- Kiírja a rekordot, és **visszaméri a kód-állapotot**: a szerver a flotta GitHub-tokenjével
  lekéri az ág fejét és a PR-t.
- Beolvadt PR-nál csak a PR-t méri, mert az ág már törölve lehet.
- Ha minden egyezik, megnevezi a következő lépést (kilépési kód 0).
- **Eltérésnél megáll** (kilépési kód 3), és felsorolja, mi más:
  - elavult ág-fej;
  - azóta beolvadt PR;
  - eltűnt ág.

  Ilyenkor a rekord egy azóta megváltozott állapotról szól: le kell mérni, mi történt, és
  jelezni, mielőtt bármi folytatódik.
- Ha valamit **nem tud lemérni** (nincs token, hálózati hiba), az is eltérés, nem egyezés.

## A végpontok

| | |
|---|---|
| `POST /api/tasks/<task>/handoffs` | `{ "agent": "...", "record": { ... } }`; 400 a hiányzó mezők listájával, 201 az `id`-vel |
| `GET /api/tasks/<task>/handoffs/latest` | a legutolsó rekord |
| `GET /api/tasks/<task>/handoffs/latest?verify=1` | a rekord és a `check`: `ok`, `mismatches`, `measured` |

A tábla `task_handoffs`, `task_id` kulccsal, idegen kulcs nélkül. Ha a feladat-tábla (a brief
1. pontja) beolvad, a kulcs egy sorban hozzáköthető.
