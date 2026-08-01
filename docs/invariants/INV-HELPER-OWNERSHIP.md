# Helper ownership invariant

Helper may create, replace, or remove only user-level Skill resources whose exact path, type, target, and content hash are proven by its ownership manifest and transaction journal. It must never write project files, Git metadata, Agent project configuration, MCP configuration, or unrelated Skills.

This boundary includes fresh install, idempotent update, 0.5 twelve-to-three migration, drift reporting, crash recovery, and remove. A conflict must preserve the resource and produce a factual error; convenience is not a reason to guess ownership.

The invariant does not promise cleanup of legacy project state. Those files are ignored and preserved.

Source incident: [INC-HELPER-RETIRED-SKILLS](../incidents/INC-HELPER-RETIRED-SKILLS.md). Verification responsibility: the Helper unit suite and public 0.5 upgrade acceptance.
