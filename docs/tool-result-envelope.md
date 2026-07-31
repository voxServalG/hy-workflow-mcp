# Tool Result Envelope

hy-workflow tool handlers keep their existing top-level fields, such as `message`, `summary`, `checks`, `prNumber`, and `url`. They also return an agent-facing envelope. The envelope tells an agent what to show the user, when to stop, what to call next, and how to recover.

The canonical field lists live in `src/output/contract.ts`. Runtime helpers and TypeScript types live in `src/output/envelope.ts`. Agents should not scrape prose from `message` when a structured field exists.

## Fields

```ts
type HyRecoveryCompatibilityFields = {
  tool?: string;
  arguments?: Record<string, unknown>;
  command?: string;
  instruction?: string;
  byLayer?: Record<string, string>;
};

type HyToolRecovery =
  | (HyRecoveryCompatibilityFields & { strategy: "retry"; tool: string })
  | (HyRecoveryCompatibilityFields & { strategy: "repair_and_retry"; tool: string; instruction: string })
  | (HyRecoveryCompatibilityFields & { strategy: "wait_and_retry"; tool: string; instruction: string })
  | (HyRecoveryCompatibilityFields & { strategy: "replan"; tool: string; instruction: string })
  | (HyRecoveryCompatibilityFields & { strategy: "reset"; tool: "hy_reset"; instruction: string })
  | (HyRecoveryCompatibilityFields & { strategy: "external_action"; instruction: string });

type HyToolResult = {
  ok: boolean;
  phase: string;
  stage: string;
  status: string;
  nextAction: {
    tool?: string;
    arguments?: Record<string, unknown>;
    phase: string;
    stage: string;
    automatic: boolean;
  };
  control: { automatic: boolean; stop: boolean; reason?: string };
  userAction: {
    kind: string;
    decisionId?: string;
    prompt?: string;
    instruction?: string;
    options?: string[];
  } | null;
  next: string; // legacy
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
  recovery?: HyToolRecovery;
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

`phase` is persisted coarse state and `stage` is the current intra-phase step. `nextAction` names the next tool and arguments, target phase/stage, and whether it is automatic. `control` says whether automation may continue, whether it must stop, and why. `userAction` carries `kind`, `decisionId`, prompt/instruction, and options. Only `userAction.kind: "approval"` means ask the human to approve. Recovery, `requires_user`, `stop_here`, CI wait, `review_failure`, configuration, authentication, permissions, and external action are not approval and must retain their own kind.

## CLI Agent Contract

Agents should handle tool results in this order:

1. If `display` exists, show `display.title`, `display.body`, and any `display.files` or `display.urls` to the user. If `summary` exists for an approval gate, show it exactly.
2. If `ok` is false, show `error.message`, include `error.code`, `error.hint`, `error.console_url`, `error.request_id`, and `error.trace_id` when present, then use `error.type` and `error.subtype` for recovery routing.
3. Obey `control`. Ask for approval only when `userAction.kind` is `approval`; otherwise present the typed recovery, wait, review, configuration, authentication, permission, or external action without relabeling it.
4. If `recovery` exists, route by its required `strategy`: `retry` invokes the named tool directly, `repair_and_retry` repairs before invoking it, `wait_and_retry` waits before invoking it, `replan` revises the plan or amendment, `reset` abandons the current workflow through `hy_reset`, and `external_action` requires work outside the MCP pipeline. When `recovery.tool` names an MCP or CLI tool, pass its complete `recovery.arguments`; never reconstruct required input from prose. `recovery.command` remains the shell command to run when provided; `recovery.byLayer` maps verify layers to targeted fixes. Do not infer a strategy from `instruction` prose.
5. If continuing automatically, choose only from `allowedTools`. Never call a `blockedTools` entry.
6. Use `phase` as coarse state, `stage` as the current step, and `nextAction` as the primary routing contract. `next` remains only for legacy clients.
7. Use `pagination.has_more`, `pagination.page_token`, and `pagination.next_page_token` for paged output. Preserve `meta.command`, `meta.cwd`, `meta.identity`, `meta.format`, `meta.version`, `meta.request_id`, `meta.trace_id`, and `meta.duration_ms` in logs. Surface `_notice.update.message` and `_notice.update.command` when setup or CLI update guidance is returned.
8. Treat legacy fields such as `message`, `prNumber`, and `url` as additional data, not as the primary control plane.

Legacy `requires_user` and `stop_here` remain additive compatibility fields. They never imply approval without `userAction.kind: "approval"`.

Terminal CLI commands follow the same control vocabulary when `--json` is passed. For example, `hy-workflow config --check --json` returns one JSON envelope with `ok`, `display`, `hint`, `issues`, `suggestedCommand`, and structured `recovery`. Setup and unset emit `phase: setup`, `action: setup|unset`, canonical `stage: setup.apply|setup.unset`, `status`, `nextAction`, `control`, `userAction`, and a strategy-discriminated recovery on failure. Retryable failures use wait-and-retry; repairable failures use repair-and-retry. Neither is an approval. Unattended calls must supply their noninteractive choices explicitly, and agents never need to scrape prose.

## Examples

`hy_plan` success returns the legacy `summary` and the same text in `display.body`. It also returns `userAction.kind: "approval"` with a `decisionId` bound to the exact PlanDoc hash. Submit that one human decision immediately through `hy_approve`; do not call `hy_read_docs(before_approve)` first. If the audit is missing, the first `hy_approve` persists the exact decision and returns an automatic `hy_read_docs(before_approve)` action. No drift returns an automatic replay. Drift returns `control.reason: "review_required"` with no user action; the agent calls `hy_approve` with `auditDecision=continue` if the PlanDoc remains materially valid or `auditDecision=replan` to refresh facts and produce a new PlanDoc. The same PlanDoc is never presented for a second approval. One approval covers unchanged intent through edits, retries, verify, `commit.ci`, merge, `merge.sync`, and reset. Pure scope removal or `changes`/`new_files` normalization preserves it. A new PlanDoc, real scope or risk expansion, or any new delete target requires a new decision. Unknown approval or audit-decision text changes no state.

`hy_edit` returns `control.stop: true` with `external_action_required` after locking scope, because standard file tools must perform the code edits. `hy_read_docs(after_edit)` likewise stops so declared documentation edits can be completed. Only after those edits does `hy_sync_docs` record the current evidence and return an automatic `hy_verify` action.

`hy_verify` failure returns `checks` and `failedChecks` as before. It also returns `findings` and `recovery.byLayer` guidance for lint, compile, scope, boundary, platform, smoke, and tests failures.

`hy_commit` performs and retries `commit.ci`. CI pending is a wait/retry result, not approval. Effective green checks advance to merge.

`hy_commit` and `hy_merge` add `data.executor` without removing legacy fields. `hy_commit` reports per-step executors for commit, push, PR creation, and CI polling; failures include the capability that was actually checked. `hy_status.capabilities` exposes the startup git/gh snapshot for diagnosis.

`hy_commit` performs bounded polling for pending CI checks after PR creation and revalidates the persisted repository/base/head/headRefOid identity in every poll. Only at least one effective check with every effective check successful returns `next: "merge"` without `requires_user` or `stop_here`. If GitHub reports no checks, the result remains `next: "commit"` with `noChecks: true`; if every reported check is skipped or neutral, it remains `next: "commit"` with `noEffectiveChecks: true`. Both cases return `error.code: "CI_CHECKS_REQUIRED"`, `requires_user: true`, `stop_here: true`, `blockedTools: ["hy_merge"]`, and structured `recovery`. Identity drift, CI failures, polling timeouts with checks still pending, and GitHub/API status problems also stop automatic progress; missing CI evidence is never treated as success.

`hy_merge` success returns `phase: "done"` / `next: "done"` and exposes `data.outcome: "merged_now" | "already_merged" | "already_integrated"` plus `data.evidence` and `data.executor`. `merged_now` means this invocation issued the sole mutation and later confirmed it; `already_merged` means this invocation issued no mutation because GitHub lifecycle and Git ancestry already confirmed MERGED, including pending-receipt recovery; `already_integrated` means fresh Git ancestry confirmed integration while GitHub lifecycle was unavailable. `data.executor` reports the executor capability that supplied the final recovery/synchronization evidence, so Git-only evidence is never presented as GitHub confirmation.

Recovery detail preserves immutable repository/PR/base/head/verified-OID identity separately from mutable lifecycle and receipt stage, plus prepared/confirmed/`syncBaseOid`, ancestry evidence, completed sync work, and remaining sync work. The attempted receipt is persisted before the sole merge mutation and advanced to confirmed after remote confirmation. Stacked branch synchronization uses `detached staging`, persists `rebasing` intent and `resultOid`, installs the local ref by `compare-and-swap`, and pushes by exact `force-with-lease`. A retry can therefore reconcile or resume remaining sync without invoking the mutation twice or overwriting a moved ref.

If neither GitHub postcondition nor fresh-fetch ancestry confirms integration, the result remains `phase: "merge"`, `next: "merge"` with `error.code: "PR_MERGE_OUTCOME_UNCONFIRMED"`, `requires_user: true`, `stop_here: true`, and retry guidance limited to `hy_merge`/`hy_status`. If integration is confirmed but base/downstream synchronization is incomplete, the same stop shape uses `POST_MERGE_SYNC_INCOMPLETE`; its recovery identifies completed and remaining sync steps, and retry must not call `executePrMerge` again. `MERGE_LOCK_BUSY` and base evidence/ancestry drift are retryable after the external condition is repaired. Immutable identity, local-ref compare-and-swap, or downstream remote-lease drift is nonretryable and directs the user to inspect and explicitly `hy_reset` or repair state rather than loop automatically.

Legacy merge state without a receipt may recover after fresh Git ancestry proves the verified OID is integrated. It reconstructs only agent-prefix stacks whose verified ancestry and equal local/remote OIDs agree; unrelated branches are ignored, while a diverged true stack returns `POST_MERGE_SYNC_INCOMPLETE`. The result never claims a prior GitHub mutation that was not recorded.

## Compatibility

The envelope is additive. Existing clients that read `next`, `message`, `summary`, `checks`, `prNumber`, `url`, or the compatibility recovery fields `tool`, `arguments`, `command`, `instruction`, and `byLayer` can keep doing so. New agents use typed `phase`, `stage`, `status`, `nextAction`, `control`, `userAction`, and `recovery.strategy`; display/recovery/pagination/meta/notice/error and other legacy details remain available.

## Structured Errors

Failures include `error.type`, `error.subtype`, and `error.message`, plus stable context fields such as `error.code`, `error.hint`, `error.detail`, `error.cause`, `error.retryable`, `error.risk`, `error.permission_violations`, `error.missing_scopes`, `error.console_url`, `error.request_id`, and `error.trace_id`. Implementations may pass a string to helper code, but `src/output/envelope.ts` normalizes it before returning JSON to MCP clients.
