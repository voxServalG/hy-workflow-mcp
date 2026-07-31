---
name: hy-edit
description: Lock approved scope, implement the change with normal file tools, and route the post-edit evidence audit. Use at edit.scope or edit.implementation, including verification recovery.
---

# Implement the approved change

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Invoke hy-workflow edit with no input only when the route permits it.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Invoke the command to lock scope; the command does not perform implementation edits.
2. Use normal file tools only after the CLI stops at edit.implementation. Touch only files declared in approved scope and preserve unrelated user changes.
3. If required work falls outside scope, stop and follow the amendment route. Never smuggle another file into the change.
4. Add or update tests at the semantic Small, Medium, and Large levels selected by the PlanDoc. Encode relevant historical incidents and project invariants.
5. After implementation, follow the routed after_edit documentation audit. Complete only documentation edits already declared in scope, then hand off to synchronization.
6. When verification returns to edit, repair the named failed layer without discarding still-current approval or evidence unless the CLI marks it stale.

## Present facts and recover

- Present branch, exact scope, dependency boundary, and edit.implementation stage before using normal file tools.
- If the branch fact is missing, explain the structured error and return to the routed branch Skill. For impossible state, preserve the exact reset route.
- After edits, invoke the routed hy-workflow read-docs command with the after_edit selector, complete declared documentation changes, and then follow synchronization. Do not advance from successful file edits alone.
