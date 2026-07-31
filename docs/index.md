# hy-workflow Documentation

These documents define the current public CLI+Skill contract:

- [Product Vision](./product-vision.md)
- [Architecture and pinned design references](./architecture.md)
- [Helper installation, update and migration](./setup.md)
- [CLI contract](./cli.md)
- [Output contract](./output.md)
- [State machine](./state-machine.md)
- [Stage Skills](./skills.md)
- [Workflow command reference](./tools.md)
- [Verification pipeline](./verify.md)
- [Repository verification contract](./verification.md)
- [Acceptance gates](./acceptance.md)
- [Error contract](./errors.md)
- [Kernel-to-CLI result projection](./tool-result-envelope.md)
- [Workflow contract lint](./lint-contract.md)
- [Built-in lint rules](./lint-rules.md)
- [NPM packaging and release](./npm.md)
- [Migration and release roadmap](./pr-roadmap.md)
- [Release log](./log.md)
- [README](../README.md)

The current public architecture has one `hy-workflow` CLI, 12 phase-named Skills, external runtime state, no MCP server entrypoint and no default project or GitHub Actions injection. Internal compatibility fields and historical migration evidence do not broaden that public surface.

The package's built contract lint and tests are the executable cross-check for command catalog, Skill catalog, package contents and migration invariants. Repository-native docs, tests and CI remain project-owned sources of truth for each consuming project.
