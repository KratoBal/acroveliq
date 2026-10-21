#!/usr/bin/env python3
# ANSWERS: A V3 (friss munkamenet) tíz munkanapja alatt mennyibe kerültek a feladatok, és olcsóbb-e a friss indulás?
#
#   python3 scripts/token-tiz-nap.py                                    # 2026-10-13-tól máig
#   python3 scripts/token-tiz-nap.py --tol 2026-10-13 --ig 2026-10-24 --ki osszesito.md
#   python3 scripts/token-tiz-nap.py --json sorok.json                  # a feladatonkénti sorok gépnek
#
# Balázs 2026-10-13 05:25:20 UTC (Token szál, msg 1559436862664474737), 3. szabály: a tíz munkanapot a
# MEGLÉVŐ telemetriából mérjük, külön modellhívás nélkül. Ez a szkript csak olvas: GET /api/tasks,
# és feladatonként GET /api/tasks/<id>/usage és /timeline. A tokent a szerver feladatonként összesíti
# (task-usage.ts), ezért a /api/token-usage 500 soros vágása itt nem számít.
#
# Feladatonként: olvasott token (input + cache_read + cache_write), írt token (output), hívásszám,
# idő (az első és az utolsó esemény között), javítási körök (fix_started), elkészült-e (merged,
# deployed vagy done esemény), és hogy FRISS munkamenetben indult-e:
#   friss    van átadó rekordja ÉS a feladathoz bejegyzett munkamenete (agent-restart --task)
#   hosszú   egyik sincs
#   vegyes   csak az egyik
#
# A MÉRÉS KÉT VAKFOLTJA, amit a kimenet megszámol, és kivesz az összevetésből:
#   0 hívás    A feladat ablakában nincs hozzárendelt hívás. Leggyakoribb oka: az ágens munkamenete
#              egy KORÁBBI feladathoz van bejegyezve, és a bejegyzett munkamenet minden hívását a
#              szerver annak a feladatnak adja (task-usage.ts assignCalls). Így a folytatott, hosszú
#              munkamenetben futó feladatok nullát kapnak.
#   elnyelő    A feladat egy bejegyzett munkamenetének hívásai jóval túlnyúlnak a feladat utolsó
#              eseményén (TULNYULAS_MP): a feladat a későbbi munkát is magába vette, a száma felfújt.
# A kettő együtt azt jelenti, hogy a hosszú munkamenet olcsónak (0), a friss drágának látszana. Ezért
# az összevetés csak a mérhető feladatokon fut, és a kimenet kiírja, hány maradt ki és miért.
#
# Kilépés: 0 kész, 2 hibás hívás, 3 a vezérlőpult nem válaszolt.
import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
FEJLESZTOI = ('code_app', 'code_fleet', 'migration')
KESZ = ('merged', 'deployed', 'done')
TULNYULAS_MP = 30 * 60
MERET_HATAROK = ((1, 49, 'kicsi (1-49 hívás)'), (50, 149, 'közepes (50-149)'), (150, 10**9, 'nagy (150+)'))


def _nap_eleje(nap):
    return int(time.mktime(time.strptime(nap, '%Y-%m-%d')))


def olvasott(t):
    return t['input'] + t['cache_read'] + t['cache_write']


def feladat_sor(task, usage, timeline):
    """One task's row, from the three API answers. Pure: no I/O."""
    items = timeline.get('items', [])
    events = [i for i in items if i.get('source') == 'event']
    kinds = [e.get('kind') for e in events]
    handoff = any(i.get('source') == 'handoff' for i in items)
    session = any(i.get('source') == 'session' for i in items)
    tot = usage['totals']
    last_event = max((e['at'] for e in events), default=None)
    elnyelo = False
    if last_event is not None and usage.get('by_mode', {}).get('session'):
        for s in usage.get('by_session', {}).values():
            if s.get('last_call') and s['last_call'] > last_event + TULNYULAS_MP:
                elnyelo = True
    return {
        'id': task['id'],
        'assignee': task.get('assignee'),
        'profil': task.get('verification_profile'),
        'letrehozva': task.get('created_at'),
        'hivas': tot['calls'],
        'olvasott': olvasott(tot),
        'irt': tot['output'],
        'hivasonkent': (olvasott(tot) / tot['calls']) if tot['calls'] else None,
        'ido_mp': usage.get('duration_seconds'),
        'javitasi_kor': kinds.count('fix_started'),
        'kesz': any(k in KESZ for k in kinds),
        'mod': 'friss' if handoff and session else 'hosszú' if not handoff and not session else 'vegyes',
        'atado': handoff,
        'munkamenet': session,
        'ervenyes': bool(usage.get('valid', True)),
        'elnyelo': elnyelo,
    }


