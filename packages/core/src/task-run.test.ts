import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteCredentialConfig, writeCredentialConfig } from "./creds/config.js";
import { TaskRun, resolveWorkingDirectory, type BootDeps } from "./task-run.js";
import type { EngineAdapter, ServerHandle } from "./engine/adapter.js";
import type { RepoSpec, WorkspaceManifest } from "./manifest/types.js";

const handle: ServerHandle = { shutdown: vi.fn(async () => {}) };

function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    syncOrClone: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    deleteCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    ensureWorkspace: vi.fn(() => {}),
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

  it("ensures the workspace root exists before cloning", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();
    expect(d.ensureWorkspace).toHaveBeenCalledWith("/home/user/workspace");
  });

  it("fails the boot when the workspace cannot be created", async () => {
    const d = deps({
      ensureWorkspace: vi.fn(() => {
        throw new Error("EACCES: permission denied");
      }),
    });
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();
    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(d.syncOrClone).not.toHaveBeenCalled();
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
  //
  // `credential-wipe`, not `credentials`: once the sandbox is gone, `step` is
  // most of the diagnostic, and a failed WRITE is a harmless dead sandbox while a
  // failed WIPE may be a sandbox still holding a live token.
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
    expect(status.error?.step).toBe("credential-wipe");
    expect(status.error?.message).toContain("refusing");
  });

  // The write and the wipe are told apart by `step` alone, so pin that they do
  // not collide: this is the benign one.
  it("fails prepare on the credentials step when the config cannot be written", async () => {
    const d = deps({
      writeCredentialConfig: vi.fn(() => {
        throw new Error("EACCES: permission denied, mkdir '/home/user/.throng'");
      }),
    });
    const tr = new TaskRun(d, { claude: adapter() });

    await tr.prepare(preparePayload);
    await settle();

    expect(tr.lifecycle.status().error?.step).toBe("credentials");
  });

  it("rejects a manifest carrying an agent block", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });

    const r = await tr.prepare({ ...preparePayload, agent: { platform: "claude" } });

    expect(r.ok).toBe(false);
    if (!r.ok && "errors" in r) expect(r.errors.some((e) => e.field === "agent")).toBe(true);
  });

  // The control plane's Oban retry maps 409 to :ok, so a second prepare must be
  // rejected rather than re-run over a workspace it is already preparing.
  //
  // No settle(), so this is the in-flight (`booting`) case specifically; the two
  // rest states are covered below.
  it("rejects a second prepare", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.prepare(preparePayload);

    const second = await tr.prepare(preparePayload);

    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  it("rejects a prepare once the workspace is already prepared", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.prepare(preparePayload);
    await settle();
    expect(tr.lifecycle.status().state).toBe("prepared");

    const second = await tr.prepare(preparePayload);

    expect(second.ok).toBe(false);
    if (!second.ok) expect("already" in second && second.already).toBe(true);
  });

  // A live task must never be reset to a snapshot build: prepare wipes the
  // credential config the running agent's git operations depend on.
  it("rejects a prepare against a ready task", async () => {
    const tr = new TaskRun(deps(), { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();
    expect(tr.lifecycle.status().state).toBe("ready");

    const r = await tr.prepare(preparePayload);

    expect(r.ok).toBe(false);
    if (!r.ok) expect("already" in r && r.already).toBe(true);
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

  // The guard is a double negation, and `failed` is the state a future reader is
  // most likely to argue should be retryable. It is not: a failed prepare has
  // already wiped the credential config, so an initialise on top of it would
  // clone with no working helper, and the control plane throws the instance away
  // rather than reusing it. Pinned so a "helpful" relaxation has to be deliberate.
  it("still rejects initialise after a failed prepare", async () => {
    const d = deps({
      runSetupCommands: vi.fn(async () => ({
        ok: false as const,
        command: "x",
        code: 1,
        signal: null,
        output: "",
      })),
    });
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.prepare(preparePayload);
    await settle();
    expect(tr.lifecycle.status().state).toBe("failed");

    const r = await tr.initialise(okPayload);

    expect(r.ok).toBe(false);
    if (!r.ok) expect("already" in r && r.already).toBe(true);
  });
});

// Run against the real filesystem rather than a mock, because what it draws is
// exactly what a mock cannot: that `prepare` reaches the real deleter, with a
// real config file and a real token cache in place, and that both are gone by
// the time it reports `prepared` — the state on which the control plane captures
// the image every task in the project boots from.
//
// It proves that much and no more. Both deps are given EXPLICIT paths under a
// temp directory, deliberately: `CONFIG_PATH` is a module constant resolved at
// import time, so a test that pointed $HOME at a temp directory and then called
// the zero-argument defaults would delete the developer's real ~/.throng. That
// the defaults agree with throng-creds.sh's own `${THRONG_CREDS_CACHE:-…}` is a
// separate claim, pinned in creds/config.test.ts.
describe("TaskRun.prepare credential wipe (real filesystem)", () => {
  let home = "";
  // mkdtempSync leaves the directory behind otherwise, one per run.
  afterEach(() => {
    if (home !== "") rmSync(home, { recursive: true, force: true });
    home = "";
  });

  it("leaves no credential config and no token cache behind", async () => {
    home = mkdtempSync(join(tmpdir(), "throng-prepare-"));
    const configPath = join(home, ".throng", "config.json");
    const cachePath = join(home, ".throng", "cache");
    // Sampled mid-run, because the wipe is the point: a test that only checked
    // the end state would pass just as well if nothing had ever been written.
    let presentDuringClone: { config: boolean; token: boolean } | undefined;
    const d = deps({
      writeCredentialConfig: (m) => writeCredentialConfig(m, configPath),
      deleteCredentialConfig: () => deleteCredentialConfig(configPath, cachePath),
      // Stand in for throng-creds minting a token during the clone.
      syncOrClone: async () => {
        mkdirSync(cachePath, { recursive: true });
        const token = join(cachePath, "git_github.com_acme_web");
        writeFileSync(token, "9999999999\nk\nusername=x\npassword=ghs_live\n");
        presentDuringClone = { config: existsSync(configPath), token: existsSync(token) };
        return { ok: true, output: "" };
      },
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.prepare(preparePayload);
    await settle();

    expect(presentDuringClone).toEqual({ config: true, token: true });
    expect(tr.lifecycle.status().state).toBe("prepared");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
    // Narrow, and worth stating rather than reading as "nothing lingers": the
    // only writer in this test is the test itself, so an empty `.throng` is no
    // evidence about what throng-creds leaves elsewhere. What it does catch is
    // the wipe leaving a THIRD thing beside the two paths asserted above — a
    // renamed or backup copy of the config, say — which neither existsSync would
    // see.
    expect(readdirSync(join(home, ".throng"))).toEqual([]);
  });
});

describe("resolveWorkingDirectory", () => {
  const root = "/home/user/workspace";
  // Typed rather than cast: if WorkspaceManifest gains a required field this
  // stops compiling, which is the point. An `as any` here would keep building
  // against a manifest shape the function no longer receives.
  const manifest = (repos: RepoSpec[]): WorkspaceManifest => ({
    repos,
    credentials: null,
    github_token: null,
    setup_commands: [],
  });

  it("returns the primary repo's destination", () => {
    const m = manifest([
      { url: "https://x/a", ref: "main", dest: "a", primary: false },
      { url: "https://x/b", ref: "main", dest: "b", primary: true },
    ]);
    expect(resolveWorkingDirectory(m, root)).toBe("/home/user/workspace/b");
  });

  it("returns the workspace root when there are no repos", () => {
    expect(resolveWorkingDirectory(manifest([]), root)).toBe(root);
  });

  // validateRepos permits a dest with subdirectories — it rejects only absolute
  // paths, ".." segments and anything resolving to the workspace root itself —
  // so a nested dest is real input, not a hypothetical.
  it("joins a nested dest under the workspace root", () => {
    const m = manifest([{ url: "https://x/a", ref: "main", dest: "team/svc", primary: true }]);
    expect(resolveWorkingDirectory(m, root)).toBe("/home/user/workspace/team/svc");
  });

  // Unreachable through the public API — validation demands exactly one primary
  // for a non-empty list — but the silent failure it prevents is bad: an empty
  // cwd makes runSetupCommands run in the process's own directory and report
  // success.
  it("throws when a non-empty list has no primary", () => {
    const m = manifest([{ url: "https://x/a", ref: "main", dest: "a", primary: false }]);
    expect(() => resolveWorkingDirectory(m, root)).toThrow(/no repo was marked primary/);
  });
});
