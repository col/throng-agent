# syntax=docker/dockerfile:1

# --- Build stage -------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json .npmrc ./
COPY packages/core/package.json ./packages/core/package.json
COPY throng-agent-codex/package.json ./throng-agent-codex/package.json
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm ci
COPY packages/core ./packages/core
COPY throng-agent-codex ./throng-agent-codex
RUN npm run build -w @throng/agent-core \
 && npm run build -w throng-agent-codex \
 && npm prune --omit=dev

# --- Runtime stage -----------------------------------------------------------
FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential gpg wget \
 && install -dm 755 /etc/apt/keyrings \
 && wget -qO - https://mise.jdx.dev/gpg-key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://mise.jdx.dev/deb stable main" \
      > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends mise \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/throng-agent-codex/dist ./throng-agent-codex/dist
COPY --from=build /app/throng-agent-codex/package.json ./throng-agent-codex/package.json
ENV CONTROL_PORT=8080
EXPOSE 8080 3030
CMD ["node", "throng-agent-codex/dist/index.js"]
