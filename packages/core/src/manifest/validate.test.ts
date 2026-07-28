import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";
import type { AgentResult, EngineAdapter } from "../engine/adapter.js";

// Echo adapter: assumes core already checked agent-is-object + platform;
// echoes the raw agent object as its resolved payload.
const echo: EngineAdapter<Record<string, unknown>> = {
  validateAgent: (input): AgentResult<Record<string, unknown>> => ({
    ok: true,
    agent: input.agent as Record<string, unknown>,
  }),
  injectCredentials: () => {},
  buildAgentConfig: () => ({}),
  createA2AServer: async () => ({ shutdown: async () => {} }),
};
const registry = { test: echo };

const okInput = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: { platform: "test", model: "m" },
};

describe("validate (registry routing)", () => {
  it("rejects a non-object manifest", () => {
    expect(validate(42, registry).ok).toBe(false);
  });
  it("rejects a missing agent block", () => {
    const r = validate({ repos: okInput.repos }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });
  it("rejects a missing platform", () => {
    const r = validate({ ...okInput, agent: { model: "m" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.platform")).toBe(true);
  });
  it("rejects an unknown platform", () => {
    const r = validate({ ...okInput, agent: { platform: "nope" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent.platform")).toBe(true);
  });
  it("requires exactly one primary repo", () => {
    const r = validate(
      { agent: { platform: "test" }, repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: false }] },
      registry,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "repos[].primary")).toBe(true);
  });
  it("builds a manifest with resolved platform + selected adapter", () => {
    const r = validate(okInput, registry);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.platform).toBe("test");
      expect(r.manifest.agent).toEqual({ platform: "test", model: "m" });
      expect(r.adapter).toBe(echo);
      expect("throng_api_token" in r.manifest).toBe(false);
    }
  });
});
