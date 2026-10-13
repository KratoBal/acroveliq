# syntax=docker/dockerfile:1
# The separate deploy executor (SB1). Built ON THE HOST, as root, from a
# root-owned clone at a reviewed commit (/opt/vegrehajto/src): never from the
# fleet's tree. The image holds the code; nothing is bind-mounted over it.
#
# Pin NODE_IMAGE to a digest when installing (README). The runtime needs full
# ICU: the executor compares Hungarian dates letter for letter and refuses to
# start if it renders them differently (assertHungarianDates).
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /build
# only the compiler, at the versions of the repo's package-lock.json
RUN npm install --no-save --ignore-scripts --no-audit --no-fund typescript@5.9.3 @types/node@22.19.12
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
# the state volume starts out owned by the executor's user (a new named
# volume copies this directory, ownership included)
RUN mkdir -p /var/lib/vegrehajto && chown 10001:10001 /var/lib/vegrehajto && chmod 700 /var/lib/vegrehajto
USER 10001:10001
CMD ["node", "/app/deploy-executor/main.js"]
