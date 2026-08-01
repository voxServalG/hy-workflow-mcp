# Semantic-impact analysis

Read this file whenever a verification target changes code, configuration, schemas, public interfaces, packaging, or operational behavior. It is optional for a truly isolated prose-only change with no matched obligation.

Path matching is deliberately conservative and deterministic, so treat the CLI-issued set as a minimum. The Agent must inspect meaning that path globs cannot see.

## Analysis procedure

1. List changed symbols, public contracts, configuration keys, schema fields, generated artifacts, packaging metadata, and operational behaviors.
2. Trace direct callers and consumers, serialization boundaries, process boundaries, persistence boundaries, error recovery, concurrency, and platform-specific paths.
3. Map those effects to repository invariants and known incident sources already present in Git.
4. Add a project-native supplemental check when a plausible affected boundary is not covered by the issued set. State the reason and label it supplemental and unsigned. Never include it in `hy-workflow.evidence.v1` unless a new inspection actually issues it.
5. Never remove an issued obligation because semantic review predicts it is irrelevant. Report a suspected false match separately so relation data can be reviewed.

Select supplemental depth by boundary, not duration:

- Small: isolated, deterministic static analysis, type checks, unit tests, or pure contract checks. Include for every substantive implementation change.
- Medium: cross-module or cross-process behavior, filesystem or local database state, serialization, schemas, public APIs, CLI behavior, configuration, concurrency, or recovery.
- Large: installation, upgrade, packaging, release, continuous integration, cross-platform behavior, external services, security boundaries, irreversible compatibility, or end-to-end reproduction of a serious historical incident.

Passing Small checks never removes a Medium or Large check required by an affected boundary.

## Reporting

Separate the final account into:

1. CLI-issued obligations and their accepted status.
2. Supplemental semantic checks and their unsigned status.
3. Verification gaps and the concrete claim each gap prevents.

Do not say "all tests passed" when only a subset ran, when an issued check is missing, or when evidence became stale after the run.
