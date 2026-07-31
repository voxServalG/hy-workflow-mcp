---
name: hy-approve
description: Apply the single explicit human decision to one exact PlanDoc and continue through the automatic pre-approval documentation audit. Use only after a routed approval request or audit continuation.
---

# Apply the plan decision

Own `approve.decision` for the human PlanDoc decision and `approve.before_approve` for the automatic documentation audit judgment.

> **Prerequisite:** Read [`../hy-status/SKILL.md`](../hy-status/SKILL.md) first for the shared CLI authority, exact argv, routing, stop, recovery, and private-state rules.

## Stage command

- Submit the decision through hy-workflow approve --input <JSON>. Keep the input as one argv value and preserve the exact human intent.
- Preserve the route-provided decisionId unchanged in every approve call. Fill only the declared human decision or Skill audit decision field; a stale or missing identity must stop without changing workflow state.
- Obey route.allowed, route.blocked, route.control, route.userAction, and route.recovery. Read top-level data and error objects as facts.

## Procedure

1. Require an explicit approve, reject, or revise decision bound to the presented PlanDoc and decision identity. Silence, earlier discussion, and general intent are not approval.
2. Map an already explicit human decision to the exact enum and submit it once with the optional note. If validation rejects the enum, correct the mapping from the same decision; ask again only when the original intent is genuinely ambiguous.
3. When the CLI routes the automatic before_approve documentation audit, hand off to the documentation Skill. Explain that this is an evidence refresh, not a second approval gate.
4. If the audit reports material drift, compare the returned document facts with PlanDoc intent, scope, verification, and risk treatment. Select continue only when all remain materially valid; otherwise select replan. This is Skill review, not a new human decision.
5. On replan, preserve the original task fact, refresh before_plan evidence, compose a new PlanDoc, and request approval only for that new decision identity.
6. On reject or revise, report the recorded decision and collect only missing revision facts before returning to planning. Never continue the old route.
7. On approval, synthesize only the category and topic required by the signed branch handoff, then continue through the CLI-issued workflow. Do not invent a hidden pipeline or bypass any later stop, evidence, verification, CI, merge, or reset gate.
