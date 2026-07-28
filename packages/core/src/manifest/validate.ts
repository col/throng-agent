import type { Env } from "../env.js";
import type { EngineAdapter } from "../engine/adapter.js";
import type { BaseManifest, FieldError, Manifest, RepoSpec, ValidateResult } from "./types.js";

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

const nonEmptyString = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? null : "must be a non-empty string";

export function validate<TAgent>(
  input: unknown,
  adapter: EngineAdapter<TAgent>,
  env: Env = process.env,
): ValidateResult<TAgent> {
  if (!isObject(input)) {
    return { ok: false, errors: [{ field: "manifest", reason: "must be a JSON object" }] };
  }
  const errors: FieldError[] = [];

  validateRepos(input.repos, errors);

  // Engine-specific validation (agent block + engine credentials) is delegated.
  const agentResult = adapter.validateAgent(input, env);
  if (!agentResult.ok) errors.push(...agentResult.errors);

  // Generic token fields (type-only). Engine credentials are the adapter's job.
  for (const f of ["throng_api_token", "github_token"]) {
    if (f in input && typeof input[f] !== "string") {
      errors.push({ field: f, reason: "must be a string" });
    }
  }

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

  // agentResult is ok here for a well-behaved adapter (its errors would have
  // returned above). Guard the invariant explicitly rather than assume it, so a
  // misbehaving adapter that returns { ok: false, errors: [] } can't fall
  // through to a silent `undefined` agent.
  if (!agentResult.ok) return { ok: false, errors: agentResult.errors };
  return { ok: true, manifest: buildManifest(input, repos, env, agentResult.agent) };
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

function buildManifest<TAgent>(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  env: Env,
  agent: TAgent,
): Manifest<TAgent> {
  const defaultToken = blankToNil(input.github_token) ?? blankToNil(env.GITHUB_TOKEN);
  const specs: RepoSpec[] = repos.map((r) => ({
    url: r.url as string,
    ref: r.ref as string,
    dest: r.dest as string,
    primary: r.primary as boolean,
    token: blankToNil(r.token) ?? defaultToken,
  }));
  const base: BaseManifest = {
    repos: specs,
    github_token: defaultToken,
    setup_commands: (input.setup_commands as string[] | undefined) ?? [],
    throng_api_token: blankToNil(input.throng_api_token) ?? blankToNil(env.THRONG_API_TOKEN),
  };
  return { ...base, agent };
}
