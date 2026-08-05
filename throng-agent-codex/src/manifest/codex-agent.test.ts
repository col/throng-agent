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

  it("resolves an api_key auth block, short-circuiting the environment", () => {
    const r = validateCodexAgent(
      { agent: { auth: { type: "api_key", token: "sk-in" } } },
      { OPENAI_API_KEY: "sk-env" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "api_key", token: "sk-in" });
  });

  it("falls back to OPENAI_API_KEY", () => {
    const r = validateCodexAgent({ agent: {} }, { OPENAI_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "api_key", token: "sk-env" });
  });

  it("resolves no auth when neither the manifest nor the env carries one", () => {
    const r = validateCodexAgent({ agent: {} }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toBe(null);
  });

  it("rejects type oauth, which Codex does not accept", () => {
    const r = validateCodexAgent({ agent: { auth: { type: "oauth", token: "oat" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.auth.type")).toBe(true);
  });

  it("rejects a blank token", () => {
    const r = validateCodexAgent({ agent: { auth: { type: "api_key", token: "" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.auth.token")).toBe(true);
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

  it("passes unknown agent keys through", () => {
    const r = validateCodexAgent({ agent: { nonsense: true, model: "o4-mini" } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.keys.nonsense).toBe(true);
      expect(r.agent.keys.model).toBe("o4-mini");
    }
  });

  it("excludes auth from the raw keys passthrough, though agent.auth still carries it", () => {
    // keys is a raw-keys bag; auth carries a plaintext token, so a future
    // refactor back to `keys: a` would silently re-duplicate the credential.
    const r = validateCodexAgent(
      { agent: { model: "o4-mini", auth: { type: "api_key", token: "sk-1" } } },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.agent.keys).not.toHaveProperty("auth");
      expect(r.agent.keys.model).toBe("o4-mini");
      expect(r.agent.auth).toEqual({ type: "api_key", token: "sk-1" });
    }
  });
});
