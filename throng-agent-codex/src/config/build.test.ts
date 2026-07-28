import { describe, expect, it } from "vitest";
import type { Manifest } from "@throng/agent-core";
import { buildAgentConfig } from "./build.js";
import type { ResolvedCodexAgent } from "../manifest/codex-agent.js";

const manifest = (keys: Record<string, unknown>): Manifest<ResolvedCodexAgent> => ({
  repos: [{ url: "https://x/y", ref: "main", dest: "app", primary: true, token: null }],
  github_token: null,
  setup_commands: [],
  agent: { keys, openai_api_key: null },
  throng_api_token: null,
});

describe("buildAgentConfig", () => {
  it("sets the agent card name and codex working directory", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
    expect(cfg.agentCard.name).toBe("Throng Agent A2A Codex");
    expect(cfg.codex.workingDirectory).toBe("/work/app");
  });

  it("maps known agent keys onto the codex block", () => {
    const cfg = buildAgentConfig(
      manifest({
        model: "o4-mini",
        sandbox_mode: "workspace-write",
        approval_policy: "never",
        network_access_enabled: true,
        web_search_mode: "cached",
        developer_instructions: "Be careful.",
        additional_directories: ["/opt/extra"],
      }),
      "/work/app",
    );
    expect(cfg.codex.model).toBe("o4-mini");
    expect(cfg.codex.sandboxMode).toBe("workspace-write");
    expect(cfg.codex.approvalPolicy).toBe("never");
    expect(cfg.codex.networkAccessEnabled).toBe(true);
    expect(cfg.codex.webSearchMode).toBe("cached");
    expect(cfg.codex.developerInstructions).toBe("Be careful.");
    expect(cfg.codex.additionalDirectories).toEqual(["/opt/extra"]);
  });

  it("ignores unknown agent keys", () => {
    const cfg = buildAgentConfig(manifest({ nonsense: true }), "/work/app");
    expect(cfg.codex.workingDirectory).toBe("/work/app");
  });

  it("pins server bind to 0.0.0.0 regardless of container HOSTNAME/PORT env", () => {
    const prevHost = process.env.HOSTNAME;
    const prevPort = process.env.PORT;
    process.env.HOSTNAME = "container-abc123";
    process.env.PORT = "9999";
    try {
      const cfg = buildAgentConfig(manifest({}), "/work/app");
      expect(cfg.server.hostname).toBe("0.0.0.0");
      expect(cfg.server.port).toBe(3030);
    } finally {
      if (prevHost === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = prevHost;
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });

  it("advertises https by default and http when ADVERTISE_PROTOCOL is set", () => {
    const prev = process.env.ADVERTISE_PROTOCOL;
    try {
      delete process.env.ADVERTISE_PROTOCOL;
      expect(buildAgentConfig(manifest({}), "/work/app").server.advertiseProtocol).toBe("https");

      process.env.ADVERTISE_PROTOCOL = "http";
      expect(buildAgentConfig(manifest({}), "/work/app").server.advertiseProtocol).toBe("http");
    } finally {
      if (prev === undefined) delete process.env.ADVERTISE_PROTOCOL;
      else process.env.ADVERTISE_PROTOCOL = prev;
    }
  });
});
