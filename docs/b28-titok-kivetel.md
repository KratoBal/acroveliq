# B28: az éles üzleti kulcsok és a Google-postafiók tokenek kivétele a flotta elől

Feladat: `b28-eles-kulcsok-kivetele` (P1-00e, P0-2). Terv: projektterv v2 B28 sora
(cél: egyik sem olvasható a flottából, `test -r` minden ágens-uid-ből ÉS a `marveen`-ből; a rotált régi érték elutasít),
és a P0 biztonsági terv H4 és H5 sora (`exchange/acroveliq-biztonsagi-terv-p0-2026-10-12.md`, 1.1).

**Minden lépés Balázsé, és mindegyik külön jóváhagyás** (rotáció a szolgáltatóknál, root-lépés a konténerben). A
parancsok a hostról futnak. Titok-értéket ez a lap nem tartalmaz, és a leltárhoz egyet sem olvastunk.

## 1. Mit mértünk (2026-10-16)

- **Ki olvassa:** `scripts/fleet-secrets.py --matrix`, uid-onként a tulajdonosból, a csoportból, a módból és a
  csoporttagságból számolva, a futtató saját sorát az `os.access`-szel összevetve (egyezett). A `store/` alatt 72
  titok-fájl áll. **A `marveen` mind a 72-t olvassa**; ágens-uid hetet: a `.claude-oauth-token` és a `.dashboard-token`
  mind a hatnak, a két GitHub-token murenának és nautilusnak, az `.expo-token` murenának, a négy FB-fájl barracudának, a
  két UNAS-fájl barracudának és polipnak.
- **Ki használja:** a fájlnév keresése (a tartalomé nem) négy helyen: a flotta repója (`KratoBal/acroveliq`, a fő ág
  `5ac86ab`, tesztek és dokumentáció nélkül), az élő fa szkriptjei (a nem követettek is), a skillek (a globális, a
  projekté és az ágenseké), és a három alkalmazás-repó (`acropora-os`, `acropora-ai-agent`, `acropora-commerce`, fő ág).
  A 72-ből 31 nevére a repóban nincs hivatkozó; ebből a második keresés hatot talált (`gads.sh`, `gsc.sh` az élő fában,
  nem követve; a `.fal-key` a képgeneráló skillben). Az OS repóban a Foxpost és a GLS fájlneve csak megjegyzésben áll: az
  élő OS a saját környezeti változóiból olvas (`FOXPOST_API_*`, `GLS_MYGLS_*`).

**Amit nem láttam, és ezért a nulla nem teljes bizonyíték:** a `marveen` ütemezett feladatai (`~/.claude/scheduled-tasks`,
0700), a `marveen` munkamenetének kézi parancsai és a vezérlőpult adatbázisában tárolt promptok. Egy C-osztályú fájl
használója tehát lehet egy ütemezett prompt vagy egy kézi lépés: ezt a 3. pont 1. lépése méri, mielőtt bármi törlődik.

## 2. Osztályok

| Osztály | Mit jelent | Mi történik vele a B28-ban |
|---|---|---|
| **C** | **éles üzleti kulcs vagy postafiók-token, a flottában nincs használója** (H4 és H5, a commerce nélkül) | **kivétel és rotáció**: ez a B28 |
| D | commerce: Stripe, Medusa, UNAS, és a commerce stage | a befagyasztás miatt **csak leltár**; a kivétel és a rotáció Balázs külön döntése |
| A | az élő működéshez kell a `marveen` alatt (vezérlőpult, ágensek indítása, posztolás, naptár, hibajegy-levelezés, mentés, stage) | marad; a közvetítő mögé vitele külön tétel (a B48 és a D4 mintája) |
| B | infrastruktúra-hozzáférés, amire már külön tétel fut | a GitHub-tokenek a D4 (GitHub App közvetítő), a Coolify-tokenek a P0 terv H2 és H3 sora |
| E | elavult másolat vagy mentés | törölhető; a két `.env` mentés a `.env` élő titkait hordozza |
| ? | célja ismeretlen, használót nem találtunk | egy mondat kell róla (kié, mire), utána C vagy E |

