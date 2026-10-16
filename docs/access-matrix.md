# Jogosultsági mátrix (acrovelIQ P0-1)

Generálva: `npx tsx scripts/access-matrix.ts > docs/access-matrix.md`, a `src/web/route-access.ts` és a
`src/web/route-rules.ts` alapján. Kézzel ne szerkeszd: egy teszt ellenőrzi, hogy egyezik a kóddal.

Oszlopok: **S** Balázs munkamenete, **A** az Acrobot tokenje, **G** egy másik ágens tokenje,
**L** a régi közös token, **D** egy eszköz-kulcs (telefon, Bridge). „saját”: csak a hívó saját rekordja.

**A D oszlop külön döntés** (acrobot, 2026-10-12, 28623): a D mindent olvas és a szokásos írásokat
megkapja, de adminisztratív és jóváhagyó műveletet nem. Balázs a telepítéskor dönthet másképp.

## Döntendő a bekapcsolás előtt

A beállítás (`ACCESS_MODE`) alapból `naplo`: semmit nem tilt, csak naplózza, mit tiltana. A `kikenyszerit`
vagy a `legacy-szukitett` állás előtt ezeket kell eldönteni vagy lemérni:

1. **A telefon hangja (D).** A voice modul minden írása adminisztráció, tehát a `POST /api/voice/stt`, a
   `/api/voice/tts` és a `/api/voice/modality/set` csak S. Ha a telefonos felület ezeket hívja, a hangja a
   kikényszerítéskor elnémul. Mérés: a `request_actors` naplóban `device:` szereplő a voice sorokon.
2. **A jóváhagyás (A).** A `PATCH /api/approvals/:id` csak S. Ma az Acrobot zárja le a jóváhagyásokat Balázs
   szöveges válasza után. A PR 4 óta a szerver maga olvassa és ellenőrzi a Discord-választ (egyszer használható,
   a kéréshez kötött kód, lejárattal), és S-ként dönt; ez az `APPROVAL_DISCORD_CHANNEL_ID`, `_USER_IDS` és
   `_DECIDER` beállításával kapcsol be. A kikényszerítés csak akkor fordulhat, ha ez be van állítva és egy
   valódi jóváhagyáson mérten működött, különben a jóváhagyási lánc megáll.
3. **A régi token (L) kritikus útjai.** Amit ma a közös token kritikus úton hív, az a kikényszerítéskor
   eltörik (például a `POST /api/schedules`). A kapcsoló csak akkor fordul, ha az
   `npx tsx scripts/access-preflight.ts` listája üres (kilépési kód 0): ez a naplóból sorolja fel, mit
   tiltott volna. Ez eljárás, nem zár: a beállítást a kód nem tagadja meg. Az L oszlop 2026-10-15 óta a
   minimum: csak az az útvonal ✓, amit a régi token az ágensek saját tokenre váltása után még hívott (lásd
   lent, „A régi token minimuma”), és az üzenetküldés sem ezek között van: a közös tokennel bármely al-ágens
   egy másik regisztrált ágens nevében küldhetne. Egy ritkábban futó hívót a 24 órás mérés nem lát: a preflight
   `--napok` értéke a legritkább ütemezett feladat periódusa fölött legyen. Hogy ki hív még közös tokennel, azt
   az `npx tsx scripts/legacy-callers.ts --napok N` mutatja (user-agent, önbevallott név, cím: nyom, nem azonosság).
4. **Az önbevallott szereplők.** Az üzenet feladóját, a jóváhagyás kérőjét és eldöntőjét, az átadó rekord
   `agent` mezőjét, a tokenmérési esemény `actor` mezőjét és az ütemezett feladat szerzőjét a szerver a
   tokenből tölti ki (`src/web/actor-claims.ts`). A régi közös token senkit nem nevez meg: `naplo` állásban
   az ő mezője önbevallott marad, a másik két állásban `legacy-ismeretlen`, nem ellenőrzött jelöléssel. Egy
   eszköz `kikenyszerit` állásban `device:<név>` néven ír, nem bármelyik ágens nevében. A bekapcsolás előtt
   tehát minden ágensnek saját tokennel kell hívnia, különben a feladója ismeretlen lesz.
