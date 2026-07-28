import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Sets ANTHROPIC_API_KEY in-process (once per sandbox). No-op when key is null. */
export function injectAnthropicKey(key: string | null): void {
  if (key) process.env.ANTHROPIC_API_KEY = key;
}

/**
 * Guards against ~/.claude/settings.json pinning env.ANTHROPIC_API_KEY, which
 * the SDK would give precedence over our per-process key. Absent/unreadable/
 * unparseable settings are treated as fine.
 */
export function assertNoAnthropicKeyInSettings(
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
  if (env && env.ANTHROPIC_API_KEY) {
    throw new Error(
      `${settingsPath} sets env.ANTHROPIC_API_KEY, which overrides the per-process key. Remove it.`,
    );
  }
}
