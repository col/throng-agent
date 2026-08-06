import type { Env } from "../env.js";
import type { AdapterRegistry, EngineAdapter } from "../engine/adapter.js";
import { log } from "../log.js";
import type {
  BaseManifest,
  CredentialsConfig,
  FieldError,
  Manifest,
  PrepareValidateResult,
  RepoSpec,
  ValidateResult,
  WorkspaceManifest,
} from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const nonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? null : "must be a non-empty string";

export function validate(
  input: unknown,
  registry: AdapterRegistry,
  env: Env = process.env,
): ValidateResult {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "manifest", reason: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];

  validateWorkspace(input, errors);

  // Routing: core reads exactly one reserved sub-field, agent.platform, to pick
  // the adapter. Everything else in `agent` is the selected adapter's payload.
  let adapter: EngineAdapter<any, any> | undefined;
  if (!("agent" in input)) {
    errors.push({ field: "agent", reason: "is required" });
  } else if (!isObject(input.agent)) {
    errors.push({ field: "agent", reason: "must be an object" });
  } else {
    const platform = input.agent.platform;
    if (typeof platform !== "string" || !(platform in registry)) {
      errors.push({
        field: "agent.platform",
        reason: `must be one of ${Object.keys(registry).join(", ")}`,
      });
    } else {
      adapter = registry[platform];
    }
  }

  // Delegate the rest of the agent block to the selected adapter (only when one
  // was resolved — otherwise the routing errors above already explain the 400).
  const agentResult = adapter ? adapter.validateAgent(input, env) : undefined;
  if (agentResult && !agentResult.ok) errors.push(...agentResult.errors);

  validateUserIdentity(input.user_identity, errors);

  if (errors.length > 0) return { ok: false, errors };

  // Cross-field rules run only after all per-field checks pass.
  const repos = input.repos as Array<Record<string, unknown>>;
  const cross = crossFieldRepoErrors(repos);
  if (cross.length > 0) return { ok: false, errors: cross };

  // adapter + agentResult are defined and ok here (errors would have returned
  // above). Guard the invariant explicitly rather than assume it.
  if (!adapter || !agentResult || !agentResult.ok) {
    return { ok: false, errors: [{ field: "agent", reason: "could not be resolved" }] };
  }
  const platform = (input.agent as Record<string, unknown>).platform as string;
  return { ok: true, manifest: buildManifest(input, repos, platform, agentResult.agent, env), adapter };
}

/**
 * The `/api/prepare` manifest: a workspace and nothing else.
 *
 * Shares every per-field and cross-field rule with `validate` above, so the
 * snapshot build and the task boot that restores from it cannot disagree about
 * what a repo list means.
 */
export function validatePrepare(input: unknown, env: Env = process.env): PrepareValidateResult {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "manifest", reason: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];

  validateWorkspace(input, errors);

  // Rejected, not ignored. A snapshot is shared by every task in the project and
  // is stored by E2B, so nothing task-specific and no LLM credential may be baked
  // into one. The control plane guarantees that by construction —
  // prepare_payload/2 never references these fields — so a manifest that carries
  // one is an initialise manifest sent to the wrong route, and a 400 says that
  // where silently ignoring it would build a snapshot the caller misunderstands.
  //
  // Presence, not truthiness: an explicit null is the same mistake.
  if ("agent" in input) {
    errors.push({
      field: "agent",
      reason:
        "must not be sent to /api/prepare: a snapshot is shared by every task in the project and carries no agent configuration or credential",
    });
  }
  if ("user_identity" in input) {
    errors.push({
      field: "user_identity",
      reason:
        "must not be sent to /api/prepare: the commit identity is injected per task by /api/initialise",
    });
  }

  rejectCredentialBearingRepoUrls(input.repos, errors);

  if (errors.length > 0) return { ok: false, errors };

  const repos = input.repos as Array<Record<string, unknown>>;
  const cross = crossFieldRepoErrors(repos);
  if (cross.length > 0) return { ok: false, errors: cross };

  return { ok: true, manifest: buildWorkspaceManifest(input, repos, env) };
}

