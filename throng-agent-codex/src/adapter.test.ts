import { describe, expect, it } from "vitest";
import type { Manifest } from "@throng/agent-core";
import { CodexEngineAdapter } from "./adapter.js";
import type { ResolvedCodexAgent } from "./manifest/codex-agent.js";

describe("CodexEngineAdapter", () => {
  it("validateAgent rejects a missing agent block", () => {
    expect(new CodexEngineAdapter().validateAgent({}, {}).ok).toBe(false);
  });

  it("injectCredentials sets OPENAI_API_KEY from agent.auth", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      new CodexEngineAdapter().injectCredentials({
        platform: "codex",
        agent: { keys: {}, auth: { type: "api_key", token: "sk-c" } },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-c");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });

  it("injectCredentials leaves an ambient key alone when no auth was resolved", () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-ambient";
    try {
      new CodexEngineAdapter().injectCredentials({
        platform: "codex",
        agent: { keys: {}, auth: null },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-ambient");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