def meret(hivas):
    for lo, hi, nev in MERET_HATAROK:
        if lo <= hivas <= hi:
            return nev
    return None


def osszevetes(sorok):
    """Fresh against long, per size band, on the measurable rows only."""
    merheto = [s for s in sorok if s['hivas'] > 0 and not s['elnyelo'] and s['ervenyes']]
    ki = []
    for _lo, _hi, nev in MERET_HATAROK:
        for mod in ('friss', 'hosszú', 'vegyes'):
            csop = [s for s in merheto if meret(s['hivas']) == nev and s['mod'] == mod]
            if not csop:
                continue
            ki.append({
                'meret': nev,
                'mod': mod,
                'feladat': len(csop),
                'hivasonkent_median': statistics.median(s['hivasonkent'] for s in csop),
                'hivas_median': statistics.median(s['hivas'] for s in csop),
                'olvasott_osszes': sum(s['olvasott'] for s in csop),
                'irt_osszes': sum(s['irt'] for s in csop),
                'javitasi_kor_atlag': sum(s['javitasi_kor'] for s in csop) / len(csop),
                'kesz': sum(1 for s in csop if s['kesz']),
            })
    return ki


def _m(n):
    return '-' if n is None else f'{n / 1e6:.2f}M'


def _ido(mp):
    if mp is None:
        return '-'
    return f'{mp / 3600:.1f} ó' if mp >= 3600 else f'{mp / 60:.0f} p'


def jelentes(sorok, tol, ig, meres_ideje):
    """The markdown report. Pure."""
    fejl = [s for s in sorok if s['profil'] in FEJLESZTOI]
    nulla = [s for s in fejl if s['hivas'] == 0]
    elnyelo = [s for s in fejl if s['elnyelo']]
    ervenytelen = [s for s in fejl if not s['ervenyes']]
    merheto = [s for s in fejl if s['hivas'] > 0 and not s['elnyelo'] and s['ervenyes']]
    L = [
        f'# V3 tíz munkanap: feladatonkénti fogyasztás, {tol}..{ig}',
        '',
        f'Mérve: {meres_ideje} (scripts/token-tiz-nap.py, a meglévő telemetriából, modellhívás nélkül).',
        f'Olvasott token = input + cache_read + cache_write; írt = output. Fejlesztői profil: {", ".join(FEJLESZTOI)}.',
        '',
        '## Lefedettség (mielőtt bármelyik számot olvasod)',
        '',
        f'- feladat az időszakban: {len(sorok)}, ebből fejlesztői: {len(fejl)}',
        f'- mérhető (van hívás, nem elnyelő, érvényes): **{len(merheto)}**',
        f'- 0 hívás (a munkamenete másik feladathoz bejegyezve, vagy nem futott): {len(nulla)}',
        f'- elnyelő (bejegyzett munkamenete {TULNYULAS_MP // 60} percnél tovább túlnyúlik a feladaton, a száma felfújt): {len(elnyelo)}',
        f'- érvénytelen (munka-hívás két feladat ablakában): {len(ervenytelen)}',
        f'- mód a fejlesztőin: friss {sum(s["mod"] == "friss" for s in fejl)}, hosszú {sum(s["mod"] == "hosszú" for s in fejl)}, vegyes {sum(s["mod"] == "vegyes" for s in fejl)}',
        '',
        '## Friss kontra hosszú, hasonló méretben (csak a mérhetőkön)',
        '',
        '| méret | mód | feladat | olvasott/hívás (medián) | hívás (medián) | olvasott össz. | írt össz. | javítási kör (átlag) | kész |',
        '|---|---|---|---|---|---|---|---|---|',
    ]
    for g in osszevetes(fejl):
        L.append(f"| {g['meret']} | {g['mod']} | {g['feladat']} | {_m(g['hivasonkent_median'])} | {g['hivas_median']:.0f} | "
                 f"{_m(g['olvasott_osszes'])} | {_m(g['irt_osszes'])} | {g['javitasi_kor_atlag']:.2f} | {g['kesz']} |")
    L += [
        '',
        'Egy sávban 3-nál kevesebb feladat nem összevetés, csak eset.',
        '',
        '## Feladatonként (fejlesztői, létrehozás szerint)',
        '',
        '| feladat | ki | mód | hívás | olvasott | írt | olvasott/hívás | idő | jav. kör | kész | megjegyzés |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
    ]
    for s in sorted(fejl, key=lambda s: s['letrehozva'] or 0):
        megj = '0 hívás' if s['hivas'] == 0 else 'elnyelő' if s['elnyelo'] else '' if s['ervenyes'] else 'érvénytelen'
        L.append(f"| {s['id']} | {s['assignee'] or '-'} | {s['mod']} | {s['hivas']} | {_m(s['olvasott'])} | {_m(s['irt'])} | "
                 f"{_m(s['hivasonkent'])} | {_ido(s['ido_mp'])} | {s['javitasi_kor']} | {'igen' if s['kesz'] else 'nem'} | {megj} |")
    return '\n'.join(L) + '\n'


