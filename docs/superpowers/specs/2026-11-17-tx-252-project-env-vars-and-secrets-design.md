# TX-252: project environment variables and secrets

- **Ticket:** TX-252
- **Status:** draft 2026-11-17, reviewed, awaiting owner approval
- **Builds on:** `docs/superpowers/specs/2026-08-08-sandbox-startup-commands-design.md`
  (the Sandbox tab and `setup_commands`),
  `docs/superpowers/specs/2026-08-06-project-snapshots-design.md`
  (the prepare path), `docs/superpowers/specs/2026-10-24-tx-236-third-party-mcp-servers-design.md`
  (`Throng.Types.Encrypted` and the encrypted `headers` map it was built for)
- **Touches two repos:** `throngx` (storage, UI, manifest) and `throng-agent`
  (applying the variables inside the sandbox). The E2B template then needs a
  rebuild to pick up the new agent image.

## 1. Intent

A project's agents often need environment the repository itself cannot carry:
a test database URL, a feature flag, a private registry token, an API key for a
service the tests hit. Today the only way to get any of that into a sandbox is
to bake it into a startup command, which puts secrets in plain text in the
project settings and in the stored manifest.

The owner wants a card on the project's Sandbox settings tab where they can
list plain environment variables and, separately, secrets. Everything listed
there is present in the environment of every sandbox the project boots.

## 2. Goals, non-goals, anti-goals

**Goals**

- Project Settings → Sandbox gets an "Environment variables" card with two
  sections: variables and secrets. Each is a dynamic list of key/value rows
  with Add and Remove.
- Secret values are masked by default with an eye toggle to reveal, the same
  control the organisation credentials use.
- Plain variables reach every sandbox the project boots: task sessions,
  scheduled runs, Slack and Linear sessions, and snapshot builds. Secrets reach
  every read-write sandbox, which is all of those except read-only Slack
  question-and-answer sessions. (Owner's decisions: snapshot builds included;
  read-only sessions get no secrets.)
- Inside the sandbox they are visible to startup commands, to the Claude or
  Codex agent, and to every shell the agent opens.
- Secrets are encrypted at rest and never appear in the stored manifest, in
  admin, in logs, or in the GraphQL or assistant tool surfaces.

**Non-goals**

- No organisation-level variables, no sharing between projects, no per-task
  overrides. Project only.
- No templating or interpolation (`${OTHER_VAR}`) in values.
- No import from or export to `.env` files.
- No change to how the organisation's LLM and GitHub credentials reach the
  sandbox. Those stay as they are and keep precedence.
- No reordering controls. Environment is a set, so row order carries no
  meaning.

**Anti-goals**

- A project variable must not be able to replace the organisation's LLM
  credential, the agent runtime's own configuration, or the credential-helper
  handshake. The billing-mode guarantee the agent gives (one credential,
  competitors scrubbed) must survive.
- A project value must not be captured in a snapshot image. A secret rotated
  or removed in settings must be gone from the next sandbox, not resurrected
  from a snapshot's memory.
- A secret must not land in `instance.error_message` through a failing startup
  command's output. Today's redaction covers GitHub tokens only.
- A sandbox booted on an older agent image must still boot. The new wire keys
  are additive and ignorable.

## 3. Constraints and facts the design rests on

- **Environment flows through the agent, not E2B.** The agent runtime
  (`throng-agent`, `packages/core`) already sets the LLM credential by mutating
  its own `process.env` (`adapter.injectCredentials`). Startup commands run via
  `execFile("/bin/sh", ...)` with no explicit `env`, so they inherit the
  process environment; the a2a wrapper copies `process.env` for each SDK query,
  so the Claude/Codex subprocess and every shell it opens inherit whatever the
  process environment holds at query time. Passing `envVars` at E2B sandbox
  creation would not reach a sandbox resumed from a snapshot, and would hand
  E2B the secret values.
