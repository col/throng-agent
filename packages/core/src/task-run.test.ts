import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteCredentialConfig, writeCredentialConfig } from "./creds/config.js";
import { TaskRun, type BootDeps } from "./task-run.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";

const handle: ServerHandle = { shutdown: vi.fn(async () => {}) };

function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    syncOrClone: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    deleteCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/home/user/workspace",
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
      syncOrClone: vi.fn(async () => {
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
        throw new Error("EACCES: permission denied, mkdir '/home/user/.throng'");
      }),
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(status.error?.step).toBe("credentials");
    expect(status.error?.message).toContain("EACCES");
    expect(d.syncOrClone).not.toHaveBeenCalled();
  });

  // Sync runs WITH credentials in place under the pull model, and its output
  // lands verbatim in the control plane's instance.error_message — the same sink
  // the setup path already redacts. Collapsing clone and checkout into one dep
  // costs nothing diagnostically: `op` names which git command failed and the ref
  // is carried alongside it, so the message still identifies both the operation
  // and what it was operating on.
  it.each([
    ["clone", "fatal: could not read Username for 'https://ghs_0123456789abcdefghij@github.com'"],
    ["checkout", "error: pathspec not found; remote was https://x-access-token:ghp_0123456789abcdefghij@github.com"],
  ])("redacts tokens out of a %s failure message", async (op, output) => {
    const d = deps({ syncOrClone: vi.fn(async () => ({ ok: false, code: 128, op, output })) });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.error?.step).toBe("cloning");
    // The ref is the clue that a restored workspace was being moved to a
    // different ref than the snapshot was built with, so it is pinned here.
    expect(status.error?.message).toContain(`git ${op} failed for y@main`);
    expect(status.error?.message).toContain("[REDACTED]");
    expect(status.error?.message).not.toMatch(/gh[ps]_0123456789abcdefghij/);
  });

  it("syncs each repo with its url, destination and ref", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    expect(d.syncOrClone).toHaveBeenCalledWith("https://x/y", "/home/user/workspace/y", "main");
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

const preparePayload = {
  repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
  setup_commands: ["mise install"],
  credentials: { url: "https://cp.example/api/credentials", token: "identity-token" },
};

describe("TaskRun.prepare", () => {
  it("reaches prepared without starting an agent", async () => {
    const claude = adapter();
    const d = deps();
    const tr = new TaskRun(d, { claude });

    const r = await tr.prepare(preparePayload);
    expect(r).toEqual({ ok: true, status: "booting" });
    await settle();

    expect(tr.lifecycle.status().state).toBe("prepared");
    expect(d.syncOrClone).toHaveBeenCalledWith("https://x/y", "/home/user/workspace/y", "main");
    expect(d.runSetupCommands).toHaveBeenCalledWith("/home/user/workspace/y", ["mise install"]);
    // Nothing task-specific and no LLM credential may reach a snapshot, and the
    // A2A server must not be serving in an image every task boots from.
    expect(claude.createA2AServer).not.toHaveBeenCalled();
    expect(claude.injectCredentials).not.toHaveBeenCalled();
    expect(d.injectGitIdentity).not.toHaveBeenCalled();
  });

  // The wipe is the last thing before `prepared`, because the control plane
  // snapshots the moment it sees that state.
  it("deletes the credential config after setup and before reporting prepared", async () => {
    const order: string[] = [];
    const d = deps({
      writeCredentialConfig: vi.fn(() => void order.push("config")),
      syncOrClone: vi.fn(async () => {
        order.push("clone");
        return { ok: true, output: "" };
      }),
      runSetupCommands: vi.fn(async () => {
        order.push("setup");
        return { ok: true };
      }),
      deleteCredentialConfig: vi.fn(() => void order.push("wipe")),
    });
    const tr = new TaskRun(d, { claude: adapter() });

    await tr.prepare(preparePayload);
    await settle();

    expect(order).toEqual(["config", "clone", "setup", "wipe"]);
    expect(tr.lifecycle.status().state).toBe("prepared");
  });

  it("wipes credentials even when setup fails, and reports the failure", async () => {
    const d = deps({
      runSetupCommands: vi.fn(async () => ({
        ok: false as const,
        command: "mise install",
        code: 1,
        signal: null,
        output: "boom",
      })),
    });
    const tr = new TaskRun(d, { claude: adapter() });

    await tr.prepare(preparePayload);
    await settle();

    expect(tr.lifecycle.status().state).toBe("failed");
    expect(tr.lifecycle.status().error?.step).toBe("setup");
    expect(d.deleteCredentialConfig).toHaveBeenCalled();
  });

  // A snapshot that still has a live credential in it is worse than no snapshot,
  // so a wipe that cannot be proved to have happened fails the prepare.
  it("fails prepare when the wipe throws", async () => {
    const d = deps({
      deleteCredentialConfig: vi.fn(() => {
        throw new Error("refusing '/' as the credential cache directory: it is too close to the filesystem root.");
      }),
    });
    const tr = new TaskRun(d, { claude: adapter() });

    await tr.prepare(preparePayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(status.error?.step).toBe("credentials");
    expect(status.error?.message).toContain("refusing");
  });

  it("rejects a manifest carrying an agent block", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });

    const r = await tr.prepare({ ...preparePayload, agent: { platform: "claude" } });

    expect(r.ok).toBe(false);
    if (!r.ok && "errors" in r) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });

  // The control plane's Oban retry maps 409 to :ok, so a second prepare must be
  // rejected rather than re-run over a workspace it is already preparing.
  it("rejects a second prepare", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.prepare(preparePayload);

    const second = await tr.prepare(preparePayload);

    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });
});

