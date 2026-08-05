# Subscription billing via `CLAUDE_CODE_OAUTH_TOKEN`: replace `agent.api_key` with `agent.auth`

**Date:** 2026-08-05
**Status:** Approved
**Scope:** `@throng/agent-core`, `throng-agent-claude`, `throng-agent-codex`.
No changes to `@col/a2a-claude` or `a2a-codex`.

## Goal

Let a caller of `POST /api/initialise` run a Claude task billed against a Claude
Code **subscription** instead of API credits, by supplying an OAuth token (the
kind `claude setup-token` mints) that reaches Claude Code as
`CLAUDE_CODE_OAUTH_TOKEN`.

Doing this correctly is not just "set one more env var". The Claude Agent SDK
reads its credential off the process environment, and `@col/a2a-claude` hands it
a copy of `process.env`. An `ANTHROPIC_API_KEY` that is merely *ambient* in the
sandbox — from the image, a host `-e` flag, a previous configuration — therefore
reaches Claude Code even when the manifest never mentioned it, and the run
silently bills API credits anyway. The feature is only meaningful if the
selected billing mode is a guarantee.

So the credential stops being a bare string and becomes a tagged value: exactly
one credential, carrying its own type. `agent.api_key` is replaced outright by
`agent.auth`.

## Background

- `POST /api/initialise` (`packages/core/src/control/server.ts`) is handled by
  `TaskRun.initialise()` (`packages/core/src/task-run.ts`).
- Core validation reads only the reserved `agent.platform` key and delegates the
  rest of the `agent` block to the adapter's `validateAgent()`
  (`packages/core/src/manifest/validate.ts`).
- Today both adapters call core's `resolveApiKey`
  (`packages/core/src/manifest/api-key.ts`), which returns the manifest
  `agent.api_key` if non-blank, else the first non-blank value among
  engine-supplied fallback env vars, else `null`.
- Each adapter then injects that string in `injectCredentials()`:
  `throng-agent-claude/src/config/credentials.ts` sets `ANTHROPIC_API_KEY`,
  `throng-agent-codex/src/config/credentials.ts` sets `OPENAI_API_KEY`. Neither
  ever unsets anything.
- `assertNoAnthropicKeyInSettings` (same Claude file) already guards against a
  `~/.claude/settings.json` pinning `env.ANTHROPIC_API_KEY`, which the SDK would
  give precedence over the per-process key.
