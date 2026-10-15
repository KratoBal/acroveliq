#!/usr/bin/env bash
# ANSWERS: Milyen szin all TENYLEG egy kirakat-lapon, kiszamolva -- amit a HTML forrasabol nem lehet latni.
#
# MIERT LETEZIK (sajat meres, 2026-09-08 hajnal): egy ejszaka alatt tizenket
# beolvasztas nyult szinekhez (rez-tokenek, a jelveny, a sotet vaz, a lap alji sav), es
# MINDEN szin-allitasunk KOZVETVE lett igazolva: a stiluslap forrasabol, a tervfajl
# kiolvasasabol, vagy egy `data-` jelolo meglétebol. Egyik sem mondja meg, milyen szin
# all a lapon.
#
# A KULONBSEG NEM ELMELETI. Egy `var(--terv-kiemel)` hivas HELYES a forrasban akkor is,
# ha a valtozo azon a fan nincs definialva -- olyankor a bongeszo CSENDBEN az orokolt
# vagy az alapertelmezett erteket hasznalja. Merve ugyanezen az ejszakan: a kosar ot
# rez-hivohelye HELYES szint adott a ROSSZ tokennel, mert a vilagos vilagban a ket
# szerep erteke egybeesik. Forrasbol ez nem latszik, kiszamolt ertekbol igen.
#
# HASZNALAT:
#   bash scripts/lap-szin.sh <url>
#   bash scripts/lap-szin.sh <url> --valtozok        <- csak a feloldott terv-tokenek
#   bash scripts/lap-szin.sh <url> --dobozok         <- csak a vaz dobozai es cimeik
#   bash scripts/lap-szin.sh --allit [sotet] [vilagos]  <- ALLIT: a ket vilag kiszamolt
#                                                          erteke terjen el (lasd lentebb)
#
# A MUNKAKONYVTAR SZAMIT, NEM A SZKRIPT UTVONALA (sajat meres, 2026-09-08 06:12):
# a `node -e` a playwrightot a MUNKAKONYVTARBOL felfele keresi, tehat mashonnan
# futtatva MODULE_NOT_FOUND-ra fut. Az pedig NEM az allitas pirosa, hanem nulla
# meres -- ugyanaz a csapda, mint egy le nem fordulo kalibracio.
#   cd /home/marveen/marveen && bash scripts/lap-szin.sh --allit
#
# A HATARA, KIMONDVA: ez a lap ALLAPOTAT meri, nem azt, hogy a szin HELYES-e. Amit a
# terv mond, azt tovabbra is a tervfajlbol kell kiolvasni -- a ketto OSSZEVETESE a
# dontes, es azt ember (vagy egy kulon allitas) vegzi, nem ez a szkript.
set -uo pipefail

ROOT=/home/marveen/marveen

