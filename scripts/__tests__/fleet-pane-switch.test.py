#!/usr/bin/env python3
"""scripts/lib/fleet_pane_switch.py reads FLEET_PANE_BROKER the way src/config.ts does.

WHAT TURNS THIS RED: the shell tools and the router disagree about the switch, i.e. one of
  - store/config-overrides.json (non-empty) does not win over .env;
  - an empty or null override does not fall through to .env;
  - .env quoting, surrounding spaces, comments or the last-one-wins rule (src/env.ts) differ;
  - anything but `on` (any case) counts as on, or a missing file is not off.
Run: python3 -B <thisfile>   Exit 0 = all pass.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(os.path.dirname(HERE), 'lib', 'fleet_pane_switch.py')
FAILS = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  -- {detail}'))
    if not ok:
        FAILS.append(name)


def case(env_text=None, overrides=None):
    root = tempfile.mkdtemp(prefix='fp-switch-')
    os.makedirs(os.path.join(root, 'store'))
    if env_text is not None:
        with open(os.path.join(root, '.env'), 'w', encoding='utf-8') as f:
            f.write(env_text)
    if overrides is not None:
        with open(os.path.join(root, 'store', 'config-overrides.json'), 'w', encoding='utf-8') as f:
            f.write(overrides if isinstance(overrides, str) else json.dumps(overrides))
    r = subprocess.run([sys.executable, '-I', LIB, root], capture_output=True, text=True)
    shutil.rmtree(root)
    return r.returncode, r.stdout.strip()


for name, kw, want in [
    ('no files: off', {}, 'off'),
    ('.env on', {'env_text': 'FLEET_PANE_BROKER=on\n'}, 'on'),
    ('.env ON, quoted, spaced', {'env_text': '  FLEET_PANE_BROKER = "ON"  \n'}, 'on'),
    ('.env commented out', {'env_text': '# FLEET_PANE_BROKER=on\n'}, 'off'),
    ('.env last one wins', {'env_text': 'FLEET_PANE_BROKER=on\nFLEET_PANE_BROKER=off\n'}, 'off'),
    ('.env other value', {'env_text': 'FLEET_PANE_BROKER=1\n'}, 'off'),
    ('.env no trailing newline', {'env_text': 'X=1\nFLEET_PANE_BROKER=on'}, 'on'),
    ('override wins over .env', {'env_text': 'FLEET_PANE_BROKER=on\n', 'overrides': {'FLEET_PANE_BROKER': 'off'}}, 'off'),
    ('override on, no .env', {'overrides': {'FLEET_PANE_BROKER': 'on'}}, 'on'),
    ('empty override falls through', {'env_text': 'FLEET_PANE_BROKER=on\n', 'overrides': {'FLEET_PANE_BROKER': ''}}, 'on'),
    ('null override falls through', {'env_text': 'FLEET_PANE_BROKER=on\n', 'overrides': {'FLEET_PANE_BROKER': None}}, 'on'),
    ('broken overrides file falls through', {'env_text': 'FLEET_PANE_BROKER=on\n', 'overrides': '{not json'}, 'on'),
]:
    rc, out = case(**kw)
    check(name, (out, rc) == (want, 0 if want == 'on' else 1), f'got {out!r} rc={rc}')

print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
