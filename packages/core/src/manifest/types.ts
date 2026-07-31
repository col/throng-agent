import type { EngineAdapter } from "../engine/adapter.js";

export interface RepoSpec {
  url: string;
  ref: string;
  dest: string;
  primary: boolean;
  token: string | null;
}

export interface FieldError {
  field: string;
  reason: string;
}

/**
 * The identity commits are made under. Fields mirror git's own `[user]` config
 * section, which is exactly what they become. Deliberately not `username`: in
 * GitHub's vocabulary that is the account handle (`octocat`), not a display name.
 *
 * Separate from the GitHub credential on purpose — a commit identity is a git
 * concept, unrelated to which forge (or token) the work is pushed with. Each field
 * is resolved to `string | null`, so consumers never re-derive "was this sent?".
 */
export interface UserIdentity {
  name: string | null;
  email: string | null;
}

/** Engine-agnostic manifest skeleton owned by core. */
export interface BaseManifest {
  repos: RepoSpec[];
  github_token: string | null;
  user_identity: UserIdentity;
  setup_commands: string[];
}

/**
 * Full manifest = generic skeleton + the resolved platform tag (lifted out of
 * the raw `agent` object during validation) + the engine's resolved agent payload.
 */
export interface Manifest<TAgent = unknown> extends BaseManifest {
  platform: string;
  agent: TAgent;
}

export type ValidateResult<TAgent = unknown> =
  | { ok: true; manifest: Manifest<TAgent>; adapter: EngineAdapter<TAgent> }
  | { ok: false; errors: FieldError[] };
