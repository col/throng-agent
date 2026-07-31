import { describe, expect, it } from "vitest";
import type { Manifest } from "@throng/agent-core";
import { buildAgentConfig } from "./build.js";
import { EMPTY_PLUGINS, resolvePlugins, type ResolvedPlugins } from "./plugins.js";
import type { ResolvedClaudeAgent } from "../manifest/claude-agent.js";

const manifest = (
  keys: Record<string, unknown>,
  plugins: ResolvedPlugins = EMPTY_PLUGINS,
): Manifest<ResolvedClaudeAgent> => ({
  repos: [{ url: "https://x/y", ref: "main", dest: "app", primary: true, token: null }],
  github_token: null,
  user_identity: { name: null, email: null },
  setup_commands: [],
  platform: "claude",
  agent: { keys, plugins, api_key: null },
});

/** Resolves a manifest `agent.plugins` list, failing the test if invalid. */
function resolved(entries: unknown[]): ResolvedPlugins {
  const r = resolvePlugins(entries);
  if (!r.ok) throw new Error(`fixture did not resolve: ${JSON.stringify(r.errors)}`);
  return r.resolved;
}

describe("buildAgentConfig", () => {
  it("sets name, project-only settingSources, and workingDirectory", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
    expect(cfg.agentCard.name).toBe("Throng Agent A2A Claude");
    expect(cfg.claude.workingDirectory).toBe("/work/app");
    // "project" loads the repo's CLAUDE.md; "user"/"local" stay excluded.
    expect(cfg.claude.settingSources).toEqual(["project"]);
    expect(cfg.claude.permissionMode).toBe("acceptEdits");
  });

  // The wrapper defaults marketplaces/enabledPlugins to {}, and omits the SDK
  // settings tier entirely while they are empty — so "no plugins" is {}, not unset.
  it("leaves both plugin channels empty when no plugins are configured", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
    expect(cfg.claude.plugins).toBeUndefined();
    expect(cfg.claude.marketplaces).toEqual({});
    expect(cfg.claude.enabledPlugins).toEqual({});
  });

  it("routes marketplace plugins to the settings-backed channel", () => {
    const plugins = resolved([
      { name: "superpowers", marketplace: "obra/superpowers-marketplace", ref: "v1.0.12" },
    ]);
    const cfg = buildAgentConfig(manifest({}, plugins), "/work/app");
    expect(cfg.claude.marketplaces).toEqual({
      "superpowers-marketplace": {
        source: { source: "github", repo: "obra/superpowers-marketplace", ref: "v1.0.12" },
      },
    });
    expect(cfg.claude.enabledPlugins).toEqual({ "superpowers@superpowers-marketplace": true });
    // A marketplace plugin must not leak into the local-path channel, which
    // the wrapper validates for on-disk existence.
    expect(cfg.claude.plugins).toBeUndefined();
  });

  it("routes pre-installed paths to claude.plugins", () => {
    const cfg = buildAgentConfig(manifest({}, resolved([{ path: "/opt/plugins/baked-in" }])), "/work/app");
    expect(cfg.claude.plugins).toEqual([{ type: "local", path: "/opt/plugins/baked-in" }]);
    expect(cfg.claude.marketplaces).toEqual({});
  });

  it("carries both channels at once", () => {
    const plugins = resolved([
      { name: "sp", marketplace: "obra/superpowers-marketplace", ref: "v1.0.12" },
      { path: "/opt/plugins/baked-in" },
    ]);
    const cfg = buildAgentConfig(manifest({}, plugins), "/work/app");
    expect(cfg.claude.plugins).toHaveLength(1);
    expect(Object.keys(cfg.claude.marketplaces!)).toEqual(["superpowers-marketplace"]);
  });

  it("overlays known agent keys onto claude config", () => {
    const cfg = buildAgentConfig(
      manifest({
        model: "claude-sonnet-5",
        permission_mode: "plan",
        system_prompt_append: "Be terse.",
        allowed_tools: ["Read", "Bash"],
        max_turns: 12,
      }),
      "/work/app",
    );
    expect(cfg.claude.model.name).toBe("claude-sonnet-5");
    expect(cfg.claude.permissionMode).toBe("plan");
    expect(cfg.claude.systemPromptAppend).toBe("Be terse.");
    expect(cfg.claude.allowedTools).toEqual(["Read", "Bash"]);
    expect(cfg.claude.maxTurns).toBe(12);
  });

  it("sets dangerouslyAllowBypassPermissions when permission_mode is bypassPermissions", () => {
    const cfg = buildAgentConfig(manifest({ permission_mode: "bypassPermissions" }), "/work/app");
    expect(cfg.claude.permissionMode).toBe("bypassPermissions");
    expect(cfg.claude.dangerouslyAllowBypassPermissions).toBe(true);
  });

  it("does not set dangerouslyAllowBypassPermissions for non-bypass modes", () => {
    const cfg = buildAgentConfig(manifest({ permission_mode: "plan" }), "/work/app");
    expect(cfg.claude.dangerouslyAllowBypassPermissions).toBeFalsy();
  });

  it("ignores unknown agent keys", () => {
    const cfg = buildAgentConfig(manifest({ nonsense: true }), "/work/app");
    expect(cfg.claude.workingDirectory).toBe("/work/app");
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
