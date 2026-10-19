# syntax=docker/dockerfile:1
# The mail relay (task level-kozvetito, slice 3). Built ON THE HOST, as root, from a root-owned clone at a reviewed
# commit (/opt/levelkozvetito/src), never from the fleet's tree; same shape as deploy-executor/Dockerfile.
# NODE_IMAGE has no default and must be pinned to a digest; the build stops otherwise.
ARG NODE_IMAGE

FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
RUN case "$NODE_IMAGE" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "NODE_IMAGE must be pinned: <image>@sha256:<64 hex>" >&2; exit 1 ;; esac
WORKDIR /build
# only the compiler, from a lockfile with integrity hashes
COPY level-kozvetito/build/package.json level-kozvetito/build/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./tsconfig.json
COPY level-kozvetito/tsconfig.build.json ./level-kozvetito/tsconfig.build.json
# the relay and the ONE shared file it uses (the <untrusted> envelope)
COPY src/level-kozvetito ./src/level-kozvetito
COPY src/prompt-safety.ts ./src/prompt-safety.ts
RUN npx tsc -p level-kozvetito/tsconfig.build.json

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY level-kozvetito/package.json ./package.json
COPY --from=build /build/out ./
# the state volume starts out owned by the relay's user (a new named volume copies this directory)
RUN mkdir -p /var/lib/levelkozvetito && chown 10003:10003 /var/lib/levelkozvetito && chmod 700 /var/lib/levelkozvetito
USER 10003:10003
CMD ["node", "/app/level-kozvetito/main.js"]
