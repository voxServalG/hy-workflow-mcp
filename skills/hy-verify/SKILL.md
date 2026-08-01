---
name: hy-verify
description: >-
  Verify the current Git change against repository-specific invariants and historical incident regressions, using the exact project-native commands issued by hy-workflow and evidence bound to HEAD plus the working-tree diff. Use when substantive code, configuration, build, packaging, or documentation has changed; when asked to test, verify, assess regression risk, or check readiness; and before claiming a change ready, committed, released, or complete. Re-run when the diff changes after evidence. Do not use for pure explanation or planning with no repository change.
---

# hy-verify

Prove the current change against the obligations that apply to it. The CLI issues and checks machine-verifiable requirements; the Agent reads their sources, expands semantic impact, runs project-native tools, and explains the result.

Before inspecting or executing checks, read [the evidence contract](references/evidence-contract.md). Read [semantic-impact analysis](references/semantic-impact.md) whenever the diff changes code, configuration, schemas, public interfaces, packaging, or operational behavior. Read [the trigger semantics](references/trigger-semantics.md) only when an implicit invocation is ambiguous, when diagnosing a false trigger, or when changing this Skill's description.

Follow these rules:

1. Run `hy-workflow inspect --json` and preserve every returned obligation, source, `commandId`, `argv`, expected exit code, and binding exactly.
2. Read every source cited by an issued obligation. Then perform the semantic-impact pass and add any necessary supplemental native checks. Supplemental checks never erase an issued obligation and never enter CLI evidence.
3. Execute each issued `argv` directly from the repository root without shell-joining it. Record the truthful result in `hy-workflow.evidence.v1`.
4. Submit the evidence with `hy-workflow verify --input-file <evidence.json> --json`, using a temporary regular file outside Git. `--input '<object>'` is an equivalent public form when safe quoting is practical.
5. If verification reports `stale`, inspect again and rerun the newly issued commands. Report `verified`, `failed`, `missing`, `stale`, `invalid`, and `unavailable` distinctly.

The CLI is not an access gate. A failed or unavailable check prevents a positive readiness claim; it does not prevent editing, diagnosis, safe recovery, or other independent checks. If the CLI or relation index is unavailable, run the best repository-native checks supported by local evidence, label them unsigned, and continue. Never require the user to repair hy-workflow state before the Agent can make safe progress.
