# The deploy executor (SB1)

A separate container that holds the only Coolify **deploy** keys. The fleet asks
it for a deployment; it deploys only a commit that the owner approved on
Discord, or that the rule path approves from the evidence on GitHub (below), once,
within the approval window, on an allowlisted application.
Code: `src/deploy-executor/` (logic and tests in `src/__tests__/deploy-executor*.test.ts`).

Plans: `exchange/biztonsag/baseline/sb1-coolify-token-terv-2026-10-13.md` and
`sb1-coolify-harom-modositas-2026-10-13.md`.

**Order (barracuda, CHANGES 1): install on a host only after the B8 gate is live
there.** Until then the fleet's SSH user is in the `docker` group and could read
this container's secrets.

## How the fleet uses it

```
1. POST http://vegrehajto:8787/requests   {"env","app","action":"deploy","sha":<40 hex>,"requester"}
   -> 201 {"r","canonicalLine","expiresAt",...}
2. POST /api/approvals on the dashboard (#33), category coolify_deploy,
   action_description = canonicalLine EXACTLY (nothing before or after it),
   timeout_seconds not longer than the R's window
3. the owner answers on Discord, as a reply: "igen <code>"
4. POST http://vegrehajto:8787/executions {"r","requestMessageId": <the #33 Discord message id>}
   -> 200 {"status":"used","outcome":"queued","deploymentUuid",...}
5. GET http://vegrehajto:8787/requests/<r>  -> outcome: finished_verified | finished_unhealthy | commit_mismatch | failed | unverified_timeout
```

