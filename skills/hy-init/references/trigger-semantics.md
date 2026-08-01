# Trigger semantics

Read this file only to resolve an ambiguous implicit invocation, investigate trigger quality, or maintain the Skill description. Do not read it during an ordinary explicit `hy-init` invocation.

## Should trigger

- "Initialize yourself in this repository, then help me fix the parser."
- "You have not seen this codebase before. Find its invariants and test commands."
- "Resume this repository in a fresh session and orient before changing anything."
- "先认识这个项目、历史事故和原生测试入口，再开始开发。"

## Should not trigger

- "What is a software invariant?" with no repository task.
- "Continue the edit" after this task already has a current project map.
- "Explain the generic small, medium, and large test taxonomy."
- "Rewrite this paragraph" when no repository knowledge is required.

## Near-negative boundaries

- "Summarize the README" does not need this Skill unless the user also asks for project obligations or development readiness.
- An explicit orientation request should trigger even if `hy-workflow.yml` is missing; the Skill then degrades without blocking.
- A new task in the same repository should rerun only when its target makes the existing task-local map materially incomplete or stale.
- A changed `HEAD` alone does not force rerunning initialization; rerun when the repository instructions, manifests, relation index, or relevant sources may have changed.
