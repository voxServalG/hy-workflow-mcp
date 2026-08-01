# Project-map protocol

Read this file on every eligible `hy-init` run, before inspecting the repository.

## Authority and bounds

Use local evidence in this order:

1. The nearest applicable `AGENTS.md` or equivalent repository instructions.
2. The Git-tracked root `hy-workflow.yml` relation index, when present and valid.
3. Only the invariant and incident sources referenced by entries applicable to the current task or current change.
4. Manifests, lockfiles, compiler configuration, test configuration, and native command definitions.
5. Current local Git identity and change facts: repository root, `HEAD`, branch or detached state, staged changes, unstaged changes, and untracked paths.

Do not fetch, browse remote pull requests, contact external knowledge systems, mutate `.git`, install dependencies, or run tests during initialization. Do not scan every document or historical incident. A source is applicable only when its declared matcher reaches a current changed path or a concrete task target.

## Procedure

1. Resolve the repository root with Git. If the directory is not a Git worktree, label Git facts unavailable and orient only to the supplied directory.
2. Read the bounded authority set above. Never infer a command from language stereotypes when the repository declares its own command.
3. Identify each ecosystem from manifests and lockfiles, then locate its exact native build, lint, type-check, unit, integration, packaging, and acceptance entry points. Record only commands supported by repository evidence.
4. If root `hy-workflow.yml` exists, run exactly `hy-workflow inspect --json`. Preserve its exact `issued`, `no_match`, `invalid`, or `unavailable` status, and preserve each returned command as an `argv` array.
5. Relate the user's task or current changed paths to the protocol. For every match, record the obligation ID, why it matched, its source paths, and its native verification command. Treat CLI matches as a minimum set; do not silently discard one.
6. Produce the task-local map below. Keep it in the conversation; do not save it to the repository or a private state file.

## Required output

```text
Project: <root and repository identity>
Revision: <HEAD and branch/detached state>
Working tree: <clean, or staged/unstaged/untracked summary>
Ecosystems: <manifest-backed list>
Native entry points: <exact repository-backed commands>
Applicable obligations: <ID, match reason, sources, argv>
Unavailable or invalid: <fact and reason>
```

An empty obligation match is a valid result, not proof that the repository has no risks. Say whether the relation index was present and valid.

## Degradation behavior

- If `hy-workflow` is absent or its output cannot be parsed, read the Git-tracked files directly and label CLI-derived matching and issuance unavailable.
- If `hy-workflow.yml` is absent, do not invoke the CLI. Build the rest of the map and state that no Git-tracked obligation index was found.
- If the index is invalid, do not guess its meaning. Report the validation error, then continue with repository instructions and native configuration.
- If a referenced source is absent, record that exact broken reference and continue with other sources.
- If Git is unavailable, do not fabricate revision or diff facts.
- Ask the user only when the actual task is ambiguous enough to change the work materially, not because hy-workflow state is missing.
