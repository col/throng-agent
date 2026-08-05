import type { AuthScheme } from "@throng/agent-core";

/**
 * The credential modes the Codex engine accepts. ChatGPT-subscription auth uses
 * an on-disk `auth.json` rather than an environment variable, so it has no place
 * in this table; `api_key` is the only mode.
 */
export const CODEX_AUTH_SCHEMES: readonly AuthScheme[] = [
  { type: "api_key", env: "OPENAI_API_KEY" },
];
