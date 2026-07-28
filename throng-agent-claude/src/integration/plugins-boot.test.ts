import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, type ServerHandle } from "@throng/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeEngineAdapter } from "../adapter.js";

/**
 * Exercises the real path — manifest → validate (via the adapter) →
 * buildAgentConfig → createA2AServer — against a real marketplace. Everything
 * else about plugins is unit-tested with fakes; this covers the one thing fakes
 * cannot: that the config we generate is actually accepted by the SDK and
 * installs a plugin.
 *
 * Network-gated: skipped without ANTHROPIC_API_KEY. The preflight itself needs
 * no valid credential (the init message precedes any model call), but it does
 * need to reach GitHub, so the key doubles as a "this environment has network
 * and credentials" signal.
 */
const RUN = Boolean(process.env.ANTHROPIC_API_KEY);
const MARKETPLACE = "obra/superpowers-marketplace";
const adapter = new ClaudeEngineAdapter();

function manifestWith(plugins: unknown[], workspace: string) {
  const result = validate(
    {
      repos: [{ url: "https://x/y", ref: "main", dest: "app", primary: true }],
      agent: { permission_mode: "plan", plugins },
    },
    adapter,
  );
  if (!result.ok) throw new Error(`manifest invalid: ${JSON.stringify(result.errors)}`);
  return adapter.buildAgentConfig(result.manifest, workspace);
}

describe.runIf(RUN)("plugin boot (real marketplace)", () => {
  let handle: ServerHandle | undefined;
  let workspace: string;
  let configDir: string;
  let prevConfigDir: string | undefined;
  let prevPort: string | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "throng-plugin-ws-"));
    configDir = mkdtempSync(join(tmpdir(), "throng-plugin-cfg-"));
    // Keep the plugin cache out of the developer's real ~/.claude.
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    prevPort = process.env.A2A_PORT;
    process.env.A2A_PORT = "3986";
  });

  afterEach(async () => {
    await handle?.shutdown();
    handle = undefined;
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevPort === undefined) delete process.env.A2A_PORT;
    else process.env.A2A_PORT = prevPort;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it("boots with a marketplace plugin installed", async () => {
    const config = manifestWith(
      [{ name: "superpowers", marketplace: MARKETPLACE, ref: "main" }],
      workspace,
    );
    expect(config.claude.enabledPlugins).toEqual({ "superpowers@superpowers-marketplace": true });

    handle = await adapter.createA2AServer(config);

    // The preflight ran and passed, or createA2AServer would have thrown before
    // binding — so a live /health proves the plugin loaded and the agent is up.
    const res = await fetch("http://localhost:3986/health");
    expect(res.ok).toBe(true);
  }, 180_000);

  it("refuses to start when the plugin is not in the marketplace", async () => {
    const config = manifestWith(
      [{ name: "no-such-plugin", marketplace: MARKETPLACE, ref: "main" }],
      workspace,
    );

    await expect(adapter.createA2AServer(config)).rejects.toThrow(
      /did not load: no-such-plugin@superpowers-marketplace/,
    );
  }, 180_000);
});