5. **Az ütemezett feladatok.** A `command`, `preCheck` és `targetSession` mezőt (és a `command` típust) API-n
   csak a munkamenet írhatja, MINDEN állásban, `naplo`-ban is (403): ez parancsfuttatási út, nem
   hozzáférési szűrő, és Balázs a beállítástól függetlenül zárta (2026-10-12 11:18:50 UTC). Az ágens vagy a
   közös token által írt feladat a kikényszerítő állásban társ-kerettel fut, nem operátor-kerettel; `naplo`
   állásban marad az operátor-keret, és a futtató naplózza, mi lenne. A váltás után tehát az Acrobot API-n
   létrehozott feladatai is kérésként érkeznek.

| Metódus | Útvonal | Osztály | S | A | G | L | D | Csoport | Tulajdonos |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/models/available` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/openrouter/manual` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/openrouter/manual` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/openrouter/models` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/agents` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| GET | `/api/claude-plans` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/agents/activity` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| POST | `/api/agents/model-suggest` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/:name/avatar` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| GET | `/api/agents/:name/avatar` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| GET | `/api/agents/:name/channels/slack/manifest` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents/:name/channels/slack/smoke-test` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/:name/channel/reconnect` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/channel/health` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents/:name/channels/:provider/test` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| POST | `/api/agents/:name/telegram/test` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| POST | `/api/agents/:name/channels/:provider` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/:name/telegram` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| DELETE | `/api/agents/:name/channels/:provider` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| DELETE | `/api/agents/:name/telegram` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/security` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PUT | `/api/agents/:name/security` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| PUT | `/api/agents/:name/auto-restart` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| GET | `/api/agents/:name/context-guard` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PUT | `/api/agents/:name/context-guard` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| GET | `/api/context-guard` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PUT | `/api/agents/:name/remote` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/team/graph` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/agents/:name/team` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PUT | `/api/agents/:name/team` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/channels/:provider/pending` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/agents/:name/telegram/pending` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents/:name/channels/:provider/approve` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/:name/telegram/approve` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/channels/:provider/allowed` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/agents/:name/telegram/allowed` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents/:name/channels/:provider/invites` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/:name/telegram/invites` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/channels/:provider/invites` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/telegram/invites` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| DELETE | `/api/agents/:name/channels/(telegram\|slack\|discord)/invites/:token` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| DELETE | `/api/agents/:name/telegram/invites/:token` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| DELETE | `/api/agents/:name/channels/(telegram\|slack\|discord)/allowed/(user\|group)/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| DELETE | `/api/agents/:name/telegram/allowed/(user\|group)/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/channel-requests` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents/:name/channel-requests/:id/approve` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/:name/channel-requests/:id/deny` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| POST | `/api/agents/:name/auth/init` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/:name/start` | KRITIKUS | ✓ | ✓ | ✗ | ✗ | ✗ | agent-lifecycle |  |
| POST | `/api/agents/:name/stop` | KRITIKUS | ✓ | ✓ | ✗ | ✗ | ✗ | agent-lifecycle |  |
| POST | `/api/agents/:name/drain-inbox` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| POST | `/api/agents/:name/restart` | KRITIKUS | ✓ | ✓ | ✗ | ✗ | ✗ | agent-lifecycle |  |
| GET | `/api/agents/:name/status` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/agents/export-all` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/export` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/agents/import` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| PUT | `/api/agents/:name` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| DELETE | `/api/agents/:name` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/agents/:name/voice-config` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PUT | `/api/agents/:name/voice-config` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| GET | `/api/connectors` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/connectors/status` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/connectors/refresh` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/connectors/external-paths` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/connectors/external-paths` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/connectors/external-paths` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/connectors/github-repos` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/connectors/github-repos` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/connectors/github-repos/:name` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| PATCH | `/api/connectors/github-repos/:name` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/connectors/:name` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/connectors` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/connectors/:name` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/connectors/:name/assign` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/mcp-catalog` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/mcp-catalog/:id/install` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/mcp-catalog/:id/uninstall` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/vault` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/vault` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/vault/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/vault/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/vault/bindings` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/vault/bindings` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/vault/bindings/:secretId/:envVar` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/vault/sync` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/vault/scan` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/vault/import` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/ollama/models` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/federation/manifest` | OLVASO | ✓ | ✗ | ✗ | ✗ | ✗ | federation-wire |  |
| POST | `/api/federation/inbox` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | federation-wire |  |
| GET | `/api/federation/peers` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/federation/status` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/federation/directory` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/federation/refresh` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/federation/apply` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| PUT | `/api/federation/peers` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/federation/enabled` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/federation/routing-mode` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/federation/peers` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| PATCH | `/api/federation/peers/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/federation/peers/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/federation/peers/:id/inbound-token` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/federation/peers/:id/rotate-inbound-token` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/federation/remove` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/connectors-hu/status` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/connectors-hu/install` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/connectors-hu/configure` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/docs` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/docs/:name` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/research` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/research/:agent/:name` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/sutyerak/ask` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| GET | `/sutyerak/health` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| GET | `/api/auth/status` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| POST | `/api/auth/login` | NYILVANOS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/auth/logout` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/auth/logout-all` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/auth/sessions` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/auth/password` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/auth/users` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/auth/users` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/auth/device-keys` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/auth/device-keys` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/auth/device-keys/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/auth/users/:username` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/security/bridge-enroll` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/bridge/service-ports` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PUT | `/api/bridge/service-ports` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/profiles` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/kanban` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| GET | `/api/kanban/heartbeat-summary` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/kanban/labels` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/kanban/labels` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| PUT | `/api/kanban/labels/:id` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| DELETE | `/api/kanban/labels/:id` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/kanban/:id/labels` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/kanban/:id/labels` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| DELETE | `/api/kanban/:id/labels/:labelId` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| GET | `/api/kanban-projects` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/kanban/assignees` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/kanban` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| PUT | `/api/kanban/:id` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| DELETE | `/api/kanban/:id` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| POST | `/api/kanban/:id/move` | KRITIKUS | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| POST | `/api/kanban/:id/archive` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| GET | `/api/kanban/archived` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/kanban/:id/unarchive` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| GET | `/api/kanban/:id/comments` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/kanban/:id/comments` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/kanban/:id/events` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/kanban/:id/breakdown` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| POST | `/api/kanban/:id/breakdown/accept` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | kanban-card-change | rekord: kanban-card (:id) |
| GET | `/api/kanban/:id/children` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/skills` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/skills/local` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/skills/export` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/skills/:name` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/skills` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/skills/import` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/skills/:name/assign` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| PUT | `/api/skills/:name` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/onboarding/status` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/onboarding/identity` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/onboarding/claude-auth` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/onboarding/launch` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/voice/directive` | ERZEKENY | ✓ | saját | saját | ✗ | ✗ | voice-directive-self | query: agent |
| GET | `/api/voice/modality` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/voice/modality/set` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/voice/status` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/voice/stt` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/voice/tts` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/voice/install` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/updates` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| GET | `/api/updates/status` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| POST | `/api/updates/diagnose` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/updates/check` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/updates/apply` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/approvals` | KRITIKUS | ✓ | ✓ | ✓ | ✗ | ✓ | approval-request |  |
| GET | `/api/approvals` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/approvals/:id` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PATCH | `/api/approvals/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | approval-decide |  |
| POST | `/api/messages` | KRITIKUS | ✓ | ✓ | ✓ | ✗ | ✓ | message-send |  |
| GET | `/api/messages/threads` | OLVASO | ✓ | ✓ | saját | ✗ | ✓ | message-read | query: agent |
| GET | `/api/messages/backlog` | OLVASO | ✓ | ✓ | saját | ✗ | ✓ | message-read | query: agent |
| GET | `/api/messages` | OLVASO | ✓ | ✓ | saját | ✓ | ✓ | message-read | query: agent |
| GET | `/api/messages/:id` | OLVASO | ✓ | ✓ | saját | ✗ | ✓ | message-read-one | rekord: message-participants (:id) |
| PUT | `/api/messages/:id` | KRITIKUS | ✓ | ✓ | saját | ✗ | ✓ | message-state | rekord: message-recipient (:id) |
| POST | `/api/memories` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | memory-write | body: agent_id |
| GET | `/api/memories` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| POST | `/api/memories/import` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | memory-write | body: agent_id |
| POST | `/api/memories/backfill` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | memory-write | body: agent_id |
| GET | `/api/memories/stats` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/memories/:id` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/fleet-reads/(access-decisions\|request-actors\|uzenet-ablak\|uzenet\|tool-log-osszesito\|tool-log-minta\|kartya-letrehozas)` | OLVASO | ✓ | ✓ | ✗ | ✗ | ✗ | fleet-reads |  |
| PUT | `/api/memories/:id` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | memory-change | rekord: memory (:id) |
| DELETE | `/api/memories/:id` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | memory-change | rekord: memory (:id) |
| GET | `/api/schedules/agents` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/schedules/expand-questions` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/schedules/expand-prompt` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/schedules` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| POST | `/api/schedules` | KRITIKUS | ✓ | saját | saját | ✗ | ✗ | schedule-create | body: agent |
| PUT | `/api/schedules/:name` | KRITIKUS | ✓ | saját | saját | ✗ | ✗ | schedule-change | rekord: schedule (:name) |
| DELETE | `/api/schedules/:name` | ERZEKENY | ✓ | saját | saját | ✗ | ✗ | schedule-change | rekord: schedule (:name) |
| POST | `/api/schedules/:name/toggle` | KRITIKUS | ✓ | saját | saját | ✗ | ✗ | schedule-change | rekord: schedule (:name) |
| POST | `/api/schedules/:name/run` | KRITIKUS | ✓ | saját | saját | ✗ | ✗ | schedule-change | rekord: schedule (:name) |
| GET | `/api/schedules/pending` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/schedules/:name/runs` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| DELETE | `/api/schedules/pending/:id` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/terminal-input` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| POST | `/api/terminal-input` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | terminal-write |  |
| GET | `/api/agents/:name/pane/stream` | KRITIKUS | ✓ | ✓ | saját | ✗ | ✓ | session-read | param: name |
| POST | `/api/agents/:name/keys` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | terminal-write |  |
| POST | `/api/agents/:name/login` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | terminal-write |  |
| GET | `/api/ideas` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/ideas/categories` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/ideas` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| PUT | `/api/ideas/:id` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| DELETE | `/api/ideas/:id` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/ideas/:id/comments` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/ideas/:id/comments` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/ideas/:id/promote` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/ideas/:id/breakdown` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/ideas/:id/promote-breakdown` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/ideas/:id/revert` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/ideas/:id/status-log` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/recall` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/recall/dates` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/network-info` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents/:name/skills/import` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/agents/:name/skills/:skill` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/agents/:name/skills` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agents/:name/skills` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/migrate/scan` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/migrate/run` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/vault/ssh-servers` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/vault/ssh-servers` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| PUT | `/api/vault/ssh-servers/:id` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| DELETE | `/api/vault/ssh-servers/:id` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/vault/ssh-servers/:id/generate-key` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/vault/ssh-servers/:id/public-key` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/background-tasks` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/background-tasks` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/background-tasks/:id` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| DELETE | `/api/background-tasks/:id` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/marveen` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| PUT | `/api/marveen` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/marveen/restart` | KRITIKUS | ✓ | ✓ | ✗ | ✗ | ✗ | agent-lifecycle |  |
| GET | `/api/marveen/avatar` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| POST | `/api/marveen/avatar` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/vault/ssh-keys` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/vault/ssh-keys` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/vault/ssh-keys/import` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/vault/ssh-keys/:id/public-key` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| DELETE | `/api/vault/ssh-keys/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/agents/:name/conversation` | KRITIKUS | ✓ | ✓ | saját | ✗ | ✓ | session-read | param: name |
| GET | `/api/overview` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| ANY | `/` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/index.html` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/style.css` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/app.js` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/manifest.json` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/sw.js` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/lang/*` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/avatars/*` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| ANY | `/icons/*` | NYILVANOS | ✓ | ✓ | ✓ | ✗ | ✓ | class:NYILVANOS |  |
| GET | `/api/measurements/runs` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/measurements/tasks` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/measurements/usage` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/measurements/refresh` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/measurements/runs/outcome` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/token-usage/collect` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/token-usage/summary` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/token-usage/timeline` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/token-usage/model-dist` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/token-usage/tool-stats` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/token-usage` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/autonomy` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/autonomy` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| POST | `/api/spans` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/traces` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/traces/:id` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/settings` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/settings` | ERZEKENY | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/costs/summary` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/costs/sources` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/costs/budgets` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/agent-taskstate/:agent/replay` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/agent-taskstate/:agent/consume` | ERZEKENY | ✓ | saját | saját | ✗ | ✗ | agent-taskstate | param: agent |
| POST | `/api/agent-taskstate/:agent` | KRITIKUS | ✓ | saját | saját | ✗ | ✗ | agent-taskstate | param: agent |
| GET | `/api/agent-taskstate/:agent` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| DELETE | `/api/agent-taskstate/:agent` | ERZEKENY | ✓ | saját | saját | ✗ | ✗ | agent-taskstate | param: agent |
| GET | `/api/fleet/export` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/fleet/import` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | administration |  |
| GET | `/api/status` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/tool-log` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/tool-log` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/tool-log/analyze` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/tool-log/prune` | ERZEKENY | ✓ | ✓ | ✗ | ✗ | ✗ | log-prune |  |
| GET | `/api/audit-log` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/skill-usage` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/skill-usage/stats` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/skill-usage` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/.well-known/fleetq` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| PUT | `/api/agents/:name/capabilities` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | agent-self-settings | param: name |
| POST | `/api/daily-log` | ERZEKENY | ✓ | ✓ | saját | ✗ | ✓ | daily-log-write | body: agent_id |
| GET | `/api/daily-log` | OLVASO | ✓ | ✓ | ✓ | ✓ | ✓ | class:OLVASO |  |
| GET | `/api/daily-log/dates` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/tasks/:id/handoffs` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/tasks/:id/handoffs/latest` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/open-matters` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/tasks` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/tasks/:id/usage` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/tasks/:id/events` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/tasks/:id/sessions` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| GET | `/api/tasks` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/tasks/:id/timeline` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/projects` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/tasks/:id/project` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/decisions/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | decision-decide |  |
| POST | `/api/task-actions` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| POST | `/api/task-actions/:id` | KRITIKUS | ✓ | ✗ | ✗ | ✗ | ✗ | class:KRITIKUS |  |
| GET | `/api/debates` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| GET | `/api/debates/:id` | OLVASO | ✓ | ✓ | ✓ | ✗ | ✓ | class:OLVASO |  |
| POST | `/api/debates/:id/turns/:token` | ERZEKENY | ✓ | ✓ | ✓ | ✗ | ✓ | class:ERZEKENY |  |
| POST | `/api/decisions/:id/discord-reply` | KRITIKUS | ✗ | ✓ | ✗ | ✗ | ✗ | decision-discord-reply |  |

## A régi token minimuma

Az L oszlopban csak ezek ✓, akármit ad a csoport vagy az osztály (a többi sor L ✗-je innen jön):

- `GET /api/messages`
- `GET /api/daily-log`
- `GET /api/kanban`
- `GET /api/schedules`
- `GET /api/agents`
- `GET /api/agents/activity`
- `GET /api/updates`
- `GET /api/updates/status`
- `GET /api/terminal-input`
- `GET /api/memories`

## A csoportok indoka

- **approval-decide**: a human decides, not a language model: only from the session (plan 2.4); the owner's Discord reply is checked on the server and decides as the session (PR 4, approval-discord.ts)
- **decision-decide**: Dontéseim V1: the owner decides from the owner's own session (Balázs, 2026-10-14 08:52:26 UTC, requirement 1); the handler holds it in every access mode
- **decision-discord-reply**: Dontéseim V1: the main agent attaches the Discord message the owner answered in; it decides nothing, the owner confirms on the page
- **approval-request**: anyone may ask; the decision is the gate
- **federation-wire**: the federation wire endpoints: peers reach them with their own scoped token (handled apart), not fleet tokens
- **message-send**: anyone may send; the stored sender is the token's owner, never the body's `from` (PR 3b); the shared token sends as `legacy-ismeretlen`, marked unverified
- **message-state**: closing a message can inject text into a pane: an agent only its own messages (the recipient)
- **message-read**: an agent reads its own messages (plan 3)
- **message-read-one**: an agent reads its own messages, sent or received (plan 3)
- **schedule-create**: only its own scheduled task; on another agent only from the session (plan 3); an agent-created task runs with a peer frame (PR 3b)
- **schedule-change**: only its own scheduled task, run-now included (plan 3); an update that would move it to another agent is not its own
- **agent-lifecycle**: starting, stopping, restarting agents: the session and the main agent (plan 3)
- **terminal-write**: text into a pane: only the session; the main agent keeps its tmux path, which the OS permissions govern (plan 3)
- **session-read**: another agent's whole session: the supervisor and the agent itself; a device reads it (the phone dashboard shows panes; acrobot's D list names no read)
- **agent-taskstate**: switches the pane-injection permission of an agent: only its own
- **agent-self-settings**: an agent's own settings (context guard, auto-restart, avatar, capabilities, its channel tests and invites)
- **fleet-reads**: B29: the main agent's fixed reads of the fleet database (access decisions, messages, the tool log): its session cannot open the database once it runs under its own user; no other caller needs them
- **log-prune**: deletes the shared tool log: the session and the main agent
- **memory-change**: an agent changes or deletes only its own memories; an update that would move one to another writer is not its own
- **memory-write**: an agent writes its own namespace (plan 3). `shared` is a category: the record still names its writer, so that must be the caller. A missing agent_id is the main agent's, so it is not "own"
- **daily-log-write**: an agent writes its own daily log (plan 3)
- **kanban-card-change**: an agent changes the cards assigned to it (plan 3); it hands one on only to the main agent, the escalation the dispatch asks for (assigning is the main agent's job, acrobot 28671); creating a card and commenting stay open
- **administration**: profiles, autonomy, settings, updates, migration, vault, security, connectors, federation: only the session (plan 3)
- **voice-directive-self**: an agent's own voice message: the transcript of its own channel's file and its reply directive, which carries no token (the reply reads the caller's own); it used to return the SHARED token (barracuda, #20), so the session only, and the agents' own hook got 403
- **class:NYILVANOS** (ha egy csoport sem illik): no authentication at all
- **class:OLVASO** (ha egy csoport sem illik): reads, no secret
- **class:ERZEKENY** (ha egy csoport sem illik): shared state, no owner
- **class:KRITIKUS** (ha egy csoport sem illik): critical: only from the session, unless a group opens it
