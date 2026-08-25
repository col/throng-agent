---
"@throng/agent-core": minor
---

Accept an empty `repos` list on `/api/initialise` and `/api/prepare`, so a task can boot into an empty
workspace — an agent asked to create a new project from scratch has nothing to clone.

`repos` is still required and must still be a list; only emptiness becomes legal. The
exactly-one-`primary` rule now applies only to a non-empty list. With no repos, the agent's working
directory and the `setup_commands` cwd are the workspace root (`$HOME/workspace`, or `WORKSPACE_DIR`).

New export: `resolveWorkingDirectory(manifest, workspaceRoot)`.

**Breaking (consumers constructing `BootDeps` directly):** `BootDeps` gains a required
`ensureWorkspace: (dir: string) => void`. Nothing else creates the workspace root — it has only ever
existed as a side effect of `git clone` creating its destination's parents, which no longer happens when
there are no repos. `defaultBootDeps()` supplies it.
