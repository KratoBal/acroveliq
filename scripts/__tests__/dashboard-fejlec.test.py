#!/usr/bin/env python3
"""scripts/dashboard-fejlec.sh: the header a skill presents is the caller's OWN token (P0-1).

WHAT TURNS THIS RED:
  1. with an own token for the calling user, the header carries the shared one;
  2. without one, the header is empty or the fallback is silent (no stderr line);
  3. an empty or missing token gives a header with no token, or exit 0;
  4. the token appears on stderr;
  5. the Sutyerak gateway's handoff token file is the shared one again, or its URL moved.
Run: python3 -B <thisfile>   Exit 0 = all pass. Runs with a fake FLEET_ROOT, no real token.
"""
import getpass
import json
import os
import pwd
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(REPO, 'scripts', 'dashboard-fejlec.sh')
FAILS = []


def check(name, ok, detail=''):
    print(('ok   ' if ok else 'FAIL ') + name + ('' if ok else f'  -- {detail}'))
    if not ok:
        FAILS.append(name)


def fake_root(own=None, shared='KOZOS-PROBA-TOKEN', mapped=True):
    root = tempfile.mkdtemp(prefix='fejlec-')
    os.makedirs(os.path.join(root, 'scripts', 'lib'))
    shutil.copy(os.path.join(REPO, 'scripts', 'lib', 'dashboard-token.sh'), os.path.join(root, 'scripts', 'lib'))
    os.makedirs(os.path.join(root, 'store', 'tokens'))
    os.makedirs(os.path.join(root, 'agents', 'probaagens'))
    me = pwd.getpwuid(os.geteuid()).pw_name
    with open(os.path.join(root, 'agents', 'probaagens', 'agent-config.json'), 'w') as f:
        json.dump({'runAsUser': me if mapped else 'nem-letezo-user'}, f)
    if shared is not None:
        with open(os.path.join(root, 'store', '.dashboard-token'), 'w') as f:
            f.write(shared)
    if own is not None:
        with open(os.path.join(root, 'store', 'tokens', 'probaagens.token'), 'w') as f:
            f.write(own)
    return root


def run(root):
    env = dict(os.environ, FLEET_ROOT=root)
    r = subprocess.run(['bash', SCRIPT], env=env, capture_output=True, text=True, timeout=30)
    return r.returncode, r.stdout, r.stderr


print('1. an own token: the header carries it, silently')
root = fake_root(own='SAJAT-PROBA-TOKEN')
rc, out, err = run(root)
check('exit 0', rc == 0, err)
check('the own token', out == 'Authorization: Bearer SAJAT-PROBA-TOKEN\n', repr(out))
check('no fallback line', 'shared token' not in err, err)
check('no token on stderr', 'PROBA-TOKEN' not in err, err)
shutil.rmtree(root)

print('2. no own token: the shared one, loudly')
root = fake_root(own=None, mapped=False)
rc, out, err = run(root)
check('exit 0', rc == 0, err)
check('the shared token', out == 'Authorization: Bearer KOZOS-PROBA-TOKEN\n', repr(out))
check('the fallback is said on stderr', 'shared token' in err, err)
check('no token on stderr', 'PROBA-TOKEN' not in err, err)
shutil.rmtree(root)

print('3. an empty own token falls back; nothing readable at all fails')
root = fake_root(own='')
rc, out, err = run(root)
check('empty own: the shared one, loudly', out == 'Authorization: Bearer KOZOS-PROBA-TOKEN\n' and 'shared token' in err, repr(out) + err)
shutil.rmtree(root)
root = fake_root(own=None, shared=None, mapped=False)
rc, out, err = run(root)
check('nothing readable: exit 1, no header', rc == 1 and out == '', f'rc={rc} out={out!r}')
shutil.rmtree(root)
root = fake_root(own=None, shared='', mapped=False)
rc, out, err = run(root)
check('empty shared: exit 1, no header', rc == 1 and out == '', f'rc={rc} out={out!r}')
shutil.rmtree(root)

print('4. the fleet-helper (seed-skills/fleet-helper/scripts/fleet.py) presents the same own token')
root = fake_root(own='SAJAT-PROBA-TOKEN')
shutil.copy(os.path.join(REPO, 'scripts', 'lib', 'dashboard_token.py'), os.path.join(root, 'scripts', 'lib'))
probe = ("import importlib.util,sys;"
         "s=importlib.util.spec_from_file_location('fleet',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
         "print(m.token())")
r = subprocess.run([sys.executable, '-B', '-c', probe, os.path.join(REPO, 'seed-skills', 'fleet-helper', 'scripts', 'fleet.py')],
                   env=dict(os.environ, CLAW_DIR=root), capture_output=True, text=True, timeout=30)
check('fleet.py token() is the own token', r.stdout.strip() == 'SAJAT-PROBA-TOKEN', r.stdout + r.stderr)
shutil.rmtree(root)

print('5. the Sutyerak gateway posts its handoff with the main agent\'s OWN token, not the shared one (p01-legacy-uzenet-hivo)')
GW_PROBE = ("import importlib.util,sys,os;"
            "os.environ['SUTYERAK_STATE']=sys.argv[2];"
            "s=importlib.util.spec_from_file_location('gw',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            "e=m.mcp_env({'threadId':'t1'},{'token':'x','user':{'id':'u1','name':'n'}});"
            "print(e['SUTYERAK_HANDOFF_TOKEN_FILE']);print(e['SUTYERAK_HANDOFF_URL'])")


def gateway_env(own):
    root = fake_root(own=own)
    os.makedirs(os.path.join(root, 'sutyerak'))
    shutil.copy(os.path.join(REPO, 'sutyerak', 'gateway.py'), os.path.join(root, 'sutyerak'))
    shutil.copy(os.path.join(REPO, 'scripts', 'lib', 'dashboard_token.py'), os.path.join(root, 'scripts', 'lib'))
    state = tempfile.mkdtemp(prefix='sutyerak-state-')
    r = subprocess.run([sys.executable, '-B', '-c', GW_PROBE, os.path.join(root, 'sutyerak', 'gateway.py'), state],
                       capture_output=True, text=True, timeout=30)
    shutil.rmtree(state)
    return root, r


root, r = gateway_env('SAJAT-PROBA-TOKEN')
lines = r.stdout.split()
check('the handoff token file is the own token file', lines[:1] == [os.path.join(root, 'store', 'tokens', 'probaagens.token')], r.stdout + r.stderr)
check('the handoff URL is unchanged', lines[1:] == ['http://localhost:3420/api/messages'], r.stdout)
check('no fallback line with an own token', 'shared token' not in r.stderr, r.stderr)
shutil.rmtree(root)
root, r = gateway_env(None)
check('no own token: the shared file, and the fallback is said on stderr',
      r.stdout.split()[:1] == [os.path.join(root, 'store', '.dashboard-token')] and 'shared token' in r.stderr, r.stdout + r.stderr)
shutil.rmtree(root)

print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