A tíz C-osztályú fájl: `.foxpost-credentials`, `.gls-credentials.json` és a `.bak-20261005` másolata, `.otp-ebiz-api-key`,
`.szamlazz-agent-key`, `.szamlazz-banktranz-key`, `.szamlazz-prod-master-key-v1`, `.gsuite-refresh-token-balazs`,
`.gsuite-refresh-token-ticket`, `.os-balazs-google-refresh-token`.

A teljes leltár a lap végén (6. pont).

## 3. Balázs lépései, sorrendben (semmi nem áll le)

A C-osztályú fájlokat a flottában semmi nem olvassa, ezért a kivételük nem állít le semmit. A rotáció viszont az **élő
rendszereket** érinti (az OS a saját példányát használja), ezért ott a sorrend: új kulcs, élő rendszer átállítva és
visszamérve, csak utána a régi visszavonása.

**1. Utolsó ellenőrzés, hogy tényleg nem használja semmi** (a flotta mérheti, írás nélkül; a `marveen` hozzáférési
idejéből): ha a fájlrendszer rögzíti az olvasást, a fájlok utolsó olvasási ideje.

```bash
cd /opt/marveen-docker
docker compose exec -u marveen marveen sh -c 'cd /home/marveen/marveen/store && stat -c "%x %n" .foxpost-credentials .gls-credentials.json .gls-credentials.json.bak-20261005 .otp-ebiz-api-key .szamlazz-agent-key .szamlazz-banktranz-key .szamlazz-prod-master-key-v1 .gsuite-refresh-token-balazs .gsuite-refresh-token-ticket .os-balazs-google-refresh-token'
```

Ha valamelyik az elmúlt napokban olvasva volt, annál a fájlnál itt megállunk, és előbb kiderítjük, mi olvasta. (A
`relatime` miatt az olvasási idő naponta legfeljebb egyszer frissül; egy régi dátum tehát jó jel, egy friss kérdés.)

**Mérve 2026-10-16 08:5x (murena, `stat`, olvasási jog nélkül; a mount `relatime`):** mind a tíz fájl utolsó olvasása
2026-10-14 16:39:13 és 16:39:15 között volt. Ugyanebben a két másodpercben a `store/` 72 titok-fájljából 56-ot olvasott
valami: ez egy tömeges olvasás (mentés vagy másolás), nem egy kulcs használata. A `relatime` szerint egy későbbi olvasás
egy napon belül frissítette volna az időt, tehát **2026-10-15 16:39 óta ezeket semmi nem olvasta**. Hogy a 10-14-i tömeges
olvasás mi volt, azt nem mértük (a `marveen` vagy a root olvashatta, mert a fájlok 600-asak); a lépés előtt érdemes
tudni.

**2. Rotáció a szolgáltatóknál, kulcsonként** (a te fiókjaidban, a flotta nélkül; az új érték NEM kerül a `store/`-ba):

| Kulcs | Hol él az új érték | Sorrend |
|---|---|---|
| Számlázz.hu agent kulcs, banki tranzakciós kulcs | az élő OS (Coolify környezeti változó vagy az OS beállításai) | új kulcs a Számlázz.hu fiókban, beírás az élő OS-be, egy próbaszámla-lekérdezés az OS-ből, utána a régi törlése |
| `.szamlazz-prod-master-key-v1` | az OS titkosítási kulcsa a Számlázz-adatokhoz (a név szerint; a szerepét nem mértük) | **előbb meg kell nézni az OS-ben, mit titkosít**: ha a tárolt adatot, a csere újratitkosítás, nem csak kulcscsere. Addig csak a flotta-másolat törlése (4. lépés), rotáció nélkül |
| OTP eBiz API-kulcs | az élő OS, ha használja | ugyanaz, mint a Számlázz-kulcsnál |
| Foxpost (e-kereskedelmi kód, jelszó, API-kulcs) | az élő OS `FOXPOST_API_*` | új jelszó és API-kulcs a Foxpost felületén, beírás az OS-be, egy követés-lekérdezés, utána a régi visszavonása |
| GLS MyGLS belépés | az élő OS `GLS_MYGLS_*` | új jelszó a MyGLS-ben, beírás az OS-be, egy csomaglista-lekérdezés |
| `.gsuite-refresh-token-balazs` (balazs@, gmail.readonly) | sehol | a balazs@ fiók Google-beállításaiban a flotta alkalmazásának hozzáférése visszavonva |
| `.gsuite-refresh-token-ticket` (ticket@, gmail.readonly) | sehol | ugyanígy a ticket@ fiókban. A hibajegy-levelezés **másik** klienssel megy (`.ticket-mail-*`, A osztály), azt nem érinti |
| `.os-balazs-google-refresh-token` (drive.readonly, gmail.readonly) | **lehet, hogy az élő OS-ben is** | **döntés kell:** ha az élő OS ugyanazzal a Google-klienssel és a balazs@ fiókkal dolgozik, a visszavonás az OS integrációját is megszünteti, és ott újra be kell jelentkezni. Ha nem, a visszavonás a többihez hasonló |