/**
 * Prepare-only, and deliberately not a rule `validate` shares.
 *
 * `https://x-access-token:ghs_…@github.com/…` is legal input on
 * `/api/initialise` on purpose: this repo's own fixtures use that form,
 * `redactTokens` exists to keep it out of logs and error messages, and
 * `validateRepos`' `repos[].token` comment records the standing policy of not
 * sending new 400s to an unchanged control plane.
 *
 * The asymmetry is the point. On a task sandbox a credential in the URL is a
 * logging concern, and the sandbox dies with the task. On a snapshot it is a
 * persistence hole: `git clone` writes the URL verbatim into
 * `<dest>/.git/config` as `remote.origin.url`, that file lives under
 * `workspaceRoot` and is captured by the filesystem image every task in the
 * project boots from, and `deleteCredentialConfig` — which only ever touches
 * `$HOME/.throng` — cannot reach it. `syncOrClone`'s remove-and-reclone branch
 * does not help either: the fresh clone writes the same URL back.
 *
 * Checked here rather than through a flag threaded into the shared
 * `validateRepos`, because it is a prepare policy and belongs beside the other
 * two prepare-only rejections, not inside a function both routes call.
 */
function rejectCredentialBearingRepoUrls(value: unknown, errors: FieldError[]): void {
  // A non-array is not this rule's problem: validateWorkspace has already
  // reported it, and the 400 explains the shape before it explains the contents.
  if (!Array.isArray(value)) return;
  value.forEach((repo, i) => {
    const url = isObject(repo) ? repo.url : undefined;
    // Userinfo is everything before an `@` in the authority, so the character
    // class stops at `/` to avoid matching an `@` in a later path segment.
    if (typeof url === "string" && /^https:\/\/[^/@]*@/.test(url)) {
      errors.push({
        field: `repos[${i}].url`,
        reason:
          "must not embed credentials (user:pass@): git stores the URL verbatim in .git/config, which a snapshot keeps and the credential wipe cannot reach",
      });
    }
  });
}

/** Every per-field rule both routes share. */
function validateWorkspace(input: Record<string, unknown>, errors: FieldError[]): void {
  validateRepos(input.repos, errors);

  if ("github_token" in input && typeof input.github_token !== "string") {
    errors.push({ field: "github_token", reason: "must be a string" });
  }

  validateCredentials(input.credentials, errors);

  if ("setup_commands" in input) {
    const list = input.setup_commands;
    if (!Array.isArray(list)) {
      errors.push({ field: "setup_commands", reason: "must be a list of strings" });
    } else if (!list.every((c) => typeof c === "string" && c.trim() !== "")) {
      errors.push({ field: "setup_commands", reason: "each entry must be a non-empty string" });
    }
  }
}

/** Rules that need every repo at once; run only after the per-field ones pass. */
function crossFieldRepoErrors(repos: Array<Record<string, unknown>>): FieldError[] {
  const errors: FieldError[] = [];
  const primaries = repos.filter((r) => r.primary === true).length;
  if (primaries !== 1) {
    errors.push({
      field: "repos[].primary",
      reason: `exactly one repo must be marked primary: true (got ${primaries})`,
    });
  }
  const dests = repos.map((r) => r.dest);
  if (new Set(dests).size !== dests.length) {
    errors.push({ field: "repos[].dest", reason: "dest values must be unique across repos" });
  }
  return errors;
}

function validateRepos(value: unknown, errors: FieldError[]): void {
  if (value === undefined) {
    errors.push({ field: "repos", reason: "is required" });
    return;
  }
  if (!Array.isArray(value)) {
    errors.push({ field: "repos", reason: "must be a list" });
    return;
  }
  if (value.length === 0) {
    errors.push({ field: "repos", reason: "must contain at least one entry" });
    return;
  }
  value.forEach((repo, i) => {
    if (!isObject(repo)) {
      errors.push({ field: `repos[${i}]`, reason: "must be an object" });
      return;
    }
    const url = repo.url;
    if (typeof url !== "string" || !url.startsWith("https://")) {
      errors.push({ field: `repos[${i}].url`, reason: "must start with https://" });
    }
    if (nonEmptyString(repo.ref)) errors.push({ field: `repos[${i}].ref`, reason: "must be a non-empty string" });
    const dest = repo.dest;
    if (typeof dest !== "string" || dest.trim() === "") {
      errors.push({ field: `repos[${i}].dest`, reason: "must be a non-empty relative path string" });
    } else if (dest.startsWith("/")) {
      errors.push({ field: `repos[${i}].dest`, reason: "must be a relative path (absolute paths are rejected)" });
    } else if (dest.split("/").includes("..")) {
      errors.push({ field: `repos[${i}].dest`, reason: "must not contain '..' path segments" });
    } else if (dest.split("/").every((s) => s === "" || s === ".")) {
      // "." and "./" pass every check above — non-empty, not absolute, no ".."
      // segments — but `join(workspaceRoot, ".")` collapses to the workspace root
      // itself, and syncOrClone deletes a destination that is not already a work
      // tree for the same remote. So this one input turns into `rm -rf` of the
      // whole workspace, taking with it every repo cloned earlier in the same
      // loop. It is rejected rather than special-cased downstream because the
      // dest rules are the only place that owns what a destination may name.
      //
      // Not a behaviour regression: before syncOrClone existed this was a hard
      // `git clone` failure ("destination path already exists"), so no working
      // caller can be sending it.
      errors.push({
        field: `repos[${i}].dest`,
        reason: "must name a subdirectory of the workspace, not the workspace itself",
      });
    }
    if (typeof repo.primary !== "boolean") {
      errors.push({ field: `repos[${i}].primary`, reason: "must be a boolean" });
    }
    // Retired by the pull model: throng-creds scopes per repo through
    // credential.useHttpPath, so a static per-repo token is a second, weaker
    // mechanism for something the helper already does properly. Still ACCEPTED
    // so an unchanged control plane does not start receiving 400s.
    if ("token" in repo) {
      log.warn("repos[].token is ignored; credentials are fetched per operation", { repo: i });
    }
  });
}

