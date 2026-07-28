import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function readDist(relativePath: string): string {
  return readFileSync(join(cwd(), "dist", relativePath), "utf-8");
}

const init = readDist("tools/init.js");
const server = readDist("server.js");
const readDocs = readDist("tools/read_docs.js");
const syncDocs = readDist("tools/sync_docs.js");
const pkg = JSON.parse(readFileSync(join(cwd(), "package.json"), "utf-8"));
const publishWorkflow = readFileSync(join(cwd(), ".github", "workflows", "npm-publish.yml"), "utf-8");

assert(pkg.scripts?.build === "npm run clean && tsc", "dist must always be rebuilt from an empty directory");
assert(!publishWorkflow.includes("upload-artifact"), "compiled dist must never be uploaded as a GitHub Actions artifact");

assert(!init.includes("npx --yes github:voxServalG/hy-harness"), "dist init must not execute hy-harness");
assert(!init.includes("stdio: \"inherit\""), "dist init must not inherit stdio");
assert(!init.includes("Harness deployed"), "dist init must not report harness deployment");
assert(init.includes("setupArtifactStatus"), "dist init should verify user-local setup artifacts");
assert(init.includes("harness_missing"), "dist init should expose structured missing-harness recovery");

assert(!server.includes("初始化项目：部署 hy-harness"), "dist server description must not claim hy_init deploys hy-harness");
assert(server.includes("默认不写项目或 .git"), "dist server description should describe zero-project-change init");
assert(server.includes('argv[0] === "setup" || argv[0] === "unset"'), "dist server should expose setup and unset through one CLI engine");
assert(server.includes('argv[0] === "lint"'), "dist server should expose the built-in lint CLI");
assert(readDist("lint.js").includes("templates/lint/index.mjs"), "dist lint adapter should execute the packaged first-party engine");

assert(server.includes("hy_read_docs"), "dist server should register hy_read_docs");
assert(readDocs.includes("before_plan"), "dist read_docs should implement before_plan stage");
assert(readDocs.includes("before_approve"), "dist read_docs should implement before_approve stage");
assert(readDocs.includes("after_edit"), "dist read_docs should implement after_edit stage");
assert(server.includes("hy_sync_docs"), "dist server should register hy_sync_docs");
assert(syncDocs.includes("handleSyncDocs"), "dist sync_docs should implement handleSyncDocs");
