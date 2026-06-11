# Tool Result Envelope

hy-workflow tool handlers keep their existing top-level fields such as `next`, `message`, `summary`, `checks`, `prNumber`, and `url`. They also add an agent-facing envelope so an agent can tell what to show the user, when to stop, and how to recover.

The envelope is optimized for CLI agents: the response is a single JSON object with stable control fields, user-facing display text, and recovery hints. Agents should not scrape prose from `message` when a structured field exists.

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

## CLI Agent Contract

Agents should consume tool results in this order:

1. If `display` exists, show `display.title`, `display.body`, and any `display.urls` to the user.
2. If `requires_user` or `stop_here` is true, stop automatic progress and wait for explicit user input.
3. If `recovery` exists, use it as the next repair action; `recovery.byLayer` maps verify layers to targeted fixes.
4. If continuing automatically, choose only from `allowedTools` and never call a `blockedTools` entry.
5. Use `phase` as the current state and `next` as the suggested next tool/state. They may differ, for example `hy_edit` returns `phase: "edit"` and `next: "verify"`.
6. Treat `message`, `summary`, `checks`, `prNumber`, and `url` as legacy/additional data, not as the primary control plane.

Happy-path tools should omit `stop_here` unless the workflow requires user review. Non-happy paths such as plan approval, setup refresh, CI failure, CI timeout, or GitHub/API errors should set `requires_user` and `stop_here` with `display` plus `recovery`.

## Examples

`hy_plan` success returns the legacy `summary` and also puts the same content in `display.body`, with `requires_user: true` and `stop_here: true`. The agent must show the plan and wait for approval.

`hy_verify` failure returns `checks` and `failedChecks` as before, plus `recovery.byLayer` guidance for lint, compile, scope, boundary, platform, smoke, and tests failures.

`hy_commit` success returns `next: "ci"` with the PR URL but does not set `stop_here`; after plan approval the agent should continue to CI automatically.

`hy_ci` performs bounded polling for pending checks. Success returns `next: "merge"` without `requires_user` or `stop_here`; after plan approval the agent should continue to merge automatically. CI failures, polling timeout with checks still pending, or GitHub/API status problems return structured `recovery` and set `requires_user`/`stop_here` so the agent stops and reports the non-happy-path condition.

## Compatibility

The envelope is additive. Existing clients that read `next`, `message`, `summary`, `checks`, `prNumber`, or `url` can keep doing so. New CLI agents should prefer `display`, `hint`, `requires_user`, `stop_here`, `allowedTools`, `blockedTools`, and `recovery` when deciding what to show and what to call next.
