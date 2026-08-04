import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, createControlApp, defaultBootDeps, startControlServer } from "./server.js";
import { TaskRun, type BootDeps } from "../task-run.js";
import type { EngineAdapter, ServerHandle } from "../engine/adapter.js";

const handle: ServerHandle = { shutdown: async () => {} };
const bootDeps: BootDeps = {
  clone: async () => ({ ok: true, output: "" }),
  checkout: async () => ({ ok: true, output: "" }),
  runSetupCommands: async () => ({ ok: true }),
  writeCredentialConfig: () => {},
  injectGitIdentity: () => {},
  workspaceRoot: "/home/user/workspace",
};
const adapter: EngineAdapter<any, any> = {
  validateAgent: (i: any) => ({ ok: true, agent: i.agent }),
  injectCredentials: () => {},
  buildAgentConfig: () => ({}),
  createA2AServer: async () => handle,
};
const app = () => createControlApp({ taskRun: new TaskRun(bootDeps, { claude: adapter }) });
const goodRepos = [{ url: "https://x/y", ref: "main", dest: "y", primary: true }];

describe("control server", () => {
  it("GET /healthz → ok", async () => {
    expect((await request(app()).get("/healthz")).body).toEqual({ status: "ok" });
  });
  it("GET /api/status → uninitialised", async () => {
    expect((await request(app()).get("/api/status")).body.state).toBe("uninitialised");
  });
  it("POST /api/initialise bad manifest → 400 list", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: [] });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body)).toBe(true);
  });
  it("POST /api/initialise unknown platform → 400", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: goodRepos, agent: { platform: "nope" } });
    expect(res.status).toBe(400);
  });
  it("POST /api/initialise valid → 202 booting", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: goodRepos, agent: { platform: "claude" } });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "booting" });
  });
  it("401 when THRONG_INIT_TOKEN set", async () => {
    const prev = process.env.THRONG_INIT_TOKEN;
    process.env.THRONG_INIT_TOKEN = "secret";
    try {
      const res = await request(app()).post("/api/initialise").send({ agent: { platform: "claude" } });
      expect(res.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.THRONG_INIT_TOKEN;
      else process.env.THRONG_INIT_TOKEN = prev;
    }
  });
});

// Saved once, restored after every case: these tests are about process-global
// state, and leaving any of it set would silently change what the cases around
// them are testing.
const saved: Record<string, string | undefined> = {};
function stash(...names: string[]): void {
  for (const name of names) if (!(name in saved)) saved[name] = process.env[name];
}
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
});

describe("defaultBootDeps", () => {
  // `/workspace` was the default until a live sandbox showed it does not exist
  // and cannot be created: E2B runs the sandbox as uid 1000, and making a
  // top-level directory needs root. `docker run` honours the image's USER (root
  // here), so it was never reproduced locally — the same false negative as the
  // credential path.
  it("defaults the workspace to $HOME/workspace", () => {
    stash("WORKSPACE_DIR", "HOME");
    delete process.env.WORKSPACE_DIR;
    process.env.HOME = "/home/user";

    expect(defaultBootDeps().workspaceRoot).toBe("/home/user/workspace");
  });

  // Kept deliberately. It is still the documented way to move the workspace; it
  // just cannot be the delivery mechanism in E2B, where the runtime's
  // environment carries neither image ENV nor template setEnvs.
  it("still honours WORKSPACE_DIR", () => {
    stash("WORKSPACE_DIR");
    process.env.WORKSPACE_DIR = "/mnt/work";

    expect(defaultBootDeps().workspaceRoot).toBe("/mnt/work");
  });

  it("treats a blank WORKSPACE_DIR as unset rather than cloning into ''", () => {
    stash("WORKSPACE_DIR", "HOME");
    process.env.WORKSPACE_DIR = "";
    process.env.HOME = "/home/user";

    expect(defaultBootDeps().workspaceRoot).toBe("/home/user/workspace");
  });

  it("refuses to guess when HOME is unset", () => {
    stash("WORKSPACE_DIR", "HOME");
    delete process.env.WORKSPACE_DIR;
    delete process.env.HOME;

    expect(() => defaultBootDeps()).toThrow(/HOME is unset/);
  });
});

// The image's `ENV GIT_TERMINAL_PROMPT=0` never reaches the runtime under E2B:
// the runtime process is captured in the template snapshot and resumed with a
// scrubbed environment that carries no image ENV and no template setEnvs. It was
// verified with `docker run`, which does inherit image ENV — the same shape of
// false negative as the uid bug. So the runtime sets it itself, and every
// process the agent spawns inherits it from there.
describe("startControlServer", () => {
  it("sets GIT_TERMINAL_PROMPT=0 on the runtime's own process", async () => {
    stash("GIT_TERMINAL_PROMPT", "CONTROL_PORT");
    delete process.env.GIT_TERMINAL_PROMPT;
    process.env.CONTROL_PORT = "0"; // any free port; nothing here connects to it

    const server = startControlServer({ claude: adapter });
    try {
      expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // The other entrypoints must stay side-effect free, or every test that builds
  // an app would quietly mutate the environment of the ones after it — and a
  // suite that sets the variable everywhere could never notice the real
  // entrypoint failing to.
  it("is not done by buildServer or createControlApp", () => {
    stash("GIT_TERMINAL_PROMPT");
    delete process.env.GIT_TERMINAL_PROMPT;

    buildServer({ claude: adapter });
    createControlApp({ taskRun: new TaskRun(bootDeps, { claude: adapter }) });

    expect(process.env.GIT_TERMINAL_PROMPT).toBeUndefined();
  });

  // ...nor by importing the module at all. The case above cannot see this: the
  // static import at the top of this file has already evaluated server.ts by the
  // time any test body runs, so moving the assignment to module scope would
  // still leave it green. Only a fresh evaluation after the variable is deleted
  // proves the property the comment in server.ts claims.
  it("is not done merely by importing the module", async () => {
    stash("GIT_TERMINAL_PROMPT");
    delete process.env.GIT_TERMINAL_PROMPT;
    vi.resetModules();

    await import("./server.js");

    expect(process.env.GIT_TERMINAL_PROMPT).toBeUndefined();
  });
});
