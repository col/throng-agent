import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeSetupFailure, runSetupCommands } from "./setup.js";

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

  it("captures the failing command's output for the caller", async () => {
    const r = await runSetupCommands(tmp(), ["echo boom-stdout; echo boom-stderr >&2; exit 2"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.output).toContain("boom-stdout");
      expect(r.output).toContain("boom-stderr");
    }
  });

  it("reports a signal death as 128 + signal", async () => {
    const r = await runSetupCommands(tmp(), ["kill -9 $$"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(137);
  });
});

describe("describeSetupFailure", () => {
  it("names the command and includes the output tail", () => {
    const message = describeSetupFailure({
      ok: false,
      command: "mix compile",
      code: 1,
      signal: null,
      output: "== Compilation error in file lib/a.ex ==\nundefined function foo/0\n",
    });

    expect(message).toContain("mix compile");
    expect(message).toContain("exit 1");
    expect(message).toContain("undefined function foo/0");
  });

  // The failure that motivated this: an OOM-killed compile whose only signal was
  // a bare "(exit 137)".
  it("decodes a 137 exit as an OOM-flavoured SIGKILL", () => {
    const message = describeSetupFailure({
      ok: false,
      command: "MIX_ENV=test mix compile",
      code: 137,
      signal: "SIGKILL",
      output: "",
    });

    expect(message).toContain("SIGKILL");
    expect(message).toMatch(/out-of-memory/i);
    expect(message).toContain("(no output)");
  });

  it("keeps the END of a long output, marking what it dropped", () => {
    const output = `${"x".repeat(5000)}THE-ACTUAL-ERROR`;
    const message = describeSetupFailure({
      ok: false,
      command: "noisy",
      code: 1,
      signal: null,
      output,
    });

    expect(message).toContain("THE-ACTUAL-ERROR");
    expect(message).toMatch(/earlier chars omitted/);
    expect(message.length).toBeLessThan(2500);
  });
});
