import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd } from "node:process";
import { CLI_COMMAND_NAMES } from "../../src/commands/catalog.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readDist(relativePath: string): string {
  return readFileSync(join(cwd(), "dist", relativePath), "utf-8");
}

const pkg = JSON.parse(readFileSync(join(cwd(), "package.json"), "utf-8"));
const main = readDist("main.js");
const workflowCli = readDist("cli/workflow.js");
const helperCli = readDist("helper/cli.js");
const helperCliContract = readDist("helper/cli-contract.js");
const helperProject = readDist("helper/project.js");
const init = readDist("tools/init.js");
const readDocs = readDist("tools/read_docs.js");
const syncDocs = readDist("tools/sync_docs.js");
const publishWorkflow = readFileSync(join(cwd(), ".github", "workflows", "npm-publish.yml"), "utf-8");

assert(pkg.scripts?.build === "npm run clean && tsc", "dist must always be rebuilt from an empty directory");
assert(!publishWorkflow.includes("upload-artifact"), "compiled dist must never be uploaded as a GitHub Actions artifact");
assert(!existsSync(join(cwd(), "dist", "server.js")), "clean build must not emit the removed MCP server entrypoint");

for (const token of ["runWorkflowCli", "runHelperCli", "WORKFLOW_CLI_COMMANDS", "helper", "setup"]) {
  assert(main.includes(token), `compiled main CLI is missing ${token}`);
}
for (const forbidden of ["@modelcontextprotocol/sdk", "StdioServerTransport", "new Server(", "server.connect("]) {
  assert(!main.includes(forbidden) && !workflowCli.includes(forbidden), `compiled public entrypoint must not start MCP: ${forbidden}`);
}
assert(workflowCli.includes("hy-workflow.cli.v1") && workflowCli.includes("stableJsonStringify"), "compiled workflow CLI must emit the deterministic v1 envelope");
for (const command of CLI_COMMAND_NAMES) assert(workflowCli.includes(`"${command}"`), `compiled workflow CLI is missing ${command}`);
assert(helperCliContract.includes("hy-workflow.helper.v1"), "compiled helper contract must expose the public v1 schema");
assert(helperCli.includes("projectFilesChanged: []"), "compiled helper must expose its zero-project-write envelope");
assert(helperProject.includes("assertHelperResourcesExternal") && helperProject.includes("projectFiles: []"), "compiled helper registration must remain outside the project");
assert(!helperProject.includes(".github/workflows/hy-workflow.yml"), "compiled helper must not inject a default workflow");

assert(!init.includes("npx --yes github:voxServalG/hy-harness"), "compiled init must not execute hy-harness");
assert(init.includes("collectProjectCognition"), "compiled init must collect local project cognition");
assert(init.includes("projectFilesChanged: []"), "compiled init must report zero project changes");
assert(readDist("lint.js").includes("templates/lint/index.mjs"), "compiled lint adapter must execute the packaged first-party engine");
for (const stage of ["before_plan", "before_approve", "after_edit"]) assert(readDocs.includes(stage), `compiled read-docs handler is missing ${stage}`);
assert(syncDocs.includes("handleSyncDocs"), "compiled sync-docs handler must implement the documentation evidence gate");

console.log("dist-artifacts: main CLI, helper, workflow envelope, handlers, and no-MCP entrypoint pass");