- `@col/a2a-claude` never carries the credential in its config
  (`dist/config/loader.js`: "ANTHROPIC_API_KEY is read directly by the SDK —
  never forwarded via config"). Its `client-factory.js` passes
  `env: syncPluginInstallEnv()` — a fresh copy of `process.env` — when
  marketplace plugins are in play, and `undefined` (plain inheritance) otherwise.
  Both are evaluated **per query**, well after `initialise` has run, so mutating
  `process.env` during initialise is observed by every turn.

## New manifest surface

`agent.api_key` is **removed**. `agent.auth` replaces it:

```jsonc
"agent": {
  "platform": "claude",
  "auth": { "type": "oauth", "token": "sk-ant-oat01-…" },
  "model": "…"
}
```

`type` rather than `kind`, matching the `thinking.type` tagged union the
manifest already uses. `auth` is optional; absent means fall through to the
environment, then to no credential.

There is no migration path, alias, or deprecation warning. The platform is
pre-1.0 and in development, and this is a deliberate breaking change. A manifest
still sending `api_key` lands in the existing `keys` passthrough, goes unread,
and resolves to no credential — which trips the same "requests will fail"
warning a credential-less manifest trips today. No special-cased error for it.

## One per-engine table drives everything

Each adapter declares an ordered list of the auth schemes it accepts:

```ts
// throng-agent-claude
const SCHEMES: AuthScheme[] = [
  { type: "oauth",   env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { type: "api_key", env: "ANTHROPIC_API_KEY" },
];
const ALSO_SCRUB = ["ANTHROPIC_AUTH_TOKEN"];  // competing, but never a source

// throng-agent-codex
const SCHEMES: AuthScheme[] = [{ type: "api_key", env: "OPENAI_API_KEY" }];
```

That single table is, at once:

- the set of accepted `agent.auth.type` values,
- the env-fallback source list, in precedence order,
- the injection target for the selected type,
- and the scrub set for every type *not* selected.

Codex rejects `type: "oauth"` for free, because its table does not list it. No
engine-specific validation branch is written for that.

`ALSO_SCRUB` exists because `ANTHROPIC_AUTH_TOKEN` is a credential the SDK will
honour but one Throng does not want to *accept* as an input — it must be cleared
without becoming a fallback source.

## Changes

### 1. Core — replace `src/manifest/api-key.ts` with `src/manifest/auth.ts`

Delete `resolveApiKey` and its export. Export instead:

```ts
export interface AuthScheme {
  type: string;   // "api_key" | "oauth"
  env: string;    // set when selected; also the fallback source for this type
}

/** A resolved credential. `token` is guaranteed non-blank. */
export interface ResolvedAuth {
  type: string;
  token: string;
}

export type AuthResolution =
  | { ok: true; auth: ResolvedAuth | null }
  | { ok: false; errors: FieldError[] };

export function resolveAuth(
  agent: Record<string, unknown>,
  env: Env,
  schemes: AuthScheme[],
): AuthResolution;

export function applyAuth(
  auth: ResolvedAuth | null,
  schemes: AuthScheme[],
  alsoScrub?: string[],
): void;
```

**`resolveAuth`** resolves in this order:

1. `agent.auth` present → validate and use it.
2. else the first non-blank `env[scheme.env]` walking `schemes` in order →
   `{ type: scheme.type, token: <that value> }`.
3. else `null`.

For Claude the table lists `oauth` first, so the env tier prefers
`CLAUDE_CODE_OAUTH_TOKEN` over `ANTHROPIC_API_KEY`. This is deliberate: a
container carrying both is already an odd configuration, and someone who went to
the trouble of exporting an OAuth token wants subscription billing. Behaviour
with only one of the two set is unchanged from today.

Validation errors, all on the existing field-error channel (`400`):

| Condition | Field | Reason |
| --- | --- | --- |
| `auth` is not an object (incl. array/null) | `agent.auth` | `must be an object` |
| `type` missing or not in the table | `agent.auth.type` | `must be one of <the table's types, joined by />` — e.g. `must be one of oauth/api_key` |
| `token` missing, non-string, or blank | `agent.auth.token` | `must be a non-empty string` |

A blank `token` is a hard error rather than being coerced to absent. The old
blank-to-nil coercion existed because `api_key` was a bare string with no way to
signal intent; an explicit `auth` block that names a type and then carries no
token is unambiguously a caller bug, and silently falling through to a different
billing mode is exactly the failure this feature exists to prevent.

The resolved value is `ResolvedAuth | null` rather than carrying a
`{ type: "none" }` member, matching the repo's existing `string | null`
convention for "was this sent?" (`github_token`, `UserIdentity` fields).

**`applyAuth`** performs the mutation:

- when `auth` is non-null: `process.env[selected.env] = auth.token`, and
  `delete process.env[s.env]` for every other `s` in `schemes`, plus every name
  in `alsoScrub`;
- when `auth` is `null`: scrub nothing, set nothing.

Scrubbing is what makes the billing mode a guarantee rather than a bet on Claude
Code's internal precedence between `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
and `CLAUDE_CODE_OAUTH_TOKEN` — a precedence that could not be confirmed from
the shipped SDK bundle and is not a documented contract.

Order matters: scrub first, then set. `applyAuth` must be correct even if a
scheme's `env` were ever to collide with the selected one.

### 2. Claude adapter — `throng-agent-claude`

**`src/manifest/claude-agent.ts`**
- Drop the `api_key` string check and the `resolveApiKey` call.
- `ResolvedClaudeAgent.api_key: string | null` → `auth: ResolvedAuth | null`.
- Call `resolveAuth(a, env, SCHEMES)`; on `!ok`, push its errors into the
  existing `errors` array so they merge with plugin/effort/thinking errors and
  the caller gets one complete `400`.

**`src/config/credentials.ts`**
- Delete `injectAnthropicKey`; the adapter calls core's `applyAuth` directly.
- `assertNoAnthropicKeyInSettings` → `assertNoAnthropicCredentialInSettings`,
  rejecting a `~/.claude/settings.json` that pins `env.ANTHROPIC_API_KEY`,
  `env.ANTHROPIC_AUTH_TOKEN` **or** `env.CLAUDE_CODE_OAUTH_TOKEN`, in either
  mode and regardless of which is selected. A pinned `CLAUDE_CODE_OAUTH_TOKEN`
  overrides the per-process one just as readily as a pinned API key does. The
  error names the offending key. Absent/unreadable/unparseable settings stay
  fine, as today.

**`src/adapter.ts`** — `injectCredentials` becomes:

```ts
assertNoAnthropicCredentialInSettings();
applyAuth(manifest.agent.auth, SCHEMES, ALSO_SCRUB);
if (manifest.agent.auth === null) {
  log.warn("no agent.auth in manifest; agent requests will fail unless another auth path is configured");
}
```

Plugin logging below it is unchanged.

### 3. Codex adapter — `throng-agent-codex`

The same three edits, minus the settings guard (Anthropic-specific) and with a
single-entry table: `ResolvedCodexAgent.api_key` → `auth`, `resolveAuth` in the
validator, `injectOpenAIKey` deleted in favour of `applyAuth`, warning reworded.
`src/config/credentials.ts` is left holding nothing and is deleted.

### 4. Tests

**Core — `src/manifest/auth.test.ts`** (replaces `api-key.test.ts`)
- manifest `auth` wins over both env vars;
- each env rung selected in table order, including OAuth-before-API-key for a
  two-entry table with both vars set;
- blank env values skipped;
- `null` when nothing is set anywhere;
- rejects: non-object `auth`, array `auth`, unknown `type`, missing `type`,
  missing `token`, non-string `token`, blank/whitespace `token`;
- `applyAuth` sets the selected var **and** asserts the *absence* of every other
  scheme var and every `alsoScrub` name that was set beforehand;
- `applyAuth(null, …)` leaves a pre-existing env var untouched.

**Claude — `src/manifest/claude-agent.test.ts`**
- `type: "oauth"` and `type: "api_key"` both accepted;
- an unknown type is rejected on `agent.auth.type`;
- auth errors merge with a simultaneous plugin/effort error into one result.

**Claude — `src/config/credentials.test.ts`**
- settings guard throws for each of the three pinned names and passes for a
  settings file with an unrelated `env` block, no `env` block, absent file,
  unparseable file.

**Claude — `src/adapter.test.ts`**, **Codex — `src/adapter.test.ts`**
- `injectCredentials` with an OAuth manifest sets `CLAUDE_CODE_OAUTH_TOKEN` and
  clears a pre-set `ANTHROPIC_API_KEY` (the regression this feature is about);
- with an api_key manifest, the converse.

**Codex — `src/manifest/codex-agent.test.ts`**
- `type: "api_key"` accepted; `type: "oauth"` rejected on `agent.auth.type`.

**Migrations** — existing `api_key` fixtures move to `auth` in
`throng-agent/src/integration/boot.test.ts`, both `adapter.test.ts`, both
`config/build.test.ts`, and both `manifest/*-agent.test.ts`.

Tests that mutate `process.env` must save and restore it, since `applyAuth`
deletes keys.

### 5. Docs — `README.md`

- Manifest example: `"api_key": "sk-…"` → the `auth` block.
- Replace the inline comment with an `auth` subsection alongside the existing
  `thinking`/`effort` and `credentials` ones: the two types, which engines accept
  which, the env-fallback order, and an explicit statement that selecting a type
  clears the competing variables so billing mode is deterministic.
- Standalone `docker run` recipe (line ~133): update the `agent` block.

### 6. Changesets

One changeset covering `@throng/agent-core`, `throng-agent-claude` and
`throng-agent-codex` — minor bumps, with the changelog text stating plainly that
`agent.api_key` is removed and replaced by `agent.auth`, since a minor bump on
0.x is where a breaking change lands.

## Data flow

`agent.auth`
→ `validateClaudeAgent` / `validateCodexAgent`
→ `resolveAuth(agent, env, SCHEMES)` → `ResolvedAuth | null` on `manifest.agent.auth`
→ adapter `injectCredentials`
→ `applyAuth` mutates `process.env` (scrub competing, set selected)
→ `@col/a2a-claude` / `a2a-codex` per-query env snapshot
→ Agent SDK.

## Non-goals

- **Pull-mode delivery.** The OAuth token arrives in the manifest, like
  `github_token`, not from the control plane via `throng-creds`. OAuth
  setup-tokens are long-lived, so there is no expiry pressure demanding a
  refresh path.
- **Token refresh into a running sandbox.** Out of scope, though the design does
  not preclude it: `@col/a2a-claude` snapshots `process.env` per query, so a
  later mutation would be picked up by the next turn.
- **Codex ChatGPT-subscription auth.** That uses an `auth.json` on disk rather
  than an env var, so it does not fit the scheme table. Codex accepts
  `type: "api_key"` only.
- **Validating token shape.** Throng does not check that an `oauth` token looks
  like `sk-ant-oat01-…`; the type is declared, not sniffed. Anthropic owns that
  format and the API returns the 401 at runtime.
- **Model-capability checking.** Subscription billing may restrict which models
  are available. Throng does not own that matrix, matching the existing
  permissive treatment of the loosely-typed agent object.
