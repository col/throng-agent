import { describe, it, expect } from "vitest";
import { CredentialCache } from "./credential-cache.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("CredentialCache", () => {
  it("caches until within the margin of expiry, then refetches", async () => {
    const c = clock();
    let n = 0;
    const cache = new CredentialCache(
      async () => ({
        headers: { authorization: `Bearer t${++n}` },
        expiresAt: new Date(c.now() + 300_000),
      }),
      { marginMs: 60_000, now: c.now },
    );

    expect(await cache.get("a")).toEqual({ authorization: "Bearer t1" });
    c.advance(200_000); // 100s left, outside the margin
    expect(await cache.get("a")).toEqual({ authorization: "Bearer t1" });
    c.advance(41_000); // 59s left, inside the margin
    expect(await cache.get("a")).toEqual({ authorization: "Bearer t2" });
    expect(n).toBe(2);
  });

  it("collapses concurrent gets into one fetch", async () => {
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cache = new CredentialCache(async () => {
      n++;
      await gate;
      return { headers: { authorization: "Bearer x" }, expiresAt: null };
    });
    const all = Promise.all([cache.get("a"), cache.get("a"), cache.get("a")]);
    release();
    const results = await all;
    expect(n).toBe(1);
    expect(results).toHaveLength(3);
  });

  it("keeps names independent", async () => {
    const seen: string[] = [];
    const cache = new CredentialCache(async (name) => {
      seen.push(name);
      return { headers: { "x-name": name }, expiresAt: null };
    });
    expect(await cache.get("a")).toEqual({ "x-name": "a" });
    expect(await cache.get("b")).toEqual({ "x-name": "b" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("inline headers (expiresAt null) never refetch", async () => {
    const c = clock();
    let n = 0;
    const cache = new CredentialCache(
      async () => {
        n++;
        return { headers: { authorization: "Bearer inline" }, expiresAt: null };
      },
      { now: c.now },
    );
    await cache.get("a");
    c.advance(10 * 24 * 3600 * 1000);
    await cache.get("a");
    expect(n).toBe(1);
  });

  it("invalidate forces a refetch", async () => {
    let n = 0;
    const cache = new CredentialCache(async () => ({
      headers: { authorization: `Bearer t${++n}` },
      expiresAt: null,
    }));
    await cache.get("a");
    cache.invalidate("a");
    expect(await cache.get("a")).toEqual({ authorization: "Bearer t2" });
  });

  it("does not cache a failed fetch", async () => {
    let n = 0;
    const cache = new CredentialCache(async () => {
      if (++n === 1) throw new Error("boom");
      return { headers: {}, expiresAt: null };
    });
    await expect(cache.get("a")).rejects.toThrow("boom");
    await expect(cache.get("a")).resolves.toEqual({});
  });
});
