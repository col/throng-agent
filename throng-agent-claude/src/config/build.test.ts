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
  agent: { keys, plugins, auth: null },
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

  // Throng agent turns routinely run past the wrapper's ten-minute default, and
  // a truncated turn is worse than a slow one. 0 disables the bound outright.
  it("disables the wrapper's prompt timeout", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
    expect(cfg.timeouts.prompt).toBe(0);
  });

  // The wrapper defaults marketplaces/enabledPlugins to {}, and omits the SDK
  // settings tier entirely while they are empty — so "no plugins" is {}, not unset.
  it("leaves the plugin channel empty when no plugins are configured", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
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
  });

  it("carries several marketplaces at once", () => {
    const plugins = resolved([
      { name: "sp", marketplace: "obra/superpowers-marketplace", ref: "v1.0.12" },
      { name: "hs", marketplace: "acme/house-style", ref: "v2" },
    ]);
    const cfg = buildAgentConfig(manifest({}, plugins), "/work/app");
    expect(Object.keys(cfg.claude.marketplaces!).sort()).toEqual(["house-style", "superpowers-marketplace"]);
    expect(cfg.claude.enabledPlugins).toEqual({
      "sp@superpowers-marketplace": true,
      "hs@house-style": true,
    });
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
    expect(cfg.claude.model).toBe("claude-sonnet-5");
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

  it("maps the model name onto claude.model as a plain string", () => {
    const cfg = buildAgentConfig(manifest({ model: "claude-opus-4-8" }), "/work/app");
    expect(cfg.claude.model).toBe("claude-opus-4-8");
  });

  it("maps effort onto claude.effort", () => {
    const cfg = buildAgentConfig(manifest({ model: "claude-opus-4-8", effort: "xhigh" }), "/work/app");
    expect(cfg.claude.effort).toBe("xhigh");
  });

  it("maps adaptive thinking onto claude.thinking", () => {
    const cfg = buildAgentConfig(
      manifest({ model: "claude-opus-4-8", thinking: { type: "adaptive" } }),
      "/work/app",
    );
    expect(cfg.claude.thinking).toEqual({ type: "adaptive" });
  });

  it("renames budget_tokens to budgetTokens for enabled thinking", () => {
    const cfg = buildAgentConfig(
      manifest({ thinking: { type: "enabled", budget_tokens: 8000 } }),
      "/work/app",
    );
    expect(cfg.claude.thinking).toEqual({ type: "enabled", budgetTokens: 8000 });
  });

  it("sets thinking and effort even without a model name", () => {
    const cfg = buildAgentConfig(
      manifest({ thinking: { type: "disabled" }, effort: "low" }),
      "/work/app",
    );
    expect(cfg.claude.model).toBeUndefined();
    expect(cfg.claude.thinking).toEqual({ type: "disabled" });
    expect(cfg.claude.effort).toBe("low");
  });

  // The wrapper only fills in thinking.display — leaving `display` unset here is
  // what lets it do that, and is why thinking sideband events carry any text.
  it("leaves thinking.display to the wrapper", () => {
    const cfg = buildAgentConfig(manifest({ thinking: { type: "adaptive" } }), "/work/app");
    expect(cfg.claude.thinking).not.toHaveProperty("display");
  });

  it("maps output_format onto the wrapper's outputFormat", () => {
    const outputFormat = {
      type: "json_schema",
      schema: { type: "object", properties: { status: { type: "string" } } },
    };
    const cfg = buildAgentConfig(manifest({ output_format: outputFormat }), "/work/app");
    expect(cfg.claude.outputFormat).toEqual(outputFormat);
  });

  // Only the outer key is renamed. The schema body carries JSON Schema's own
  // vocabulary (additionalProperties, required, …) and must survive untouched.
  it("passes the schema body through without rewriting its keys", () => {
    const schema = {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "blocked"] },
        documents_created: { type: "array", items: { type: "string" } },
      },
      required: ["status"],
      additionalProperties: false,
    };
    const cfg = buildAgentConfig(
      manifest({ output_format: { type: "json_schema", schema } }),
      "/work/app",
    );
    expect(cfg.claude.outputFormat?.schema).toEqual(schema);
  });

  // Absent means "wrapper default" — freeform text — not an empty format object.
  it("leaves outputFormat unset when the manifest omits it", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
    expect(cfg.claude.outputFormat).toBeUndefined();
  });

  it("sets additionalDirectories when attachment dirs are provided", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app", ["/work/attachments"]);
    expect(cfg.claude.additionalDirectories).toEqual(["/work/attachments"]);
  });

  it("leaves additionalDirectories unset when none are provided", () => {
    const cfg = buildAgentConfig(manifest({}), "/work/app");
    expect(cfg.claude.additionalDirectories ?? []).toEqual([]);
  });
});
