import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSetupCommands } from "./setup.js";

const tmp = () => mkdtempSync(join(tmpdir(), "a2a-setup-"));

describe("runSetupCommands", () => {
  it("runs commands sequentially in the given dir", async () => {
    const dir = tmp();
    const r = await runSetupCommands(dir, ["echo hi > out.txt", "echo bye >> out.txt"]);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("hi\nbye\n");
  });

  it("stops at the first non-zero exit and reports it", async () => {
    const dir = tmp();
    const r = await runSetupCommands(dir, ["true", "exit 3", "echo should-not-run > nope.txt"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.command).toBe("exit 3");
      expect(r.code).toBe(3);
    }
  });

  it("no-ops on an empty command list", async () => {
    const r = await runSetupCommands(tmp(), []);
    expect(r.ok).toBe(true);
  });
});
