# Migrating from 0.5 to 0.6

Version 0.6 replaces the 12-stage workflow product with a three-Skill stateless protocol. Removed public commands, phases, routes, approvals, PlanDocs, scope locks, exam submission, Git/GitHub orchestration, project registration, MCP retirement, built-in lint, and injected workflows are not compatibility surfaces.

Run:

```bash
hy-workflow helper update --json
```

The update validates the existing 0.5 user-level ownership manifest, recovers any safe interrupted projection, installs `hy-init`, `hy-verify`, and `hy-capture`, and removes the ten obsolete Skill projections and canonical directories only when ownership path, type, target, and content hash still match. A foreign or modified resource is not deleted; the operation reports an ownership conflict. Unrelated Skills remain unchanged.

Old project config, deployment, workflow, scope, cache, and MCP ownership files are ignored and preserved byte-for-byte. They no longer influence Agent work. Helper does not clean them up or modify any repository. Direct migration is supported from the latest stable 0.5 line; older MCP-era installs should first update to 0.5 or remove their old integration manually under review.

After update, restart the Agent host so its Skill catalog contains exactly the new bundle. Projects opt into the relation protocol through a normal reviewed `hy-workflow.yml`; Helper never creates one.
