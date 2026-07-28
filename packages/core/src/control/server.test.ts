import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
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
const adapter: EngineAdapter = {
  validateAgent: (input) =>
    typeof input.agent === "object" && input.agent !== null
      ? { ok: true, agent: input.agent }
      : { ok: false, errors: [{ field: "agent", reason: "is required" }] },
  injectCredentials: () => {},
  buildAgentConfig: () => ({}),
  createA2AServer: async () => handle,
};

const app = () => createControlApp({ taskRun: new TaskRun(bootDeps, adapter) });

describe("control server", () => {
  it("GET /healthz → ok", async () => {
    const res = await request(app()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /api/status → uninitialised", async () => {
    const res = await request(app()).get("/api/status");
    expect(res.body.state).toBe("uninitialised");
  });

  it("POST /api/initialise with bad manifest → 400 field errors", async () => {
    const res = await request(app()).post("/api/initialise").send({ repos: [] });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("POST /api/initialise valid → 202 booting", async () => {
    const res = await request(app())
      .post("/api/initialise")
      .send({ repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }], agent: {} });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "booting" });
  });

  it("rejects unauthorized when THRONG_INIT_TOKEN set", async () => {
    const prev = process.env.THRONG_INIT_TOKEN;
    process.env.THRONG_INIT_TOKEN = "secret";
    try {
      const res = await request(app()).post("/api/initialise").send({ agent: {} });
      expect(res.status).toBe(401);
    } finally {
      process.env.THRONG_INIT_TOKEN = prev;
    }
  });
});
