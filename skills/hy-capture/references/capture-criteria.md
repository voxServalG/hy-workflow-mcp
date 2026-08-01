# Capture criteria

Read this file on every eligible `hy-capture` run, before creating or modifying durable project knowledge.

## Admission rule

An authoritative capture requires all four predicates:

1. Impact: a production outage, security or data-integrity failure, serious release regression, irreversible compatibility failure, or a materially costly defect that has recurred.
2. Cause: repository evidence demonstrates the causal mechanism; temporal correlation or speculation is insufficient.
3. Oracle: a regression test or fixture fails on the faulty behavior and passes on the corrected behavior, or an equivalent deterministic observation proves both sides.
4. Stable verification: the repository exposes a non-interactive, project-native argv whose expected exit code can be checked repeatedly.

An explicit user request to "capture this" triggers evaluation, not automatic admission. If any predicate is missing, report a non-authoritative candidate containing the missing proof and next investigation step. Do not add it to `hy-workflow.yml` yet.

## Deduplication and identity

Search by obligation ID, incident title, invariant statement, affected subsystem, root-cause terms, test name, and verification argv. Prefer, in order:

1. Link a new incident to an existing invariant and obligation.
2. Extend an existing obligation's narrowly related applicability or sources.
3. Create a new invariant only when the stable rule is genuinely distinct.

IDs are immutable after review. Never recycle a retired ID for a different claim. Keep the incident-specific narrative separate from the reusable invariant statement. Use `superseded` plus `superseded_by` only when a reviewed obligation is replaced by another existing ID; use `retired` when it no longer applies and has no successor.

## Save contract

The reviewable Git change must contain:

- Incident source: observed impact, detection, timeline or reproduction, demonstrated root cause, repair, and links to the regression oracle and invariant.
- Invariant source: one falsifiable statement, rationale, protected boundary, explicit non-goals, and links to related incidents.
- Regression oracle: a test or fixture in the project's native test structure, with a name that states the historical failure.
- Relation entry: immutable ID, active status, source paths, narrow path applicability, exact native argv, verification scale, and expected exit code.

Store no private state, prompts, Agent transcripts, raw command logs, timestamps that change on every run, secrets, credentials, external-only knowledge, or copied source prose in the relation index. Source documents contain meaning; `hy-workflow.yml` contains only durable relations and executable obligations.

## Completion proof

Before claiming capture complete:

1. The faulty behavior is reproducible or its equivalent deterministic oracle is documented.
2. The regression oracle passes on the fix.
3. The incident and invariant sources, test, and protocol are part of the Git candidate so the CLI can verify tracked source paths.
4. `hy-workflow inspect --json` accepts the protocol and a relevant current diff deterministically hits the new or amended obligation.
5. The exact issued native argv is executed and current evidence is accepted through `hy-verify` when a protocol-backed claim is required.
6. The Git diff is ready for independent team review. Do not label it team-approved before that review occurs.

## Degradation behavior

- If the CLI is absent, finish evidence-backed incident, invariant, and regression-test work; label relation validation and evidence signing unavailable.
- If no stable native argv exists, improve or identify a project-native test entry point before creating an obligation. Do not add an ad hoc Agent-only shell recipe.
- If the root cause is uncertain, preserve a non-authoritative candidate and continue diagnosis.
- If applicability cannot be narrowed, propose the candidate for review instead of matching the entire repository.
- If incident details contain secrets or personal data, redact them before Git storage and preserve only the engineering facts needed to prevent recurrence.
