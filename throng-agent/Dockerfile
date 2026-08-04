# syntax=docker/dockerfile:1

# --- Build stage -------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json .npmrc ./
COPY packages/core/package.json ./packages/core/package.json
COPY throng-agent-claude/package.json ./throng-agent-claude/package.json
COPY throng-agent-codex/package.json ./throng-agent-codex/package.json
COPY throng-agent/package.json ./throng-agent/package.json
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" npm ci
COPY packages/core ./packages/core
COPY throng-agent-claude ./throng-agent-claude
COPY throng-agent-codex ./throng-agent-codex
COPY throng-agent ./throng-agent
RUN npm run build && npm prune --omit=dev

# --- Runtime stage -----------------------------------------------------------
FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential gpg wget curl jq \
 && install -dm 755 /etc/apt/keyrings \
 && wget -qO - https://mise.jdx.dev/gpg-key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg arch=$(dpkg --print-architecture)] https://mise.jdx.dev/deb stable main" \
      > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends mise \
 && rm -rf /var/lib/apt/lists/*
# GitHub CLI. Agents reach for `gh pr create`; without it they fall back to
# hand-rolled curl calls against api.github.com, scraping the token out of git's
# credential helper to do it (observed in a live run).
#
# Installed system-wide into /usr/local/bin, which is on the image's default PATH
# — so unlike mise's user-local shims this needs no /etc/profile.d wiring to reach
# the shells the agent spawns. Pinned rather than apt-sourced: the image is the
# unit of promotion (DEV_VERSION/PROD_VERSION), so a rebuild of "the same" version
# must not quietly pick up a different gh. `dpkg --print-architecture` keeps a
# local arm64 build working even though E2B runs amd64; the final `gh.real
# --version` turns a bad URL into a failed build instead of a missing binary at
# runtime.
#
# Installed as `gh.real`: /usr/local/bin/gh is a shim that fetches a fresh token
# per invocation, because GH_TOKEN cannot be refreshed once a process has
# started. Because this image owns both names, PATH ordering cannot resolve to
# the wrong one.
ARG GH_VERSION=2.96.0
RUN arch="$(dpkg --print-architecture)" \
 && wget -qO /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz" \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh.real \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}" \
 && gh.real --version
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/throng-agent-claude/dist ./throng-agent-claude/dist
COPY --from=build /app/throng-agent-claude/package.json ./throng-agent-claude/package.json
COPY --from=build /app/throng-agent-codex/dist ./throng-agent-codex/dist
COPY --from=build /app/throng-agent-codex/package.json ./throng-agent-codex/package.json
COPY --from=build /app/throng-agent/dist ./throng-agent/dist
COPY --from=build /app/throng-agent/package.json ./throng-agent/package.json
# Credential plumbing. git and gh both fetch a short-lived token at the moment
# of use via throng-creds, which reads /run/throng/config.json — written by
# POST /api/initialise before any clone.
#
# The git config is baked in here rather than written at initialise because it
# is a constant. `useHttpPath` is required, not optional: without it git never
# sends `path=`, so no request can name a repo and everything collapses to the
# task's default scope. The helper is referenced by absolute path because git
# invokes helpers through /bin/sh, whose PATH may not include /usr/local/bin.
#
# The last three are build-time smoke checks: `throng-creds git store` proves the
# script parses and exits 0, and `gh --version` proves the shim resolves gh.real
# and declines cleanly with no config present. `gh --version` reaches the cache
# path and so creates /run/throng/cache; the rm keeps that build-time side effect
# out of the shipped image, which must start with nothing configured.
RUN install -m 0755 /app/packages/core/dist/creds/throng-creds.sh /usr/local/bin/throng-creds \
 && install -m 0755 /app/packages/core/dist/creds/gh-shim.sh /usr/local/bin/gh \
 && git config --system credential.helper '/usr/local/bin/throng-creds git' \
 && git config --system credential.useHttpPath true \
 && git config --system url."https://github.com/".insteadOf git@github.com: \
 && throng-creds git store </dev/null \
 && gh --version \
 && rm -rf /run/throng
ENV CONTROL_PORT=8080
# node:20-slim (Debian 12) sets no LANG, so every process in the sandbox inherits
# the `C` locale. That makes locale-sensitive toolchains misbehave on non-ASCII
# paths and output. `C.UTF-8` is built into glibc >= 2.35, so it needs no 
# `locales` package and no locale-gen.
ENV LANG=C.UTF-8
EXPOSE 8080 3030
CMD ["node", "throng-agent/dist/index.js"]
