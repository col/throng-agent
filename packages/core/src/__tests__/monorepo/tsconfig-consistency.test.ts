import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../../../..");
const read = (p: string) => JSON.parse(readFileSync(join(root, p), "utf-8"));

describe("tsconfig consistency", () => {
  it("every package extends the base tsconfig", () => {
    for (const p of ["packages/core", "throng-agent-claude", "throng-agent-codex", "throng-agent"]) {
      const ts = read(`${p}/tsconfig.json`);
      expect(ts.extends).toMatch(/tsconfig\.base\.json$/);
    }
  });
});