A Google-tokeneknél a visszavonás a **fiók és az alkalmazás** közti hozzáférést szünteti meg, nem egy tokent; ezért
nézd meg előbb, hogy a fiók listájában melyik alkalmazás az, és ne az info@ fiókban vond vissza (az info@ tokenje, a
`.gsuite-refresh-token`, A osztály: a naptár és a levél-összefoglaló él belőle).

**3. A flotta-másolatok törlése** a konténerben, rootként, egy lépésben, előtte egy névlistával:

```bash
cd /opt/marveen-docker
docker compose exec -u root marveen sh -c 'cd /home/marveen/marveen/store && ls -l .foxpost-credentials .gls-credentials.json .gls-credentials.json.bak-20261005 .otp-ebiz-api-key .szamlazz-agent-key .szamlazz-banktranz-key .szamlazz-prod-master-key-v1 .gsuite-refresh-token-balazs .gsuite-refresh-token-ticket .os-balazs-google-refresh-token && rm -f -- .foxpost-credentials .gls-credentials.json .gls-credentials.json.bak-20261005 .otp-ebiz-api-key .szamlazz-agent-key .szamlazz-banktranz-key .szamlazz-prod-master-key-v1 .gsuite-refresh-token-balazs .gsuite-refresh-token-ticket .os-balazs-google-refresh-token'
```

A titkosított titok-mentés (`fleet-secrets-backup.sh`) a régi értékeket továbbra is hordozza: ezért a rotáció az
alapértelmezés, nem a törlés. A rotált érték a mentésből visszaállítva is elutasít.

**4. A figyelő beolvasztása:** ez a PR (`scripts/titok-jog-figyelo.py`, `RETIRED` lista). **A 3. lépés UTÁN olvasztandó
be**: előtte a napi figyelő minden futáskor a tíz fájlt jelezné, ami igaz, de zaj, és egy folyton szóló őrzőre senki
nem figyel. Utána a figyelő minden futáskor szól, ha egy ilyen fájl visszakerül a `store/`-ba (egy mentésből vagy egy
kézi lépésből), és ezt nem nyeli el, amíg a fájl ott van.

**Visszaállítás:** a kivétel után a régi érték már nem kell (rotálva), tehát nincs mit visszatenni. Ha egy C-osztályú
fájlról mégis kiderül, hogy valami használta: az új értéket a szolgáltatótól, a te döntéseddel, és nem a `store/`-ba,
hanem a megfelelő közvetítő mögé (a B48 és a D4 mintája).

## 4. Mit kell mérni utána

| # | Mérés | Ki |
|---|---|---|
| M1 | `fleet-secrets.py --matrix`: a tíz C-osztályú fájl nincs a listában | a flotta |
| M2 | a napi figyelő a 3. lépés után egyszer `ELTUNT FAJL` sorokat ad mind a tízre, utána csendes | a flotta |
| M3 | az élő OS a rotált kulcsokkal működik: egy számla-lekérdezés, egy Foxpost-követés, egy GLS-csomaglista | Balázs vagy az OS naplója |
| M4 | a régi érték elutasít: a szolgáltató felülete a régi kulcsot visszavontnak mutatja (a flotta ezt nem tudja mérni, mert a régi értéket nem olvashatja, és nem is kell) | Balázs |

## 5. Ami a B28 után nyitva marad

- **D osztály** (Stripe éles és webhook, Medusa éles admin és mesterkulcs, UNAS): ugyanaz a helyzet, mint a C-nél (a
  Stripe és a Medusa éles kulcsokat a flottában semmi nem olvassa; az UNAS-t a `unas.sh` igen), de a commerce
  befagyasztása miatt ez csak leltár. A kivételük ugyanígy menne, a te szavadra; a figyelő listája akkor bővül.
