# The deploy executor (SB1)

A separate container that holds the only Coolify **deploy** keys. The fleet asks
it for a deployment; it deploys only a commit that the owner approved on
Discord, once, within the approval window, on an allowlisted application.
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
5. GET http://vegrehajto:8787/requests/<r>  -> outcome: finished_verified | commit_mismatch | failed | unverified_timeout
```

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
tailnet only) the `ki` network must reach `coolify.acropora.hu` over the tailnet;
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

## Not here yet

`restart` (its Coolify ability is an estimate in the plan); the running image
tag check (`<app-uuid>:<sha>`) needs host Docker access the B8 gate decides about;
the fleet-side switch of `kirakat-telepites.sh` and the skills (plan step 5).
