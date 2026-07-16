# Setup and Unset

## User flow

Install or update the two public npm packages, enter a Git project, and run the same command on Windows, macOS, or Linux:

```bash
npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest
hy-workflow setup
```

For mainland routing:

```bash
npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest --registry=https://registry.npmmirror.com
hy-workflow setup
```

The Node TUI shows its intro/spinner before a bounded inspection of Codex, Claude Code, OpenCode, project profile, docs readiness and artifact drift. It offers install/update or unset with no deployment mode choice. Setup shows detected native CI commands and requires confirmation (or one explicit command when inference is unsafe). Restart selected clients after setup, then call `hy_init`.

## Single deployment model

Setup always creates or updates exactly two team-owned repository files:

- `hy-workflow.json`
- `.github/workflows/hy-workflow.yml`

Review and commit those files in a dedicated setup artifact sync PR. No other setup output belongs in the repository. Deployment, registry, workflow state, scope locks, DocsGraph cache, and client MCP configuration remain outside the repository. External data is keyed by a stable project identity derived from canonical project root, Git common dir, and origin remote:

| Data | Linux default | macOS default | Windows default |
| --- | --- | --- | --- |
| config/registry | `$XDG_CONFIG_HOME/hy-workflow` | `~/Library/Application Support/hy-workflow` | `%APPDATA%\hy-workflow` |
| state/deployment | `$XDG_STATE_HOME/hy-workflow` | Application Support state subdir | `%LOCALAPPDATA%\hy-workflow\state` |
| cache/DocsGraph | `$XDG_CACHE_HOME/hy-workflow` | `~/Library/Caches/hy-workflow` | `%LOCALAPPDATA%\hy-workflow\cache` |

When XDG variables are absent, Linux uses `~/.config`, `~/.local/state`, and `~/.cache`. Tests and managed environments may override the roots with `HY_WORKFLOW_CONFIG_HOME`, `HY_WORKFLOW_STATE_HOME`, and `HY_WORKFLOW_CACHE_HOME`.

MCP clients run installed bins directly:

- `hy-workflow`: command `hy-workflow`, no arguments
- `docs-gardener`: command `docs-gardener`, arguments `["mcp"]`

Do not put `npx`, GitHub URLs, or SSH URLs in client startup configuration. Package download/update is an explicit npm HTTPS operation, never part of MCP startup.

The packaged template and root `hy-workflow.json` are canonical. Profile inference uses Git-tracked files and manifests for JS/TS/Python/Go/Rust, preserves multiple source extensions and real directory casing, then resolves base branch from origin HEAD/current/main/master/trunk/dev/develop. Material mixed, unknown, non-conventional-branch or otherwise low-confidence Git evidence stops for explicit confirmation. Optional `ci.commands` is an ordered, non-empty, confirmed native CI sequence; preserve-first migration never overwrites it or other manual values.

MCP runtime accepts only the root `hy-workflow.json`; legacy user config may be read only by setup/config CLI as a migration input.

Setup accepts an existing `docs`/`documentation`/`doc` directory, or `.` only when the repository root has a case-insensitive README/index document. It fails closed if that system is empty, contains no substantive project facts, is dominated by excluded dependency/example/fixture/generated trees, or has a managed AGENTS block without `hy-workflow-rules-version: 2026.07.16.1`. Create/repair the maintained docs or select another project-relative directory, then rerun:

```bash
hy-workflow config --apply --json --docs-dir '<existing-project-relative-dir>'
hy-workflow setup
```

`--apply` only changes the explicitly supplied fields and preserves the rest of an existing root or migrated legacy configuration. Use `--apply-suggested` only when the detected defaults should replace the configurable project and lint fields.

## Reversible unset

```bash
hy-workflow unset
```

Unset uses the same TUI and removes only the current project's deployment, workflow state/cache, and registry entry. Global MCP entries and their ownership manifest remain while other registered projects exist. On the final project, the ownership manifest is updated or cleared only when the user explicitly requests removal of the owned global MCP entries; ownership snapshots ensure unrelated or subsequently edited client configuration is not deleted. Legacy user config remains untouched.

Repository files are never silently removed by unset because they are team-owned and may be committed. Remove them through an ordinary reviewed repository change if the team wants to retire hy-workflow.

## Automation

```bash
hy-workflow setup --yes --clients codex,claude,opencode --json
hy-workflow setup --yes --clients codex --ci-command 'npm ci' --ci-command 'npm test' --json
hy-workflow setup --yes --clients codex --dry-run --json
hy-workflow setup --yes --clients codex --ci-command 'npm test' --accept-artifact-changes --review-artifact 'hy-workflow.json:<before>:<after>' --json
hy-workflow unset --yes --clients all --remove-global --json
```

Non-interactive use requires `--yes`, explicit `--clients`, and either existing valid `ci.commands` or explicit repeatable `--ci-command`. A bare `--accept-ci-commands` is rejected because it does not identify what was reviewed. `--dry-run` reports project evidence, CI candidates, artifact diff/hash/change-kind and confirmation requirements without writing; JSON emits one envelope. To apply drift non-interactively, pass `--accept-artifact-changes` plus one exact `--review-artifact <file>:<before-sha256|absent>:<after-sha256>` for every accepted diff. Stale or self-generated approval hashes fail closed.

Legacy projects with a stale managed `AGENTS.md` block remain human-owned: setup never edits that file. `hy-workflow config --print-managed-rules` prints the versioned canonical block bundled in the installed npm package. Replace only the marked block, review/commit that project change separately, then rerun setup.

## CI enforcement

The generated Verify job executes confirmed `ci.commands` as the complete native sequence, then mandatory pinned doclint/codelint with timeouts. Missing/empty commands, unknown unsafe inference, zero scanned files, materialization/lint failure or cleanup failure all fail closed; compatibility JSON is temporary and restored. Local runtime commands additionally persist an external recovery journal before materialization, recover after process death on the next MCP invocation, and refuse symlink escapes or concurrent edits. `hy_ci` requires the stable Verify check and every effective check to succeed. An administrator must separately mark Verify required; setup does not mutate repository rules.

## Runtime prerequisites

- Node.js 18 or newer and npm
- `git` on PATH for project identity and repository operations
- authenticated `gh` for PR creation, CI status, and merge operations

`hy_status` reports Git/GitHub capability state. Missing capabilities fail closed with recovery guidance; there is no hidden Git or GitHub fallback.

## Version migration

Every `hy_*` dispatch checks schema-3 deployment version, direct binaries/versions, MCP catalog hashes and both team artifact SHA/size. `hy_init` additionally requires the root config/workflow, resolvable base ref, substantive docs and current managed rules. Missing, unreadable, outdated, tool-mismatch or artifact-drift evidence returns a structured setup/artifact-sync stop; legacy state is never deleted or treated as a second mode.

The npm package contains compiled `dist/`, docs, the shared workflow template, and README. It contains no Bash/PowerShell installer. Installation does not compile locally.
