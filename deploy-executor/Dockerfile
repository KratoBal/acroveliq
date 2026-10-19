# syntax=docker/dockerfile:1
# The separate deploy executor (SB1). Built ON THE HOST, as root, from a
# root-owned clone at a reviewed commit (/opt/vegrehajto/src): never from the
# fleet's tree. The image holds the code; nothing is bind-mounted over it.
#
# NODE_IMAGE has no default: compose passes it from VEGREHAJTO_NODE_IMAGE, and
# the build stops unless it is pinned to a digest (barracuda, #49 review 1). The
# runtime needs full ICU: the executor compares Hungarian dates letter for
# letter and refuses to start if it renders them differently.
ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
RUN case "$NODE_IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "NODE_IMAGE must be pinned: <image>@sha256:<64 hex>" >&2; exit 1 ;; esac
WORKDIR /build
# only the compiler, from a lockfile with integrity hashes (barracuda, #49 review 2):
# a swapped package on the registry fails npm ci with EINTEGRITY
COPY deploy-executor/build/package.json deploy-executor/build/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./tsconfig.json
COPY deploy-executor/tsconfig.build.json ./deploy-executor/tsconfig.build.json
# the executor and the ONE dashboard file it shares (#33's pure Discord half)
COPY src/deploy-executor ./src/deploy-executor
COPY src/web/approval-discord-core.ts ./src/web/approval-discord-core.ts
RUN npx tsc -p deploy-executor/tsconfig.build.json

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY deploy-executor/package.json ./package.json
COPY --from=build /build/out ./
# The grant door's ssh client (task parancssor-a-fleet-ro-grant; barracuda, N1): Debian's signed repository, in the
# owner's root build from a reviewed commit. The version is NOT pinned (the bookworm security updates would break the
# build), and `ssh -V` prints it, so the build log names the version that went in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && ssh -V
# ssh refuses to run for a uid that has no account: the executor's uid gets one, with no shell and no home
RUN groupadd -g 10001 vegrehajto \
 && useradd -u 10001 -g 10001 -M -d /nonexistent -s /usr/sbin/nologin vegrehajto
# the state volume starts out owned by the executor's user (a new named
# volume copies this directory, ownership included)
RUN mkdir -p /var/lib/vegrehajto && chown 10001:10001 /var/lib/vegrehajto && chmod 700 /var/lib/vegrehajto
USER 10001:10001
CMD ["node", "/app/deploy-executor/main.js"]
