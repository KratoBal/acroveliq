# The GPT runner container (variant B)

Balázs's decision (2026-10-14 16:38 UTC, Acroveliq thread, message 1559968751112167476):
- the GPT runner gets **a container of its own**, not the fleet's;
- the environment and the Codex install are approved **with six conditions**;
- the ChatGPT login and any credential are **not** approved yet.

The plan this follows: `exchange/acroveliq/gpt-futtato-elkulonites-terv-2026-10-14.md` (point 1: the checks, point 4: variant B).

**What this PR does:** it defines the container and the probe that proves its isolation. That is all the container does: it runs the probe once, writes the result to its log, and stops. The GPT side stays off (condition 6). There is no login, no `auth.json`, no secret, and no channel to the fleet.

## What the container is

| Condition (Balázs) | Where it is |
|---|---|
| 1. No fleet file, volume, credential or internal service | `compose.yaml`: no bind mount, no `secrets:`, no docker socket, no host port. One network, `gpt-futtato-ki`, outward only, which no fleet container joins. The only volume is its own empty `gpt-futtato-codex-home`. |
| 2. Not root, least privilege, resource limits | `user: 10002:10002` (not root; not 1000, which is marveen on the host and the image's `node`); `cap_drop: ALL`; `no-new-privileges`; `read_only: true` with a tmpfs `/tmp`; `pids_limit: 128`, `mem_limit: 512m`, `cpus: 1.0`. |
| 3. Network isolation by real negative tests | probe N1: TCP to the dashboard's and the usual internal ports on the gateway, on the fleet container's addresses and on the fleet's names, all must fail, **while the control (api.openai.com:443) answers**. Without the control the line is NEM_MERHETO, not OK. |
| 4. Codex's command and network abilities measured on the installed version | probe VER (the pinned version), V2 (a network attempt and a write attempt **inside `codex sandbox`**, with a marker that tells "the sandbox never started the command" from "it ran and was blocked"), V3 (the shell tool cannot be switched off without a logged-in model: NEM_MERHETO until the login; the `codex exec --help` flags go into the log). |
| 5. No general execution or file access to the fleet | probes F1 (the fleet's paths do not exist), F2 (every readable file is on a system path; the walk must find its own canary), H1 (no credential), V1 (no sudo, no tmux socket), G0 (no fleet uid or group), CAP (no capability, no_new_privs). |
| 6. The GPT side stays off | the image's only command is the probe; `restart: "no"`. |

**Codex version:**
- **0.159.3**, pinned in `package.json` and `package-lock.json`, with integrity hashes.
- Why this one: it is the newest release that was at least two weeks old on 2026-10-14 (released 2026-09-30).
- A change of version means a new probe run, because V2 is valid for one version only.

**Expected V2 result:**
- The vendor's sandbox on Linux is bubblewrap + seccomp in a new user namespace (the openai/codex repo, `codex-rs/linux-sandbox/README.md`).
- Docker's default seccomp profile and `cap_drop: ALL` usually block creating one.
- So V2 may well come out as **"the sandbox never started the command"**. That is a measurement, not a failure of the probe.
- It means the container is the isolation, not Codex's sandbox. What `codex exec` then does with a command (refuses or runs it unsandboxed) can only be measured with a logged-in model. That measurement is part of the activation step, not this one.

## Probe output

One line per check:

```
PROBA <id> <OK|FAIL|NEM_MERHETO> <detail>
PROBA-NAPLO <what> <text>          (help texts, raw sandbox outputs)
OSSZESITES ok=<n> fail=<n> nem_merheto=<n>
```

- The exit code is 1 when any line is FAIL.
- NEM_MERHETO means that the check could not prove anything, and it says why (e.g. no control). It is **never** counted as OK.

## Install on the host (the owner, as root; nothing here is run by the fleet)

```
/opt/gpt-futtato/            root:root 755
  compose.yaml               copy of gpt-runner/compose.yaml, root 644
  .env                       root 644, two lines (see below)
  src/                       git clone of KratoBal/marveen at the reviewed commit, root-owned
```

```
# 0. uid 10002 must not be a user on the host (the volume files belong to it)
getent passwd 10002                       # empty

# 1. the pinned base image and the fleet container's addresses for the N1 test
docker buildx imagetools inspect node:22-bookworm-slim        # the "Digest:" line
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}},{{end}}' <the fleet container>
cat > /opt/gpt-futtato/.env <<'EOF'
GPT_FUTTATO_NODE_IMAGE=node:22-bookworm-slim@sha256:<digest>
GPT_FUTTATO_FLOTTA_CIMEK=<the addresses from the line above, comma separated>
EOF

# 2. build and run the probe once
cd /opt/gpt-futtato && docker compose build && docker compose up
docker logs gpt-futtato

# 3. the configuration side, for the PR record (the probe is the proof, this is the cross-check)
docker inspect gpt-futtato --format '{{json .Mounts}} {{json .HostConfig.CapDrop}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.SecurityOpt}} {{.Config.User}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}} {{json .NetworkSettings.Networks}}'
```

The expected `docker inspect` values:
- `Mounts`: only the `gpt-futtato-codex-home` volume and the tmpfs;
- `CapDrop`: `["ALL"]`;
- `ReadonlyRootfs`: `true`;
- `SecurityOpt`: `["no-new-privileges:true"]`;
- `User`: `10002:10002`;
- `Memory`: 536870912, `PidsLimit`: 128, `NanoCpus`: 1000000000;
- `Networks`: only `gpt-futtato-ki`.

## The host firewall (after the first live run)

**The first live run** (2026-10-14 17:50 UTC, commit 710b1e01): `ok=8 fail=2 nem_merheto=3`. The two FAILs:

- **F2: `/.dockerenv`.** This is Docker's own empty marker file, a false hit. It is now allowed by exact path (`SYSTEM_EXACT`), not as a prefix.
- **N1: `10.0.5.1:8000` answered.** That address is the gateway of `gpt-futtato-ki`, which is the host itself. **A bridge network alone does not close the host's services**, and that is a real gap against conditions 1 and 3.

**The fix, on the host** (`host/`):
- `compose.yaml`: the network gets a fixed bridge name, `gptki0`, so the rules apply to a stable interface.
- `host/tuzfal.sh` (root, idempotent): everything from `gptki0` to the host (INPUT, every address and port of the host) is DROPped. Everything from `gptki0` to the private ranges is DROPped too, in DOCKER-USER. That second rule matters because a published port is DNAT-ed to a container address, so INPUT never sees it. The ranges: 10/8, 172.16/12, 192.168/16, the tailnet 100.64/10, and link-local 169.254/16 (cloud metadata). Outward traffic to public addresses is untouched.
- `host/gpt-futtato-tuzfal.service`: it runs the script at boot (`multi-user.target`) and on every docker start and restart (`WantedBy`/`PartOf=docker.service`). Balázs's standing order (2026-10-13): no step is repeated by hand.
- `host/gpt-futtato-tuzfal-ellenor.timer` + `.service`: **every minute** it runs the same script. The script now makes sure our jumps are the **first** rule of INPUT and DOCKER-USER, exactly once, not just present. Our own chains are refilled only when they differ, so there is no instant with an empty chain. It writes only on a difference, with one journal line (`VISSZATETTE: ...`). This is because a ufw or firewalld reload can drop our jumps or put them behind its own chains, and the boot unit does not run again then (the host-firewall run printed: ufw runs; acrobot, 30821). The installer measures the timer in one round: it puts a rule above our INPUT jump and removes the DOCKER-USER jump, and within 90 s both must be back, with the journal line. **How the script writes (acrobot and barracuda, #144):** every iptables call waits for the xtables lock (`-w 5`), so a busy lock does not stop the script half way. A chain is never flushed: missing rules are added first and extra ones removed after, so every state in between drops at least as much as the final one. A misplaced jump gets its new copy at the top before the old copy is removed. **Before the reload** (acrobot, 30825), `host/ufw-elo-mentett.sh` compares the running `ufw-user-*` rules with `/etc/ufw/user.rules` and `user6.rules`. If a rule lives only in the running state, or the comparison cannot be made, the installer stops without reloading and prints the difference. Then it saves `iptables-save` and `ip6tables-save` to root-only files (`/opt/gpt-futtato/ip*tables-elotte.rules`, 600) for a restore. **Then a real `ufw reload`** (acrobot, 30822) runs, with its risk measured instead of assumed: ufw rebuilds from its saved files, so a rule that lives only in the running state would be dropped. So `ufw status verbose`, and the rules outside ufw's and our chains, are compared before and after, and any difference is printed. Our jumps must be first again within 90 s, or the installer prints STOP.
- The probe: N1 now tests, on every address, the dashboard ports, the databases, Coolify and the executor, plus 22, 80 and 443 (`HOST_PORTS`). The addresses are the gateway, the host's own addresses (`GPT_FUTTATO_GEP_CIMEK`) and the fleet's. The control (api.openai.com:443, by name) must still answer.

**The owner runs this, as root, after `git -C /opt/gpt-futtato/src fetch && git -C /opt/gpt-futtato/src checkout <the approved commit>`:**

```
/opt/gpt-futtato/src/gpt-runner/host/telepit-tuzfal.sh
```

**What the installer does:**
1. It installs the script and the unit, and enables and starts them.
2. **It measures persistence:** it removes our rules, restarts the unit, and the rules must be back. It also prints the unit's `WantedBy`, `PartOf` and `After`. **It does not restart docker**, because that would restart the fleet's container. A real reboot is not part of the measurement; the unit's enablement and its docker binding stand for it.
3. It writes the host's IPv4 addresses into `.env`, re-creates the network (`docker compose down` + `up`) and runs the probe once.
4. **If N1 comes out NEM_MERHETO** (the control or name resolution broke under the rules), it prints `STOP` and the two commands that take the rules back off.

## Before the login step (not this PR)

- **The activation condition (barracuda, #138 review):** the exit code is 1 only on FAIL; NEM_MERHETO exits 0. So before activation, **V2 and V3 must not stay NEM_MERHETO**, unless Balázs accepts that explicitly, in writing, for those lines.
- **F2 after the login:** the runner's own home (`/home/gpt`, with `auth.json` in it) is not a system path, so F2 will report it. That is then expected, not a fault. The login PR names it explicitly in the probe (the own home is allowed, nothing else), or the probe stays red forever and the red loses its meaning.

- **The controller's channel:** a network of its own between this container and the controller, never one of the fleet's. Then N1 runs on that network too, and ports 3420 and 3425 must not answer there either (plan v2).
- **Who can read the login:** like the deploy executor's secrets, `~/.codex` in a volume is readable by anyone who can run `docker` on the host. Install the login only after the fleet's SSH user is out of the `docker` group (the B8 gate).
- **V3:** with a logged-in model, measure whether the shell tool can be switched off. If the sandbox never starts (see above), also measure what `codex exec` does with a command.
