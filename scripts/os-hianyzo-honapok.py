#!/usr/bin/env python3
"""ANSWERS: Mit mond az eles OS SAJAT itelete a honap banki terheleseirol (talalt, hianyzo eredeti, nem parosodott,
nem kell szamla)? Ugyanaz a szamitas, amit Balazs a Hianyzo szamlak lapon lat.

Murena 2026-10-21 (34723): a napi ellenorzes eddig a BankTransactionMatch tablat szamolta, ami csak a kezi parositast
tarolja; az automatikus parositas es a "nem kell szamla" besorolas olvasaskor szamolodik. Ezert a szamot az app
GET /missing-invoices/months vegpontjarol vesszuk, a flotta OS-fiokjaval (flotta@acropora.hu, a jelszo
store/.os-flotta-jelszo, 0600). Csak olvas: egy bejelentkezes es egy GET, a session sutit nem menti sehova.

  python3 /home/marveen/marveen/scripts/os-hianyzo-honapok.py            # nyers JSON a stdout-on
"""
import http.cookiejar
import json
import sys
import urllib.request

BASE = 'https://api.acropora.hu'
EMAIL = 'flotta@acropora.hu'
PASSWORD = open('/home/marveen/marveen/store/.os-flotta-jelszo', encoding='utf-8').read().strip()

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
login = urllib.request.Request(BASE + '/auth/login/password', data=json.dumps({'email': EMAIL, 'password': PASSWORD}).encode(),
                               headers={'Content-Type': 'application/json'}, method='POST')
try:
    opener.open(login, timeout=30).read()
    with opener.open(urllib.request.Request(BASE + '/missing-invoices/months', headers={'Accept': 'application/json'}), timeout=60) as r:
        sys.stdout.write(r.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print(f'HIBA: HTTP {e.code} ({e.url.replace(BASE, "")})', file=sys.stderr)
    sys.exit(2)
