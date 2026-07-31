# Helper Installation, Update, and Migration

Public setup is the helper. `hy-workflow setup` is a compatibility alias for `hy-workflow helper install`; it is not the former project-artifact TUI and it never installs an MCP server.

## Fresh installation

From a real Git worktree:

```bash
npm install -g @voxstudio/hy-workflow@latest
hy-workflow helper install --json
```

When Agent detection is empty or ambiguous, specify the exact target set:

```bash
hy-workflow helper install --clients codex,claude,opencode --mode auto --json
```

The helper performs three ordered layers:

1. install the complete versioned Skill bundle into user storage and selected global Agent Skill directories;
2. register the current Git project in external config/state;
3. retire any exactly owned legacy `hy-workflow` MCP registration for those selected clients.

It returns one `hy-workflow.helper.v1` envelope with per-layer status. A successful fresh install has `projectFilesChanged: []` and leaves the worktree and Git metadata byte-identical.

Restart the Agent after installation so it discovers the Skills. The first workflow call is `hy-workflow init`, normally made by `hy-init`.

## What is not installed

Fresh helper installation does not create or edit:

- `hy-workflow.json`;
- `.github/workflows/hy-workflow.yml` or any other GitHub Actions file;
- `AGENTS.md`, `CLAUDE.md` or another Agent instruction file;
- `.mcp.json`, `.codex/`, `.opencode/` or project-local Agent configuration;
- `.hy/`, codelint/doclint compatibility JSON or `.git` contents.

There is therefore no setup artifact PR. Teams may independently document project invariants or add `hy-workflow lint --json` to their existing CI through an ordinary reviewed change.

## Target selection

Supported targets are `codex`, `claude` and `opencode`. Detection uses explicit Agent environment variables, existing user configuration directories and executables on PATH. Detection only informs first install; it never expands an existing target set.

`--mode auto` prefers a canonical single source of truth with symlink projections and can fall back to staged copies. `symlink` requires symlink projections; `copy` writes independently verified copies. The helper records the exact target directories and mode in its ownership manifest.

Target set and mode are immutable for one installation lifecycle. To change them:

```bash
hy-workflow helper remove --json
hy-workflow helper install --clients codex,opencode --mode copy --json
```

## Upgrading an existing CLI+Skill install

After updating the npm package, run:

```bash
hy-workflow helper update --json
```

Update verifies the new 12-Skill bundle, the existing manifest, canonical files and projections before mutation. It uses staged replacement and rollback, then atomically records the new bundle version and hashes. It preserves the exact target set and projection preference.

If a user deliberately deleted an owned projection, ordinary update preserves that deletion. Restore it explicitly with:

```bash
hy-workflow helper update --repair --json
```

Unmanaged same-name content, unexpected hashes, unsafe paths and ownership ambiguity stop the update. The helper does not overwrite them merely because their directory name matches a bundled Skill.
Every mutating helper command holds one user-level operation lock across Skill projection, project registration and legacy MCP retirement. Each Skill mutation is additionally bound to fingerprints captured during ownership preflight; a destination created or changed before swap/remove is preserved and returns an ownership conflict. New destinations use exclusive no-replace publication, so a racing user resource is never treated as helper-owned content.


## Seamless migration from the MCP release

For a project already using the earlier MCP packaging, run `helper install` after updating the npm package. The migration contract is:

- install Skills first, so the Agent has the replacement interface before MCP retirement;
- on an unmoved checkout, require an exact deployment/registry pair, including identity, mode, clients and timestamp, and preserve deployment, registry, external config, workflow state and scope byte for byte;
- on a genuinely moved checkout, keep status read-only and use the reported `helper install --json` recovery to reconcile only deployment and registry identity fields in one transaction, preserving config, workflow, scope, cache, DocsGraph and client ownership;
- keep the current phase, PlanDoc, approval, verification and working tree unchanged;
- immediately revalidate the exact installed Skill manifest, then retire only a legacy `hy-workflow` MCP entry whose ownership record and current effective bytes prove that it belongs to this package;
- preserve `docs-gardener`, unrelated MCP servers, project-level overrides and unowned same-name entries;
- never read, change or delete historical project injections as a migration precondition.

Equivalent GitHub remote spellings resolve to one canonical identity and do not rewrite same-checkout deployment or registry bytes. A deployment without its exact registry record, a registry record without its deployment, or drift in mode, clients or timestamp fails closed before Skill or MCP mutation. A genuine move is eligible only when the old checkout is absent or resolves to the same physical Git common directory, the canonical remote is equivalent, and the legacy deployment/registry pair is exact and unique. Multiple active candidates return `PROJECT_IDENTITY_CONFLICT`; the helper will not copy or merge their state automatically.

Tracked legacy files are outside helper ownership. An old Actions workflow may continue to run because GitHub reads the repository independently. Removing or disabling it requires a separate cleanup PR and is not required before the new CLI+Skill workflow can run.

## Partial migration and recovery

Helper output reports `skills`, `project` and `mcp` independently. If an earlier layer completes and a later layer fails, top-level status is `partial`, exit code is one, and `recovery` contains:

- the helper command to retry;
- an exact argv array;
- completed layer names;
- a stable reason code.

Retry that exact operation after addressing the structured error. Completed idempotent layers return unchanged or preserved. Do not manually edit the ownership manifest or private project registry to force success.

Use status at any time:

```bash
hy-workflow helper status --json
```

Status reports Skill health and hashes, project registration, and whether an owned legacy MCP entry remains pending retirement. `attention` is not success and includes a recovery route.

## Removal

```bash
hy-workflow helper remove --json
# compatibility alias
hy-workflow unset --json
```

Removal deletes only canonical Skill resources and projections still proven by the helper ownership manifest. It preserves:

- external project config, deployment, registry, workflow state and scope;
- every project file and Git metadata;
- the current MCP configuration;
- `docs-gardener` and unrelated tools.

It does not restore the retired MCP entry. Removing Skills is therefore not a rollback to the previous transport. Reinstall the current Skills to resume Agent-guided use while retaining the preserved project state.

## CI policy

Helper never injects a workflow. A team that wants CI enforcement adds the installed CLI to its existing workflow and invokes `hy-workflow lint --json` after its own toolchain setup. Branch protection and required-check configuration remain repository-administrator responsibilities. The local workflow kernel can observe checks during `commit.ci`, but installation does not manufacture them.
