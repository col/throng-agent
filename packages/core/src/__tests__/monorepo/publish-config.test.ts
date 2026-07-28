import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../../../.."); // → throng_agent/
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf-8"));

describe("publish config", () => {
  it("resolves the monorepo root", () => {
    // Sanity check: root must be the workspace root, not some parent.
    expect(existsSync(join(root, "turbo.json"))).toBe(true);
  });

  it("core is publishable and public", () => {
    const pkg = read("packages/core/package.json");
    expect(pkg.name).toBe("@throng/agent-core");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.private).not.toBe(true);
  });

  it("variants pin core to an exact version", () => {
    for (const v of ["throng-agent-claude", "throng-agent-codex"]) {
      const pkg = read(`${v}/package.json`);
      expect(pkg.dependencies["@throng/agent-core"]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
