import { execFile } from "node:child_process";
import { log } from "../log.js";

export type SetupResult =
  | { ok: true }
  | { ok: false; command: string; code: number; signal: string | null; output: string };

/** Chars of command output kept in the failure MESSAGE (the full output is logged). */
const OUTPUT_TAIL_CHARS = 2000;

/**
 * GitHub's token prefixes: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-server),
 * ghs_ (installation), ghr_ (refresh).
 *
 * Setup commands used to run before any credential existed. Under the pull model
 * the credential config is written before cloning, so they run with working git
 * and gh — and their output is captured verbatim into the control plane's
 * `instance.error_message`. A command that echoes its environment, or runs
 * `git config --list`, would otherwise persist a live token.
 */
const TOKEN_PATTERN = /gh[pousr]_[A-Za-z0-9]{16,}/g;

const REDACTED = "[REDACTED]";

/**
 * Options for `runSetupCommands`. `env` is the full environment the shell sees
 * (the caller merges project env over `process.env`); `secretValues` are the
 * resolved project-secret values to scrub from every log line and failure message.
 */
export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  secretValues?: readonly string[];
}

/**
 * Masks GitHub tokens plus any literal `extraValues` (resolved project secrets).
 * Longest values go first so a value that contains another (`abc` inside
 * `abcdef`) is replaced whole instead of leaving the remainder behind. Values are
 * matched literally via split/join — never as a pattern — and empty ones are
 * skipped, since splitting on "" would shred the text.
 */
export function redactSecrets(text: string, extraValues: readonly string[] = []): string {
  let out = text.replace(TOKEN_PATTERN, REDACTED);
  const values = extraValues.filter((v) => v !== "").sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(REDACTED);
  return out;
}

export function redactTokens(text: string): string {
  return redactSecrets(text);
}

/**
 * Exit codes a POSIX shell reports as 128 + signal. A setup command that dies this
 * way produced no error text of its own, so the bare code is all the operator gets
 * — and 137 in particular (the OOM killer reaping a compile) is the single most
 * likely way a setup command fails in a memory-capped sandbox.
 */
const SIGNAL_EXITS: Record<number, string> = {
  130: "SIGINT: interrupted",
  131: "SIGQUIT: quit",
  134: "SIGABRT: aborted",
  137: "SIGKILL: killed by the OS — most often the out-of-memory killer; the sandbox may need more memory",
  139: "SIGSEGV: segmentation fault",
  143: "SIGTERM: terminated",
};

function runOne(
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; signal: string | null; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (err) {
        const signal = (err as { signal?: string | null }).signal ?? null;
        // A shell killed by a signal reports no numeric code; surface it as the
        // conventional 128 + signal so downstream sees one consistent scheme.
        const code =
          typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : signal ? 137 : 1;
        resolve({ code, signal, output });
      } else {
        resolve({ code: 0, signal: null, output });
      }
    });
  });
}

/** Keep the TAIL — a failing build's actual error is at the end, not the start. */
function tail(output: string, chars = OUTPUT_TAIL_CHARS): string {
  const trimmed = output.trim();
  if (trimmed.length <= chars) return trimmed;
  return `…[${trimmed.length - chars} earlier chars omitted]…\n${trimmed.slice(-chars)}`;
}

/**
 * Renders a setup failure as an operator-readable message: which command, how it
 * died (decoding signal exits), and the tail of its output.
 *
 * This ends up in the orchestrator's `instance.error_message` via `/api/status`,
 * so it is the ONLY diagnostic most operators will see — the sandbox is usually
 * gone by the time anyone looks.
 *
 * Setup commands run WITH live credentials under the pull model, so the output
 * is redacted before it leaves this process.
 */
export function describeSetupFailure(
  result: Extract<SetupResult, { ok: false }>,
  secretValues: readonly string[] = [],
): string {
  const how = SIGNAL_EXITS[result.code]
    ? `exit ${result.code} — ${SIGNAL_EXITS[result.code]}`
    : `exit ${result.code}`;
  // Redact BEFORE truncating. The other order slices a token straddling the
  // 2000-char boundary: the `gh?_` prefix falls outside the tail, so the pattern
  // no longer matches and the token's suffix is kept verbatim.
  const body = tail(redactSecrets(result.output, secretValues));
  const outputBlock = body ? `\n--- output (tail) ---\n${body}` : "\n(no output)";
  // The command is caller-supplied and as token-bearing as the output: a
  // `git clone https://ghp_…@github.com/…` in `setup_commands` lands in the same
  // `instance.error_message`.
  return `setup command failed: ${redactSecrets(result.command, secretValues)} (${how})${outputBlock}`;
}

/** Runs commands sequentially in `cwd`; the first non-zero exit fails the run. */
export async function runSetupCommands(
  cwd: string,
  commands: string[],
  opts: SetupOptions = {},
): Promise<SetupResult> {
  const { env = process.env, secretValues = [] } = opts;
  for (const [index, command] of commands.entries()) {
    const step = `${index + 1}/${commands.length}`;
    // Logged redacted, returned verbatim: `command` is passed to the shell from
    // the manifest, so it may carry a token, but the caller needs the real string.
    const safeCommand = redactSecrets(command, secretValues);
    log.info("setup command starting", { step, command: safeCommand, cwd });
    const startedAt = Date.now();
    const { code, signal, output } = await runOne(cwd, command, env);
    const durationMs = Date.now() - startedAt;

    if (code !== 0) {
      // Full output at ERROR — the message carries only the tail, and a truncated
      // compile log is exactly what makes these failures hard to diagnose.
      log.error("setup command failed", { step, command: safeCommand, code, signal, durationMs, output: redactSecrets(output, secretValues) });
      return { ok: false, command, code, signal, output };
    }

    log.info("setup command finished", { step, command: safeCommand, durationMs });
  }
  return { ok: true };
}
