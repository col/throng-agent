# TX-252 Project Environment Variables and Secrets Implementation Plan (throng-agent)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept `env` and `secrets` maps on the initialise and prepare manifests and make them visible to setup commands and, on boot, to the agent and every shell it opens, without leaking a secret into a snapshot, the wrapper's own configuration, or an error message.

**Architecture:** Two injection points. Setup commands receive an explicit environment on both paths, so prepare never touches `process.env` and a snapshot's memory image carries nothing. On boot only, after the adapter has built its config and injected the LLM credential, the runtime writes the project variables into `process.env`, skipping a reserved set, right before the A2A server starts. Secret values are redacted from setup output alongside GitHub tokens.

**Tech Stack:** TypeScript (ESM), vitest, turbo monorepo (`packages/core`, `throng-agent-claude`, `throng-agent-codex`, `throng-agent`), changesets.

**Spec:** `/home/user/workspace/throngx/docs/superpowers/specs/2026-11-17-tx-252-project-env-vars-and-secrets-design.md` (§3, §5.3). Copy the spec into this repo at `docs/superpowers/specs/2026-11-17-tx-252-project-env-vars-and-secrets-design.md` in Task A1 so it travels with the plan.

**Companion plan:** `throngx/docs/superpowers/plans/2026-11-17-tx-252-project-env-vars-and-secrets.md`. Wire contract fixed there: payload keys `env` and `secrets`, both `Record<string, string>`, each absent when empty.

## Global Constraints

