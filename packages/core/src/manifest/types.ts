import type { EngineAdapter } from "../engine/adapter.js";

export interface RepoSpec {
  url: string;
  ref: string;
  dest: string;
  primary: boolean;
}

/**
 * Where `throng-creds` fetches GitHub tokens from, and the identity it presents
 * when it does.
 *
 * `token` is task-scoped: useless outside the control plane, revocable per task,
 * and bound server-side to an installation, a repo set and a permission set. It
 * must stay valid for the task's entire lifetime including pauses — there is no
 * rotation path into a running sandbox.
 */
export interface CredentialsConfig {
  url: string;
  token: string;
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

/**
 * The workspace half of a manifest: everything needed to put repositories and
 * their dependencies on disk, and nothing about the agent that will use them.
 *
 * `/api/prepare` sends exactly this, and a snapshot built from it is shared by
 * every task in the project — so the absence of `agent` and `user_identity` is
 * a property of the type, not a convention the two routes have to remember.
 */
export interface WorkspaceManifest {
  repos: RepoSpec[];
  /** Pull mode. Null in standalone mode, where `github_token` is used instead. */
  credentials: CredentialsConfig | null;
  /** A literal token. Takes precedence over `credentials` when both are set. */
  github_token: string | null;
  setup_commands: string[];
}

/** Engine-agnostic manifest skeleton owned by core: a workspace plus the commit
 *  identity the task's work is attributed to. */
export interface BaseManifest extends WorkspaceManifest {
  user_identity: UserIdentity;
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

export type PrepareValidateResult =
  | { ok: true; manifest: WorkspaceManifest }
  | { ok: false; errors: FieldError[] };
