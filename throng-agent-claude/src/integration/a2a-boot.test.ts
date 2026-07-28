import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerHandle } from "@throng/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeEngineAdapter } from "../adapter.js";

/**
 * Real boot through the ClaudeEngineAdapter: validateAgent → buildAgentConfig →
 * createA2AServer. Proves the adapter's slices produce a config the a2a-claude
 * SDK actually accepts and serves.
 */
const adapter = new ClaudeEngineAdapter();

function manifest() {
  const result = adapter.validateAgent({ agent: {} }, {});
  if (!result.ok) throw new Error(`agent invalid: ${JSON.stringify(result.errors)}`);
  return {
    repos: [{ url: "https://x/y", ref: "main", dest: "app", primary: true, token: null }],
    github_token: null,
    setup_commands: [],
    agent: result.agent,
    throng_api_token: null,
  };
}

describe("createA2AServer real boot", () => {
  let handle: ServerHandle | undefined;
  let prevHost: string | undefined;
  let prevPort: string | undefined;

  afterEach(async () => {
    await handle?.shutdown();
    handle = undefined;
    if (prevHost === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = prevHost;
    if (prevPort === undefined) delete process.env.A2A_PORT;
    else process.env.A2A_PORT = prevPort;
  });

  it("binds 0.0.0.0 and serves /health even when HOSTNAME is a container id", async () => {
    prevHost = process.env.HOSTNAME;
    prevPort = process.env.A2A_PORT;
    // A container id would break app.listen(port, hostname) if it leaked into the bind.
    process.env.HOSTNAME = "container-deadbeef";
    process.env.A2A_PORT = "3987";
    const dir = mkdtempSync(join(tmpdir(), "a2a-boot-"));

    const cfg = adapter.buildAgentConfig(manifest(), dir);
    handle = await adapter.createA2AServer(cfg);

    const res = await fetch("http://localhost:3987/health");
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("healthy");
  }, 15000);
});
