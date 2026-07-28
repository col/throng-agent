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
  throng_api_token: string | null;
}

/** Full manifest = generic skeleton + the engine's resolved agent payload. */
export interface Manifest<TAgent = unknown> extends BaseManifest {
  agent: TAgent;
}

export type ValidateResult<TAgent = unknown> =
  | { ok: true; manifest: Manifest<TAgent> }
  | { ok: false; errors: FieldError[] };
