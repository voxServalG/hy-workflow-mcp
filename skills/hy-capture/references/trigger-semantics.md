# Trigger semantics

Read this file only to resolve an ambiguous implicit invocation, investigate trigger quality, or maintain the Skill description. Do not read it during an ordinary explicit `hy-capture` invocation.

## Should trigger

- "This outage is fixed and reproduced by a regression test. Capture the lesson as a project invariant."
- "We have hit the same release corruption three times; institutionalize the proven fix."
- "Turn this confirmed root cause and native regression command into Git-tracked knowledge."
- "这个重大历史事故已经定位并有回归测试，把它沉淀为项目不变量。"

## Should not trigger

- "Fix this ordinary one-off bug."
- "The naming style feels inconsistent."
- "This might someday become a security problem" without demonstrated impact or cause.
- "One test failed once" without a stable reproduction and causal finding.
- A preference, review comment, feature request, or generic best practice.

## Near-negative boundaries

- "Capture this incident" should trigger the Skill, but incomplete proof yields only a candidate; it must not create an authoritative obligation.
- A repeatedly annoying defect is insufficient unless its cumulative impact is material and its cause and oracle are demonstrated.
- A historical issue with a clear narrative but no stable native argv remains a candidate until the repository has a repeatable verification entry point.
- A serious newly discovered failure can trigger investigation, but durable capture waits for root-cause and regression proof.
