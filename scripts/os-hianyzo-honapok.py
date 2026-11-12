#!/usr/bin/env python3
"""ANSWERS: Mit mond az eles OS SAJAT itelete a honap banki terheleseirol (talalt, hianyzo eredeti, nem parosodott,
nem kell szamla)? Ugyanaz a szamitas, amit Balazs a Hianyzo szamlak lapon lat.

Murena 2026-10-21 (34723): a napi ellenorzes eddig a BankTransactionMatch tablat szamolta, ami csak a kezi parositast
tarolja; az automatikus parositas es a "nem kell szamla" besorolas olvasaskor szamolodik. Ezert a szamot az app
GET /missing-invoices/months vegpontjarol vesszuk, a flotta OS-fiokjaval (flotta@acropora.hu, a jelszo
store/.os-flotta-jelszo, 0600). Csak olvas: egy bejelentkezes es egy GET, a session sutit nem menti sehova.

  python3 /home/marveen/marveen/scripts/os-hianyzo-honapok.py            # nyers JSON a stdout-on
  python3 /home/marveen/marveen/scripts/os-hianyzo-honapok.py suggestions  # a dontesre varo PDF-javaslatok (finance.view)

A MASODIK ALAK (card 5f8a2714): a napi ellenorzes a javaslat-lista `staleCount` mezojet is kiirja (a 60 napnal regebben
dontesre varo UNASSIGNED PDF-ek szama, acropora-os #1833). Ugyanaz a bejelentkezes, ugyanaz a fiok, egy masik GET; a vegpont
NEVE egy szuk listabol jon (months, suggestions), nem a hivo szovegebol: ez a szkript nem altalanos GET-eszkoz.
"""
import http.cookiejar
import json
import sys
import urllib.request

# the endpoint comes from this list by NAME, never from the caller's text: two read-only lists of the Missing invoices page
ENDPOINTS = {'months': '/missing-invoices/months', 'suggestions': '/missing-invoices/suggestions'}
NAME = sys.argv[1] if len(sys.argv) > 1 else 'months'
if NAME not in ENDPOINTS:
    print(f'HIBA: ismeretlen vegpont-nev ({", ".join(ENDPOINTS)})', file=sys.stderr)
    sys.exit(64)

BASE = 'https://api.acropora.hu'
EMAIL = 'flotta@acropora.hu'
PASSWORD = open('/home/marveen/marveen/store/.os-flotta-jelszo', encoding='utf-8').read().strip()

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
login = urllib.request.Request(BASE + '/auth/login/password', data=json.dumps({'email': EMAIL, 'password': PASSWORD}).encode(),
                               headers={'Content-Type': 'application/json'}, method='POST')
try:
    opener.open(login, timeout=30).read()
    with opener.open(urllib.request.Request(BASE + ENDPOINTS[NAME], headers={'Accept': 'application/json'}), timeout=60) as r:
        sys.stdout.write(r.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print(f'HIBA: HTTP {e.code} ({e.url.replace(BASE, "")})', file=sys.stderr)
    sys.exit(2)
