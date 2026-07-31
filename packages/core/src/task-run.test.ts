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
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/workspace",
    ...over,
  };
}

function adapter(over: Partial<EngineAdapter<any, any>> = {}): EngineAdapter<any, any> {
  return {
    validateAgent: (input: any) => ({ ok: true, agent: input.agent }),
    injectCredentials: vi.fn(() => {}),
    buildAgentConfig: vi.fn(() => ({})),
    createA2AServer: vi.fn(async () => handle),
    ...over,
  };
}

const okPayload = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  agent: { platform: "claude" },
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("TaskRun", () => {
  it("rejects a second initialise", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.initialise(okPayload);
    const second = await tr.initialise(okPayload);
    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  it("boots via the platform-selected adapter and reaches ready", async () => {
    const claude = adapter();
    const tr = new TaskRun(deps(), { claude });
    const r = await tr.initialise(okPayload);
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();
    expect(tr.lifecycle.status().state).toBe("ready");
    expect(claude.createA2AServer).toHaveBeenCalledOnce();
  });

  it("routes to the adapter named by agent.platform", async () => {
    const claude = adapter();
    const codex = adapter();
    const tr = new TaskRun(deps(), { claude, codex });
    await tr.initialise({ ...okPayload, agent: { platform: "codex" } });
    await settle();
    expect(codex.createA2AServer).toHaveBeenCalledOnce();
    expect(claude.createA2AServer).not.toHaveBeenCalled();
  });

  it("rejects an unknown platform", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    const r = await tr.initialise({ ...okPayload, agent: { platform: "nope" } });
    expect(r.ok).toBe(false);
    if (!r.ok && "errors" in r) expect(r.errors.some((e) => e.field === "agent.platform")).toBe(true);
  });

  it("fails with the adapter-classified step on server start error", async () => {
    const claude = adapter({
      createA2AServer: async () => { throw new Error("plugin did not load"); },
      classifyBootError: () => "plugins",
    });
    const tr = new TaskRun(deps(), { claude });
    await tr.initialise(okPayload);
    await settle();
    expect(tr.lifecycle.status().error?.step).toBe("plugins");
  });
});
