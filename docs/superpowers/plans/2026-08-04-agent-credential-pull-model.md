# Agent Credential Pull Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace boot-time `GH_TOKEN` injection with a credential helper that fetches a fresh GitHub token at the moment of use, so `git` and `gh` keep working for the whole of a task however long it runs or sits paused.

**Architecture:** A bash script `throng-creds` serves git's credential-helper protocol and backs the `gh` CLI through a shim. A cache hit is served from disk with no HTTP; a miss takes a lock and either serves a literal `github_token` from `/run/throng/config.json` or calls the Throng credentials API. The agent runtime writes that config file at `/api/initialise`, before cloning.

**Tech Stack:** bash 3.2-compatible shell, `jq`, `curl`, TypeScript/Node 20, vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-08-04-agent-credential-pull-model-design.md`

---

## Deviations from the spec (decided while planning, corrected in Task 15)

Two implementation realities differ from the spec as written. Both are corrected in the spec by Task 15 — do not silently leave the spec contradicting the code.

1. **`mkdir` locking, not `flock`.** `flock` is util-linux and absent on macOS, where this repo's tests are run locally. A `mkdir` lock is atomic everywhere, needs no package, and has no stale-lock case to reason about because the wait is bounded — after 15s the caller proceeds without the lock. Worst case is a duplicate API call, which is far better than a stalled `git push`.
2. **The fast path forks once** (`date +%s`), not zero times. The fork-free `printf '%(%s)T'` needs bash 4.2; macOS ships bash 3.2. One fork is ~1ms and keeps the test suite running natively on both platforms.

**The script must stay bash 3.2 compatible.** No `mapfile`, no `exec {fd}>`, no `printf '%(%s)T'`, no associative arrays, no `${var^^}`. The image runs bash 5.2, but vitest spawns `bash` from PATH and on macOS that is 3.2.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `packages/core/src/creds/throng-creds.sh` | the credential helper: protocol, cache, lock, resolution, HTTP |
| `packages/core/src/creds/gh-shim.sh` | wraps `gh.real` with a freshly fetched `GH_TOKEN` |
| `packages/core/src/creds/throng-creds.test.ts` | spawn-and-assert suite for both scripts |
| `packages/core/src/creds/config.ts` | writes `/run/throng/config.json` from the manifest |
| `packages/core/src/creds/config.test.ts` | unit tests for the above |

**Modify:**

| Path | Change |
|---|---|
| `packages/core/src/manifest/types.ts` | add `CredentialsConfig`; `RepoSpec` loses `token`; `BaseManifest` gains `credentials` |
| `packages/core/src/manifest/validate.ts` | validate `credentials`; accept-and-warn on `repos[].token` |
| `packages/core/src/manifest/validate.test.ts` | cover the above |
| `packages/core/src/task-run.ts` | boot reorder; `BootDeps` swaps `injectGitCredentials` for `writeCredentialConfig` |
| `packages/core/src/task-run.test.ts` | cover the above |
| `packages/core/src/bootstrap/git.ts` | `clone()` loses its `token` param; `ASKPASS` deleted |
| `packages/core/src/bootstrap/git.test.ts` | update call sites |
| `packages/core/src/bootstrap/setup.ts` | redact tokens from captured output |
| `packages/core/src/bootstrap/setup.test.ts` | cover redaction |
| `packages/core/src/control/server.ts` | `defaultBootDeps()` wiring |
| `packages/core/src/index.ts` | exports |
| `packages/core/package.json` | build copies `creds/*.sh` instead of `askpass.sh` |
| `throng-agent/Dockerfile` | `curl`+`jq`; `gh` → `gh.real`; install shims; `git config --system` |
| `throng-agent/src/integration/boot.test.ts` | `BootDeps` shape |
| `README.md` | manifest docs |
| `docs/superpowers/specs/2026-08-04-agent-credential-pull-model-design.md` | the two deviations above |

**Delete:**

| Path | Why |
|---|---|
| `packages/core/src/bootstrap/askpass.sh` | no per-invocation askpass under the pull model |
| `packages/core/src/bootstrap/git-credentials.ts` | replaced by `git-identity.ts` (identity only) |
| `packages/core/src/bootstrap/git-credentials.test.ts` | replaced by `git-identity.test.ts` |

**Rename:** `bootstrap/git-credentials.{ts,test.ts}` → `bootstrap/git-identity.{ts,test.ts}`. After `injectGitCredentials` is deleted the file holds only `injectGitIdentity`, and the old name would describe something it no longer does.

---

### Task 1: Test harness and the cache fast path

The helper is built inside-out: cache reading first, because every other path ends by writing something this code must be able to read.

**Files:**
- Create: `packages/core/src/creds/throng-creds.sh`
- Create: `packages/core/src/creds/throng-creds.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/creds/throng-creds.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./throng-creds.sh", import.meta.url));

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** A fresh sandbox: its own config path and cache dir, so tests never collide. */
export function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "throng-creds-"));
}

/** Spawn the real script. `bash` from PATH is bash 3.2 on macOS — deliberate. */
export function run(
  dir: string,
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [SCRIPT, ...args],
      {
        env: {
          ...process.env,
          THRONG_CONFIG: join(dir, "config.json"),
          THRONG_CREDS_CACHE: join(dir, "cache"),
          ...opts.env,
        },
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
    child.stdin?.end(opts.stdin ?? "");
  });
}

/** Write a cache entry directly, so fast-path tests need no server. */
export function seedCache(
  dir: string,
  key: string,
  opts: { serveUntil: number; token: string; keyLine?: string },
): void {
  const cache = join(dir, "cache");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, key.replace(/[^A-Za-z0-9._-]/g, "_"));
  writeFileSync(
    file,
    [
      String(opts.serveUntil),
      opts.keyLine ?? key,
      "username=x-access-token",
      `password=${opts.token}`,
      `password_expiry_utc=${opts.serveUntil + 300}`,
      "",
    ].join("\n"),
  );
}

export const soon = () => Math.floor(Date.now() / 1000) + 3600;
export const past = () => Math.floor(Date.now() / 1000) - 60;

/** git speaks to a credential helper in `key=value` lines ended by a blank line. */
const getStdin = (path: string) =>
  `protocol=https\nhost=github.com\npath=${path}\n\n`;

describe("throng-creds fast path", () => {
  it("serves a fresh cache entry without touching the network", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_cached" });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("username=x-access-token");
    expect(r.stdout).toContain("password=ghs_cached");
    expect(r.stdout).toContain("quit=1");
  });

  it("ignores an entry past its serve window", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: past(), token: "ghs_stale" });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    // No config file, so the slow path declines: exit 0 and no credential.
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("ghs_stale");
  });

  it("ignores an entry whose recorded key does not match (filename collision)", async () => {
    const dir = sandbox();
    // "acme/app" and "acme_app" both sanitise to the filename "acme_app".
    seedCache(dir, "git|github.com|acme/app", {
      serveUntil: soon(),
      token: "ghs_wrongrepo",
      keyLine: "git|github.com|acme_app",
    });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.stdout).not.toContain("ghs_wrongrepo");
  });

  it("ignores a malformed cache file rather than serving garbage", async () => {
    const dir = sandbox();
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(join(dir, "cache", "git_github.com_acme_app"), "not-a-number\nwhatever\n");

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("password=");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: FAIL — every case errors because `throng-creds.sh` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/core/src/creds/throng-creds.sh`:

```bash
#!/bin/bash
# throng-creds — GitHub credentials for the agent sandbox, fetched at the moment
# of use rather than injected at boot.
#
#   throng-creds git get|store|erase   git credential helper protocol (stdin)
#   throng-creds gh                    bare token on stdout, for the gh shim
#
# See docs/superpowers/specs/2026-08-04-agent-credential-pull-model-design.md
#
# Deliberately bash 3.2 compatible. The image runs bash 5.2, but macOS ships 3.2
# and the test suite spawns this script with `bash` from PATH. No mapfile, no
# `exec {fd}>`, no printf '%(%s)T', no associative arrays.
#
# No `set -e`: a credential helper must decide for itself what is fatal and what
# is a decline, and `-e` would turn an ordinary non-zero probe into an exit.

set -uo pipefail

CONFIG_FILE="${THRONG_CONFIG:-/run/throng/config.json}"
CACHE_DIR="${THRONG_CREDS_CACHE:-/run/throng/cache}"
SKEW=300              # serve_until = expires_at - SKEW

warn() { printf 'throng-creds: %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }
now()  { date +%s; }

# REPLY <- the cache file for a canonical key. Sanitising can collide
# ("acme/app" and "acme_app" both become "acme_app"), which is why every entry
# records the key it was minted for; read_fresh rejects a mismatch.
cache_file() {
  local safe="${1//[^A-Za-z0-9._-]/_}"
  REPLY="$CACHE_DIR/$safe"
}

# Prints the cached credential lines when the entry exists, records this exact
# key, and is still inside its serve window. Returns 1 otherwise.
read_fresh() { # $1 = canonical key
  local file exp key line body=""
  cache_file "$1"; file="$REPLY"
  [ -f "$file" ] || return 1
  {
    read -r exp || return 1
    read -r key || return 1
    while IFS= read -r line; do body="$body$line
"; done
  } < "$file"
  case "$exp" in ''|*[!0-9]*) return 1 ;; esac
  [ "$key" = "$1" ] || return 1
  [ "$exp" -gt "$(now)" ] || return 1
  [ -n "$body" ] || return 1
  printf '%s' "$body"
}

# Prints the credential block for a key, from cache when fresh.
# Returns 1 to decline.
credential() { # $1=key $2=purpose $3=host $4=repo (may be empty)
  read_fresh "$1" && return 0
  return 1
}

git_get() {
  local line k v protocol="" host="" path="" repo=""
  while IFS= read -r line; do
    [ -z "$line" ] && break
    k="${line%%=*}"; v="${line#*=}"
    case "$k" in
      protocol) protocol="$v" ;;
      host)     host="$v" ;;
      path)     path="$v" ;;
    esac
  done

  # Decline anything that is not GitHub over HTTPS. Exit 0 with no output lets
  # git fall through to its own behaviour, which is what makes public clones in
  # an unconfigured sandbox keep working.
  [ "$protocol" = "https" ] || exit 0
  [ "$host" = "github.com" ] || exit 0

  # Requires credential.useHttpPath=true. Without it `path` is empty and the
  # request falls back to the task's default scope.
  repo="${path#/}"
  repo="${repo%.git}"

  credential "git|$host|$repo" git "$host" "$repo" || exit 0
  printf 'quit=1\n'
}

