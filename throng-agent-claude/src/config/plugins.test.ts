import { describe, expect, it } from "vitest";
import { resolvePlugins, type ResolvedPlugins } from "./plugins.js";

function ok(entries: unknown): ResolvedPlugins {
  const r = resolvePlugins(entries);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.resolved;
}

function errs(entries: unknown): Array<{ field: string; reason: string }> {
  const r = resolvePlugins(entries);
  if (r.ok) throw new Error("expected errors, got ok");
  return r.errors;
}

describe("resolvePlugins", () => {
  it("treats an absent list as no plugins", () => {
    const r = ok(undefined);
    expect(r).toEqual({ marketplaces: {}, enabledPlugins: {}, unpinned: [] });
  });

  it("maps owner/repo to a github source and derives the marketplace id", () => {
    const r = ok([{ name: "superpowers", marketplace: "obra/superpowers-marketplace", ref: "v1.0.12" }]);
    expect(r.marketplaces).toEqual({
      "superpowers-marketplace": {
        source: { source: "github", repo: "obra/superpowers-marketplace", ref: "v1.0.12" },
      },
    });
    expect(r.enabledPlugins).toEqual({ "superpowers@superpowers-marketplace": true });
    expect(r.unpinned).toEqual([]);
  });

  // An https:// repo URL is a `git` source, not `url` — `url` means a direct
  // marketplace.json and has no ref field, so pinning would silently vanish.
  it("maps an https git URL to a git source, stripping .git from the id", () => {
    const r = ok([{ name: "internal", marketplace: "https://github.com/throng/mk.git", ref: "v2" }]);
    expect(r.marketplaces).toEqual({
      mk: { source: { source: "git", url: "https://github.com/throng/mk.git", ref: "v2" } },
    });
    expect(r.enabledPlugins).toEqual({ "internal@mk": true });
  });

  it("rejects a pre-installed path, which the wrapper cannot express", () => {
    const e = errs([{ path: "/opt/plugins/baked-in" }]);
    expect(e[0]!.field).toBe("agent.plugins[0].path");
    expect(e[0]!.reason).toMatch(/not supported/);
  });

  it("collapses two plugins from the same marketplace into one entry", () => {
    const r = ok([
      { name: "a", marketplace: "org/mk", ref: "v1" },
      { name: "b", marketplace: "org/mk", ref: "v1" },
    ]);
    expect(Object.keys(r.marketplaces)).toEqual(["mk"]);
    expect(r.enabledPlugins).toEqual({ "a@mk": true, "b@mk": true });
  });

  it("rejects two marketplaces that collide on a derived id", () => {
    const e = errs([
      { name: "a", marketplace: "org-one/mk", ref: "v1" },
      { name: "b", marketplace: "org-two/mk", ref: "v1" },
    ]);
    expect(e[0]!.field).toBe("agent.plugins[1].marketplace");
    expect(e[0]!.reason).toMatch(/agent\.plugins\[0\] already defines/);
    expect(e[0]!.reason).toMatch(/marketplace_id/);
  });

  it("treats the same repo at different refs as a collision", () => {
    const e = errs([
      { name: "a", marketplace: "org/mk", ref: "v1" },
      { name: "b", marketplace: "org/mk", ref: "v2" },
    ]);
    expect(e[0]!.reason).toMatch(/different source or ref/);
  });

  it("lets marketplace_id disambiguate a collision", () => {
    const r = ok([
      { name: "a", marketplace: "org-one/mk", ref: "v1" },
      { name: "b", marketplace: "org-two/mk", ref: "v1", marketplace_id: "mk-two" },
    ]);
    expect(Object.keys(r.marketplaces).sort()).toEqual(["mk", "mk-two"]);
    expect(r.enabledPlugins).toEqual({ "a@mk": true, "b@mk-two": true });
  });

  it("reports unpinned marketplace plugins without failing", () => {
    const r = ok([{ name: "sp", marketplace: "obra/superpowers-marketplace" }]);
    expect(r.unpinned).toEqual(["sp@superpowers-marketplace"]);
    expect(r.marketplaces["superpowers-marketplace"]!.source).toEqual({
      source: "github",
      repo: "obra/superpowers-marketplace",
    });
  });

  // The SDK's marketplace clone rejects a commit SHA as a ref — fail loudly at
  // validation rather than let it surface as a clone failure at boot.
  it("rejects sha with guidance toward ref", () => {
    const e = errs([{ name: "a", marketplace: "org/mk", sha: "a1b2c3d" }]);
    expect(e[0]!.field).toBe("agent.plugins[0].sha");
    expect(e[0]!.reason).toMatch(/branch or tag via "ref"/);
  });

  it("rejects an entry mixing path with marketplace fields", () => {
    const e = errs([{ path: "/opt/p", name: "a", marketplace: "org/mk" }]);
    expect(e[0]!.field).toBe("agent.plugins[0].path");
    expect(e[0]!.reason).toMatch(/not supported/);
  });

  it("rejects an entry with neither name nor marketplace", () => {
    expect(errs([{}])[0]!.reason).toMatch(/requires both "name" and "marketplace"/);
  });

  it("rejects a marketplace that is neither owner/repo nor https", () => {
    const e = errs([{ name: "a", marketplace: "git@github.com:org/mk.git" }]);
    expect(e[0]!.reason).toMatch(/"owner\/repo" or an https:\/\/ git URL/);
  });

  it("rejects a plugin name containing @, which would corrupt the key", () => {
    const e = errs([{ name: "a@b", marketplace: "org/mk" }]);
    expect(e[0]!.field).toBe("agent.plugins[0].name");
  });

  it("rejects a non-list and non-object entries", () => {
    expect(errs("nope")[0]).toEqual({ field: "agent.plugins", reason: "must be a list" });
    expect(errs(["nope"])[0]!.reason).toMatch(/must be an object/);
  });

  it("reports every bad entry at once, with indexed field paths", () => {
    const e = errs([{ path: "/opt/p" }, {}, { name: "x", marketplace: "" }]);
    expect(e.map((x) => x.field)).toEqual([
      "agent.plugins[0].path",
      "agent.plugins[1]",
      "agent.plugins[2].marketplace",
    ]);
  });
});
