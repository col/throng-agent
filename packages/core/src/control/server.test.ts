import request from "supertest";
import { describe, expect, it } from "vitest";
import { createControlApp } from "./server.js";
import { TaskRun, type BootDeps } from "../task-run.js";
import type { EngineAdapter, ServerHandle } from "../engine/adapter.js";

const handle: ServerHandle = { shutdown: async () => {} };
const bootDeps: BootDeps = {
  clone: async () => ({ ok: true, output: "" }),
  checkout: async () => ({ ok: true, output: "" }),
  runSetupCommands: async () => ({ ok: true }),
  injectGitCredentials: () => {},
  workspaceRoot: "/workspace",
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