- **A osztály**: a `marveen` továbbra is olvassa a 40 A-osztályú titkot, köztük az info@ postafiók tokenjét (levél küldésére is), a FB,
  YouTube, Drive, Search Console, Merchant Center és Google Ads tokeneket. Ezek a B29 (acrobot bypass munkamenete) végleges
  zárásáig a munkamenetből olvashatók; a helyük egy közvetítő, ahogy a GitHubnál a D4.
- **? osztály** (`.fleet-ro-password`, `.flintsign-key`, `.pagespeed-api-key`, `.szamlazz-stage-master-key-v1`): egy
  mondat kell róluk, kié és mire, és utána C vagy E.
- **E osztály**: a két `.env` mentés (`.env.mentes-*-2026-10-15`) a `.env` élő értékeit hordozza; a `.yt-refresh-token.bak`
  és a lejárt `.figma-token` (acrobot mérése szerint 2026-09-28-án lejárt) törölhető.

## 6. A teljes leltár (2026-10-16)

A „Használó” oszlop a fájlnévre hivatkozó fájlokat sorolja (a `fleet-secrets.py` maga nyilvántartás, nem használó, ezért
kimarad). A `-` azt jelenti, hogy a négy forrás egyikében sem találtunk hivatkozót (az 1. pont határaival).