case "${1:-}" in
  git)
    case "${2:-}" in
      get)   git_get ;;
      store) cat >/dev/null ;;
      erase) cat >/dev/null ;;
      *)     exit 0 ;;
    esac
    ;;
  *) die "usage: throng-creds git <get|store|erase> | throng-creds gh" ;;
esac
```

Note the literal newline inside `body="$body$line` — bash 3.2 has no `$'\n'` inside `${}` concatenation that reads as cleanly; a literal line break in the string is correct and intentional. Do not "tidy" it into `\n`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/
git commit -m "feat(creds): throng-creds cache fast path and git get protocol"
```

---

### Task 2: Decline rules and repo derivation

**Files:**
- Modify: `packages/core/src/creds/throng-creds.test.ts`

The implementation from Task 1 already satisfies these. They are written as tests because each is a rule the spec depends on, and each is one line away from silently regressing.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/creds/throng-creds.test.ts`:

```ts
describe("throng-creds decline rules", () => {
  it("declines a non-HTTPS protocol so git falls through", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_x" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=ssh\nhost=github.com\npath=acme/app.git\n\n",
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("declines a host other than github.com", async () => {
    const dir = sandbox();
    seedCache(dir, "git|gitlab.com|acme/app", { serveUntil: soon(), token: "ghs_x" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=gitlab.com\npath=acme/app.git\n\n",
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("derives the same repo with or without a trailing .git", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_same" });

    const withSuffix = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
    });
    const without = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\npath=acme/app\n\n",
    });

    expect(withSuffix.stdout).toContain("password=ghs_same");
    expect(without.stdout).toContain("password=ghs_same");
  });

  it("strips a leading slash from path", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_slash" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\npath=/acme/app.git\n\n",
    });

    expect(r.stdout).toContain("password=ghs_slash");
  });

  it("falls back to the default scope when useHttpPath is off (no path sent)", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|", { serveUntil: soon(), token: "ghs_default" });

    const r = await run(dir, ["git", "get"], {
      stdin: "protocol=https\nhost=github.com\n\n",
    });

    expect(r.stdout).toContain("password=ghs_default");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: PASS for all five. If any fails, the Task 1 implementation is wrong — fix it there rather than weakening the test.

This is the one task in the plan where a passing test at Step 2 is the expected outcome. These are regression locks on behaviour already written, not new behaviour.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/creds/throng-creds.test.ts
git commit -m "test(creds): lock in decline rules and repo derivation"
```

---

### Task 3: `store`, `erase` and `gh` modes

**Files:**
- Modify: `packages/core/src/creds/throng-creds.sh`
- Modify: `packages/core/src/creds/throng-creds.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/creds/throng-creds.test.ts`:

```ts
import { existsSync, readdirSync } from "node:fs";

describe("throng-creds store/erase/gh", () => {
  it("store consumes stdin and exits 0 without persisting anything", async () => {
    const dir = sandbox();

    const r = await run(dir, ["git", "store"], {
      stdin: "protocol=https\nhost=github.com\nusername=x\npassword=y\n\n",
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(dir, "cache"))).toBe(false);
  });

  // Git calls erase after a 401. Everything must go, so the next operation
  // re-mints rather than replaying a token GitHub has already rejected.
  it("erase clears the cache", async () => {
    const dir = sandbox();
    seedCache(dir, "git|github.com|acme/app", { serveUntil: soon(), token: "ghs_dead" });
    seedCache(dir, "api|github.com|", { serveUntil: soon(), token: "ghs_dead2" });

    const r = await run(dir, ["git", "erase"], {
      stdin: "protocol=https\nhost=github.com\n\n",
    });

    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "cache")) ? readdirSync(join(dir, "cache")) : []).toEqual([]);
  });

  it("gh prints a bare token from the default-scope entry", async () => {
    const dir = sandbox();
    seedCache(dir, "api|github.com|", { serveUntil: soon(), token: "ghs_forgh" });

    const r = await run(dir, ["gh"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("ghs_forgh");
  });

  it("gh prints nothing and exits 0 when unconfigured", async () => {
    const dir = sandbox();

    const r = await run(dir, ["gh"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: FAIL — `gh` is not a recognised mode (the script `die`s with usage), and `erase` does not clear the cache.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/creds/throng-creds.sh`, add these two functions after `git_get`:

```bash
git_erase() {
  cat >/dev/null
  # Git calls erase after a 401. Drop the whole directory rather than globbing:
  # lock directories live here too, and a partial clear would leave a rejected
  # token in play for some other key.
  rm -rf "${CACHE_DIR:?}"
  return 0
}

# The shim cannot know which repo a given `gh` command targets, so `gh` always
# resolves against the task's default scope.
gh_token() {
  local out line
  out=$(credential "api|github.com|" api "github.com" "") || exit 0
  while IFS= read -r line; do
    case "$line" in
      password=*) printf '%s\n' "${line#password=}"; return 0 ;;
    esac
  done <<EOF
$out
EOF
  return 0
}
```

Then replace the entry-point `case` at the bottom of the file with:

```bash
case "${1:-}" in
  git)
    case "${2:-}" in
      get)   git_get ;;
      store) cat >/dev/null ;;   # nothing to persist; must still exit 0
      erase) git_erase ;;
      *)     exit 0 ;;
    esac
    ;;
  gh) gh_token ;;
  *)  die "usage: throng-creds git <get|store|erase> | throng-creds gh" ;;
esac
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/
git commit -m "feat(creds): store, erase and gh modes"
```

---

### Task 4: Config resolution — decline and static token

**Files:**
- Modify: `packages/core/src/creds/throng-creds.sh`
- Modify: `packages/core/src/creds/throng-creds.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/creds/throng-creds.test.ts`:

```ts
/** Write the config file throng-creds reads on a cache miss. */
function writeConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
}

describe("throng-creds config resolution", () => {
  it("declines silently when there is no config file", async () => {
    const dir = sandbox();

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("declines when the config carries neither a token nor credentials", async () => {
    const dir = sandbox();
    writeConfig(dir, {});

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("serves a static github_token and caches it", async () => {
    const dir = sandbox();
    writeConfig(dir, { github_token: "ghp_static" });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("password=ghp_static");
    expect(r.stdout).toContain("quit=1");

    // Far-future expiry: every later call is a fast-path hit, so a standalone
    // sandbox takes the slow path once per key for its whole life.
    const entry = readFileSync(join(dir, "cache", "git_github.com_acme_app"), "utf8");
    const serveUntil = Number(entry.split("\n")[0]);
    expect(serveUntil).toBeGreaterThan(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  });

  it("serves the static token for gh as well", async () => {
    const dir = sandbox();
    writeConfig(dir, { github_token: "ghp_static" });

    const r = await run(dir, ["gh"]);

    expect(r.stdout.trim()).toBe("ghp_static");
  });

  it("prefers a static github_token over credentials", async () => {
    const dir = sandbox();
    writeConfig(dir, {
      github_token: "ghp_static",
      // Unreachable on purpose: if this were consulted the test would hang or fail.
      credentials: { url: "http://127.0.0.1:1", token: "task-tok" },
    });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.stdout).toContain("password=ghp_static");
  });
});
```

