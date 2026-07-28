type Level = "INFO" | "WARN" | "ERROR";

/**
 * Minimal structured logger matching the `@col/a2a-claude` SDK's line format
 * (`[iso-ts] [LEVEL] [component] message {json}`) so wrapper and SDK output
 * interleave legibly. Dependency-free; writes to stdout/stderr.
 */
function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = ctx && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : "";
  const line = `[${ts}] [${level}] [throng-a2a] ${msg}${suffix}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, ctx?: Record<string, unknown>) => emit("INFO", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("WARN", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => emit("ERROR", msg, ctx),
};
