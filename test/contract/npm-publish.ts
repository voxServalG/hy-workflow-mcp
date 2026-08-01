import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function extractVersionValidator(raw: string): string {
  const workflow = raw.replace(/\r\n?/g, "\n");
  const marker = "          node --input-type=module <<'NODE'\n";
  const start = workflow.indexOf(marker);
  const end = workflow.indexOf("\n          NODE", start + marker.length);
  assert(start >= 0 && end > start, "release version validator heredoc is missing");
  return workflow.slice(start + marker.length, end)
    .split("\n")
    .map(line => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

const raw = readFileSync(".github/workflows/npm-publish.yml", "utf8");
const workflow = raw.replace(/\r\n?/g, "\n");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert(/^on:\n  release:\n    types: \[published\]/m.test(workflow), "publication must be triggered only by a published GitHub Release");
assert(workflow.includes("permissions:\n  contents: read\n  id-token: write"), "trusted publishing requires read-only contents plus OIDC id-token permission");
assert(workflow.includes('node-version: "24"'), "release runner must use Node 24");
assert(workflow.includes("npm install --global npm@11.13.0"), "release runner must pin the reviewed OIDC-capable npm version");
assert(workflow.includes("fetch-depth: 0") && workflow.includes("persist-credentials: false"), "release checkout must fetch ancestry without persisting GitHub credentials");

const actions = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(match => match[1]);
assert(actions.length === 2, `release workflow must use exactly two reviewed Actions, got ${actions.length}`);
for (const action of actions) {
  assert(/^[^@\s]+@[0-9a-f]{40}$/.test(action), `Action must be pinned to a full immutable commit: ${action}`);
}

for (const provenance of [
  "Validate release provenance",
  "release tag must equal v",
  "package semver prerelease state must match GitHub release.prerelease",
  'test "$tag_commit" = "$head_commit"',
  "refs/remotes/origin/main",
  "git merge-base --is-ancestor",
]) {
  assert(workflow.includes(provenance), `release provenance check is missing: ${provenance}`);
}

const packCommand = "npm pack --json --pack-destination";
const thinCommand = 'npm run test:acceptance:thin -- --package-archive "$HY_RELEASE_TGZ"';
const migrationCommand = 'npm run test:acceptance:migration -- --legacy @voxstudio/hy-workflow@0.5.0 --candidate "$HY_RELEASE_TGZ"';
const digestCommand = 'test "$actual_sha512" = "$HY_RELEASE_TGZ_SHA512"';
const latestPublish = 'npm publish "$HY_RELEASE_TGZ" --access public --tag latest';
const nextPublish = 'npm publish "$HY_RELEASE_TGZ" --access public --tag next';
for (const token of [packCommand, thinCommand, migrationCommand, digestCommand, latestPublish, nextPublish]) {
  assert(workflow.includes(token), `release integrity chain is missing: ${token}`);
}
assert((workflow.match(/npm pack --json --pack-destination/g) ?? []).length === 1, "release workflow must create exactly one tarball");
assert(workflow.indexOf("Validate release provenance") < workflow.indexOf("npm run verify"), "provenance must be rejected before expensive verification");
assert(workflow.indexOf(packCommand) < workflow.indexOf(thinCommand), "the canonical tarball must exist before thin acceptance");
assert(workflow.indexOf(thinCommand) < workflow.indexOf(migrationCommand), "thin acceptance must finish before the networked migration oracle");
assert(workflow.indexOf(migrationCommand) < workflow.indexOf(digestCommand), "migration must gate the final digest check");
assert(workflow.indexOf(digestCommand) < workflow.indexOf(latestPublish), "digest recheck must gate publication");
assert(pkg.scripts?.["test:acceptance:thin"] === "npx tsx test/acceptance/thin-package.ts", "thin acceptance script path drifted");
assert(pkg.scripts?.["test:acceptance:migration"] === "npx tsx test/acceptance/public-0.5-upgrade.ts", "public v0.5 migration script path drifted");
for (const forbidden of ["NPM_TOKEN", "NODE_AUTH_TOKEN", "actions/upload-artifact", "gh release upload", "actions/attest-build-provenance", "@voxstudio/hy-workflow@0.4.0"]) {
  assert(!workflow.includes(forbidden), `release workflow contains forbidden legacy or secret surface: ${forbidden}`);
}

const validator = extractVersionValidator(raw);
assert(extractVersionValidator(raw.replace(/\n/g, "\r\n")) === validator, "release validator extraction must be CRLF-stable");
function validate(version: string, tag: string, prerelease: boolean, expected: boolean): void {
  const root = mkdtempSync(join(tmpdir(), "hy-release-version-"));
  try {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ version })}\n`, "utf8");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", validator], {
      cwd: root,
      env: { RELEASE_TAG: tag, IS_PRERELEASE: String(prerelease) },
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
    });
    assert(!result.error, `version validator failed to start: ${result.error?.message ?? "unknown error"}`);
    assert((result.status === 0) === expected, `${version}/${tag}/prerelease=${prerelease} returned ${String(result.status)}: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
validate("1.2.3", "v1.2.3", false, true);
validate("1.2.3-next.0", "v1.2.3-next.0", true, true);
validate("1.2.3-next.0", "v1.2.3-next.0", false, false);
validate("1.2.3", "v1.2.3", true, false);
validate("1.2.3", "v1.2.4", false, false);
validate("not-semver", "vnot-semver", false, false);

process.stdout.write("npm-publish: static provenance, OIDC, one-tarball integrity, migration, and channel contracts pass\n");
