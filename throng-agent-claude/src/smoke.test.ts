import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { buildServer } from "@throng/agent-core";
import { describe, expect, it } from "vitest";
import { ClaudeEngineAdapter } from "./adapter.js";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8"),
) as { version: string };

describe("smoke", () => {
  // The variant no longer exports a VERSION constant (the entrypoint is a
  // one-liner over core's startControlServer), so the old VERSION===package.json
  // assertion is repointed at the package.json version alone.
  it("package.json carries a semver version", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("buildServer with the Claude adapter answers control endpoints", async () => {
    const app = buildServer(new ClaudeEngineAdapter());
    await request(app).get("/healthz").expect(200, { status: "ok" });
    await request(app).get("/api/status").expect(200, { state: "uninitialised" });
  });
});