- **The wrapper reads its own configuration from `process.env`.**
  `@col/a2a-claude`'s `resolveConfig` (and a2a-codex's) calls
  `loadEnvOverrides()`, which reads `PORT`, `HOSTNAME`, `ADVERTISE_HOST`,
  `WORKSPACE_DIR`, `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `STREAM_ARTIFACTS`,
  `LOG_LEVEL`, `AGENT_NAME`, `AGENT_DESCRIPTION` (Codex: `CODEX_MODEL`)
  straight off `process.env`, with no way to pass a different map. This runs
  inside `adapter.buildAgentConfig`. Several of those names (`PORT`,
  `LOG_LEVEL`, `HOSTNAME`) are also ordinary application variables a project
  would legitimately want to set, so a deny-list is the wrong tool: the fix is
  to make sure the wrapper's config is built before project variables touch
  `process.env` (5.3).
- **A snapshot is a full-memory capture that resumes the same Node process.**
  Anything in `process.env` at the moment the agent reports `prepared` is in
  the environment of every task sandbox later restored from that snapshot, and
  nothing on the restore path can unset it. The agent already has a
  `deleteCredentialConfig` step before `prepared` for the on-disk equivalent.
- **The stored manifest is not a safe place for a secret.**
  `Instance.agent_manifest` is a public, plain jsonb attribute kept as the audit
  trail of what a sandbox was initialised with; it outlives the sandbox and
  nothing about the column promises who reads it later. Credentials are
  therefore stored as references
  (`%{"secret" => name, "args" => %{...}}`) and resolved by
  `Throng.Infra.SecretResolver` at send time, inside
  `Manifest.Resolve.initialise_payload/4` and `prepare_payload/2`.
  `Resolve.Shape` allowlists the recognised secret names and type-checks their
  args before anything is resolved.
- **An encrypted string-keyed map type already exists.**
  `Throng.Types.Encrypted` with `constraints kind: :map` stores a
  `%{String.t() => String.t()}` as an AEAD-sealed binary; `Throng.Mcp.Server.headers`
  uses it. In memory the attribute holds the plaintext map. A value that no
  longer decrypts reads as `nil` with a warning.
- **An embedded resource cannot hold an encrypted field cleanly.** Embedded
  attributes are dumped to JSON; the encrypted type's storage is a raw binary.
- **The agent's manifest validation ignores unknown keys.** `validate.ts`
  checks fields with `"x" in input`, so an older image receiving `env` and
  `secrets` ignores them. The server side can ship first.
- **Order of operations in the agent** (`task-run.ts`). Boot: validate
  manifest → `writeCredentials` (the on-disk config `throng-creds` reads) →
  `syncRepos` → `runSetup` → download attachments → `injectCredentials` →
  `injectGitIdentity` → `buildAgentConfig` → MCP proxy → start the A2A server.
  Prepare: validate → `writeCredentials` → `syncRepos` → `runSetup` →
  `deleteCredentialConfig` → `prepared`. Setup commands run *before* the
  credential scrub on both paths.
- **The Sandbox tab already has a dynamic-rows pattern.**
  `ThrongWeb.Live.Project.CommandListEditor` is a stateless function component
  whose Add/Remove buttons are `type="submit"` carrying `name="action"`, so one
  `phx-submit` handler receives both the structural intent and every row's
  text. A hidden `<name>_present` marker tells "list was emptied" from "list was
  not rendered".
- **The eye toggle exists.** `secure_input/1` in `core_components.ex` renders a
  `password` input with a `JS.toggle_attribute` eye button. It is bound to a
  `Phoenix.HTML.FormField`, which the row editor does not have.
- **Project is exposed to the assistant.** `Throng.Projects` defines
  `create_project` (the `:create` action) as an AI tool; `update_project` is not
  a tool. GraphQL `show_fields` on Project is limited to id, name, slug and
  id_prefix.
- **The env var names the sandbox must own.** Credentials:
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`
  (Claude) and `OPENAI_API_KEY` (Codex), from `CLAUDE_AUTH_SCHEMES`,
  `CLAUDE_AUTH_ALSO_SCRUB` and `CODEX_AUTH_SCHEMES` in the agent repo. The
  handshake with `throng-creds`, a bash helper git starts from the agent's
  shells *after* boot and which reads these from the inherited environment:
  `HOME`, `THRONG_CONFIG`, `THRONG_CREDS_CACHE`, `WORKSPACE_DIR`. And `PATH`,
  which the SDK needs to find its own binary. The wrapper's config keys above
  are *not* in this set; 5.3 protects them by ordering instead.
- **The sandbox image** is `ghcr.io/col/throng-agent`, pinned by
  `BETA_VERSION` / `STABLE_VERSION` in `throng_e2b_templates/throng-agent/template.ts`.

## 4. Approaches considered

The injection path is the same under every option: an `env` block on the
initialise and prepare manifests, applied to the agent's own process
environment before anything else runs. The fork was storage.

