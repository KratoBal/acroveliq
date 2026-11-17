# Stage app atallitasa Dockerfile-epitesrol GHCR-kepre (scripts/ghcr-atallas.sh)

Task t-20261117-ghcr-kepek, kartya 0529e916, acrobot 54755. Az OS kepeit a GitHub epiti (acropora-os #2661, docs/GHCR-IMAGES.md az acropora-os repoban), a Coolify csak huzza. Ez a szkript EGY stage appot allit at es vissza, acrobot inditasara, eloszor a stage api.

## Hasznalat (mindig a flotta gyokerebol)

```bash
cd /home/marveen/marveen && bash scripts/ghcr-atallas.sh terv <app-uuid>                       # csak olvas: elteres + elore es vissza lepesek
cd /home/marveen/marveen && bash scripts/ghcr-atallas.sh elore <app-uuid> <sha40>              # szaraz futas (alapertelmezes)
cd /home/marveen/marveen && bash scripts/ghcr-atallas.sh elore <app-uuid> <sha40> --vegrehajt  # ir
cd /home/marveen/marveen && bash scripts/ghcr-atallas.sh vissza <app-uuid> --vegrehajt         # a rogzitett allapotra
cd /home/marveen/marveen && bash scripts/ghcr-atallas.sh meres <app-uuid>                      # csak a /health (api) vagy GET / (web, partner)
```

Stage api uuid: `vrjxxwffsxytstq8oepgbhii`. A `<sha40>` a #2661 utan a main egy commitja, aminek az images.yml futasa kesz (a GHCR-ben van `sha-<sha40>` kep).

## Mit ir az `elore` (ebben a sorrendben, mindegyik lepes visszaolvasva a kovetkezo elott)

| lepes | iras | visszaolvasas |
| --- | --- | --- |
| 1 | `PATCH /api/v1/applications/<uuid>`: `build_pack` `dockerimage`, `docker_registry_image_name` `ghcr.io/kratobal/<kep>`, `docker_registry_image_tag` `sha-<40>` | az app MINDEN rogzitett mezoje a vartat adja (a harom uj, a tobbi valtozatlan) |
| 2 | csak api: a nem-preview `RELEASE_COMMIT_SHA` env sor torlese (`DELETE .../envs/<env-uuid>`) | nincs nem-preview sor |
| 3 | `POST /api/v1/deploy?uuid=<uuid>`, varakozas a `/deployments/<uuid>` `finished` allapotra | |
| 4 | meres: api `/health`: `imageCommit == runtimeCommit ==` a cimke commitja es `commitSourceState` `match`; web, partner `GET /` 2xx vagy 3xx | |

Kepek (a rogzitett NEV alapjan): `acropora-stage-api` `acropora-os-api`; `acropora-staging-web` `acropora-os-web-stage`; `acropora-staging-partner` `acropora-os-partner-stage`. A jatek es a reefclub appok nem kapnak kepet (a szkript megtagadja), az eles gep apps mas Coolify (megtagadja).

Miert kell a `RELEASE_COMMIT_SHA` sort torolni az api-n: a kep a commitot alapertekkent hordozza (az api Dockerfile ENV-je), de a platform-ertek FELULIRJA, az ures is (release-info.util.ts), tehat huzott kepen a Coolify-valtozo nem maradhat.

## Mit ir a `vissza`

`PATCH` a rogzitett ertekekkel: `build_pack` `dockerfile`, `dockerfile_location`, `base_directory`, `dockerfile_target_build`, es a ket registry mezo `null` (a rogzitett allapotban nincs kep); az api-n a `RELEASE_COMMIT_SHA` sor ujra (`${SOURCE_COMMIT}`, build es runtime, nem preview); visszaolvasas (minden rogzitett mezo, az env sorok kulcs/preview/build/runtime szerint); telepites (TELJES epites a git-bol, percek); a /health allapota kiirva.

## Vedelem

- Fix stage cim (az AI gep Coolifyja a tailnet-en), nem kornyezetbol. Olvasni az olvaso token, irni CSAK a `--vegrehajt` agon az rw token. A /health-kerés nem visel tokent.
- Egy app egy futasban. Szaraz alapertelmezes. Nincs automatikus visszaallitas (egy tartos hibat egy ciklus vegtelenul probalna): egy bukott lepes megall es kiirja a `vissza` parancsot.
- Indulas elott az elo app EGYEZNI kell a rogzitett allapottal (mezonkent, az env sorok kulcs/preview/build/runtime szerint) es `running` allapotban kell lennie; elteres eseten megtagad, mert a visszaallitas egy olyan allapotra allna vissza, ami sosem volt az elottunk allo.
- A cimke csak `sha-<40 kisbetus hexa>`; `latest` es mas regiszter nem megy.
- Naplo: `exchange/ghcr/atallas-<uuid>.jsonl`, lepesenkent egy sor (nincs token, nincs env-ertek).

## Amit a szkript irasakor NEM lehetett megmerni (az elso `--vegrehajt` maga a meres)

1. Hogy ez a Coolify elfogadja-e a `build_pack: dockerimage` erteket egy MEGLEVO app PATCH-jen (a Coolify docs tartomanya nincs a karanten-olvaso engedelylistajan, a tokenek nem az en kulcsom). Ha elutasitja, az app valtozatlan marad (a szkript ezt kiirja), es kell masik ut.
2. Hogy atallitas utan megmarad-e a tobbi mezo (portok, git, envek): minden mezo visszaolvasva, elteres eseten a szkript megall.
3. A `DELETE /api/v1/applications/<uuid>/envs/<env-uuid>` utvonal, es hogy az env-sorok a GET-ben viselnek `uuid`-ot.
4. Hogy a `RELEASE_COMMIT_SHA` volt erteke `${SOURCE_COMMIT}` volt (a rogzitett allapotban nincs ertek, a Coolify nem adja): a `vissza` ezt irja vissza, es NEM tudja visszaolvasni.
5. Hogy a GHCR csomag lathatosaga a Coolify gepen huzhato (publikus csomag kell, vagy `docker login` a gepen: a Balazs-lista 3. pontja).
6. A web es a partner `API_URL`-je epitesi idoju: a kepek kornyezetenkent kulonallnak (stage, prod), a stage kep a `vars.STAGE_API_URL`-bol epul.