Add `readFileSync` to the `node:fs` import at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: FAIL on the static-token cases — `credential()` currently returns 1 on any cache miss.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/creds/throng-creds.sh`, add a constant beside `SKEW`:

```bash
STATIC_TTL=315360000  # 10 years, for a literal github_token
```

Add `write_cache` and `resolve` after `read_fresh`:

```bash
# Atomic within the cache directory: git may be reading while we write.
write_cache() { # $1=key $2=serve_until $3=username $4=token $5=password_expiry
  local file tmp
  cache_file "$1"; file="$REPLY"
  mkdir -p "$CACHE_DIR" 2>/dev/null || return 1
  tmp="$file.$$"
  {
    printf '%s\n' "$2"
    printf '%s\n' "$1"
    printf 'username=%s\n' "$3"
    printf 'password=%s\n' "$4"
    printf 'password_expiry_utc=%s\n' "$5"
  } > "$tmp" || return 1
  chmod 600 "$tmp" 2>/dev/null
  mv -f "$tmp" "$file"
}

# Fills the cache for a key. Returns 1 to DECLINE — no config, or nothing
# usable in it — which the caller turns into a silent exit 0.
resolve() { # $1=key $2=purpose $3=host $4=repo (may be empty)
  [ -r "$CONFIG_FILE" ] || return 1

  # Read with jq, never sourced: this file holds a control-plane-supplied token,
  # and `. file` would execute whatever it contains.
  local static
  static=$(jq -r '.github_token // empty' "$CONFIG_FILE" 2>/dev/null)
  if [ -n "$static" ]; then
    local expiry
    expiry=$(( $(now) + STATIC_TTL ))
    write_cache "$1" "$expiry" "x-access-token" "$static" "$expiry" || return 1
    return 0
  fi

  return 1
}
```

Replace `credential()` with:

```bash
credential() { # $1=key $2=purpose $3=host $4=repo (may be empty)
  read_fresh "$1" && return 0
  resolve "$@" || return 1
  read_fresh "$1"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/
git commit -m "feat(creds): config resolution and static token precedence"
```

---

### Task 5: The credentials API

**Files:**
- Modify: `packages/core/src/creds/throng-creds.sh`
- Modify: `packages/core/src/creds/throng-creds.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/creds/throng-creds.test.ts`:

```ts
import { createServer, type Server } from "node:http";
import { afterEach } from "vitest";

interface Stub {
  url: string;
  requests: Array<{ body: string; auth: string | undefined; idempotency: string | undefined }>;
  close: () => Promise<void>;
}

/** A stand-in for POST /v1/credentials/github. `reply` decides each response. */
async function stubApi(
  reply: (n: number) => { status: number; body: unknown },
): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({
        body,
        auth: req.headers.authorization,
        idempotency: req.headers["idempotency-key"] as string | undefined,
      });
      const { status, body: payload } = reply(requests.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const stubs: Stub[] = [];
afterEach(async () => {
  while (stubs.length) await stubs.pop()!.close();
});

async function api(reply: (n: number) => { status: number; body: unknown }): Promise<Stub> {
  const s = await stubApi(reply);
  stubs.push(s);
  return s;
}

const okBody = (token: string, expiresAt: string) => ({
  username: "x-access-token",
  token,
  expires_at: expiresAt,
  scope: { repos: ["acme/app"], permissions: { contents: "write" } },
});

const isoIn = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

describe("throng-creds credentials API", () => {
  it("mints a token, sends the task identity, and caches the result", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_minted", isoIn(3600)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("password=ghs_minted");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].auth).toBe("Bearer task-tok");
    expect(stub.requests[0].idempotency).toBeTruthy();
    expect(JSON.parse(stub.requests[0].body)).toEqual({
      purpose: "git",
      host: "github.com",
      repo: "acme/app",
    });
  });

  it("omits repo entirely for gh, so the server applies the default scope", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_api", isoIn(3600)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    await run(dir, ["gh"]);

    expect(JSON.parse(stub.requests[0].body)).toEqual({ purpose: "api", host: "github.com" });
  });

  // serve_until is expires_at minus skew, so the fast path needs no ISO parsing
  // and no arithmetic of its own.
  it("writes serve_until 300s before the true expiry", async () => {
    const dir = sandbox();
    const expiresAt = isoIn(3600);
    const stub = await api(() => ({ status: 200, body: okBody("ghs_x", expiresAt) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    const lines = readFileSync(join(dir, "cache", "git_github.com_acme_app"), "utf8").split("\n");
    const trueExpiry = Math.floor(new Date(expiresAt).getTime() / 1000);
    expect(Number(lines[0])).toBe(trueExpiry - 300);
    expect(lines[1]).toBe("git|github.com|acme/app");
    expect(lines).toContain(`password_expiry_utc=${trueExpiry}`);
  });

  it("does not call the API twice for the same key", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_once", isoIn(3600)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });
    const second = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(second.stdout).toContain("password=ghs_once");
    expect(stub.requests).toHaveLength(1);
  });

  it("403 is permanent, names the repo, and tells the agent not to work around it", async () => {
    const dir = sandbox();
    const stub = await api(() => ({
      status: 403,
      body: { message: "acme/secret is not in this task's grant" },
    }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/secret.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("acme/secret");
    expect(r.stderr).toContain("will not change on retry");
    expect(r.stderr).toContain("different repository or remote");
    expect(r.stderr).toContain("is not in this task's grant");
    expect(stub.requests).toHaveLength(1); // never retried
  });

  it("401 reports a revoked or completed task", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 401, body: {} }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("revoked or completed");
    expect(stub.requests).toHaveLength(1);
  });

  it("429 is described as transient and retryable", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 429, body: {} }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("transient");
    expect(r.stderr).toContain("retry the same command");
  });

  it("retries a 5xx and succeeds when the retry does", async () => {
    const dir = sandbox();
    const stub = await api((n) =>
      n === 1
        ? { status: 503, body: {} }
        : { status: 200, body: okBody("ghs_afterretry", isoIn(3600)) },
    );
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.stdout).toContain("password=ghs_afterretry");
    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("reports an unreachable service as transient", async () => {
    const dir = sandbox();
    writeConfig(dir, { credentials: { url: "http://127.0.0.1:1", token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("transient");
  });

  it("rejects a 200 that omits expires_at rather than caching forever", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: { username: "x", token: "ghs_x" } }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const r = await run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain("expires_at");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: FAIL — `resolve()` returns 1 whenever there is no static token, so nothing calls the API.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/creds/throng-creds.sh`, add these helpers above `resolve`:

```bash
# REPLY <- a request id. /proc is Linux-only and the test suite runs on macOS.
uuid() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    read -r REPLY < /proc/sys/kernel/random/uuid
  elif command -v uuidgen >/dev/null 2>&1; then
    REPLY=$(uuidgen)
  else
    REPLY="$$-$(now)-$RANDOM"
  fi
}

# GNU date and BSD date disagree on parsing; try both. The API contract
# specifies ISO-8601 with a Z suffix, which is all we accept.
iso_to_epoch() {
  date -u -d "$1" +%s 2>/dev/null && return 0
  date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null && return 0
  return 1
}

fetch() { # $1=key $2=purpose $3=host $4=repo $5=url $6=task_token
  local req resp rc status body msg username tok exp_iso exp_epoch serve_until scope

  req=$(jq -nc --arg p "$2" --arg h "$3" --arg r "$4" \
        '{purpose:$p, host:$h} + (if $r == "" then {} else {repo:$r} end)')

  uuid
  # --retry covers 5xx, timeouts and connection-refused. A 4xx is never retried,
  # which is what we want: a 403 will not become a 200.
  resp=$(curl -sS --max-time 10 --retry 2 --retry-connrefused \
           -w '\n%{http_code}' \
           -H "Authorization: Bearer $6" \
           -H "Content-Type: application/json" \
           -H "Idempotency-Key: $REPLY" \
           -d "$req" "$5/v1/credentials/github" 2>/dev/null)
  rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$resp" ]; then
    die "the Throng credential service is unreachable. This is transient — retry the same command."
  fi

  # -w always appends "\n<code>", so the status is everything after the final
  # newline and the body is everything before it. Correct even when the body is
  # empty or carries no trailing newline of its own.
  status="${resp##*
}"
  body="${resp%
*}"

  scope="${4:-the task's default scope}"
  case "$status" in
    200) ;;
    401) die "task identity rejected — this task may have been revoked or completed." ;;
    403)
      msg=$(printf '%s' "$body" | jq -r '.message // empty' 2>/dev/null)
      die "this task's credentials do not cover $scope. This is a policy decision and will not change on retry: do not retry it, and do not attempt the same operation against a different repository or remote.${msg:+ ($msg)}"
      ;;
    429) die "the Throng credential service is rate limiting. This is transient — retry the same command." ;;
    *)   die "the Throng credential service returned HTTP $status. This is transient — retry the same command." ;;
  esac

  username=$(printf '%s' "$body" | jq -r '.username // empty' 2>/dev/null)
  tok=$(printf '%s' "$body" | jq -r '.token // empty' 2>/dev/null)
  exp_iso=$(printf '%s' "$body" | jq -r '.expires_at // empty' 2>/dev/null)
  [ -n "$tok" ] || die "the credential service returned no token."
  # Without expires_at the entry could never age out, and the installation-token
  # creation limit would be exhausted by the resulting churn elsewhere.
  [ -n "$exp_iso" ] || die "the credential service returned no expires_at."

  exp_epoch=$(iso_to_epoch "$exp_iso") || die "could not parse expires_at '$exp_iso'."
  serve_until=$(( exp_epoch - SKEW ))
  write_cache "$1" "$serve_until" "${username:-x-access-token}" "$tok" "$exp_epoch"
}
```

The two multi-line parameter expansions above (`${resp##*` … `}`) contain a literal newline. That is deliberate — bash 3.2 does not accept `$'\n'` inside `${}`. Do not reformat them onto one line.

Then replace the `return 1` at the end of `resolve()` with:

```bash
  local url token
  url=$(jq -r '.credentials.url // empty' "$CONFIG_FILE" 2>/dev/null)
  token=$(jq -r '.credentials.token // empty' "$CONFIG_FILE" 2>/dev/null)
  [ -n "$url" ] && [ -n "$token" ] || return 1

  fetch "$1" "$2" "$3" "$4" "$url" "$token"
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/
git commit -m "feat(creds): fetch from the credentials API with agent-facing errors"
```

---

### Task 6: Single-flight

Write this test first and take it seriously: it is the only one that catches a lock regression, and a stampede stays silent until GitHub starts rate-limiting installation-token creation.

**Files:**
- Modify: `packages/core/src/creds/throng-creds.sh`
- Modify: `packages/core/src/creds/throng-creds.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/creds/throng-creds.test.ts`:

```ts
describe("throng-creds single-flight", () => {
  it("makes exactly one API call when several git operations miss at once", async () => {
    const dir = sandbox();
    const stub = await api(() => ({ status: 200, body: okBody("ghs_shared", isoIn(3600)) }));
    writeConfig(dir, { credentials: { url: stub.url, token: "task-tok" } });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(dir, ["git", "get"], { stdin: getStdin("acme/app.git") }),
      ),
    );

    // All five get a credential; only one of them paid for it.
    for (const r of results) expect(r.stdout).toContain("password=ghs_shared");
    expect(stub.requests).toHaveLength(1);
  }, 30_000);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: FAIL — `expect(received).toHaveLength(1)` with a received length between 2 and 5. All five processes miss the cache and each calls the API.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/creds/throng-creds.sh`, add beside `SKEW`:

```bash
LOCK_TICKS=75         # × 0.2s = 15s before giving up on the lock
```

Add after `write_cache`:

```bash
# Single-flight. `mkdir` is atomic on every POSIX filesystem, needs no
# util-linux (flock is absent on macOS, where these tests run), and has no
# stale-lock case to reason about because the wait is bounded: after LOCK_TICKS
# we proceed anyway. A duplicate API call is a far better outcome than a git
# operation that stalls behind a lock whose owner died.
LOCK_DIR=""
acquire_lock() { # $1 = canonical key
  local lock ticks=0
  cache_file "$1"; lock="$REPLY.lock"
  mkdir -p "$CACHE_DIR" 2>/dev/null
  while ! mkdir "$lock" 2>/dev/null; do
    if [ "$ticks" -ge "$LOCK_TICKS" ]; then
      warn "proceeding without the single-flight lock"
      return 0
    fi
    sleep 0.2
    ticks=$((ticks + 1))
  done
  LOCK_DIR="$lock"
  trap 'release_lock' EXIT
}

release_lock() {
  [ -n "$LOCK_DIR" ] && rmdir "$LOCK_DIR" 2>/dev/null
  LOCK_DIR=""
}
```

Replace `credential()` with:

```bash
credential() { # $1=key $2=purpose $3=host $4=repo (may be empty)
  read_fresh "$1" && return 0

  acquire_lock "$1"
  # The process that held the lock may have just filled the cache. Re-check
  # before spending an API call.
  if read_fresh "$1"; then release_lock; return 0; fi

  if resolve "$@"; then
    release_lock
    read_fresh "$1"
    return $?
  fi
  release_lock
  return 1
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/
git commit -m "feat(creds): single-flight lock so parallel git ops mint once"
```

---

### Task 7: The `gh` shim

**Files:**
- Create: `packages/core/src/creds/gh-shim.sh`
- Modify: `packages/core/src/creds/throng-creds.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/creds/throng-creds.test.ts`:

```ts
import { chmodSync } from "node:fs";

const SHIM = fileURLToPath(new URL("./gh-shim.sh", import.meta.url));

/**
 * The shim resolves throng-creds and gh.real through THRONG_CREDS_BIN and
 * GH_REAL_BIN so it can be exercised without installing anything. In the image
 * both default to their /usr/local/bin paths.
 */
function fakeGh(dir: string): string {
  const path = join(dir, "gh-real");
  writeFileSync(
    path,
    ["#!/bin/bash", 'printf "GH_TOKEN=%s\\n" "${GH_TOKEN-<unset>}"', 'printf "args=%s\\n" "$*"', ""].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

function runShim(dir: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "bash",
      [SHIM, ...args],
      {
        env: {
          ...process.env,
          THRONG_CONFIG: join(dir, "config.json"),
          THRONG_CREDS_CACHE: join(dir, "cache"),
          THRONG_CREDS_BIN: `bash ${SCRIPT}`,
          GH_REAL_BIN: fakeGh(dir),
        },
      },
      (err, stdout, stderr) => {
        resolve({ stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 });
      },
    );
    child.stdin?.end("");
  });
}

describe("gh shim", () => {
  it("runs gh with a freshly fetched token and forwards its arguments", async () => {
    const dir = sandbox();
    writeConfig(dir, { github_token: "ghp_shim" });

    const r = await runShim(dir, ["pr", "create", "--fill"]);

    expect(r.stdout).toContain("GH_TOKEN=ghp_shim");
    expect(r.stdout).toContain("args=pr create --fill");
  });

  // Setting GH_TOKEN to "" would make gh report an auth rejection. Leaving it
  // unset gets gh's own "not logged in" message, which is the true problem.
  it("leaves GH_TOKEN unset when throng-creds declines", async () => {
    const dir = sandbox();

    const r = await runShim(dir, ["pr", "list"]);

    expect(r.stdout).toContain("GH_TOKEN=<unset>");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: FAIL — `gh-shim.sh` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/creds/gh-shim.sh`:

```bash
#!/bin/bash
# gh shim — installed at /usr/local/bin/gh, ahead of the real binary at
# /usr/local/bin/gh.real.
#
# `gh` reads GH_TOKEN from its environment, and an environment is fixed at
# execve(), so a token placed there at boot cannot be refreshed. Fetching one
# per invocation is the only way `gh` can outlive a 1 hour installation token.
#
# The two _BIN variables exist so the test suite can exercise this without
# installing anything; in the image both defaults are correct.

set -uo pipefail

CREDS_BIN="${THRONG_CREDS_BIN:-/usr/local/bin/throng-creds}"
GH_REAL="${GH_REAL_BIN:-/usr/local/bin/gh.real}"

TOKEN=$($CREDS_BIN gh)

# On a decline or a failure, exec gh WITHOUT GH_TOKEN rather than with an empty
# one: gh then reports that it is not logged in, which is the actual problem,
# instead of an auth rejection that misdirects. throng-creds has already
# explained itself on stderr.
if [ -n "$TOKEN" ]; then
  exec env GH_TOKEN="$TOKEN" "$GH_REAL" "$@"
fi
exec "$GH_REAL" "$@"
```

`$CREDS_BIN` is deliberately unquoted: the test passes `bash /path/to/throng-creds.sh`, which must split into two words. The installed value is a single path with no spaces.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- creds`
Expected: PASS, 31 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/
git commit -m "feat(creds): gh shim fetching a fresh token per invocation"
```

---

### Task 8: Manifest types and validation

**Files:**
- Modify: `packages/core/src/manifest/types.ts`
- Modify: `packages/core/src/manifest/validate.ts`
- Modify: `packages/core/src/manifest/validate.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/manifest/validate.test.ts`. The file already defines an `echo` adapter and `const registry = { test: echo }`, so `agent.platform` here is `"test"` — not `"claude"`.

```ts
describe("credentials block", () => {
  const base = {
    repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true }],
    agent: { platform: "test", model: "m" },
  };

  it("is optional", () => {
    const r = validate(base, registry);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.credentials).toBeNull();
  });

  it("resolves url and token onto the manifest", () => {
    const r = validate(
      { ...base, credentials: { url: "https://cp.example", token: "task-tok" } },
      registry,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.credentials).toEqual({ url: "https://cp.example", token: "task-tok" });
  });

  it("rejects a non-object", () => {
    const r = validate({ ...base, credentials: "nope" }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "credentials")).toBe(true);
  });

  it("rejects a blank url or token", () => {
    const r = validate({ ...base, credentials: { url: "  ", token: "" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === "credentials.url")).toBe(true);
      expect(r.errors.some((e) => e.field === "credentials.token")).toBe(true);
    }
  });

  it("rejects a missing url", () => {
    const r = validate({ ...base, credentials: { token: "t" } }, registry);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "credentials.url")).toBe(true);
  });

  // Accepted so an unchanged control plane does not start receiving 400s, but
  // it carries no information: throng-creds scopes per repo already.
  it("accepts and ignores repos[].token", () => {
    const r = validate(
      {
        ...base,
        repos: [{ url: "https://x/y", ref: "main", dest: "y", primary: true, token: "ghs_old" }],
      },
      registry,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect("token" in r.manifest.repos[0]).toBe(false);
  });

  it("keeps github_token and its GITHUB_TOKEN fallback", () => {
    const explicit = validate({ ...base, github_token: "ghp_a" }, registry, {});
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.manifest.github_token).toBe("ghp_a");

    const fallback = validate(base, registry, { GITHUB_TOKEN: "ghp_b" });
    expect(fallback.ok).toBe(true);
    if (fallback.ok) expect(fallback.manifest.github_token).toBe("ghp_b");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- validate`
Expected: FAIL — `credentials` is not validated and `manifest.credentials` does not exist.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/manifest/types.ts`, remove `token` from `RepoSpec` and add the new type:

```ts
export interface RepoSpec {
  url: string;
  ref: string;
  dest: string;
  primary: boolean;
}

/**
 * Where `throng-creds` fetches GitHub tokens from, and the identity it presents
 * when it does.
 *
 * `token` is task-scoped: useless outside the control plane, revocable per task,
 * and bound server-side to an installation, a repo set and a permission set. It
 * must stay valid for the task's entire lifetime including pauses — there is no
 * rotation path into a running sandbox.
 */
export interface CredentialsConfig {
  url: string;
  token: string;
}
```

Add `credentials` to `BaseManifest`:

```ts
export interface BaseManifest {
  repos: RepoSpec[];
  /** Pull mode. Null in standalone mode, where `github_token` is used instead. */
  credentials: CredentialsConfig | null;
  /** A literal token. Takes precedence over `credentials` when both are set. */
  github_token: string | null;
  user_identity: UserIdentity;
  setup_commands: string[];
}
```

In `packages/core/src/manifest/validate.ts`, add the import:

```ts
import { log } from "../log.js";
import type { BaseManifest, CredentialsConfig, FieldError, Manifest, RepoSpec, ValidateResult } from "./types.js";
```

Replace the `repos[].token` check inside `validateRepos` with:

```ts
    // Retired by the pull model: throng-creds scopes per repo through
    // credential.useHttpPath, so a static per-repo token is a second, weaker
    // mechanism for something the helper already does properly. Still ACCEPTED
    // so an unchanged control plane does not start receiving 400s.
    if ("token" in repo) {
      log.warn("repos[].token is ignored; credentials are fetched per operation", { repo: i });
    }
```

Add the validator beside `validateUserIdentity`:

```ts
/**
 * The optional `credentials` block. Omitted entirely in standalone mode, where a
 * literal `github_token` is used instead. Both fields are required when the
 * block is present — a half-configured helper would fail at the first clone
 * rather than at initialise, which is much harder to diagnose.
 */
function validateCredentials(value: unknown, errors: FieldError[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push({ field: "credentials", reason: "must be an object" });
    return;
  }
  for (const key of ["url", "token"] as const) {
    const reason = nonEmptyString(value[key]);
    if (reason) errors.push({ field: `credentials.${key}`, reason });
  }
}
```

Call it in `validate`, immediately after the `github_token` check:

```ts
  validateCredentials(input.credentials, errors);
```

Replace `buildManifest`:

```ts
function buildManifest(
  input: Record<string, unknown>,
  repos: Array<Record<string, unknown>>,
  platform: string,
  agent: unknown,
  env: Env,
): Manifest {
  const specs: RepoSpec[] = repos.map((r) => ({
    url: r.url as string,
    ref: r.ref as string,
    dest: r.dest as string,
    primary: r.primary as boolean,
  }));
  // A blank name/email is treated as absent, the same way a blank token is: git
  // rejects an empty ident, so passing one through would only fail later.
  const identity = isObject(input.user_identity) ? input.user_identity : {};
  const creds = isObject(input.credentials) ? input.credentials : null;
  const credentials: CredentialsConfig | null = creds
    ? { url: creds.url as string, token: creds.token as string }
    : null;
  const base: BaseManifest = {
    repos: specs,
    credentials,
    github_token: blankToNil(input.github_token) ?? blankToNil(env.GITHUB_TOKEN),
    user_identity: { name: blankToNil(identity.name), email: blankToNil(identity.email) },
    setup_commands: (input.setup_commands as string[] | undefined) ?? [],
  };
  return { ...base, platform, agent };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- validate`
Expected: PASS. Other suites will not compile yet — that is expected and fixed in Tasks 10 and 11.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/manifest/
git commit -m "feat(manifest): add the credentials block, retire repos[].token"
```

---

### Task 9: Writing the credential config file

**Files:**
- Create: `packages/core/src/creds/config.ts`
- Create: `packages/core/src/creds/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/creds/config.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeCredentialConfig } from "./config.js";
import type { BaseManifest } from "../manifest/types.js";

function manifest(over: Partial<BaseManifest> = {}): BaseManifest {
  return {
    repos: [],
    credentials: null,
    github_token: null,
    user_identity: { name: null, email: null },
    setup_commands: [],
    ...over,
  };
}

const target = () => join(mkdtempSync(join(tmpdir(), "throng-cfg-")), "run", "config.json");

describe("writeCredentialConfig", () => {
  it("writes the credentials block for pull mode", () => {
    const path = target();
    writeCredentialConfig(manifest({ credentials: { url: "https://cp", token: "tok" } }), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      credentials: { url: "https://cp", token: "tok" },
    });
  });

  it("writes a static token for standalone mode", () => {
    const path = target();
    writeCredentialConfig(manifest({ github_token: "ghp_static" }), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ github_token: "ghp_static" });
  });

  it("writes both when both are present, letting the helper apply precedence", () => {
    const path = target();
    writeCredentialConfig(
      manifest({ credentials: { url: "https://cp", token: "tok" }, github_token: "ghp_static" }),
      path,
    );

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      credentials: { url: "https://cp", token: "tok" },
      github_token: "ghp_static",
    });
  });

  // An empty object is still written: throng-creds treats "no config" and
  // "config with nothing usable" identically, and creating the file proves
  // the directory and permissions are right before the first clone needs them.
  it("writes an empty object when there is nothing to configure", () => {
    const path = target();
    writeCredentialConfig(manifest(), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
  });

  it("creates the directory and keeps the file private", () => {
    const path = target();
    writeCredentialConfig(manifest({ github_token: "ghp_static" }), path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("overwrites an existing file rather than appending", () => {
    const path = target();
    writeCredentialConfig(manifest({ github_token: "ghp_first" }), path);
    writeCredentialConfig(manifest({ github_token: "ghp_second" }), path);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ github_token: "ghp_second" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- creds/config`
Expected: FAIL — `./config.js` does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/creds/config.ts`:

```ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BaseManifest } from "../manifest/types.js";

/** Where throng-creds reads its configuration. The env var exists for tests. */
export const CONFIG_PATH = process.env.THRONG_CONFIG ?? "/run/throng/config.json";

/**
 * Writes the configuration `throng-creds` reads on a cache miss.
 *
 * A file rather than environment variables, because the agent runtime is
 * started during template build and captured in the snapshot: a process's
 * environment is fixed at execve(), long before any per-task value exists. A
 * freshly spawned throng-creds reads this at the moment of use, so there is no
 * inheritance chain to get wrong.
 *
 * JSON rather than shell-sourced assignments: this file holds a
 * control-plane-supplied token, and sourcing it would execute whatever it
 * contains.
 *
 * Called before cloning, because cloning now authenticates through the helper.
 */
export function writeCredentialConfig(manifest: BaseManifest, path = CONFIG_PATH): void {
  const config: Record<string, unknown> = {};
  if (manifest.credentials) config.credentials = manifest.credentials;
  if (manifest.github_token) config.github_token = manifest.github_token;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode applies only when it creates the file; an existing one
  // keeps whatever it had.
  chmodSync(path, 0o600);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- creds/config`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/creds/config.ts packages/core/src/creds/config.test.ts
git commit -m "feat(creds): write /run/throng/config.json from the manifest"
```

---

### Task 10: Boot reordering

**Files:**
- Modify: `packages/core/src/task-run.ts`
- Modify: `packages/core/src/task-run.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/core/src/task-run.test.ts`, change the `deps()` fixture:

```ts
function deps(over: Partial<BootDeps> = {}): BootDeps {
  return {
    clone: vi.fn(async () => ({ ok: true, output: "" })),
    checkout: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/workspace",
    ...over,
  };
}
```

Then append:

```ts
describe("TaskRun credential ordering", () => {
  // Cloning authenticates through throng-creds, which reads the config file.
  // If it is written after the clone, every private repo fails to clone.
  it("writes the credential config before cloning", async () => {
    const order: string[] = [];
    const d = deps({
      writeCredentialConfig: vi.fn(() => void order.push("config")),
      clone: vi.fn(async () => {
        order.push("clone");
        return { ok: true, output: "" };
      }),
      runSetupCommands: vi.fn(async () => {
        order.push("setup");
        return { ok: true };
      }),
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    expect(order).toEqual(["config", "clone", "setup"]);
  });

  it("fails on the credentials step when the config cannot be written", async () => {
    const d = deps({
      writeCredentialConfig: vi.fn(() => {
        throw new Error("EACCES: permission denied, mkdir '/run/throng'");
      }),
    });

    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    const status = tr.lifecycle.status();
    expect(status.state).toBe("failed");
    expect(status.error?.step).toBe("credentials");
    expect(status.error?.message).toContain("EACCES");
    expect(d.clone).not.toHaveBeenCalled();
  });

  it("clones without a token argument", async () => {
    const d = deps();
    const tr = new TaskRun(d, { claude: adapter() });
    await tr.initialise(okPayload);
    await settle();

    expect(d.clone).toHaveBeenCalledWith("https://x/y", "/workspace/y");
  });
});
```

Remove any existing assertion in this file that references `injectGitCredentials`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- task-run`
Expected: FAIL — `writeCredentialConfig` is not part of `BootDeps`, and ordering puts credentials last.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/task-run.ts`, update the imports and `BootDeps`:

```ts
import type { BaseManifest, FieldError, Manifest, UserIdentity } from "./manifest/types.js";

/** Engine-agnostic boot dependencies. */
export interface BootDeps {
  clone: (url: string, dest: string) => Promise<GitResult>;
  checkout: (dest: string, ref: string) => Promise<GitResult>;
  runSetupCommands: (cwd: string, commands: string[]) => Promise<SetupResult>;
  writeCredentialConfig: (manifest: BaseManifest) => void;
  injectGitIdentity: (identity: UserIdentity) => void;
  workspaceRoot: string;
}
```

Replace the body of `boot()` down to the end of the setup step:

```ts
  private async boot(manifest: Manifest, adapter: EngineAdapter<any, any>): Promise<void> {
    try {
      // First, and before anything touches the network: cloning authenticates
      // through throng-creds, which reads this file on every cache miss. There
      // is no per-invocation credential environment any more.
      log.info("boot step: writing credential config", {
        mode: manifest.github_token ? "static" : manifest.credentials ? "api" : "none",
      });
      try {
        this.deps.writeCredentialConfig(manifest);
      } catch (err) {
        throw new StepError("credentials", err instanceof Error ? err.message : String(err));
      }

      this.lifecycle.set("cloning");
      log.info("boot step: cloning repos", { count: manifest.repos.length, workspace: this.deps.workspaceRoot });
      let primaryDest = "";
      for (const repo of manifest.repos) {
        const dest = join(this.deps.workspaceRoot, repo.dest);
        log.info("cloning repo", { url: repo.url, ref: repo.ref, dest, primary: repo.primary });
        const cloned = await this.deps.clone(repo.url, dest);
        if (!cloned.ok) {
          throw new StepError("cloning", `git clone failed for ${repo.dest} (exit ${cloned.code}): ${cloned.output.trim()}`);
        }
        const checked = await this.deps.checkout(dest, repo.ref);
        if (!checked.ok) {
          throw new StepError("cloning", `git checkout ${repo.ref} failed for ${repo.dest}: ${checked.output.trim()}`);
        }
        log.info("repo ready", { dest, ref: repo.ref });
        if (repo.primary) primaryDest = dest;
      }

      this.lifecycle.set("setup");
      // Setup commands now run WITH working git and gh, because the config
      // above is already in place. See describeSetupFailure: their output is
      // redacted before it leaves this process.
      log.info("boot step: running setup commands", { count: manifest.setup_commands.length, cwd: primaryDest });
      const setup = await this.deps.runSetupCommands(primaryDest, manifest.setup_commands);
      if (!setup.ok) {
        throw new StepError("setup", describeSetupFailure(setup));
      }

      log.info("boot step: injecting engine credentials and commit identity");
      adapter.injectCredentials(manifest);
      // Commit identity only. GitHub auth is no longer environment-based.
      this.deps.injectGitIdentity(manifest.user_identity);
```

The rest of `boot()` — `buildAgentConfig`, `createA2AServer`, the `catch` — is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- task-run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/task-run.ts packages/core/src/task-run.test.ts
git commit -m "feat(boot): write credential config before cloning"
```

---

### Task 11: Delete the askpass path

**Files:**
- Modify: `packages/core/src/bootstrap/git.ts`
- Modify: `packages/core/src/bootstrap/git.test.ts`
- Delete: `packages/core/src/bootstrap/askpass.sh`
- Rename: `packages/core/src/bootstrap/git-credentials.ts` → `git-identity.ts`
- Rename: `packages/core/src/bootstrap/git-credentials.test.ts` → `git-identity.test.ts`
- Modify: `packages/core/src/control/server.ts`

- [ ] **Step 1: Write the failing test**

Replace `packages/core/src/bootstrap/git-credentials.test.ts` with a new file `packages/core/src/bootstrap/git-identity.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectGitIdentity } from "./git-identity.js";

const VARS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GH_TOKEN",
  "GIT_ASKPASS",
] as const;

