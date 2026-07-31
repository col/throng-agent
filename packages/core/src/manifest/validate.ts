import type { Env } from "../env.js";
import type { AdapterRegistry, EngineAdapter } from "../engine/adapter.js";
import type { BaseManifest, FieldError, Manifest, RepoSpec, ValidateResult } from "./types.js";

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

  validateRepos(input.repos, errors);

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

  if ("github_token" in input && typeof input.github_token !== "string") {
    errors.push({ field: "github_token", reason: "must be a string" });
  }

  validateUserIdentity(input.user_identity, errors);

  if ("setup_commands" in input) {
    const list = input.setup_commands;
    if (!Array.isArray(list)) {
      errors.push({ field: "setup_commands", reason: "must be a list of strings" });
    } else if (!list.every((c) => typeof c === "string" && c.trim() !== "")) {
      errors.push({ field: "setup_commands", reason: "each entry must be a non-empty string" });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Cross-field rules run only after all per-field checks pass.
  const repos = input.repos as Array<Record<string, unknown>>;
  const cross: FieldError[] = [];
  const primaries = repos.filter((r) => r.primary === true).length;
  if (primaries !== 1) {
    cross.push({
      field: "repos[].primary",
      reason: `exactly one repo must be marked primary: true (got ${primaries})`,
    });
  }
  const dests = repos.map((r) => r.dest);
  if (new Set(dests).size !== dests.length) {
    cross.push({ field: "repos[].dest", reason: "dest values must be unique across repos" });
  }
  if (cross.length > 0) return { ok: false, errors: cross };

  // adapter + agentResult are defined and ok here (errors would have returned
  // above). Guard the invariant explicitly rather than assume it.
  if (!adapter || !agentResult || !agentResult.ok) {
    return { ok: false, errors: [{ field: "agent", reason: "could not be resolved" }] };
  }
  const platform = (input.agent as Record<string, unknown>).platform as string;
  return { ok: true, manifest: buildManifest(input, repos, platform, agentResult.agent, env), adapter };
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
    }
    if (typeof repo.primary !== "boolean") {
      errors.push({ field: `repos[${i}].primary`, reason: "must be a boolean" });
    }
    if ("token" in repo && typeof repo.token !== "string") {
      errors.push({ field: `repos[${i}].token`, reason: "must be a string" });
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

function buildManifest(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  platform: string,
  agent: unknown,
  env: Env,
): Manifest {
  const defaultToken = blankToNil(input.github_token) ?? blankToNil(env.GITHUB_TOKEN);
  const specs: RepoSpec[] = repos.map((r) => ({
    url: r.url as string,
    ref: r.ref as string,
    dest: r.dest as string,
    primary: r.primary as boolean,
    token: blankToNil(r.token) ?? defaultToken,
  }));
  // A blank name/email is treated as absent, the same way a blank token is: git
  // rejects an empty ident, so passing one through would only fail later.
  const identity = isObject(input.user_identity) ? input.user_identity : {};
  const base: BaseManifest = {
    repos: specs,
    github_token: defaultToken,
    user_identity: { name: blankToNil(identity.name), email: blankToNil(identity.email) },
    setup_commands: (input.setup_commands as string[] | undefined) ?? [],
  };
  return { ...base, platform, agent };
}
