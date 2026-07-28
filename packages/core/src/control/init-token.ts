import { timingSafeEqual } from "node:crypto";

/**
 * Optional bootstrap gate. A blank/unset expected token means OPEN (relies on
 * network isolation). When set, requires `Authorization: Bearer <token>` with
 * a constant-time match.
 */
export function checkInitToken(expected: string | undefined, authHeader: string | undefined): boolean {
  const exp = expected?.trim();
  if (!exp) return true;
  const header = authHeader ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const presented = header.slice("Bearer ".length);
  const a = Buffer.from(presented);
  const b = Buffer.from(exp);
  return a.length === b.length && timingSafeEqual(a, b);
}
