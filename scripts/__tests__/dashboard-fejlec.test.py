#!/usr/bin/env python3
"""scripts/dashboard-fejlec.sh: the header a skill presents is the caller's OWN token (P0-1).

WHAT TURNS THIS RED:
  1. with an own token for the calling user, the header carries the shared one;
  2. without one, the header is empty or the fallback is silent (no stderr line);
  3. an empty or missing token gives a header with no token, or exit 0;
  4. the token appears on stderr;
  6. an agent whose own token is missing or empty quietly gets the shared one again, or the install's owner without
     MAIN_AGENT_ID in .env is guessed as "marveen"; or a non-agent caller (root, cron) stops getting the loud shared
     fallback (P0-1, p01-legacy-uzenet-hivo);
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


def fake_root(own=None, shared='KOZOS-PROBA-TOKEN', mapped=True, env=None):
    root = tempfile.mkdtemp(prefix='fejlec-')
    os.makedirs(os.path.join(root, 'scripts', 'lib'))
    shutil.copy(os.path.join(REPO, 'scripts', 'lib', 'dashboard-token.sh'), os.path.join(root, 'scripts', 'lib'))
    os.makedirs(os.path.join(root, 'store', 'tokens'))
    os.makedirs(os.path.join(root, 'agents', 'probaagens'))
    me = pwd.getpwuid(os.geteuid()).pw_name
    with open(os.path.join(root, 'agents', 'probaagens', 'agent-config.json'), 'w') as f:
        json.dump({'runAsUser': me if mapped else 'nem-letezo-user'}, f)
    if env is not None:
        with open(os.path.join(root, '.env'), 'w') as f:
            f.write(env)
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


def run_as_stranger(root):
    """The header script as a process that is neither an agent's user nor the install's owner (root, cron).

    The owner test is a function of its own in the resolver; the probe sources the resolver and redefines it, so
    the test needs no other OS user."""
    probe = ('. "$1/scripts/lib/dashboard-token.sh"; _dashboard_token_owns() { return 1; }; '
             'f="$(dashboard_token_file "$1")" || exit 1; [ -s "$f" ] || exit 1; printf "Authorization: Bearer %s\\n" "$(cat "$f")"')
    r = subprocess.run(['bash', '-c', probe, '_', root], capture_output=True, text=True, timeout=30)
    return r.returncode, r.stdout, r.stderr


print('1. an own token: the header carries it, silently')
root = fake_root(own='SAJAT-PROBA-TOKEN')
rc, out, err = run(root)
check('exit 0', rc == 0, err)
check('the own token', out == 'Authorization: Bearer SAJAT-PROBA-TOKEN\n', repr(out))
check('no fallback line', 'shared token' not in err, err)
check('no token on stderr', 'PROBA-TOKEN' not in err, err)
shutil.rmtree(root)

print('2. an agent (runAsUser) without an own token: an error, NOT the shared one')
root = fake_root(own=None)
rc, out, err = run(root)
check('exit 1, no header', rc == 1 and out == '', f'rc={rc} out={out!r}')
check('the error says the shared token is not used', 'NOT used for an agent' in err, err)
check('no token on stderr', 'PROBA-TOKEN' not in err, err)
shutil.rmtree(root)

print('2b. a caller that is no agent (root, cron, an unknown user): the shared one, loudly')
root = fake_root(own=None, mapped=False)
rc, out, err = run_as_stranger(root)
check('exit 0', rc == 0, err)
check('the shared token', out == 'Authorization: Bearer KOZOS-PROBA-TOKEN\n', repr(out))
check('the fallback is said on stderr', 'using the shared token' in err, err)
check('no token on stderr', 'PROBA-TOKEN' not in err, err)
shutil.rmtree(root)

print('3. an empty own token is an error; nothing readable at all fails')
root = fake_root(own='')
rc, out, err = run(root)
check('empty own: exit 1, no header, NOT the shared one', rc == 1 and out == '' and 'NOT used for an agent' in err, repr(out) + err)
shutil.rmtree(root)
root = fake_root(own=None, shared=None, mapped=False, env='MAIN_AGENT_ID=probaagens\n')
rc, out, err = run(root)
check('nothing readable: exit 1, no header', rc == 1 and out == '', f'rc={rc} out={out!r}')
shutil.rmtree(root)
root = fake_root(own=None, shared='', mapped=False)
rc, out, err = run_as_stranger(root)
check('empty shared (no agent): exit 1, no header', rc == 1 and out == '', f'rc={rc} out={out!r}')
shutil.rmtree(root)

print('3b. the install\'s owner: .env names the main agent, or the call fails (no guessed "marveen")')
root = fake_root(own='SAJAT-PROBA-TOKEN', mapped=False, env='MAIN_AGENT_ID=probaagens\n')
rc, out, err = run(root)
check('MAIN_AGENT_ID in .env: the main agent\'s own token', rc == 0 and out == 'Authorization: Bearer SAJAT-PROBA-TOKEN\n', f'rc={rc} out={out!r} {err}')
shutil.rmtree(root)
root = fake_root(own='SAJAT-PROBA-TOKEN', mapped=False)
rc, out, err = run(root)
check('no .env: exit 1, no header, the reason said', rc == 1 and out == '' and 'MAIN_AGENT_ID' in err and 'refusing to guess' in err, f'rc={rc} out={out!r} {err}')
shutil.rmtree(root)
root = fake_root(own='SAJAT-PROBA-TOKEN', mapped=False, env='# nothing here\nOTHER=1\n')
rc, out, err = run(root)
check('.env without MAIN_AGENT_ID: the same error', rc == 1 and out == '' and 'refusing to guess' in err, f'rc={rc} out={out!r} {err}')
shutil.rmtree(root)

print('3c. the Python resolver follows the same three cases')
PY_PROBE = ("import os,sys;sys.path.insert(0,os.path.join(sys.argv[1],'scripts','lib'));"
            "import dashboard_token as d;"
            "mode=sys.argv[2];"
            "d.os.geteuid=(lambda:424242) if mode=='stranger' else d.os.geteuid;"
            "\ntry:\n print(d.token_file(sys.argv[1], 'agent-x' if mode=='stranger' else None));print('rt='+repr(d.read_token(sys.argv[1], 'agent-x' if mode=='stranger' else None)))\n"
            "except d.DashboardTokenError as e:\n print('ERR');sys.exit(3)")


def py_resolver(root, mode):
    shutil.copy(os.path.join(REPO, 'scripts', 'lib', 'dashboard_token.py'), os.path.join(root, 'scripts', 'lib'))
    return subprocess.run([sys.executable, '-B', '-c', PY_PROBE, root, mode], capture_output=True, text=True, timeout=30)


root = fake_root(own=None)
r = py_resolver(root, 'agent')
check('python: an agent without an own token raises, never the shared path',
      r.returncode == 3 and 'ERR' in r.stdout and '.dashboard-token' not in r.stdout and 'NOT used for an agent' in r.stderr, r.stdout + r.stderr)
shutil.rmtree(root)
root = fake_root(own='SAJAT-PROBA-TOKEN')
r = py_resolver(root, 'agent')
check('python: the own token', os.path.join(root, 'store', 'tokens', 'probaagens.token') in r.stdout and "rt='SAJAT-PROBA-TOKEN'" in r.stdout, r.stdout + r.stderr)
shutil.rmtree(root)
root = fake_root(own=None, mapped=False)
r = py_resolver(root, 'agent')
check('python: the install\'s owner without MAIN_AGENT_ID raises', r.returncode == 3 and 'refusing to guess' in r.stderr, r.stdout + r.stderr)
shutil.rmtree(root)
root = fake_root(own=None, mapped=False)
r = py_resolver(root, 'stranger')
check('python: a stranger (not an agent, not the owner) gets the shared path, loudly',
      os.path.join(root, 'store', '.dashboard-token') in r.stdout and 'using the shared token' in r.stderr, r.stdout + r.stderr)
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
check('no own token: the handoff is switched off (empty path), the shared token is NOT handed out, the reason is said on stderr',
      r.returncode == 0 and r.stdout.split('\n')[0] == '' and '.dashboard-token' not in r.stdout and 'NOT used for an agent' in r.stderr,
      r.stdout + r.stderr)
shutil.rmtree(root)

print()
print('FAILED: ' + ', '.join(FAILS) if FAILS else 'all passed')
sys.exit(1 if FAILS else 0)
