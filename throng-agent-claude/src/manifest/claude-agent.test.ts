import { describe, expect, it } from "vitest";
import { validateClaudeAgent } from "./claude-agent.js";

describe("validateClaudeAgent", () => {
  it("requires the agent block", () => {
    const r = validateClaudeAgent({}, {});
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown permission mode", () => {
    const r = validateClaudeAgent({ agent: { permission_mode: "nope" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.permission_mode")).toBe(true);
  });

  it("resolves api_key from agent.api_key", () => {
    const r = validateClaudeAgent({ agent: { api_key: "sk-in" } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.api_key).toBe("sk-in");
  });

  it("falls back to ANTHROPIC_API_KEY when agent.api_key is absent", () => {
    const r = validateClaudeAgent({ agent: {} }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.api_key).toBe("sk-env");
  });

  it("rejects a non-string agent.api_key", () => {
    const r = validateClaudeAgent({ agent: { api_key: 5 } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.api_key")).toBe(true);
  });

  it("resolves plugins into channels", () => {
    const r = validateClaudeAgent(
      { agent: { plugins: [{ path: "/opt/p" }], api_key: "sk" } },
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.plugins.local).toHaveLength(1);
  });

  it("accepts bypassPermissions as a permission mode", () => {
    const r = validateClaudeAgent({ agent: { permission_mode: "bypassPermissions" } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.keys.permission_mode).toBe("bypassPermissions");
  });

  it("reports a bad plugin entry alongside other agent errors", () => {
    const r = validateClaudeAgent(
      { agent: { model: 5, plugins: [{}] } },
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "agent.model")).toBe(true);
      expect(r.errors.some((e) => e.field.startsWith("agent.plugins["))).toBe(true);
    }
  });
});
