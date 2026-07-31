# NPM Packaging and Release Contract

The public package is `@voxstudio/hy-workflow`; its executable is `hy-workflow`. Both npm `main` and `bin["hy-workflow"]` point to `dist/main.js`. The installed binary is a CLI and must not expose an MCP server entrypoint.

## Shipped package

The npm allowlist contains compiled `dist/`, public `docs/`, the public configuration schema, required templates/compatibility assets, the complete `skills/` bundle, `README.md` and `LICENSE`. Registry users receive compiled JavaScript; global installation does not require TypeScript or development dependencies.

The tarball must include:

- `dist/main.js` and the compiled workflow/helper/lint kernel it imports;
- all 12 `skills/<name>/SKILL.md` files;
- the public configuration schema needed at runtime;
- public documentation and README;
- the MIT `LICENSE`.

It must not include source tests, local tarballs, `.hy/`, project Agent directories, `.mcp.json`, compatibility lint JSON or any user config/state/cache. `dist/` and generated `.tgz` files are build products and are not committed unless a separate release policy explicitly says otherwise.

There is no `prepare`, `install` or `postinstall` mutation. Installing the npm package alone does not touch Agent directories or a project. The user explicitly runs `hy-workflow helper install` in a Git project.

## Required scripts

- `clean`: remove only repository-root `dist/` through the cross-platform cleaner;
- `build`: clean TypeScript compilation;
- `lint:contract`: build and run the package's public-contract lint;
- `test:unit`, `test:e2e`, `test:contract`: deterministic test layers;
- `test`: all normal layers;
- `verify`: build plus normal tests;
- `test:acceptance:baseline`: offline packed-tarball development gate;
- `test:acceptance:migration`: online real-public-package migration oracle;
- `test:acceptance:pressure`: pinned public-repository release pressure;
- `test:acceptance`: release-pressure alias;
- `test:windows`: independent Windows installed-package smoke;
- `verify:dev`: normal verification plus offline baseline;
- `prepack`: rebuild immediately before packing;
- `prepublishOnly`: full verification before direct source publication attempts.

`tsx` remains a development dependency because TypeScript tests execute through its declared local CLI. Test scripts must not rely on remote `npx` resolution.

## Reproducible pack boundary

Every build/prepack starts from an empty `dist/`. Two consecutive packs from the same source must have the same allowed file set; an orphan compiled file injected between builds must not survive. Contract tests inspect the packed tarball rather than assuming `package.json.files` is sufficient.

Installed-tarball tests must execute `dist/main.js`, use `skills list` and raw/JSON `skills read` to bind all 12 Skills to the installed package version and bundle hash, install/status/update/remove the Skill bundle in isolated user roots, confirm `projectFilesChanged: []`, and prove there is no MCP server entrypoint. The offline migration fixture synthesizes the known legacy shape. The online oracle installs the real public 0.4.0 package and begins with its repository-root `hy-workflow.json`, schema-3 deployment/registry/client ownership, active workflow/scope evidence and owned client entries, but no external runtime-config authority marker. The candidate may create only that marker as a new external state file. On an unmoved checkout it preserves root config, deployment/registry, workflow/scope evidence and all unrelated client bytes, while retiring only exactly owned MCP entries and their corresponding ownership records.

## Lint packaging

`hy-workflow lint --json` must run from the unpacked tarball without registry or codeload access. It includes first-party doclint and codelint and never creates or updates legacy compatibility JSON. Dependency lint is not shipped.

The package may be invoked by a consumer's existing CI, but helper does not generate a workflow. Packaging tests must not require a repository to contain `.github/workflows/hy-workflow.yml`.

## Release workflow

`.github/workflows/npm-publish.yml` publishes only a GitHub Release with `release.published`. It uses npm Trusted Publishing with `id-token: write` and no long-lived npm token.

Before publication it proves:

1. the release tag equals `v` plus `package.json.version`;
2. the checked-out commit is the tag commit and belongs to `origin/main`;
3. semver prerelease state matches the GitHub Release prerelease flag;
4. normal verification passes;
5. exactly one canonical tarball is created and its SHA-512 is recorded;
6. the exact tarball passes the no-skip acceptance pressure matrix;
7. the online oracle migrates real public 0.4.0 state to that exact tarball;
8. its bytes remain unchanged before `npm publish`.

That same accepted `.tgz` is published directly. Stable releases use npm tag `latest`; prereleases use `next`. The workflow does not publish the source directory after acceptance and does not upload compiled artifacts to GitHub Releases or commit them to Git.

## Stable migration release gate

A stable CLI+Skill release is incomplete until the offline synthetic baseline and the online public-package oracle prove:

- the active bin and main are `dist/main.js`;
- all 12 Skills are present and hashable;
- fresh helper install leaves representative repositories byte-identical;
- update preserves an existing target set and intentional deletion;
- on an unmoved checkout, the MCP-era root `hy-workflow.json`, schema-3 deployment/registry and workflow/scope evidence remain byte-identical, while client ownership changes only for the retired owned MCP entry;
- on a genuinely moved checkout, status is read-only and install transactionally updates only the proven deployment/registry identity fields;
- no external authority marker exists before migration and the candidate creates exactly one marker that points back to the preserved root config;
- only an exactly owned legacy `hy-workflow` MCP entry is retired;
- `docs-gardener` and unrelated client configuration survive;
- local doclint/codelint work from the installed tarball;
- Windows and POSIX projection modes have focused coverage.

Release documentation and npm dist-tags must be verified after the workflow completes; creating a GitHub Release alone is not proof that `latest` moved. After `latest` resolves to the released version, repeat the public oracle with `npm run test:acceptance:migration -- --legacy @voxstudio/hy-workflow@0.4.0 --candidate @voxstudio/hy-workflow@latest` so registry installation, not only the pre-publication tarball, closes the migration loop.