describe("TaskRun.initialise from prepared", () => {
  async function prepared(d: BootDeps, registry: { claude: EngineAdapter<any, any> }): Promise<TaskRun> {
    const tr = new TaskRun(d, registry);
    await tr.prepare(preparePayload);
    await settle();
    expect(tr.lifecycle.status().state).toBe("prepared");
    return tr;
  }

  // A snapshot preserves memory, so it preserves lifecycle state: a restored
  // sandbox starts at `prepared` and must still accept its one real initialise.
  it("accepts exactly one initialise, then 409s", async () => {
    const claude = adapter();
    const tr = await prepared(deps(), { claude });

    const first = await tr.initialise(okPayload);
    await settle();
    const second = await tr.initialise(okPayload);

    expect(first).toEqual({ ok: true, status: "booting" });
    expect(tr.lifecycle.status().state).toBe("ready");
    expect(claude.createA2AServer).toHaveBeenCalledOnce();
    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  it("re-syncs repos and re-runs setup on the restored workspace", async () => {
    const d = deps();
    const tr = await prepared(d, { claude: adapter() });

    await tr.initialise(okPayload);
    await settle();

    expect(d.syncOrClone).toHaveBeenCalledTimes(2);
    expect(d.injectGitIdentity).toHaveBeenCalledOnce();
  });
});

// The security boundary, asserted against the real filesystem rather than a
// mock. What survives this call is what E2B captures into an image that every
// task in the project boots from.
describe("TaskRun.prepare credential wipe (real filesystem)", () => {
  it("leaves no credential config and no token cache behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "throng-prepare-"));
    const configPath = join(home, ".throng", "config.json");
    const cachePath = join(home, ".throng", "cache");
    const d = deps({
      writeCredentialConfig: (m) => writeCredentialConfig(m, configPath),
      deleteCredentialConfig: () => deleteCredentialConfig(configPath, cachePath),
      // Stand in for throng-creds minting a token during the clone.
      syncOrClone: async () => {
        mkdirSync(cachePath, { recursive: true });
        writeFileSync(join(cachePath, "git_github.com_acme_web"), "9999999999\nk\nusername=x\npassword=ghs_live\n");
        return { ok: true, output: "" };
      },
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.prepare(preparePayload);
    await settle();

    expect(tr.lifecycle.status().state).toBe("prepared");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
    expect(readdirSync(join(home, ".throng"))).toEqual([]);
  });
});