/**
 * The optional `user_identity` block. Both fields are optional and the block
 * itself may be omitted entirely — a manifest that sends neither behaves exactly
 * as it did before the block existed. `undefined` means "not sent"; a wrong type
 * is a 400 rather than something silently coerced, matching `github_token`.
 */
function validateUserIdentity(value: unknown, errors: FieldError[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push({ field: "user_identity", reason: "must be an object" });
    return;
  }
  for (const key of ["name", "email"] as const) {
    if (key in value && typeof value[key] !== "string") {
      errors.push({ field: `user_identity.${key}`, reason: "must be a string" });
    }
  }
}

/**
 * The optional `credentials` block. Omitted entirely in standalone mode, where a
 * literal `github_token` is used instead. Both fields are required when the
 * block is present — a half-configured helper would fail at the first clone
 * rather than at initialise, which is much harder to diagnose.
 */
function validateCredentials(value: unknown, errors: FieldError[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push({ field: "credentials", reason: "must be an object" });
    return;
  }
  const url = value.url;
  if (typeof url !== "string" || url.trim() === "") {
    errors.push({ field: "credentials.url", reason: "must be a non-empty string" });
  } else if (!url.startsWith("https://")) {
    // Same requirement as repos[].url: this endpoint hands back live GitHub
    // and control-plane tokens, so it is never appropriate to send in the clear.
    errors.push({ field: "credentials.url", reason: "must start with https://" });
  } else if (url.endsWith("/")) {
    // throng-creds POSTs to this URL verbatim, so a trailing slash is sent as
    // given: ".../credentials/github/" is a different route from
    // ".../credentials/github" to most routers, and they 404 it rather than
    // reject it outright — the helper would then report a confusing runtime
    // error at the first clone. Rejecting here, where the operator gets a
    // precise field error, is cheaper than normalising and hoping the result
    // still matches what the control plane serves.
    errors.push({ field: "credentials.url", reason: "must not end with a trailing slash" });
  }
  const tokenReason = nonEmptyString(value.token);
  if (tokenReason) errors.push({ field: "credentials.token", reason: tokenReason });
}

function buildWorkspaceManifest(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  env: Env,
): WorkspaceManifest {
  const specs: RepoSpec[] = repos.map((r) => ({
    url: r.url as string,
    ref: r.ref as string,
    dest: r.dest as string,
    primary: r.primary as boolean,
  }));
  const creds = isObject(input.credentials) ? input.credentials : null;
  const credentials: CredentialsConfig | null = creds
    ? { url: creds.url as string, token: creds.token as string }
    : null;
  return {
    repos: specs,
    credentials,
    github_token: blankToNil(input.github_token) ?? blankToNil(env.GITHUB_TOKEN),
    setup_commands: (input.setup_commands as string[] | undefined) ?? [],
  };
}

function buildManifest(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  platform: string,
  agent: unknown,
  env: Env,
): Manifest {
  // A blank name/email is treated as absent, the same way a blank token is: git
  // rejects an empty ident, so passing one through would only fail later.
  const identity = isObject(input.user_identity) ? input.user_identity : {};
  const base: BaseManifest = {
    ...buildWorkspaceManifest(input, repos, env),
    user_identity: { name: blankToNil(identity.name), email: blankToNil(identity.email) },
  };
  return { ...base, platform, agent };
}
