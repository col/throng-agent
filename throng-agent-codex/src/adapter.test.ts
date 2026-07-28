import { describe, expect, it } from "vitest";
import type { Manifest } from "@throng/agent-core";
import { CodexEngineAdapter } from "./adapter.js";
import type { ResolvedCodexAgent } from "./manifest/codex-agent.js";

describe("CodexEngineAdapter", () => {
  it("validateAgent rejects a missing agent block", () => {
    expect(new CodexEngineAdapter().validateAgent({}, {}).ok).toBe(false);
  });

  it("injectCredentials sets OPENAI_API_KEY", () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      new CodexEngineAdapter().injectCredentials({
        platform: "codex",
        agent: { keys: {}, api_key: "sk-c" },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-c");
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
    }
  });
});
