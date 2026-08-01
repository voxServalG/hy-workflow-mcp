# Protocol

## Durable storage

Keep human meaning in reviewable Git files:

```text
docs/incidents/INC-...md
docs/invariants/INV-...md
test/... native regression fixture
hy-workflow.yml relation index
```

An incident records observed impact, reproduction, demonstrated root cause, repair, regression oracle, and derived invariant. An invariant states one falsifiable current rule, its protected boundary and non-goals, its rationale or source incidents, and its project-native verification responsibility. Git commits and pull requests record team review; there is no reviewer database.

Only major, root-caused, reproducible lessons belong in the protocol. Ordinary bugs, style preferences, speculative risks, Agent transcripts, secrets, raw logs, prompts, workflow state, and copied documentation do not.

## Relation schema

The only root machine file is tracked `hy-workflow.yml` using `hy-workflow.protocol.v1`. Each obligation contains an immutable ID, kind, active/superseded/retired status, concise statement, tracked source files, constrained repository-relative POSIX path globs, verification scale, and one or more exact argv arrays with expected exit codes. Unknown fields, duplicate IDs, path traversal, YAML aliases, untracked sources, unsafe shell command strings, and supersession cycles are rejected.

The complete machine schema is [hy-workflow.protocol.schema.json](../schemas/hy-workflow.protocol.schema.json), and [the template](../templates/hy-workflow.yml) shows the smallest useful entry.

Supported path matching uses forward slashes. `*` and `?` stay within one segment; `**` may cross segments. Negated patterns, backslashes, absolute paths, `..`, `.git`, brace expansion, and extglob are not part of the protocol. Matching is deterministic and deliberately only a floor: `hy-verify` performs semantic impact analysis and may add unsigned native checks, but may never remove an issued obligation.

## Inspect

Run from the repository:

```bash
hy-workflow inspect --json
```

`hy-workflow.inspect.v1` reports `issued`, `no_match`, `invalid`, or `unavailable`; current Git changes; matched obligations; deduplicated exact commands; and a deterministic binding containing `issuanceId`, `head`, `diffHash`, and `protocolHash`. Identical commands shared by several obligations are issued once with all related obligation IDs.

No match means only that no active path matcher reached the current diff. It is not proof that the project has no risks.

## Verify

The Agent executes each issued argv directly from the repository root, captures canonical UTC start and completion timestamps, the real exit code, stdout, and stderr, then submits one `hy-workflow.evidence.v1` object. See [the evidence schema](../schemas/hy-workflow.evidence.schema.json).

```bash
hy-workflow verify --input-file /tmp/evidence.json --json
```

Results are `verified`, `failed`, `missing`, `stale`, `invalid`, or `unavailable`. Any change to HEAD, tracked or untracked content, file mode, index state, or protocol invalidates the old binding. Evidence files and output do not belong in Git.
