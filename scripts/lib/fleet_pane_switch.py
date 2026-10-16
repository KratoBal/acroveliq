#!/usr/bin/env python3
"""Is the fleet-pane broker switch on? The router's own rule, for the shell tools.

  python3 -I scripts/lib/fleet_pane_switch.py <project-root>   -> prints on|off, exit 0 on, 1 off

The router reads FLEET_PANE_BROKER through src/config.ts: store/config-overrides.json first (when
the value is non-empty), then .env, default off. The shell tools that reach agent panes
(agent-pane.sh, feladat-keret-or.sh, fleet-doctor.py, agent-to-own-user.sh) must take the SAME
road as the router: once the owner retires the tmux line, a tool still on the old line just
fails, and before that a tool on the broker would bypass the stage-first order (B48 (2),
docs/fleet-pane.md). Read the same way, twice, so the two cannot disagree by being written apart.
"""
import json
import os
import sys

BIN = '/usr/local/sbin/fleet-pane'


def _env_file_value(path, key):
    try:
        with open(path, encoding='utf-8') as f:
            lines = f.read().split('\n')
    except OSError:
        return None
    value = None
    for line in lines:
        t = line.strip()
        if not t or t.startswith('#') or '=' not in t:
            continue
        k, v = t.split('=', 1)
        if k.strip() != key:
            continue
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in '"\'':
            v = v[1:-1]
        value = v  # the last one wins, as in src/env.ts
    return value


def broker_on(root):
    raw = None
    try:
        with open(os.path.join(root, 'store', 'config-overrides.json'), encoding='utf-8') as f:
            ov = json.load(f)
        v = ov.get('FLEET_PANE_BROKER') if isinstance(ov, dict) else None
        if v is not None and str(v) != '':
            raw = str(v)
    except (OSError, ValueError):
        pass
    if raw is None:
        raw = _env_file_value(os.path.join(root, '.env'), 'FLEET_PANE_BROKER')
    return (raw or 'off').strip().lower() == 'on'


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.stderr.write('usage: fleet_pane_switch.py <project-root>\n')
        sys.exit(2)
    on = broker_on(sys.argv[1])
    print('on' if on else 'off')
    sys.exit(0 if on else 1)
