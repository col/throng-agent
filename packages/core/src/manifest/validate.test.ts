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

describe("validate (github_token)", () => {
  const tok = (input: Record<string, unknown>, env = {}) => {
    const r = validate({ ...okInput, ...input }, registry, env);
    if (!r.ok) throw new Error(`expected valid manifest, got ${JSON.stringify(r.errors)}`);
    return r.manifest;
  };

  it("takes the top-level github_token in preference to the env var", () => {
    expect(tok({ github_token: "from_root" }, { GITHUB_TOKEN: "from_env" }).github_token).toBe(
      "from_root",
    );
  });

  it("falls back to GITHUB_TOKEN, and treats a blank token as absent", () => {
    expect(tok({}, { GITHUB_TOKEN: "from_env" }).github_token).toBe("from_env");
    expect(tok({ github_token: "  " }, { GITHUB_TOKEN: "from_env" }).github_token).toBe("from_env");
    expect(tok({}).github_token).toBeNull();
  });

  it("rejects a non-string github_token", () => {
    const r = validate({ ...okInput, github_token: 1 }, registry, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "github_token")).toBe(true);
  });
});

describe("validate (user_identity)", () => {
  const identity = (input: Record<string, unknown>) => {
    const r = validate({ ...okInput, ...input }, registry, {});
    if (!r.ok) throw new Error(`expected valid manifest, got ${JSON.stringify(r.errors)}`);
    return r.manifest.user_identity;
  };

  it("resolves both fields", () => {
    expect(identity({ user_identity: { name: "Throng Bot", email: "bot@throng.dev" } })).toEqual({
      name: "Throng Bot",
      email: "bot@throng.dev",
    });
  });

  // Omitting the block entirely is the pre-existing manifest shape.
  it("defaults each field to null when the block is absent or partial", () => {
    expect(identity({})).toEqual({ name: null, email: null });
    expect(identity({ user_identity: {} })).toEqual({ name: null, email: null });
    expect(identity({ user_identity: { name: "Throng Bot" } })).toEqual({
      name: "Throng Bot",
      email: null,
    });
  });

  // git rejects an empty ident, so a blank would only fail later, at commit time.
  it("treats blank fields as absent", () => {
    expect(identity({ user_identity: { name: "  ", email: "" } })).toEqual({
      name: null,
      email: null,
    });
  });

  it("is independent of the token", () => {
    const r = validate(
      { ...okInput, github_token: "t", user_identity: { name: "Throng Bot" } },
      registry,
      {},
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.github_token).toBe("t");
      expect(r.manifest.user_identity.name).toBe("Throng Bot");
    }
  });

  it("rejects a non-object user_identity", () => {
    const r = validate({ ...okInput, user_identity: "Throng Bot" }, registry, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "user_identity")).toBe(true);
  });

  it("rejects non-string fields inside the block", () => {
    const r = validate({ ...okInput, user_identity: { name: [], email: {} } }, registry, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.field).sort()).toEqual([
        "user_identity.email",
        "user_identity.name",
      ]);
    }
  });
});

describe("credentials block", () => {
  const base = {
    repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
    agent: { platform: "test", model: "m" },
  };

  it("is optional", () => {
    const r = validate(base, registry);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.credentials).toBeNull();
  });

  it("resolves url and token onto the manifest", () => {
    const r = validate(
      { ...base, credentials: { url: "https://cp.example", token: "task-tok" } },
      registry,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.credentials).toEqual({ url: "https://cp.example", token: "task-tok" });
  });

  it("rejects a non-object", () => {
    const r = validate({ ...base, credentials: "nope" }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "credentials")).toBe(true);
  });

  it("rejects a blank url or token", () => {
    const r = validate({ ...base, credentials: { url: "  ", token: "" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "credentials.url")).toBe(true);
      expect(r.errors.some((e) => e.field === "credentials.token")).toBe(true);
    }
  });

  it("rejects a missing url", () => {
    const r = validate({ ...base, credentials: { token: "t" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "credentials.url")).toBe(true);
  });

  it("rejects a non-https url", () => {
    const r = validate({ ...base, credentials: { url: "http://cp.example", token: "t" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "credentials.url")).toBe(true);
  });

  it("rejects a trailing slash on the url", () => {
    const r = validate({ ...base, credentials: { url: "https://cp.example/", token: "t" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "credentials.url")).toBe(true);
  });

  // Accepted so an unchanged control plane does not start receiving 400s, but
  // it carries no information: throng-creds scopes per repo already.
  it("accepts and ignores repos[].token", () => {
    const r = validate(
      {
        ...base,
        repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true, token: "ghs_old" }],
      },
      registry,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect("token" in r.manifest.repos[0]).toBe(false);
  });

  it("keeps github_token and its GITHUB_TOKEN fallback", () => {
    const explicit = validate({ ...base, github_token: "ghp_a" }, registry, {});
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.manifest.github_token).toBe("ghp_a");

    const fallback = validate(base, registry, { GITHUB_TOKEN: "ghp_b" });
    expect(fallback.ok).toBe(true);
    if (fallback.ok) expect(fallback.manifest.github_token).toBe("ghp_b");
  });
});
