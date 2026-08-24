import { describe, expect, it } from "vitest";
import { validate, validatePrepare } from "./validate.js";
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

describe("validate (empty repo list)", () => {
  it("accepts repos: [] with a valid agent block", () => {
    const r = validate({ repos: [], agent: { platform: "test", model: "m" } }, registry);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.repos).toEqual([]);
  });

  // The pair matters, which is why the primary rule is pinned here rather than
  // among the routing tests where it used to live. Dropping the rule outright
  // instead of making it conditional would also pass the case above, and would
  // let a real manifest through with no primary — which resolveWorkingDirectory
  // has no cwd for. Note this fires for a single-repo list too: `primary` names the
  // directory the agent runs in, so one repo must still claim it.
  it("still requires exactly one primary when repos is non-empty", () => {
    const r = validate(
      { repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: false }], agent: { platform: "test" } },
      registry,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "repos[].primary")).toBe(true);
  });

  it("still requires the repos key to be present", () => {
    const r = validate({ agent: { platform: "test", model: "m" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ field: "repos", reason: "is required" });
  });

  it("still rejects a non-array repos", () => {
    const r = validate({ repos: {}, agent: { platform: "test", model: "m" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ field: "repos", reason: "must be a list" });
  });

  it("accepts repos: [] on prepare too", () => {
    const r = validatePrepare({ repos: [] }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.repos).toEqual([]);
  });

  it("still requires the repos key on prepare", () => {
    const r = validatePrepare({}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContainEqual({ field: "repos", reason: "is required" });
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

// The exact body Throng.Agents.Manifest.Resolve.prepare_payload/2 produces.
// Keys whose value is nil are dropped by the control plane, so github_token is
// absent here rather than null.
const preparePayload = {
  repos: [{ url: "https://github.com/acme/web.git", ref: "main", dest: "web", primary: true }],
  setup_commands: ["mise install", "mix deps.get"],
  credentials: { url: "https://cp.example/api/credentials", token: "identity-token" },
};

describe("validatePrepare", () => {
  const errorsOf = (input: unknown) => {
    const r = validatePrepare(input);
    if (r.ok) throw new Error("expected validation to fail");
    return r.errors;
  };

  // An explicit empty env, like the initialise token cases: github_token falls
  // back to GITHUB_TOKEN, so a developer with one set would otherwise fail this.
  it("accepts the control plane's prepare payload", () => {
    const r = validatePrepare(preparePayload, {});

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.repos).toEqual([
        { url: "https://github.com/acme/web.git", ref: "main", dest: "web", primary: true },
      ]);
      expect(r.manifest.setup_commands).toEqual(["mise install", "mix deps.get"]);
      expect(r.manifest.credentials).toEqual({
        url: "https://cp.example/api/credentials",
        token: "identity-token",
      });
      expect(r.manifest.github_token).toBeNull();
      // The type has no user_identity, and the built manifest must not grow one:
      // git identity is a per-task /api/initialise concern and a `git config
      // --global` write does not belong in an image shared by every task.
      expect("user_identity" in r.manifest).toBe(false);
    }
  });

  it("accepts the standalone form with a static github_token", () => {
    const { credentials, ...rest } = preparePayload;
    const r = validatePrepare({ ...rest, github_token: "ghp_static" }, {});

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.github_token).toBe("ghp_static");
      expect(r.manifest.credentials).toBeNull();
    }
  });

  // Rejected rather than ignored. A snapshot is shared by every task in the
  // project and is stored by E2B, so no agent configuration and no LLM credential
  // may be baked into one. The control plane guarantees that by construction —
  // prepare_payload/2 never references these fields — so a manifest carrying one
  // is an initialise manifest sent to the wrong route, and saying so is more
  // useful than silently building a snapshot the caller misunderstands.
  it("rejects an agent block", () => {
    const fields = errorsOf({ ...preparePayload, agent: { platform: "claude" } }).map((e) => e.field);
    expect(fields).toContain("agent");
  });

  // Presence, not truthiness: an explicit null is still a caller that thinks this
  // route takes an agent.
  it("rejects an explicitly null agent block", () => {
    expect(errorsOf({ ...preparePayload, agent: null }).map((e) => e.field)).toContain("agent");
  });

  it("rejects a user_identity block", () => {
    const fields = errorsOf({ ...preparePayload, user_identity: { name: "A", email: "a@b.c" } }).map(
      (e) => e.field,
    );
    expect(fields).toContain("user_identity");
  });

  // Both, not just the first. These are two independent pushes onto one error
  // list, and the validators in this file report every bad field at once so a
  // caller with two mistakes gets one complete 400 rather than a second round
  // trip — an early return between them would still pass the two cases above.
  it("reports both agent and user_identity when a manifest carries both", () => {
    const fields = errorsOf({
      ...preparePayload,
      agent: { platform: "claude" },
      user_identity: { name: "A", email: "a@b.c" },
    }).map((e) => e.field);

    expect(fields).toContain("agent");
    expect(fields).toContain("user_identity");
  });

  it("applies the same repo rules as initialise", () => {
    // Direct, not via errorsOf: that helper throws when validation succeeds, and
    // an empty repo list is now a success on this route just as it is on
    // initialise. The parity is the point of the assertion.
    expect(validatePrepare({ ...preparePayload, repos: [] }).ok).toBe(true);
    expect(errorsOf({ repos: preparePayload.repos.map((r) => ({ ...r, primary: false })) }).map((e) => e.field))
      .toContain("repos[].primary");
    expect(errorsOf({ ...preparePayload, repos: [{ ...preparePayload.repos[0], url: "http://x/y" }] })
      .map((e) => e.field)).toContain("repos[0].url");
  });

  it("applies the same credentials and setup_commands rules as initialise", () => {
    expect(errorsOf({ ...preparePayload, credentials: { url: "https://cp/", token: "t" } })
      .map((e) => e.field)).toContain("credentials.url");
    expect(errorsOf({ ...preparePayload, setup_commands: [""] }).map((e) => e.field))
      .toContain("setup_commands");
  });

  // The two rules the suite above reaches only through `validate`: one cross-field
  // and one per-field. Both routes call the same helpers, so what this catches is
  // a wiring regression specific to validatePrepare — the cross-field pass
  // dropped, or `repos` handed to it where the whole input belongs.
  //
  // Separate calls, deliberately: crossFieldRepoErrors runs only once every
  // per-field check has passed, so a manifest carrying both mistakes would report
  // github_token alone and the dest rule would never be exercised.
  it("applies the shared dest-uniqueness and github_token rules", () => {
    const duplicated = {
      ...preparePayload,
      repos: [
        { url: "https://github.com/acme/web.git", ref: "main", dest: "web", primary: true },
        { url: "https://github.com/acme/api.git", ref: "main", dest: "web", primary: false },
      ],
    };
    expect(errorsOf(duplicated).map((e) => e.field)).toContain("repos[].dest");

    expect(errorsOf({ ...preparePayload, github_token: 1 }).map((e) => e.field)).toContain(
      "github_token",
    );
  });

  // Prepare-only, and the asymmetry with initialise is the point. git writes the
  // clone URL verbatim into <dest>/.git/config, that file is inside the workspace
  // the snapshot captures, and the credential wipe only reaches $HOME/.throng —
  // so on this route a token in the URL is a credential baked into an image every
  // task in the project boots from. On a task sandbox the same URL is a logging
  // concern that redactTokens already handles, and rejecting it there would send
  // new 400s to an unchanged control plane.
  it("rejects a repo url with credentials embedded in it", () => {
    const withCreds = (url: string) =>
      errorsOf({ ...preparePayload, repos: [{ ...preparePayload.repos[0], url }] }).map((e) => e.field);

    expect(withCreds("https://x-access-token:ghs_live@github.com/acme/web.git")).toContain("repos[0].url");
    expect(withCreds("https://ghp_live@github.com/acme/web.git")).toContain("repos[0].url");
  });

  it("accepts an @ that is not userinfo", () => {
    // A path segment, not an authority: git stores nothing sensitive here.
    const r = validatePrepare(
      { ...preparePayload, repos: [{ ...preparePayload.repos[0], url: "https://git.example/~@acme/web.git" }] },
      {},
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(errorsOf(42).map((e) => e.field)).toEqual(["manifest"]);
  });
});

// A shared rule, so it is pinned on both routes at once. `join(workspaceRoot, ".")`
// is the workspace root itself, and syncOrClone removes a destination that is not
// already a work tree for the same remote — so accepting this would turn one
// manifest field into `rm -rf` of the whole workspace, including repos synced
// earlier in the same loop. Before syncOrClone it was a plain clone failure.
describe("repos[].dest may not resolve to the workspace root", () => {
  const initialise = (dest: string) =>
    validate({ repos: [{ url: "https://x/y", ref: "main", dest, primary: true }], agent: { platform: "test" } }, registry, {});
  const prepare = (dest: string) =>
    validatePrepare({ ...preparePayload, repos: [{ ...preparePayload.repos[0], dest }] }, {});

  it.each([".", "./"])("is rejected by both routes for %j", (dest) => {
    for (const r of [initialise(dest), prepare(dest)]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.map((e) => e.field)).toContain("repos[0].dest");
    }
  });

  // The guard must not catch an ordinary nested destination, which is the shape
  // a multi-repo project actually sends.
  it("still accepts a nested dest on both routes", () => {
    expect(initialise("services/api").ok).toBe(true);
    expect(prepare("services/api").ok).toBe(true);
  });
});

describe("validate (credential-bearing repo urls stay legal on initialise)", () => {
  // The counterpart to the prepare rejection above. This form is deliberate
  // input on /api/initialise — the fixtures in this repo use it and redactTokens
  // exists for it — so a regression that moved the check into the shared repo
  // rules would start 400ing an unchanged control plane. Pinned from both sides.
  it("accepts a repo url with credentials embedded in it", () => {
    const r = validate(
      {
        repos: [
          {
            url: "https://x-access-token:ghs_live@github.com/acme/web.git",
            ref: "main",
            dest: "web",
            primary: true,
          },
        ],
        agent: { platform: "test" },
      },
      registry,
      {},
    );

    expect(r.ok).toBe(true);
  });
});
