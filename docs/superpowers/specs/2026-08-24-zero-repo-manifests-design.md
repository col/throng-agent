# Zero-repo manifests

## Problem

A manifest with an empty repo list is rejected:

```
[{"repos", "must contain at least one entry"}]
```

The rule assumes every task starts from existing code. That is not always true. An
agent asked to create a new project from scratch — scaffold it, `git init` it,
create the remote — has no repo to clone, and today it cannot be booted at all.

Whether a task needs a repo is the consumer's decision, not the runtime's. The
runtime's job is to make an empty workspace behave predictably.

## What changes

An empty `repos` array becomes valid input on `/api/initialise` and
`/api/prepare`. The agent's working directory in that case is the workspace root.

Applying it to both routes is deliberate. `validate` and `validatePrepare` share
every per-field and cross-field repo rule (`validateWorkspace`,
`crossFieldRepoErrors`) precisely so a snapshot build and the task boot that
restores from it cannot disagree about what a repo list means. Relaxing one route
only would make the two disagree for the first time, and the reward would be
small: a prepare with no repos but with `setup_commands` is a legitimate way to
warm a toolchain cache into a snapshot.

`repos` stays a **required** key. `repos: []` is accepted; omitting the field
remains a 400. An empty workspace is a thing the caller states, not a thing that
happens when a payload loses a field — a control-plane bug that drops `repos`
should still fail loudly rather than silently boot an agent with nothing checked
out.

Nothing else relaxes. `dest: "."` stays rejected, the `credentials` and
`github_token` rules are untouched, and a non-array `repos` is still a 400.

## Validation

`packages/core/src/manifest/validate.ts`.

`validateRepos` drops the `value.length === 0` rejection. The `undefined` and
non-array branches stay exactly as they are.

`crossFieldRepoErrors` requires exactly one `primary: true` **only when `repos`
is non-empty**; on an empty array it returns no errors. Without this the length
check's removal would achieve nothing — zero repos means zero primaries, so
`primaries !== 1` fires instead, and the caller trades one confusing 400 for
another.

The dest-uniqueness check and prepare's `rejectCredentialBearingRepoUrls` are
already no-ops on an empty array and need no change.

## Working directory

`packages/core/src/task-run.ts`.

Today `syncRepos` both clones and computes the primary repo's destination,
accumulating `primaryDest` through the clone loop and throwing if it is still
`""` at the end. That destination is two things: the cwd for `setup_commands`,
and the `workingDirectory` handed to `adapter.buildAgentConfig`.

Resolution moves into a pure function:

```ts
function resolveWorkingDirectory(manifest: WorkspaceManifest, workspaceRoot: string): string
```

- `repos` non-empty, one marked primary → `join(workspaceRoot, primary.dest)`
- `repos` empty → `workspaceRoot`
- `repos` non-empty, none primary → throws `StepError("cloning", …)`

The third case preserves the existing guard. Validation accepts exactly one
primary on both routes, so it is unreachable through the public API, but the
silent failure it prevents is bad: an empty working directory makes
`runSetupCommands` run in the process's cwd instead of the repo and report
success. The guard survives as a function contract rather than a loop invariant,
which is the point of extracting it — the empty-repos case makes the separation
between "clone the repos" and "decide where the agent runs" load-bearing rather
than cosmetic, and a pure function is testable without mocking git.

`syncRepos` loses the accumulator and its return value; it only clones. `boot`
and `prepareWorkspace` each call `resolveWorkingDirectory` and pass the result to
`runSetup` and (in `boot`) `buildAgentConfig`.

Resolution happens **before** `syncRepos`, not after. The old guard fired at the
end of the clone loop, so a manifest with no primary repo cloned everything over
the network and only then failed. Resolving first makes that a validation-shaped
failure with nothing done. It is a strict improvement and affects no reachable
input, since validation rejects such a manifest anyway.

`syncRepos` is still called on a zero-repo manifest. Its loop body simply does
not execute, so it logs the step, ensures the workspace, and returns.

## Workspace creation

Nothing creates `workspaceRoot` today. It exists as a side effect of `git clone`
creating its destination's parents. With no repos, nothing creates it, and the
agent would be pointed at a directory that does not exist.

`BootDeps` gains:

```ts
ensureWorkspace: (dir: string) => void;
```

`defaultBootDeps` implements it as `mkdirSync(dir, { recursive: true })`.
`syncRepos` calls it unconditionally, for every manifest, before the clone loop —
idempotent where `git clone` would have created the directory anyway, and
load-bearing where there are no repos. A failure is wrapped as
`StepError("cloning", …)`, matching how the other filesystem faults in that step
are reported.

It is an injected dep rather than a direct `mkdirSync` for the same reason every
other side effect in `BootDeps` is: `task-run.test.ts` uses
`workspaceRoot: "/home/user/workspace"`, a path that does not exist on a
developer machine and cannot be created there. A raw `mkdirSync` would make the
existing suite depend on the host filesystem.

## Behaviour with an empty workspace

- `syncOrClone` is never called; no network access during the clone step.
- `setup_commands` run with `workspaceRoot` as cwd. Still supported, and the
  reason a zero-repo prepare is worth allowing.
- The agent's `workingDirectory` is `workspaceRoot`. For Claude,
  `settingSources: ["project"]` then finds no `CLAUDE.md` and no
  `.claude/settings.json`, because there is no project yet. That is correct, not
  a degradation.
- An agent that creates a repository does so inside `workspaceRoot`, where
  cloned repos live, so a subsequent task whose manifest names that repo finds
  the layout it expects.
- Credential write and wipe, git identity injection, and the prepare lifecycle
  are all unchanged — none of them reads `repos`.

## Testing

`manifest/validate.test.ts`

- Invert the assertion at line 320: `repos: []` is accepted on prepare rather
  than producing a `repos` error.
- The initialise equivalent: a manifest with `repos: []` and a valid `agent`
  block validates.
- An empty `repos` produces no `repos[].primary` error, while a non-empty array
  with every entry `primary: false` still does. This pins the conditional in
  `crossFieldRepoErrors` — the pair fails if the rule is dropped outright instead
  of made conditional.
- Omitting `repos` entirely is still `{ field: "repos", reason: "is required" }`
  on both routes.

`task-run.test.ts`

- Add `ensureWorkspace: vi.fn()` to the fake deps.
- A zero-repo initialise reaches `ready`, and `buildAgentConfig` receives
  `workspaceRoot` as its working directory.
- `setup_commands` on a zero-repo manifest run with `workspaceRoot` as cwd.
- `syncOrClone` is never called for a zero-repo manifest.
- `ensureWorkspace` is called for both the zero-repo and the normal path.
- A zero-repo prepare reaches `prepared` and still wipes credentials.

`resolveWorkingDirectory` gets direct unit tests for all three cases, including
the throw.
