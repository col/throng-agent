---
"@throng/agent-core": minor
---

Accept an optional `user_identity` block in the initialise manifest: `{ name, email }`, both
optional.

The fields become the commit identity via `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}` — without them git
refuses to commit ("Author identity unknown") and agents invent an identity of their own. They are
independent of `github_token`, which is unchanged and still resolves through the `GITHUB_TOKEN` env
var: an identity is a git concept, unrelated to which token pushes the work.

**Breaking for library consumers:** `BaseManifest` gains a required `user_identity: UserIdentity`
field, and `BootDeps` a required `injectGitIdentity` — the new `injectGitIdentity(identity)` export
sets the identity. The manifest wire format is unchanged for callers that omit the block.