describe("injectGitIdentity", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
  });

  afterEach(() => {
    for (const [v, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[v];
      else process.env[v] = value;
    }
  });

  // Without an identity git refuses to commit ("Author identity unknown"),
  // which an agent then papers over by inventing one.
  it("sets the commit identity for both author and committer", () => {
    injectGitIdentity({ name: "throng-bot", email: "bot@throng.dev" });

    expect(process.env.GIT_AUTHOR_NAME).toBe("throng-bot");
    expect(process.env.GIT_COMMITTER_NAME).toBe("throng-bot");
    expect(process.env.GIT_AUTHOR_EMAIL).toBe("bot@throng.dev");
    expect(process.env.GIT_COMMITTER_EMAIL).toBe("bot@throng.dev");
  });

  it("sets nothing when there is nothing to set", () => {
    injectGitIdentity({ name: null, email: null });

    for (const v of VARS) expect(process.env[v]).toBeUndefined();
  });

  // The whole point of the pull model: no GitHub credential ever reaches the
  // environment, because an environment cannot be refreshed.
  it("never puts a GitHub credential in the environment", () => {
    injectGitIdentity({ name: "throng-bot", email: "bot@throng.dev" });

    expect(process.env.GH_TOKEN).toBeUndefined();
    expect(process.env.GIT_ASKPASS).toBeUndefined();
  });
});
```

In `packages/core/src/bootstrap/git.test.ts`, change both `clone(...)` calls to drop the third argument:

```ts
    const c = await clone(`file://${src}`, dest);
