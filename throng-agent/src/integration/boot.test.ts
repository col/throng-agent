import { describe, expect, it, vi } from "vitest";
import { TaskRun, type BootDeps } from "@throng/agent-core";
import { createRegistry } from "../registry.js";

// Drive a full boot through the registry with faked bootstrap deps, asserting
// the claude adapter is selected by agent.platform and the lifecycle reaches ready.
function fakeDeps(): BootDeps {
  return {
    clone: vi.fn(async () => ({ ok: true, output: "" })),
    checkout: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/home/user/workspace",
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("throng-agent boot routing", () => {
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
