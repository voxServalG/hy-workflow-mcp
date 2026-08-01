# hy-workflow documentation

hy-workflow is a free, Git-native, cross-Agent protocol. It connects reviewed project incidents and invariants to the code paths they protect and to exact project-native verification commands. The CLI is deliberately small: Helper manages the three Skills, `inspect` issues applicable obligations for the current Git diff, and `verify` checks Agent-attested execution results against the current binding.

Start with:

- [Architecture](architecture.md) for product boundaries and trust.
- [Protocol](protocol.md) for `hy-workflow.yml`, matching, issuance, and evidence.
- [Skills](skills.md) for `hy-init`, `hy-verify`, and `hy-capture`.
- [Migration from 0.5](migration-0.6.md) for the 12-to-3 Skill transition.
- [Releasing](releasing.md) for the package integrity chain.

The durable project knowledge is ordinary Markdown and native tests in Git. `hy-workflow.yml` is only the narrow relation index. The CLI stores no task phase, plan, approval, scope, prompt, test output, or project workflow state.
