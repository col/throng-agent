import type { AuthScheme } from "@throng/agent-core";

/**
 * The credential modes the Codex engine accepts. ChatGPT-subscription auth uses
 * an on-disk `auth.json` rather than an environment variable, so it has no place
 * in this table; `api_key` is the only mode.
 *
 * That on-disk file has no override-precedence hazard to guard against here,
 * unlike Claude's settings file (see `assertNoAnthropicCredentialInSettings`):
 * nothing in this repo writes `~/.codex/auth.json` or sets `CODEX_HOME`, so
 * there is no self-inflicted exposure to a stale or ambient credential on disk.
 */
export const CODEX_AUTH_SCHEMES: readonly AuthScheme[] = [
  { type: "api_key", env: "OPENAI_API_KEY" },
];
