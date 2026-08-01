---
name: hy-init
description: >-
  Orient an agent to this repository's Git-tracked hy-workflow protocol, project invariants, incident history, and native verification entry points. Use when entering or resuming an unfamiliar repository, when the user asks to initialize, orient, onboard, or understand the project, or before the first substantive repository change when this task has not yet loaded the project's obligations. Do not repeat after the task-local project map is current, and do not use for generic questions unrelated to a repository.
---

# hy-init

Build a bounded, read-only project map before substantive repository work. The CLI supplies machine facts; this Skill interprets those facts and local Git-tracked sources for the Agent.

Before collecting facts, read [the project-map protocol](references/project-map.md). It defines the required reads, output, and degradation behavior. Read [the trigger semantics](references/trigger-semantics.md) only when an implicit invocation is ambiguous, when diagnosing a false trigger, or when changing this Skill's description.

Follow these rules:

1. If this task already has a current project map, return to the user's work without rerunning initialization.
2. Collect the bounded local facts in the project-map protocol. If a root `hy-workflow.yml` exists, run `hy-workflow inspect --json` and treat its structured facts as authoritative for what the CLI actually inspected.
3. Read only obligation sources that apply to the task or current change; do not ingest the entire incident archive.
4. Return a compact task-local map: repository identity, current change state, ecosystems, native verification entry points, applicable invariants and incidents, and explicitly unavailable facts.
5. Make no repository, Git, user-configuration, or external-service changes.

The CLI is not an access gate. If it is missing, incompatible, or unable to inspect the protocol, report that limitation and continue the same read-only orientation from Git and project files. Never require installation or user intervention merely to continue safe repository work.
