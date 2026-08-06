---
name: release
description: Use when the user asks to "release", "cut a release", "ship", "publish", or "bump the version" of throng-agent, or to move an E2B template pin (beta/stable) to a new agent image. Covers both the throng-agent tag and the throng_e2b_templates pin that consumes it.
---

# Release

Releasing throng-agent means **two repositories and two tags**. Doing only the first ships nothing anyone runs: the image sits in GHCR unused until an E2B template pins it.

| Repo | What a tag does |
| --- | --- |
| `throng_agent` (here) | `publish.yml` fires on `v*` → builds `throng-agent/Dockerfile` → pushes `ghcr.io/col/throng-agent:X.Y.Z` |
| `throng_e2b_templates` (sibling) | `build-templates.yml` fires on **any** tag → rebuilds all four project × channel templates from the pins committed in `throng-agent/template.ts` |

**The image version lives only in the git tag.** No file in this repo records it — do not bump any `package.json`.

## Settled decisions — do not re-investigate

- **No npm publish.** `changeset version`/`changeset publish` have never been run here (no CHANGELOGs, no changeset ever consumed, `npm view @throng/agent-core` 404s). Changesets accumulate as release notes only. Leave `.changeset/` alone and leave every `package.json` version alone. If asked to publish to npm, treat that as a separate decision, confirm first, and keep it off the release's critical path — the image build reads repo source and never touches npm, so publishing unblocks nothing.
- **A pending changeset is not unshipped work.** Files in `.changeset/` are never consumed, so most of them describe code that already shipped in whatever tag followed them. Before calling anything a "backlog", check which tag contains each changeset's commit (`git log --oneline --diff-filter=A -1 -- .changeset/<file>`, then `git tag --contains <sha>`). Usually only the newest one is actually unreleased.
- **Always confirm the channel before editing pins.** Never infer it. Stable reaches every user immediately.
- The image tag is a **monotonic build counter**, not library semver — features have shipped as patches throughout `0.1.x`. Default to the next patch; confirm if the user implies otherwise.

## Inputs

Ask for whichever the user did not give:

1. **Version** — default to the next patch after `git tag --sort=-v:refname | head -1`.
2. **Channel** — `beta` only, `stable` only, or both. **Always ask.** See the promotion flow in the templates repo's `README.md` / `AGENTS.md`.

## Steps

### 1. Pre-flight (here)

```bash
git branch --show-current              # must be main — stop if not
git fetch --tags origin
git status --short                     # no modified/staged TRACKED files
git rev-parse HEAD origin/main         # must match — the tag must sit on what CI checked out
gh run list --branch main --limit 3    # CI must be green on HEAD
```

Any failure: stop and report. Do not release from a branch, from modified tracked files, or on a red CI.

**Untracked files (`??`) do not block a release** and do not need raising — a tag captures committed state only, and this repo routinely carries untracked `.claude/`, scratch and editor files. Only *modified or staged tracked* files matter, because they mean the tree differs from what CI verified.

### 2. Tag and push (here)

Use an **annotated** tag — the message is this repo's only changelog. Summarise what changed since the last tag (`git log --oneline vLAST..HEAD`, and the pending `.changeset/*.md` describe it well).

```bash
git tag -a vX.Y.Z -m "vX.Y.Z — <summary>

<what changed and what it means for callers>"
git push origin vX.Y.Z
```

### 3. Wait for the image, and verify it exists

**Blocking.** A template build pins `fromImage(ghcr.io/col/throng-agent:X.Y.Z)` and fails deep inside E2B if the tag is not there yet.

```bash
gh run watch $(gh run list --workflow="Publish image" --limit 1 --json databaseId --jq '.[0].databaseId')
gh api /users/col/packages/container/throng-agent/versions --jq '.[0].metadata.container.tags'
```

Expect `["X.Y.Z","latest","0.1"]`. Note that **`latest` and `<major>.<minor>` move on every release**, including a beta-only one — `docker/metadata-action`'s default `latest=auto` does this. E2B is unaffected (both channels pin exact versions), but the README's standalone `docker run …:latest` recipes now pull the new image.

### 4. Move the pin(s) (templates repo)

`/Users/col/projects/throng_platform/throng_e2b_templates/throng-agent/template.ts`:

```ts
export const BETA_VERSION = '0.1.7'     // beta channel
export const STABLE_VERSION = '0.1.7'   // stable channel — what all users get
```

Edit **only** the constant(s) for the channel(s) confirmed in Inputs. The two must stay split: the workflow fires on any tag and builds all four combinations, so a shared value would ship whatever beta is testing straight to users. `throng-agent-elixir` carries no pin — it chains on the agent template by name and inherits the image.

```bash
cd /Users/col/projects/throng_platform/throng_e2b_templates
git fetch --tags origin && git status --short   # clean, on main
# edit the pin(s)
git diff                                        # exactly the intended line(s)
npm run typecheck
git add throng-agent/template.ts
git commit -m "chore(agent): pin the beta channel to wrapper image X.Y.Z

<what the image adds>

Beta only. STABLE_VERSION stays at <old> pending a Dev-beta and Prod-beta soak."
git push origin main
git tag -a vA.B.C -m "vA.B.C — beta channel to agent image X.Y.Z"
git push origin vA.B.C
```

The templates repo has its own tag line (`v0.3.x`, unrelated to the agent's) — take the next patch after its latest tag. The name is arbitrary; the workflow reads versions from the committed file, never from the tag.

### 5. Verify the templates built

```bash
gh run watch $(gh run list --workflow="Build E2B templates" --limit 1 --json databaseId --jq '.[0].databaseId')
```

Read the four job summaries: the two beta rows must show the new version and the two stable rows the old one (or both new, if promoting). The stable jobs always rebuild — on an unchanged image that is a harmless no-op, not a promotion.

### 6. Report

Tell the user what shipped, to which channel, in which projects, and what remains. If the release went to beta only, say plainly that stable is untouched and name the promotion step. Point at the templates repo's "Running a prod beta end-to-end test" section for the soak.

## Gotchas

| Thing | Reality |
| --- | --- |
| `smoke.ts` with no argument | Defaults to the **beta** template. After promoting stable, `npx tsx throng-agent/smoke.ts throng-agent` — omitting the name silently smokes beta and proves nothing. |
| `E2B_API_KEY` | The *only* thing selecting Dev vs Prod, silently. Run `npm run e2b:whoami` before trusting any local sandbox. |
| Hand-building a template | Don't build into a name CI owns. A stale template boots fine and runs months-old code. |
| Re-tagging a bad release | Don't. Roll forward with a new version — a moved tag makes the image and its source commit disagree permanently. |
| Rollback | Revert the pin to the previous version, commit, tag, push. Old images stay on GHCR, so this always works. Beta-only means stable was never at risk. |

## Red flags — stop and ask

- About to edit `STABLE_VERSION` without the user having said "stable" or "both".
- About to tag the templates repo before the GHCR image is confirmed present.
- About to run `changeset version`, `changeset publish`, or `npm run release`.
- About to bump a version in any `package.json` as part of a release.
- Working tree dirty, branch is not `main`, or CI is not green.