```
```ts
    await clone(`file://${src}`, dest);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- bootstrap`
Expected: FAIL — `./git-identity.js` does not exist, and `clone` still takes three arguments.

- [ ] **Step 3: Write the implementation**

```bash
git mv packages/core/src/bootstrap/git-credentials.ts packages/core/src/bootstrap/git-identity.ts
git rm packages/core/src/bootstrap/git-credentials.test.ts
git rm packages/core/src/bootstrap/askpass.sh
```

Replace the whole contents of `packages/core/src/bootstrap/git-identity.ts`:

```ts
import type { UserIdentity } from "../manifest/types.js";

/**
 * Sets the identity commits are made under, via `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}`
 * — which git honours over `user.name`/`user.email` config. Env rather than
 * `git config --global` keeps this per-run and writes nothing into the sandbox's
 * home directory.
 *
 * Identity is a git concept, independent of which token pushes the work, so it
 * stays environment-based even though credentials no longer are: a name is not a
 * secret and never needs refreshing.
 */
export function injectGitIdentity(identity: UserIdentity): void {
  // Author and committer are set together: git needs both, and a run where they
  // disagree would be confusing to attribute.
  if (identity.name) {
    process.env.GIT_AUTHOR_NAME = identity.name;
    process.env.GIT_COMMITTER_NAME = identity.name;
  }

  if (identity.email) {
    process.env.GIT_AUTHOR_EMAIL = identity.email;
    process.env.GIT_COMMITTER_EMAIL = identity.email;
  }
}
```

Replace `packages/core/src/bootstrap/git.ts` in full:

```ts
import { execFile } from "node:child_process";

