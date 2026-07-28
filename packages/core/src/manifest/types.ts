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

/** Engine-agnostic manifest skeleton owned by core. */
export interface BaseManifest {
  repos: RepoSpec[];
  github_token: string | null;
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
