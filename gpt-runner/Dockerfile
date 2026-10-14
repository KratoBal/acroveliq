# syntax=docker/dockerfile:1
# The GPT runner (task t-20261014-gpt-futtato-kontener; Balázs, 2026-10-14 16:38 UTC: variant B,
# a container of its own). Built ON THE HOST, as root, from a root-owned clone at a reviewed
# commit (/opt/gpt-futtato/src), never from the fleet's tree, the same way as deploy-executor/.
#
# By default the image runs the isolation probe (proba.mjs), once, into `docker logs`. The
# controller channel's service (szolga.mjs) is a second compose service from the same image,
# started only by the host script; the GPT side stays off until Balázs's separate activation.
#
# NODE_IMAGE has no default and must be pinned to a digest; the Codex CLI comes from
# package-lock.json with `npm ci` (integrity hashes), at one exact version: the probe's V2 sandbox
# measurement is valid for that version only (plan v2, barracuda).
ARG NODE_IMAGE

FROM ${NODE_IMAGE}
ARG NODE_IMAGE
RUN case "$NODE_IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "NODE_IMAGE must be pinned: <image>@sha256:<64 hex>" >&2; exit 1 ;; esac
ENV NODE_ENV=production
# the system CA store: the slim image has none (the node image purges ca-certificates after its
# own download), and Node brings its own store, so a Node check passed while Codex (Rust) failed
# the login's TLS ("error sending request", 2026-10-14 20:13 UTC)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY gpt-runner/package.json gpt-runner/package-lock.json ./
# no install scripts: the Codex binary is the platform package of the lockfile, not a download
RUN npm ci --ignore-scripts --no-audit --no-fund --omit=dev \
 && ln -s /app/node_modules/.bin/codex /usr/local/bin/codex
COPY gpt-runner/proba.mjs ./proba.mjs
# the service (the controller channel); it imports the probe's measured flags
COPY gpt-runner/szolga.mjs ./szolga.mjs
# the home volume (~/.codex later) starts out owned by the runner's user, closed to anyone else;
# uid 10002: not root, not the image's own `node` (1000, which is marveen on the fleet host)
RUN mkdir -p /home/gpt && chown 10002:10002 /home/gpt && chmod 700 /home/gpt
USER 10002:10002
ENV HOME=/home/gpt
CMD ["node", "/app/proba.mjs"]