# =============================================================================
# --allit : A HARMADIK LAB. Ez az EGYETLEN allitasunk, ami nem a NEVEN all.
# =============================================================================
#
# MIERT KELL, es miert epp EBBEN az alakban (murena mert megkotese, 2026-09-08
# 05:50, kartya 2aec0206):
#
#   Ket allitasunk van ugyanarra a rez-tokenre, ket retegben, ket agenstol:
#   a komponens-spec `toHaveStyle({ color: "var(--terv-kiemel-tinta)" })` alakja
#   es a forras-szintu ertek-allitas. A jsdom NEM oldja fel a CSS-valtozot,
#   tehat MIND A KETTO a NEVET veti ossze. Ket reteg, ket agens, EGY kozos
#   tamaszpont: egy atnevezes vagy egy osszevonas mind a kettot egyszerre teszi
#   halotta, es egyik agens sem lat pirosat.
#
#   Az, hogy ketten allitjuk, NEM ketszeres vedelem: ugyanaz a vedelem ketszer.
#
# EZERT NEM A LETEZEST ALLITJUK. Egy letezes-allitas egy OSSZEVONAS utan is zold
# maradna: a valtozo tovabbra is letezik es tovabbra is szint ad, csak epp
# MINDKET vilagban ugyanazt. Az allitas ezert a KET VILAG KISZAMOLT ERTEKEBEN
# KOVETEL KULONBSEGET -- azt egy osszevonas pirosra valtja.
#
# A MASIK IRANY IS ALL, es olcso: ami vilag-fuggetlen (betuk, sarkok), annak
# AZONOSNAK kell maradnia. Egy veletlen vilag-fuggo felulirast semmi mas nem fog
# meg, mert az is "mukodik".
#
# A LISTAK MERESBOL JONNEK, nem a stiluslapbol: 2026-09-08 06:10-kor mindket
# lapot lemertem, es a huszonnegy feloldott terv-tokenbol kilenc tert el.
#
# A HATARA, KIMONDVA, ES EZ A FONTOSABB FELE: ez azt meri, AMI KI VAN TELEPITVE,
# nem azt, ami a fo agon all. A teszt kirakat ma huszonnegy beolvasztassal van
# lemaradva (kartya 35572a81), es a lap ma nem mondja meg, melyik commit fut
# rajta (kartya 5a66fa34). Vagyis egy PIROS itt ket dolgot jelenthet: valodi
# visszaeses, VAGY egy elavult telepites. A szkript ezert nem mond verdiktet a
# fo agrol, es ezt ki is irja.
# =============================================================================
# The test storefront sits behind HTTP basic auth since 2026-10-15 (Balazs, stage P1-00b).
# node reads the credentials from this file itself; they never reach argv or the env.
STAGE_AUTH_FILE="/home/marveen/marveen/store/.stage-basic-auth"
if [ "${1:-}" = "--allit" ]; then
  SOTET="${2:-https://shop-staging.acropora.hu/hu/products/acropora-austea-tricolor}"
  VILAGOS="${3:-https://shop-staging.acropora.hu/hu/products/nyos-quantum-220-eq-okos-lehabzo}"

  PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers" STAGE_AUTH_FILE="$STAGE_AUTH_FILE" \
  LAP_SOTET="$SOTET" LAP_VILAGOS="$VILAGOS" timeout 180 node -e '
  const { chromium } = require("playwright")

  // KULONBOZZON: a szerepe szerint vilag-fuggo token. Ha ketto egybeesik, vagy
  // ha valaki ket szerepet egy tokenne von ossze, ez pirosra valt.
  const KULONBOZZON = [
    "--terv-hatter",
    "--terv-hatter-halvany",
    "--terv-hatter-lap",
    "--terv-keret",
    "--terv-keret-meleg",
    "--terv-kiemel",
    "--terv-szoveg",
    "--terv-szoveg-halvany",
  ]

  // VART: NEV SZERINT, MELYIK ERTEK MELYIK VILAGE.
  //
  // MIERT KELL, ES MIERT NEM ELEG A KULONBOZZON (murena merese, 2026-09-08):
  // a KULONBOZZON csak azt koveteli, hogy a ket ertek TERJEN EL. Egy HELYCSERE
  // eltér, tehat atmegy rajta. Merve: a kitelepitett lapon a --terv-kiemel ket
  // erteke FEL VOLT CSERELVE (sotet=0.55, vilagos=0.62), es a meres ZOLDET adott.
  //
  // A TABLA FORRASA: apps/storefront/src/styles/globals.css a commerce fo agan,
  // a :root es a [data-vilag="sotet"] blokk, kiolvasva 2026-09-08-an.
  //
  // EZ A TABLA ELAVULHAT. Ha egy sor nem stimmel, KET oka lehet, es a szkript
  // nem tudja eldonteni, melyik:
  //   a) a telepites lemaradt, es a lapon regi ertek all
  //   b) a fo agon valtozott a token, es EZ A TABLA az elavult
  // Ezert a hibauzenet mind a kettot kiirja. Aki javit, eloszor a fo agat nezze meg.
  const VART = {
    "--terv-hatter": { sotet: "oklch(0.235 0.02 248)", vilagos: "oklch(0.96 0.006 75)" },
    "--terv-hatter-halvany": { sotet: "oklch(0.205 0.018 249)", vilagos: "oklch(0.955 0.004 250)" },
    "--terv-hatter-lap": { sotet: "oklch(0.17 0.016 250)", vilagos: "oklch(0.995 0.003 80)" },
    "--terv-keret": { sotet: "oklch(0.28 0.014 250)", vilagos: "oklch(0.88 0.005 250)" },
    "--terv-keret-meleg": { sotet: "oklch(0.33 0.016 250)", vilagos: "oklch(0.88 0.008 70)" },
    "--terv-kiemel": { sotet: "oklch(0.62 0.13 45)", vilagos: "oklch(0.55 0.13 45)" },
    "--terv-szoveg": { sotet: "oklch(0.95 0.006 250)", vilagos: "oklch(0.2 0.012 60)" },
    "--terv-szoveg-halvany": { sotet: "oklch(0.72 0.012 250)", vilagos: "oklch(0.5 0.012 60)" },
  }

  // A LISTA OROKOLTE A TELEPITES KORAT, ES EZ A TELEPITES UTAN JAVITANDO.
  //
  // Murena merese, 2026-09-08: a fenti nyolc tokent a KITELEPITETT lap
  // meresebol vezettem le. A FO AGON viszont TIZ ter el vilagonkent. A ket
  // hianyzo, a fo agi `globals.css` ertekeivel:
  //
  //   --terv-kiemel-szoveg   vilagos: oklch(1 0 0)         sotet: oklch(0.15 0.014 45)
  //   --terv-kiemel-tinta    vilagos: oklch(0.55 0.13 45)  sotet: oklch(0.68 0.13 45)
  //
  // MIERT NINCSENEK MA A LISTAN: a `-tinta` a kitelepitett lapon MEG NEM
  // LETEZIK (a #145 vitte be), tehat felvetele ma "nem oldodik fel mindket
  // lapon" pirosat adna -- ami igaz allitas a telepitesi lemaradasrol, de nem
  // terv-hiba, es elfedne a valodiakat.
  //
  // A LEPES, ES A FELTETELE: amint a kirakat telepitese megtortent, mind a ket
  // listat (KULONBOZZON es VART) a FO AG `globals.css` fajlabol kell
  // ujravezetni, nem a lapbol. Addig a `NINCS TABLA` sorok mutatjak, mi marad
  // fedetlen.
  //
  // A `--terv-kiemel-szoveg` felcserelese lenne a leglathatobb: az a rezen ALLO
  // szoveg, tehat egy csere utan a vilagos lapon sotet felirat allna feher
  // helyett a rez gombokon.

  // AZONOS: vilag-fuggetlen. Egy vilag-fuggo felulirast semmi mas nem fog meg.
  const AZONOS = [
    "--terv-betu-fo-lanc",
    "--terv-betu-mono-lanc",
    "--terv-betu-kiemelt-lanc",
    "--terv-sugar-doboz",
    "--terv-sugar-kicsi",
    "--terv-sugar-kor",
  ]

  const MINIMUM_TOKEN = 20 // az orzo szamolja magat: ennyi alatt a meres hasznalhatatlan

  async function merd(b, url) {
    const p = await b.newPage({ httpCredentials: (() => { try { const [u, pw] = require("fs").readFileSync(process.env.STAGE_AUTH_FILE || "/home/marveen/marveen/store/.stage-basic-auth", "utf8").split("\n"); return u && pw ? { username: u, password: pw } : undefined } catch { return undefined } })(), viewport: { width: 1440, height: 1000 } })
    const valasz = await p.goto(url, { waitUntil: "networkidle", timeout: 60000 })
    const allapot = valasz ? valasz.status() : 0
    const vilag = await p.evaluate(() =>
      document.querySelector("[data-vilag]")?.getAttribute("data-vilag") ?? null)
    const tokenek = await p.evaluate(() => {
      const el = document.querySelector("[data-vilag]") || document.documentElement
      const cs = getComputedStyle(el)
      const nevek = new Set()
      for (const lap of Array.from(document.styleSheets)) {
        let szabalyok
        try { szabalyok = lap.cssRules } catch { continue }
        for (const sz of Array.from(szabalyok || [])) {
          const t = sz.cssText || ""
          for (const m of t.matchAll(/(--terv-[a-z0-9-]+)\s*:/g)) nevek.add(m[1])
        }
      }
      const ki = {}
      for (const n of Array.from(nevek).sort()) {
        const v = cs.getPropertyValue(n).trim()
        if (v) ki[n] = v
      }
      return ki
    })
    await p.close()
    return { url, allapot, vilag, tokenek }
  }

  ;(async () => {
    const b = await chromium.launch()
    const s = await merd(b, process.env.LAP_SOTET)
    const v = await merd(b, process.env.LAP_VILAGOS)
    await b.close()

    console.log("--- lap-szin --allit   (a KITELEPITETT lapot meri, nem a fo agat)")
    console.log(`    sotet    HTTP ${s.allapot}  data-vilag=${s.vilag}  ${Object.keys(s.tokenek).length} feloldott token`)
    console.log(`    vilagos  HTTP ${v.allapot}  data-vilag=${v.vilag}  ${Object.keys(v.tokenek).length} feloldott token`)

    const hiba = []

    // AZ ORZO SZAMOLJA MAGAT. Egy ures vagy csonka meres NEM zold: az elso
    // dolog, amit el kell donteni, hogy a meres egyaltalan megtortent-e.
    if (s.allapot !== 200 || v.allapot !== 200) hiba.push(`nem 200-as valasz (sotet=${s.allapot}, vilagos=${v.allapot})`)
    if (s.vilag !== "sotet") hiba.push(`a sotetnek szant lap data-vilag ertéke: ${s.vilag}`)
    if (v.vilag !== "vilagos") hiba.push(`a vilagosnak szant lap data-vilag ertéke: ${v.vilag}`)
    if (Object.keys(s.tokenek).length < MINIMUM_TOKEN) hiba.push(`a sotet lapon csak ${Object.keys(s.tokenek).length} token oldodott fel (minimum ${MINIMUM_TOKEN})`)
    if (Object.keys(v.tokenek).length < MINIMUM_TOKEN) hiba.push(`a vilagos lapon csak ${Object.keys(v.tokenek).length} token oldodott fel (minimum ${MINIMUM_TOKEN})`)
    if (!KULONBOZZON.length) hiba.push("a KULONBOZZON lista ures: ez az allitas nem tudna elbukni")
    if (!Object.keys(VART).length) hiba.push("a VART tabla ures: a helycsere ellen nincs vedelem")
    for (const n of Object.keys(VART)) {
      if (!KULONBOZZON.includes(n)) hiba.push(`${n}: VART erteke van, de nincs a KULONBOZZON listan`)
    }

    // HA NULLA (VAGY TUL KEVES) TOKEN OLDODOTT FEL, A MERES ROMLOTT EL, NEM A LAP.
    //
    // Murena merese, 2026-09-08 08:35, kozvetlenul egy telepites utan: a szkript NULLA
    // tokent latott, es ettol MIND A TIZENNEGY token "nem oldodik fel mindket lapon"
    // pirosat kapott. A CSS bizonyithatoan helyes volt (o kozvetlenul lehivta), es en
    // ket perccel korabban ES ket perccel kesobb is ZOLDET mertem ugyanezen a lapon.
    // Vagyis atmeneti allapot volt a telepitesi ablakban (a stiluslap neve epp
    // cserelodott, a `cssRules` bejarasa nem adott szabalyt).
    //
    // AMIERT EZ KULON AG, ES NEM CSAK EGY TOVABBI HIBASOR: az idozitese a
    // legrosszabb. Egy telepites utani ELSO meres, ami tizenhat pirosat mutat egy JO
    // kiadasra -- aki a szamot olvassa, visszagordulest javasol. A tartalom helyes
    // volt, a KIMENET olvasodott katasztrofanak.
    if (Object.keys(s.tokenek).length < MINIMUM_TOKEN || Object.keys(v.tokenek).length < MINIMUM_TOKEN) {
      console.log("\n    A MERES NEM SIKERULT -- ES EZ NEM A LAPROL SZOL.")
      console.log("    A stiluslapbol nem sikerult tokent kiolvasni, tehat a lenti")
      console.log("    osszevetesnek nem volna ertelme: MINDEN token hianyoznek.")
      console.log("    EZT NE OLVASD VISSZAESESKENT. Tipikus ok: epp fut egy telepites,")
      console.log("    es a stiluslap cserelodik. Varj egy percet, es merd ujra.")
      console.log("\n    PIROS (" + hiba.length + "):")
      for (const h of hiba) console.log("      " + h)
      process.exit(1)
    }

    console.log("\n    KULONBOZNIE KELL:")
    for (const n of KULONBOZZON) {
      const a = s.tokenek[n], c = v.tokenek[n]
      if (a === undefined || c === undefined) {
        console.log(`      HIANYZIK  ${n.padEnd(26)} sotet=${a ?? "-"}  vilagos=${c ?? "-"}`)
        hiba.push(`${n}: nem oldodik fel mindket lapon`)
      } else if (a === c) {
        console.log(`      AZONOS    ${n.padEnd(26)} ${a}`)
        hiba.push(`${n}: a ket vilagban UGYANAZ az ertek (${a})`)
      } else {
        console.log(`      rendben   ${n.padEnd(26)} sotet=${a}  vilagos=${c}`)
      }
    }

    console.log("\n    VART ERTEK (nev szerint, melyik melyike):")
    for (const n of KULONBOZZON) {
      const e = VART[n]
      if (!e) {
        console.log(`      NINCS TABLA ${n.padEnd(26)} csak a kulonbozes van rajta allitva, a HELYCSERE atmenne`)
        continue
      }
      const a = s.tokenek[n], c = v.tokenek[n]
      if (a === undefined || c === undefined) continue
      if (a === e.sotet && c === e.vilagos) {
        console.log(`      rendben     ${n.padEnd(26)} sotet=${a}  vilagos=${c}`)
      } else if (a === e.vilagos && c === e.sotet) {
        console.log(`      FELCSERELVE ${n.padEnd(26)} sotet=${a}  vilagos=${c}`)
        hiba.push(`${n}: a ket vilag erteke FEL VAN CSERELVE (varva: sotet=${e.sotet}, vilagos=${e.vilagos})`)
      } else {
        console.log(`      ELTER       ${n.padEnd(26)} sotet=${a} (vart ${e.sotet})  vilagos=${c} (vart ${e.vilagos})`)
        hiba.push(`${n}: elter a tervtol -- vagy a telepites maradt le, vagy a VART tabla avult el`)
      }
    }

    console.log("\n    AZONOSNAK KELL MARADNIA:")
    for (const n of AZONOS) {
      const a = s.tokenek[n], c = v.tokenek[n]
      if (a === undefined || c === undefined) {
        console.log(`      HIANYZIK  ${n.padEnd(26)} sotet=${a ?? "-"}  vilagos=${c ?? "-"}`)
        hiba.push(`${n}: nem oldodik fel mindket lapon`)
      } else if (a !== c) {
        console.log(`      ELTER     ${n.padEnd(26)} sotet=${a}  vilagos=${c}`)
        hiba.push(`${n}: vilag-fuggetlen tokennek KET erteke van`)
      } else {
        console.log(`      rendben   ${n.padEnd(26)} ${a}`)
      }
    }

    if (hiba.length) {
      console.log(`\n    PIROS (${hiba.length}):`)
      for (const h of hiba) console.log(`      ${h}`)
      console.log("\n    MIELOTT VISSZAESESNEK NEVEZED: ez a KITELEPITETT lap. Nezd meg,")
      console.log("    hany beolvasztas var telepitesre (kartya 35572a81). Egy elavult")
      console.log("    telepites ugyanigy nez ki, mint egy visszaeses.")
      process.exit(1)
    }
    console.log("\n    ZOLD. (Amit bizonyit: a ket vilag kiszamolt erteke elter ott, ahol")
    console.log("    kell, es egyezik ott, ahol kell -- a KITELEPITETT lapon.)")
  })().catch((e) => { console.error("HIBA:", e.message); process.exit(2) })
  '
  exit $?
