import { describe, expect, it } from "vitest";
import type { EngineAdapter, ServerHandle } from "./adapter.js";

describe("EngineAdapter contract", () => {
  it("a minimal adapter satisfies the interface", async () => {
    const handle: ServerHandle = { shutdown: async () => {} };
    const adapter: EngineAdapter<{ model: string }, { port: number }> = {
      validateAgent: () => ({ ok: true, agent: { model: "x" } }),
      injectCredentials: () => {},
      buildAgentConfig: () => ({ port: 3030 }),
      createA2AServer: async () => handle,
    };
    const r = adapter.validateAgent({}, {});
    expect(r.ok).toBe(true);
    expect(await adapter.createA2AServer({ port: 3030 })).toBe(handle);
  });
});