export type GitResult = { ok: true; output: string } | { ok: false; code: number; output: string };

function run(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: opts.cwd, env: opts.env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (err) {
        const code = typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : 1;
        resolve({ ok: false, code, output });
      } else {
        resolve({ ok: true, output });
      }
    });
  });
}

/**
 * `GIT_TERMINAL_PROMPT=0` turns a missing credential into an immediate error
 * instead of a hang on a TTY that is not there.
 */
const noPrompt = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: "0" });

/**
 * Full clone (no --depth) so any branch/tag/SHA can be checked out afterward.
 *
 * No token parameter: authentication is git's system credential helper
 * (`throng-creds`, configured in the image), which mints a token scoped to this
 * repo at the moment of the fetch.
 */
export function clone(url: string, dest: string): Promise<GitResult> {
  return run(["clone", url, dest], { env: noPrompt() });
}

export function checkout(dest: string, ref: string): Promise<GitResult> {
  return run(["checkout", ref], { cwd: dest, env: noPrompt() });
}

export function revParseHead(dest: string): Promise<GitResult> {
  return run(["rev-parse", "HEAD"], { cwd: dest });
}
```

In `packages/core/src/control/server.ts`, update the imports and `defaultBootDeps`:

```ts
import { injectGitIdentity } from "../bootstrap/git-identity.js";
import { writeCredentialConfig } from "../creds/config.js";
```

```ts
/** Generic boot deps assembled from the environment. */
export function defaultBootDeps(): BootDeps {
  return {
    clone,
    checkout,
    runSetupCommands,
    writeCredentialConfig: (manifest) => writeCredentialConfig(manifest),
    injectGitIdentity,
    workspaceRoot: process.env.WORKSPACE_DIR ?? "/workspace",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core && npm run typecheck --workspace @throng/agent-core`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add -A packages/core/src/
git commit -m "refactor: delete the askpass path, git-credentials becomes git-identity"
```

---

### Task 12: Redact tokens from setup output

**Files:**
- Modify: `packages/core/src/bootstrap/setup.ts`
- Modify: `packages/core/src/bootstrap/setup.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/bootstrap/setup.test.ts`:

```ts
import { redactTokens } from "./setup.js";

describe("token redaction", () => {
  it("redacts every GitHub token prefix", () => {
    const text = [
      "ghp_0123456789abcdefghij",
      "ghs_0123456789abcdefghij",
      "gho_0123456789abcdefghij",
      "ghu_0123456789abcdefghij",
      "ghr_0123456789abcdefghij",
    ].join(" ");

    const out = redactTokens(text);

    expect(out).not.toMatch(/gh[pousr]_/);
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(5);
  });

  it("leaves ordinary output alone", () => {
    const text = "npm ERR! missing script: buidl\nat github.com/acme/app";
    expect(redactTokens(text)).toBe(text);
  });

  // This text is stored verbatim in the control plane's instance.error_message.
  // Setup commands now run with live credentials, so a command echoing its
  // environment would otherwise persist a minted token.
  it("redacts inside a setup failure message", () => {
    const message = describeSetupFailure({
      ok: false,
      command: "env",
      code: 1,
      signal: null,
      output: "GH_TOKEN=ghs_0123456789abcdefghij\n",
    });

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("ghs_0123456789abcdefghij");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @throng/agent-core -- setup`
Expected: FAIL — `redactTokens` is not exported.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/bootstrap/setup.ts`, add below `OUTPUT_TAIL_CHARS`:

```ts
/**
 * GitHub's token prefixes: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-server),
 * ghs_ (installation), ghr_ (refresh).
 *
 * Setup commands used to run before any credential existed. Under the pull model
 * the credential config is written before cloning, so they run with working git
 * and gh — and their output is captured verbatim into the control plane's
 * `instance.error_message`. A command that echoes its environment, or runs
 * `git config --list`, would otherwise persist a live token.
 */
const TOKEN_PATTERN = /gh[pousr]_[A-Za-z0-9]{16,}/g;

export function redactTokens(text: string): string {
  return text.replace(TOKEN_PATTERN, "[REDACTED]");
}
```

In `describeSetupFailure`, redact the body:

```ts
  const body = redactTokens(tail(result.output));
```

In `runSetupCommands`, redact the logged output:

```ts
      log.error("setup command failed", { step, command, code, signal, durationMs, output: redactTokens(output) });
```

Update the doc comment on `describeSetupFailure`: replace the sentence *"Setup runs before any credential injection, so the output cannot contain the manifest's tokens."* with:

```
 * Setup commands run WITH live credentials under the pull model, so the output
 * is redacted before it leaves this process.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @throng/agent-core -- setup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bootstrap/setup.ts packages/core/src/bootstrap/setup.test.ts
git commit -m "feat(setup): redact GitHub tokens from captured command output"
```

---

### Task 13: Package exports and build

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/package.json`
- Modify: `throng-agent/src/integration/boot.test.ts`

- [ ] **Step 1: Write the failing test**

In `throng-agent/src/integration/boot.test.ts`, replace `fakeDeps()`:

```ts
function fakeDeps(): BootDeps {
  return {
    clone: vi.fn(async () => ({ ok: true, output: "" })),
    checkout: vi.fn(async () => ({ ok: true, output: "" })),
    runSetupCommands: vi.fn(async () => ({ ok: true })),
    writeCredentialConfig: vi.fn(() => {}),
    injectGitIdentity: vi.fn(() => {}),
    workspaceRoot: "/workspace",
  };
}
```

Append to the same file:

```ts
describe("throng-agent credential wiring", () => {
  it("exposes the credential config writer through the core package", async () => {
    const { writeCredentialConfig } = await import("@throng/agent-core");
    expect(typeof writeCredentialConfig).toBe("function");
  });

  it("no longer exposes the askpass path", async () => {
    const core = await import("@throng/agent-core");
    expect("ASKPASS" in core).toBe(false);
    expect("injectGitCredentials" in core).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && npm test --workspace throng-agent`
Expected: FAIL — `writeCredentialConfig` is not exported, and `ASKPASS` still is.

- [ ] **Step 3: Write the implementation**

Replace `packages/core/src/index.ts` lines for git/creds exports:

```ts
export { clone, checkout, type GitResult } from "./bootstrap/git.js";
export { runSetupCommands, describeSetupFailure, redactTokens, type SetupResult } from "./bootstrap/setup.js";
export { injectGitIdentity } from "./bootstrap/git-identity.js";
export { writeCredentialConfig, CONFIG_PATH } from "./creds/config.js";
```

Add `CredentialsConfig` to the type export block:

```ts
export type {
  RepoSpec,
  FieldError,
  BaseManifest,
  Manifest,
  ValidateResult,
  UserIdentity,
  CredentialsConfig,
} from "./manifest/types.js";
```

In `packages/core/package.json`, replace the `build` script:

```json
    "build": "tsc && mkdir -p dist/creds && cp src/creds/throng-creds.sh src/creds/gh-shim.sh dist/creds/ && chmod +x dist/creds/throng-creds.sh dist/creds/gh-shim.sh",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS across all workspaces.

- [ ] **Step 5: Verify the scripts reach dist**

Run: `ls -l packages/core/dist/creds/`
Expected: `throng-creds.sh` and `gh-shim.sh`, both mode `-rwxr-xr-x`.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/index.ts packages/core/package.json throng-agent/src/integration/boot.test.ts
git commit -m "build: ship the creds scripts in dist and update exports"
```

---

### Task 14: Dockerfile

**Files:**
- Modify: `throng-agent/Dockerfile`

- [ ] **Step 1: Add curl and jq**

In the runtime stage's first `apt-get install`, add `curl` and `jq`:

```dockerfile
 && apt-get install -y --no-install-recommends \
      ca-certificates git build-essential gpg wget curl jq \
```

- [ ] **Step 2: Install the real gh under its own name**

In the `gh` install block, change the `install` target and the version check:

```dockerfile
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh.real \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}" \
 && gh.real --version
```

Add to that block's existing comment:

```
# Installed as `gh.real`: /usr/local/bin/gh is a shim that fetches a fresh token
# per invocation, because GH_TOKEN cannot be refreshed once a process has
# started. Because this image owns both names, PATH ordering cannot resolve to
# the wrong one.
```

- [ ] **Step 3: Install the shims and configure git**

After the final `COPY --from=build` line and before `ENV CONTROL_PORT=8080`, add:

```dockerfile
# Credential plumbing. git and gh both fetch a short-lived token at the moment
# of use via throng-creds, which reads /run/throng/config.json — written by
# POST /api/initialise before any clone.
#
# The git config is baked in here rather than written at initialise because it
# is a constant. `useHttpPath` is required, not optional: without it git never
# sends `path=`, so no request can name a repo and everything collapses to the
# task's default scope. The helper is referenced by absolute path because git
# invokes helpers through /bin/sh, whose PATH may not include /usr/local/bin.
RUN install -m 0755 /app/packages/core/dist/creds/throng-creds.sh /usr/local/bin/throng-creds \
 && install -m 0755 /app/packages/core/dist/creds/gh-shim.sh /usr/local/bin/gh \
 && git config --system credential.helper '/usr/local/bin/throng-creds git' \
 && git config --system credential.useHttpPath true \
 && git config --system url."https://github.com/".insteadOf git@github.com: \
 && throng-creds git store </dev/null \
 && gh --version
```

The final two commands are build-time smoke checks: `throng-creds git store` proves the script parses and exits 0, and `gh --version` proves the shim resolves `gh.real` and declines cleanly with no config present.

- [ ] **Step 4: Verify the image builds and the wiring is right**

Run:
```bash
docker build -t throng-agent-creds-test \
  --secret id=github_token,env=GITHUB_TOKEN \
  -f throng-agent/Dockerfile .
```
Expected: build succeeds; the smoke-check layer prints a `gh version …` line.

Run:
```bash
docker run --rm throng-agent-creds-test bash -lc \
  'git config --system --get credential.helper; git config --system --get credential.useHttpPath; ls -l /usr/local/bin/gh /usr/local/bin/gh.real /usr/local/bin/throng-creds'
```
Expected:
```
/usr/local/bin/throng-creds git
true
```
followed by three executable entries.

Run:
```bash
docker run --rm throng-agent-creds-test bash -lc \
  'printf "protocol=https\nhost=github.com\npath=acme/app.git\n\n" | throng-creds git get; echo "exit=$?"'
```
Expected: no output before `exit=0` — an unconfigured sandbox declines, so public clones keep working.

- [ ] **Step 5: Commit**

```bash
git add throng-agent/Dockerfile
git commit -m "build(docker): install throng-creds, shim gh, configure git system-wide"
```

---

### Task 15: Documentation and spec corrections

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-04-agent-credential-pull-model-design.md`

- [ ] **Step 1: Update the README manifest example**

In `README.md`, replace the manifest example's `github_token` line and add `credentials`:

```jsonc
{
  "repos": [
    { "url": "https://github.com/acme/app", "ref": "main", "dest": "app", "primary": true }
  ],
  "setup_commands": ["npm install"],
  "credentials": {                    // pull mode: where to fetch GitHub tokens
    "url": "https://control-plane.example",
    "token": "…"                      // task-scoped identity
  },
  "github_token": "ghp_…",            // static; wins over `credentials`
  "user_identity": {
    "name": "Throng Bot",
    "email": "bot@throng.dev"
  },
  "agent": { "platform": "claude", "api_key": "sk-…" }
}
```

Also add `- Credentials: either a control-plane endpoint to fetch short-lived GitHub tokens from, or a static token` to the bullet list under "Initialisation", and remove the bullet reading "A GitHub token for the agent to checkout repos, raise PRs etc."

- [ ] **Step 2: Replace the `github_token` section**

Replace the whole `### \`github_token\` and \`user_identity\`` section with:

````markdown
### `credentials`, `github_token` and `user_identity`

- **`credentials`** is how the agent gets GitHub tokens in production. `git` uses
  a credential helper and `gh` is wrapped by a shim; both call `throng-creds`,
  which POSTs to `<url>/v1/credentials/github` with `token` as its bearer
  identity and gets back a short-lived, repo-scoped installation token. Nothing
  is cached beyond its expiry, and no GitHub credential is ever placed in the
  process environment — an environment is fixed at `execve()`, so a token put
  there at boot could never be refreshed, which is what broke long-running and
  paused tasks.
- **`github_token`** is a literal token, and **takes precedence over
  `credentials`** when both are present. It exists so the image can be run
  standalone, without the Throng platform. It is honoured inside `throng-creds`
  rather than by a separate code path, so a standalone run exercises the same
  wiring production uses.
- **`user_identity`** is optional, as are both of its fields. `name` and `email`
  become the commit identity, exported as `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}`
  for every command the agent runs. Without an identity from some source git
  refuses to commit at all ("Author identity unknown"), and an agent will
  improvise one. The field names mirror git's own `[user]` config section.

Credentials and identity are independent: a commit identity is a git concept,
unrelated to which token pushes the work, so a manifest may carry either, both,
or neither.

`repos[].token` is still accepted but ignored. `throng-creds` scopes every
request to the repo git is talking to, which a static per-repo token cannot.

### Running standalone

```bash
docker run -d -p 8080:8080 -p 3030:3030 --name throng-agent ghcr.io/col/throng-agent:latest

curl -X POST localhost:8080/api/initialise -H 'content-type: application/json' -d '{
  "repos": [{"url":"https://github.com/acme/app","ref":"main","dest":"app","primary":true}],
  "github_token": "ghp_…",
  "agent": {"platform":"claude","api_key":"sk-…"}
}'
```

Then confirm the credential wiring end to end:

```bash
docker exec throng-agent bash -lc 'cd /home/user/workspace/app && git fetch && gh auth status'
```
````

- [ ] **Step 3: Correct the two spec deviations**

In `docs/superpowers/specs/2026-08-04-agent-credential-pull-model-design.md`:

Replace the "Single-flight" section body with:

```markdown
Required despite the fast path: N parallel git operations at boot all miss
simultaneously, and GitHub rate-limits installation-token creation hard.

An atomic `mkdir` on a per-key lock directory, then **re-check the cache under
the lock** — the process that blocked will find the entry the winner just wrote,
and must not fetch again.

`mkdir` rather than `flock`: `flock` is util-linux and absent on macOS, where
this repo's tests run locally, and a lock that can only be exercised in CI is a
lock whose regressions are found late. The `mkdir` wait is bounded at 15s, after
which the caller proceeds *without* the lock — so there is no stale-lock case to
reason about, and the worst outcome is a duplicate API call rather than a git
operation stalled behind a dead owner.
```

In the "Fast path and slow path" section, replace *"it must therefore fork nothing — no `jq`, no `date -d`, no `sha256sum`"* with:

```markdown
it must therefore fork at most once. The one fork is `date +%s`; the fork-free
`printf '%(%s)T'` needs bash 4.2 and macOS ships bash 3.2, which the test suite
runs against. No `jq`, no `date -d`, no `sha256sum`, no expiry arithmetic.
```

Add to the end of the "One language" section:

```markdown
The script is written to bash 3.2, not bash 5. The image runs 5.2, but vitest
spawns `bash` from PATH and macOS ships 3.2 — so no `mapfile`, no
`exec {fd}>`, no `printf '%(%s)T'`, no associative arrays. This is what keeps
the whole suite runnable on a development machine.
```

- [ ] **Step 4: Verify everything still passes**

Run: `npm run build && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-04-agent-credential-pull-model-design.md
git commit -m "docs: document the credentials block and correct spec deviations"
```

---

## Manual verification

Not automatable here; run before merging.

- [ ] **Standalone escape hatch.** Follow the "Running standalone" recipe in the README against a real private repo and a real PAT. `git fetch` succeeds, `gh auth status` reports authenticated, `gh pr create` opens a PR.
- [ ] **Template smoke.** In `throng_e2b_templates`, build the dev template on the new image version and run `throng-agent/smoke.ts`. Then confirm in a live sandbox that `/run` is tmpfs, that `id -u` is the same for the runtime and for a shell the agent spawns, and that `/run/throng/config.json` survives a pause and resume. If the uids differ, switch `/run/throng` to `0711` with the file at `0644` per the spec.
- [ ] **Cache behaviour under a real token.** In a live sandbox, run `git fetch` twice and confirm `/run/throng/cache` gains exactly one entry with a `serve_until` about 55 minutes ahead.