def _get(base, token, path):
    req = urllib.request.Request(base + path, headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main(argv=None):
    p = argparse.ArgumentParser(description='A V3 tíz munkanapjának összesítője.')
    p.add_argument('--tol', default='2026-10-13')
    p.add_argument('--ig', default=time.strftime('%Y-%m-%d'))
    p.add_argument('--ki', default='-')
    p.add_argument('--json', default=None)
    a = p.parse_args(argv)
    try:
        tol, ig = _nap_eleje(a.tol), _nap_eleje(a.ig) + 86400
    except ValueError:
        print('FAIL: a --tol és az --ig ÉÉÉÉ-HH-NN', file=sys.stderr)
        return 2
    if ig <= tol:
        print('FAIL: az --ig nem lehet korábbi a --tol-nál', file=sys.stderr)
        return 2
    sys.path.insert(0, os.path.join(HERE, 'lib'))
    from dashboard_token import read_token
    # the install whose store/tokens holds the caller's token (CLAW_DIR, like fleet.py); default: this checkout
    token = read_token(os.environ.get('CLAW_DIR', os.path.dirname(HERE)))
    base = os.environ.get('CLAW_BASE', 'http://localhost:' + os.environ.get('MARVEEN_WEB_PORT', '3420')).rstrip('/')
    try:
        tasks = [t for t in _get(base, token, '/api/tasks') if tol <= (t.get('created_at') or 0) < ig]
        sorok = []
        for t in tasks:
            tid = urllib.request.quote(t['id'], safe='')
            sorok.append(feladat_sor(t, _get(base, token, f'/api/tasks/{tid}/usage'), _get(base, token, f'/api/tasks/{tid}/timeline')))
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f'FAIL: a vezérlőpult nem válaszolt: {e}', file=sys.stderr)
        return 3
    szoveg = jelentes(sorok, a.tol, a.ig, time.strftime('%Y-%m-%d %H:%M %z'))
    if a.ki == '-':
        sys.stdout.write(szoveg)
    else:
        with open(a.ki, 'w', encoding='utf-8') as f:
            f.write(szoveg)
        print(f'OK {a.ki}: {len(sorok)} feladat')
    if a.json:
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump(sorok, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
