import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectGitIdentity } from "./git-identity.js";

const VARS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GH_TOKEN",
  "GIT_ASKPASS",
] as const;

describe("injectGitIdentity", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
  });

  afterEach(() => {
    for (const [v, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  });

  // Without an identity git refuses to commit ("Author identity unknown"),
  // which an agent then papers over by inventing one.
  it("sets the commit identity for both author and committer", () => {
    injectGitIdentity({ name: "throng-bot", email: "bot@throng.dev" });

    expect(process.env.GIT_AUTHOR_NAME).toBe("throng-bot");
    expect(process.env.GIT_COMMITTER_NAME).toBe("throng-bot");
    expect(process.env.GIT_AUTHOR_EMAIL).toBe("bot@throng.dev");
    expect(process.env.GIT_COMMITTER_EMAIL).toBe("bot@throng.dev");
  });

  it("sets nothing when there is nothing to set", () => {
    injectGitIdentity({ name: null, email: null });

    for (const v of VARS) expect(process.env[v]).toBeUndefined();
  });

  // The whole point of the pull model: no GitHub credential ever reaches the
  // environment, because an environment cannot be refreshed.
  it("never puts a GitHub credential in the environment", () => {
    injectGitIdentity({ name: "throng-bot", email: "bot@throng.dev" });

    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.GIT_ASKPASS).toBeUndefined();
  });
});
