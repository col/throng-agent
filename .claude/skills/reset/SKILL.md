---
name: reset
description: Use when the user asks to "reset", "reset the repo", "start fresh", "clean slate", or wants the project back to a known-good state on main before starting new feature development. Handles uncommitted changes, switches to main, pulls, reinstalls dependencies, and runs the full check suite.
---

# Reset

Returns the working copy to a known-good baseline so new feature work starts from a clean, green `main`: no uncommitted changes, up to date with origin, dependencies matching the lockfile, build/typecheck/tests passing.

This skill is **read-then-ask** about anything destructive. Never throw away work without the user explicitly choosing to.

## Steps

1. **Survey the current state.** Run these together:
   ```
   git branch --show-current
   git status --short
   git stash list
   ```
   If not on `main`, also check for commits that exist only locally:
   ```
   git log --oneline @{u}..HEAD    # unpushed commits (fails if no upstream)
   ```
   If the branch has no upstream, use `git log --oneline main..HEAD` instead.

2. **Handle uncommitted changes.** If `git status --short` is empty, skip to step 4.

   Otherwise, build a summary for the user *before* asking anything:
   ```
   git diff --stat              # unstaged changes to tracked files
   git diff --cached --stat     # staged changes
   git status --short           # includes untracked (??) files
   ```
   Present the summary — file count, which files, roughly what changed — then **ask the user** what to do. Use AskUserQuestion with these options:
   - **Stash** (recommended default) — `git stash push -u -m "reset: <short description>"`. The `-u` includes untracked files. Tell the user how to get it back: `git stash pop`.
   - **Commit** — they may want the work kept on a branch. If they're on `main`, create a branch first rather than committing to `main`.
   - **Discard** — `git checkout -- .` plus `git clean -fd` for untracked. **Destructive and unrecoverable.** Only after the user explicitly picks it; re-confirm if the diff is large or touches many files.
   - **Something else / stop** — let them handle it manually and abort the reset.

   Never pick for them. Never silently stash.

3. **Warn about unpushed commits.** If step 1 found local-only commits on a non-`main` branch, tell the user which ones before switching away. The commits survive on the branch, but they should know they're leaving them behind. If the branch is not pushed anywhere, say so explicitly.

4. **Switch to main and pull.**
   ```
   git checkout main
   git pull
   ```
   If the pull fails (diverged, conflicts, network), stop and report. Do not force anything.

5. **Reinstall dependencies.** A pull can move `package-lock.json`, and a stale `node_modules` is exactly the kind of thing that makes a green baseline lie. `npm ci` installs the lockfile exactly, deleting `node_modules` first.

   The workspace includes `throng-agent-claude`, which depends on the **private** `@col/a2a-claude` from GitHub Packages, so any install needs a token:
   ```
   GITHUB_TOKEN="$(gh auth token)" npm ci
   ```
   If `gh auth token` is empty, stop and report — the install will 401 on the `@col` scope and there is nothing useful to do until the user re-authenticates with `gh auth login`.

6. **Run the checks.** Mirror what CI runs, in order, and stop at the first failure:
   ```
   npm run build
   npm run typecheck
   npm test
   ```
   These need no token — only installs do.

7. **Report.**
   - **All green:** tell the user the project is reset and ready for new feature development. Include: the commit `main` is now at, whether anything was stashed (and how to recover it), whether the install changed anything, and the test count.
   - **Checks failing:** report the failures with the actual output and **stop**. Do not start fixing them — a failing baseline on `main` is information the user needs before deciding anything. Ask whether they want them investigated.

## Notes

- Only `npm install` / `npm ci` need `GITHUB_TOKEN`. Plain `npm run build|typecheck|test` read what is already in `node_modules` and work without one.
- `git clean -fd` in step 2 will **not** remove `node_modules`, `.turbo` or `dist` (they're gitignored, and `-x` is deliberately not used). Never add `-x` to the clean — it would wipe `node_modules` and force a token'd reinstall to get back to where you were.
- Turborepo caches build/typecheck/test results in `.turbo`, so step 6 can report `cached` for tasks whose inputs did not change. That is a real pass, not a skipped one. If the user wants everything genuinely re-run, add `--force` (e.g. `npm test -- --force`).
- If the user is already on a clean, up-to-date `main`, steps 2–4 are no-ops. Still reinstall and run the checks — a green baseline is the point of the skill, not just the branch state.
- This skill does not create a feature branch. It leaves the user on `main`, ready to branch when they decide what they're building.
