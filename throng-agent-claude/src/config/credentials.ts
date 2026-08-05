import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthScheme } from "@throng/agent-core";

/**
 * The credential modes the Claude engine accepts, in env-fallback precedence
 * order. OAuth first: a container carrying both variables is already an odd
 * configuration, and going to the trouble of exporting an OAuth token is an
 * unambiguous request for subscription billing.
 */
export const CLAUDE_AUTH_SCHEMES: AuthScheme[] = [
  { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { type: "api_key", env: "ANTHROPIC_API_KEY" },
];

/**
 * A credential the SDK honours but the manifest does not accept as input, so it
 * is cleared without ever becoming a fallback source.
 */
export const CLAUDE_AUTH_ALSO_SCRUB = ["ANTHROPIC_AUTH_TOKEN"];

/** Every credential variable a settings file must not pin. */
const PINNABLE = [...CLAUDE_AUTH_SCHEMES.map((s) => s.env), ...CLAUDE_AUTH_ALSO_SCRUB];

/** Sets ANTHROPIC_API_KEY in-process (once per sandbox). No-op when key is null. */
export function injectAnthropicKey(key: string | null): void {
  if (key) process.env.ANTHROPIC_API_KEY = key;
}

/**
 * Guards against ~/.claude/settings.json pinning any Anthropic credential in its
 * `env` block, which the SDK gives precedence over our per-process value. All of
 * them are rejected regardless of which mode was selected: a pinned
 * CLAUDE_CODE_OAUTH_TOKEN overrides ours exactly as readily as a pinned API key
 * does, and either way the run is billed to an account nobody chose.
 *
 * Absent/unreadable/unparseable settings are treated as fine — the file is
 * optional, and a missed check costs less than refusing to boot over one.
 */
export function assertNoAnthropicCredentialInSettings(
  settingsPath: string = join(homedir(), ".claude", "settings.json"),
): void {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const env = (parsed as { env?: Record<string, unknown> } | null)?.env;
  if (!env) return;
  const pinned = PINNABLE.find((name) => env[name]);
  if (pinned) {
    throw new Error(
      `${settingsPath} sets env.${pinned}, which overrides the per-process credential. Remove it.`,
    );
  }
}