1. **One embedded list with a `secret?` flag.** Simplest model; the UI filters
   by the flag. Rejected: secrets would sit in plaintext jsonb in `projects`,
   and the whole list would have to be marked sensitive and hidden from every
   API surface, which hides the plain variables too.
2. **Two attributes.** `environment_variables` as an embedded list of key/value
   rows in plain jsonb, and `secret_environment_variables` as the existing
   encrypted map type, sensitive and not public. Mirrors how MCP server headers
   are stored. **Chosen by the owner.**
3. **A separate table.** One row per variable with an encrypted value and a
   secret flag. Per-row timestamps and room for cross-project reuse later, at
   the cost of a migration, a relationship and `manage_relationship` plumbing
   that nothing asked for.

## 5. Design

### 5.1 Data model (`throngx`)

**New embedded resource `Throng.Projects.EnvironmentVariable`**
(`data_layer: :embedded`), modelled on `Throng.Projects.Label`:

- `key`, string, `allow_nil? false`, `public? true`, `constraints trim?: true,
  match: ~r/^[A-Za-z_][A-Za-z0-9_]*$/` (a POSIX environment variable name).
- `value`, string, `allow_nil? false`, `public? true`, `constraints
  allow_empty?: true, trim?: false`. An empty value is legal (`FOO=`), and
  values are never trimmed: trailing whitespace in an env var is the user's
  business.
- Primary `create` and `update` accept both. `@derive Jason.Encoder` on both
  fields. No derived `id`: the key is the identity, and uniqueness is enforced
  on the project.

**Two new attributes on `Throng.Projects.Project`:**

- `environment_variables, {:array, Throng.Projects.EnvironmentVariable}`,
  `allow_nil? false`, `default []`, `public? true`, with a `description` for
  the attribute like its neighbours.
- `secret_environment_variables, Throng.Types.Encrypted`,
  `constraints kind: :map`, `allow_nil? true`, `public? false`,
  `sensitive? true`. `nil` and `%{}` both mean "none"; every reader treats
  `nil` as `%{}`.

Both are added to the primary `:update` action's `accept` list only. They are
**not** added to `:create`, which is the assistant's `create_project` tool.

**New validation `Throng.Projects.Project.Validations.EnvironmentVariableKeys`**
on `:update`, `where: [changing(:environment_variables)]` or
`changing(:secret_environment_variables)`. It reads both attributes off the
changeset (`Ash.Changeset.get_attribute/2`, which falls through to stored
data) and rejects:

- a key that appears twice across the two collections combined;
- a secret key that fails the same POSIX pattern as the embedded resource
  (the embedded type checks plain keys; the map needs an explicit check);
- a secret value that is not a binary (the encrypted type checks this too; the
  validation gives a field-level error instead of an "is invalid");
