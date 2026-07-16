# Tool Result Envelope

hy-workflow tool handlers keep their existing top-level fields, such as `message`, `summary`, `checks`, `prNumber`, and `url`. They also return an agent-facing envelope. The envelope tells an agent what to show the user, when to stop, what to call next, and how to recover.

The canonical field lists live in `src/output/contract.ts`. Runtime helpers and TypeScript types live in `src/output/envelope.ts`. Agents should not scrape prose from `message` when a structured field exists.

## Fields

```ts
type HyToolResult = {
  ok: boolean;
  phase: string;
  next: string;
  status?: string;
  data?: unknown;
  error?: HyToolError;
  display?: {
    title?: string;
    body?: string;
    files?: string[];
    urls?: string[];
  };
  summary?: string;
  hint?: string;
  requires_user?: boolean;
  stop_here?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  recovery?: {
    tool?: string;
    command?: string;
    instruction?: string;
    byLayer?: Record<string, string>;
  };
  checks?: unknown[];
  findings?: unknown[];
  pagination?: {
    has_more?: boolean;
    page_token?: string;
    next_page_token?: string;
  };
  meta?: {
    command?: string;
    cwd?: string;
    identity?: string;
    format?: string;
    version?: string;
    request_id?: string;
    trace_id?: string;
    duration_ms?: number;
  };
  _notice?: {
    update?: {
      message?: string;
      command?: string;
      current_version?: string;
      latest_version?: string;
    };
  };
};

type HyToolError = {
  type: string;
  subtype: string;
  code?: string;
  message: string;
  hint?: string;
  detail?: unknown;
  cause?: string;
  retryable?: boolean;
  risk?: unknown;
  permission_violations?: unknown[];
  missing_scopes?: string[];
  console_url?: string;
  request_id?: string;
  trace_id?: string;
};
```

`display` is content for the user. `summary` is exact long-form content for review gates. `hint` is an instruction for the agent. `requires_user` means the next step needs explicit user input. `stop_here` means the agent should not continue automatically in the current turn. `allowedTools` and `blockedTools` describe safe next calls without changing the state machine. `status`, `checks`, `findings`, `pagination`, `meta`, and `_notice` make CLI output useful without ad hoc parsing.

## CLI Agent Contract

Agents should handle tool results in this order:

1. If `display` exists, show `display.title`, `display.body`, and any `display.files` or `display.urls` to the user. If `summary` exists for an approval gate, show it exactly.
2. If `ok` is false, show `error.message`, include `error.code`, `error.hint`, `error.console_url`, `error.request_id`, and `error.trace_id` when present, then use `error.type` and `error.subtype` for recovery routing.
3. If `requires_user` or `stop_here` is true, stop automatic progress and wait for explicit user input.
4. If `recovery` exists, use it as the next repair action. `recovery.command` is the shell command to run when provided; `recovery.byLayer` maps verify layers to targeted fixes.
5. If continuing automatically, choose only from `allowedTools`. Never call a `blockedTools` entry.
6. Use `phase` as the current state and `next` as the suggested next tool or state. They may differ. For example, `hy_edit` returns `phase: "edit"` and `next: "verify"`.
7. Use `pagination.has_more`, `pagination.page_token`, and `pagination.next_page_token` for paged output. Preserve `meta.command`, `meta.cwd`, `meta.identity`, `meta.format`, `meta.version`, `meta.request_id`, `meta.trace_id`, and `meta.duration_ms` in logs. Surface `_notice.update.message` and `_notice.update.command` when setup or CLI update guidance is returned.
8. Treat legacy fields such as `message`, `prNumber`, and `url` as additional data, not as the primary control plane.

Happy-path tools should omit `stop_here` unless the workflow requires user review. Non-happy paths should set `requires_user` and `stop_here` with `display` plus `recovery`. Examples include plan approval, setup refresh, CI failure, CI timeout, permission failures, and GitHub/API errors.

Terminal CLI commands follow the same contract when `--json` is passed. For example, `hy-workflow config --check --json` returns one JSON envelope with `ok`, `display`, `hint`, `issues`, `suggestedCommand`, and `recovery`. `hy-workflow setup --yes --clients ... --json` and `hy-workflow unset --yes --clients ... --json` likewise emit one machine-readable result; unattended calls must supply the noninteractive choices explicitly. These commands do not return prose that agents must scrape.

## Examples

`hy_plan` success returns the legacy `summary` and also puts the same content in `display.body`. This text is the user approval summary: it should explain the current state, expected project state after applying the plan, files and reasons, boundary, verification plan, risks, and tradeoffs in reader-friendly language. The expected state must be derived from the concrete PlanDoc rather than a fixed sentence about summary quality. The full PlanDoc remains available in `plan` for agents and compatibility clients. `hy_plan` sets `requires_user: true` and `stop_here: true`; the agent must show the approval summary and wait for explicit approval.

`hy_verify` failure returns `checks` and `failedChecks` as before. It also returns `findings` and `recovery.byLayer` guidance for lint, compile, scope, boundary, platform, smoke, and tests failures.

`hy_commit` success returns `next: "ci"` with the PR URL, but does not set `stop_here`. After plan approval, the agent should continue to CI automatically.

`hy_commit`, `hy_ci`, `hy_merge`, and `hy_chain` add `data.executor` without removing legacy fields. A mixed operation such as `hy_commit` reports per-step executors for commit, push, and PR creation; failures include the capability that was actually checked. `hy_status.capabilities` exposes the startup git/gh snapshot for diagnosis.

`hy_ci` performs bounded polling for pending checks and revalidates the persisted repository/base/head/headRefOid identity in every poll. Only at least one effective check with every effective check successful returns `next: "merge"` without `requires_user` or `stop_here`. If GitHub reports no checks, the result remains `next: "ci"` with `noChecks: true`; if every reported check is skipped or neutral, it remains `next: "ci"` with `noEffectiveChecks: true`. Both cases return `error.code: "CI_CHECKS_REQUIRED"`, `requires_user: true`, `stop_here: true`, `blockedTools: ["hy_merge", "hy_chain"]`, and structured `recovery`. Identity drift, CI failures, polling timeouts with checks still pending, and GitHub/API status problems also stop automatic progress; missing CI evidence is never treated as success.

## Compatibility

The envelope is additive. Existing clients that read `next`, `message`, `summary`, `checks`, `prNumber`, or `url` can keep doing so. New CLI agents should use `ok`, `phase`, `next`, `status`, `data`, `error`, `display`, `summary`, `hint`, `requires_user`, `stop_here`, `allowedTools`, `blockedTools`, `recovery`, `checks`, `findings`, `pagination`, `meta`, and `_notice` to decide what to show and what to call next.

## Structured Errors

Failures include `error.type`, `error.subtype`, and `error.message`, plus stable context fields such as `error.code`, `error.hint`, `error.detail`, `error.cause`, `error.retryable`, `error.risk`, `error.permission_violations`, `error.missing_scopes`, `error.console_url`, `error.request_id`, and `error.trace_id`. Implementations may pass a string to helper code, but `src/output/envelope.ts` normalizes it before returning JSON to MCP clients.
