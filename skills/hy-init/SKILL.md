---
name: hy-init
description: Initialize external workflow state and build the first local project cognition baseline. Use for the first workflow session, an uninitialized state, or an exact CLI route to initialization.
---

# Initialize hy-workflow

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Do not guess a transition or treat local observations as workflow evidence.
- Read top-level data and error objects as facts. Ask a human only for the structured user action that the route requires.

## Procedure

1. Invoke hy-workflow init with no input only when the route permits initialization. Never launch interactive setup, edit the worktree, or write Git metadata.
2. Confirm that initialization reports projectFilesChanged as an empty array and that deployment, configuration authority, identity, and external state are valid.
3. Build a local-only cognition report:
   - Read progressive local documentation entry points and the configured documentation directory.
   - Inspect locally available pull-request evidence, merge commits, refs, and repository records. If none exists, report that evidence unavailable and do not fetch it.
   - Inspect recent local commits as context, never as approval.
   - Identify ecosystems from manifests, lockfiles, source layout, compiler or runtime configuration, and code extensions.
   - Identify the test platform from package scripts, task runners, test directories, compiler and linter settings, local continuous-integration files, and historical regression fixtures.
4. Record a semantic test-scale policy from change characteristics:
   - Small is mandatory for every change: single-module, deterministic and isolated compile, static, type, focused unit, smoke, and pure contract checks near the changed behavior.
   - Medium is mandatory when behavior crosses modules, processes, the file system, a local database, serialization, schema, a public API, CLI, configuration, concurrency, or recovery state.
   - Large is mandatory for installation, upgrade, packaging, release, CI, cross-platform behavior, an external service, a security boundary, irreversible compatibility, or end-to-end reproduction of a historical major incident.
   - Do not infer scale from programming language, repository size, a user label, or elapsed time alone. Record the trigger facts and available commands; the planning Skill selects the concrete suite later.
5. Keep cognition local. Do not access Feishu, Lark, team knowledge bases, remote pull-request APIs, or other external services.
6. Report local cognition separately from CLI evidence, then follow only the returned route.

## Expected result

Explain local documentation, recent change history, ecosystems, test platform, and semantic Small, Medium, and Large triggers. Initialization leaves project files and Git metadata unchanged.

## Present facts and recover

- On success, explain the verified deployment, configuration authority, project identity, external runtime paths, zero project-file changes, and local cognition facts. State the repository boundary from projectFilesChanged, commitArtifacts, localArtifacts, and gitignoreChanged rather than from handler-authored prose.
- If a workflow is already active, report its phase and stage and hand off only to the routed status command.
- For a missing or unsafe deployment, report the structured error code and missing artifacts, stop, and request only the external setup action authorized by the route. Never invent a shell command or continue into planning.
- For configuration or readiness failures, explain code, message, issues, and affected authority. Ask for repair only when the structured user action requires it, then retry the exact routed initialization.
- When initialization needs a task, use the current concrete user request for the routed before_plan input. Ask the user only if no concrete task exists.