| Fájl | Mód | Ágens-olvasó (a `marveen` mindet olvassa) | Használó (név szerint) | Osztály |
|---|---|---|---|---|
| `.acropora-ai-token` | marveen:fleet 600 | - | - | A |
| `.acropora-ai-token-stage` | marveen:marveen 600 | - | - | A |
| `.acropora-service-token-polip.json` | marveen:marveen 600 | - | scripts/acropora-task.sh | A |
| `.acropora-service-token.json` | marveen:marveen 600 | - | scripts/acropora-task.sh | A |
| `.acropora-stage-env.json` | marveen:marveen 600 | - | - | A |
| `.claude-oauth-token` | marveen:sec-claude-oauth 640 | barracuda, korall, murena, nautilus, picasso, polip | .env.example, install-linux.sh, install-macos.sh, scripts/auth.sh, scripts/channel-watchdog.sh, scripts/channels.sh, scripts/doctor.sh, scripts/fleet-bootstrap.sh, scripts/main-agent-isolated-config.mjs, scripts/root/fleet-pane-start-values.example.json, scripts/watchdog.sh, src/config-registry.ts, src/gpt-package.ts, src/index.ts, src/karanten-olvas.ts, src/store-watcher.ts, src/web/agent-process.ts, src/web/claude-credentials-guard.ts, src/web/measurement-auth.ts, src/web/routes/onboarding.ts, sutyerak/gateway.py | A |
| `.claude-oauth-token.verified` | marveen:marveen 600 | - | src/web/claude-credentials-guard.ts | A |
| `.commerce-stage-env.json` | marveen:marveen 600 | - | - | D |
| `.content-agent-token` | marveen:marveen 600 | - | scripts/tartalom.sh | A |
| `.coolify-token-ai` | marveen:marveen 600 | - | scripts/infra-allapot.sh, scripts/kirakat-telepites.sh | B |
| `.coolify-token-prod` | marveen:marveen 600 | - | scripts/eles-naplo.sh, scripts/infra-allapot.sh | B |
| `.dashboard-token` | marveen:sec-dashboard 640 | barracuda, korall, murena, nautilus, picasso, polip | gpt-runner/host/csatorna.sh, install-linux.sh, install-macos.sh, scripts/agent-msg.sh, scripts/agent-to-own-user.sh, scripts/backup.sh, scripts/daily-log.sh, scripts/doctor.sh, scripts/feladat-keret-or.sh, scripts/fix-agent-auth-headers.sh, scripts/fleet-api.sh, scripts/fleet-doctor.py, scripts/fleet-safe-start.sh, scripts/fleet-state.py, scripts/heartbeat-metrics.sh, scripts/hooks/inbox-drain.py, scripts/hooks/prior-art-recall.py, scripts/hooks/provenance-gate.py, scripts/hooks/session-recent-log.py, scripts/hooks/skill-usage-capture.py, scripts/hooks/taskstate-replay.py, scripts/hooks/tests/readonly-command-gate.test.py, scripts/hooks/tool-log-capture.py, scripts/hooks/voice-reply-directive.py, scripts/install-prod-tree-guard-hook.sh, scripts/lib/dashboard-token.sh, scripts/lib/dashboard_token.py, scripts/msg-close.sh, scripts/pr-beolvaszt.sh, scripts/pre-modify-backup.sh, scripts/pre-pr-review.sh, scripts/remote-access-enroll.ts, scripts/support-mail/lib.py, scripts/task-last-run.sh, scripts/watchdog.sh, seed-skills/fleet-helper/scripts/.gitignore, seed-skills/fleet-helper/scripts/fleet.py, src/db.ts, src/gpt-package.ts, src/remote-enroll-core.ts, src/store-watcher.ts, src/web/agent-scaffold.ts, src/web/dashboard-auth.ts, src/web/federation/capabilities.ts, src/web/federation/onboarding.ts, src/web/heartbeat-agent-scaffold.ts, src/web/routes/kanban.ts, sutyerak/gateway.py, templates/CLAUDE.md.template, templates/settings.json.template, tests/smoke/dashboard.spec.ts, tests/smoke/kanban-mobile-move.spec.ts, tests/smoke/update-diagnose.spec.ts | A |
| `.env.mentes-gpt-aktivalas-2026-10-15` | marveen:marveen 600 | - | - | E |
| `.env.mentes-reefclub-2026-10-15` | marveen:marveen 600 | - | - | E |
| `.expo-token` | marveen:sec-expo 640 | murena | scripts/eas-feltoltes.sh, scripts/eas-keret.sh, scripts/mobil-build.sh, scripts/mobil-ota.sh | A |
| `.fal-key` | marveen:marveen 600 | - | skill: kepgeneralas-flottaban | A |
| `.fb-app-secret` | marveen:sec-fb 640 | barracuda | scripts/fb-insights.sh | A |
| `.fb-page-token` | marveen:sec-fb 640 | barracuda | scripts/fb-calendar-sync.sh, scripts/fb-insights.sh, scripts/fb-schedule-post.sh | A |
| `.fb-page-tokens.json` | marveen:sec-fb 640 | barracuda | scripts/fb-insights.sh | A |
| `.fb-user-token` | marveen:sec-fb 640 | barracuda | scripts/fb-campaign-draft.sh, scripts/fb-insights.sh | A |
| `.figma-token` | marveen:sec-github 600 | - | - | E |
| `.fleet-ro-password` | marveen:marveen 600 | - | - | ? |
| `.flintsign-key` | marveen:marveen 600 | - | - | ? |
| `.foxpost-credentials` | marveen:marveen 600 | - | - | C |
| `.gads-refresh-token` | marveen:marveen 600 | - | scripts/gads.sh (élő fa, nem követett) | A |
| `.gdrive-access-token` | marveen:marveen 600 | - | scripts/gdrive.sh | A |
| `.gdrive-refresh-token` | marveen:sec-google 600 | - | scripts/gdrive.sh, scripts/yt-stats.sh | A |
| `.github-token` | marveen:sec-github 640 | murena, nautilus | scripts/ci-el-or.sh, scripts/git-auth.sh, scripts/github-pr-monitor.sh, scripts/lib/github-token.sh, scripts/lib/github_token.py, scripts/pr-allas.sh, scripts/pr-beolvaszt.sh, src/github-token.ts, src/gpt-package.ts | B |
| `.github-token-commerce` | marveen:sec-github 640 | murena, nautilus | - | B |
| `.gls-credentials.json` | marveen:marveen 600 | - | - | C |
| `.gls-credentials.json.bak-20261005` | marveen:marveen 600 | - | - | C |
| `.gmc-refresh-token` | marveen:marveen 600 | - | scripts/gmc.sh | A |
| `.google-ads-developer-token` | marveen:marveen 600 | - | scripts/gads.sh (élő fa, nem követett) | A |
| `.gpt-futtato-token` | marveen:sec-dashboard 600 | - | gpt-runner/host/aktivalas.sh, gpt-runner/host/csatorna.sh, src/config.ts, src/gpt-package.ts, src/store-watcher.ts | A |
| `.gsc-refresh-token` | marveen:marveen 600 | - | scripts/gsc.sh | A |
| `.gsc-refresh-token-domainfiok` | marveen:marveen 600 | - | scripts/gsc.sh (élő fa, nem követett) | A |
| `.gsuite-refresh-token` | marveen:marveen 600 | - | scripts/fb-calendar-sync.sh, scripts/gcal.sh | A |
| `.gsuite-refresh-token-balazs` | marveen:marveen 600 | - | - | C |
| `.gsuite-refresh-token-ticket` | marveen:marveen 600 | - | - | C |
| `.jev-api-key` | marveen:sec-dashboard 600 | - | scripts/jev/shadow.py, scripts/jev/tests/test_offline.py, scripts/jev/tests/test_p016.py, scripts/jev/tests/test_p017.py | A |
| `.medusa-admin-key-prod` | marveen:marveen 600 | - | - | D |
| `.medusa-master-key-prod-UJ` | marveen:marveen 600 | - | - | D |
| `.medusa-stage-admin-key` | marveen:marveen 600 | - | - | D |
| `.medusa-stage-key` | marveen:marveen 600 | - | scripts/medusa-stage.sh | D |
| `.os-balazs-google-refresh-token` | marveen:marveen 600 | - | - | C |
| `.otp-ebiz-api-key` | marveen:marveen 600 | - | - | C |
| `.pagespeed-api-key` | marveen:marveen 600 | - | - | ? |
| `.secrets-backup-passphrase` | marveen:marveen 600 | - | scripts/fleet-secrets-backup.sh | A |
| `.stage-basic-auth` | marveen:marveen 600 | - | scripts/kirakat-build.sh, scripts/lap-szin.sh | A |
| `.stage-os-smoke-admin-password` | marveen:marveen 600 | - | - | A |
| `.stage-os-smoke-partner-password` | marveen:marveen 600 | - | - | A |
| `.stage-os-smoke-password` | marveen:marveen 600 | - | - | A |
| `.stage-os-smoke-raktar-password` | marveen:marveen 600 | - | sutyerak/try.py | A |
| `.stripe-live-key` | marveen:marveen 600 | - | - | D |
| `.stripe-test-keys` | marveen:marveen 600 | - | - | D |
| `.stripe-webhook-secret` | marveen:marveen 600 | - | - | D |
| `.sutyerak-gateway-secret` | marveen:marveen 600 | - | sutyerak/gateway.py, sutyerak/try.py | A |
| `.sutyerak-handoff-token` | marveen:marveen 600 | - | scripts/sutyerak-valasz.sh | A |
| `.szamlazz-agent-key` | marveen:marveen 600 | - | - | C |
| `.szamlazz-banktranz-key` | marveen:marveen 600 | - | - | C |
| `.szamlazz-prod-master-key-v1` | marveen:marveen 600 | - | - | C |
| `.szamlazz-stage-master-key-v1` | marveen:marveen 600 | - | - | ? |
| `.ticket-mail-access-token` | marveen:marveen 600 | - | scripts/ticket-mail.sh | A |
| `.ticket-mail-client-secret` | marveen:marveen 600 | - | scripts/ticket-mail.sh | A |
| `.ticket-mail-refresh-token` | marveen:marveen 600 | - | scripts/ticket-mail.sh | A |
| `.unas-api-key` | marveen:sec-unas 640 | barracuda, polip | scripts/unas.sh, scripts/vevo-osszesito.py | D |
| `.unas-token` | marveen:sec-unas 660 | barracuda, polip | scripts/unas.sh, scripts/vevo-osszesito.py | D |
| `.vault-key` | marveen:sec-vault 640 | - | scripts/pre-modify-backup.sh, src/db.ts, src/gpt-package.ts, src/store-watcher.ts, src/web/fleet-transfer.ts, src/web/vault.ts | A |
| `.yt-access-token` | marveen:sec-google 600 | - | scripts/yt-stats.sh | A |
| `.yt-client-secret` | marveen:sec-google 640 | - | scripts/fb-calendar-sync.sh, scripts/gcal.sh, scripts/gdrive.sh, scripts/gmc.sh, scripts/gsc.sh, scripts/yt-stats.sh | A |
| `.yt-refresh-token` | marveen:sec-google 640 | - | scripts/yt-stats.sh | A |
| `.yt-refresh-token.bak-20260816` | marveen:marveen 600 | - | - | E |
