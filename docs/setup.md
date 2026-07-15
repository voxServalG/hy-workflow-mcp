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

The Node TUI detects Codex, Claude Code, and OpenCode, shows the installed clients as a multiselect, and offers install/update or unset. Restart selected clients after setup, then call `hy_init`.

## Default: local mode

Local mode is the default and guarantees that setup, unset, and hy_init do not modify the project worktree or `.git`. Data is keyed by a stable project identity derived from canonical project root, Git common dir, and origin remote:

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

## Shared mode

Choose shared mode in the TUI or pass `--shared` only when the team intentionally wants repository artifacts. It may write exactly:

- `hy-workflow.json`
- `.github/workflows/hy-workflow.yml`

The workflow is copied from the template packaged in the npm tarball. Review and commit these files in a dedicated setup artifact PR. Default local mode never writes them.

## Reversible unset

```bash
hy-workflow unset
```

Unset uses the same TUI and removes only the current project's owned config/state/cache and registry record. Global MCP entries are retained while other registered projects exist. On the final project, the user may explicitly request global removal; ownership snapshots ensure unrelated or subsequently edited client configuration is not deleted.

Shared repository files are never silently removed by unset because they may be team-owned and committed. Remove them through an ordinary reviewed repository change if the team wants to retire shared mode.

## Automation

```bash
hy-workflow setup --yes --clients codex,claude,opencode --json
hy-workflow setup --yes --clients codex --dry-run --json
hy-workflow unset --yes --clients all --remove-global --json
```

Non-interactive use requires both `--yes` and explicit `--clients`. `--dry-run` reports the candidate changes without writing. JSON mode emits one machine-readable result.

## Runtime prerequisites

- Node.js 18 or newer and npm
- `git` on PATH for project identity and repository operations
- authenticated `gh` for PR creation, CI status, and merge operations

`hy_status` reports Git/GitHub capability state. Missing capabilities fail closed with recovery guidance; there is no hidden Git or GitHub fallback.

## Version migration

Every `hy_*` dispatch checks the user-local deployment version. Missing, unreadable, or outdated deployments return a structured refresh envelope with the npm update command and `hy-workflow setup`. Legacy `.git/hy-workflow` state and setup stamps may be read once for compatibility and copied to user storage, but are never automatically deleted.

The npm package contains compiled `dist/`, docs, the shared workflow template, and README. It contains no Bash/PowerShell installer. Installation does not compile locally.
