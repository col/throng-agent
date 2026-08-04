import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskRun, type BootDeps } from "./task-run.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";

const handle: ServerHandle = { shutdown: vi.fn(async () => {}) };

function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    clone: vi.fn(async () => ({ ok: true, output: "" })),
    checkout: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
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

describe("TaskRun credential ordering", () => {
  // Cloning authenticates through throng-creds, which reads the config file.
  // If it is written after the clone, every private repo fails to clone.
  it("writes the credential config before cloning", async () => {
    const order: string[] = [];
    const d = deps({
      writeCredentialConfig: vi.fn(() => void order.push("config")),
      clone: vi.fn(async () => {
        order.push("clone");
        return { ok: true, output: "" };
      }),
      runSetupCommands: vi.fn(async () => {
        order.push("setup");
        return { ok: true };
      }),
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    expect(order).toEqual(["config", "clone", "setup"]);
  });

  it("fails on the credentials step when the config cannot be written", async () => {
    const d = deps({
      writeCredentialConfig: vi.fn(() => {
        throw new Error("EACCES: permission denied, mkdir '/run/throng'");
      }),
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(status.error?.step).toBe("credentials");
    expect(status.error?.message).toContain("EACCES");
    expect(d.clone).not.toHaveBeenCalled();
  });

  // Clone and checkout run WITH credentials in place under the pull model, and
  // their output lands verbatim in the control plane's instance.error_message —
  // the same sink the setup path already redacts.
  it("redacts tokens out of a clone failure message", async () => {
    const d = deps({
      clone: vi.fn(async () => ({
        ok: false,
        code: 128,
        output: "fatal: could not read Username for 'https://ghs_0123456789abcdefghij@github.com'",
      })),
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.error?.step).toBe("cloning");
    expect(status.error?.message).toContain("[REDACTED]");
    expect(status.error?.message).not.toContain("ghs_0123456789abcdefghij");
  });

  it("redacts tokens out of a checkout failure message", async () => {
    const d = deps({
      checkout: vi.fn(async () => ({
        ok: false,
        code: 1,
        output: "error: pathspec not found; remote was https://x-access-token:ghp_0123456789abcdefghij@github.com",
      })),
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.error?.step).toBe("cloning");
    expect(status.error?.message).toContain("[REDACTED]");
    expect(status.error?.message).not.toContain("ghp_0123456789abcdefghij");
  });

  it("clones without a token argument", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    expect(d.clone).toHaveBeenCalledWith("https://x/y", "/workspace/y");
  });
});

describe("TaskRun logging", () => {
  afterEach(() => vi.restoreAllMocks());

  // The pull model does not stop a caller sending a credential-bearing clone
  // URL — `repos[].url` is whatever the control plane put there, and
  // `https://x-access-token:ghs_…@github.com/…` is a shape this repo's own
  // fixtures use. stdout is shipped off the box, so it is the same sink the
  // failure messages are already redacted for.
  it("redacts a token embedded in the clone URL before logging it", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logged.push(String(line)));
    const url = "https://x-access-token:ghs_0123456789abcdefghij@github.com/acme/app.git";

    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.initialise({ ...okPayload, repos: [{ url, ref: "main", dest: "app", primary: true }] });
    await settle();

    // The trailing space keeps "boot step: cloning repos" out of the match.
    const cloning = logged.filter((l) => l.includes("cloning repo "));
    expect(cloning).toHaveLength(1);
    expect(cloning[0]).not.toContain("ghs_0123456789abcdefghij");
    expect(cloning[0]).toContain("[REDACTED]");
    // Still useful to an operator: the host and repo survive redaction.
    expect(cloning[0]).toContain("github.com/acme/app.git");
  });
});