fi

# =============================================================================
# --kep <url> <fajl.png> [szelesseg] : KEPERNYOKEP, mert nem minden kerdes szam
# =============================================================================
#
# MIERT LETEZIK (murena leletebol, 2026-09-08 06:37): a jelveny rez szine
# BELEOLVADHAT a foto ala eso reszbe. Ez RENDERELT LAPON latszik, nem
# API-valaszon es nem is kiszamolt ertekben: a kontraszt a KEP tartalma ellen
# all, ami termekenkent mas.
#
# ES EZ MAS FAJTA KORLAT VOLT, MINT AMINEK LATSZOTT. Murena azt irta, hogy azert
# nem tudja megnezni, mert nincs kulcsa a bolthoz. A kulcs azota megvan, a korlat
# viszont MEGMARADT -- csak mas okbol: adat-hozzaferest kapott, ehhez pedig
# bongeszo kell. Ha csak annyit latunk, hogy "mar eleri a boltot", jogosan
# gondolnank, hogy atadhato. Nem az.
#
# A KEP NEM BIZONYITEK ONMAGABAN, es ezt ki kell mondani: azt mutatja meg, ami a
# felvetel PILLANATABAN es EZEN a szelessegen latszott. Ket kepet erdemes venni
# (telepites elott es utan), mert a kulonbseg tobbet mond, mint egyetlen kep.
if [ "${1:-}" = "--kep" ]; then
  KEP_URL="${2:?hasznalat: lap-szin.sh --kep <url> <fajl.png> [szelesseg]}"
  KEP_FAJL="${3:?hasznalat: lap-szin.sh --kep <url> <fajl.png> [szelesseg]}"
  KEP_SZEL="${4:-1440}"

  PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers" STAGE_AUTH_FILE="$STAGE_AUTH_FILE" \
  LAP_URL="$KEP_URL" LAP_FAJL="$KEP_FAJL" LAP_SZEL="$KEP_SZEL" timeout 180 node -e '
  const { chromium } = require("playwright")
  ;(async () => {
    const b = await chromium.launch()
    const p = await b.newPage({ httpCredentials: (() => { try { const [u, pw] = require("fs").readFileSync(process.env.STAGE_AUTH_FILE || "/home/marveen/marveen/store/.stage-basic-auth", "utf8").split("\n"); return u && pw ? { username: u, password: pw } : undefined } catch { return undefined } })(), viewport: { width: Number(process.env.LAP_SZEL), height: 1200 } })
    const valasz = await p.goto(process.env.LAP_URL, { waitUntil: "networkidle", timeout: 60000 })
    const allapot = valasz ? valasz.status() : 0
    if (allapot !== 200) {
      console.error(`HIBA: HTTP ${allapot} -- kepet nem mentek, mert az a hibalapot orokitene meg.`)
      await b.close(); process.exit(1)
    }
    // A lusta kepek csak gorgetesre toltodnek be. Enelkul a jelveny egy URES
    // helyen allna a kepen, es epp azt NEM latnank, amit merni akarunk.
    await p.evaluate(async () => {
      await new Promise((kesz) => {
        let y = 0
        const l = setInterval(() => {
          window.scrollBy(0, 600); y += 600
          if (y >= document.body.scrollHeight) { clearInterval(l); window.scrollTo(0, 0); kesz() }
        }, 60)
      })
    })
    await p.waitForTimeout(1200)
    await p.screenshot({ path: process.env.LAP_FAJL, fullPage: true })
    const vilag = await p.evaluate(() =>
      document.querySelector("[data-vilag]")?.getAttribute("data-vilag") ?? null)
    console.log(`--- lap-szin --kep   HTTP ${allapot}  data-vilag=${vilag}  szelesseg=${process.env.LAP_SZEL}`)
    console.log(`    cim:   ${await p.title()}`)
    console.log(`    mentve: ${process.env.LAP_FAJL}`)
    await b.close()
  })().catch((e) => { console.error("HIBA:", e.message); process.exit(2) })
  '
  exit $?
