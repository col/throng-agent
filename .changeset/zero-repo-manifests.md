---
"@throng/agent-core": minor
---

Accept an empty `repos` list on `/api/initialise` and `/api/prepare`, so a task can boot into an empty
workspace. Whether a task needs a repository is the consumer's decision: an agent asked to create a new
project from scratch — scaffold it, `git init` it, create the remote — has nothing to clone, and until
now could not be booted at all.

`repos` remains a required key and must still be a list; only emptiness becomes legal. An absent `repos`
is still `{"repos", "is required"}`, so a control plane that drops the field fails loudly rather than
silently booting an agent with nothing checked out. The exactly-one-`primary` rule now applies only to a
non-empty list — with no repos there is nothing for it to choose between, though one repo must still
claim it, because `primary` is what names the directory the agent runs in. Both routes change together,
because `validate` and `validatePrepare` share every repo rule precisely so a snapshot build and the
task boot that restores from it cannot disagree about what a repo list means; a zero-repo prepare is a
legitimate way to warm a toolchain cache into a snapshot from `setup_commands` alone.

With no repos, the agent's working directory and the `setup_commands` cwd are the workspace root
(`$HOME/workspace`, or `WORKSPACE_DIR`). A repository the agent creates there lands in the same layout a
later task's manifest expects. For Claude, `settingSources: ["project"]` then finds no `CLAUDE.md` and no
`.claude/settings.json`, because there is no project yet.

Working-directory resolution moves out of the clone loop into a new exported
`resolveWorkingDirectory(manifest, workspaceRoot)`, which returns the primary repo's destination or the
workspace root. It also now runs *before* the clone rather than after it, so a non-empty manifest with no
primary repo fails having done nothing instead of after fetching every repo over the network. No
reachable input changes: validation rejects such a manifest on both routes. `syncRepos` correspondingly
becomes clone-only and returns nothing.

Nothing else relaxes. `repos[].dest` still rejects `"."`, the `credentials` and `github_token` rules are
untouched, and a non-array `repos` is still a `400`.

**Breaking (consumers constructing `BootDeps` directly):** `BootDeps` gains a required
`ensureWorkspace: (dir: string) => void`, called unconditionally before the clone loop.
`defaultBootDeps()` supplies `mkdirSync(dir, { recursive: true })`. It is needed because nothing else
creates the workspace root — the directory has only ever existed as a side effect of `git clone`
creating its destination's parents, which no longer happens when there are no repos. It is a dep rather
than a direct `mkdirSync` so a caller can point the runtime at a workspace it manages itself, and so the
test suite's fake workspace root stays inert.

`EngineAdapter.buildAgentConfig`'s second parameter is renamed `primaryDest` -> `workingDirectory`, in
the interface and in both bundled engine adapters. Not a breaking change — TypeScript compares
signatures structurally and ignores parameter names — but the old name now asserts something untrue: it
receives the workspace root when the manifest carries no repos, so it is not necessarily a repository.
