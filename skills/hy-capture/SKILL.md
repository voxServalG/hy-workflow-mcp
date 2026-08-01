---
name: hy-capture
description: >-
  Turn a confirmed, high-impact project failure into Git-tracked engineering memory: an incident source, a stable invariant, a narrow applicability rule, and a project-native regression obligation. Use when a real outage, serious regression, or repeatedly recurring defect has a demonstrated root cause and reproducible test, or when the user explicitly asks to institutionalize such a lesson. Do not create obligations for ordinary one-off bugs, style feedback, speculative risks, preferences, or failures that lack a stable native verification command.
---

# hy-capture

Convert proven operational learning into a small, reviewable Git change. The Agent authors knowledge and tests with normal project tools; the CLI validates relation data and later issues the resulting obligation against matching diffs.

Before deciding whether an event is eligible, read [the capture criteria](references/capture-criteria.md). Before editing `hy-workflow.yml` or authoring new incident or invariant sources, read [the protocol example](references/protocol-example.md). Read [the trigger semantics](references/trigger-semantics.md) only when an implicit invocation is ambiguous, when diagnosing a false trigger, or when changing this Skill's description.

Follow these rules:

1. Search existing incident sources, invariant sources, tests, and obligation IDs before creating anything. Amend or link existing knowledge when it already expresses the same causal lesson.
2. Require demonstrated impact, root cause, a regression oracle, and a stable project-native command. If proof is incomplete, return a clearly labeled capture candidate and continue safe investigation; do not create an authoritative obligation.
3. Save durable knowledge only in Git: one incident source, one reusable invariant source, the regression test or fixture, and the smallest root `hy-workflow.yml` entry needed to connect affected paths to the native command.
4. Keep path applicability narrow and reviewable. Do not embed prompts, workflow state, command output, secrets, or copied documentation in relation data.
5. Once the candidate files are Git-tracked, run `hy-workflow inspect --json`. Confirm that the relevant diff hits the new obligation and execute the exact issued argv. Use `hy-verify` to submit evidence when a protocol-backed verification claim is needed.

There is no capture CLI command and capture never self-approves. Normal Git review establishes team acceptance. The CLI is not an access gate. Missing CLI support or invalid existing configuration must not halt diagnosis or repair: prepare only the source and regression-test changes that are independently justified, label protocol validation unavailable, and continue without asking the user to repair internal workflow state.
