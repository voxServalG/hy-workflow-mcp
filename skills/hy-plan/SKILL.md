---
name: hy-plan
description: Compose and submit a scientific PlanDoc from current local documentation evidence and CLI state. Use for a concrete development change after a current before_plan read.
---

# Plan a change

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Submit one JSON object through hy-workflow plan --input <JSON>. Keep the input as one argv value; never convert routed argv into a shell string.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Require current before_plan evidence. If it is absent or stale, follow the documentation route first.
2. Inspect the worktree only to ground the plan. Confirm existing and deleted paths, and keep planned new paths inside the repository.
3. Build a PlanDoc with a problem-oriented task, exact scope, dependency direction, unaffected boundaries, compile and lint entry points, platform setup, executable checks with expected exits, scenario-impact-mitigation risks, and at least one rejected alternative with reason.
4. Select verification semantically:
   - Small is mandatory for every change: single-module, deterministic and isolated compile, static, type, focused unit, smoke, and pure contract checks near the changed behavior.
   - Medium is mandatory when behavior crosses modules, processes, the file system, a local database, serialization, schema, a public API, CLI, configuration, concurrency, or recovery state.
   - Large is mandatory for installation, upgrade, packaging, release, CI, cross-platform behavior, an external service, a security boundary, irreversible compatibility, or end-to-end reproduction of a historical major incident.
   - Treat CLI-required checks and incident fixtures as a minimum. Do not choose scale from language, repository size, a user label, or duration alone.
5. Submit the task and complete PlanDoc in one command input.
6. When the CLI accepts the PlanDoc, render the approval view from the returned PlanDoc facts. Include every item below without truncating material details:
   - the problem and expected state;
   - exact changes, new files, and deletions;
   - dependency direction, entry points, and explicitly unaffected boundaries;
   - environment setup and every executable compile, lint, and test command with its expected exit code;
   - semantic Small, Medium, and Large coverage and the trigger facts for every included level;
   - each risk as scenario, impact, and mitigation;
   - at least one alternative and the reason it was rejected.
7. Treat structured warning records as advisories and explain them separately from validation failures. Never turn Skill prose into workflow evidence.
8. Bind the rendered PlanDoc to the returned decision identity, request one explicit approve, reject, or revise decision, and stop. Never approve on behalf of the human.
