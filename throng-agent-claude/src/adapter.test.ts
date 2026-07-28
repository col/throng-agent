import { describe, expect, it } from "vitest";
import type { Manifest } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "./adapter.js";
import type { ResolvedClaudeAgent } from "./manifest/claude-agent.js";

describe("ClaudeEngineAdapter", () => {
  it("validateAgent rejects a missing agent block", () => {
    const a = new ClaudeEngineAdapter();
    expect(a.validateAgent({}, {}).ok).toBe(false);
  });

  it("classifyBootError names plugins when a marketplace is configured", () => {
    const a = new ClaudeEngineAdapter();
    const manifest = {
      agent: { plugins: { local: [], marketplaces: { m: {} }, enabledPlugins: {}, unpinned: [] } },
    } as unknown as Manifest<ResolvedClaudeAgent>;
    expect(a.classifyBootError(new Error("plugin did not load"), manifest)).toBe("plugins");
    expect(a.classifyBootError(new Error("something else"), manifest)).toBe(undefined);
  });

  it("injectCredentials sets ANTHROPIC_API_KEY", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const a = new ClaudeEngineAdapter();
      a.injectCredentials({
        agent: { keys: {}, plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] }, anthropic_api_key: "sk-x" },
      } as unknown as Manifest<ResolvedClaudeAgent>);
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-x");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
