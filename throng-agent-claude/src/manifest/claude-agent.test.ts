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

  it("resolves an oauth auth block", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "oauth", token: "oat-1" } } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "oauth", token: "oat-1" });
  });

  it("resolves an api_key auth block", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "api_key", token: "sk-1" } } }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "api_key", token: "sk-1" });
  });

  it("falls back to CLAUDE_CODE_OAUTH_TOKEN ahead of ANTHROPIC_API_KEY", () => {
    const r = validateClaudeAgent({ agent: {} }, {
      CLAUDE_CODE_OAUTH_TOKEN: "oat-env",
      ANTHROPIC_API_KEY: "sk-env",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toEqual({ type: "oauth", token: "oat-env" });
  });

  it("resolves no auth when neither the manifest nor the env carries one", () => {
    const r = validateClaudeAgent({ agent: {} }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agent.auth).toBe(null);
  });

  it("rejects an auth type the engine does not accept", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "chatgpt", token: "x" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.auth.type")).toBe(true);
  });

  it("reports an auth error alongside an unrelated agent error in one result", () => {
    const r = validateClaudeAgent({ agent: { auth: { type: "oauth" }, effort: "nope" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.field).sort()).toEqual(["agent.auth.token", "agent.effort"]);
    }
  });

  it("resolves plugins into channels", () => {
    const r = validateClaudeAgent(
      { agent: { plugins: [{ path: "/opt/p" }], auth: { type: "api_key", token: "sk" } } },
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

  it("accepts a valid effort level", () => {
    const r = validateClaudeAgent({ agent: { effort: "high" } }, {});
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown effort level", () => {
    const r = validateClaudeAgent({ agent: { effort: "turbo" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.effort")).toBe(true);
  });

  it("accepts adaptive and disabled thinking", () => {
    for (const type of ["adaptive", "disabled"]) {
      const r = validateClaudeAgent({ agent: { thinking: { type } } }, {});
      expect(r.ok).toBe(true);
    }
  });

  it("accepts enabled thinking with a budget", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "enabled", budget_tokens: 2048 } } }, {});
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown thinking type", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "hard" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking")).toBe(true);
  });

  it("rejects non-object thinking", () => {
    const r = validateClaudeAgent({ agent: { thinking: "adaptive" } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking")).toBe(true);
  });

  it("rejects enabled thinking without a numeric budget", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "enabled" } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking.budget_tokens")).toBe(true);
  });

  it("rejects enabled thinking with a budget below 1024", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "enabled", budget_tokens: 500 } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking.budget_tokens")).toBe(true);
  });

  it("rejects enabled thinking with a non-integer budget", () => {
    const r = validateClaudeAgent({ agent: { thinking: { type: "enabled", budget_tokens: 1500.5 } } }, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.thinking.budget_tokens")).toBe(true);
  });
});
