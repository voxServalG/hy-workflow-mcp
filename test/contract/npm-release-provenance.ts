import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function extractValidator(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const startMarker = "          node --input-type=module <<'NODE'\n";
  const start = normalized.indexOf(startMarker);
  const end = normalized.indexOf("\n          NODE", start + startMarker.length);
  assert(start >= 0 && end > start, "release provenance Node validator is missing");
  return normalized
    .slice(start + startMarker.length, end)
    .split("\n")
    .map(line => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

const rawWorkflow = readFileSync(".github/workflows/npm-publish.yml", "utf8");
const workflow = rawWorkflow.replace(/\r\n?/g, "\n");
const validator = extractValidator(rawWorkflow);
const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));
const actionReferences = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map(match => match[1]);
assert(actionReferences.length > 0, "release workflow must use explicitly reviewed Actions");
for (const reference of actionReferences) {
  assert(
    /^[^@\s]+@[0-9a-f]{40}$/.test(reference),
    `release workflow Action references must use full immutable commit SHAs: ${reference}`,
  );
}
assert(actionReferences.includes("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803"), "checkout v6 pin drifted");
assert(actionReferences.includes("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38"), "setup-node v6 pin drifted");
const packageVersion = packageManifest.version;
const migrationCommand = 'npm run test:acceptance:migration -- --legacy @voxstudio/hy-workflow@0.4.0 --candidate "$HY_RELEASE_TGZ"';
assert(
  packageManifest.scripts?.["test:acceptance:migration"] === "npx tsx test/acceptance/public-migration-oracle.ts",
  "public migration oracle must have one stable npm script",
);
assert(
  packageManifest.scripts?.["test:acceptance"] === "npm run test:acceptance:pressure --",
  "release pressure alias must forward the canonical package archive argument",
);
const reusableWorkflow = readFileSync(".github/workflows/reusable-verify.yml", "utf8").replace(/\r\n?/g, "\n");
const reusablePackageSpecs = [...reusableWorkflow.matchAll(/@voxstudio\/hy-workflow@([^\s]+)\s+hy-workflow\s+lint\s+--json/g)].map(match => match[1]);
assert(
  reusablePackageSpecs.length === 1 && reusablePackageSpecs[0] === packageVersion,
  `reusable verify must pin exactly package.json version ${packageVersion}, got ${JSON.stringify(reusablePackageSpecs)}`,
);
assert(extractValidator(workflow.replace(/\n/g, "\r\n")) === validator, "release provenance validator must parse identically with CRLF");

function validate(version: string, tag: string, prerelease: boolean, expected: boolean): void {
  const root = mkdtempSync(join(tmpdir(), "hy-release-provenance-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }) + "\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", validator], {
    cwd: root,
    env: { ...process.env, RELEASE_TAG: tag, IS_PRERELEASE: String(prerelease) },
    encoding: "utf8",
  });
  assert((result.status === 0) === expected, `${version}/${tag}/prerelease=${prerelease} returned ${result.status}: ${result.stderr}`);
}

validate("1.2.3", "v1.2.3", false, true);
validate("1.2.3-next.0", "v1.2.3-next.0", true, true);
validate("1.2.3-next.0", "v1.2.3-next.0", false, false);
validate("1.2.3", "v1.2.3", true, false);
validate("1.2.3", "v1.2.4", false, false);
validate("not-semver", "vnot-semver", false, false);

for (const token of [
  "fetch-depth: 0",
  'test "$tag_commit" = "$head_commit"',
  "refs/remotes/origin/main",
  "git merge-base --is-ancestor",
  "Build one release tarball",
  'npm run test:acceptance -- --package-archive "$HY_RELEASE_TGZ"',
  migrationCommand,
  'test "$actual_sha512" = "$HY_RELEASE_TGZ_SHA512"',
  'npm publish "$HY_RELEASE_TGZ" --access public --tag next',
  'npm publish "$HY_RELEASE_TGZ" --access public --tag latest',
]) {
  assert(workflow.includes(token), `release provenance workflow token is missing: ${token}`);
}
assert(workflow.indexOf("Validate release provenance") < workflow.indexOf("npm run verify"), "release provenance must run before verification");
assert(workflow.indexOf("Build one release tarball") < workflow.indexOf("--package-archive"), "the canonical tarball must exist before acceptance consumes it");
assert(workflow.indexOf("--package-archive") < workflow.indexOf(migrationCommand), "release pressure must finish before the public migration oracle");
assert(workflow.indexOf(migrationCommand) < workflow.indexOf('test "$actual_sha512" = "$HY_RELEASE_TGZ_SHA512"'), "the public migration oracle must gate digest recheck and publication");
assert(workflow.indexOf("--package-archive") < workflow.indexOf('npm publish "$HY_RELEASE_TGZ"'), "acceptance must gate publication of the same tarball");
for (const forbidden of ["actions/upload-artifact", "gh release upload", "NPM_TOKEN", "NODE_AUTH_TOKEN"]) {
  assert(!workflow.includes(forbidden), `release workflow must not contain ${forbidden}`);
}

console.log("npm-release-provenance: tag, branch ancestry, prerelease channel, and no-upload contract passes");
