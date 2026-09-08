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
      autoconf m4 libncurses-dev libssl-dev automake \
      libxml2-utils ca-certificates inotify-tools \
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
# of use via throng-creds, which reads $HOME/.throng/config.json — written by
# POST /api/initialise before any clone.
#
# $HOME and not /run: this image sets no USER, so `docker run` runs it as root,
# but E2B's envd runs the same image as uid 1000 — and /run is tmpfs owned
# root:root 0755, so `mkdir /run/throng` is EACCES there. Pre-creating the
# directory here would not help, because /run is mounted fresh at boot. $HOME is
# writable without privilege under either host, and is one of the few things E2B
# does put in the runtime's environment (HOME=/home/user).
#
# The git config is baked in here rather than written at initialise because it
# is a constant. `useHttpPath` is required, not optional: without it git never
# sends `path=`, so no request can name a repo and everything collapses to the
# task's default scope. The helper is referenced by absolute path because git
# invokes helpers through /bin/sh, whose PATH may not include /usr/local/bin.
#
# The last three are build-time smoke checks: `throng-creds git store` proves the
# script parses and exits 0 (it is also the one mode that resolves no paths, so
# it needs no HOME), and `gh --version` proves the shim resolves gh.real and
# declines cleanly with no config present.
#
# `gh --version` reaches the cache path and so creates $HOME/.throng/cache —
# /root/.throng/cache, since the build runs as root — and the shipped image must
# start with nothing configured, so the rm removes it. This rm is load-bearing
# now, unlike the /dev/shm one it replaces: BuildKit mounted /dev/shm as a fresh
# tmpfs per RUN, so that directory could never reach a layer whether or not it
# was removed. /root is an ordinary layer and this one would.
RUN install -m 0755 /app/packages/core/dist/creds/throng-creds.sh /usr/local/bin/throng-creds \
 && install -m 0755 /app/packages/core/dist/creds/gh-shim.sh /usr/local/bin/gh \
 && git config --system credential.helper '/usr/local/bin/throng-creds git' \
 && git config --system credential.useHttpPath true \
 && git config --system url."https://github.com/".insteadOf git@github.com: \
 && throng-creds git store </dev/null \
 && gh --version \
 && rm -rf "${HOME:?}/.throng" \
 && printf 'export GIT_TERMINAL_PROMPT=0\n' > /etc/profile.d/throng.sh
# The third of three places GIT_TERMINAL_PROMPT is set, and each covers a
# different set of processes. See the ENV below for why one is not enough:
#
#   startControlServer()'s process.env  → the runtime and everything DESCENDED
#                                         from it: the engine, its shells, the
#                                         agent's `git push` an hour later
#   /etc/profile.d/throng.sh (this)     → login shells, whoever starts them —
#                                         including ones E2B's envd spawns, which
#                                         are SIBLINGS of the runtime and inherit
#                                         nothing from it
#   ENV GIT_TERMINAL_PROMPT=0 (below)   → everything, under `docker run` only
#
# A file rather than another ENV because a file is read at shell startup, which
# is after the snapshot, whereas an image ENV is applied at execve and E2B's
# resumed runtime never saw it. This is the same reason the credentials
# themselves live in a file. It is still not total — a non-login `bash -c` reads
# no profile — but the blocking case needs a TTY, and a TTY means an interactive
# shell.
# Every ENV below is belt and braces. None of them reaches production.
#
# E2B's agent runtime process inherits NO image ENV and no template `setEnvs`:
# the runtime is started during template build and captured in the snapshot, and
# the environment it is resumed with is scrubbed down to roughly E2B_*, HOME,
# LOGNAME, PATH, PWD and USER. Measured on a live sandbox — not even LANG
# survives, despite the line below. `docker run` DOES inherit image ENV, which is
# how an image-only mechanism could look verified and still be dead in
# production. So: nothing the runtime needs may come from here. It must come
# from a code default, from /api/initialise, or from a file.
#
# These stay because they cost nothing and are correct for `docker run`, which is
# how the image is exercised standalone.
#
# GIT_TERMINAL_PROMPT: when throng-creds declines or dies — a 403, an unreachable
# service, an unconfigured sandbox — git falls back to asking for a username.
# Without a TTY that is an immediate error; WITH one it blocks forever, and the
# README's standalone recipe reaches in over `docker exec`. A blocked git
# operation is the worst outcome this design has, which is why it is set three
# times (see the profile.d note above). Under E2B this ENV does nothing at all.
ENV GIT_TERMINAL_PROMPT=0
# CONTROL_PORT: the runtime's own default is 8080, which is what E2B gets.
ENV CONTROL_PORT=8080
# node:20-slim (Debian 12) sets no LANG, so every process in the sandbox inherits
# the `C` locale. That makes locale-sensitive toolchains misbehave on non-ASCII
# paths and output. `C.UTF-8` is built into glibc >= 2.35, so it needs no
# `locales` package and no locale-gen. Note that this one is `docker run` only
# and has no runtime counterpart yet: under E2B the sandbox really is in the `C`
# locale.
ENV LANG=C.UTF-8
EXPOSE 8080 3030
CMD ["node", "throng-agent/dist/index.js"]
