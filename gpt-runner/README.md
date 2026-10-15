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
  src/                       git clone of KratoBal/acroveliq at the reviewed commit, root-owned
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

## The login and the measure after it

Balázs approved the ChatGPT login on 2026-10-14 at 18:31 UTC (`exchange/acroveliq/gpt-belepes-jovahagyas-balazs-2026-10-14.md`). The order is fixed: the ufw persistence first (#144), then the login, then the measure.

- **`host/belepes.sh`** (as root; Balázs runs it, since he sees and approves the device code):
  - It runs `codex login --device-auth` (the 0.159.3 spelling) in the container, as 10002, on its own volume.
  - If the login fails, it names the most likely cause: the device-code login is not enabled in the ChatGPT account's security settings. The 0.159.3 error texts are `Device code login is not enabled` and `Error logging in with device code: ...`.
  - The log holds the one-time code, so it is root-only and removed.
  - Afterwards it prints **only** the place, mode, owner and size of `/home/gpt/.codex/auth.json`, and the **names** of the files in the volume. It requires `600` and `10002`. The value is never read.
- **`host/utana-meres.sh`** (as root): the whole probe again, then a summary. The GPT side stays off unless V3, H1-AUTH and every other line are OK.
- **The probe after the login:**
  - **H1-AUTH:** the one allowed credential is `/home/gpt/.codex/auth.json`, by exact path, `600` and owned by 10002. F2 no longer flags that exact path; any other credential-looking name stays FAIL.
  - **TESZT-VALTOZO:** `PROBA_ELVART_HOME`, `PROBA_GYOKER`, `PROBA_CSAK_HELYI` and `PROBA_CODEX_VERSION` set in the container are FAIL. `PROBA_FLOTTA_CIMEK` and `PROBA_GEP_CIMEK` are real inputs.
  - **V3** (Balázs, condition 4: a conversation partner, **no execution right**, not just "no shell"; barracuda, #145).
    - The flags are an **allowlist**: exactly `exec --json --skip-git-repo-check -C /tmp -s read-only -c approval_policy="never"`, then only `-c features.<shell_tool|unified_exec>=<true|false>` pairs, then `-`: the fixed prompt goes in on **stdin** (the CLI's documented stdin sentinel), the way the service sends it, so no prompt text is ever an argument. Anything else (`--full-auto`, `--add-dir`, another sandbox, the bypass flags) is refused before any call.
    - The `--json` events are an **allowlist** too. In the test run only the frames (`thread.started`, `turn.started`, `turn.completed`, `item.*`) and the items `agent_message` and `reasoning` may appear. **Any other item** (a command, a `file_change`, a `web_search`, an `mcp_tool_call`, or a type a later version adds) is FAIL, and so is an unknown event type. An `error` or `turn.failed`, or no item at all, proves nothing: NEM_MERHETO.
    - **The test run:** `features.shell_tool=false` and `features.unified_exec=false`, with a prompt that asks for `touch /tmp/kanari-v3 /home/gpt/kanari-v3`. Neither canary may appear (the second one is on the writable volume), and the JSON events may show no command execution.
    - **The control run:** the same prompt with `shell_tool` on, still read-only. It must show a non-allowed item in the events, or the parser is blind and V3 is NEM_MERHETO.
    - **A canary from the control run** is its own FAIL (`V3-KONTROLL-IRAS`). Since V2 shows that Codex's own sandbox does not start in this container, **this line is the expected signal** if Codex then runs commands without a sandbox: there is no "read-only" inside the container. The activation must then rest on the container's boundary (and on V3's test run with the tools off), not on Codex's sandbox (barracuda, #145).
    - This costs two short model calls on Balázs's plan.

## The controller channel

The debate controller (in the fleet's dashboard) talks to this runner over one narrow, **routed** channel (acrobot 30868, barracuda 30866/30873). The runner never calls back.

- **The service** (`szolga.mjs`, the compose service `gpt-szolga` in the `szolga` profile, the same image):
  - It listens on the container's **one** address, port 8790, never `0.0.0.0`.
  - `POST /futtat` takes **exactly** `{"prompt": "..."}`: no Codex flag, no working directory, no session. It needs a Bearer token, compared by SHA-256 in constant time; the runner holds only the hash.
  - It runs Codex with **the same flag list V3 measured** (`SERVICE_ARGS` is `V3_TEST_ARGS`), with the prompt on stdin.
  - One run at a time (a parallel request is 429), a time limit per run (the whole process group is killed), and a daily cap on the runner side too, kept in its volume.
  - It returns the answer only if the `--json` stream holds nothing but the answer and the reasoning. A tool, an unknown event or an error means no answer.
  - `GET /health` returns the source address the service saw, and logs it.
  - **No session:** whether `codex exec resume` keeps the read-only sandbox and the tools-off flags is not provable from the 0.159.3 source (`-s` is not a global flag there; the resume parameters carry only part of the config). So every round is a new run (acrobot 30864).
- **The network:** the port is published on **one** host address, the gateway of the fleet network with the fewest containers. The fleet container joins no network of ours.
  - **GPTF-BE** (in `tuzfal.sh`, from DOCKER-USER, so after the DNAT): a new connection into the runner's bridge is dropped unless it comes from the fleet container's fixed address and goes to the service's fixed address and port.
  - **GPTF-GEPROL** (OUTPUT): the host itself sends nothing into the runner's bridge.
  - **GPTF-NAT** (nat POSTROUTING, first, while the channel is open): the channel flow is not masqueraded. Docker's own rule for the fleet network (`-s <fleet subnet> ! -o <fleet bridge> -j MASQUERADE`) rewrote the source to `gptki0`'s address. The v3 host run's service saw `10.0.5.128`, not the fleet container, so the source measurement stopped, as designed. A nat `ACCEPT` ends nat processing for that one flow; it filters nothing. The chain empties first when the channel closes.
  - The private-range drops now spare replies (`! RELATED,ESTABLISHED`). A NEW connection from the runner to a private address is still dropped, so it never has an established flow of its own.
  - **Past Docker's isolation:** two bridges do not talk (DOCKER-ISOLATION-STAGE-*, after DOCKER-USER), the DNAT-ed channel neither. While the channel is open, GPTF-TOVABB holds two ACCEPTs for **exactly** its one flow: the fleet `/32` to the service `/32` tcp/8790 out of `gptki0` (NEW, ESTABLISHED), and the reply back from source port 8790 (ESTABLISHED). Each passes only what our DROP chains pass anyway, so the order changes no verdict. The isolation itself is not loosened (barracuda, #148).
  - Every other rule of ours is a DROP. If the addresses in `.env` are missing or malformed, GPTF-BE drops every new connection: the channel is closed.
  - **The channel is open only while the fleet container holds the fixed address**, measured at every run of `tuzfal.sh` (the per-minute timer too). Docker may give an old address to another container (barracuda, #148). So another address, an unreadable container or a missing setting **closes** the channel: GPTF-BE gets its closed form and the two ACCEPTs go. On closing, the ACCEPTs leave first; on opening, they come last. The timer logs the change once: `CSATORNA: ...` in `journalctl -u gpt-futtato-tuzfal-ellenor.service`. Running `host/csatorna.sh` again re-reads the address.
- **The token** is `store/.gpt-futtato-token` in the fleet's store: 0600, owned like `.dashboard-token`, read at every call, never printed.
- **The controller side** (`src/gpt-runner-client.ts`):
  - `DEBATE_GPT_RUNNER_ENABLED` is off by default, and **it cannot switch the runner on alone**: the controller gets one only together with the conversation package and its filters. Without filters, `on` still means no runner and one log line.
  - `DEBATE_GPT_RUNNER_URL` must be `http://<IPv4>:<port>`.
- **The package and its filters** (`src/gpt-package.ts`, `scripts/gpt-csomag/hatar.py`; the multi-model plan's PR 2):
  - **What goes out:** only this debate's record. The owner's messages and the texts the controller itself posted (Acrobot's and GPT's answered turns), in time order, with the project and the topic.
  - **Secrets:** every raw piece (the messages, the topic, the controller's ask) is checked for the repository's secret shapes and the fleet's own token **values** from the store. A hit blocks the package. The thread is told **which** piece it was, never its content.
  - **Personal data:** the body goes through the JEV provider boundary's redactor in its **full** mode, behind its leak gate (green for the running code), then its runtime guard. Names, e-mails, phones and addresses leave only as placeholders. Any failure blocks; nothing falls back to the raw text. The keeping mode (amounts, dates, ids, company names) was narrowed by Balázs to one other task (PD-006), so it is not used here.
  - **Size:** the oldest messages are left out, and the thread is told how many.
  - **Log:** `logs/gpt-csomag/<date>.jsonl` holds the hash and the size of what went out, never the text.
  - **Output filter:** GPT's answer is checked for secrets (shapes and fleet token values) before it is posted.
  - **End mark:** a last line of exactly `[VÉGE]` ends the phase early; the mark itself is not posted.
  - **Daily cap:** it counts **attempts**. The row is written before the runner is called, and a failed or late run counts too. A package the filters stopped spent nothing and does not count.
  - **The HTTP answer does not wait for GPT:** after Acrobot's hand-in, GPT's turn runs in the background (barracuda, #137).
- **`host/csatorna.sh`** (as root, on the host) sets all of this up and **measures** it. Any difference is a STOP.
  1. It finds the fleet container (the one that mounts `/opt/marveen-docker/data`) and chooses the network.
  2. It fixes the runner network's subnet as Docker gave it, with the service at `.10`.
  3. It makes the token if there is none, and writes the addresses and the hash into `.env`.
  4. It runs `telepit-tuzfal.sh`: persistence, the timer, a quiet second run of `tuzfal.sh` (the rules are spelled the canonical way), and the probe. N1 also tries port 8790 on every host address.
  5. It starts the service, then measures the **source address** the service sees from a call made in the fleet container. It must be the fleet container's address; a gateway would mean a docker-proxy is in the way and the source filter filters the wrong thing.
  6. **Negative controls** in the same round, each with a positive control from the same place: another container on the same fleet network, and the host itself. Each must reach the fleet's own port 3420 but not the service's port.
  7. It checks the timer's address state, then **stops the service**. Running it for the debates is Balázs's separate activation.

## Before the activation (not this PR)

- **The activation condition (barracuda, #138 review):** the exit code is 1 only on FAIL; NEM_MERHETO exits 0. So before activation, **V2 and V3 must not stay NEM_MERHETO**, unless Balázs accepts that explicitly, in writing, for those lines.
- **F2 after the login:** the runner's own home (`/home/gpt`, with `auth.json` in it) is not a system path, so F2 will report it. That is then expected, not a fault. The login PR names it explicitly in the probe (the own home is allowed, nothing else), or the probe stays red forever and the red loses its meaning.

- **The conversation package and its filters (PR 2):** without them the controller has no runner, whatever the switch says (see "The controller channel").
- **Who can read the login:** like the deploy executor's secrets, `~/.codex` in a volume is readable by anyone who can run `docker` on the host. Install the login only after the fleet's SSH user is out of the `docker` group (the B8 gate).
- **V3:** with a logged-in model, measure whether the shell tool can be switched off. If the sandbox never starts (see above), also measure what `codex exec` does with a command.
