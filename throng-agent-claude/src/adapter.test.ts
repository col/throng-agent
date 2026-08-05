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

  it("injectCredentials selects OAuth and clears an ambient API key", () => {
    const saved = { api: process.env.ANTHROPIC_API_KEY, oat: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.ANTHROPIC_API_KEY = "sk-ambient";
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      new ClaudeEngineAdapter().injectCredentials({
        platform: "claude",
        agent: {
          keys: {},
          plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] },
          auth: { type: "oauth", token: "oat-x" },
        },
      } as unknown as Manifest<ResolvedClaudeAgent>);
      // The ambient key is the whole point: the SDK reads it off the environment,
      // so leaving it set would bill API credits despite the OAuth manifest.
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-x");
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (saved.api === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.api;
      if (saved.oat === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oat;
    }
  });

  it("injectCredentials selects the API key and clears an ambient OAuth token", () => {
    const saved = { api: process.env.ANTHROPIC_API_KEY, oat: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oat-ambient";
    delete process.env.ANTHROPIC_API_KEY;
    try {
      new ClaudeEngineAdapter().injectCredentials({
        platform: "claude",
        agent: {
          keys: {},
          plugins: { local: [], marketplaces: {}, enabledPlugins: {}, unpinned: [] },
          auth: { type: "api_key", token: "sk-x" },
        },
      } as unknown as Manifest<ResolvedClaudeAgent>);
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-x");
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (saved.api === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.api;
      if (saved.oat === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oat;
    }
  });
});
