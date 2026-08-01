# Trigger semantics

Read this file only to resolve an ambiguous implicit invocation, investigate trigger quality, or maintain the Skill description. Do not read it during an ordinary explicit `hy-verify` invocation.

## Should trigger

- "Run the right regression checks for my current diff."
- "Prove this change is ready to commit or release."
- "The implementation changed after tests; verify it again."
- "根据项目历史事故和不变量，核验当前改动。"
- A substantive documentation change whose applicable obligation requires document linting or contract synchronization.

## Should not trigger

- "Explain the test pyramid" with no repository change.
- "Draft a plan for a future refactor."
- "What would you test?" when the user requests only conceptual advice and no current diff exists.
- A generic prose rewrite outside a repository.

## Near-negative boundaries

- A code review with no local change should trigger only when the user asks for executable verification against a checked-out revision; otherwise use review reasoning.
- A single failing test during unrelated exploration does not by itself require full diff verification.
- Documentation-only work can be substantive; determine this from matched obligations and contract impact, not the file extension alone.
- If there is no diff, `inspect` may return `no_match`; report that fact and do not fabricate a change or issuance requirement.
