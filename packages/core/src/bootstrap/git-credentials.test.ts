import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectGitCredentials, injectGitIdentity } from "./git-credentials.js";

const VARS = [
  "GIT_ASKPASS",
  "GIT_ASKPASS_USERNAME",
  "GIT_ASKPASS_TOKEN",
  "GIT_TERMINAL_PROMPT",
  "GH_TOKEN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

describe("injectGitCredentials", () => {
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

  it("exposes the token to git and to the gh CLI", () => {
    injectGitCredentials("ghs_secret");

    expect(process.env.GIT_ASKPASS_TOKEN).toBe("ghs_secret");
    expect(process.env.GIT_ASKPASS_USERNAME).toBe("x-access-token");
    expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
    // `gh` authenticates from GH_TOKEN; without it the CLI is installed but
    // logged out, and agents fall back to raw api.github.com calls.
    expect(process.env.GH_TOKEN).toBe("ghs_secret");
  });

  it("leaves GITHUB_TOKEN alone — gh prefers GH_TOKEN and that name is widely read", () => {
    injectGitCredentials("ghs_secret");

    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  // Without an identity git refuses to commit ("Author identity unknown"), which
  // an agent then papers over by inventing one.
  it("sets the commit identity for both author and committer", () => {
    injectGitIdentity({ name: "throng-bot", email: "bot@throng.dev" });

    expect(process.env.GIT_AUTHOR_NAME).toBe("throng-bot");
    expect(process.env.GIT_COMMITTER_NAME).toBe("throng-bot");
    expect(process.env.GIT_AUTHOR_EMAIL).toBe("bot@throng.dev");
    expect(process.env.GIT_COMMITTER_EMAIL).toBe("bot@throng.dev");
  });

  it("credentials and identity are independent of each other", () => {
    // Identity only — the auth vars stay unset.
    injectGitIdentity({ name: "throng-bot", email: null });
    expect(process.env.GIT_AUTHOR_NAME).toBe("throng-bot");
    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.GIT_ASKPASS).toBeUndefined();

    // Token only — the pre-`github`-block manifest shape.
    for (const v of VARS) delete process.env[v];
    injectGitCredentials("ghs_secret");
    expect(process.env.GH_TOKEN).toBe("ghs_secret");
    expect(process.env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(process.env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it("sets nothing when there is nothing to set", () => {
    injectGitCredentials(null);
    injectGitIdentity({ name: null, email: null });

    for (const v of VARS) expect(process.env[v]).toBeUndefined();
  });
});
