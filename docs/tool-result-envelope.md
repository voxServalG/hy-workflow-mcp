# Tool Result Envelope

hy-workflow tool handlers keep their existing top-level fields such as `next`, `message`, `summary`, `checks`, `prNumber`, and `url`. They also add an agent-facing envelope so an agent can tell what to show the user, when to stop, and how to recover.

## Fields

```ts
type HyToolResult = {
  ok: boolean;
  phase: string;
  next: string;
  display?: {
    title?: string;
    body?: string;
    files?: string[];
    urls?: string[];
  };
  hint?: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  recovery?: {
    tool?: string;
    instruction?: string;
    byLayer?: Record<string, string>;
  };
};
```

`display` is content intended for the user. `hint` is an instruction to the agent. `requires_user` means the next step needs explicit user input. `stop_here` means the agent should not continue automatically in the current turn. `allowedTools` and `blockedTools` describe the safe next calls without changing the state machine.

## Examples

`hy_plan` success returns the legacy `summary` and also puts the same content in `display.body`, with `requires_user: true` and `stop_here: true`. The agent must show the plan and wait for approval.

`hy_verify` failure returns `checks` and `failedChecks` as before, plus `recovery.byLayer` guidance for lint, compile, scope, boundary, platform, smoke, and tests failures.

`hy_commit` success returns `next: "ci"` with the PR URL but does not set `stop_here`; after plan approval the agent should continue to CI automatically.

`hy_ci` success returns `next: "merge"` without `requires_user` or `stop_here`; after plan approval the agent should continue to merge automatically. CI failures, pending checks, or GitHub/API status problems return structured `recovery` and set `requires_user`/`stop_here` so the agent stops and reports the non-happy-path condition.

## Compatibility

The envelope is additive. Existing clients that read `next`, `message`, `summary`, `checks`, `prNumber`, or `url` can keep doing so. New agents should prefer `display`, `hint`, `allowedTools`, and `recovery` when deciding what to do next.