fi

URL="${1:?hasznalat: lap-szin.sh <url> [--valtozok|--dobozok]  |  lap-szin.sh --allit [sotet-url] [vilagos-url]  |  lap-szin.sh --kep <url> <fajl.png> [szelesseg]}"
MOD="${2:-mind}"
ROOT=/home/marveen/marveen

PLAYWRIGHT_BROWSERS_PATH="$ROOT/.playwright-browsers" \
LAP_URL="$URL" LAP_MOD="$MOD" timeout 120 node -e '
const { chromium } = require("playwright")
const url = process.env.LAP_URL
const mod = process.env.LAP_MOD

;(async () => {
  const b = await chromium.launch()
  const p = await b.newPage({ httpCredentials: (() => { try { const [u, pw] = require("fs").readFileSync(process.env.STAGE_AUTH_FILE || "/home/marveen/marveen/store/.stage-basic-auth", "utf8").split("\n"); return u && pw ? { username: u, password: pw } : undefined } catch { return undefined } })(), viewport: { width: 1440, height: 1000 } })
  const valasz = await p.goto(url, { waitUntil: "networkidle", timeout: 60000 })
  console.log(`--- lap-szin  ${url}`)
  console.log(`    HTTP ${valasz ? valasz.status() : "?"}   cim: ${await p.title()}`)

  const vilag = await p.evaluate(() =>
    document.querySelector("[data-vilag]")?.getAttribute("data-vilag") ?? null)
  console.log(`    data-vilag: ${vilag}`)

  // A FELOLDOTT TERV-TOKENEK. Nem a stiluslapbol olvassuk, hanem a bongeszotol
  // KERDEZZUK meg, mi az ertekuk EZEN a fan -- ez a kulonbseg a lenyeg.
  if (mod === "mind" || mod === "--valtozok") {
    const tokenek = await p.evaluate(() => {
      const el = document.querySelector("[data-vilag]") || document.documentElement
      const cs = getComputedStyle(el)
      const nevek = new Set()
      for (const lap of Array.from(document.styleSheets)) {
        let szabalyok
        try { szabalyok = lap.cssRules } catch { continue }
        for (const sz of Array.from(szabalyok || [])) {
          const t = sz.cssText || ""
          for (const m of t.matchAll(/(--terv-[a-z0-9-]+)\s*:/g)) nevek.add(m[1])
        }
      }
      const ki = {}
      for (const n of Array.from(nevek).sort()) ki[n] = cs.getPropertyValue(n).trim()
      return ki
    })
    console.log("\n    A FELOLDOTT TERV-TOKENEK EZEN A FAN:")
    const uresek = []
    for (const [n, v] of Object.entries(tokenek)) {
      if (v) console.log(`      ${n.padEnd(34)} ${v}`)
      else uresek.push(n)
    }
    // AZ URES ERTEK A LENYEGES ESET: a nev letezik a stiluslapban, de EZEN a fan nem
    // oldodik fel. Aki ilyet hasznal, csendben orokolt szint kap.
    if (uresek.length) {
      console.log("\n      NEM OLDODIK FEL EZEN A FAN (aki hasznalja, orokolt szint kap):")
      for (const n of uresek) console.log(`        ${n}`)
    }
  }

  if (mod === "mind" || mod === "--dobozok") {
    const dobozok = await p.evaluate(() =>
      Array.from(document.querySelectorAll("[data-vaz-szakasz]")).map((el) => {
        const h = el.querySelector("h2")
        const cs = getComputedStyle(el)
        return {
          kulcs: el.getAttribute("data-vaz-szakasz"),
          oszlop: el.getAttribute("data-vaz-oszlop"),
          cim: h ? (h.textContent || "").trim().slice(0, 48) : "",
          hatter: cs.backgroundColor,
          keret: cs.borderStyle,
        }
      }))
    console.log(`\n    A VAZ DOBOZAI (${dobozok.length}):`)
    for (const d of dobozok) {
      console.log(`      ${(d.kulcs || "").padEnd(18)} ${(d.oszlop || "").padEnd(8)} ${d.keret.padEnd(8)} ${d.cim}`)
    }
  }

  if (mod === "mind") {
    // A NEVESITETT ELEMEK KISZAMOLT SZINE. A lista szandekosan rovid: azok az elemek,
    // amikrol ma ejjel allitast tettunk. Ha egy elem NINCS a lapon, azt kiirjuk --
    // a hianyzo elem is valasz, es nem ugyanaz, mint egy rossz szin.
    const celok = [
      ["add-product-button", "Kosarba gomb"],
      ["unique-piece-badge", "Egyedi peldany jelveny"],
      ["unique-piece-promise", "Egyedi peldany igerete"],
      ["ragados-sav-ugras", "A lap alji sav gombja"],
      ["vaz-kerdezd-telefon", "A bolt telefonszama"],
    ]
    console.log("\n    NEVESITETT ELEMEK, KISZAMOLT SZINNEL:")
    for (const [tid, nev] of celok) {
      const adat = await p.evaluate((t) => {
        const el = document.querySelector(`[data-testid="${t}"]`)
        if (!el) return null
        const cs = getComputedStyle(el)
        return { szoveg: cs.color, hatter: cs.backgroundColor, sugar: cs.borderRadius }
      }, tid)
      if (!adat) { console.log(`      ${nev.padEnd(26)} NINCS A LAPON`); continue }
      console.log(`      ${nev.padEnd(26)} szoveg=${adat.szoveg}  hatter=${adat.hatter}  sugar=${adat.sugar}`)
    }
  }

  await b.close()
})().catch((e) => { console.error("HIBA:", e.message); process.exit(1) })
'
