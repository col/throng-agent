import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeSetupFailure, redactTokens, runSetupCommands } from "./setup.js";

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

describe("token redaction", () => {
  it("redacts every GitHub token prefix", () => {
    const text = [
      "ghp_0123456789abcdefghij",
      "ghs_0123456789abcdefghij",
      "gho_0123456789abcdefghij",
      "ghu_0123456789abcdefghij",
      "ghr_0123456789abcdefghij",
    ].join(" ");

    const out = redactTokens(text);

    expect(out).not.toMatch(/gh[pousr]_/);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(5);
  });

  it("leaves ordinary output alone", () => {
    const text = "npm ERR! missing script: buidl\nat github.com/acme/app";
    expect(redactTokens(text)).toBe(text);
  });

  // This text is stored verbatim in the control plane's instance.error_message.
  // Setup commands now run with live credentials, so a command echoing its
  // environment would otherwise persist a minted token.
  it("redacts inside a setup failure message", () => {
    const message = describeSetupFailure({
      ok: false,
      command: "env",
      code: 1,
      signal: null,
      output: "GH_TOKEN=ghs_0123456789abcdefghij\n",
    });

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("ghs_0123456789abcdefghij");
  });

  // Truncating before redacting slices a token that straddles the 2000-char
  // boundary: the `ghs_` prefix falls outside the tail, so the pattern no longer
  // matches and the token's SUFFIX is kept verbatim. Redacting first closes it.
  it("redacts a token that straddles the truncation boundary", () => {
    // 24 chars. Positioned so its last 10 land inside the tail and its prefix
    // does not: 1990 trailing chars + 24 = the cut falls mid-token.
    const token = "ghs_ABCDEFGHIJKLMNOPQRST";
    const message = describeSetupFailure({
      ok: false,
      command: "noisy",
      code: 1,
      signal: null,
      output: `${"x".repeat(3000)}${token}${"y".repeat(1990)}`,
    });

    expect(message).toMatch(/earlier chars omitted/); // truncation really happened
    expect(message).not.toContain(token);
    expect(message).not.toContain("KLMNOPQRST"); // nor the surviving tail of it
    expect(message).toContain("[REDACTED]");
  });

  // The COMMAND is as token-bearing as the output. `setup_commands` is caller
  // supplied, and a `git clone https://ghp_…@github.com/...` in it lands in the
  // same instance.error_message the output half is already redacted for.
  it("redacts a token in the failing command, not just in its output", () => {
    const message = describeSetupFailure({
      ok: false,
      command: "git clone https://ghp_0123456789abcdefghij@github.com/acme/app",
      code: 128,
      signal: null,
      output: "fatal: repository not found\n",
    });

    expect(message).not.toContain("ghp_0123456789abcdefghij");
    expect(message).toContain("[REDACTED]");
    expect(message).toContain("github.com/acme/app"); // still identifies the command
  });
});

describe("runSetupCommands logging", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts a token in the command on both the start and failure log lines", async () => {
    const lines: string[] = [];
    const capture = (line: unknown) => void lines.push(String(line));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const dir = tmp();

    await runSetupCommands(dir, ["echo ghp_0123456789abcdefghij && exit 3"]);

    expect(lines.some((l) => l.includes("setup command starting"))).toBe(true);
    expect(lines.some((l) => l.includes("setup command failed"))).toBe(true);
    for (const line of lines) expect(line).not.toContain("ghp_0123456789abcdefghij");
  });
});
