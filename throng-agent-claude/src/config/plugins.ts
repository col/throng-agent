import type { FieldError } from "@throng/agent-core";

/**
 * Translates the manifest's ergonomic `agent.plugins` list into the two
 * channels a2a-claude exposes: `claude.plugins` for directories already on
 * disk, and `claude.marketplaces` + `claude.enabledPlugins` for plugins the
 * SDK fetches itself.
 *
 * All the ergonomics live here rather than in the wrapper, which stays a thin
 * passthrough of SDK-shaped config.
 */

export interface LocalPlugin {
  type: "local";
  path: string;
}

/** Mirrors the SDK's extraKnownMarketplaces[].source union (github | git). */
export type MarketplaceSource =
  | { source: "github"; repo: string; ref?: string }
  | { source: "git"; url: string; ref?: string };

export interface ResolvedPlugins {
  /** Pre-installed plugin directories → claude.plugins. */
  local: LocalPlugin[];
  /** Marketplace id → source, deduped across entries. */
  marketplaces: Record<string, { source: MarketplaceSource }>;
  /** "<plugin>@<marketplace-id>" → true. */
  enabledPlugins: Record<string, boolean>;
  /** Enabled plugins whose marketplace carries no ref; warned about at boot. */
  unpinned: string[];
}

export type PluginResolution =
  | { ok: true; resolved: ResolvedPlugins }
  | { ok: false; errors: FieldError[] };

export const EMPTY_PLUGINS: ResolvedPlugins = {
  local: [],
  marketplaces: {},
  enabledPlugins: {},
  unpinned: [],
};

// "owner/repo" — no scheme, exactly one slash.
const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// Plugin and marketplace ids become "<plugin>@<marketplace>" keys, so neither
// may contain "@" or whitespace.
const SAFE_ID = /^[^@\s]+$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** "obra/superpowers-marketplace" → "superpowers-marketplace"; strips a .git suffix. */
function deriveMarketplaceId(marketplace: string): string {
  const withoutQuery = marketplace.split(/[?#]/)[0]!;
  const last = withoutQuery.replace(/\/+$/, "").split("/").pop() ?? "";
  return last.replace(/\.git$/, "");
}

function buildSource(marketplace: string, ref: string | undefined): MarketplaceSource | null {
  if (OWNER_REPO.test(marketplace)) {
    return ref ? { source: "github", repo: marketplace, ref } : { source: "github", repo: marketplace };
  }
  if (marketplace.startsWith("https://")) {
    return ref ? { source: "git", url: marketplace, ref } : { source: "git", url: marketplace };
  }
  return null;
}

/**
 * Validates and resolves `agent.plugins`. Returns per-entry FieldErrors so a
 * bad manifest is rejected with 400 rather than failing at boot.
 */
export function resolvePlugins(value: unknown): PluginResolution {
  if (value === undefined) return { ok: true, resolved: EMPTY_PLUGINS };

  const errors: FieldError[] = [];
  if (!Array.isArray(value)) {
    return { ok: false, errors: [{ field: "agent.plugins", reason: "must be a list" }] };
  }

  const local: LocalPlugin[] = [];
  const marketplaces: Record<string, { source: MarketplaceSource }> = {};
  const enabledPlugins: Record<string, boolean> = {};
  const unpinned: string[] = [];
  // Which entry first claimed each marketplace id, for a useful collision message.
  const idOrigin = new Map<string, number>();

  value.forEach((entry, i) => {
    const at = `agent.plugins[${i}]`;
    if (!isObject(entry)) {
      errors.push({ field: at, reason: "must be an object" });
      return;
    }

    const hasPath = "path" in entry;
    const hasRemote = "name" in entry || "marketplace" in entry;
    if (hasPath && hasRemote) {
      errors.push({
        field: at,
        reason: 'must be either { "path" } for a pre-installed plugin or { "name", "marketplace" } for a marketplace plugin, not both',
      });
      return;
    }
    if (!hasPath && !hasRemote) {
      errors.push({
        field: at,
        reason: 'requires either "path" or both "name" and "marketplace"',
      });
      return;
    }

    if (hasPath) {
      if (!nonEmptyString(entry.path)) {
        errors.push({ field: `${at}.path`, reason: "must be a non-empty string" });
      } else if (!entry.path.startsWith("/")) {
        errors.push({
          field: `${at}.path`,
          reason: "must be an absolute path (it is resolved inside the container, not against the workspace)",
        });
      } else {
        local.push({ type: "local", path: entry.path });
      }
      return;
    }

    // A commit SHA is not a valid marketplace ref — the SDK's clone rejects it.
    if ("sha" in entry) {
      errors.push({
        field: `${at}.sha`,
        reason: 'is not supported — marketplaces can only be pinned by branch or tag via "ref"',
      });
    }

    if (!nonEmptyString(entry.name)) {
      errors.push({ field: `${at}.name`, reason: "must be a non-empty string" });
    } else if (!SAFE_ID.test(entry.name)) {
      errors.push({ field: `${at}.name`, reason: "must not contain '@' or whitespace" });
    }
    if ("ref" in entry && !nonEmptyString(entry.ref)) {
      errors.push({ field: `${at}.ref`, reason: "must be a non-empty string when present" });
    }
    if ("marketplace_id" in entry && !nonEmptyString(entry.marketplace_id)) {
      errors.push({ field: `${at}.marketplace_id`, reason: "must be a non-empty string when present" });
    }

    if (!nonEmptyString(entry.marketplace)) {
      errors.push({ field: `${at}.marketplace`, reason: "must be a non-empty string" });
      return;
    }
    const ref = nonEmptyString(entry.ref) ? entry.ref : undefined;
    const source = buildSource(entry.marketplace, ref);
    if (!source) {
      errors.push({
        field: `${at}.marketplace`,
        reason: 'must be "owner/repo" or an https:// git URL',
      });
      return;
    }

    const id = nonEmptyString(entry.marketplace_id)
      ? entry.marketplace_id
      : deriveMarketplaceId(entry.marketplace);
    if (!nonEmptyString(id) || !SAFE_ID.test(id)) {
      errors.push({
        field: `${at}.marketplace`,
        reason: `yields an unusable marketplace id ("${id}") — set "marketplace_id" explicitly`,
      });
      return;
    }

    const existing = marketplaces[id];
    if (existing) {
      // Two entries sharing an id must agree, or the second would silently
      // redefine where the first one's plugin comes from.
      if (JSON.stringify(existing.source) !== JSON.stringify(source)) {
        errors.push({
          field: `${at}.marketplace`,
          reason: `resolves to marketplace id "${id}", which agent.plugins[${idOrigin.get(id)}] already defines with a different source or ref — set "marketplace_id" on one of them`,
        });
        return;
      }
    } else {
      marketplaces[id] = { source };
      idOrigin.set(id, i);
    }

    if (nonEmptyString(entry.name)) {
      const key = `${entry.name}@${id}`;
      enabledPlugins[key] = true;
      if (!ref && !unpinned.includes(key)) unpinned.push(key);
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, resolved: { local, marketplaces, enabledPlugins, unpinned } };
}