The fleet does not hand-write these calls: `scripts/vegrehajto.sh` does steps 1-2
(`kerj <agent> <env> <app> <sha40>`: the approval goes up with the canonical
line as its whole description and an expiry inside the R's window; the
dashboard's default of 1440 minutes would be refused), step 4
(`vegrehajt <R> <approval_id>`: only an approved, Discord-decided approval of
this very R is sent on) and step 5 (`allapot <R>`).

**What `finished_verified` means (task `vegrehajto-health-poll`, nautilus' measurement on the Cápárium #16 deployment: every route was 503 for about 15 s after Coolify said finished, because the proxy sends traffic only to a healthy container).** An app entry in `config.json` may carry an optional `healthUrl` (https, no credentials, query or fragment; the app's PUBLIC health address, owner's data like the rest of the file). With it, a deployment that Coolify reports finished on the approved commit is `finished_verified` only after that address answers **200**: the executor looks every 2 s, for at most 120 s, does not follow redirects, and reads only the status. If it never answers 200 the outcome is `finished_unhealthy` (the right commit was built; `observed.health` holds the last status, `null` for no answer). Without a `healthUrl` nothing changes. **What a 200 does not prove:** that it is the NEW container answering (the health address carries no version), and that the rest of the app works; it closes the window in which the verdict came before the container was ready, not more. The probe runs from the executor's container: from there the public address must be reachable (measure it before setting the line: `docker exec vegrehajto node -e "fetch('<healthUrl>').then(r=>console.log(r.status))"`).

A refusal is `403 {"error": <reason>}` and leaves the R unused. Anything after
the R is marked used spends it (also a failed Coolify call): a new request and a
new approval are needed.

Limits, checked before any outside call: 6 requests and 12 executions a minute
(refused calls count too), at most 10 open, unexpired Rs; over them the answer is
`429`.

After a restart: an R that was spent while its Coolify call was in flight
(`calling`) is matched against Coolify's own deployment list. Exactly one
commit-pinned rollback of its sha, recorded after the R was spent and held by no
other R, becomes its deployment (`queued`, then followed); anything else is
`interrupted` (spent, result unknown, look at Coolify). A `queued` R is followed
again.

## The rule path: no Discord question (task `vegrehajto-szabaly-jovahagyas`)

Balázs, 2026-10-19 19:54 UTC ("1 mehet 2 mehet 3 mehet"; CLAUDE.md "NINCS DISCORDOS ENGEDÉLYEZGETÉS"): a deploy
that passed the review and the CI goes to stage on its own, and one that passed on stage goes to prod on its own,
the commerce freeze excepted. The Discord path above stays, as the fallback.

```
POST http://vegrehajto:8787/requests          the same R as above
POST http://vegrehajto:8787/executions/by-rule {"r"}   -> 200 used, or 403 naming the condition that failed
```

`scripts/vegrehajto.sh szabaly <agent> <env> <app> <sha40>` does both. The executor itself reads the evidence on
GitHub (`src/deploy-executor/rules.ts`), every time:

| | stage (`stage-auto`) | prod (`prod-auto`) |
|---|---|---|
| the commit | the merge commit of exactly one merged PR into the app's branch, and on that branch | the same |
| the review | the LATEST decisive review of a `rules.reviewerLogins` login on that PR is APPROVED, for exactly the PR's head | the same |
| the CI | the head: at least one check run, all completed, none failed; the merge commit: none failed or unfinished | the same |
| the stage | | this executor deployed the same commit to the app's `stageApp` and saw `finished_verified` |
| the freeze | | the repo is not in `rules.frozenRepos`, and no changed file (old or new path) matches `rules.frozenPaths`; else 403 naming the file |

Never by rule: a fleet_ro grant (a permission change, the owner's own), and a step back, a fork or an unmeasured
running version (the Discord line shows those to the owner; a rule has no one to show them to). The audit log has a
line for every decision: `approved` with `by: rule`, the rule and the evidence (PR, head, reviewer, check counts, the
stage R, the number of files checked), or `refused` with `by: rule`, the rule and the reason.

**Why a GitHub review and not barracuda's root record.** The record (`/var/lib/fleet-approve/verdicts.jsonl`) lives
inside the fleet container, root 0600; this executor runs outside the fleet on purpose and cannot read it. What it can
read is the review `fleet-approve approve` posts with the machine account, which `fleet-approve` posts only for a
verdict in that record, bound to that head (`docs/fleet-github.md`). **Until that review is posted on a repo, the rule
path refuses there** (`no review by <login>`), and the Discord path is the way: on 2026-10-19 the machine account could
not yet write reviews on caparium-napplo and acropora-os (barracuda: HTTP 404/403, the G2 step).

### Install (the owner, on the host, as root; one block)

```
cd /opt/vegrehajto/src && git fetch origin && git checkout <the merged commit of this PR>
# config.json, from config.example.json: a "rules" block (reviewerLogins: the GitHub login fleet-approve posts its
#   reviews with; frozenPaths; frozenRepos), and "stageApp" on each prod app that has a stage counterpart
# the github-olvaso token: besides contents:read, also "Pull requests: read" and "Checks: read" on the same repos
cd /opt/vegrehajto && docker compose build && docker compose up -d
docker compose logs vegrehajto | grep '"event":"listening"'     # the line ends with "rules":true
```

After it, from the fleet: `bash scripts/vegrehajto.sh szabaly acrobot stage <a stage app> <a merged, reviewed sha>`;
a 403 names the missing evidence, and nothing is deployed.

## Install on a host (the owner, as root; nothing here is run by the fleet)

```
/opt/vegrehajto/                 root:root 755
  compose.yaml                   copy of deploy-executor/compose.yaml, root 644
  .env                           root 644, one line: VEGREHAJTO_NODE_IMAGE=node:22-bookworm-slim@sha256:<digest>
  config.json                    from config.example.json, root 644 (no secret in it)
  src/                           git clone of KratoBal/acroveliq at the reviewed commit, root-owned
  titkok/                        root:root 700
    coolify-prod-deploy          10001:10001 400   deploy ability (and read), prod Coolify
    coolify-ai-deploy            10001:10001 400   the same, AI machine's Coolify
    discord-olvaso               10001:10001 400   a separate bot, read-only on the approval channel
    github-olvaso                10001:10001 400   contents:read on the repos in config.json
    gate-key                     10001:10001 400   the executor's own ssh key to the B8 gate (the grant button, below)
    gate-known-hosts             10001:10001 400   the host's ssh key, pinned (one line, made from the host's own key file)
```

The secret files belong to uid 10001 (the container's user) because compose
mounts file secrets from the host as they are; check at install that uid 10001
is not a user on the host (`getent passwd 10001` empty). Whether this compose
version honours a `mode`/`uid` on file secrets was not measured; the file
ownership above works either way.

```
cd /opt/vegrehajto && docker compose build && docker compose up -d
docker network connect vegrehajto-hivas <the fleet container's name>
```

The `network connect` takes effect at once; to keep it across a re-creation of
the fleet container, the network goes into the fleet's compose file as an
external network (that change waits for the next planned re-creation).

The base image is pinned by digest: compose refuses to start the build
without `VEGREHAJTO_NODE_IMAGE`, and the Dockerfile refuses a value without
`@sha256:<64 hex>`. The compiler comes from `deploy-executor/build/package-lock.json`
with `npm ci` (integrity hashes, the same versions as the repo's lockfile). To get a digest:
`docker buildx imagetools inspect node:22-bookworm-slim` (the `Digest:` line).

**Reaching the Coolify APIs.** After B20 (the production Coolify reachable on the
tailnet only) the public name `coolify.acropora.hu` no longer answers, so the
`coolifyApiUrl` of the production host must be an internal address of the same
host (the fleet uses `http://10.0.1.1:8000`; which address the `ki` network reaches
is measured at install, not assumed);
measure it at install: `docker compose exec vegrehajto node -e "fetch('<coolifyApiUrl>/version').then(r=>console.log(r.status))"`
(401 without a token is the expected answer: reachable). The `ki` network allows
any outbound traffic today; narrowing it to Discord, GitHub and the two Coolify
hosts is a later step.

## Checks after install (from three-changes 1; each must hold, or the executor stays down)

On the host:

- `docker inspect vegrehajto`: no `docker.sock` and no `/opt/marveen-docker` path in `Mounts`;
  `ReadonlyRootfs=true`, `User` = `10001:10001`, `CapDrop=[ALL]`, `Privileged=false`, `PidMode` not `host`.
- the fleet container's `docker inspect` has no `/opt/vegrehajto` mount.
- `docker compose logs vegrehajto` shows `"event":"listening"` (it refuses to start if
  the runtime renders Hungarian dates differently from the dashboard).

With the fleet's key (must be refused by the B8 gate): `ssh fleet@<host> 'docker inspect vegrehajto'`
and `ssh fleet@<host> 'docker exec vegrehajto true'`.

From the fleet container: `ls /run/secrets` empty or missing; `ps aux` shows no
executor process; `curl -s http://vegrehajto:8787/healthz` answers; an execution
with no approval answers 403.

## The fleet_ro grant button (task parancssor-a-fleet-ro-grant; design sheet and barracuda's APPROVE)

The same executor applies the `fleet_ro` read grants of the OS database, through the B8 gate's `fleet-ro-grant` operation
(`docs/fleet-gate.md`, "fleet_ro jogok gombbal"). Same shape as a deploy, a second kind of R:

```
1. bash scripts/vegrehajto.sh fleet-ro-kerj <agent> prod fleet-ro <commit40>
   -> POST /requests {"env":"prod","app":"fleet-ro","action":"fleet-ro-grant","sha":<commit>,"requester"}
      the executor asks the gate for its PLAN at that commit (`terv`, a transaction that rolls back) and builds the line
   -> POST /api/approvals, category fleet_ro_grant, the line as the whole description
2. the owner reads the table and column names on Discord and answers `igen <code>`
3. bash scripts/vegrehajto.sh vegrehajt <R> <approval_id>
   -> POST /executions: the answer is read back as for a deploy; then a SECOND `terv` must give the approved plan
      (all 64 digits of its digest, kept in the record); the R is spent; the gate's `alkalmaz` runs; a THIRD `terv`
      must show no change, or the outcome says `terv_nem_ures`
4. bash scripts/vegrehajto.sh allapot <R>  -> finished_verified | terv_nem_ures | alkalmaz_hiba | utomeres_nem_olvashato
```

**What the owner reads.** One line, compact, with the commit and the first 16 digits of the list's and the plan's digest:
`... / GRANT SELECT TO fleet-ro: +Table col1,col2; +Other col3 / REVOKE SELECT FROM fleet-ro: -Third col4`. Every `+` is one
`GRANT SELECT (cols) ON table TO fleet_ro`, every `-` one `REVOKE SELECT (cols) ON table FROM fleet_ro`; tables and columns
are sorted; an underscore in a name is shown as a dot (#33 turns `_` into a space), and the line says so. A name outside
`[A-Za-z0-9_]` refuses the plan (a quoted name with a comma or a space would give two readings). A plan that does not fit
the category's 1500 characters is REFUSED (`terv-nem-fer-a-gombra`), never cut: split the list into two commits. An empty
plan is refused (nothing to approve). Today's whole list is about 1100 characters.

**What the gate output must be.** Exactly a head line (`fleet-ro-grant terv: commit <sha>, lista sha256 <hex>, ma <date>`)
and one `GRANT SELECT (c) ON t TO fleet_ro` / `REVOKE SELECT (c) ON t FROM fleet_ro` line per changed column (a psql notice,
with or without its prefix). Any other line refuses the request and the audit trail keeps one visible line of it: the first
real run of that SQL is the first real Postgres run, so a surprise stops here instead of being guessed at.

**Install (the owner, as root on the host; nothing here is run by the fleet).** After the gate is live, and the OS role
`fleet_ro_grantor` exists (`docs/fleet-gate.md`, steps 1 and 2):

```
cd /opt/vegrehajto/titkok && ssh-keygen -t ed25519 -N '' -C vegrehajto -f gate-key && chown 10001:10001 gate-key && chmod 400 gate-key && ls -l gate-key gate-key.pub
cd /opt/vegrehajto/titkok && printf '%s %s\n' "<the address the executor will use>" "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > gate-known-hosts && chown 10001:10001 gate-known-hosts && chmod 400 gate-known-hosts
```

The `known_hosts` line is made from the host's OWN key file, not from `ssh-keyscan` over the network. **If `gate.port` is not 22, the
first field of the line is `[<address>]:<port>`** (ssh looks the host up in that form, and with `StrictHostKeyChecking=yes` it would refuse
every call otherwise); with port 22 it is the bare address, as in the command above. The public key goes into
`/etc/ssh/authorized_keys/fleet` as a second line, `restrict,from="<the executor's source address>",command="/usr/local/sbin/fleet-gate vegrehajto" <the contents of gate-key.pub>`
(`restrict` also switches off the pty, agent and port forwarding, X11 and user rc; the gate's own `sshd-match` check accepts exactly the two line shapes).
`config.json` gets `gate` (host, port, user `fleet`, the two secret files) and `grants` (see `config.example.json`). The host
address, the source address the gate sees and the host key are the owner's measurements on the machine: the executor
reaches the host's sshd through its `ki` network, and neither is guessed here. The image build prints `ssh -V`.

**What the executor's key can do, said plainly.** The gate gives `terv` to any key and `alkalmaz` to this one only. Whoever
holds the key can apply the CURRENT, already reviewed list of `main` WITHOUT the owner's answer, and nothing else: no other
commit (the gate takes the list from the main branch, and a commit that is not the main head must carry the same list),
no other role (`TO fleet_ro` and `fleet_ro_grantor` are constants), no credential column, no SQL. **For that key's thief the
owner's approval step falls away, so the only gate of a change to the list is the review and the merge of the PR that
changes it.** The `terv` of the same list needs no key at all (any fleet key).

**Expired lines** are taken back by the gate's `szukit`, which needs no approval (it only narrows): `scripts/fleet-ro-szukit.sh`
runs it on the fleet's own key, from a scheduled task of the main agent; the gate stops at 40 columns in one run and asks
for a human decision.

**Not measured here:** a real `ssh` to a real gate, the image build (no docker in the development container), and a real
Postgres run of the plan. The first `terv` after the install only reads.

## Not here yet

`restart` (its Coolify ability is an estimate in the plan); the running image
tag check (`<app-uuid>:<sha>`) needs host Docker access the B8 gate decides about;
the fleet-side switch of `kirakat-telepites.sh` and the skills (plan step 5).

## B20b: the AI machine's Coolify on the tailnet only (task b20b-coolify2-tailnet)

`coolify2.acropora.hu` keeps only its `/webhooks/` path public. The executor reaches that
Coolify's API on the tailnet through its own Tailscale identity:

- the `ts` sidecar in `compose.yaml` (kernel mode, `NET_ADMIN` and the tun device only, tag
  `tag:vegrehajto`, `--accept-routes=false`, no exit node, Docker's DNS kept); the executor runs in
  its network namespace (`network_mode: service:ts`) with its own hardening unchanged, and the
  fleet keeps calling `http://vegrehajto:8787` (the alias is on the `hivas` network);
- the tailnet policy gives `tag:vegrehajto` exactly `tag:stage-ai:8000`, and nobody reaches
  `tag:vegrehajto:8787`; `tag:prod` keeps its `:8000` denial;
- `config.json`: `coolifyHosts.ai-gep.coolifyApiUrl` = `http://100.88.199.87:8000/api/v1`;
- the auth key: `/opt/vegrehajto/titkok/ts-authkey`, root 600, one-time, pre-approved, tagged;
  the sidecar reads it at its first login only (`TS_AUTH_ONCE`), its state is a named volume.

`host/b20b-meres.sh` is step 0 on the AI machine (read-only: the Traefik version, the dynamic
config's router lines, Coolify's webhook routes, the tailnet address). The step list for the
owner is in Hungarian beside the plan (`b20b-telepitesi-lap-2026-10-16.md`).
