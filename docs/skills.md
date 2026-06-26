# Skill Contract

Skills are operational manuals for agents. They must reference real tools, preserve workflow order, describe output and error behavior, and explain recovery for destructive state changes.

## Core Skill

The core skill lives at docs/skills/core/SKILL.md and must mention every MCP tool:

- `hy_init`
- `hy_read_docs`
- `hy_plan`
- `hy_approve`
- `hy_branch`
- `hy_edit`
- `hy_sync_docs`
- `hy_verify`
- `hy_amend_plan`
- `hy_commit`
- `hy_ci`
- `hy_merge`
- `hy_chain`
- `hy_reset`
- `hy_status`

Contract lint checks Skill tool references against src/commands/catalog.ts.

