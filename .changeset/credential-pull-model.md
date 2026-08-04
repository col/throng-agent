---
"@throng/agent-core": minor
---

Replace boot-time GitHub token injection with a pull model: `git` and `gh` fetch a short-lived token
at the moment of use, and no installation token is ever placed in the sandbox's environment.

A process's environment is fixed at `execve()`, so a token injected at boot can never be refreshed —
which broke every task outliving its 1 hour installation token, and every task paused waiting on user
input. The sandbox now holds only a task-scoped identity token in `/run/throng/config.json`, and a
bash helper (`throng-creds`, shipped in `dist/creds/`) exchanges it for a GitHub token per operation:
as git's system credential helper, and through a `gh` shim. It caches per repo, single-flights
concurrent misses, and declines silently when unconfigured, so public clones still work in a sandbox
that was never initialised.

The initialise manifest gains an optional `credentials: { url, token }` block naming the credentials
API. `github_token` is unchanged, still falls back to the `GITHUB_TOKEN` env var, and now wins over
`credentials` when both are present — honoured inside the helper rather than by a second code path,
so a standalone `docker run` exercises the production wiring.

`repos[].token` is retired. It is still accepted, so an unchanged caller does not start receiving
400s, but it is ignored with a warning: the helper scopes per repo on every request, which is
strictly narrower than a static per-repo token was.

Setup commands now run after credentials are configured, so `git` and `gh` work inside them —
a private submodule or a git-URL dependency begins to work. Because their output is captured into the
control plane's `instance.error_message`, setup, clone and checkout output, the failing command, and
the clone URL are all redacted of `gh[pousr]_` tokens before they leave the process.

**Breaking for library consumers**, though the manifest wire format only relaxes:

- `injectGitCredentials` and `ASKPASS` are removed, along with the askpass script. `injectGitIdentity`
  is unaffected — commit identity was always a separate concern — and moves to
  `bootstrap/git-identity.ts`.
- `BootDeps` replaces its `injectGitCredentials` member with `writeCredentialConfig(manifest)`, which
  runs first in the boot sequence because cloning now depends on it.
- `clone(url, dest)` loses its `token` parameter; authentication is the credential helper's job.
- `BaseManifest` gains a required `credentials: CredentialsConfig | null`, and `RepoSpec` loses
  `token`.
- New exports: `writeCredentialConfig`, `CONFIG_PATH`, `redactTokens`, and the `CredentialsConfig`
  type.

Consumers must run the helper for any of this to work; it is installed by the `throng-agent` image
from this package's `dist/creds/`, which also bakes in the system git config and
`GIT_TERMINAL_PROMPT=0`.
