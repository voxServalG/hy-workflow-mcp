# Release tarball invariant

The npm artifact accepted by release tests must be the exact tarball published to the registry. Its package version must equal the GitHub Release tag, the tagged commit must be the checked-out `main` commit, and the SHA-512 digest must remain unchanged between pack, acceptance, and publish.

Stable versions publish to `latest`; prereleases publish to `next`. npm publishing uses the repository's trusted OIDC workflow and is the final release side effect.

This boundary does not make branch protection assumptions. Promotion and release automation must explicitly observe the expected Linux and Windows checks before publication.

Verification responsibility: package contract tests, installed-package acceptance, public 0.5 migration, and the pinned `npm-publish.yml` workflow.
