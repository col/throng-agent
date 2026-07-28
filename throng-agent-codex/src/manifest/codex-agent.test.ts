import { describe, expect, it } from "vitest";
import { validateCodexAgent } from "./codex-agent.js";

describe("validateCodexAgent", () => {
  it("requires the agent block", () => {
    expect(validateCodexAgent({}, {}).ok).toBe(false);
  });

  it("rejects a non-object agent block", () => {
    const r = validateCodexAgent({ agent: 5 }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });

  it("resolves api_key from agent.api_key then OPENAI_API_KEY", () => {
    expect((validateCodexAgent({ agent: { api_key: "sk-in" } }, {}) as any).agent.api_key).toBe("sk-in");
    const r = validateCodexAgent({ agent: {} }, { OPENAI_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.api_key).toBe("sk-env");
  });

  it("rejects a non-string model", () => {
    const r = validateCodexAgent({ agent: { model: 5 } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.model")).toBe(true);
  });

  it("rejects an unknown sandbox_mode", () => {
    const r = validateCodexAgent({ agent: { sandbox_mode: "nope" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.sandbox_mode")).toBe(true);
  });

  it("accepts a valid sandbox_mode", () => {
    const r = validateCodexAgent({ agent: { sandbox_mode: "workspace-write" } }, {});
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown approval_policy", () => {
    const r = validateCodexAgent({ agent: { approval_policy: "always" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.approval_policy")).toBe(true);
  });

  it("accepts a valid approval_policy", () => {
    const r = validateCodexAgent({ agent: { approval_policy: "never" } }, {});
    expect(r.ok).toBe(true);
  });

  it("rejects a non-string agent.api_key", () => {
    const r = validateCodexAgent({ agent: { api_key: 5 } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.api_key")).toBe(true);
  });

  it("passes unknown agent keys through", () => {
    const r = validateCodexAgent({ agent: { nonsense: true, model: "o4-mini" } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.keys.nonsense).toBe(true);
      expect(r.agent.keys.model).toBe("o4-mini");
    }
  });
});
