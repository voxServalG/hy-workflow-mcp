---
name: hy-status
description: Inspect the authoritative workflow position, evidence health, and permitted route without mutation. Use when resuming work, recovering context, checking progress, or when another stage Skill lacks a current envelope.
---

# Inspect workflow status

## Shared CLI control contract

- The hy-workflow CLI is the sole authority for phase, stage, allowed and blocked commands, route, and workflow evidence. Never read, edit, or reconstruct its private state files.
- If no current CLI envelope exists, invoke hy-workflow status with no input. Otherwise use only the immediately preceding route while its evidence is still current.
- When route.action.argv is non-null, preserve every element boundary and execute it exactly, only after satisfying route.control.
- When argv is null but route.action.command is non-null, hand the envelope to that command's Skill. Only that Skill may fill route.action.inputRequired from its declared sources, merge the signed partial input without overwriting it, and add no other fields.
- When argv and command are both null, act only on explicit route.choices, an external target, recovery, or a terminal result. Never infer a command from route.allowed, phase, stage, natural language, or private state; refresh status at most once for an unexplained null.
- Status never constructs another stage command. It only reports or hands off the CLI-issued route.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Do not guess a transition or infer completion from Git alone.
- Read top-level data and error objects as facts. Ask a human only for the structured user action that the route requires.

## Procedure

1. Run status without mutating project files, Git metadata, remote state, or external workflow state.
2. Report the current phase and stage, evidence health, branch and pull-request facts when present, and the exact route.
3. Stop when route.control.stop is true. Request only the decision or information identified by route.userAction.
4. When route.action.automatic is true, hand off to the matching stage Skill with its complete input and argv. When false, do not silently advance.
5. Preserve absent, corrupt, stale, pending, and unknown states exactly as reported.

## Present facts and recover

- Explain phase, stage, status, evidence health, current identities, and route fields in plain language without adding a transition.
- For impossible state, report the structured error code and message, preserve the exact reset route, and request only the structured review action.
- When task information is required, use the current concrete development request. Ask the user only when that source is absent.
