# Setup and Unset

## Install

Install the two public packages, enter a Git project, and run setup:

```bash
npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest
hy-workflow setup
```

For mainland routing:

```bash
npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest --registry=https://registry.npmmirror.com
hy-workflow setup
```

Setup configures the selected MCP clients in the current user's configuration. The clients run the installed binaries directly:

- `hy-workflow`: command `hy-workflow`, no arguments
- `docs-gardener`: command `docs-gardener`, arguments `["mcp"]`

Do not put `npx`, GitHub URLs, or SSH URLs in MCP startup configuration. Package installation is an explicit npm operation, not part of MCP startup.

## What a fresh setup writes

A fresh setup has one small repository contract:

- `hy-workflow.json` contains project-owned paths, branches, policy choices, overrides, and exceptions.
- `.github/workflows/hy-workflow.yml` is a thin pull-request check that invokes one exact published hy-workflow package version.

Setup does not create or update `AGENTS.md`. It also does not create `.hy/`, `.opencode/`, `.codex/`, `.mcp.json`, `codelint.json`, `doclint.json`, or `docs-gardener.json` in the project.

Review the two new files and commit them through a focused repository change. If either path already contains different content during a genuinely fresh install, setup shows the exact change and requires exact review before replacing it. This review protects an existing project file; it is not an upgrade gate for previously installed projects.

Deployment identity, workflow state, approvals, scope locks, DocsGraph cache, and MCP client ownership stay under the operating-system user roots:

| Data | Linux default | macOS default | Windows default |
| --- | --- | --- | --- |
| config/registry | `$XDG_CONFIG_HOME/hy-workflow` | `~/Library/Application Support/hy-workflow` | `%APPDATA%\hy-workflow` |
| state/deployment | `$XDG_STATE_HOME/hy-workflow` | Application Support state subdir | `%LOCALAPPDATA%\hy-workflow\state` |
| cache/DocsGraph | `$XDG_CACHE_HOME/hy-workflow` | `~/Library/Caches/hy-workflow` | `%LOCALAPPDATA%\hy-workflow\cache` |

When XDG variables are absent, Linux uses `~/.config`, `~/.local/state`, and `~/.cache`. Tests and managed environments may override the roots with `HY_WORKFLOW_CONFIG_HOME`, `HY_WORKFLOW_STATE_HOME`, and `HY_WORKFLOW_CACHE_HOME`.

## Seamless upgrades for existing projects

Updating the npm package must not turn an old installation into a repository migration. After an upgrade, hy-workflow runtime and setup do not read, hash, validate, rewrite, move, or delete old injected project files. In particular, they do not use an existing root `hy-workflow.json`, generated workflow, managed `AGENTS.md` block, `.hy/`, project-level MCP client files, or the three old lint JSON files as an upgrade gate. Those files remain byte-for-byte untouched and non-authoritative to hy-workflow. Existing external workflow state, locked scope, approval, and Git worktree are preserved.

This is what “inert” means inside hy-workflow. MCP cannot stop Codex, Claude Code, OpenCode, other agents, or GitHub Actions from independently loading or executing tracked old files. An old tracked workflow can continue under its own triggers until a separate repository change removes or disables it. Cleanup is an optional separate PR and is never required to use the upgraded MCP.

Old deployment manifests remain compatible. Installing the new package and restarting the MCP client is sufficient; do not rerun setup merely to migrate old repository files.

## Configuration authority

The runtime chooses exactly one configuration authority in this order:

1. A complete pre-existing external project configuration remains authoritative. This preserves an installed project's behavior without consulting old repository injections.
2. A fresh setup writes a small external authority marker. That exact marker authorizes the new root `hy-workflow.json`.
3. The generated GitHub workflow supplies the exact `HY_WORKFLOW_RUNTIME_CONFIG_SOURCE=hy-workflow.runtime-config-source.v1` signal, which authorizes the root config on a clean runner.
4. Without external authority or the exact CI signal, runtime detects only basic project facts and uses the frozen legacy-compatible defaults. It does not open an old root config to guess whether it should be trusted.

Near matches, stale mode fields, filenames, or the mere presence of a root file never grant authority. This makes the selected source deterministic and prevents an old injection from becoming active by accident.

Project policy stays data, not generated instructions. Teams choose `relaxed`, `standard`, or `strict`, then place project rules, path-specific overrides, and time-bounded exceptions in `hy-workflow.json`. Safety rules for scan integrity, project identity, evidence freshness, and scope/path boundaries cannot be disabled by a project profile.

To see the final value for one rule and the ordered sources that produced it, run:

```bash
hy-workflow config --explain-policy code.max-lines --file src/parser.ts --json
```

The result reports the selected configuration authority, effective severity and thresholds, then the applied sources in order, such as profile, legacy-compatible threshold, project rule, matching file override, and a non-expired exception. This is the supported way to answer “why did this file get this rule?” without inspecting generated code.

## CI boundary

The generated workflow is deliberately thin. It runs only for pull requests and explicit manual dispatch, checks out with persisted credentials disabled, grants only `contents: read`, and invokes:

```text
npx --yes --package=@voxstudio/hy-workflow@<exact-version> hy-workflow lint --json
```

It does not infer a JavaScript, Python, Go, Rust, or mixed-project pipeline. It does not rerun the repository's native build and test commands. Keep those commands in the project's own CI jobs; hy-workflow contributes only its centralized policy/lint check. Mark the resulting `Verify` check required in GitHub rulesets or branch protection if the repository needs enforcement. Setup does not change repository administration settings.

Because the workflow installs an exact npm package on the runner, npm network availability is part of this check. Exact version pinning prevents a later package release from silently changing an already committed workflow.

## Automation

```bash
hy-workflow setup --yes --clients codex,claude,opencode --json
hy-workflow setup --yes --clients codex --dry-run --json
hy-workflow setup --yes --clients codex --accept-artifact-changes --review-artifact 'hy-workflow.json:<before>:<after>' --json
hy-workflow setup --yes --clients codex --force-client-overwrite codex --json
hy-workflow unset --yes --clients all --remove-global --json
```

Non-interactive setup requires `--yes` and explicit `--clients`. `--dry-run` emits one JSON envelope and makes no change. Exact `--review-artifact` hashes apply only when a fresh installation must replace an existing target path; stale hashes fail closed.

`--force-client-overwrite` applies only to the hy-workflow-owned user-level MCP definition. The deprecated `--migrate-legacy-clients` flag remains accepted for command compatibility but does not scan, back up, move, or delete project files.

## Reversible unset

```bash
hy-workflow unset
```

Unset removes only the current local deployment, registry/state/cache entries, and client definitions owned by hy-workflow when explicitly requested. It does not remove repository files, including either of the two new setup files or any old injection. Repository cleanup is always an ordinary reviewed repository change.

## Runtime prerequisites

- Node.js 18 or newer and npm
- `git` on PATH for project identity and repository operations
- authenticated `gh` for PR creation, CI status, and merge operations

`hy_status` reports the current stage, allowed next action, and Git/GitHub capability state. Missing mutation capabilities fail closed with recovery guidance; there is no hidden GitHub mutation backend.

The npm package contains compiled `dist/`, docs, schema files, the thin workflow template, and README. It contains no Bash or PowerShell installer, and installation does not compile locally.
