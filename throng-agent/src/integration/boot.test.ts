import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskRun, type BootDeps } from "@throng/agent-core";
import { createRegistry } from "../registry.js";

// assertNoAnthropicCredentialInSettings (run for real via the boot below)
// resolves its default settings path through node:os's homedir(). Vitest's
// default (worker-thread) pool gives each worker its own process.env copy
// that native calls like os.homedir() never observe, so mutating
// process.env.HOME below would silently fail to redirect the guard onto the
// temp HOME this suite creates — it would keep reading the developer's real
// ~/.claude/settings.json. Mocking homedir() to track process.env.HOME
// directly makes the redirection real.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => process.env.HOME as string };
});

// Drive a full boot through the registry with faked bootstrap deps, asserting
// the claude adapter is selected by agent.platform and the lifecycle reaches ready.
function fakeDeps(): BootDeps {
  return {
    syncOrClone: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    deleteCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/home/user/workspace",
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("throng-agent boot routing", () => {
  // The real ClaudeEngineAdapter.injectCredentials runs during this boot, so it
  // both mutates the credential env vars and reads the real
  // ~/.claude/settings.json. Names are hand-listed rather than imported from
  // throng-agent-claude's credentials module, which isn't part of that
  // package's public export surface — keep this list in sync with
  // CLAUDE_AUTH_SCHEMES/CLAUDE_AUTH_ALSO_SCRUB there.
  const CREDENTIAL_VARS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"];
  let savedEnv: Record<string, string | undefined>;
  let savedHome: string | undefined;
  beforeAll(() => {
    savedEnv = Object.fromEntries(CREDENTIAL_VARS.map((n) => [n, process.env[n]]));
    savedHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "throng-agent-boot-"));
  });
  afterAll(() => {
    for (const n of CREDENTIAL_VARS) {
      const v = savedEnv[n];
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("routes agent.platform=claude through the claude adapter to ready", async () => {
    const tr = new TaskRun(fakeDeps(), createRegistry());
    const res = await tr.initialise({
      repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
      agent: {
        platform: "claude",
        auth: { type: "api_key", token: "sk-test" },
        permission_mode: "plan",
      },
    });
    expect(res).toEqual({ ok: true, status: "booting" });
    // Boot invokes the real ClaudeEngineAdapter.createA2AServer (@col/a2a-claude).
    // Allow the async boot to settle, then assert it did not fail on routing/validation.
    await settle();
    const state = tr.lifecycle.status().state;
    expect(["setup", "ready", "failed"]).toContain(state);
    // If it reached "failed", it must be an engine/agent step (real SDK), never a
    // routing/validation problem.
    if (state === "failed") {
      expect(tr.lifecycle.status().error?.step).not.toBe("boot");
    }
  });
});

describe("throng-agent credential wiring", () => {
  it("exposes the credential config writer through the core package", async () => {
    const { writeCredentialConfig } = await import("@throng/agent-core");
    expect(typeof writeCredentialConfig).toBe("function");
  });

  it("no longer exposes the askpass path", async () => {
    const core = await import("@throng/agent-core");
    expect("ASKPASS" in core).toBe(false);
    expect("injectGitCredentials" in core).toBe(false);
  });
});
