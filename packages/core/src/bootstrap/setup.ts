import { execFile } from "node:child_process";

export type SetupResult =
  | { ok: true }
  | { ok: false; command: string; code: number; output: string };

function runOne(cwd: string, command: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (err) {
        const code = typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1;
        resolve({ code, output });
      } else {
        resolve({ code: 0, output });
      }
    });
  });
}

/** Runs commands sequentially in `cwd`; the first non-zero exit fails the run. */
export async function runSetupCommands(cwd: string, commands: string[]): Promise<SetupResult> {
  for (const command of commands) {
    const { code, output } = await runOne(cwd, command);
    if (code !== 0) return { ok: false, command, code, output };
  }
  return { ok: true };
}