- Key pattern: `/^[A-Za-z_][A-Za-z0-9_]*$/`.
- `RESERVED_ENV_KEYS` (exported from `packages/core/src/task-run.ts`): `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `HOME`, `PATH`, `WORKSPACE_DIR`, `THRONG_CONFIG`, `THRONG_CREDS_CACHE`, `THRONG_INIT_TOKEN`, `GIT_TERMINAL_PROMPT`, `THRONG_CREDS_BIN`, `GH_REAL_BIN` (thirteen; the last four are read lazily after boot, so ordering cannot protect them).
- `process.env` is never mutated on the prepare path.
- On boot, `process.env` is mutated only after `adapter.buildAgentConfig` returns and before `adapter.createA2AServer` is called.
- No log line and no error message ever contains a secret value or the `env`/`secrets` maps; counts only.
- Work on branch `throng/TX-252` in this repo. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A manifest key the server should have rejected (`PATH`) still arrives: it is skipped with a warning, not applied. (Task A3 test "skips reserved keys with a warning".)
2. A secret value that is a substring of another secret: the longer one is redacted whole, not left half-visible. (Task A2 test "redacts longer values first".)
3. A project `ANTHROPIC_API_KEY` that slipped through: after boot, `process.env.ANTHROPIC_API_KEY` is whatever `injectCredentials` set. (Task A3 test "the manifest credential wins".)
4. The same key in `env` and `secrets`: rejected at validation, so the sandbox never has to pick a winner. (Task A1 test "rejects a key present in both".)
5. An older control plane sends neither key: both default to `{}` and setup commands run with the unchanged environment. (Task A1 test "defaults both to empty"; Task A3 test "passes the process environment unchanged when both are empty".)

---

### Task A1: Manifest types and validation

**Files:**
- Create: `docs/superpowers/specs/2026-11-17-tx-252-project-env-vars-and-secrets-design.md` (copy of the throngx spec)
- Modify: `packages/core/src/manifest/types.ts` (`WorkspaceManifest`)
- Modify: `packages/core/src/manifest/validate.ts` (`validateWorkspace`, the two manifest-building returns)
- Test: `packages/core/src/manifest/validate.test.ts`

**Interfaces:**
- Produces: `WorkspaceManifest.env: Record<string, string>` and `WorkspaceManifest.secrets: Record<string, string>`, both `{}` when absent; `validateEnvMap(field: "env" | "secrets", value: unknown, errors: FieldError[]): void`.

- [ ] **Step 1: Write the failing tests** (in `validate.test.ts`, for both `validate` and `validatePrepare`)

```ts
describe("env and secrets", () => {
  it("defaults both to empty", ...);                 // manifest.env toEqual({}) and manifest.secrets toEqual({})
  it("accepts string maps", ...);                     // env: {NODE_ENV: "test"}, secrets: {NPM_TOKEN: "x"} pass through
  it("rejects a non-object env", ...);                // env: "x" → error field "env"
  it("rejects a non-string value and names only the key", ...);  // env: {A: 1} → field "env.A", reason not containing "1"
  it("rejects a bad key", ...);                       // secrets: {"NODE ENV": "x"} → field "secrets.NODE ENV"
  it("rejects a key present in both", ...);           // → field "secrets.X", reason "also set in env"
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/core -- validate`
Expected: new tests fail.

- [ ] **Step 3: Implement**

Add the two fields to `WorkspaceManifest` with the spec's doc comments. `validateEnvMap` in `validate.ts`: non-object → `{ field, reason: "must be an object of string values" }`; per entry: bad key → `{ field: `${field}.${key}`, reason: "is not a valid environment variable name" }`, non-string value → `{ field: `${field}.${key}`, reason: "must be a string" }`. Call it from `validateWorkspace` for `"env"` and `"secrets"` when present, then the cross check for keys in both. Default both to `{}` where the resolved manifests are assembled (the `setup_commands: ... ?? []` lines).

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w packages/core -- validate && npm run typecheck`
Expected: pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs packages/core/src/manifest
git commit -m "feat(TX-252): env and secrets on the workspace manifest"
```

---

### Task A2: Setup commands take an explicit environment; secret redaction

**Files:**
- Modify: `packages/core/src/bootstrap/setup.ts`
- Modify: `packages/core/src/index.ts` (export `redactSecrets`, `SetupOptions`)
- Test: `packages/core/src/bootstrap/setup.test.ts`

**Interfaces:**
- Produces: `interface SetupOptions { env?: NodeJS.ProcessEnv; secretValues?: readonly string[] }`; `runSetupCommands(cwd: string, commands: string[], opts?: SetupOptions): Promise<SetupResult>`; `redactSecrets(text: string, extraValues?: readonly string[]): string`; `describeSetupFailure(result, secretValues?: readonly string[]): string`. `redactTokens(text)` remains as `redactSecrets(text)`.

- [ ] **Step 1: Write the failing tests**

```ts
it("passes the given environment to the shell", ...);        // runSetupCommands(dir, ["echo $TX_PROBE"], { env: { ...process.env, TX_PROBE: "hit" } }) — assert via writing to a file in dir, as the existing tests do
it("uses process.env when no env is given", ...);
describe("redactSecrets", () => {
  it("still redacts github tokens", ...);
  it("redacts every occurrence of each secret value", ...);   // "x=s3cret y=s3cret" → both replaced with [REDACTED]
  it("redacts longer values first", ...);                     // values ["abc", "abcdef"], text "abcdef" → exactly "[REDACTED]"
  it("ignores empty values", ...);
});
it("describeSetupFailure redacts secret values from command and output", ...);
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/core -- setup`
Expected: fail.

- [ ] **Step 3: Implement**

`runOne(cwd, command, env)` passes `env` into `execFile`'s options. `runSetupCommands` destructures `opts` with defaults `env = process.env`, `secretValues = []`, and passes `secretValues` to every redaction in its log lines. `redactSecrets` applies `TOKEN_PATTERN` then, for each non-empty value sorted by length descending, `text.split(value).join("[REDACTED]")`. `describeSetupFailure(result, secretValues = [])` uses `redactSecrets(..., secretValues)` for both the command and the output. Keep the "redact before truncating" order and comment.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -w packages/core -- setup && npm run typecheck`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/setup.ts packages/core/src/bootstrap/setup.test.ts packages/core/src/index.ts
git commit -m "feat(TX-252): setup commands take an explicit env; redact secret values"
```

---

### Task A3: Two injection points in `TaskRun`, reserved keys, wiring

**Files:**
- Modify: `packages/core/src/task-run.ts` (`BootDeps.runSetupCommands` signature, `runSetup`, `boot`, new exports)
- Modify: `packages/core/src/index.ts` (export `RESERVED_ENV_KEYS`, `projectEnv`)
- Modify: `throng-agent/src/*.ts` where `BootDeps` is assembled, if the `runSetupCommands` reference needs the new signature (it is passed by reference; confirm typecheck)
- Test: `packages/core/src/task-run.test.ts`, `throng-agent-claude/src/adapter.test.ts`, `throng-agent-codex/src/adapter.test.ts`

**Interfaces:**
- Consumes: Task A1 fields; Task A2 `SetupOptions`.
- Produces: `export const RESERVED_ENV_KEYS: ReadonlySet<string>`; `export function projectEnv(manifest: WorkspaceManifest): Record<string, string>` (env then secrets merged, reserved keys dropped with `log.warn("project env key skipped", { key })`); `BootDeps.runSetupCommands: (cwd: string, commands: string[], opts?: SetupOptions) => Promise<SetupResult>`.

- [ ] **Step 1: Write the failing tests** (in `task-run.test.ts`; stub `runSetupCommands` and inspect its third argument; snapshot and restore `process.env` in `afterEach`)

```ts
describe("project env", () => {
  it("passes env and secrets to setup commands on boot", ...);       // opts.env.NODE_ENV === "test", opts.env.NPM_TOKEN === "x", opts.secretValues toEqual(["x"])
  it("passes the process environment unchanged when both are empty", ...);  // opts undefined or opts.env equals process.env
  it("does not touch process.env before buildAgentConfig", ...);     // buildAgentConfig spy asserts process.env.NODE_ENV undefined when called
  it("populates process.env before the server starts", ...);         // createA2AServer spy asserts process.env.NODE_ENV === "test"
  it("the manifest credential wins", ...);                           // injectCredentials sets process.env.ANTHROPIC_API_KEY = "from-manifest"; manifest env ANTHROPIC_API_KEY: "evil" → after ready, still "from-manifest"
  it("skips reserved keys with a warning", ...);                     // env PATH: "/evil" → process.env.PATH unchanged; log.warn called with { key: "PATH" } (spy on log)
  it("prepare passes env to setup but leaves process.env unchanged at prepared", ...);
});
```

Adapter tests (one in each of `throng-agent-claude/src/adapter.test.ts`, `throng-agent-codex/src/adapter.test.ts`): every `env` in the adapter's auth schemes (plus `CLAUDE_AUTH_ALSO_SCRUB` for Claude) is in `RESERVED_ENV_KEYS`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w packages/core -- task-run`
Expected: fail.

- [ ] **Step 3: Implement**

`RESERVED_ENV_KEYS` as a `ReadonlySet` with a comment listing where each name is read (adapter credentials, `throng-creds` handshake, SDK binary lookup) and noting the throngx mirror `Throng.Projects.Project.Validations.EnvironmentVariableKeys`. `projectEnv(manifest)` builds `{ ...manifest.env, ...manifest.secrets }` minus reserved keys. `runSetup` calls `this.deps.runSetupCommands(cwd, manifest.setup_commands, { env: { ...process.env, ...projectEnv(manifest) }, secretValues: Object.values(manifest.secrets ?? {}) })` and passes `secretValues` to `describeSetupFailure`. In `boot()`, after `const config = adapter.buildAgentConfig(...)` and before the server start log line: `this.applyProjectEnv(manifest)` which does `Object.assign(process.env, projectEnv(manifest))` with a comment stating the ordering is load-bearing (spec §5.3). Nothing changes in `prepareWorkspace` beyond what `runSetup` already does; add a sentence to the `deleteCredentialConfig` comment: project variables never enter `process.env` on this path, so there is nothing to unset. Update the two `log.info` manifest-count lines with `envCount` and `secretCount`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test && npm run typecheck && npm run build`
Expected: all workspaces pass and build.

- [ ] **Step 5: Add a changeset and commit**

Run: `npx changeset` non-interactively by writing `.changeset/tx-252-project-env.md` with a `patch` bump for `@throng/core` (or the actual core package name from `packages/core/package.json`), `throng-agent-claude`, `throng-agent-codex` and `throng-agent`, summary "Accept project `env` and `secrets` on initialise and prepare manifests; apply to setup commands and, on boot, to the agent environment after config build; redact secret values from setup output."

```bash
git add packages/core/src throng-agent-claude/src throng-agent-codex/src throng-agent/src .changeset
git commit -m "feat(TX-252): apply project env to setup and, after config build, to the agent"
git push -u origin throng/TX-252
```

- [ ] **Step 6: Open a draft PR**

`gh pr create --draft --title "TX-252: project env and secrets on the manifest" --body` summarising the two injection points, the reserved set, the redaction, and linking the throngx PR #340. End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
