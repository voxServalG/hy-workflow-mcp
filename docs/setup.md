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

Setup creates or updates repository files in two categories:

Team-owned configuration and CI:
- `hy-workflow.json`
- `.github/workflows/hy-workflow.yml`

Agent instruction injection in `AGENTS.md`. Setup owns only the `<!-- hy-workflow-rules --> ... <!-- /hy-workflow-rules -->` block. When `AGENTS.md` does not exist, setup creates it with the current managed block. When the file exists but the block is missing, stale, or malformed (missing version marker, removed setup flags, old mode text), setup replaces just that block in place while preserving every byte outside the two markers. Custom agent instructions written before or after the managed block are never overwritten. Setup refuses to silently overwrite a hand-edited `hy-workflow.json` or workflow template; those changes still go through the artifact drift review path described below.

Review and commit `hy-workflow.json`, `.github/workflows/hy-workflow.yml`, and any auto-migrated `AGENTS.md` managed block in a dedicated setup artifact sync PR. All other setup state (deployment, registry, workflow state, scope locks, DocsGraph cache, client MCP configuration) remains outside the repository. External data is keyed by a stable project identity derived from canonical project root, Git common dir, and origin remote:

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

Setup accepts an existing `docs`/`documentation`/`doc` directory, or `.` only when the repository root has a case-insensitive README/index document. It fails closed if that system is empty, contains no substantive project facts, or is dominated by excluded dependency/example/fixture/generated trees. A managed AGENTS block that lacks the current `hy-workflow-rules-version` is migrated automatically during setup rather than blocking the run. Create/repair the maintained docs or select another project-relative directory, then rerun:

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
hy-workflow setup --yes --clients codex --ci-command 'npm test' --accept-artifact-changes --json
hy-workflow setup --yes --clients codex --force-client-overwrite codex --json
hy-workflow setup --yes --clients codex --migrate-legacy-clients --json
hy-workflow unset --yes --clients all --remove-global --json
```

Non-interactive use requires `--yes`, explicit `--clients`, and either existing valid `ci.commands` or explicit repeatable `--ci-command`. A bare `--accept-ci-commands` is rejected because it does not identify what was reviewed. `--dry-run` reports project evidence, CI candidates, artifact diff/hash/change-kind and confirmation requirements without writing; JSON emits one envelope. After `--dry-run --json` the exact artifact hashes are cached on the OS user state for 5 minutes, so an immediate `--accept-artifact-changes` (without `--review-artifact`) will reuse them automatically. To apply drift non-interactively on `hy-workflow.json` or `.github/workflows/hy-workflow.yml`, pass `--accept-artifact-changes` plus one exact `--review-artifact <file>:<before-sha256|absent>:<after-sha256>` for every accepted diff; stale or self-generated approval hashes fail closed.

`--force-client-overwrite <client1,client2>` re-installs the hy-workflow-owned user-scope MCP definition for those clients even when the existing entry is unreadable, shadowed, or drifted from the owned definition. It does not touch project-scope (tracked) files; combine with `--migrate-legacy-clients` if legacy project-level MCP files (.mcp.json, .opencode/, .codex/, .claude/) are blocking setup.

`--migrate-legacy-clients` scans the project root for legacy client MCP definitions referencing hy-workflow or docs-gardener, backs them up to `.hy-cleanup-backup/<timestamp>/`, ensures user-scope definitions exist, then moves the project-level files out of the way. Project files are moved (not deleted) so they can be reviewed and `git rm`'d later.

Setup auto-migrates the managed `AGENTS.md` block without an acceptance flag: existing hand-written content outside the markers is preserved byte-for-byte, and malformed legacy blocks are rewritten to the canonical versioned block.

## CI enforcement

The generated Verify job runs on pull requests and explicit `workflow_dispatch`, not on generic pushes. It executes confirmed `ci.commands` as the complete native sequence, then decodes the package's deterministic first-party lint bundle into runner-temporary storage and runs built-in doclint/codelint offline. Missing/empty commands, unknown unsafe inference, zero documentation files, invalid configuration, parser/report failure, or lint errors fail closed. Existing legacy compatibility JSON remains byte-identical because the workflow never creates, rewrites, or restores it. `hy_ci` requires the stable Verify check and every effective check to succeed. An administrator must separately mark Verify required; setup does not mutate repository rules.

## Runtime prerequisites

- Node.js 18 or newer and npm
- `git` on PATH for project identity and repository operations
- authenticated `gh` for PR creation, CI status, and merge operations

`hy_status` reports Git/GitHub capability state. Missing mutation capabilities fail closed with recovery guidance; there is no hidden GitHub mutation backend.

Merge recovery 的 **read-only Git fallback** 不是隐藏的 GitHub mutation 替代品。它只对 `origin/<base>` 执行 fresh fetch，将远端 tip 固定为 immutable `baseOid`，并检查 verified head 是否为其祖先；绝不直接 merge 或 push base。创建 PR 和首次执行 merge mutation 仍要求已认证的 `gh`。如果 legacy workflow 没有 merge receipt，但 Git 证据已经证明 verified head 被包含，`hy_merge` 会同步由 agent prefix、verified ancestry 与 local=remote 共同证明的 stacked branches；unrelated branch 忽略，真实 stack 的 ref 漂移 fail closed。

正常 pre-mutation snapshot 还要求候选建立在 fresh prepared base 上。确认合入后以 `syncBaseOid` 固定同步基准，`detached staging` 的 `rebasing`/`resultOid` 进度先落盘，再通过 local ref `compare-and-swap` 与 exact `force-with-lease` 安装。project-specific merge lock 只串行化共享同一本地状态根和工作树的进程；它不提供跨主机强一致。receipt 和 lock 的恢复协议面向已完成状态写入后的普通工具或进程中断，文档不承诺机器断电或缺少 `fsync` 时的存储持久性。

## Version migration

Every `hy_*` dispatch checks schema-3 deployment version, direct binaries/versions, MCP catalog hashes and all three team artifact SHA/size (`hy-workflow.json`, `.github/workflows/hy-workflow.yml`, and the managed `AGENTS.md` block). `hy_init` additionally requires the root config/workflow, resolvable base ref, substantive docs and current managed rules. Missing, unreadable, outdated, tool-mismatch or artifact-drift evidence returns a structured setup/artifact-sync stop; legacy state is never deleted or treated as a second mode.

The npm package contains compiled `dist/`, docs, the shared workflow template, the `templates/lint/*.mjs` engine modules, and README. It contains no Bash/PowerShell installer. Installation does not compile locally.
