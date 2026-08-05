import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "@throng/agent-core";
import { CodexEngineAdapter } from "./adapter.js";
import { CODEX_AUTH_SCHEMES } from "./config/credentials.js";
import type { ResolvedCodexAgent } from "./manifest/codex-agent.js";

// Derived, not hand-maintained, so it can't drift from what applyAuth actually touches.
const CREDENTIAL_VARS = CODEX_AUTH_SCHEMES.map((s) => s.env);

describe("CodexEngineAdapter", () => {
  it("validateAgent rejects a missing agent block", () => {
    expect(new CodexEngineAdapter().validateAgent({}, {}).ok).toBe(false);
  });

  describe("injectCredentials", () => {
    // applyAuth deletes keys, not just sets them, so each test starts from a clean
    // slate (a leaked deletion would otherwise leak as a silent absence into
    // whichever file vitest's worker runs next) and the whole set is restored.
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
      saved = Object.fromEntries(CREDENTIAL_VARS.map((n) => [n, process.env[n]]));
      for (const n of CREDENTIAL_VARS) delete process.env[n];
    });
    afterEach(() => {
      for (const n of CREDENTIAL_VARS) {
        const v = saved[n];
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    });

    it("sets OPENAI_API_KEY from agent.auth, overwriting an ambient value", () => {
      process.env.OPENAI_API_KEY = "sk-ambient";
      new CodexEngineAdapter().injectCredentials({
        platform: "codex",
        agent: { keys: {}, auth: { type: "api_key", token: "sk-c" } },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-c");
    });

    it("leaves an ambient key alone when no auth was resolved", () => {
      process.env.OPENAI_API_KEY = "sk-ambient";
      new CodexEngineAdapter().injectCredentials({
        platform: "codex",
        agent: { keys: {}, auth: null },
      } as unknown as Manifest<ResolvedCodexAgent>);
      expect(process.env.OPENAI_API_KEY).toBe("sk-ambient");
    });
  });
});
