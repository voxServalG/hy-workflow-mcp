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

The Node TUI detects Codex, Claude Code, and OpenCode, shows the installed clients as a multiselect, and offers install/update or unset. There is no deployment mode choice. Restart selected clients after setup, then call `hy_init`.

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

The workflow is copied from the template packaged in the npm tarball. Root `hy-workflow.json` is the canonical project configuration. MCP runtime accepts only the root `hy-workflow.json`; legacy user config may be read only by setup/config CLI as a migration input. Runtime fields `project.baseBranch`, `project.codeExt`, `project.codeDirs`, `project.docsDir`, and `codelint.lintDirs` must be explicitly present. Legacy deployment manifests with a `mode` field are also read-only migration inputs. These migration paths may preserve existing values, but do not restore a mode choice, rewrite legacy inputs as the project source, or delete them automatically.

Setup fails closed when it cannot find an existing `docs`, `documentation`, or `doc` directory. It does not silently use the repository root or create a third project artifact. First create the intended documentation directory or select another existing project-relative directory, then confirm it explicitly and rerun setup:

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
hy-workflow setup --yes --clients codex --dry-run --json
hy-workflow unset --yes --clients all --remove-global --json
```

Non-interactive use requires both `--yes` and explicit `--clients`. `--dry-run` reports the candidate changes without writing. JSON mode emits one machine-readable result.

## CI enforcement

The generated workflow must run doclint and codelint on every relevant pull request and push. Before running those CLIs, the lint step snapshots existing `doclint.json`, `codelint.json`, and `docs-gardener.json`, materializes temporary configs from `hy-workflow.json`, and registers an EXIT trap that attempts to restore the snapshots or remove generated files when the step ends. Lint or materialization failures fail the step. These compatibility files must not be committed. `hy_ci` fails closed when GitHub reports no checks or only skipped/neutral checks. A repository administrator must separately make the workflow's Verify check required in a GitHub ruleset or branch protection rule; setup reports this responsibility but does not change repository administration settings.

## Runtime prerequisites

- Node.js 18 or newer and npm
- `git` on PATH for project identity and repository operations
- authenticated `gh` for PR creation, CI status, and merge operations

`hy_status` reports Git/GitHub capability state. Missing capabilities fail closed with recovery guidance; there is no hidden Git or GitHub fallback.

## Version migration

Every `hy_*` dispatch checks the external deployment version. Missing, unreadable, or outdated deployments return a structured refresh envelope with the npm update command and `hy-workflow setup`. Only that external deployment can satisfy the gate: `.git/hy-workflow/setup.json` or `.hy/hy-workflow-setup.json` remains legacy input even when its version equals the current setup version. Legacy user config, deployment manifests, `.git/hy-workflow` state, and setup stamps are never automatically deleted or treated as a second active mode.

The npm package contains compiled `dist/`, docs, the shared workflow template, and README. It contains no Bash/PowerShell installer. Installation does not compile locally.