- a key in the **reserved set** the sandbox owns:
  `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `OPENAI_API_KEY`, `HOME`, `PATH`, `WORKSPACE_DIR`, `THRONG_CONFIG`,
  `THRONG_CREDS_CACHE`. The list lives in one module attribute with a comment
  pointing at the agent's `RESERVED_ENV_KEYS` (5.3), which it mirrors. The
  agent skips the same keys when it applies project env, so this is belt and
  braces: the user learns at save time, and a stale server list cannot break
  the guarantee.

Error messages name the offending key: `NODE_ENV is set twice`,
`ANTHROPIC_API_KEY is managed by Throng and cannot be overridden`,
`"my var" is not a valid environment variable name`.

**Migration:** `environment_variables jsonb not null default '[]'` and
`secret_environment_variables bytea null` on `projects`, generated with
`mix ash.codegen`.

### 5.2 Manifest and resolution (`throngx`)

**`Throng.Agents.Manifest`** gains two struct fields:

- `env :: %{String.t() => String.t()}`, default `%{}`. Literal, built from
  `project.environment_variables` as `Map.new(vars, &{&1.key, &1.value})`.
  Stored in the manifest like `setup_commands`, so admin shows exactly what
  the sandbox got.
- `secrets :: secret_ref() | nil`, default `nil`. Set to
  `%{"secret" => "project_secrets", "args" => %{"project_id" => id,
  "organisation_id" => org_id}}` whenever the session's `credential_scope` is
  `:read_write`, and left `nil` for `:read_only`. Resolution returns `%{}` for
  a project with none, so there is no "did the project have secrets at
  provision time" branch. (Consequence: a re-initialise of an existing
  instance gets the project's *current* secrets but the plain env captured at
  provision. Acceptable; both are captured within seconds for a new instance,
  and secrets being live is the safer direction.)

**Read-only sessions get no secrets** (owner's decision). Slack
question-and-answer sessions provision with `credential_scope: :read_only`,
and the system already treats that as a trust boundary: a read-only GitHub
token, no third-party MCP servers, and the MCP credentials endpoint refuses
read-only instances. `build_for_initialise/2` reads the scope the same way
`mcp_servers/3` does and omits the reference. Plain variables are not a
credential and go to every session regardless of scope.

`build_for_initialise/2` sets `env` always and `secrets` by scope;
`build_for_prepare/1` sets both (owner's decision: snapshot builds get them
too; a prepare run is always read-write). The prepare moduledoc's
"no credential may be baked into it" paragraph gets a sentence: project
variables are project-scoped, not task-scoped, are applied to the process
environment and never written to disk by the runtime, so they belong on both
paths like the GitHub credential does.

`to_stored/1` writes `"env"` and `"secrets"`; `from_stored/1` defaults a
missing `"env"` to `%{}` and a missing `"secrets"` to `nil` (a manifest written
before this change loads with no project env, which is what it had).

**`Throng.Agents.Manifest.Resolve.Shape`:**

- `validate_env/1`: `nil` → `%{}`; a map whose keys and values are all
  binaries → ok; anything else → `{:error, {:unresolved_secret, "malformed
  env"}}`. Never echoes a key or value.
- `validate_secrets/1`: `nil` → `nil`; otherwise `validate_reference/1`.
  `"project_secrets"` is added to `@recognised_secrets` with a `valid_args?/2`
  clause requiring both `"project_id"` and `"organisation_id"` to be canonical
  36-character UUID strings, exactly as the org-credential clause does and for
  the same reason.
- Both run in `:initialise` and `:prepare` mode. The `shaped` type gains
  `env` and `secrets`.

**`Throng.Infra.SecretResolver`:**

```elixir
def resolve("project_secrets", %{"project_id" => project_id, "organisation_id" => org_id}) do
  project = Throng.Projects.get_project_by_id!(project_id, tenant: org_id, authorize?: false)
  {:ok, project.secret_environment_variables || %{}}
end
```

Behind the same `Process.get(:project_secrets_fn) || Application.get_env(...)`
seam the other clauses use, arity 1 taking the project id, so tests can stub
it without a project row. The `@spec` return type widens to include
`%{String.t() => String.t()}`. A project deleted between provision and
initialise raises from the bang lookup, which fails the boot; the instance is
being released anyway.

**`Throng.Agents.Manifest.Resolve`:**

- `initialise_payload/4` and `prepare_payload/2` each resolve
  `shaped.secrets` (a new `resolve_secrets/1`: `nil` → `{:ok, %{}}`; a
  reference → `SecretResolver.resolve/2`, and a non-map result is
  `{:error, {:unresolved_secret, "project_secrets"}}`) and emit
  `"env" => shaped.env` and `"secrets" => resolved`. Each is replaced by `nil`
  when empty, so the existing `Enum.reject(fn {_k, v} -> is_nil(v) end)` drops
  it and a project with nothing configured sends the exact wire shape it
  sends today.
- Plain and secret maps are **not** merged server-side. They travel as two
  keys so the agent knows which values to redact (5.3).
- The moduledoc's "never log the payload" warning now also covers `secrets`.

### 5.3 Agent runtime (`throng-agent`)

**`packages/core/src/manifest/types.ts`:** `WorkspaceManifest` gains
`env: Record<string, string>` and `secrets: Record<string, string>`. Both are
optional on the wire and default to `{}`, like `attachments`. On
`WorkspaceManifest` rather than `BaseManifest` because prepare receives them
too. A doc comment on `secrets` says: same effect as `env`, but its values
are redacted from everything that leaves the process.

**`packages/core/src/manifest/validate.ts`:** a shared `validateEnvMap(field,
value, errors)` used from `validateWorkspace` for both keys: must be a plain
object; every key matches `^[A-Za-z_][A-Za-z0-9_]*$`; every value is a string.
Field errors name the key (`env.NODE ENV`) but never a value. A key that
appears in both `env` and `secrets` is rejected at this layer too
(`"secrets.X"`: `"also set in env"`), since the server validation is the
primary guard and this is the sandbox's own.

**Two injection points, deliberately not one.** The naive design (write
everything into `process.env` right after validation) fails two ways: the
wrapper would then build its own config from a project-polluted environment
(§3), and on the prepare path the values would be captured in the snapshot's
memory image and resurrected in every restored sandbox (§3). So:

1. **Setup commands get an explicit environment.** `runSetupCommands(cwd,
   commands, env)` gains a third argument and passes it to `execFile` as
   `{ env }`. `runSetup` builds it as `{ ...process.env, ...manifest.env,
   ...manifest.secrets }` minus `RESERVED_ENV_KEYS`. This is the only way
   project variables reach setup on **both** paths. On prepare nothing else
   happens: `process.env` is never touched, so there is nothing to unset
   before `prepared`, and a snapshot never carries a project value in memory.
   The existing `deleteCredentialConfig` comment gets a sibling sentence
   saying so.
2. **The agent's own environment is mutated last.** On the boot path only, a
   new `applyProjectEnv(manifest)` step runs **after `buildAgentConfig` and
   before the A2A server starts**. It writes `manifest.env` then
   `manifest.secrets` into `process.env`, skipping `RESERVED_ENV_KEYS` with a
   `log.warn` naming the skipped key (never the value). Running after config
   build means `PORT`, `LOG_LEVEL`, `HOSTNAME` and the rest are ordinary
   variables a project may set: the wrapper has already read its own. Running
   after `injectCredentials` and skipping the credential names means the
   adapter's "selected credential wins, competitors scrubbed" guarantee cannot
   be disturbed. Running before the server starts means every SDK query, and
   so every shell the agent opens, inherits the variables. A comment states
   this ordering as load-bearing.

`RESERVED_ENV_KEYS` is exported from core: the Claude and Codex auth-scheme
env names plus `CLAUDE_AUTH_ALSO_SCRUB`, and `HOME`, `PATH`, `WORKSPACE_DIR`,
`THRONG_CONFIG`, `THRONG_CREDS_CACHE`. The two existing `log.info` lines that
log manifest counts gain `envCount` and `secretCount`; neither map is ever
logged.

**Redaction (`packages/core/src/bootstrap/setup.ts`):** `redactTokens` becomes
`redactSecrets(text, extraValues: readonly string[] = [])`, still applying the
GitHub token pattern and additionally replacing every verbatim occurrence of
each non-empty value in `extraValues` with `[REDACTED]`. `describeSetupFailure`
and the `setup command starting/failed/finished` logs pass
`Object.values(manifest.secrets)`. Longest value first so a value that is a
substring of another is not half-redacted. The existing `redactTokens` name is
kept as a zero-extras wrapper so callers outside setup do not churn.
`runSetupCommands`' result already carries the raw output for the caller, so
the secret values thread into `describeSetupFailure` from `runSetup`, which
holds the manifest.

**Tests (vitest):** validation accepts and rejects the shapes above; on boot,
setup commands see `env` and `secrets` while `process.env` is untouched until
after `buildAgentConfig` (spy order), and is populated before the server
starts; a reserved key in the manifest is skipped with a warning and the
manifest credential is what the process holds; on prepare, setup commands see
the variables and `process.env` is unchanged when `prepared` is reported;
setup failure output containing a secret value is redacted in both the message
and the log.

**Release:** a new `throng-agent` image version, then bump `BETA_VERSION` in
`throng_e2b_templates/throng-agent/template.ts` and rebuild the beta template.
Out of scope for the `throngx` PR; noted here so the plan has a row for it.

### 5.4 Settings UI (`throngx`)

A new card on the Sandbox tab, placed after "Startup commands" and before the
snapshot card. One form, one Save.

```
┌ Environment variables ─────────────────────────────────────────────┐
│ Set in every sandbox this project boots: task sessions, scheduled   │
│ runs and snapshot builds. Startup commands and the agent both see   │
│ them.                                                               │
│                                                                     │
│ Variables                                                           │
│ [NODE_ENV          ] [test                                  ] [🗑]  │
│ [API_BASE_URL      ] [http://localhost:4000                 ] [🗑]  │
│ [+ Add variable]                                                    │
│                                                                     │
│ Secrets        Encrypted at rest. Shown only here, never in logs.   │
│ [NPM_TOKEN         ] [••••••••••••••••••••••••••••••••  👁] [🗑]    │
│ [+ Add secret]                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                     [Save changes]  │
└─────────────────────────────────────────────────────────────────────┘
```

- Empty states, one line each in tertiary text: "No variables." and "No
  secrets."
- Key inputs are monospace `text_input`s with placeholder `NAME`. Plain value
  inputs are monospace `text_input`s. Secret value inputs are `type="password"`
  with the same trailing eye button `secure_input/1` renders, revealed per row.
- Add and Remove are `type="submit"` buttons carrying `name="action"`:
  `add:env`, `add:secret`, `remove:env:<index>`, `remove:secret:<index>`,
  exactly the `CommandListEditor` scheme. Save is `action=save`.

**New function component `ThrongWeb.Live.Project.EnvVarListEditor`**
(`env_var_list/1`), a sibling of `CommandListEditor` and built the same way:
stateless, `name` scopes params (`<name>[key][]`, `<name>[value][]`), `id`
scopes DOM ids, hidden `<name>_present` marker, a `secret` boolean attr that
switches the value input to masked-with-eye. It owns `rows/1` (params → list
of `%{key, value}`), `apply_action/3` and `clean/1` (drops rows where both key
and value are blank after trimming the key; keeps a blank-key row with a value
so the resource rejects it with "is required" and the user sees which row).

**`SettingsLive`:**

- Mount/`handle_params` for the Sandbox tab stages `env_rows` from
  `project.environment_variables` and `secret_rows` from
  `project.secret_environment_variables` sorted by key (a map has no order;
  sorting makes the list stable across saves).
- `handle_event("save_environment", params, socket)` branches on
  `params["action"]`: structural actions restage the touched list and leave
  the other alone; `save` builds
  `%{environment_variables: [...], secret_environment_variables: %{...}}` from
  whichever lists were on screen and calls `Throng.Projects.update_project/3`
  with the current scope. Success re-stages both lists from the saved project
  and flashes "Environment variables saved". Failure restages the submitted
  rows (so nothing typed is lost) and flashes the error via the existing
  `error_message/1`.
- After a save, secret inputs render masked again. A revealed secret is only
  ever revealed until the next render.
- `secure_input/1` stays as it is. The eye button markup is extracted into a
  small private component both it and the row editor use, so the toggle
  behaviour has one definition.

### 5.5 Docs

`docs/architecture/a2a-agent-architecture.md` §5.3 (the initialise payload)
gets the two new keys. No user-facing docs page covers the Sandbox tab today,
so the card's own description text is the documentation.

### 5.6 Tests (`throngx`)

- `EnvironmentVariable`: key pattern, trim, empty value allowed, value not
  trimmed.
- `Project` update: both attributes round-trip; secrets are encrypted in the
  row (read the raw column and assert it is not the plaintext); duplicate key
  across lists rejected; reserved key rejected; `nil` and `%{}` secrets both
  load as "none"; `:create` does not accept either attribute.
- `Manifest`: both builders set `env`; the `project_secrets` reference is set
  for a read-write context and for prepare, and nil for a read-only context;
  `to_stored`/`from_stored` round-trip; a stored manifest without the keys
  loads with `%{}` and `nil`.
- `Shape`: valid env; non-string key or value → `"malformed env"`;
  `project_secrets` with bad or missing args rejected; both modes.
- `SecretResolver`: returns the map, `%{}` for none, the seam is honoured.
- `Resolve`: initialise and prepare payloads carry `env` and `secrets`; both
  omitted when empty; a resolver error fails the payload; the payload's
  `secrets` never reaches `to_stored`.
- `SettingsLive`: card renders on the Sandbox tab; add/remove rows restage
  without persisting; save persists both; secret inputs are `type="password"`
  after load and after save; a reserved key shows the flash; emptying both
  lists and saving stores `[]` and `%{}`; blank rows are dropped.

## 6. Calls made for the builder

- Secret values are readable back in the UI by design (the eye toggle). This
  matches the organisation credentials card, which prefills the token.
- No reorder controls; rows render plain variables in stored order and secrets
  sorted by key.
- Values are never trimmed. Keys are trimmed and otherwise taken as typed,
  with no automatic upper-casing.
- Both attributes land on the primary `:update` action rather than a dedicated
  action, because the Sandbox tab's other cards already save through it and
  `:update` is not an assistant tool.
- Plain env is stored literally in the manifest; secrets are a reference.
  Admin therefore shows plain variables for an instance and never a secret.

## 7. Left to the builder

- Exact Tailwind classes and spacing of the card, matching the startup
  commands card.
- Whether `EnvVarListEditor` shares a private helper with `CommandListEditor`
  for the `action` encoding, or duplicates the dozen lines.
- The precise `description` strings on the two new attributes.
- Test file layout, following the existing `_test.exs` files beside each
  module this touches.
