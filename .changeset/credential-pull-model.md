---
"@throng/agent-core": minor
---

Replace boot-time GitHub token injection with a pull model: `git` and `gh` fetch a short-lived token
at the moment of use, and no installation token is ever placed in the sandbox's environment.

A process's environment is fixed at `execve()`, so a token injected at boot can never be refreshed —
which broke every task outliving its 1 hour installation token, and every task paused waiting on user
input. The sandbox now holds only a task-scoped identity token in `$HOME/.throng/config.json`, and a
bash helper (`throng-creds`, shipped in `dist/creds/`) exchanges it for a GitHub token per operation:
as git's system credential helper, and through a `gh` shim. It caches per repo, single-flights
concurrent misses, and declines silently when unconfigured, so public clones still work in a sandbox
that was never initialised.

Both locations sit under `$HOME/.throng` (overridable with `THRONG_CONFIG` and `THRONG_CREDS_CACHE`),
because the sandbox runs unprivileged: hosts do not agree on the uid it runs as (E2B runs it as
uid 1000, `docker run` as the image's root), and `/run` — the original location — is root-owned
`0755`. `$HOME` needs no privilege and, unlike `/dev/shm`, its parent is owned by the user, so
nothing can squat the directory. The trade is that it is disk-backed, so the identity token does
reach a persisted layer; accepted, since E2B snapshots memory on pause anyway and the design already
assumes the agent can read that token.

The runtime and the bash helper both resolve this from `$HOME` and nothing else — not
`os.homedir()`, whose passwd fallback bash does not share — and an unset `HOME` is a hard error
rather than a fallback, because a disagreement would leave the runtime writing a file the helper
never reads and the helper declining as though the sandbox were unconfigured.

`defaultBootDeps()` clones into `$HOME/workspace` instead of `/workspace`, which an unprivileged uid
cannot create. `WORKSPACE_DIR` still overrides it.

`startControlServer()` sets `GIT_TERMINAL_PROMPT=0` on the runtime's `process.env` before anything
can fork, so the runtime and every process descended from it inherits it. The image keeps the `ENV`
of the same name and adds `/etc/profile.d/throng.sh`, which covers login shells the runtime did not
start — under E2B the runtime process inherits no image `ENV` at all, which is why an image-only
version passed a `docker run` check and did nothing in production. `buildServer` and
`createControlApp` are unchanged and set nothing, so a consumer that calls `buildServer(...).listen()`
instead of `startControlServer(...)` must set the variable itself.

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
- New exports: `writeCredentialConfig`, `CONFIG_PATH`, `redactTokens`, `homeDir`, and the
  `CredentialsConfig` type.
- `startControlServer` returns the listening `http.Server` instead of `void`, so a caller can shut
  it down. Additive; existing call sites need no change.
- `CONFIG_PATH` is evaluated at module load, so **importing the package throws** when `HOME` is
  unset and `THRONG_CONFIG` is not — set `THRONG_CONFIG` in the environment before the import, not
  programmatically after it. `defaultBootDeps()` throws on the same condition for `WORKSPACE_DIR`,
  at call time.

Consumers must run the helper for any of this to work; it is installed by the `throng-agent` image
from this package's `dist/creds/`, which also bakes in the system git config.
