# Architecture

## Product boundary

hy-workflow does one job: relate reviewed project knowledge to a current Git diff and check evidence for the resulting native commands. It is not an Agent, planner, code reviewer, test runner, continuous-integration service, policy engine, dependency graph, retrieval system, or knowledge portal.

The three layers are intentionally separate:

1. Git stores meaning and review history. Incident and invariant sources are ordinary Markdown; regression oracles stay in the project's native test tree; `hy-workflow.yml` stores only relations.
2. Skills interpret meaning. They decide when to orient, perform semantic impact analysis, choose Small/Medium/Large depth, execute exact argv, explain limitations, and guide capture.
3. The CLI handles deterministic facts. Helper projects the Skill bundle with ownership records. `inspect` validates the protocol, snapshots Git, matches paths, and issues commands. `verify` compares submitted results with current issuance facts.

The CLI never returns a next action, permission gate, phase, or request that the user must satisfy before the Agent can continue. Invalid or unavailable facts prevent only a protocol-backed positive claim; safe diagnosis, editing, and native checks continue.

## Trust boundary

`verify` reports `trust: agent_attested`. It proves structural binding: the submitted issuance ID, HEAD, complete staged/unstaged/tracked/untracked diff hash, protocol hash, command ID, exact argv, and exit code agree with the current inspection. It does not independently prove that an untrusted Agent really ran a command. Stronger execution provenance belongs to a CLI runner or signed continuous-integration attestation and is intentionally outside this thin protocol.

Evidence is transient input. The CLI returns bounded hashes and byte counts and does not persist evidence in Git or a private project database.

## Git snapshot

The diff hash frames the current HEAD, final tracked diff, staged diff, unstaged diff, changed-path records, and every non-ignored untracked path with file mode, size, and content hash. Inspect captures the snapshot twice and rejects a moving worktree rather than issuing a mixed-state result. Renames match both the old and new path.

## Helper boundary

Helper writes only user-level Skill data, ownership state, and detected Agent Skill directories. It works outside a Git repository. It never writes project files, `.git`, Agent project configuration, MCP configuration, or GitHub Actions. A 0.5 ownership manifest is migrated transactionally from 12 Skills to 3; an owned resource whose type, path, target, or hash changed is preserved and reported as a conflict rather than guessed away.
