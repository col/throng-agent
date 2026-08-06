---
"@throng/agent-core": minor
---

Add `POST /api/prepare` and a sync-aware clone, so a sandbox can be snapshotted with a project's
repositories and dependencies already in place and every task booted from that image.

`/api/prepare` takes the workspace half of a manifest — `repos`, `setup_commands`, and `credentials`
or `github_token` — writes the credential config, syncs the repos, runs the setup commands, then
deletes the credential config and the whole `throng-creds` token cache and settles at a new terminal
lifecycle state, `prepared`. It never injects engine credentials and never starts the A2A server. An
`agent` or `user_identity` block is rejected with a `400` rather than ignored: a snapshot is shared by
every task in the project and is stored by the sandbox provider, so a manifest carrying either is an
initialise manifest sent to the wrong route. The wipe is a security boundary, so it is verified rather
than assumed — `deleteCredentialConfig` re-checks that both paths are actually gone instead of
inferring it from the absence of an exception, and if either survives the prepare fails, because a
snapshot with a live credential in it is worse than no snapshot.

`/api/prepare` also rejects a `repos[].url` that embeds a credential
(`https://x-access-token:ghs_…@github.com/…`). `git clone` writes that URL verbatim into
`<dest>/.git/config`, which lives inside the workspace the snapshot captures, so on this route the
credential outlives a wipe that only ever touches `$HOME/.throng`. On a task sandbox the same URL is a
logging concern `redactTokens` already covers and the sandbox dies with the task, so the rule lives in
`validatePrepare` rather than in the repo rules both routes share.

`prepared` is a terminal *rest* state. A sandbox restored from a snapshot resumes with the lifecycle
the snapshot captured, so `/api/initialise`'s one-shot guard relaxes from "the lifecycle has left
`uninitialised`" to "…and is not `prepared`": a restored sandbox accepts exactly one initialise, and
everything after that guard is unchanged.

`bootstrap/git.ts` gains `syncOrClone(url, dest, ref)`, which both routes use in place of
`clone` + `checkout`, so the two cannot drift. An absent `dest` is cloned and checked out exactly as
before; a `dest` that is already a work tree for the same remote (compared with userinfo, a trailing
slash and a trailing `.git` normalised away) is fetched, force-checked-out and reset to
`origin/<ref>`; anything else — a different remote, a plain directory, a dangling symlink — is removed
and cloned fresh. `checkout -f` discards modifications to tracked files, which a prepared workspace
normally has because `npm ci` and `mix deps.get` rewrite lockfiles; there is deliberately no
`git clean`, so the untracked build output a prepare leaves behind — the entire point of the snapshot
— survives. The reset is skipped for a `ref` with no `origin/<ref>`, so a tag or SHA still works.
Existing boots take the clone branch and are behaviourally unaffected.

Behaviourally, not byte-identically: two things an existing boot can emit have changed shape, without
any change to which manifests succeed or fail. A failed repo sync now reports
`git <op> failed for <dest>@<ref> (exit <code>): …` — it names the ref, and a failed checkout carries
an exit code it never used to — which reaches operators as `instance.error_message`, so log-matching
tooling keyed on the old wording needs updating. And the `400` body from `/api/initialise` lists the
same errors in a different order, because the shared `validateWorkspace` now runs the `github_token`,
`credentials` and `setup_commands` checks ahead of the agent-routing errors and `user_identity` after
them. The set of `{field, reason}` pairs is unchanged; only the array order is.

`repos[].dest` gains one rejection on both routes: a value that resolves to the workspace root itself
(`"."`, `"./"`). `join(workspaceRoot, ".")` is the workspace root, and `syncOrClone` removes a
destination that is not already a work tree for the same remote, so this would delete the whole
workspace including repos synced earlier in the same manifest. It was a `git clone` failure before
`syncOrClone` existed, so it has never been usable input.

New from the package root: `syncOrClone`, `validatePrepare`, `deleteCredentialConfig`,
`credsCachePath`, and the `WorkspaceManifest`, `PrepareValidateResult`, `BootAcceptance` and
`PrepareResult` types.

**Breaking (consumers constructing `BootDeps` directly):** `BootDeps.clone` and `BootDeps.checkout`
are replaced by a single `syncOrClone(url, dest, ref)`; `BootDeps.deleteCredentialConfig` is now
required; and `BootDeps.writeCredentialConfig` now receives a `WorkspaceManifest` rather than a
`BaseManifest`. `defaultBootDeps()` supplies all of it. `clone` and `checkout` are still exported and
unchanged, and `validate`'s behaviour is unchanged — in particular the credential-bearing-URL
rejection above is prepare-only, deliberately, so an unchanged control plane sees no new `400`s on
`/api/initialise`. `BaseManifest` now extends a new `WorkspaceManifest` (the same fields minus
`user_identity`); nothing that consumes a `BaseManifest` changes.
