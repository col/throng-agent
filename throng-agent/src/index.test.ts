import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildServer } from "@throng/agent-core";
import { createRegistry } from "./registry.js";

describe("throng-agent app registry", () => {
  it("registers both bundled engines", () => {
    expect(Object.keys(createRegistry()).sort()).toEqual(["claude", "codex"]);
  });

  it("buildServer(registry) answers the control endpoints", async () => {
    const app = buildServer(createRegistry());
    expect((await request(app).get("/healthz")).body).toEqual({ status: "ok" });
    expect((await request(app).get("/api/status")).body.state).toBe("uninitialised");
  });

  it("rejects a manifest with an unknown platform", async () => {
    const app = buildServer(createRegistry());
    const res = await request(app)
      .post("/api/initialise")
      .send({ repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }], agent: { platform: "gemini" } });
    expect(res.status).toBe(400);
  });
});
