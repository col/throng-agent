import type { Env } from "../env.js";

const blankToNil = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/**
 * Resolves the generic `agent.api_key` for an engine: the manifest value if
 * present and non-blank, else the first non-blank value among the engine's
 * fallback env vars (e.g. ANTHROPIC_API_KEY), else null. The env target is
 * engine-specific, so each adapter passes its own SDK env var(s) as fallback.
 */
export function resolveApiKey(
  agent: Record<string, unknown>,
  env: Env,
  fallbackEnvVars: string[],
): string | null {
  const fromManifest = blankToNil(agent.api_key);
  if (fromManifest) return fromManifest;
  for (const name of fallbackEnvVars) {
    const v = blankToNil(env[name]);
    if (v) return v;
  }
  return null;
}
