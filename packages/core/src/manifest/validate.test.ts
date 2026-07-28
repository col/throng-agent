import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";
import type { EngineAdapter } from "../engine/adapter.js";

// A trivial adapter: requires agent to be an object, echoes it as the payload.
const echoAdapter: Pick<EngineAdapter<Record<string, unknown>>, "validateAgent"> = {
  validateAgent: (input) => {
    if (typeof input.agent !== "object" || input.agent === null) {
      return { ok: false, errors: [{ field: "agent", reason: "is required" }] };
    }
    return { ok: true, agent: input.agent as Record<string, unknown> };
  },
};

const okInput = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: { model: "m" },
};

describe("validate (generic core)", () => {
  it("rejects a non-object manifest", () => {
    const r = validate(42, echoAdapter as EngineAdapter, {});
    expect(r.ok).toBe(false);
  });

  it("requires exactly one primary repo", () => {
    const r = validate(
      { repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: false }], agent: {} },
      echoAdapter as EngineAdapter,
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "repos[].primary")).toBe(true);
  });

  it("delegates agent validation to the adapter", () => {
    const r = validate({ ...okInput, agent: undefined }, echoAdapter as EngineAdapter, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });

  it("builds a manifest with the adapter's resolved agent payload", () => {
    const r = validate(okInput, echoAdapter as EngineAdapter, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.repos[0].primary).toBe(true);
      expect(r.manifest.agent).toEqual({ model: "m" });
    }
  });
});
