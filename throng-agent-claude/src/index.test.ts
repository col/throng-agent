import { describe, expect, it } from "vitest";
import { buildServer } from "@throng/agent-core";
import { ClaudeEngineAdapter } from "./adapter.js";

describe("claude entrypoint", () => {
  it("buildServer with the Claude adapter yields an app that answers /healthz-shaped wiring", () => {
    const app = buildServer(new ClaudeEngineAdapter());
    expect(typeof app.listen).toBe("function");
  });
});
