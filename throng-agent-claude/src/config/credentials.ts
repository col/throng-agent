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
export const CLAUDE_AUTH_SCHEMES: readonly AuthScheme[] = [
  { type: "oauth", env: "CLAUDE_CODE_OAUTH_TOKEN" },
  { type: "api_key", env: "ANTHROPIC_API_KEY" },
];

/**
 * A credential the SDK honours but the manifest does not accept as input, so it
 * is cleared without ever becoming a fallback source.
 */
export const CLAUDE_AUTH_ALSO_SCRUB: readonly string[] = ["ANTHROPIC_AUTH_TOKEN"];

/** Every env var a settings file must not mention, whatever its value. */
const FORBIDDEN_PINS: readonly string[] = [
  ...CLAUDE_AUTH_SCHEMES.map((s) => s.env),
  ...CLAUDE_AUTH_ALSO_SCRUB,
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Guards against ~/.claude/settings.json overriding the credential we just set,
 * by either route Claude Code's own precedence gives priority over our
 * per-process value: an `env` block naming one of the credential variables, or
 * a top-level `apiKeyHelper` script. The latter outranks
 * `CLAUDE_CODE_OAUTH_TOKEN` and survives `applyAuth`'s scrub, since it isn't an
 * environment variable at all — it never mattered while the only thing this
 * engine injected was `ANTHROPIC_API_KEY`, which outranks it, but it matters
 * the moment `oauth` becomes an injectable mode. Either route quietly rebills
 * the run to an account nobody chose.
 *
 * Settings must not *mention* a forbidden variable at all, whatever its value:
 * a settings `env` block replaces the inherited variable rather than merging
 * with it, so `env: { ANTHROPIC_API_KEY: "" }` erases the credential we just
 * set and reads to Claude Code as unset, letting it fall through to the next
 * rung of its precedence chain exactly as a deleted variable would. So this
 * checks key presence (`Object.hasOwn`), not truthiness.
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
  if (!isObject(parsed)) return;

  const offenders: string[] = [];
  const env = parsed.env;
  if (isObject(env)) {
    offenders.push(...FORBIDDEN_PINS.filter((name) => Object.hasOwn(env, name)).map((name) => `env.${name}`));
  }
  if (parsed.apiKeyHelper) offenders.push("apiKeyHelper");

  if (offenders.length > 0) {
    throw new Error(
      `${settingsPath} sets ${offenders.join(", ")}, which overrides the per-process credential. ` +
        `Remove ${offenders.length > 1 ? "them" : "it"}.`,
    );
  }
}
