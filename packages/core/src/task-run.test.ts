import { describe, expect, it, vi } from "vitest";
import { TaskRun, type BootDeps } from "./task-run.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";

const handle: ServerHandle = { shutdown: vi.fn(async () => {}) };

function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    clone: vi.fn(async () => ({ ok: true, output: "" })),
    checkout: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    injectGitCredentials: vi.fn(() => {}),
    workspaceRoot: "/workspace",
    ...over,
  };
}

function adapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    validateAgent: () => ({ ok: true, agent: {} }),
    injectCredentials: vi.fn(() => {}),
    buildAgentConfig: vi.fn(() => ({})),
    createA2AServer: vi.fn(async () => handle),
    ...over,
  };
}

const okPayload = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: {},
};

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("TaskRun", () => {
  it("rejects a second initialise", async () => {
    const tr = new TaskRun(deps(), adapter());
    await tr.initialise(okPayload);
    const second = await tr.initialise(okPayload);
    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  it("returns 202 booting on a valid manifest and reaches ready", async () => {
    const a = adapter();
    const tr = new TaskRun(deps(), a);
    const r = await tr.initialise(okPayload);
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();
    expect(tr.lifecycle.status().state).toBe("ready");
    expect(a.createA2AServer).toHaveBeenCalledOnce();
  });

  it("fails with the adapter-classified step on server start error", async () => {
    const a = adapter({
      createA2AServer: async () => { throw new Error("plugin did not load"); },
      classifyBootError: () => "plugins",
    });
    const tr = new TaskRun(deps(), a);
    await tr.initialise(okPayload);
    await settle();
    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(status.error?.step).toBe("plugins");
  });
});
